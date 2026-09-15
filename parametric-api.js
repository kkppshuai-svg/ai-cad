import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { analyzeAssemblyConstraints } from "./assembly-constraints.js";
import { assessManufacturability, canPromoteRevision, mergeValidationReports, proposeDeterministicRepairs, validateBuildEvidence } from "./cad-validation.js";
import { applyEditPatch } from "./parametric-edit.js";
import { checksumParametricPart } from "./parametric-plan.js";
import { createCandidateRevision, markRevisionFailed, promoteRevision, writeRevisionState } from "./revision-store.js";

const assemblyWriteLocks = new Map();
export const CADQUERY_BUILDER_VERSION = "cadquery-parametric-v9";
export const REVISION_DELIVERY_KEYS = [
  "engine", "fcstdPath", "stepPath", "stlPath", "glbPath", "glbWarning", "featureTracePath", "geometryValidationPath", "manifestPath",
  "kinematics", "kinematicsPath", "constraintManifestPath", "kinematicPackagePath", "kinematicArchivePath", "freeCadBridgeLog", "freeCadBridgeReport",
  "completedAt", "status"
];

export async function editAssemblyRevision({ revisionRoot, job, patch, executeBuild, finalizeBuild }) {
  return withAssemblyRevisionLock(revisionRoot, job?.id || "missing", () => editAssemblyRevisionUnlocked({ revisionRoot, job, patch, executeBuild, finalizeBuild }));
}


