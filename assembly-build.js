import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeAssemblyConstraints } from "./assembly-constraints.js";
import { composeAssemblyValidationReport } from "./assembly-validation-report.js";
import { canPromoteRevision, proposeDeterministicRepairs } from "./cad-validation.js";
import { applyEditPatch } from "./parametric-edit.js";
import { collectRevisionArtifactPaths } from "./parametric-api.js";
import { normalizeParametricPlan } from "./parametric-plan.js";
import { stabilizeMechanicalPlan } from "./planner-profile-repair.js";
import { createCandidateRevision, markRevisionFailed, promoteRevision, writeRevisionState } from "./revision-store.js";

// How many times a build may repair itself with deterministic (non-AI) patches
// before it gives up and reports the blocking errors to the caller.
export const MAX_DETERMINISTIC_REPAIR_ATTEMPTS = 2;

/**
 * One-line summary of why a revision could not be promoted, listing the first
 * few blocking error codes with the parts they belong to.
 */
export function describeBlockingValidationError(validationReport) {
  const details = (validationReport.issues || [])
    .filter((issue) => issue.severity === "error")
    .slice(0, 6)
    .map((issue) => `${issue.code}${Array.isArray(issue.parts) ? `(${issue.parts.join(" + ")})` : issue.partId ? `(${issue.partId})` : ""}`)
    .join(", ");
  return `Assembly validation blocked revision with ${validationReport.blockingErrorCount} error(s)${details ? `: ${details}` : ""}`;
}

/** The CadQuery builder manifest derived from a normalized parametric plan. */
export function buildCadQueryManifest(plan, outputDir) {
  return {
    name: plan.name || "AI_CAD_Assembly",
    outputDir,
    relations: plan.relations || [],
    joints: plan.joints || [],
    constraints: plan.constraints || [],
    intendedContacts: plan.intendedContacts || [],
    parts: plan.parts
  };
}

/**
 * Build one assembly: normalize the plan, run CadQuery, validate the result,
 * and either promote the candidate revision or fail with enough context for
 * the caller's repair loop to act on.
 *
 * Side effects arrive through `deps` so the whole flow can be exercised
 * without a CadQuery runtime:
 *   assemblyDir, newAssemblyId, hydrateStandardParts, runCadQueryBuild,
 *   applyBuildSummaryToJob, buildKinematicPackage, ensureAssemblyFcstd,
 *   revisionDeliveryState, registerJob, publish, publicAssembly,
 *   queueLatentLearning
 *
 * On failure the thrown error carries `validationReport`, `failedPlan`, and —
 * when partial geometry exists — `previewAssembly`, which is what
 * runAssemblyValidationRepairLoop() consumes.
 */
