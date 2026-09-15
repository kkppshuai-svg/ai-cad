# Codex Timeout Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce AI-CAD planner latency and recover once from genuine Codex process timeouts without changing assembly state.

**Architecture:** Add a pure planner-context compaction module and a pure/testable bounded retry runner. `server.js` supplies configuration and Codex process invocation while `prompt-contract.js` renders either the full creation contract or a shorter existing-revision edit contract.

**Tech Stack:** Node.js ES modules, Node test runner, Codex CLI subprocess integration.

---

### Task 1: Compact planner context and prompt

**Files:**
- Create: `planner-context.js`
- Create: `planner-context.test.mjs`
- Modify: `prompt-contract.js`
- Modify: `prompt-contract.test.mjs`
- Modify: `server.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing context tests**

Assert that `compactPlannerConversation(conversation, { fastRetry: false })` deep-clones input, removes `primitives/features` only when an authoritative `featureTree` exists, preserves constraints/joints/poses/standard parts, and retains four messages. Assert fast retry retains two messages.

- [ ] **Step 2: Verify RED**

Run: `node --test planner-context.test.mjs`

Expected: FAIL because `planner-context.js` does not exist.

- [ ] **Step 3: Implement context compaction**

Create a pure structured-clone transformation with normal history limit 4 and retry history limit 2. Do not mutate the stored conversation.

- [ ] **Step 4: Add the existing-revision prompt fast path**

When `currentRevision` exists, render the edit-patch contract, compact plan, selection context, validation issues and user request without repeating the full new-assembly JSON schema and long creation-only rules. Keep the full schema for new assemblies.

- [ ] **Step 5: Verify GREEN**

Run: `node --test planner-context.test.mjs prompt-contract.test.mjs`

Expected: all tests pass, and a prompt-size assertion proves the edit prompt is materially shorter than the creation prompt.

### Task 2: Add bounded timeout retry and configuration

**Files:**
- Create: `codex-retry.js`
- Create: `codex-retry.test.mjs`
- Modify: `server.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing retry tests**

Use a fake async invocation to assert: first timeout then success performs two attempts; non-timeout errors perform one attempt; two timeouts throw a stable Chinese error; attempt metadata selects normal then fast context.

- [ ] **Step 2: Verify RED**

Run: `node --test codex-retry.test.mjs`

Expected: FAIL because `codex-retry.js` does not exist.

- [ ] **Step 3: Implement the minimal retry runner**

Export `isProcessTimeoutError(error)` and `runWithTimeoutRetry(invoke)`. Permit exactly one retry and attach the original cause to the final user-facing error.

- [ ] **Step 4: Integrate configurable planner timeouts**

Read bounded `AICAD_CODEX_TIMEOUT_MS` (default 300000) and `AICAD_CODEX_IMAGE_TIMEOUT_MS` (default 360000). Build a fresh compact prompt for each attempt; the retry omits excellent examples, web-search text and CAD reference text while keeping the user request and authoritative plan.

- [ ] **Step 5: Verify focused tests**

Run: `node --check server.js && node --test codex-retry.test.mjs planner-context.test.mjs prompt-contract.test.mjs`

Expected: all checks pass.

### Task 3: Full verification and integration

**Files:**
- Modify: none unless verification identifies a regression.

- [ ] **Step 1: Run complete verification**

Run: `npm run check`

Expected: all Node, Python, CadQuery, FreeCAD and UI tests pass.

- [ ] **Step 2: Validate repository state**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intended tracked changes.
