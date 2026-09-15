import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAllowedHostHeader,
  isAllowedOriginHeader,
  isStateChangingMethod,
  isValidRequestToken,
} from "./security.js";
import {
  buildAssemblyConstraintManifest,
  buildPackageMates,
  renderFreeCadOpenScript,
} from "./freecad-bridge.js";
import { buildAssemblyPlannerInstruction } from "./prompt-contract.js";
import { compactPlannerConversation } from "./planner-context.js";
import { hydrateStandardPartsForPlan } from "./standard-parts.js";
import { normalizeAnySearchResponse } from "./anysearch-provider.js";
import { buildCadReferenceContext, formatCadReferenceContextForPrompt } from "./cad-reference-context.js";
import { buildCadLatentSample } from "./cad-latent-memory.js";
import { searchStepPartsCandidates } from "./step-parts.js";
import { buildExplorerCommandArgs, chooseExplorerPreviewFile, isPathInside, parseExplorerUrl } from "./cad-explorer-link.js";
import { buildCodexExecInvocation, normalizeCodexModel, normalizeCodexReasoningEffort } from "./codex-cli.js";
import { CodexHarnessClient } from "./codex-harness.js";
import { DeepSeekClient } from "./deepseek-client.js";
import { describeLlmPolicy, llmRouteForRequest, resolveLlmPolicy } from "./llm-provider.js";
import { runWithTimeoutRetry } from "./codex-retry.js";
import { generatePlanWithProfileRepair, normalizeGeneratedPlanCandidate } from "./planner-profile-repair.js";
import { safePartId, sanitizeFeature, sanitizePose, sanitizePrimitive } from "./plan-validation.js";
import { synchronizeConversationWithAssembly } from "./conversation-state.js";
import { actionableVisualFindings, buildVisualImprovementValidationRepairMessage, buildVisualReviewImprovementMessage, buildVisualReviewInstruction, buildVisualReviewReportRepairMessage, normalizeVisualReviewResult, visualReviewImprovementEligibility } from "./visual-review.js";
import { canPromoteRevision } from "./cad-validation.js";
import { createRouteTable, matchRoute } from "./api-routes.js";
import { buildValidatedAssembly } from "./assembly-build.js";
import { createRepairPlanner, normalizeWebSearchOptions, runConversationEditTurn, sanitizeFbsContext, shouldResetPlanForMessage } from "./conversation-turn.js";
import { boundedInt, sanitizeText } from "./text-utils.js";
import { buildPackageAudit, renderMatesMarkdown } from "./kinematic-package-report.js";
import { checksumParametricPart, normalizeParametricPlan, preflightExtrudeProfiles } from "./parametric-plan.js";
import { validatePartComplexity } from "./plan-complexity.js";
import { checksumPartBuildPolicy, editAssemblyRevision, featureTreePayload, isEditPatchResponse, parseParametricAssemblyRoute, restoreJobFromRevisionState, REVISION_DELIVERY_KEYS, validationPayload, withAssemblyRevisionLock } from "./parametric-api.js";
import { listRevisions, loadRevisionState, revertRevision } from "./revision-store.js";
import { restoreAssemblyJob, restoreLatestAssemblyJob } from "./assembly-job-recovery.js";
import { runAssemblyValidationRepairLoop } from "./validation-repair-loop.js";
import { buildNema23LBracketPlan } from "./nema23-template.js";
import { assertAssemblyPartCount, MAX_ASSEMBLY_PARTS } from "./assembly-plan-limits.js";
import { normalizeFbsAnalysis } from "./fbs-workflow.js";
import { CadLatentTrainingManager } from "./cad-latent-training.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnvFile(path.join(__dirname, ".env.local"));

const publicDir = path.join(__dirname, "public");
const threeBuildDir = path.join(__dirname, "node_modules", "three", "build");
const threeAddonsDir = path.join(__dirname, "node_modules", "three", "examples", "jsm");
const workspaceDir = path.join(__dirname, "workspace");
const chatUploadsDir = path.join(workspaceDir, "uploads");
const renderDir = path.join(__dirname, "renders");
const assemblyDir = path.join(__dirname, "assemblies");
const standardPartsCacheDir = path.join(__dirname, "standard-parts-cache");
const conversationArchiveDir = path.join(process.env.AICAD_CONVERSATION_DIR || path.join(__dirname, "aicad建模反馈"));
const cadqueryScriptLibraryDir = path.join(process.env.AICAD_CADQUERY_SCRIPT_DIR || path.join(__dirname, "cadquery底层脚本库"));
const ratingArchiveDir = path.join(process.env.AICAD_RATING_DIR || path.join(__dirname, "aicad人工评分"));
const trainingArchiveDir = path.join(process.env.AICAD_TRAINING_DIR || path.join(__dirname, "aicad训练记录"));
const fbsArchiveDir = path.join(process.env.AICAD_FBS_DIR || path.join(__dirname, "aicad-fbs-experiments"));
const excellentCadqueryLibraryDir = path.join(process.env.AICAD_EXCELLENT_CADQUERY_DIR || path.join(__dirname, "人工优秀代码库"));
const port = Number(process.env.PORT || 3101);
const host = process.env.HOST || "127.0.0.1";
const allowRemote = isEnabled(process.env.AICAD_ALLOW_REMOTE);
const maxJsonBodyBytes = boundedInt(process.env.AICAD_MAX_JSON_BODY_BYTES, 4_000_000, 1024, 16_000_000);
const maxChatImages = boundedInt(process.env.AICAD_MAX_CHAT_IMAGES, 3, 1, 6);
const maxChatImageBytes = boundedInt(process.env.AICAD_MAX_CHAT_IMAGE_BYTES, 2_000_000, 10_000, 8_000_000);
const maxVisualReviewImages = boundedInt(process.env.AICAD_MAX_VISUAL_REVIEW_IMAGES, 6, 1, 8);
const maxVisualReviewImageBytes = boundedInt(process.env.AICAD_MAX_VISUAL_REVIEW_IMAGE_BYTES, 1_500_000, 10_000, 5_000_000);
const cadqueryPython = validateCommandPath(process.env.CADQUERY_PYTHON || path.join(__dirname, ".venv-cadquery", "bin", "python"), "CADQUERY_PYTHON");
const codexBin = validateCommandPath(process.env.CODEX_BIN || "codex", "CODEX_BIN");
const codexModel = normalizeCodexModel(process.env.AICAD_CODEX_MODEL, "gpt-6-astra");
const codexReasoningEffort = normalizeCodexReasoningEffort(process.env.AICAD_CODEX_REASONING_EFFORT, "medium");
const codexHarnessEnabled = process.env.AICAD_CODEX_HARNESS !== "exec";
const codexHarnessStrict = process.env.AICAD_CODEX_HARNESS_STRICT === "1";
const codexHarness = new CodexHarnessClient({ command: codexBin, cwd: __dirname, env: buildChildEnv(process.env), model: codexModel, reasoningEffort: codexReasoningEffort });
const llmPolicy = resolveLlmPolicy(process.env);
const deepseekClient = llmPolicy.deepseek.apiKey ? new DeepSeekClient({ ...llmPolicy.deepseek }) : null;
const freecadCmd = validateCommandPath(process.env.FREECAD_CMD || "freecadcmd", "FREECAD_CMD");
const webSearchProvider = normalizeWebSearchProvider(process.env.AICAD_WEB_SEARCH_PROVIDER || (process.env.TAVILY_API_KEY ? "tavily" : "anysearch"));
const webSearchMaxResults = Math.max(1, Math.min(8, Number(process.env.AICAD_WEB_SEARCH_MAX_RESULTS || 5)));
// Web search is advisory; keep it from holding up CAD generation when the
// external provider or DNS is unavailable.  An explicit env value can still
// increase this for installations with a reliable proxy.
const webSearchTimeoutMs = Math.max(2000, Math.min(30000, Number(process.env.AICAD_WEB_SEARCH_TIMEOUT_MS || 5000)));
const codexPlannerTimeoutMs = boundedInt(process.env.AICAD_CODEX_TIMEOUT_MS, 300000, 60000, 600000);
const codexImageTimeoutMs = boundedInt(process.env.AICAD_CODEX_IMAGE_TIMEOUT_MS, 360000, 120000, 900000);
const codexEditTimeoutMs = boundedInt(process.env.AICAD_CODEX_EDIT_TIMEOUT_MS, 90000, 30000, 180000);
const codexEditRetryTimeoutMs = boundedInt(process.env.AICAD_CODEX_EDIT_RETRY_TIMEOUT_MS, 45000, 20000, 120000);
const codexVisualReviewTimeoutMs = boundedInt(process.env.AICAD_CODEX_VISUAL_REVIEW_TIMEOUT_MS, 360000, 120000, 900000);
const webSearchCurlFallback = shouldUseCurlFallback();
const requestToken = randomUUID();

if (isPublicHost(host) && !allowRemote) {
  throw new Error(`Refusing to listen on ${host}. Set AICAD_ALLOW_REMOTE=1 only on a trusted network.`);
}

await mkdir(workspaceDir, { recursive: true });
await mkdir(chatUploadsDir, { recursive: true });
await mkdir(renderDir, { recursive: true });
await mkdir(assemblyDir, { recursive: true });
await mkdir(standardPartsCacheDir, { recursive: true });
await mkdir(conversationArchiveDir, { recursive: true });
await mkdir(cadqueryScriptLibraryDir, { recursive: true });
await mkdir(ratingArchiveDir, { recursive: true });
await mkdir(trainingArchiveDir, { recursive: true });
await mkdir(fbsArchiveDir, { recursive: true });
await mkdir(excellentCadqueryLibraryDir, { recursive: true });

const latentTraining = new CadLatentTrainingManager({
  rootDir: __dirname,
  runtimeDir: process.env.AICAD_LATENT_RUNTIME_DIR || path.join(workspaceDir, "latent-learning"),
  seedStructureDataset: path.join(__dirname, "cad-latent", "training_samples.jsonl"),
  seedBrepDataset: path.join(__dirname, "cad-latent", "brep_training_samples.jsonl"),
  python: cadqueryPython,
  epochs: boundedInt(process.env.AICAD_LATENT_VAE_EPOCHS, 120, 20, 2000),
  onEvent: (event, payload) => publish(event, payload)
});
await latentTraining.init();

const clients = new Set();
const conversations = new Map();
const assemblyJobs = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".md": "text/markdown; charset=utf-8",
  ".stl": "model/stl",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".gz": "application/gzip",
  ".zip": "application/zip",
  ".step": "model/step",
  ".stp": "model/step",
  ".FCStd": "application/octet-stream"
};

const server = createServer(async (req, res) => {
  try {
    applySecurityHeaders(res);
    if (!isAllowedHostHeader(req.headers.host, { host, port })) {
      return json(res, 403, { error: "Host is not allowed" });
    }
    if (!allowRemote && !isLocalRequest(req)) {
      return json(res, 403, { error: "Remote access is disabled" });
    }
    if (!isAllowedMethod(req.method)) {
      return json(res, 405, { error: "Method not allowed" });
    }

    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/events") {
      return handleEvents(req, res);
    }

    if (url.pathname.startsWith("/api/")) {
      const guard = validateApiRequest(req);
      if (!guard.ok) return json(res, guard.status, { error: guard.error });
      return await handleApi(req, res, url);
    }

    if (url.pathname.startsWith("/renders/")) {
      return await serveFile(res, safeRoutePath(renderDir, url.pathname, "/renders/"), renderDir);
    }

    if (url.pathname.startsWith("/assemblies/")) {
      return await serveFile(res, safeRoutePath(assemblyDir, url.pathname, "/assemblies/"), assemblyDir);
    }

    if (url.pathname.startsWith("/vendor/three/addons/")) {
      return await serveFile(res, safeRoutePath(threeAddonsDir, url.pathname, "/vendor/three/addons/"), threeAddonsDir);
    }

    if (url.pathname.startsWith("/vendor/three/")) {
      return await serveFile(res, safeRoutePath(threeBuildDir, url.pathname, "/vendor/three/"), threeBuildDir);
    }

    const filePath = url.pathname === "/"
      ? path.join(publicDir, "index.html")
      : safeRoutePath(publicDir, url.pathname, "/");
    return await serveFile(res, filePath, publicDir);
  } catch (error) {
    return json(res, Number.isInteger(error?.status) ? error.status : 500, {
      error: error.message || String(error),
      ...(error?.code ? { code: error.code } : {})
    });
  }
});

