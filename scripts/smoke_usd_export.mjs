import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const base = process.env.AICAD_TEST_URL || "http://127.0.0.1:3101";
const get = async endpoint => {
  const response = await fetch(base + endpoint);
  assert.equal(response.status, 200);
  return response.json();
};
const status = await get("/api/status");
assert.equal(status.usdBrep.available, true);
const post = async (endpoint, body, expected = 200) => {
  const response = await fetch(base + endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", "X-AI-CAD-Token": status.requestToken },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
};
const preview = await post("/api/preview", { part: {
  id: "usd_demo_plate", name: "USD demo plate", primitives: [{ type: "box", size: [40, 30, 6], center: true }],
  features: [{ type: "hole", diameter: 8, depth: 20, axis: "z", center: [0, 0, 0] }]
} });
assert.equal(preview.status, "done");
await post("/api/usd/export", { assemblyId: preview.id, revisionId: "stale-revision" }, 409);
await post("/api/usd/export", { assemblyId: "../outside" }, 400);
const exported = await post("/api/usd/export", { assemblyId: preview.id, revisionId: null });
assert.equal(exported.representation, "mesh");
assert.equal(exported.roundTrip, "passed");
assert.ok(exported.triangles > 12);
const response = await fetch(base + exported.usdUrl);
assert.equal(response.status, 200);
const usd = await response.text();
assert.ok(usd.startsWith("#usda 1.0"));
assert.match(usd, /metersPerUnit = 0\.001/);
assert.match(usd, /upAxis = "Z"/);
const unauthorized = await fetch(base + "/api/usd/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
assert.equal(unauthorized.status, 403);
await mkdir("output", { recursive: true });
const report = { result: "passed", model: "40 x 30 x 6 mm plate with diameter 8 mm through hole", previewId: preview.id,
  stepUrl: preview.stepUrl, usdUrl: exported.usdUrl, vertices: exported.vertices, triangles: exported.triangles,
  roundTrip: exported.roundTrip, version: exported.version, runtimeWarnings: exported.runtimeWarnings };
await writeFile(path.join("output", "usd-integration-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
