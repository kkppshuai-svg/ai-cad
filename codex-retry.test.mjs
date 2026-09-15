import test from "node:test";
import assert from "node:assert/strict";

import { isProcessTimeoutError, runWithTimeoutRetry } from "./codex-retry.js";

test("retries one timeout with fast context and returns the second result", async () => {
  const attempts = [];
  const result = await runWithTimeoutRetry(async (context) => {
    attempts.push(context);
    if (context.attempt === 0) throw new Error("codex timed out after 160000ms");
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(attempts, [
    { attempt: 0, fastRetry: false },
    { attempt: 1, fastRetry: true }
  ]);
});

test("does not retry non-timeout failures", async () => {
  let attempts = 0;
  await assert.rejects(
    runWithTimeoutRetry(async () => {
      attempts += 1;
      throw new Error("codex exited with code 1");
    }),
    /exited with code 1/
  );
  assert.equal(attempts, 1);
});

test("two timeouts return a stable Chinese error with the timeout as cause", async () => {
  let attempts = 0;
  await assert.rejects(
    runWithTimeoutRetry(async () => {
      attempts += 1;
      throw new Error("codex timed out after 300000ms");
    }),
    (error) => {
      assert.match(error.message, /AI 建模请求超时.*缩小修改范围/i);
      assert.match(error.cause?.message || "", /timed out/i);
      return true;
    }
  );
  assert.equal(attempts, 2);
});

test("recognizes only process timeout errors", () => {
  assert.equal(isProcessTimeoutError(new Error("codex timed out after 160000ms")), true);
  assert.equal(isProcessTimeoutError(new Error("connection timed out")), false);
  assert.equal(isProcessTimeoutError(new Error("codex exited with code 1")), false);
});
