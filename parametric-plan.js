import { createHash } from "node:crypto";

const SUPPORTED_TYPES = new Set([
  "base_box",
  "base_cylinder",
  "base_cone",
  "base_sphere",
  "base_ellipsoid",
  "base_spur_gear",
  "add_extrude",
  "cut_extrude",
  "hole",
  "slot",
  "cut_box",
  "add_primitive",
  "linear_pattern",
  "circular_pattern",
  "fillet",
  "chamfer",
  "dimension"
]);

const LEGACY_BASE_TYPES = new Map([
  ["box", "base_box"],
  ["cylinder", "base_cylinder"],
  ["cone", "base_cone"],
  ["sphere", "base_sphere"],
  ["ellipsoid", "base_ellipsoid"],
  ["spur_gear", "base_spur_gear"]
]);

const COMPAT_BASE_TYPES = new Map(
  [...LEGACY_BASE_TYPES].map(([legacy, normalized]) => [normalized, legacy])
);

const LEGACY_FEATURE_TYPES = new Map([["add", "add_primitive"]]);
const COMPAT_FEATURE_TYPES = new Map([["add_primitive", "add"]]);

const NODE_FIELDS = new Set([
  "id", "name", "type", "enabled", "dependsOn", "params", "selector"
]);

const POSITIVE_SCALAR_NAMES = new Set([
  "angle",
  "bottomRadius",
  "boreDiameter",
  "boreRadius",
  "cornerRadius",
  "count",
  "depth",
  "diameter",
  "distance",
  "height",
  "length",
  "module",
  "radius",
  "radius1",
  "radius2",
  "spacing",
  "thickness",
  "topRadius",
  "teeth",
  "value",
  "width"
]);

const POSITIVE_ARRAY_NAMES = new Set(["dimensions", "radii", "size"]);

const INVALID_PATTERN_SOURCE_TYPES = new Set([
  "linear_pattern",
  "circular_pattern",
  "fillet",
  "chamfer",
  "dimension"
]);

export function normalizeParametricPlan(plan) {
  if (!isPlainObject(plan)) {
    throw new TypeError("Parametric plan must be an object");
  }

  const normalized = structuredClone(plan);
  if (normalized.parts !== undefined && !Array.isArray(normalized.parts)) {
    throw new TypeError("Parametric plan parts must be an array");
  }
  const parts = normalized.parts || [];
  const partIds = new Set();

  normalized.parts = parts.map((part, partIndex) => {
    if (!isPlainObject(part)) {
      throw new TypeError(`Part at index ${partIndex} must be an object`);
    }

    const partId = normalizePartId(part, partIndex);
    if (partIds.has(partId)) throw new Error(`Duplicate part ID: ${partId}`);
    partIds.add(partId);

    const hasFeatureTree = Object.hasOwn(part, "featureTree");
    if (hasFeatureTree && !Array.isArray(part.featureTree)) {
      throw new TypeError(`Part ${partId} featureTree must be an array`);
    }
    validateLegacyContainer(part.primitives, "primitives", partId);
    validateLegacyContainer(part.features, "features", partId);
    const counters = new Map();
    const sourceNodes = hasFeatureTree
      ? part.featureTree
      : [
          ...normalizeLegacyPrimitives(part.primitives),
          ...normalizeLegacyFeatures(part.features)
        ];
    reserveExplicitIds(partId, sourceNodes, counters);
    const featureTree = normalizeDuplicateRootPose(part, normalizeAdditionalBaseNodes(
      sourceNodes.map((node, index) =>
        normalizeFeatureNode(partId, node, index, counters)
      )
    ));

    const dependencyGraph = buildDependencyGraph(featureTree);
    validatePatternSourceTypes(featureTree, dependencyGraph.nodesById);

    return {
      ...part,
      id: partId,
      featureTree,
      primitives: compatibilityPrimitives(featureTree),
      features: compatibilityFeatures(featureTree)
    };
  });

  normalizeNativeGearPairPhases(normalized);

  return normalized;
}

