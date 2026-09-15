import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appJs = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("./server.js", import.meta.url), "utf8");

test("preview panel exposes a manual visual review button and report container", () => {
  assert.match(html, /id="visualReviewBtn"/);
  assert.match(html, /审查并自动修复/);
  assert.match(html, /id="visualReviewPanel"/);
  assert.match(html, /id="visualReviewStatus"/);
  assert.match(html, /id="visualAcceptanceStatus"/);
  assert.match(html, /id="visualReviewFindings"/);
  assert.match(html, /id="visualImproveBtn"/);
  assert.match(html, /id="visualImproveStatus"/);
  assert.match(html, /id="visualImprovementTrace"/);
});

test("visual review feedback can request a validated parametric improvement", () => {
  assert.match(appJs, /els\.visualImproveBtn\.addEventListener\("click",\s*improveFromVisualReview\)/);
  assert.match(appJs, /async function improveFromVisualReview\(/);
  assert.match(appJs, /reReview = true/);
  assert.match(appJs, /followUpReview = await runVisualReview\(\{ rethrow: true, autoImprove: false \}\)/);
  assert.match(appJs, /improveFromVisualReview\(\{ rethrow: true, reReview: false \}\)/);
  assert.match(appJs, /api\("\/api\/visual-review\/improve"/);
  assert.match(server, /path: "\/api\/visual-review\/improve", handler: handleVisualReviewImprove/);
  assert.match(server, /visualReviewImprovementEligibility\(review, job\.currentRevision\)/);
  assert.match(server, /editAssemblyRevision\(\{/);
  assert.match(server, /persistVisualReviewReport\(job/);
  assert.match(appJs, /visualImprovementTrace:\s*document\.querySelector\("#visualImprovementTrace"\)/);
  assert.match(appJs, /visualReviewFindings\.addEventListener\("click"/);
  assert.match(appJs, /data-review-target/);
  assert.match(appJs, /function focusReviewFinding\(/);
  assert.match(appJs, /function renderVisualImprovementTrace\(/);
  assert.match(appJs, /finding\.actionability === "auto"/);
  assert.match(appJs, /finding\.proposedChange\?\.op/);
  assert.match(appJs, /问题 → 修改 → 验证/);
});

test("app wires manual visual review to screenshot capture and backend endpoint", () => {
  assert.match(appJs, /visualReviewBtn:\s*document\.querySelector\("#visualReviewBtn"\)/);
  assert.match(appJs, /els\.visualReviewBtn\.addEventListener\("click",\s*\(\) => runAutomaticReviewLoop\(\{ request: "审查当前装配并根据报告自动修复，直到几何与视觉验收通过", assembly: state\.currentAssembly \}\)\)/);
  assert.match(appJs, /async function runVisualReview\(/);
  assert.match(appJs, /function captureReviewScreenshots\(/);
  assert.match(appJs, /async function runVisualReview\(\{ rethrow = false, autoImprove = false \}/);
  assert.match(appJs, /正在自动修改可安全修复的问题并复审/);
  assert.match(appJs, /captureReviewView\("3d"\)/);
  assert.match(appJs, /captureReviewView\("front"\)/);
  assert.match(appJs, /captureReviewView\("top"\)/);
  assert.match(appJs, /captureReviewView\("side"\)/);
  assert.match(appJs, /captureReviewView\("3d", "section"\)/);
  assert.match(appJs, /captureReviewView\("3d", "exploded"\)/);
  assert.match(appJs, /setReviewTransparency\(enclosurePartIds, 0\.08\)/);
  assert.match(appJs, /setReviewVisibility\?\.\(enclosurePartIds, false\)/);
  assert.match(appJs, /restoreDisplayState/);
  assert.match(appJs, /api\("\/api\/visual-review"/);
});

test("completed generation enters an automatic review/improvement loop", () => {
  assert.match(appJs, /async function runAutomaticReviewLoop\(/);
  assert.match(appJs, /else await runAutomaticReviewLoop\(\{ request: message \|\| "根据参考图片建模", assembly: result\.assembly \}\)/);
  assert.match(appJs, /自动审查中/);
  assert.match(appJs, /自动审查\/改进失败/);
  assert.match(appJs, /剩余问题需要后期输入尺寸、约束或人工确认/);
  assert.match(appJs, /function visualReviewFingerprint\(/);
  assert.match(appJs, /autoLoopStopReason = "no_progress"/);
  assert.match(appJs, /review\.geometryAcceptance = geometryAcceptanceState/);
  assert.match(appJs, /双重验收：通过 · BREP\/STEP 几何 \+ 视觉审查/);
});

test("visual review button is disabled until an assembly and mesh are ready", () => {
  assert.match(appJs, /function updateVisualReviewButton\(/);
  assert.match(appJs, /els\.visualReviewBtn\.disabled\s*=\s*state\.trainingRunning \|\| state\.autoReviewRunning \|\| !\(state\.currentAssembly\?\.id && \["done", "validation_failed"\]\.includes\(state\.currentAssembly\?\.status\) && mesh\)/);
});

test("validation-failed previews remain eligible for visual evidence but not training promotion", () => {
  assert.match(server, /\["done", "validation_failed"\]\.includes\(job\.status\)/);
  assert.match(server, /job\.currentRevision \|\| job\.pendingRevision \|\| `validation-failed:/);
  assert.match(appJs, /state\.currentAssembly\?\.status === "validation_failed"/);
  assert.match(appJs, /几何验证未通过，未进入训练样本/);
  assert.match(server, /acceptance: assemblyAcceptanceGate\(job\)/);
  assert.match(server, /passed: geometryPassed && visualPassed/);
  assert.match(server, /path: "\/api\/assembly\/repair", handler: handleAssemblyRepair/);
  assert.match(appJs, /api\("\/api\/assembly\/repair"/);
  assert.match(appJs, /api\("\/api\/visual-review\/repair"/);
  assert.match(server, /path: "\/api\/visual-review\/repair", handler: handleVisualReviewRepair/);
});
