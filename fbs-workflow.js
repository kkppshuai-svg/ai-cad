export function normalizeFbsAnalysis(raw, requirements, criteria = "") {
  const clean = (items, prefix) => (Array.isArray(items) ? items : []).slice(0, 8).map((item, index) => ({
    id: String(item?.id || `${prefix}-${index + 1}`).replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80),
    label: String(item?.label || "").trim().slice(0, 500), rationale: String(item?.rationale || "").trim().slice(0, 1500),
    specifications: (Array.isArray(item?.specifications) ? item.specifications : []).map(String).filter(Boolean).slice(0, 12),
    upstreamIds: (Array.isArray(item?.upstreamIds) ? item.upstreamIds : []).map(String).filter(Boolean).slice(0, 12)
  })).filter((item) => item.label);
  const acceptanceChecks = (Array.isArray(raw?.acceptanceChecks) ? raw.acceptanceChecks : []).slice(0, 16).map((check, index) => ({
    id: String(check?.id || `ac-${index + 1}`).replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80),
    statement: String(check?.statement || check?.label || "").trim().slice(0, 500),
    measurementId: String(check?.measurementId || "").trim().slice(0, 120) || null,
    tolerance: Number.isFinite(Number(check?.tolerance)) ? Number(check.tolerance) : null,
    sourceIds: Array.isArray(check?.sourceIds) ? check.sourceIds.map(String).slice(0, 8) : []
  })).filter((check) => check.statement);
  const result = { format: "ai-cad-fbs-analysis-v1", requirements: String(requirements || "").trim(), criteria: String(criteria || "").trim(), functions: clean(raw?.functions, "f"), behaviors: clean(raw?.behaviors, "be"), structures: clean(raw?.structures, "s"), acceptanceChecks, generatedAt: new Date().toISOString() };
  if (!result.functions.length || !result.behaviors.length || !result.structures.length) throw new Error("FBS analysis returned an incomplete R→F→Be→S chain");
  return result;
}

// CAD planning should consume only the approved FBS decisions. The full
// rationale/trace remains archived for review, but is not repeated in every
// planner prompt or regenerated on every edit.
export function buildFbsPlanningSummary(fbs = {}) {
  const compact = (items) => (Array.isArray(items) ? items : []).slice(0, 8).map((item) => ({
    id: String(item?.id || "").slice(0, 80),
    label: String(item?.label || item || "").trim().slice(0, 300),
    specifications: (Array.isArray(item?.specifications) ? item.specifications : []).map(String).filter(Boolean).slice(0, 6),
    upstreamIds: (Array.isArray(item?.upstreamIds) ? item.upstreamIds : []).map(String).filter(Boolean).slice(0, 8)
  })).filter((item) => item.label);
  return {
    requirements: String(fbs.requirements || "").trim().slice(0, 2000),
    criteria: String(fbs.criteria || "").trim().slice(0, 2000),
    functions: compact(fbs.functions),
    behaviors: compact(fbs.behaviors),
    structures: compact(fbs.structures)
    ,acceptanceChecks: (Array.isArray(fbs.acceptanceChecks) ? fbs.acceptanceChecks : []).slice(0, 16).map((check) => ({
      id: check.id,
      statement: check.statement,
      measurementId: check.measurementId || null,
      tolerance: check.tolerance,
      sourceIds: check.sourceIds || []
    }))
  };
}
