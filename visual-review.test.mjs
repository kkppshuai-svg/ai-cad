import test from "node:test";
import assert from "node:assert/strict";

import {
  actionableVisualFindings,
  actionableValidationIssues,
  buildVisualImprovementValidationRepairMessage,
  buildVisualReviewImprovementMessage,
  buildVisualReviewReportRepairMessage,
  buildVisualReviewInstruction,
  normalizeVisualReviewResult,
  visualReviewImprovementEligibility
} from "./visual-review.js";

test("builds a visual review instruction that asks Codex to review screenshots against the request", () => {
  const instruction = buildVisualReviewInstruction({
    userRequest: "做一个带四个安装孔的电机支架",
    plan: {
      name: "motor_bracket",
      parts: [{ id: "plate", features: [{ type: "hole" }] }],
      relations: []
    },
    assembly: {
      id: "assembly-1",
      name: "motor_bracket",
      manifestUrl: "/assemblies/assembly-1/assembly-manifest.json"
    },
    screenshots: [
      { view: "3d", name: "3d.jpg" },
      { view: "front", name: "front.jpg" },
      { view: "top", name: "top.jpg" },
      { view: "side", name: "side.jpg" }
    ]
  });

  assert.match(instruction, /Return only one JSON object/);
  assert.match(instruction, /做一个带四个安装孔的电机支架/);
  assert.match(instruction, /3d\.jpg/);
  assert.match(instruction, /front\.jpg/);
  assert.match(instruction, /pass\|warning\|fail/);
  assert.match(instruction, /visual observation/i);
});

test("review prompt distinguishes transparent and exploded evidence from real assembly position", () => {
  const instruction = buildVisualReviewInstruction({ screenshots: [{ view: "section", name: "section.jpg" }, { view: "exploded", name: "exploded.jpg" }] });
  assert.match(instruction, /section\.jpg uses temporary transparent enclosure/i);
  assert.match(instruction, /never report those offsets as floating parts/i);
  assert.match(instruction, /never from exploded\.jpg/i);
});

test("visual review prompt receives the merged BREP/STEP validation report", () => {
  const instruction = buildVisualReviewInstruction({
    userRequest: "检查零件",
    assembly: {
      id: "assembly-1",
      validationReport: {
        valid: true,
        blockingErrorCount: 0,
        measurements: [{ id: "depth", status: "pass" }]
      }
    },
    screenshots: []
  });
  assert.match(instruction, /geometryValidation/);
  assert.match(instruction, /"depth"/);
});

test("report repair prompt can cover high-confidence structural gaps", () => {
  const prompt = buildVisualReviewReportRepairMessage({
    userRequest: "增加行星齿轮、行星架和内齿圈",
    currentRevision: "rev-0002",
    review: { status: "fail", recommendedNextAction: "ask_user", findings: [{ findingId: "F01", actionability: "needs_user", message: "缺少行星机构" }] }
  });
  assert.match(prompt, /优先返回 edit_patch/);
  assert.match(prompt, /增加行星齿轮、行星架和内齿圈/);
  assert.match(prompt, /缺少行星机构/);
  assert.match(prompt, /STEP round-trip/);
});

test("normalizes visual review JSON into a stable report shape", () => {
  const report = normalizeVisualReviewResult({
    status: "fail",
    summary: "未看到加强筋",
    findings: [{
      findingId: "F01",
      severity: "fail",
      category: "visual",
      message: "侧视图缺少加强筋",
      partId: "plate",
      featureId: "plate.rib.01",
      confidence: "high",
      actionability: "auto",
      proposedChange: { op: "add_feature", path: null, value: { type: "rib" }, reason: "侧视图缺少加强筋" },
      verification: { method: "visual re-review", expected: "side.jpg 可见加强筋" },
      evidence: ["side.jpg"]
    }],
    recommendedNextAction: "revise"
  }, {
    assemblyId: "assembly-1",
    screenshots: [{ view: "side", name: "side.jpg" }]
  });

  assert.equal(report.status, "fail");
  assert.equal(report.assemblyId, "assembly-1");
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].evidence[0], "side.jpg");
  assert.equal(report.findings[0].partId, "plate");
  assert.equal(report.findings[0].proposedChange.op, "add_feature");
  assert.equal(report.findings[0].verification.method, "visual re-review");
  assert.equal(report.recommendedNextAction, "revise");
  assert.equal(report.screenshots[0].view, "side");
});

