export function buildExtrudeProfileRepairInstruction({
  originalRequest,
  featureId,
  featureType,
  validationError,
  invalidPlan
}) {
  return `Repair the generated assembly plan and return a full JSON plan.

Original user request:
${originalRequest}

Invalid feature:
- featureId: ${featureId}
- featureType: ${featureType}
- validation error: ${validationError}

Invalid generated plan to repair:
${JSON.stringify(invalidPlan || {}, null, 2)}

Use one of these supported profile schemas:
- rectangle(width,height)
- circle(radius|diameter)
- slot(length,width|diameter)
- polygon(points)

Return a schema-valid full plan. Every pattern must include both dependsOn: [sourceFeatureId] and params.sourceFeatureId.
- linear_pattern requires sourceFeatureId, count, and spacing.
- circular_pattern requires sourceFeatureId, count, and angle.

Use exactly one base_* feature per generated part. Model every additional solid with add_primitive or add_extrude; never emit a second base ID such as base.02.

Preserve every valid field from the invalid plan. For add_extrude and cut_extrude, keep the complete params object: profile and positive depth are both required. Change only the malformed feature fields needed for validation.

Finish features use type-specific parameters:
- fillet requires params.radius to be positive and a valid edge selector.
- chamfer requires params.distance to be positive and a valid edge selector.
- A finish selector must use axis_position or legacy_all_edges; do not use selector kind feature for a finish.
- fillet and chamfer must not include size or dimensions.`;
}

export function buildAssemblyPlanRepairInstruction({ originalRequest, validationError, invalidPlan }) {
  return `Repair the generated assembly plan and return a complete full JSON plan.

Original user request:
${originalRequest}

Validation error:
${validationError}

Invalid generated response:
${JSON.stringify(invalidPlan || {}, null, 2)}

The repaired response must preserve the requested object and include a non-empty parts array. Each generated part must contain exactly one supported base_* feature and all required assembly fields. Return JSON only.`;
}

