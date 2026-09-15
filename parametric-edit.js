import { buildDependencyGraph, normalizeParametricPlan, resolveDimensionRefs } from "./parametric-plan.js";


const SUPPORTED_OPERATIONS = new Set([
  "set_param",
  "add_feature",
  "remove_feature",
  "enable_feature",
  "disable_feature",
  "set_measurement_target",
  "set_part_property",
  "set_part_pose",
  "set_constraint",
  "remove_constraint"
]);


export function resolveFeatureTarget(plan, query = {}) {
  const candidates = [];
  for (const part of plan.parts || []) {
    if (query.activePartId && part.id !== query.activePartId) continue;
    const matchingType = (part.featureTree || []).filter((node) => !query.type || node.type === query.type);
    for (const [typeIndex, node] of matchingType.entries()) {
      const tags = Array.isArray(node.selector?.tags) ? node.selector.tags.map(String) : [];
      const explicitIndex = tags.find((tag) => /^index:\d+$/i.test(tag));
      const ordinal = explicitIndex ? Number(explicitIndex.split(":")[1]) : typeIndex + 1;
      if (query.ordinal && ordinal !== Number(query.ordinal)) continue;
      if (query.name && !String(node.name || "").toLowerCase().includes(String(query.name).toLowerCase())) continue;
      if (query.tags && !query.tags.every((tag) => tags.includes(tag))) continue;
      candidates.push({ partId: part.id, featureId: node.id, name: node.name || node.id, type: node.type, ordinal });
    }
  }
  if (candidates.length === 1) return { status: "resolved", ...candidates[0], candidates };
  if (!candidates.length) return { status: "not_found", candidates };
  return { status: "ambiguous", candidates };
}


export function applyEditPatch(inputPlan, patch, context = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Edit patch must be an object");
  if (String(patch.baseRevision || "") !== String(context.revisionId || "")) {
    throw new Error(`Edit patch base revision ${patch.baseRevision || "<missing>"} does not match current revision ${context.revisionId || "<missing>"}`);
  }
  if (!Array.isArray(patch.operations) || !patch.operations.length) throw new Error("Edit patch requires operations");

  const plan = normalizeParametricPlan(structuredClone(inputPlan));
  if (!Array.isArray(plan.constraints)) plan.constraints = [];
  const geometryAffected = new Set();
  const assemblyAffected = new Set();
  const diff = [];

  for (const [index, operation] of patch.operations.entries()) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new TypeError(`Edit operation ${index} must be an object`);
    if (!SUPPORTED_OPERATIONS.has(operation.op)) throw new Error(`Unsupported edit operation: ${operation.op}`);
    applyOperation(plan, normalizeEditOperation(operation), geometryAffected, assemblyAffected, diff);
  }

  const normalized = resolveDimensionRefs(normalizeParametricPlan(plan));
  const partOrder = (normalized.parts || []).map((part) => part.id);
  const orderedGeometryAffected = partOrder.filter((partId) => geometryAffected.has(partId));
  const orderedAssemblyAffected = partOrder.filter((partId) => assemblyAffected.has(partId));
  return {
    plan: normalized,
    diff,
    affectedPartIds: orderedGeometryAffected,
    geometryAffectedPartIds: orderedGeometryAffected,
    assemblyAffectedPartIds: orderedAssemblyAffected,
    assemblyArtifactsDirty: diff.length > 0
  };
}


