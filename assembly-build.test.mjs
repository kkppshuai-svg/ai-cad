import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildValidatedAssembly, buildCadQueryManifest, describeBlockingValidationError, MAX_DETERMINISTIC_REPAIR_ATTEMPTS } from "./assembly-build.js";

function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "aicad-build-"));
}

function samplePlan() {
  return {
    name: "bracket",
    parts: [{
      id: "base",
      name: "底板",
      primitives: [{ type: "box", size: [80, 60, 8], center: true }],
      features: [],
      pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] }
    }]
  };
}

function cleanBuildSummary(plan, outDir) {
  return {
    engine: "cadquery",
    stepPath: path.join(outDir, "assembly.step"),
    stlPath: path.join(outDir, "assembly.stl"),
    glbPath: path.join(outDir, "assembly.glb"),
    fcstdPath: path.join(outDir, "assembly.FCStd"),
    parts: plan.parts.map((part) => ({
      id: part.id,
      stepPath: path.join(outDir, `${part.id}.step`),
      localStepPath: path.join(outDir, `${part.id}.local.step`)
    })),
    geometryValidation: {
      parts: plan.parts.map((part) => ({
        partId: part.id,
        valid: true,
        issues: [],
        measurements: [],
        facts: { solidCount: 1, volume: 38400, bbox: [80, 60, 8] }
      })),
      interferences: [],
      reviewStages: [],
      stepRoundTrip: { issues: [] }
    }
  };
}

// writeRevisionState refuses to record artifacts that are not on disk, so a
// fake build has to leave real (empty) files behind just like CadQuery would.
async function materializeArtifacts(summary) {
  const files = [summary.stepPath, summary.stlPath, summary.glbPath, summary.fcstdPath]
    .concat((summary.parts || []).flatMap((part) => [part.stepPath, part.localStepPath]))
    .filter(Boolean);
  for (const file of files) await writeFile(file, "", "utf8");
  return summary;
}

/** deps wired to in-memory fakes; `overrides` replaces any single entry. */
function makeDeps(assemblyDir, overrides = {}) {
  const events = [];
  const jobs = [];
  const learned = [];
  let counter = 0;
  const deps = {
    assemblyDir,
    newAssemblyId: () => `asm-${++counter}`,
    hydrateStandardParts: async () => {},
    runCadQueryBuild: async ({ outDir, plan }) => materializeArtifacts(cleanBuildSummary(plan, outDir)),
    applyBuildSummaryToJob: (job, buildSummary) => {
      job.parts = (job.plan.parts || []).map((part) => {
        const output = (buildSummary.parts || []).find((item) => item.id === part.id) || {};
        return { ...part, stepPath: output.stepPath || null, localStepPath: output.localStepPath || null };
      });
    },
    buildKinematicPackage: async () => ({
      kinematicsPath: "/k/assembly-kinematics.json",
      constraintsPath: "/k/assembly-constraints.json",
      packagePath: "/k/assembly_kinematic_package",
      archivePath: "/k/assembly_kinematic_package.zip"
    }),
    ensureAssemblyFcstd: async () => {},
    revisionDeliveryState: (job) => ({ stepPath: job.stepPath, status: job.status }),
    registerJob: (job) => jobs.push(job),
    publish: (event, payload) => events.push({ event, payload }),
    publicAssembly: (job) => ({ id: job.id, status: job.status }),
    queueLatentLearning: (job, source) => learned.push(source),
    ...overrides
  };
  return { deps, events, jobs, learned };
}

test("a clean build promotes its candidate revision and publishes done", async () => {
  const root = await tempRoot();
  const { deps, events, jobs, learned } = makeDeps(root);

  const job = await buildValidatedAssembly({ plan: samplePlan(), deps });

  assert.equal(job.status, "done");
  assert.equal(job.id, "asm-1");
  assert.equal(job.currentRevision, "rev-0001");
  assert.equal(job.pendingRevision, undefined);
  assert.equal(job.engine, "cadquery");
  assert.equal(job.kinematicArchivePath, "/k/assembly_kinematic_package.zip");
  assert.deepEqual(events.map((entry) => entry.event), ["assembly:progress", "assembly:done"]);
  assert.deepEqual(jobs.map((entry) => entry.id), ["asm-1"]);
  assert.deepEqual(learned, ["validated-build"]);

  const manifest = JSON.parse(await readFile(path.join(root, "asm-1", "assembly-manifest.json"), "utf8"));
  assert.equal(manifest.name, "bracket");
  const state = JSON.parse(await readFile(path.join(root, "asm-1", "revisions", "rev-0001", "revision.json"), "utf8"));
  assert.equal(state.status, "current");
});

