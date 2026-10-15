import test from "node:test";
import assert from "node:assert/strict";
import { createReviewProposal, createInstructionProposal, assertProposalPatch, planReviewProposal } from "./review-improvement.js";
const job=()=>({currentRevision:"rev-0001",plan:{parts:[{id:"plate",featureTree:[{id:"plate.base",type:"base_box",params:{size:[10,10,10]}},{id:"plate.hole",type:"hole",params:{diameter:2,depth:2}}]}]}});
const report=()=>({reviewRevisionId:"rev-0001",review:{cache:{evidenceHash:"abc"}},issues:[{code:"CUT_NOT_THROUGH",partId:"plate",featureId:"plate.hole",requiredDepth:20,severity:"error",message:"cut is too shallow"}]});
test("unified repair converts a BRep measurement finding to a revision-bound patch",()=>{
  const proposal=createReviewProposal(job(),report());
  assert.equal(proposal.status,"ready"); assert.equal(proposal.patch.operations[0].value,20);
  assert.equal(proposal.evidenceHash,"abc");
  assert.throws(()=>assertProposalPatch(proposal,{...proposal.patch,operations:[]}),{status:409});
});
test("verification gaps cannot be concealed by geometry guesses",()=>{
  const r=report();r.issues=[{code:"NATIVE_ASSEMBLY_INTERFERENCE_UNVERIFIED",severity:"error"}];
  assert.equal(createReviewProposal(job(),r).status,"measurement_required");
  r.reviewRevisionId="rev-0000"; assert.throws(()=>createReviewProposal(job(),r),{status:409});
});
test("review changes cannot weaken acceptance or escape selected feature scope",()=>{
  const j=job(),r=report(),finding=createReviewProposal(j,r).findings[0];
  assert.throws(()=>createInstructionProposal(j,r,{baseRevision:j.currentRevision,operations:[{op:"disable_feature",partId:"plate",featureId:"plate.hole"}]},"fix",[]),{status:422});
  assert.throws(()=>createInstructionProposal(j,r,{baseRevision:j.currentRevision,operations:[{op:"set_param",partId:"plate",featureId:"plate.base",path:"params.size",value:[20,10,10]}]},"fix",[finding.id]),{status:422});
});

test("invalid AI patch schema is repaired within a bounded planning loop before any build",async()=>{
  const j=job(); let calls=0;
  const proposed=await planReviewProposal({job:j,report:report(),instructions:"hole depth 20",generate:async({feedback})=>{
    calls++; if(calls===1)return {editPatch:{baseRevision:j.currentRevision,operations:[{type:"replace",value:20}]}};
    assert.equal(feedback.length,1);
    return {editPatch:{baseRevision:j.currentRevision,operations:[{op:"set_param",partId:"plate",featureId:"plate.hole",path:"params.depth",value:20}]}};
  }});
  assert.equal(calls,2);assert.equal(proposed.status,"ready");assert.equal(j.plan.parts[0].featureTree[1].params.depth,2);
});
