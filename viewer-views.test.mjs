import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appJs = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");

test("viewer toolbar offers 3D plus front/top/side view buttons", () => {
  assert.match(html, /id="view3dBtn"[^>]*>3D</);
  assert.match(html, /id="viewFrontBtn"[^>]*>前视</);
  assert.match(html, /id="viewTopBtn"[^>]*>顶视</);
  assert.match(html, /id="viewSideBtn"[^>]*>侧视</);
});

test("app wires view preset buttons and tracks the active preset", () => {
  assert.match(appJs, /view3dBtn:\s*document\.querySelector\("#view3dBtn"\)/);
  assert.match(appJs, /viewFrontBtn:\s*document\.querySelector\("#viewFrontBtn"\)/);
  assert.match(appJs, /viewTopBtn:\s*document\.querySelector\("#viewTopBtn"\)/);
  assert.match(appJs, /viewSideBtn:\s*document\.querySelector\("#viewSideBtn"\)/);
  assert.match(appJs, /viewPreset:\s*"free"/);
  assert.match(appJs, /function setViewPreset\(/);
  assert.match(appJs, /setViewPreset\("front"\)/);
  assert.match(appJs, /setViewPreset\("top"\)/);
  assert.match(appJs, /setViewPreset\("side"\)/);
  assert.match(appJs, /setViewPreset\("free"\)/);
});

test("preset views use orthographic projection while 3D stays perspective", () => {
  assert.match(appJs, /const VIEW_PRESETS\s*=/);
  assert.match(appJs, /function ortho\(/);
  assert.match(appJs, /function rotateZ\(/);
  assert.match(appJs, /angleZ/);
  // free mode still uses perspective projection
  assert.match(appJs, /perspective\(45 \* Math\.PI \/ 180/);
});

test("viewer delegates orbit interaction to Three.js controls", () => {
  const viewerJs = readFileSync(new URL("./public/cad-viewer.js", import.meta.url), "utf8");
  assert.match(viewerJs, /OrbitControls/);
  assert.match(viewerJs, /screenSpacePanning\s*=\s*true/);
});
