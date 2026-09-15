import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const STRUCTURE_DATASET = "training_samples.jsonl";
const BREP_DATASET = "brep_training_samples.jsonl";
const STRUCTURE_MODEL = "cad_vae_model.json";
const BREP_MODEL = "brep_vae_model.json";
const REGISTRY = "model-registry.json";

export class CadLatentTrainingManager {
  constructor({
    rootDir,
    runtimeDir,
    seedStructureDataset,
    seedBrepDataset,
    seedStructureModel,
    seedBrepModel,
    python,
    extractScript,
    structureTrainScript,
    brepTrainScript,
    minSamples = 2,
    epochs = 120,
    onEvent = () => {}
  } = {}) {
    this.rootDir = path.resolve(rootDir || process.cwd());
    this.runtimeDir = path.resolve(runtimeDir || path.join(this.rootDir, "workspace", "latent-learning"));
    this.seedStructureDataset = seedStructureDataset || path.join(this.rootDir, "cad-latent", STRUCTURE_DATASET);
    this.seedBrepDataset = seedBrepDataset || path.join(this.rootDir, "cad-latent", BREP_DATASET);
    this.seedStructureModel = seedStructureModel || path.join(this.rootDir, "cad-latent", "model.json");
    this.seedBrepModel = seedBrepModel || path.join(this.rootDir, "cad-latent", BREP_MODEL);
    this.python = python || "python3";
    this.extractScript = extractScript || path.join(this.rootDir, "scripts", "extract_brep_geometry.py");
    this.structureTrainScript = structureTrainScript || path.join(this.rootDir, "scripts", "train_cad_vae.py");
    this.brepTrainScript = brepTrainScript || path.join(this.rootDir, "scripts", "train_brep_vae.py");
    this.minSamples = Math.max(2, Number(minSamples) || 2);
    this.epochs = Math.max(1, Number(epochs) || 120);
    this.onEvent = onEvent;
    this.queue = [];
    this.pendingIds = new Set();
    this.running = false;
    this.initialized = false;
    this.lastResult = null;
    this.lastError = null;
    this.lastStartedAt = null;
    this.lastCompletedAt = null;
  }

  async init() {
    if (this.initialized) return this.status();
    await mkdir(this.runtimeDir, { recursive: true });
    await ensureSeed(this.seedStructureDataset, this.structureDatasetPath());
    await ensureSeed(this.seedBrepDataset, this.brepDatasetPath());
    await ensureSeed(this.seedStructureModel, this.structureModelPath());
    await ensureSeed(this.seedBrepModel, this.brepModelPath());
    try {
      const model = JSON.parse(await readFile(this.structureModelPath(), "utf8"));
      this.lastResult = { trained: false, activeModel: { modelVersion: model.modelVersion || "baseline", structureSamples: model.sampleCount || await countLines(this.structureDatasetPath()), brepSamples: await countLines(this.brepDatasetPath()) } };
    } catch {
      this.lastResult = null;
    }
    this.initialized = true;
    return this.status();
  }

  structureDatasetPath() { return path.join(this.runtimeDir, STRUCTURE_DATASET); }
  brepDatasetPath() { return path.join(this.runtimeDir, BREP_DATASET); }
  structureModelPath() { return path.join(this.runtimeDir, STRUCTURE_MODEL); }
  brepModelPath() { return path.join(this.runtimeDir, BREP_MODEL); }
  registryPath() { return path.join(this.runtimeDir, REGISTRY); }

  async enqueueAcceptedAssembly({ job, source = "validation" } = {}) {
    await this.init();
    const stepPath = job?.stepPath;
    if (!job?.id || !stepPath) return { ok: false, queued: false, reason: "missing-step" };
    const revision = job.currentRevision || "unversioned";
    const id = `assembly:${job.id}:${revision}`;
    if (await datasetHasId(this.structureDatasetPath(), id)) {
      return { ok: true, queued: false, duplicate: true, id, status: this.status() };
    }
    if (this.pendingIds.has(id)) return { ok: true, queued: false, duplicate: true, id, status: this.status() };
    const item = { job: structuredClone(job), source, id };
    this.pendingIds.add(id);
    this.queue.push(item);
    this.emit("queued", { id, source, queueLength: this.queue.length });
    void this.drain();
    return { ok: true, queued: true, id, status: this.status() };
  }

