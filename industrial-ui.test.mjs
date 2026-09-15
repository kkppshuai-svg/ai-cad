import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./public/styles.css", import.meta.url), "utf8");

const functionalIds = [
  "engineStatus", "chatHistory", "chatForm", "chatInput", "chatImageInput",
  "attachImageBtn", "chatImagePreview", "webSearchEnabled", "webSearchQuery",
  "searchResults", "trainingModeEnabled", "trainingStopBtn", "trainingStatus",
  "sendChatBtn", "resetChatBtn", "code", "activePartName",
  "renderBtn", "exportBtn", "renderState", "jobId", "viewer", "previewImage",
  "emptyPreview", "viewerStats", "viewAssemblyBtn", "viewPartBtn", "view3dBtn",
  "viewFrontBtn", "viewTopBtn", "viewSideBtn", "resetViewBtn", "wireframeBtn",
  "downloadLink", "fcstdLink", "stepLink", "assemblyStlLink",
  "kinematicPackageLink", "constraintsLink", "manifestLink",
  "visualReviewBtn", "visualReviewPanel", "visualReviewStatus",
  "visualReviewSummary", "visualReviewFindings", "visualImproveBtn", "visualImproveStatus", "visualImprovementTrace", "partsList", "relationsList",
  "log", "ratingPanel", "ratingForm", "submitRatingBtn", "ratingAssemblyName",
  "ratingAssemblyId", "ratingComment", "ratingStatus"
];

test("industrial workspace preserves every functional DOM hook", () => {
  for (const id of functionalIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
});

test("core modeling workspace keeps the engineering learning and delivery controls", () => {
  assert.match(html, /kinematicPackageLink/);
  assert.match(html, /VAE\/latent/);
  assert.match(html, /准确性、稳定性与可修改性/);
});

test("page presents a compact professional CAD application shell", () => {
  assert.match(html, /class="[^"]*app-header/);
  assert.match(html, /class="[^"]*brand-block/);
  assert.match(html, /class="[^"]*status-indicator/);
  assert.match(html, /class="[^"]*workspace-kicker/);
  assert.match(html, /质量检查器/);
});

test("styles define an Apple Fitness inspired engineering system", () => {
  assert.match(css, /--bg:\s*#000/);
  assert.match(css, /--fitness-move:\s*#ff375f/i);
  assert.match(css, /--fitness-exercise:\s*#32d74b/i);
  assert.match(css, /--fitness-stand:\s*#64d2ff/i);
  assert.match(css, /--panel-radius:\s*22px/);
  assert.match(css, /\.brand-mark::before[^}]*fitness-move/s);
  assert.match(css, /backdrop-filter/);
  assert.match(css, /font-family:[^;]*(?:SFMono|JetBrains Mono|Consolas)/);
});

test("workspace remains accessible and responsive", () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(max-width:\s*1280px\)/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});
