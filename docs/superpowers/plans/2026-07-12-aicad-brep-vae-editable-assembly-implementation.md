# AI CAD BREP VAE and Editable Assembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one editable FreeCAD part container per logical assembly part and replace the PCA-only latent baseline with a functioning geometry-aware BREP VAE v2 pipeline.

**Architecture:** The FreeCAD bridge imports local part STEP geometry, consolidates each logical part into one Geometry object under an App::Part container, and applies assembly pose at the container level. A separate Python pipeline extracts normalized OpenCascade BREP descriptors and trains/queries a lightweight NumPy neural VAE while preserving the legacy token model.

**Tech Stack:** FreeCAD Python API, CadQuery/OpenCascade, NumPy, Node.js tests, Python unittest/pytest.

---

### Task 1: Reproduce the non-editable assembly structure

**Files:**
- Modify: `freecad-bridge.test.mjs`

- [ ] Add failing source assertions requiring `App::Part`, one consolidated `Part::Feature`, local STEP preference, pose placement, source JSON properties, and imported temporary-object cleanup.
- [ ] Run `node --test freecad-bridge.test.mjs` and confirm failure.

### Task 2: Generate clean editable FreeCAD part containers

**Files:**
- Modify: `freecad-bridge.js`
- Test: `freecad-bridge.test.mjs`

- [ ] Add pose-to-Placement conversion using millimeters and degree rotations.
- [ ] Add a helper that imports local STEP, collects shapes, creates one logical Geometry feature, removes temporary imported objects, and places it under App::Part.
- [ ] Store PartId, role, pose and CadQuery JSON properties.
- [ ] Route joint references to the new Geometry object.
- [ ] Run focused tests and generate a real FCStd for FreeCADCmd object-structure inspection.

### Task 3: Extract normalized BREP geometry descriptors

**Files:**
- Create: `scripts/extract_brep_geometry.py`
- Create: `scripts/test_extract_brep_geometry.py`

- [ ] Write failing tests using generated box/cylinder STEP fixtures.
- [ ] Implement topology counts, bbox/scale, mass properties, surface/curve histograms, statistics, adjacency and validity extraction.
- [ ] Implement dataset augmentation from `training_samples.jsonl` and assembly directories.
- [ ] Run extraction tests and verify nonzero vectors with stable feature names.

### Task 4: Implement the NumPy BREP VAE v2

**Files:**
- Create: `scripts/train_brep_vae.py`
- Create: `scripts/query_brep_vae.py`
- Create: `scripts/test_train_brep_vae.py`

- [ ] Write failing tests for VAE model format, finite training metrics, save/load, latent dimension and self-query ranking.
- [ ] Implement normalization, MLP encoder/decoder, reparameterization, beta-KL loss, manual backpropagation, Adam, validation split and early stopping.
- [ ] Implement STEP and dataset query modes.
- [ ] Train a small repository model from available linked STEP samples and run self-query verification.

### Task 5: Integrate and verify

**Files:**
- Modify: `package.json`
- Update: `cad-latent/manifest.json` and create v2 artifacts only when enough linked samples exist.

- [ ] Add new Python tests to `npm run check`.
- [ ] Run full verification.
- [ ] Inspect a generated STEP with CAD inspection tooling and hand the modified artifact to CAD Explorer if an explicit final artifact is produced.
