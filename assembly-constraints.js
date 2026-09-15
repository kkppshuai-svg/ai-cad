const SUPPORTED_TYPES = new Set(["fixed", "coincident", "concentric", "distance", "angle", "revolute", "slider", "gear"]);
const DOF_KEYS = ["tx", "ty", "tz", "rx", "ry", "rz"];


export function normalizeConstraints(plan) {
  const partIds = new Set((plan.parts || []).map((part) => part.id));
  const source = Array.isArray(plan.constraints) ? plan.constraints : [];
  const ids = new Set();
  return source.map((constraint, index) => {
    if (!constraint || typeof constraint !== "object" || Array.isArray(constraint)) throw new TypeError(`Constraint ${index} must be an object`);
    const id = String(constraint.id || `constraint-${index + 1}`).trim();
    if (!id) throw new Error(`Constraint ${index} requires an ID`);
    if (ids.has(id)) throw new Error(`Duplicate constraint ID: ${id}`);
    ids.add(id);
    const rawType = String(constraint.type || "fixed").toLowerCase();
    const type = rawType === "prismatic" ? "slider" : rawType === "continuous" ? "revolute" : rawType;
    if (!SUPPORTED_TYPES.has(type)) throw new Error(`Unsupported constraint type: ${rawType}`);
    const from = normalizeReference(constraint.from || (constraint.parent ? { partId: constraint.parent } : null));
    const to = normalizeReference(constraint.to || (constraint.child ? { partId: constraint.child } : constraint.partId ? { partId: constraint.partId } : null));
    if (!to?.partId) throw new Error(`Constraint ${id} requires a target part`);
    for (const reference of [from, to]) {
      if (reference?.partId && reference.partId !== "world" && !partIds.has(reference.partId)) throw new Error(`Constraint ${id} references missing part ${reference.partId}`);
    }
    const normalized = { id, type, from: from || { partId: "world" }, to };
    if (["distance", "angle"].includes(type)) normalized.value = finiteNumber(constraint.value, `${id} value`);
    if (["revolute", "slider", "gear", "concentric", "distance"].includes(type)) normalized.axis = unitVector(constraint.axis || [0, 0, 1], `${id} axis`);
    if (type === "gear") {
      normalized.ratio = finiteNumber(constraint.ratio, `${id} ratio`);
      if (Math.abs(normalized.ratio) < 1e-12) throw new Error(`Constraint ${id} ratio must be non-zero`);
    }
    if (["revolute", "slider"].includes(type) && constraint.limit) {
      const lower = finiteNumber(constraint.limit.lower, `${id} lower limit`);
      const upper = finiteNumber(constraint.limit.upper, `${id} upper limit`);
      if (lower > upper) throw new Error(`Constraint ${id} lower limit exceeds upper limit`);
      normalized.limit = { ...constraint.limit, lower, upper };
    }
    return normalized;
  });
}


export function resolveDatum(plan, reference) {
  const normalized = normalizeReference(reference);
  if (!normalized?.partId) throw new Error("Datum reference requires partId");
  if (normalized.partId === "world") return { partId: "world", origin: [0, 0, 0], axis: [0, 0, 1], normal: [0, 0, 1] };
  const part = (plan.parts || []).find((item) => item.id === normalized.partId);
  if (!part) throw new Error(`Datum part missing: ${normalized.partId}`);
  if (normalized.featureId) {
    const feature = (part.featureTree || []).find((item) => item.id === normalized.featureId);
    if (!feature) throw new Error(`Feature datum missing: ${normalized.featureId}`);
    const axis = axisVector(feature.params?.axis || "z");
    return transformDatum(part, { partId: part.id, featureId: feature.id, origin: vector3(feature.params?.center || [0, 0, 0]), axis, normal: axis });
  }
  if (normalized.datumId) {
    const datum = (part.datums || []).find((item) => item.id === normalized.datumId);
    if (datum) {
      const axis = unitVector(datum.axis || datum.normal || [0, 0, 1], `${datum.id} axis`);
      return transformDatum(part, { partId: part.id, datumId: datum.id, origin: vector3(datum.origin || [0, 0, 0]), axis, normal: unitVector(datum.normal || axis, `${datum.id} normal`) });
    }
    const taggedFeature = (part.featureTree || []).find((item) =>
      Array.isArray(item.selector?.tags) && item.selector.tags.includes(`datum:${normalized.datumId}`)
    );
    if (taggedFeature) {
      const axis = axisVector(taggedFeature.params?.axis || "z");
      return transformDatum(part, { partId: part.id, datumId: normalized.datumId, featureId: taggedFeature.id, origin: vector3(taggedFeature.params?.center || [0, 0, 0]), axis, normal: axis });
    }
    throw new Error(`Datum missing: ${normalized.partId}.${normalized.datumId}`);
  }
  return transformDatum(part, { partId: part.id, origin: [0, 0, 0], axis: [0, 0, 1], normal: [0, 0, 1] });
}