function normalizeNativeGearPairPhases(plan) {
  const parts = new Map((plan.parts || []).map((part) => [part.id, part]));
  for (const constraint of plan.constraints || []) {
    if (constraint?.type !== "gear") continue;
    const from = parts.get(constraint.from?.partId);
    const to = parts.get(constraint.to?.partId);
    const fromGear = from?.featureTree?.find((feature) => feature.type === "base_spur_gear");
    const toGear = to?.featureTree?.find((feature) => feature.type === "base_spur_gear");
    if (!fromGear || !toGear) continue;
    const module = Number(fromGear.params?.module);
    const toModule = Number(toGear.params?.module);
    const fromTeeth = Number(fromGear.params?.teeth);
    const toTeeth = Number(toGear.params?.teeth);
    const fromTranslate = Array.isArray(from.pose?.translate) ? from.pose.translate.map(Number) : [0, 0, 0];
    const toTranslate = Array.isArray(to.pose?.translate) ? to.pose.translate.map(Number) : [0, 0, 0];
    const fromRotate = Array.isArray(from.pose?.rotate) ? from.pose.rotate.map(Number) : [0, 0, 0];
    if (![module, toModule, fromTeeth, toTeeth, ...fromTranslate, ...toTranslate, ...fromRotate].every(Number.isFinite)) continue;
    const expectedDistance = module * (fromTeeth + toTeeth) / 2;
    const dx = toTranslate[0] - fromTranslate[0];
    const dy = toTranslate[1] - fromTranslate[1];
    if (Math.abs(module - toModule) > 1e-9 || Math.abs(dy) > 1e-9 || dx <= 0 || Math.abs(dx - expectedDistance) > 1e-6) continue;
    if (Math.abs(fromRotate[2]) > 1e-9) continue;
    const rotate = Array.isArray(to.pose?.rotate) ? [...to.pose.rotate] : [0, 0, 0];
    rotate[2] = 180 / toTeeth;
    to.pose = { ...(to.pose || {}), rotate };
  }
}

function normalizeDuplicateRootPose(part, nodes) {
  if (!isPlainObject(part.pose)) return nodes;
  const rootIndex = nodes.findIndex((node) => COMPAT_BASE_TYPES.has(node.type));
  if (rootIndex < 0 || !samePose(part.pose, nodes[rootIndex].params?.pose)) return nodes;
  return nodes.map((node, index) => {
    if (index !== rootIndex) return node;
    const normalized = structuredClone(node);
    delete normalized.params.pose;
    return normalized;
  });
}

function samePose(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  return ["translate", "rotate"].every((key) =>
    Array.isArray(left[key])
    && Array.isArray(right[key])
    && left[key].length === 3
    && right[key].length === 3
    && left[key].every((value, index) => Number(value) === Number(right[key][index]))
  );
}

export function preflightExtrudeProfiles(plan, { canonicalizePartId = (value) => value } = {}) {
  if (!isPlainObject(plan) || !Array.isArray(plan.parts)) return;

  for (const [partIndex, part] of plan.parts.entries()) {
    if (!isPlainObject(part)) continue;
    if (part.mode === "standard_part") continue;
    const partId = canonicalizePartId(normalizePartId(part, partIndex));
    let sourceNodes;
    try {
      sourceNodes = Object.hasOwn(part, "featureTree")
        ? (Array.isArray(part.featureTree) ? part.featureTree : [])
        : [
            ...normalizeLegacyPrimitives(Array.isArray(part.primitives) ? part.primitives : undefined),
            ...normalizeLegacyFeatures(Array.isArray(part.features) ? part.features : undefined)
          ];
    } catch {
      continue;
    }

    const counters = new Map();
    reserveExplicitIds(partId, sourceNodes, counters);
    for (const node of sourceNodes) {
      if (!isPlainObject(node) || typeof node.type !== "string" || !node.type.trim()) continue;
      const type = LEGACY_BASE_TYPES.get(node.type) || node.type;
      let featureId;
      try {
        featureId = normalizeFeatureId(partId, node.id, featureCategory(type), counters);
      } catch {
        continue;
      }
      if (type !== "add_extrude" && type !== "cut_extrude") continue;
      if (node.params !== undefined && !isPlainObject(node.params)) continue;
      const params = {
        ...copyLegacyParams(node),
        ...(node.params ? structuredClone(node.params) : {})
      };
      if (params.profile === undefined) continue;
      validateExtrudeProfileEligibility(params.profile, featureId, type);
    }
  }
}