server.listen(port, host, () => {
  console.log(`AI CAD server: http://${host}:${port}`);
  console.log(`CadQuery Python: ${cadqueryPython}`);
  console.log(`Codex: ${codexBin} · ${codexModel} · reasoning=${codexReasoningEffort}`);
  console.log(`LLM provider: ${llmPolicy.provider}${llmPolicy.provider === "deepseek" ? ` · ${llmPolicy.deepseek.model} · vision=${llmPolicy.deepseek.supportsImages ? "on" : "off"}` : ""}${llmPolicy.strict ? " · strict" : ""}`);
  for (const warning of llmPolicy.warnings) console.warn(`AI-CAD LLM: ${warning}`);
  if (llmPolicy.provider === "deepseek" && llmPolicy.deepseek.jsonMode) console.log("DeepSeek JSON mode: on");
  console.log(`FreeCADCmd: ${freecadCmd}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    codexHarness.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

async function handleApi(req, res, url) {
  // The parametric sub-routes (/api/assembly/:id/feature-tree and friends) are
  // matched first: they are more specific than the /api/assembly/ prefix in the
  // table below, which would otherwise swallow them.
  const parametricRoute = parseParametricAssemblyRoute(req.method, url.pathname);
  if (parametricRoute) {
    const job = assemblyJobs.get(parametricRoute.assemblyId)
      || await restoreAssemblyJob(assemblyDir, parametricRoute.assemblyId).catch(() => null);
    if (!job) return json(res, 404, { error: "Assembly job not found" });
    assemblyJobs.set(job.id, job);
    if (parametricRoute.action === "feature-tree") return json(res, 200, featureTreePayload(job));
    if (parametricRoute.action === "validation") return json(res, 200, validationPayload(job));
    if (parametricRoute.action === "revisions") return json(res, 200, { assemblyId: job.id, currentRevision: job.currentRevision || null, revisions: await listRevisions(assemblyDir, job.id) });
    if (parametricRoute.action === "edit") {
      const body = await readJson(req);
      const patch = body.editPatch || body.patch || body;
      const result = await editAssemblyRevision({
        revisionRoot: assemblyDir,
        job,
        patch,
        executeBuild: executeParametricRevisionBuild,
        finalizeBuild: (context) => finalizeParametricRevisionBuild(job, context)
      });
      if (result.status === "current" && result.buildSummary) {
        applyBuildSummaryToJob(job, result.buildSummary);
        void queueLatentLearning(job, "parametric-edit");
      }
      publish(result.status === "current" ? "assembly:done" : "assembly:error", publicAssembly(job));
      return json(res, result.status === "current" ? 200 : result.status === "stale" ? 409 : 422, { assembly: publicAssembly(job), revision: result });
    }
    if (parametricRoute.action === "revert") {
      const body = await readJson(req);
      const revisionId = String(body.revisionId || "").trim();
      if (!revisionId) return json(res, 400, { error: "revisionId is required" });
      const reverted = await withAssemblyRevisionLock(assemblyDir, job.id, async () => {
        const state = await loadRevisionState(assemblyDir, job.id, revisionId);
        const result = await revertRevision(assemblyDir, job.id, revisionId);
        restoreJobFromRevisionState(job, revisionId, state);
        return result;
      });
      publish("assembly:done", publicAssembly(job));
      return json(res, 200, { assembly: publicAssembly(job), revision: reverted });
    }
  }

  const match = matchRoute(apiRoutes, req.method, url.pathname);
  if (match) return match.handler(req, res, url);

  return json(res, 404, { error: "API route not found" });
}

// GET /api/status
async function handleStatus(req, res, url) {
  return json(res, 200, {
    ok: true,
    cadqueryPython: publicCommandName(cadqueryPython),
    codexBin: publicCommandName(codexBin),
    codexModel,
    codexReasoningEffort,
    codexHarness: {
      enabled: codexHarnessEnabled,
      strict: codexHarnessStrict,
      transport: "app-server/stdio",
      running: codexHarness.running
    },
    llm: describeLlmPolicy(llmPolicy, { codexModel }),
    freecadCmd: publicCommandName(freecadCmd),
    allowRemote,
    maxAssemblyParts: MAX_ASSEMBLY_PARTS,
    requestToken,
    latentLearning: latentTraining.status(),
    webSearch: {
      provider: webSearchProvider,
      maxResults: webSearchMaxResults,
      timeoutMs: webSearchTimeoutMs,
      tavilyConfigured: Boolean(process.env.TAVILY_API_KEY),
      proxyConfigured: hasProxyEnv(),
      curlFallback: webSearchCurlFallback
    }
  });
}

// GET /api/latent/training
async function handleLatentTrainingStatus(req, res, url) {
  return json(res, 200, { ok: true, ...latentTraining.status() });
}

// POST /api/latent/retrain
async function handleLatentRetrain(req, res, url) {
  return json(res, 202, await latentTraining.retrainNow());
}

// POST /api/preview
async function handlePreview(req, res, url) {
  const body = await readJson(req);
  const part = parseFeaturePart(body.part || body.code);
  const preview = await buildCadQueryPreview(part);
  return json(res, 200, preview);
}

// POST /api/search
async function handleSearch(req, res, url) {
  const body = await readJson(req);
  const query = String(body.query || "").trim();
  if (!query) return json(res, 400, { error: "Search query is required" });
  const search = await searchCadReferences(query, {
    maxResults: boundedInt(body.maxResults, webSearchMaxResults, 1, 8)
  });
  return json(res, 200, publicSearch(search));
}

// POST /api/explorer-link
async function handleExplorerLink(req, res, url) {
  const body = await readJson(req);
  const result = await buildExplorerLink(body);
  return json(res, 200, result);
}

// POST /api/visual-review
async function handleVisualReview(req, res, url) {
  const body = await readJson(req);
  const result = await runVisualReview(body);
  return json(res, 200, result);
}

// POST /api/assembly/repair
async function handleAssemblyRepair(req, res, url) {
  const body = await readJson(req);
  const assemblyId = sanitizeText(body.assemblyId || "", 120);
  if (!assemblyId) return json(res, 400, { error: "assemblyId is required" });
  const failedJob = assemblyJobs.get(assemblyId) || await restoreAssemblyJob(assemblyDir, assemblyId).catch(() => null);
  if (!failedJob) return json(res, 404, { error: "Assembly job not found" });
  if (failedJob.status !== "validation_failed") {
    return json(res, 409, { error: `Assembly does not need geometry repair (current status: ${failedJob.status || "unknown"})`, assembly: publicAssembly(failedJob) });
  }
  const repaired = await buildAssembly(failedJob.plan, { repairAudit: failedJob.repairAudit || [] });
  if (body.conversationId) {
    const conversation = conversations.get(String(body.conversationId));
    if (conversation) {
      conversation.assemblyId = repaired.id;
      synchronizeConversationWithAssembly(conversation, repaired);
      conversations.set(conversation.id, conversation);
      await persistConversation(conversation, repaired.plan);
    }
  }
  return json(res, 200, { ok: repaired.status === "done", assembly: publicAssembly(repaired), sourceAssemblyId: assemblyId });
}

// POST /api/visual-review/repair
async function handleVisualReviewRepair(req, res, url) {
  const body = await readJson(req);
  const assemblyId = sanitizeText(body.assemblyId || "", 120);
  const conversationId = sanitizeText(body.conversationId || "", 160);
  if (!assemblyId || !conversationId) return json(res, 400, { error: "assemblyId and conversationId are required" });
  const job = assemblyJobs.get(assemblyId) || await restoreAssemblyJob(assemblyDir, assemblyId).catch(() => null);
  if (!job) return json(res, 404, { error: "Assembly job not found" });
  const review = job.visualReview || body.review;
  if (!review || typeof review !== "object") return json(res, 409, { error: "请先运行视觉审查" });
  if (review.revisionId && job.currentRevision && String(review.revisionId) !== String(job.currentRevision)) {
    return json(res, 409, { error: "视觉审查报告已过期，请先对当前修订重新审查", staleReview: true });
  }
  const conversation = conversations.get(conversationId) || { id: conversationId, messages: [], plan: null, searchReferences: [] };
  conversation.assemblyId = assemblyId;
  conversation.plan = job.plan;
  conversation.currentRevision = job.currentRevision;
  conversation.validationReport = job.validationReport;
  conversations.set(conversationId, conversation);
  const userRequest = findLatestUserRequest(conversationId) || sanitizeText(body.userRequest || "", 2000);
  const repairMessage = buildVisualReviewReportRepairMessage({ review, userRequest, currentRevision: job.currentRevision });
  const result = await handleConversationTurn(conversationId, repairMessage, { enabled: false }, [], {
    activePartId: body.activePartId,
    activeFeatureId: body.activeFeatureId,
    fbs: conversation.fbs
  }, { internalRepair: true, originalUserRequest: userRequest });
  return json(res, 200, { ...result, sourceAssemblyId: assemblyId, reportRepair: true });
}

// POST /api/visual-review/improve
async function handleVisualReviewImprove(req, res, url) {
  const body = await readJson(req);
  const result = await improveFromVisualReview(body);
  const status = result.ok ? 200 : result.code === "REVIEW_STALE" || result.code === "AMBIGUOUS_IMPROVEMENT" ? 409 : 422;
  return json(res, status, result);
}

// POST /api/generate
async function handleGenerate(req, res, url) {
  const body = await readJson(req);
  const prompt = String(body.prompt || "").trim();
  const currentCode = typeof body.currentCode === "string" ? body.currentCode : "";
  if (!prompt) return json(res, 400, { error: "Prompt is required" });

  const generated = await generateWithCodex(prompt, currentCode);
  return json(res, 200, generated);
}

// POST /api/chat
async function handleChat(req, res, url) {
  const body = await readJson(req);
  const message = String(body.message || "").trim();
  const conversationId = String(body.conversationId || randomUUID());
  const webSearch = normalizeWebSearchOptions(body.webSearch, { defaultMaxResults: webSearchMaxResults });
  const imageAttachments = await persistChatImages(conversationId, body.images);
  if (!message && !imageAttachments.length) return json(res, 400, { error: "Message is required" });

  const result = await handleConversationTurn(
    conversationId,
    message || "请根据附带的参考图片建模这个物体。",
    webSearch,
    imageAttachments,
    { activePartId: body.activePartId, activeFeatureId: body.activeFeatureId, fbs: body.fbs }
  );
  return json(res, 200, result);
}

// POST /api/chat/stop
async function handleChatStop(req, res, url) {
  const body = await readJson(req);
  const conversationId = sanitizeText(body.conversationId || "", 120);
  if (!conversationId) return json(res, 400, { error: "conversationId is required" });
  return json(res, 200, await codexHarness.stop(`planner:${conversationId}`));
}

// POST /api/rate
async function handleRate(req, res, url) {
  const body = await readJson(req);
  const rating = await persistManualRating(body);
  return json(res, 200, rating);
}

// POST /api/training/session
async function handleTrainingSessionSave(req, res, url) {
  const body = await readJson(req);
  const result = await persistTrainingSession(body);
  return json(res, 200, result);
}

// GET /api/training/session
async function handleTrainingSessionLoad(req, res, url) {
  const conversationId = sanitizeText(url.searchParams.get("conversationId") || "", 160);
  const sessions = [];
  for (const entry of await readdir(trainingArchiveDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const session = JSON.parse(await readFile(path.join(trainingArchiveDir, entry.name), "utf8"));
      if (session?.format !== "ai-cad-training-session-v1") continue;
      if (conversationId && session.conversationId !== conversationId) continue;
      if (["running", "timeout"].includes(session.status)) sessions.push(session);
    } catch { /* ignore incomplete checkpoint */ }
  }
  sessions.sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
  return json(res, 200, { session: sessions[0] || null });
}

// GET /api/assembly/latest
async function handleLatestAssembly(req, res, url) {
  const job = await restoreLatestAssemblyJob(assemblyDir);
  if (!job) return json(res, 404, { error: "No completed assembly found" });
  assemblyJobs.set(job.id, job);
  return json(res, 200, publicAssembly(job));
}

// GET /api/assembly/:id
async function handleAssemblyById(req, res, url) {
  const id = url.pathname.split("/").pop();
  const job = assemblyJobs.get(id) || await restoreAssemblyJob(assemblyDir, id).catch(() => null);
  if (!job) return json(res, 404, { error: "Assembly job not found" });
  assemblyJobs.set(job.id, job);
  return json(res, 200, publicAssembly(job));
}

// Declaration order is match order: /api/assembly/latest must stay ahead
// of the /api/assembly/ prefix that would otherwise swallow it.
const apiRoutes = createRouteTable([
  { method: "GET", path: "/api/status", handler: handleStatus },
  { method: "GET", path: "/api/latent/training", handler: handleLatentTrainingStatus },
  { method: "POST", path: "/api/latent/retrain", handler: handleLatentRetrain },
  { method: "POST", path: "/api/preview", handler: handlePreview },
  { method: "POST", path: "/api/search", handler: handleSearch },
  { method: "POST", path: "/api/explorer-link", handler: handleExplorerLink },
  { method: "POST", path: "/api/visual-review", handler: handleVisualReview },
  { method: "POST", path: "/api/assembly/repair", handler: handleAssemblyRepair },
  { method: "POST", path: "/api/visual-review/repair", handler: handleVisualReviewRepair },
  { method: "POST", path: "/api/visual-review/improve", handler: handleVisualReviewImprove },
  { method: "POST", path: "/api/generate", handler: handleGenerate },
  { method: "POST", path: "/api/chat", handler: handleChat },
  { method: "POST", path: "/api/chat/stop", handler: handleChatStop },
  { method: "POST", path: "/api/rate", handler: handleRate },
  { method: "POST", path: "/api/training/session", handler: handleTrainingSessionSave },
  { method: "GET", path: "/api/training/session", handler: handleTrainingSessionLoad },
  { method: "GET", path: "/api/assembly/latest", handler: handleLatestAssembly },
  { method: "GET", prefix: "/api/assembly/", handler: handleAssemblyById }
]);

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const client = { res };
  clients.add(client);
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  req.on("close", () => clients.delete(client));
}

function publish(event, payload) {
  const packet = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.res.write(packet);
}

async function handleConversationTurn(conversationId, message, webSearch = { enabled: false }, imageAttachments = [], uiContext = {}, options = {}) {
  const conversation = conversations.get(conversationId) || {
    id: conversationId,
    messages: [],
    plan: null,
    searchReferences: []
  };
  if (!options.internalRepair) {
    conversation.messages.push({
      role: "user",
      content: message,
      images: imageAttachments.map((item) => item.name),
      at: new Date().toISOString()
    });
  }
  if (uiContext.activePartId) conversation.activePartId = sanitizeText(uiContext.activePartId, 120);
  if (uiContext.activeFeatureId) conversation.activeFeatureId = sanitizeText(uiContext.activeFeatureId, 180);
  if (uiContext.fbs && typeof uiContext.fbs === "object") conversation.fbs = sanitizeFbsContext(uiContext.fbs);

  const search = webSearch.enabled
    ? await searchCadReferences(webSearch.query || buildCadSearchQuery(message), { maxResults: webSearch.maxResults })
    : null;
  const cadReferenceContext = await buildServerCadReferenceContext(message, conversation);
  if (search) {
    conversation.searchReferences = [publicSearch(search), ...(conversation.searchReferences || [])].slice(0, 8);
    publish("search:done", { conversationId, search: publicSearch(search) });
  }

  const currentJob = conversation.assemblyId ? assemblyJobs.get(conversation.assemblyId) : null;
  if (currentJob) {
    synchronizeConversationWithAssembly(conversation, currentJob);
  }
  const resetPlan = shouldResetPlanForMessage(message);
  const planningConversation = resetPlan
    ? { ...conversation, plan: null, currentRevision: null, assemblyId: null, activePartId: null, activeFeatureId: null, fbs: null }
    : conversation;
  const planned = await generateAssemblyPlan(planningConversation, message, search, cadReferenceContext, imageAttachments);
  if (planned.mode === "ambiguous") {
    conversation.messages.push({ role: "assistant", content: planned.reply || "修改目标不唯一，请确认具体零件或特征。", at: new Date().toISOString() });
    conversations.set(conversationId, conversation);
    await persistConversation(conversation, conversation.plan);
    return {
      conversationId,
      reply: planned.reply,
      ambiguous: true,
      candidates: planned.candidates || [],
      plan: conversation.plan,
      assembly: currentJob ? publicAssembly(currentJob) : null,
      search: search ? publicSearch(search) : { enabled: false, results: [] }
    };
  }
  if (isEditPatchResponse(planned)) {
    const revision = await runConversationEditTurn({
      conversation,
      currentJob,
      planned,
      cadReferenceContext,
      deps: conversationTurnDeps()
    });
    conversation.plan = currentJob.plan;
    conversation.currentRevision = currentJob.currentRevision;
    conversation.validationReport = currentJob.validationReport;
    conversation.messages.push({ role: "assistant", content: planned.reply || "已完成局部参数修改。", at: new Date().toISOString() });
    conversations.set(conversationId, conversation);
    await persistConversation(conversation, currentJob.plan);
    publish(revision.status === "current" ? "assembly:done" : "assembly:error", publicAssembly(currentJob));
    return {
      conversationId,
      reply: planned.reply,
      editPatch: planned.editPatch,
      revision,
      plan: currentJob.plan,
      assembly: publicAssembly(currentJob),
      search: search ? publicSearch(search) : { enabled: false, results: [] }
    };
  }
  let plan = planned;
  const fbsAnalysis = await normalizeAndArchiveConceptPlan(plan, options.originalUserRequest || message, planningConversation.fbs);
  conversation.fbs = sanitizeFbsContext(fbsAnalysis);
  plan.concept = fbsAnalysis;
  conversation.plan = plan;
  conversation.messages.push({
    role: "assistant",
    content: plan.reply || "已生成装配计划。",
    at: new Date().toISOString()
  });
  conversations.set(conversationId, conversation);
  await persistConversation(conversation, plan);
  await persistCadqueryScripts(conversation, plan);

  const repairPlanner = createRepairPlanner({
    conversation,
    cadReferenceContext,
    generatePlan: plannerBridge(),
    publish,
    persistPlan: persistConversation,
    maximumRepairs: MAX_CONVERSATION_REPAIRS
  });
  const assembly = await runAssemblyValidationRepairLoop({
    initialPlan: plan,
    maximumRepairs: MAX_CONVERSATION_REPAIRS,
    returnPreviewOnFailure: true,
    build: (candidatePlan) => buildAssembly(candidatePlan),
    repair: repairPlanner.repair,
    repairFallback: repairPlanner.repairFallback,
    onRepair: async (context) => {
      // Keep the local `plan` in step so the reply we return is the one that
      // was actually built.
      plan = context.plan;
      await repairPlanner.onRepair(context);
    }
  });
  publish("assembly:repair", { status: assembly.status === "done" ? "complete" : "failed", assemblyId: assembly.id, summary: assembly.validationReport?.summary || null, repairAudit: assembly.repairAudit || [], message: assembly.status === "done" ? "自动修复与重新验证完成" : "自动修复轮次结束，仍有阻断错误" });
  conversation.assemblyId = assembly.id;
  synchronizeConversationWithAssembly(conversation, assembly);
  conversations.set(conversationId, conversation);
  return {
    conversationId,
    reply: plan.reply,
    plan,
    assembly: publicAssembly(assembly),
    fbsAnalysis,
    search: search ? publicSearch(search) : { enabled: false, results: [] }
  };
}


const chatImageMimeExtensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

async function persistChatImages(conversationId, images) {
  if (!Array.isArray(images) || !images.length) return [];
  if (images.length > maxChatImages) {
    throw new Error(`最多附带 ${maxChatImages} 张参考图片`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const attachments = [];
  for (const [index, image] of images.entries()) {
    const dataUrl = String(image?.dataUrl || "");
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("参考图片必须是 png/jpeg/webp 格式的 base64 data URL");
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length) throw new Error("参考图片内容为空");
    if (buffer.length > maxChatImageBytes) {
      throw new Error(`单张参考图片不能超过 ${Math.round(maxChatImageBytes / 1024)} KB`);
    }
    const fileName = `${stamp}-${safeSlug(conversationId).slice(0, 24)}-${index + 1}.${chatImageMimeExtensions[match[1]]}`;
    const filePath = path.join(chatUploadsDir, fileName);
    await writeFile(filePath, buffer);
    attachments.push({
      name: sanitizeChatImageName(image?.name) || fileName,
      path: filePath,
      bytes: buffer.length
    });
  }
  return attachments;
}

function sanitizeChatImageName(name) {
  return String(name || "").replace(/[^\w.一-龥-]+/g, "_").slice(0, 80);
}

async function persistConversation(conversation, plan) {
  const safeId = safeSlug(conversation.id || "conversation");
  const baseName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeId}`;
  const payload = {
    id: conversation.id,
    savedAt: new Date().toISOString(),
    plan,
    messages: conversation.messages,
    searchReferences: conversation.searchReferences || []
  };
  const jsonPath = path.join(conversationArchiveDir, `${baseName}.json`);
  const mdPath = path.join(conversationArchiveDir, `${baseName}.md`);
  await writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  await writeFile(mdPath, renderConversationMarkdown(payload), "utf8");
}

function renderConversationMarkdown(entry) {
  const lines = [
    `# AI-CAD 对话记录`,
    ``,
    `- 会话 ID: \`${entry.id}\``,
    `- 保存时间: ${entry.savedAt}`,
    `- 计划名: ${entry.plan?.name || "未命名"}`,
    ``,
    `## 消息`,
    ``
  ];
  for (const message of entry.messages || []) {
    lines.push(`### ${message.role || "unknown"} | ${message.at || ""}`);
    lines.push("");
    lines.push(String(message.content || ""));
    lines.push("");
  }
  if (entry.plan) {
    lines.push(`## 生成结果`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(entry.plan, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}


async function persistCadqueryScripts(conversation, plan) {
  const safeConversationId = safeSlug(conversation.id || "conversation");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sessionDir = path.join(cadqueryScriptLibraryDir, `${stamp}-${safeConversationId}`);
  await mkdir(sessionDir, { recursive: true });

  const index = [];
  for (const part of plan?.parts || []) {
    const script = partToFeatureJson(part);
    const fileName = `${safeSlug(part.id || part.name || "part")}.json`;
    const filePath = path.join(sessionDir, fileName);
    await writeFile(filePath, script, "utf8");
    index.push({
      id: part.id || null,
      name: part.name || null,
      role: part.role || null,
      file: fileName
    });
  }

  const manifest = {
    conversationId: conversation.id,
    savedAt: new Date().toISOString(),
    files: index,
    plan: {
      name: plan?.name || null,
      activePartId: plan?.activePartId || null
    }
  };
  await writeFile(path.join(sessionDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function partToFeatureJson(part) {
  return JSON.stringify({
    id: part.id,
    name: part.name,
    role: part.role,
    primitives: part.primitives || [],
    features: part.features || [],
    pose: part.pose || { translate: [0, 0, 0], rotate: [0, 0, 0] }
  }, null, 2);
}

async function persistManualRating(body) {
  const score = normalizeManualScore(body.score);
  const conversationId = sanitizeText(body.conversationId || "", 120) || "unknown-conversation";
  const assemblyId = sanitizeText(body.assemblyId || "", 160) || "unknown-assembly";
  const plan = body.plan && typeof body.plan === "object" ? body.plan : null;
  const assembly = body.assembly && typeof body.assembly === "object" ? body.assembly : null;
  if (!plan || !Array.isArray(plan.parts) || !plan.parts.length) {
    throw new Error("Rating requires a generated plan with parts");
  }

  const now = new Date().toISOString();
  const ratingId = `${now.replace(/[:.]/g, "-")}-${score}-${safeSlug(assemblyId)}`;
  const payload = {
    format: "ai-cad-manual-rating-v1",
    id: ratingId,
    score,
    label: manualRatingLabel(score),
    standard: manualRatingStandard(score),
    comment: sanitizeText(body.comment || "", 1200),
    savedAt: now,
    conversationId,
    assemblyId,
    retainedForLearning: score === 100,
    plan,
    assembly
  };

  const ratingJsonPath = path.join(ratingArchiveDir, `${ratingId}.json`);
  const ratingMdPath = path.join(ratingArchiveDir, `${ratingId}.md`);
  await writeFile(ratingJsonPath, JSON.stringify(payload, null, 2), "utf8");
  await writeFile(ratingMdPath, renderRatingMarkdown(payload), "utf8");

  const response = {
    ok: true,
    id: ratingId,
    score,
    label: payload.label,
    retainedForLearning: false,
    ratingFile: ratingJsonPath
  };

  if (score === 100) {
    const excellent = await persistExcellentCadqueryExample(payload);
    response.retainedForLearning = true;
    response.excellentDir = excellent.dir;
    response.pythonFile = excellent.pythonPath;
    response.manifestFile = excellent.manifestPath;
  }

  return response;
}

async function persistTrainingSession(body = {}) {
  const id = sanitizeText(body.id || `${Date.now()}-${randomUUID().slice(0, 8)}`, 160);
  const assemblyId = sanitizeText(body.assemblyId || "", 160);
  if (!id || !assemblyId) throw new Error("Training session requires id and assemblyId");
  const allowedStatuses = new Set(["running", "pass", "needs_user", "max_rounds", "stopped", "timeout", "failed"]);
  const status = allowedStatuses.has(body.status) ? body.status : "running";
  const job = assemblyJobs.get(assemblyId) || await restoreAssemblyJob(assemblyDir, assemblyId).catch(() => null);
  if (!job) throw new Error("Training session assembly was not found");
  assemblyJobs.set(job.id, job);
  const rounds = (Array.isArray(body.rounds) ? body.rounds : []).slice(0, 10).map(normalizeTrainingRound);
  const savedAt = new Date().toISOString();
  const payload = {
    format: "ai-cad-training-session-v1",
    id,
    status,
    request: sanitizeText(body.request || "", 2400),
    conversationId: sanitizeText(body.conversationId || "", 160),
    assemblyId,
    initialRevision: sanitizeText(body.initialRevision || "", 120) || null,
    finalRevision: sanitizeText(body.finalRevision || job.currentRevision || "", 120) || null,
    maxImprovements: boundedInt(body.maxImprovements, 6, 0, 8),
    phase: ["queued", "reviewing", "reviewed", "improving", "persisted", "completed"].includes(body.phase) ? body.phase : "queued",
    currentRound: boundedInt(body.currentRound, rounds.length + 1, 1, 10),
    startedAt: body.startedAt || savedAt,
    completedAt: body.completedAt || null,
    savedAt,
    error: sanitizeText(body.error || "", 1200) || null,
    rounds,
    finalReview: normalizeTrainingReview(body.finalReview),
    retainedForLatentLearning: status === "pass",
    plan: structuredClone(job.plan),
    assembly: publicAssembly(job)
  };
  const jsonPath = path.join(trainingArchiveDir, `${safeSlug(id)}.json`);
  const mdPath = path.join(trainingArchiveDir, `${safeSlug(id)}.md`);
  await writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  await writeFile(mdPath, renderTrainingSessionMarkdown(payload), "utf8");
  return {
    ok: true,
    id,
    status,
    rounds: rounds.length,
    retainedForLatentLearning: payload.retainedForLatentLearning,
    trainingFile: jsonPath
  };
}

function normalizeTrainingRound(round, index) {
  const improvement = round?.improvement && typeof round.improvement === "object" ? round.improvement : null;
  return {
    index: boundedInt(round?.index, index + 1, 1, 10),
    revisionId: sanitizeText(round?.revisionId || "", 120) || null,
    reviewedAt: round?.reviewedAt || null,
    review: normalizeTrainingReview(round?.review),
    improvement: improvement ? {
      reply: sanitizeText(improvement.reply || "", 1200),
      editPatch: improvement.editPatch && typeof improvement.editPatch === "object" ? structuredClone(improvement.editPatch) : null,
      appliedRevision: sanitizeText(improvement.appliedRevision || improvement.revision?.id || "", 120) || null,
      revisionStatus: sanitizeText(improvement.revision?.status || "", 40) || null,
      attempts: (Array.isArray(improvement.attempts) ? improvement.attempts : []).slice(0, 4).map((attempt) => ({
        index: boundedInt(attempt?.index, 1, 1, 4),
        revisionId: sanitizeText(attempt?.revisionId || "", 120) || null,
        status: sanitizeText(attempt?.status || "", 40) || null,
        reply: sanitizeText(attempt?.reply || "", 1200),
        validationErrorCount: boundedInt(attempt?.validationReport?.blockingErrorCount, 0, 0, 1000)
      }))
    } : null
  };
}

function normalizeTrainingReview(review) {
  if (!review || typeof review !== "object") return null;
  return {
    assemblyId: sanitizeText(review.assemblyId || "", 160) || null,
    revisionId: sanitizeText(review.revisionId || "", 120) || null,
    status: ["pass", "warning", "fail"].includes(review.status) ? review.status : "warning",
    summary: sanitizeText(review.summary || "", 1600),
    recommendedNextAction: ["accept", "ask_user", "revise"].includes(review.recommendedNextAction) ? review.recommendedNextAction : "ask_user",
    findings: (Array.isArray(review.findings) ? review.findings : []).slice(0, 20).map((finding) => ({
      findingId: sanitizeText(finding?.findingId || "", 40) || null,
      severity: sanitizeText(finding?.severity || "warning", 20),
      category: sanitizeText(finding?.category || "visual", 60),
      message: sanitizeText(finding?.message || "", 1200),
      partId: sanitizeText(finding?.partId || "", 160) || null,
      featureId: sanitizeText(finding?.featureId || "", 200) || null,
      confidence: ["high", "medium", "low"].includes(finding?.confidence) ? finding.confidence : "low",
      actionability: ["auto", "needs_measurement", "needs_user", "informational"].includes(finding?.actionability) ? finding.actionability : "needs_user",
      proposedChange: finding?.proposedChange && typeof finding.proposedChange === "object" ? structuredClone(finding.proposedChange) : null,
      verification: finding?.verification && typeof finding.verification === "object" ? structuredClone(finding.verification) : null,
      evidence: (Array.isArray(finding?.evidence) ? finding.evidence : []).slice(0, 8).map((item) => sanitizeText(item, 160))
    })).filter((finding) => finding.message),
    reviewedAt: review.reviewedAt || null
  };
}

function renderTrainingSessionMarkdown(session) {
  const lines = [
    "# AI-CAD 训练模式记录", "",
    `- 训练 ID: \`${session.id}\``,
    `- 状态: ${session.status}`,
    `- 装配 ID: \`${session.assemblyId}\``,
    `- 初始修订: ${session.initialRevision || "unknown"}`,
    `- 最终修订: ${session.finalRevision || "unknown"}`,
    `- 进入 latent 学习: ${session.retainedForLatentLearning ? "yes" : "no"}`,
    "", "## 用户要求", "", session.request || "未提供", "", "## 训练轮次", ""
  ];
  for (const round of session.rounds) {
    lines.push(`### 第 ${round.index} 轮`, "", `- 修订: ${round.revisionId || "unknown"}`, `- 审查: ${round.review?.status || "missing"}`, `- 摘要: ${round.review?.summary || "无"}`);
    if (round.improvement) lines.push(`- 改进修订: ${round.improvement.appliedRevision || "unknown"}`, `- 改进说明: ${round.improvement.reply || "无"}`);
    lines.push("");
  }
  return lines.join("\n");
}

function normalizeManualScore(value) {
  const score = Number(value);
  if ([0, 50, 100].includes(score)) return score;
  throw new Error("Manual score must be 0, 50, or 100");
}

function manualRatingLabel(score) {
  if (score === 100) return "优秀，保留学习";
  if (score === 50) return "可用但需改进";
  return "失败，不进入学习集";
}

function manualRatingStandard(score) {
  if (score === 100) {
    return [
      "视觉和功能意图吻合用户需求",
      "主要零件、孔、槽、倒角、装配关系清晰可复用",
      "CadQuery 构建成功并产出 STEP/STL/预览",
      "尺寸、位姿和层级没有明显硬伤",
      "适合作为后续生成的优秀建模模式"
    ];
  }
  if (score === 50) {
    return [
      "大体方向正确，部分结构或比例可用",
      "存在缺件、孔位、位姿、装配关系或细节表达不足",
      "可以归档供人工复盘，但不进入优秀学习集"
    ];
  }
  return [
    "不符合需求、结构错误或无法代表目标物",
    "构建失败、关键几何缺失或装配关系严重错误",
    "只保留失败证据，不作为后续学习样本"
  ];
}

function renderRatingMarkdown(entry) {
  const lines = [
    `# AI-CAD 人工评分`,
    ``,
    `- 评分: ${entry.score} (${entry.label})`,
    `- 会话 ID: \`${entry.conversationId}\``,
    `- 装配 ID: \`${entry.assemblyId}\``,
    `- 保存时间: ${entry.savedAt}`,
    `- 进入优秀学习集: ${entry.retainedForLearning ? "是" : "否"}`,
    ``,
    `## 定评分标准`,
    ``
  ];
  for (const item of entry.standard || []) lines.push(`- ${item}`);
  if (entry.comment) {
    lines.push(``, `## 人工备注`, ``, entry.comment);
  }
  lines.push(``, `## CadQuery 特征计划`, ``, "```json", JSON.stringify(entry.plan, null, 2), "```", "");
  return lines.join("\n");
}

async function persistExcellentCadqueryExample(entry) {
  const exampleDir = path.join(excellentCadqueryLibraryDir, `${entry.id}-${safeSlug(entry.plan?.name || "assembly")}`);
  await mkdir(exampleDir, { recursive: true });
  const manifestPath = path.join(exampleDir, "manifest.json");
  const pythonPath = path.join(exampleDir, "excellent_cadquery.py");
  const readmePath = path.join(exampleDir, "README.md");
  const planPath = path.join(exampleDir, "feature-plan.json");

  const python = renderCadqueryPythonExample(entry.plan);
  await writeFile(planPath, JSON.stringify(entry.plan, null, 2), "utf8");
  await writeFile(pythonPath, python, "utf8");
  await writeFile(manifestPath, JSON.stringify({
    format: "ai-cad-excellent-cadquery-v1",
    sourceRatingId: entry.id,
    savedAt: entry.savedAt,
    score: entry.score,
    conversationId: entry.conversationId,
    assemblyId: entry.assemblyId,
    name: entry.plan?.name || null,
    comment: entry.comment || "",
    files: {
      python: path.basename(pythonPath),
      plan: path.basename(planPath)
    }
  }, null, 2), "utf8");
  await writeFile(readmePath, [
    `# ${entry.plan?.name || "优秀 CadQuery 案例"}`,
    "",
    `- 人工评分: ${entry.score}`,
    `- 来源装配: ${entry.assemblyId}`,
    `- 保存时间: ${entry.savedAt}`,
    "",
    "此目录用于保留 100 分优秀样本。`excellent_cadquery.py` 是由 AI-CAD 特征计划导出的可读 CadQuery Python 代码，后续生成会读取它的建模模式作为参考。"
  ].join("\n"), "utf8");

  return { dir: exampleDir, manifestPath, pythonPath };
}

function renderCadqueryPythonExample(plan) {
  const safeAssemblyName = safeSlug(plan?.name || "excellent_assembly").replace(/-/g, "_");
  const safePartNames = new Set((plan?.parts || []).map((part) => safeSlug(part?.id || part?.name || "part").replace(/-/g, "_")));
  let assemblyRootName = safeAssemblyName;
  for (let suffix = 1; safePartNames.has(assemblyRootName); suffix += 1) {
    assemblyRootName = `${safeAssemblyName}_assembly${suffix === 1 ? "" : `_${suffix}`}`;
  }
  const lines = [
    "import cadquery as cq",
    "",
    "",
    "def apply_pose(obj, pose):",
    "    pose = pose or {}",
    "    translate = (pose.get('translate') or [0, 0, 0]) + [0, 0, 0]",
    "    rotate = (pose.get('rotate') or [0, 0, 0]) + [0, 0, 0]",
    "    result = obj",
    "    if rotate[0]:",
    "        result = result.rotate((0, 0, 0), (1, 0, 0), rotate[0])",
    "    if rotate[1]:",
    "        result = result.rotate((0, 0, 0), (0, 1, 0), rotate[1])",
    "    if rotate[2]:",
    "        result = result.rotate((0, 0, 0), (0, 0, 1), rotate[2])",
    "    if translate[:3] != [0, 0, 0]:",
    "        result = result.translate(tuple(translate[:3]))",
    "    return result",
    "",
    "",
    "def make_primitive(spec):",
    "    kind = spec.get('type', 'box')",
    "    center = spec.get('center', True) is not False",
    "    if kind == 'box':",
    "        sx, sy, sz = (spec.get('size') or [10, 10, 10])[:3]",
    "        return cq.Workplane('XY').box(sx, sy, sz, centered=center)",
    "    if kind == 'cylinder':",
    "        radius = spec.get('radius', spec.get('diameter', 10) / 2)",
    "        height = spec.get('height', 10)",
    "        result = cq.Workplane('XY').circle(radius).extrude(height, both=center)",
    "        return result if center else result.translate((0, 0, height / 2))",
    "    if kind == 'sphere':",
    "        return cq.Workplane('XY').sphere(spec.get('radius', 5))",
    "    if kind == 'ellipsoid':",
    "        radii = (spec.get('radii') or [5, 5, 5])[:3]",
    "        matrix = cq.Matrix([[radii[0], 0, 0, 0], [0, radii[1], 0, 0], [0, 0, radii[2], 0], [0, 0, 0, 1]])",
    "        sphere = cq.Workplane('XY').sphere(1)",
    "        return sphere.newObject([sphere.val().transformGeometry(matrix)])",
    "    if kind == 'cone':",
    "        solid = cq.Solid.makeCone(spec.get('radius1', 8), spec.get('radius2', 3), spec.get('height', 10))",
    "        if center:",
    "            solid = solid.translate((0, 0, -spec.get('height', 10) / 2))",
    "        return cq.Workplane('XY').newObject([solid])",
    "    raise ValueError(f'Unsupported primitive: {kind}')",
    "",
    "",
    "def cylinder_tool(feature):",
    "    radius = feature.get('radius', feature.get('diameter', 5) / 2)",
    "    depth = feature.get('depth', 1000)",
    "    center = (feature.get('center') or [0, 0, 0])[:3]",
    "    axis = str(feature.get('axis', 'z')).lower()",
    "    tool = cq.Workplane('XY').circle(radius).extrude(depth, both=True)",
    "    if axis == 'x':",
    "        tool = tool.rotate((0, 0, 0), (0, 1, 0), 90)",
    "    elif axis == 'y':",
    "        tool = tool.rotate((0, 0, 0), (1, 0, 0), 90)",
    "    return tool.translate(tuple(center))",
    "",
    "",
    "def slot_tool(feature):",
    "    length = feature.get('length', 20)",
    "    width = feature.get('width', feature.get('diameter', 5))",
    "    depth = feature.get('depth', 1000)",
    "    center = (feature.get('center') or [0, 0, 0])[:3]",
    "    axis = str(feature.get('axis', 'x')).lower()",
    "    radius = width / 2",
    "    straight = max(length - width, 0.1)",
    "    if axis == 'x':",
    "        box = cq.Workplane('XY').box(straight, width, depth)",
    "        c1 = cq.Workplane('XY').circle(radius).extrude(depth, both=True).translate((-length / 2 + radius, 0, 0))",
    "        c2 = cq.Workplane('XY').circle(radius).extrude(depth, both=True).translate((length / 2 - radius, 0, 0))",
    "    else:",
    "        box = cq.Workplane('XY').box(width, straight, depth)",
    "        c1 = cq.Workplane('XY').circle(radius).extrude(depth, both=True).translate((0, -length / 2 + radius, 0))",
    "        c2 = cq.Workplane('XY').circle(radius).extrude(depth, both=True).translate((0, length / 2 - radius, 0))",
    "    return box.union(c1).union(c2).translate(tuple(center))",
    "",
    "",
    "def apply_features(obj, features):",
    "    result = obj",
    "    for feature in features or []:",
    "        kind = feature.get('type')",
    "        if kind == 'hole':",
    "            result = result.cut(cylinder_tool(feature))",
    "        elif kind == 'slot':",
    "            result = result.cut(slot_tool(feature))",
    "        elif kind == 'cut_box':",
    "            tool = make_primitive({'type': 'box', 'size': feature.get('size', [10, 10, 10]), 'center': True})",
    "            result = result.cut(apply_pose(tool, {'translate': feature.get('center', [0, 0, 0]), 'rotate': feature.get('rotate', [0, 0, 0])}))",
    "        elif kind == 'add':",
    "            primitive = feature.get('primitive') or {'type': 'box', 'size': [10, 10, 10]}",
    "            result = result.union(apply_pose(make_primitive(primitive), primitive.get('pose', {})))",
    "        elif kind == 'fillet':",
    "            result = result.edges().fillet(feature.get('radius', 1))",
    "        elif kind == 'chamfer':",
    "            result = result.edges().chamfer(feature.get('distance', 1))",
    "    return result",
    "",
    "",
    "def build_part(part):",
    "    result = None",
    "    for primitive in part.get('primitives') or [{'type': 'box', 'size': [10, 10, 10]}]:",
    "        pose = primitive.get('pose') or {}",
    "        if isinstance(primitive.get('center'), list) and not pose.get('translate'):",
    "            pose = {**pose, 'translate': primitive['center']}",
    "        item = apply_pose(make_primitive(primitive), pose)",
    "        result = item if result is None else result.union(item)",
    "    return apply_features(result, part.get('features', []))",
    "",
    "",
    "PLAN = " + pythonLiteral(plan || {}, 0),
    "",
    "",
    `def build_${safeAssemblyName}():`,
    `    assembly = cq.Assembly(name=${JSON.stringify(assemblyRootName)})`,
    "    parts = {}",
    "    for part in PLAN.get('parts', []):",
    "        built = build_part(part)",
    "        parts[part['id']] = built",
    "        pose = part.get('pose') or {}",
    "        loc = cq.Location(tuple((pose.get('translate') or [0, 0, 0])[:3]), tuple((pose.get('rotate') or [0, 0, 0])[:3]))",
    "        assembly.add(built, name=part['id'], loc=loc)",
    "    return assembly, parts",
    "",
    "",
    "if __name__ == '__main__':",
    `    assembly, parts = build_${safeAssemblyName}()`,
    `    assembly.save('${safeAssemblyName}.step')`
  ];
  return `${lines.join("\n")}\n`;
}

function pythonLiteral(value, indent = 0) {
  const pad = " ".repeat(indent);
  const nextPad = " ".repeat(indent + 4);
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((item) => `${nextPad}${pythonLiteral(item, indent + 4)}`).join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([key, item]) => `${nextPad}${JSON.stringify(key)}: ${pythonLiteral(item, indent + 4)}`).join(",\n")}\n${pad}}`;
  }
  return "None";
}

async function loadExcellentCadqueryContext(message) {
  const examples = await listExcellentCadqueryExamples();
  if (!examples.length) return "No 100-point local CadQuery examples have been saved yet.";
  const tokens = tokenizeSearchQuery(message);
  const ranked = examples
    .map((example) => ({ example, score: scoreExcellentExample(example, tokens) }))
    .sort((a, b) => b.score - a.score || String(b.example.savedAt || "").localeCompare(String(a.example.savedAt || "")))
    .slice(0, 3)
    .map(({ example }) => ({
      name: example.name,
      score: example.score,
      savedAt: example.savedAt,
      comment: example.comment,
      pythonFile: example.pythonPath,
      planSummary: summarizePlanForLearning(example.plan),
      pythonExcerpt: example.pythonExcerpt
    }));
  return JSON.stringify({
    instruction: "These are local 100-point human-rated CadQuery Python examples. Learn their modeling patterns, decomposition, feature ordering, holes/slots/fillets, and assembly organization. Do not copy dimensions or override the current user request unless directly relevant.",
    examples: ranked
  }, null, 2);
}

async function listExcellentCadqueryExamples() {
  let entries = [];
  try {
    entries = await readdir(excellentCadqueryLibraryDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const examples = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(excellentCadqueryLibraryDir, entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    const planPath = path.join(dir, "feature-plan.json");
    const pythonPath = path.join(dir, "excellent_cadquery.py");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const plan = JSON.parse(await readFile(planPath, "utf8"));
      const python = await readFile(pythonPath, "utf8");
      examples.push({
        ...manifest,
        dir,
        plan,
        pythonPath,
        pythonExcerpt: python.slice(0, 2600)
      });
    } catch {
      // Ignore incomplete manually edited examples.
    }
  }
  return examples.slice(-80);
}

async function listCadLatentSamples() {
  const samples = [];
  let ratingEntries = [];
  try {
    ratingEntries = await readdir(ratingArchiveDir, { withFileTypes: true });
  } catch {
    ratingEntries = [];
  }
  for (const entry of ratingEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const rating = JSON.parse(await readFile(path.join(ratingArchiveDir, entry.name), "utf8"));
      if (rating?.format !== "ai-cad-manual-rating-v1") continue;
      samples.push(buildCadLatentSample({
        rating,
        plan: rating.plan || {},
        assembly: rating.assembly || {}
      }));
    } catch {
      // Ignore incomplete or manually edited rating files.
    }
  }

  let trainingEntries = [];
  try {
    trainingEntries = await readdir(trainingArchiveDir, { withFileTypes: true });
  } catch {
    trainingEntries = [];
  }
  for (const entry of trainingEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const session = JSON.parse(await readFile(path.join(trainingArchiveDir, entry.name), "utf8"));
      if (session?.format !== "ai-cad-training-session-v1" || session.status !== "pass") continue;
      samples.push(buildCadLatentSample({
        rating: {
          id: `training:${session.id}`,
          score: 50,
          trainingVerified: true,
          retainedForLearning: false,
          comment: [session.request, session.finalReview?.summary].filter(Boolean).join(" | "),
          savedAt: session.savedAt,
          assemblyId: session.assemblyId
        },
        plan: session.plan || {},
        assembly: session.assembly || {}
      }));
    } catch {
      // Ignore incomplete or manually edited training records.
    }
  }

  for (const example of await listExcellentCadqueryExamples()) {
    samples.push(buildCadLatentSample({
      rating: {
        id: example.sourceRatingId || example.name,
        score: example.score || 100,
        retainedForLearning: true,
        comment: example.comment || "",
        savedAt: example.savedAt || null,
        assemblyId: example.assemblyId || null
      },
      plan: example.plan || {},
      assembly: {
        status: "done",
        stepUrl: "excellent-cadquery-library",
        freeCadBridgeReport: { visiblePartObjectCount: Math.max(1, example.plan?.parts?.length || 1), failedConstraints: [] }
      }
    }));
  }

  const unique = new Map();
  for (const sample of samples) unique.set(sample.id, sample);
  return [...unique.values()].slice(-200);
}

function summarizePlanForLearning(plan) {
  return {
    name: plan?.name || "",
    parts: (plan?.parts || []).slice(0, 8).map((part) => ({
      id: part.id,
      name: part.name,
      role: part.role,
      primitiveTypes: (part.primitives || []).map((primitive) => primitive.type),
      featureTypes: (part.features || []).map((feature) => feature.type)
    })),
    relations: (plan?.relations || []).slice(0, 8),
    joints: (plan?.joints || []).slice(0, 8)
  };
}

function scoreExcellentExample(example, tokens) {
  const text = [
    example.name,
    example.comment,
    example.plan?.name,
    ...(example.plan?.parts || []).flatMap((part) => [part.id, part.name, part.role]),
    ...(example.plan?.relations || []).map((relation) => relation.description)
  ].join(" ").toLowerCase();
  if (!tokens.size) return 1;
  let score = 0;
  for (const token of tokens) {
    if (text.includes(token)) score += token.length > 2 ? 10 : 4;
  }
  return score;
}

async function buildServerCadReferenceContext(message, conversation) {
  return buildCadReferenceContext({
    message,
    conversation,
    loadExcellentExamples: listExcellentCadqueryExamples,
    loadCadLatentSamples: listCadLatentSamples,
    loadCadLatentModel: () => latentTraining.plannerModel(),
    searchStepParts: async (request) => {
      const candidates = await searchStepPartsCandidates({ request, pageSize: 3 });
      return candidates[0] || null;
    }
  });
}

async function queueLatentLearning(job, source) {
  if (!job || job.status !== "done" || !job.stepPath || !canPromoteRevision(job.validationReport || {})) return null;
  try {
    const result = await latentTraining.enqueueAcceptedAssembly({ job, source });
    if (result.queued) publish("latent:training:queued", { status: "queued", source, assemblyId: job.id, revisionId: job.currentRevision, queueLength: result.status?.queueLength || 0 });
    return result;
  } catch (error) {
    publish("latent:training:failed", { status: "failed", source, assemblyId: job.id, error: error.message || String(error) });
    return null;
  }
}

async function runCodexTextInvocation({ label, fallbackWarning, threadKey, prompt, images = [], fastPlanner = false, timeoutMs, maxBuffer = 500000 }) {
  if (codexHarnessEnabled) {
    try {
      const result = await codexHarness.run({ key: threadKey, prompt, images, cwd: __dirname, timeoutMs });
      return { text: result.text, source: "codex-app-server", provider: "codex" };
    } catch (error) {
      if (codexHarnessStrict) throw error;
      console.warn(`${fallbackWarning || `Codex app-server ${label} fallback`}: ${error.message || error}`);
    }
  }
  const invocation = buildCodexExecInvocation(prompt, images, { fastPlanner, model: codexModel, reasoningEffort: codexReasoningEffort });
  const result = await runProcess(codexBin, invocation.args, {
    cwd: __dirname,
    timeoutMs,
    maxBuffer,
    input: invocation.input
  });
  return { text: result.stdout, source: "codex-cli", provider: "codex" };
}

// Single seam for every planner/edit/visual-review call: DeepSeek first when it
// is selected and capable, otherwise the existing Codex harness + exec chain.
async function invokeLlmText({ label, fallbackWarning, threadKey, prompt, images = [], fastPlanner = false, timeoutMs, maxBuffer = 500000 }) {
  const route = llmRouteForRequest(llmPolicy, { hasImages: images.length > 0 });
  if (route.useDeepSeek && deepseekClient) {
    try {
      const result = await deepseekClient.run({ prompt, images, timeoutMs });
      return { text: result.text, source: `deepseek:${result.model}`, provider: "deepseek" };
    } catch (error) {
      if (!route.fallbackToCodex) throw error;
      console.warn(`DeepSeek ${label} fallback: ${error.message || error}`);
    }
  } else if (route.reason === "images-unsupported") {
    if (llmPolicy.strict) {
      const error = new Error(`DeepSeek 模型 ${llmPolicy.deepseek.model} 不支持图片输入，${label} 需要视觉模型。请设置 AICAD_DEEPSEEK_VISION=1、改用视觉模型，或关闭 AICAD_LLM_STRICT。`);
      error.code = "DEEPSEEK_VISION_UNSUPPORTED";
      throw error;
    }
    console.warn(`DeepSeek ${label}: 模型 ${llmPolicy.deepseek.model} 未启用视觉输入，改用 Codex。`);
  }
  return runCodexTextInvocation({ label, fallbackWarning, threadKey, prompt, images, fastPlanner, timeoutMs, maxBuffer });
}

async function generateAssemblyPlan(conversation, message, searchContext = null, cadReferenceContext = null, imageAttachments = []) {
  if (!conversation?.currentRevision && !(conversation?.plan?.parts || []).length && !imageAttachments.length) {
    const deterministicPlan = buildNema23LBracketPlan(message);
    if (deterministicPlan) {
      return normalizeGeneratedPlanCandidate(deterministicPlan, {
        normalizeShape: normalizePlanShape,
        preflightExtrudes: preflightExtrudeProfiles,
        canonicalizePartId: safePartId,
        validateAssembly: validateAssemblyPlan,
        normalizeParametric: normalizeParametricPlan
      });
    }
  }
  const invokePlanner = async (plannerMessage, { forceFullPlan = false } = {}) => runWithTimeoutRetry(async ({ fastRetry }) => {
    const plannerConversation = compactPlannerConversation(conversation, { fastRetry });
    const fastPlanner = Boolean(conversation?.currentRevision && !imageAttachments.length);
    const excellentCadqueryContext = fastRetry ? "" : await loadExcellentCadqueryContext(message);
    const instruction = buildAssemblyPlannerInstruction({
      conversation: plannerConversation,
      message: plannerMessage,
      searchContext: fastRetry ? null : searchContext,
      excellentCadqueryContext,
      formattedSearchContext: fastRetry ? "No search context on timeout retry." : formatSearchContextForPrompt(searchContext),
      formattedCadReferenceContext: fastRetry ? "No CAD reference context on timeout retry." : formatCadReferenceContextForPrompt(cadReferenceContext),
      imageAttachments,
      fbs: plannerConversation.fbs,
      forceFullPlan
    });

    const llmResult = await invokeLlmText({
      label: "planner",
      fallbackWarning: "Codex app-server planner fallback",
      threadKey: `planner:${conversation.id || "default"}`,
      prompt: instruction,
      images: imageAttachments,
      fastPlanner,
      timeoutMs: imageAttachments.length
        ? codexImageTimeoutMs
        : fastPlanner
          ? (fastRetry ? codexEditRetryTimeoutMs : codexEditTimeoutMs)
          : codexPlannerTimeoutMs,
      maxBuffer: 600000
    });
    return extractJsonObject(llmResult.text);
  });
  const response = await generatePlanWithProfileRepair({
    originalRequest: message,
    invokePlanner,
    prepareFullPlan: () => {},
    normalize: (plan) => normalizeGeneratedPlanCandidate(plan, {
      normalizeShape: normalizePlanShape,
      preflightExtrudes: preflightExtrudeProfiles,
      canonicalizePartId: safePartId,
      validateAssembly: validateAssemblyPlan,
      normalizeParametric: normalizeParametricPlan
    }),
    classifyResponse: (plan) => {
      if (plan?.mode === "ambiguous") return "ambiguous";
      if (isEditPatchResponse(plan)) return "editPatch";
      return "fullPlan";
    }
  });
  if (response?.mode === "ambiguous") {
    return {
      mode: "ambiguous",
      ambiguous: true,
      reply: sanitizeText(response.reply || "修改目标不唯一，请确认具体零件或特征。", 500),
      candidates: Array.isArray(response.candidates) ? response.candidates.slice(0, 12) : []
    };
  }
  if (isEditPatchResponse(response)) {
    response.reply = sanitizeText(response.reply || "已生成局部修改。", 500);
    return response;
  }
  if (conversation?.fbs && response?.concept) {
    // FBS is generated once per conceptual revision. Subsequent CAD edits
    // reuse the archived trace instead of asking the planner to restate it.
    response.concept = {
      requirements: conversation.fbs.requirements || response.concept.requirements || "",
      criteria: conversation.fbs.criteria || response.concept.criteria || "",
      functions: structuredClone(conversation.fbs.functions || response.concept.functions || []),
      behaviors: structuredClone(conversation.fbs.behaviors || response.concept.behaviors || []),
      structures: structuredClone(conversation.fbs.structures || response.concept.structures || [])
    };
  }
  return response;
}

// Side effects buildValidatedAssembly needs from this process: the CadQuery
// runtime, the live job registry, SSE publishing, and the FreeCAD/latent
// follow-ups.  Everything else it imports directly.
function assemblyBuildDeps() {
  return {
    assemblyDir,
    newAssemblyId: (plan) => `${Date.now()}-${safeSlug(plan.name || "assembly")}-${randomUUID().slice(0, 8)}`,
    hydrateStandardParts: (plan) => hydrateStandardPartsForPlan(plan, { cacheDir: standardPartsCacheDir }),
    runCadQueryBuild: runCadQueryAssemblyBuild,
    applyBuildSummaryToJob,
    buildKinematicPackage,
    ensureAssemblyFcstd,
    revisionDeliveryState,
    registerJob: (job) => assemblyJobs.set(job.id, job),
    publish,
    publicAssembly,
    queueLatentLearning
  };
}

async function runCadQueryAssemblyBuild({ manifestPath }) {
  const buildResult = await runProcess(cadqueryPython, [path.join(__dirname, "scripts/cadquery_build.py")], {
    cwd: __dirname,
    env: {
      ...process.env,
      AI_CAD_CADQUERY_MANIFEST: manifestPath
    },
    timeoutMs: 90000,
    maxBuffer: 200000
  });
  return extractJsonObject(buildResult.stdout);
}

function buildAssembly(plan, repairContext = {}) {
  return buildValidatedAssembly({ plan, repairContext, deps: assemblyBuildDeps() });
}

// How many planner-driven repair rounds one chat turn may spend before the
// build is reported as still blocked.
const MAX_CONVERSATION_REPAIRS = 6;

// conversation-turn.js takes the planner as a single-object call so it never
// has to know generateAssemblyPlan's positional signature.
function plannerBridge() {
  return ({ conversation, message, cadReferenceContext }) =>
    generateAssemblyPlan(conversation, message, null, cadReferenceContext, []);
}

function conversationTurnDeps() {
  return {
    editRevision: ({ job, patch }) => editAssemblyRevision({
      revisionRoot: assemblyDir,
      job,
      patch,
      executeBuild: executeParametricRevisionBuild,
      finalizeBuild: (context) => finalizeParametricRevisionBuild(job, context)
    }),
    generatePlan: plannerBridge(),
    applyBuildSummary: applyBuildSummaryToJob,
    queueLatentLearning
  };
}

async function executeParametricRevisionBuild({ plan, outputDir }) {
  const manifest = {
    name: plan.name || "AI_CAD_Assembly",
    outputDir,
    relations: plan.relations || [],
    joints: plan.joints || [],
    constraints: plan.constraints || [],
    intendedContacts: plan.intendedContacts || [],
    repairActions: plan.repairActions || [],
    parts: plan.parts || []
  };
  const manifestPath = path.join(outputDir, "assembly-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const buildResult = await runProcess(cadqueryPython, [path.join(__dirname, "scripts/cadquery_build.py")], {
    cwd: __dirname,
    env: { ...process.env, AI_CAD_CADQUERY_MANIFEST: manifestPath },
    timeoutMs: 90000,
    maxBuffer: 300000
  });
  const summary = extractJsonObject(buildResult.stdout);
  summary.manifestPath = manifestPath;
  await writeFile(path.join(outputDir, "build-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  return summary;
}

function applyBuildSummaryToJob(job, buildSummary) {
  job.parts = (job.plan?.parts || []).map((part) => {
    const previous = (job.parts || []).find((item) => item.id === part.id) || {};
    const output = (buildSummary.parts || []).find((item) => item.id === part.id) || {};
    return {
      ...previous,
      ...part,
      mode: output.mode || part.mode || "generated",
      standardPart: output.standardPart || part.standardPart || null,
      pose: normalizePose(part.pose),
      inertial: part.inertial || null,
      sourceStepPath: output.sourceStepPath || part.sourceStepPath || null,
      stepPath: output.stepPath || previous.stepPath || null,
      localStepPath: output.localStepPath || previous.localStepPath || null,
      stlPath: output.stlPath || previous.stlPath || null,
      localStlPath: output.localStlPath || previous.localStlPath || null,
      pngPath: output.pngPath || previous.pngPath || null,
      featureTrace: output.featureTrace || previous.featureTrace || [],
      geometryValidation: output.geometryValidation || previous.geometryValidation || null,
      parametricChecksum: checksumParametricPart(part),
      buildPolicyChecksum: checksumPartBuildPolicy(part.id, job.plan?.repairActions),
      builderVersion: output.builderVersion || previous.builderVersion || buildSummary.builderVersion || null,
      localStepChecksum: output.localStepChecksum || (output.localStepPath === previous.localStepPath ? previous.localStepChecksum : null),
      sourceStepChecksum: output.sourceStepChecksum || (part.sourceStepPath === previous.sourceStepPath ? previous.sourceStepChecksum : null),
      stepUrl: artifactUrl(job, output.stepPath || previous.stepPath),
      stlUrl: artifactUrl(job, output.stlPath || previous.stlPath),
      pngUrl: artifactUrl(job, output.pngPath || previous.pngPath)
    };
  });
  job.engine = buildSummary.engine || "cadquery";
  job.fcstdPath = buildSummary.fcstdPath || job.fcstdPath || null;
  job.stepPath = buildSummary.stepPath || job.stepPath || null;
  job.stlPath = buildSummary.stlPath || job.stlPath || null;
  job.glbPath = buildSummary.glbPath || null;
  job.glbWarning = buildSummary.glbWarning || null;
  job.featureTracePath = buildSummary.featureTracePath || null;
  job.geometryValidationPath = buildSummary.geometryValidationPath || null;
  job.manifestPath = buildSummary.manifestPath || job.manifestPath || null;
}

async function refreshAssemblyDerivatives(job) {
  job.kinematics = await buildKinematicPackage(job);
  job.kinematicsPath = job.kinematics.kinematicsPath;
  job.constraintManifestPath = job.kinematics.constraintsPath;
  job.kinematicPackagePath = job.kinematics.packagePath;
  job.kinematicArchivePath = job.kinematics.archivePath;
  await ensureAssemblyFcstd(job);
  job.completedAt = new Date().toISOString();
  job.status = "done";
}

async function finalizeParametricRevisionBuild(job, { plan, buildSummary, outputDir, revisionId }) {
  const staging = {
    ...job,
    plan,
    outputDir,
    pendingRevision: revisionId,
    parts: (job.parts || []).map((part) => ({ ...part }))
  };
  applyBuildSummaryToJob(staging, buildSummary);
  await refreshAssemblyDerivatives(staging);
  return revisionDeliveryState(staging);
}

function revisionDeliveryState(job) {
  return Object.fromEntries(REVISION_DELIVERY_KEYS.filter((key) => job[key] !== undefined).map((key) => [key, structuredClone(job[key])]));
}

function artifactUrl(job, filePath) {
  if (!filePath || !job?.outputDir || !isPathInside(filePath, job.outputDir)) return null;
  const relative = path.relative(job.outputDir, filePath).split(path.sep).map(encodeURIComponent).join("/");
  return `/assemblies/${job.id}/${relative}`;
}

async function buildCadQueryPreview(part) {
  const id = `${Date.now()}-preview-${safeSlug(part.id || part.name || "part")}-${randomUUID().slice(0, 8)}`;
  const outDir = path.join(assemblyDir, id);
  await mkdir(outDir, { recursive: true });

  const normalized = {
    id: part.id || "preview_part",
    name: part.name || "预览零件",
    role: part.role || "preview",
    primitives: Array.isArray(part.primitives) && part.primitives.length
      ? part.primitives
      : [{ type: "box", size: [20, 20, 10], center: true }],
    features: Array.isArray(part.features) ? part.features : [],
    pose: normalizePose(part.pose),
    inertial: normalizeInertial(part.inertial)
  };
  const manifest = {
    name: `${safeSlug(normalized.id)}_preview`,
    outputDir: outDir,
    relations: [],
    joints: [],
    parts: [normalized]
  };
  const manifestPath = path.join(outDir, "assembly-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const buildResult = await runProcess(cadqueryPython, [path.join(__dirname, "scripts/cadquery_build.py")], {
    cwd: __dirname,
    env: {
      ...process.env,
      AI_CAD_CADQUERY_MANIFEST: manifestPath
    },
    timeoutMs: 45000,
    maxBuffer: 120000
  });
  const buildSummary = extractJsonObject(buildResult.stdout);
  const output = buildSummary.parts?.[0] || {};
  const previewJob = {
    id,
    plan: manifest,
    outputDir: outDir,
    parts: [{
      id: normalized.id,
      name: normalized.name,
      role: normalized.role,
      pose: normalized.pose,
      primitives: normalized.primitives,
      features: normalized.features,
      inertial: normalized.inertial,
      stepPath: output.stepPath || null,
      localStepPath: output.localStepPath || null,
      stlPath: output.stlPath || null,
      localStlPath: output.localStlPath || null
    }]
  };
  const kinematics = output.stepPath ? await buildKinematicPackage(previewJob) : null;
  previewJob.status = "done";
  previewJob.completedAt = new Date().toISOString();
  previewJob.manifestPath = manifestPath;
  previewJob.engine = buildSummary.engine || "cadquery";
  previewJob.stepPath = output.stepPath || null;
  previewJob.stlPath = output.stlPath || buildSummary.stlPath || null;
  previewJob.glbPath = buildSummary.glbPath || null;
  previewJob.glbWarning = buildSummary.glbWarning || null;
  previewJob.kinematics = kinematics;
  previewJob.kinematicsPath = kinematics?.kinematicsPath || null;
  previewJob.constraintManifestPath = kinematics?.constraintsPath || null;
  previewJob.kinematicPackagePath = kinematics?.packagePath || null;
  previewJob.kinematicArchivePath = kinematics?.archivePath || null;
  assemblyJobs.set(id, previewJob);

  return {
    id,
    status: "done",
    part: normalized,
    stlUrl: output.stlPath ? `/assemblies/${id}/${path.basename(output.stlPath)}` : null,
    stepUrl: output.stepPath ? `/assemblies/${id}/${path.basename(output.stepPath)}` : null,
    assemblyStlUrl: buildSummary.stlPath ? `/assemblies/${id}/${path.basename(buildSummary.stlPath)}` : null,
    glbUrl: buildSummary.glbPath ? `/assemblies/${id}/${path.basename(buildSummary.glbPath)}` : null,
    glbWarning: buildSummary.glbWarning || null,
    pngUrl: output.pngPath ? `/assemblies/${id}/${path.basename(output.pngPath)}` : null,
    assemblyPngUrl: buildSummary.pngPath ? `/assemblies/${id}/${path.basename(buildSummary.pngPath)}` : null,
    kinematicsUrl: kinematics?.kinematicsPath ? `/assemblies/${id}/${path.basename(kinematics.kinematicsPath)}` : null,
    constraintManifestUrl: kinematics?.constraintsPath ? `/assemblies/${id}/${path.basename(kinematics.constraintsPath)}` : null,
    kinematicPackageUrl: kinematics?.archivePath ? `/assemblies/${id}/${path.basename(kinematics.archivePath)}` : null,
    manifestUrl: `/assemblies/${id}/${path.basename(manifestPath)}`
  };
}

async function buildExplorerLink(body = {}) {
  const assemblyId = sanitizeText(body.assemblyId || body.id || "", 120);
  if (!assemblyId) throw new Error("assemblyId is required");
  const job = assemblyJobs.get(assemblyId);
  if (!job) throw new Error(`Assembly job not found: ${assemblyId}`);
  const partId = sanitizeText(body.partId || "", 120);
  const filePath = chooseExplorerPreviewFile(job, { partId });
  if (!filePath || !existsSync(filePath)) {
    throw new Error(partId
      ? `No Explorer preview file is available for part ${partId}`
      : "No Explorer preview file is available for this assembly");
  }
  if (!isPathInside(filePath, job.outputDir)) {
    throw new Error("Explorer preview file is outside the assembly output directory");
  }

  const result = await runProcess("npm", buildExplorerCommandArgs({
    workspaceRoot: __dirname,
    filePath
  }), {
    cwd: __dirname,
    timeoutMs: 45000,
    maxBuffer: 160000
  });
  const explorerUrl = parseExplorerUrl(result.stdout);
  if (!explorerUrl) {
    throw new Error(`CAD Explorer did not return a URL: ${result.stdout.slice(-500)}`);
  }
  return {
    ok: true,
    assemblyId,
    partId: partId || null,
    file: path.basename(filePath),
    explorerUrl
  };
}

async function runVisualReview(body = {}) {
  const assemblyId = sanitizeText(body.assemblyId || body.id || "", 120);
  if (!assemblyId) throw new Error("assemblyId is required");
  const job = assemblyJobs.get(assemblyId);
  if (!job) throw new Error(`Assembly job not found: ${assemblyId}`);
  const previewableStatus = ["done", "validation_failed"].includes(job.status)
    && Boolean(job.glbPath || job.stlPath || job.stepPath);
  if (!previewableStatus) {
    const error = new Error(`Assembly is not ready for visual review (current status: ${job.status || "unknown"})`);
    error.status = 409;
    error.code = "ASSEMBLY_NOT_READY";
    throw error;
  }
  const reviewedRevisionId = job.currentRevision || job.pendingRevision || `validation-failed:${job.id}`;

  const screenshots = await persistVisualReviewScreenshots(job, body.screenshots);
  if (!screenshots.length) throw new Error("At least one visual review screenshot is required");

  const userRequest = findLatestUserRequest(body.conversationId) || sanitizeText(body.userRequest || "", 2000);
  const instruction = buildVisualReviewInstruction({
    userRequest,
    plan: body.plan || job.plan,
    assembly: publicAssembly(job),
    screenshots
  });
  const llmResult = await invokeLlmText({
    label: "visual review",
    fallbackWarning: "Codex app-server visual review fallback",
    threadKey: `visual-review:${assemblyId}`,
    prompt: instruction,
    images: screenshots,
    timeoutMs: codexVisualReviewTimeoutMs,
    maxBuffer: 500000
  });
  const parsed = extractJsonObject(llmResult.text);
  const report = normalizeVisualReviewResult(parsed, {
    assemblyId,
    revisionId: reviewedRevisionId,
    plan: body.plan || job.plan,
    assembly: publicAssembly(job),
    screenshots,
    reviewedAt: new Date().toISOString()
  });
  job.visualReview = await persistVisualReviewReport(job, report);
  publish("assembly:review_done", publicAssembly(job));
  return publicVisualReview(job.visualReview);
}

async function improveFromVisualReview(body = {}) {
  const assemblyId = sanitizeText(body.assemblyId || "", 120);
  if (!assemblyId) return { ok: false, code: "ASSEMBLY_ID_REQUIRED", error: "assemblyId is required" };
  const job = assemblyJobs.get(assemblyId) || await restoreAssemblyJob(assemblyDir, assemblyId).catch(() => null);
  if (!job) return { ok: false, code: "ASSEMBLY_NOT_FOUND", error: "Assembly job not found" };
  assemblyJobs.set(job.id, job);
  const review = job.visualReview;
  const eligibility = visualReviewImprovementEligibility(review, job.currentRevision);
  if (!eligibility.ok) return { ok: false, code: eligibility.code, error: eligibility.message, review: publicVisualReview(review) };
  if (body.reviewRevisionId && String(body.reviewRevisionId) !== String(review.revisionId)) {
    return { ok: false, code: "REVIEW_STALE", error: "审查版本已变化，请刷新后重新审查", review: publicVisualReview(review) };
  }

  const conversationId = String(body.conversationId || "").trim();
  const sourceConversation = conversations.get(conversationId) || { id: conversationId || randomUUID(), messages: [] };
  const userRequest = findLatestUserRequest(conversationId);
  const sourceRevision = job.currentRevision;
  const maximumValidationRepairs = boundedInt(body.maximumValidationRepairs, 2, 0, 3);
  const actionableFindings = actionableVisualFindings(review);
  const requestedFindingIds = Array.isArray(body.findingIds)
    ? body.findingIds.map((id) => sanitizeText(id, 60)).filter(Boolean).slice(0, 20)
    : null;
  const selectedFindingIds = requestedFindingIds === null
    ? actionableFindings.map((finding) => finding.findingId)
    : requestedFindingIds.filter((id) => actionableFindings.some((finding) => String(finding.findingId) === id));
  if (!selectedFindingIds.length) return { ok: false, code: "NO_SELECTED_FINDINGS", error: "请至少选择一个可自动修复的问题", review: publicVisualReview(review) };
  const attempts = [];
  let planned = null;
  let revision = null;
  let improvementMessage = buildVisualReviewImprovementMessage({ review, userRequest, currentRevision: sourceRevision, selectedFindingIds });
  for (let attempt = 0; attempt <= maximumValidationRepairs; attempt += 1) {
    const improvementConversation = {
      ...sourceConversation,
      plan: job.plan,
      assemblyId: job.id,
      currentRevision: job.currentRevision,
      validationReport: attempt ? revision?.validationReport : job.validationReport,
      activePartId: body.activePartId || job.plan?.activePartId || null,
      activeFeatureId: body.activeFeatureId || job.plan?.activeFeatureId || null
    };
    planned = await generateAssemblyPlan(improvementConversation, improvementMessage, null, null, []);
    if (planned.mode === "ambiguous") {
      return { ok: false, code: "AMBIGUOUS_IMPROVEMENT", error: planned.reply || "视觉审查反馈无法唯一定位修改目标", candidates: planned.candidates || [], attempts };
    }
    if (!isEditPatchResponse(planned)) {
      return { ok: false, code: "EDIT_PATCH_REQUIRED", error: "视觉改进必须返回局部参数化编辑补丁", attempts };
    }
    try {
      revision = await editAssemblyRevision({
        revisionRoot: assemblyDir,
        job,
        patch: planned.editPatch,
        executeBuild: executeParametricRevisionBuild,
        finalizeBuild: (context) => finalizeParametricRevisionBuild(job, context)
      });
    } catch (error) {
      revision = {
        status: "failed",
        code: "EDIT_PATCH_INVALID",
        message: error.message || String(error),
        validationReport: {
          format: "ai-cad-validation-report-v1",
          generatedAt: new Date().toISOString(),
          valid: false,
          blockingErrorCount: 1,
          summary: { errors: 1, warnings: 0, info: 0 },
          issues: [{ stage: "edit_patch", severity: "error", code: "EDIT_PATCH_INVALID", message: error.message || String(error) }],
          assemblyId: job.id,
          revisionId: null
        }
      };
    }
    attempts.push({
      index: attempt + 1,
      patch: planned.editPatch,
      reply: planned.reply || "",
      revisionId: revision.id || revision.validationReport?.revisionId || null,
      status: revision.status || "failed",
      validationReport: revision.validationReport || null
    });
    if (revision.status === "current") break;
    if (attempt >= maximumValidationRepairs) {
      publish("assembly:error", publicAssembly(job));
      job.visualReview = await persistVisualReviewReport(job, {
        ...review,
        improvement: { status: "validation_failed", sourceRevision, selectedFindingIds, attempts, failedAt: new Date().toISOString() }
      });
      return { ok: false, code: "IMPROVEMENT_VALIDATION_FAILED", error: `视觉改进经过 ${attempts.length} 个候选仍未通过验证`, revision, attempts, review: publicVisualReview(job.visualReview) };
    }
    improvementMessage = buildVisualImprovementValidationRepairMessage({
      review,
      userRequest,
      currentRevision: sourceRevision,
      failedPatch: planned.editPatch,
      validationReport: revision.validationReport,
      attempt: attempt + 1,
      selectedFindingIds
    });
  }
  if (revision.buildSummary) applyBuildSummaryToJob(job, revision.buildSummary);
  job.visualReview = await persistVisualReviewReport(job, {
    ...review,
    improvement: {
      status: "applied",
      sourceRevision,
      selectedFindingIds,
      revisionId: job.currentRevision,
      improvedAt: new Date().toISOString(),
      reply: planned.reply || "已根据视觉审查反馈完成局部改进。",
      attempts
    }
  });
  if (conversationId) {
    sourceConversation.plan = job.plan;
    sourceConversation.assemblyId = job.id;
    sourceConversation.currentRevision = job.currentRevision;
    sourceConversation.validationReport = job.validationReport;
    sourceConversation.messages ||= [];
    sourceConversation.messages.push({ role: "assistant", content: planned.reply || "已根据视觉审查反馈完成局部改进。", at: new Date().toISOString() });
    conversations.set(conversationId, sourceConversation);
    await persistConversation(sourceConversation, job.plan);
  }
  publish("assembly:done", publicAssembly(job));
  return {
    ok: true,
    reply: planned.reply || "已根据视觉审查反馈完成局部改进。",
    editPatch: planned.editPatch,
    revision,
    attempts,
    review: publicVisualReview(job.visualReview),
    assembly: publicAssembly(job)
  };
}

async function persistVisualReviewReport(job, report) {
  const reviewDir = path.join(job.outputDir, "visual-review");
  await mkdir(reviewDir, { recursive: true });
  const jsonPath = path.join(reviewDir, "visual-review.json");
  const mdPath = path.join(reviewDir, "visual-review.md");
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(mdPath, renderVisualReviewMarkdown(report), "utf8");
  return {
    ...report,
    jsonPath,
    mdPath,
    jsonUrl: `/assemblies/${job.id}/visual-review/visual-review.json`,
    mdUrl: `/assemblies/${job.id}/visual-review/visual-review.md`
  };
}

async function persistVisualReviewScreenshots(job, screenshots) {
  if (!Array.isArray(screenshots) || !screenshots.length) return [];
  if (screenshots.length > maxVisualReviewImages) {
    throw new Error(`最多提交 ${maxVisualReviewImages} 张视觉审查截图`);
  }
  const reviewDir = path.join(job.outputDir, "visual-review");
  await mkdir(reviewDir, { recursive: true });
  const saved = [];
  for (const [index, image] of screenshots.entries()) {
    const dataUrl = String(image?.dataUrl || "");
    const match = dataUrl.match(/^data:image\/(?:jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("视觉审查截图必须是 JPEG data URL");
    const buffer = Buffer.from(match[1], "base64");
    if (!buffer.length) throw new Error("视觉审查截图内容为空");
    if (buffer.length > maxVisualReviewImageBytes) {
      throw new Error(`单张视觉审查截图不能超过 ${Math.round(maxVisualReviewImageBytes / 1024)} KB`);
    }
    const view = safeSlug(image?.view || `view-${index + 1}`) || `view-${index + 1}`;
    const fileName = `${String(index + 1).padStart(2, "0")}-${view}.jpg`;
    const filePath = path.join(reviewDir, fileName);
    await writeFile(filePath, buffer);
    saved.push({
      view,
      name: fileName,
      path: filePath,
      url: `/assemblies/${job.id}/visual-review/${fileName}`
    });
  }
  return saved;
}

function findLatestUserRequest(conversationId) {
  const id = String(conversationId || "").trim();
  if (!id) return "";
  const conversation = conversations.get(id);
  const messages = conversation?.messages || [];
  const latest = [...messages].reverse().find((message) => message.role === "user" && message.content);
  return latest ? String(latest.content) : "";
}

function renderVisualReviewMarkdown(report) {
  const lines = [
    `# AI-CAD 视觉审查`,
    ``,
    `- 装配 ID: \`${report.assemblyId}\``,
    `- 修订 ID: \`${report.revisionId || "unknown"}\``,
    `- 状态: ${report.status}`,
    `- 时间: ${report.reviewedAt}`,
    ``,
    `## 摘要`,
    ``,
    report.summary,
    ``,
    `## 问题`,
    ``
  ];
  if (!report.findings.length) {
    lines.push("- 未报告具体问题。");
  } else {
    for (const finding of report.findings) {
      lines.push(`- [${finding.findingId || "finding"}] [${finding.severity}] ${finding.category}: ${finding.message}`);
      lines.push(`  目标: ${finding.partId || "未定位"}${finding.featureId ? ` / ${finding.featureId}` : ""}`);
      lines.push(`  可执行性: ${finding.actionability || "needs_user"}; 置信度: ${finding.confidence || "low"}`);
      if (finding.proposedChange?.op) {
        lines.push(`  拟修改: ${finding.proposedChange.op}${finding.proposedChange.path ? ` ${finding.proposedChange.path}` : ""}${finding.proposedChange.value === undefined ? "" : ` = ${JSON.stringify(finding.proposedChange.value)}`}`);
      }
      if (finding.verification?.method) {
        lines.push(`  验证: ${finding.verification.method}${finding.verification.expected ? ` -> ${finding.verification.expected}` : ""}`);
      }
      if (finding.evidence?.length) {
        lines.push(`  证据: ${finding.evidence.join(", ")}`);
      }
    }
  }
  lines.push("", `## 建议`, "", report.recommendedNextAction);
  if (report.improvement?.status === "applied") {
    lines.push("", "## 改进版本", "", `- 来源修订: ${report.improvement.sourceRevision}`, `- 新修订: ${report.improvement.revisionId}`, `- 时间: ${report.improvement.improvedAt}`);
  }
  return lines.join("\n");
}

function parseFeaturePart(input) {
  if (input && typeof input === "object") return sanitizePreviewPart(input);
  const text = String(input || "").trim();
  if (!text) throw new Error("CadQuery feature JSON is required");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("CadQuery feature JSON must be an object");
  return sanitizePreviewPart(parsed);
}

function sanitizePreviewPart(part) {
  const plan = {
    name: "preview",
    parts: [{
      ...part,
      id: part.id || "preview_part",
      name: part.name || "预览零件"
    }],
    relations: [],
    joints: []
  };
  validateAssemblyPlan(plan);
  return plan.parts[0];
}

async function generateWithCodex(prompt, currentCode) {
  const instruction = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: prompt,
    searchContext: null,
    excellentCadqueryContext: "",
    formattedSearchContext: ""
  });

  const llmResult = await invokeLlmText({
    label: "generate",
    fallbackWarning: "Codex app-server generate fallback",
    threadKey: "generate",
    prompt: instruction,
    timeoutMs: 120000,
    maxBuffer: 300000
  });
  const generated = extractJsonObject(llmResult.text);
  return {
    code: JSON.stringify(generated, null, 2),
    raw: llmResult.text,
    source: llmResult.source
  };
}

async function normalizeAndArchiveConceptPlan(plan, requirements, previousFbs = null) {
  let analysis;
  try {
    analysis = normalizeFbsAnalysis(plan?.concept, requirements, plan?.concept?.criteria || previousFbs?.criteria || "");
  } catch {
    const fallbackCandidate = (id, label, upstreamIds = []) => ({ id, label, rationale: "由当前 CAD 计划直接映射", specifications: [], upstreamIds });
    const partLabels = (plan?.parts || []).map((part) => part.name || part.id).filter(Boolean);
    analysis = normalizeFbsAnalysis({
      functions: previousFbs?.functions?.length ? previousFbs.functions : [fallbackCandidate("f-1", "满足当前工程需求")],
      behaviors: previousFbs?.behaviors?.length ? previousFbs.behaviors : [fallbackCandidate("be-1", "通过参数化几何实现功能", ["f-1"])],
      structures: previousFbs?.structures?.length ? previousFbs.structures : [fallbackCandidate("s-1", partLabels.join(" + ") || "参数化 CAD 结构", ["be-1"])]
    }, requirements, previousFbs?.criteria || "");
  }
  const experimentId = sanitizeText(previousFbs?.experimentId, 120) || `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const payload = { format: "ai-cad-concept-cad-contract-v1", experimentId, analysis, plan: { name: plan?.name, partIds: (plan?.parts || []).map((part) => part.id) }, savedAt: new Date().toISOString() };
  await writeFile(path.join(fbsArchiveDir, `${safeSlug(experimentId)}-concept-cad.json`), JSON.stringify(payload, null, 2), "utf8");
  return { experimentId, ...analysis };
}

function buildCadSearchQuery(message) {
  const text = String(message || "").toLowerCase();
  const operations = [];
  if (/外壳|壳|盒|case|enclosure|cover|lid/.test(text)) operations.push("enclosure shell lid box hollow");
  if (/孔|打孔|螺丝|螺钉|安装|hole|screw|mount/.test(text)) operations.push("hole cboreHole cskHole workplane");
  if (/槽|针脚|避让|开口|slot|cut|window|clearance/.test(text)) operations.push("slot cutBlind cutThruAll rectangular cut");
  if (/圆角|倒角|fillet|chamfer/.test(text)) operations.push("fillet chamfer edges");
  if (/装配|关系|运动|铰链|滑块|assembly|joint|hinge|slider/.test(text)) operations.push("Assembly Location constraint");
  return [
    "CadQuery Python Workplane example code",
    ...operations,
    "site:cadquery.readthedocs.io OR site:github.com"
  ].join(" ");
}

async function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const text = await readFile(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseEnvValue(match[2]);
  }
}

function parseEnvValue(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "");
}

function isEnabled(value) {
  return ["1", "true", "on", "yes"].includes(String(value || "").trim().toLowerCase());
}

function normalizeWebSearchProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return ["tavily", "anysearch", "bing-cn", "sogou", "china"].includes(provider) ? provider : "anysearch";
}

function shouldUseCurlFallback() {
  const value = String(process.env.AICAD_WEB_SEARCH_CURL_FALLBACK || "auto").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(value)) return false;
  if (["1", "true", "on", "yes"].includes(value)) return true;
  return hasProxyEnv();
}

function shouldUseLocalCadLibraryFirst() {
  const value = String(process.env.AICAD_WEB_SEARCH_LOCAL_FIRST || "auto").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(value)) return false;
  if (["1", "true", "on", "yes"].includes(value)) return true;
  // CAD queries are best served by the deterministic local reference set
  // first. Remote search remains available for topics not covered locally.
  return true;
}

async function searchCadReferences(query, options = {}) {
  const normalizedQuery = String(query || "").replace(/\s+/g, " ").trim();
  if (!normalizedQuery) {
    return {
      enabled: true,
      provider: webSearchProvider,
      query: "",
      searchedAt: new Date().toISOString(),
      results: [],
      error: "Search query is empty"
    };
  }

  if (shouldUseLocalCadLibraryFirst()) {
    const fallback = searchLocalCadReferences(normalizedQuery, {
      maxResults: boundedInt(options.maxResults, webSearchMaxResults, 1, 8)
    });
    if (fallback.results.length) {
      return {
        enabled: true,
        provider: fallback.provider,
        query: normalizedQuery,
        searchedAt: new Date().toISOString(),
        results: fallback.results,
        notice: "已优先使用本地 CAD/加工资料库。",
        error: null
      };
    }
  }

  const attempts = [];
  try {
    const result = await searchWithConfiguredProvider(normalizedQuery, options, attempts);
    return {
      enabled: true,
      provider: result.provider,
      query: normalizedQuery,
      searchedAt: new Date().toISOString(),
      results: result.results
    };
  } catch (error) {
    const failure = formatSearchFailure(error, attempts);
    const fallback = searchLocalCadReferences(normalizedQuery, {
      maxResults: boundedInt(options.maxResults, webSearchMaxResults, 1, 8)
    });
    return {
      enabled: true,
      provider: fallback.results.length ? fallback.provider : webSearchProvider,
      query: normalizedQuery,
      searchedAt: new Date().toISOString(),
      results: fallback.results,
      notice: fallback.results.length ? "外部搜索暂不可用，已改用本地 CAD/加工资料库。" : null,
      error: fallback.results.length ? null : "外部搜索暂不可用，已跳过网络资料检索。"
    };
  }
}

async function searchWithConfiguredProvider(query, options, attempts) {
  if (webSearchProvider === "china") {
    try {
      const result = await searchWithSogou(query, options);
      if (result.results.length) return result;
      attempts.push({ provider: "sogou", error: new Error("no results") });
    } catch (error) {
      attempts.push({ provider: "sogou", error });
    }
    return searchWithBingCn(query, options);
  }
  if (webSearchProvider === "bing-cn") return searchWithBingCn(query, options);
  if (webSearchProvider === "sogou") return searchWithSogou(query, options);
  const useTavily = webSearchProvider === "tavily" && process.env.TAVILY_API_KEY;
  if (!useTavily) {
    try {
      return await searchWithAnySearch(query, options);
    } catch (error) {
      attempts.push({ provider: "anysearch", error });
    }
    return searchWithBingCn(query, options);
  }

  try {
    return await searchWithTavily(query, options);
  } catch (error) {
    attempts.push({ provider: "tavily", error });
  }

  try {
    return await searchWithAnySearch(query, options);
  } catch (error) {
    attempts.push({ provider: "anysearch", error });
  }

  try {
    return await searchWithBingCn(query, options);
  } catch (error) {
    attempts.push({ provider: "bing-cn", error });
  }

  try {
    return await searchWithSogou(query, options);
  } catch (error) {
    attempts.push({ provider: "sogou", error });
    throw error;
  }
}

async function searchWithTavily(query, options = {}) {
  const response = await fetchJsonWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.TAVILY_API_KEY}`
    },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: boundedInt(options.maxResults, webSearchMaxResults, 1, 8),
      include_answer: false,
      include_raw_content: false
    })
  });
  const results = (response.results || []).map((item) => normalizeSearchResult({
    title: item.title,
    url: item.url,
    snippet: item.content || item.snippet || "",
    score: item.score,
    source: hostnameOf(item.url)
  })).filter(Boolean);
  return { provider: "tavily", results };
}

