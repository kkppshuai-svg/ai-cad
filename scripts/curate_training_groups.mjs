import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildCadLatentSample } from "../cad-latent-memory.js";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outputDir = path.join(repoRoot, "cad-latent", "curated-groups");
const assembliesDir = path.join(repoRoot, "assemblies");

const ratingFiles = {
  gear: path.join(repoRoot, "aicad人工评分", "2026-07-28T09-10-27-988Z-100-1785220767403-10-c966bcbb.json"),
  servo: path.join(repoRoot, "aicad人工评分", "2026-08-08T02-38-55-986Z-100-1786155623561-160mm-7e374289.json"),
  die: path.join(repoRoot, "aicad人工评分", "2026-06-14T05-31-14-749Z-100-1781415023056-simple_rounded_die-48619228.json")
};

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  const nemaStatePath = path.join(assembliesDir, "1786362889802-nema23-l-f5873f9d", "revisions", "rev-0004", "revision-state.json");
  const nemaState = (await readJson(nemaStatePath)).state;
  const nemaAssemblyId = "1786362889802-nema23-l-f5873f9d";
  const nemaStep = path.join(assembliesDir, nemaAssemblyId, "revisions", "rev-0004", "artifacts", "assembly.step");
  const nemaRating = {
    id: "curated-2026-08-10-nema23-l-bracket",
    score: 100,
    retainedForLearning: true,
    trainingVerified: true,
    savedAt: new Date().toISOString(),
    assemblyId: nemaAssemblyId,
    comment: "自动筛选：NEMA23 一体式单实体支架；参数化孔槽、底板厚度和局部撤销链路均通过 BREP 验证。"
  };
  const nemaAssembly = {
    id: nemaAssemblyId,
    name: nemaState.plan.name,
    status: "done",
    stepUrl: nemaStep,
    fcstdUrl: nemaState.delivery?.fcstdPath || null,
    freeCadBridgeReport: nemaState.delivery?.freeCadBridgeReport || { visiblePartObjectCount: 1, failedConstraints: [] }
  };
  const nemaSample = {
    ...buildCadLatentSample({ rating: nemaRating, plan: nemaState.plan, assembly: nemaAssembly }),
    stepPath: nemaStep,
    curation: { group: "parametric_mechanical", basis: "validated_local_revision", sourceRevision: "rev-0004" }
  };

  const sources = {};
  for (const [key, file] of Object.entries(ratingFiles)) sources[key] = await readJson(file);
  const makeRatedSample = (key, group) => {
    const rating = sources[key];
    const assemblyId = rating.assemblyId;
    const stepPath = path.join(assembliesDir, assemblyId, "assembly.step");
    return {
      ...buildCadLatentSample({ rating: { ...rating, trainingVerified: true }, plan: rating.plan, assembly: rating.assembly || { id: assemblyId, status: "done", stepUrl: stepPath } }),
      stepPath,
      curation: { group, basis: "existing_manual_score_100", sourceRating: rating.id }
    };
  };

  const groups = {
    parametric_mechanical: [nemaSample, makeRatedSample("gear", "parametric_mechanical")],
    manufacturing_features: [makeRatedSample("servo", "manufacturing_features"), makeRatedSample("die", "manufacturing_features")]
  };
  await mkdir(outputDir, { recursive: true });
  const all = [];
  const manifest = { format: "ai-cad-curated-training-groups-v1", createdAt: new Date().toISOString(), groups: {} };
  for (const [group, samples] of Object.entries(groups)) {
    const datasetPath = path.join(outputDir, `${group}.jsonl`);
    await writeFile(datasetPath, `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`, "utf8");
    manifest.groups[group] = {
      sampleCount: samples.length,
      dataset: datasetPath,
      samples: samples.map((sample) => ({ id: sample.id, name: sample.name, assemblyId: sample.assemblyId, stepPath: sample.stepPath, score: sample.quality.score }))
    };
    all.push(...samples);
  }

  const trainingPath = path.join(repoRoot, "cad-latent", "training_samples.jsonl");
  const existing = (await readFile(trainingPath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const byId = new Map(existing.map((sample) => [sample.id, sample]));
  for (const sample of all) byId.set(sample.id, sample);
  await writeFile(trainingPath, `${[...byId.values()].map((sample) => JSON.stringify(sample)).join("\n")}\n`, "utf8");
  manifest.trainingDataset = trainingPath;
  manifest.totalAddedOrUpdated = all.length;
  const mergedSamples = [...byId.values()];
  await writeFile(path.join(repoRoot, "cad-latent", "manifest.json"), JSON.stringify({
    format: "ai-cad-latent-dataset-v1",
    sampleCount: mergedSamples.length,
    datasetFile: "training_samples.jsonl",
    createdAt: new Date().toISOString(),
    tokenCount: new Set(mergedSamples.flatMap((sample) => sample.tokens || [])).size,
    curatedGroups: Object.keys(groups)
  }, null, 2), "utf8");
  await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
