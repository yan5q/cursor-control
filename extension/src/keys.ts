export type ParsedKey = {
  key: string;
  code: string;
  vk: number;
  text?: string;
  modifiers: number;
};

const MODIFIERS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

const NAMED: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  " ": { key: " ", code: "Space", vk: 32, text: " " },
};

export function parseKey(combo: string): ParsedKey {
  const parts = combo
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("Missing key");

  let modifiers = 0;
  const keys: string[] = [];
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier && keys.length === 0) {
      modifiers |= modifier;
      continue;
    }
    keys.push(part);
  }
  if (keys.length !== 1) {
    throw new Error(`Could not read key "${combo}". Use names like Enter, Tab, or Control+Enter.`);
  }

  const raw = keys[0] ?? "";
  const named = NAMED[raw.toLowerCase()];
  if (named) {
    return {
      ...named,
      text: modifiers ? undefined : named.text,
      modifiers,
    };
  }

  if (raw.length === 1) {
    const letter = /[a-z]/i.test(raw);
    const digit = /[0-9]/.test(raw);
    return {
      key: modifiers & 8 ? raw.toUpperCase() : raw,
      code: letter ? `Key${raw.toUpperCase()}` : digit ? `Digit${raw}` : raw,
      vk: letter || digit ? raw.toUpperCase().charCodeAt(0) : raw.charCodeAt(0),
      text: modifiers ? undefined : modifiers & 8 ? raw.toUpperCase() : raw,
      modifiers,
    };
  }

  throw new Error(`Unsupported key "${raw}". Use Enter, Tab, Escape, arrows, or a single character.`);
}

export function selectAllCombo(): string {
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? "Meta+a" : "Control+a";
}
