import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const buildPy = readFileSync(new URL("./scripts/cadquery_build.py", import.meta.url), "utf8");
const serverJs = readFileSync(new URL("./server.js", import.meta.url), "utf8");

test("CadQuery build emits a hierarchical GLB alongside STEP and STL", () => {
  assert.match(buildPy, /assembly\.glb/);
  assert.match(buildPy, /exportType=["']GLTF["']/);
  assert.match(buildPy, /["']glbPath["']\s*:/);
  assert.match(buildPy, /["']stlPath["']\s*:/);
});

test("server publishes GLB while preserving STL compatibility", () => {
  assert.match(serverJs, /job\.glbPath\s*=\s*buildSummary\.glbPath/);
  assert.match(serverJs, /glbUrl:\s*job\.glbPath/);
  assert.match(serverJs, /stlUrl:\s*job\.stlPath/);
  assert.match(serverJs, /glbUrl:\s*buildSummary\.glbPath/);
});
