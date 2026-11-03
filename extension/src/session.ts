import { assertSafeUrl } from "../../shared/url.ts";
import { parseKey } from "./keys.ts";
import { pruneAccessibilityTree, type AxNode, type Snapshot } from "./snapshot.ts";

type Waiter = {
  method: string;
  resolve: () => void;
  reject: (error: Error) => void;
};

const waiters = new Map<number, Waiter[]>();

export function installDebuggerEvents(): void {
  if (!chrome.debugger?.onEvent) return;
  chrome.debugger.onEvent.addListener((source, method) => {
    const tabId = source.tabId;
    if (tabId == null) return;
    const list = waiters.get(tabId);
    if (!list) return;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const waiter = list[index];
      if (waiter?.method !== method) continue;
      list.splice(index, 1);
      waiter.resolve();
    }
  });
}

export function waitForEvent(
  tabId: number,
  method: string,
  timeoutMs: number,
): { promise: Promise<void>; cancel: () => void } {
  let waiter!: Waiter;
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      removeWaiter(tabId, waiter);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    waiter = {
      method,
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
    const list = waiters.get(tabId) ?? [];
    list.push(waiter);
    waiters.set(tabId, list);
  });
  return {
    promise,
    cancel() {
      removeWaiter(tabId, waiter);
      waiter.reject(new Error("cancelled"));
    },
  };
}

function removeWaiter(tabId: number, waiter: Waiter): void {
  const list = waiters.get(tabId);
  if (!list) return;
  const index = list.indexOf(waiter);
  if (index >= 0) list.splice(index, 1);
}

export async function send<T>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/detached|target closed|debugger is not attached/i.test(message)) {
      throw new Error("Tab was disarmed. Stop.");
    }
    throw new Error(message);
  }
}

export async function attach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already attached/i.test(message)) {
      if (/devtools|another debugger/i.test(message)) {
        throw new Error("Close DevTools on this tab, then arm it again.");
      }
      throw new Error(message);
    }
  }
  await send(tabId, "Page.enable").catch(() => undefined);
  await send(tabId, "DOM.enable").catch(() => undefined);
  await send(tabId, "Accessibility.enable").catch(() => undefined);
  await send(tabId, "DOM.getDocument", { depth: 0, pierce: true }).catch(() => undefined);
}

export async function readSnapshot(tabId: number): Promise<Snapshot> {
  const tree = await send<{ nodes?: AxNode[] }>(tabId, "Accessibility.getFullAXTree");
  return pruneAccessibilityTree(tree.nodes ?? []);
}

async function elementPoint(tabId: number, backendNodeId: number): Promise<{ x: number; y: number }> {
  try {
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    throw new Error("Element is gone. Take a new snapshot.");
  }
  const quads = await send<{ quads?: number[][] }>(tabId, "DOM.getContentQuads", { backendNodeId }).catch(() => ({
    quads: [] as number[][],
  }));
  const quad = quads.quads?.find((entry) => entry.length >= 8);
  if (!quad) throw new Error("Element is not visible. Take a new snapshot.");
  return {
    x: ((quad[0] ?? 0) + (quad[2] ?? 0) + (quad[4] ?? 0) + (quad[6] ?? 0)) / 4,
    y: ((quad[1] ?? 0) + (quad[3] ?? 0) + (quad[5] ?? 0) + (quad[7] ?? 0)) / 4,
  };
}

async function mouse(
  tabId: number,
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  x: number,
  y: number,
): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" ? "none" : "left",
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

export async function click(tabId: number, backendNodeId: number): Promise<void> {
  const point = await elementPoint(tabId, backendNodeId);
  await mouse(tabId, "mouseMoved", point.x, point.y);
  await mouse(tabId, "mousePressed", point.x, point.y);
  await mouse(tabId, "mouseReleased", point.x, point.y);
}

export async function hover(tabId: number, backendNodeId: number): Promise<void> {
  const point = await elementPoint(tabId, backendNodeId);
  await mouse(tabId, "mouseMoved", point.x, point.y);
}

async function focus(tabId: number, backendNodeId: number): Promise<void> {
  try {
    await send(tabId, "DOM.focus", { backendNodeId });
  } catch {
    throw new Error("Element is gone. Take a new snapshot.");
  }
}

export async function typeText(tabId: number, backendNodeId: number, text: string): Promise<void> {
  await focus(tabId, backendNodeId);
  await send(tabId, "Input.insertText", { text });
}

