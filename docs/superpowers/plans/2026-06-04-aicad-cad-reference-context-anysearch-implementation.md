# AI-CAD CAD Reference Context and AnySearch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CAD-specific planning context that stays enabled when general web search is disabled, and use AnySearch for general web search.

**Architecture:** `cad-reference-context.js` owns pure context extraction/ranking. `server.js` orchestrates optional general search plus always-on CAD reference context. `prompt-contract.js` renders separate prompt sections for web snippets, step.parts candidates, and local CadQuery templates.

**Tech Stack:** Node.js ES modules, built-in test runner, existing Codex/CadQuery pipeline, step.parts HTTP API, AnySearch HTTP API.

---

### Task 1: CAD Reference Context Module

**Files:**
- Create: `cad-reference-context.js`
- Create: `cad-reference-context.test.mjs`

- [ ] Write tests for standard-part term extraction and local example ranking.
- [ ] Implement `extractStandardPartRequests(message, conversation)`.
- [ ] Implement `rankCadQueryTemplates(message, examples)`.
- [ ] Run `node --test cad-reference-context.test.mjs`.

### Task 2: Prompt Contract

**Files:**
- Modify: `prompt-contract.js`
- Modify: `prompt-contract.test.mjs`

- [ ] Add failing tests asserting prompt includes `Standard part candidates` and `Local CadQuery template matches`.
- [ ] Add `cadReferenceContext` argument to `buildAssemblyPlannerInstruction`.
- [ ] Render clear instructions: use step.parts candidates for off-the-shelf parts; use templates only for modeling patterns.
- [ ] Run `node --test prompt-contract.test.mjs`.

### Task 3: AnySearch Provider

**Files:**
- Modify: `server.js`
- Create: `anysearch-provider.test.mjs`

- [ ] Add tests for AnySearch response normalization with `{ results: [...] }` and `{ items: [...] }`.
- [ ] Set the default general web search provider to `anysearch`.
- [ ] Implement `searchWithAnySearch(query, options)`.
- [ ] Route general web search fallback attempts through AnySearch.
- [ ] Run `node --test anysearch-provider.test.mjs`.

### Task 4: Server Orchestration

**Files:**
- Modify: `server.js`
- Modify: `package.json`
- Modify: `README.md`

- [ ] Build CAD reference context every conversation turn, even when `webSearch.enabled=false`.
- [ ] Keep the UI `search` response representing general web search only.
- [ ] Pass CAD reference context into `generateAssemblyPlan`.
- [ ] Add new tests to `npm run check`.
- [ ] Document that AnySearch is the general web provider and step.parts/template context is CAD-specific.

### Task 5: Verification

**Files:**
- No new files.

- [ ] Run `node --test cad-reference-context.test.mjs anysearch-provider.test.mjs prompt-contract.test.mjs`.
- [ ] Run `npm run check`.
- [ ] Report exact commands and results.
