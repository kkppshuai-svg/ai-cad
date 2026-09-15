import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./public/styles.css", import.meta.url), "utf8");


test("workspace exposes parametric tree revision and validation hooks", () => {
  for (const id of [
    "featureTreePanel", "featureTreeList", "revisionList", "validationSummary",
    "validationIssues", "dofSummary", "revertRevisionBtn"
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
});


test("frontend loads feature tree, revisions and validation for completed assemblies", () => {
  assert.match(app, /loadParametricWorkspace/);
  assert.match(app, /\/feature-tree/);
  assert.match(app, /\/revisions/);
  assert.match(app, /\/validation/);
  assert.match(app, /renderFeatureTree/);
  assert.match(app, /renderValidation/);
  assert.match(app, /activeFeatureId/);
});


test("feature selection becomes local edit context and revisions can be reverted", () => {
  assert.match(app, /state\.activeFeatureId\s*=/);
  assert.match(app, /revertRevisionBtn\.addEventListener/);
  assert.match(app, /\/revert/);
  assert.match(app, /revisionId/);
});


test("parametric panels use compact industrial status styling", () => {
  assert.match(css, /\.feature-tree-panel/);
  assert.match(css, /\.feature-node/);
  assert.match(css, /\.validation-issue/);
  assert.match(css, /\.status-error/);
  assert.match(css, /\.status-warning/);
});

test("parametric workspace shows feature dimensions, interference pairs, and repair audit", () => {
  assert.match(app, /formatFeatureParams/);
  assert.match(app, /issue\.parts/);
  assert.match(app, /issue\.volume/);
  assert.match(app, /report\.repairAudit/);
  assert.match(app, /repair-audit/);
});
