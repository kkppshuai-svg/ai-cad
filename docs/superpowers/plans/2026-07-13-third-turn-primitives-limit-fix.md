# Third-Turn Primitives Limit Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent later CAD conversation turns from failing with `Part has too many primitives` while preserving bounded geometry complexity and editable parametric history.

**Architecture:** Keep the built assembly's normalized `featureTree` plan as the authoritative conversation state. Move part-complexity policy into a small pure module so feature-tree plans are validated by feature-node count, while legacy plans retain bounded but less restrictive primitive and feature limits.

**Tech Stack:** Node.js ES modules, Node test runner, existing AI-CAD server and parametric plan pipeline.

---

### Task 1: Add feature-tree-aware complexity policy

**Files:**
- Create: `plan-complexity.js`
- Create: `plan-complexity.test.mjs`
- Modify: `server.js:2351-2374`
- Modify: `package.json`

- [ ] **Step 1: Write the failing tests**

Test that a legacy part with 17 primitives is accepted, an authoritative feature tree ignores oversized compatibility arrays, and genuinely excessive legacy or feature-tree plans are rejected.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test plan-complexity.test.mjs`

Expected: FAIL because `plan-complexity.js` does not exist.

- [ ] **Step 3: Implement the minimal policy**

Export `validatePartComplexity(part)` with explicit limits: 32 legacy primitives, 64 legacy features, and 96 authoritative feature-tree nodes. When `featureTree` exists, validate it instead of compatibility arrays.

- [ ] **Step 4: Integrate the policy into server validation**

Call the helper before sanitizing generated-part arrays and remove the obsolete inline 16/40 checks. Add the focused test to `npm run check`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test plan-complexity.test.mjs`

Expected: all tests pass.

### Task 2: Preserve normalized plans across conversation turns

**Files:**
- Create: `conversation-state.js`
- Create: `conversation-state.test.mjs`
- Modify: `server.js:350-365`
- Modify: `server.js:470-480`
- Modify: `package.json`

- [ ] **Step 1: Write the failing tests**

Test that an existing assembly job replaces the stale legacy conversation plan with the job's normalized feature-tree plan and carries revision, active selection, and validation context forward.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test conversation-state.test.mjs`

Expected: FAIL because `conversation-state.js` does not exist.

- [ ] **Step 3: Implement the synchronization helper**

Export `synchronizeConversationWithAssembly(conversation, job)` and assign the job plan as authoritative while preserving explicitly selected active part and feature IDs.

- [ ] **Step 4: Integrate synchronization before planning and after initial build**

Use the helper whenever a current job exists. After a successful initial build, replace `conversation.plan` with `assembly.plan` so the next prompt contains stable feature IDs.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test conversation-state.test.mjs plan-complexity.test.mjs`

Expected: all tests pass.

### Task 3: Full regression verification

**Files:**
- Modify: none unless verification exposes a regression.

- [ ] **Step 1: Run syntax and focused Node checks**

Run: `node --check server.js && node --test conversation-state.test.mjs plan-complexity.test.mjs parametric-plan.test.mjs prompt-contract.test.mjs`

Expected: all checks pass.

- [ ] **Step 2: Run the complete project verification**

Run: `npm run check`

Expected: JavaScript, Python, CadQuery, FreeCAD integration, and UI suites all pass.

- [ ] **Step 3: Review the final diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only the intended fix, tests, and plan are changed.
