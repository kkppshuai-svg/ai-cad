import test from "node:test";
import assert from "node:assert/strict";
import { buildFbsPlanningSummary, normalizeFbsAnalysis } from "./fbs-workflow.js";

test("normalizes a complete conversational FBS analysis", () => {
  const candidate = (id, label, upstreamIds = []) => ({ id, label, rationale: "r", specifications: ["check"], upstreamIds });
  const result = normalizeFbsAnalysis({ functions: [candidate("f-1", "支撑")], behaviors: [candidate("be-1", "传递载荷", ["f-1"])], structures: [candidate("s-1", "参数化支架", ["be-1"])] }, "做一个支架");
  assert.equal(result.format, "ai-cad-fbs-analysis-v1"); assert.equal(result.structures[0].upstreamIds[0], "be-1");
  assert.deepEqual(result.acceptanceChecks, []);
});

test("normalizes measurable acceptance checks for downstream BREP validation", () => {
  const result = normalizeFbsAnalysis({
    functions: [{ label: "安装" }],
    behaviors: [{ label: "定位" }],
    structures: [{ label: "安装孔" }],
    acceptanceChecks: [{ id: "ac-hole", statement: "孔径满足要求", measurementId: "plate.hole_diameter", tolerance: 0.05, sourceIds: ["s-1"] }]
  }, "做安装板");
  assert.equal(result.acceptanceChecks[0].measurementId, "plate.hole_diameter");
  assert.equal(result.acceptanceChecks[0].tolerance, 0.05);
});

test("planning summary keeps decisions compact without repeating FBS rationale", () => {
  const summary = buildFbsPlanningSummary({
    requirements: "做一个支架",
    criteria: "孔位可测量",
    functions: [{ id: "f-1", label: "支撑", rationale: "long rationale", specifications: ["承载 10kg"] }],
    behaviors: [{ id: "be-1", label: "传递载荷", rationale: "long rationale", upstreamIds: ["f-1"] }],
    structures: [{ id: "s-1", label: "参数化支架", rationale: "long rationale", upstreamIds: ["be-1"] }]
  });
  assert.equal(summary.functions[0].rationale, undefined);
  assert.equal(summary.structures[0].upstreamIds[0], "be-1");
});
