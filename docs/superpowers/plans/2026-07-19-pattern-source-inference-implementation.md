# Pattern Source Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely infer a missing pattern `sourceFeatureId` from one valid dependency and prevent repaired plans from failing on this omission.

**Architecture:** Extend parametric-plan normalization with a narrow compatibility step that runs after IDs are assigned and before type-specific validation. The step resolves only one unambiguous legal source. Strengthen the planner contract so newly generated and repaired plans explicitly include both `dependsOn` and `params.sourceFeatureId`.

**Tech Stack:** Node.js ESM, `node:test`, existing parametric plan normalizer and planner prompt contract.

---

### Task 1: Infer an unambiguous pattern source

**Files:**

- Modify: `parametric-plan.js`
- Test: `parametric-plan.test.mjs`

- [ ] **Step 1: Add failing normalization tests**

Add tests that construct complete parts and assert:

```js
const normalized = normalizeParametricPlan({
  parts: [{
    id: "stepper_57_l_bracket",
    featureTree: [
      { id: "stepper_57_l_bracket.base.01", type: "base_box", params: { size: [60, 40, 8] } },
      { id: "stepper_57_l_bracket.hole.seed", type: "hole", dependsOn: ["stepper_57_l_bracket.base.01"], params: { diameter: 5 } },
      { id: "stepper_57_l_bracket.hole.01", type: "linear_pattern", dependsOn: ["stepper_57_l_bracket.hole.seed"], params: { count: 4, spacing: 10 } }
    ]
  }]
});
assert.equal(
  normalized.parts[0].featureTree[2].params.sourceFeatureId,
  "stepper_57_l_bracket.hole.seed"
);
```

Also cover circular patterns, multiple dependencies, missing dependencies, illegal source types, explicit source preservation, input immutability, and idempotence.

- [ ] **Step 2: Verify RED**

Run: `node --test parametric-plan.test.mjs`

Expected: the unique-dependency inference tests fail with `linear_pattern requires sourceFeatureId`.

- [ ] **Step 3: Implement minimal inference**

After all nodes have normalized IDs, but before `validateFeatureParams` rejects a pattern, resolve a missing source only when exactly one dependency points to an existing legal source node. Keep the current error for every ambiguous or illegal case.

- [ ] **Step 4: Verify GREEN**

Run: `node --test parametric-plan.test.mjs scripts/test_parametric_build.py`

Expected: Node parametric tests pass; run the Python build test separately with `.venv-cadquery/bin/python scripts/test_parametric_build.py`.

- [ ] **Step 5: Commit**

```bash
git add parametric-plan.js parametric-plan.test.mjs
git commit -m "fix: infer unambiguous pattern sources"
```

### Task 2: Strengthen planner and repair prompts

**Files:**

- Modify: `prompt-contract.js`
- Modify: `prompt-contract.test.mjs`
- Modify: `planner-profile-repair.js`
- Modify: `planner-profile-repair.test.mjs`

- [ ] **Step 1: Add failing prompt tests**

Assert that creation/full-plan instructions and profile-repair instructions explicitly require:

```text
dependsOn: [sourceFeatureId]
params.sourceFeatureId
linear_pattern: count + spacing
circular_pattern: count + angle
```

- [ ] **Step 2: Verify RED**

Run: `node --test prompt-contract.test.mjs planner-profile-repair.test.mjs`

Expected: failures because current prompts do not state the complete array source contract.

- [ ] **Step 3: Add the minimal prompt guidance**

Add one concise pattern rule and one valid JSON pattern example to the full-plan contract. Extend the profile repair instruction with the same source requirement without changing retry count or repair eligibility.

- [ ] **Step 4: Verify focused and full suites**

Run:

```bash
node --test parametric-plan.test.mjs prompt-contract.test.mjs planner-profile-repair.test.mjs planner-profile-repair.integration.test.mjs
npm run check
```

Expected: all checks pass with zero failures.

- [ ] **Step 5: Commit**

```bash
git add prompt-contract.js prompt-contract.test.mjs planner-profile-repair.js planner-profile-repair.test.mjs
git commit -m "fix: require pattern sources in planner output"
```

