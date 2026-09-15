import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { describeLlmPolicy, llmRouteForRequest, normalizeLlmProvider, resolveLlmPolicy } from "./llm-provider.js";

const server = readFileSync(new URL("./server.js", import.meta.url), "utf8");

test("LLM provider selection defaults to Codex and rejects unknown values", () => {
  assert.equal(normalizeLlmProvider(undefined), "codex");
  assert.equal(normalizeLlmProvider("DeepSeek"), "deepseek");
  assert.throws(() => normalizeLlmProvider("gemini"), /Invalid LLM provider/);
  assert.equal(resolveLlmPolicy({}).provider, "codex");
});

test("DeepSeek stays primary only when it is selected and configured", () => {
  const missingKey = resolveLlmPolicy({ AICAD_LLM_PROVIDER: "deepseek" });
  assert.equal(missingKey.deepseek.apiKey, "");
  assert.equal(missingKey.warnings.length, 1);
  assert.deepEqual(llmRouteForRequest(missingKey, {}), { useDeepSeek: false, fallbackToCodex: true, reason: "missing-api-key" });

  const ready = resolveLlmPolicy({ AICAD_LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-test" });
  assert.deepEqual(llmRouteForRequest(ready, {}), { useDeepSeek: true, fallbackToCodex: true, reason: "deepseek" });
});

test("images route away from a text-only DeepSeek model unless strict mode forbids fallback", () => {
  const policy = resolveLlmPolicy({ AICAD_LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-test" });
  assert.deepEqual(llmRouteForRequest(policy, { hasImages: true }), { useDeepSeek: false, fallbackToCodex: true, reason: "images-unsupported" });

  const visionPolicy = resolveLlmPolicy({ AICAD_LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-test", AICAD_DEEPSEEK_VISION: "1" });
  assert.deepEqual(llmRouteForRequest(visionPolicy, { hasImages: true }), { useDeepSeek: true, fallbackToCodex: true, reason: "deepseek" });

  const strictPolicy = resolveLlmPolicy({ AICAD_LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-test", AICAD_LLM_STRICT: "1" });
  assert.equal(llmRouteForRequest(strictPolicy, { hasImages: true }).fallbackToCodex, false);
  assert.equal(llmRouteForRequest(strictPolicy, {}).fallbackToCodex, false);
});

test("public status never exposes the DeepSeek key", () => {
  const policy = resolveLlmPolicy({ AICAD_LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-secret" });
  const status = describeLlmPolicy(policy, { codexModel: "gpt-6-astra" });
  assert.equal(status.provider, "deepseek");
  assert.equal(status.deepseek.configured, true);
  assert.equal(status.deepseek.active, true);
  assert.equal(status.deepseek.model, "deepseek-chat");
  assert.equal(status.codexModel, "gpt-6-astra");
  assert.equal(JSON.stringify(status).includes("sk-secret"), false);
});

test("server routes planner, edit and visual review through one DeepSeek-then-Codex seam", () => {
  assert.match(server, /import \{ DeepSeekClient \} from "\.\/deepseek-client\.js"/);
  assert.match(server, /const llmPolicy = resolveLlmPolicy\(process\.env\)/);
  assert.match(server, /new DeepSeekClient/);
  assert.match(server, /async function invokeLlmText/);
  assert.match(server, /llm: describeLlmPolicy\(llmPolicy, \{ codexModel \}\)/);
  assert.match(server, /label: "planner"/);
  assert.match(server, /label: "visual review"/);
  assert.match(server, /label: "generate"/);
  // DeepSeek must be attempted before the Codex fallback inside the seam.
  const seam = server.slice(server.indexOf("async function invokeLlmText"), server.indexOf("async function generateAssemblyPlan"));
  assert.ok(seam.indexOf("deepseekClient.run") < seam.indexOf("runCodexTextInvocation({"));
  assert.match(server, /Codex app-server planner fallback/);
});