function normalizeEditOperation(operation) {
  const normalized = structuredClone(operation);
  if (normalized.op === "set_part_pose" && !isPlainObject(normalized.pose)) {
    if (isCompletePose(normalized.value)) {
      normalized.pose = structuredClone(normalized.value);
      return normalized;
    }
    if (isCompletePose(normalized)) {
      normalized.pose = {
        translate: structuredClone(normalized.translate),
        rotate: structuredClone(normalized.rotate)
      };
      return normalized;
    }
  }
  if (normalized.op !== "add_feature" || isPlainObject(normalized.feature)) return normalized;
  if (isPlainObject(normalized.value) && typeof normalized.value.type === "string" && normalized.value.type.trim()) {
    normalized.feature = structuredClone(normalized.value);
    return normalized;
  }
  if (typeof normalized.type !== "string" || !normalized.type.trim()) return normalized;
  normalized.feature = {};
  const featureId = normalized.id ?? normalized.featureId;
  if (featureId !== undefined) normalized.feature.id = structuredClone(featureId);
  for (const field of ["name", "type", "enabled", "dependsOn", "params", "selector"]) {
    if (normalized[field] !== undefined) normalized.feature[field] = structuredClone(normalized[field]);
  }
  return normalized;
}


function isCompletePose(value) {
  return isPlainObject(value) && Array.isArray(value.translate) && Array.isArray(value.rotate);
}


function applyOperation(plan, operation, geometryAffected, assemblyAffected, diff) {
  if (operation.op === "set_constraint") {
    setConstraint(plan, operation, assemblyAffected, diff);
    return;
  }
  if (operation.op === "remove_constraint") {
    removeConstraint(plan, operation, assemblyAffected, diff);
    return;
  }

  const part = findPart(plan, operation.partId);
  if (operation.op === "set_part_property") {
    if (operation.path !== "requireSingleSolid") throw new Error("set_part_property only supports requireSingleSolid");
    if (typeof operation.value !== "boolean") throw new TypeError("requireSingleSolid must be a boolean");
    const previous = part.requireSingleSolid;
    part.requireSingleSolid = operation.value;
    assemblyAffected.add(part.id);
    diff.push({ op: operation.op, partId: part.id, path: operation.path, before: previous, after: operation.value });
    return;
  }
  if (operation.op === "set_measurement_target") {
    const measurement = (part.measurements || []).find((item) => item.id === operation.measurementId);
    if (!measurement) throw new Error(`Measurement not found: ${operation.measurementId}`);
    if (!Number.isFinite(Number(operation.value))) throw new TypeError("set_measurement_target requires a finite value");
    const previous = measurement.target;
    measurement.target = Number(operation.value);
    assemblyAffected.add(part.id);
    diff.push({ op: operation.op, partId: part.id, measurementId: measurement.id, before: previous, after: measurement.target });
    return;
  }
  if (operation.op === "set_part_pose") {
    const previous = structuredClone(part.pose || null);
    part.pose = normalizePose(operation.pose);
    assemblyAffected.add(part.id);
    diff.push({ op: operation.op, partId: part.id, before: previous, after: structuredClone(part.pose) });
    return;
  }

  if (operation.op === "add_feature") {
    if (!operation.feature || typeof operation.feature !== "object" || Array.isArray(operation.feature)) throw new TypeError("add_feature requires feature");
    part.featureTree.push(structuredClone(operation.feature));
    geometryAffected.add(part.id);
    assemblyAffected.add(part.id);
    diff.push({ op: operation.op, partId: part.id, featureId: operation.feature.id || null, after: structuredClone(operation.feature) });
    return;
  }

  const featureIndex = part.featureTree.findIndex((node) => node.id === operation.featureId);
  if (featureIndex < 0) throw new Error(`Feature not found: ${operation.featureId}`);
  const feature = part.featureTree[featureIndex];

  if (operation.op === "remove_feature") {
    const graph = buildDependencyGraph(part.featureTree);
    const dependents = graph.reverseDependencies.get(feature.id) || [];
    if (dependents.length) throw new Error(`Cannot remove feature ${feature.id}; dependent features: ${dependents.join(", ")}`);
    part.featureTree.splice(featureIndex, 1);
    geometryAffected.add(part.id);
    assemblyAffected.add(part.id);
    diff.push({ op: operation.op, partId: part.id, featureId: feature.id, before: structuredClone(feature) });
    return;
  }

  if (operation.op === "enable_feature" || operation.op === "disable_feature") {
    const previous = feature.enabled !== false;
    feature.enabled = operation.op === "enable_feature";
    geometryAffected.add(part.id);
    assemblyAffected.add(part.id);
    diff.push({ op: operation.op, partId: part.id, featureId: feature.id, before: previous, after: feature.enabled });
    return;
  }

  if (operation.op === "set_param") {
    const path = parseParamPath(operation.path);
    const previous = getPath(feature, path);
    setPath(feature, path, structuredClone(operation.value));
    geometryAffected.add(part.id);
    assemblyAffected.add(part.id);
    diff.push({ op: operation.op, partId: part.id, featureId: feature.id, path: operation.path, before: structuredClone(previous), after: structuredClone(operation.value) });
  }
}