export function normalizeFeatureNode(partId, node, index = 0, counters = new Map()) {
  if (!isPlainObject(node)) {
    throw new TypeError(`Feature node at index ${index} must be an object`);
  }

  if (typeof node.type !== "string" || !node.type.trim()) {
    throw new TypeError(`Feature node at index ${index} type must be a non-empty string`);
  }
  const type = LEGACY_BASE_TYPES.get(node.type) || node.type;
  if (!SUPPORTED_TYPES.has(type)) {
    throw new Error(`Unsupported feature type: ${String(node.type)}`);
  }
  if (node.enabled !== undefined && typeof node.enabled !== "boolean") {
    throw new TypeError(`Feature ${node.id || index} enabled must be a boolean`);
  }
  if (node.dependsOn !== undefined && !isStringArray(node.dependsOn)) {
    throw new TypeError(`Feature ${node.id || index} dependsOn must be an array of IDs`);
  }
  if (node.params !== undefined && !isPlainObject(node.params)) {
    throw new TypeError(`Feature ${node.id || index} params must be an object`);
  }
  if (node.selector !== undefined && !isPlainObject(node.selector) && type !== "fillet" && type !== "chamfer") {
    throw new TypeError(`Feature ${node.id || index} selector must be an object`);
  }
  if (node.name !== undefined && (typeof node.name !== "string" || !node.name.trim())) {
    throw new TypeError(`Feature ${node.id || index} name must be a non-empty string`);
  }

  const category = featureCategory(type);
  const id = normalizeFeatureId(partId, node.id, category, counters);
  const params = {
    ...copyLegacyParams(node),
    ...(node.params ? structuredClone(node.params) : {})
  };
  if (COMPAT_BASE_TYPES.has(type)) normalizePrimitivePlacement(params, id);
  if (type === "add_primitive" && isPlainObject(params.primitive)) {
    normalizePrimitivePlacement(params.primitive, id);
  }
  if (type === "fillet" || type === "chamfer") {
    delete params.size;
    delete params.dimensions;
  }
  if (type === "dimension" && params.name === undefined && node.name !== undefined) {
    params.name = node.name;
  }
  if (type === "dimension" && params.value === undefined) {
    const scalarValues = Object.entries(params)
      .filter(([name, value]) => name !== "name" && Number.isFinite(value))
      .map(([, value]) => value);
    if (scalarValues.length && scalarValues.every((value) => value === scalarValues[0])) {
      params.value = scalarValues[0];
    }
  }
  const dependsOn = [...new Set(node.dependsOn || [])];
  if (
    (type === "linear_pattern" || type === "circular_pattern")
    && params.sourceFeatureId === undefined
    && dependsOn.length === 1
  ) {
    params.sourceFeatureId = dependsOn[0];
  }
  const selector = type === "fillet" || type === "chamfer"
    ? normalizeFinishSelector(node.selector ?? params.selector ?? params.edgeSelector)
    : node.selector;
  if (type === "fillet" || type === "chamfer") {
    delete params.selector;
    delete params.edgeSelector;
  }
  validateFunctionalDimensions(params, id, type);
  validateFeatureParams(type, params, selector, dependsOn, id);

  const normalized = {
    id,
    type,
    enabled: node.enabled ?? true,
    dependsOn,
    params
  };
  if (node.name !== undefined) normalized.name = node.name;
  if (selector !== undefined) {
    normalized.selector = structuredClone(selector);
  }
  return normalized;
}

function validatePatternSourceTypes(nodes, nodesById) {
  for (const node of nodes) {
    if (node.type !== "linear_pattern" && node.type !== "circular_pattern") continue;
    const source = nodesById.get(node.params.sourceFeatureId);
    if (!source) continue;
    if (source.type.startsWith("base_") || INVALID_PATTERN_SOURCE_TYPES.has(source.type)) {
      throw new Error(`Feature ${node.id} has unsupported pattern source type: ${source.type}`);
    }
  }
}

