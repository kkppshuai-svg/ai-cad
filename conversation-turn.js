import { compactValidationForRepair, classifyValidationIssues, scoreRepairCandidate, validateRepairInvariants } from "./cad-validation.js";
import { isEditPatchResponse } from "./parametric-api.js";
import { applyEditPatch } from "./parametric-edit.js";
import { stabilizeMechanicalPlan } from "./planner-profile-repair.js";
import { boundedInt, sanitizeText } from "./text-utils.js";

const AI_REPAIR_INSTRUCTION = "根据刚才的验证错误生成最小范围修复补丁；不得静默改变功能孔径、孔中心、零件数量或约束语义。";

/**
 * Phrases that mean "throw the current model away and start fresh" rather than
 * "adjust what we have".  Anything matching here plans from an empty slate, so
 * a new request cannot inherit the previous part's features.
 */
const RESET_KEYWORDS = [
  "不是这样",
  "不像",
  "不对",
  "重做",
  "重新做",
  "重新生成",
  "推倒",
  "乱",
  "烂",
  "wrong",
  "redo",
  "start over",
  "做一个",
  "设计一个",
  "生成一个",
  "创建一个",
  "建模一个",
  "我要一个",
  "make a",
  "create a",
  "design a",
  "generate a"
];

export function shouldResetPlanForMessage(message) {
  const text = String(message || "").toLowerCase();
  const explicitReset = RESET_KEYWORDS.some((keyword) => text.includes(keyword));
  const newDesign = /^(?:请|帮我|我想)?\s*(?:做|设计|生成|创建|建模|制作|我要)\s*(?:一个|一套|一种|新的|新)/i.test(text)
    || /^(?:please\s+)?(?:make|create|design|generate)\s+(?:a|an|new)\b/i.test(text);
  return explicitReset || newDesign;
}

export function normalizeWebSearchOptions(value, { defaultMaxResults = 5 } = {}) {
  if (value === true) return { enabled: true, query: "", maxResults: defaultMaxResults };
  if (!value || typeof value !== "object") return { enabled: false, query: "", maxResults: defaultMaxResults };
  return {
    enabled: Boolean(value.enabled),
    query: String(value.query || "").trim(),
    maxResults: boundedInt(value.maxResults, defaultMaxResults, 1, 8)
  };
}

/**
 * Clamp an incoming FBS (function / behaviour / structure) context to the
 * shape and size the planner prompt expects.  The UI round-trips this object,
 * so it is untrusted input.
 */
export function sanitizeFbsContext(value = {}) {
  const list = (items) => Array.isArray(items) ? items.map((item, index) => {
    if (typeof item === "string") return sanitizeText(item, 500);
    if (!item || typeof item !== "object") return "";
    return {
      id: sanitizeText(item.id || `candidate-${index + 1}`, 100),
      label: sanitizeText(item.label, 500),
      rationale: sanitizeText(item.rationale, 1000),
      specifications: Array.isArray(item.specifications) ? item.specifications.map((spec) => sanitizeText(spec, 500)).filter(Boolean).slice(0, 12) : [],
      upstreamIds: Array.isArray(item.upstreamIds) ? item.upstreamIds.map((id) => sanitizeText(id, 100)).filter(Boolean).slice(0, 12) : []
    };
  }).filter((item) => typeof item === "string" ? item : item.label).slice(0, 20) : [];
  const acceptanceChecks = (Array.isArray(value.acceptanceChecks) ? value.acceptanceChecks : []).map((check, index) => ({
    id: sanitizeText(check?.id || `ac-${index + 1}`, 80),
    statement: sanitizeText(check?.statement || check?.label, 500),
    measurementId: sanitizeText(check?.measurementId, 120) || null,
    tolerance: Number.isFinite(Number(check?.tolerance)) ? Number(check.tolerance) : null,
    sourceIds: Array.isArray(check?.sourceIds) ? check.sourceIds.map((id) => sanitizeText(id, 80)).filter(Boolean).slice(0, 8) : []
  })).filter((check) => check.statement).slice(0, 16);
  return {
    requirements: sanitizeText(value.requirements, 2000),
    functions: list(value.functions),
    behaviors: list(value.behaviors),
    structures: list(value.structures),
    acceptanceChecks,
    criteria: sanitizeText(value.criteria, 2000),
    selectedFunction: Number.isInteger(value.selectedFunction) ? value.selectedFunction : null,
    selectedBehavior: Number.isInteger(value.selectedBehavior) ? value.selectedBehavior : null,
    selectedStructure: Number.isInteger(value.selectedStructure) ? value.selectedStructure : null
  };
}

/**
 * Apply a scoped edit patch to the current revision.  If the revision fails
 * validation in a way deterministic repair cannot reach (`aiRepairRequired`),
 * ask the planner once for a minimal fix and apply that instead.
 *
 * `deps`: editRevision, generatePlan, applyBuildSummary, queueLatentLearning.
 */