test("a blocking validation failure throws with the report and the failed plan attached", async () => {
  const root = await tempRoot();
  const { deps, events } = makeDeps(root, {
    runCadQueryBuild: async ({ outDir, plan }) => {
      const summary = cleanBuildSummary(plan, outDir);
      // No round-trip evidence and no artifacts: blocking, unrepairable.
      delete summary.geometryValidation.stepRoundTrip;
      delete summary.stepPath;
      delete summary.stlPath;
      delete summary.glbPath;
      return summary;
    }
  });

  const error = await buildValidatedAssembly({ plan: samplePlan(), deps }).then(() => null, (err) => err);

  assert.ok(error, "expected the build to reject");
  assert.match(error.message, /Assembly validation blocked revision with \d+ error\(s\)/);
  assert.equal(error.validationReport.valid, false);
  assert.equal(error.failedPlan.name, "bracket");
  assert.equal(error.previewAssembly, undefined);
  assert.deepEqual(events.map((entry) => entry.event), ["assembly:progress", "assembly:error"]);
});

test("partial geometry is handed back as a preview instead of being discarded", async () => {
  const root = await tempRoot();
  const { deps } = makeDeps(root, {
    runCadQueryBuild: async ({ outDir, plan }) => materializeArtifacts(cleanBuildSummary(plan, outDir)),
    buildKinematicPackage: async () => { throw new Error("zip failed"); }
  });

  const error = await buildValidatedAssembly({ plan: samplePlan(), deps }).then(() => null, (err) => err);

  assert.match(error.message, /zip failed/);
  assert.ok(error.previewAssembly, "expected a preview assembly");
  assert.equal(error.previewAssembly.status, "validation_failed");
  assert.ok(error.previewAssembly.stepPath);
});

test("a failed candidate revision is marked failed on disk", async () => {
  const root = await tempRoot();
  const { deps } = makeDeps(root, {
    runCadQueryBuild: async () => { throw new Error("cadquery crashed"); }
  });

  await assert.rejects(buildValidatedAssembly({ plan: samplePlan(), deps }), /cadquery crashed/);

  const revision = JSON.parse(await readFile(path.join(root, "asm-1", "revisions", "rev-0001", "revision.json"), "utf8"));
  assert.equal(revision.status, "failed");
});

test("a deterministic repair halves the failing fillet and rebuilds, up to the attempt limit", async () => {
  const root = await tempRoot();
  const radii = [];
  const planWithFillet = () => {
    const plan = samplePlan();
    plan.parts[0].features = [{ id: "base.fillet.01", type: "fillet", params: { radius: 5, edges: "all" } }];
    return plan;
  };

  const { deps } = makeDeps(root, {
    runCadQueryBuild: async ({ outDir, plan }) => {
      // normalizeParametricPlan puts the editable params on featureTree;
      // part.features is the flattened legacy view.
      radii.push(plan.parts[0].featureTree.find((node) => node.id === "base.fillet.01").params.radius);
      const summary = cleanBuildSummary(plan, outDir);
      // FINISH_FEATURE_FAILED on a fillet is deterministically repairable:
      // proposeDeterministicRepairs halves the radius and the build retries.
      summary.geometryValidation.parts[0].issues = [
        { code: "FINISH_FEATURE_FAILED", severity: "error", partId: "base", featureId: "base.fillet.01", message: "fillet exceeds edge" }
      ];
      summary.geometryValidation.parts[0].valid = false;
      summary.geometryValidation.parts[0].blockingErrorCount = 1;
      return summary;
    }
  });

  await assert.rejects(buildValidatedAssembly({ plan: planWithFillet(), deps }), /Assembly validation blocked revision/);

  // attempt 0 and 1 repair and rebuild; attempt 2 hits the limit and throws.
  assert.equal(radii.length, MAX_DETERMINISTIC_REPAIR_ATTEMPTS + 1);
  assert.deepEqual(radii, [5, 2.5, 1.25]);
});

