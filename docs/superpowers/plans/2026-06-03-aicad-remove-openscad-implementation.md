# AI-CAD Remove OpenSCAD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the OpenSCAD auxiliary module from `ai-cad` so only the CadQuery and FreeCAD workflows remain.

**Architecture:** Delete the OpenSCAD-specific backend path entirely instead of hiding it behind compatibility shims. Then remove frontend usage, docs, setup references, and sample artifacts so the repository and runtime surface consistently describe a CadQuery/FreeCAD-only product.

**Tech Stack:** Node.js, browser JavaScript, shell scripts, Markdown docs, Node test runner

---

### Task 1: Add failing regression tests for OpenSCAD removal

**Files:**
- Create: `/home/kkk/ai-cad/remove-openscad.test.mjs`
- Modify: `/home/kkk/ai-cad/package.json`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("server and frontend no longer expose OpenSCAD product surface", () => {
  const serverJs = readFileSync(new URL("./server.js", import.meta.url), "utf8");
  const appJs = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(serverJs, /OPENSCAD_BIN/);
  assert.doesNotMatch(serverJs, /runOpenScad/);
  assert.doesNotMatch(serverJs, /\/api\/render/);
  assert.doesNotMatch(serverJs, /\/api\/export\/stl/);
  assert.doesNotMatch(appJs, /OpenSCAD/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test remove-openscad.test.mjs`
Expected: FAIL because `server.js` and `public/app.js` still contain OpenSCAD references.

- [ ] **Step 3: Add the test to the main check script**

```json
{
  "scripts": {
    "check": "node --check server.js && node --check public/app.js && python3 -m py_compile scripts/aicad_training_30.py && node --test security.test.mjs freecad-bridge.test.mjs freecad-open.test.mjs prompt-contract.test.mjs ui-copy.test.mjs remove-openscad.test.mjs"
  }
}
```

- [ ] **Step 4: Re-run the targeted test and keep it red**

Run: `node --test remove-openscad.test.mjs`
Expected: still FAIL until the product surface is removed.

- [ ] **Step 5: Commit**

```bash
git add remove-openscad.test.mjs package.json
git commit -m "test: lock openscad removal"
```

### Task 2: Remove OpenSCAD backend routes and runtime wiring

**Files:**
- Modify: `/home/kkk/ai-cad/server.js`

- [ ] **Step 1: Delete OpenSCAD executable detection and starter SCAD sample**

Remove these definitions from `server.js`:

```js
const openscadBin = validateCommandPath(process.env.OPENSCAD_BIN || "/snap/bin/openscad-nightly", "OPENSCAD_BIN");

const starterScad = `// AI CAD OpenSCAD workspace
cube([30, 20, 10], center = true);
`;
```

- [ ] **Step 2: Remove OpenSCAD status reporting**

Delete the OpenSCAD log line and status payload field:

```js
console.log(`OpenSCAD: ${openscadBin}`);
```

```js
openscadBin: publicCommandName(openscadBin),
sample: starterScad,
```

- [ ] **Step 3: Remove OpenSCAD-only API routes**

Delete these route branches from `handleApi()`:

```js
if (req.method === "POST" && url.pathname === "/api/render") { ... }
if (req.method === "GET" && url.pathname.startsWith("/api/render/")) { ... }
if (req.method === "POST" && url.pathname === "/api/export/stl") { ... }
```

- [ ] **Step 4: Remove the OpenSCAD execution function**

Delete the whole helper:

```js
async function runOpenScad(job, target) {
  // ...
}
```

- [ ] **Step 5: Remove any remaining SCAD-specific parsing or validation branches**

Delete the remaining OpenSCAD-only instruction and validation fragments:

```js
const instruction = `You generate OpenSCAD only.
```

```js
throw new Error("OpenSCAD code is required");
throw new Error("OpenSCAD code is too large");
```

- [ ] **Step 6: Run syntax and the removal test**

Run: `node --check server.js && node --test remove-openscad.test.mjs`
Expected: syntax PASS and the removal test either passes or only fails on frontend/doc references.

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "refactor: remove openscad backend module"
```

### Task 3: Remove frontend OpenSCAD UI and client calls

**Files:**
- Modify: `/home/kkk/ai-cad/public/app.js`

- [ ] **Step 1: Remove OpenSCAD engine wording from the status bar**

Replace:

```js
els.engineStatus.textContent = `CadQuery: ${status.cadqueryPython} | Codex: ${status.codexBin}${freecadLabel} | OpenSCAD 辅助: ${status.openscadBin}${searchLabel}`;
```

With:

```js
els.engineStatus.textContent = `CadQuery: ${status.cadqueryPython} | Codex: ${status.codexBin}${freecadLabel}${searchLabel}`;
```

- [ ] **Step 2: Remove client functions that call deleted routes**

Delete the OpenSCAD route callers:

```js
async function render(quality = "preview") { ... }
async function exportStl() { ... }
```

- [ ] **Step 3: Remove OpenSCAD-specific status text**

Delete the obsolete mapping entry:

```js
rendering: "OpenSCAD 渲染中",
```

- [ ] **Step 4: Run the focused removal test**

Run: `node --test remove-openscad.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "refactor: remove openscad frontend flow"
```

### Task 4: Remove repository artifacts and documentation references

**Files:**
- Modify: `/home/kkk/ai-cad/README.md`
- Modify: `/home/kkk/ai-cad/MIGRATION.md`
- Modify: `/home/kkk/ai-cad/scripts/setup_cadquery_env.sh`
- Modify: `/home/kkk/ai-cad/agents/aicad/SKILL.md`
- Modify: `/home/kkk/ai-cad/agents/aicad/references/project.md`
- Modify: `/home/kkk/ai-cad/agents/aicad/agent.yaml`
- Delete: `/home/kkk/ai-cad/NOTES.md`
- Delete: `/home/kkk/ai-cad/desk.scad`

- [ ] **Step 1: Remove OpenSCAD setup and API docs**

Update `README.md` and `MIGRATION.md` to remove:

```md
OpenSCAD 接入
OPENSCAD_BIN=...
POST /api/render
GET /api/render/:id
POST /api/export/stl
```

- [ ] **Step 2: Remove setup and skill references**

Delete OpenSCAD references from:

```sh
OPENSCAD_BIN=/snap/bin/openscad-nightly
```

and

```yaml
- OPENSCAD_BIN
```

- [ ] **Step 3: Delete OpenSCAD-only artifacts**

Delete:

```text
/home/kkk/ai-cad/NOTES.md
/home/kkk/ai-cad/desk.scad
```

- [ ] **Step 4: Run repository-wide search to confirm cleanup**

Run: `rg -n -i "openscad|OPENSCAD_BIN|/api/render|/api/export/stl|desk\\.scad" /home/kkk/ai-cad --hidden -g '!node_modules'`
Expected: only intentional historical hits such as the new spec/plan docs or `.git` internals remain.

- [ ] **Step 5: Commit**

```bash
git add README.md MIGRATION.md scripts/setup_cadquery_env.sh agents/aicad/SKILL.md agents/aicad/references/project.md agents/aicad/agent.yaml NOTES.md desk.scad
git commit -m "docs: remove openscad references and artifacts"
```

### Task 5: Run full verification

**Files:**
- Modify: `/home/kkk/ai-cad/remove-openscad.test.mjs`

- [ ] **Step 1: Keep the removal test focused on active code paths**

Use this final assertion set:

```js
assert.doesNotMatch(serverJs, /OPENSCAD_BIN/);
assert.doesNotMatch(serverJs, /runOpenScad/);
assert.doesNotMatch(serverJs, /\/api\/render/);
assert.doesNotMatch(serverJs, /\/api\/export\/stl/);
assert.doesNotMatch(appJs, /OpenSCAD/);
```

- [ ] **Step 2: Run full verification**

Run: `npm run check`
Expected: PASS with the new removal test included.

- [ ] **Step 3: Run a final targeted search**

Run: `rg -n -i "openscad|OPENSCAD_BIN|starterScad|runOpenScad" /home/kkk/ai-cad/server.js /home/kkk/ai-cad/public/app.js /home/kkk/ai-cad/README.md /home/kkk/ai-cad/MIGRATION.md /home/kkk/ai-cad/scripts/setup_cadquery_env.sh /home/kkk/ai-cad/agents/aicad`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add remove-openscad.test.mjs package.json server.js public/app.js README.md MIGRATION.md scripts/setup_cadquery_env.sh agents/aicad/SKILL.md agents/aicad/references/project.md agents/aicad/agent.yaml
git commit -m "chore: remove openscad module from ai-cad"
```
