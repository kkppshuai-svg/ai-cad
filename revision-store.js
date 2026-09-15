import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";


const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const REVISION_PATTERN = /^rev-\d{4,}$/;
const promotionLocks = new Map();


export async function createCandidateRevision(root, assemblyId, plan, metadata = {}) {
  const assemblyRoot = assemblyPath(root, assemblyId);
  const revisionsRoot = path.join(assemblyRoot, "revisions");
  await mkdir(revisionsRoot, { recursive: true });
  const { revisionId, revisionDir } = await allocateRevisionDirectory(revisionsRoot, metadata.revisionId);

  const now = new Date().toISOString();
  const manifest = {
    format: "ai-cad-revision-v1",
    id: revisionId,
    assemblyId,
    status: "candidate",
    createdAt: now,
    updatedAt: now,
    parentRevision: metadata.parentRevision || null,
    summary: metadata.summary || "",
    affectedPartIds: uniqueStrings(metadata.affectedPartIds),
    diff: Array.isArray(metadata.diff) ? structuredClone(metadata.diff) : [],
    planChecksum: checksumJson(plan)
  };
  await atomicWriteJson(path.join(revisionDir, "feature-plan.json"), plan);
  await atomicWriteJson(path.join(revisionDir, "revision.json"), manifest);
  return structuredClone(manifest);
}


export async function promoteRevision(root, assemblyId, revisionId, validationReport = {}) {
  const lockKey = `${path.resolve(root)}\0${assemblyId}`;
  return withPromotionLock(lockKey, () => promoteRevisionUnlocked(root, assemblyId, revisionId, validationReport));
}


async function promoteRevisionUnlocked(root, assemblyId, revisionId, validationReport = {}) {
  validateRevisionId(revisionId);
  if (Number(validationReport.blockingErrorCount || 0) > 0) {
    throw new Error(`Revision ${revisionId} has blocking validation errors`);
  }
  const assemblyRoot = assemblyPath(root, assemblyId);
  const target = await readRevision(root, assemblyId, revisionId);
  if (!isSuccessfulStatus(target.status) && target.status !== "candidate") {
    throw new Error(`Revision ${revisionId} cannot be promoted from status ${target.status}`);
  }

  const current = await readCurrentPointer(assemblyRoot);
  if (target.status === "candidate" && (current?.id || null) !== (target.parentRevision || null)) {
    const error = new Error(`Stale candidate ${revisionId}: expected current revision ${target.parentRevision || "<none>"}, found ${current?.id || "<none>"}`);
    error.code = "STALE_CANDIDATE";
    throw error;
  }
  if (current?.id && current.id !== revisionId) {
    const previous = await readRevision(root, assemblyId, current.id);
    if (previous.status === "current") {
      previous.status = "successful";
      previous.updatedAt = new Date().toISOString();
      await writeRevisionManifest(root, assemblyId, previous);
    }
  }

  const now = new Date().toISOString();
  target.status = "current";
  target.updatedAt = now;
  target.promotedAt = now;
  target.validationSummary = validationReport;
  await atomicWriteJson(path.join(revisionPath(root, assemblyId, revisionId), "validation-report.json"), validationReport);
  await writeRevisionManifest(root, assemblyId, target);
  await atomicWriteJson(path.join(assemblyRoot, "current.json"), { id: revisionId, updatedAt: now, planChecksum: target.planChecksum });
  return structuredClone(target);
}


async function withPromotionLock(key, operation) {
  const previous = promotionLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  promotionLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (promotionLocks.get(key) === current) promotionLocks.delete(key);
  }
}


export async function markRevisionFailed(root, assemblyId, revisionId, failure) {
  validateRevisionId(revisionId);
  const manifest = await readRevision(root, assemblyId, revisionId);
  if (manifest.status === "current") throw new Error("Cannot mark the current revision as failed");
  manifest.status = "failed";
  manifest.updatedAt = new Date().toISOString();
  manifest.failure = normalizeFailure(failure);
  await atomicWriteJson(path.join(revisionPath(root, assemblyId, revisionId), "failure.json"), manifest.failure);
  await writeRevisionManifest(root, assemblyId, manifest);
  return structuredClone(manifest);
}


export async function getCurrentRevision(root, assemblyId) {
  const assemblyRoot = assemblyPath(root, assemblyId);
  const pointer = await readCurrentPointer(assemblyRoot);
  if (!pointer?.id) return null;
  return readRevision(root, assemblyId, pointer.id);
}