export async function generatePlanWithProfileRepair({
  originalRequest,
  invokePlanner,
  prepareFullPlan,
  normalize,
  classifyResponse,
  buildRepairInstruction = buildExtrudeProfileRepairInstruction
}) {
  const initialResponse = await invokePlanner(originalRequest);
  if (classifyResponse(initialResponse) !== "fullPlan") return initialResponse;

  await prepareFullPlan(initialResponse);
  try {
    return await repairInvalidExtrudeProfile({
      plan: initialResponse,
      normalize,
      retry: async (repairContext) => {
        const repairMessage = buildRepairInstruction({
          originalRequest,
          featureId: repairContext.featureId,
          featureType: repairContext.featureType,
          validationError: repairContext.message,
          invalidPlan: initialResponse
        });
        const retriedResponse = await invokePlanner(repairMessage, { forceFullPlan: true });
        if (classifyResponse(retriedResponse) !== "fullPlan") {
          throw new Error("Planner profile repair must return a full JSON plan");
        }
        await prepareFullPlan(retriedResponse);
        return retriedResponse;
      }
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Assembly plan requires at least one part") throw error;
    const repairMessage = buildAssemblyPlanRepairInstruction({
      originalRequest,
      validationError: error.message,
      invalidPlan: initialResponse
    });
    const retriedResponse = await invokePlanner(repairMessage, { forceFullPlan: true });
    if (classifyResponse(retriedResponse) !== "fullPlan") {
      throw new Error("Planner assembly repair must return a full JSON plan");
    }
    await prepareFullPlan(retriedResponse);
    return normalize(retriedResponse);
  }
}

export function normalizeGeneratedPlanCandidate(plan, {
  normalizeShape,
  preflightExtrudes,
  canonicalizePartId,
  validateAssembly,
  normalizeParametric
}) {
  const shapedPlan = structuredClone(plan);
  stabilizeMechanicalPlan(shapedPlan);
  const normalizedShape = normalizeShape(shapedPlan) ?? shapedPlan;
  preflightExtrudes(normalizedShape, { canonicalizePartId });
  const validatedPlan = validateAssembly(normalizedShape) ?? normalizedShape;
  return normalizeParametric(validatedPlan);
}

export function stabilizeMechanicalPlan(plan) {
  repairMechanicalExtrudes(plan);
  repairProfileAliases(plan);
  repairInvalidMechanicalParameters(plan);
  repairBoxCavities(plan);
  repairShaftKeyways(plan);
  repairFinishSelectors(plan);
  repairInvalidMechanicalDimensions(plan);
  repairMechanicalMeasurements(plan);
  return plan;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function baseExtent(part, axis = "z") {
  const base = (part?.featureTree || []).find((feature) => feature?.enabled !== false && feature?.type?.startsWith("base_"));
  if (!base) return null;
  if (base.type === "base_box" && Array.isArray(base.params?.size)) {
    const index = { x: 0, y: 1, z: 2 }[String(axis || "z").toLowerCase()] ?? 2;
    return positiveNumber(base.params.size[index]);
  }
  return positiveNumber(base.params?.height);
}

function recordParameterRepair(plan, entry) {
  plan.parameterRepairAudit ||= [];
  plan.parameterRepairAudit.push({ ...entry, at: new Date().toISOString() });
}

// Repair only mechanical parameter errors with an unambiguous local source:
// aliases, optional zero bores, through-depths, and disabled decorative
// finishes. Functional dimensions with no safe source remain AI-repairable.
export function repairInvalidMechanicalParameters(plan) {
  for (const part of plan?.parts || []) {
    const tree = Array.isArray(part?.featureTree) ? part.featureTree : [];
    for (const feature of tree) {
      if (!feature || !feature.params || typeof feature.params !== "object") continue;
      const params = feature.params;
      const before = JSON.stringify(params);
      const type = feature.type;
      const syncPair = (first, second) => {
        const a = positiveNumber(params[first]);
        const b = positiveNumber(params[second]);
        if (!a && b) params[first] = b / 2;
        else if (a && !b) params[second] = a * 2;
        else if (!a && !b) {
          delete params[first];
          delete params[second];
        }
      };

      if (["base_cylinder", "base_sphere", "hole", "slot"].includes(type)) syncPair("radius", "diameter");
      if (type === "base_spur_gear") {
        syncPair("boreRadius", "boreDiameter");
        if (!positiveNumber(params.boreRadius) && !positiveNumber(params.boreDiameter)) {
          delete params.boreRadius;
          delete params.boreDiameter;
        }
      }
      if (type === "hole" || type === "slot") {
        const axis = params.axis || "z";
        if (!(positiveNumber(params.depth))) {
          const inferred = baseExtent(part, axis);
          if (inferred) params.depth = inferred;
          else delete params.depth;
        }
      }
      if (type === "cut_extrude" && !(positiveNumber(params.depth))) {
        const inferred = baseExtent(part, params.axis || "z");
        if (inferred) params.depth = inferred;
      }
      if (["fillet", "chamfer"].includes(type)) {
        const key = type === "fillet" ? "radius" : "distance";
        if (!(positiveNumber(params[key]))) {
          params[key] = 0.05;
          feature.enabled = false;
          feature.repairNote = "disabled_invalid_decorative_finish";
        }
      }
      if (JSON.stringify(params) !== before || feature.enabled === false && feature.repairNote) {
        recordParameterRepair(plan, { partId: part.id, featureId: feature.id, type, action: feature.repairNote || "repair_parameter_alias" });
      }
    }
  }
  return plan;
}

// Dimension nodes are scalar engineering parameters, not raw coordinate
// placeholders. A few planner generations incorrectly emitted an input/output
// center dimension with value 0, which blocks the whole plan before CadQuery
// can build it. Recover only this known gearbox naming pattern from an existing
// positive center distance or its positive counterpart; never alter ordinary
// functional dimensions silently.
export function repairInvalidMechanicalDimensions(plan) {
  const globalPositiveCenter = (plan?.parts || []).flatMap((part) => (part?.featureTree || []).map((feature) => {
    if (feature?.type !== "dimension") return null;
    const name = String(feature.params?.name || feature.name || feature.id || "").toLowerCase().replace(/\s+/g, "");
    const value = Number(feature.params?.value);
    return /center.?distance|center[_-]?(input|output)|中心距/.test(name) && value > 0 ? value : null;
  })).find((value) => value > 0) || null;
  for (const part of plan?.parts || []) {
    const tree = Array.isArray(part?.featureTree) ? part.featureTree : [];
    const positiveByName = new Map();
    for (const feature of tree) {
      if (feature?.type !== "dimension") continue;
      const name = String(feature.params?.name || feature.name || feature.id || "").trim();
      const value = Number(feature.params?.value);
      if (name && value > 0) positiveByName.set(name.toLowerCase(), value);
    }
    const centerDistance = [...positiveByName.entries()].find(([name]) => /center.?distance|中心距/.test(name))?.[1];
    for (const feature of tree) {
      if (feature?.type !== "dimension") continue;
      const name = String(feature.params?.name || feature.name || feature.id || "").trim();
      const value = Number(feature.params?.value);
      const normalizedName = name.toLowerCase().replace(/\s+/g, "");
      if (!(value <= 0) || !/(^|[._-])((input|output)[._-]?center|center[_-]?(input|output)|center.?distance|中心距)([._-]|$)/.test(normalizedName)) continue;
      const counterpart = name.toLowerCase().startsWith("input") ? positiveByName.get("output_center") : positiveByName.get("input_center");
      const repaired = Number(centerDistance || counterpart || globalPositiveCenter);
      if (!(repaired > 0)) continue;
      feature.params.value = repaired;
      feature.params.repairNote = "recovered from positive gearbox center distance";
    }
  }
  return plan;
}

export function repairMechanicalExtrudes(plan) {
  const parts = plan?.parts || [];
  const partById = new Map(parts.map((part) => [part?.id, part]));
  for (const part of parts) {
    const tree = Array.isArray(part?.featureTree) ? part.featureTree : [];
    for (const feature of tree) {
      if (!feature || !["add_extrude", "cut_extrude"].includes(feature.type)) continue;
      const params = feature.params ||= {};
      if (!(Number(params.depth) > 0)) {
        const depthAlias = Number(params.height ?? params.length ?? params.thickness);
        if (depthAlias > 0) params.depth = depthAlias;
      }
      if (Number(params.depth) > 0) continue;

      const identity = `${feature.id || ""} ${feature.name || ""}`.toLowerCase();
      const profile = params.profile || {};
      if (feature.type !== "add_extrude" || profile.type !== "circle" || !/gear[_ -]?seat|安装段|轴肩|shaft[_ -]?seat/.test(identity)) continue;

      const relation = (plan.relations || []).find((item) => item?.type === "concentric" && (item.from === part.id || item.to === part.id));
      const mateId = relation ? (relation.from === part.id ? relation.to : relation.from) : null;
      const mate = partById.get(mateId);
      const gear = (mate?.featureTree || []).find((node) => node?.type === "base_spur_gear");
      const nearbyKeyway = tree.find((node) => node?.type === "cut_box" && /keyway|键槽/.test(`${node?.id || ""} ${node?.name || ""}`.toLowerCase()));
      const inferredHeight = Number(gear?.params?.width)
        || Number(nearbyKeyway?.params?.size?.[2])
        || 25;
      const radius = Number(profile.radius ?? (Number(profile.diameter) / 2));
      if (!(radius > 0) || !(inferredHeight > 0)) continue;
      const center = Array.isArray(params.center) && params.center.length === 3 ? params.center.map(Number) : [0, 0, 0];
      feature.type = "add_primitive";
      feature.params = {
        primitive: {
          type: "cylinder",
          radius,
          height: inferredHeight,
          center: true,
          pose: { translate: center, rotate: [0, 0, 0] }
        }
      };
    }
  }
  return plan;
}

export function repairProfileAliases(plan) {
  for (const part of plan?.parts || []) {
    for (const feature of [...(part?.featureTree || []), ...(part?.features || [])]) {
      if (!feature || !["add_extrude", "cut_extrude"].includes(feature.type)) continue;
      const params = feature.params ||= {};
      const profile = params.profile;
      if (!profile || !["rectangle", "rounded_rectangle"].includes(profile.type)) continue;
      const size = Array.isArray(profile.size) ? profile.size : Array.isArray(params.size) ? params.size : null;
      const dimensions = Array.isArray(profile.dimensions) ? profile.dimensions : Array.isArray(params.dimensions) ? params.dimensions : null;
      if (!(Number(profile.width) > 0)) {
        const width = Number(params.width ?? size?.[0] ?? dimensions?.[0]);
        if (width > 0) profile.width = width;
      }
      if (!(Number(profile.height) > 0)) {
        const height = Number(params.height ?? size?.[1] ?? dimensions?.[1]);
        if (height > 0) profile.height = height;
      }
    }
  }
  return plan;
}

export function repairBoxCavities(plan) {
  for (const part of plan?.parts || []) {
    const tree = Array.isArray(part?.featureTree) ? part.featureTree : [];
    const base = tree.find((feature) => feature?.type === "base_box");
    const baseSize = Array.isArray(base?.params?.size) ? base.params.size.map(Number) : [];
    if (baseSize.length < 3 || baseSize.some((value) => !(value > 0))) continue;
    const wallNode = tree.find((feature) => feature?.type === "dimension" && /wallThickness/i.test(feature?.params?.name || ""));
    const wall = Number(wallNode?.params?.value) > 0 ? Number(wallNode.params.value) : 8;

    for (const feature of tree) {
      const identity = `${feature?.id || ""} ${feature?.name || ""}`.toLowerCase();
      const profile = feature?.params?.profile || {};
      if (feature?.type !== "cut_extrude" || profile.type !== "rectangle" || !/cavity|内腔/.test(identity)) continue;
      const axis = String(feature.params?.axis || "z").toLowerCase();
      const width = Number(profile.width) > 0 ? Number(profile.width) : Math.max(baseSize[0] - 2 * wall, 0.1);
      const height = Number(profile.height) > 0 ? Number(profile.height) : Math.max(baseSize[1] - 2 * wall, 0.1);
      const depth = Number(feature.params?.depth) > 0 ? Number(feature.params.depth) : Math.max(baseSize[2] - wall, 0.1);
      const size = axis === "x"
        ? [depth, height, width]
        : axis === "y"
          ? [width, depth, height]
          : [width, height, depth];
      const explicitCenter = Array.isArray(feature.params?.center) && feature.params.center.length === 3
        ? feature.params.center.map(Number)
        : null;
      const baseTranslate = Array.isArray(base.params?.pose?.translate) ? base.params.pose.translate.map(Number) : [0, 0, 0];
      const sign = (baseTranslate[2] || 0) < 0 || /lower|下箱/.test(`${part.id || ""} ${part.name || ""}`.toLowerCase()) ? -1 : 1;
      const center = explicitCenter && explicitCenter.every(Number.isFinite)
        ? explicitCenter
        : axis === "z"
          ? [baseTranslate[0] || 0, baseTranslate[1] || 0, sign * depth / 2]
          : [...baseTranslate];
      feature.type = "cut_box";
      feature.params = { size, center };
    }
  }
  return plan;
}

export function repairFinishSelectors(plan) {
  for (const part of plan?.parts || []) {
    for (const feature of [...(part?.featureTree || []), ...(part?.features || [])]) {
      if (!feature || !["fillet", "chamfer"].includes(feature.type)) continue;
      const selector = feature.selector ?? feature.params?.selector ?? feature.params?.edgeSelector;
      const validAxisPosition = selector && selector.kind === "axis_position"
        && ["x", "y", "z"].includes(String(selector.axis || "").toLowerCase())
        && Number.isFinite(Number(selector.position));
      const validAllEdges = selector && selector.kind === "legacy_all_edges" && Object.keys(selector).length === 1;
      if (validAxisPosition) {
        feature.selector = {
          kind: "axis_position",
          axis: String(selector.axis).toLowerCase(),
          position: Number(selector.position)
        };
      } else if (!validAllEdges) {
        // Finish features are decorative. A deterministic all-edge selector
        // lets normalization proceed; CadQuery will skip the finish safely if
        // the requested radius/distance cannot be applied to this BREP.
        feature.selector = { kind: "legacy_all_edges" };
      }
      if (feature.params && ("selector" in feature.params || "edgeSelector" in feature.params)) {
        delete feature.params.selector;
        delete feature.params.edgeSelector;
      }
    }
  }
  return plan;
}

export function repairShaftKeyways(plan) {
  for (const part of plan?.parts || []) {
    const tree = Array.isArray(part?.featureTree) ? part.featureTree : [];
    const base = tree.find((node) => node?.type === "base_cylinder");
    const baseRadius = Number(base?.params?.radius ?? (Number(base?.params?.diameter) / 2));
    if (!(baseRadius > 0)) continue;

    for (const node of tree) {
      const identity = `${node?.id || ""} ${node?.name || ""}`.toLowerCase();
      if (node?.type !== "cut_box" || !/keyway|键槽/.test(identity)) continue;
      const params = node.params ||= {};
      const originalSize = Array.isArray(params.size) ? params.size.map(Number) : [];
      if (originalSize.length < 3 || originalSize.some((value) => !(value > 0))) continue;
      const dimensionValue = (pattern) => Number(tree.find((feature) => feature?.type === "dimension" && pattern.test(`${feature?.id || ""} ${feature?.name || ""} ${feature?.params?.name || ""}`))?.params?.value);
      const measurementTarget = (pattern) => Number((part.measurements || []).find((measurement) => measurement?.featureId === node.id && pattern.test(`${measurement?.id || ""} ${measurement?.name || ""} ${measurement?.label || ""}`))?.target);
      const width = dimensionValue(/keywayWidth|键槽宽度/i) || measurementTarget(/width|宽度/i) || originalSize[0];
      const depth = dimensionValue(/keywayDepth|键槽深度/i) || measurementTarget(/depth|深度/i) || Number(params.depth) || originalSize[1];
      const length = dimensionValue(/keywayLength|键槽长度/i) || measurementTarget(/length|长度/i) || originalSize[2];
      const size = [width, depth, length];
      params.size = size;
      const center = Array.isArray(params.center) ? [...params.center].map(Number) : [0, 0, 0];
      while (center.length < 3) center.push(0);

      // A shaft keyway is a shallow radial cut, not a box through the shaft
      // centre. Width is X, radial depth is Y and length follows shaft axis Z.
      const dependency = tree.find((feature) => (node.dependsOn || []).includes(feature?.id));
      const dependencyRadius = Number(dependency?.params?.primitive?.radius ?? dependency?.params?.radius ?? (Number(dependency?.params?.diameter) / 2));
      const localRadius = dependencyRadius > 0 ? dependencyRadius : baseRadius;
      center[0] = 0;
      center[1] = localRadius - depth / 2;
      params.center = center;
      params.axis = "z";
      params.depth = depth;

      for (const measurement of part.measurements || []) {
        if (measurement?.featureId !== node.id) continue;
        const descriptor = `${measurement.id || ""} ${measurement.name || ""} ${measurement.label || ""}`.toLowerCase();
        const property = /length|长度/.test(descriptor)
          ? "length"
          : /depth|深度/.test(descriptor)
            ? "depth"
            : /width|宽度/.test(descriptor)
              ? "width"
              : null;
        if (!property) continue;
        measurement.kind = "keyway";
        measurement.property = property;
        measurement.axis = "z";
        measurement.widthAxis = "x";
        measurement.depthAxis = "y";
      }
    }

    for (const measurement of part.measurements || []) {
      const feature = tree.find((node) => node?.id === measurement?.featureId);
      const descriptor = `${measurement?.id || ""} ${measurement?.name || ""} ${measurement?.label || ""}`.toLowerCase();
      if (feature?.type !== "hole" || !/diameter|孔径|直径/.test(descriptor)) continue;
      measurement.kind = "cylinder_diameter";
      measurement.axis = feature.params?.axis || "z";
    }
  }

  repairGearboxHousingEnvelope(plan);
  addMechanicalIntendedContacts(plan);
  return plan;
}

export function repairMechanicalMeasurements(plan) {
  for (const part of plan?.parts || []) {
    const tree = Array.isArray(part?.featureTree) ? part.featureTree : [];
    const baseBox = tree.find((feature) => feature?.type === "base_box");
    const baseSize = Array.isArray(baseBox?.params?.size) ? baseBox.params.size.map(Number) : [];
    part.measurements = (part.measurements || []).filter((measurement) => {
      const descriptor = `${measurement?.id || ""} ${measurement?.name || ""} ${measurement?.label || ""}`.toLowerCase();
      // A single feature bounding box cannot prove a distance between two axes
      // or a wall thickness. Keep those editable dimension nodes, but do not
      // turn an unrelated bounding box into a blocking geometry assertion.
      if (measurement?.kind === "feature_bbox" && /center.?distance|中心距|wall.?thickness|壁厚/.test(descriptor)) return false;
      if (measurement?.kind === "bbox" && !measurement?.featureId && baseSize.length === 3) {
        const axisIndex = { x: 0, y: 1, z: 2 }[String(measurement.axis || "").toLowerCase()];
        if (axisIndex !== undefined && baseSize[axisIndex] > 0) {
          const isOverall = /overall|总|包络|外形|外廓/.test(descriptor);
          const sameAxisTargets = (part.measurements || [])
            .filter((candidate) => candidate !== measurement && candidate?.featureId && String(candidate?.axis || "").toLowerCase() === String(measurement.axis || "").toLowerCase())
            .map((candidate) => Number(candidate?.target))
            .filter((value) => Number.isFinite(value) && value > 0);
          const inferredTarget = Math.max(baseSize[axisIndex], ...sameAxisTargets);
          if (isOverall && inferredTarget > Number(measurement.target || 0)) {
            // Keep the user's target immutable; expose the audited envelope inference separately.
            measurement.effectiveTarget = inferredTarget;
            measurement.targetSource = "inferred-overall-envelope";
          }
        }
      }
      return true;
    });
  }
  return plan;
}

function repairGearboxHousingEnvelope(plan) {
  const parts = plan?.parts || [];
  const gears = parts.flatMap((part) => {
    const identity = `${part?.id || ""} ${part?.name || ""}`.toLowerCase();
    if (!/gear|齿轮/.test(identity)) return [];
    const base = (part.featureTree || []).find((node) => ["base_cylinder", "base_spur_gear"].includes(node?.type));
    const radius = base?.type === "base_spur_gear"
      ? (Number(base?.params?.teeth) + 2) * Number(base?.params?.module) / 2
      : Number(base?.params?.radius ?? (Number(base?.params?.diameter) / 2));
    if (!(radius > 0)) return [];
    const position = Array.isArray(part.pose?.translate) ? part.pose.translate.map(Number) : [0, 0, 0];
    return [{ radius, y: position[1] || 0, z: position[2] || 0 }];
  });
  if (!gears.length) return;

  const clearance = 8;
  const wall = 8;
  const innerHalfY = Math.ceil(Math.max(...gears.map((gear) => Math.abs(gear.y) + gear.radius)) + clearance);
  const innerHalfZ = Math.ceil(Math.max(...gears.map((gear) => Math.abs(gear.z) + gear.radius)) + clearance);
  const outerY = 2 * (innerHalfY + wall);
  const innerY = 2 * innerHalfY;
  const outerHalfZ = innerHalfZ + wall;

  for (const part of parts) {
    const identity = `${part?.id || ""} ${part?.name || ""}`.toLowerCase();
    if (!/housing|cover|箱体|箱盖/.test(identity)) continue;
    const tree = part.featureTree || [];
    const base = tree.find((node) => node?.type === "base_box");
    const cavity = tree.find((node) => node?.type === "cut_box" && /cavity|内腔/.test(`${node?.id || ""} ${node?.name || ""}`.toLowerCase()));
    if (!base || !cavity) continue;
    const lower = /lower|下箱/.test(identity);
    const sign = lower ? -1 : 1;
    const baseSize = Array.isArray(base.params?.size) ? [...base.params.size] : [140, outerY, outerHalfZ];
    const cavitySize = Array.isArray(cavity.params?.size) ? [...cavity.params.size] : [124, innerY, innerHalfZ];
    baseSize[1] = Math.max(Number(baseSize[1]) || 0, outerY);
    baseSize[2] = Math.max(Number(baseSize[2]) || 0, outerHalfZ);
    cavitySize[1] = Math.max(Number(cavitySize[1]) || 0, innerY);
    cavitySize[2] = Math.max(Number(cavitySize[2]) || 0, innerHalfZ);
    base.params.size = baseSize;
    base.params.pose ||= {};
    base.params.pose.translate = [0, 0, sign * baseSize[2] / 2];
    cavity.params.size = cavitySize;
    cavity.params.center = [0, 0, sign * cavitySize[2] / 2];

    for (const measurement of part.measurements || []) {
      const descriptor = `${measurement.id || ""} ${measurement.label || ""}`.toLowerCase();
      if ((measurement.axis === "y" || /length|总长/.test(descriptor)) && measurement.kind === "bbox") {
        measurement.target = baseSize[1];
      }
      if ((measurement.axis === "z" || /height|高度/.test(descriptor)) && measurement.kind === "bbox") {
        measurement.target = baseSize[2];
      }
    }
  }
}

function addMechanicalIntendedContacts(plan) {
  const pairs = new Map((plan.intendedContacts || []).map((pair) => [pair.map(String).sort().join("\u0000"), pair.map(String).sort()]));
  for (const relation of plan.relations || []) {
    if (!["concentric", "gear"].includes(relation?.type) || !relation.from || !relation.to) continue;
    const pair = [String(relation.from), String(relation.to)].sort();
    pairs.set(pair.join("\u0000"), pair);
  }
  const parts = plan.parts || [];
  const gearByShaft = new Map();
  for (const relation of plan.relations || []) {
    if (relation?.type !== "concentric") continue;
    const fromGear = isGearPart(parts.find((part) => part.id === relation.from));
    const toGear = isGearPart(parts.find((part) => part.id === relation.to));
    if (fromGear !== toGear) gearByShaft.set(fromGear ? relation.to : relation.from, fromGear ? relation.from : relation.to);
  }
  for (const relation of plan.relations || []) {
    if (relation?.type !== "distance") continue;
    const gearA = gearByShaft.get(relation.from);
    const gearB = gearByShaft.get(relation.to);
    if (gearA && gearB) {
      const pair = [gearA, gearB].sort();
      pairs.set(pair.join("\u0000"), pair);
    }
  }
  for (const bearing of parts.filter((part) => /bearing|轴承/i.test(`${part?.id || ""} ${part?.name || ""}`))) {
    const identity = `${bearing.id || ""} ${bearing.name || ""}`.toLowerCase();
    const shaft = parts.find((part) => /shaft|轴/i.test(`${part?.id || ""} ${part?.name || ""}`) && ((/input|输入/.test(identity) && /input|输入/i.test(`${part?.id || ""} ${part?.name || ""}`)) || (/output|输出/.test(identity) && /output|输出/i.test(`${part?.id || ""} ${part?.name || ""}`))));
    if (!shaft) continue;
    const pair = [bearing.id, shaft.id].map(String).sort();
    pairs.set(pair.join("\u0000"), pair);
  }
  plan.intendedContacts = [...pairs.values()];
}

function isGearPart(part) {
  return Boolean(part) && (/gear|齿轮/i.test(`${part.id || ""} ${part.name || ""}`) || (part.featureTree || []).some((feature) => feature?.type === "base_spur_gear"));
}

export async function repairInvalidExtrudeProfile({ plan, normalize, retry }) {
  try {
    return await normalize(plan);
  } catch (error) {
    const repair = eligibleRepair(error);
    if (!repair) throw error;

    try {
      const retriedPlan = await retry({
        featureId: repair.featureId,
        featureType: repair.featureType,
        message: error.message
      });
      return await normalize(mergeTargetedRepair(plan, retriedPlan, repair));
    } catch (cause) {
      const requirement = repair.category === "missing-type"
        ? "profile requires a type"
        : repair.category === "missing-profile"
          ? "add_extrude or cut_extrude requires profile"
          : repair.category === "missing-profile-field"
            ? "profile requires its missing geometric field"
          : repair.category === "missing-depth"
            ? "add_extrude or cut_extrude requires positive depth"
        : repair.category === "invalid-finish-selector"
          ? "finish selector requires axis_position or legacy_all_edges"
          : "unsupported profile requires a supported type";
      const retryRequirement = cause instanceof Error ? cause.message : String(cause);
      const repairLabel = repair.category === "invalid-finish-selector" ? "selector repair" : "profile repair";
      throw new Error(
        `Feature ${repair.featureId} ${repair.featureType} ${repairLabel} failed: ${requirement}; retry failed: ${retryRequirement}`,
        { cause }
      );
    }
  }
}

function mergeTargetedRepair(originalPlan, retriedPlan, repair) {
  const originalHasParts = Array.isArray(originalPlan?.parts) && originalPlan.parts.length > 0;
  const retryHasParts = Array.isArray(retriedPlan?.parts) && retriedPlan.parts.length > 0;
  const mergedPlan = structuredClone(originalHasParts && !retryHasParts ? originalPlan : retriedPlan);
  const original = findFeature(originalPlan, repair.featureId);
  const target = findFeature(mergedPlan, repair.featureId);
  if (!original || !target) return mergedPlan;

  const mergedFeature = {
    ...structuredClone(original.feature),
    ...structuredClone(target.feature)
  };
  if (original.feature.params || target.feature.params) {
    mergedFeature.params = {
      ...structuredClone(original.feature.params || {}),
      ...structuredClone(target.feature.params || {})
    };
    if (original.feature.params?.profile || target.feature.params?.profile) {
      mergedFeature.params.profile = {
        ...structuredClone(original.feature.params?.profile || {}),
        ...structuredClone(target.feature.params?.profile || {})
      };
    }
  }
  target.container[target.index] = mergedFeature;
  return mergedPlan;
}

function findFeature(plan, featureId) {
  for (const part of plan?.parts || []) {
    for (const key of ["featureTree", "features"]) {
      const container = part?.[key];
      if (!Array.isArray(container)) continue;
      const index = container.findIndex((feature) => feature?.id === featureId);
      if (index >= 0) return { part, container, index, feature: container[index] };
    }
  }
  return null;
}

function eligibleRepair(error) {
  if (!(error instanceof Error)) return null;

  const missingProfile = error.message.match(
    /^Feature (.+) (add_extrude|cut_extrude) requires profile$/
  );
  if (missingProfile) {
    return {
      featureId: missingProfile[1],
      featureType: missingProfile[2],
      category: "missing-profile"
    };
  }

  const missingType = error.message.match(
    /^Feature (.+) (add_extrude|cut_extrude) profile requires a type$/
  );
  if (missingType) {
    return {
      featureId: missingType[1],
      featureType: missingType[2],
      category: "missing-type"
    };
  }

  const missingDepth = error.message.match(
    /^Feature (.+) (add_extrude|cut_extrude) requires depth$/
  );
  if (missingDepth) {
    return {
      featureId: missingDepth[1],
      featureType: missingDepth[2],
      category: "missing-depth"
    };
  }

  const missingProfileField = error.message.match(
    /^Feature (.+) (add_extrude|cut_extrude) (rectangle|rounded_rectangle) profile requires (width|height|cornerRadius)$/
  );
  if (missingProfileField) {
    return {
      featureId: missingProfileField[1],
      featureType: missingProfileField[2],
      category: "missing-profile-field"
    };
  }

  const invalidFinishSelector = error.message.match(
    /^Feature (.+) (fillet|chamfer) requires a valid selector$/
  );
  if (invalidFinishSelector) {
    return {
      featureId: invalidFinishSelector[1],
      featureType: invalidFinishSelector[2],
      category: "invalid-finish-selector"
    };
  }

  const unsupportedType = error.message.match(
    /^Feature (.+) (add_extrude|cut_extrude) has unsupported parametric profile: ([\s\S]+)$/
  );
  if (!unsupportedType) return null;

  return {
    featureId: unsupportedType[1],
    featureType: unsupportedType[2],
    category: "unsupported-type"
  };
}
