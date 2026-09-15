import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCandidateRevision, getCurrentRevision, promoteRevision } from "./revision-store.js";
import { CADQUERY_BUILDER_VERSION, checksumPartBuildPolicy, editAssemblyRevision, featureTreePayload, isEditPatchResponse, parseParametricAssemblyRoute, restoreJobFromRevisionState, validationPayload } from "./parametric-api.js";
import { checksumParametricPart, normalizeParametricPlan } from "./parametric-plan.js";


function plan() {
  return {
    name: "fixture",
    parts: [
      { id: "left", featureTree: [{ id: "left.base.01", type: "base_box", params: { size: [20, 20, 4] } }] },
      { id: "right", featureTree: [{ id: "right.base.01", type: "base_box", params: { size: [20, 20, 4] } }] }
    ],
    constraints: []
  };
}


async function currentJob(root) {
  const initialPlan = normalizeParametricPlan(plan());
  const initial = await createCandidateRevision(root, "assembly-1", initialPlan);
  await promoteRevision(root, "assembly-1", initial.id, { blockingErrorCount: 0 });
  const cacheDir = path.join(root, "cache");
  await mkdir(cacheDir, { recursive: true });
  const leftPath = path.join(cacheDir, "left.step");
  const rightPath = path.join(cacheDir, "right.step");
  await writeFile(leftPath, "left-step", "utf8");
  await writeFile(rightPath, "right-step", "utf8");
  return {
    id: "assembly-1",
    plan: initialPlan,
    currentRevision: initial.id,
    parts: [
      { id: "left", localStepPath: leftPath, localStepChecksum: sha256("left-step"), parametricChecksum: checksumParametricPart(initialPlan.parts[0]), buildPolicyChecksum: checksumPartBuildPolicy("left"), builderVersion: CADQUERY_BUILDER_VERSION },
      { id: "right", localStepPath: rightPath, localStepChecksum: sha256("right-step"), parametricChecksum: checksumParametricPart(initialPlan.parts[1]), buildPolicyChecksum: checksumPartBuildPolicy("right"), builderVersion: CADQUERY_BUILDER_VERSION }
    ],
    validationReport: { blockingErrorCount: 0, issues: [] }
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}


test("successful edit reuses unchanged part geometry and promotes candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-api-"));
  const job = await currentJob(root);
  const cachedRightPath = job.parts[1].localStepPath;
  let buildInput;
  const result = await editAssemblyRevision({
    revisionRoot: root,
    job,
    patch: { baseRevision: "rev-0001", operations: [{ op: "set_param", partId: "left", featureId: "left.base.01", path: "params.size.2", value: 6 }] },
    executeBuild: async (input) => {
      buildInput = input;
      return {
        stepPath: "/new/assembly.step",
        parts: input.plan.parts.map((part) => ({ id: part.id, localStepPath: `/new/${part.id}.step` })),
        geometryValidation: { parts: input.plan.parts.map((part) => ({ partId: part.id, blockingErrorCount: 0, issues: [] })), interferences: [] }
      };
    }
  });

  assert.equal(buildInput.plan.parts[0].reuseStepPath, undefined);
  assert.equal(buildInput.plan.parts[1].reuseStepPath, cachedRightPath);
  assert.equal(result.status, "current");
  assert.equal(job.currentRevision, "rev-0002");
  assert.equal((await getCurrentRevision(root, job.id)).id, "rev-0002");
});


test("failed candidate preserves current revision and plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-api-"));
  const job = await currentJob(root);
  const originalPlan = structuredClone(job.plan);
  const result = await editAssemblyRevision({
    revisionRoot: root,
    job,
    patch: { baseRevision: "rev-0001", operations: [{ op: "set_param", partId: "left", featureId: "left.base.01", path: "params.size.2", value: 6 }] },
    executeBuild: async (input) => ({
      stepPath: "/new/assembly.step",
      parts: [],
      geometryValidation: { parts: [{ partId: "left", blockingErrorCount: 1, issues: [{ code: "INVALID_BREP", severity: "error" }] }], interferences: [] }
    })
  });

  assert.equal(result.status, "failed");
  assert.equal(job.currentRevision, "rev-0001");
  assert.deepEqual(job.plan, originalPlan);
  assert.equal((await getCurrentRevision(root, job.id)).id, "rev-0001");
});