export async function buildValidatedAssembly({ plan, repairContext = {}, deps }) {
  const {
    assemblyDir,
    newAssemblyId,
    hydrateStandardParts,
    runCadQueryBuild,
    applyBuildSummaryToJob,
    buildKinematicPackage,
    ensureAssemblyFcstd,
    revisionDeliveryState,
    registerJob = () => {},
    publish = () => {},
    publicAssembly = (job) => job,
    queueLatentLearning = () => {}
  } = deps;

  const normalizedPlan = normalizeParametricPlan(stabilizeMechanicalPlan(structuredClone(plan)));
  const id = newAssemblyId(normalizedPlan);
  const outDir = path.join(assemblyDir, id);
  await mkdir(outDir, { recursive: true });

  const job = {
    id,
    status: "building",
    createdAt: new Date().toISOString(),
    outputDir: outDir,
    plan: normalizedPlan,
    parts: [],
    repairAudit: structuredClone(repairContext.repairAudit || [])
  };
  registerJob(job);
  publish("assembly:progress", publicAssembly(job));
  let candidate = null;

  try {
    await hydrateStandardParts(normalizedPlan);
    candidate = await createCandidateRevision(assemblyDir, id, normalizedPlan, { summary: "Initial generated assembly" });
    job.pendingRevision = candidate.id;

    const manifestPath = path.join(outDir, "assembly-manifest.json");
    await writeFile(manifestPath, JSON.stringify(buildCadQueryManifest(normalizedPlan, outDir), null, 2), "utf8");
    const buildSummary = await runCadQueryBuild({ manifestPath, outDir, plan: normalizedPlan });
    applyBuildSummaryToJob(job, buildSummary);

    const constraintReport = analyzeAssemblyConstraints(normalizedPlan);
    const validationReport = composeAssemblyValidationReport({
      plan: normalizedPlan,
      buildSummary,
      constraintReport,
      assemblyId: id,
      revisionId: candidate.id
    });
    job.validationReport = validationReport;
    job.constraintReport = constraintReport;

    if (!canPromoteRevision(validationReport)) {
      const repairs = proposeDeterministicRepairs(validationReport, normalizedPlan);
      const attempt = Number(repairContext.attempt || 0);
      if (attempt < MAX_DETERMINISTIC_REPAIR_ATTEMPTS && (repairs.patch.operations.length || repairs.actions.length)) {
        await markRevisionFailed(assemblyDir, id, candidate.id, { code: "AUTO_REPAIR_SUPERSEDED", validationReport, repairAudit: repairs.audit });
        let repairedPlan = normalizedPlan;
        if (repairs.patch.operations.length) {
          repairedPlan = applyEditPatch(normalizedPlan, { baseRevision: candidate.id, operations: repairs.patch.operations }, { revisionId: candidate.id }).plan;
        }
        if (repairs.actions.length) {
          repairedPlan = { ...repairedPlan, repairActions: [...(repairedPlan.repairActions || []), ...repairs.actions] };
        }
        return buildValidatedAssembly({
          plan: repairedPlan,
          repairContext: { attempt: attempt + 1, repairAudit: [...job.repairAudit, ...repairs.audit] },
          deps
        });
      }
      const error = new Error(describeBlockingValidationError(validationReport));
      error.requiresAi = repairs.requiresAi;
      throw error;
    }

    await writeFile(path.join(outDir, "revisions", candidate.id, "build-summary.json"), JSON.stringify(buildSummary, null, 2), "utf8");
    job.manifestPath = manifestPath;
    job.engine = buildSummary.engine || "cadquery";
    job.fcstdPath = buildSummary.fcstdPath;
    job.stepPath = buildSummary.stepPath;
    job.stlPath = buildSummary.stlPath;
    job.glbPath = buildSummary.glbPath;
    job.glbWarning = buildSummary.glbWarning || null;
    job.kinematics = await buildKinematicPackage(job);
    job.kinematicsPath = job.kinematics.kinematicsPath;
    job.constraintManifestPath = job.kinematics.constraintsPath;
    job.kinematicPackagePath = job.kinematics.packagePath;
    job.kinematicArchivePath = job.kinematics.archivePath;
    await ensureAssemblyFcstd(job);
    await writeRevisionState(assemblyDir, id, candidate.id, {
      plan: normalizedPlan,
      validationReport,
      constraintReport,
      buildSummary,
      parts: job.parts,
      repairAudit: job.repairAudit,
      delivery: revisionDeliveryState(job),
      artifacts: collectRevisionArtifactPaths(buildSummary, revisionDeliveryState(job))
    });
    await promoteRevision(assemblyDir, id, candidate.id, validationReport);
    job.currentRevision = candidate.id;
    delete job.pendingRevision;
    job.status = "done";
    job.completedAt = new Date().toISOString();
    publish("assembly:done", publicAssembly(job));
    void queueLatentLearning(job, "validated-build");
    return job;
  } catch (error) {
    if (candidate) {
      try {
        await markRevisionFailed(assemblyDir, id, candidate.id, { code: "BUILD_FAILED", message: error.message || String(error), validationReport: job.validationReport || null });
      } catch {
        // Preserve original build error.
      }
    }
    job.status = "error";
    job.error = error.message || String(error);
    job.completedAt = new Date().toISOString();
    // Partial geometry is still worth showing the user, so hand it back as a
    // preview instead of discarding the whole attempt.
    if (job.stepPath || job.stlPath || job.glbPath) {
      job.status = "validation_failed";
      error.previewAssembly = job;
    }
    publish("assembly:error", publicAssembly(job));
    error.validationReport = job.validationReport || null;
    error.failedPlan = normalizedPlan;
    throw error;
  }
}
