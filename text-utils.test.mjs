import test from "node:test";
import assert from "node:assert/strict";
import { boundedInt, sanitizeText } from "./text-utils.js";

test("sanitizeText collapses newlines, tabs and repeated spaces", () => {
  assert.equal(sanitizeText("做一个\n底盘\t长 500", 100), "做一个 底盘 长 500");
  assert.equal(sanitizeText("  padded  ", 100), "padded");
});

test("sanitizeText strips control characters including DEL", () => {
  assert.equal(sanitizeText("a\u0001b\u0007c\u007fd", 100), "a b c d");
  assert.equal(sanitizeText("x\u0000y", 100), "x y");
});

test("sanitizeText clamps to maxLength after trimming", () => {
  assert.equal(sanitizeText("  abcdefgh  ", 4), "abcd");
  assert.equal(sanitizeText("abc", undefined), "abc");
});

test("sanitizeText coerces nullish and non-string input", () => {
  assert.equal(sanitizeText(null, 10), "");
  assert.equal(sanitizeText(undefined, 10), "");
  assert.equal(sanitizeText(0, 10), "0");
  assert.equal(sanitizeText(false, 10), "false");
});

test("boundedInt clamps into range and rounds", () => {
  assert.equal(boundedInt(99, 5, 1, 8), 8);
  assert.equal(boundedInt(-3, 5, 1, 8), 1);
  assert.equal(boundedInt(3.6, 5, 1, 8), 4);
  assert.equal(boundedInt("7", 5, 1, 8), 7);
});

test("boundedInt falls back only for non-finite input", () => {
  for (const value of [undefined, "abc", Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.equal(boundedInt(value, 5, 1, 8), 5, String(value));
  }
  // Number(null) is 0, which is finite, so null clamps to the minimum instead.
  assert.equal(boundedInt(null, 5, 1, 8), 1);
});
