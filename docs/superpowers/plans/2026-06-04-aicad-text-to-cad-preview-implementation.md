# AI-CAD Text-to-CAD Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CAD Explorer the primary embedded preview mode for AI-CAD generated CAD files, with existing STL/PNG preview as fallback.

**Architecture:** Add a small backend integration layer that starts/reuses CAD Explorer and returns a URL for a generated STEP/STL file. Frontend loads that URL in an iframe and keeps existing WebGL STL preview as fallback.

**Tech Stack:** Node.js ES modules, built-in test runner, existing CAD Explorer `dev:ensure`, browser iframe, existing STL WebGL fallback.

---

### Task 1: Explorer Link Helpers

**Files:**
- Create: `cad-explorer-link.js`
- Create: `cad-explorer-link.test.mjs`

- [ ] Write tests for choosing assembly STEP before STL and part STEP before STL.
- [ ] Write tests for parsing a CAD Explorer URL from `dev:ensure` stdout.
- [ ] Implement helper functions.
- [ ] Run `node --test cad-explorer-link.test.mjs`.

### Task 2: Backend API

**Files:**
- Modify: `server.js`

- [ ] Add `POST /api/explorer-link`.
- [ ] Validate requested job and part id against `assemblyJobs`.
- [ ] Call CAD Explorer `dev:ensure` through `runProcess`.
- [ ] Attach `explorerUrl` to preview and assembly payloads when available.

### Task 3: Frontend Preview

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `ui-copy.test.mjs`

- [ ] Add an iframe to the preview stage.
- [ ] Add tests asserting `explorerFrame`, `showExplorerPreview`, and STL fallback paths exist.
- [ ] Load Explorer URL first when available.
- [ ] Hide iframe when falling back to STL/PNG.

### Task 4: Verification

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] Add new tests to `npm run check`.
- [ ] Document CAD Explorer embedded preview and fallback behavior.
- [ ] Run `node --test cad-explorer-link.test.mjs ui-copy.test.mjs`.
- [ ] Run `npm run check`.
