import { createHash } from "node:crypto";
import { applyEditPatch } from "./parametric-edit.js";
import { proposeDeterministicRepairs } from "./cad-validation.js";
import { actionableVisualFindings } from "./visual-review.js";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const supportedNative = new Set(["base_box", "base_cylinder", "base_sphere", "base_spur_gear", "hole", "cut_box", "add_primitive", "dimension"]);

export function unifiedFindings(job, report) {
  const findings = (report.issues || []).map((issue, i) => {
    const repairs = proposeDeterministicRepairs({ issues: [issue] }, job.plan);
    return { id: `brep-${i}-${hash(issue).slice(0,10)}`, source: "brep", severity: issue.severity,
      message: issue.message || issue.code, partId: issue.partId || null, featureId: issue.featureId || null,
      code: issue.code, operations: repairs.patch.operations, actionable: repairs.patch.operations.length > 0 };
  });
  if (job.visualReview?.revisionId === job.currentRevision) {
    for (const finding of actionableVisualFindings(job.visualReview)) {
      const part = job.plan.parts.find(p => p.id === finding.partId);
      if (!part) continue;
      const change = finding.proposedChange;
      let operation = { ...structuredClone(change), partId: finding.partId, featureId: finding.featureId };
      if (change.op === "set_part_pose") {
        const pose = { translate: [0,0,0], rotate: [0,0,0], ...structuredClone(part.pose || {}) };
        if (change.path === "pose.rotate" || change.path === "pose.translate") pose[change.path.split('.')[1]] = change.value;
        else if (change.value?.translate && change.value?.rotate) Object.assign(pose, change.value);
        else operation = null;
        if (operation) operation.pose = pose;
      } else if (change.op === "add_feature") {
        if (!change.value?.id || !change.value?.type) operation = null;
        else operation.feature = change.value;
      } else if (change.op !== "set_param") operation = null;
      if (operation && change.op === "set_param" && (change.value === null || !finding.featureId || !change.path)) operation = null;
      // Numeric dimensions inferred only from pictures require measurement, not guessed edits.
      if (operation?.op === "set_param" && !/brep|kernel|native|measurement|测量|内核/i.test(finding.verification.method)) operation = null;
      findings.push({ id: `visual-${finding.findingId}`, source: "visual", severity: finding.severity,
        message: finding.message, partId: finding.partId, featureId: finding.featureId || null,
        operations: operation ? [operation] : [], actionable: Boolean(operation), verification: finding.verification });
    }
  }
  return findings;
}

export function createReviewProposal(job, report, findingIds) {
  if (!report.review?.cache?.evidenceHash || report.reviewRevisionId !== job.currentRevision) {
    throw Object.assign(new Error("当前联合报告缺少修订绑定，请先重新审查"), { status: 409 });
  }
  if (report.issues?.some(i => i.stage === "integrity" && i.severity === "error")) {
    throw Object.assign(new Error("模型文件或参数证据已变化，请重建"), { status: 409 });
  }
  const findings = unifiedFindings(job, report);
  const selected = findingIds === undefined ? findings.filter(f => f.actionable) : findings.filter(f => findingIds.includes(f.id));
  if (findingIds && (new Set(findingIds).size !== selected.length || selected.some(f => !f.actionable))) {
    throw Object.assign(new Error("所选问题已变化或需要测量，不能自动修改"), { status: 422 });
  }
  const operations = [];
  const targets = new Map();
  for (const finding of selected) for (const operation of finding.operations) {
    const key = JSON.stringify([operation.partId, operation.featureId, operation.op, operation.path || null]);
    const previous = targets.get(key);
    if (previous && hash(previous) !== hash(operation)) throw Object.assign(new Error("审查建议相互冲突，请分别选择后修改"), { status: 422 });
    if (!previous) { targets.set(key,operation); operations.push(operation); }
  }
  const patch = { baseRevision: job.currentRevision, operations };
  if (operations.length) validateNativeReviewPatch(job, patch);
  const proposal = { revisionId: job.currentRevision, evidenceHash: report.review.cache.evidenceHash,
    findingIds: selected.map(f => f.id), patch, findings, blockedFindings: findings.filter(f => !f.actionable),
    status: operations.length ? "ready" : "measurement_required", engine: "nvidia-usd-brep" };
  proposal.id = hash(proposal);
  return proposal;
}

export function validateNativeReviewPatch(job, patch) {
  if (!patch?.baseRevision || patch.baseRevision !== job.currentRevision) throw Object.assign(new Error("修改补丁的基础修订已过期"), { status: 409 });
  if (patch.operations.some(op => !["set_param", "set_part_pose", "add_feature"].includes(op.op))) {
    throw Object.assign(new Error("审查自动修改不能移除特征、关闭特征或降低验收目标"), { status: 422 });
  }
  const edit = applyEditPatch(job.plan, patch, { revisionId: job.currentRevision });
  if (edit.plan.parts.some(p => p.featureTree.some(f => f.enabled !== false && !supportedNative.has(f.type)))) {
    throw Object.assign(new Error("建议包含 NVIDIA 原生适配器不支持的特征"), { status: 422 });
  }
  return edit;
}

export function assertProposalPatch(proposal, suppliedPatch) {
  if (suppliedPatch && hash(suppliedPatch) !== hash(proposal.patch)) {
    throw Object.assign(new Error("补丁与审查建议不一致，请重新生成建议"), { status: 409 });
  }
}

export function createInstructionProposal(job, report, patch, instructions, findingIds) {
  const base = createReviewProposal(job, report, []);
  validateNativeReviewPatch(job, patch);
  if (findingIds?.length) {
    const selected = base.findings.filter(f => findingIds.includes(f.id));
    if (selected.length !== new Set(findingIds).size) throw Object.assign(new Error("所选问题已过期"), { status: 409 });
    const scoped = selected.filter(f => f.partId);
    if (scoped.length && patch.operations.some(op => !scoped.some(f => f.partId === op.partId && (!f.featureId || f.featureId === op.featureId)))) {
      throw Object.assign(new Error("补丁扩大到了未选择的零件或特征"), { status: 422 });
    }
  }
  const proposal = { ...base, patch, instructions, findingIds: findingIds || [], status: "ready", authorization: "user-instruction" };
  proposal.id = hash(proposal);
  return proposal;
}

export async function planReviewProposal({ job, report, instructions, findingIds, generate }) {
  const revision = job.currentRevision;
  const attempts = [];
  for (let index=0; index<3; index++) {
    const candidate = await generate({ attempt:index+1, feedback:attempts });
    if (job.currentRevision !== revision) throw Object.assign(new Error("建议生成期间模型已变化"), { status:409 });
    if (candidate.error) throw Object.assign(new Error(String(candidate.error)), { status:422 });
    try {
      const proposal = createInstructionProposal(job, report, candidate.editPatch, instructions, findingIds);
      return { ...proposal, planningAttempts:[...attempts,{attempt:index+1,status:"valid"}] };
    } catch (error) {
      if (error.status === 409) throw error;
      attempts.push({attempt:index+1,status:"rejected",error:error.message,patch:candidate.editPatch || null});
    }
  }
  throw Object.assign(new Error("原生补丁经过三次校验仍不可执行，未修改模型"), { status:422, attempts });
}
