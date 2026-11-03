import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_PORT } from "../../shared/protocol.ts";
import { BrowserBridge } from "./bridge.ts";
import { releaseStaleListener, SERVER_PID_PATH } from "./stale.ts";
import { registerTools } from "./tools.ts";

const bridge = new BrowserBridge({ port: DEFAULT_PORT });
let shuttingDown = false;

try {
  await listen();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

await mkdir(path.dirname(SERVER_PID_PATH), { recursive: true, mode: 0o700 });
await writeFile(SERVER_PID_PATH, JSON.stringify({ pid: process.pid, port: DEFAULT_PORT }), { mode: 0o600 });

process.stdin.on("end", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

const server = new McpServer({ name: "cursor-browser", version: "0.1.0" });
registerTools(server, bridge);
const transport = new StdioServerTransport();
transport.onclose = () => {
  void shutdown();
};
await server.connect(transport);

async function listen(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await bridge.start();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const busy = message.includes("already in use");
      if (!busy || attempt === 4) throw error;
      const released = await releaseStaleListener(DEFAULT_PORT);
      if (!released) throw error;
      await delay(100);
    }
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await rm(SERVER_PID_PATH, { force: true }).catch(() => undefined);
  try {
    await bridge.close();
  } catch {
    // Exit anyway so the port is not left behind.
  }
  process.exit(0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