test("invalid dependent feature removal is returned as an AI-repairable validation failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-api-"));
  const job = await currentJob(root);
  job.plan.parts[0].featureTree.push(
    { id: "left.hole.01", type: "hole", dependsOn: ["left.base.01"], params: { diameter: 5, depth: 4 } },
    { id: "left.chamfer.01", type: "chamfer", dependsOn: ["left.hole.01"], params: { distance: 0.5 } },
    { id: "left.dimension.01", type: "dimension", dependsOn: ["left.hole.01"], params: { value: 5 }, name: "holeDiameter" }
  );

  const result = await editAssemblyRevision({
    revisionRoot: root,
    job,
    patch: { baseRevision: "rev-0001", operations: [{ op: "remove_feature", partId: "left", featureId: "left.hole.01" }] },
    executeBuild: async () => assert.fail("invalid patch must not start a build")
  });

  assert.equal(result.status, "failed");
  assert.equal(result.code, "EDIT_PATCH_INVALID");
  assert.equal(result.aiRepairRequired, true);
  assert.equal(result.validationReport.issues[0].featureId, "left.hole.01");
  assert.deepEqual(result.validationReport.issues[0].dependentFeatureIds, ["left.chamfer.01", "left.dimension.01"]);
  assert.equal(job.currentRevision, "rev-0001");
});

test("does not reuse a cached STEP whose file checksum changed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-api-"));
  const job = await currentJob(root);
  await writeFile(job.parts[1].localStepPath, "tampered-step", "utf8");
  let buildPlan;
  await editAssemblyRevision({
    revisionRoot: root,
    job,
    patch: { baseRevision: "rev-0001", operations: [{ op: "set_param", partId: "left", featureId: "left.base.01", path: "params.size.2", value: 6 }] },
    executeBuild: async (input) => {
      buildPlan = input.plan;
      return { stepPath: "/new/assembly.step", parts: input.plan.parts.map((part) => ({ id: part.id, localStepPath: `/new/${part.id}.step` })), geometryValidation: { parts: input.plan.parts.map((part) => ({ partId: part.id, blockingErrorCount: 0, issues: [] })), interferences: [] } };
    }
  });
  assert.equal(buildPlan.parts[1].reuseStepPath, undefined);
});

test("constraint-only edit reuses every matching local STEP", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-api-"));
  const job = await currentJob(root);
  let buildPlan;
  const result = await editAssemblyRevision({
    revisionRoot: root,
    job,
    patch: { baseRevision: "rev-0001", operations: [{ op: "set_constraint", constraint: { id: "align", type: "coincident", from: { partId: "left" }, to: { partId: "right" } } }] },
    executeBuild: async (input) => {
      buildPlan = input.plan;
      return { stepPath: "/new/assembly.step", parts: input.plan.parts.map((part) => ({ id: part.id, localStepPath: `/new/${part.id}.step` })), geometryValidation: { parts: input.plan.parts.map((part) => ({ partId: part.id, blockingErrorCount: 0, issues: [] })), interferences: [] } };
    }
  });
  assert.ok(buildPlan.parts.every((part) => part.reuseStepPath));
  assert.deepEqual(result.affectedPartIds, []);
  assert.deepEqual(result.assemblyAffectedPartIds, ["left", "right"]);
});


test("derivative finalization runs before candidate promotion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-api-"));
  const job = await currentJob(root);
  const result = await editAssemblyRevision({
    revisionRoot: root,
    job,
    patch: { baseRevision: "rev-0001", operations: [{ op: "set_param", partId: "left", featureId: "left.base.01", path: "params.size.2", value: 6 }] },
    executeBuild: async (input) => ({
      stepPath: "/new/assembly.step",
      parts: input.plan.parts.map((part) => ({ id: part.id, localStepPath: `/new/${part.id}.step` })),
      geometryValidation: { parts: input.plan.parts.map((part) => ({ partId: part.id, blockingErrorCount: 0, issues: [] })), interferences: [] }
    }),
    finalizeBuild: async () => {
      assert.equal((await getCurrentRevision(root, job.id)).id, "rev-0001");
      throw new Error("FCStd failed");
    }
  });
  assert.equal(result.status, "failed");
  assert.equal((await getCurrentRevision(root, job.id)).id, "rev-0001");
});


test("feature tree and validation payloads expose revision state", () => {
  const job = {
    id: "assembly-1",
    currentRevision: "rev-0003",
    plan: plan(),
    parts: [{ id: "left", featureTrace: [{ featureId: "left.base.01", status: "passed" }] }],
    validationReport: { blockingErrorCount: 0, summary: { errors: 0, warnings: 1, info: 0 }, issues: [{ code: "RISK", severity: "warning" }] },
    repairAudit: [{ action: "reduce_finish" }]
  };
  const tree = featureTreePayload(job);
  assert.equal(tree.revisionId, "rev-0003");
  assert.equal(tree.parts[0].featureTree[0].status, "passed");
  assert.equal(validationPayload(job).issues[0].code, "RISK");
  assert.equal(validationPayload(job).repairAudit[0].action, "reduce_finish");
});