  async retrainNow() {
    await this.init();
    if (this.running) return { ok: true, queued: false, running: true, status: this.status() };
    this.queue.push({ rebuildOnly: true, id: `retrain:${Date.now()}`, source: "manual" });
    void this.drain();
    return { ok: true, queued: true, status: this.status() };
  }

  status() {
    return {
      enabled: true,
      initialized: this.initialized,
      running: this.running,
      queueLength: this.queue.length,
      minSamples: this.minSamples,
      epochs: this.epochs,
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastError: this.lastError,
      lastResult: this.lastResult,
      runtimeDir: this.runtimeDir,
      activeModel: this.lastResult?.activeModel || null
    };
  }

  async plannerModel() {
    await this.init();
    try {
      const model = JSON.parse(await readFile(this.structureModelPath(), "utf8"));
      return {
        format: model.format,
        modelVersion: model.modelVersion || null,
        sampleCount: model.sampleCount || 0,
        latentDim: model.latentDim || 0,
        metrics: model.metrics || {},
        vocabulary: model.vocabulary || [],
        components: model.components || [],
        mean: model.mean || [],
        samples: model.samples || []
      };
    } catch {
      return null;
    }
  }

  async drain() {
    if (this.running || !this.queue.length) return;
    this.running = true;
    this.lastError = null;
    this.lastStartedAt = new Date().toISOString();
    const item = this.queue.shift();
    this.emit("started", { id: item.id, source: item.source });
    try {
      if (!item.rebuildOnly) await this.appendAcceptedSample(item);
      const result = await this.trainModels();
      this.lastResult = result;
      this.lastCompletedAt = new Date().toISOString();
      this.emit("completed", result);
    } catch (error) {
      this.lastError = error.message || String(error);
      this.lastCompletedAt = new Date().toISOString();
      this.emit("failed", { id: item.id, error: this.lastError });
    } finally {
      this.pendingIds.delete(item.id);
      this.running = false;
      if (this.queue.length) void this.drain();
    }
  }

  async appendAcceptedSample({ job, source, id }) {
    const geometry = JSON.parse(await runJson(this.python, [this.extractScript, "--step", job.stepPath], { cwd: this.rootDir, timeoutMs: 120000 }));
    const sample = buildTrainingSample({ job, source, id, geometry });
    await appendUniqueJsonLine(this.structureDatasetPath(), sample);
    await appendUniqueJsonLine(this.brepDatasetPath(), { ...sample, geometry });
    return sample;
  }