async function editAssemblyRevisionUnlocked({ revisionRoot, job, patch, executeBuild, finalizeBuild }) {
  if (!job?.id || !job.plan || !job.currentRevision) throw new Error("Assembly job has no current parametric revision");
  if (typeof executeBuild !== "function") throw new TypeError("executeBuild is required");
  let edit;
  try {
    edit = applyEditPatch(job.plan, patch, { revisionId: job.currentRevision });
  } catch (error) {
    if (/base revision .* does not match current revision/i.test(error.message || "")) {
      return { status: "stale", code: "STALE_REVISION", message: error.message, currentRevision: job.currentRevision };
    }
    const message = error.message || String(error);
    const validationReport = {
      format: "ai-cad-validation-report-v1",
      generatedAt: new Date().toISOString(),
      valid: false,
      blockingErrorCount: 1,
      summary: { errors: 1, warnings: 0, info: 0 },
      issues: [{
        stage: "edit_patch",
        severity: "error",
        code: "EDIT_PATCH_INVALID",
        message,
        ...(dependentFeatureIssue(message))
      }],
      assemblyId: job.id,
      revisionId: job.currentRevision
    };
    return {
      status: "failed",
      code: "EDIT_PATCH_INVALID",
      message,
      validationReport,
      requiresAi: validationReport.issues,
      aiRepairRequired: true,
      currentRevision: job.currentRevision
    };
  }
  let workingPlan = edit.plan;
  let affectedPartIds = [...edit.affectedPartIds];
  let assemblyAffectedPartIds = [...edit.assemblyAffectedPartIds];
  const repairAudit = [];
  let repairActions = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await createCandidateRevision(revisionRoot, job.id, workingPlan, {
      parentRevision: job.currentRevision,
      affectedPartIds: [...new Set([...affectedPartIds, ...assemblyAffectedPartIds])],
      diff: edit.diff,
      summary: editSummary(edit.diff)
    });
    const outputDir = path.join(path.resolve(revisionRoot), job.id, "revisions", candidate.id, "artifacts");
    await mkdir(outputDir, { recursive: true });
    const buildPlan = await withReusableParts(workingPlan, job.parts || [], affectedPartIds);
    if (repairActions.length) buildPlan.repairActions = structuredClone(repairActions);
    let buildSummary;
    let buildError = null;
    try {
      buildSummary = await executeBuild({ plan: buildPlan, outputDir, revisionId: candidate.id, affectedPartIds, repairActions });
    } catch (error) {
      buildError = error;
      buildSummary = { parts: [], geometryValidation: { parts: [], interferences: [] } };
    }
    const geometryValidation = buildSummary.geometryValidation || { parts: [], interferences: [] };
    const constraintReport = analyzeAssemblyConstraints(workingPlan);
    const manufacturingIssues = assessManufacturability(
      workingPlan,
      Object.fromEntries((geometryValidation.parts || []).map((report) => [report.partId, report]))
    );
    const validationReport = mergeValidationReports({
      planIssues: [...validateBuildEvidence(workingPlan, buildSummary), ...(buildError ? [buildFailureIssue(buildError, workingPlan)] : [])],
      geometryReports: geometryValidation.parts || [],
      interferences: geometryValidation.interferences || [],
      constraintReport,
      manufacturingIssues
    });
    validationReport.assemblyId = job.id;
    validationReport.revisionId = candidate.id;
    if (!canPromoteRevision(validationReport)) {
      const repairs = proposeDeterministicRepairs(validationReport, workingPlan);
      const canRetry = attempt < 2 && (repairs.patch.operations.length > 0 || repairs.actions.length > 0);
      if (canRetry) {
        repairAudit.push(...repairs.audit.map((item) => ({ ...item, attempt: attempt + 1, revisionId: candidate.id })));
        await markRevisionFailed(revisionRoot, job.id, candidate.id, {
          code: "AUTO_REPAIR_SUPERSEDED",
          message: "Candidate was superseded by a deterministic repair attempt",
          validationReport,
          repairAudit: repairs.audit
        });
        if (repairs.patch.operations.length) {
          const repaired = applyEditPatch(workingPlan, { baseRevision: candidate.id, operations: repairs.patch.operations }, { revisionId: candidate.id });
          workingPlan = repaired.plan;
          affectedPartIds = [...new Set([...affectedPartIds, ...repaired.affectedPartIds])];
          assemblyAffectedPartIds = [...new Set([...assemblyAffectedPartIds, ...repaired.assemblyAffectedPartIds])];
        }
        if (repairs.actions.length) {
          const existingActions = Array.isArray(workingPlan.repairActions) ? workingPlan.repairActions : [];
          repairActions = deduplicateRepairActions([...existingActions, ...repairs.actions]);
          workingPlan = { ...workingPlan, repairActions: structuredClone(repairActions) };
          const actionPartIds = repairActions.map((action) => action.partId).filter(Boolean);
          affectedPartIds = [...new Set([...affectedPartIds, ...actionPartIds])];
          assemblyAffectedPartIds = [...new Set([...assemblyAffectedPartIds, ...actionPartIds])];
        }
        continue;
      }
      const failed = await markRevisionFailed(revisionRoot, job.id, candidate.id, {
        code: buildError ? "BUILD_FAILED" : "VALIDATION_BLOCKED",
        message: "Candidate revision failed validation",
        validationReport,
        repairAudit
      });
      return { ...failed, validationReport, repairAudit, requiresAi: repairs.requiresAi, aiRepairRequired: repairs.requiresAi.length > 0, currentRevision: job.currentRevision };
    }
    try {
      const finalization = typeof finalizeBuild === "function"
        ? await finalizeBuild({ plan: workingPlan, buildSummary, outputDir, revisionId: candidate.id, validationReport, affectedPartIds })
        : null;
      const mergedParts = mergeBuiltParts(workingPlan, job.parts || [], buildSummary.parts || []);
      if (finalization && typeof finalization === "object") {
        await writeRevisionState(revisionRoot, job.id, candidate.id, {
          plan: workingPlan, validationReport, constraintReport, buildSummary, parts: mergedParts,
          delivery: finalization, repairAudit, artifacts: collectRevisionArtifactPaths(buildSummary, finalization)
        });
      }
      const promoted = await promoteRevision(revisionRoot, job.id, candidate.id, validationReport);
      job.plan = workingPlan;
      job.currentRevision = candidate.id;
      job.validationReport = validationReport;
      job.constraintReport = constraintReport;
      job.repairAudit = structuredClone(repairAudit);
      job.parts = mergedParts;
      if (finalization && typeof finalization === "object") Object.assign(job, finalization);
      job.lastRevisionBuild = { affectedPartIds, reusedPartIds: buildPlan.parts.filter((part) => part.reuseStepPath).map((part) => part.id) };
      return { ...promoted, validationReport, buildSummary, repairAudit, affectedPartIds, geometryAffectedPartIds: affectedPartIds, assemblyAffectedPartIds, reusedPartIds: job.lastRevisionBuild.reusedPartIds };
    } catch (error) {
      const failed = await markRevisionFailed(revisionRoot, job.id, candidate.id, { code: error.code || "FINALIZATION_FAILED", message: error.message || String(error), repairAudit });
      return { ...failed, repairAudit, currentRevision: job.currentRevision };
    }
  }
  throw new Error("Parametric repair loop exhausted unexpectedly");
}

