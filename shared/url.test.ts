import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeUrl, isControllablePage } from "./url.ts";

test("allows http and https urls", () => {
  assert.equal(assertSafeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(assertSafeUrl("http://127.0.0.1:9/fixture"), "http://127.0.0.1:9/fixture");
});

test("rejects javascript and non-web urls", () => {
  assert.throws(() => assertSafeUrl("javascript:alert(1)"), /javascript:/);
  assert.throws(() => assertSafeUrl("chrome://settings"), /http and https/);
  assert.throws(() => assertSafeUrl("not a url"), /Invalid URL/);
});

test("controllable pages are only web pages", () => {
  assert.equal(isControllablePage("https://example.com"), true);
  assert.equal(isControllablePage("chrome://newtab"), false);
  assert.equal(isControllablePage(undefined), false);
});
