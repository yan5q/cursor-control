# Cursor Control

Let a Cursor agent read and operate tabs in **your real Chromium browser** — only after **you** arm them. Chat stays in Cursor. A local MCP server is the connector. An MV3 extension is the hands.

Agents: this README is the setup + operating contract. Follow it before inventing workarounds.

## Architecture (one sentence)

```
Cursor (MCP tools)  --stdio-->  local Node server :47321  --WebSocket-->  Cursor Control extension  --chrome.debugger-->  armed tab(s)
```

You cannot arm tabs. You cannot approve pairing. If a tool says the tab was disarmed, **stop and ask the user** to re-arm. Do not loop on arm/pair yourself.

## Requirements

- Node.js 20+ (workspaces + `tsx`)
- Chromium browser: Chrome, Edge, Brave, Arc, Helium, etc. (MV3 + `chrome.debugger`)
- Cursor with MCP enabled
- This repo on disk (absolute path needed for MCP config)

## Install (human or agent with shell)

From the repo root:

```bash
npm install
npm run build
```

That builds:

- `server/dist/index.js` — MCP + WebSocket bridge
- `extension/dist/` — unpacked extension (load this folder)

### 1. Load the extension

1. Open `chrome://extensions` (or the browser’s equivalent).
2. Enable **Developer mode**.
3. **Load unpacked** → select `extension/dist` (the **dist** folder, not `extension/`).
4. Pin **Cursor Control** if you want the popup handy.
5. After every `npm run build` that touches the extension, click **Reload** on the extension card.

The extension talks only to `127.0.0.1` / `localhost` (WebSocket to the MCP server).

### 2. Register the MCP server in Cursor

Merge into `~/.cursor/mcp.json` without wiping other servers:

```bash
npx tsx scripts/merge-mcp.ts
```

Or copy from `mcp.example.json` and replace the path with the **absolute** path to `server/dist/index.js`:

```json
{
  "mcpServers": {
    "cursor-browser": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/cursor-control/server/dist/index.js"]
    }
  }
}
```

Then reload MCP servers in Cursor (Settings → MCP, or restart Cursor). The tools usually appear under a namespace like `user-cursor-browser` / `cursor-browser`.

Default bridge port: **`47321`** (`shared/protocol.ts`). Only one Cursor Control server should own that port.

### 3. Pair (user only)

1. Open the **Cursor Control** popup. It should show a pairing code when the MCP server is running.
2. In chat, call **`browser_status`** (or check the MCP log for `Pairing code`). Codes must match.
3. User clicks **Approve pairing** in the popup. Agents must never claim they can approve.

If the popup stuck on “Connecting”: reload the extension, reopen the popup, confirm MCP is running, try `browser_status` again.

### 4. Arm a tab (user only)

1. Focus a **normal https:// (or http://) page** — not `chrome://extensions`, not the popup, not another extension page.
2. Open the popup → **Arm this tab**.
3. Accept the browser’s debugger / “started debugging this browser” prompt the first time.
4. Expect: Stop chip / overlay on the page, toolbar badge **ON**.

Armed state survives navigations **in that same tab**. A click that opens a **new** tab does **not** arm the new tab. Quitting the browser clears arms. `javascript:` URLs are rejected.

## Agent operating rules

### Always

1. Call **`browser_status`** first. Need: paired + at least one armed tab.
2. **`browser_snapshot`** before click / type / fill / hover / select. Refs look like `e12`.
3. After navigation, submit, or DOM change: **snapshot again** — old refs are dead.
4. Prefer **one mutating action at a time** (fill → click Submit → wait → snapshot), especially on SPAs.
5. If a control is off-screen, **`browser_scroll`** with `ref` before clicking.
6. Prefer **`browser_fill`** to replace field contents; **`browser_type`** only appends.
7. For short delays, prefer a local sleep over flaky `browser_wait` if the bridge briefly reports disconnected.
8. Use **`browser_screenshot`** when the a11y tree is thin (canvas, theory text, charts).

### Never

- Arm or “approve pairing” yourself — tell the user what to click.
- Continue automating after “Tab was disarmed” / “Browser is not connected” without a successful `browser_status` that lists an armed tab.
- Arm `chrome-extension://…`, `chrome://…`, or the Extensions page (you’ll get debugger / cross-extension errors).
- Open DevTools on an armed tab (Chrome won’t allow debugger + DevTools together).
- Rely on Select-All + Backspace clears; fill sets value via the debugger API and dispatches input/change.

### What disarms a tab

- User clicks **Stop** / Cancel on the debugging bar
- Debugger detach / some aggressive key combos in older builds
- Browser quit
- Explicit disarm from the popup

When disarmed: stop the task flow, tell the user to re-arm the **same** working tab (usually the target app page), then resume from `browser_status` + fresh snapshot.

## MCP tools

| Tool | Role |
|------|------|
| `browser_status` | Paired? Pending code? Armed tabs (`tabId`, title, URL) |
| `browser_snapshot` | Compact a11y tree + refs (`e1`…) |
| `browser_click` / `browser_hover` | Pointer on a ref |
| `browser_type` | Insert text (no clear) |
| `browser_fill` | Replace field contents (empty string clears) |
| `browser_press_key` | e.g. `Enter`, `Meta+a`, `Control+Enter` |
| `browser_scroll` | Wheel `dx`/`dy` and/or scroll `ref` into view |
| `browser_select_option` | `<select>` by value / label / text |
| `browser_navigate` | Go to URL in armed tab |
| `browser_back` | History back |
| `browser_screenshot` | PNG of the tab (vision) |
| `browser_wait` | Wait for timeout / text / load |

`tabId` is optional when exactly one tab is armed.

## Suggested agent checklist

```text
[ ] npm install && npm run build
[ ] extension/dist loaded + reloaded after build
[ ] mcp.json points at absolute server/dist/index.js
[ ] MCP reloaded; browser_* tools visible
[ ] popup shows code; user Approve pairing
[ ] user armed a normal https tab (not chrome://)
[ ] browser_status → paired + armed
[ ] snapshot → act → snapshot (refs refreshed)
[ ] if disarmed → ask user to re-arm; do not invent arm APIs
```

## Develop / verify

```bash
npm test          # unit tests, no browser
npm run typecheck
npm run e2e       # temporary Chromium profile + fixture page through the bridge
```

`npm run e2e` also uses port **47321** — quit any other Cursor Control MCP process first.

Layout:

```text
extension/   MV3 extension (popup, offscreen WS, debugger session)
server/      MCP stdio server + WebSocket bridge
shared/      protocol, default port
scripts/     merge-mcp.ts, e2e.ts
fixtures/    pages used by e2e
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tools missing | Rebuild server; fix absolute path in `mcp.json`; reload MCP |
| Popup “Connecting” | Ensure MCP process is up; reload extension; reopen popup |
| Pairing code mismatch | Call `browser_status`; approve the **current** code in the popup |
| “Cannot access chrome-extension://…” | Arm a normal website tab, not the extensions UI |
| Clicks do nothing | Snapshot again; scroll ref into view; confirm still armed |
| Fill visible but Submit no-ops | Scroll Submit into view; click; wait; re-snapshot (React may need a real click on the enabled button) |
| Port in use | Only one server on `47321`; stop stale Cursor Control / e2e |
| Debugger bar Cancel | User re-arm; agent waits |

## Security model

- Localhost-only bridge.
- Explicit human pairing.
- Explicit per-tab arming.
- Agent tools only address **armed** tabs.
- Stop / Cancel ends debugger access immediately.

Treat this like handing the agent a remote control with a physical safety switch you hold.
