function finiteRange(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function sanitizeNumberList(values, fallback, min, max) {
  const list = Array.isArray(values) ? values : [];
  return [0, 1, 2].map((index) => finiteRange(list[index], fallback, min, max));
}

export function safePartId(value) {
  return String(value || "item")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "item";
}

export function sanitizePose(pose = {}) {
  return {
    translate: sanitizeNumberList(pose.translate, 0, -5000, 5000),
    rotate: sanitizeNumberList(pose.rotate, 0, -360, 360)
  };
}

export function sanitizePrimitive(primitive = {}) {
  const type = ["box", "cylinder", "sphere", "cone"].includes(primitive.type) ? primitive.type : "box";
  const clean = {
    type,
    center: primitive.center !== false,
    pose: sanitizePose(primitive.pose || {})
  };
  if (type === "box") {
    clean.size = sanitizeNumberList(primitive.size || [10, 10, 10], 10, 0.1, 5000);
  } else if (type === "cylinder") {
    clean.radius = finiteRange(primitive.radius ?? Number(primitive.diameter) / 2, 5, 0.05, 2500);
    clean.height = finiteRange(primitive.height, 10, 0.1, 5000);
  } else if (type === "sphere") {
    clean.radius = finiteRange(primitive.radius, 5, 0.05, 2500);
  } else if (type === "cone") {
    clean.radius1 = finiteRange(primitive.radius1 ?? primitive.bottomRadius, 8, 0.05, 2500);
    clean.radius2 = finiteRange(primitive.radius2 ?? primitive.topRadius, 3, 0.05, 2500);
    clean.height = finiteRange(primitive.height, 10, 0.1, 5000);
  }
  return clean;
}

export function sanitizeFeature(feature = {}) {
  if (["add_extrude", "cut_extrude"].includes(feature.type)) {
    return {
      type: feature.type,
      profile: structuredClone(feature.profile),
      depth: feature.depth
    };
  }

  const type = ["hole", "slot", "cut_box", "add", "fillet", "chamfer"].includes(feature.type) ? feature.type : "cut_box";
  const clean = {
    type,
    center: sanitizeNumberList(feature.center || [0, 0, 0], 0, -5000, 5000)
  };
  if (["hole", "slot"].includes(type)) {
    clean.axis = ["x", "y", "z"].includes(String(feature.axis || "").toLowerCase()) ? String(feature.axis).toLowerCase() : "z";
    clean.radius = finiteRange(feature.radius ?? Number(feature.diameter) / 2, 2.5, 0.05, 1000);
    clean.depth = finiteRange(feature.depth, 1000, 0.1, 10000);
  }
  if (type === "slot") {
    clean.length = finiteRange(feature.length, 20, 0.1, 5000);
    clean.width = finiteRange(feature.width ?? feature.diameter, 5, 0.1, 1000);
  }
  if (type === "cut_box") {
    clean.size = sanitizeNumberList(feature.size || [10, 10, 10], 10, 0.1, 5000);
    clean.rotate = sanitizeNumberList(feature.rotate || [0, 0, 0], 0, -360, 360);
  }
  if (type === "add") {
    clean.primitive = sanitizePrimitive(feature.primitive || {});
  }
  if (type === "fillet") clean.radius = finiteRange(feature.radius, 1, 0.01, 200);
  if (type === "chamfer") clean.distance = finiteRange(feature.distance, 1, 0.01, 200);
  return clean;
}
