import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("./server.js", import.meta.url), "utf8");
const latent = readFileSync(new URL("./cad-latent-memory.js", import.meta.url), "utf8");

test("training mode exposes an integrated generation review improvement workflow", () => {
  assert.match(html, /id="trainingModeEnabled"/);
  assert.match(html, /id="trainingStopBtn"/);
  assert.match(html, /生成 → 视觉审查 → 局部改进 → 再审查/);
  assert.match(app, /async function runTrainingLoop\(/);
  assert.match(app, /await runVisualReview\(\{ rethrow: true \}\)/);
  assert.match(app, /await improveFromVisualReview\(\{ rethrow: true, reReview: false \}\)/);
  assert.match(app, /const maxImprovements = 6/);
  assert.match(app, /recommendedNextAction !== "revise"/);
  assert.match(app, /function dualAcceptancePassed\(/);
  assert.match(app, /async function ensureGeometryAcceptance\(/);
  assert.match(app, /几何与视觉验收均通过/);
  assert.match(app, /visual review made no progress/);
  assert.match(app, /resumeSession\.phase/);
  assert.match(app, /attempts: improvement\.attempts \|\| \[\]/);
  assert.match(server, /maximumValidationRepairs/);
  assert.match(server, /buildVisualImprovementValidationRepairMessage/);
  assert.match(server, /code: "EDIT_PATCH_INVALID"/);
  assert.match(server, /\["queued", "reviewing", "reviewed", "improving", "persisted", "completed"\]/);
});

test("training mode archives each round and only retains passing loops for latent learning", () => {
  assert.match(app, /api\("\/api\/training\/session"/);
  assert.match(server, /path: "\/api\/training\/session", handler: handleTrainingSession(Save|Load)/);
  assert.match(server, /format: "ai-cad-training-session-v1"/);
  assert.match(server, /retainedForLatentLearning: status === "pass"/);
  assert.match(server, /session\.status !== "pass"/);
  assert.match(server, /trainingVerified: true/);
  assert.match(latent, /quality:visual-loop-pass/);
});