export function analyzeAssemblyConstraints(plan) {
  let constraints;
  try {
    constraints = [
      ...normalizeConstraints(plan),
      ...normalizeJointConstraints(plan)
    ];
  } catch (error) {
    return { format: "ai-cad-constraint-analysis-v1", constraints: [], parts: initialDof(plan.parts), errors: [{ code: "INVALID_CONSTRAINT", message: error.message }], warnings: [] };
  }
  const parts = initialDof(plan.parts);
  const errors = [];
  const warnings = [];
  const distanceValues = new Map();
  const resolvedConstraints = [];

  for (const constraint of constraints) {
    try {
      resolvedConstraints.push({ constraint, from: resolveDatum(plan, constraint.from), to: resolveDatum(plan, constraint.to) });
    } catch (error) {
      errors.push({ code: "UNRESOLVED_DATUM", constraintId: constraint.id, message: error.message });
      continue;
    }
    if (constraint.type === "distance") {
      const key = distanceKey(constraint);
      if (distanceValues.has(key) && Math.abs(distanceValues.get(key).value - constraint.value) > 1e-7) {
        errors.push({ code: "CONFLICTING_DISTANCE", constraintId: constraint.id, conflictsWith: distanceValues.get(key).id, message: "Conflicting distance constraints" });
      } else distanceValues.set(key, { id: constraint.id, value: constraint.value });
    }
    reduceDof(parts, constraint);
  }
  errors.push(...gearRatioErrors(constraints));
  for (const resolved of resolvedConstraints) {
    if (resolved.constraint.source === "joint") continue;
    const residual = constraintResidual(resolved.constraint, resolved.from, resolved.to);
    if (residual) errors.push({ code: "CONSTRAINT_RESIDUAL", constraintId: resolved.constraint.id, residual: residual.value, tolerance: residual.tolerance, message: residual.message });
  }
  for (const [partId, state] of Object.entries(parts)) {
    state.free = DOF_KEYS.filter((key) => state[key]);
    state.remainingDof = state.free.length;
    if ((plan.parts || []).length > 1 && state.remainingDof === 6) warnings.push({ code: "UNCONSTRAINED_PART", partId, message: `${partId} retains all six degrees of freedom` });
  }
  return { format: "ai-cad-constraint-analysis-v1", constraints, parts, errors, warnings };
}


function normalizeJointConstraints(plan) {
  const partIds = new Set((plan.parts || []).map((part) => part.id));
  const source = Array.isArray(plan.joints) ? plan.joints : [];
  return source.map((joint, index) => {
    if (!joint || typeof joint !== "object" || Array.isArray(joint)) throw new TypeError(`Joint ${index} must be an object`);
    const child = String(joint.child || joint.to || "").trim();
    const parent = String(joint.parent || joint.from || "world").trim() || "world";
    if (!child || !partIds.has(child)) throw new Error(`Joint ${joint.id || index} references missing child part ${child || "(empty)"}`);
    if (parent !== "world" && !partIds.has(parent)) throw new Error(`Joint ${joint.id || index} references missing parent part ${parent}`);
    const rawType = String(joint.type || "fixed").toLowerCase();
    const type = rawType === "prismatic" ? "slider" : rawType === "continuous" ? "revolute" : rawType;
    if (!["fixed", "revolute", "slider"].includes(type)) throw new Error(`Unsupported joint type: ${rawType}`);
    const normalized = {
      id: `joint:${String(joint.id || `${parent}_${child}_${rawType}_${index}`).trim()}`,
      source: "joint",
      type,
      from: { partId: parent },
      to: { partId: child }
    };
    if (["revolute", "slider"].includes(type)) normalized.axis = unitVector(joint.axis || [0, 0, 1], `${normalized.id} axis`);
    if (["revolute", "slider"].includes(type) && joint.limit) {
      const lower = finiteNumber(joint.limit.lower, `${normalized.id} lower limit`);
      const upper = finiteNumber(joint.limit.upper, `${normalized.id} upper limit`);
      if (lower > upper) throw new Error(`Joint ${normalized.id} lower limit exceeds upper limit`);
      normalized.limit = { ...joint.limit, lower, upper };
    }
    return normalized;
  });
}