export function resolveDimensionRefs(plan) {
  if (!isPlainObject(plan)) {
    throw new TypeError("Parametric plan must be an object");
  }

  const cloned = structuredClone(plan);
  for (const part of cloned.parts || []) {
    const partId = part.id || "unknown";
    const dimensions = new Map();
    for (const node of part.featureTree || []) {
      if (node.type !== "dimension") continue;
      const name = node.params?.name;
      if (typeof name !== "string" || !name.trim()) {
        throw new Error(`Dimension ${node.id || "node"} requires a name`);
      }
      if (dimensions.has(name)) {
        throw new Error(`Duplicate dimension name ${name} in part ${partId}`);
      }
      dimensions.set(name, node.params?.value);
    }

    const resolvedDimensions = new Map();
    const resolving = new Set();
    const resolveDimension = (name) => {
      if (resolvedDimensions.has(name)) return resolvedDimensions.get(name);
      if (!dimensions.has(name)) throw new Error(`Part ${partId} missing dimension reference: ${name}`);
      if (resolving.has(name)) throw new Error(`Dimension reference cycle involving ${name} in part ${partId}`);
      resolving.add(name);
      const resolved = replaceDimensionRefs(dimensions.get(name), resolveDimension);
      resolving.delete(name);
      resolvedDimensions.set(name, resolved);
      return resolved;
    };

    for (const node of part.featureTree || []) {
      node.params = replaceDimensionRefs(node.params || {}, resolveDimension);
      if (node.selector !== undefined) {
        node.selector = replaceDimensionRefs(node.selector, resolveDimension);
      }
      validateFunctionalDimensions(node.params, node.id, node.type);
      validateFeatureParams(node.type, node.params, node.selector, node.dependsOn || [], node.id);
    }
    part.primitives = compatibilityPrimitives(part.featureTree || []);
    part.features = compatibilityFeatures(part.featureTree || []);
  }
  return cloned;
}

export function buildDependencyGraph(nodes) {
  if (!Array.isArray(nodes)) {
    throw new TypeError("Dependency graph nodes must be an array");
  }

  const nodesById = new Map();
  const positions = new Map();
  for (const [index, node] of nodes.entries()) {
    if (!isPlainObject(node) || typeof node.id !== "string" || !node.id) {
      throw new Error(`Dependency node at index ${index} requires an ID`);
    }
    if (nodesById.has(node.id)) {
      throw new Error(`Duplicate feature ID: ${node.id}`);
    }
    nodesById.set(node.id, node);
    positions.set(node.id, index);
  }

  const dependencies = new Map();
  const reverseDependencies = new Map(
    [...nodesById.keys()].map((id) => [id, []])
  );
  const indegree = new Map();

  for (const node of nodes) {
    if (node.dependsOn !== undefined && !isStringArray(node.dependsOn)) {
      throw new TypeError(`Feature ${node.id} dependsOn must be an array of IDs`);
    }
    const nodeDependencies = [...new Set(node.dependsOn || [])];
    for (const dependencyId of nodeDependencies) {
      if (!nodesById.has(dependencyId)) {
        throw new Error(`Missing dependency ${dependencyId} for feature ${node.id}`);
      }
      reverseDependencies.get(dependencyId).push(node.id);
    }
    dependencies.set(node.id, nodeDependencies);
    indegree.set(node.id, nodeDependencies.length);
  }

  const ready = nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  const topologicalOrder = [];
  while (ready.length) {
    ready.sort((left, right) => positions.get(left) - positions.get(right));
    const id = ready.shift();
    topologicalOrder.push(id);
    for (const dependentId of reverseDependencies.get(id)) {
      const nextIndegree = indegree.get(dependentId) - 1;
      indegree.set(dependentId, nextIndegree);
      if (nextIndegree === 0) ready.push(dependentId);
    }
  }

  if (topologicalOrder.length !== nodes.length) {
    const cyclicIds = nodes
      .map((node) => node.id)
      .filter((id) => indegree.get(id) > 0);
    throw new Error(`Dependency cycle detected: ${cyclicIds.join(", ")}`);
  }

  return {
    nodesById,
    dependencies,
    reverseDependencies,
    topologicalOrder,
    topologicalNodes: topologicalOrder.map((id) => nodesById.get(id))
  };
}

