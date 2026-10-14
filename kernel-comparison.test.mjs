import test from "node:test";
import assert from "node:assert/strict";
import { analyticVolume, buildKernelComparison } from "./kernel-comparison.js";
import { normalizeParametricPlan } from "./parametric-plan.js";

const plate = () => normalizeParametricPlan({ parts: [{ id: "plate", name: "plate",
  primitives: [{ type: "box", size: [40, 30, 6] }],
  features: [{ type: "hole", diameter: 8, depth: 20, axis: "z", center: [0, 0, 0] }] }] });

test("independent volume reference is only used for supported analytic geometry", () => {
  const plan = plate();
  assert.equal(analyticVolume(plan.parts[0]).value, 7200 - Math.PI * 16 * 6);
  plan.parts[0].featureTree[1].params.center = [30, 0, 0];
  assert.equal(analyticVolume(plan.parts[0]), null);
});

test("comparison reports independent errors and shared rule-based rigid-body DOF separately", () => {
  const plan = plate(), volume = analyticVolume(plan.parts[0]).value;
  const results = [
    { engine: "usd-brep", status: "passed", preview: { nativeReport: { volumeMm3: volume, restoredVolumeMm3: volume,
      bboxMm: [40,30,6], manifoldSolid: true, faceCount: 7, edgeCount: 15 } } },
    { engine: "cadquery", status: "passed", preview: { geometryFacts: { volume: volume + 0.01, bbox: [40,30,6] }, geometryValid: true } }
  ];
  const report = buildKernelComparison(plan, results);
  assert.ok(Math.abs(report.volumeDifferenceMm3 - 0.01) < 1e-8);
  assert.equal(report.engines[0].analyticVolumeErrorMm3, 0);
  assert.equal(report.dof.analysis.parts.plate.remainingDof, 6);
  plan.constraints = [{ id: "fixed", type: "fixed", from: { partId: "world" }, to: { partId: "plate" } }];
  assert.equal(buildKernelComparison(plan, results).dof.analysis.parts.plate.remainingDof, 0);
});

test("unsupported native builds stay failed while independent OpenCascade results remain available", () => {
  const report = buildKernelComparison(plate(), [{ engine: "usd-brep", status: "failed", error: "unsupported" },
    { engine: "cadquery", status: "passed", preview: { geometryFacts: { volume: 1 } } }]);
  assert.equal(report.engines[0].status, "failed");
  assert.equal(report.volumeDifferenceMm3, null);
});
