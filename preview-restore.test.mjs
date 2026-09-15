import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("frontend restores the last successful assembly preview on startup", async () => {
  const source = await readFile(new URL("./public/app.js", import.meta.url), "utf8");

  assert.match(source, /ai-cad-last-assembly-id/);
  assert.match(source, /await restoreLastAssembly\(\)/);
  assert.match(source, /\/api\/assembly\/latest/);
  assert.match(source, /localStorage\.setItem\(LAST_ASSEMBLY_KEY, assembly\.id\)/);
  assert.match(source, /localStorage\.removeItem\(LAST_ASSEMBLY_KEY\)/);
});

test("server exposes disk-backed latest assembly recovery", async () => {
  const source = await readFile(new URL("./server.js", import.meta.url), "utf8");

  assert.match(source, /path: "\/api\/assembly\/latest", handler: handleLatestAssembly/);
  assert.match(source, /restoreLatestAssemblyJob\(assemblyDir\)/);
  assert.match(source, /restoreAssemblyJob\(assemblyDir, id\)/);
});

test("parametric revision finalization persists core preview artifact paths", async () => {
  const source = await readFile(new URL("./server.js", import.meta.url), "utf8");
  const finalizeBlock = source.match(/async function finalizeParametricRevisionBuild[\s\S]*?\n}\n\nfunction revisionDeliveryState/)?.[0] || "";

  assert.match(finalizeBlock, /applyBuildSummaryToJob\(staging, buildSummary\)/);
  assert.match(finalizeBlock, /return revisionDeliveryState\(staging\)/);
});

test("a new generation clears the previous model while validation-failed builds remain previewable", async () => {
  const source = await readFile(new URL("./public/app.js", import.meta.url), "utf8");

  assert.match(source, /setBusy\(els\.sendChatBtn, true\);[\s\S]*?clearGeneratedPreview\("正在生成新的装配预览\.\.\."\)/s);
  assert.match(source, /cadViewer\?\.cancelPendingLoad\(\);\s*cadViewer\?\.clearModel\(\);\s*cadViewer\?\.render\(\);\s*mesh = null;/s);
  assert.match(source, /if \(!\["done", "validation_failed"\]\.includes\(assembly\.status\)\) \{[\s\S]*?return null;/);
  assert.match(source, /validation_failed: "模型已生成，验证未通过"/);
});
