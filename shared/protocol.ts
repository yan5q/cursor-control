export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47321;

export type ArmedTabInfo = {
  tabId: number;
  title: string;
  url: string;
};

export type BridgeCommand =
  | { method: "listArmedTabs" }
  | { method: "snapshot"; tabId?: number }
  | { method: "click"; tabId?: number; ref: string }
  | { method: "hover"; tabId?: number; ref: string }
  | { method: "type"; tabId?: number; ref: string; text: string }
  | { method: "fill"; tabId?: number; ref: string; text: string }
  | { method: "pressKey"; tabId?: number; key: string }
  | { method: "scroll"; tabId?: number; ref?: string; dx?: number; dy?: number }
  | { method: "selectOption"; tabId?: number; ref: string; value: string }
  | { method: "navigate"; tabId?: number; url: string }
  | { method: "back"; tabId?: number }
  | { method: "screenshot"; tabId?: number }
  | { method: "wait"; tabId?: number; timeoutMs?: number; text?: string; load?: boolean };

export type CommandResult = {
  text: string;
  imageBase64?: string;
  mimeType?: string;
};

export type ClientMessage =
  | { type: "hello"; protocol: number; token?: string }
  | { type: "approve" }
  | { type: "disconnect" }
  | { type: "armed"; tabs: ArmedTabInfo[] }
  | { type: "result"; id: string; ok: true; result: CommandResult }
  | { type: "result"; id: string; ok: false; error: string };

export type ServerMessage =
  | { type: "challenge"; code: string }
  | { type: "paired"; token?: string }
  | { type: "rejected"; reason: string }
  | { type: "command"; id: string; command: BridgeCommand };

export type PairingStatus = {
  paired: boolean;
  pendingCode: string | null;
  armedTabs: ArmedTabInfo[];
  port: number;
};
