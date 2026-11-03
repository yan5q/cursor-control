import {
  PROTOCOL_VERSION,
  type ArmedTabInfo,
  type BridgeCommand,
  type ClientMessage,
  type CommandResult,
  type ServerMessage,
} from "../../shared/protocol.ts";
import { isControllablePage } from "../../shared/url.ts";
import {
  attach,
  captureScreenshot,
  click,
  delay,
  fillText,
  goBack,
  hover,
  installDebuggerEvents,
  navigate,
  pressKey,
  readSnapshot,
  scroll,
  selectOption,
  typeText,
  waitForEvent,
  waitForText,
} from "./session.ts";
import type { ElementRef } from "./snapshot.ts";
import type { UiState } from "./ui.ts";

type ArmedRecord = ArmedTabInfo & { generation: number };

type Connection =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "challenge"; code: string }
  | { status: "paired" }
  | { status: "rejected"; reason: string };

type PopupResponse = { ok: true; state: UiState } | { ok: false; error: string };

const armed = new Map<number, ArmedRecord>();
const refs = new Map<number, Record<string, ElementRef>>();
const aborts = new Map<number, AbortController>();
const chains = new Map<number, Promise<void>>();

let connection: Connection = { status: "connecting" };
let stickyReason: string | undefined;
let ensuringOffscreen: Promise<void> | null = null;

installDebuggerEvents();

chrome.debugger?.onDetach.addListener((source) => {
  if (source.tabId == null || !armed.has(source.tabId)) return;
  void disarm(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (armed.has(tabId)) void disarm(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!armed.has(tabId) || (info.title == null && info.url == null)) return;
  void remember(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || !armed.has(details.tabId)) return;
  refs.delete(details.tabId);
  void injectOverlay(details.tabId).catch(() => undefined);
  void remember(details.tabId);
});

chrome.alarms.onAlarm.addListener(() => {
  void ensureOffscreen().catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!ownsMessage(message)) return;
  void handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: text } satisfies PopupResponse);
    });
  return true;
});

globalThis.__cursorControl = {
  getState: () => publicState(),
  approve: async () => {
    await approvePairing();
    return publicState();
  },
  armUrl: async (prefix: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => item.url?.startsWith(prefix));
    if (tab?.id == null) throw new Error(`No tab matching ${prefix}`);
    await armTab(tab.id);
    return publicState();
  },
  stopTab: async (tabId: number) => {
    await disarm(tabId);
    return publicState();
  },
};

void startup();

async function startup(): Promise<void> {
  try {
    await chrome.alarms.create("keepalive", { periodInMinutes: 1 });
    await restore();
    await ensureOffscreen();
  } catch (error) {
    stickyReason = error instanceof Error ? error.message : String(error);
    connection = { status: "disconnected" };
  }
  await publish();
}

async function ensureOffscreen(): Promise<void> {
  if (ensuringOffscreen) return ensuringOffscreen;
  ensuringOffscreen = (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Keeps the local connection Cursor uses to control armed tabs",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|single offscreen/i.test(message)) throw error;
    }
  })().finally(() => {
    ensuringOffscreen = null;
  });
  return ensuringOffscreen;
}

function ownsMessage(message: unknown): message is { type: string } {
  if (!message || typeof message !== "object" || !("type" in message)) return false;
  const type = (message as { type?: unknown }).type;
  return (
    type === "offscreen-ready" ||
    type === "socket-open" ||
    type === "socket-closed" ||
    type === "server-message" ||
    type === "get-state" ||
    type === "approve" ||
    type === "disconnect" ||
    type === "arm-active" ||
    type === "disarm" ||
    type === "overlay-stop"
  );
}

