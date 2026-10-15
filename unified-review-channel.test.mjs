import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnifiedReviewChannel } from "./unified-review-channel.js";
import { composeAssemblyValidationReport } from "./assembly-validation-report.js";
import { canPromoteRevision } from "./cad-validation.js";
import { REVIEW_POLICY } from "./review-policy.js";

function cleanReport() {
  return { valid: true, blockingErrorCount: 0, summary: {errors:0,warnings:0,info:0}, issues: [],
    review: {protocol:REVIEW_POLICY.version,policy:REVIEW_POLICY,geometryDecision:"pass"} };
}

test("unchanged artifact evidence is cached but content and plan changes invalidate it", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unified-review-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file = path.join(root,"solid.step"); await writeFile(file,"valid-original-evidence");
  const job = {id:"test",outputDir:root,stepPath:file,plan:{parts:[{id:"part"}]},parts:[],engine:"cadquery",validationReport:cleanReport()};
  const channel = new UnifiedReviewChannel(); await channel.bind(job);
  assert.equal((await channel.review(job)).status,"pass");
  assert.equal((await channel.review(job)).review.cache.hit,true);
  job.validationReport.review.policy = { ...REVIEW_POLICY, linearAbsoluteMm: 1 };
  const obsolete = await channel.review(job);
  assert.equal(obsolete.status, "fail");
  assert.ok(obsolete.issues.some(issue => issue.code === "REVIEW_POLICY_CHANGED"));
  job.validationReport = cleanReport();
  await writeFile(file,"changed-artifact-evidence");
  const changed = await channel.review(job);
  assert.equal(changed.status,"fail");
  assert.ok(changed.issues.some(issue=>issue.code==="REVIEW_ARTIFACT_CHANGED"));
  await writeFile(file,"valid-original-evidence");
  job.plan.parts[0].name="different-plan";
  assert.ok((await channel.review(job)).issues.some(issue=>issue.code==="REVIEW_PLAN_CHANGED"));
});

test("geometry pass cannot become delivery pass without current visual evidence", async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),"unified-delivery-")); t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,"solid.step"); await writeFile(file,"geometry");
  const job={outputDir:root,stepPath:file,plan:{parts:[]},validationReport:cleanReport(),currentRevision:"rev-0001"};
  const channel=new UnifiedReviewChannel(); await channel.bind(job);
  const geometry=await channel.review(job,{profile:"geometry"});
  const delivery=await channel.review(job,{profile:"delivery"});
  assert.equal(geometry.review.cache.evidenceHash,delivery.review.cache.evidenceHash);
  assert.equal((await channel.review(job,{profile:"delivery"})).status,"pending");
  job.visualReview={revisionId:"rev-0000",status:"pass"};
  assert.equal((await channel.review(job,{profile:"delivery"})).status,"pending");
  job.visualReview={revisionId:"rev-0001",status:"pass"};
  assert.equal((await channel.review(job,{profile:"delivery"})).status,"pass");
  job.visualReview={revisionId:"rev-0001",status:"fail",recommendedNextAction:"accept"};
  assert.equal((await channel.review(job,{profile:"delivery"})).status,"fail");
});

test("missing and nonfinite evidence and nominal successful counters never bypass review", ()=> {
  const plan={parts:[{id:"part"}]};
  const summary={stepPath:"assembly.step",parts:[{id:"part",localStepPath:"part.step"}],geometryValidation:{
    parts:[{partId:"part",valid:true,facts:{solidCount:1,volume:Infinity,bbox:[10,10,10]},issues:[]}],stepRoundTrip:{issues:[]}}};
  const report=composeAssemblyValidationReport({plan,buildSummary:summary,constraintReport:{errors:[],warnings:[]}});
  assert.equal(canPromoteRevision(report),false);
  assert.ok(report.issues.some(issue=>issue.code==="UNVERIFIED_ROUNDTRIP"));
  assert.ok(report.issues.some(issue=>issue.code==="BREP_REVIEW_NO_VOLUME_EVIDENCE"));
  assert.equal(canPromoteRevision({valid:false,blockingErrorCount:0}),false);
  assert.equal(canPromoteRevision({valid:true,blockingErrorCount:0,issues:[{severity:"error"}]}),false);
  assert.equal(canPromoteRevision({}),false);
});