export function checksumParametricPart(part) {
  return createHash("sha256").update(canonicalJson(part)).digest("hex");
}

function normalizeLegacyPrimitives(primitives) {
  if (primitives === undefined) return [];
  if (!Array.isArray(primitives)) throw new TypeError("Part primitives must be an array");
  return primitives.map((primitive, index) => {
    validateLegacyNodeType(primitive, "primitive", index);
    return {
      ...structuredClone(primitive),
      type: LEGACY_BASE_TYPES.get(primitive.type) || primitive.type
    };
  });
}

function normalizeAdditionalBaseNodes(nodes) {
  let hasBase = false;
  return nodes.map((node) => {
    if (!COMPAT_BASE_TYPES.has(node.type)) return node;
    if (!hasBase) {
      hasBase = true;
      return node;
    }
    const primitiveParams = structuredClone(node.params);
    if (node.type === "base_sphere" && primitiveParams.radius === undefined && primitiveParams.diameter !== undefined) {
      primitiveParams.radius = primitiveParams.diameter / 2;
      delete primitiveParams.diameter;
    }
    return {
      ...node,
      type: "add_primitive",
      params: {
        primitive: {
          type: COMPAT_BASE_TYPES.get(node.type),
          ...primitiveParams
        }
      }
    };
  });
}

function normalizeLegacyFeatures(features) {
  if (features === undefined) return [];
  if (!Array.isArray(features)) throw new TypeError("Part features must be an array");
  return features.map((feature, index) => {
    validateLegacyNodeType(feature, "feature", index);
    const migrated = {
      ...structuredClone(feature),
      type: LEGACY_FEATURE_TYPES.get(feature?.type) || feature?.type
    };
    if (["fillet", "chamfer"].includes(migrated.type) && migrated.selector === undefined) {
      migrated.selector = { kind: "legacy_all_edges" };
    }
    return migrated;
  });
}

