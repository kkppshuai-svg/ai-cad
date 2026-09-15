import test from "node:test";
import assert from "node:assert/strict";
import { composeAssemblyValidationReport } from "./assembly-validation-report.js";

function cleanPart(partId = "base") {
  return {
    partId,
    valid: true,
    issues: [],
    measurements: [],
    facts: { solidCount: 1, volume: 1000, bbox: [10, 10, 10] }
  };
}

function cleanBuildSummary({ parts = [cleanPart()], reviewStages = [] } = {}) {
  return {
    stepPath: "/out/assembly.step",
    parts: parts.map((part) => ({
      id: part.partId,
      stepPath: `/out/${part.partId}.step`,
      localStepPath: `/out/local/${part.partId}.step`
    })),
    geometryValidation: {
      parts,
      interferences: [],
      reviewStages,
      stepRoundTrip: { issues: [] }
    }
  };
}

const plan = { name: "bracket", parts: [{ id: "base" }] };

test("a clean build produces a promotable report with an empty repair queue", () => {
  const report = composeAssemblyValidationReport({
    plan,
    buildSummary: cleanBuildSummary(),
    constraintReport: { errors: [], warnings: [] },
    assemblyId: "asm-1",
    revisionId: "rev-0001"
  });

  assert.equal(report.valid, true);
  assert.equal(report.blockingErrorCount, 0);
  assert.equal(report.assemblyId, "asm-1");
  assert.equal(report.revisionId, "rev-0001");
  assert.equal(report.repairQueue.active.length, 0);
});

test("BREP review issues are tagged, counted, and invalidate the report", () => {
  const parts = [{ ...cleanPart(), facts: { solidCount: 0, volume: 0, bbox: [0, 0, 0] } }];
  const report = composeAssemblyValidationReport({
    plan,
    buildSummary: cleanBuildSummary({ parts }),
    constraintReport: { errors: [], warnings: [] }
  });

  const brep = report.issues.filter((issue) => issue.stage === "brep_review");
  assert.equal(brep.length, 3);
  assert.ok(brep.every((issue) => issue.code.startsWith("BREP_REVIEW_")));
  assert.equal(report.valid, false);
  assert.equal(report.blockingErrorCount, 3);
  assert.equal(report.summary.errors, 3);
});

test("a missing STEP round-trip fails its review stage", () => {
  const buildSummary = cleanBuildSummary();
  delete buildSummary.geometryValidation.stepRoundTrip;
  const report = composeAssemblyValidationReport({
    plan,
    buildSummary,
    constraintReport: { errors: [], warnings: [] }
  });

  assert.equal(report.issues.filter((issue) => issue.stage === "step_roundtrip").length, 1);
  assert.equal(report.issues.find((issue) => issue.stage === "step_roundtrip").code, "MISSING_STEP_ROUNDTRIP");
  assert.equal(report.reviewStages.find((stage) => stage.stage === "step_roundtrip").status, "fail");
  assert.equal(report.reviewStages.find((stage) => stage.stage === "fbs_acceptance").status, "pass");
  assert.equal(report.blockingErrorCount, 1);
});

test("an FBS acceptance check with no matching measurement blocks promotion", () => {
  const fbsPlan = {
    ...plan,
    concept: { acceptanceChecks: [{ id: "ac-1", statement: "板厚 6mm", measurementId: "m-thickness" }] }
  };
  const report = composeAssemblyValidationReport({
    plan: fbsPlan,
    buildSummary: cleanBuildSummary(),
    constraintReport: { errors: [], warnings: [] }
  });

  const fbs = report.issues.filter((issue) => issue.stage === "fbs");
  assert.equal(fbs.length, 1);
  assert.equal(fbs[0].code, "FBS_ACCEPTANCE_UNMAPPED");
  assert.equal(report.reviewStages.find((stage) => stage.stage === "fbs_acceptance").status, "fail");
  assert.equal(report.valid, false);
});

test("an FBS check backed by a real measurement passes", () => {
  const parts = [{ ...cleanPart(), measurements: [{ id: "m-thickness", value: 6 }] }];
  const fbsPlan = {
    ...plan,
    concept: { acceptanceChecks: [{ id: "ac-1", statement: "板厚 6mm", measurementId: "m-thickness" }] }
  };
  const report = composeAssemblyValidationReport({
    plan: fbsPlan,
    buildSummary: cleanBuildSummary({ parts }),
    constraintReport: { errors: [], warnings: [] }
  });

  assert.equal(report.issues.filter((issue) => issue.stage === "fbs").length, 0);
  assert.equal(report.reviewStages.find((stage) => stage.stage === "fbs_acceptance").status, "pass");
  assert.equal(report.valid, true);
});

test("errors from every stage accumulate into one blocking count", () => {
  const parts = [{ ...cleanPart(), facts: { solidCount: 0, volume: 1000, bbox: [10, 10, 10] } }];
  const buildSummary = cleanBuildSummary({ parts });
  delete buildSummary.geometryValidation.stepRoundTrip;
  const fbsPlan = {
    ...plan,
    concept: { acceptanceChecks: [{ id: "ac-1", statement: "板厚 6mm", measurementId: "m-missing" }] }
  };

  const report = composeAssemblyValidationReport({
    plan: fbsPlan,
    buildSummary,
    constraintReport: { errors: [{ code: "JOINT_DANGLING", message: "joint references a missing part" }], warnings: [] }
  });

  // 1 constraint + 1 brep_review + 1 fbs + 1 step_roundtrip
  assert.equal(report.blockingErrorCount, 4);
  assert.equal(report.summary.errors, 4);
  assert.equal(report.valid, false);
  assert.ok(report.repairQueue.active.length > 0);
});

test("geometry review stages from the builder are preserved ahead of the late stages", () => {
  const report = composeAssemblyValidationReport({
    plan,
    buildSummary: cleanBuildSummary({ reviewStages: [{ stage: "solid_check", status: "pass" }] }),
    constraintReport: { errors: [], warnings: [] }
  });

  assert.deepEqual(report.reviewStages.map((stage) => stage.stage), [
    "solid_check",
    "fbs_acceptance",
    "local_repair",
    "step_roundtrip"
  ]);
});

test("maximumBatchSize bounds the active repair batch", () => {
  const parts = [
    { ...cleanPart("a"), facts: { solidCount: 0, volume: 0, bbox: [0, 0, 0] } },
    { ...cleanPart("b"), facts: { solidCount: 0, volume: 0, bbox: [0, 0, 0] } }
  ];
  const report = composeAssemblyValidationReport({
    plan: { name: "two", parts: [{ id: "a" }, { id: "b" }] },
    buildSummary: cleanBuildSummary({ parts }),
    constraintReport: { errors: [], warnings: [] },
    maximumBatchSize: 2
  });

  assert.equal(report.blockingErrorCount, 6);
  assert.ok(report.repairQueue.active.length <= 2);
});
