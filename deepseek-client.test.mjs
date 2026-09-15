import test from "node:test";
import assert from "node:assert/strict";

import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekClient,
  buildDeepSeekChatBody,
  deepSeekResponseText,
  normalizeDeepSeekConfig,
  normalizeDeepSeekImages,
  normalizeDeepSeekVision,
  readImageAsDataUrl
} from "./deepseek-client.js";

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); }
  };
}

function captureFetch(status, payload, calls) {
  return async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return jsonResponse(status, payload);
  };
}

test("DeepSeek defaults to the official OpenAI-compatible endpoint and text model", () => {
  const config = normalizeDeepSeekConfig({ DEEPSEEK_API_KEY: "sk-test" });
  assert.equal(config.apiKey, "sk-test");
  assert.equal(config.baseUrl, DEEPSEEK_DEFAULT_BASE_URL);
  assert.equal(config.model, DEEPSEEK_DEFAULT_MODEL);
  assert.equal(config.supportsImages, false);
  assert.equal(config.jsonMode, false);
  assert.equal(config.timeoutMs, 300000);
});

test("AICAD_ prefixed DeepSeek settings win over generic ones", () => {
  const config = normalizeDeepSeekConfig({
    DEEPSEEK_API_KEY: "generic",
    AICAD_DEEPSEEK_API_KEY: "specific",
    DEEPSEEK_MODEL: "deepseek-reasoner",
    AICAD_DEEPSEEK_MODEL: "deepseek-chat",
    AICAD_DEEPSEEK_BASE_URL: "https://proxy.example.com/v1/",
    AICAD_DEEPSEEK_JSON_MODE: "1"
  });
  assert.equal(config.apiKey, "specific");
  assert.equal(config.model, "deepseek-chat");
  assert.equal(config.baseUrl, "https://proxy.example.com/v1");
  assert.equal(config.jsonMode, true);
});

test("vision support follows an explicit switch or a vision-capable model name", () => {
  assert.equal(normalizeDeepSeekVision("auto", "deepseek-vl2"), true);
  assert.equal(normalizeDeepSeekVision("auto", "deepseek-chat"), false);
  assert.equal(normalizeDeepSeekVision("1", "deepseek-chat"), true);
  assert.equal(normalizeDeepSeekVision("off", "deepseek-vl2"), false);
  assert.throws(() => normalizeDeepSeekVision("maybe", "deepseek-chat"), /Invalid AICAD_DEEPSEEK_VISION/);
});

test("runs a text-only chat completion against the DeepSeek endpoint", async () => {
  const calls = [];
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: captureFetch(200, { model: "deepseek-chat", choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }], usage: { total_tokens: 12 } }, calls)
  });

  const result = await client.run({ prompt: "规划一个法兰盘" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer sk-test");
  assert.equal(calls[0].body.model, "deepseek-chat");
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.messages[0].content, "规划一个法兰盘");
  assert.equal(result.text, "{\"ok\":true}");
  assert.equal(result.provider, "deepseek");
  assert.equal(result.model, "deepseek-chat");
  assert.equal(result.usage.total_tokens, 12);
});

test("sends image parts only when the configured model supports vision", async () => {
  const calls = [];
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    vision: true,
    fetchImpl: captureFetch(200, { choices: [{ message: { content: "done" } }] }, calls)
  });

  await client.run({
    prompt: "看这张参考图",
    images: [{ name: "ref.png", dataUrl: "data:image/png;base64,AAAA" }]
  });

  const content = calls[0].body.messages[0].content;
  assert.equal(Array.isArray(content), true);
  assert.deepEqual(content[0], { type: "text", text: "看这张参考图" });
  assert.deepEqual(content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
});

test("reads image attachments from disk with an inferred mime type", async () => {
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    vision: true,
    readFileImpl: async () => Buffer.from("hello"),
    fetchImpl: captureFetch(200, { choices: [{ message: { content: "ok" } }] }, [])
  });

  await client.run({ prompt: "看图", images: [{ path: "/tmp/render.jpg" }] });
  const dataUrl = await readImageAsDataUrl("/tmp/render.jpg", { readFileImpl: async () => Buffer.from("hello") });
  assert.equal(dataUrl, "data:image/jpeg;base64,aGVsbG8=");
  assert.equal((await normalizeDeepSeekImages([{ path: "/tmp/render.webp" }], { readFileImpl: async () => Buffer.from("x") }))[0].dataUrl.startsWith("data:image/webp"), true);
});

test("refuses image requests instead of silently dropping the screenshots", async () => {
  let called = 0;
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async () => { called += 1; return jsonResponse(200, {}); }
  });

  await assert.rejects(
    client.run({ prompt: "审查装配", images: [{ path: "/tmp/a.png" }] }),
    (error) => {
      assert.equal(error.code, "DEEPSEEK_VISION_UNSUPPORTED");
      assert.equal(error.provider, "deepseek");
      return true;
    }
  );
  assert.equal(called, 0);
});

test("reports missing credentials before any network call", async () => {
  const client = new DeepSeekClient({ apiKey: "" });
  await assert.rejects(client.run({ prompt: "hello" }), (error) => {
    assert.equal(error.code, "DEEPSEEK_API_KEY_MISSING");
    return true;
  });
});

test("surfaces HTTP and timeout failures with actionable codes", async () => {
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async () => jsonResponse(401, { error: { message: "Authentication Fails" } })
  });
  await assert.rejects(client.run({ prompt: "hello" }), (error) => {
    assert.equal(error.code, "DEEPSEEK_HTTP_ERROR");
    assert.equal(error.status, 401);
    assert.match(error.message, /Authentication Fails/);
    return true;
  });

  const aborting = new DeepSeekClient({
    apiKey: "sk-test",
    fetchImpl: async () => { throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); }
  });
  await assert.rejects(aborting.run({ prompt: "hello" }), (error) => {
    assert.equal(error.code, "DEEPSEEK_TIMEOUT");
    return true;
  });
});

test("builds json-mode bodies and extracts array content", () => {
  const body = buildDeepSeekChatBody({ model: "deepseek-chat", prompt: "输出 JSON", json: true, temperature: 0.2, maxTokens: 512 });
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 512);
  assert.equal(deepSeekResponseText({ choices: [{ message: { content: [{ type: "text", text: "abc" }, { type: "text", text: "def" }] } }] }), "abcdef");
  assert.equal(deepSeekResponseText({ choices: [{ message: { reasoning_content: "thinking" } }] }), "");
  assert.equal(deepSeekResponseText({}), "");
});
