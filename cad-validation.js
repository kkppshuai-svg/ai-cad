export function mergeValidationReports(inputs = {}) {
  const issues = [];
  const measurements = [];
  const unverifiedDimensions = [];
  const unverifiedConditions = [];
  for (const issue of inputs.planIssues || []) issues.push(normalizeIssue(issue, "error", "plan"));
  for (const report of inputs.geometryReports || []) {
    for (const measurement of report.measurements || []) {
      measurements.push({ partId: report.partId, ...structuredClone(measurement) });
    }
    for (const dimension of report.unverifiedDimensions || []) {
      unverifiedDimensions.push({ partId: report.partId, ...structuredClone(dimension) });
    }
    for (const condition of report.unverifiedConditions || []) {
      unverifiedConditions.push({ partId: report.partId, ...structuredClone(condition) });
    }
    for (const issue of report.issues || []) issues.push(normalizeIssue({ partId: report.partId, ...issue }, "error", "geometry"));
  }
  for (const issue of inputs.interferences || []) {
    const severity = issue?.intendedContact === true ? "info" : "error";
    issues.push(normalizeIssue({ ...issue, severity }, severity, "assembly"));
  }
  for (const issue of inputs.constraintReport?.errors || []) issues.push(normalizeIssue(issue, "error", "constraint"));
  for (const issue of inputs.constraintReport?.warnings || []) issues.push(normalizeIssue(issue, "warning", "constraint"));
  for (const issue of inputs.manufacturingIssues || []) issues.push(normalizeIssue(issue, "warning", "manufacturing"));
  const summary = { errors: 0, warnings: 0, info: 0 };
  for (const issue of issues) {
    if (issue.severity === "error") summary.errors += 1;
    else if (issue.severity === "warning") summary.warnings += 1;
    else summary.info += 1;
  }
  return {
    format: "ai-cad-validation-report-v1",
    generatedAt: new Date().toISOString(),
    valid: summary.errors === 0,
    blockingErrorCount: summary.errors,
    summary,
    issues,
    measurements,
    unverifiedDimensions,
    unverifiedConditions
  };
}


export function canPromoteRevision(report) {
  return Boolean(report) && Number(report.blockingErrorCount || 0) === 0 && report.valid !== false;
}

export function validateFbsAcceptanceCoverage(plan = {}, validationReport = {}) {
  const checks = Array.isArray(plan?.concept?.acceptanceChecks) ? plan.concept.acceptanceChecks : [];
  if (!checks.length) return [];
  const measurementIds = new Set((validationReport.measurements || []).map((measurement) => String(measurement.id || "")));
  return checks.filter((check) => check?.measurementId && !measurementIds.has(String(check.measurementId))).map((check) => ({
    code: "FBS_ACCEPTANCE_UNMAPPED",
    severity: "error",
    measurementId: check.measurementId,
    message: `FBS验收条件未映射到可测量项：${check.statement || check.id}`
  }));
}

export function validateBrepReviewCoverage(plan = {}, buildSummary = {}) {
  const plannedParts = new Set((plan.parts || []).map((part) => String(part.id)));
  const reports = new Map((buildSummary.geometryValidation?.parts || []).map((report) => [String(report.partId), report]));
  const issues = [];
  for (const partId of plannedParts) {
    const report = reports.get(partId);
    if (!report) continue;
    const facts = report.facts || {};
    if (report.valid !== true) continue;
    if (!(Number(facts.solidCount) >= 1)) issues.push({ code: "BREP_REVIEW_NO_SOLID_EVIDENCE", severity: "error", partId, message: "BREP审查缺少闭合实体证据" });
    if (!(Number(facts.volume) > 0)) issues.push({ code: "BREP_REVIEW_NO_VOLUME_EVIDENCE", severity: "error", partId, message: "BREP审查缺少正体积证据" });
    if (!Array.isArray(facts.bbox) || facts.bbox.length !== 3 || facts.bbox.some((value) => !(Number(value) > 0))) {
      issues.push({ code: "BREP_REVIEW_NO_BBOX_EVIDENCE", severity: "error", partId, message: "BREP审查缺少有效包围盒尺寸证据" });
    }
  }
  return issues;
}

