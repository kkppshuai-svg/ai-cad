import test from "node:test";
import assert from "node:assert/strict";

import { buildNema23LBracketPlan } from "./nema23-template.js";
import { normalizeParametricPlan } from "./parametric-plan.js";

test("builds a deterministic editable single-solid NEMA23 L bracket plan", () => {
  const plan = normalizeParametricPlan(buildNema23LBracketPlan("生成一体式 NEMA23 L 型电机安装支架"));
  const part = plan.parts[0];
  const byId = new Map(part.featureTree.map((node) => [node.id, node]));

  assert.equal(part.requireSingleSolid, true);
  assert.deepEqual(byId.get("nema23_l_motor_bracket.base.01").params.size, [120, 80, 8]);
  assert.equal(byId.get("nema23_l_motor_bracket.center_hole.01").params.diameter, 38.1);
  assert.equal(byId.get("nema23_l_motor_bracket.motor_hole.03").params.diameter, 5.5);
  assert.deepEqual(byId.get("nema23_l_motor_bracket.motor_hole.01").params.center, [-56, -23.57, 24.43]);
  assert.deepEqual(byId.get("nema23_l_motor_bracket.motor_hole.04").params.center, [-56, 23.57, 71.57]);
  assert.equal(byId.get("nema23_l_motor_bracket.adjust_slot.01").params.axis, "x");
  assert.equal(byId.get("nema23_l_motor_bracket.adjust_slot.01").params.length, 40);
  assert.equal(byId.get("nema23_l_motor_bracket.adjust_slot.02").params.center[1] - byId.get("nema23_l_motor_bracket.adjust_slot.01").params.center[1], 50);
});

test("does not claim unrelated prompts", () => {
  assert.equal(buildNema23LBracketPlan("生成一个普通 PCB 外壳"), null);
});
