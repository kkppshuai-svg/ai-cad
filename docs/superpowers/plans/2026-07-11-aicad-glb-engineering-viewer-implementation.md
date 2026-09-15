# AI CAD GLB Engineering Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the handwritten assembly STL renderer with a Three.js GLB engineering viewer supporting part selection, tree synchronization, hide, isolate, show-all, transparency, standard CAD views, and screenshot review.

**Architecture:** CadQuery exports an additional hierarchical GLB next to existing STEP/STL files. The server exposes the GLB URL, while a focused browser module owns Three.js rendering and engineering interactions; `public/app.js` remains the workflow coordinator and retains STL fallback for old or failed jobs.

**Tech Stack:** CadQuery 2.7 GLTF export, Node.js, native browser modules, Three.js, Node test runner, Python pytest.

---

### Task 1: Define GLB build and API contracts

**Files:**
- Modify: `scripts/test_query_cad_vae.py` only if unsuitable; otherwise create `glb-export.test.mjs`
- Modify: `cad-latent-dataset.test.mjs` only if suitable; otherwise use `glb-export.test.mjs`
- Modify: `package.json`

- [ ] Write a failing source contract test requiring `assembly.glb`, `glbPath`, `glbUrl`, and preserved `stlUrl`.
- [ ] Run `node --test glb-export.test.mjs` and confirm failure is caused by missing GLB support.
- [ ] Add the new test to `npm run check`.

### Task 2: Export assembly GLB without breaking existing artifacts

**Files:**
- Modify: `scripts/cadquery_build.py`
- Modify: `server.js`
- Test: `glb-export.test.mjs`

- [ ] Export `assembly.glb` from the existing CadQuery Assembly with deterministic part colors.
- [ ] Catch GLB export errors separately and include `glbPath: null` plus a warning while STEP/STL remain successful.
- [ ] Store `job.glbPath` and expose `glbUrl` from `publicAssembly()` and preview responses.
- [ ] Run `node --test glb-export.test.mjs` and confirm it passes.

### Task 3: Add Three.js and the viewer module contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `public/cad-viewer.js`
- Create: `cad-viewer-ui.test.mjs`
- Modify: `server.js`

- [ ] Install a fixed Three.js version.
- [ ] Write a failing UI contract test for `GLTFLoader`, `OrbitControls`, selection, hide, isolate, show-all, transparency, view presets, wireframe, capture, disposal, and STL fallback hooks.
- [ ] Expose only the required Three.js module files through safe static routes.
- [ ] Implement `CadViewer` with public methods matching the contract.
- [ ] Run the viewer contract test and syntax checks.

### Task 4: Connect engineering controls and tree synchronization

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`
- Modify: `viewer-views.test.mjs`
- Modify: `visual-review-ui.test.mjs`

- [ ] Add hide, isolate, show-all, and transparency buttons while preserving current view IDs.
- [ ] Replace direct handwritten WebGL setup with `CadViewer` initialization and callbacks.
- [ ] Prefer assembly GLB, retain part STL and assembly STL fallback.
- [ ] On 3D selection, set `activePartId`, update editor/list state, and keep controls enabled consistently.
- [ ] On part-card click, select and frame the corresponding GLB node.
- [ ] Route view presets, wireframe, resize, pointer controls, and screenshot capture through `CadViewer`.
- [ ] Add selected/hidden/isolated styles and responsive toolbar behavior.
- [ ] Run focused UI tests.

### Task 5: Verify with a real multi-part assembly

**Files:**
- Verify generated artifacts under temporary output paths.

- [ ] Generate a two-part test assembly through `scripts/cadquery_build.py`.
- [ ] Assert STEP, STL, and GLB all exist and GLB has non-zero size.
- [ ] Start the application and load the generated GLB in headless Chrome.
- [ ] Capture desktop and mobile screenshots and inspect selection/tool layout.
- [ ] Run `npm run check`, `git diff --check`, and duplicate-ID inspection.