function dependentFeatureIssue(message) {
  const match = String(message || "").match(/^Cannot remove feature ([^;]+); dependent features: (.+)$/i);
  if (!match) return {};
  return {
    featureId: match[1].trim(),
    dependentFeatureIds: match[2].split(",").map((item) => item.trim()).filter(Boolean),
    repairHint: "Prefer changing the parent feature parameters. If removal is required, remove dependent features first in reverse dependency order."
  };
}


export async function withAssemblyRevisionLock(revisionRoot, assemblyId, operation) {
  const key = `${path.resolve(revisionRoot)}\0${assemblyId}`;
  const previous = assemblyWriteLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  assemblyWriteLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (assemblyWriteLocks.get(key) === current) assemblyWriteLocks.delete(key);
  }
}


export function featureTreePayload(job) {
  const traces = new Map((job.parts || []).map((part) => [part.id, new Map((part.featureTrace || []).map((item) => [item.featureId, item]))]));
  return {
    format: "ai-cad-feature-tree-response-v1",
    assemblyId: job.id,
    revisionId: job.currentRevision || null,
    parts: (job.plan?.parts || []).map((part) => ({
      id: part.id,
      name: part.name || part.id,
      featureTree: (part.featureTree || []).map((node) => ({ ...structuredClone(node), ...(traces.get(part.id)?.get(node.id) || { status: "not_built" }) }))
    }))
  };
}


export function validationPayload(job) {
  return {
    format: "ai-cad-validation-response-v1",
    assemblyId: job.id,
    revisionId: job.currentRevision || null,
    ...(structuredClone(job.validationReport || { blockingErrorCount: 0, summary: { errors: 0, warnings: 0, info: 0 }, issues: [] })),
    repairAudit: structuredClone(job.repairAudit || []),
    constraints: structuredClone(job.constraintReport || null)
  };
}


export function restoreJobFromRevisionState(job, revisionId, state) {
  if (!job || !state?.plan || !state.validationReport || !state.constraintReport) throw new Error("Revision state is incomplete");
  job.plan = structuredClone(state.plan);
  job.currentRevision = revisionId;
  job.validationReport = structuredClone(state.validationReport);
  job.constraintReport = structuredClone(state.constraintReport);
  if (job.constraintReport?.format === "ai-cad-constraint-analysis-v1" && Array.isArray(job.plan.joints) && job.plan.joints.length > 0) {
    job.constraintReport = analyzeAssemblyConstraints(job.plan);
    job.validationReport = replaceConstraintIssues(job.validationReport, job.constraintReport);
  }
  job.parts = structuredClone(state.parts || []);
  job.repairAudit = structuredClone(state.repairAudit || []);
  for (const key of REVISION_DELIVERY_KEYS) delete job[key];
  if (state.delivery && typeof state.delivery === "object") Object.assign(job, structuredClone(state.delivery));
  job.status = "done";
  return job;
}


function replaceConstraintIssues(validationReport, constraintReport) {
  const report = structuredClone(validationReport || {});
  const retained = (Array.isArray(report.issues) ? report.issues : []).filter((issue) => issue.stage !== "constraint");
  const current = [
    ...(constraintReport.errors || []).map((issue) => ({ stage: "constraint", severity: "error", code: issue.code || "VALIDATION_ISSUE", ...structuredClone(issue) })),
    ...(constraintReport.warnings || []).map((issue) => ({ stage: "constraint", severity: "warning", code: issue.code || "VALIDATION_ISSUE", ...structuredClone(issue) }))
  ];
  report.issues = [...retained, ...current];
  report.summary = report.issues.reduce((summary, issue) => {
    if (issue.severity === "error") summary.errors += 1;
    else if (issue.severity === "warning") summary.warnings += 1;
    else summary.info += 1;
    return summary;
  }, { errors: 0, warnings: 0, info: 0 });
  report.blockingErrorCount = report.summary.errors;
  report.valid = report.summary.errors === 0;
  return report;
}


export function parseParametricAssemblyRoute(method, pathname) {
  const match = String(pathname || "").match(/^\/api\/assembly\/([A-Za-z0-9._-]+)\/(feature-tree|revisions|validation|edit|revert)$/);
  if (!match) return null;
  const action = match[2];
  const allowed = action === "edit" || action === "revert" ? method === "POST" : method === "GET";
  return allowed ? { assemblyId: match[1], action } : null;
}


