import type { ArmedTabInfo } from "../../shared/protocol.ts";

export type UiState = {
  connection: "disconnected" | "connecting" | "challenge" | "paired" | "rejected";
  code?: string;
  reason?: string;
  armed: ArmedTabInfo[];
  activeTabId?: number;
  activeTabTitle?: string;
  activeTabArmed: boolean;
  activeTabControllable: boolean;
};