export function validateStepRoundTrip(buildSummary = {}) {
  const report = buildSummary.geometryValidation?.stepRoundTrip;
  if (!report) return [{ code: "MISSING_STEP_ROUNDTRIP", severity: "error", message: "缺少 STEP round-trip 回归验证证据" }];
  return (report.issues || []).map((issue) => ({ ...issue, code: issue.code || "STEP_ROUNDTRIP_FAILED" }));
}


export function validateBuildEvidence(plan, buildSummary = {}) {
  const issues = [];
  const plannedIds = new Set((plan.parts || []).map((part) => part.id));
  const builtParts = new Map((buildSummary.parts || []).map((part) => [part.id, part]));
  const geometryReports = new Map((buildSummary.geometryValidation?.parts || []).map((report) => [report.partId, report]));
  if (typeof buildSummary.stepPath !== "string" || !buildSummary.stepPath) issues.push({ code: "MISSING_ASSEMBLY_STEP", severity: "error", message: "Build did not produce an assembly STEP artifact" });
  for (const partId of plannedIds) {
    const built = builtParts.get(partId);
    if (!built?.localStepPath) issues.push({ code: "MISSING_PART_ARTIFACT", severity: "error", partId, message: "Planned part has no local STEP artifact" });
    const geometry = geometryReports.get(partId);
    if (!geometry) issues.push({ code: "MISSING_GEOMETRY_VALIDATION", severity: "error", partId, message: "Planned part has no geometry validation report" });
    else if (Number(geometry.blockingErrorCount || 0) > 0 && !(geometry.issues || []).some((issue) => issue.severity === "error")) {
      issues.push({ code: "UNEXPLAINED_GEOMETRY_FAILURE", severity: "error", partId, message: "Geometry validation reported blocking errors without issue details" });
    }
  }
  for (const partId of builtParts.keys()) if (!plannedIds.has(partId)) issues.push({ code: "UNEXPECTED_BUILT_PART", severity: "error", partId, message: "Build produced a part that is not present in the plan" });
  for (const partId of geometryReports.keys()) if (!plannedIds.has(partId)) issues.push({ code: "UNEXPECTED_GEOMETRY_VALIDATION", severity: "error", partId, message: "Geometry validation references a part outside the plan" });
  return issues;
}


export function proposeDeterministicRepairs(report, plan, options = {}) {
  const operations = [];
  const audit = [];
  const requiresAi = [];
  const actions = [];
  const minimumFinish = Number(options.minimumFinishSize || 0.05);
  for (const issue of report.issues || []) {
    const located = locateFeature(plan, issue.partId, issue.featureId);
    if (issue.code === "FINISH_FEATURE_FAILED" && located && ["fillet", "chamfer"].includes(located.feature.type)) {
      const key = located.feature.type === "fillet" ? "radius" : "distance";
      const original = Number(located.feature.params?.[key]);
      if (Number.isFinite(original) && original > minimumFinish) {
        const repaired = Math.max(minimumFinish, original / 2);
        operations.push({ op: "set_param", partId: located.part.id, featureId: located.feature.id, path: `params.${key}`, value: repaired });
        audit.push({ issueCode: issue.code, partId: located.part.id, featureId: located.feature.id, action: "reduce_finish", originalValue: original, repairedValue: repaired });
      } else {
        operations.push({ op: "disable_feature", partId: located.part.id, featureId: located.feature.id });
        audit.push({ issueCode: issue.code, partId: located.part.id, featureId: located.feature.id, action: "disable_failed_finish", originalValue: original, repairedValue: null });
      }
    } else if (issue.code === "CUT_NOT_THROUGH" && located && ["hole", "slot", "cut_box", "cut_extrude"].includes(located.feature.type) && Number.isFinite(Number(issue.requiredDepth))) {
      const original = Number(located.feature.params?.depth);
      const repaired = Number(issue.requiredDepth);
      if (repaired > original) {
        operations.push({ op: "set_param", partId: located.part.id, featureId: located.feature.id, path: "params.depth", value: repaired });
        audit.push({ issueCode: issue.code, partId: located.part.id, featureId: located.feature.id, action: "extend_cut", originalValue: original, repairedValue: repaired });
      }
    } else if (issue.code === "MINIMUM_POSITIVE_REQUIRED" && issue.safeToClamp === true && located && /^params\.[A-Za-z_][A-Za-z0-9_]*$/.test(issue.path || "")) {
      const key = issue.path.slice("params.".length);
      const original = Number(located.feature.params?.[key]);
      const repaired = Number(issue.minimum || minimumFinish);
      if (Number.isFinite(original) && Number.isFinite(repaired) && repaired > 0 && original < repaired) {
        operations.push({ op: "set_param", partId: located.part.id, featureId: located.feature.id, path: issue.path, value: repaired });
        audit.push({ issueCode: issue.code, partId: located.part.id, featureId: located.feature.id, action: "minimum_positive_clamp", originalValue: original, repairedValue: repaired });
      }
    } else if (issue.code === "INVALID_BREP" || issue.code === "BREP_CLEAN_RETRY") {
      actions.push({ type: "clean_and_retry", partId: issue.partId || null, featureId: issue.featureId || null });
      audit.push({ issueCode: issue.code, partId: issue.partId || null, featureId: issue.featureId || null, action: "clean_and_retry" });
    } else {
      requiresAi.push(structuredClone(issue));
    }
  }
  return { patch: { operations }, actions, audit, requiresAi };
}

