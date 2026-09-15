import test from "node:test";
import assert from "node:assert/strict";

import {
  assessManufacturability,
  buildRepairWorkQueue,
  canPromoteRevision,
  classifyValidationIssues,
  compactValidationForRepair,
  mergeValidationReports,
  proposeDeterministicRepairs,
  scoreRepairCandidate,
  validateFbsAcceptanceCoverage,
  validateBrepReviewCoverage,
  validateRepairInvariants,
  validateBuildEvidence
} from "./cad-validation.js";


test("blocking geometry, interference, and constraint issues prevent promotion", () => {
  const report = mergeValidationReports({
    planIssues: [],
    geometryReports: [{ partId: "bad", blockingErrorCount: 1, issues: [{ code: "INVALID_BREP", severity: "error" }] }],
    interferences: [{ parts: ["a", "b"], volume: 5, code: "PART_INTERFERENCE", severity: "error" }],
    constraintReport: { errors: [{ code: "CONFLICTING_DISTANCE" }], warnings: [] },
    manufacturingIssues: []
  });
  assert.equal(report.blockingErrorCount, 3);
  assert.equal(canPromoteRevision(report), false);
  assert.deepEqual(report.summary, { errors: 3, warnings: 0, info: 0 });
});

test("FBS acceptance checks must map to measured BREP dimensions", () => {
  const plan = { concept: { acceptanceChecks: [
    { id: "ac-1", statement: "孔径满足要求", measurementId: "plate.bore" },
    { id: "ac-2", statement: "总长满足要求", measurementId: "plate.length" }
  ] } };
  const issues = validateFbsAcceptanceCoverage(plan, { measurements: [{ id: "plate.bore", status: "pass" }] });
  assert.deepEqual(issues.map((issue) => issue.measurementId), ["plate.length"]);
});

test("BREP review requires solid, volume, and bounding-box evidence", () => {
  const plan = { parts: [{ id: "plate" }, { id: "shaft" }] };
  const issues = validateBrepReviewCoverage(plan, { geometryValidation: { parts: [
    { partId: "plate", valid: true, facts: { solidCount: 1, volume: 10, bbox: [10, 10, 2] } },
    { partId: "shaft", valid: true, facts: { solidCount: 1, volume: 10, bbox: [10, 0, 2] } }
  ] } });
  assert.deepEqual(issues.map((issue) => issue.code), ["BREP_REVIEW_NO_BBOX_EVIDENCE"]);
});

test("build evidence requires every planned part, validation report, and assembly STEP", () => {
  const issues = validateBuildEvidence(
    { parts: [{ id: "left" }, { id: "right" }] },
    { stepPath: null, parts: [{ id: "left", localStepPath: "/tmp/left.step" }], geometryValidation: { parts: [{ partId: "left", blockingErrorCount: 0, issues: [] }] } }
  );
  assert.ok(issues.some((item) => item.code === "MISSING_ASSEMBLY_STEP"));
  assert.ok(issues.some((item) => item.code === "MISSING_PART_ARTIFACT" && item.partId === "right"));
  assert.ok(issues.some((item) => item.code === "MISSING_GEOMETRY_VALIDATION" && item.partId === "right"));
});


test("warning-only manufacturability risks allow promotion", () => {
  const report = mergeValidationReports({
    geometryReports: [{ partId: "plate", blockingErrorCount: 0, issues: [] }],
    manufacturingIssues: [{ code: "HOLE_EDGE_DISTANCE", severity: "warning", partId: "plate" }]
  });
  assert.equal(report.blockingErrorCount, 0);
  assert.equal(canPromoteRevision(report), true);
  assert.equal(report.summary.warnings, 1);
});

test("intended assembly contact is reported but does not block promotion", () => {
  const report = mergeValidationReports({
    interferences: [{ parts: ["shaft", "bearing"], volume: 12, code: "PART_INTERFERENCE", severity: "error", intendedContact: true }]
  });
  assert.equal(report.blockingErrorCount, 0);
  assert.equal(report.summary.info, 1);
  assert.equal(report.issues[0].severity, "info");
});


test("safe repair proposals reduce finishes and extend through cuts with audit", () => {
  const plan = {
    parts: [{
      id: "plate",
      featureTree: [
        { id: "plate.fillet.01", type: "fillet", params: { radius: 4 }, selector: { kind: "named", name: "outer" } },
        { id: "plate.hole.01", type: "hole", params: { diameter: 6, depth: 4, center: [0, 0, 0], axis: "z" } }
      ]
    }]
  };
  const repairs = proposeDeterministicRepairs({ issues: [
    { code: "FINISH_FEATURE_FAILED", partId: "plate", featureId: "plate.fillet.01" },
    { code: "CUT_NOT_THROUGH", partId: "plate", featureId: "plate.hole.01", requiredDepth: 12 }
  ] }, plan);

  assert.deepEqual(repairs.patch.operations, [
    { op: "set_param", partId: "plate", featureId: "plate.fillet.01", path: "params.radius", value: 2 },
    { op: "set_param", partId: "plate", featureId: "plate.hole.01", path: "params.depth", value: 12 }
  ]);
  assert.equal(repairs.audit[0].originalValue, 4);
  assert.equal(repairs.audit[0].repairedValue, 2);
});


