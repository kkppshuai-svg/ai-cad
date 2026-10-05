import { safePartId, sanitizeFeature, sanitizePose, sanitizePrimitive } from "./plan-validation.js";
import { sanitizeText } from "./text-utils.js";
import { validatePartComplexity } from "./plan-complexity.js";
import { assertAssemblyPartCount } from "./assembly-plan-limits.js";

export function validateAssemblyPlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("Assembly plan must be an object");
  assertAssemblyPartCount(plan.parts);
  for (const part of plan.parts) {
    if (!part.id || !part.name) throw new Error("Each part requires id and name");
    part.id = safePartId(part.id);
    part.name = sanitizeText(part.name, 120);
    part.role = sanitizeText(part.role || "", 240);
    part.mode = part.mode === "standard_part" ? "standard_part" : "generated";
    if (part.mode === "standard_part") {
      part.standardPart = sanitizeStandardPartRequest(part.standardPart || {});
      part.primitives = [];
      part.features = [];
      part.featureTree = [];
    } else {
      if (!Array.isArray(part.primitives) || part.primitives.length === 0) {
        part.primitives = [{ type: "box", size: [10, 10, 10], center: true }];
      }
      if (!Array.isArray(part.features)) part.features = [];
      validatePartComplexity(part);
      part.primitives = part.primitives.map(sanitizePrimitive);
      part.features = part.features.map(sanitizeFeature);
      part.standardPart = null;
    }
    part.pose = normalizePose(part.pose);
    part.inertial = normalizeInertial(part.inertial);
  }
  if (!Array.isArray(plan.relations)) plan.relations = [];
  plan.relations = plan.relations.slice(0, 24).map(sanitizeRelation);
  if (!Array.isArray(plan.joints)) plan.joints = [];
  plan.joints = normalizeJoints(plan.joints, plan.parts);
  if (!Array.isArray(plan.constraints)) plan.constraints = [];
  if (!plan.activePartId || !plan.parts.some((part) => part.id === plan.activePartId)) plan.activePartId = plan.parts[0].id;
  if (plan.activeFeatureId && !plan.parts.some((part) => (part.featureTree || []).some((feature) => feature.id === plan.activeFeatureId))) plan.activeFeatureId = null;
  plan.name = safeSlug(plan.name || "assembly");
  plan.reply = sanitizeText(plan.reply || "", 500);
}

function sanitizeStandardPartRequest(value = {}) {
  const provider = sanitizeText(value.provider || "step.parts", 40);
  if (provider !== "step.parts") throw new Error(`Unsupported standard part provider: ${provider}`);
  const request = {
    provider,
    id: sanitizeText(value.id || "", 120),
    query: sanitizeText(value.query || "", 160),
    category: sanitizeText(value.category || "", 80),
    family: sanitizeText(value.family || "", 80),
    standard: sanitizeText(value.standard || "", 80),
    tag: sanitizeText(value.tag || "", 80),
  };
  if (!request.id && !request.query && !request.category && !request.family && !request.standard && !request.tag) {
    throw new Error("step.parts standard part requires an id, query, or facet");
  }
  return request;
}

export function normalizePlanShape(plan) {
  if (plan.plan && typeof plan.plan === "object") {
    Object.assign(plan, plan.plan);
  }
  if (!Array.isArray(plan.parts)) {
    plan.parts = plan.components || plan.objects || plan.items || [];
  }
  for (const part of plan.parts || []) {
    if (!Array.isArray(part.primitives)) {
      if (part.primitive) part.primitives = [part.primitive];
      if (part.shape) part.primitives = [part.shape];
      if (part.geometry) part.primitives = [part.geometry];
    }
    if (!Array.isArray(part.features)) {
      part.features = part.operations || part.modifiers || [];
    }
  }
  if (!Array.isArray(plan.joints)) {
    plan.joints = [];
  }
}

export function normalizePose(pose = {}) {
  if (!pose || typeof pose !== "object") return { translate: [0, 0, 0], rotate: [0, 0, 0] };
  return sanitizePose(pose);
}

function normalizeVector(values, fallback) {
  const list = Array.isArray(values) ? values : [];
  return [0, 1, 2].map((index) => Number.isFinite(Number(list[index])) ? Number(list[index]) : fallback);
}

function sanitizeRelation(relation = {}) {
  return {
    type: sanitizeText(relation.type || "reference", 40),
    from: safePartId(relation.from || ""),
    to: safePartId(relation.to || ""),
    description: sanitizeText(relation.description || "", 240)
  };
}

export function normalizeInertial(inertial) {
  if (!inertial || typeof inertial !== "object") return null;
  const mass = Number(inertial.mass);
  if (!Number.isFinite(mass) || mass <= 0) return null;
  const inertia = inertial.inertia || {};
  return {
    mass,
    origin: {
      xyz: normalizeVector(inertial.origin?.xyz, 0),
      rpy: normalizeVector(inertial.origin?.rpy, 0)
    },
    inertia: {
      ixx: finiteNumber(inertia.ixx, mass * 0.001),
      ixy: finiteNumber(inertia.ixy, 0),
      ixz: finiteNumber(inertia.ixz, 0),
      iyy: finiteNumber(inertia.iyy, mass * 0.001),
      iyz: finiteNumber(inertia.iyz, 0),
      izz: finiteNumber(inertia.izz, mass * 0.001)
    }
  };
}

function normalizeJoints(joints, parts) {
  const partIds = new Set((parts || []).map((part) => part.id));
  return (joints || [])
    .map((joint, index) => {
      const child = String(joint.child || joint.to || "").trim();
      if (!child || !partIds.has(child)) return null;
      const parent = String(joint.parent || joint.from || "world").trim() || "world";
      const type = normalizeJointType(joint.type);
      const normalized = {
        id: safeKinematicName(joint.id || `${parent}_${child}_${type}_${index}`),
        type,
        parent: parent === "world" || partIds.has(parent) ? parent : "world",
        child,
        origin: {
          xyz: normalizeVector(joint.origin?.xyz || joint.xyz, 0),
          rpy: normalizeVector(joint.origin?.rpy || joint.rpy, 0)
        },
        axis: normalizeAxis(joint.axis)
      };
      if (type === "revolute" || type === "prismatic") {
        normalized.limit = normalizeLimit(joint.limit, type);
      }
      return normalized;
    })
    .filter(Boolean);
}

function normalizeJointType(value) {
  const type = String(value || "fixed").toLowerCase();
  return ["fixed", "revolute", "continuous", "prismatic"].includes(type) ? type : "fixed";
}

function normalizeAxis(values) {
  const axis = normalizeVector(values, 0);
  return axis.some((value) => value !== 0) ? axis : [0, 0, 1];
}

function normalizeLimit(limit = {}, type) {
  return {
    lower: finiteNumber(limit.lower, type === "prismatic" ? -0.1 : -1.57),
    upper: finiteNumber(limit.upper, type === "prismatic" ? 0.1 : 1.57),
    effort: finiteNumber(limit.effort, 1),
    velocity: finiteNumber(limit.velocity, 1)
  };
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function safeKinematicName(value) {
  return safeSlug(value).replaceAll("-", "_") || "item";
}


export function safeSlug(value) {
  return String(value || "item")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "item";
}
