import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexExecInvocation, normalizeCodexModel, normalizeCodexReasoningEffort } from "./codex-cli.js";

test("passes Codex prompt through stdin instead of a command-line argument", () => {
  const invocation = buildCodexExecInvocation("make a hinge bracket");

  assert.deepEqual(invocation.args, [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never"
  ]);
  assert.equal(invocation.input, "make a hinge bracket");
});

test("keeps image arguments on the command line while prompt stays on stdin", () => {
  const invocation = buildCodexExecInvocation("infer from image", [
    { path: "/tmp/front.jpg" },
    { path: "/tmp/side.png" }
  ]);

  assert.deepEqual(invocation.args.slice(-4), [
    "--image",
    "/tmp/front.jpg",
    "--image",
    "/tmp/side.png"
  ]);
  assert.equal(invocation.input, "infer from image");
});

test("scoped edits use an ephemeral low-reasoning planner without repository rules", () => {
  const invocation = buildCodexExecInvocation("return json", [], { fastPlanner: true });
  assert.ok(invocation.args.includes("--ephemeral"));
  assert.ok(invocation.args.includes("--ignore-rules"));
  assert.ok(invocation.args.includes('model_reasoning_effort="low"'));
  assert.equal(invocation.input, "return json");
});

test("does not pass removed view_image feature flag to current Codex", () => {
  const invocation = buildCodexExecInvocation("return json", [], { fastPlanner: true });
  assert.equal(invocation.args.includes("view_image"), false);
});

test("pins GPT-6 Sol and all supported reasoning efforts when configured", () => {
  const invocation = buildCodexExecInvocation("return json", [], {
    model: "gpt-6-sol",
    reasoningEffort: "medium"
  });
  assert.deepEqual(invocation.args.slice(0, 5), [
    "exec",
    "--model",
    "gpt-6-sol",
    "-c",
    'model_reasoning_effort="medium"'
  ]);
  assert.equal(normalizeCodexModel(), "gpt-6-sol");
  assert.equal(normalizeCodexModel("gpt-6-sol"), "gpt-6-sol");
  assert.equal(normalizeCodexReasoningEffort("medium"), "medium");
  assert.equal(normalizeCodexReasoningEffort("none"), "none");
  assert.throws(() => normalizeCodexReasoningEffort("minimal"), /Invalid Codex reasoning effort/);
});