export function classifyValidationIssues(report = {}) {
  return (report.issues || []).map((issue) => {
    let category = "semantic";
    let automatic = false;
    if (["FINISH_FEATURE_FAILED", "CUT_NOT_THROUGH", "MINIMUM_POSITIVE_REQUIRED"].includes(issue.code)) {
      category = "deterministic";
      automatic = true;
    } else if (["INVALID_BREP", "BREP_CLEAN_RETRY", "MISSING_GEOMETRY_VALIDATION", "UNEXPLAINED_GEOMETRY_FAILURE"].includes(issue.code)) {
      category = "geometry";
    } else if (["PART_INTERFERENCE", "CONSTRAINT_CONFLICT", "CONFLICTING_DISTANCE", "MISSING_ASSEMBLY_STEP"].includes(issue.code)) {
      category = "assembly";
    } else if (["MINIMUM_WALL_RISK", "HOLE_EDGE_DISTANCE", "SMALL_FILLET_RISK"].includes(issue.code)) {
      category = "manufacturing";
    }
    return {
      code: issue.code || "VALIDATION_ISSUE",
      category,
      automatic,
      severity: issue.severity || "error",
      partId: issue.partId || null,
      featureId: issue.featureId || null
    };
  });
}

export function buildRepairWorkQueue(report = {}, options = {}) {
  const maximumBatchSize = Math.max(1, Number(options.maximumBatchSize || 4));
  const errors = (report.issues || []).filter((issue) => issue.severity === "error");
  const rootPriority = new Map([
    ["MINIMUM_POSITIVE_REQUIRED", 0], ["CUT_NOT_THROUGH", 0], ["FINISH_FEATURE_FAILED", 0],
    ["INVALID_BREP", 1], ["NO_SOLID", 1], ["OPEN_SHELL", 1], ["NON_POSITIVE_VOLUME", 1],
    ["DIMENSION_MISMATCH", 2], ["DIMENSION_UNMEASURABLE", 2], ["FBS_ACCEPTANCE_UNMAPPED", 2],
    ["PART_INTERFERENCE", 3], ["CONSTRAINT_CONFLICT", 3], ["CONFLICTING_DISTANCE", 3],
    ["STEP_ROUNDTRIP_FAILED", 4], ["MISSING_STEP_ROUNDTRIP", 4]
  ]);
  const geometryRoots = new Set(errors.filter((issue) => ["INVALID_BREP", "NO_SOLID", "OPEN_SHELL", "NON_POSITIVE_VOLUME"].includes(issue.code)).map((issue) => String(issue.partId || "assembly")));
  const downstreamCodes = new Set(["BREP_REVIEW_NO_SOLID_EVIDENCE", "BREP_REVIEW_NO_VOLUME_EVIDENCE", "BREP_REVIEW_NO_BBOX_EVIDENCE", "STEP_ROUNDTRIP_FAILED"]);
  const unique = new Map();
  for (const issue of errors) {
    const target = String(issue.partId || (Array.isArray(issue.parts) ? issue.parts.join("+") : "assembly"));
    if (downstreamCodes.has(issue.code) && geometryRoots.has(target)) continue;
    if (issue.code === "STEP_ROUNDTRIP_FAILED" && geometryRoots.size) continue;
    const key = `${target}:${issue.featureId || issue.measurementId || "root"}:${issue.code}`;
    if (!unique.has(key)) unique.set(key, structuredClone(issue));
  }
  const pending = [...unique.values()].sort((left, right) => {
    const leftPriority = rootPriority.get(left.code) ?? 5;
    const rightPriority = rootPriority.get(right.code) ?? 5;
    return leftPriority - rightPriority;
  });
  const active = pending.slice(0, maximumBatchSize);
  return {
    totalBlocking: errors.length,
    rootCauseCount: pending.length,
    active,
    deferred: pending.slice(active.length),
    suppressedCount: Math.max(0, errors.length - pending.length)
  };
}

