import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectCadLatentSamples,
  writeCadLatentDataset,
} from "./scripts/export_cad_latent_dataset.mjs";

test("exports CAD latent samples from ratings and excellent examples", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-latent-export-"));
  const ratingsDir = path.join(root, "ratings");
  const excellentDir = path.join(root, "excellent");
  await mkdir(ratingsDir, { recursive: true });
  await mkdir(path.join(excellentDir, "good-servo"), { recursive: true });

  await writeFile(path.join(ratingsDir, "rating.json"), JSON.stringify({
    format: "ai-cad-manual-rating-v1",
    id: "rating-servo",
    score: 100,
    comment: "舵机支架孔位清楚",
    savedAt: "2026-06-07T00:00:00.000Z",
    assemblyId: "assembly-servo",
    plan: {
      name: "servo_bracket",
      parts: [{ id: "bracket", name: "舵机支架", role: "servo bracket", primitives: [{ type: "box" }], features: [{ type: "hole" }] }],
      relations: [],
      joints: []
    },
    assembly: { stepUrl: "/assembly.step", freeCadBridgeReport: { visiblePartObjectCount: 1, failedConstraints: [] } }
  }), "utf8");

  await writeFile(path.join(excellentDir, "good-servo", "manifest.json"), JSON.stringify({
    format: "ai-cad-excellent-cadquery-v1",
    sourceRatingId: "excellent-servo",
    score: 100,
    name: "servo library sample",
    comment: "servo holes"
  }), "utf8");
  await writeFile(path.join(excellentDir, "good-servo", "feature-plan.json"), JSON.stringify({
    name: "servo_library",
    parts: [{ id: "plate", name: "安装板", role: "servo mount plate", primitives: [{ type: "box" }], features: [{ type: "hole" }, { type: "fillet" }] }],
    relations: [],
    joints: []
  }), "utf8");

  const samples = await collectCadLatentSamples({ ratingsDir, excellentDir });

  assert.equal(samples.length, 2);
  assert.equal(samples[0].format, "ai-cad-latent-sample-v1");
  assert.ok(samples.some((sample) => sample.id === "rating-servo"));
  assert.ok(samples.some((sample) => sample.tokens.includes("feature:hole")));

  const datasetPath = path.join(root, "training_samples.jsonl");
  const manifest = await writeCadLatentDataset({ samples, datasetPath });
  const lines = (await readFile(datasetPath, "utf8")).trim().split("\n");

  assert.equal(lines.length, 2);
  assert.equal(manifest.sampleCount, 2);
  assert.equal(manifest.format, "ai-cad-latent-dataset-v1");
});