  async trainModels() {
    const structureSamples = await countLines(this.structureDatasetPath());
    const brepSamples = await countLines(this.brepDatasetPath());
    if (structureSamples < this.minSamples || brepSamples < this.minSamples) {
      return { ok: true, trained: false, reason: "not-enough-samples", structureSamples, brepSamples };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const structureTmp = path.join(this.runtimeDir, `.cad-model-${stamp}.json`);
    const brepTmp = path.join(this.runtimeDir, `.brep-model-${stamp}.json`);
    await runJson(this.python, [this.structureTrainScript, "--dataset", this.structureDatasetPath(), "--out", structureTmp, "--latent-dim", "8"], { cwd: this.rootDir, timeoutMs: 180000 });
    await runJson(this.python, [this.brepTrainScript, "--dataset", this.brepDatasetPath(), "--out", brepTmp, "--latent-dim", "8", "--hidden-dim", "64", "--epochs", String(this.epochs)], { cwd: this.rootDir, timeoutMs: 300000 });
    const modelVersion = `vae-${Date.now()}`;
    const structureModel = JSON.parse(await readFile(structureTmp, "utf8"));
    const brepModel = JSON.parse(await readFile(brepTmp, "utf8"));
    structureModel.modelVersion = modelVersion;
    structureModel.trainedAt = new Date().toISOString();
    brepModel.modelVersion = modelVersion;
    brepModel.trainedAt = new Date().toISOString();
    await writeFile(structureTmp, JSON.stringify(structureModel, null, 2), "utf8");
    await writeFile(brepTmp, JSON.stringify(brepModel, null, 2), "utf8");
    await rename(structureTmp, this.structureModelPath());
    await rename(brepTmp, this.brepModelPath());
    const registry = await readJsonOrDefault(this.registryPath(), { format: "ai-cad-latent-model-registry-v1", activeModel: null, versions: [] });
    const entry = {
      modelVersion,
      trainedAt: structureModel.trainedAt,
      structureModel: path.basename(this.structureModelPath()),
      brepModel: path.basename(this.brepModelPath()),
      structureSamples,
      brepSamples,
      structureMetrics: structureModel.metrics || {},
      brepMetrics: brepModel.metrics || {}
    };
    registry.activeModel = entry;
    registry.versions = [...(registry.versions || []), entry].slice(-20);
    await writeFile(this.registryPath(), JSON.stringify(registry, null, 2), "utf8");
    return { ok: true, trained: true, activeModel: entry, structureSamples, brepSamples };
  }

  emit(status, payload) {
    try { this.onEvent(`latent:training:${status}`, { status, ...payload }); } catch { /* status reporting must never block CAD */ }
  }
}

export function buildTrainingSample({ job, source, id, geometry }) {
  const plan = job.plan || {};
  const parts = Array.isArray(plan.parts) ? plan.parts : [];
  const visiblePartObjectCount = Number(job.freeCadBridgeReport?.visiblePartObjectCount || 0);
  const featureTypes = {};
  const primitiveTypes = {};
  for (const part of parts) {
    for (const primitive of part.primitives || []) primitiveTypes[primitive.type || "unknown"] = (primitiveTypes[primitive.type || "unknown"] || 0) + 1;
    for (const feature of part.features || []) featureTypes[feature.type || "unknown"] = (featureTypes[feature.type || "unknown"] || 0) + 1;
  }
  const tokens = [
    `parts:${parts.length}`,
    `relations:${(plan.relations || []).length}`,
    `joints:${(plan.joints || []).length}`,
    ...Object.entries(primitiveTypes).map(([type, count]) => `primitive:${type}:${count}`),
    ...Object.entries(featureTypes).flatMap(([type, count]) => [`feature:${type}`, `feature:${type}:${count}`]),
    ...parts.flatMap((part) => [part.name, part.role].filter(Boolean).flatMap((value) => String(value).toLowerCase().match(/[a-z0-9.#+-]+/g) || [])),
    "quality:geometry-validated",
    ...(visiblePartObjectCount > 0 ? ["freecad:visible"] : [])
  ];
  return {
    format: "ai-cad-latent-sample-v1",
    id,
    savedAt: new Date().toISOString(),
    assemblyId: job.id,
    name: plan.name || "AI_CAD_Assembly",
    comment: `自动回流：${source}`,
    geometryPolicy: { learnedRepresentation: "CAD structure JSON + BREP descriptors", learnsGeometryFiles: false, usesStepStlFcstdAsEvidenceOnly: true },
    structure: { name: plan.name || "", partCount: parts.length, relationCount: (plan.relations || []).length, jointCount: (plan.joints || []).length, primitiveTypes, featureTypes, partRoles: parts.map((part) => part.role || part.name || part.id).filter(Boolean).slice(0, 12), jointTypes: (plan.joints || []).map((joint) => joint.type || "fixed").slice(0, 12) },
    quality: { score: 100, retainedForLearning: true, trainingVerified: true, cadqueryBuilt: true, freecadVisible: visiblePartObjectCount > 0, visiblePartObjectCount, failedConstraintCount: Number(job.freeCadBridgeReport?.failedConstraints?.length || 0), status: job.status },
    tokens: [...new Set(tokens.filter(Boolean))].sort(),
    latent: { kind: "sparse-cad-token-baseline", learnedRepresentation: "CAD structure JSON", tokens: [...new Set(tokens.filter(Boolean))].sort() },
    geometry
  };
}

async function ensureSeed(source, target) {
  try { await stat(target); } catch { await copyFile(source, target); }
}

async function datasetHasId(file, id) {
  try {
    const text = await readFile(file, "utf8");
    return text.split(/\r?\n/).some((line) => { try { return JSON.parse(line).id === id; } catch { return false; } });
  } catch { return false; }
}

async function appendUniqueJsonLine(file, sample) {
  if (await datasetHasId(file, sample.id)) return false;
  const existing = await readFile(file, "utf8").catch(() => "");
  await writeFile(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${JSON.stringify(sample, null, 0)}\n`, "utf8");
  return true;
}

async function countLines(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split(/\r?\n/).filter((line) => line.trim()).length;
}

async function readJsonOrDefault(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

function runJson(command, args, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`latent training timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.slice(-1200)}`));
      const text = stdout.trim();
      try {
        JSON.parse(text);
        resolve(text);
      } catch {
        reject(new Error(`${path.basename(command)} returned invalid JSON: ${text.slice(-1200)}`));
      }
    });
  });
}