test("an unrepairable issue fails on the first build without retrying", async () => {
  const root = await tempRoot();
  let builds = 0;
  const { deps } = makeDeps(root, {
    runCadQueryBuild: async ({ outDir, plan }) => {
      builds += 1;
      const summary = cleanBuildSummary(plan, outDir);
      summary.geometryValidation.parts[0].issues = [
        { code: "PART_INTERFERENCE", severity: "error", partId: "base", message: "parts overlap" }
      ];
      summary.geometryValidation.parts[0].valid = false;
      summary.geometryValidation.parts[0].blockingErrorCount = 1;
      return summary;
    }
  });

  const error = await buildValidatedAssembly({ plan: samplePlan(), deps }).then(() => null, (err) => err);

  assert.equal(builds, 1);
  assert.equal(error.requiresAi.length, 1);
  assert.equal(error.requiresAi[0].code, "PART_INTERFERENCE");
});

test("repairContext.attempt at the limit skips deterministic repair entirely", async () => {
  const root = await tempRoot();
  let builds = 0;
  const { deps } = makeDeps(root, {
    runCadQueryBuild: async ({ outDir, plan }) => {
      builds += 1;
      const summary = cleanBuildSummary(plan, outDir);
      delete summary.geometryValidation.stepRoundTrip;
      return summary;
    }
  });

  await assert.rejects(
    buildValidatedAssembly({ plan: samplePlan(), repairContext: { attempt: MAX_DETERMINISTIC_REPAIR_ATTEMPTS }, deps }),
    /Assembly validation blocked revision/
  );
  assert.equal(builds, 1);
});

test("the prior repair audit carries into the new job", async () => {
  const root = await tempRoot();
  const { deps } = makeDeps(root);
  const audit = [{ code: "AUTO_FILLET_SHRINK", partId: "base" }];

  const job = await buildValidatedAssembly({ plan: samplePlan(), repairContext: { repairAudit: audit }, deps });

  assert.deepEqual(job.repairAudit, audit);
  assert.notEqual(job.repairAudit, audit, "the audit should be cloned, not aliased");
});

test("buildCadQueryManifest carries relations, joints, constraints and contacts", () => {
  const manifest = buildCadQueryManifest({
    name: "arm",
    parts: [{ id: "a" }],
    relations: [{ type: "mounted_on", from: "a", to: "b" }],
    joints: [{ id: "j1" }],
    constraints: [{ id: "c1" }],
    intendedContacts: [{ parts: ["a", "b"] }]
  }, "/out");

  assert.equal(manifest.name, "arm");
  assert.equal(manifest.outputDir, "/out");
  assert.equal(manifest.relations.length, 1);
  assert.equal(manifest.joints.length, 1);
  assert.equal(manifest.constraints.length, 1);
  assert.equal(manifest.intendedContacts.length, 1);
});

test("buildCadQueryManifest falls back to a default name and empty collections", () => {
  const manifest = buildCadQueryManifest({ parts: [] }, "/out");

  assert.equal(manifest.name, "AI_CAD_Assembly");
  assert.deepEqual(manifest.relations, []);
  assert.deepEqual(manifest.joints, []);
  assert.deepEqual(manifest.constraints, []);
  assert.deepEqual(manifest.intendedContacts, []);
});

test("the blocking error message lists error codes with their parts", () => {
  const message = describeBlockingValidationError({
    blockingErrorCount: 2,
    issues: [
      { code: "PART_INTERFERENCE", severity: "error", parts: ["left", "right"] },
      { code: "MISSING_PART_ARTIFACT", severity: "error", partId: "base" },
      { code: "THIN_WALL", severity: "warning", partId: "base" }
    ]
  });

  assert.equal(message, "Assembly validation blocked revision with 2 error(s): PART_INTERFERENCE(left + right), MISSING_PART_ARTIFACT(base)");
});

test("the blocking error message caps the listed codes at six", () => {
  const issues = Array.from({ length: 9 }, (_, index) => ({ code: `E${index}`, severity: "error" }));
  const message = describeBlockingValidationError({ blockingErrorCount: 9, issues });

  assert.equal(message, "Assembly validation blocked revision with 9 error(s): E0, E1, E2, E3, E4, E5");
});

test("a report with no error-severity issues still names its blocking count", () => {
  const message = describeBlockingValidationError({ blockingErrorCount: 3, issues: [] });

  assert.equal(message, "Assembly validation blocked revision with 3 error(s)");
});
