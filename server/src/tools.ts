import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BridgeCommand, CommandResult, PairingStatus } from "../../shared/protocol.ts";
import type { BrowserBridge } from "./bridge.ts";

const STOP = "If the tab was disarmed, stop. Do not try to arm it.";
const tabId = z.number().int().positive().optional().describe("Armed tab id. Omit when only one tab is armed.");

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function registerTools(server: McpServer, bridge: BrowserBridge): void {
  server.registerTool(
    "browser_status",
    {
      title: "Browser status",
      description:
        "Report whether Cursor Control is paired and which tabs the user has armed. If a pairing code is pending, tell the user to compare it with the Cursor Control popup and click Approve pairing there. You cannot approve pairing and you cannot arm tabs.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => text(formatStatus(await bridge.status())),
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot armed tab",
      description: `Read an armed tab as a compact accessibility tree. Interactive controls and headings have refs such as e1. Call this before click, type, hover, or select. Refs expire after the next snapshot or navigation. ${STOP}`,
      inputSchema: { tabId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(bridge, { method: "snapshot", tabId: args.tabId }),
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click element",
      description: `Click an element ref from the latest browser_snapshot in an armed tab. Snapshot again after the page changes. A new tab opened by the click is not armed. ${STOP}`,
      inputSchema: { tabId, ref: refField() },
      annotations: { openWorldHint: true },
    },
    async (args) => run(bridge, { method: "click", tabId: args.tabId, ref: args.ref }),
  );

  server.registerTool(
    "browser_hover",
    {
      title: "Hover element",
      description: `Move the pointer over an element ref from the latest browser_snapshot. ${STOP}`,
      inputSchema: { tabId, ref: refField() },
      annotations: { openWorldHint: true },
    },
    async (args) => run(bridge, { method: "hover", tabId: args.tabId, ref: args.ref }),
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type text",
      description: `Insert text into an element ref from the latest browser_snapshot without clearing it first. ${STOP}`,
      inputSchema: { tabId, ref: refField(), text: z.string().min(1).describe("Text to insert") },
      annotations: { openWorldHint: true },
    },
    async (args) => run(bridge, { method: "type", tabId: args.tabId, ref: args.ref, text: args.text }),
  );

  server.registerTool(
    "browser_fill",
    {
      title: "Fill element",
      description: `Replace the contents of an element ref from the latest browser_snapshot. Pass an empty string to clear it. ${STOP}`,
      inputSchema: { tabId, ref: refField(), text: z.string().describe("Replacement text") },
      annotations: { openWorldHint: true },
    },
    async (args) => run(bridge, { method: "fill", tabId: args.tabId, ref: args.ref, text: args.text }),
  );

  server.registerTool(
    "browser_press_key",
    {
      title: "Press key",
      description: `Press a key in an armed tab. Examples: Enter, Tab, Escape, ArrowDown, Backspace, Control+Enter, Meta+a. ${STOP}`,
      inputSchema: { tabId, key: z.string().min(1).describe("Key or combo to press") },
      annotations: { openWorldHint: true },
    },
    async (args) => run(bridge, { method: "pressKey", tabId: args.tabId, key: args.key }),
  );

  server.registerTool(
    "browser_scroll",
    {
      title: "Scroll",
      description: `Scroll an armed tab, or scroll a snapshot ref into view. dx and dy are pixel deltas. ${STOP}`,
      inputSchema: {
        tabId,
        ref: z.string().optional().describe("Element ref to scroll into view"),
        dx: z.number().optional().describe("Horizontal wheel delta"),
        dy: z.number().optional().describe("Vertical wheel delta"),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => run(bridge, { method: "scroll", tabId: args.tabId, ref: args.ref, dx: args.dx, dy: args.dy }),
  );

  server.registerTool(
    "browser_select_option",
    {
      title: "Select option",
      description: `Choose an option in a select ref from the latest browser_snapshot. Match the option value, label, or visible text. ${STOP}`,
      inputSchema: {
        tabId,
        ref: refField(),
        value: z.string().min(1).describe("Option value, label, or text"),
      },
      annotations: { openWorldHint: true },
    },
    async (args) =>
      run(bridge, { method: "selectOption", tabId: args.tabId, ref: args.ref, value: args.value }),
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate armed tab",
      description: `Open an http or https URL in an armed tab. javascript: URLs are rejected. This does not arm new tabs. Refs from the previous page expire. ${STOP}`,
      inputSchema: { tabId, url: z.string().min(1).describe("Absolute http or https URL") },
      annotations: { openWorldHint: true },
    },
    async (args) => run(bridge, { method: "navigate", tabId: args.tabId, url: args.url }, 25_000),
  );

  server.registerTool(
    "browser_back",
    {
      title: "Go back",
      description: `Go back in the history of an armed tab. ${STOP}`,
      inputSchema: { tabId },
      annotations: { openWorldHint: true },
    },
    async (args) => run(bridge, { method: "back", tabId: args.tabId }, 25_000),
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Screenshot armed tab",
      description: `Capture a PNG of an armed tab. The Stop chip is hidden for the shot. ${STOP}`,
      inputSchema: { tabId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(bridge, { method: "screenshot", tabId: args.tabId }),
  );

  server.registerTool(
    "browser_wait",
    {
      title: "Wait",
      description: `Wait in an armed tab for the next load event, for visible text, or for a short timeout. ${STOP}`,
      inputSchema: {
        tabId,
        timeoutMs: z.number().int().positive().max(30_000).optional().describe("Maximum wait, up to 30 seconds"),
        text: z.string().optional().describe("Visible text to wait for"),
        load: z.boolean().optional().describe("Wait for the next load event"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const timeoutMs = Math.min(args.timeoutMs ?? 10_000, 30_000) + 5_000;
      return run(
        bridge,
        { method: "wait", tabId: args.tabId, timeoutMs: args.timeoutMs, text: args.text, load: args.load },
        timeoutMs,
      );
    },
  );
}

function refField() {
  return z.string().regex(/^e\d+$/).describe("Element ref from the latest browser_snapshot, such as e1");
}

function formatStatus(status: PairingStatus): string {
  const lines = [status.paired ? "Paired with Cursor Control." : "Not paired."];
  if (status.pendingCode) {
    lines.push(
      `Pairing code: ${status.pendingCode}`,
      "Tell the user to compare this code with the Cursor Control popup and click Approve pairing.",
      "Do not approve pairing yourself. You cannot arm tabs.",
    );
  } else if (!status.paired) {
    lines.push("Open Chromium with the Cursor Control extension installed.");
  }
  if (status.armedTabs.length === 0) {
    lines.push("No armed tabs. The user must arm a tab from the popup.");
  } else {
    lines.push("Armed tabs:");
    for (const tab of status.armedTabs) lines.push(`- ${tab.tabId} ${tab.title} ${tab.url}`);
    if (status.armedTabs.length === 1) lines.push("tabId is optional while only one tab is armed.");
  }
  return lines.join("\n");
}

async function run(bridge: BrowserBridge, command: BridgeCommand, timeoutMs?: number) {
  try {
    return fromResult(await bridge.command(command, timeoutMs));
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
}

function fromResult(result: CommandResult) {
  const content: ToolContent[] = [{ type: "text", text: result.text }];
  if (result.imageBase64 && result.mimeType) {
    content.push({ type: "image", data: result.imageBase64, mimeType: result.mimeType });
  }
  return { content };
}

function text(message: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: message }],
    ...(isError ? { isError: true as const } : {}),
  };
}
