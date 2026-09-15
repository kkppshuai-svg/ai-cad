import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const viewer = readFileSync(new URL("./public/cad-viewer.js", import.meta.url), "utf8");
const server = readFileSync(new URL("./server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

test("engineering viewer uses Three.js GLB controls with STL fallback", () => {
  assert.match(viewer, /from\s+["']three["']/);
  assert.match(viewer, /GLTFLoader/);
  assert.match(viewer, /STLLoader/);
  assert.match(viewer, /OrbitControls/);
  assert.match(viewer, /async loadGlb\(/);
  assert.match(viewer, /async loadStl\(/);
});

test("engineering viewer exposes part interaction operations", () => {
  for (const method of [
    "selectPart", "hideSelected", "isolateSelected", "showAll", "captureDisplayState", "restoreDisplayState", "setReviewTransparency", "setReviewVisibility", "setExplodedReview",
    "setGhostMode", "setWireframe", "setViewPreset", "capture", "dispose"
  ]) {
    assert.match(viewer, new RegExp(`${method}\\(`), `missing ${method}`);
  }
  assert.match(viewer, /Raycaster/);
  assert.match(viewer, /onSelect/);
});

test("server exposes scoped Three.js module routes", () => {
  assert.match(server, /url\.pathname\.startsWith\("\/vendor\/three\/"\)/);
  assert.match(server, /threeBuildDir/);
  assert.match(server, /\/vendor\/three\/addons\//);
  assert.match(server, /node_modules["'],\s*["']three/);
});

test("viewer is visible and resized before and after model loading", () => {
  assert.match(app, /els\.canvas\.style\.display\s*=\s*"block";\s*els\.canvas\.hidden\s*=\s*false;\s*cadViewer\s*=\s*new CadViewer/s);
  assert.match(viewer, /new ResizeObserver\(\(\)\s*=>\s*this\.resize\(\)\)/);
  assert.match(viewer, /async loadGlb[\s\S]*this\.resize\(\);[\s\S]*this\.fitToObject/);
  assert.match(viewer, /async loadStl[\s\S]*this\.resize\(\);[\s\S]*this\.fitToObject/);
  assert.match(viewer, /this\.resizeObserver\?\.disconnect\(\)/);
  assert.match(app, /showThreeViewerStage\(\);\s*const stats = await cadViewer\.loadGlb/s);
  assert.match(app, /showThreeViewerStage\(\);\s*const stats = await cadViewer\.loadStl/s);
});

test("latest part or assembly request wins when model loads overlap", () => {
  assert.match(viewer, /this\.loadSequence\s*=\s*0/);
  assert.match(viewer, /const sequence = \+\+this\.loadSequence/g);
  assert.match(viewer, /if \(sequence !== this\.loadSequence\) \{\s*this\.disposeObject\(gltf\.scene\);\s*return null;/s);
  assert.match(viewer, /if \(sequence !== this\.loadSequence\) \{\s*geometry\.dispose\(\);\s*return null;/s);
  assert.match(app, /cadViewer\?\.cancelPendingLoad\(\);\s*els\.canvas\.style\.display = "none";/s);
});
