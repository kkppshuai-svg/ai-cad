import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const harness = readFileSync(new URL("./codex-harness.js", import.meta.url), "utf8");
const server = readFileSync(new URL("./server.js", import.meta.url), "utf8");

test("Codex harness uses app-server lifecycle and interrupt controls", () => {
  assert.match(harness, /app-server/);
  assert.match(harness, /initialize/);
  assert.match(harness, /thread\/start/);
  assert.match(harness, /model: this\.model/);
  assert.match(harness, /allowProviderModelFallback: false/);
  assert.match(harness, /turn\/start/);
  assert.match(harness, /turn\/interrupt/);
  assert.match(harness, /turn\/completed/);
  assert.match(harness, /localImage/);
  assert.match(harness, /shutdown\(\)/);
  assert.match(server, /new CodexHarnessClient/);
  assert.match(server, /codexHarness\.run/);
});

test("AI-CAD exposes harness migration status and keeps an exec fallback", () => {
  assert.match(server, /codexHarness:\s*\{/);
  assert.match(server, /AICAD_CODEX_MODEL/);
  assert.match(server, /gpt-6-astra/);
  assert.match(server, /AICAD_CODEX_HARNESS_STRICT/);
  assert.match(server, /Codex app-server planner fallback/);
  assert.match(server, /buildCodexExecInvocation/);
  assert.match(server, /\/api\/chat\/stop/);
});
