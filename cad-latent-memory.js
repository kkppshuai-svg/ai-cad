const ZH_KEYWORDS = [
  "轴承", "连杆", "支架", "外壳", "孔", "槽", "圆角", "倒角", "舵机", "电机",
  "螺丝", "螺钉", "螺母", "安装", "盒子", "滑块", "导轨", "齿轮", "轮胎", "关节",
  "除草刷", "刷毛", "主轴", "圆形阵列", "径向"
];

const CAD_INTENT_RULES = [
  {
    token: "concept:weeding-brush",
    patterns: [/weeding[_\s-]*brush/, /weed[_\s-]*brush/, /除草刷/]
  },
  {
    token: "component:bristle",
    patterns: [/bristles?/, /brush[_\s-]*(wire|line|hair)/, /刷毛/]
  },
  {
    token: "component:shaft",
    patterns: [/\bshaft\b/, /\baxis\b/, /主轴/, /刷轴/, /中心轴/]
  },
  {
    token: "pattern:radial-array",
    patterns: [/radial[_\s-]*array/, /circular[_\s-]*array/, /round[_\s-]*array/, /圆形阵列/, /环形阵列/, /径向/]
  }
];

const GEOMETRY_POLICY = {
  learnedRepresentation: "CAD structure JSON",
  learnsGeometryFiles: false,
  usesStepStlFcstdAsEvidenceOnly: true,
};

export function buildCadLatentSample({ rating = {}, plan = {}, assembly = {} } = {}) {
  const structure = summarizeStructure(plan);
  const quality = summarizeQuality({ rating, assembly });
  const tokens = buildCadTokens({ rating, plan, structure, quality });
  return {
    format: "ai-cad-latent-sample-v1",
    id: rating.id || rating.assemblyId || plan.name || "cad-sample",
    savedAt: rating.savedAt || null,
    assemblyId: rating.assemblyId || assembly.id || null,
    name: plan.name || assembly.name || "AI_CAD_Assembly",
    comment: rating.comment || "",
    geometryPolicy: { ...GEOMETRY_POLICY },
    structure,
    quality,
    tokens,
    latent: {
      kind: "sparse-cad-token-baseline",
      learnedRepresentation: GEOMETRY_POLICY.learnedRepresentation,
      tokens
    }
  };
}

export function rankCadLatentSamples(message, samples = [], options = {}) {
  const queryTokens = tokenizeText(message);
  const limit = Math.max(1, Math.min(8, Number(options.limit || 4)));
  return samples
    .map((sample) => {
      const tokenScore = scoreTokenOverlap(queryTokens, new Set(sample.tokens || []));
      const qualityBoost = qualityScore(sample.quality);
      return {
        ...sample,
        similarity: Number((tokenScore + qualityBoost).toFixed(3))
      };
    })
    .filter((sample) => sample.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || (b.quality?.score || 0) - (a.quality?.score || 0))
    .slice(0, limit);
}

