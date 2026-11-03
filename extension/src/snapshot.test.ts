import assert from "node:assert/strict";
import test from "node:test";
import { pruneAccessibilityTree, type AxNode } from "./snapshot.ts";

function node(partial: AxNode): AxNode {
  return partial;
}

test("keeps controls and headings and drops static text", () => {
  const nodes: AxNode[] = [
    node({
      nodeId: "1",
      role: { value: "RootWebArea" },
      name: { value: "Fixture" },
      childIds: ["2", "3", "4"],
    }),
    node({
      nodeId: "2",
      role: { value: "heading" },
      name: { value: "Fixture" },
      backendDOMNodeId: 10,
      properties: [{ name: "level", value: { value: 1 } }],
      childIds: ["5"],
    }),
    node({
      nodeId: "5",
      ignored: true,
      role: { value: "StaticText" },
      name: { value: "Fixture" },
    }),
    node({
      nodeId: "3",
      role: { value: "button" },
      name: { value: "Press me" },
      backendDOMNodeId: 11,
    }),
    node({
      nodeId: "4",
      role: { value: "textbox" },
      name: { value: "Name" },
      value: { value: "" },
      backendDOMNodeId: 12,
      properties: [{ name: "focused", value: { value: true } }],
    }),
    node({
      nodeId: "6",
      role: { value: "generic" },
      childIds: ["7"],
    }),
    node({
      nodeId: "7",
      role: { value: "StaticText" },
      name: { value: "noise" },
    }),
  ];

  const snapshot = pruneAccessibilityTree(nodes);
  assert.match(snapshot.text, /e1 heading "Fixture" level=1/);
  assert.match(snapshot.text, /e2 button "Press me"/);
  assert.match(snapshot.text, /e3 textbox "Name" value="" focused/);
  assert.doesNotMatch(snapshot.text, /noise/);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.refs.e2?.backendDOMNodeId, 11);
  assert.equal(snapshot.refs.e1?.name, "Fixture");
});

test("walks through ignored wrappers and keeps a nested button", () => {
  const snapshot = pruneAccessibilityTree([
    node({ nodeId: "root", role: { value: "RootWebArea" }, childIds: ["wrap"] }),
    node({ nodeId: "wrap", ignored: true, role: { value: "generic" }, childIds: ["btn"] }),
    node({
      nodeId: "btn",
      role: { value: "button" },
      name: { value: "Save" },
      backendDOMNodeId: 4,
    }),
  ]);

  assert.match(snapshot.text, /e1 button "Save"/);
  assert.equal(snapshot.refs.e1?.backendDOMNodeId, 4);
});

test("truncates after the requested number of nodes", () => {
  const children = Array.from({ length: 5 }, (_, index) => `b${index}`);
  const nodes: AxNode[] = [
    node({ nodeId: "root", role: { value: "RootWebArea" }, childIds: children }),
    ...children.map((id, index) =>
      node({
        nodeId: id,
        role: { value: "button" },
        name: { value: `B${index}` },
        backendDOMNodeId: index + 1,
      }),
    ),
  ];

  const snapshot = pruneAccessibilityTree(nodes, { maxNodes: 2 });
  assert.match(snapshot.text, /e1 button "B0"/);
  assert.match(snapshot.text, /e2 button "B1"/);
  assert.doesNotMatch(snapshot.text, /B2/);
  assert.match(snapshot.text, /\[truncated\]/);
  assert.equal(snapshot.truncated, true);
  assert.equal(Object.keys(snapshot.refs).length, 2);
});

test("includes a focused generic node and reports an empty page", () => {
  const focused = pruneAccessibilityTree([
    node({
      nodeId: "root",
      role: { value: "generic" },
      name: { value: "panel" },
      properties: [{ name: "focused", value: { value: true } }],
      backendDOMNodeId: 3,
    }),
  ]);
  assert.match(focused.text, /e1 generic "panel" focused/);

  const empty = pruneAccessibilityTree([
    node({ nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Blank" } }),
  ]);
  assert.equal(empty.text, "(no interactive elements)");
  assert.deepEqual(empty.refs, {});
});