export function constraintToFreeCadManifest(constraint, resolved = {}) {
  const mapping = {
    fixed: "Fixed", coincident: "Ball", concentric: "Cylindrical", distance: "Distance",
    angle: "Angle", revolute: "Revolute", slider: "Slider", gear: "Gears"
  };
  const fromDatum = resolved.from || { origin: [0, 0, 0], axis: constraint.axis || [0, 0, 1] };
  const toDatum = resolved.to || { origin: [0, 0, 0], axis: constraint.axis || [0, 0, 1] };
  return {
    id: constraint.id,
    source: "constraint",
    type: constraint.type,
    freecadJointType: mapping[constraint.type] || "Fixed",
    from: { part: constraint.from?.partId || "world", datumId: constraint.from?.datumId || constraint.from?.featureId || null },
    to: { part: constraint.to?.partId || null, datumId: constraint.to?.datumId || constraint.to?.featureId || null },
    connector1: { originMm: vector3(fromDatum.origin).map((value) => Number(value)), rpyRad: [0, 0, 0], axis: unitVector(fromDatum.axis || [0, 0, 1], "from axis") },
    connector2: { originMm: vector3(toDatum.origin).map((value) => Number(value)), rpyRad: [0, 0, 0], axis: unitVector(toDatum.axis || [0, 0, 1], "to axis") },
    value: constraint.value ?? null,
    ratio: constraint.ratio ?? null,
    limit: constraint.limit || null,
    valid: true
  };
}


function reduceDof(parts, constraint) {
  const target = parts[constraint.to?.partId];
  if (!target) return;
  if (constraint.type === "fixed") setOnly(target, []);
  else if (constraint.type === "revolute") setOnly(target, [rotationDof(constraint.axis)]);
  else if (constraint.type === "slider") setOnly(target, [translationDof(constraint.axis)]);
  else if (constraint.type === "coincident") for (const key of ["tx", "ty", "tz"]) target[key] = false;
  else if (constraint.type === "concentric") {
    const translation = translationDof(constraint.axis);
    const rotation = rotationDof(constraint.axis);
    for (const key of DOF_KEYS) if (key !== translation && key !== rotation) target[key] = false;
  } else if (constraint.type === "distance") target[translationDof(constraint.axis)] = false;
  else if (constraint.type === "angle") target.rz = false;
}


function initialDof(partList = []) {
  return Object.fromEntries(partList.map((part) => [part.id, Object.fromEntries(DOF_KEYS.map((key) => [key, true]))]));
}


function setOnly(state, freeKeys) {
  for (const key of DOF_KEYS) state[key] = state[key] && freeKeys.includes(key);
}


function transformDatum(part, datum) {
  const pose = part.pose || {};
  const translate = Array.isArray(pose.translate) ? vector3(pose.translate) : [0, 0, 0];
  const rotate = Array.isArray(pose.rotate) ? vector3(pose.rotate) : [0, 0, 0];
  const origin = rotateVector(datum.origin, rotate).map((value, index) => value + translate[index]);
  const axis = unitVector(rotateVector(datum.axis, rotate), `${datum.partId} world axis`);
  const normal = unitVector(rotateVector(datum.normal, rotate), `${datum.partId} world normal`);
  return { ...datum, origin, axis, normal };
}


function rotateVector(values, degrees) {
  let [x, y, z] = vector3(values);
  const [rx, ry, rz] = degrees.map((value) => Number(value) * Math.PI / 180);
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  return [x, y, z];
}