test("parses scoped parametric assembly API routes", () => {
  assert.deepEqual(parseParametricAssemblyRoute("GET", "/api/assembly/a-1/feature-tree"), { assemblyId: "a-1", action: "feature-tree" });
  assert.deepEqual(parseParametricAssemblyRoute("GET", "/api/assembly/a-1/revisions"), { assemblyId: "a-1", action: "revisions" });
  assert.deepEqual(parseParametricAssemblyRoute("GET", "/api/assembly/a-1/validation"), { assemblyId: "a-1", action: "validation" });
  assert.deepEqual(parseParametricAssemblyRoute("POST", "/api/assembly/a-1/edit"), { assemblyId: "a-1", action: "edit" });
  assert.deepEqual(parseParametricAssemblyRoute("POST", "/api/assembly/a-1/revert"), { assemblyId: "a-1", action: "revert" });
  assert.equal(parseParametricAssemblyRoute("DELETE", "/api/assembly/a-1/edit"), null);
});


test("recognizes structured local edit responses", () => {
  assert.equal(isEditPatchResponse({ mode: "edit_patch", editPatch: { baseRevision: "rev-0001", operations: [] } }), true);
  assert.equal(isEditPatchResponse({ mode: "ambiguous", candidates: [] }), false);
  assert.equal(isEditPatchResponse({ parts: [] }), false);
});

test("serializes edits and rejects a stale concurrent base revision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-api-"));
  const job = await currentJob(root);
  const build = async (input) => ({
    stepPath: "/new/assembly.step",
    parts: input.plan.parts.map((part) => ({ id: part.id, localStepPath: `/new/${part.id}.step` })),
    geometryValidation: { parts: input.plan.parts.map((part) => ({ partId: part.id, blockingErrorCount: 0, issues: [] })), interferences: [] }
  });
  const first = editAssemblyRevision({
    revisionRoot: root,
    job,
    patch: { baseRevision: "rev-0001", operations: [{ op: "set_param", partId: "left", featureId: "left.base.01", path: "params.size.2", value: 6 }] },
    executeBuild: build
  });
  const second = editAssemblyRevision({
    revisionRoot: root,
    job,
    patch: { baseRevision: "rev-0001", operations: [{ op: "set_param", partId: "right", featureId: "right.base.01", path: "params.size.2", value: 7 }] },
    executeBuild: build
  });
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((item) => item.status), ["current", "stale"]);
  assert.equal(job.plan.parts.find((part) => part.id === "left").featureTree[0].params.size[2], 6);
  assert.equal(job.plan.parts.find((part) => part.id === "right").featureTree[0].params.size[2], 4);
});

test("deterministic repair rebuilds a failed finish and records audit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-api-"));
  const initialPlan = {
    name: "repair",
    parts: [{ id: "plate", featureTree: [
      { id: "plate.base.01", type: "base_box", params: { size: [20, 20, 4] } },
      { id: "plate.fillet.01", type: "fillet", dependsOn: ["plate.base.01"], params: { radius: 4 }, selector: { kind: "axis_position", axis: "z", position: 0 } }
    ] }], constraints: []
  };
  const initial = await createCandidateRevision(root, "assembly-repair", initialPlan);
  await promoteRevision(root, "assembly-repair", initial.id, { blockingErrorCount: 0 });
  const job = { id: "assembly-repair", plan: initialPlan, currentRevision: initial.id, parts: [] };
  let attempt = 0;
  const result = await editAssemblyRevision({
    revisionRoot: root,
    job,
    patch: { baseRevision: initial.id, operations: [{ op: "set_param", partId: "plate", featureId: "plate.base.01", path: "params.size.2", value: 5 }] },
    executeBuild: async ({ plan: buildPlan }) => {
      attempt += 1;
      const radius = buildPlan.parts[0].featureTree[1].params.radius;
      return {
        stepPath: `/tmp/assembly-${attempt}.step`,
        parts: [{ id: "plate", localStepPath: `/tmp/plate-${attempt}.step` }],
        geometryValidation: { parts: [{ partId: "plate", blockingErrorCount: radius === 4 ? 1 : 0, issues: radius === 4 ? [{ code: "FINISH_FEATURE_FAILED", severity: "error", featureId: "plate.fillet.01" }] : [] }], interferences: [] }
      };
    }
  });
  assert.equal(result.status, "current");
  assert.equal(attempt, 2);
  assert.equal(job.plan.parts[0].featureTree[1].params.radius, 2);
  assert.equal(result.repairAudit[0].action, "reduce_finish");
});