export function rankCadLatentModelSamples(message, model, options = {}) {
  if (!model || !Array.isArray(model.vocabulary) || !Array.isArray(model.components) || !Array.isArray(model.mean)) return [];
  const limit = Math.max(1, Math.min(8, Number(options.limit || 4)));
  const vocabulary = new Map(model.vocabulary.map((token, index) => [token, index]));
  const vector = Array.from({ length: model.mean.length }, () => 0);
  const queryTokens = tokenizeText(message);
  for (const token of queryTokens) {
    const index = vocabulary.get(token);
    if (index != null) vector[index] = 1;
    if (token === "zh:孔" && vocabulary.has("feature:hole")) vector[vocabulary.get("feature:hole")] = 1;
  }
  const centered = vector.map((value, index) => value - Number(model.mean[index] || 0));
  const latent = model.components.map((component) => dot(centered, component));
  return (model.samples || [])
    .map((sample) => {
      const structural = scoreTokenOverlap(queryTokens, new Set(sample.tokens || []));
      const distance = euclideanDistance(latent, sample.latent || []);
      return {
        id: sample.id,
        name: sample.name,
        quality: sample.quality || null,
        structuralScore: structural,
        latentDistance: Number(distance.toFixed(6)),
        rankScore: Number((structural + qualityScore(sample.quality) - distance).toFixed(6))
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore || a.latentDistance - b.latentDistance)
    .slice(0, limit);
}

export function formatCadLatentContextForPrompt({ samples = [] } = {}) {
  return JSON.stringify({
    instruction: "CAD latent memory learns CAD structure JSON, not STEP/STL/FCStd geometry files. Use these compact structural memories as design priors for decomposition, feature ordering, joints, and failure avoidance. It uses STEP/STL/FCStd only as build evidence, not as learned representation. Do not copy dimensions unless the current request explicitly matches the sample.",
    geometryPolicy: { ...GEOMETRY_POLICY },
    samples: samples.map((sample) => ({
      id: sample.id,
      name: sample.name,
      similarity: sample.similarity ?? null,
      geometryPolicy: sample.geometryPolicy || GEOMETRY_POLICY,
      quality: sample.quality,
      structure: sample.structure,
      tokens: (sample.tokens || []).slice(0, 80),
      comment: sample.comment || ""
    }))
  }, null, 2);
}

function summarizeStructure(plan = {}) {
  const parts = Array.isArray(plan.parts) ? plan.parts : [];
  const relations = Array.isArray(plan.relations) ? plan.relations : [];
  const joints = Array.isArray(plan.joints) ? plan.joints : [];
  const primitiveTypes = countTypes(parts.flatMap((part) => part.primitives || []));
  const featureTypes = countTypes(parts.flatMap((part) => part.features || []));
  return {
    name: plan.name || "",
    partCount: parts.length,
    relationCount: relations.length,
    jointCount: joints.length,
    primitiveTypes,
    featureTypes,
    partRoles: parts.map((part) => part.role || part.name || part.id).filter(Boolean).slice(0, 12),
    jointTypes: joints.map((joint) => joint.type || "fixed").slice(0, 12)
  };
}

function summarizeQuality({ rating = {}, assembly = {} }) {
  const report = assembly.freeCadBridgeReport || {};
  const failedConstraints = Array.isArray(report.failedConstraints) ? report.failedConstraints : [];
  return {
    score: Number.isFinite(Number(rating.score)) ? Number(rating.score) : null,
    retainedForLearning: Boolean(rating.retainedForLearning || Number(rating.score) === 100),
    trainingVerified: Boolean(rating.trainingVerified),
    cadqueryBuilt: Boolean(assembly.stepUrl || assembly.stlUrl || assembly.fcstdUrl),
    freecadVisible: Number(report.visiblePartObjectCount || 0) > 0,
    visiblePartObjectCount: Number(report.visiblePartObjectCount || 0),
    hiddenReferenceObjectCount: Number(report.hiddenReferenceObjectCount || 0),
    failedConstraintCount: failedConstraints.length,
    status: assembly.status || null
  };
}

function buildCadTokens({ rating = {}, plan = {}, structure, quality }) {
  const tokens = new Set();
  const intentText = [
    plan.name,
    rating.comment,
    ...(structure.partRoles || []),
    ...(Array.isArray(plan.relations) ? plan.relations.map((relation) => relation.description || relation.type || "") : [])
  ].join(" ");
  for (const token of tokenizeText(intentText)) tokens.add(token);
  tokens.add(`parts:${structure.partCount}`);
  tokens.add(`relations:${structure.relationCount}`);
  tokens.add(`joints:${structure.jointCount}`);
  for (const [type, count] of Object.entries(structure.primitiveTypes)) tokens.add(`primitive:${type}:${count}`);
  for (const [type, count] of Object.entries(structure.featureTypes)) {
    tokens.add(`feature:${type}`);
    tokens.add(`feature:${type}:${count}`);
  }
  for (const role of structure.partRoles) {
    for (const token of tokenizeText(role)) tokens.add(token);
  }
  for (const type of structure.jointTypes) tokens.add(`joint:${type}`);
  if (quality.retainedForLearning) tokens.add("quality:excellent");
  if (quality.trainingVerified) tokens.add("quality:visual-loop-pass");
  if (quality.freecadVisible) tokens.add("freecad:visible");
  if (quality.failedConstraintCount > 0) tokens.add("freecad:constraint-failed");
  return [...tokens].sort();
}

function countTypes(items) {
  const counts = {};
  for (const item of items) {
    const type = String(item?.type || "unknown").toLowerCase();
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function tokenizeText(text) {
  const normalized = String(text || "").toLowerCase();
  const ascii = normalized.match(/[a-z0-9.#+-]+/g) || [];
  const zh = ZH_KEYWORDS.filter((word) => normalized.includes(word)).map((word) => `zh:${word}`);
  const structural = CAD_INTENT_RULES
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(normalized)))
    .map((rule) => rule.token);
  return addDerivedIntentTokens(new Set([...ascii, ...zh, ...structural]));
}

function addDerivedIntentTokens(tokens) {
  if (tokens.has("concept:weeding-brush")) {
    tokens.add("component:shaft");
  }
  return tokens;
}

function scoreTokenOverlap(queryTokens, sampleTokens) {
  if (!queryTokens.size || !sampleTokens.size) return 0;
  let score = 0;
  for (const token of queryTokens) {
    if (sampleTokens.has(token)) score += tokenWeight(token);
    const featureToken = token.startsWith("zh:孔") ? "feature:hole" : null;
    if (featureToken && sampleTokens.has(featureToken)) score += 10;
  }
  return score;
}

function tokenWeight(token) {
  if (token.startsWith("concept:")) return 34;
  if (token.startsWith("pattern:")) return 30;
  if (token.startsWith("component:")) return 24;
  if (token.startsWith("zh:")) return 12;
  return 8;
}

function qualityScore(quality = {}) {
  let score = 0;
  if (quality.score === 100) score += 10;
  if (quality.score === 50) score += 3;
  if (quality.score === 0) score -= 8;
  if (quality.cadqueryBuilt) score += 4;
  if (quality.freecadVisible) score += 4;
  score -= Math.min(12, Number(quality.failedConstraintCount || 0) * 4);
  return score;
}

function dot(a, b) {
  let total = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) total += Number(a[index] || 0) * Number(b[index] || 0);
  return total;
}

function euclideanDistance(a, b) {
  let total = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = Number(a[index] || 0) - Number(b[index] || 0);
    total += delta * delta;
  }
  return Math.sqrt(total);
}
