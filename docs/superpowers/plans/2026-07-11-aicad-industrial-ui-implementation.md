# AI CAD Industrial UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing AI CAD interface into a compact dark precision-instrument workspace while preserving every existing function, DOM ID, and JavaScript workflow.

**Architecture:** Keep the native HTML/CSS/JS architecture and all behavior in `public/app.js`. Add only presentation-oriented structure and accessibility labels in `public/index.html`, then replace the accumulated card-style CSS with one coherent industrial design system in `public/styles.css`. Protect the redesign with a static UI contract test and the existing functional source tests.

**Tech Stack:** HTML5, CSS3, native JavaScript, Node.js built-in test runner.

---

### Task 1: Add an industrial UI contract test

**Files:**
- Create: `industrial-ui.test.mjs`
- Test: `industrial-ui.test.mjs`

- [ ] **Step 1: Write the failing test**

Create assertions that require an application header class, workspace-oriented labels, cold-blue design tokens, compact radii, non-pill buttons, responsive breakpoints, reduced-motion support, and preservation of all functional IDs.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test industrial-ui.test.mjs`

Expected: FAIL because the current page still uses the old hero/card design tokens and lacks the new application-workspace markers.

- [ ] **Step 3: Add the test to the project check command**

Modify `package.json` so `npm run check` includes `industrial-ui.test.mjs` alongside the existing UI tests.

### Task 2: Restructure presentation markup without changing behavior

**Files:**
- Modify: `public/index.html`
- Test: `industrial-ui.test.mjs`, `ui-copy.test.mjs`, `viewer-views.test.mjs`, `visual-review-ui.test.mjs`

- [ ] **Step 1: Convert the hero into a compact application header**

Keep `engineStatus` and all existing text required by tests, but introduce `app-header`, `brand-block`, `status-indicator`, and concise workspace copy.

- [ ] **Step 2: Add presentation-only panel metadata**

Add panel role classes and small section kickers to distinguish conversation, feature editor, viewport, and quality inspector. Do not rename or remove any existing ID.

- [ ] **Step 3: Run the UI tests**

Run: `node --test industrial-ui.test.mjs ui-copy.test.mjs viewer-views.test.mjs visual-review-ui.test.mjs`

Expected: the industrial contract may still fail on CSS, while all pre-existing functional UI tests pass.

### Task 3: Implement the dark precision-instrument design system

**Files:**
- Modify: `public/styles.css`
- Test: `industrial-ui.test.mjs`

- [ ] **Step 1: Replace global tokens and page foundation**

Use cold gunmetal surfaces, blue focus/action states, restrained status colors, system UI fonts, monospaced technical values, thin borders, and minimal shadows.

- [ ] **Step 2: Build the compact desktop workspace**

Style the header at application-bar scale, use compact three-column sizing, reserve space for the fixed quality inspector, and make the preview panel the visual focus.

- [ ] **Step 3: Restyle controls and data panels**

Use 5–10px radii, rectangular tool buttons, recessed inputs, restrained message blocks, engineering data cards, compact viewer controls, and consistent visual-review/rating states.

- [ ] **Step 4: Add responsive and accessibility rules**

Add wide, laptop, tablet, and mobile breakpoints without hiding core functions. Add visible `:focus-visible` treatment and a `prefers-reduced-motion` rule.

- [ ] **Step 5: Run the industrial UI contract test**

Run: `node --test industrial-ui.test.mjs`

Expected: PASS.

### Task 4: Verify behavior and rendered-page integrity

**Files:**
- Verify: `public/index.html`, `public/styles.css`, `public/app.js`, `package.json`

- [ ] **Step 1: Run syntax and focused UI checks**

Run: `node --check public/app.js && node --test industrial-ui.test.mjs ui-copy.test.mjs viewer-views.test.mjs visual-review-ui.test.mjs`

Expected: all checks pass with zero failures.

- [ ] **Step 2: Run the full project verification**

Run: `npm run check`

Expected: exit code 0 and zero failed tests.

- [ ] **Step 3: Inspect the final diff and ID preservation**

Run: `git diff --check && rg -o 'id="[^"]+"' public/index.html | sort | uniq -d`

Expected: no whitespace errors and no duplicate IDs.

- [ ] **Step 4: Review the rendered interface at desktop and mobile widths**

Start the local application, capture the page at representative desktop and mobile sizes, and verify that the 3D viewport remains dominant, the rating inspector does not obscure controls, and all panels remain reachable.