test("clean-and-retry repair is persisted in the authoritative revision plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-api-"));
  const job = await currentJob(root);
  let attempt = 0;
  const result = await editAssemblyRevision({
    revisionRoot: root,
    job,
    patch: { baseRevision: "rev-0001", operations: [{ op: "set_param", partId: "left", featureId: "left.base.01", path: "params.size.2", value: 6 }] },
    executeBuild: async ({ plan: buildPlan }) => {
      attempt += 1;
      const repaired = Array.isArray(buildPlan.repairActions) && buildPlan.repairActions.some((action) => action.type === "clean_and_retry" && action.partId === "left");
      return {
        stepPath: `/tmp/clean-assembly-${attempt}.step`,
        parts: buildPlan.parts.map((part) => ({ id: part.id, localStepPath: `/tmp/clean-${part.id}-${attempt}.step` })),
        geometryValidation: { parts: buildPlan.parts.map((part) => ({ partId: part.id, blockingErrorCount: part.id === "left" && !repaired ? 1 : 0, issues: part.id === "left" && !repaired ? [{ code: "INVALID_BREP", severity: "error" }] : [] })), interferences: [] }
      };
    }
  });
  const saved = JSON.parse(await readFile(path.join(root, job.id, "revisions", result.id, "feature-plan.json"), "utf8"));
  assert.equal(result.status, "current");
  assert.equal(attempt, 2);
  assert.deepEqual(job.plan.repairActions, [{ type: "clean_and_retry", partId: "left", featureId: null }]);
  assert.deepEqual(saved.repairActions, job.plan.repairActions);
});

test("unsafe validation failures are returned as an AI repair proposal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-api-"));
  const job = await currentJob(root);
  const result = await editAssemblyRevision({
    revisionRoot: root,
    job,
    patch: { baseRevision: "rev-0001", operations: [{ op: "set_param", partId: "left", featureId: "left.base.01", path: "params.size.2", value: 6 }] },
    executeBuild: async (input) => ({
      stepPath: "/new/assembly.step",
      parts: input.plan.parts.map((part) => ({ id: part.id, localStepPath: `/new/${part.id}.step` })),
      geometryValidation: { parts: input.plan.parts.map((part) => ({ partId: part.id, blockingErrorCount: 0, issues: [] })), interferences: [{ code: "PART_INTERFERENCE", severity: "error", parts: ["left", "right"], volume: 5 }] }
    })
  });
  assert.equal(result.status, "failed");
  assert.equal(result.aiRepairRequired, true);
  assert.equal(result.requiresAi[0].code, "PART_INTERFERENCE");
});

test("rollback restoration replaces plan, validation, constraints, parts, and delivery together", () => {
  const job = { plan: { name: "new" }, currentRevision: "rev-0002", validationReport: { marker: "new" }, constraintReport: { marker: "new" }, parts: [{ id: "new" }], fcstdPath: "/new.FCStd", glbPath: "/new.glb" };
  restoreJobFromRevisionState(job, "rev-0001", {
    plan: { name: "old" },
    validationReport: { marker: "old" },
    constraintReport: { marker: "old" },
    parts: [{ id: "old" }],
    delivery: { fcstdPath: "/old.FCStd", kinematicsPath: "/old-kinematics.json", status: "done" }
  });
  assert.equal(job.currentRevision, "rev-0001");
  assert.equal(job.plan.name, "old");
  assert.equal(job.validationReport.marker, "old");
  assert.equal(job.constraintReport.marker, "old");
  assert.equal(job.parts[0].id, "old");
  assert.equal(job.fcstdPath, "/old.FCStd");
  assert.equal(job.kinematicsPath, "/old-kinematics.json");
  assert.equal(job.glbPath, undefined);
});

test("restoration refreshes stale joint constraint warnings", () => {
  const job = {};
  restoreJobFromRevisionState(job, "rev-0001", {
    plan: {
      parts: [{ id: "chassis" }, { id: "wheel" }],
      joints: [
        { id: "ground", type: "fixed", parent: "world", child: "chassis" },
        { id: "mount", type: "fixed", parent: "chassis", child: "wheel" }
      ]
    },
    validationReport: {
      valid: true,
      blockingErrorCount: 0,
      summary: { errors: 0, warnings: 2, info: 0 },
      issues: [
        { stage: "constraint", severity: "warning", code: "UNCONSTRAINED_PART", partId: "chassis" },
        { stage: "constraint", severity: "warning", code: "UNCONSTRAINED_PART", partId: "wheel" }
      ]
    },
    constraintReport: {
      format: "ai-cad-constraint-analysis-v1",
      constraints: [],
      parts: {},
      errors: [],
      warnings: [{ code: "UNCONSTRAINED_PART", partId: "chassis" }, { code: "UNCONSTRAINED_PART", partId: "wheel" }]
    }
  });

  assert.equal(job.validationReport.summary.warnings, 0);
  assert.equal(job.validationReport.issues.length, 0);
  assert.equal(job.constraintReport.parts.chassis.remainingDof, 0);
  assert.equal(job.constraintReport.parts.wheel.remainingDof, 0);
});
