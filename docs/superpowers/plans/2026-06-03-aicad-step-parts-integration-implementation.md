# AI-CAD step.parts Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let AI-CAD use real downloaded step.parts standard STEP components inside generated CadQuery/FreeCAD assemblies.

**Architecture:** Add a small `step-parts.js` client with injectable HTTP for deterministic tests, then hydrate `mode: "standard_part"` plan entries before the CadQuery build. Extend `scripts/cadquery_build.py` so mixed assemblies can import existing STEP files, export placed/local artifacts, and flow through the existing kinematic package and FreeCAD `.FCStd` output.

**Tech Stack:** Node.js ES modules, Node test runner, CadQuery Python, step.parts hosted API

---

### Task 1: step.parts client and cache

**Files:**
- Create: `/home/kkk/ai-cad/step-parts.js`
- Create: `/home/kkk/ai-cad/step-parts.test.mjs`
- Modify: `/home/kkk/ai-cad/package.json`

- [ ] **Step 1: Write failing client tests**

Create `step-parts.test.mjs` with tests that use injected mock HTTP handlers:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  StepPartsError,
  buildStepPartsSearchUrl,
  resolveAndDownloadStepPart,
} from "./step-parts.js";

test("builds step.parts search URLs with query and facets", () => {
  const url = buildStepPartsSearchUrl({
    origin: "https://api.step.parts",
    query: "608ZZ bearing",
    category: "bearing",
    tag: "608zz",
  });

  assert.equal(
    url,
    "https://api.step.parts/v1/parts?page=1&pageSize=5&q=608ZZ+bearing&category=bearing&tag=608zz",
  );
});

test("downloads the first matching part and verifies sha256", async () => {
  const stepBytes = Buffer.from("ISO-10303-21; mock step");
  const sha256 = createHash("sha256").update(stepBytes).digest("hex");
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url.includes("/v1/parts?")) {
      return {
        json: async () => ({
          total: 1,
          items: [{
            id: "bearing_608zz",
            name: "608ZZ bearing",
            downloadUrl: "https://api.step.parts/v1/parts/bearing_608zz/download",
            apiUrl: "https://api.step.parts/v1/parts/bearing_608zz",
            pageUrl: "https://www.step.parts/parts/bearing_608zz",
            sha256,
          }],
        }),
      };
    }
    return { arrayBuffer: async () => stepBytes };
  };

  const cacheDir = await mkdtemp(path.join(tmpdir(), "aicad-step-parts-"));
  const result = await resolveAndDownloadStepPart({
    request: { query: "608ZZ bearing" },
    cacheDir,
    httpRequest: request,
  });

  assert.equal(result.id, "bearing_608zz");
  assert.equal(result.checksumVerified, true);
  assert.equal(await readFile(result.localStepPath, "utf8"), stepBytes.toString());
  assert.equal(calls.length, 2);
});

test("uses exact id fetch when provided", async () => {
  const stepBytes = Buffer.from("ISO-10303-21; exact step");
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url.endsWith("/v1/parts/iso4762_m3x12")) {
      return {
        json: async () => ({
          id: "iso4762_m3x12",
          name: "M3x12 socket head cap screw",
          downloadUrl: "https://api.step.parts/v1/parts/iso4762_m3x12/download",
        }),
      };
    }
    return { arrayBuffer: async () => stepBytes };
  };

  const cacheDir = await mkdtemp(path.join(tmpdir(), "aicad-step-parts-"));
  const result = await resolveAndDownloadStepPart({
    request: { id: "iso4762_m3x12", query: "M3 x 12 screw" },
    cacheDir,
    httpRequest: request,
  });

  assert.equal(result.id, "iso4762_m3x12");
  assert.equal(calls[0], "https://api.step.parts/v1/parts/iso4762_m3x12");
});

test("throws a clear no-match error", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "aicad-step-parts-"));
  await assert.rejects(
    () => resolveAndDownloadStepPart({
      request: { query: "missing servo" },
      cacheDir,
      httpRequest: async () => ({ json: async () => ({ total: 0, items: [] }) }),
    }),
    (error) => error instanceof StepPartsError && /No step.parts result matched/.test(error.message),
  );
});

test("throws a clear checksum mismatch error", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "aicad-step-parts-"));
  await assert.rejects(
    () => resolveAndDownloadStepPart({
      request: { query: "bad checksum" },
      cacheDir,
      httpRequest: async (url) => url.includes("/v1/parts?")
        ? { json: async () => ({ items: [{ id: "bad", name: "bad", downloadUrl: "https://api.step.parts/v1/parts/bad/download", sha256: "deadbeef" }] }) }
        : { arrayBuffer: async () => Buffer.from("wrong") },
    }),
    (error) => error instanceof StepPartsError && /checksum/i.test(error.message),
  );
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `node --test step-parts.test.mjs`

