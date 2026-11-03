import assert from "node:assert/strict";
import test from "node:test";
import { parseKey } from "./keys.ts";

test("parses named keys and modifiers", () => {
  assert.deepEqual(parseKey("Enter"), {
    key: "Enter",
    code: "Enter",
    vk: 13,
    text: "\r",
    modifiers: 0,
  });
  const combo = parseKey("Control+Shift+Enter");
  assert.equal(combo.key, "Enter");
  assert.equal(combo.modifiers, 2 | 8);
  assert.equal(combo.text, undefined);
});

test("parses letters and rejects empty combos", () => {
  const letter = parseKey("Meta+a");
  assert.equal(letter.code, "KeyA");
  assert.equal(letter.modifiers, 4);
  assert.equal(letter.text, undefined);
  assert.throws(() => parseKey("Control+"), /Could not read key/);
  assert.throws(() => parseKey("F5"), /Unsupported key/);
});
