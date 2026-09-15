import test from "node:test";
import assert from "node:assert/strict";
import { assertAssemblyPartCount, MAX_ASSEMBLY_PARTS } from "./assembly-plan-limits.js";

test("accepts a normal ten-part gearbox assembly", () => {
  const parts = Array.from({ length: 10 }, (_, index) => ({ id: `part-${index}` }));
  assert.doesNotThrow(() => assertAssemblyPartCount(parts));
});

test("keeps a clear safety cap for pathological plans", () => {
  const parts = Array.from({ length: MAX_ASSEMBLY_PARTS + 1 }, (_, index) => ({ id: `part-${index}` }));
  assert.throws(() => assertAssemblyPartCount(parts), /maximum 16, received 17/);
});
