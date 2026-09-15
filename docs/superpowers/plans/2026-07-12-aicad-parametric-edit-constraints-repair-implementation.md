# AI-CAD Parametric Editing, Constraints, and Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a revisioned parametric feature tree, local conversational edits with incremental rebuilds, assembly constraint analysis, and automatic geometry validation/repair.

**Architecture:** `feature-plan.json` remains the source of truth. Focused JavaScript domain modules normalize plans, apply patches, calculate dependencies, analyze constraints, and manage revisions; `scripts/cadquery_build.py` evaluates feature-tree nodes and performs BREP/interference checks. `server.js` orchestrates immutable candidate revisions and publishes only validated results.

**Tech Stack:** Node.js ES modules and `node:test`, Python 3 with CadQuery/OCP, FreeCAD bridge, JSON revision artifacts, Three.js frontend.

---

## File map

- Create `parametric-plan.js`: schema migration, stable IDs, dimensions, dependency graph.
- Create `parametric-plan.test.mjs`: plan normalization and dependency tests.
- Create `parametric-edit.js`: target resolution, patch application, diff and affected parts.
- Create `parametric-edit.test.mjs`: precise local-edit and ambiguity tests.
- Create `assembly-constraints.js`: constraint normalization, datum validation and DOF/conflict analysis.
- Create `assembly-constraints.test.mjs`: concentric/coincident/distance/angle/gear/slider tests.
- Create `cad-validation.js`: report gates, deterministic repair policy and revision promotion rules.
- Create `cad-validation.test.mjs`: validation and safe-repair tests.
- Create `revision-store.js`: immutable revision directories, current pointer and rollback.
- Create `revision-store.test.mjs`: atomic revision lifecycle tests.
- Modify `scripts/cadquery_build.py`: evaluate feature tree, patterns, named selectors, BREP checks and interference.
- Create `scripts/test_parametric_build.py`: actual CadQuery geometry tests.
- Modify `server.js`: revision/edit/revert/feature-tree/validation APIs and incremental build orchestration.
- Create `parametric-api.test.mjs`: API contract and failed-candidate rollback tests.
- Modify `prompt-contract.js`: complete-plan versus edit-patch planner contract.
- Modify `prompt-contract.test.mjs`: local-edit prompt tests.
- Modify `public/index.html`, `public/app.js`, `public/styles.css`: feature tree, revision and validation UI.
- Create `parametric-ui.test.mjs`: stable DOM hooks and frontend wiring tests.
- Modify `package.json`, `README.md`: test gates and operator documentation.

### Task 1: Normalize legacy plans into a stable parameter tree

**Files:**
- Create: `parametric-plan.js`
- Create: `parametric-plan.test.mjs`

- [ ] **Step 1: Write the failing stable-ID migration tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeParametricPlan, buildDependencyGraph } from "./parametric-plan.js";

test("legacy primitives and features receive deterministic stable IDs", () => {
  const input = { name: "demo", parts: [{ id: "bracket", primitives: [{ type: "box", size: [60, 20, 6] }], features: [{ type: "hole", center: [0, 0, 0], diameter: 6 }] }] };
  const first = normalizeParametricPlan(structuredClone(input));
  const second = normalizeParametricPlan(structuredClone(input));
  assert.deepEqual(first.parts[0].featureTree, second.parts[0].featureTree);
  assert.equal(first.parts[0].featureTree[0].id, "bracket.base.01");
  assert.equal(first.parts[0].featureTree[1].id, "bracket.hole.01");
});

