import { DEEPSEEK_DEFAULT_MODEL, normalizeDeepSeekConfig } from "./deepseek-client.js";

export const LLM_PROVIDERS = new Set(["codex", "deepseek"]);
export const LLM_DEFAULT_PROVIDER = "codex";

export function normalizeLlmProvider(value, fallback = LLM_DEFAULT_PROVIDER) {
  const provider = String(value || fallback).trim().toLowerCase();
  if (!LLM_PROVIDERS.has(provider)) throw new Error(`Invalid LLM provider: ${provider}`);
  return provider;
}

export function normalizeLlmStrict(value) {
  return ["1", "true", "on", "yes"].includes(String(value || "").trim().toLowerCase());
}

// Routing policy keeps Codex as the always-available engineering path while
// DeepSeek becomes the primary planner when it is explicitly selected and
// configured. A missing key or a text-only model never silently weakens an
// image request: those cases fall back to Codex unless strict mode is on.
export function resolveLlmPolicy(env = {}) {
  const provider = normalizeLlmProvider(env.AICAD_LLM_PROVIDER, LLM_DEFAULT_PROVIDER);
  const strict = normalizeLlmStrict(env.AICAD_LLM_STRICT);
  const deepseek = normalizeDeepSeekConfig(env);
  const warnings = [];
  if (provider === "deepseek" && !deepseek.apiKey) {
    warnings.push("AICAD_LLM_PROVIDER=deepseek 但未配置 DeepSeek API key，本次运行继续使用 Codex。");
  }
  return { provider, strict, deepseek, warnings };
}

export function llmRouteForRequest(policy, { hasImages = false } = {}) {
  if (policy?.provider !== "deepseek") {
    return { useDeepSeek: false, fallbackToCodex: true, reason: "codex-provider" };
  }
  if (!policy.deepseek?.apiKey) {
    return { useDeepSeek: false, fallbackToCodex: true, reason: "missing-api-key" };
  }
  if (hasImages && !policy.deepseek.supportsImages) {
    return { useDeepSeek: false, fallbackToCodex: !policy.strict, reason: "images-unsupported" };
  }
  return { useDeepSeek: true, fallbackToCodex: !policy.strict, reason: "deepseek" };
}

export function describeLlmPolicy(policy, { codexModel = null } = {}) {
  const deepseekReady = policy?.provider === "deepseek" && Boolean(policy.deepseek?.apiKey);
  return {
    provider: policy?.provider || LLM_DEFAULT_PROVIDER,
    strict: Boolean(policy?.strict),
    fallbackProvider: policy?.strict ? null : "codex",
    codexModel,
    deepseek: {
      configured: Boolean(policy?.deepseek?.apiKey),
      baseUrl: policy?.deepseek?.baseUrl || null,
      model: policy?.deepseek?.model || DEEPSEEK_DEFAULT_MODEL,
      vision: Boolean(policy?.deepseek?.supportsImages),
      jsonMode: Boolean(policy?.deepseek?.jsonMode),
      timeoutMs: policy?.deepseek?.timeoutMs || null,
      active: deepseekReady
    }
  };
}