function setConstraint(plan, operation, assemblyAffected, diff) {
  const constraint = operation.constraint;
  if (!constraint || typeof constraint !== "object" || Array.isArray(constraint) || typeof constraint.id !== "string" || !constraint.id.trim()) {
    throw new TypeError("set_constraint requires a constraint with ID");
  }
  const index = plan.constraints.findIndex((item) => item.id === constraint.id);
  const previous = index >= 0 ? structuredClone(plan.constraints[index]) : null;
  if (index >= 0) plan.constraints[index] = structuredClone(constraint);
  else plan.constraints.push(structuredClone(constraint));
  addConstraintParts(assemblyAffected, constraint);
  if (previous) addConstraintParts(assemblyAffected, previous);
  diff.push({ op: operation.op, constraintId: constraint.id, before: previous, after: structuredClone(constraint) });
}


function removeConstraint(plan, operation, assemblyAffected, diff) {
  const index = plan.constraints.findIndex((item) => item.id === operation.constraintId);
  if (index < 0) throw new Error(`Constraint not found: ${operation.constraintId}`);
  const [removed] = plan.constraints.splice(index, 1);
  addConstraintParts(assemblyAffected, removed);
  diff.push({ op: operation.op, constraintId: removed.id, before: structuredClone(removed) });
}


function addConstraintParts(affected, constraint) {
  for (const candidate of [constraint.partId, constraint.parent, constraint.child, constraint.from?.partId, constraint.to?.partId]) {
    if (candidate && candidate !== "world") affected.add(candidate);
  }
}


function findPart(plan, partId) {
  const part = (plan.parts || []).find((item) => item.id === partId);
  if (!part) throw new Error(`Part not found: ${partId}`);
  return part;
}


function parseParamPath(value) {
  const path = String(value || "").split(".").filter(Boolean);
  if (path[0] !== "params" || path.length < 2) throw new Error("set_param path must start with params");
  if (path.some((segment) => !/^([A-Za-z_][A-Za-z0-9_]*|\d+)$/.test(segment))) throw new Error(`Invalid parameter path: ${value}`);
  return path;
}


function getPath(root, path) {
  let current = root;
  for (const segment of path) {
    if (current == null || !Object.hasOwn(current, segment)) throw new Error(`Parameter path not found: ${path.join(".")}`);
    current = current[segment];
  }
  return current;
}


function setPath(root, path, value) {
  let current = root;
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index];
    if (current == null || !Object.hasOwn(current, segment)) throw new Error(`Parameter path not found: ${path.join(".")}`);
    current = current[segment];
  }
  const leaf = path.at(-1);
  if (current == null || !Object.hasOwn(current, leaf)) throw new Error(`Parameter path not found: ${path.join(".")}`);
  current[leaf] = value;
}


function normalizePose(pose) {
  if (!pose || typeof pose !== "object" || Array.isArray(pose)) throw new TypeError("set_part_pose requires pose");
  return {
    translate: vector3(pose.translate, "pose.translate"),
    rotate: vector3(pose.rotate, "pose.rotate")
  };
}


function vector3(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => !Number.isFinite(Number(item)))) {
    throw new TypeError(`${name} must contain three numbers`);
  }
  return value.map(Number);
}


function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
