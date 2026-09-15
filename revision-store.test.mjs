import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCandidateRevision,
  getCurrentRevision,
  listRevisions,
  loadRevisionState,
  markRevisionFailed,
  promoteRevision,
  revertRevision,
  writeRevisionState
} from "./revision-store.js";


async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "aicad-revisions-"));
}


test("candidate revisions are immutable and promote atomically", async () => {
  const root = await tempRoot();
  const first = await createCandidateRevision(root, "assembly-1", { name: "one", parts: [] }, { summary: "initial" });
  assert.equal(first.id, "rev-0001");
  assert.equal(first.status, "candidate");
  assert.equal(await getCurrentRevision(root, "assembly-1"), null);

  const promoted = await promoteRevision(root, "assembly-1", first.id, { blockingErrorCount: 0 });
  assert.equal(promoted.status, "current");
  assert.equal((await getCurrentRevision(root, "assembly-1")).id, "rev-0001");

  await assert.rejects(
    () => createCandidateRevision(root, "assembly-1", { name: "duplicate", parts: [] }, { revisionId: "rev-0001" }),
    /already exists/i
  );
});


test("failed candidate leaves the current successful revision unchanged", async () => {
  const root = await tempRoot();
  const first = await createCandidateRevision(root, "assembly-1", { name: "one", parts: [] });
  await promoteRevision(root, "assembly-1", first.id, { blockingErrorCount: 0 });
  const second = await createCandidateRevision(root, "assembly-1", { name: "two", parts: [] }, { parentRevision: first.id, affectedPartIds: ["left"] });
  await markRevisionFailed(root, "assembly-1", second.id, { code: "BREP_INVALID", message: "invalid solid" });

  assert.equal((await getCurrentRevision(root, "assembly-1")).id, first.id);
  const revisions = await listRevisions(root, "assembly-1");
  assert.deepEqual(revisions.map((item) => [item.id, item.status]), [["rev-0002", "failed"], ["rev-0001", "current"]]);
  assert.equal(revisions[0].failure.code, "BREP_INVALID");
});


test("revert switches current pointer only to a successful revision", async () => {
  const root = await tempRoot();
  const first = await createCandidateRevision(root, "assembly-1", { name: "one", parts: [] });
  await promoteRevision(root, "assembly-1", first.id, { blockingErrorCount: 0 });
  const second = await createCandidateRevision(root, "assembly-1", { name: "two", parts: [] }, { parentRevision: first.id });
  await promoteRevision(root, "assembly-1", second.id, { blockingErrorCount: 0 });
  const failed = await createCandidateRevision(root, "assembly-1", { name: "bad", parts: [] });
  await markRevisionFailed(root, "assembly-1", failed.id, { message: "failed" });

  await assert.rejects(() => revertRevision(root, "assembly-1", failed.id), /successful/i);
  const reverted = await revertRevision(root, "assembly-1", first.id);
  assert.equal(reverted.id, first.id);
  assert.equal((await getCurrentRevision(root, "assembly-1")).id, first.id);
});


test("revision artifacts include plan checksum and metadata", async () => {
  const root = await tempRoot();
  const created = await createCandidateRevision(root, "assembly-1", { name: "one", parts: [{ id: "p" }] }, {
    parentRevision: "rev-0000",
    affectedPartIds: ["p"],
    diff: [{ op: "set_param" }]
  });
  const revisionDir = path.join(root, "assembly-1", "revisions", created.id);
  const manifest = JSON.parse(await readFile(path.join(revisionDir, "revision.json"), "utf8"));
  const plan = JSON.parse(await readFile(path.join(revisionDir, "feature-plan.json"), "utf8"));

  assert.match(manifest.planChecksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.affectedPartIds, ["p"]);
  assert.equal(manifest.parentRevision, "rev-0000");
  assert.equal(plan.name, "one");
});


test("rejects unsafe assembly and revision identifiers", async () => {
  const root = await tempRoot();
  await assert.rejects(() => createCandidateRevision(root, "../escape", { parts: [] }), /identifier/i);
  await assert.rejects(() => createCandidateRevision(root, "safe", { parts: [] }, { revisionId: "../../bad" }), /identifier/i);
});

test("allocates unique revision IDs under concurrent candidate creation", async () => {
  const root = await tempRoot();
  const candidates = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    createCandidateRevision(root, "assembly-1", { name: `plan-${index}`, parts: [] })
  ));
  assert.equal(new Set(candidates.map((item) => item.id)).size, candidates.length);
});

test("candidate promotion uses parent revision compare-and-swap", async () => {
  const root = await tempRoot();
  const first = await createCandidateRevision(root, "assembly-1", { name: "one", parts: [] });
  await promoteRevision(root, "assembly-1", first.id, { blockingErrorCount: 0 });
  const second = await createCandidateRevision(root, "assembly-1", { name: "two", parts: [] }, { parentRevision: first.id });
  const third = await createCandidateRevision(root, "assembly-1", { name: "three", parts: [] }, { parentRevision: first.id });
  await promoteRevision(root, "assembly-1", second.id, { blockingErrorCount: 0 });
  await assert.rejects(() => promoteRevision(root, "assembly-1", third.id, { blockingErrorCount: 0 }), /stale candidate/i);
  assert.equal((await getCurrentRevision(root, "assembly-1")).id, second.id);
});

test("concurrent promotions allow exactly one current child", async () => {
  const root = await tempRoot();
  const first = await createCandidateRevision(root, "assembly-1", { name: "one", parts: [] });
  await promoteRevision(root, "assembly-1", first.id, { blockingErrorCount: 0 });
  const second = await createCandidateRevision(root, "assembly-1", { name: "two", parts: [] }, { parentRevision: first.id });
  const third = await createCandidateRevision(root, "assembly-1", { name: "three", parts: [] }, { parentRevision: first.id });
  const results = await Promise.allSettled([
    promoteRevision(root, "assembly-1", second.id, { blockingErrorCount: 0 }),
    promoteRevision(root, "assembly-1", third.id, { blockingErrorCount: 0 })
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await listRevisions(root, "assembly-1")).filter((item) => item.status === "current").length, 1);
});

test("revision state verifies plan and artifact checksums before rollback", async () => {
  const root = await tempRoot();
  const plan = { name: "one", parts: [] };
  const candidate = await createCandidateRevision(root, "assembly-1", plan);
  const artifact = path.join(root, "assembly-1", "revisions", candidate.id, "assembly.step");
  await writeFile(artifact, "STEP-v1", "utf8");
  await writeRevisionState(root, "assembly-1", candidate.id, {
    plan,
    validationReport: { blockingErrorCount: 0 },
    constraintReport: { errors: [] },
    artifacts: { stepPath: artifact }
  });
  assert.equal((await loadRevisionState(root, "assembly-1", candidate.id)).artifacts.stepPath, artifact);
  await writeFile(artifact, "tampered", "utf8");
  await assert.rejects(() => loadRevisionState(root, "assembly-1", candidate.id), /artifact checksum/i);
});
