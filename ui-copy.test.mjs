import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("default product copy prioritizes parametric part modeling and VAE latent learning", () => {
  const appJs = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const serverJs = readFileSync(new URL("./server.js", import.meta.url), "utf8");

  assert.match(html, /参数化特征计划和 VAE\/latent 学习为核心/);
  assert.match(appJs, /参数化特征计划 \+ VAE\/latent 学习/);
  assert.match(serverJs, /coreRepresentation/);
  assert.match(serverJs, /参数化特征计划 \+ VAE\/latent 学习/);
  assert.match(serverJs, /零件 STEP\/FCStd 是主要交付文件/);
  assert.match(appJs, /CadQuery BREP 几何内核/);
  assert.match(appJs, /outputStrategy/);
  assert.match(html, /下载 STEP/);
  assert.match(html, /下载单体与关系包/);
});

test("FreeCAD kinematic package remains part of the core delivery", () => {
  const serverJs = readFileSync(new URL("./server.js", import.meta.url), "utf8");

  assert.match(serverJs, /async function buildKinematicPackage\(job\)/);
  assert.match(serverJs, /assembly_kinematic_package/);
  assert.match(serverJs, /open_in_freecad\.py/);
});

test("part editor serialization preserves step.parts standard part fields", () => {
  const appJs = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

  assert.match(appJs, /mode:\s*part\.mode/);
  assert.match(appJs, /standardPart:\s*part\.standardPart/);
  assert.match(appJs, /sourceStepPath:\s*part\.sourceStepPath/);
});

test("plan application renders built STL directly without starting CAD Explorer", () => {
  const appJs = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

  assert.match(appJs, /function getActiveBuiltPart\(\)/);
  assert.match(appJs, /loadStl\(assembly\.stlUrl/);
  assert.match(appJs, /loadStl\(activeBuilt\.stlUrl/);
  assert.doesNotMatch(appJs, /showExplorerForPart\(activePart\.id\)/);
});

test("preview stage uses the built-in STL viewer and does not depend on an Explorer iframe", () => {
  const appJs = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("./public/styles.css", import.meta.url), "utf8");

  assert.match(html, /id="viewer"/);
  assert.match(html, /刷新 3D 预览/);
  assert.match(html, /导出当前预览/);
  assert.match(html, /3D STL 预览/);
  assert.doesNotMatch(html, /id="explorerFrame"/);
  assert.doesNotMatch(appJs, /\/api\/explorer-link/);
  assert.doesNotMatch(appJs, /showExplorerPreview|hideExplorerPreview|explorerFrame/);
  assert.match(appJs, /function showAssemblyStl\(\)/);
  assert.match(appJs, /function showActivePartStl\(\)/);
  assert.match(appJs, /loadStl\(/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test("legacy external STEP/STL receiver transfer UI is removed", () => {
  const appJs = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");

  assert.doesNotMatch(html, /发送 STEP|发送 STL|打开接收端/);
  assert.doesNotMatch(html, /sendStepBtn|sendStlBtn|receiverLink/);
  assert.doesNotMatch(appJs, /sendCurrentFile|getTransferUrl|updateTransferButtons/);
  assert.doesNotMatch(appJs, /receiverUrl|ai-cad-receiver-url|\/api\/receive/);
});

test("FreeCAD GUI launch button and API are removed", () => {
  const appJs = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const serverJs = readFileSync(new URL("./server.js", import.meta.url), "utf8");
  const packageJson = readFileSync(new URL("./package.json", import.meta.url), "utf8");

  assert.doesNotMatch(html, /打开 FreeCAD 装配|openFreeCadBtn/);
  assert.doesNotMatch(appJs, /openFreeCadAssembly|canOpenFreeCadAssembly|allowFreeCadLaunch|openFreeCadBtn|\/api\/freecad\/open/);
  assert.doesNotMatch(serverJs, /\/api\/freecad\/open|openAssemblyInFreeCad|allowFreeCadLaunch|freecadBin|AICAD_ALLOW_FREECAD_OPEN|freecad-open\.js/);
  assert.doesNotMatch(packageJson, /freecad-open\.test\.mjs/);
});