export async function listRevisions(root, assemblyId) {
  const revisionsRoot = path.join(assemblyPath(root, assemblyId), "revisions");
  if (!(await exists(revisionsRoot))) return [];
  const names = (await readdir(revisionsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && REVISION_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  return Promise.all(names.map((revisionId) => readRevision(root, assemblyId, revisionId)));
}


export async function revertRevision(root, assemblyId, revisionId) {
  validateRevisionId(revisionId);
  const target = await readRevision(root, assemblyId, revisionId);
  if (!isSuccessfulStatus(target.status)) throw new Error(`Can only revert to a successful revision: ${revisionId}`);
  return promoteRevision(root, assemblyId, revisionId, target.validationSummary || { blockingErrorCount: 0 });
}


export async function writeRevisionState(root, assemblyId, revisionId, state) {
  const revision = await readRevision(root, assemblyId, revisionId);
  const serializedState = JSON.parse(JSON.stringify(state));
  if (!serializedState?.plan || checksumJson(serializedState.plan) !== revision.planChecksum) throw new Error(`Revision ${revisionId} state plan checksum does not match its manifest`);
  const artifactManifest = [];
  for (const artifactPath of collectArtifactPaths(serializedState.artifacts)) {
    const info = await stat(artifactPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) throw new Error(`Revision artifact is missing: ${artifactPath}`);
    if (!info.isFile()) continue;
    artifactManifest.push({ path: artifactPath, size: info.size, checksum: await checksumFile(artifactPath) });
  }
  const payload = { format: "ai-cad-revision-state-v1", state: serializedState, artifactManifest };
  payload.stateChecksum = checksumJson({ state: payload.state, artifactManifest });
  await atomicWriteJson(path.join(revisionPath(root, assemblyId, revisionId), "revision-state.json"), payload);
  return structuredClone(payload);
}


export async function loadRevisionState(root, assemblyId, revisionId, { allowLegacyStateChecksum = false } = {}) {
  const revision = await readRevision(root, assemblyId, revisionId);
  const target = path.join(revisionPath(root, assemblyId, revisionId), "revision-state.json");
  const payload = JSON.parse(await readFile(target, "utf8"));
  const expectedStateChecksum = checksumJson({ state: payload.state, artifactManifest: payload.artifactManifest || [] });
  if (payload.stateChecksum !== expectedStateChecksum && !allowLegacyStateChecksum) throw new Error(`Revision ${revisionId} state checksum is invalid`);
  if (!payload.state?.plan || checksumJson(payload.state.plan) !== revision.planChecksum) throw new Error(`Revision ${revisionId} state plan checksum is invalid`);
  for (const artifact of payload.artifactManifest || []) {
    const info = await stat(artifact.path).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!info?.isFile() || info.size !== artifact.size || await checksumFile(artifact.path) !== artifact.checksum) {
      throw new Error(`Revision artifact checksum mismatch: ${artifact.path}`);
    }
  }
  return structuredClone(payload.state);
}


async function readRevision(root, assemblyId, revisionId) {
  const manifestPath = path.join(revisionPath(root, assemblyId, revisionId), "revision.json");
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Revision not found: ${revisionId}`);
    throw error;
  }
}


async function writeRevisionManifest(root, assemblyId, manifest) {
  await atomicWriteJson(path.join(revisionPath(root, assemblyId, manifest.id), "revision.json"), manifest);
}


async function nextRevisionId(revisionsRoot) {
  const names = await readdir(revisionsRoot).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const highest = names.reduce((value, name) => {
    const match = name.match(/^rev-(\d+)$/);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  return `rev-${String(highest + 1).padStart(4, "0")}`;
}


async function allocateRevisionDirectory(revisionsRoot, requestedRevisionId) {
  if (requestedRevisionId) {
    const revisionId = validateRevisionId(requestedRevisionId);
    const revisionDir = path.join(revisionsRoot, revisionId);
    try {
      await mkdir(revisionDir, { recursive: false });
      return { revisionId, revisionDir };
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`Revision already exists: ${revisionId}`);
      throw error;
    }
  }
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const revisionId = await nextRevisionId(revisionsRoot);
    const revisionDir = path.join(revisionsRoot, revisionId);
    try {
      await mkdir(revisionDir, { recursive: false });
      return { revisionId, revisionDir };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to allocate a unique revision ID");
}


async function atomicWriteJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}


function assemblyPath(root, assemblyId) {
  if (typeof root !== "string" || !root) throw new TypeError("Revision root is required");
  if (typeof assemblyId !== "string" || !ID_PATTERN.test(assemblyId)) throw new Error(`Invalid assembly identifier: ${assemblyId}`);
  return path.join(path.resolve(root), assemblyId);
}


function revisionPath(root, assemblyId, revisionId) {
  validateRevisionId(revisionId);
  return path.join(assemblyPath(root, assemblyId), "revisions", revisionId);
}


function validateRevisionId(revisionId) {
  if (typeof revisionId !== "string" || !REVISION_PATTERN.test(revisionId)) throw new Error(`Invalid revision identifier: ${revisionId}`);
  return revisionId;
}


async function readCurrentPointer(assemblyRoot) {
  try {
    return JSON.parse(await readFile(path.join(assemblyRoot, "current.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}


function isSuccessfulStatus(status) {
  return status === "current" || status === "successful";
}


function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value))];
}


function normalizeFailure(failure) {
  if (failure instanceof Error) return { name: failure.name, message: failure.message };
  if (failure && typeof failure === "object" && !Array.isArray(failure)) return structuredClone(failure);
  return { message: String(failure || "Revision failed") };
}


function checksumJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}


function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}


function collectArtifactPaths(value, result = new Set()) {
  if (typeof value === "string" && path.isAbsolute(value)) result.add(value);
  else if (Array.isArray(value)) for (const item of value) collectArtifactPaths(item, result);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectArtifactPaths(item, result);
  return [...result].sort();
}


async function checksumFile(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}


async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
