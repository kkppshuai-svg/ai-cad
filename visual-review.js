const VALID_STATUSES = new Set(["pass", "warning", "fail"]);
const VALID_SEVERITIES = new Set(["info", "warning", "fail"]);
const VALID_ACTIONS = new Set(["accept", "ask_user", "revise"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_ACTIONABILITY = new Set(["auto", "needs_measurement", "needs_user", "informational"]);
const VALID_EDIT_OPERATIONS = new Set(["set_param", "set_measurement_target", "set_part_property", "add_feature", "remove_feature", "enable_feature", "disable_feature", "set_part_pose", "set_constraint", "remove_constraint"]);

export function buildVisualReviewInstruction({
  userRequest = "",
  plan = null,
  assembly = null,
  screenshots = []
} = {}) {
  const screenshotList = screenshots.map((item) => ({
    view: item.view,
    name: item.name
  }));

  return `You are a CAD visual reviewer.

Return only one JSON object. No markdown.

Task:
- Review the rendered CAD screenshots against the user's original request and the structured CAD plan.
- Treat screenshots as visual observation evidence, not exact measurement evidence.
- Separate visual observation from items that require geometric measurement.
- Prefer the supplied BREP/STEP geometry validation measurements for exact dimensions. If a measurement passed there, do not ask the user to confirm that same numeric dimension from a screenshot.
- If a required measurement is missing, failed, or unmeasurable, report that exact measurement state and recommend user confirmation or a geometry-validation fix.
- Treat unverifiedDimensions as explicitly unresolved engineering evidence; do not convert them into a visual pass.
- Do not claim strength, real-world fit, machining success, or load capacity has been validated.
- Every non-informational finding must identify an exact existing partId. Include featureId when one feature can be identified from the structured plan.
- Never invent partId or featureId values. If the target is not unique, use actionability needs_user.
- Use actionability auto only when target and operation are unambiguous. Numeric edits require structured geometry evidence; otherwise use needs_measurement or needs_user.
- Every auto finding must include proposedChange plus a concrete verification method and expected pass condition.

Required JSON schema:
{
  "status": "pass|warning|fail",
  "summary": "short Chinese summary",
  "findings": [
    {
      "findingId": "F01",
      "severity": "info|warning|fail",
      "category": "visual|geometry|manufacturing|requirement|uncertain",
      "message": "Chinese finding",
      "partId": "exact existing part ID or null",
      "featureId": "exact existing feature ID or null",
      "confidence": "high|medium|low",
      "actionability": "auto|needs_measurement|needs_user|informational",
      "proposedChange": { "op": "set_param|set_part_pose|add_feature|...", "path": "exact edit path or null", "value": "evidence-backed value or null", "reason": "why" },
      "verification": { "method": "BREP measurement|visual re-review|interference check|constraint check", "expected": "specific pass condition" },
      "evidence": ["3d.jpg", "front.jpg", "manifest.features"]
    }
  ],
  "recommendedNextAction": "accept|ask_user|revise"
}

Review checklist:
- Overall object identity and proportions.
- Expected major features: holes, slots, ribs, bosses, brackets, shafts, connectors, and visible standard parts.
- Orientation, symmetry, missing/extra parts, obvious intersections, floating parts, and strange scale.
- Manufacturing visual risks such as very thin walls, sharp unsupported spikes, crowded holes, or features too close to edges.
- Mention when a dimension, hole spacing, or clearance needs script measurement instead of visual judgment.
- section.jpg uses temporary transparent enclosure parts so internal components can be inspected.
- exploded.jpg uses temporary display-only part offsets. Never report those offsets as floating parts, bad constraints, or real assembly positions; use it only to check part presence and shape.
- Judge actual interference and assembly position from ordinary views plus structured geometry validation, never from exploded.jpg.

User request:
${userRequest || "No user request was provided."}

  Assembly:
${JSON.stringify({
  id: assembly?.id || null,
  name: assembly?.name || null,
  status: assembly?.status || null,
  parts: assembly?.parts?.map((part) => ({
    id: part.id,
    name: part.name,
    role: part.role,
    features: part.features
  })) || [],
  relations: assembly?.relations || [],
  // The public assembly contract currently exposes the merged report as
  // `validation`; accept `validationReport` too for internal callers so the
  // reviewer always receives BREP/STEP evidence instead of guessing from
  // screenshots.
  geometryValidation: assembly?.validation || assembly?.validationReport || null,
  manifestUrl: assembly?.manifestUrl || null
}, null, 2)}

Structured plan:
${JSON.stringify(plan || null, null, 2)}

Screenshots:
${JSON.stringify(screenshotList, null, 2)}
`;
}

export function normalizeVisualReviewResult(result, context = {}) {
  const input = result && typeof result === "object" ? result : {};
  const status = VALID_STATUSES.has(input.status) ? input.status : "warning";
  const targets = collectReviewTargets(context.plan, context.assembly);
  const findings = Array.isArray(input.findings)
    ? input.findings.map((item, index) => normalizeFinding(item, index, targets)).filter(Boolean)
    : [];
  let recommendedNextAction = VALID_ACTIONS.has(input.recommendedNextAction)
    ? input.recommendedNextAction
    : status === "fail" ? "revise" : status === "warning" ? "ask_user" : "accept";
  if (recommendedNextAction === "revise" && !actionableVisualFindings({ findings }).length) recommendedNextAction = "ask_user";

  return {
    assemblyId: String(context.assemblyId || ""),
    revisionId: String(context.revisionId || ""),
    status,
    summary: String(input.summary || "").trim() || "Unable to produce a confident visual review summary.",
    findings,
    recommendedNextAction,
    screenshots: normalizeScreenshots(context.screenshots),
    reviewedAt: context.reviewedAt || new Date().toISOString()
  };
}

export function visualReviewImprovementEligibility(review, currentRevision) {
  if (!review || typeof review !== "object") return { ok: false, code: "REVIEW_MISSING", message: "请先运行视觉审查" };
  if (!currentRevision) return { ok: false, code: "REVISION_MISSING", message: "当前模型没有可编辑修订版本" };
  if (!review.revisionId) return { ok: false, code: "REVIEW_REVISION_MISSING", message: "该审查未绑定修订版本，请重新运行视觉审查" };
  if (String(review.revisionId) !== String(currentRevision)) return { ok: false, code: "REVIEW_STALE", message: "模型已发生变化，请重新运行视觉审查后再改进" };
  if (review.improvement?.status === "applied") return { ok: false, code: "REVIEW_ALREADY_APPLIED", message: "该审查反馈已经生成改进版本，请重新审查新版本" };
  if (review.status === "pass" || !Array.isArray(review.findings) || !review.findings.length) {
    return { ok: false, code: "NO_ACTIONABLE_FINDINGS", message: "视觉审查没有需要自动改进的问题" };
  }
  if (!actionableVisualFindings(review).length) return { ok: false, code: "FINDINGS_NEED_CONFIRMATION", message: "审查问题缺少可靠目标或参数，请先完成测量或用户确认" };
  return { ok: true, code: "READY", message: "可以根据视觉审查反馈生成改进版本" };
}

export function actionableVisualFindings(review) {
  return (review?.findings || []).filter((finding) => (
    finding?.actionability === "auto"
    && finding?.confidence !== "low"
    && finding?.partId
    && finding?.proposedChange?.op
    && finding?.verification?.method
    && finding?.verification?.expected
  ));
}

export function buildVisualReviewImprovementMessage({ review, userRequest = "", currentRevision = "", selectedFindingIds = null } = {}) {
  const selected = Array.isArray(selectedFindingIds) && selectedFindingIds.length
    ? new Set(selectedFindingIds.map((id) => String(id)))
    : null;
  const findings = actionableVisualFindings(review)
    .filter((finding) => !selected || selected.has(String(finding.findingId)))
    .map((finding, index) => ({
    index: index + 1,
    findingId: finding.findingId,
    severity: finding.severity,
    category: finding.category,
    message: finding.message,
    partId: finding.partId,
    featureId: finding.featureId,
    confidence: finding.confidence,
    proposedChange: finding.proposedChange,
    verification: finding.verification,
    evidence: finding.evidence || []
    }));
  return `根据视觉审查反馈生成最小范围参数化编辑补丁。

必须返回 edit_patch，不得返回完整计划。只修改能够由当前参数化计划和明确视觉证据可靠定位的问题。
- 保留无关零件、特征 ID、零件数量、功能孔径、孔中心和约束语义。
- 视觉截图不是精确测量证据；涉及尺寸、间隙或强度但没有结构化数据支撑时，不得猜测数值。
- 对 uncertain 或需要用户确认的问题返回 ambiguous，不要擅自修改。
- 优先修复缺失特征、明显方向错误、错位、漂浮、穿插和比例异常。
- 只处理下方 actionability=auto 的结构化问题，补丁目标和路径必须与 findingId 对应，不得扩大修改范围。
- 如果用户只选择了部分问题，只处理下方列出的 findingId；未列出的问题必须保持不变并留待后续修复。
- reply 必须逐项说明 findingId 对应哪条 operation，以及修改后如何验证。
- baseRevision 必须是 ${currentRevision || review?.revisionId || "当前修订"}。

用户原始要求：
${userRequest || "未提供"}

视觉审查摘要：
${review?.summary || "无"}

视觉审查问题：
${JSON.stringify(findings, null, 2)}`;
}

export function buildVisualReviewReportRepairMessage({ review, userRequest = "", currentRevision = "" } = {}) {
  return `根据视觉审查报告直接修复当前装配，并返回可执行的参数化 CAD 修改结果。

修复规则：
- 原始用户需求优先；视觉审查是问题清单，不得把截图猜测当成精确尺寸。
- 对缺失的结构、零件或装配约束，可以根据原始需求和当前计划补齐；涉及孔径、孔距、间隙、承载、强度或传动比时，必须保留现有尺寸意图，使用 BREP/STEP 验证，不能凭截图猜数值。
- 优先返回 edit_patch；只有新增零件或结构无法由局部补丁表达时才返回完整计划。
- 保留未涉及的零件、功能孔径、孔中心、约束语义和稳定 ID。
- 修改后必须通过 BREP 几何验证、装配约束检查和 STEP round-trip；不能通过时返回明确的验证错误，不要伪造通过。
- 当前有效修订：${currentRevision || "unknown"}

原始用户需求：
${userRequest || "未提供"}

视觉审查报告：
${JSON.stringify(review || {}, null, 2)}`;
}

export function buildVisualImprovementValidationRepairMessage({ review, userRequest = "", currentRevision = "", failedPatch = null, validationReport = null, attempt = 1, selectedFindingIds = null } = {}) {
  return `第 ${attempt} 个视觉改进候选未通过构建或几何验证。请基于当前有效修订重新生成一个替代 edit_patch，不要继续编辑失败候选。

必须返回 edit_patch，baseRevision 必须是 ${currentRevision || review?.revisionId || "当前有效修订"}。
- 继续解决原视觉审查问题，但必须先消除下面的构建和验证错误。
- 不要重复失败补丁中的无效操作。
- 若错误包含 dependent features，不得再次直接删除父特征。优先用 set_param 修改父特征；确需删除时，必须按依赖关系逆序先删除所有子特征，最后删除父特征。尺寸标注等仍需保留时，应改写其依赖而不是删除功能几何。
- set_part_pose 必须使用 { op, partId, pose: { translate: [...], rotate: [...] } }；不得把 translate/rotate 平铺到 operation，也不得放入 value。
- 每个生成零件必须保留且仅保留一个启用的 base_* 基础特征；其他启用的几何特征必须位于有效基础几何之后。
- 不得禁用唯一的基础特征后仅新增 add_primitive；若要替换基础几何，应修改现有 base_* 参数。
- add_primitive 一次只生成一个实体，不支持 primitive.positions；重复零件必须使用带 sourceFeatureId 的 linear_pattern 或 circular_pattern，不能依赖会被忽略的批量 positions 字段。
- 保留无关零件、稳定特征 ID、功能孔径、孔中心、约束语义和零件数量。
- 只允许修复用户选中的 findingId；其他审查问题不得顺带修改。

用户选中的 findingId：
${JSON.stringify(Array.isArray(selectedFindingIds) ? selectedFindingIds : [], null, 2)}

用户原始要求：
${userRequest || "未提供"}

原视觉审查摘要：
${review?.summary || "无"}

失败补丁：
${JSON.stringify(failedPatch || null, null, 2)}

本次需要处理的验证错误：
${JSON.stringify(actionableValidationIssues(validationReport), null, 2)}`;
}

export function actionableValidationIssues(report) {
  const issues = Array.isArray(report?.issues) ? report.issues : [];
  const rootFailures = issues.filter((issue) => ["BUILD_EXECUTION_FAILED", "FINISH_FEATURE_FAILED"].includes(issue.code));
  const selected = rootFailures.length
    ? [...rootFailures, ...issues.filter((issue) => !String(issue.code || "").startsWith("MISSING_"))]
    : issues;
  const seen = new Set();
  return selected.filter((issue) => {
    const key = JSON.stringify([issue.code, issue.partId || null, issue.featureId || null, issue.parts || null]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function normalizeFinding(item, index, targets = null) {
  if (!item || typeof item !== "object") return null;
  const message = String(item.message || "").trim();
  if (!message) return null;
  const requestedPartId = item.partId ? String(item.partId).trim().slice(0, 160) : null;
  const partId = requestedPartId && (!targets?.partIds.size || targets.partIds.has(requestedPartId)) ? requestedPartId : null;
  const requestedFeatureId = item.featureId ? String(item.featureId).trim().slice(0, 200) : null;
  const featureId = requestedFeatureId && partId && (!targets?.featureIdsByPart.get(partId)?.size || targets.featureIdsByPart.get(partId).has(requestedFeatureId))
    ? requestedFeatureId
    : null;
  let actionability = VALID_ACTIONABILITY.has(item.actionability) ? item.actionability : "needs_user";
  const confidence = VALID_CONFIDENCE.has(item.confidence) ? item.confidence : "low";
  const proposedChange = normalizeProposedChange(item.proposedChange);
  const verification = normalizeVerification(item.verification);
  if (actionability === "auto" && (!partId || !proposedChange || confidence === "low" || !verification?.method || !verification?.expected)) {
    actionability = requestedPartId && !partId ? "needs_user" : "needs_measurement";
  }
  return {
    findingId: String(item.findingId || `F${String(index + 1).padStart(2, "0")}`).trim().slice(0, 40),
    severity: VALID_SEVERITIES.has(item.severity) ? item.severity : "warning",
    category: String(item.category || "visual").trim() || "visual",
    message,
    partId,
    featureId,
    confidence,
    actionability,
    proposedChange,
    verification,
    evidence: Array.isArray(item.evidence)
      ? item.evidence.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 8)
      : []
  };
}

function collectReviewTargets(plan, assembly) {
  const partIds = new Set();
  const featureIdsByPart = new Map();
  for (const part of [...(plan?.parts || []), ...(assembly?.parts || [])]) {
    if (!part?.id) continue;
    partIds.add(String(part.id));
    const featureIds = featureIdsByPart.get(String(part.id)) || new Set();
    for (const feature of [...(part.features || []), ...(part.featureTree || [])]) {
      if (feature?.id) featureIds.add(String(feature.id));
    }
    featureIdsByPart.set(String(part.id), featureIds);
  }
  return { partIds, featureIdsByPart };
}

function normalizeProposedChange(change) {
  if (!change || typeof change !== "object" || !VALID_EDIT_OPERATIONS.has(change.op)) return null;
  return {
    op: change.op,
    path: change.path ? String(change.path).trim().slice(0, 200) : null,
    value: change.value === undefined ? null : structuredClone(change.value),
    reason: String(change.reason || "").trim().slice(0, 800)
  };
}

function normalizeVerification(verification) {
  if (!verification || typeof verification !== "object") return null;
  const method = String(verification.method || "").trim();
  const expected = String(verification.expected || "").trim();
  if (!method && !expected) return null;
  return { method: method.slice(0, 300), expected: expected.slice(0, 600) };
}

function normalizeScreenshots(screenshots = []) {
  if (!Array.isArray(screenshots)) return [];
  return screenshots.map((item) => ({
    view: String(item.view || "").trim(),
    name: String(item.name || "").trim(),
    url: item.url ? String(item.url) : null
  })).filter((item) => item.view && item.name);
}