export async function fillText(tabId: number, backendNodeId: number, text: string): Promise<void> {
  await focus(tabId, backendNodeId);
  const resolved = await send<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("Element is gone. Take a new snapshot.");
  try {
    const evaluated = await send<{ result?: { value?: { ok?: boolean; error?: string } } }>(
      tabId,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function(value) {
          const element = this;
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            element.value = value;
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
          }
          if (element.isContentEditable) {
            element.textContent = value;
            element.dispatchEvent(new Event("input", { bubbles: true }));
            return { ok: true };
          }
          return { ok: false, error: "Element is not a text field" };
        }`,
        arguments: [{ value: text }],
        returnByValue: true,
      },
    );
    if (evaluated.result?.value?.ok) return;
    throw new Error(evaluated.result?.value?.error ?? "Could not fill the field");
  } finally {
    await send(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

export async function pressKey(tabId: number, combo: string): Promise<void> {
  const parsed = parseKey(combo);
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: parsed.modifiers,
    key: parsed.key,
    code: parsed.code,
    windowsVirtualKeyCode: parsed.vk,
    nativeVirtualKeyCode: parsed.vk,
    text: parsed.text,
  });
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: parsed.modifiers,
    key: parsed.key,
    code: parsed.code,
    windowsVirtualKeyCode: parsed.vk,
    nativeVirtualKeyCode: parsed.vk,
  });
}

export async function scroll(
  tabId: number,
  backendNodeId: number | undefined,
  dx: number,
  dy: number,
): Promise<void> {
  let x = 0;
  let y = 0;
  if (backendNodeId != null) {
    const point = await elementPoint(tabId, backendNodeId);
    x = point.x;
    y = point.y;
    if (dx === 0 && dy === 0) return;
  } else {
    const metrics = await send<{
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    }>(tabId, "Page.getLayoutMetrics");
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    x = (viewport?.clientWidth ?? 800) / 2;
    y = (viewport?.clientHeight ?? 600) / 2;
  }
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: dx,
    deltaY: dy,
  });
}

export async function selectOption(tabId: number, backendNodeId: number, value: string): Promise<void> {
  const resolved = await send<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("Element is gone. Take a new snapshot.");
  try {
    const evaluated = await send<{ result?: { value?: { ok?: boolean; error?: string } } }>(
      tabId,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function(value) {
          const element = this;
          if (!(element instanceof HTMLSelectElement)) return { ok: false, error: "Element is not a select" };
          const match = Array.from(element.options).find((option) => option.value === value || option.label === value || option.text === value);
          if (!match) return { ok: false, error: "Option not found" };
          element.value = match.value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        }`,
        arguments: [{ value }],
        returnByValue: true,
      },
    );
    if (!evaluated.result?.value?.ok) {
      throw new Error(evaluated.result?.value?.error ?? "Could not select the option");
    }
  } finally {
    await send(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

export async function navigate(tabId: number, url: string): Promise<string> {
  const safe = assertSafeUrl(url);
  const load = waitForEvent(tabId, "Page.loadEventFired", 20_000);
  void load.promise.catch(() => undefined);
  try {
    const result = await send<{ errorText?: string }>(tabId, "Page.navigate", { url: safe });
    if (result.errorText) throw new Error(result.errorText);
    await load.promise.catch(() => undefined);
  } catch (error) {
    load.cancel();
    throw error;
  }
  const tab = await chrome.tabs.get(tabId);
  return tab.url ?? safe;
}

export async function goBack(tabId: number): Promise<string> {
  const history = await send<{ currentIndex?: number; entries?: Array<{ id: number; url?: string }> }>(
    tabId,
    "Page.getNavigationHistory",
  );
  const index = history.currentIndex ?? 0;
  const entry = history.entries?.[index - 1];
  if (index <= 0 || !entry) throw new Error("No previous history entry");
  const load = waitForEvent(tabId, "Page.loadEventFired", 20_000);
  void load.promise.catch(() => undefined);
  try {
    await send(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
    await load.promise.catch(() => undefined);
  } catch (error) {
    load.cancel();
    throw error;
  }
  const tab = await chrome.tabs.get(tabId);
  return tab.url ?? entry.url ?? "";
}

export async function captureScreenshot(tabId: number): Promise<string> {
  const shot = await send<{ data?: string }>(tabId, "Page.captureScreenshot", { format: "png" });
  if (!shot.data) throw new Error("Screenshot failed");
  return shot.data;
}

export async function waitForText(tabId: number, text: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await pageIncludesText(tabId, text)) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for "${text}"`);
}

async function pageIncludesText(tabId: number, text: string): Promise<boolean> {
  const result = await send<{ result?: { value?: boolean } }>(tabId, "Runtime.evaluate", {
    expression: `(() => {
      const body = document.body;
      return Boolean(body && (body.innerText || "").includes(${JSON.stringify(text)}));
    })()`,
    returnByValue: true,
  });
  return result.result?.value === true;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