Expected: FAIL because `step-parts.js` does not exist.

- [ ] **Step 3: Implement the client**

Create `step-parts.js`:

```js
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

export function buildStepPartsSearchUrl({ origin = DEFAULT_ORIGIN, query = "", category = "", family = "", standard = "", tag = "", page = 1, pageSize = 5 } = {}) {
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

export async function resolveAndDownloadStepPart({ request, cacheDir, origin = DEFAULT_ORIGIN, httpRequest = defaultHttpRequest }) {
  const spec = normalizeRequest(request);
  const record = spec.id
    ? await fetchPartById({ id: spec.id, origin, httpRequest, label: spec.query || spec.id })
    : await searchFirstPart({ spec, origin, httpRequest });
  return downloadPart({ record, cacheDir, httpRequest });
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
  if (spec.provider !== "step.parts") throw new StepPartsError(`Unsupported standard part provider: ${spec.provider}`);
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
    throw new StepPartsError(`Failed to fetch step.parts part "${label}": ${error.message || error}`, { code: "STEP_PARTS_FETCH_FAILED", cause: error });
  }
}

async function searchFirstPart({ spec, origin, httpRequest }) {
  const url = buildStepPartsSearchUrl({ origin, ...spec });
  let result;
  try {
    result = await (await httpRequest(url)).json();
  } catch (error) {
    throw new StepPartsError(`Failed to search step.parts for "${spec.query || spec.tag || spec.category}": ${error.message || error}`, { code: "STEP_PARTS_SEARCH_FAILED", cause: error });
  }
  const items = Array.isArray(result.items) ? result.items : [];
  if (!items.length) {
    throw new StepPartsError(`No step.parts result matched standard part "${spec.query || spec.tag || spec.category}"`, { code: "STEP_PARTS_NO_MATCH" });
  }
  return items[0];
}

async function downloadPart({ record, cacheDir, httpRequest }) {
  if (!record?.id) throw new StepPartsError("step.parts record is missing id", { code: "STEP_PARTS_BAD_RECORD" });
  if (!record.downloadUrl) throw new StepPartsError(`step.parts part "${record.id}" has no downloadable STEP file`, { code: "STEP_PARTS_NO_DOWNLOAD" });
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
    throw new StepPartsError(`Failed to download step.parts part "${record.name || record.id}": ${error.message || error}`, { code: "STEP_PARTS_DOWNLOAD_FAILED", cause: error });
  }
  const actualSha256 = sha256(data);
  if (record.sha256 && actualSha256 !== record.sha256) {
    throw new StepPartsError(`step.parts checksum mismatch for "${record.name || record.id}": expected ${record.sha256}, got ${actualSha256}`, { code: "STEP_PARTS_CHECKSUM_MISMATCH" });
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
    throw new StepPartsError("Global fetch is not available in this Node runtime", { code: "STEP_PARTS_FETCH_UNAVAILABLE" });
  }
  const response = await fetch(url, { headers: { "User-Agent": "AI-CAD step.parts integration" } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response;
}
```

- [ ] **Step 4: Wire test into `npm run check`**

Add `step-parts.test.mjs` to the Node test list in `package.json`.

- [ ] **Step 5: Verify**

Run: `node --test step-parts.test.mjs`

Expected: PASS.

### Task 2: Prompt and plan validation support

**Files:**
- Modify: `/home/kkk/ai-cad/prompt-contract.js`
- Modify: `/home/kkk/ai-cad/prompt-contract.test.mjs`
- Modify: `/home/kkk/ai-cad/server.js`

- [ ] **Step 1: Add failing prompt contract test**

Extend `prompt-contract.test.mjs`:

```js
test("planner prompt uses step.parts standard part mode for off-the-shelf hardware", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "加一个 608ZZ 轴承和 M3x12 内六角螺钉",
    searchContext: null,
    excellentCadqueryContext: "No examples",
  });

  assert.match(prompt, /"mode": "standard_part"/);
  assert.match(prompt, /"standardPart"/);
  assert.match(prompt, /step\.parts/);
  assert.match(prompt, /Do not invent exact standard part dimensions/i);
});
```

- [ ] **Step 2: Run and verify fail**

Run: `node --test prompt-contract.test.mjs`

Expected: FAIL because the prompt does not describe `mode: "standard_part"` yet.

- [ ] **Step 3: Update prompt schema and rules**