export function compactValidationForRepair(report = {}, options = {}) {
  const repairQueue = buildRepairWorkQueue(report, options);
  return {
    format: report.format,
    valid: false,
    blockingErrorCount: repairQueue.active.length,
    summary: { errors: repairQueue.active.length, warnings: 0, info: 0 },
    issues: repairQueue.active,
    measurements: (report.measurements || []).filter((measurement) => repairQueue.active.some((issue) => issue.measurementId && issue.measurementId === measurement.id)),
    repairQueue
  };
}

function stableValue(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

export function captureRepairInvariants(plan = {}) {
  const parts = (plan.parts || []).map((part) => ({
    id: part.id,
    featureIds: (part.featureTree || []).map((feature) => feature.id),
    functionalFeatures: (part.featureTree || []).filter((feature) => feature.type === "hole" || feature.type === "gear").map((feature) => ({
      id: feature.id,
      type: feature.type,
      params: Object.fromEntries(Object.entries(feature.params || {}).filter(([key]) => ["diameter", "radius", "center", "axis", "teeth", "module", "pressureAngle", "keyway"].includes(key)))
    }))
  }));
  return {
    partIds: parts.map((part) => part.id),
    parts,
    relations: stableValue(plan.relations || []),
    joints: stableValue(plan.joints || []),
    constraints: stableValue(plan.constraints || [])
  };
}

export function validateRepairInvariants(beforePlan, afterPlan) {
  const before = captureRepairInvariants(beforePlan);
  const after = captureRepairInvariants(afterPlan);
  const issues = [];
  if (stableValue(before.partIds) !== stableValue(after.partIds)) issues.push({ code: "REPAIR_CHANGED_PART_SET", message: "Repair changed the assembly part set" });
  if (before.parts.length !== after.parts.length) issues.push({ code: "REPAIR_CHANGED_PART_COUNT", message: "Repair changed the assembly part count" });
  for (const part of before.parts) {
    const repaired = after.parts.find((candidate) => candidate.id === part.id);
    if (!repaired) continue;
    if (stableValue(part.featureIds) !== stableValue(repaired.featureIds)) issues.push({ code: "REPAIR_CHANGED_FEATURE_SET", partId: part.id, message: "Repair changed the feature set" });
    for (const feature of part.functionalFeatures) {
      const candidate = repaired.functionalFeatures.find((item) => item.id === feature.id);
      if (!candidate || stableValue(feature.params) !== stableValue(candidate.params)) issues.push({ code: "REPAIR_CHANGED_FUNCTIONAL_DIMENSION", partId: part.id, featureId: feature.id, message: "Repair changed a protected functional dimension" });
    }
  }
  for (const key of ["relations", "joints", "constraints"]) if (before[key] !== after[key]) issues.push({ code: `REPAIR_CHANGED_${key.toUpperCase()}`, message: `Repair changed ${key}` });
  return { ok: issues.length === 0, issues, before, after };
}

export function scoreRepairCandidate(beforePlan, afterPlan, report = {}) {
  const guard = validateRepairInvariants(beforePlan, afterPlan);
  const changedFeatures = (afterPlan.parts || []).reduce((count, part, index) => {
    const beforePart = beforePlan.parts?.[index];
    return count + (part.featureTree || []).reduce((inner, feature, featureIndex) => stableValue(feature) === stableValue(beforePart?.featureTree?.[featureIndex]) ? inner : inner + 1, 0);
  }, 0);
  const unresolved = (report.issues || []).filter((issue) => issue.severity === "error").length;
  return { score: guard.ok ? 100 - changedFeatures * 3 - unresolved : -1000, changedFeatures, unresolved, invariantViolations: guard.issues, accepted: guard.ok };
}


export function assessManufacturability(plan, geometryByPart = {}, config = {}) {
  const minimumWall = Number(config.minimumWallThickness || 1);
  const minimumEdge = Number(config.minimumHoleEdgeDistance || 1.5);
  const minimumFillet = Number(config.minimumFilletRadius || 0.2);
  const issues = [];
  for (const part of plan.parts || []) {
    const wall = Number(part.manufacturing?.wallThickness);
    if (Number.isFinite(wall) && wall < minimumWall) {
      issues.push({ code: "MINIMUM_WALL_RISK", severity: "warning", partId: part.id, measured: wall, recommendedMinimum: minimumWall, message: "Wall thickness is below the configured process guideline" });
    }
    const base = (part.featureTree || []).find((node) => node.type === "base_box" && node.enabled !== false);
    const bbox = geometryByPart[part.id]?.facts?.bbox || base?.params?.size;
    if (Array.isArray(bbox) && bbox.length >= 3) {
      const half = { x: Number(bbox[0]) / 2, y: Number(bbox[1]) / 2, z: Number(bbox[2]) / 2 };
      for (const feature of part.featureTree || []) {
        if (feature.type !== "hole" || feature.enabled === false) continue;
        const center = feature.params?.center || [0, 0, 0];
        const radius = Number(feature.params?.radius ?? Number(feature.params?.diameter) / 2);
        const axis = String(feature.params?.axis || "z").toLowerCase();
        const perpendicular = axis === "x" ? [["y", 1], ["z", 2]] : axis === "y" ? [["x", 0], ["z", 2]] : [["x", 0], ["y", 1]];
        const clearance = Math.min(...perpendicular.map(([key, index]) => half[key] - Math.abs(Number(center[index] || 0)))) - radius;
        if (Number.isFinite(clearance) && clearance < minimumEdge) {
          issues.push({ code: "HOLE_EDGE_DISTANCE", severity: "warning", partId: part.id, featureId: feature.id, measured: clearance, recommendedMinimum: minimumEdge, message: "Hole is close to the part edge" });
        }
      }
    }
    for (const feature of part.featureTree || []) {
      if (feature.type === "fillet" && Number(feature.params?.radius) < minimumFillet) {
        issues.push({ code: "SMALL_FILLET_RISK", severity: "warning", partId: part.id, featureId: feature.id, measured: Number(feature.params?.radius), recommendedMinimum: minimumFillet, message: "Fillet is below the configured process guideline" });
      }
    }
  }
  return issues;
}


function normalizeIssue(issue, fallbackSeverity, stage) {
  return { stage, severity: issue.severity || fallbackSeverity, code: issue.code || "VALIDATION_ISSUE", ...structuredClone(issue) };
}


function locateFeature(plan, partId, featureId) {
  const part = (plan.parts || []).find((item) => item.id === partId);
  if (!part) return null;
  const feature = (part.featureTree || []).find((item) => item.id === featureId);
  return feature ? { part, feature } : null;
}
