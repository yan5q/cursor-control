import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import type { ServerMessage } from "../../shared/protocol.ts";
import { BrowserBridge } from "./bridge.ts";

test("pairs a browser, refreshes armed tabs, and rejects a second browser", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cursor-control-"));
  const bridge = new BrowserBridge({
    port: 0,
    tokenPath: path.join(directory, "pair.json"),
    log() {},
  });
  await bridge.start();
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  const incoming = messages(socket);
  try {
    await opened(socket);
    socket.send(JSON.stringify({ type: "hello", protocol: 1 }));
    const challenge = await incoming.next();
    assert.equal(challenge.type, "challenge");
    if (challenge.type !== "challenge") return;
    assert.equal(bridge.snapshotStatus().pendingCode, challenge.code);
    await assert.rejects(() => bridge.command({ method: "listArmedTabs" }), new RegExp(challenge.code));

    socket.send(JSON.stringify({ type: "approve" }));
    const paired = await incoming.next();
    assert.equal(paired.type, "paired");
    if (paired.type !== "paired" || !paired.token) throw new Error("missing token");
    const file = await stat(path.join(directory, "pair.json"));
    assert.equal(file.mode & 0o777, 0o600);

    const status = await bridge.status();
    assert.equal(status.paired, true);
    assert.equal(status.armedTabs[0]?.title, "Example");
    assert.equal((await bridge.command({ method: "snapshot" })).text, "ok");

    const stranger = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    const strangerMessages = messages(stranger);
    await opened(stranger);
    stranger.send(JSON.stringify({ type: "hello", protocol: 1 }));
    const rejected = await strangerMessages.next();
    assert.equal(rejected.type, "rejected");
    stranger.close();

    socket.close();
    const again = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    const resumed = messages(again);
    await opened(again);
    again.send(JSON.stringify({ type: "hello", protocol: 1, token: paired.token }));
    const welcome = await resumed.next();
    assert.equal(welcome.type, "paired");
    again.send(JSON.stringify({ type: "disconnect" }));
    const goodbye = await resumed.next();
    assert.equal(goodbye.type, "rejected");
    again.close();
  } finally {
    socket.close();
    await bridge.close();
  }
});

function messages(socket: WebSocket) {
  const pending: ServerMessage[] = [];
  const waiters: Array<(message: ServerMessage) => void> = [];
  socket.on("message", (data: RawData) => {
    const message = JSON.parse(data.toString()) as ServerMessage;
    if (message.type === "command") {
      socket.send(
        JSON.stringify({
          type: "armed",
          tabs: [{ tabId: 7, title: "Example", url: "https://example.com" }],
        }),
      );
      socket.send(JSON.stringify({ type: "result", id: message.id, ok: true, result: { text: "ok" } }));
    }
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else pending.push(message);
  });
  return {
    next(): Promise<ServerMessage> {
      const queued = pending.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}