async function handleMessage(
  message: { type: string; message?: ServerMessage; tabId?: number; reason?: string },
  sender: chrome.runtime.MessageSender,
): Promise<PopupResponse | { ok: true }> {
  switch (message.type) {
    case "offscreen-ready":
      return { ok: true };
    case "socket-open":
      await sendHello();
      return { ok: true };
    case "socket-closed":
      if (connection.status === "paired" || connection.status === "challenge") {
        stickyReason = undefined;
      } else if (message.reason) {
        stickyReason = message.reason;
      }
      connection = { status: "disconnected" };
      await publish();
      return { ok: true };
    case "server-message":
      if (message.message) await onServerMessage(message.message);
      return { ok: true };
    case "get-state":
      return { ok: true, state: await publicState() };
    case "approve":
      await approvePairing();
      return { ok: true, state: await publicState() };
    case "disconnect":
      await disconnectBrowser();
      return { ok: true, state: await publicState() };
    case "arm-active": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) throw new Error("No active tab");
      await armTab(tab.id);
      return { ok: true, state: await publicState() };
    }
    case "disarm":
      if (typeof message.tabId !== "number") throw new Error("Missing tab");
      await disarm(message.tabId);
      return { ok: true, state: await publicState() };
    case "overlay-stop":
      if (sender.tab?.id != null) await disarm(sender.tab.id);
      return { ok: true };
    default:
      return { ok: true };
  }
}

async function onServerMessage(message: ServerMessage): Promise<void> {
  if (message.type === "challenge") {
    stickyReason = undefined;
    connection = { status: "challenge", code: message.code };
    await publish();
    return;
  }
  if (message.type === "paired") {
    stickyReason = undefined;
    if (message.token) await chrome.storage.local.set({ token: message.token });
    connection = { status: "paired" };
    await publish();
    await pushArmed();
    return;
  }
  if (message.type === "rejected") {
    stickyReason = message.reason;
    connection = { status: "rejected", reason: message.reason };
    await publish();
    return;
  }
  if (message.type === "command") await handleCommand(message.id, message.command);
}

async function approvePairing(): Promise<void> {
  if (currentConnection().status !== "challenge") throw new Error("Nothing to approve");
  await sendToServer({ type: "approve" });
  const started = Date.now();
  for (;;) {
    const current = currentConnection();
    if (current.status === "paired") return;
    if (current.status !== "challenge") {
      throw new Error("reason" in current ? current.reason : "Pairing was rejected");
    }
    if (Date.now() - started > 5_000) throw new Error("Pairing was not accepted");
    await delay(50);
  }
}

function currentConnection(): Connection {
  return connection;
}

async function disconnectBrowser(): Promise<void> {
  try {
    await sendToServer({ type: "disconnect" });
  } catch {
    // The server may already be gone. Local pairing still needs to clear.
  }
  await chrome.storage.local.remove("token");
  stickyReason = undefined;
  connection = { status: "disconnected" };
  await publish();
}

async function sendHello(): Promise<void> {
  const stored = await chrome.storage.local.get("token");
  const token = typeof stored.token === "string" ? stored.token : undefined;
  await sendToServer({ type: "hello", protocol: PROTOCOL_VERSION, ...(token ? { token } : {}) });
}

async function sendToServer(message: ClientMessage): Promise<void> {
  await ensureOffscreen();
  const response = (await chrome.runtime.sendMessage({ type: "socket-send", message })) as
    | { ok: true }
    | { ok: false; error?: string }
    | undefined;
  if (!response?.ok) {
    throw new Error(response?.error ?? "Cursor Control is not connected to the local server");
  }
}

async function pushArmed(): Promise<void> {
  if (connection.status !== "paired") return;
  try {
    await sendToServer({ type: "armed", tabs: armedList() });
  } catch {
    // The next command refreshes the list after the socket returns.
  }
}

function armedList(): ArmedTabInfo[] {
  return [...armed.values()].map(({ tabId, title, url }) => ({ tabId, title, url }));
}

async function publish(): Promise<UiState> {
  const state = await publicState();
  await chrome.storage.session.set({ ui: state });
  return state;
}

