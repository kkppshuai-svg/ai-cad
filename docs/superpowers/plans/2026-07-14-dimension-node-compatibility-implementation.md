# Dimension Node Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely accept equal-valued legacy dimension groups and prevent malformed parametric plans from reaching build state.

**Architecture:** Extend the pure parametric normalizer with conservative dimension inference, then make planner output normalization authoritative before persistence. Tighten the planner prompt for future outputs.

**Tech Stack:** Node.js ES modules and Node test runner.

---

### Task 1: Dimension compatibility

**Files:** `parametric-plan.js`, `parametric-plan.test.mjs`

- [ ] Add failing tests for equal legacy values, one scalar value, conflicting values, and no scalar values.
- [ ] Run focused tests and verify RED.
- [ ] Implement conservative `value` inference before dimension validation.
- [ ] Run focused tests and verify GREEN.

### Task 2: Early normalization and prompt contract

**Files:** `server.js`, `prompt-contract.js`, `prompt-contract.test.mjs`

- [ ] Add a failing prompt test requiring `dimension` name/value and split nodes.
- [ ] Normalize complete planner responses before returning them to conversation persistence.
- [ ] Run focused tests, then `npm run check`.
- [ ] Merge, rerun checks, and restart AI-CAD.
