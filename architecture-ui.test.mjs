import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./public/architecture.html", import.meta.url), "utf8");
const main = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const spec = JSON.parse(readFileSync(new URL("./docs/architecture/aicad.architecture.json", import.meta.url), "utf8"));

test("Archify architecture artifact is self-contained and linked from AI-CAD", () => {
  assert.match(html, /AI-CAD 参数化建模系统架构/);
  assert.match(html, /data-theme|theme/i);
  assert.match(html, /Present/);
  assert.match(html, /Export/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /src="\/architecture\.js"/);
  assert.doesNotMatch(html, /href="\/architecture\.css"/);
  assert.match(main, /href="\/architecture\.html"/);
});

test("Archify specification preserves the real AI-CAD engineering framework", () => {
  assert.equal(spec.diagram_type, "architecture");
  assert.equal(spec.meta.quality_profile, "showcase");
  const ids = new Set(spec.components.map((component) => component.id));
  for (const id of ["workbench", "orchestrator", "planner", "parametric", "cadkernel", "validation", "revision", "delivery", "codex", "catalog", "learning", "visual"]) assert.equal(ids.has(id), true);
  assert.equal(spec.connections.some((connection) => connection.id === "repair_retry"), true);
  assert.equal(spec.meta.views.length, 3);
});
