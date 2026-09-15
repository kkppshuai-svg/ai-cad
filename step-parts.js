import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ORIGIN = "https://api.step.parts";

export class StepPartsError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "StepPartsError";
    this.code = options.code || "STEP_PARTS_ERROR";
    this.cause = options.cause;
  }
}

export function buildStepPartsSearchUrl({
  origin = DEFAULT_ORIGIN,
  query = "",
  category = "",
  family = "",
  standard = "",
  tag = "",
  page = 1,
  pageSize = 5,
} = {}) {
  const url = new URL("/v1/parts", origin);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  if (query) url.searchParams.set("q", query);
  if (category) url.searchParams.set("category", category);
  if (family) url.searchParams.set("family", family);
  if (standard) url.searchParams.set("standard", standard);
  if (tag) url.searchParams.set("tag", tag);
  return url.href;
}

export async function resolveAndDownloadStepPart({
  request,
  cacheDir,
  origin = DEFAULT_ORIGIN,
  httpRequest = defaultHttpRequest,
}) {
  if (!cacheDir) throw new StepPartsError("step.parts cacheDir is required");
  const spec = normalizeRequest(request);
  const record = spec.id
    ? await fetchPartById({ id: spec.id, origin, httpRequest, label: spec.query || spec.id })
    : await searchFirstPart({ spec, origin, httpRequest });
  return downloadPart({ record, cacheDir, httpRequest });
}

export async function searchStepPartsCandidates({
  request,
  origin = DEFAULT_ORIGIN,
  pageSize = 3,
  httpRequest = defaultHttpRequest,
}) {
  const spec = normalizeRequest(request);
  const label = spec.query || spec.id || spec.tag || spec.category || spec.family || spec.standard;
  const url = spec.id
    ? new URL(`/v1/parts/${encodeURIComponent(spec.id)}`, origin).href
    : buildStepPartsSearchUrl({ origin, ...spec, pageSize });
  try {
    const payload = await (await httpRequest(url)).json();
    const items = spec.id
      ? [payload]
      : Array.isArray(payload.items)
        ? payload.items
        : [];
    return items
      .filter((item) => item?.id)
      .slice(0, Math.max(1, Math.min(5, Number(pageSize || 3))))
      .map((item) => ({
        id: item.id,
        name: item.name || item.id,
        category: item.category || null,
        family: item.family || null,
        standard: item.standard || null,
        attributes: item.attributes || null,
        apiUrl: item.apiUrl || null,
        pageUrl: item.pageUrl || null,
        stepUrl: item.stepUrl || null,
        downloadUrl: item.downloadUrl || null,
        sha256: item.sha256 || null
      }));
  } catch (error) {
    throw new StepPartsError(`Failed to search step.parts for "${label}": ${error.message || error}`, {
      code: "STEP_PARTS_SEARCH_FAILED",
      cause: error,
    });
  }
}

function normalizeRequest(value = {}) {
  const spec = {
    provider: value.provider || "step.parts",
    id: String(value.id || "").trim(),
    query: String(value.query || "").trim(),
    category: String(value.category || "").trim(),
    family: String(value.family || "").trim(),
    standard: String(value.standard || "").trim(),
    tag: String(value.tag || "").trim(),
  };
  if (spec.provider !== "step.parts") {
    throw new StepPartsError(`Unsupported standard part provider: ${spec.provider}`);
  }
  if (!spec.id && !spec.query && !spec.category && !spec.family && !spec.standard && !spec.tag) {
    throw new StepPartsError("step.parts standard part requires an id, query, or facet");
  }
  return spec;
}

async function fetchPartById({ id, origin, httpRequest, label }) {
  const url = new URL(`/v1/parts/${encodeURIComponent(id)}`, origin).href;
  try {
    return await (await httpRequest(url)).json();
  } catch (error) {
    throw new StepPartsError(`Failed to fetch step.parts part "${label}": ${error.message || error}`, {
      code: "STEP_PARTS_FETCH_FAILED",
      cause: error,
    });
  }
}

async function searchFirstPart({ spec, origin, httpRequest }) {
  const label = spec.query || spec.tag || spec.category || spec.family || spec.standard;
  const url = buildStepPartsSearchUrl({ origin, ...spec });
  let result;
  try {
    result = await (await httpRequest(url)).json();
  } catch (error) {
    throw new StepPartsError(`Failed to search step.parts for "${label}": ${error.message || error}`, {
      code: "STEP_PARTS_SEARCH_FAILED",
      cause: error,
    });
  }
  const items = Array.isArray(result.items) ? result.items : [];
  if (!items.length) {
    throw new StepPartsError(`No step.parts result matched standard part "${label}"`, {
      code: "STEP_PARTS_NO_MATCH",
    });
  }
  return items[0];
}

async function downloadPart({ record, cacheDir, httpRequest }) {
  if (!record?.id) throw new StepPartsError("step.parts record is missing id", { code: "STEP_PARTS_BAD_RECORD" });
  if (!record.downloadUrl) {
    throw new StepPartsError(`step.parts part "${record.id}" has no downloadable STEP file`, {
      code: "STEP_PARTS_NO_DOWNLOAD",
    });
  }

  await mkdir(cacheDir, { recursive: true });
  const hashSuffix = record.sha256 ? `-${record.sha256.slice(0, 12)}` : "";
  const localStepPath = path.join(cacheDir, `${safeFileName(record.id)}${hashSuffix}.step`);

  if (existsSync(localStepPath)) {
    const cached = await readFile(localStepPath);
    const cachedSha256 = sha256(cached);
    if (!record.sha256 || cachedSha256 === record.sha256) {
      return provenance(record, localStepPath, cachedSha256, Boolean(record.sha256), true);
    }
  }

  let data;
  try {
    data = Buffer.from(await (await httpRequest(record.downloadUrl)).arrayBuffer());
  } catch (error) {
    throw new StepPartsError(`Failed to download step.parts part "${record.name || record.id}": ${error.message || error}`, {
      code: "STEP_PARTS_DOWNLOAD_FAILED",
      cause: error,
    });
  }

  const actualSha256 = sha256(data);
  if (record.sha256 && actualSha256 !== record.sha256) {
    throw new StepPartsError(
      `step.parts checksum mismatch for "${record.name || record.id}": expected ${record.sha256}, got ${actualSha256}`,
      { code: "STEP_PARTS_CHECKSUM_MISMATCH" },
    );
  }
  await writeFile(localStepPath, data);
  return provenance(record, localStepPath, actualSha256, Boolean(record.sha256), false);
}

function provenance(record, localStepPath, actualSha256, checksumVerified, cacheHit) {
  return {
    provider: "step.parts",
    id: record.id,
    name: record.name || record.id,
    category: record.category || null,
    family: record.family || null,
    standard: record.standard || null,
    attributes: record.attributes || null,
    apiUrl: record.apiUrl || null,
    pageUrl: record.pageUrl || null,
    downloadUrl: record.downloadUrl || null,
    stepUrl: record.stepUrl || null,
    sha256: actualSha256,
    checksumVerified,
    cacheHit,
    localStepPath,
  };
}

function safeFileName(value) {
  return String(value || "part").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 100) || "part";
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function defaultHttpRequest(url) {
  if (typeof fetch !== "function") {
    throw new StepPartsError("Global fetch is not available in this Node runtime", {
      code: "STEP_PARTS_FETCH_UNAVAILABLE",
    });
  }
  const response = await fetch(url, {
    headers: { "User-Agent": "AI-CAD step.parts integration" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}