function constraintResidual(constraint, from, to, tolerance = 1e-6) {
  const delta = to.origin.map((value, index) => value - from.origin[index]);
  const distance = magnitude(delta);
  const alignment = Math.abs(dot(from.axis, to.axis));
  const perpendicular = magnitude(cross(delta, from.axis));
  if (constraint.type === "coincident" && distance > tolerance) return { value: distance, tolerance, message: "Coincident datums are separated in world coordinates" };
  if (["concentric", "revolute", "slider"].includes(constraint.type)) {
    const residual = Math.max(1 - alignment, perpendicular);
    if (residual > tolerance) return { value: residual, tolerance, message: "Constraint axes are not concentric/aligned in world coordinates" };
  }
  if (constraint.type === "distance") {
    const actual = Math.abs(dot(delta, constraint.axis));
    const residual = Math.abs(actual - Math.abs(constraint.value));
    if (residual > tolerance) return { value: residual, tolerance, message: `Distance residual is ${residual}` };
  }
  if (constraint.type === "angle") {
    const actual = Math.acos(Math.max(-1, Math.min(1, dot(from.axis, to.axis)))) * 180 / Math.PI;
    const residual = Math.abs(actual - constraint.value);
    if (residual > 1e-5) return { value: residual, tolerance: 1e-5, message: `Angle residual is ${residual} degrees` };
  }
  return null;
}


function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}


function cross(left, right) {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}


function magnitude(values) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}


function translationDof(axis) {
  return `t${dominantAxis(axis)}`;
}


function rotationDof(axis) {
  return `r${dominantAxis(axis)}`;
}


function dominantAxis(axis) {
  const values = unitVector(axis || [0, 0, 1], "axis").map(Math.abs);
  return ["x", "y", "z"][values.indexOf(Math.max(...values))];
}


function distanceKey(constraint) {
  const parts = [constraint.from?.partId || "world", constraint.to?.partId || "world"].sort();
  const axis = unitVector(constraint.axis || [0, 0, 1], "distance axis").map((value) => Math.abs(value).toFixed(8));
  return `${parts.join("|")}|${axis.join(",")}`;
}


function gearRatioErrors(constraints) {
  const graph = new Map();
  for (const constraint of constraints.filter((item) => item.type === "gear")) {
    const from = constraint.from.partId;
    const to = constraint.to.partId;
    if (!graph.has(from)) graph.set(from, []);
    if (!graph.has(to)) graph.set(to, []);
    graph.get(from).push({ to, ratio: constraint.ratio, id: constraint.id });
    graph.get(to).push({ to: from, ratio: 1 / constraint.ratio, id: constraint.id });
  }
  const potentials = new Map();
  const errors = [];
  for (const start of graph.keys()) {
    if (potentials.has(start)) continue;
    potentials.set(start, 1);
    const queue = [start];
    while (queue.length) {
      const current = queue.shift();
      for (const edge of graph.get(current)) {
        const expected = potentials.get(current) * edge.ratio;
        if (!potentials.has(edge.to)) {
          potentials.set(edge.to, expected);
          queue.push(edge.to);
        } else if (Math.abs(potentials.get(edge.to) - expected) > 1e-7 * Math.max(1, Math.abs(expected))) {
          if (!errors.some((item) => item.constraintId === edge.id)) errors.push({ code: "GEAR_RATIO_CONFLICT", constraintId: edge.id, message: "Inconsistent gear ratio loop" });
        }
      }
    }
  }
  return errors;
}


function normalizeReference(reference) {
  if (!reference) return null;
  if (typeof reference === "string") return { partId: reference };
  if (typeof reference !== "object" || Array.isArray(reference)) throw new TypeError("Constraint reference must be an object");
  const result = { partId: String(reference.partId || reference.part || "").trim() };
  if (reference.datumId) result.datumId = String(reference.datumId);
  if (reference.featureId) result.featureId = String(reference.featureId);
  return result;
}


function axisVector(axis) {
  if (Array.isArray(axis)) return unitVector(axis, "axis");
  const result = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[String(axis || "z").toLowerCase()];
  if (!result) throw new Error(`Unsupported datum axis: ${axis}`);
  return result;
}


function vector3(values) {
  if (!Array.isArray(values) || values.length !== 3 || values.some((value) => !Number.isFinite(Number(value)))) throw new TypeError("Vector must contain three numbers");
  return values.map(Number);
}


function unitVector(values, name) {
  const result = vector3(values);
  const magnitude = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0));
  if (magnitude <= 1e-12) throw new Error(`${name} must be non-zero`);
  return result.map((value) => value / magnitude);
}


function finiteNumber(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new TypeError(`${name} must be a number`);
  return result;
}
