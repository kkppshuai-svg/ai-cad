const CODEX_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function normalizeCodexModel(value, fallback = "gpt-6-astra") {
  const model = String(value || fallback).trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(model)) throw new Error(`Invalid Codex model: ${model}`);
  return model;
}

export function normalizeCodexReasoningEffort(value, fallback = "medium") {
  const effort = String(value || fallback).trim().toLowerCase();
  if (!CODEX_REASONING_EFFORTS.has(effort)) throw new Error(`Invalid Codex reasoning effort: ${effort}`);
  return effort;
}

export function buildCodexExecInvocation(prompt, imageAttachments = [], options = {}) {
  const modelArgs = options.model ? ["--model", normalizeCodexModel(options.model)] : [];
  const reasoningEffort = options.fastPlanner
    ? "low"
    : options.reasoningEffort ? normalizeCodexReasoningEffort(options.reasoningEffort) : null;
  const fastPlannerArgs = options.fastPlanner
    ? [
        "--ephemeral",
        "--ignore-rules",
        "--disable", "plugins",
        "--disable", "remote_plugin",
        "--disable", "apps",
        "--disable", "memories",
        "--disable", "multi_agent",
        "--disable", "browser_use",
        "--disable", "computer_use",
        "--disable", "image_generation",
        "--disable", "shell_tool",
        "--disable", "unified_exec",
        "--disable", "skill_search",
        "--disable", "hooks",
        "--disable", "goals",
        "-c", 'model_reasoning_effort="low"'
      ]
    : [];
  return {
    args: [
      "exec",
      ...modelArgs,
      ...(!options.fastPlanner && reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`] : []),
      ...fastPlannerArgs,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      ...imageAttachments.flatMap((item) => ["--image", item.path])
    ],
    input: prompt
  };
}
