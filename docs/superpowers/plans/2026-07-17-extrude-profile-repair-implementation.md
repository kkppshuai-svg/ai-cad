# Extrude Profile Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry one malformed AI-generated parametric plan when an extrude profile omits or uses an invalid `type`, then either return a schema-valid plan or a feature-specific error.

**Architecture:** Add a small orchestration module that accepts a planner callback and a plan-normalization callback. It recognizes only `add_extrude`/`cut_extrude` profile schema failures, builds a narrowly scoped repair context, and invokes the planner once more. `server.js` supplies its existing Codex call as the planner callback, so transport and timeout behavior remain unchanged.

**Tech Stack:** Node.js ESM, `node:test`, existing `normalizeParametricPlan` schema validation.

---

### Task 1: Add isolated profile-repair orchestration tests

**Files:**

- Create: `planner-profile-repair.js`
- Create: `planner-profile-repair.test.mjs`

- [ ] **Step 1: Write failing tests for repair eligibility, a successful retry, and retry exhaustion**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { repairInvalidExtrudeProfile } from "./planner-profile-repair.js";

test("retries once with the failed extrude feature context", async () => {
  const calls = [];
  const result = await repairInvalidExtrudeProfile({
    plan: { parts: [{ id: "bracket", featureTree: [{ id: "bracket.upright.01", type: "add_extrude", params: { profile: { width: 42, height: 8 }, depth: 50 } }] }] },
    normalize: (plan) => {
      if (!plan.parts[0].featureTree[0].params.profile.type) throw new TypeError("Feature bracket.upright.01 add_extrude profile requires a type");
      return plan;
    },
    retry: async (context) => {
      calls.push(context);
      return { parts: [{ id: "bracket", featureTree: [{ id: "bracket.upright.01", type: "add_extrude", params: { profile: { type: "rectangle", width: 42, height: 8 }, depth: 50 } }] }] };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].featureId, "bracket.upright.01");
  assert.equal(calls[0].featureType, "add_extrude");
  assert.equal(result.parts[0].featureTree[0].params.profile.type, "rectangle");
});

test("does not retry unrelated schema failures", async () => {
  let calls = 0;
  await assert.rejects(() => repairInvalidExtrudeProfile({
    plan: { parts: [] },
    normalize: () => { throw new Error("Assembly plan requires at least one part"); },
    retry: async () => { calls += 1; return {}; }
  }), /requires at least one part/i);
  assert.equal(calls, 0);
});

test("reports the feature after one unsuccessful repair retry", async () => {
  await assert.rejects(() => repairInvalidExtrudeProfile({
    plan: { parts: [{ id: "bracket", featureTree: [{ id: "bracket.upright.01", type: "add_extrude", params: { profile: { width: 42, height: 8 }, depth: 50 } }] }] },
    normalize: () => { throw new TypeError("Feature bracket.upright.01 add_extrude profile requires a type"); },
    retry: async () => ({ parts: [] })
  }), /bracket\.upright\.01.*profile.*type/i);
});
```

- [ ] **Step 2: Run test to verify it fails because the module is absent**

Run: `node --test planner-profile-repair.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `planner-profile-repair.js`.

- [ ] **Step 3: Commit the red test**

```bash
git add planner-profile-repair.test.mjs
git commit -m "test: cover extrude profile repair"
```

### Task 2: Implement the one-time repair helper

**Files:**

- Create: `planner-profile-repair.js`
- Test: `planner-profile-repair.test.mjs`

- [ ] **Step 1: Implement the smallest retry helper that passes Task 1**

```js
const PROFILE_ERROR = /^Feature\s+([A-Za-z0-9._-]+)\s+(add_extrude|cut_extrude)\s+profile requires a type$/i;

export async function repairInvalidExtrudeProfile({ plan, normalize, retry }) {
  try {
    return normalize(plan);
  } catch (error) {
    const match = String(error?.message || error).match(PROFILE_ERROR);
    if (!match) throw error;
    const [featureId, featureType] = match.slice(1);
    try {
      return normalize(await retry({ featureId, featureType, message: error.message }));
    } catch (retryError) {
      throw new Error(`Feature ${featureId} ${featureType} profile repair failed: profile requires a type`, { cause: retryError });
    }
  }
}
```

- [ ] **Step 2: Run the focused test to verify it passes**

Run: `node --test planner-profile-repair.test.mjs`

Expected: PASS, 3 tests, 0 failures.

- [ ] **Step 3: Commit the green implementation**

```bash
git add planner-profile-repair.js planner-profile-repair.test.mjs
git commit -m "fix: retry malformed extrude profiles"
```

### Task 3: Wire repair into assembly-plan generation

**Files:**

- Modify: `server.js:20-40,1060-1101`
- Modify: `package.json:7`
- Test: `planner-profile-repair.test.mjs`

- [ ] **Step 1: Add the helper import and wrap final plan normalization**

```js
import { repairInvalidExtrudeProfile } from "./planner-profile-repair.js";

// After the first Codex response is decoded and shape-validated:
return repairInvalidExtrudeProfile({
  plan: response,
  normalize: (candidate) => {
    normalizePlanShape(candidate);
    validateAssemblyPlan(candidate);
    return normalizeParametricPlan(candidate);
  },
  retry: async ({ featureId, featureType, message: profileError }) =>
    invokePlanner(`${message}\n\nRepair only this invalid feature: ${featureId} (${featureType}). ${profileError}. Return a complete JSON plan. Every extrude profile must use exactly one supported type: rectangle(width,height), circle(radius or diameter), slot(length,width or diameter), or polygon(points).`)
});
```

Refactor the existing `runWithTimeoutRetry` callback into a local `invokePlanner(plannerMessage)` function so both calls retain the same prompt inputs, attachments, timeouts, and JSON extraction. Add `planner-profile-repair.test.mjs` to the `npm run check` Node test list.

- [ ] **Step 2: Run syntax and focused tests**

Run: `node --check server.js && node --check planner-profile-repair.js && node --test planner-profile-repair.test.mjs`

Expected: all commands exit 0.

- [ ] **Step 3: Commit integration**

```bash
git add server.js package.json planner-profile-repair.js planner-profile-repair.test.mjs
git commit -m "fix: repair invalid generated extrude profiles"
```

### Task 4: Verify the regression and full project checks

**Files:**

- Test: `planner-profile-repair.test.mjs`
- Test: `parametric-plan.test.mjs`

- [ ] **Step 1: Run the targeted regression suite**

Run: `node --test planner-profile-repair.test.mjs parametric-plan.test.mjs prompt-contract.test.mjs codex-retry.test.mjs`

Expected: PASS with 0 failures.

- [ ] **Step 2: Run the repository check command**

Run: `npm run check`

Expected: exit 0 with all JavaScript, Python, CadQuery, and Node test stages passing.

- [ ] **Step 3: Inspect final changes and commit any verification-only edits**

Run: `git status --short && git log --oneline -3`

Expected: no uncommitted source or test changes; history contains the repair implementation commits.