In `prompt-contract.js`, add `mode` and `standardPart` to each part schema and add rules:

```text
- Use "mode": "standard_part" with "standardPart.provider": "step.parts" when the user asks for recognizable off-the-shelf hardware such as screws, bearings, nuts, washers, standoffs, connectors, motors, or servos.
- Do not invent exact standard part dimensions when step.parts lookup is appropriate. Provide a focused standardPart.query and optional category/family/standard/tag instead.
- Generated custom geometry parts may omit mode or use "mode": "generated".
```

- [ ] **Step 4: Update plan validation**

In `validateAssemblyPlan(plan)` in `server.js`:

```js
const mode = part.mode === "standard_part" ? "standard_part" : "generated";
part.mode = mode;
if (mode === "standard_part") {
  part.standardPart = sanitizeStandardPartRequest(part.standardPart || {});
  part.primitives = [];
  part.features = [];
} else {
  if (!Array.isArray(part.primitives) || part.primitives.length === 0) {
    part.primitives = [{ type: "box", size: [10, 10, 10], center: true }];
  }
  if (part.primitives.length > 16) throw new Error("Part has too many primitives");
  part.primitives = part.primitives.map(sanitizePrimitive);
  if (!Array.isArray(part.features)) part.features = [];
  if (part.features.length > 40) throw new Error("Part has too many features");
  part.features = part.features.map(sanitizeFeature);
}
```

Add:

```js
function sanitizeStandardPartRequest(value = {}) {
  const provider = sanitizeText(value.provider || "step.parts", 40);
  if (provider !== "step.parts") throw new Error(`Unsupported standard part provider: ${provider}`);
  const request = {
    provider,
    id: sanitizeText(value.id || "", 120),
    query: sanitizeText(value.query || "", 160),
    category: sanitizeText(value.category || "", 80),
    family: sanitizeText(value.family || "", 80),
    standard: sanitizeText(value.standard || "", 80),
    tag: sanitizeText(value.tag || "", 80),
  };
  if (!request.id && !request.query && !request.category && !request.family && !request.standard && !request.tag) {
    throw new Error("step.parts standard part requires an id, query, or facet");
  }
  return request;
}
```

- [ ] **Step 5: Verify**

Run: `node --check server.js && node --test prompt-contract.test.mjs`

Expected: PASS.

### Task 3: Hydrate standard parts before assembly build

**Files:**
- Create: `/home/kkk/ai-cad/standard-parts.js`
- Modify: `/home/kkk/ai-cad/server.js`
- Create: `/home/kkk/ai-cad/standard-parts.test.mjs`
- Modify: `/home/kkk/ai-cad/package.json`

- [ ] **Step 1: Create a hydration helper module for tests and server use**

Create `standard-parts.js`:

```js
import { resolveAndDownloadStepPart } from "./step-parts.js";

export async function hydrateStandardPartsForPlan(plan, {
  cacheDir,
  resolver = resolveAndDownloadStepPart,
} = {}) {
  if (!cacheDir) throw new Error("standard parts cacheDir is required");
  for (const part of plan.parts || []) {
    if (part.mode !== "standard_part") continue;
    const resolved = await resolver({
      request: part.standardPart,
      cacheDir,
    });
    part.standardPart = {
      ...part.standardPart,
      resolved,
    };
    part.sourceStepPath = resolved.localStepPath;
    part.primitives = [];
    part.features = [];
  }
  return plan;
}
```

- [ ] **Step 2: Add failing hydration test**

Create `standard-parts.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { hydrateStandardPartsForPlan } from "./standard-parts.js";

test("hydrates standard_part entries with local STEP path and provenance", async () => {
  const plan = {
    name: "bearing mount",
    parts: [{
      id: "bearing_608zz",
      name: "608ZZ bearing",
      role: "bearing",
      mode: "standard_part",
      standardPart: { provider: "step.parts", query: "608ZZ bearing" },
      pose: { translate: [1, 2, 3], rotate: [0, 0, 90] },
    }],
    relations: [],
    joints: [],
  };

  await hydrateStandardPartsForPlan(plan, {
    cacheDir: "/tmp/not-used",
    resolver: async ({ request }) => ({
      provider: "step.parts",
      id: "bearing_608zz",
      name: "608ZZ bearing",
      pageUrl: "https://www.step.parts/parts/bearing_608zz",
      apiUrl: "https://api.step.parts/v1/parts/bearing_608zz",
      sha256: "abc",
      checksumVerified: true,
      localStepPath: "/tmp/bearing.step",
      request,
    }),
  });

  assert.equal(plan.parts[0].sourceStepPath, "/tmp/bearing.step");
  assert.equal(plan.parts[0].standardPart.resolved.id, "bearing_608zz");
  assert.deepEqual(plan.parts[0].primitives, []);
  assert.deepEqual(plan.parts[0].features, []);
});
```

