import test from "node:test";
import assert from "node:assert/strict";

import { validatePartComplexity } from "./plan-complexity.js";

test("feature-tree parts allow up to 96 nodes and ignore compatibility arrays", () => {
  const part = {
    featureTree: Array.from({ length: 96 }, () => ({})),
    primitives: Array.from({ length: 100 }, () => ({})),
    features: Array.from({ length: 100 }, () => ({}))
  };

  assert.doesNotThrow(() => validatePartComplexity(part));
});

test("feature-tree parts reject more than 96 nodes", () => {
  const part = { featureTree: Array.from({ length: 97 }, () => ({})) };

  assert.throws(
    () => validatePartComplexity(part),
    /feature tree has too many nodes.*maximum is 96/i
  );
});

test("legacy parts allow up to 32 primitives and 64 features", () => {
  const part = {
    primitives: Array.from({ length: 32 }, () => ({})),
    features: Array.from({ length: 64 }, () => ({}))
  };

  assert.doesNotThrow(() => validatePartComplexity(part));
});

test("legacy parts reject more than 32 primitives", () => {
  const part = { primitives: Array.from({ length: 33 }, () => ({})), features: [] };

  assert.throws(
    () => validatePartComplexity(part),
    /too many primitives.*maximum is 32/i
  );
});

test("legacy parts reject more than 64 features", () => {
  const part = { primitives: [], features: Array.from({ length: 65 }, () => ({})) };

  assert.throws(
    () => validatePartComplexity(part),
    /too many features.*maximum is 64/i
  );
});