async function searchWithAnySearch(query, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "AI-CAD/0.1 AnySearch reference search"
  };
  if (process.env.ANYSEARCH_API_KEY) {
    headers.Authorization = `Bearer ${process.env.ANYSEARCH_API_KEY}`;
  }
  const payload = await fetchJsonWithTimeout("https://api.anysearch.com/v1/search", {
    method: "POST",
    headers: {
      ...headers
    },
    body: JSON.stringify({
      query,
      max_results: boundedInt(options.maxResults, webSearchMaxResults, 1, 8)
    })
  });
  return normalizeAnySearchResponse(payload, {
    maxResults: boundedInt(options.maxResults, webSearchMaxResults, 1, 8)
  });
}

async function searchWithBingCn(query, options = {}) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}`;
  const html = await fetchTextWithCurl(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 AI-CAD/0.1"
    }
  });
  const results = parseBingHtml(html)
    .slice(0, boundedInt(options.maxResults, webSearchMaxResults, 1, 8));
  return { provider: "bing-cn", results };
}

async function searchWithSogou(query, options = {}) {
  const url = `https://www.sogou.com/web?ie=utf8&query=${encodeURIComponent(query)}`;
  const html = await fetchTextWithCurl(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 AI-CAD/0.1"
    }
  });
  const results = parseSogouHtml(html)
    .slice(0, boundedInt(options.maxResults, webSearchMaxResults, 1, 8));
  return { provider: "sogou", results };
}