- [ ] **Step 3: Run and verify fail**

Run: `node --test standard-parts.test.mjs`

Expected: FAIL until `standard-parts.js` exists.

- [ ] **Step 4: Call hydration in `buildAssembly()`**

In `server.js`, import the helper:

```js
import { hydrateStandardPartsForPlan } from "./standard-parts.js";
```

Add runtime cache path:

```js
const standardPartsCacheDir = path.join(__dirname, "standard-parts-cache");
```

In `buildAssembly(plan)`, after `validateAssemblyPlan(plan)` and before writing `assembly-manifest.json`, call:

```js
await hydrateStandardPartsForPlan(plan, { cacheDir: standardPartsCacheDir });
```

Ensure `standard-parts-cache/` is created at startup.

- [ ] **Step 5: Include standard part provenance in public output**

In `publicAssembly(job).parts`, include:

```js
mode: part.mode || "generated",
standardPart: part.standardPart || null,
```

When building `job.parts` from build outputs, carry `mode`, `standardPart`, and `sourceStepPath` from the plan part.

- [ ] **Step 6: Wire test into check and verify**

Add `standard-parts.test.mjs` to `package.json` check.

Run: `node --test standard-parts.test.mjs`

Expected: PASS.

### Task 4: Import standard STEP files in CadQuery build

**Files:**
- Modify: `/home/kkk/ai-cad/scripts/cadquery_build.py`

- [ ] **Step 1: Add STEP import support**

Add:

```python
def import_step_part(part):
    source = part.get("sourceStepPath")
    if not source or not os.path.exists(source):
        raise ValueError("Standard part {} is missing sourceStepPath".format(part.get("id", part.get("name", "part"))))
    imported = cq.importers.importStep(source)
    if hasattr(imported, "val"):
        return imported
    return cq.Workplane("XY").newObject(imported.vals())
```

In `main()`, choose:

```python
if part.get("mode") == "standard_part":
    built = import_step_part(part)
else:
    built = build_part(part)
```

- [ ] **Step 2: Preserve metadata in build output**

For each `part_outputs` entry, add:

```python
"mode": part.get("mode", "generated"),
"standardPart": part.get("standardPart"),
"sourceStepPath": part.get("sourceStepPath"),
```

- [ ] **Step 3: Verify Python syntax**

Run: `python3 -m py_compile scripts/cadquery_build.py`

Expected: PASS.

### Task 5: Package provenance and docs

**Files:**
- Modify: `/home/kkk/ai-cad/server.js`
- Modify: `/home/kkk/ai-cad/README.md`
- Modify: `/home/kkk/ai-cad/.gitignore`

- [ ] **Step 1: Keep provenance through kinematic package**

In `buildKinematicPackage(job)`, include in `packageParts.push()`:

```js
mode: part.mode || "generated",
standardPart: part.standardPart || null,
```

This makes `assembly-kinematics.json`, `manifest.json`, and FreeCAD metadata aware of step.parts sourced components.

- [ ] **Step 2: Ignore runtime cache**

Add to `.gitignore`:

```gitignore
standard-parts-cache/
```

- [ ] **Step 3: Update README**

Document:

```md
- step.parts 标准件：对话里可以直接要求 608ZZ 轴承、M3 螺钉等标准件；AI-CAD 会通过 step.parts 下载真实 STEP，缓存到 `standard-parts-cache/`，并打包进 FreeCAD 主输出。
```

Mention network requirement and clear failure behavior.

- [ ] **Step 4: Verify targeted searches**

Run:

```bash
rg -n "standard-parts-cache|step.parts|standard_part|standardPart" README.md .gitignore server.js prompt-contract.js scripts/cadquery_build.py
```

Expected: relevant matches in all intended files.

### Task 6: Full verification

**Files:**
- Modify as needed from earlier tasks only

- [ ] **Step 1: Run full check**

Run: `npm run check`

Expected: PASS with all Node tests and Python compile checks.

- [ ] **Step 2: Optional live smoke test only if network is allowed**

Run:

```bash
node --test step-parts.test.mjs
```

Do not require live step.parts access for completion. If live network is unavailable, report that only mocked API tests were run.

- [ ] **Step 3: Review git status**

Run: `git status --short`

Expected: step.parts integration files are present; unrelated dirty worktree changes are left untouched.
