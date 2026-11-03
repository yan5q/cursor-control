export type AxValue = {
  type?: string;
  value?: unknown;
};

export type AxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  description?: AxValue;
  value?: AxValue;
  properties?: Array<{ name: string; value?: AxValue }>;
  childIds?: string[];
  backendDOMNodeId?: number;
};

export type ElementRef = {
  backendDOMNodeId?: number;
  role: string;
  name: string;
};

export type Snapshot = {
  text: string;
  refs: Record<string, ElementRef>;
  truncated: boolean;
};

const INCLUDED_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "slider",
  "spinbutton",
  "switch",
  "heading",
]);

const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox"]);

function textOf(value: AxValue | undefined): string {
  if (!value || value.value == null) return "";
  if (typeof value.value === "string") return value.value;
  if (typeof value.value === "number" || typeof value.value === "boolean") return String(value.value);
  return "";
}

function property(node: AxNode, name: string): unknown {
  return node.properties?.find((entry) => entry.name === name)?.value?.value;
}

function roleOf(node: AxNode): string {
  const role = textOf(node.role);
  return role || "unknown";
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim().replaceAll('"', "'");
}

function shouldInclude(node: AxNode): boolean {
  if (node.ignored) return false;
  if (property(node, "focused") === true) return true;
  return INCLUDED_ROLES.has(roleOf(node));
}

function formatLine(node: AxNode, ref: string, depth: number): string {
  const role = roleOf(node);
  const name = clean(textOf(node.name) || textOf(node.description));
  const parts = [`${"  ".repeat(depth)}${ref} ${role} "${name}"`];
  if (VALUE_ROLES.has(role)) parts.push(`value="${clean(textOf(node.value))}"`);
  const level = property(node, "level");
  if (typeof level === "number") parts.push(`level=${level}`);
  const checked = property(node, "checked");
  if (checked === true || checked === "mixed") parts.push(`checked=${String(checked)}`);
  if (property(node, "disabled") === true) parts.push("disabled");
  if (property(node, "focused") === true) parts.push("focused");
  const url = property(node, "url");
  if (typeof url === "string" && url) parts.push(`url="${clean(url)}"`);
  return parts.join(" ");
}

export function pruneAccessibilityTree(nodes: AxNode[], options?: { maxNodes?: number }): Snapshot {
  const maxNodes = options?.maxNodes ?? 300;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const roots = nodes.filter((node) => !childIds.has(node.nodeId)).map((node) => node.nodeId);
  const lines: string[] = [];
  const refs: Record<string, ElementRef> = {};
  let count = 0;
  let truncated = false;
  let nextRef = 1;

  const walk = (nodeId: string, depth: number) => {
    if (truncated) return;
    const node = byId.get(nodeId);
    if (!node) return;
    let nextDepth = depth;
    if (shouldInclude(node)) {
      if (count >= maxNodes) {
        truncated = true;
        return;
      }
      const ref = `e${nextRef++}`;
      count += 1;
      const name = clean(textOf(node.name) || textOf(node.description));
      refs[ref] = { backendDOMNodeId: node.backendDOMNodeId, role: roleOf(node), name };
      lines.push(formatLine(node, ref, depth));
      nextDepth = depth + 1;
    }
    for (const childId of node.childIds ?? []) walk(childId, nextDepth);
  };

  for (const root of roots) walk(root, 0);

  if (lines.length === 0) lines.push("(no interactive elements)");
  if (truncated) lines.push("[truncated]");

  return { text: lines.join("\n"), refs, truncated };
}