function searchLocalCadReferences(query, options = {}) {
  const tokens = tokenizeSearchQuery(query);
  const results = localCadReferenceLibrary
    .map((item) => ({ item, score: scoreLocalReference(item, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => normalizeSearchResult({
      ...entry.item,
      score: entry.score / 100
    }))
    .filter(Boolean)
    .slice(0, boundedInt(options.maxResults, webSearchMaxResults, 1, 8));
  return { provider: "local-cad-library", results };
}

function tokenizeSearchQuery(query) {
  const normalized = String(query || "").toLowerCase();
  const ascii = normalized.match(/[a-z0-9.#+-]+/g) || [];
  const zh = [
    "电机", "步进", "舵机", "支架", "外壳", "盒子", "安装", "孔", "螺丝", "螺栓",
    "铝型材", "型材", "传感器", "相机", "雷达", "夹具", "连杆", "齿轮", "轴承",
    "轴", "打印", "光固化", "材料", "公差", "间隙", "壁厚"
  ].filter((word) => normalized.includes(word));
  return new Set([...ascii, ...zh]);
}

function scoreLocalReference(item, tokens) {
  if (!tokens.size) return 1;
  const haystack = [item.title, item.source, item.snippet, ...(item.keywords || [])].join(" ").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length > 2 ? 12 : 6;
  }
  return score;
}

const localCadReferenceLibrary = [
  {
    title: "NEMA 17 步进电机安装参考",
    url: "local://cad-reference/nema17-stepper-motor",
    source: "AI-CAD 本地资料库",
    keywords: ["nema17", "stepper", "motor", "电机", "步进", "支架", "安装孔"],
    snippet: "常见 NEMA 17 电机法兰约 42.3 x 42.3 mm，安装孔中心距常见为 31 mm，常用 M3 螺钉；中心凸台和轴径需按实物数据确认。建模时电机孔建议做长圆孔或预留 0.2-0.5 mm 装配余量。"
  },
  {
    title: "标准舵机支架建模参考",
    url: "local://cad-reference/standard-servo-bracket",
    source: "AI-CAD 本地资料库",
    keywords: ["servo", "mg996r", "舵机", "支架", "安装"],
    snippet: "标准舵机安装耳、输出轴位置和壳体尺寸不同批次差异较大；结构件应参数化舵机长宽高、耳孔距、输出轴偏置。支架孔位建议用槽孔，避免打印收缩或舵机批次误差导致装不上。"
  },
  {
    title: "2020/4040 铝型材连接件参考",
    url: "local://cad-reference/aluminum-extrusion-2020",
    source: "AI-CAD 本地资料库",
    keywords: ["2020", "4040", "铝型材", "型材", "支架", "连接件", "螺丝"],
    snippet: "2020 铝型材常配 M5 螺钉和 T 型螺母，连接件应预留槽位方向和扳手空间。用于快速装配时，孔位优先做长圆孔，边缘倒角，避免干涉型材圆角或槽口。"
  },
  {
    title: "FDM 3D 打印结构件设计规则",
    url: "local://cad-reference/fdm-design-rules",
    source: "AI-CAD 本地资料库",
    keywords: ["fdm", "3d", "打印", "壁厚", "孔", "公差", "材料", "pla", "petg", "abs"],
    snippet: "FDM 打印最小壁厚通常不低于 1.2-2.0 mm，承力件建议 3 mm 以上。孔会偏小，螺钉通孔建议按直径增加 0.2-0.5 mm；装配滑动间隙建议 0.3-0.6 mm。"
  },
  {
    title: "SLA/光固化打印结构件注意事项",
    url: "local://cad-reference/sla-design-rules",
    source: "AI-CAD 本地资料库",
    keywords: ["sla", "光固化", "打印", "树脂", "二次元", "手办", "外壳"],
    snippet: "光固化精度高，适合小外观件、手办、精细外壳，但普通树脂偏脆，不适合高冲击承力结构。空腔件要留排液孔；卡扣、薄筋、铰链需谨慎加厚或改用韧性树脂。"
  },
  {
    title: "CNC 铝合金零件设计规则",
    url: "local://cad-reference/cnc-aluminum-design-rules",
    source: "AI-CAD 本地资料库",
    keywords: ["cnc", "铝合金", "6061", "7075", "加工", "圆角", "公差", "材料"],
    snippet: "CNC 内角不能天然加工成直角，应按刀具半径预留内圆角；深腔和细长薄壁会提高加工难度。常见样件可用 6061 铝，强度要求更高可考虑 7075；螺纹孔、沉头孔、倒角需在模型和备注中明确。"
  },
  {
    title: "螺钉孔、热熔铜螺母和装配间隙参考",
    url: "local://cad-reference/screw-hole-clearance",
    source: "AI-CAD 本地资料库",
    keywords: ["m2", "m3", "m4", "m5", "螺丝", "螺钉", "孔", "铜螺母", "公差", "间隙"],
    snippet: "M3 普通通孔常取 3.2-3.4 mm，M4 通孔常取 4.3-4.5 mm，M5 通孔常取 5.3-5.5 mm。3D 打印件需要按设备补偿；塑料件反复拆装建议使用热熔铜螺母或嵌件。"
  },
  {
    title: "PCB 外壳和安装柱建模参考",
    url: "local://cad-reference/pcb-enclosure-standoffs",
    source: "AI-CAD 本地资料库",
    keywords: ["pcb", "外壳", "盒子", "安装柱", "传感器", "孔", "螺丝"],
    snippet: "PCB 外壳需要确认板长宽、安装孔坐标、元件最高点、接口开口位置。安装柱外径建议至少螺钉直径的 2.2-3 倍，柱根加圆角或加强筋，盖板和底壳之间预留 0.2-0.5 mm 装配间隙。"
  },
  {
    title: "传感器/相机/雷达安装座参考",
    url: "local://cad-reference/sensor-camera-mount",
    source: "AI-CAD 本地资料库",
    keywords: ["传感器", "相机", "摄像头", "雷达", "激光雷达", "安装座", "支架"],
    snippet: "传感器安装座需要优先保证视野、线缆出口、调节角度和抗振。孔位不确定时做槽孔；相机和雷达支架应避免遮挡视场，底座加大接触面积并预留扎带孔或线夹。"
  },
  {
    title: "连杆、转轴、铰链和运动关系参考",
    url: "local://cad-reference/links-joints-kinematics",
    source: "AI-CAD 本地资料库",
    keywords: ["连杆", "转轴", "铰链", "运动", "关节", "轴承", "轴", "装配约束"],
    snippet: "有运动关系的结构应明确固定件、活动件、转轴中心和轴向。CadQuery 模型中保持零件独立，运动关系用 assembly-constraints.json 的 revolute/prismatic/fixed 约束表达，并在 FreeCAD Assembly 中还原；转轴孔应考虑轴承、衬套或螺钉作为销轴。"
  }
];

async function fetchTextWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), webSearchTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Search request failed: HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    const cause = error.cause;
    if (cause?.code || cause?.address || cause?.port) {
      const detail = [cause.code, cause.address, cause.port].filter(Boolean).join(" ");
      error.message = `${error.message} (${detail})`;
    }
    if (!webSearchCurlFallback) throw error;
    try {
      return await fetchTextWithCurl(url, options);
    } catch (curlError) {
      error.message = `${formatFetchError(error)}; curl fallback: ${formatFetchError(curlError)}`;
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithCurl(url, options = {}) {
  const args = [
    "-fsSL",
    "--max-time",
    String(Math.ceil(webSearchTimeoutMs / 1000)),
    "--connect-timeout",
    String(Math.ceil(webSearchTimeoutMs / 1000)),
    "-X",
    options.method || "GET"
  ];
  for (const [name, value] of Object.entries(options.headers || {})) {
    if (/^authorization$/i.test(name)) continue;
    args.push("-H", `${name}: ${value}`);
  }
  let input = null;
  if (options.body !== undefined) {
    input = String(options.body);
    args.push("--data-binary", "@-");
  }
  args.push(url);

  const result = await runProcess("curl", args, {
    cwd: __dirname,
    input,
    timeoutMs: webSearchTimeoutMs + 3000,
    maxBuffer: 300000
  });
  return result.stdout;
}

function formatSearchFailure(error, attempts = []) {
  const message = attempts.length
    ? attempts.map((attempt) => `${attempt.provider}: ${formatFetchError(attempt.error)}`).join("; ")
    : formatFetchError(error);
  return addSearchTroubleshooting(message);
}

function addSearchTroubleshooting(message) {
  if (!looksLikeNetworkTimeout(message)) return message;
  const proxyHint = hasProxyEnv()
    ? "检测到代理环境变量，但目标站点仍超时，请检查代理是否可访问。"
    : "已尝试国内可达搜索源；如仍失败，请检查 DNS/网络或在 .env.local 中配置代理。";
  return `${message}。网络资料搜索无法连接外部搜索服务。${proxyHint}`;
}

function looksLikeNetworkTimeout(message) {
  return /timed out|timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|connection timed out|curl.*28/i.test(String(message || ""));
}

function hasProxyEnv() {
  return [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy"
  ].some((name) => Boolean(process.env[name]));
}

function formatFetchError(error) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  if (code === "UND_ERR_CONNECT_TIMEOUT") return "connection timed out";
  if (error?.name === "AbortError") return `timed out after ${webSearchTimeoutMs}ms`;
  const detail = [code, cause?.address, cause?.port].filter(Boolean).join(" ");
  const message = error?.message || String(error);
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

async function fetchJsonWithTimeout(url, options = {}) {
  const text = await fetchTextWithTimeout(url, options);
  return JSON.parse(text);
}

function parseBingHtml(html) {
  const results = [];
  const blocks = String(html || "").split(/<li[^>]+class="b_algo"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/<div[^>]+class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<p[^>]+class="b_lineclamp\d+"[^>]*>([\s\S]*?)<\/p>/i);
    const url = decodeHtml(titleMatch[1]);
    const result = normalizeSearchResult({
      title: decodeHtml(stripTags(titleMatch[2])),
      url,
      snippet: snippetMatch ? decodeHtml(stripTags(snippetMatch[1])) : "",
      source: hostnameOf(url)
    });
    if (result) results.push(result);
  }
  return dedupeSearchResults(results);
}

function parseSogouHtml(html) {
  const results = [];
  const blocks = String(html || "").split(/<div[^>]+class="vrwrap"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/<h3[^>]+class="vr-title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i);
    if (!titleMatch) continue;
    const dataUrlMatch = block.match(/data-url="([^"]+)"/i);
    const snippetMatch = block.match(/<div[^>]+class="[^"]*(?:fz-mid|str_info|text-layout)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const url = decodeHtml(dataUrlMatch?.[1] || absolutizeUrl(titleMatch[1], "https://www.sogou.com"));
    const result = normalizeSearchResult({
      title: decodeHtml(stripTags(titleMatch[2])),
      url,
      snippet: snippetMatch ? decodeHtml(stripTags(snippetMatch[1])) : "",
      source: hostnameOf(url)
    });
    if (result) results.push(result);
  }
  return dedupeSearchResults(results);
}

function normalizeSearchResult(item) {
  const title = String(item.title || "").replace(/\s+/g, " ").trim();
  const url = String(item.url || "").trim();
  if (!title || !/^(https?:\/\/|local:\/\/)/i.test(url)) return null;
  return {
    title: title.slice(0, 180),
    url,
    source: String(item.source || hostnameOf(url) || "").slice(0, 120),
    snippet: String(item.snippet || "").replace(/\s+/g, " ").trim().slice(0, 500),
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : null
  };
}

function dedupeSearchResults(results) {
  const seen = new Set();
  const deduped = [];
  for (const result of results) {
    const key = result.url.replace(/[?#].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

function publicSearch(search) {
  return {
    enabled: Boolean(search?.enabled),
    provider: search?.provider || webSearchProvider,
    query: search?.query || "",
    searchedAt: search?.searchedAt || null,
    notice: search?.notice || null,
    error: search?.error || null,
    results: (search?.results || []).map((item) => ({
      title: item.title,
      url: item.url,
      source: item.source,
      snippet: item.snippet,
      score: item.score
    }))
  };
}

function formatSearchContextForPrompt(search) {
  if (!search?.enabled) return "Disabled.";
  const publicData = publicSearch(search);
  if (publicData.error) {
    return `Search attempted but failed: ${publicData.error}`;
  }
  const filtered = filterSearchResultsForPlanning(publicData.results);
  if (!filtered.length) {
    return `Search query: ${publicData.query}\nNo useful results were returned.`;
  }
  return JSON.stringify({
    untrusted: true,
    provider: publicData.provider,
    query: publicData.query,
    instruction: "Use only CadQuery/Python modeling patterns from clearly relevant docs, examples, GitHub code, or tutorials. Do not use search results as product requirements, dimensions, or shape instructions unless the user explicitly asked to look up a standard part dimension.",
    results: filtered.map((item) => ({
      title: item.title,
      url: item.url,
      source: item.source,
      snippet: item.snippet.slice(0, 240)
    }))
  }, null, 2);
}

function filterSearchResultsForPlanning(results = []) {
  const usefulWords = [
    "cadquery", "workplane", "cq.", "import cadquery", "python", "github", "example",
    "examples", "documentation", "docs", "cutblind", "hole", "cborehole", "cskhole",
    "slot2d", "fillet", "chamfer", "shell", "union", "cut", "assembly", "constraint",
    "cadquery.readthedocs", "cadquery documentation", "cadquery examples", "建模代码",
    "python代码", "示例代码"
  ];
  const preferredSources = [
    "cadquery.readthedocs.io", "github.com", "github.io", "pypi.org", "readthedocs.io"
  ];
  const noisySources = [
    "bilibili.com", "youtube.com", "amazon.com", "taobao.com", "jd.com", "3d66.com",
    "znzmo.com", "cjcp.cn", "baike.baidu.com", "sohu.com", "zhihu.com", "mohou.com",
    "datasheetarchive.com", "alldatasheet.com"
  ];
  return (results || [])
    .map((item) => {
      const source = String(item.source || hostnameOf(item.url) || "").toLowerCase();
      const text = [item.title, item.snippet, item.url].join(" ").toLowerCase();
      const useful = usefulWords.some((word) => text.includes(word));
      const preferred = preferredSources.some((domain) => source.includes(domain));
      const noisy = noisySources.some((domain) => source.includes(domain));
      return { item, useful, preferred, noisy };
    })
    .filter((entry) => entry.useful && !entry.noisy)
    .sort((a, b) => Number(b.preferred) - Number(a.preferred))
    .map((entry) => entry.item)
    .slice(0, 3);
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function absolutizeUrl(url, base) {
  try {
    return new URL(decodeHtml(url), base).href;
  } catch {
    return url;
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : findLastJsonObject(trimmed);
  if (!candidate.startsWith("{")) {
    throw new Error(`No JSON object returned.\n${text.slice(-2000)}`);
  }
  return JSON.parse(candidate);
}

function findLastJsonObject(text) {
  const candidates = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") inString = true;
      if (char === "{") depth++;
      if (char === "}") depth--;
      if (depth === 0) {
        const candidate = text.slice(start, end + 1);
        try {
          const parsed = JSON.parse(candidate);
          candidates.push({ text: candidate, parsed });
        } catch {
          // Keep scanning; FreeCAD logs contain braces in non-JSON text.
        }
        break;
      }
    }
  }
  const preferred = candidates
    .filter((candidate) => Array.isArray(candidate.parsed.parts) || candidate.parsed.fcstdPath || candidate.parsed.plan)
    .sort((a, b) => b.text.length - a.text.length)[0];
  if (preferred) return preferred.text;
  return candidates.sort((a, b) => b.text.length - a.text.length)[0]?.text || "";
}

function validateAssemblyPlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("Assembly plan must be an object");
  assertAssemblyPartCount(plan.parts);
  for (const part of plan.parts) {
    if (!part.id || !part.name) throw new Error("Each part requires id and name");
    part.id = safePartId(part.id);
    part.name = sanitizeText(part.name, 120);
    part.role = sanitizeText(part.role || "", 240);
    part.mode = part.mode === "standard_part" ? "standard_part" : "generated";
    if (part.mode === "standard_part") {
      part.standardPart = sanitizeStandardPartRequest(part.standardPart || {});
      part.primitives = [];
      part.features = [];
      part.featureTree = [];
    } else {
      if (!Array.isArray(part.primitives) || part.primitives.length === 0) {
        part.primitives = [{ type: "box", size: [10, 10, 10], center: true }];
      }
      if (!Array.isArray(part.features)) part.features = [];
      validatePartComplexity(part);
      part.primitives = part.primitives.map(sanitizePrimitive);
      part.features = part.features.map(sanitizeFeature);
      part.standardPart = null;
    }
    part.pose = normalizePose(part.pose);
    part.inertial = normalizeInertial(part.inertial);
  }
  if (!Array.isArray(plan.relations)) plan.relations = [];
  plan.relations = plan.relations.slice(0, 24).map(sanitizeRelation);
  if (!Array.isArray(plan.joints)) plan.joints = [];
  plan.joints = normalizeJoints(plan.joints, plan.parts);
  if (!Array.isArray(plan.constraints)) plan.constraints = [];
  if (!plan.activePartId || !plan.parts.some((part) => part.id === plan.activePartId)) plan.activePartId = plan.parts[0].id;
  if (plan.activeFeatureId && !plan.parts.some((part) => (part.featureTree || []).some((feature) => feature.id === plan.activeFeatureId))) plan.activeFeatureId = null;
  plan.name = safeSlug(plan.name || "assembly");
  plan.reply = sanitizeText(plan.reply || "", 500);
}

function sanitizeStandardPartRequest(value = {}) {
  const provider = sanitizeText(value.provider || "step.parts", 40);
  if (provider !== "step.parts") throw new Error(`Unsupported standard part provider: ${provider}`);
  const request = {
    provider,
    id: sanitizeText(value.id || "", 120),
    query: sanitizeText(value.query || "", 160),
    category: sanitizeText(value.category || "", 80),
    family: sanitizeText(value.family || "", 80),
    standard: sanitizeText(value.standard || "", 80),
    tag: sanitizeText(value.tag || "", 80),
  };
  if (!request.id && !request.query && !request.category && !request.family && !request.standard && !request.tag) {
    throw new Error("step.parts standard part requires an id, query, or facet");
  }
  return request;
}

function normalizePlanShape(plan) {
  if (plan.plan && typeof plan.plan === "object") {
    Object.assign(plan, plan.plan);
  }
  if (!Array.isArray(plan.parts)) {
    plan.parts = plan.components || plan.objects || plan.items || [];
  }
  for (const part of plan.parts || []) {
    if (!Array.isArray(part.primitives)) {
      if (part.primitive) part.primitives = [part.primitive];
      if (part.shape) part.primitives = [part.shape];
      if (part.geometry) part.primitives = [part.geometry];
    }
    if (!Array.isArray(part.features)) {
      part.features = part.operations || part.modifiers || [];
    }
  }
  if (!Array.isArray(plan.joints)) {
    plan.joints = [];
  }
}

function normalizePose(pose = {}) {
  if (!pose || typeof pose !== "object") return { translate: [0, 0, 0], rotate: [0, 0, 0] };
  return sanitizePose(pose);
}

function normalizeVector(values, fallback) {
  const list = Array.isArray(values) ? values : [];
  return [0, 1, 2].map((index) => Number.isFinite(Number(list[index])) ? Number(list[index]) : fallback);
}

function sanitizeRelation(relation = {}) {
  return {
    type: sanitizeText(relation.type || "reference", 40),
    from: safePartId(relation.from || ""),
    to: safePartId(relation.to || ""),
    description: sanitizeText(relation.description || "", 240)
  };
}

function publicAssembly(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    name: job.plan?.name || null,
    reply: job.plan?.reply || null,
    activePartId: job.plan?.activePartId || null,
    activeFeatureId: job.plan?.activeFeatureId || null,
    currentRevision: job.currentRevision || null,
    relations: job.plan?.relations || [],
    joints: job.plan?.joints || [],
    constraints: job.plan?.constraints || [],
    validation: job.validationReport || null,
    repairAudit: job.repairAudit || [],
    constraintAnalysis: job.constraintReport || null,
    lastRevisionBuild: job.lastRevisionBuild || null,
    engine: job.engine || "cadquery",
    latentLearning: latentTraining.status(),
    outputStrategy: {
      coreRepresentation: "参数化特征计划 + VAE/latent 学习",
      geometryKernel: "CadQuery BREP 几何内核",
      primaryDelivery: "零件 STEP/FCStd 是主要交付文件",
      compatibility: "STL/GLB 用于快速预览；装配能力处于第二阶段",
      freeCadRole: "FreeCAD FCStd 是可继续编辑的交付文件；VAE/latent 用于学习建模结构和失败模式"
    },
    freeCadBridgeReport: job.freeCadBridgeReport || null,
    parts: (job.parts || []).map((part) => ({
      id: part.id,
      name: part.name,
      role: part.role,
      mode: part.mode || "generated",
      standardPart: part.standardPart || null,
      pose: part.pose,
      primitives: part.primitives,
      features: part.features,
      featureTree: part.featureTree || [],
      featureTrace: part.featureTrace || [],
      geometryValidation: part.geometryValidation || null,
      inertial: part.inertial || null,
      stepUrl: part.stepUrl,
      stlUrl: part.stlUrl,
      pngUrl: part.pngUrl
    })),
    fcstdUrl: job.fcstdPath && existsSync(job.fcstdPath) ? artifactUrl(job, job.fcstdPath) : null,
    stepUrl: job.stepPath && existsSync(job.stepPath) ? artifactUrl(job, job.stepPath) : null,
    stlUrl: job.stlPath && existsSync(job.stlPath) ? artifactUrl(job, job.stlPath) : null,
    glbUrl: job.glbPath && existsSync(job.glbPath) ? artifactUrl(job, job.glbPath) : null,
    glbWarning: job.glbWarning || null,
    kinematicsUrl: job.kinematicsPath && existsSync(job.kinematicsPath) ? `/assemblies/${job.id}/${path.basename(job.kinematicsPath)}` : null,
    constraintManifestUrl: job.constraintManifestPath && existsSync(job.constraintManifestPath) ? `/assemblies/${job.id}/${path.basename(job.constraintManifestPath)}` : null,
    kinematicPackageUrl: job.kinematicArchivePath && existsSync(job.kinematicArchivePath) ? `/assemblies/${job.id}/${path.basename(job.kinematicArchivePath)}` : null,
    manifestUrl: job.manifestPath && existsSync(job.manifestPath) ? `/assemblies/${job.id}/${path.basename(job.manifestPath)}` : null,
    visualReview: publicVisualReview(job.visualReview),
    acceptance: assemblyAcceptanceGate(job),
    error: job.error || null
  };
}

function assemblyAcceptanceGate(job) {
  const validation = job?.validationReport || {};
  const geometryPassed = job?.status === "done" && canPromoteRevision(validation);
  const visualCurrent = Boolean(job?.visualReview?.revisionId && String(job.visualReview.revisionId) === String(job.currentRevision));
  const visualPassed = visualCurrent && (job.visualReview?.status === "pass" || job.visualReview?.recommendedNextAction === "accept");
  return {
    passed: geometryPassed && visualPassed,
    geometry: {
      passed: geometryPassed,
      errors: Number(validation.blockingErrorCount || 0),
      blockingErrorCount: Number(validation.blockingErrorCount || 0),
      status: job?.status || "unknown",
      revisionId: validation.revisionId || job?.currentRevision || null
    },
    visual: {
      passed: visualPassed,
      current: visualCurrent,
      status: job?.visualReview?.status || "pending",
      recommendedNextAction: job?.visualReview?.recommendedNextAction || "pending",
      revisionId: job?.visualReview?.revisionId || null
    }
  };
}

function publicVisualReview(review) {
  if (!review) return null;
  return {
    assemblyId: review.assemblyId,
    revisionId: review.revisionId || null,
    status: review.status,
    summary: review.summary,
    findings: review.findings || [],
    recommendedNextAction: review.recommendedNextAction,
    screenshots: (review.screenshots || []).map((item) => ({
      view: item.view,
      name: item.name,
      url: item.url || null
    })),
    reviewedAt: review.reviewedAt,
    improvement: review.improvement || null,
    jsonUrl: review.jsonUrl || null,
    mdUrl: review.mdUrl || null
  };
}

function normalizeInertial(inertial) {
  if (!inertial || typeof inertial !== "object") return null;
  const mass = Number(inertial.mass);
  if (!Number.isFinite(mass) || mass <= 0) return null;
  const inertia = inertial.inertia || {};
  return {
    mass,
    origin: {
      xyz: normalizeVector(inertial.origin?.xyz, 0),
      rpy: normalizeVector(inertial.origin?.rpy, 0)
    },
    inertia: {
      ixx: finiteNumber(inertia.ixx, mass * 0.001),
      ixy: finiteNumber(inertia.ixy, 0),
      ixz: finiteNumber(inertia.ixz, 0),
      iyy: finiteNumber(inertia.iyy, mass * 0.001),
      iyz: finiteNumber(inertia.iyz, 0),
      izz: finiteNumber(inertia.izz, mass * 0.001)
    }
  };
}

function normalizeJoints(joints, parts) {
  const partIds = new Set((parts || []).map((part) => part.id));
  return (joints || [])
    .map((joint, index) => {
      const child = String(joint.child || joint.to || "").trim();
      if (!child || !partIds.has(child)) return null;
      const parent = String(joint.parent || joint.from || "world").trim() || "world";
      const type = normalizeJointType(joint.type);
      const normalized = {
        id: safeKinematicName(joint.id || `${parent}_${child}_${type}_${index}`),
        type,
        parent: parent === "world" || partIds.has(parent) ? parent : "world",
        child,
        origin: {
          xyz: normalizeVector(joint.origin?.xyz || joint.xyz, 0),
          rpy: normalizeVector(joint.origin?.rpy || joint.rpy, 0)
        },
        axis: normalizeAxis(joint.axis)
      };
      if (type === "revolute" || type === "prismatic") {
        normalized.limit = normalizeLimit(joint.limit, type);
      }
      return normalized;
    })
    .filter(Boolean);
}

function normalizeJointType(value) {
  const type = String(value || "fixed").toLowerCase();
  return ["fixed", "revolute", "continuous", "prismatic"].includes(type) ? type : "fixed";
}

function normalizeAxis(values) {
  const axis = normalizeVector(values, 0);
  return axis.some((value) => value !== 0) ? axis : [0, 0, 1];
}

function normalizeLimit(limit = {}, type) {
  return {
    lower: finiteNumber(limit.lower, type === "prismatic" ? -0.1 : -1.57),
    upper: finiteNumber(limit.upper, type === "prismatic" ? 0.1 : 1.57),
    effort: finiteNumber(limit.effort, 1),
    velocity: finiteNumber(limit.velocity, 1)
  };
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function ensureAssemblyFcstd(job) {
  if (!job.kinematicPackagePath || !existsSync(job.kinematicPackagePath)) {
    job.kinematics = await buildKinematicPackage(job);
    job.kinematicsPath = job.kinematics.kinematicsPath;
    job.constraintManifestPath = job.kinematics.constraintsPath;
    job.kinematicPackagePath = job.kinematics.packagePath;
    job.kinematicArchivePath = job.kinematics.archivePath;
  }
  const scriptPath = path.join(job.kinematicPackagePath, "open_in_freecad.py");
  if (!existsSync(scriptPath)) {
    throw new Error("FreeCAD bridge script is missing from the kinematic package");
  }

  const fcstdPath = path.join(job.kinematicPackagePath, "ai_cad_assembly.FCStd");
  let shouldBuild = !existsSync(fcstdPath);
  if (!shouldBuild) {
    const [fcstdInfo, scriptInfo] = await Promise.all([stat(fcstdPath), stat(scriptPath)]);
    shouldBuild = fcstdInfo.mtimeMs < scriptInfo.mtimeMs;
  }
  if (shouldBuild) {
    const result = await runProcess(freecadCmd, [scriptPath], {
      cwd: job.kinematicPackagePath,
      timeoutMs: 120000,
      maxBuffer: 500000
    });
    job.freeCadBridgeLog = {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim()
    };
    try {
      job.freeCadBridgeReport = extractJsonObject(result.stdout);
    } catch {
      job.freeCadBridgeReport = null;
    }
  }
  if (!existsSync(fcstdPath)) {
    throw new Error("FreeCAD bridge did not produce ai_cad_assembly.FCStd");
  }
  job.fcstdPath = fcstdPath;
  return { fcstdPath, scriptPath };
}

async function buildKinematicPackage(job) {
  const outDir = job.outputDir || path.join(assemblyDir, job.id);
  const packagePath = path.join(outDir, "assembly_kinematic_package");
  const partsPath = path.join(packagePath, "parts");
  const localPartsPath = path.join(partsPath, "local");
  const placedPartsPath = path.join(partsPath, "placed");
  const meshesPath = path.join(packagePath, "meshes");
  const metadataPath = path.join(packagePath, "metadata");
  await rm(packagePath, { recursive: true, force: true });
  await mkdir(localPartsPath, { recursive: true });
  await mkdir(placedPartsPath, { recursive: true });
  await mkdir(meshesPath, { recursive: true });
  await mkdir(metadataPath, { recursive: true });

  const packageParts = [];
  for (const part of job.parts || []) {
    const partId = safeSlug(part.id || part.name || "part");
    const localStep = part.localStepPath && existsSync(part.localStepPath) ? part.localStepPath : null;
    const placedStep = part.stepPath && existsSync(part.stepPath) ? part.stepPath : null;
    const localStl = part.localStlPath && existsSync(part.localStlPath) ? part.localStlPath : null;
    const placedStl = part.stlPath && existsSync(part.stlPath) ? part.stlPath : null;
    const targetName = `${partId || "part"}.step`;
    const meshName = `${partId || "part"}.stl`;
    if (localStep) {
      await copyFile(localStep, path.join(localPartsPath, targetName));
    }
    if (placedStep) {
      await copyFile(placedStep, path.join(placedPartsPath, targetName));
    }
    if (localStl || placedStl) {
      await copyFile(localStl || placedStl, path.join(meshesPath, meshName));
    }
    packageParts.push({
      id: part.id,
      name: part.name,
      role: part.role,
      mode: part.mode || "generated",
      standardPart: part.standardPart || null,
      pose: normalizePose(part.pose),
      primitives: part.primitives || [],
      features: part.features || [],
      featureTree: part.featureTree || [],
      revisionId: job.pendingRevision || job.currentRevision || null,
      localStepFile: localStep ? `parts/local/${targetName}` : null,
      placedStepFile: placedStep ? `parts/placed/${targetName}` : null,
      meshFile: localStl || placedStl ? `meshes/${meshName}` : null
    });
  }

  if (job.stepPath && existsSync(job.stepPath)) {
    await copyFile(job.stepPath, path.join(packagePath, "assembly.step"));
    await copyFile(job.stepPath, path.join(packagePath, "freecad_assembly.step"));
  }
  if (job.stlPath && existsSync(job.stlPath)) {
    await copyFile(job.stlPath, path.join(packagePath, "assembly.stl"));
  }
  if (job.manifestPath && existsSync(job.manifestPath)) {
    await copyFile(job.manifestPath, path.join(metadataPath, "assembly-manifest.json"));
    await copyFile(job.manifestPath, path.join(packagePath, "assembly-manifest.json"));
  }

  const relations = job.plan?.relations || [];
  const joints = job.plan?.joints || [];
  const effectiveJoints = buildEffectiveJoints(joints, packageParts.map((part) => ({
    id: part.id,
    linkName: safeKinematicName(part.id),
    pose: part.pose
  })));
  const mates = buildPackageMates({ parts: packageParts, relations, joints, effectiveJoints });
  const constraints = buildAssemblyConstraintManifest({
    assemblyName: job.plan?.name || "AI_CAD_Assembly",
    parts: packageParts,
    relations,
    joints,
    effectiveJoints,
    constraints: job.plan?.constraints || []
  });
  const audit = buildPackageAudit({ job, packageParts, relations, joints, effectiveJoints, mates });
  const kinematics = {
    format: "ai-cad-kinematics-v2",
    note: "assembly.step stores BREP geometry and static placements. Editable CAD motion mates are stored as package metadata (assembly-constraints.json, mates.md) because this CadQuery/OCC STEP exporter does not write editable AP242 kinematic joints.",
    assembly: {
      name: job.plan?.name || "AI_CAD_Assembly",
      stepFile: job.stepPath && existsSync(job.stepPath) ? "assembly.step" : null,
      freecadStepFile: job.stepPath && existsSync(job.stepPath) ? "freecad_assembly.step" : null,
      stlFile: job.stlPath && existsSync(job.stlPath) ? "assembly.stl" : null,
      manifestFile: job.manifestPath && existsSync(job.manifestPath) ? "assembly-manifest.json" : null,
      partCount: packageParts.length,
      relationCount: relations.length,
      explicitJointCount: joints.length,
      effectiveJointCount: effectiveJoints.length,
      units: {
        cad: "mm",
        poseRotation: "deg",
        jointTranslation: "m",
        jointRotation: "rad"
      }
    },
    parts: packageParts,
    relations,
    joints,
    effectiveJoints,
    mates,
    constraintManifest: "assembly-constraints.json",
    audit
  };

  const kinematicsPath = path.join(outDir, "assembly-kinematics.json");
  const packageKinematicsPath = path.join(packagePath, "assembly-kinematics.json");
  const packageManifestPath = path.join(packagePath, "manifest.json");
  const constraintsPath = path.join(outDir, "assembly-constraints.json");
  const packageConstraintsPath = path.join(packagePath, "assembly-constraints.json");
  const readmePath = path.join(packagePath, "README.txt");
  const freecadScriptPath = path.join(packagePath, "open_in_freecad.py");
  const packageFcstdPath = path.join(packagePath, "ai_cad_assembly.FCStd");
  await writeFile(kinematicsPath, JSON.stringify(kinematics, null, 2), "utf8");
  await writeFile(packageKinematicsPath, JSON.stringify(kinematics, null, 2), "utf8");
  await writeFile(constraintsPath, JSON.stringify(constraints, null, 2), "utf8");
  await writeFile(packageConstraintsPath, JSON.stringify(constraints, null, 2), "utf8");
  await writeFile(path.join(metadataPath, "relations.json"), JSON.stringify(relations, null, 2), "utf8");
  await writeFile(path.join(metadataPath, "joints.json"), JSON.stringify(joints, null, 2), "utf8");
  await writeFile(path.join(metadataPath, "effective-joints.json"), JSON.stringify(effectiveJoints, null, 2), "utf8");
  await writeFile(path.join(metadataPath, "mates.json"), JSON.stringify(mates, null, 2), "utf8");
  await writeFile(path.join(metadataPath, "assembly-constraints.json"), JSON.stringify(constraints, null, 2), "utf8");
  await writeFile(path.join(metadataPath, "package-audit.json"), JSON.stringify(audit, null, 2), "utf8");
  await writeFile(path.join(packagePath, "mates.md"), renderMatesMarkdown(kinematics), "utf8");
  await writeFile(packageManifestPath, JSON.stringify({
    format: "ai-cad-step-package-v2",
    createdAt: new Date().toISOString(),
    assembly: kinematics.assembly,
    parts: packageParts,
    relations: kinematics.relations,
    joints: kinematics.joints,
    effectiveJoints: kinematics.effectiveJoints,
    mates: kinematics.mates,
    constraintsFile: "assembly-constraints.json",
    audit: kinematics.audit
  }, null, 2), "utf8");
  await writeFile(freecadScriptPath, renderFreeCadOpenScript(), "utf8");
  await rm(packageFcstdPath, { force: true });
  await writeFile(readmePath, [
    "AI-CAD complete STEP assembly package",
    "",
    "Open in FreeCAD:",
    "- Open `freecad_assembly.step` directly for the complete static assembly.",
    "- Or run `freecadcmd open_in_freecad.py` to create `ai_cad_assembly.FCStd` with each placed part visible as the primary assembly and the complete STEP kept as a hidden reference.",
    "",
    "Contents:",
    "- freecad_assembly.step: recommended complete BREP assembly STEP for FreeCAD.",
    "- assembly.step: same complete BREP assembly, kept for compatibility.",
    "- parts/local/*.step: every individual part in its own local coordinates for editing.",
    "- parts/placed/*.step: every individual part already transformed to its assembly placement.",
    "- meshes/*.stl: per-part STL meshes for viewers and downstream tooling.",
    "- assembly-manifest.json: original AI-CAD feature plan, part list, relations, and joints.",
    "- assembly-kinematics.json: AI-CAD relation/joint semantics and unit declarations.",
    "- assembly-constraints.json: bridge-layer constraint manifest consumed by open_in_freecad.py.",
    "- mates.md: human-readable mate, relation, and joint index.",
    "- metadata/*.json: machine-readable relations, joints, effective joints, mates, and package audit files.",
    "- manifest.json: package index with all included files.",
    "- open_in_freecad.py: bridge script that imports placed part STEP files as visible FreeCAD objects, keeps the complete STEP hidden as a reference, reads assembly-constraints.json, and creates FreeCAD Assembly/Joint objects when the installed FreeCAD API supports them.",
    "",
    "Important:",
    "- Standard STEP importers reliably preserve geometry hierarchy and static placements.",
    "- Editable CAD motion mates are not reliably written by the CadQuery/OCC STEP exporter as AP242 kinematic constraints.",
    "- Codex is expected to produce geometry and relationship JSON only; this bridge script owns FreeCAD Assembly API calls.",
    "- Use assembly-constraints.json, mates.md, assembly-kinematics.json, or open_in_freecad.py for relationship and joint semantics.",
    "",
    "FreeCAD:",
    "Open `freecad_assembly.step` if you only need one combined geometry reference. Run `freecadcmd open_in_freecad.py` from this folder to create ai_cad_assembly.FCStd with visible per-part geometry and metadata.",
    ""
  ].join("\n"), "utf8");

  const archivePath = path.join(outDir, "assembly_kinematic_package.zip");
  await runProcess("zip", ["-qr", archivePath, "assembly_kinematic_package"], {
    cwd: outDir,
    timeoutMs: 30000,
    maxBuffer: 50000
  });

  return {
    kinematicsPath,
    constraintsPath,
    packagePath,
    archivePath
  };
}


function buildEffectiveJoints(planJoints, parts) {
  const available = new Set(parts.map((part) => part.id));
  const claimed = new Set();
  const joints = [];
  for (const joint of planJoints || []) {
    if (!available.has(joint.child)) continue;
    const parent = joint.parent === "world" || available.has(joint.parent) ? joint.parent : "world";
    claimed.add(joint.child);
    joints.push({
      ...joint,
      id: safeKinematicName(joint.id || `${parent}_${joint.child}_${joint.type}`),
      parent,
      child: joint.child,
      parentLink: parent === "world" ? "world" : safeKinematicName(parent),
      childLink: safeKinematicName(joint.child)
    });
  }
  for (const part of parts) {
    if (claimed.has(part.id)) continue;
    const pose = normalizePose(part.pose);
    joints.push({
      id: `${part.linkName}_fixed`,
      type: "fixed",
      parent: "world",
      child: part.id,
      parentLink: "world",
      childLink: part.linkName,
      origin: {
        xyz: pose.translate.map((value) => value / 1000),
        rpy: pose.rotate.map((value) => value * Math.PI / 180)
      },
      axis: [0, 0, 1]
    });
  }
  return joints;
}


function safeKinematicName(value) {
  return safeSlug(value).replaceAll("-", "_") || "item";
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'sha256-nAG3xy0rRET2ecuPDHRx6qjQE+p+98x1xfv8G0NqT2c='",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:*",
    "frame-src 'self' http://127.0.0.1:* http://localhost:*",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join("; "));
}

function isAllowedMethod(method) {
  return ["GET", "HEAD", "POST"].includes(String(method || "").toUpperCase());
}

function validateApiRequest(req) {
  if (!isStateChangingMethod(req.method)) return { ok: true };
  if (!isAllowedOriginHeader(req.headers.origin, { host, port })) {
    return { ok: false, status: 403, error: "Origin is not allowed" };
  }
  if (!isValidRequestToken(req.headers["x-ai-cad-token"], requestToken)) {
    return { ok: false, status: 403, error: "Invalid request token" };
  }
  return { ok: true };
}

function isPublicHost(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function isLocalRequest(req) {
  const address = req.socket?.remoteAddress || "";
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
    || address === "localhost";
}

function validateCommandPath(value, envName) {
  const command = String(value || "").trim();
  if (!command) throw new Error(`${envName} is empty`);
  if (/[\s;&|`$<>(){}[\]\\'"!*?]/.test(command)) {
    throw new Error(`${envName} contains unsafe characters`);
  }
  if (command.includes("..")) {
    throw new Error(`${envName} must not contain parent directory segments`);
  }
  return command;
}

function publicCommandName(command) {
  const value = String(command || "");
  if (!value.includes("/")) return value;
  if (value.startsWith(__dirname)) return path.relative(__dirname, value);
  return path.basename(value);
}

function safeRoutePath(rootDir, routePath, prefix) {
  const raw = String(routePath || "");
  if (raw.includes("\0")) throw new Error("Invalid path");
  const relativeUrlPath = prefix === "/"
    ? raw.replace(/^\/+/, "")
    : raw.slice(prefix.length);
  let decoded;
  try {
    decoded = decodeURIComponent(relativeUrlPath);
  } catch {
    throw new Error("Invalid path encoding");
  }
  if (decoded.includes("\0")) throw new Error("Invalid path");
  const resolved = path.resolve(rootDir, decoded);
  assertInsideRoot(resolved, rootDir);
  return resolved;
}

function assertInsideRoot(filePath, rootDir) {
  const relative = path.relative(path.resolve(rootDir), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes allowed directory");
  }
}

function safeSlug(value) {
  return String(value || "item")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "item";
}

async function serveFile(res, filePath, rootDir) {
  const normalized = path.resolve(filePath);
  try {
    assertInsideRoot(normalized, rootDir);
  } catch {
    return json(res, 404, { error: "Not found" });
  }
  if (!existsSync(normalized)) {
    return json(res, 404, { error: "Not found" });
  }

  const ext = path.extname(normalized);
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" || ext === ".css" || ext === ".js" ? "no-store" : "public, max-age=60"
  });
  createReadStream(normalized).pipe(res);
}

async function readJson(req) {
  const contentType = String(req.headers["content-type"] || "");
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > maxJsonBodyBytes) {
      req.destroy();
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function buildChildEnv(source) {
  const env = {};
  const allowed = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "AI_CAD_CADQUERY_MANIFEST",
    "FREECAD_CMD",
    "CADQUERY_PYTHON",
    "QT_QPA_PLATFORM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "TAVILY_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_HOME",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT"
  ];
  for (const name of allowed) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || __dirname,
      env: buildChildEnv(options.env || process.env),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      settled = true;
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs || 30000);

    const maxBuffer = options.maxBuffer || 120000;
    child.stdout.on("data", (data) => {
      stdout += data.toString();
      if (stdout.length > maxBuffer) stdout = stdout.slice(-maxBuffer);
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) return resolve({ stdout, stderr });
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      reject(new Error(`${command} exited with ${reason}\n${stderr || stdout}`));
    });
  });
}
