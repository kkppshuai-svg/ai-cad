import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { restoreAssemblyJob, restoreLatestAssemblyJob } from "./assembly-job-recovery.js";
import { createCandidateRevision, promoteRevision, writeRevisionState } from "./revision-store.js";

async function saveCurrentAssembly(root, assemblyId) {
  const plan = {
    name: "restored bracket",
    parts: [{ id: "bracket", featureTree: [{ id: "bracket.base.01", type: "base_box", params: { size: [20, 20, 4] } }] }]
  };
  const candidate = await createCandidateRevision(root, assemblyId, plan);
  await writeRevisionState(root, assemblyId, candidate.id, {
    plan,
    validationReport: { valid: true, blockingErrorCount: 0, issues: [] },
    constraintReport: { errors: [], warnings: [] },
    buildSummary: { engine: "cadquery" },
    parts: [{ id: "bracket", name: "Bracket", stlUrl: `/assemblies/${assemblyId}/bracket.stl` }],
    repairAudit: [],
    delivery: {
      status: "done",
      engine: "cadquery",
      glbWarning: undefined,
      stlPath: path.join(root, assemblyId, "assembly.stl"),
      glbPath: path.join(root, assemblyId, "assembly.glb")
    },
    artifacts: []
  });
  await promoteRevision(root, assemblyId, candidate.id, { valid: true, blockingErrorCount: 0, issues: [] });
  return candidate.id;
}

test("restores an assembly job from its current revision state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-recovery-"));
  const revisionId = await saveCurrentAssembly(root, "assembly-one");

  const job = await restoreAssemblyJob(root, "assembly-one");

  assert.equal(job.id, "assembly-one");
  assert.equal(job.status, "done");
  assert.equal(job.currentRevision, revisionId);
  assert.equal(job.plan.name, "restored bracket");
  assert.equal(job.parts[0].id, "bracket");
  assert.match(job.glbPath, /assembly\.glb$/);
});

test("restores the latest available current assembly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-latest-"));
  await saveCurrentAssembly(root, "assembly-latest");

  const job = await restoreLatestAssemblyJob(root);

  assert.equal(job.id, "assembly-latest");
  assert.equal(job.status, "done");
});

test("restores the persisted visual review with its revision binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-review-recovery-"));
  const revisionId = await saveCurrentAssembly(root, "assembly-review");
  const reviewDir = path.join(root, "assembly-review", "visual-review");
  await mkdir(reviewDir, { recursive: true });
  await writeFile(path.join(reviewDir, "visual-review.json"), JSON.stringify({
    assemblyId: "assembly-review",
    revisionId,
    status: "warning",
    summary: "需要改进",
    findings: [{ severity: "warning", category: "visual", message: "方向异常", evidence: ["3d.jpg"] }]
  }), "utf8");

  const job = await restoreAssemblyJob(root, "assembly-review");

  assert.equal(job.visualReview.revisionId, revisionId);
  assert.match(job.visualReview.jsonUrl, /visual-review\.json$/);
});

test("recovery accepts a legacy state checksum when plan and artifacts remain valid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-legacy-state-"));
  const revisionId = await saveCurrentAssembly(root, "assembly-legacy");
  const statePath = path.join(root, "assembly-legacy", "revisions", revisionId, "revision-state.json");
  const payload = JSON.parse(await readFile(statePath, "utf8"));
  payload.stateChecksum = "legacy-pre-serialization-checksum";
  await writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const job = await restoreAssemblyJob(root, "assembly-legacy");

  assert.equal(job.id, "assembly-legacy");
  assert.equal(job.status, "done");
});
