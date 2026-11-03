const HOST_ID = "cursor-control-host";

type OverlayMessage =
  | { type: "overlay-hidden"; hidden: boolean }
  | { type: "overlay-busy"; busy: boolean }
  | { type: "overlay-remove" };

const state = globalThis as typeof globalThis & {
  __cursorControlOverlay?: boolean;
  __cursorControlLabel?: HTMLElement | null;
};

if (!state.__cursorControlOverlay) {
  state.__cursorControlOverlay = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isOverlayMessage(message)) return;
    const host = document.getElementById(HOST_ID);
    if (message.type === "overlay-remove") host?.remove();
    if (message.type === "overlay-hidden" && host) {
      host.style.setProperty("display", message.hidden ? "none" : "block", "important");
    }
    if (message.type === "overlay-busy" && state.__cursorControlLabel) {
      state.__cursorControlLabel.textContent = message.busy ? "Working" : "Cursor";
    }
    sendResponse({ ok: true });
    return true;
  });
}

mount();

function mount(): void {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("aria-hidden", "true");
  const style = host.style;
  style.setProperty("all", "initial", "important");
  style.setProperty("position", "fixed", "important");
  style.setProperty("z-index", "2147483647", "important");
  style.setProperty("right", "16px", "important");
  style.setProperty("bottom", "16px", "important");
  style.setProperty("left", "auto", "important");
  style.setProperty("top", "auto", "important");
  style.setProperty("display", "block", "important");
  style.setProperty("width", "auto", "important");
  style.setProperty("height", "auto", "important");
  style.setProperty("margin", "0", "important");
  style.setProperty("pointer-events", "auto", "important");

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .chip {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 7px 7px 10px;
        background: #1a1714;
        color: #f3ecdf;
        border-radius: 999px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
        font: 600 12px/1 Palatino, "Palatino Linotype", Georgia, serif;
        letter-spacing: 0.02em;
      }
      .lamp {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #b6f25c;
        box-shadow: 0 0 0 3px rgba(182, 242, 92, 0.18);
      }
      button {
        border: 0;
        background: #ff5c1c;
        color: #1a1714;
        border-radius: 999px;
        padding: 6px 10px;
        cursor: pointer;
        font: 700 11px/1 Palatino, "Palatino Linotype", Georgia, serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
    </style>
    <div class="chip">
      <span class="lamp"></span>
      <span id="label">Cursor</span>
      <button id="stop" type="button">Stop</button>
    </div>
  `;
  state.__cursorControlLabel = shadow.getElementById("label");
  shadow.getElementById("stop")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void chrome.runtime.sendMessage({ type: "overlay-stop" });
  });
  (document.documentElement ?? document.body).appendChild(host);
}

function isOverlayMessage(message: unknown): message is OverlayMessage {
  if (!message || typeof message !== "object" || !("type" in message)) return false;
  const type = (message as { type?: unknown }).type;
  return type === "overlay-hidden" || type === "overlay-busy" || type === "overlay-remove";
}
