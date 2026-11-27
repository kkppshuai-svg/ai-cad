import assert from "node:assert/strict";
import test from "node:test";
import { compileFbsVerification } from "./fbs-verification.js";

test("compiles mounting width and working travel with an explicit target", () => {
  const result = compileFbsVerification({ requirements: "整体安装外宽范围 20 至 26 mm。工作挠度范围 0.14 至 0.21 mm，目标工作挠度 0.165 mm。一端固支，自由端沿 Z 方向施加 20 N 静载，弹性模量 70 GPa。" });
  assert.deepEqual(result.requirements.map(({kind, minMm, maxMm, targetMm}) => [kind, minMm, maxMm, targetMm]),
    [["outside_width", 20, 26, undefined], ["deflection", 0.14, 0.21, 0.165]]);
  assert.ok(result.requirements.every(row => !row.missing));
});

test("explicit manual criteria are traceable even when no automated measure applies", () => {
  const result = compileFbsVerification({}, {criteria: "必须人工复核：装配后扳手能否伸入。" });
  assert.deepEqual(result.requirements, [{id: "review-1", kind: "design_review",
    statement: "装配后扳手能否伸入", sourceIds: ["user-criteria"]}]);
});

test("conflicting width ranges request clarification", () => {
  const result = compileFbsVerification({requirements: "整体安装外宽范围 20 至 26 mm。整体安装外宽范围 32 至 38 mm。"});
  assert.ok(result.requirements[0].missing.includes("minMm"));
});

test("maps explicit envelope and static cantilever targets with FBS trace IDs", () => {
  const result = compileFbsVerification({
    requirements: "XYZ 包络上限 130 × 30 × 12 mm。一端理想固支，自由端沿 Z 方向施加 20 至 22 N 静载，弹性模量 70 GPa。最大允许挠度 0.25 mm，最大允许应力 20 MPa。",
    behaviors: [{ id: "be-1", label: "限制挠度" }],
    acceptanceChecks: [{ id: "ac-1", statement: "验证最大挠度", sourceIds: ["be-1", "s-1"] }]
  });
  assert.deepEqual(result, {
    requirements: [
      { id: "fbs-envelope", kind: "envelope", maxMm: [130, 30, 12], sourceIds: ["user-requirements"] },
      { id: "fbs-deflection", kind: "deflection", maxMm: 0.25, sourceIds: ["user-requirements", "be-1", "ac-1", "s-1"] },
      { id: "fbs-stress", kind: "stress", maxMPa: 20, sourceIds: ["user-requirements"] }
    ],
    loadCase: { support: "ideal_clamp", kind: "static_tip_force", forceN: [20, 22] },
    material: { youngMPa: 70_000 }
  });
});

test("missing values in a qualitative target do not come from planner assumptions", () => {
  const result = compileFbsVerification({
    requirements: "支架固定后不能弯太多。",
    criteria: "一端理想固支，自由端沿 Z 方向施加 20 N 静载，弹性模量 70 GPa，最大允许挠度 0.25 mm。",
    behaviors: [{ id: "be-1", label: "控制挠度", specifications: ["最大允许挠度 0.25 mm"] }]
  });
  assert.equal(result.requirements[0].maxMm, undefined);
  assert.deepEqual(result.requirements[0].sourceIds, ["user-requirements", "be-1"]);
  assert.deepEqual(result.requirements[0].missing, ["maxMm", "loadCase.support", "loadCase.kind", "loadCase.forceN", "material.youngMPa"]);
});

test("geometry-only requests do not inherit hypothetical engineering targets", () => {
  assert.equal(compileFbsVerification({
    requirements: "做一块外形尺寸 120 × 24 × 8 mm 的板，不需要检查应力。",
    criteria: "包络上限 130 × 30 × 12 mm。",
    behaviors: [{ id: "be-1", label: "限制变形", specifications: ["最大允许挠度 0.25 mm"] }]
  }), undefined);
});

test("ambiguous limits and alternative load cases stay unresolved", () => {
  const result = compileFbsVerification({
    requirements: "一端理想固支，自由端沿 Z 方向施加 20 N 静载，施加 30 N 分布载荷，弹性模量 70 GPa。挠度不超过 0.25 mm。挠度不超过 0.3 mm。"
  });
  assert.deepEqual(result.requirements[0].missing, ["maxMm", "loadCase.kind", "loadCase.forceN"]);
  assert.equal(result.loadCase.kind, undefined);
});

test("rejects unsupported directions and avoids misreading grouped loads", () => {
  const result = compileFbsVerification({
    requirements: "一端固支，自由端施加 1,200 N 静载，非沿 Z 方向，弹性模量 70 GPa，挠度不超过 0.25 mm。"
  });
  assert.deepEqual(result.requirements[0].missing, ["loadCase.kind", "loadCase.forceN"]);
});

test("an unspecified or explicitly denied rigid clamp does not select the beam model", () => {
  for (const support of ["设一个固定端", "不是理想固支", "两端理想固支", "采用简支"]) {
    const result = compileFbsVerification({
      requirements: `${support}，自由端沿 Z 方向施加 20 N 静载，弹性模量 70 GPa，挠度上限 0.25 mm。`
    });
    assert.equal(result.loadCase.support, undefined, support);
    assert.deepEqual(result.requirements[0].missing, ["loadCase.support"], support);
  }
});

test("documented user supplementation can complete an existing behavior target", () => {
  const result = compileFbsVerification({ requirements: "悬臂梁的挠度要尽量小。" }, {
    criteria: "一端理想固支，自由端沿 Z 方向施加 20 N 静载，弹性模量 70 GPa，挠度上限 0.25 mm。"
  });
  assert.equal(result.requirements[0].maxMm, 0.25);
  assert.equal(result.requirements[0].missing, undefined);
  assert.deepEqual(result.requirements[0].sourceIds, ["user-requirements", "user-criteria"]);
});

test("a separately stated force value completes an already specified load case", () => {
  const result = compileFbsVerification({ requirements: "一端理想固支，自由端沿 Z 方向施加静载。挠度上限 0.25 mm。" }, {
    criteria: "载荷 20 N，弹性模量 70 GPa。夹具额定容量 80 N。"
  });
  assert.deepEqual(result.loadCase, { support: "ideal_clamp", kind: "static_tip_force", forceN: 20 });
  assert.equal(result.requirements[0].missing, undefined);
});
