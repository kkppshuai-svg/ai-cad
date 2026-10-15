import {
  assessManufacturability,
  buildRepairWorkQueue,
  mergeValidationReports,
  validateBrepReviewCoverage,
  validateBuildEvidence,
  validateFbsAcceptanceCoverage,
  validateStepRoundTrip
} from "./cad-validation.js";
import { attachUnifiedDecision } from "./review-policy.js";
import { analyticVolume } from "./kernel-comparison.js";
import { REVIEW_POLICY } from "./review-policy.js";
import { normalizeParametricPlan } from "./parametric-plan.js";

// Every late review stage contributes issues the same way: tag them with the
// stage that found them, count them as blocking errors, and invalidate the
// report.  Keeping that in one place stops the four counters from drifting
// apart as stages are added.
function appendStageIssues(report, stage, issues) {
  if (!issues?.length) return false;
  report.issues.push(...issues.map((issue) => ({ stage, ...issue })));
  report.summary.errors += issues.filter(issue => issue.severity === "error").length;
  report.blockingErrorCount = report.summary.errors;
  report.valid = report.summary.errors === 0;
  return true;
}

/**
 * Compose the full validation report for one candidate revision: geometry and
 * constraint findings from the CadQuery build, then the BREP review, FBS
 * acceptance and STEP round-trip stages layered on top.
 *
 * Pure — takes the build output, returns the report.  No filesystem, no job.
 */
export function composeAssemblyValidationReport({
  plan,
  buildSummary = {},
  constraintReport,
  assemblyId = null,
  revisionId = null,
  maximumBatchSize = 4
} = {}) {
  const geometryValidation = buildSummary.geometryValidation || { parts: [], interferences: [] };
  const geometryReports = geometryValidation.parts || [];
  const report = mergeValidationReports({
    planIssues: validateBuildEvidence(plan, buildSummary),
    geometryReports,
    interferences: geometryValidation.interferences || [],
    constraintReport,
    manufacturingIssues: assessManufacturability(plan, Object.fromEntries(geometryReports.map((entry) => [entry.partId, entry])))
  });

  if (geometryValidation.motionReview) report.motionReview = structuredClone(geometryValidation.motionReview);
  appendStageIssues(report, "brep_review", validateBrepReviewCoverage(plan, buildSummary));
  report.independentReferences = [];
  const unknownMeasurements = [];
  for (const part of plan.parts || []) {
    for (const [index, spec] of (part.measurements || []).entries()) {
      if (spec.required === false) continue;
      const id = spec.id || `measurement-${index+1}`;
      const measurement = report.measurements.find(item => item.partId === part.id && item.id === id);
      if ((!measurement || measurement.status !== "pass" || !Number.isFinite(measurement.measured))
          && !report.issues.some(issue => issue.partId === part.id && issue.measurementId === id && issue.severity === "error")) {
        unknownMeasurements.push({ code: "REQUIRED_MEASUREMENT_UNVERIFIED", severity: "error", partId: part.id, measurementId: id,
          message: "A required dimension has no successful finite BRep measurement" });
      }
    }
    const referencePart = part.featureTree || !part.primitives ? part : normalizeParametricPlan({parts:[part]}).parts[0];
    const reference = analyticVolume(referencePart);
    if (!reference || !Number.isFinite(reference.value)) continue;
    const measured = geometryReports.find(item => item.partId === part.id)?.facts?.volume;
    const tolerance = REVIEW_POLICY.volumeAbsoluteMm3 + REVIEW_POLICY.volumeRelative*Math.abs(reference.value);
    const passed = Number.isFinite(measured) && Math.abs(measured-reference.value) <= tolerance;
    report.independentReferences.push({ partId: part.id, kind: "analytic-volume", formula: reference.formula,
      target: reference.value, measured, tolerance, status: passed ? "pass" : "fail" });
    if (!passed) appendStageIssues(report, "analytic_reference", [{ code: "ANALYTIC_VOLUME_MISMATCH", severity: "error", partId: part.id,
      measured, target: reference.value, tolerance, message: "Built solid volume does not match the independent analytic reference" }]);
  }
  appendStageIssues(report, "dimensions", unknownMeasurements);
  // FBS acceptance runs after geometry, BREP and required measurement checks.
  const fbsFailed = appendStageIssues(report, "fbs", validateFbsAcceptanceCoverage(plan, report));
  const stepRoundTripFailed = appendStageIssues(report, "step_roundtrip", validateStepRoundTrip(buildSummary));

  report.reviewStages = [
    ...(geometryValidation.reviewStages || []),
    { stage: "fbs_acceptance", status: fbsFailed ? "fail" : "pass" },
    { stage: "local_repair", status: "automatic" },
    { stage: buildSummary.engine === "nvidia-usd-brep" ? "usd_roundtrip" : "step_roundtrip", status: stepRoundTripFailed ? "fail" : "pass" }
  ];
  const stages = new Map();
  for (const entry of report.reviewStages) {
    const previous = stages.get(entry.stage);
    stages.set(entry.stage, previous?.status === "fail" ? previous : entry);
  }
  report.reviewStages = [...stages.values()];
  report.repairQueue = buildRepairWorkQueue(report, { maximumBatchSize });
  report.assemblyId = assemblyId;
  report.revisionId = revisionId;
  return attachUnifiedDecision(report, { engine: buildSummary.engine || "cadquery", revisionId });
}
