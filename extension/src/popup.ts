import type { UiState } from "./ui.ts";

const lamp = required<HTMLElement>("#lamp");
const status = required<HTMLElement>("#status");
const pair = required<HTMLElement>("#pair");
const code = required<HTMLElement>("#code");
const approve = required<HTMLButtonElement>("#approve");
const active = required<HTMLElement>("#active");
const arm = required<HTMLButtonElement>("#arm");
const tabs = required<HTMLElement>("#tabs");
const disconnect = required<HTMLButtonElement>("#disconnect");
const error = required<HTMLElement>("#error");

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Popup is missing ${selector}`);
  return element;
}

const statusText: Record<UiState["connection"], string> = {
  connecting: "Connecting",
  disconnected: "Waiting for Cursor",
  challenge: "Check the code",
  paired: "Paired",
  rejected: "Not paired",
};

approve.addEventListener("click", () => {
  void run(() => chrome.runtime.sendMessage({ type: "approve" }));
});

arm.addEventListener("click", () => {
  void (async () => {
    error.textContent = "";
    const granted = await chrome.permissions.request({
      permissions: ["debugger"],
      origins: ["<all_urls>"],
    });
    if (!granted) {
      error.textContent = "Debugger access is required to control the tab.";
      return;
    }
    await run(() => chrome.runtime.sendMessage({ type: "arm-active" }));
  })();
});

disconnect.addEventListener("click", () => {
  void run(() => chrome.runtime.sendMessage({ type: "disconnect" }));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.ui?.newValue) render(changes.ui.newValue as UiState);
});

void refresh();

async function refresh(): Promise<void> {
  const stored = await chrome.storage.session.get("ui");
  if (stored.ui) render(stored.ui as UiState);
  await run(() => chrome.runtime.sendMessage({ type: "get-state" }));
}

async function run(send: () => Promise<unknown>): Promise<void> {
  error.textContent = "";
  try {
    const response = (await send()) as { ok?: boolean; error?: string; state?: UiState } | undefined;
    if (!response?.ok) {
      error.textContent = response?.error ?? "Cursor Control did not answer.";
      return;
    }
    if (response.state) render(response.state);
  } catch (caught) {
    error.textContent = caught instanceof Error ? caught.message : String(caught);
  }
}

function render(state: UiState): void {
  lamp.className = `lamp ${state.connection}`;
  status.textContent = statusText[state.connection];
  if (state.reason && (state.connection === "rejected" || state.connection === "disconnected")) {
    status.textContent = state.reason;
  }
  const showPair = state.connection === "challenge" && Boolean(state.code);
  pair.hidden = !showPair;
  code.textContent = state.code ?? "";
  disconnect.hidden = state.connection !== "paired";

  if (!state.activeTabControllable) {
    active.textContent = "This page cannot be armed.";
    arm.disabled = true;
    arm.textContent = "Arm this tab";
  } else if (state.activeTabArmed) {
    active.textContent = state.activeTabTitle || "This tab";
    arm.disabled = true;
    arm.textContent = "This tab is armed";
  } else {
    active.textContent = state.activeTabTitle || "Current tab";
    arm.disabled = false;
    arm.textContent = "Arm this tab";
  }

  tabs.replaceChildren();
  for (const tab of state.armed) {
    const item = document.createElement("li");
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = tab.title || "Untitled";
    const host = document.createElement("span");
    host.textContent = hostOf(tab.url);
    copy.append(title, host);
    const stop = document.createElement("button");
    stop.type = "button";
    stop.textContent = "Stop";
    stop.addEventListener("click", () => {
      void run(() => chrome.runtime.sendMessage({ type: "disarm", tabId: tab.tabId }));
    });
    item.append(copy, stop);
    tabs.append(item);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