test("repair policy never silently changes functional hole diameter or center", () => {
  const plan = { parts: [{ id: "plate", featureTree: [{ id: "plate.hole.01", type: "hole", params: { diameter: 6, depth: 10, center: [9, 0, 0] } }] }] };
  const repairs = proposeDeterministicRepairs({ issues: [
    { code: "HOLE_EDGE_DISTANCE", partId: "plate", featureId: "plate.hole.01" },
    { code: "PART_INTERFERENCE", parts: ["plate", "shaft"] }
  ] }, plan);
  assert.deepEqual(repairs.patch.operations, []);
  assert.equal(repairs.requiresAi.length, 2);
});

test("minimum-positive clamp requires an explicitly safe parameter", () => {
  const plan = { parts: [{ id: "plate", featureTree: [{ id: "plate.extrude.01", type: "add_extrude", params: { depth: 0 } }] }] };
  const repairs = proposeDeterministicRepairs({ issues: [{ code: "MINIMUM_POSITIVE_REQUIRED", partId: "plate", featureId: "plate.extrude.01", path: "params.depth", minimum: 0.05, safeToClamp: true }] }, plan);
  assert.deepEqual(repairs.patch.operations, [{ op: "set_param", partId: "plate", featureId: "plate.extrude.01", path: "params.depth", value: 0.05 }]);
  assert.equal(repairs.audit[0].action, "minimum_positive_clamp");
});

test("validation issues are classified before repair planning", () => {
  const classes = classifyValidationIssues({ issues: [
    { code: "CUT_NOT_THROUGH", severity: "error", partId: "plate" },
    { code: "PART_INTERFERENCE", severity: "error" },
    { code: "HOLE_EDGE_DISTANCE", severity: "warning" }
  ] });
  assert.deepEqual(classes.map((item) => [item.category, item.automatic]), [["deterministic", true], ["assembly", false], ["manufacturing", false]]);
});

test("repair queue suppresses downstream duplicates and limits each repair batch", () => {
  const report = { issues: [
    { code: "INVALID_BREP", severity: "error", partId: "gear" },
    { code: "BREP_REVIEW_NO_SOLID_EVIDENCE", severity: "error", partId: "gear" },
    { code: "STEP_ROUNDTRIP_FAILED", severity: "error", partId: "gear" },
    { code: "DIMENSION_MISMATCH", severity: "error", partId: "shaft", measurementId: "shaft.diameter" },
    { code: "PART_INTERFERENCE", severity: "error", parts: ["shaft", "gear"] },
    { code: "CONSTRAINT_CONFLICT", severity: "error" }
  ] };
  const queue = buildRepairWorkQueue(report, { maximumBatchSize: 2 });
  assert.deepEqual(queue.active.map((issue) => issue.code), ["INVALID_BREP", "DIMENSION_MISMATCH"]);
  assert.equal(queue.deferred.length, 2);
  assert.equal(queue.suppressedCount, 2);
  const compact = compactValidationForRepair(report, { maximumBatchSize: 2 });
  assert.equal(compact.blockingErrorCount, 2);
  assert.equal(compact.issues.length, 2);
});

test("repair guard protects functional dimensions, feature set, and constraints", () => {
  const before = { parts: [{ id: "plate", featureTree: [{ id: "plate.hole.01", type: "hole", params: { diameter: 6, center: [0, 0, 0], axis: "z", depth: 4 } }] }], constraints: [{ id: "fix", type: "fixed" }] };
  const changed = { parts: [{ id: "plate", featureTree: [{ id: "plate.hole.01", type: "hole", params: { diameter: 8, center: [0, 0, 0], axis: "z", depth: 12 } }] }], constraints: [{ id: "fix", type: "fixed" }] };
  const safe = { parts: [{ id: "plate", featureTree: [{ id: "plate.hole.01", type: "hole", params: { diameter: 6, center: [0, 0, 0], axis: "z", depth: 12 } }] }], constraints: [{ id: "fix", type: "fixed" }] };
  assert.equal(validateRepairInvariants(before, changed).ok, false);
  assert.equal(validateRepairInvariants(before, safe).ok, true);
  assert.equal(scoreRepairCandidate(before, safe, { issues: [] }).accepted, true);
});


test("manufacturability assessment reports thin walls and hole-edge risk", () => {
  const plan = {
    parts: [{
      id: "plate",
      manufacturing: { wallThickness: 0.8 },
      featureTree: [
        { id: "plate.base.01", type: "base_box", params: { size: [20, 20, 4] } },
        { id: "plate.hole.01", type: "hole", params: { diameter: 6, depth: 8, center: [8, 0, 0] } }
      ]
    }]
  };
  const issues = assessManufacturability(plan, { plate: { facts: { bbox: [20, 20, 4] } } }, { minimumWallThickness: 1.2, minimumHoleEdgeDistance: 2 });
  assert.ok(issues.some((item) => item.code === "MINIMUM_WALL_RISK"));
  assert.ok(issues.some((item) => item.code === "HOLE_EDGE_DISTANCE"));
  assert.ok(issues.every((item) => item.severity === "warning"));
});

test("hole edge clearance uses the plane perpendicular to the hole axis", () => {
  const plan = { parts: [{ id: "die", featureTree: [
    { id: "die.base", type: "base_box", params: { size: [10, 10, 10] } },
    { id: "die.side-pip", type: "hole", params: { diameter: 1.2, axis: "x", center: [5, 2.2, -2.2] } }
  ] }] };
  const issues = assessManufacturability(plan, { die: { facts: { bbox: [10, 10, 10] } } });
  assert.equal(issues.some((item) => item.code === "HOLE_EDGE_DISTANCE"), false);
});