export function isEditPatchResponse(value) {
  return Boolean(value && value.mode === "edit_patch" && value.editPatch && typeof value.editPatch === "object" && Array.isArray(value.editPatch.operations));
}


async function withReusableParts(plan, previousParts, affectedPartIds) {
  const affected = new Set(affectedPartIds);
  const previous = new Map(previousParts.map((part) => [part.id, part]));
  const result = structuredClone(plan);
  result.parts = await Promise.all(result.parts.map(async (part) => {
    const cached = previous.get(part.id);
    if (!affected.has(part.id) && await reusableCacheMatches(part, cached, plan.repairActions)) return { ...part, reuseStepPath: cached.localStepPath };
    return part;
  }));
  return result;
}


function mergeBuiltParts(plan, previousParts, builtParts) {
  const previous = new Map(previousParts.map((part) => [part.id, part]));
  const built = new Map(builtParts.map((part) => [part.id, part]));
  return (plan.parts || []).map((part) => {
    const prior = previous.get(part.id) || {};
    const output = built.get(part.id) || {};
    return {
      ...prior,
      ...part,
      ...output,
      parametricChecksum: checksumParametricPart(part),
      buildPolicyChecksum: checksumPartBuildPolicy(part.id, plan.repairActions),
      builderVersion: output.builderVersion || CADQUERY_BUILDER_VERSION,
      localStepChecksum: output.localStepChecksum || (output.localStepPath === prior.localStepPath ? prior.localStepChecksum : null),
      sourceStepChecksum: output.sourceStepChecksum || (part.sourceStepPath === prior.sourceStepPath ? prior.sourceStepChecksum : null)
    };
  });
}


async function reusableCacheMatches(part, cached, repairActions) {
  if (!cached?.localStepPath || cached.builderVersion !== CADQUERY_BUILDER_VERSION) return false;
  if (cached.parametricChecksum !== checksumParametricPart(part) || cached.buildPolicyChecksum !== checksumPartBuildPolicy(part.id, repairActions) || !cached.localStepChecksum) return false;
  try {
    if (await checksumFile(cached.localStepPath) !== cached.localStepChecksum) return false;
    if (part.sourceStepPath) {
      if (!cached.sourceStepChecksum || await checksumFile(part.sourceStepPath) !== cached.sourceStepChecksum) return false;
    }
    return true;
  } catch {
    return false;
  }
}


export function checksumPartBuildPolicy(partId, repairActions = []) {
  const relevant = (Array.isArray(repairActions) ? repairActions : []).filter((action) => !action.partId || action.partId === partId);
  return checksumParametricPart({ id: partId, repairActions: relevant });
}


async function checksumFile(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}


function editSummary(diff) {
  return diff.map((item) => item.featureId || item.constraintId || item.partId).filter(Boolean).join(", ").slice(0, 240);
}


function buildFailureIssue(error, plan) {
  const message = error?.message || String(error);
  const match = message.match(/Feature\s+([A-Za-z0-9._-]+)\s*:/i);
  const featureId = match?.[1] || null;
  const part = (plan.parts || []).find((item) => (item.featureTree || []).some((feature) => feature.id === featureId));
  const feature = part?.featureTree?.find((item) => item.id === featureId);
  if (feature && ["fillet", "chamfer"].includes(feature.type)) {
    return { code: "FINISH_FEATURE_FAILED", severity: "error", partId: part.id, featureId, message };
  }
  return { code: "BUILD_EXECUTION_FAILED", severity: "error", partId: part?.id || null, featureId, message };
}


function deduplicateRepairActions(actions) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = JSON.stringify([action.type, action.partId || null, action.featureId || null]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


export function collectRevisionArtifactPaths(buildSummary, finalization) {
  const fileKeys = new Set(["stepPath", "localStepPath", "stlPath", "localStlPath", "pngPath", "glbPath", "featureTracePath", "geometryValidationPath", "manifestPath", "fcstdPath", "kinematicsPath", "constraintManifestPath", "kinematicArchivePath"]);
  const result = {};
  for (const [key, value] of Object.entries({ ...buildSummary, ...finalization })) if (fileKeys.has(key) && typeof value === "string") result[key] = value;
  result.parts = (buildSummary.parts || []).map((part) => Object.fromEntries(Object.entries(part).filter(([key, value]) => fileKeys.has(key) && typeof value === "string")));
  return result;
}
