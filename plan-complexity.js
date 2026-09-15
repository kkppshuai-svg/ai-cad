const MAX_FEATURE_TREE_NODES = 96;
const MAX_LEGACY_PRIMITIVES = 32;
const MAX_LEGACY_FEATURES = 64;

export function validatePartComplexity(part) {
  if (Object.prototype.hasOwnProperty.call(part, "featureTree") && Array.isArray(part.featureTree)) {
    if (part.featureTree.length > MAX_FEATURE_TREE_NODES) {
      throw new Error(`Part feature tree has too many nodes; maximum is ${MAX_FEATURE_TREE_NODES}`);
    }
    return;
  }

  if (Array.isArray(part.primitives) && part.primitives.length > MAX_LEGACY_PRIMITIVES) {
    throw new Error(`Part has too many primitives; maximum is ${MAX_LEGACY_PRIMITIVES}`);
  }
  if (Array.isArray(part.features) && part.features.length > MAX_LEGACY_FEATURES) {
    throw new Error(`Part has too many features; maximum is ${MAX_LEGACY_FEATURES}`);
  }
}