async function publicState(): Promise<UiState> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return {
    connection: connection.status,
    code: connection.status === "challenge" ? connection.code : undefined,
    reason:
      connection.status === "rejected"
        ? connection.reason
        : connection.status === "disconnected"
          ? stickyReason
          : undefined,
    armed: armedList(),
    activeTabId: tab?.id,
    activeTabTitle: tab?.title,
    activeTabArmed: tab?.id != null && armed.has(tab.id),
    activeTabControllable: isControllablePage(tab?.url),
  };
}

async function armTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!isControllablePage(tab.url)) throw new Error("Only web pages can be armed.");
  const granted = await chrome.permissions.contains({
    permissions: ["debugger"],
    origins: ["<all_urls>"],
  });
  if (!granted) throw new Error("Approve debugger access in the popup, then arm the tab.");
  if (armed.has(tabId)) return;
  await attach(tabId);
  aborts.set(tabId, new AbortController());
  armed.set(tabId, {
    tabId,
    title: tab.title ?? "Untitled",
    url: tab.url ?? "",
    generation: 1,
  });
  await injectOverlay(tabId).catch(() => undefined);
  await setBadge(tabId, true);
  await persist();
  await pushArmed();
  await publish();
}

async function disarm(tabId: number): Promise<void> {
  const existing = armed.get(tabId);
  if (!existing) return;
  existing.generation += 1;
  armed.delete(tabId);
  refs.delete(tabId);
  aborts.get(tabId)?.abort();
  aborts.delete(tabId);
  chains.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // The infobar Cancel button detaches before this call.
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "overlay-remove" });
  } catch {
    // The tab may already be gone.
  }
  await setBadge(tabId, false);
  await persist();
  await pushArmed();
  await publish();
}

async function restore(): Promise<void> {
  const stored = await chrome.storage.session.get("armedTabs");
  const rows = Array.isArray(stored.armedTabs) ? (stored.armedTabs as ArmedRecord[]) : [];
  let attached = new Set<number>();
  try {
    const targets = await chrome.debugger.getTargets();
    attached = new Set(
      targets.flatMap((target) => (target.attached && target.tabId != null ? [target.tabId] : [])),
    );
  } catch {
    attached = new Set();
  }
  for (const row of rows) {
    try {
      const tab = await chrome.tabs.get(row.tabId);
      if (!isControllablePage(tab.url)) continue;
      if (!attached.has(row.tabId)) await attach(row.tabId);
      aborts.set(row.tabId, new AbortController());
      armed.set(row.tabId, {
        tabId: row.tabId,
        title: tab.title ?? row.title,
        url: tab.url ?? row.url,
        generation: row.generation,
      });
      await injectOverlay(row.tabId).catch(() => undefined);
      await setBadge(row.tabId, true);
    } catch {
      // Drop tabs that cannot be reattached.
    }
  }
  await persist();
}

async function remember(tabId: number): Promise<void> {
  const current = armed.get(tabId);
  if (!current) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    current.title = tab.title ?? current.title;
    current.url = tab.url ?? current.url;
  } catch {
    return;
  }
  await persist();
  await pushArmed();
  await publish();
}

async function persist(): Promise<void> {
  await chrome.storage.session.set({
    armedTabs: [...armed.values()].map(({ tabId, title, url, generation }) => ({
      tabId,
      title,
      url,
      generation,
    })),
  });
}

async function setBadge(tabId: number, on: boolean): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? "ON" : "" });
    if (!on) return;
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#ff5c1c" });
    const action = chrome.action as typeof chrome.action & {
      setBadgeTextColor?: (details: { tabId?: number; color: string }) => Promise<void>;
    };
    await action.setBadgeTextColor?.({ tabId, color: "#1a1714" });
  } catch {
    // The tab closed between the update and the badge write.
  }
}

async function injectOverlay(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["overlay.js"],
  });
}

async function setOverlayHidden(tabId: number, hidden: boolean): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "overlay-hidden", hidden });
  } catch {
    // The chip is absent until the next injection.
  }
}

async function setOverlayBusy(tabId: number, busy: boolean): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "overlay-busy", busy });
  } catch {
    // The chip is optional.
  }
}

