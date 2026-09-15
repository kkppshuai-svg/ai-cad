import test from "node:test";
import assert from "node:assert/strict";

import { createApiClient } from "./public/api-client.js";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); }
  };
}

test("refreshes an invalid token and retries the POST once", async () => {
  let token = "old-token";
  const calls = [];
  const replies = [
    response(403, { error: "Invalid request token" }),
    response(200, { requestToken: "new-token" }),
    response(200, { ok: true })
  ];
  const api = createApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
    getToken: () => token,
    setToken: (value) => { token = value; }
  });

  assert.deepEqual(await api("/api/chat", { method: "POST", body: { message: "修改" } }), { ok: true });
  assert.equal(token, "new-token");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers["X-AI-CAD-Token"], "old-token");
  assert.equal(calls[1].url, "/api/status");
  assert.equal(calls[2].options.headers["X-AI-CAD-Token"], "new-token");
});

test("does not refresh for unrelated forbidden responses", async () => {
  let calls = 0;
  const api = createApiClient({
    fetchImpl: async () => {
      calls += 1;
      return response(403, { error: "Origin is not allowed" });
    },
    getToken: () => "token",
    setToken: () => assert.fail("token must not change")
  });

  await assert.rejects(api("/api/chat", { method: "POST" }), /Origin is not allowed/);
  assert.equal(calls, 1);
});

test("never retries the POST more than once", async () => {
  let token = "old-token";
  let postCalls = 0;
  const api = createApiClient({
    fetchImpl: async (url) => {
      if (url === "/api/status") return response(200, { requestToken: "new-token" });
      postCalls += 1;
      return response(403, { error: "Invalid request token" });
    },
    getToken: () => token,
    setToken: (value) => { token = value; }
  });

  await assert.rejects(api("/api/chat", { method: "POST" }), /Invalid request token/);
  assert.equal(postCalls, 2);
});

test("preserves structured API error codes for training workflow decisions", async () => {
  const api = createApiClient({
    fetchImpl: async () => response(409, { error: "需要用户确认", code: "AMBIGUOUS_IMPROVEMENT", candidates: [{ partId: "wheel" }] }),
    getToken: () => "token",
    setToken: () => {}
  });

  await assert.rejects(api("/api/visual-review/improve", { method: "POST", body: {} }), (error) => {
    assert.equal(error.code, "AMBIGUOUS_IMPROVEMENT");
    assert.equal(error.status, 409);
    assert.equal(error.details.candidates[0].partId, "wheel");
    return true;
  });
});
