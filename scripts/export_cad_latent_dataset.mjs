import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCadLatentSample } from "../cad-latent-memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(__dirname);

export async function collectCadLatentSamples({
  ratingsDir = path.join(repoRoot, "aicad人工评分"),
  excellentDir = path.join(repoRoot, "人工优秀代码库"),
} = {}) {
  const samples = [];
  for (const rating of await readRatings(ratingsDir)) {
    samples.push(buildCadLatentSample({
      rating,
      plan: rating.plan || {},
      assembly: rating.assembly || {}
    }));
  }
  for (const example of await readExcellentExamples(excellentDir)) {
    samples.push(buildCadLatentSample({
      rating: {
        id: example.sourceRatingId || example.name,
        score: example.score || 100,
        retainedForLearning: true,
        comment: example.comment || "",
        savedAt: example.savedAt || null,
        assemblyId: example.assemblyId || null
      },
      plan: example.plan || {},
      assembly: {
        status: "done",
        stepUrl: "excellent-cadquery-library",
        freeCadBridgeReport: {
          visiblePartObjectCount: Math.max(1, example.plan?.parts?.length || 1),
          failedConstraints: []
        }
      }
    }));
  }

  const unique = new Map();
  for (const sample of samples) unique.set(sample.id, sample);
  return [...unique.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export async function writeCadLatentDataset({ samples, datasetPath }) {
  await mkdir(path.dirname(datasetPath), { recursive: true });
  const lines = samples.map((sample) => JSON.stringify(sample));
  await writeFile(datasetPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
  const manifest = {
    format: "ai-cad-latent-dataset-v1",
    sampleCount: samples.length,
    datasetFile: path.basename(datasetPath),
    createdAt: new Date().toISOString(),
    tokenCount: new Set(samples.flatMap((sample) => sample.tokens || [])).size
  };
  await writeFile(path.join(path.dirname(datasetPath), "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

async function readRatings(ratingsDir) {
  let entries = [];
  try {
    entries = await readdir(ratingsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ratings = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const rating = JSON.parse(await readFile(path.join(ratingsDir, entry.name), "utf8"));
      if (rating?.format === "ai-cad-manual-rating-v1") ratings.push(rating);
    } catch {
      // Ignore incomplete files.
    }
  }
  return ratings;
}

async function readExcellentExamples(excellentDir) {
  let entries = [];
  try {
    entries = await readdir(excellentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const examples = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(excellentDir, entry.name);
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
      const plan = JSON.parse(await readFile(path.join(dir, "feature-plan.json"), "utf8"));
      examples.push({ ...manifest, plan });
    } catch {
      // Ignore incomplete examples.
    }
  }
  return examples;
}

async function main() {
  const datasetPath = process.argv[2] || path.join(repoRoot, "cad-latent", "training_samples.jsonl");
  const samples = await collectCadLatentSamples();
  const manifest = await writeCadLatentDataset({ samples, datasetPath });
  console.log(JSON.stringify(manifest, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
