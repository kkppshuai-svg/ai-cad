import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CadLatentTrainingManager, buildTrainingSample } from "./cad-latent-training.js";
import { rankCadLatentModelSamples } from "./cad-latent-memory.js";

test("accepted geometry is converted into one structure/BREP learning sample", () => {
  const sample = buildTrainingSample({
    id: "assembly:a:rev-1",
    source: "validated-build",
    geometry: { format: "ai-cad-brep-geometry-v1", featureNames: ["x"], vector: [1] },
    job: {
      id: "a",
      status: "done",
      currentRevision: "rev-1",
      plan: {
        name: "servo bracket",
        parts: [{ id: "bracket", role: "舵机支架", primitives: [{ type: "box" }], features: [{ type: "hole" }] }],
        relations: [],
        joints: []
      }
    }
  });
  assert.equal(sample.format, "ai-cad-latent-sample-v1");
  assert.equal(sample.geometry.format, "ai-cad-brep-geometry-v1");
  assert.ok(sample.tokens.includes("feature:hole:1"));
  assert.equal(sample.quality.trainingVerified, true);
});

test("runtime manager seeds the baseline and exposes it to planning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-latent-manager-"));
  await mkdir(path.join(root, "cad-latent"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "structure.json"), JSON.stringify({ format: "seed", sampleCount: 1, vocabulary: [], mean: [], components: [], samples: [] }));
  await writeFile(path.join(root, "brep.json"), JSON.stringify({ format: "brep-seed" }));
  await writeFile(path.join(root, "structure.jsonl"), "{\"id\":\"s1\"}\n");
  await writeFile(path.join(root, "brep.jsonl"), "{\"id\":\"b1\"}\n");
  const runtime = path.join(root, "runtime");
  const manager = new CadLatentTrainingManager({
    rootDir: root,
    runtimeDir: runtime,
    seedStructureDataset: path.join(root, "structure.jsonl"),
    seedBrepDataset: path.join(root, "brep.jsonl"),
    seedStructureModel: path.join(root, "structure.json"),
    seedBrepModel: path.join(root, "brep.json")
  });
  await manager.init();
  const model = await manager.plannerModel();
  assert.equal(model.format, "seed");
  assert.equal(manager.status().initialized, true);
});

test("latest structure model can rank planning priors without changing dimensions", () => {
  const model = {
    vocabulary: ["zh:支架", "feature:hole"],
    mean: [0, 0, 0, 0, 0, 0, 0, 0],
    components: [[1, 0, 0, 0, 0, 0, 0, 0]],
    samples: [{ id: "bracket", name: "bracket", tokens: ["zh:支架", "feature:hole"], latent: [1], quality: { score: 100 } }]
  };
  const matches = rankCadLatentModelSamples("支架 孔", model);
  assert.equal(matches[0].id, "bracket");
  assert.equal(matches[0].structuralScore > 0, true);
});