function normalizePartId(part, index) {
  if (typeof part.id === "string" && part.id.trim()) return part.id;
  const slug = String(part.name || "part")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "part"}-${String(index + 1).padStart(2, "0")}`;
}

function normalizeFeatureId(partId, explicitId, category, counters) {
  if (explicitId !== undefined && (typeof explicitId !== "string" || !explicitId.trim())) {
    throw new TypeError("Feature ID must be a non-empty string");
  }

  if (explicitId) {
    if (!explicitId.startsWith(`${partId}.`)) {
      throw new Error(`Feature ID ${explicitId} is outside part namespace ${partId}`);
    }
    const escapedPartId = escapeRegExp(partId);
    const escapedCategory = escapeRegExp(category);
    const match = explicitId.match(new RegExp(`^${escapedPartId}\\.${escapedCategory}\\.(\\d+)$`));
    if (match) setCounter(counters, category, Math.max(getCounter(counters, category), Number(match[1])));
    return explicitId;
  }

  const next = getCounter(counters, category) + 1;
  let available = next;
  let candidate = `${partId}.${category}.${String(available).padStart(2, "0")}`;
  while (counters.reservedIds?.has(candidate)) {
    available += 1;
    candidate = `${partId}.${category}.${String(available).padStart(2, "0")}`;
  }
  setCounter(counters, category, available);
  return candidate;
}

function reserveExplicitIds(partId, nodes, counters) {
  counters.reservedIds = new Set(
    nodes.filter((node) => typeof node?.id === "string").map((node) => node.id)
  );
  for (const node of nodes) {
    if (!isPlainObject(node) || typeof node.id !== "string") continue;
    const type = LEGACY_BASE_TYPES.get(node.type) || node.type;
    const category = featureCategory(type);
    const escapedPartId = escapeRegExp(partId);
    const escapedCategory = escapeRegExp(category);
    const match = node.id.match(new RegExp(`^${escapedPartId}\\.${escapedCategory}\\.(\\d+)$`));
    if (match) {
      setCounter(counters, category, Math.max(getCounter(counters, category), Number(match[1])));
    }
  }
}

function featureCategory(type) {
  return type.startsWith("base_") ? "base" : type;
}

function getCounter(counters, category) {
  if (counters instanceof Map) return Number(counters.get(category) || 0);
  return Number(counters?.[category] || 0);
}

function setCounter(counters, category, value) {
  if (counters instanceof Map) counters.set(category, value);
  else counters[category] = value;
}

function copyLegacyParams(node) {
  const params = {};
  for (const [key, value] of Object.entries(node)) {
    if (!NODE_FIELDS.has(key)) params[key] = structuredClone(value);
  }
  return params;
}

function validateFunctionalDimensions(value, featureId, featureType = "", path = []) {
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const currentPath = [...path, key];
    if (POSITIVE_SCALAR_NAMES.has(key)) {
      if (isDimensionReference(nested)) continue;
      if (typeof nested !== "number" || !Number.isFinite(nested)) {
        throw new TypeError(`Feature ${featureId} ${currentPath.join(".")} must be a number or dimension reference`);
      }
      if (nested <= 0) {
        if (nested === 0 && featureType === "base_spur_gear" && (key === "boreRadius" || key === "boreDiameter")) continue;
        throw new Error(`Feature ${featureId} ${currentPath.join(".")} must be positive`);
      }
      if (key === "count" && !Number.isInteger(nested)) {
        throw new Error(`Feature ${featureId} count must be a positive integer`);
      }
    } else if (POSITIVE_ARRAY_NAMES.has(key)) {
      if (!Array.isArray(nested) || !nested.length || nested.some((item) =>
        !isDimensionReference(item) && (typeof item !== "number" || !Number.isFinite(item) || item <= 0)
      )) {
        throw new Error(`Feature ${featureId} ${currentPath.join(".")} values must be positive`);
      }
    } else if (isPlainObject(nested)) {
      validateFunctionalDimensions(nested, featureId, featureType, currentPath);
    }
  }
}

function validateFeatureParams(type, params, selector, dependsOn, featureId) {
  const requireParam = (name) => {
    if (params[name] === undefined) throw new Error(`Feature ${featureId} ${type} requires ${name}`);
  };

  if (type === "base_spur_gear") {
    requireParam("module");
    requireParam("teeth");
    requireParam("width");
    if (!Number.isInteger(params.teeth) || params.teeth < 6) {
      throw new Error(`Feature ${featureId} base_spur_gear teeth must be an integer of at least 6`);
    }
  }

  if (type === "base_ellipsoid") {
    requireParam("radii");
  }

  if (type === "add_extrude" || type === "cut_extrude") {
    requireParam("profile");
    requireParam("depth");
    validateParametricProfile(params.profile, featureId, type);
  }
  if (type === "linear_pattern" || type === "circular_pattern") {
    requireParam("sourceFeatureId");
    requireParam("count");
    if (typeof params.sourceFeatureId !== "string" || !params.sourceFeatureId.trim()) {
      throw new TypeError(`Feature ${featureId} ${type} sourceFeatureId must be a non-empty string`);
    }
    if (!dependsOn.includes(params.sourceFeatureId)) {
      throw new Error(`Feature ${featureId} sourceFeatureId must be listed in dependsOn`);
    }
    if (!isDimensionReference(params.count) && params.count < 2) {
      throw new Error(`Feature ${featureId} ${type} count must be at least 2`);
    }
    if (type === "linear_pattern") requireParam("spacing");
    else {
      requireParam("angle");
      if (!isDimensionReference(params.angle) && params.angle > 360) {
        throw new Error(`Feature ${featureId} circular_pattern angle must be at most 360`);
      }
    }
  }
  if (type === "add_primitive") {
    requireParam("primitive");
    if (!isPlainObject(params.primitive) || !LEGACY_BASE_TYPES.has(params.primitive.type)) {
      throw new Error(`Feature ${featureId} add_primitive requires a supported primitive`);
    }
  }
  if (type === "fillet" || type === "chamfer") {
    requireParam(type === "fillet" ? "radius" : "distance");
    if (!isValidSelector(selector)) {
      throw new Error(`Feature ${featureId} ${type} requires a valid selector`);
    }
  }
  if (type === "dimension") {
    if (typeof params.name !== "string" || !params.name.trim()) {
      throw new Error(`Feature ${featureId} dimension requires a name`);
    }
    requireParam("value");
  }
}

function normalizePrimitivePlacement(primitive, featureId) {
  if (!Array.isArray(primitive.center)) return;
  if (primitive.center.length !== 3 || primitive.center.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError(`Feature ${featureId} primitive center must contain three finite coordinates`);
  }
  const translate = primitive.pose?.translate;
  if (translate !== undefined && (!Array.isArray(translate) || translate.length !== 3)) {
    throw new TypeError(`Feature ${featureId} primitive pose.translate must contain three coordinates`);
  }
  if (Array.isArray(translate) && translate.some((value, index) => Number(value) !== primitive.center[index])) {
    throw new Error(`Feature ${featureId} has conflicting primitive center and pose.translate`);
  }
  primitive.pose = {
    ...(isPlainObject(primitive.pose) ? primitive.pose : {}),
    translate: [...primitive.center]
  };
}

function validateParametricProfile(profile, featureId, featureType) {
  if (!isPlainObject(profile) || typeof profile.type !== "string" || !profile.type.trim()) {
    throw new TypeError(`Feature ${featureId} ${featureType} profile requires a type`);
  }
  const requireProfileParam = (name) => {
    if (profile[name] === undefined) {
      throw new Error(`Feature ${featureId} ${featureType} ${profile.type} profile requires ${name}`);
    }
  };

  if (profile.type === "rectangle") {
    requireProfileParam("width");
    requireProfileParam("height");
  } else if (profile.type === "rounded_rectangle") {
    requireProfileParam("width");
    requireProfileParam("height");
    requireProfileParam("cornerRadius");
    if (
      typeof profile.width === "number"
      && typeof profile.height === "number"
      && typeof profile.cornerRadius === "number"
      && profile.cornerRadius * 2 >= Math.min(profile.width, profile.height)
    ) {
      throw new Error(`Feature ${featureId} ${featureType} rounded_rectangle cornerRadius must be less than half its width and height`);
    }
  } else if (profile.type === "circle") {
    if (profile.radius === undefined && profile.diameter === undefined) {
      throw new Error(`Feature ${featureId} ${featureType} circle profile requires radius or diameter`);
    }
  } else if (profile.type === "slot") {
    requireProfileParam("length");
    if (profile.width === undefined && profile.diameter === undefined) {
      throw new Error(`Feature ${featureId} ${featureType} slot profile requires width or diameter`);
    }
  } else if (profile.type === "polygon") {
    if (!Array.isArray(profile.points) || profile.points.length < 3 || profile.points.some((point) =>
      !Array.isArray(point) || point.length !== 2 || point.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
    )) {
      throw new Error(`Feature ${featureId} ${featureType} polygon profile requires at least three 2D points`);
    }
  } else {
    throw new Error(`Feature ${featureId} ${featureType} has unsupported parametric profile: ${profile.type}`);
  }
  validateFunctionalDimensions(profile, featureId, "", ["profile"]);
}

function validateExtrudeProfileEligibility(profile, featureId, featureType) {
  if (!isPlainObject(profile) || typeof profile.type !== "string" || !profile.type.trim()) {
    throw new TypeError(`Feature ${featureId} ${featureType} profile requires a type`);
  }
  if (!["rectangle", "rounded_rectangle", "circle", "slot", "polygon"].includes(profile.type)) {
    throw new Error(`Feature ${featureId} ${featureType} has unsupported parametric profile: ${profile.type}`);
  }
}

function isValidSelector(selector) {
  if (!isPlainObject(selector) || typeof selector.kind !== "string") return false;
  if (selector.kind === "legacy_all_edges") return Object.keys(selector).length === 1;
  if (selector.kind === "axis_position") {
    return typeof selector.axis === "string"
      && ["x", "y", "z"].includes(selector.axis.toLowerCase())
      && typeof selector.position === "number"
      && Number.isFinite(selector.position);
  }
  return false;
}

function normalizeFinishSelector(selector) {
  if (selector === undefined || selector === null || selector === "") {
    return { kind: "legacy_all_edges" };
  }
  if (typeof selector === "string") {
    return isAllEdgesAlias(selector) ? { kind: "legacy_all_edges" } : selector;
  }
  if (!isPlainObject(selector)) return selector;

  const kind = typeof selector.kind === "string" ? selector.kind.trim().toLowerCase() : "";
  if (kind === "legacy_all_edges" && Object.keys(selector).length === 1) {
    return { kind: "legacy_all_edges" };
  }
  if (isAllEdgesAlias(kind) || kind === "feature") {
    return { kind: "legacy_all_edges" };
  }
  if (kind === "named" && isAllEdgesAlias(selector.name)) {
    return { kind: "legacy_all_edges" };
  }
  if (!kind && Array.isArray(selector.tags) && selector.tags.length) {
    return { kind: "legacy_all_edges" };
  }
  if (kind === "axis_position") {
    const position = typeof selector.position === "string" && selector.position.trim()
      ? Number(selector.position)
      : selector.position;
    return {
      kind: "axis_position",
      axis: selector.axis,
      position
    };
  }
  return selector;
}

function isAllEdgesAlias(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return new Set([
    "all",
    "edge",
    "edges",
    "all_edge",
    "all_edges",
    "outer_edge",
    "outer_edges",
    "external_edges",
    "perimeter_edges",
    "decorative_edges"
  ]).has(normalized);
}

function validateLegacyContainer(value, field, partId) {
  if (value !== undefined && !Array.isArray(value)) {
    throw new TypeError(`Part ${partId} ${field} must be an array`);
  }
}

function validateLegacyNodeType(node, label, index) {
  if (!isPlainObject(node)) throw new TypeError(`Legacy ${label} at index ${index} must be an object`);
  if (typeof node.type !== "string" || !node.type.trim()) {
    throw new TypeError(`Legacy ${label} at index ${index} type must be a non-empty string`);
  }
}

function compatibilityPrimitives(nodes) {
  return nodes
    .filter((node) => node.enabled && COMPAT_BASE_TYPES.has(node.type))
    .map((node) => {
      const primitive = {
        type: COMPAT_BASE_TYPES.get(node.type),
        ...structuredClone(node.params)
      };
      if (node.type === "base_sphere" && primitive.radius === undefined && primitive.diameter !== undefined) {
        primitive.radius = primitive.diameter / 2;
        delete primitive.diameter;
      }
      if (Array.isArray(primitive.center) && primitive.pose?.translate?.every((value, index) => Number(value) === Number(primitive.center[index]))) {
        delete primitive.pose;
      }
      if (node.name !== undefined) primitive.name = node.name;
      return primitive;
    });
}

function compatibilityFeatures(nodes) {
  return nodes
    .filter((node) => node.enabled && !COMPAT_BASE_TYPES.has(node.type) && node.type !== "dimension")
    .map((node) => {
      const feature = {
        type: COMPAT_FEATURE_TYPES.get(node.type) || node.type,
        ...structuredClone(node.params)
      };
      if (isPlainObject(feature.primitive) && Array.isArray(feature.primitive.center) && feature.primitive.pose?.translate?.every((value, index) => Number(value) === Number(feature.primitive.center[index]))) {
        delete feature.primitive.pose;
      }
      if (node.name !== undefined) feature.name = node.name;
      if (node.selector !== undefined) feature.selector = structuredClone(node.selector);
      return feature;
    });
}

function replaceDimensionRefs(value, resolveDimension) {
  if (typeof value === "string" && /^\$[A-Za-z_][A-Za-z0-9_.-]*$/.test(value)) {
    return structuredClone(resolveDimension(value.slice(1)));
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceDimensionRefs(item, resolveDimension));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, replaceDimensionRefs(nested, resolveDimension)])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isDimensionReference(value) {
  return typeof value === "string" && /^\$[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