export async function runConversationEditTurn({ conversation, currentJob, planned, cadReferenceContext, deps }) {
  const { editRevision, generatePlan, applyBuildSummary = () => {}, queueLatentLearning = () => {} } = deps;
  if (!currentJob) throw new Error("Local edit requires an existing assembly revision");

  let revision = await editRevision({ job: currentJob, patch: planned.editPatch });

  if (revision.status !== "current" && revision.aiRepairRequired) {
    const repairPlan = await generatePlan({
      conversation: {
        ...conversation,
        plan: currentJob.plan,
        currentRevision: currentJob.currentRevision,
        validationReport: revision.validationReport
      },
      message: AI_REPAIR_INSTRUCTION,
      cadReferenceContext
    });
    if (isEditPatchResponse(repairPlan)) {
      const aiRevision = await editRevision({ job: currentJob, patch: repairPlan.editPatch });
      revision = { ...aiRevision, aiRepairAttempted: true, initialFailure: revision };
    } else {
      revision.aiRepairAttempted = true;
      revision.aiRepairError = "Planner did not return a scoped edit patch";
    }
  }

  if (revision.status === "current" && revision.buildSummary) {
    applyBuildSummary(currentJob, revision.buildSummary);
    void queueLatentLearning(currentJob, "conversation-edit");
  }
  return revision;
}

/**
 * Build the repair/fallback/progress callbacks that
 * runAssemblyValidationRepairLoop() drives after a failed build.
 *
 * `repair` asks the planner for a fix, applies it, and rejects any candidate
 * that would silently change protected functional dimensions or assembly
 * semantics — returning null so the loop falls through to `repairFallback`.
 */
export function createRepairPlanner({ conversation, cadReferenceContext, generatePlan, publish = () => {}, persistPlan, maximumRepairs = 6, maximumBatchSize = 4 }) {
  async function repair({ plan: failedPlan, validationReport, attempt }) {
    const compactReport = compactValidationForRepair(validationReport, { maximumBatchSize });
    const issueClasses = classifyValidationIssues(compactReport);
    publish("assembly:repair", {
      status: "planning",
      attempt: attempt + 1,
      maximumRepairs,
      summary: validationReport.summary || null,
      issueClasses,
      repairQueue: compactReport.repairQueue,
      message: `第 ${attempt + 1} 轮：修复 ${compactReport.repairQueue.active.length} 个根因，剩余 ${compactReport.repairQueue.deferred.length} 个排队`
    });

    const repairedPlan = await generatePlan({
      conversation: { ...conversation, plan: failedPlan, validationReport: compactReport },
      message: `根据第 ${attempt + 1} 次构建的修复队列，仅修复 validationReport.issues 中当前批次的根因。优先返回最小 editPatch；只有局部补丁无法表达时才返回完整计划。不要处理 deferred 问题，它们会在重建后重新评估。遇到 PART_INTERFERENCE 时使用报告中的世界坐标 partBounds 和 overlapBounds 计算最小安全间隙。保持用户功能意图，不得静默修改功能孔径、孔中心、约束语义或零件数量。`,
      cadReferenceContext
    });
    if (repairedPlan.mode === "ambiguous") return null;

    let candidatePlan = repairedPlan;
    if (isEditPatchResponse(repairedPlan)) {
      const patch = structuredClone(repairedPlan.editPatch);
      const baseRevision = patch.baseRevision || validationReport.revisionId || `repair-${attempt + 1}`;
      patch.baseRevision = baseRevision;
      try {
        candidatePlan = applyEditPatch(failedPlan, patch, { revisionId: baseRevision }).plan;
      } catch (error) {
        publish("assembly:repair", { status: "rejected", attempt: attempt + 1, message: `局部修复补丁无效：${error.message || error}` });
        return null;
      }
    }

    const guard = validateRepairInvariants(failedPlan, candidatePlan);
    const score = scoreRepairCandidate(failedPlan, candidatePlan, validationReport);
    if (!guard.ok) {
      publish("assembly:repair", { status: "rejected", attempt: attempt + 1, score, message: "修复候选修改了受保护的功能尺寸或装配语义，已拒绝" });
      return null;
    }
    candidatePlan.repairDecision = { attempt: attempt + 1, score, issueClasses, source: isEditPatchResponse(repairedPlan) ? "edit-patch" : "full-plan" };
    return candidatePlan;
  }

  // Last resort when the planner cannot produce an acceptable patch: apply the
  // deterministic mechanical stabilizer, still subject to the same guard.
  async function repairFallback({ plan: failedPlan, validationReport }) {
    const stabilized = stabilizeMechanicalPlan(structuredClone(failedPlan));
    const guard = validateRepairInvariants(failedPlan, stabilized);
    if (!guard.ok) return null;
    const score = scoreRepairCandidate(failedPlan, stabilized, validationReport);
    return { ...stabilized, repairDecision: { source: "safe-fallback", score } };
  }

  async function onRepair({ plan: repairedPlan, validationReport }) {
    publish("assembly:repair", { status: "rebuilding", summary: validationReport.summary || null, message: "修复计划已生成，正在重新构建并验证 BREP" });
    conversation.plan = repairedPlan;
    conversation.validationReport = validationReport;
    if (typeof persistPlan === "function") await persistPlan(conversation, repairedPlan);
  }

  return { repair, repairFallback, onRepair };
}
