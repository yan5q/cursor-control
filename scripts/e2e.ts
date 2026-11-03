import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, type RawData } from "ws";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { BrowserBridge } from "../server/src/bridge.ts";

const debugPort = 9333;

void main();

async function main(): Promise<void> {
const extensionDir = path.resolve("extension/dist-e2e");
const browsers = [
  process.env.CURSOR_CONTROL_BROWSER,
  "/Applications/Helium.app/Contents/MacOS/Helium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Arc.app/Contents/MacOS/Arc",
].filter((candidate): candidate is string => Boolean(candidate));

const binary = browsers.find((candidate) => existsSync(candidate));
if (!binary) throw new Error("No Chromium browser found. Set CURSOR_CONTROL_BROWSER.");

const profile = await mkdtemp(path.join(tmpdir(), "cursor-control-profile-"));
const tokenPath = path.join(profile, "pair.json");
const bridge = new BrowserBridge({ port: DEFAULT_PORT, tokenPath, log: (message) => console.error(message) });
const fixture = await startFixture();
const origin = `http://127.0.0.1:${fixture.port}`;
let browser: ChildProcess | undefined;

try {
  await bridge.start();
  browser = spawn(
    binary,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-popup-blocking",
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      `${origin}/`,
    ],
    { stdio: "ignore" },
  );

  const worker = await waitFor("extension service worker", async () => {
    const targets = await listTargets();
    return targets.find((target) => target.type === "service_worker" && target.url.endsWith("/background.js"));
  });
  const sw = await Cdp.connect(worker.webSocketDebuggerUrl);
  const challenge = await waitFor("pairing code", async () => {
    const state = await sw.evaluate<UiState>("globalThis.__cursorControl.getState()");
    if (state.connection === "challenge" && state.code) return state;
    throw new Error(JSON.stringify(state));
  });
  if (bridge.snapshotStatus().pendingCode !== challenge.code) {
    throw new Error(`Popup code ${challenge.code} did not match the bridge`);
  }
  await sw.evaluate("globalThis.__cursorControl.approve()");
  if (!bridge.snapshotStatus().paired) throw new Error("Browser did not pair");

  const armed = await sw.evaluate<UiState>(`globalThis.__cursorControl.armUrl(${JSON.stringify(origin)})`);
  const tabId = armed.armed.find((tab) => tab.url.startsWith(origin))?.tabId;
  if (tabId == null) throw new Error(`Fixture tab was not armed: ${JSON.stringify(armed.armed)}`);
  await waitFor("armed tab on the bridge", async () =>
    bridge.snapshotStatus().armedTabs.some((tab) => tab.tabId === tabId) ? true : undefined,
  );

  const snapshot = await bridge.command({ method: "snapshot", tabId });
  const name = refFor(snapshot.text, "textbox", "Name");
  const button = refFor(snapshot.text, "button", "Press me");
  if (!snapshot.text.includes('heading "Fixture"')) throw new Error(snapshot.text);

  await bridge.command({ method: "fill", tabId, ref: name, text: "ada" });
  await bridge.command({ method: "click", tabId, ref: button });
  const seen = await bridge.command({ method: "wait", tabId, text: "clicked:ada", timeoutMs: 5000 });
  if (!seen.text.includes("clicked:ada")) throw new Error(seen.text);

  const shot = await bridge.command({ method: "screenshot", tabId });
  if (!shot.imageBase64 || shot.mimeType !== "image/png") throw new Error("Screenshot was empty");

  await bridge.command({ method: "navigate", tabId, url: `${origin}/next.html` });
  const next = await bridge.command({ method: "snapshot", tabId });
  if (!next.text.includes('heading "Second page"')) throw new Error(next.text);

  await sw.evaluate(`globalThis.__cursorControl.stopTab(${tabId})`);
  await expectStop(bridge, tabId);
  console.log("e2e passed");
} finally {
  await closeBrowser(browser).catch(() => undefined);
  browser?.kill("SIGTERM");
  await bridge.close().catch(() => undefined);
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
  await delay(300);
  await rm(profile, { recursive: true, force: true });
}
}

function refFor(snapshot: string, role: string, name: string): string {
  const line = snapshot.split("\n").find((item) => item.includes(`${role} "${name}"`));
  if (!line) throw new Error(`Missing ${role} "${name}" in:\n${snapshot}`);
  const match = /\be\d+\b/.exec(line);
  if (!match) throw new Error(line);
  return match[0];
}

async function expectStop(bridge: BrowserBridge, tabId: number): Promise<void> {
  let refused = false;
  try {
    await bridge.command({ method: "snapshot", tabId });
  } catch (error) {
    refused = true;
    const message = error instanceof Error ? error.message : String(error);
    if (!/not armed|disarmed/i.test(message)) throw error;
  }
  if (!refused) throw new Error("Stop left the tab armed");
}

async function startFixture(): Promise<{ server: Server; port: number }> {
  const server = createServer(async (request, response) => {
    const file = request.url?.startsWith("/next.html") ? "fixtures/next.html" : "fixtures/index.html";
    const body = await readFile(file);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no port");
  return { server, port: address.port };
}

type Target = { type: string; url: string; webSocketDebuggerUrl: string };

async function listTargets(): Promise<Target[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) return [];
    return (await response.json()) as Target[];
  } catch {
    return [];
  }
}

async function closeBrowser(child: ChildProcess | undefined): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    const version = (await response.json()) as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) return;
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    await cdp.send("Browser.close");
    cdp.close();
  } catch {
    child?.kill("SIGTERM");
  }
}

async function waitFor<T>(label: string, read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

type UiState = {
  connection: string;
  code?: string;
  armed: Array<{ tabId: number; url: string }>;
};

class Cdp {
  private nextId = 1;
  private readonly contextIds: number[] = [];
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data: RawData) => {
      const message = JSON.parse(data.toString()) as {
        id?: number;
        method?: string;
        params?: { context?: { id?: number } };
        result?: unknown;
        error?: { message?: string };
      };
      if (message.method === "Runtime.executionContextCreated" && message.params?.context?.id != null) {
        this.contextIds.push(message.params.context.id);
      }
      if (message.id == null) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "CDP error"));
      else waiter.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const cdp = new Cdp(socket);
    await cdp.send("Runtime.enable");
    return cdp;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const started = Date.now();
    while (this.contextIds.length === 0 && Date.now() - started < 5_000) await delay(50);
    const contextIds = this.contextIds.length > 0 ? this.contextIds : [undefined];
    let lastError = "evaluate failed";
    for (const contextId of contextIds) {
      const result = (await this.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...(contextId == null ? {} : { contextId }),
      })) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
      if (!result.exceptionDetails) return result.result?.value as T;
      lastError = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? lastError;
    }
    throw new Error(lastError);
  }

  send(method: string, params?: object): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}
