import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initializeNativeRevision, editNativeRevision, restoreNativeJob, revertNativeRevision, nativeAssemblyReviewEvidence } from "./native-revisions.js";
import { UnifiedReviewChannel } from "./unified-review-channel.js";
import { composeAssemblyValidationReport } from "./assembly-validation-report.js";
import { analyzeAssemblyConstraints } from "./assembly-constraints.js";
import { normalizeParametricPlan } from "./parametric-plan.js";
import { listRevisions } from "./revision-store.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-revision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = normalizeParametricPlan({ parts: [{ id: "plate", featureTree: [{ id: "plate.base", type: "base_box", params: { size: [10,10,10] } }] }] });
  const outputDir = path.join(root,"model"); await mkdir(outputDir);
  const bridge = { calls:0, async buildAssembly({plan,outputDir}) {
    this.calls++;
    for (const name of ["native-solid.usda","native-preview.stl","native-mesh.usda",...plan.parts.map(p=>`${p.id}.usda`),...plan.parts.map(p=>`${p.id}.stl`)]) await writeFile(path.join(outputDir,name), JSON.stringify(plan));
    const parts = plan.parts.map(part=>{
      const size=part.featureTree[0].params.size;
      return { partId:part.id, valid:true, issues:[], measurements:[], facts:{solidCount:1,volume:size.reduce((a,b)=>a*b),bbox:size} };
    });
    return { engine:"nvidia-usd-brep", cadqueryUsed:false, parts, featureTrace:{}, usdRoundTrip:{valid:true,issues:[]} };
  } };
  const report=await bridge.buildAssembly({plan,outputDir});
  const parts=plan.parts.map(p=>({...p,localUsdBrepPath:path.join(outputDir,p.id+".usda")}));
  const job={id:"model",engine:"nvidia-usd-brep",outputDir,plan,parts,status:"done",stlPath:path.join(outputDir,"native-preview.stl"),usdBrepPath:path.join(outputDir,"native-solid.usda")};
  job.constraintReport=analyzeAssemblyConstraints(plan);
  job.validationReport=composeAssemblyValidationReport({plan,constraintReport:job.constraintReport,buildSummary:{engine:job.engine,parts,usdBrepPath:job.usdBrepPath,geometryValidation:{parts:report.parts,usdRoundTrip:report.usdRoundTrip}}});
  const channel=new UnifiedReviewChannel();
  await initializeNativeRevision({root,job,channel});
  const edit=patch=>editNativeRevision({root,job,patch,bridge,channel,sourceDir:process.cwd()});
  return {root,job,bridge,channel,edit};
}
const patch=(revision,size=[20,10,10])=>({baseRevision:revision,operations:[{op:"set_param",partId:"plate",featureId:"plate.base",path:"params.size",value:size}]});

test("native edit rebuilds and persists a draft; clears old visual conclusions and never uses STEP",async t=>{
  const f=await fixture(t);
  f.job.visualReview={revisionId:f.job.currentRevision,status:"pass"};
  const result=await f.edit(patch(f.job.currentRevision));
  assert.equal(result.status,"draft"); assert.equal(f.bridge.calls,2);
  assert.equal(f.job.currentRevision,"rev-0002"); assert.equal(f.job.visualReview,null);
  assert.equal(f.job.stepPath,undefined); assert.equal(f.job.engine,"nvidia-usd-brep");
  const restored=await restoreNativeJob(f.root,f.job.id);
  assert.equal(restored.currentRevision,f.job.currentRevision);
  assert.equal(restored.latestUnifiedReview.review.visualDecision,"pending");
  assert.deepEqual(restored.plan.parts[0].featureTree[0].params.size,[20,10,10]);
  const next=await f.edit(patch(f.job.currentRevision,[30,10,10]));
  assert.equal(next.status,"draft"); assert.equal(f.job.currentRevision,"rev-0003");
});

test("stale patches and changed artifact evidence never start a native rebuild",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.edit(patch("rev-0000")),{status:409});
  await writeFile(f.job.usdBrepPath,"tampered");
  await assert.rejects(f.edit(patch(f.job.currentRevision)),{code:"REVIEW_ARTIFACT_CHANGED"});
  assert.equal(f.bridge.calls,1);
});

test("failed native candidate preserves displayed source and stores failure history",async t=>{
  const f=await fixture(t);
  f.bridge.buildAssembly=async()=>{throw new Error("native kernel failure");};
  const result=await f.edit(patch(f.job.currentRevision));
  assert.equal(result.status,"failed"); assert.equal(f.job.currentRevision,"rev-0001");
  assert.equal((await listRevisions(f.root,f.job.id))[0].status,"failed");
  assert.equal((await restoreNativeJob(f.root,f.job.id)).currentRevision,"rev-0001");
});

test("native revert restores checked geometry without resurrecting an old visual pass",async t=>{
  const f=await fixture(t); await f.edit(patch(f.job.currentRevision));
  await revertNativeRevision({root:f.root,job:f.job,revisionId:"rev-0001",channel:f.channel});
  assert.equal(f.job.currentRevision,"rev-0001"); assert.equal(f.job.visualReview,null);
  assert.deepEqual(f.job.plan.parts[0].featureTree[0].params.size,[10,10,10]);
});

test("a nominal motion pass without finite clearance evidence cannot release an assembly",()=>{
  const result=nativeAssemblyReviewEvidence({parts:[{partId:"a",issues:[]},{partId:"b",issues:[]}],motionReview:{status:"pass"}}, {parts:[]});
  assert.equal(result.reviewStages[0].status,"unverified");
  assert.equal(result.parts[0].issues[0].severity,"error");
});
