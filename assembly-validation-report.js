import {
  assessManufacturability,
  buildRepairWorkQueue,
  mergeValidationReports,
  validateBrepReviewCoverage,
  validateBuildEvidence,
  validateFbsAcceptanceCoverage,
  validateStepRoundTrip
} from "./cad-validation.js";

// Every late review stage contributes issues the same way: tag them with the
// stage that found them, count them as blocking errors, and invalidate the
// report.  Keeping that in one place stops the four counters from drifting
// apart as stages are added.
function appendStageIssues(report, stage, issues) {
  if (!issues?.length) return false;
  report.issues.push(...issues.map((issue) => ({ stage, ...issue })));
  report.summary.errors += issues.length;
  report.blockingErrorCount += issues.length;
  report.valid = false;
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

  appendStageIssues(report, "brep_review", validateBrepReviewCoverage(plan, buildSummary));
  // FBS acceptance reads the report built so far, so it has to run after the
  // geometry and BREP stages have already contributed their issues.
  const fbsFailed = appendStageIssues(report, "fbs", validateFbsAcceptanceCoverage(plan, report));
  const stepRoundTripFailed = appendStageIssues(report, "step_roundtrip", validateStepRoundTrip(buildSummary));

  report.reviewStages = [
    ...(geometryValidation.reviewStages || []),
    { stage: "fbs_acceptance", status: fbsFailed ? "fail" : "pass" },
    { stage: "local_repair", status: "automatic" },
    { stage: "step_roundtrip", status: stepRoundTripFailed ? "fail" : "pass" }
  ];
  report.repairQueue = buildRepairWorkQueue(report, { maximumBatchSize });
  report.assemblyId = assemblyId;
  report.revisionId = revisionId;
  return report;
}
