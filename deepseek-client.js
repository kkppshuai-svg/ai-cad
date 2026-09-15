import path from "node:path";
import { readFile } from "node:fs/promises";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";
export const DEEPSEEK_DEFAULT_TIMEOUT_MS = 300000;
export const DEEPSEEK_MAX_TIMEOUT_MS = 900000;
export const DEEPSEEK_MIN_TIMEOUT_MS = 30000;

// DeepSeek 官方文本模型不读图；只有名字带视觉标记的模型或显式开关才发送图片。
const DEEPSEEK_VISION_MODEL_PATTERN = /(vl|vision|multimodal|omni)/i;
const IMAGE_MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

export class DeepSeekError extends Error {
  constructor(message, { code = "DEEPSEEK_ERROR", status = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DeepSeekError";
    this.provider = "deepseek";
    this.code = code;
    this.status = status;
  }
}

export function isEnabledFlag(value) {
  return ["1", "true", "on", "yes"].includes(String(value || "").trim().toLowerCase());
}

export function normalizeDeepSeekBaseUrl(value, fallback = DEEPSEEK_DEFAULT_BASE_URL) {
  const raw = String(value || "").trim() || fallback;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid DeepSeek base URL: ${raw}`);
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.host) throw new Error(`Invalid DeepSeek base URL: ${raw}`);
  return raw.replace(/\/+$/, "");
}

export function normalizeDeepSeekModel(value, fallback = DEEPSEEK_DEFAULT_MODEL) {
  const model = String(value || fallback).trim();
  if (!/^[a-z0-9][a-z0-9._/-]{0,79}$/i.test(model)) throw new Error(`Invalid DeepSeek model: ${model}`);
  return model;
}

export function normalizeDeepSeekVision(value, model = DEEPSEEK_DEFAULT_MODEL) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return DEEPSEEK_VISION_MODEL_PATTERN.test(String(model || ""));
  if (isEnabledFlag(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  throw new Error(`Invalid AICAD_DEEPSEEK_VISION: ${value}`);
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function optionalNumber(value, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, number));
}

export function normalizeDeepSeekConfig(env = {}) {
  const model = normalizeDeepSeekModel(env.AICAD_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL, DEEPSEEK_DEFAULT_MODEL);
  const vision = normalizeDeepSeekVision(env.AICAD_DEEPSEEK_VISION, model);
  const apiKey = String(env.AICAD_DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || "").trim();
  return {
    apiKey,
    baseUrl: normalizeDeepSeekBaseUrl(env.AICAD_DEEPSEEK_BASE_URL || env.DEEPSEEK_BASE_URL),
    model,
    vision,
    supportsImages: vision,
    jsonMode: isEnabledFlag(env.AICAD_DEEPSEEK_JSON_MODE),
    temperature: optionalNumber(env.AICAD_DEEPSEEK_TEMPERATURE, 0, 2),
    maxTokens: optionalNumber(env.AICAD_DEEPSEEK_MAX_TOKENS, 1, 65536),
    timeoutMs: boundedNumber(env.AICAD_DEEPSEEK_TIMEOUT_MS, DEEPSEEK_DEFAULT_TIMEOUT_MS, DEEPSEEK_MIN_TIMEOUT_MS, DEEPSEEK_MAX_TIMEOUT_MS)
  };
}

export function deepSeekChatCompletionsUrl(baseUrl = DEEPSEEK_DEFAULT_BASE_URL) {
  return `${normalizeDeepSeekBaseUrl(baseUrl)}/chat/completions`;
}

export function buildDeepSeekChatBody({ model, prompt, images = [], json = false, temperature = null, maxTokens = null } = {}) {
  const content = images.length
    ? [
        { type: "text", text: prompt },
        ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl || image.url } }))
      ]
    : prompt;
  const body = { model, messages: [{ role: "user", content }], stream: false };
  if (json) body.response_format = { type: "json_object" };
  if (temperature !== null && temperature !== undefined) body.temperature = temperature;
  if (maxTokens !== null && maxTokens !== undefined) body.max_tokens = maxTokens;
  return body;
}

export async function readImageAsDataUrl(filePath, { readFileImpl = readFile, mime = null } = {}) {
  const buffer = await readFileImpl(filePath);
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!bytes.length) throw new DeepSeekError(`图片内容为空：${filePath}`, { code: "DEEPSEEK_IMAGE_EMPTY" });
  const resolvedMime = mime || IMAGE_MIME_BY_EXTENSION[path.extname(String(filePath)).toLowerCase()] || "image/png";
  return `data:${resolvedMime};base64,${bytes.toString("base64")}`;
}

export async function normalizeDeepSeekImages(images = [], { readFileImpl = readFile } = {}) {
  const normalized = [];
  for (const image of images) {
    if (!image) continue;
    if (typeof image === "string") {
      normalized.push({ name: path.basename(image), dataUrl: await readImageAsDataUrl(image, { readFileImpl }) });
      continue;
    }
    if (image.dataUrl) {
      normalized.push({ name: image.name || image.view || "", dataUrl: String(image.dataUrl) });
      continue;
    }
    if (image.path) {
      normalized.push({ name: image.name || path.basename(image.path), dataUrl: await readImageAsDataUrl(image.path, { readFileImpl }) });
    }
  }
  return normalized;
}

export function deepSeekResponseText(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = choice?.message || choice?.delta || null;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === "string" ? part : String(part?.text ?? part?.content ?? "")))
      .join("");
  }
  if (typeof message.text === "string") return message.text;
  return "";
}

export function deepSeekErrorMessage(payload, fallback) {
  const message = payload?.error?.message || payload?.message || payload?.error;
  return typeof message === "string" && message.trim() ? message.trim() : fallback;
}

export class DeepSeekClient {
  constructor({
    apiKey = "",
    baseUrl = DEEPSEEK_DEFAULT_BASE_URL,
    model = DEEPSEEK_DEFAULT_MODEL,
    vision = null,
    jsonMode = false,
    temperature = null,
    maxTokens = null,
    timeoutMs = DEEPSEEK_DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    readFileImpl = readFile
  } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.baseUrl = normalizeDeepSeekBaseUrl(baseUrl);
    this.model = normalizeDeepSeekModel(model);
    this.supportsImages = vision === null || vision === undefined ? normalizeDeepSeekVision("auto", this.model) : Boolean(vision);
    this.jsonMode = Boolean(jsonMode);
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.timeoutMs = boundedNumber(timeoutMs, DEEPSEEK_DEFAULT_TIMEOUT_MS, DEEPSEEK_MIN_TIMEOUT_MS, DEEPSEEK_MAX_TIMEOUT_MS);
    this.fetchImpl = fetchImpl;
    this.readFileImpl = readFileImpl;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async run({ prompt, images = [], json = this.jsonMode, timeoutMs = this.timeoutMs } = {}) {
    const text = String(prompt ?? "");
    if (!text.trim()) throw new DeepSeekError("DeepSeek prompt 不能为空", { code: "DEEPSEEK_PROMPT_REQUIRED" });
    if (!this.configured) {
      throw new DeepSeekError("未配置 DeepSeek API key（DEEPSEEK_API_KEY 或 AICAD_DEEPSEEK_API_KEY）", { code: "DEEPSEEK_API_KEY_MISSING" });
    }
    const requestedImages = Array.isArray(images) ? images.filter(Boolean) : [];
    if (requestedImages.length && !this.supportsImages) {
      throw new DeepSeekError(
        `DeepSeek 模型 ${this.model} 未启用图片输入。可在 .env.local 设置 AICAD_DEEPSEEK_VISION=1 或改用支持视觉的模型。`,
        { code: "DEEPSEEK_VISION_UNSUPPORTED" }
      );
    }
    const normalizedImages = await normalizeDeepSeekImages(requestedImages, { readFileImpl: this.readFileImpl });
    const body = buildDeepSeekChatBody({
      model: this.model,
      prompt: text,
      images: normalizedImages,
      json: Boolean(json),
      temperature: this.temperature,
      maxTokens: this.maxTokens
    });
    const effectiveTimeoutMs = boundedNumber(timeoutMs, this.timeoutMs, DEEPSEEK_MIN_TIMEOUT_MS, DEEPSEEK_MAX_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    let response;
    try {
      response = await this.fetchImpl(deepSeekChatCompletionsUrl(this.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) {
        throw new DeepSeekError(`DeepSeek 请求超时（${effectiveTimeoutMs}ms）`, { code: "DEEPSEEK_TIMEOUT", cause: error });
      }
      throw new DeepSeekError(`DeepSeek 网络请求失败：${error?.message || error}`, { code: "DEEPSEEK_NETWORK_ERROR", cause: error });
    } finally {
      clearTimeout(timer);
    }

    const raw = typeof response.text === "function" ? await response.text() : "";
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new DeepSeekError(`DeepSeek 请求失败（HTTP ${response.status}）：${deepSeekErrorMessage(payload, String(raw || "").slice(0, 300))}`, {
        code: "DEEPSEEK_HTTP_ERROR",
        status: response.status
      });
    }
    if (payload?.error) {
      throw new DeepSeekError(`DeepSeek 返回错误：${deepSeekErrorMessage(payload, "unknown error")}`, { code: "DEEPSEEK_API_ERROR" });
    }
    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    return {
      provider: "deepseek",
      model: payload?.model || this.model,
      text: deepSeekResponseText(payload),
      finishReason: choice?.finish_reason || null,
      usage: payload?.usage || null,
      images: normalizedImages.length
    };
  }
}
