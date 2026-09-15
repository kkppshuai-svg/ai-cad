# Request Token Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover browser POST requests automatically after an AI-CAD server restart changes the request token.

**Architecture:** Extract a small browser-independent API client with injected `fetch` and token getters/setters. Retry exactly once only for the server's explicit invalid-token response, then wire `public/app.js` to the client.

**Tech Stack:** Browser JavaScript ES modules, Node.js test runner.

---

### Task 1: Token-refreshing API client

**Files:**
- Create: `public/api-client.js`
- Create: `api-client.test.mjs`
- Modify: `public/app.js`
- Modify: `package.json`

- [ ] Write tests for successful token refresh, unrelated 403 without retry, and one-retry maximum.
- [ ] Run `node --test api-client.test.mjs` and verify it fails because the client module is missing.
- [ ] Implement `createApiClient({ fetchImpl, getToken, setToken })` with one guarded `/api/status` refresh.
- [ ] Replace the inline `api()` transport in `public/app.js` while preserving its call signature.
- [ ] Run `node --test api-client.test.mjs security.test.mjs` and verify all tests pass.

### Task 2: Full verification and delivery

**Files:**
- Modify: none unless verification exposes a regression.

- [ ] Run `npm run check` and verify all suites pass.
- [ ] Run `git diff --check` and verify no whitespace errors.
- [ ] Merge to master, rerun `npm run check`, restart AI-CAD, and verify `/api/status` responds.
