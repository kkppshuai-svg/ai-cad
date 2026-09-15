# AI-CAD FreeCAD Primary Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FreeCAD `.FCStd` the required primary AI-CAD assembly output while keeping STEP and STL as compatibility and preview artifacts.

**Architecture:** Keep the existing CadQuery geometry and package generation flow, then require a generated `ai_cad_assembly.FCStd` from the FreeCAD bridge before an assembly can finish successfully. Expose the `.FCStd` path through `publicAssembly()`, make the UI present it as the main output, and make `/api/freecad/open` open that existing file instead of a generic package target.

**Tech Stack:** Node.js, browser JavaScript, FreeCAD bridge Python script, Node test runner

---

### Task 1: Lock the FreeCAD-primary contract with focused tests

**Files:**
- Modify: `/home/kkk/ai-cad/freecad-open.test.mjs`
- Create: `/home/kkk/ai-cad/ui-copy.test.mjs`
- Modify: `/home/kkk/ai-cad/package.json`

- [ ] **Step 1: Add a failing UI copy test for the default assistant message**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("default chat copy presents FreeCAD FCStd as the primary output", () => {
  const appJs = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

  assert.match(appJs, /FreeCAD FCStd 是主输出/);
  assert.doesNotMatch(appJs, /STEP\/STL 是主输出/);
});
```

- [ ] **Step 2: Run the new UI copy test and verify it fails**

Run: `node --test ui-copy.test.mjs`
Expected: FAIL because `public/app.js` still says `STEP/STL 是主输出`.

- [ ] **Step 3: Extend the check script to include the new regression test**

```json
{
  "scripts": {
    "check": "node --check server.js && node --check public/app.js && python3 -m py_compile scripts/aicad_training_30.py && node --test security.test.mjs freecad-bridge.test.mjs freecad-open.test.mjs prompt-contract.test.mjs ui-copy.test.mjs"
  }
}
```

- [ ] **Step 4: Re-run the new test and keep it red until the copy is fixed**

Run: `node --test ui-copy.test.mjs`
Expected: still FAIL until `public/app.js` is updated.

- [ ] **Step 5: Commit the test harness**

```bash
git add package.json ui-copy.test.mjs
git commit -m "test: lock freecad primary output copy"
```

### Task 2: Finish the frontend wording and output presentation

**Files:**
- Modify: `/home/kkk/ai-cad/public/app.js`
- Modify: `/home/kkk/ai-cad/public/index.html`

- [ ] **Step 1: Update the default assistant starter copy**

```js
content: "描述你要的零件和它们如何装配。我会用 CadQuery 实体生成零件和装配，FreeCAD FCStd 是主输出，STEP/STL 继续作为兼容和预览输出。"
```

- [ ] **Step 2: Confirm download labels present the FreeCAD file as primary**

```html
<a id="fcstdLink" href="#" download hidden>下载 FreeCAD 主文件</a>
<a id="stepLink" href="#" download hidden>下载 STEP 兼容文件</a>
<a id="kinematicPackageLink" href="#" download hidden>下载关系装配包</a>
```

- [ ] **Step 3: Run the targeted UI tests and verify they pass**

Run: `node --test ui-copy.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit the UI wording fix**

```bash
git add public/app.js public/index.html ui-copy.test.mjs package.json
git commit -m "fix: present freecad as primary assembly output"
```

### Task 3: Verify backend completion and FreeCAD open behavior

**Files:**
- Modify: `/home/kkk/ai-cad/server.js:946-1030`
- Modify: `/home/kkk/ai-cad/freecad-open.js`
- Modify: `/home/kkk/ai-cad/freecad-open.test.mjs`

- [ ] **Step 1: Add or confirm a failing test for opening an existing generated FCStd**

```js
assert.deepEqual(result, {
  ok: true,
  action: "open-existing-fcstd",
  primaryOutput: true,
  assemblyId: "assembly-1",
  freecadBin: "freecad",
  freecadCmd: "freecadcmd",
  packagePath,
  fcstdPath,
  scriptPath: path.join(packagePath, "open_in_freecad.py"),
  command: `freecad ${fcstdPath}`,
  generatedBy: `freecadcmd ${path.join(packagePath, "open_in_freecad.py")}`,
  pid: null,
});
```

- [ ] **Step 2: Run the focused backend test**

Run: `node --test freecad-open.test.mjs`
Expected: PASS after the helper returns `open-existing-fcstd` and the `.FCStd` path.

- [ ] **Step 3: Confirm assembly completion requires `ensureAssemblyFcstd(job)`**

```js
await ensureAssemblyFcstd(job);
job.status = "done";
job.completedAt = new Date().toISOString();
publish("assembly:done", publicAssembly(job));
```

- [ ] **Step 4: Run syntax and focused test coverage**

Run: `node --check server.js && node --test freecad-open.test.mjs freecad-bridge.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit the backend completion contract**

```bash
git add server.js freecad-open.js freecad-open.test.mjs freecad-bridge.test.mjs
git commit -m "feat: require generated freecad primary output"
```

### Task 4: Full verification and handoff

**Files:**
- Modify: `/home/kkk/ai-cad/README.md`

- [ ] **Step 1: Confirm README language matches the implemented behavior**

```md
- FreeCAD `.FCStd` is the primary assembly output.
- STEP remains a compatibility geometry export.
- STL remains a preview/simulation artifact.
```

- [ ] **Step 2: Run the full project verification**

Run: `npm run check`
Expected: all syntax checks and Node tests pass.

- [ ] **Step 3: Smoke-test a local assembly generation if FreeCAD CLI is available**

Run: `node server.js`
Expected: the server starts and a completed assembly exposes `fcstdUrl` plus `stepUrl`.

- [ ] **Step 4: Commit the documentation alignment**

```bash
git add README.md
git commit -m "docs: align ai-cad output docs with freecad primary flow"
```