function resolveTab(tabId?: number): number {
  if (tabId != null) {
    if (!armed.has(tabId)) {
      throw new Error("That tab is not armed. Arm it from the Cursor Control popup. Cursor cannot arm tabs.");
    }
    return tabId;
  }
  const ids = [...armed.keys()];
  if (ids.length === 0) {
    throw new Error("No armed tabs. Arm a tab from the Cursor Control popup. Cursor cannot arm tabs.");
  }
  if (ids.length > 1) throw new Error("Multiple tabs are armed. Pass tabId.");
  const only = ids[0];
  if (only == null) throw new Error("No armed tabs. Arm a tab from the Cursor Control popup.");
  return only;
}

function requireRef(tabId: number, ref: string): ElementRef & { backendDOMNodeId: number } {
  const found = refs.get(tabId)?.[ref];
  if (!found) throw new Error(`Unknown ref ${ref}. Take a new snapshot.`);
  if (found.backendDOMNodeId == null) throw new Error(`Ref ${ref} has no DOM node. Take a new snapshot.`);
  return { ...found, backendDOMNodeId: found.backendDOMNodeId };
}

function enqueue(tabId: number, job: (tabId: number) => Promise<CommandResult>): Promise<CommandResult> {
  const previous = chains.get(tabId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    if (!armed.has(tabId)) throw new Error("Tab was disarmed. Stop.");
    await setOverlayBusy(tabId, true);
    try {
      return await raceArmed(tabId, job(tabId));
    } finally {
      if (armed.has(tabId)) await setOverlayBusy(tabId, false);
    }
  });
  chains.set(
    tabId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function raceArmed<T>(tabId: number, promise: Promise<T>): Promise<T> {
  const controller = aborts.get(tabId);
  if (!controller || controller.signal.aborted) return Promise.reject(new Error("Tab was disarmed. Stop."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Tab was disarmed. Stop."));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
  });
}

async function handleCommand(id: string, command: BridgeCommand): Promise<void> {
  try {
    const result = await dispatch(command);
    await sendToServer({ type: "result", id, ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await sendToServer({ type: "result", id, ok: false, error: message });
    } catch {
      // The bridge times out if the socket is already gone.
    }
  }
}

async function dispatch(command: BridgeCommand): Promise<CommandResult> {
  switch (command.method) {
    case "listArmedTabs":
      await pushArmed();
      return {
        text: armed.size === 0 ? "No armed tabs." : armedList().map((tab) => `${tab.tabId} ${tab.title} ${tab.url}`).join("\n"),
      };
    case "snapshot":
      return enqueue(resolveTab(command.tabId), snapshotCommand);
    case "click":
      return enqueue(resolveTab(command.tabId), (tabId) => clickCommand(tabId, command.ref));
    case "hover":
      return enqueue(resolveTab(command.tabId), async (tabId) => {
        const target = requireRef(tabId, command.ref);
        await hover(tabId, target.backendDOMNodeId);
        return { text: `Hovered ${command.ref}.` };
      });
    case "type":
      if (!command.text) throw new Error("Missing text");
      return enqueue(resolveTab(command.tabId), async (tabId) => {
        const target = requireRef(tabId, command.ref);
        await typeText(tabId, target.backendDOMNodeId, command.text);
        return { text: `Typed into ${command.ref}.` };
      });
    case "fill":
      return enqueue(resolveTab(command.tabId), async (tabId) => {
        const target = requireRef(tabId, command.ref);
        await fillText(tabId, target.backendDOMNodeId, command.text);
        return { text: `Filled ${command.ref}.` };
      });
    case "pressKey":
      return enqueue(resolveTab(command.tabId), async (tabId) => {
        await pressKey(tabId, command.key);
        return { text: `Pressed ${command.key}.` };
      });
    case "scroll": {
      const dx = command.dx ?? 0;
      const dy = command.dy ?? 0;
      if (!command.ref && dx === 0 && dy === 0) throw new Error("Pass a ref, dx, or dy.");
      return enqueue(resolveTab(command.tabId), async (tabId) => {
        const target = command.ref ? requireRef(tabId, command.ref) : undefined;
        await scroll(tabId, target?.backendDOMNodeId, dx, dy);
        return { text: command.ref ? `Scrolled ${command.ref}.` : "Scrolled the page." };
      });
    }
    case "selectOption":
      return enqueue(resolveTab(command.tabId), async (tabId) => {
        const target = requireRef(tabId, command.ref);
        await selectOption(tabId, target.backendDOMNodeId, command.value);
        return { text: `Selected "${command.value}" in ${command.ref}.` };
      });
    case "navigate":
      return enqueue(resolveTab(command.tabId), async (tabId) => {
        refs.delete(tabId);
        const finalUrl = await navigate(tabId, command.url);
        await remember(tabId);
        return { text: `Navigated tab ${tabId} to ${finalUrl}` };
      });
    case "back":
      return enqueue(resolveTab(command.tabId), async (tabId) => {
        refs.delete(tabId);
        const finalUrl = await goBack(tabId);
        await remember(tabId);
        return { text: `Went back. Tab ${tabId} is at ${finalUrl}` };
      });
    case "screenshot":
      return enqueue(resolveTab(command.tabId), screenshotCommand);
    case "wait":
      return enqueue(resolveTab(command.tabId), (tabId) => waitCommand(tabId, command));
    default: {
      const unknown: never = command;
      throw new Error(`Unknown command ${(unknown as BridgeCommand).method}`);
    }
  }
}

async function snapshotCommand(tabId: number): Promise<CommandResult> {
  const snapshot = await readSnapshot(tabId);
  refs.set(tabId, snapshot.refs);
  const tab = armed.get(tabId);
  const header = [`Tab ${tabId}`, tab?.title ?? "", tab?.url ?? ""].filter(Boolean).join("\n");
  return { text: `${header}\n\n${snapshot.text}` };
}

async function clickCommand(tabId: number, ref: string): Promise<CommandResult> {
  const target = requireRef(tabId, ref);
  const before = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
  await click(tabId, target.backendDOMNodeId);
  const created = (await chrome.tabs.query({})).filter((tab) => tab.id != null && !before.has(tab.id));
  let text = `Clicked ${ref}.`;
  if (created.length > 0) {
    const described = created.map((tab) => `${tab.title ?? "New tab"} ${tab.url ?? ""}`.trim()).join("; ");
    text += ` A new tab opened and is not armed: ${described}`;
  }
  return { text };
}

async function screenshotCommand(tabId: number): Promise<CommandResult> {
  await setOverlayHidden(tabId, true);
  try {
    await delay(40);
    const imageBase64 = await captureScreenshot(tabId);
    return { text: `Screenshot of tab ${tabId}.`, imageBase64, mimeType: "image/png" };
  } finally {
    await setOverlayHidden(tabId, false);
  }
}

async function waitCommand(
  tabId: number,
  command: Extract<BridgeCommand, { method: "wait" }>,
): Promise<CommandResult> {
  const timeoutMs = Math.min(Math.max(command.timeoutMs ?? (command.text || command.load ? 10_000 : 500), 0), 30_000);
  if (command.load) {
    const load = waitForEvent(tabId, "Page.loadEventFired", timeoutMs);
    try {
      await load.promise;
    } catch (error) {
      load.cancel();
      throw error;
    }
  }
  if (command.text) {
    await waitForText(tabId, command.text, timeoutMs);
    return { text: `Found "${command.text}" in tab ${tabId}.` };
  }
  if (!command.load) await delay(timeoutMs);
  return { text: command.load ? `Tab ${tabId} loaded.` : `Waited ${timeoutMs}ms.` };
}

declare global {
  var __cursorControl: {
    getState: () => Promise<UiState>;
    approve: () => Promise<UiState>;
    armUrl: (prefix: string) => Promise<UiState>;
    stopTab: (tabId: number) => Promise<UiState>;
  };
}