test("dependency graph rejects cycles", () => {
  assert.throws(() => buildDependencyGraph([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }]), /cycle/i);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test parametric-plan.test.mjs`

Expected: FAIL because `parametric-plan.js` does not exist.

- [ ] **Step 3: Implement normalized nodes, dimensions and dependency sorting**

Implement exports:

```js
export function normalizeParametricPlan(plan) { /* clone, migrate, validate, return */ }
export function normalizeFeatureNode(partId, node, index, counters) { /* stable ID and params */ }
export function resolveDimensionRefs(plan) { /* replace $dimension references */ }
export function buildDependencyGraph(nodes) { /* Map plus stable topological order */ }
export function checksumParametricPart(part) { /* canonical JSON SHA-256 */ }
```

Reject duplicate IDs, missing dependencies, cycles, non-positive functional dimensions and unsupported feature types. Preserve legacy `primitives`/`features` as generated compatibility views.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test parametric-plan.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add parametric-plan.js parametric-plan.test.mjs
git commit -m "feat: add stable parametric feature tree"
```

### Task 2: Apply precise local edit patches

**Files:**
- Create: `parametric-edit.js`
- Create: `parametric-edit.test.mjs`

- [ ] **Step 1: Write failing patch and ambiguity tests**

```js
test("set_param edits only the third named hole", () => {
  const result = applyEditPatch(planWithThreeHoles(), {
    baseRevision: "rev-0001",
    operations: [{ op: "set_param", partId: "left_bracket", featureId: "left_bracket.hole.03", path: "params.diameter", value: 8 }]
  }, { revisionId: "rev-0001" });
  assert.equal(result.plan.parts[0].featureTree[3].params.diameter, 8);
  assert.deepEqual(result.affectedPartIds, ["left_bracket"]);
});

test("natural target resolution reports ambiguity instead of guessing", () => {
  const result = resolveFeatureTarget(planWithTwoPartsAndHoles(), { type: "hole", ordinal: 3 });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 2);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test parametric-edit.test.mjs`

Expected: FAIL because edit functions do not exist.

- [ ] **Step 3: Implement edit operations and affected-set calculation**

Implement `set_param`, `add_feature`, `remove_feature`, `enable_feature`, `disable_feature`, `set_part_pose`, `set_constraint`, and `remove_constraint`. Validate `baseRevision`, JSON paths, target uniqueness and resulting schema. Return `{ plan, diff, affectedPartIds, assemblyArtifactsDirty }` without mutating input.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test parametric-edit.test.mjs`

Expected: PASS, including checksum evidence that the right bracket is unchanged after “only thicken left bracket”.

- [ ] **Step 5: Commit**

```bash
git add parametric-edit.js parametric-edit.test.mjs
git commit -m "feat: add precise parametric edit patches"
```

### Task 3: Add immutable revisions and rollback

**Files:**
- Create: `revision-store.js`
- Create: `revision-store.test.mjs`

- [ ] **Step 1: Write failing revision lifecycle tests**

Test that a candidate is created under `revisions/rev-0002`, cannot overwrite `rev-0001`, becomes current only after `promoteRevision`, and a failed candidate leaves `current.json` pointing to `rev-0001`.

- [ ] **Step 2: Run and verify RED**

Run: `node --test revision-store.test.mjs`

Expected: FAIL because revision store is missing.

- [ ] **Step 3: Implement filesystem-safe revision store**

```js
export async function createCandidateRevision(root, assemblyId, plan, metadata) {}
export async function promoteRevision(root, assemblyId, revisionId, validationReport) {}
export async function markRevisionFailed(root, assemblyId, revisionId, failure) {}
export async function listRevisions(root, assemblyId) {}
export async function revertRevision(root, assemblyId, revisionId) {}
```

Write temporary JSON then rename atomically. Store plan checksum, parent revision, status, diff and affected part IDs.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test revision-store.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add revision-store.js revision-store.test.mjs
git commit -m "feat: add immutable assembly revisions"
```

### Task 4: Build editable extrusions, patterns and named finishes

**Files:**
- Modify: `scripts/cadquery_build.py`
- Create: `scripts/test_parametric_build.py`

- [ ] **Step 1: Write failing real-geometry tests**

Create tests that build:

1. a box plus `cut_extrude` rectangle;
2. a linear pattern of three holes;
3. a circular pattern of six holes;
4. a fillet with an explicit axis/position selector;
5. a missing selector that raises `FeatureBuildError(feature_id=...)`.

Assert positive volume, expected hole topology, changed bounding box after extrusion depth edit, and node-level trace output.

- [ ] **Step 2: Run and verify RED**

Run: `PYTHONPATH=scripts .venv-cadquery/bin/python scripts/test_parametric_build.py`

Expected: FAIL on unsupported `featureTree` nodes.

- [ ] **Step 3: Implement feature-tree evaluator**

Add focused functions:

```python
def build_feature_tree(part): ...
def evaluate_node(result, node, context): ...
def expand_linear_pattern(node, source_node): ...
def expand_circular_pattern(node, source_node): ...
def select_named_edges(result, selector): ...
def validate_node_shape(feature_id, shape): ...
```

Do not swallow fillet/chamfer exceptions. Emit `feature-trace.json` with status, duration, input/output facts and repair attempts for each node.

- [ ] **Step 4: Run and verify GREEN**

Run: `PYTHONPATH=scripts .venv-cadquery/bin/python scripts/test_parametric_build.py`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cadquery_build.py scripts/test_parametric_build.py
git commit -m "feat: build editable feature trees and patterns"
```

### Task 5: Normalize and analyze assembly constraints

**Files:**
- Create: `assembly-constraints.js`
- Create: `assembly-constraints.test.mjs`
- Modify: `freecad-bridge.js`

- [ ] **Step 1: Write failing constraint tests**

Test normalization and datum resolution for `coincident`, `concentric`, `distance`, `angle`, `revolute`, `slider`, and `gear`. Assert a fixed base has 0 DOF, a revolute child has 1 rotational DOF, a slider child has 1 translational DOF, conflicting distance values are errors, and a gear ratio loop with inconsistent product is an error.

- [ ] **Step 2: Run and verify RED**

Run: `node --test assembly-constraints.test.mjs`

Expected: FAIL because constraint analyzer is missing.

- [ ] **Step 3: Implement datum and DOF analysis**

Implement:

```js
export function normalizeConstraints(plan) {}
export function resolveDatum(plan, reference) {}
export function analyzeAssemblyConstraints(plan) {}
export function constraintToFreeCadManifest(constraint, resolvedDatums) {}
```

Use six Boolean DOF flags per part. Apply deterministic reductions for supported constraints and report unresolved datums instead of inventing geometry.

- [ ] **Step 4: Integrate FreeCAD manifest mappings**

Map concentric/coincident/distance/angle/revolute/slider/gear to explicit manifest types and retain source datum IDs. Keep existing joints/relations input migration.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test assembly-constraints.test.mjs freecad-bridge.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add assembly-constraints.js assembly-constraints.test.mjs freecad-bridge.js freecad-bridge.test.mjs
git commit -m "feat: add assembly constraint and DOF analysis"
```

### Task 6: Add BREP, interference and manufacturability validation

**Files:**
- Create: `cad-validation.js`
- Create: `cad-validation.test.mjs`
- Modify: `scripts/cadquery_build.py`
- Modify: `scripts/test_parametric_build.py`

- [ ] **Step 1: Write failing validation tests**

Test that invalid shape, no solids, non-positive volume, open shell, boolean failure and zero-thickness suspicion are blocking errors. Build two overlapping boxes and assert positive interference volume; build touching boxes and assert no volumetric interference. Add minimum wall and hole-edge warnings.

- [ ] **Step 2: Run and verify RED**

Run: `node --test cad-validation.test.mjs && PYTHONPATH=scripts .venv-cadquery/bin/python scripts/test_parametric_build.py`

Expected: FAIL because validation reports are absent.

- [ ] **Step 3: Implement Python geometry facts and interference**

Emit per-part `geometryValidation` and assembly `interferences` using bounding-box broad phase and exact `intersect().Volume()` narrow phase. Include tolerance and intended-contact exclusions.

- [ ] **Step 4: Implement validation gates and safe repairs**

```js
export function mergeValidationReports(inputs) {}
export function canPromoteRevision(report) {}
export function proposeDeterministicRepairs(report, plan) {}
```

Allow only `clean`, through-cut extension, minimum-positive clamp, finish-feature disable, and fillet/chamfer radius binary reduction. Never alter hole center, functional diameter, constraint or part count.

- [ ] **Step 5: Run and verify GREEN**

Run both focused suites. Expected: PASS and repair audit contains original value, repaired value and reason.

- [ ] **Step 6: Commit**

```bash
git add cad-validation.js cad-validation.test.mjs scripts/cadquery_build.py scripts/test_parametric_build.py
git commit -m "feat: validate and safely repair CAD revisions"
```

### Task 7: Add incremental revision APIs and build orchestration

**Files:**
- Modify: `server.js`
- Create: `parametric-api.test.mjs`

- [ ] **Step 1: Write failing API tests**

Cover:

- `GET /api/assembly/:id/feature-tree`
- `GET /api/assembly/:id/revisions`
- `GET /api/assembly/:id/validation`
- `POST /api/assembly/:id/edit`
- `POST /api/assembly/:id/revert`

Assert request token enforcement, candidate revision response, unchanged-part cache reuse, successful promotion, and failed candidate rollback.

- [ ] **Step 2: Run and verify RED**

Run: `node --test parametric-api.test.mjs`

Expected: FAIL with missing routes.

- [ ] **Step 3: Extract build orchestration from server**

Add a revision-aware `buildAssemblyRevision` that accepts `affectedPartIds`, copies or links unchanged artifacts by checksum, rebuilds changed parts, regenerates assembly artifacts, validates, repairs if allowed, and atomically promotes.

- [ ] **Step 4: Implement routes and public payloads**

Expose current revision, feature-node status, validation summary, DOF summary, repair history and revision URLs. Keep existing build/chat endpoints compatible.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test parametric-api.test.mjs security.test.mjs freecad-bridge.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server.js parametric-api.test.mjs
git commit -m "feat: add incremental parametric revision APIs"
```

### Task 8: Teach the planner to emit local edit patches and repair proposals

**Files:**
- Modify: `prompt-contract.js`
- Modify: `prompt-contract.test.mjs`

- [ ] **Step 1: Write failing prompt contract tests**

Assert the prompt requires stable part/feature IDs, `featureTree`, dimensions, constraints and `editPatch`; requires candidate lists on ambiguity; forbids whole-plan regeneration for a resolvable local edit; and supplies validation errors to repair planning without authorizing silent functional changes.

- [ ] **Step 2: Run and verify RED**

Run: `node --test prompt-contract.test.mjs`

Expected: FAIL on missing edit-patch contract.

- [ ] **Step 3: Update planner schema and rules**

Add complete-plan and patch response modes. Include current revision, active part/feature, compact feature tree and latest validation report. Require Chinese reply to state exactly what changed and whether other parts were reused.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test prompt-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prompt-contract.js prompt-contract.test.mjs
git commit -m "feat: plan conversational local CAD edits"
```

### Task 9: Add feature-tree, revision and validation UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `parametric-ui.test.mjs`

- [ ] **Step 1: Write failing DOM and wiring tests**

Require hooks `featureTreePanel`, `featureTreeList`, `revisionList`, `validationSummary`, `validationIssues`, `dofSummary`, `revertRevisionBtn`, and active feature state. Assert app fetches feature tree/validation after assembly update and includes `activeFeatureId` with chat edits.

- [ ] **Step 2: Run and verify RED**

Run: `node --test parametric-ui.test.mjs industrial-ui.test.mjs`

Expected: FAIL on missing hooks.

- [ ] **Step 3: Implement compact industrial UI**

Render an expandable per-part feature tree with node type, dimensions and pass/warn/error status. Add revision dropdown and revert action. Show validation counts, interference pairs, automatic repair audit and remaining DOF without replacing existing viewer controls.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test parametric-ui.test.mjs industrial-ui.test.mjs ui-copy.test.mjs`

Expected: PASS and all prior DOM hooks preserved.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/styles.css parametric-ui.test.mjs
git commit -m "feat: add parametric tree and validation workspace"
```

### Task 10: End-to-end verification and documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Create: `docs/parametric-editing.md`

- [ ] **Step 1: Add all focused suites to `npm run check`**

Include new Node suites, Python geometry tests and syntax checks.

- [ ] **Step 2: Document local-edit and recovery workflows**

Show examples for “把第三个孔改成 8 mm”, “只加厚左支架”, constraint definitions, revision rollback, validation levels and repair limitations.

- [ ] **Step 3: Run the full regression suite**

Run: `npm run check`

Expected: all Python and Node tests pass with no skipped new suites.

- [ ] **Step 4: Run a real multi-part acceptance build**

Create a fixture with left/right brackets, three patterned holes, a slider, concentric shaft constraint and deliberate interference. Verify the first candidate is blocked, apply a repair patch, rebuild only the affected bracket, and verify the repaired revision is promoted. Compare unchanged right-bracket STEP checksum.

- [ ] **Step 5: Validate CAD artifacts**

Run CAD inspection on generated STEP and inspect the FCStd with `freecadcmd` to confirm logical part containers, editable geometry objects, revision properties and constraint metadata. Open the final STEP in CAD Explorer and record the URL.

- [ ] **Step 6: Commit final documentation and gates**

```bash
git add package.json README.md docs/parametric-editing.md
git commit -m "docs: document parametric editing and repair"
```

- [ ] **Step 7: Completion audit**

Map every design acceptance bullet to a test, generated report, checksum comparison or inspected artifact. Do not mark complete if gear/slider analysis, interference blocking, rollback, incremental rebuild or local feature targeting lacks direct evidence.
