import {
  formatCadLatentContextForPrompt,
  rankCadLatentModelSamples,
  rankCadLatentSamples
} from "./cad-latent-memory.js";

export function extractStandardPartRequests(message, conversation = {}) {
  const text = [
    message,
    ...(conversation?.messages || []).slice(-4).map((item) => item.content)
  ].join("\n");
  const requests = [];
  const add = (request) => {
    const key = [request.query, request.category, request.tag].filter(Boolean).join("|").toLowerCase();
    if (requests.some((item) => [item.query, item.category, item.tag].filter(Boolean).join("|").toLowerCase() === key)) return;
    requests.push({ provider: "step.parts", ...request });
  };

  for (const match of String(text).matchAll(/\b(6\d{2,3})\s*(?:zz|ZZ|rs|RS)?\b/g)) {
    const token = match[0].replace(/\s+/g, "").toUpperCase();
    add({ query: `${token} bearing`, category: "bearing", tag: token.toLowerCase() });
  }
  for (const match of String(text).matchAll(/\bM([2-8])\s*[xX*]\s*(\d{2,3})\b/g)) {
    const query = `M${match[1]}x${match[2]} screw`;
    add({ query, category: "screw", tag: `m${match[1]}` });
  }

  const normalized = String(text).toLowerCase();
  const keywordRules = [
    { words: ["轴承", "bearing"], query: "bearing", category: "bearing" },
    { words: ["螺丝", "螺钉", "螺栓", "screw", "bolt"], query: "screw", category: "screw" },
    { words: ["螺母", "nut"], query: "nut", category: "nut" },
    { words: ["垫片", "washer"], query: "washer", category: "washer" },
    { words: ["舵机", "servo"], query: "servo", category: "servo" },
    { words: ["连接器", "connector"], query: "connector", category: "connector" },
    { words: ["型材", "extrusion"], query: "aluminum extrusion", category: "extrusion" }
  ];
  for (const rule of keywordRules) {
    if (rule.words.some((word) => normalized.includes(word))) {
      add({ query: rule.query, category: rule.category });
    }
  }

  return requests.slice(0, 6);
}

export function rankCadQueryTemplates(message, examples = [], options = {}) {
  const tokens = tokenizeContext(message);
  const limit = Math.max(1, Math.min(5, Number(options.limit || 3)));
  return examples
    .map((example) => ({ example, score: scoreTemplate(example, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.example.savedAt || "").localeCompare(String(a.example.savedAt || "")))
    .slice(0, limit)
    .map(({ example, score }) => ({
      name: example.name,
      score,
      savedAt: example.savedAt || null,
      comment: example.comment || "",
      pythonFile: example.pythonPath,
      planSummary: summarizePlan(example.plan),
      pythonExcerpt: String(example.pythonExcerpt || "").slice(0, 1800)
    }));
}

export async function buildCadReferenceContext({
  message,
  conversation = {},
  loadExcellentExamples = async () => [],
  loadCadLatentSamples = async () => [],
  loadCadLatentModel = async () => null,
  searchStepParts = async () => null
} = {}) {
  const requests = extractStandardPartRequests(message, conversation);
  const standardPartCandidates = [];
  const warnings = [];
  for (const request of requests) {
    try {
      const result = await searchStepParts(request);
      if (result) {
        standardPartCandidates.push({
          request,
          id: result.id,
          name: result.name,
          category: result.category || request.category || "",
          family: result.family || "",
          standard: result.standard || "",
          attributes: result.attributes || {},
          pageUrl: result.pageUrl || "",
          apiUrl: result.apiUrl || ""
        });
      }
    } catch (error) {
      warnings.push(`step.parts lookup failed for "${request.query}": ${error.message || error}`);
    }
  }

  const localCadqueryTemplates = rankCadQueryTemplates(message, await loadExcellentExamples());
  const cadLatentMemory = rankCadLatentSamples(message, await loadCadLatentSamples(), { limit: 4 });
  const latentModel = await loadCadLatentModel();
  const cadLatentModelMatches = rankCadLatentModelSamples(message, latentModel, { limit: 4 });
  return {
    enabled: true,
    standardPartRequests: requests,
    standardPartCandidates,
    localCadqueryTemplates,
    cadLatentMemory,
    cadLatentModel: latentModel ? {
      format: latentModel.format,
      modelVersion: latentModel.modelVersion || null,
      sampleCount: latentModel.sampleCount || 0,
      latentDim: latentModel.latentDim || 0,
      metrics: latentModel.metrics || {}
    } : null,
    cadLatentModelMatches,
    warnings
  };
}

export function formatCadReferenceContextForPrompt(context) {
  if (!context?.enabled) return "Disabled.";
  return JSON.stringify({
    instruction: "Use step.parts candidates only for recognizable off-the-shelf parts. Use CAD latent memory for structural priors, decomposition, feature ordering, joint completeness, and failure avoidance. Use local CadQuery templates only for modeling patterns; never copy dimensions unless the current user request explicitly matches them.",
    standardPartCandidates: context.standardPartCandidates || [],
    standardPartWarnings: context.warnings || [],
    cadLatentMemory: JSON.parse(formatCadLatentContextForPrompt({ samples: context.cadLatentMemory || [] })),
    cadLatentModel: context.cadLatentModel || null,
    cadLatentModelMatches: context.cadLatentModelMatches || [],
    localCadqueryTemplates: context.localCadqueryTemplates || []
  }, null, 2);
}

function tokenizeContext(text) {
  const normalized = String(text || "").toLowerCase();
  const ascii = normalized.match(/[a-z0-9.#+-]+/g) || [];
  const zh = [
    "轴承", "连杆", "支架", "外壳", "孔", "槽", "圆角", "倒角", "舵机", "电机",
    "螺丝", "螺钉", "螺母", "型材", "安装", "盒子", "滑块", "导轨", "齿轮"
  ].filter((word) => normalized.includes(word));
  return new Set([...ascii, ...zh]);
}

function scoreTemplate(example, tokens) {
  if (!tokens.size) return 1;
  const text = [
    example.name,
    example.comment,
    example.plan?.name,
    ...(example.plan?.parts || []).flatMap((part) => [part.id, part.name, part.role]),
    ...(example.plan?.relations || []).map((relation) => relation.description),
    ...(example.plan?.joints || []).map((joint) => joint.type)
  ].join(" ").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (text.includes(token)) score += token.length > 2 ? 10 : 5;
  }
  return score;
}

function summarizePlan(plan) {
  return {
    name: plan?.name || "",
    parts: (plan?.parts || []).slice(0, 8).map((part) => ({
      id: part.id,
      name: part.name,
      role: part.role,
      mode: part.mode || "generated",
      primitiveTypes: (part.primitives || []).map((primitive) => primitive.type),
      featureTypes: (part.features || []).map((feature) => feature.type)
    })),
    relations: (plan?.relations || []).slice(0, 8),
    joints: (plan?.joints || []).slice(0, 8)
  };
}
