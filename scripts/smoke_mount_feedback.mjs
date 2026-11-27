import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = await mkdtemp(path.join(tmpdir(),"aicad-mount-smoke-"));
const port = 32300+Math.floor(Math.random()*8000);
const server=spawn(process.execPath,["server.js"],{env:{...process.env,PORT:String(port),HOST:"127.0.0.1",
  AICAD_RL_DIR:path.join(root,"rl"),AICAD_RATING_DIR:path.join(root,"ratings"),
  AICAD_CONVERSATION_DIR:path.join(root,"conversations"),AICAD_CADQUERY_SCRIPT_DIR:path.join(root,"scripts")},stdio:["ignore","pipe","inherit"]});
try {
  await once(server.stdout,"data");
  const base="http://127.0.0.1:"+port;
  const {requestToken}=await(await fetch(base+"/api/status")).json();
  async function post(route,body){
    const res=await fetch(base+route,{method:"POST",headers:{"content-type":"application/json","x-ai-cad-token":requestToken},
      body:JSON.stringify(body)});
    const result=await res.json();
    assert.equal(res.status,200,JSON.stringify(result));
    return result;
  }
  const task={pitchMm:23,pinCount:2,travelMm:6,minSeatFraction:0.65};
  const job=await post("/api/chat",{message:"/安装板 "+JSON.stringify(task)});
  assert.equal(job.exploration.action,"twin_slots");
  assert.ok(job.assembly.currentRevision);
  const rating=await post("/api/rate",{assemblyId:job.assembly.id,conversationId:job.conversationId,plan:job.plan,
    assembly:job.assembly,score:50,comment:"integration fixture"});
  assert.ok(rating.ok);
  const dir=path.join(root,"rl","experience");
  const events=await Promise.all((await readdir(dir)).filter(x=>x.endsWith(".json")).map(async f=>JSON.parse(await readFile(path.join(dir,f)))));
  const selected=events.find(x=>x.type==="selected");
  assert.equal(selected.decision,"pass");
  assert.ok(events.some(x=>x.type==="rating" && x.designDigest===selected.designDigest));
  assert.ok(events.some(x=>x.type==="verification"));
  const rejected=await post("/api/chat",{message:"/安装板 "+JSON.stringify({...task,pinCount:4})});
  assert.equal(rejected.exploration.action,null);
  await rename(dir, `${dir}-verified`);
  await writeFile(dir, "feedback directory intentionally unavailable");
  const fallback = await post("/api/chat", { message: "/安装板 " + JSON.stringify(task) });
  assert.ok(fallback.assembly.currentRevision);
  const fallbackRating = await post("/api/rate", {
    assemblyId: fallback.assembly.id, conversationId: fallback.conversationId,
    plan: fallback.plan, assembly: fallback.assembly, score: 50, comment: "feedback unavailable fixture"
  });
  assert.ok(fallbackRating.ok);
  console.log("Verified build, rating, rejected exploration, and feedback storage failure:", root);
} finally {
  server.kill("SIGTERM");
}
