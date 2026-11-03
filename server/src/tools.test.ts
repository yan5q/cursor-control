import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowserBridge } from "./bridge.ts";
import { registerTools } from "./tools.ts";

test("registers Cursor browser tools", () => {
  const server = new McpServer({ name: "cursor-browser-test", version: "0.0.0" });
  const bridge = {
    async status() {
      return { paired: false, pendingCode: "ABCD-EFGH", armedTabs: [], port: 1 };
    },
    async command() {
      return { text: "ok" };
    },
  } as unknown as BrowserBridge;
  assert.doesNotThrow(() => registerTools(server, bridge));
});
