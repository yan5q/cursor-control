import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  type ArmedTabInfo,
  type BridgeCommand,
  type ClientMessage,
  type CommandResult,
  type PairingStatus,
  type ServerMessage,
} from "../../shared/protocol.ts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type Waiter = {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type BridgeOptions = {
  port: number;
  tokenPath?: string;
  log?: (message: string) => void;
};

export class BrowserBridge {
  private readonly tokenPath: string;
  private readonly log: (message: string) => void;
  private wss: WebSocketServer | null = null;
  private token: string | null = null;
  private paired: WebSocket | null = null;
  private pending: { socket: WebSocket; code: string } | null = null;
  private armed: ArmedTabInfo[] = [];
  private readonly waiters = new Map<string, Waiter>();
  port: number;

  constructor(options: BridgeOptions) {
    this.port = options.port;
    this.tokenPath = options.tokenPath ?? path.join(homedir(), ".cursor-browser", "pair.json");
    this.log = options.log ?? ((message) => console.error(message));
  }

  async start(): Promise<number> {
    this.token = await readToken(this.tokenPath);
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.port,
      maxPayload: 16 * 1024 * 1024,
    });
    this.wss = wss;
    let failed = false;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        this.wss = null;
        wss.close();
        const message =
          "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? `127.0.0.1:${this.port} is already in use. Quit the other Cursor Control server first.`
            : error.message;
        reject(new Error(message));
      };
      wss.once("listening", () => resolve());
      wss.on("error", (error) => {
        if (failed) return;
        if (wss.address()) {
          this.log(`cursor-browser socket error: ${error.message}`);
          return;
        }
        fail(error);
      });
    });
    wss.on("connection", (socket) => this.onConnection(socket));
    const address = wss.address();
    this.port = typeof address === "object" && address ? address.port : this.port;
    this.log(`cursor-browser listening on 127.0.0.1:${this.port}`);
    return this.port;
  }

  async close(): Promise<void> {
    this.rejectWaiters("Bridge closed");
    this.pending?.socket.close();
    this.paired?.close();
    this.pending = null;
    this.paired = null;
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => (error ? reject(error) : resolve()));
    });
  }

  snapshotStatus(): PairingStatus {
    return {
      paired: this.paired?.readyState === WebSocket.OPEN,
      pendingCode: this.pending?.code ?? null,
      armedTabs: this.armed,
      port: this.port,
    };
  }

  async status(): Promise<PairingStatus> {
    if (this.paired?.readyState === WebSocket.OPEN) {
      try {
        await this.command({ method: "listArmedTabs" }, 5_000);
      } catch {
        // Keep the last list when the browser does not answer.
      }
    }
    return this.snapshotStatus();
  }

  async command(command: BridgeCommand, timeoutMs = 30_000): Promise<CommandResult> {
    const socket = this.paired;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(this.disconnectedMessage());
    }
    const id = randomUUID();
    const result = new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error("Timed out waiting for the browser"));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
    });
    this.send(socket, { type: "command", id, command });
    return result;
  }

  private disconnectedMessage(): string {
    if (this.pending) {
      return `Browser is not paired. The pairing code is ${this.pending.code}. Compare it with the Cursor Control popup and click Approve pairing there. Cursor cannot approve pairing.`;
    }
    return "Browser is not connected. Open the Cursor Control extension and approve the pairing code. Cursor cannot arm tabs or approve pairing.";
  }

  private onConnection(socket: WebSocket): void {
    let welcomed = false;
    let chain = Promise.resolve();
    socket.on("message", (data) => {
      const raw = data.toString();
      chain = chain
        .then(async () => {
          welcomed = await this.onMessage(socket, raw, welcomed);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`cursor-browser message failed: ${message}`);
        });
    });
    socket.on("close", () => this.onClose(socket));
    socket.on("error", () => socket.close());
  }

  private async onMessage(socket: WebSocket, raw: string, welcomed: boolean): Promise<boolean> {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      socket.close();
      return welcomed;
    }
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      socket.close();
      return welcomed;
    }

    if (message.type === "hello") {
      if (message.protocol !== PROTOCOL_VERSION) {
        this.send(socket, { type: "rejected", reason: "Unsupported protocol" });
        socket.close();
        return true;
      }
      if (welcomed && socket === this.paired) return true;
      await this.onHello(socket, message.token);
      return true;
    }
    if (!welcomed) return false;

    if (message.type === "approve") {
      await this.onApprove(socket);
      return true;
    }
    if (message.type === "disconnect") {
      await this.onDisconnect(socket);
      return true;
    }
    if (message.type === "armed") {
      if (socket === this.paired && Array.isArray(message.tabs)) this.armed = message.tabs;
      return true;
    }
    if (message.type === "result") {
      this.onResult(message);
    }
    return true;
  }

  private async onHello(socket: WebSocket, token: string | undefined): Promise<void> {
    if (token && this.token && tokensMatch(token, this.token)) {
      this.becomePaired(socket);
      this.send(socket, { type: "paired" });
      this.log("cursor-browser reconnected");
      return;
    }
    if (this.paired && this.paired !== socket && this.paired.readyState === WebSocket.OPEN) {
      this.send(socket, {
        type: "rejected",
        reason: "A browser is already paired. Disconnect it in the Cursor Control popup first.",
      });
      socket.close();
      return;
    }
    if (this.pending && this.pending.socket !== socket) {
      this.send(this.pending.socket, { type: "rejected", reason: "Superseded by a new pairing request." });
      this.pending.socket.close();
    }
    const code = makePairingCode();
    this.pending = { socket, code };
    this.send(socket, { type: "challenge", code });
    this.log(`Pairing code: ${code}`);
  }

  private async onApprove(socket: WebSocket): Promise<void> {
    if (!this.pending || this.pending.socket !== socket) {
      this.send(socket, { type: "rejected", reason: "No pairing challenge for this connection." });
      return;
    }
    const token = randomBytes(32).toString("hex");
    await writeToken(this.tokenPath, token);
    this.token = token;
    this.pending = null;
    this.becomePaired(socket);
    this.send(socket, { type: "paired", token });
    this.log("cursor-browser paired");
  }

  private async onDisconnect(socket: WebSocket): Promise<void> {
    if (socket !== this.paired && socket !== this.pending?.socket) return;
    await rm(this.tokenPath, { force: true });
    this.token = null;
    if (this.pending?.socket === socket) this.pending = null;
    if (this.paired === socket) {
      this.paired = null;
      this.armed = [];
      this.rejectWaiters("Browser disconnected");
    }
    this.send(socket, { type: "rejected", reason: "Disconnected" });
    socket.close();
    this.log("cursor-browser disconnected");
  }

  private onResult(message: Extract<ClientMessage, { type: "result" }>): void {
    const waiter = this.waiters.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error));
  }

  private onClose(socket: WebSocket): void {
    if (this.pending?.socket === socket) this.pending = null;
    if (this.paired === socket) {
      this.paired = null;
      this.armed = [];
      this.rejectWaiters("Browser disconnected");
      this.log("cursor-browser connection closed");
    }
  }

  private becomePaired(socket: WebSocket): void {
    if (this.paired && this.paired !== socket) this.paired.close();
    this.paired = socket;
    if (this.pending?.socket === socket) this.pending = null;
    this.armed = [];
  }

  private rejectWaiters(message: string): void {
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
      this.waiters.delete(id);
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

function makePairingCode(): string {
  let raw = "";
  for (let index = 0; index < 8; index += 1) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function tokensMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readToken(tokenPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(tokenPath, "utf8")) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

async function writeToken(tokenPath: string, token: string): Promise<void> {
  const directory = path.dirname(tokenPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(tokenPath, JSON.stringify({ token }), { mode: 0o600 });
  await chmod(tokenPath, 0o600);
}
