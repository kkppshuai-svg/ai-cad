import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnifiedReviewChannel } from "./unified-review-channel.js";
import { REVIEW_POLICY, reviewRevisionId } from "./review-policy.js";
import { runCombinedReview } from "./combined-review.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "combined-review-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  const file = path.join(root,"solid.usda"); await writeFile(file,"kernel-evidence");
  const job = { id:"preview", engine:"nvidia-usd-brep", outputDir:root, usdBrepPath:file, plan:{parts:[]},
    validationReport:{valid:true,blockingErrorCount:0,issues:[],review:{protocol:REVIEW_POLICY.version,policy:REVIEW_POLICY}} };
  const channel = new UnifiedReviewChannel(); await channel.bind(job);
  return {job,channel};
}

test("native preview geometry and visual checks share one version and delivery report", async t => {
  const {job,channel}=await fixture(t);let calls=0;
  const report=await runCombinedReview({job,channel,visualRequested:true,screenshots:[{view:"3d"}],runVisual:async ({revisionId})=>{
    calls++;job.visualReview={revisionId,status:"pass",summary:"verified visual fixture",findings:[]};
  }});
  assert.equal(calls,1);assert.equal(report.status,"pass");assert.equal(report.review.geometryDecision,"pass");
  assert.equal(report.review.visualDecision,"pass");assert.equal(report.visualEvidence.revisionId,reviewRevisionId(job));
  assert.equal(report.review.rollout.userAcceptance,"pending");
});

test("visual provider failure leaves delivery pending rather than retaining an old pass", async t=>{
  const {job,channel}=await fixture(t);job.visualReview={revisionId:reviewRevisionId(job),status:"pass"};
  const report=await runCombinedReview({job,channel,visualRequested:true,screenshots:[{}],runVisual:async ()=>{throw Error("provider unavailable");}});
  assert.equal(report.status,"pending");assert.equal(report.visualAttempt.status,"unavailable");
  assert.equal(report.review.geometryDecision,"pass");assert.equal(report.visualEvidence,null);
});

test("visual pass cannot override geometry changed during the same combined review", async t=>{
  const {job,channel}=await fixture(t);
  const report=await runCombinedReview({job,channel,visualRequested:true,screenshots:[{}],runVisual:async ({revisionId})=>{
    job.visualReview={revisionId,status:"pass"};await writeFile(job.usdBrepPath,"changed");
  }});
  assert.equal(report.status,"fail");assert.ok(report.issues.some(item=>item.code==="REVIEW_ARTIFACT_CHANGED"));
});

test("stale revisions and missing screenshot evidence never invoke a visual provider", async t=>{
  const {job,channel}=await fixture(t);let called=false;const runVisual=async ()=>{called=true;};
  await assert.rejects(runCombinedReview({job,channel,expectedRevision:"old",runVisual}),{status:409});
  await assert.rejects(runCombinedReview({job,channel,visualRequested:true,runVisual}),{status:400});
  await assert.rejects(runCombinedReview({job,channel,visualRequested:true,screenshots:[{}],runVisual:async()=>{job.currentRevision="rev-0002";}}),{status:409});
  assert.equal(called,false);
});
