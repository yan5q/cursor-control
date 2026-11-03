import { DEFAULT_PORT, type ClientMessage, type ServerMessage } from "../../shared/protocol.ts";

let socket: WebSocket | null = null;
let reconnectTimer = 0;
let stopped = false;
const queue: ClientMessage[] = [];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || message.type !== "socket-send") return;
  const payload = (message as { message?: ClientMessage }).message;
  if (!payload) {
    sendResponse({ ok: false, error: "Missing message" });
    return true;
  }
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  else queue.push(payload);
  sendResponse({ ok: true });
  return true;
});

// createDocument resolves on load. Calling runtime or storage before that returns
// deadlocks the service worker, and the popup stays on Connecting.
window.addEventListener("load", () => {
  window.setTimeout(connect, 0);
});

function connect(): void {
  if (stopped) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    notify({ type: "socket-closed", reason });
    scheduleReconnect();
    return;
  }
  socket = ws;
  const stalled = window.setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) ws.close();
  }, 4_000);
  let opened = false;
  ws.onopen = () => {
    opened = true;
    window.clearTimeout(stalled);
    for (const message of queue.splice(0)) ws.send(JSON.stringify(message));
    notify({ type: "socket-open" });
  };
  ws.onmessage = (event) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(event.data)) as ServerMessage;
    } catch {
      return;
    }
    notify({ type: "server-message", message });
  };
  ws.onclose = () => {
    window.clearTimeout(stalled);
    if (socket === ws) socket = null;
    notify({
      type: "socket-closed",
      ...(opened ? {} : { reason: `Cannot reach Cursor on 127.0.0.1:${DEFAULT_PORT}` }),
    });
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function scheduleReconnect(): void {
  if (!stopped) reconnectTimer = window.setTimeout(connect, 1500);
}

function notify(message: { type: string; message?: ServerMessage; reason?: string }): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

window.addEventListener("beforeunload", () => {
  stopped = true;
  window.clearTimeout(reconnectTimer);
  socket?.close();
});
