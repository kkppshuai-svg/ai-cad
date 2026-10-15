export const REVIEW_POLICY = Object.freeze({
  version: "unified-brep-review-v2",
  linearAbsoluteMm: 1e-6,
  linearRelative: 1e-9,
  volumeAbsoluteMm3: 1e-8,
  volumeRelative: 1e-7,
  occtIntegrationRelative: 1e-9,
  smlibIntegrationRelative: 1e-8
});

export function finitePositive(value) { return typeof value === "number" && Number.isFinite(value) && value > 0; }

export function reviewRevisionId(job) {
  return job.currentRevision || job.pendingRevision || (job.id && job.reviewPlanChecksum ? `preview:${job.id}:${job.reviewPlanChecksum}` : null);
}

export function attachUnifiedDecision(report, { engine = "cadquery", visualReview = null, revisionId = null, cache = null } = {}) {
  const errors = (report.issues || []).filter(item => item.severity === "error");
  const geometry = report.valid === true && errors.length === 0 && report.blockingErrorCount === 0 ? "pass" : "fail";
  const currentVisual = Boolean(revisionId && visualReview?.revisionId && String(visualReview.revisionId) === String(revisionId));
  const visual = currentVisual && visualReview.status === "pass" && (!visualReview.recommendedNextAction || visualReview.recommendedNextAction === "accept") ? "pass"
    : currentVisual ? "fail" : "pending";
  return { ...report, review: { protocol: REVIEW_POLICY.version, engine, policy: REVIEW_POLICY,
    rollout: { phase: engine === "nvidia-usd-brep" ? "native-only" : "parallel-validation", primaryEngine: "nvidia-usd-brep", parallelEngine: engine === "nvidia-usd-brep" ? null : "cadquery", userAcceptance: "pending" },
    coverage: { topology: engine === "nvidia-usd-brep" ? "SMLib manifold topology" : "OpenCascade exact BRepCheck with geometric controls",
      serialization: "volume, solid count, center and absolute bounds", dimensions: "required finite BRep measurements; unsupported checks block",
      surfaceDistance: "not a surface Hausdorff-distance proof", manufacturing: "heuristic engineering checks" },
    geometryDecision: geometry, visualDecision: visual,
    deliveryDecision: geometry === "fail" || visual === "fail" ? "fail" : visual === "pass" ? "pass" : "pending",
    constraintMethod: "AICAD rule-based rigid-body analysis; not a general numerical constraint solver",
    ...(cache ? { cache } : {}) } };
}
