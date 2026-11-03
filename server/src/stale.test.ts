import assert from "node:assert/strict";
import test from "node:test";
import { isCursorBrowserCommand } from "./stale.ts";

test("recognizes this server and ignores other listeners", () => {
  assert.equal(isCursorBrowserCommand("node /Users/jansa/Projects/extensions/server/dist/index.js"), true);
  assert.equal(isCursorBrowserCommand("node C:\\extensions\\server\\dist\\index.js"), true);
  assert.equal(isCursorBrowserCommand("node /usr/local/bin/other-server"), false);
});