test("binds visual review feedback to a revision and builds a scoped improvement request", () => {
  const report = normalizeVisualReviewResult({
    status: "fail",
    summary: "车轮方向错误",
    findings: [{
      findingId: "F01",
      severity: "fail",
      category: "visual",
      message: "四个车轮轴线方向不正确",
      partId: "wheel_front_left",
      featureId: "wheel_front_left.base.01",
      confidence: "high",
      actionability: "auto",
      proposedChange: { op: "set_part_pose", path: "pose.rotate", value: [90, 0, 0], reason: "轮轴方向与车体不一致" },
      verification: { method: "visual re-review", expected: "front.jpg 中轮轴方向一致" },
      evidence: ["front.jpg"]
    }],
    recommendedNextAction: "revise"
  }, { assemblyId: "assembly-1", revisionId: "rev-0002" });

  assert.equal(report.revisionId, "rev-0002");
  assert.equal(visualReviewImprovementEligibility(report, "rev-0002").ok, true);
  assert.equal(visualReviewImprovementEligibility(report, "rev-0003").code, "REVIEW_STALE");
  const message = buildVisualReviewImprovementMessage({ review: report, currentRevision: "rev-0002", userRequest: "四轮底盘" });
  assert.match(message, /必须返回 edit_patch/);
  assert.match(message, /四个车轮轴线方向不正确/);
  assert.match(message, /F01/);
  assert.match(message, /wheel_front_left/);
  assert.match(message, /set_part_pose/);
  assert.match(message, /visual re-review/);
  assert.match(message, /不得猜测数值/);
  assert.match(message, /rev-0002/);
});

test("improvement request can be limited to selected findings", () => {
  const report = normalizeVisualReviewResult({
    status: "fail",
    summary: "两个可修复问题",
    findings: [
      { findingId: "F01", severity: "fail", category: "visual", message: "方向错误", partId: "a", confidence: "high", actionability: "auto", proposedChange: { op: "set_part_pose", reason: "修正方向" }, verification: { method: "visual re-review", expected: "方向正确" } },
      { findingId: "F02", severity: "warning", category: "visual", message: "位置错误", partId: "b", confidence: "high", actionability: "auto", proposedChange: { op: "set_part_pose", reason: "修正位置" }, verification: { method: "visual re-review", expected: "位置正确" } }
    ]
  }, { assemblyId: "assembly-1", revisionId: "rev-0002" });
  const message = buildVisualReviewImprovementMessage({ review: report, currentRevision: "rev-0002", selectedFindingIds: ["F02"] });
  assert.match(message, /F02/);
  assert.doesNotMatch(message, /F01/);
  assert.match(message, /未列出的问题必须保持不变/);
});

test("requires measurement or confirmation instead of auto-editing weak findings", () => {
  const report = normalizeVisualReviewResult({
    status: "fail",
    summary: "孔边距可能不足",
    findings: [{
      findingId: "F01",
      severity: "warning",
      category: "geometry",
      message: "截图中孔看起来靠近边缘",
      partId: "plate",
      confidence: "low",
      actionability: "needs_measurement",
      verification: { method: "BREP measurement", expected: "孔边距达到设计下限" },
      evidence: ["top.jpg"]
    }],
    recommendedNextAction: "revise"
  }, { assemblyId: "assembly-1", revisionId: "rev-0002" });

  assert.equal(report.recommendedNextAction, "ask_user");
  assert.equal(actionableVisualFindings(report).length, 0);
  assert.equal(visualReviewImprovementEligibility(report, "rev-0002").code, "FINDINGS_NEED_CONFIRMATION");
});

test("downgrades invented review targets before an edit can run", () => {
  const report = normalizeVisualReviewResult({
    status: "fail",
    summary: "目标错误",
    findings: [{
      severity: "fail",
      message: "虚构零件需要移动",
      partId: "invented_part",
      confidence: "high",
      actionability: "auto",
      proposedChange: { op: "set_part_pose", value: [1, 2, 3] },
      verification: { method: "visual re-review", expected: "位置正确" }
    }],
    recommendedNextAction: "revise"
  }, {
    assemblyId: "assembly-1",
    revisionId: "rev-0002",
    plan: { parts: [{ id: "real_part", features: [] }] }
  });

  assert.equal(report.findings[0].partId, null);
  assert.equal(report.findings[0].actionability, "needs_user");
  assert.equal(report.recommendedNextAction, "ask_user");
});

test("invalid visual review status falls back to warning", () => {
  const report = normalizeVisualReviewResult({
    status: "unknown",
    summary: "",
    findings: []
  }, { assemblyId: "assembly-1" });

  assert.equal(report.status, "warning");
  assert.match(report.summary, /unable/i);
});

test("validation repair prompt replaces a failed visual patch from the current revision", () => {
  const report = { issues: [
    { code: "MISSING_PART_ARTIFACT", partId: "wheel" },
    { code: "BUILD_EXECUTION_FAILED", partId: "wheel", featureId: "wheel.add.02", message: "feature requires existing base geometry" }
  ] };
  assert.deepEqual(actionableValidationIssues(report).map((issue) => issue.code), ["BUILD_EXECUTION_FAILED"]);
  const prompt = buildVisualImprovementValidationRepairMessage({
    review: { summary: "缺少十个轮子", revisionId: "rev-0001" },
    currentRevision: "rev-0001",
    failedPatch: { operations: [{ op: "disable_feature", featureId: "wheel.base.01" }] },
    validationReport: report
  });
  assert.match(prompt, /基于当前有效修订重新生成/);
  assert.match(prompt, /baseRevision 必须是 rev-0001/);
  assert.match(prompt, /不得禁用唯一的基础特征/);
  assert.match(prompt, /set_part_pose 必须使用/);
  assert.match(prompt, /不支持 primitive\.positions/);
  assert.match(prompt, /BUILD_EXECUTION_FAILED/);
  assert.doesNotMatch(prompt, /MISSING_PART_ARTIFACT/);
});
