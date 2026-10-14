import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:3101";
const status = await (await fetch(base+"/api/status")).json();
const part = await (await fetch(base+"/usd-demo-plate.json")).json();
async function post(endpoint, body, expected = 200) {
  const response = await fetch(base+endpoint, { method: "POST", headers: {"Content-Type":"application/json", "X-AI-CAD-Token":status.requestToken}, body:JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}
const native = await post("/api/preview", { part, engine: "usd-brep" });
assert.equal(native.engine, "nvidia-usd-brep");
assert.equal(native.nativeReport.representation, "brep");
assert.ok(Math.abs(native.nativeReport.volumeMm3 - (7200-Math.PI*96)) < 1e-4);
assert.equal(native.nativeReport.cadqueryUsed, false);
const exact = await (await fetch(base+native.usdBrepUrl)).text();
assert.match(exact, /Brep|brep|Solid/);
const unsupported = await post("/api/preview", { engine:"usd-brep", part:{ id:"unsupported", name:"unsupported", primitives:[{type:"box",size:[10,10,10]}], features:[{type:"fillet",radius:1}] } }, 422);
assert.match(unsupported.error, /not yet support|Unsupported/);
const report = await post("/api/kernels/compare", { part });
for (const engine of report.engines) assert.equal(engine.status, "passed", engine.error);
assert.ok(report.volumeDifferenceMm3 < 1e-4);
assert.equal(report.dof.analysis.parts[report.partId].remainingDof, 6);
await writeFile("output/kernel-comparison-report.json", JSON.stringify(report,null,2));
console.log(JSON.stringify({result:"passed",nativeVolumeMm3:native.nativeReport.volumeMm3,comparisonVolumeDifferenceMm3:report.volumeDifferenceMm3,engines:report.engines.map(e=>({engine:e.engine,metrics:e.metrics,analyticVolumeErrorMm3:e.analyticVolumeErrorMm3,durationMs:e.durationMs})),dof:report.dof.analysis.parts[report.partId].remainingDof},null,2));
