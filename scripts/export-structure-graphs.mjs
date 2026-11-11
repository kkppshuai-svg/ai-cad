import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildCadStructureGraph } from "../cad-structure-graph.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const defaults = path.join(root, "workspace", "latent-learning");
const { values: options } = parseArgs({
  options: {
    out: { type: "string", default: path.join(defaults, "structure_graph_training.jsonl") },
    manifest: { type: "string", default: path.join(defaults, "structure_graph_manifest.json") },
  },
});
const planNames = new Set(["feature-plan.json", "native-feature-plan.json"]);

async function filesIn(directory, pick, recursive = true) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (recursive && entry.isDirectory()) files.push(...await filesIn(file, pick));
    if (entry.isFile() && pick(entry.name)) files.push(file);
  }
  return files;
}

function familyOf(plan, source) {
  const description = [source, plan.prototype, plan.id, plan.name,
    ...plan.parts.map((part) => part.id)].filter(Boolean).join(" ").toLowerCase();
  if (/planetary|行星减速机/.test(description)) return "planetary-reducer";
  if (/usd[_-]demo[_-]plate|带孔安装板/.test(description)) return "usd-demo-plate";
  if (/iphone18[_-]?stand|iphone18手机支架/.test(description)) return "phone-stand";
  const [directory, lineage] = source.split("/");
  return String(plan.prototype || (directory === "assemblies" ? lineage : plan.name || source));
}

function fingerprint(graph) {
  const edges = [...new Set(graph.edges.map((edge) =>
    JSON.stringify([edge.kind, edge.type || "", edge.from, edge.to])))].sort();
  return createHash("sha256").update(JSON.stringify([graph.nodes, edges])).digest("hex");
}

const sources = [
  ...await filesIn(path.join(root, "assemblies"), (name) => planNames.has(name)),
  ...await filesIn(path.join(root, "人工优秀代码库"), (name) => planNames.has(name)),
  ...await filesIn(path.join(root, "examples"), (name) => name.endsWith(".json"), false),
  ...await filesIn(path.join(root, "public"), (name) => /^usd-(demo-plate|planetary-5to1)\.json$/.test(name), false),
];
const byFingerprint = new Map();
const familyByAssembly = new Map();
const manifest = {
  format: "ai-cad-structure-graph-export-v1",
  candidatePlans: sources.length, planGraphs: 0, runtimeSamples: 0, summaryOnlySamples: 0,
  runtimeGraphsWithoutLineage: 0, skippedPlans: [], families: {}, records: [],
};

function retain(graph, family, source) {
  const hash = fingerprint(graph);
  const prior = byFingerprint.get(hash);
  if (prior) {
    prior.sources.push(source);
    prior.families.add(family);
    return;
  }
  byFingerprint.set(hash, { id: hash, family, structureGraph: graph, sources: [source], families: new Set([family]) });
}

for (const file of sources) {
  const source = path.relative(root, file).split(path.sep).join("/");
  const raw = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  const standalone = ["featureTree", "primitives", "features"].some((key) => Array.isArray(raw[key]));
  const plan = Array.isArray(raw.parts) ? raw : standalone ? { ...raw, parts: [raw] } : null;
  if (!plan?.parts.length) {
    manifest.skippedPlans.push(source);
    continue;
  }
  const graph = buildCadStructureGraph(plan);
  if (!graph.edges.length) {
    manifest.skippedPlans.push(source);
    continue;
  }
  const family = familyOf(plan, source);
  const [directory, assembly] = source.split("/");
  if (directory === "assemblies") familyByAssembly.set(assembly, family);
  retain(graph, family, source);
  manifest.planGraphs++;
}

const datasetPath = path.join(defaults, "training_samples.jsonl");
const runtime = await readFile(datasetPath, "utf8").catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
for (const line of runtime.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim())) {
  const sample = JSON.parse(line);
  manifest.runtimeSamples++;
  if (sample.structureGraph?.format !== "ai-cad-structure-graph-v1") {
    manifest.summaryOnlySamples++;
    continue;
  }
  const family = familyByAssembly.get(sample.assemblyId) || sample.family;
  if (!family) {
    manifest.runtimeGraphsWithoutLineage++;
    continue;
  }
  retain(sample.structureGraph, family, `workspace/latent-learning/training_samples.jsonl#${sample.id}`);
}

// Identical graphs link lineages so their other variants stay in the same fold.
const parent = new Map();
function representative(family) {
  while (parent.has(family)) family = parent.get(family);
  return family;
}
for (const record of byFingerprint.values()) {
  for (const family of record.families) {
    const a = representative(record.family);
    const b = representative(family);
    if (a !== b) parent.set(b, a);
  }
}
const rows = [...byFingerprint.values()].map(({ id, family, structureGraph, sources: provenance }) => {
  family = representative(family);
  manifest.families[family] = (manifest.families[family] || 0) + 1;
  manifest.records.push({ id, family, sources: provenance, nodeCount: structureGraph.nodes.length,
    edgeKinds: Object.fromEntries([...new Set(structureGraph.edges.map((edge) => edge.kind))].map((kind) =>
      [kind, structureGraph.edges.filter((edge) => edge.kind === kind).length])) });
  return { id, family, structureGraph, provenance };
});
manifest.uniqueGraphs = rows.length;
manifest.duplicateGraphs = [...byFingerprint.values()].reduce((sum, row) => sum + row.sources.length - 1, 0);
for (const file of [options.out, options.manifest]) await mkdir(path.dirname(file), { recursive: true });
await writeFile(options.out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
await writeFile(options.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  candidatePlans: manifest.candidatePlans, planGraphs: manifest.planGraphs, uniqueGraphs: rows.length,
  duplicateGraphs: manifest.duplicateGraphs, families: manifest.families,
  summaryOnlySamples: manifest.summaryOnlySamples, output: options.out, manifest: options.manifest,
}, null, 2));
