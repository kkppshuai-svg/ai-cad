import { CadViewer } from "./cad-viewer.js";
import { createApiClient } from "./api-client.js";
import { createFSB } from "./fsb.js";

const state = {
  conversationId: localStorage.getItem("ai-cad-conversation-id") || crypto.randomUUID(),
  messages: JSON.parse(localStorage.getItem("ai-cad-chat") || "[]"),
  webSearchEnabled: localStorage.getItem("ai-cad-web-search-enabled") === "true" && localStorage.getItem("ai-cad-web-search-user-set") === "true",
  webSearchQuery: localStorage.getItem("ai-cad-web-search-query") || "",
  requestToken: "",
  lastSearch: null,
  currentJobId: null,
  currentAssembly: null,
  currentPlan: null,
  currentVisualReview: null,
  visualImprovementBusy: false,
  autoReviewRunning: false,
  trainingMode: localStorage.getItem("ai-cad-training-mode") === "true",
  trainingRunning: false,
  trainingStopRequested: false,
  trainingSession: null,
  loadedAssemblyModelKey: "",
  activePartId: null,
  activeFeatureId: null,
  parametricTree: null,
  revisions: [],
  validationReport: null,
  previewSeq: 0,
  renderTimer: null,
  autoRenderReady: false,
  currentStlUrl: "",
  viewMode: "assembly",
  viewPreset: "free",
  wireframe: false,
  ghostMode: false,
  angleX: -0.7,
  angleY: 0.55,
  angleZ: 0,
  zoom: 1,
  pendingImages: []
  ,chatAbortController: null
};

const fsb = createFSB({ getState: () => state, onRender: ({ snapshot, event }) => renderFSB(snapshot, event) });
window.aiCadFSB = fsb;

// 预设视角：正交三视图按欧拉角锁定（先 Z 后 Y 再 X），free 为自由透视。
const VIEW_PRESETS = {
  free: { angleX: -0.7, angleY: 0.55, angleZ: 0, ortho: false },
  front: { angleX: -Math.PI / 2, angleY: 0, angleZ: 0, ortho: true },
  top: { angleX: 0, angleY: 0, angleZ: 0, ortho: true },
  side: { angleX: -Math.PI / 2, angleY: 0, angleZ: -Math.PI / 2, ortho: true }
};

const MAX_CHAT_IMAGES = 3;
const MAX_CHAT_IMAGE_EDGE = 1280;
const LAST_ASSEMBLY_KEY = "ai-cad-last-assembly-id";

localStorage.setItem("ai-cad-conversation-id", state.conversationId);
localStorage.removeItem("ai-cad-manufacturing-enabled");
localStorage.removeItem("ai-cad-manufacturing-mode");

const els = {
  engineStatus: document.querySelector("#engineStatus"),
  latentStatus: document.querySelector("#latentStatus"),
  chatHistory: document.querySelector("#chatHistory"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  chatImageInput: document.querySelector("#chatImageInput"),
  attachImageBtn: document.querySelector("#attachImageBtn"),
  chatImagePreview: document.querySelector("#chatImagePreview"),
  webSearchEnabled: document.querySelector("#webSearchEnabled"),
  webSearchQuery: document.querySelector("#webSearchQuery"),
  searchResults: document.querySelector("#searchResults"),
  trainingModeEnabled: document.querySelector("#trainingModeEnabled"),
  trainingStopBtn: document.querySelector("#trainingStopBtn"),
  trainingStatus: document.querySelector("#trainingStatus"),
  sendChatBtn: document.querySelector("#sendChatBtn"),
  resetChatBtn: document.querySelector("#resetChatBtn"),
  code: document.querySelector("#code"),
  activePartName: document.querySelector("#activePartName"),
  renderBtn: document.querySelector("#renderBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  renderState: document.querySelector("#renderState"),
  jobId: document.querySelector("#jobId"),
  previewImage: document.querySelector("#previewImage"),
  emptyPreview: document.querySelector("#emptyPreview"),
  viewerStats: document.querySelector("#viewerStats"),
  viewAssemblyBtn: document.querySelector("#viewAssemblyBtn"),
  viewPartBtn: document.querySelector("#viewPartBtn"),
  view3dBtn: document.querySelector("#view3dBtn"),
  viewFrontBtn: document.querySelector("#viewFrontBtn"),
  viewTopBtn: document.querySelector("#viewTopBtn"),
  viewSideBtn: document.querySelector("#viewSideBtn"),
  resetViewBtn: document.querySelector("#resetViewBtn"),
  wireframeBtn: document.querySelector("#wireframeBtn"),
  hidePartBtn: document.querySelector("#hidePartBtn"),
  isolatePartBtn: document.querySelector("#isolatePartBtn"),
  showAllPartsBtn: document.querySelector("#showAllPartsBtn"),
  ghostModeBtn: document.querySelector("#ghostModeBtn"),
  downloadLink: document.querySelector("#downloadLink"),
  fcstdLink: document.querySelector("#fcstdLink"),
  stepLink: document.querySelector("#stepLink"),
  assemblyStlLink: document.querySelector("#assemblyStlLink"),
  kinematicPackageLink: document.querySelector("#kinematicPackageLink"),
  constraintsLink: document.querySelector("#constraintsLink"),
  manifestLink: document.querySelector("#manifestLink"),
  visualReviewBtn: document.querySelector("#visualReviewBtn"),
  visualReviewPanel: document.querySelector("#visualReviewPanel"),
  visualReviewStatus: document.querySelector("#visualReviewStatus"),
  visualReviewSummary: document.querySelector("#visualReviewSummary"),
  visualAcceptanceStatus: document.querySelector("#visualAcceptanceStatus"),
  visualReviewFindings: document.querySelector("#visualReviewFindings"),
  visualImproveBtn: document.querySelector("#visualImproveBtn"),
  visualImproveStatus: document.querySelector("#visualImproveStatus"),
  visualImprovementTrace: document.querySelector("#visualImprovementTrace"),
  partsList: document.querySelector("#partsList"),
  relationsList: document.querySelector("#relationsList"),
  featureTreePanel: document.querySelector("#featureTreePanel"),
  featureTreeList: document.querySelector("#featureTreeList"),
  revisionList: document.querySelector("#revisionList"),
  validationSummary: document.querySelector("#validationSummary"),
  repairStatus: document.querySelector("#repairStatus"),
  validationStages: document.querySelector("#validationStages"),
  validationMeasurements: document.querySelector("#validationMeasurements"),
  validationIssues: document.querySelector("#validationIssues"),
  dofSummary: document.querySelector("#dofSummary"),
  revertRevisionBtn: document.querySelector("#revertRevisionBtn"),
  log: document.querySelector("#log"),
  canvas: document.querySelector("#viewer"),
  ratingPanel: document.querySelector("#ratingPanel"),
  ratingForm: document.querySelector("#ratingForm"),
  submitRatingBtn: document.querySelector("#submitRatingBtn"),
  ratingAssemblyName: document.querySelector("#ratingAssemblyName"),
  ratingAssemblyId: document.querySelector("#ratingAssemblyId"),
  ratingComment: document.querySelector("#ratingComment"),
  ratingStatus: document.querySelector("#ratingStatus"), cancelChatBtn: document.querySelector("#cancelChatBtn"), processTrace: document.querySelector("#processTrace"), processTraceStatus: document.querySelector("#processTraceStatus")
  ,fsbStatus: document.querySelector("#fsbStatus"), fsbSnapshot: document.querySelector("#fsbSnapshot"), fsbEvents: document.querySelector("#fsbEvents"), fsbClear: document.querySelector("#fsbClear"), fbsRequirementSummary: document.querySelector("#fbsRequirementSummary"), fbsFunctionSummary: document.querySelector("#fbsFunctionSummary"), fbsBehaviorSummary: document.querySelector("#fbsBehaviorSummary"), fbsStructureSummary: document.querySelector("#fbsStructureSummary"), fbsCriteriaSummary: document.querySelector("#fbsCriteriaSummary")
};

const gl = null;
const ctx2d = null;
let mesh = null;
let shader = null;
let cadViewer = null;

const api = createApiClient({
  getToken: () => state.requestToken,
  setToken: (token) => { state.requestToken = token; }
});

init();

async function init() {
  wireEvents();
  setupEventStream();
  setupViewer();
  renderChat();
  els.webSearchEnabled.checked = state.webSearchEnabled;
  els.webSearchQuery.value = state.webSearchQuery;
  els.trainingModeEnabled.checked = state.trainingMode;
  renderTrainingStatus();
  renderSearchResults();
  renderFSB(fsb.snapshot());
  hydrateFBS();

  try {
    const status = await api("/api/status");
    state.requestToken = status.requestToken || "";
    const searchLabel = status.webSearch?.provider ? ` | 搜索: ${status.webSearch.provider}` : "";
    const freecadLabel = status.freecadCmd ? ` | FreeCADCmd: ${status.freecadCmd}` : "";
    const codexModelLabel = status.codexModel ? ` · ${status.codexModel}` : "";
    const llmLabel = status.llm?.provider === "deepseek" && status.llm?.deepseek?.active
      ? ` | DeepSeek: ${status.llm.deepseek.model}${status.llm.deepseek.vision ? " · vision" : ""}${status.llm.strict ? " · strict" : ""}`
      : ` | Codex: ${status.codexBin}${codexModelLabel}`;
    els.engineStatus.textContent = `CadQuery: ${status.cadqueryPython}${llmLabel}${freecadLabel}${searchLabel}`;
    renderLatentStatus(status.latentLearning);
    els.code.value = localStorage.getItem("ai-cad-code") || "// CadQuery 特征 JSON 会在对话生成后显示在这里";
    state.autoRenderReady = true;
    await restoreLastAssembly();
    await restoreTrainingCheckpoint();
  } catch (error) {
    setError(error);
  }
}

async function restoreTrainingCheckpoint() {
  const conversationId = state.conversationId || localStorage.getItem("ai-cad-conversation-id") || "";
  if (!conversationId || state.trainingRunning) return;
  const result = await api(`/api/training/session?conversationId=${encodeURIComponent(conversationId)}`).catch(() => null);
  const session = result?.session;
  if (!session || !state.currentAssembly || session.assemblyId !== state.currentAssembly.id) return;
  state.trainingSession = session;
  setTrainingStatus("warning", `检测到未完成训练：已完成 ${session.rounds?.length || 0} 轮，正在从检查点继续。`);
  els.trainingModeEnabled.checked = true;
  state.trainingMode = true;
  renderTrainingStatus();
  void runTrainingLoop({ request: session.request || "继续训练", assembly: state.currentAssembly, resumeSession: session });
}

function wireEvents() {
  els.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendChat();
  });
  els.resetChatBtn.addEventListener("click", resetChat);
  els.attachImageBtn.addEventListener("click", () => els.chatImageInput.click());
  els.chatImageInput.addEventListener("change", async () => {
    try {
      await addChatImages(els.chatImageInput.files);
    } catch (error) {
      els.log.textContent = `读取图片失败：${error.message || error}`;
    } finally {
      els.chatImageInput.value = "";
    }
  });
  els.webSearchEnabled.addEventListener("change", () => {
    state.webSearchEnabled = els.webSearchEnabled.checked;
    localStorage.setItem("ai-cad-web-search-enabled", String(state.webSearchEnabled));
    localStorage.setItem("ai-cad-web-search-user-set", "true");
    renderSearchResults();
  });
  els.webSearchQuery.addEventListener("input", () => {
    state.webSearchQuery = els.webSearchQuery.value;
    localStorage.setItem("ai-cad-web-search-query", state.webSearchQuery);
  });
  els.trainingModeEnabled.addEventListener("change", () => {
    state.trainingMode = els.trainingModeEnabled.checked;
    localStorage.setItem("ai-cad-training-mode", String(state.trainingMode));
    renderTrainingStatus();
  });
  els.trainingStopBtn.addEventListener("click", () => {
    state.trainingStopRequested = true;
    els.trainingStatus.textContent = "将在当前审查或构建完成后停止。";
    updateTrainingControls();
  });
  els.cancelChatBtn.addEventListener("click", cancelChat);
  els.code.addEventListener("input", () => {
    localStorage.setItem("ai-cad-code", els.code.value);
    scheduleRender();
  });
  els.renderBtn.addEventListener("click", () => previewCadQuery({ force: true }));
  els.exportBtn.addEventListener("click", () => previewCadQuery({ force: true, download: true }));
  window.addEventListener("resize", () => cadViewer?.resize());
  els.viewAssemblyBtn.addEventListener("click", showAssemblyStl);
  els.viewPartBtn.addEventListener("click", showActivePartStl);
  els.view3dBtn.addEventListener("click", () => setViewPreset("free"));
  els.viewFrontBtn.addEventListener("click", () => setViewPreset("front"));
  els.viewTopBtn.addEventListener("click", () => setViewPreset("top"));
  els.viewSideBtn.addEventListener("click", () => setViewPreset("side"));
  els.resetViewBtn.addEventListener("click", resetView);
  els.visualReviewBtn.addEventListener("click", () => runAutomaticReviewLoop({ request: "审查当前装配并根据报告自动修复，直到几何与视觉验收通过", assembly: state.currentAssembly }));
  els.visualImproveBtn.addEventListener("click", improveFromVisualReview);
  els.visualReviewFindings.addEventListener("click", (event) => {
    const target = event.target.closest("[data-review-target]");
    if (!target) return;
    focusReviewFinding(target.dataset.partId, target.dataset.featureId || null);
  });
  els.revertRevisionBtn.addEventListener("click", revertSelectedRevision);
  els.ratingForm.addEventListener("submit", submitRating);
  els.wireframeBtn.addEventListener("click", () => {
    state.wireframe = !state.wireframe;
    els.wireframeBtn.classList.toggle("active", state.wireframe);
    cadViewer?.setWireframe(state.wireframe);
  });
  els.hidePartBtn.addEventListener("click", () => cadViewer?.hideSelected());
  els.isolatePartBtn.addEventListener("click", () => cadViewer?.isolateSelected());
  els.showAllPartsBtn.addEventListener("click", () => cadViewer?.showAll());
  els.ghostModeBtn.addEventListener("click", () => {
    state.ghostMode = !state.ghostMode;
    cadViewer?.setGhostMode(state.ghostMode);
    updateViewerControls();
  });
}

function fbsLabels(items) { return (items || []).map((item) => typeof item === "string" ? item : item?.label).filter(Boolean); }
function fbsSummary(items, empty) { const labels = fbsLabels(items); return labels.length ? labels.slice(0, 3).join(" · ") : empty; }
function hydrateFBS() {
  const d = fsb.document();
  els.fbsRequirementSummary.textContent = d.requirements || "等待工程需求";
  els.fbsFunctionSummary.textContent = fbsSummary(d.functions, "待分析");
  els.fbsBehaviorSummary.textContent = fbsSummary(d.behaviors, "待分析");
  els.fbsStructureSummary.textContent = fbsSummary(d.structures, "待分析");
  els.fbsCriteriaSummary.textContent = d.criteria || "等待可测量标准";
}

function setupEventStream() {
  const events = new EventSource("/api/events");
  events.addEventListener("assembly:progress", (event) => updateAssembly(JSON.parse(event.data)));
  events.addEventListener("assembly:done", (event) => updateAssembly(JSON.parse(event.data)));
  events.addEventListener("assembly:review_done", (event) => updateAssembly(JSON.parse(event.data)));
  events.addEventListener("assembly:repair", (event) => renderRepairStatus(JSON.parse(event.data)));
  events.addEventListener("assembly:error", (event) => updateAssembly(JSON.parse(event.data)));
  ["queued", "started", "completed", "failed"].forEach((status) => {
    events.addEventListener(`latent:training:${status}`, (event) => renderLatentStatus(JSON.parse(event.data)));
  });
  events.onerror = () => {
    els.renderState.textContent = "事件流断开，API 仍可用";
  };
}

function renderLatentStatus(status = {}) {
  if (!els.latentStatus) return;
  const model = status.activeModel || status.lastResult?.activeModel || null;
  if (status.running || status.status === "started") {
    els.latentStatus.textContent = `latent/VAE：后台训练中（队列 ${status.queueLength ?? 0}）`;
    return;
  }
  if (status.status === "failed" || status.lastError) {
    els.latentStatus.textContent = `latent/VAE：训练失败，CAD 不受影响`;
    return;
  }
  if (model?.modelVersion) {
    els.latentStatus.textContent = `latent/VAE：${model.modelVersion} · ${model.structureSamples || model.sampleCount || 0} 个结构样本`;
    return;
  }
  els.latentStatus.textContent = `latent/VAE：已接入后台学习 · 队列 ${status.queueLength ?? 0}`;
}

async function addChatImages(fileList) {
  const files = Array.from(fileList || []).filter((file) => /^image\/(png|jpeg|webp)$/.test(file.type));
  if (!files.length) return;
  for (const file of files) {
    if (state.pendingImages.length >= MAX_CHAT_IMAGES) {
      els.log.textContent = `最多附带 ${MAX_CHAT_IMAGES} 张参考图片。`;
      break;
    }
    const dataUrl = await compressChatImage(file);
    state.pendingImages.push({ name: file.name, dataUrl });
  }
  renderChatImagePreview();
}

async function compressChatImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_CHAT_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

function renderChatImagePreview() {
  els.chatImagePreview.innerHTML = "";
  state.pendingImages.forEach((image, index) => {
    const item = document.createElement("div");
    item.className = "chat-image-thumb";
    const img = document.createElement("img");
    img.src = image.dataUrl;
    img.alt = image.name;
    img.title = image.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "移除这张图片";
    remove.addEventListener("click", () => {
      state.pendingImages.splice(index, 1);
      renderChatImagePreview();
    });
    item.append(img, remove);
    els.chatImagePreview.appendChild(item);
  });
  els.chatImagePreview.classList.toggle("has-images", state.pendingImages.length > 0);
}

async function sendChat() {
  const message = els.chatInput.value.trim();
  const images = state.pendingImages.slice();
  const trainingRequested = state.trainingMode;
  if (!message && !images.length) return;

  pushMessage("user", images.length ? `${message || "（识别参考图片建模）"}\n📷 附带 ${images.length} 张参考图` : message);
  els.chatInput.value = "";
  state.pendingImages = [];
  state.chatAbortController?.abort();
  renderChatImagePreview();
  setBusy(els.sendChatBtn, true);
  state.chatAbortController = new AbortController();
  els.cancelChatBtn.hidden = false;
  els.cancelChatBtn.disabled = false;
  updateProcessTrace("request", "进行中", "已收到当前需求");
  updateProcessTrace("fbs", "进行中", "正在提取功能、行为和结构");
  clearGeneratedPreview("正在生成新的装配预览...");
  els.renderState.textContent = state.webSearchEnabled ? "正在搜索资料，并先做 FBS 分析再规划装配..." : "AI 正在先做 FBS 分析，再规划零件和装配...";
  els.log.classList.remove("error");
  els.log.textContent = state.webSearchEnabled
    ? "正在搜索网络上的相关数据/图纸，再生成 CadQuery 特征计划并构建 BREP 装配。"
    : "正在分析 R→F→Be→S，生成 CadQuery 特征计划，然后构建 BREP 装配。";
  if (state.webSearchEnabled) {
    state.lastSearch = { enabled: true, query: state.webSearchQuery || message, results: [], loading: true };
    renderSearchResults();
  }

  try {
    const result = await api("/api/chat", {
      method: "POST",
      signal: state.chatAbortController.signal,
      body: {
        conversationId: state.conversationId,
        message,
        images,
        activePartId: state.activePartId,
        activeFeatureId: state.activeFeatureId,
        fbs: fsb.document(),
        webSearch: {
          enabled: state.webSearchEnabled,
          query: state.webSearchQuery.trim(),
          maxResults: 5
        }
      }
    });
    updateProcessTrace("fbs", "完成", result.fbsAnalysis ? "Concept-CAD 合同已归档" : "CAD 规划已完成");
    state.conversationId = result.conversationId;
    localStorage.setItem("ai-cad-conversation-id", state.conversationId);
    state.lastSearch = result.search || null;
    if (result.fbsAnalysis) {
      fsb.updateDocument({ experimentId: result.fbsAnalysis.experimentId, requirements: result.fbsAnalysis.requirements, criteria: result.fbsAnalysis.criteria, functions: result.fbsAnalysis.functions, behaviors: result.fbsAnalysis.behaviors, structures: result.fbsAnalysis.structures, stageHistory: [{ stage: "analysis", generatedAt: result.fbsAnalysis.generatedAt, candidates: [...result.fbsAnalysis.functions, ...result.fbsAnalysis.behaviors, ...result.fbsAnalysis.structures] }] });
      hydrateFBS();
      els.fsbStatus.textContent = "AI 已完成 R→F→Be→S 分析，结果已归档并用于 CAD 规划";
    }
    renderSearchResults();
    pushMessage("assistant", result.reply || "装配已生成。");
    await applyPlan(result.plan, result.assembly);
    const buildStatus = result.assembly?.status === "done" ? "完成" : result.assembly?.status === "building" ? "进行中" : "失败";
    updateProcessTrace("build", buildStatus, result.assembly?.status || "CAD 规划与构建完成");
    const geometryPassed = geometryAcceptanceState(result.assembly).passed;
    updateProcessTrace("validate", geometryPassed ? "完成" : "失败", geometryPassed ? "BREP/STEP 几何验收通过" : "几何验收仍有阻断问题");
    updateProcessTrace("deliver", geometryPassed ? "进行中" : "失败", geometryPassed ? "等待视觉审查与自动改进" : "等待几何修复");
    if (result.assembly?.id && ["done", "validation_failed"].includes(result.assembly.status)) {
      let reviewResult;
      if (trainingRequested) {
        await runTrainingLoop({ request: message || "根据参考图片建模", assembly: result.assembly });
      } else await runAutomaticReviewLoop({ request: message || "根据参考图片建模", assembly: result.assembly });
      reviewResult = state.currentVisualReview;
      if (dualAcceptancePassed(reviewResult)) updateProcessTrace("deliver", "完成", "几何与视觉验收均通过");
      else if (reviewResult?.recommendedNextAction === "ask_user") updateProcessTrace("deliver", "已停止", "等待后期尺寸、约束或人工确认");
      else updateProcessTrace("deliver", "失败", "自动审查未达到双重验收条件");
    }
  } catch (error) {
    if (error.name === "AbortError") {
      pushMessage("assistant", "已停止当前建模任务，未继续生成或覆盖模型。");
      updateProcessTrace(null, "已停止", "用户停止了当前任务");
      return;
    }
    updateProcessTrace(null, "失败", error.message || String(error));
    pushMessage("assistant", `失败：${error.message || error}`);
    setError(error);
  } finally {
    setBusy(els.sendChatBtn, false);
    state.chatAbortController = null;
    els.cancelChatBtn.hidden = true;
  }
}

function cancelChat() {
  if (!state.chatAbortController) return;
  els.cancelChatBtn.disabled = true;
  els.renderState.textContent = "正在停止当前任务...";
  if (state.conversationId) {
    void api("/api/chat/stop", { method: "POST", body: { conversationId: state.conversationId } }).catch(() => {});
  }
  state.chatAbortController.abort();
}

function updateProcessTrace(stage, status, detail) {
  const labels = { "进行中": "进行中", 完成: "完成", 失败: "失败", 已停止: "已停止", 跳过: "跳过" };
  if (els.processTraceStatus) els.processTraceStatus.textContent = detail || labels[status] || status || "等待输入";
  if (!els.processTrace) return;
  const stages = [...els.processTrace.querySelectorAll("[data-stage]")];
  const index = stage ? stages.findIndex((item) => item.dataset.stage === stage) : -1;
  stages.forEach((item, itemIndex) => {
    item.classList.toggle("active", itemIndex === index && status === "进行中");
    item.classList.toggle("complete", index >= 0 && itemIndex < index || itemIndex === index && ["完成", "跳过"].includes(status));
    item.classList.toggle("failed", itemIndex === index && ["失败", "已停止"].includes(status));
    const small = item.querySelector("small");
    if (itemIndex === index || (stage === null && itemIndex === stages.length - 1)) small.textContent = detail || status;
  });
}

function resetChat() {
  state.conversationId = crypto.randomUUID();
  state.messages = [];
  state.currentAssembly = null;
  state.currentPlan = null;
  state.activePartId = null;
  state.activeFeatureId = null;
  state.parametricTree = null;
  state.revisions = [];
  state.validationReport = null;
  state.trainingStopRequested = true;
  state.trainingRunning = false;
  state.trainingSession = null;
  state.loadedAssemblyModelKey = "";
  state.lastSearch = null;
  state.pendingImages = [];
  fsb.clearDocument();
  fsb.clearHistory();
  renderChatImagePreview();
  mesh = null;
  state.currentStlUrl = "";
  localStorage.setItem("ai-cad-conversation-id", state.conversationId);
  localStorage.setItem("ai-cad-chat", "[]");
  localStorage.removeItem("ai-cad-code");
  localStorage.removeItem(LAST_ASSEMBLY_KEY);
  renderChat();
  renderParts();
  renderRelations();
  renderFeatureTree();
  renderRevisions(null);
  renderValidation();
  els.activePartName.textContent = "未选择零件";
  els.code.value = "// 新会话：发送工程需求后生成 CadQuery 特征 JSON";
  els.log.textContent = "已创建新会话。";
  resetViewerStage();
  renderSearchResults();
  els.fsbStatus.textContent = "新会话已清空 · 发送需求后自动分析";
  updateProcessTrace(null, "等待", "等待输入");
  hydrateFBS();
  updateRatingPanel();
  renderTrainingStatus();
}

function pushMessage(role, content) {
  state.messages.push({ role, content, at: new Date().toISOString() });
  localStorage.setItem("ai-cad-chat", JSON.stringify(state.messages.slice(-30)));
  fsb.emit("chat.message", { role, preview: String(content || "").slice(0, 120) });
  renderChat();
}

function renderChat() {
  els.chatHistory.innerHTML = "";
  const messages = state.messages.length ? state.messages : [{
    role: "assistant",
    content: "描述你要建模的零件、尺寸、孔槽和功能特征。AI-CAD 会生成参数化特征计划，经 CadQuery 构建与验证，并用 VAE/latent 持续学习成功结构和失败模式。"
  }];
  for (const message of messages) {
    const item = document.createElement("div");
    item.className = `message ${message.role}`;
    item.textContent = message.content;
    els.chatHistory.appendChild(item);
  }
  els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
}

async function applyPlan(plan, assembly) {
  state.currentPlan = plan;
  state.currentAssembly = assembly;
  state.activePartId = plan.activePartId || plan.parts?.[0]?.id || null;
  state.activeFeatureId = plan.activeFeatureId || null;
  const activePart = getActivePart();
  if (activePart) {
    const text = partToFeatureJson(activePart);
    els.code.value = text;
    localStorage.setItem("ai-cad-code", text);
    els.activePartName.textContent = activePart.name;
  }
  renderParts();
  renderRelations();
  return updateAssembly(assembly);
}

function getActivePart() {
  return state.currentPlan?.parts?.find((part) => part.id === state.activePartId) || null;
}

function getActiveBuiltPart() {
  return state.currentAssembly?.parts?.find((part) => part.id === state.activePartId) || null;
}

function renderParts() {
  els.partsList.innerHTML = "";
  const planParts = state.currentPlan?.parts || [];
  const assemblyParts = state.currentAssembly?.parts || [];
  if (!planParts.length) {
    els.partsList.innerHTML = `<div class="empty-list">还没有零件</div>`;
    return;
  }

  for (const part of planParts) {
    const built = assemblyParts.find((item) => item.id === part.id);
    const card = document.createElement("button");
    card.className = `part-card ${part.id === state.activePartId ? "active" : ""}`;
    card.dataset.partId = part.id;
    card.type = "button";
    card.innerHTML = `
      <strong>${escapeHtml(part.name)}</strong>
      <span>${escapeHtml(part.role || "零件")}</span>
      <small>位置 [${(part.pose?.translate || [0, 0, 0]).join(", ")}]</small>
    `;
    card.addEventListener("click", () => {
      state.activePartId = part.id;
      els.code.value = part.scad;
      localStorage.setItem("ai-cad-code", part.scad);
      els.activePartName.textContent = part.name;
      const text = partToFeatureJson(part);
      els.code.value = text;
      localStorage.setItem("ai-cad-code", text);
      if (state.viewMode === "assembly" && state.currentAssembly?.glbUrl && cadViewer?.selectPart(part.id, { frame: true })) {
        updateViewerControls();
      } else {
        fallbackToBuiltPartPreview(built, part.name || part.id);
      }
      renderParts();
    });
    els.partsList.appendChild(card);
  }
}

function fallbackToBuiltPartPreview(built, label) {
  if (built?.stlUrl) {
    els.downloadLink.hidden = false;
    els.downloadLink.href = built.stlUrl;
    state.viewMode = "part";
    loadStl(built.stlUrl, { label });
  } else {
    previewCadQuery({ force: true });
  }
}

function renderRelations() {
  els.relationsList.innerHTML = "";
  const relations = state.currentPlan?.relations || [];
  const joints = state.currentPlan?.joints || state.currentAssembly?.joints || [];
  if (!relations.length && !joints.length) {
    els.relationsList.innerHTML = `<div class="empty-list">还没有装配关系</div>`;
    return;
  }
  for (const relation of relations) {
    const item = document.createElement("div");
    item.className = "relation-card";
    item.innerHTML = `
      <strong>${escapeHtml(relation.type || "relation")}: ${escapeHtml(relation.from || "?")} -> ${escapeHtml(relation.to || "?")}</strong>
      <span>${escapeHtml(relation.description || "")}</span>
    `;
    els.relationsList.appendChild(item);
  }
  for (const joint of joints) {
    const item = document.createElement("div");
    item.className = "relation-card";
    item.innerHTML = `
      <strong>joint ${escapeHtml(joint.type || "fixed")}: ${escapeHtml(joint.parent || "world")} -> ${escapeHtml(joint.child || "?")}</strong>
      <span>axis [${(joint.axis || [0, 0, 1]).join(", ")}], origin [${(joint.origin?.xyz || [0, 0, 0]).join(", ")}] m</span>
    `;
    els.relationsList.appendChild(item);
  }
}

async function loadParametricWorkspace() {
  const assemblyId = state.currentAssembly?.id;
  if (!assemblyId) return;
  try {
    const [tree, revisions, validation] = await Promise.all([
      api(`/api/assembly/${encodeURIComponent(assemblyId)}/feature-tree`),
      api(`/api/assembly/${encodeURIComponent(assemblyId)}/revisions`),
      api(`/api/assembly/${encodeURIComponent(assemblyId)}/validation`)
    ]);
    state.parametricTree = tree;
    state.revisions = revisions.revisions || [];
    state.validationReport = validation;
    renderFeatureTree();
    renderRevisions(revisions.currentRevision);
    renderValidation();
  } catch (error) {
    els.validationSummary.textContent = error.message || String(error);
    els.validationSummary.className = "validation-summary status-error";
  }
}

function renderFeatureTree() {
  els.featureTreeList.innerHTML = "";
  const parts = state.parametricTree?.parts || [];
  if (!parts.length) {
    els.featureTreeList.innerHTML = `<div class="empty-list">暂无参数化特征</div>`;
    return;
  }
  for (const part of parts) {
    const group = document.createElement("section");
    group.className = "feature-part";
    const title = document.createElement("strong");
    title.textContent = part.name || part.id;
    group.appendChild(title);
    for (const feature of part.featureTree || []) {
      const button = document.createElement("button");
      const status = feature.status || (feature.enabled === false ? "disabled" : "not-built");
      button.type = "button";
      button.className = `feature-node status-${status === "failed" ? "error" : status === "warning" ? "warning" : "ok"} ${feature.id === state.activeFeatureId ? "active" : ""}`;
      button.dataset.featureId = feature.id;
      const params = formatFeatureParams(feature.params);
      button.innerHTML = `<span>${escapeHtml(feature.name || feature.id)}</span><small>${escapeHtml(feature.type)} · ${escapeHtml(status)}</small>${params ? `<small class="feature-params">${escapeHtml(params)}</small>` : ""}`;
      button.addEventListener("click", () => {
        state.activePartId = part.id;
        state.activeFeatureId = feature.id;
        if (state.currentPlan) {
          state.currentPlan.activePartId = part.id;
          state.currentPlan.activeFeatureId = feature.id;
        }
        els.activePartName.textContent = `${part.name || part.id} / ${feature.name || feature.id}`;
        els.code.value = JSON.stringify({ partId: part.id, feature }, null, 2);
        localStorage.setItem("ai-cad-code", els.code.value);
        renderParts();
        renderFeatureTree();
      });
      group.appendChild(button);
    }
    els.featureTreeList.appendChild(group);
  }
}

function formatFeatureParams(params) {
  if (!params || typeof params !== "object") return "";
  return Object.entries(params).slice(0, 6).map(([key, value]) => {
    const shown = Array.isArray(value) ? value.join(" × ") : value && typeof value === "object" ? JSON.stringify(value) : String(value);
    return `${key}: ${shown}`;
  }).join(" · ");
}

function renderRevisions(currentRevision) {
  els.revisionList.innerHTML = "";
  if (!state.revisions.length) {
    els.revisionList.innerHTML = `<option value="">暂无修订</option>`;
    els.revertRevisionBtn.disabled = true;
    return;
  }
  for (const revision of state.revisions) {
    const option = document.createElement("option");
    option.value = revision.id;
    option.textContent = `${revision.id} · ${revision.status}${revision.summary ? ` · ${revision.summary}` : ""}`;
    option.selected = revision.id === currentRevision;
    els.revisionList.appendChild(option);
  }
  els.revertRevisionBtn.disabled = false;
}

function renderValidation() {
  const report = state.validationReport || {};
  const summary = report.summary || { errors: 0, warnings: 0, info: 0 };
  const measurements = report.measurements || [];
  const passedMeasurements = measurements.filter((item) => item.status === "pass").length;
  els.validationSummary.textContent = summary.errors ? `验证未通过 · ${summary.errors} 个阻断问题${summary.warnings ? ` · ${summary.warnings} 项风险` : ""}` : summary.warnings ? `几何通过 · ${summary.warnings} 项工程风险${passedMeasurements ? ` · ${passedMeasurements} 项尺寸通过` : ""}` : `工程验证通过${passedMeasurements ? ` · ${passedMeasurements} 项尺寸通过` : ""}`;
  els.validationSummary.className = `validation-summary ${summary.errors ? "status-error" : summary.warnings ? "status-warning" : "status-ok"}`;
  renderValidationStages(report);
  if (state.currentAssembly?.status === "validation_failed") renderRepairStatus({ status: "failed", summary, repairAudit: state.currentAssembly.repairAudit || [], message: "自动修复已结束，仍有阻断错误；请查看下方错误详情" });
  else if (state.currentAssembly?.status === "done") renderRepairStatus({ status: "complete", summary, repairAudit: state.currentAssembly.repairAudit || [], message: state.currentAssembly.repairAudit?.length ? "自动修复完成，最终验证已通过" : "无需自动修复，验证已通过" });
  els.validationMeasurements.innerHTML = "";
  for (const measurement of measurements.filter((item) => item.status !== "pass")) {
    const item = document.createElement("div");
    const passed = measurement.status === "pass";
    item.className = `validation-issue ${passed ? "status-ok" : "status-error"}`;
    const measured = measurement.measured === null || measurement.measured === undefined ? "未测得" : Number(measurement.measured).toFixed(4);
    const target = measurement.target === null || measurement.target === undefined ? "未设目标" : Number(measurement.target).toFixed(4);
    const tolerance = measurement.tolerance === null || measurement.tolerance === undefined ? "-" : Number(measurement.tolerance).toFixed(4);
    item.innerHTML = `<strong>${escapeHtml(measurement.label || measurement.id || "尺寸")}</strong><span>${escapeHtml(`实测 ${measured} ${measurement.unit || "mm"} · 目标 ${target} ± ${tolerance} · ${passed ? "通过" : "未通过"}`)}</span>`;
    els.validationMeasurements.appendChild(item);
  }
  if (passedMeasurements) {
    const item = document.createElement("div");
    item.className = "validation-issue status-ok";
    item.innerHTML = `<strong>BREP 尺寸</strong><span>${passedMeasurements} 项精确测量全部通过</span>`;
    els.validationMeasurements.prepend(item);
  }
  for (const dimension of report.unverifiedDimensions || []) {
    const item = document.createElement("div");
    item.className = "validation-issue status-warning";
    item.innerHTML = `<strong>${escapeHtml(dimension.label || dimension.name || "尺寸")}</strong><span>${escapeHtml(`目标 ${dimension.target ?? "未设定"} · 尚未通过 BREP 测量确认`)}</span>`;
    els.validationMeasurements.appendChild(item);
  }
  for (const condition of report.unverifiedConditions || []) {
    const item = document.createElement("div");
    item.className = "validation-issue status-warning";
    item.innerHTML = `<strong>工程条件 · ${escapeHtml(condition.label || condition.name || "条件")}</strong><span>${escapeHtml(`目标 ${condition.target ?? "未设定"} · 需要承载/强度分析确认，不属于 BREP 尺寸`)}</span>`;
    els.validationMeasurements.appendChild(item);
  }
  els.validationIssues.innerHTML = "";
  const repairQueue = report.repairQueue;
  const visibleIssues = repairQueue?.active?.length
    ? [...repairQueue.active, ...(report.issues || []).filter((issue) => issue.severity !== "error").slice(0, 4)]
    : (report.issues || []);
  if (repairQueue && (repairQueue.deferred?.length || repairQueue.suppressedCount)) {
    const queueSummary = document.createElement("div");
    queueSummary.className = "validation-issue status-warning";
    queueSummary.innerHTML = `<strong>修复队列</strong><span>${escapeHtml(`当前 ${repairQueue.active?.length || 0} 个根因 · 排队 ${repairQueue.deferred?.length || 0} 个 · 已合并 ${repairQueue.suppressedCount || 0} 个派生问题`)}</span>`;
    els.validationIssues.appendChild(queueSummary);
  }
  for (const group of groupValidationIssues(visibleIssues)) {
    const issue = group.issue;
    const item = document.createElement("div");
    item.className = `validation-issue status-${issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "ok"}`;
    const pair = Array.isArray(issue.parts) ? issue.parts.join(" ↔ ") : "";
    const volume = Number.isFinite(Number(issue.volume)) ? ` · ${Number(issue.volume).toFixed(3)} mm³` : "";
    const affected = group.partIds.length ? ` · ${group.partIds.slice(0, 4).join(", ")}${group.partIds.length > 4 ? ` 等 ${group.partIds.length} 处` : ""}` : "";
    item.innerHTML = `<strong>${escapeHtml(issue.code || "ISSUE")}${group.count > 1 ? ` × ${group.count}` : ""}</strong><span>${escapeHtml(issue.message || pair || "")}${escapeHtml(volume + affected)}</span>`;
    els.validationIssues.appendChild(item);
  }
  for (const audit of report.repairAudit || []) {
    const item = document.createElement("div");
    item.className = "validation-issue repair-audit status-ok";
    const target = [audit.partId, audit.featureId].filter(Boolean).join(" / ");
    const change = audit.originalValue !== undefined ? `${audit.originalValue} → ${audit.repairedValue ?? "disabled"}` : "已执行";
    item.innerHTML = `<strong>AUTO_REPAIR · ${escapeHtml(audit.action || "repair")}</strong><span>${escapeHtml(target)} · ${escapeHtml(change)}</span>`;
    els.validationIssues.appendChild(item);
  }
  const parts = report.constraints?.parts || {};
  els.dofSummary.innerHTML = Object.entries(parts).length
    ? Object.entries(parts).map(([partId, value]) => `<div><strong>${escapeHtml(partId)}</strong><span>${value.remainingDof} DOF · ${escapeHtml((value.free || []).join(", ") || "fixed")}</span></div>`).join("")
    : "尚未分析";
}

function renderValidationStages(report) {
  if (!els.validationStages) return;
  const labels = {
    brepcheck: "BREP",
    shape_healing: "修复",
    topology_facts: "事实",
    fbs_acceptance: "FBS",
    local_repair: "局部修改",
    step_roundtrip: "STEP回归"
  };
  const stages = Array.isArray(report.reviewStages) ? report.reviewStages : [];
  if (!stages.length) {
    els.validationStages.innerHTML = "";
    return;
  }
  els.validationStages.innerHTML = stages.map((stage) => {
    const status = stage.status === "pass" || stage.status === "not_needed" || stage.status === "automatic" ? "ok" : stage.status === "pending" || stage.status === "delegated_to_validation_loop" ? "pending" : "error";
    return `<span class="validation-stage ${status}" title="${escapeHtml(stage.status || "")}"><i></i>${escapeHtml(labels[stage.stage] || stage.stage)}</span>`;
  }).join("<b>›</b>");
}

function groupValidationIssues(issues) {
  const groups = new Map();
  for (const issue of issues) {
    const key = `${issue.severity || "info"}:${issue.code || "ISSUE"}:${issue.message || ""}`;
    const group = groups.get(key) || { issue, count: 0, partIds: [] };
    group.count += 1;
    const target = [issue.partId, issue.featureId].filter(Boolean).join("/");
    if (target && !group.partIds.includes(target)) group.partIds.push(target);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => ({ error: 0, warning: 1, info: 2 }[a.issue.severity] ?? 3) - ({ error: 0, warning: 1, info: 2 }[b.issue.severity] ?? 3));
}

function renderRepairStatus(update = {}) {
  if (!els.repairStatus) return;
  const status = update.status || "idle";
  const auditCount = update.repairAudit?.length || 0;
  const errors = update.summary?.errors ?? update.summary?.blockingErrors;
  els.repairStatus.className = `repair-status ${["planning", "rebuilding"].includes(status) ? "is-running" : status === "complete" ? "is-complete" : status === "failed" ? "is-failed" : ""}`;
  els.repairStatus.textContent = `${update.message || "未启动修复"}${auditCount ? ` · 已执行 ${auditCount} 项安全修复` : ""}${Number.isFinite(Number(errors)) ? ` · 当前错误 ${errors}` : ""}`;
}

async function revertSelectedRevision() {
  const assemblyId = state.currentAssembly?.id;
  const revisionId = els.revisionList.value;
  if (!assemblyId || !revisionId) return;
  setBusy(els.revertRevisionBtn, true);
  try {
    const result = await api(`/api/assembly/${encodeURIComponent(assemblyId)}/revert`, { method: "POST", body: { revisionId } });
    updateAssembly(result.assembly);
    await loadParametricWorkspace();
  } catch (error) {
    setError(error);
  } finally {
    setBusy(els.revertRevisionBtn, false);
  }
}

function renderSearchResults() {
  if (!els.searchResults) return;
  if (!state.webSearchEnabled && !state.lastSearch) {
    els.searchResults.innerHTML = `<div class="search-empty">搜索关闭</div>`;
    return;
  }
  if (state.lastSearch?.loading) {
    els.searchResults.innerHTML = `<div class="search-empty">正在搜索：${escapeHtml(state.lastSearch.query || "")}</div>`;
    return;
  }
  if (!state.lastSearch?.enabled) {
    els.searchResults.innerHTML = `<div class="search-empty">开启后会在生成前查找相关数据和图纸</div>`;
    return;
  }
  if (state.lastSearch.error) {
    els.searchResults.innerHTML = `
      <div class="search-empty error">
        <strong>搜索失败</strong>
        <span>${escapeHtml(state.lastSearch.error)}</span>
      </div>
    `;
    return;
  }
  const results = state.lastSearch.results || [];
  if (!results.length) {
    els.searchResults.innerHTML = `<div class="search-empty">没有搜索结果</div>`;
    return;
  }
  const notice = state.lastSearch.notice
    ? `<div class="search-empty notice">${escapeHtml(state.lastSearch.notice)}</div>`
    : "";
  els.searchResults.innerHTML = notice + results.slice(0, 5).map((item) => {
    const content = `
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.source || item.url)}</span>
      ${item.snippet ? `<small>${escapeHtml(item.snippet)}</small>` : ""}
    `;
    if (String(item.url || "").startsWith("local://")) {
      return `<div class="search-result local-reference">${content}</div>`;
    }
    return `
      <a class="search-result" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
        ${content}
      </a>
    `;
  }).join("");
}

function updateAssembly(assembly) {
  if (!assembly) return;
  const previousAssemblyId = state.currentAssembly?.id || null;
  if (assembly.id && assembly.id !== previousAssemblyId && assembly.status !== "done") {
    clearGeneratedPreview(assembly.status === "error" ? "本次装配生成失败" : "正在构建新的装配预览...");
  }
  state.currentAssembly = assembly;
  if (!state.currentPlan && assembly.parts?.length) {
    state.currentPlan = {
      name: assembly.name,
      parts: assembly.parts.map((part) => ({ ...part })),
      relations: assembly.relations || [],
      joints: assembly.joints || [],
      constraints: assembly.constraints || [],
      activePartId: assembly.activePartId || assembly.parts[0]?.id || null,
      activeFeatureId: assembly.activeFeatureId || null
    };
    state.activePartId = state.currentPlan.activePartId;
    state.activeFeatureId = state.currentPlan.activeFeatureId;
  }
  if (state.currentPlan && assembly.parts?.length) {
    state.currentPlan = {
      ...state.currentPlan,
      parts: assembly.parts.map((part) => ({ ...part })),
      relations: assembly.relations || state.currentPlan.relations || [],
      joints: assembly.joints || state.currentPlan.joints || [],
      constraints: assembly.constraints || state.currentPlan.constraints || [],
      activePartId: assembly.activePartId || state.currentPlan.activePartId,
      activeFeatureId: assembly.activeFeatureId || state.currentPlan.activeFeatureId
    };
  }
  state.activeFeatureId = assembly.activeFeatureId || state.activeFeatureId;
  state.currentVisualReview = assembly.visualReview || (previousAssemblyId === assembly.id ? state.currentVisualReview : null);
  fsb.emit("assembly.updated", { id: assembly.id, status: assembly.status, revision: assembly.currentRevision || null });
  const outputStrategy = assembly.outputStrategy || {
    coreRepresentation: "参数化特征计划 + VAE/latent 学习",
    geometryKernel: "CadQuery BREP 几何内核",
    primaryDelivery: "零件 STEP/FCStd 是主要交付文件",
    compatibility: "STL/GLB 用于快速预览；装配能力处于第二阶段"
  };
  renderLatentStatus(assembly.latentLearning);
  els.renderState.textContent = statusText(assembly.status);
  els.log.classList.toggle("error", assembly.status === "error");
  els.log.textContent = assembly.error || JSON.stringify({
    assembly: assembly.name,
    status: assembly.status,
    parts: assembly.parts?.length || 0,
    relations: assembly.relations?.length || 0,
    outputStrategy,
    freecad: assembly.fcstdUrl || null,
    freecadBridge: assembly.freeCadBridgeReport || null
  }, null, 2);

  setDownload(els.fcstdLink, assembly.fcstdUrl);
  setDownload(els.stepLink, assembly.stepUrl);
  setDownload(els.assemblyStlLink, assembly.stlUrl);
  setDownload(els.kinematicPackageLink, assembly.kinematicPackageUrl);
  setDownload(els.constraintsLink, assembly.constraintManifestUrl);
  setDownload(els.manifestLink, assembly.manifestUrl);
  updateVisualReviewButton();
  renderVisualReview();
  updateRatingPanel();
  renderParts();
  loadParametricWorkspace();

  if (!["done", "validation_failed"].includes(assembly.status)) {
    updateVisualReviewButton();
    return null;
  }

  if (assembly.glbUrl || assembly.stlUrl) {
    if (assembly.status === "done" && assembly.id) localStorage.setItem(LAST_ASSEMBLY_KEY, assembly.id);
    els.downloadLink.hidden = false;
    els.downloadLink.href = assembly.stlUrl;
    state.viewMode = "assembly";
    return loadAssemblyModel(assembly);
  } else {
    return showActivePartStl();
  }
}

async function restoreLastAssembly() {
  const savedId = localStorage.getItem(LAST_ASSEMBLY_KEY);
  const endpoints = savedId
    ? [`/api/assembly/${encodeURIComponent(savedId)}`, "/api/assembly/latest"]
    : ["/api/assembly/latest"];
  for (const endpoint of endpoints) {
    try {
      const assembly = await api(endpoint);
      if (!assembly?.id) continue;
      updateAssembly(assembly);
      return;
    } catch {
      // Try the latest completed assembly if the saved ID is stale.
    }
  }
  if (savedId) localStorage.removeItem(LAST_ASSEMBLY_KEY);
}

function showAssemblyStl() {
  if (!state.currentAssembly?.id) return;
  if (!state.currentAssembly.glbUrl && !state.currentAssembly.stlUrl) return;
  state.viewMode = "assembly";
  els.downloadLink.hidden = false;
  els.downloadLink.href = state.currentAssembly.stlUrl;
  loadAssemblyModel(state.currentAssembly);
}

async function loadAssemblyModel(assembly) {
  if (!cadViewer) {
    const fallback = assembly.parts?.find((part) => part.id === state.activePartId) || assembly.parts?.[0];
    if (fallback?.pngUrl) showPreviewImage(fallback.pngUrl);
    return;
  }
  if (assembly.glbUrl) {
    try {
      const stats = await loadGlb(assembly.glbUrl, { label: assembly.name || "装配", parts: assembly.parts || [] });
      if (stats) state.loadedAssemblyModelKey = assemblyModelKey(assembly);
      return;
    } catch (error) {
      els.log.textContent = `GLB 加载失败，切换 STL 兼容模式：${error.message || error}`;
    }
  }
  if (assembly.stlUrl) {
    const stats = await loadStl(assembly.stlUrl, { label: `${assembly.name || "装配"} · STL 兼容模式` });
    if (stats) state.loadedAssemblyModelKey = assemblyModelKey(assembly);
  }
}

function assemblyModelKey(assembly) {
  return `${assembly?.id || ""}:${assembly?.currentRevision || ""}`;
}

function showActivePartStl() {
  const activeBuilt = getActiveBuiltPart() || state.currentAssembly?.parts?.[0];
  if (activeBuilt?.stlUrl) {
    state.viewMode = "part";
    els.downloadLink.hidden = false;
    els.downloadLink.href = activeBuilt.stlUrl;
    loadStl(activeBuilt.stlUrl, { label: activeBuilt.name || activeBuilt.id || "零件" });
  } else if (activeBuilt?.pngUrl) {
    showPreviewImage(activeBuilt.pngUrl);
  }
}

function setDownload(anchor, url) {
  anchor.hidden = !url;
  anchor.href = url || "";
}

function updateRatingPanel() {
  const canRate = Boolean(state.currentAssembly?.id && state.currentPlan?.parts?.length && state.currentAssembly.status === "done");
  els.ratingPanel.classList.toggle("ready", canRate);
  els.submitRatingBtn.disabled = !canRate;
  if (canRate) {
    els.ratingAssemblyName.textContent = state.currentAssembly.name || state.currentPlan.name || "未命名装配";
    els.ratingAssemblyId.textContent = state.currentAssembly.id;
    if (!els.ratingStatus.textContent || els.ratingStatus.dataset.auto === "true") {
      els.ratingStatus.textContent = "可提交人工评分。";
      els.ratingStatus.dataset.auto = "true";
      els.ratingStatus.classList.remove("error");
    }
  } else {
    els.ratingAssemblyName.textContent = "等待装配结果";
    els.ratingAssemblyId.textContent = "生成完成后可提交评分";
    els.ratingStatus.textContent = "暂无可评分的装配。";
    els.ratingStatus.dataset.auto = "true";
    els.ratingStatus.classList.remove("error");
  }
}

async function submitRating(event) {
  event.preventDefault();
  if (els.submitRatingBtn.disabled) {
    els.ratingStatus.classList.add("error");
    els.ratingStatus.textContent = "没有可评分的装配结果。";
    delete els.ratingStatus.dataset.auto;
    return;
  }
  const score = Number(new FormData(els.ratingForm).get("score"));
  if (![0, 50, 100].includes(score)) {
    els.ratingStatus.classList.add("error");
    els.ratingStatus.textContent = "请选择 0、50 或 100 分。";
    delete els.ratingStatus.dataset.auto;
    return;
  }
  setBusy(els.submitRatingBtn, true);
  els.ratingStatus.classList.remove("error");
  els.ratingStatus.textContent = "正在保存评分...";
  delete els.ratingStatus.dataset.auto;
  try {
    const result = await api("/api/rate", {
      method: "POST",
      body: {
        score,
        comment: els.ratingComment.value.trim(),
        conversationId: state.conversationId,
        assemblyId: state.currentAssembly.id,
        plan: state.currentPlan,
        assembly: state.currentAssembly
      }
    });
    els.ratingStatus.textContent = result.retainedForLearning
      ? `已保存：${result.label}。优秀 CadQuery Python 已进入学习库。`
      : `已保存：${result.label}。`;
    els.log.classList.remove("error");
    els.log.textContent = JSON.stringify({
      rating: result.id,
      score: result.score,
      retainedForLearning: result.retainedForLearning,
      pythonFile: result.pythonFile || null
    }, null, 2);
  } catch (error) {
    els.ratingStatus.classList.add("error");
    els.ratingStatus.textContent = error.message || String(error);
  } finally {
    setBusy(els.submitRatingBtn, false);
  }
}

async function runVisualReview({ rethrow = false, autoImprove = false } = {}) {
  const assembly = state.currentAssembly;
  if (!assembly?.id || !mesh) {
    setError(new Error("需要先生成并加载装配 3D 预览"));
    return;
  }
  setBusy(els.visualReviewBtn, true);
  els.visualReviewPanel.hidden = false;
  els.visualReviewStatus.textContent = "审查中";
  els.visualReviewSummary.textContent = "正在采集 3D、前视、顶视、侧视截图并交给 Codex 审查...";
  els.visualReviewFindings.innerHTML = "";
  try {
    const screenshots = await captureReviewScreenshots();
    const review = await api("/api/visual-review", {
      method: "POST",
      body: {
        assemblyId: assembly.id,
        conversationId: state.conversationId,
        plan: state.currentPlan,
        assembly,
        screenshots
      }
    });
    state.currentVisualReview = review;
    review.geometryAcceptance = geometryAcceptanceState(state.currentAssembly);
    refreshClientAcceptance(review);
    renderVisualReview();
    els.log.classList.remove("error");
    els.log.textContent = JSON.stringify({ visualReview: review }, null, 2);
    const actionable = review.status !== "pass" && review.recommendedNextAction === "revise" && review.findings?.some((finding) => (
      finding.actionability === "auto" && finding.confidence !== "low" && finding.partId
        && finding.proposedChange?.op && finding.verification?.method && finding.verification?.expected
    ));
    if (autoImprove && actionable) {
      els.visualImproveStatus.textContent = "审查完成，正在自动修改可安全修复的问题并复审...";
      const improvement = await improveFromVisualReview({ rethrow, reReview: true });
      return improvement?.followUpReview || state.currentVisualReview;
    }
    return review;
  } catch (error) {
    els.visualReviewStatus.textContent = "失败";
    els.visualReviewSummary.textContent = error.message || String(error);
    setError(error);
    if (rethrow) throw error;
    return null;
  } finally {
    setBusy(els.visualReviewBtn, false);
    updateVisualReviewButton();
  }
}

async function repairFromVisualReviewReport(review) {
  const assembly = state.currentAssembly;
  if (!assembly?.id || !review) return null;
  els.visualImproveStatus.textContent = "局部补丁无法覆盖全部问题，正在依据原始需求和审查报告重规划修复...";
  const result = await api("/api/visual-review/repair", {
    method: "POST",
    body: {
      assemblyId: assembly.id,
      conversationId: state.conversationId,
      review,
      activePartId: state.activePartId,
      activeFeatureId: state.activeFeatureId
    }
  });
  if (result.assembly) {
    await updateAssembly(result.assembly);
    await loadParametricWorkspace();
  }
  if (result.ambiguous) {
    review.recommendedNextAction = "ask_user";
    review.autoLoopStopReason = "repair_ambiguous";
    els.visualImproveStatus.textContent = result.reply || "审查报告无法唯一确定结构修复范围。";
    renderVisualReview();
    return result;
  }
  els.visualImproveStatus.textContent = result.assembly?.status === "done"
    ? "报告驱动修复已构建并通过几何验证，继续复审..."
    : result.reply || "报告驱动修复未通过构建验证。";
  return result;
}

function geometryAcceptanceState(assembly = state.currentAssembly) {
  if (assembly?.acceptance?.geometry) {
    const accepted = structuredClone(assembly.acceptance.geometry);
    accepted.errors = Number(accepted.errors ?? accepted.blockingErrorCount ?? 0);
    accepted.status ||= assembly.status || "unknown";
    accepted.passed = assembly?.status === "done" && accepted.passed === true && accepted.errors === 0;
    return accepted;
  }
  const validation = assembly?.validationReport || assembly?.validation || {};
  const errors = Number(validation.blockingErrorCount ?? validation.summary?.errors ?? 0);
  return {
    passed: assembly?.status === "done" && Boolean(assembly?.validationReport || assembly?.validation) && validation.valid !== false && errors === 0,
    errors,
    status: assembly?.status || "unknown"
  };
}

function dualAcceptancePassed(review, assembly = state.currentAssembly) {
  const geometry = geometryAcceptanceState(assembly);
  const visual = review?.status === "pass" || review?.recommendedNextAction === "accept";
  const currentRevision = Boolean(review?.revisionId && assembly?.currentRevision && String(review.revisionId) === String(assembly.currentRevision));
  return geometry.passed && visual && currentRevision;
}

function visualReviewFingerprint(review, assembly = state.currentAssembly) {
  const findings = (review?.findings || []).map((finding) => ({
    id: finding.findingId || null,
    partId: finding.partId || null,
    featureId: finding.featureId || null,
    message: finding.message || "",
    actionability: finding.actionability || null,
    proposedChange: finding.proposedChange || null
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({
    status: review?.status || null,
    next: review?.recommendedNextAction || null,
    geometryErrors: geometryAcceptanceState(assembly).errors,
    findings
  });
}

function refreshClientAcceptance(review, assembly = state.currentAssembly) {
  if (!assembly) return null;
  const geometry = geometryAcceptanceState(assembly);
  const visualCurrent = Boolean(review?.revisionId && assembly.currentRevision && String(review.revisionId) === String(assembly.currentRevision));
  const visualPassed = visualCurrent && (review?.status === "pass" || review?.recommendedNextAction === "accept");
  assembly.acceptance = {
    ...(assembly.acceptance || {}),
    passed: geometry.passed && visualPassed,
    geometry,
    visual: {
      passed: visualPassed,
      current: visualCurrent,
      status: review?.status || "pending",
      recommendedNextAction: review?.recommendedNextAction || "pending",
      revisionId: review?.revisionId || null
    }
  };
  return assembly.acceptance;
}

async function improveFromVisualReview({ rethrow = false, reReview = true } = {}) {
  const assembly = state.currentAssembly;
  const review = state.currentVisualReview;
  if (!assembly?.id || !review) {
    setError(new Error("需要先完成视觉审查"));
    return;
  }
  state.visualImprovementBusy = true;
  updateVisualImproveButton();
  els.visualImproveStatus.classList.remove("error");
  els.visualImproveStatus.textContent = "正在根据审查反馈生成最小范围修复并验证候选版本...";
  try {
    const result = await api("/api/visual-review/improve", {
      method: "POST",
      body: {
        assemblyId: assembly.id,
        conversationId: state.conversationId,
        reviewRevisionId: review.revisionId,
        activePartId: state.activePartId,
        activeFeatureId: state.activeFeatureId
      }
    });
    if (result.assembly) await updateAssembly(result.assembly);
    state.currentVisualReview = result.review || result.assembly?.visualReview || state.currentVisualReview;
    renderVisualReview();
    await loadParametricWorkspace();
    let followUpReview = null;
    if (reReview && result.assembly?.status === "done") {
      els.visualImproveStatus.textContent = "改进已通过构建与几何验证，正在自动生成复审报告...";
      try {
        followUpReview = await runVisualReview({ rethrow: true, autoImprove: false });
      } catch (reviewError) {
        els.visualImproveStatus.textContent = `改进已应用，但复审失败：${reviewError.message || reviewError}`;
      }
    }
    if (followUpReview) state.currentVisualReview = followUpReview;
    renderVisualReview();
    if (followUpReview) {
      els.visualImproveStatus.textContent = `改进完成，已生成复审报告：${visualReviewStatusText(followUpReview.status)}`;
    } else if (!reReview || result.assembly?.status !== "done") {
      els.visualImproveStatus.textContent = result.reply || "已生成并应用视觉改进版本。";
    }
    els.log.classList.remove("error");
    els.log.textContent = JSON.stringify({ visualImprovement: result, followUpReview }, null, 2);
    return { ...result, followUpReview };
  } catch (error) {
    els.visualImproveStatus.classList.add("error");
    els.visualImproveStatus.textContent = error.message || String(error);
    setError(error);
    if (rethrow) throw error;
    return null;
  } finally {
    state.visualImprovementBusy = false;
    updateVisualImproveButton();
  }
}

async function ensureGeometryAcceptance(assembly) {
  if (!assembly || assembly.status !== "validation_failed") return assembly;
  updateProcessTrace("validate", "进行中", "按 BREP 报告自动重建修复");
  els.visualImproveStatus.textContent = "几何验收未通过，正在先按 BREP 报告自动重建修复...";
  const repaired = await api("/api/assembly/repair", {
    method: "POST",
    body: { assemblyId: assembly.id, conversationId: state.conversationId }
  });
  if (repaired.assembly) {
    await updateAssembly(repaired.assembly);
    await loadParametricWorkspace();
  }
  if (!repaired.ok || repaired.assembly?.status !== "done") {
    updateProcessTrace("validate", "失败", "几何自动修复仍未通过");
    els.visualImproveStatus.textContent = "几何自动修复仍未通过，已保留报告并等待新的尺寸或约束。";
    return null;
  }
  updateProcessTrace("build", "完成", "几何修复版本已构建");
  updateProcessTrace("validate", "完成", "BREP/STEP 几何验收通过，继续视觉审查");
  return repaired.assembly;
}

async function runTrainingLoop({ request, assembly, resumeSession = null }) {
  const maxImprovements = 6;
  state.trainingRunning = true;
  state.trainingStopRequested = false;
  state.trainingSession = resumeSession || {
    id: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    status: "running",
    request,
    conversationId: state.conversationId,
    assemblyId: assembly.id,
    initialRevision: assembly.currentRevision || null,
    maxImprovements,
    startedAt: new Date().toISOString(),
    rounds: []
  };
  state.trainingSession.status = "running";
  state.trainingSession.maxImprovements = maxImprovements;
  const savedRounds = Array.isArray(state.trainingSession.rounds) ? state.trainingSession.rounds : [];
  const resumeLastRound = resumeSession && ["reviewing", "reviewed", "improving"].includes(resumeSession.phase)
    ? savedRounds[savedRounds.length - 1]
    : null;
  const resumeRoundIndex = resumeLastRound?.review && !resumeLastRound.improvement
    ? Math.max(0, Number(resumeLastRound.index || savedRounds.length) - 1)
    : savedRounds.length;
  const seenReviewStates = new Set(savedRounds
    .filter((round) => round !== resumeLastRound)
    .map((round) => visualReviewFingerprint(round.review, state.currentAssembly)));
  updateTrainingControls();
  setTrainingStatus("running", resumeSession ? `训练模式：从第 ${resumeRoundIndex + 1} 轮检查点继续...` : "训练模式：等待初始3D模型加载...");
  await persistTrainingSession();
  try {
    assembly = await ensureGeometryAcceptance(assembly);
    if (!assembly) return await finishTrainingSession("needs_user", "训练暂停：几何验收仍未通过，请补充尺寸或约束。", new Error("geometry acceptance is still blocked"));
    state.trainingSession.assemblyId = assembly.id;
    await waitForAssemblyModel(assembly.id, assembly.currentRevision);
    for (let roundIndex = resumeRoundIndex; roundIndex <= maxImprovements; roundIndex += 1) {
      if (state.trainingStopRequested) return await finishTrainingSession("stopped", "训练模式已停止。 ");
      state.trainingSession.phase = "reviewing";
      state.trainingSession.currentRound = roundIndex + 1;
      await persistTrainingSession();
      setTrainingStatus("running", `第 ${roundIndex + 1} 次视觉审查：正在采集多视图并分析...`);
      const resumedReview = resumeLastRound && roundIndex === resumeRoundIndex ? resumeLastRound.review : null;
      const review = resumedReview || await runVisualReview({ rethrow: true, autoImprove: false });
      const round = resumedReview ? resumeLastRound : {
        index: roundIndex + 1,
        revisionId: review.revisionId || state.currentAssembly?.currentRevision || null,
        reviewedAt: review.reviewedAt || new Date().toISOString(),
        review
      };
      state.currentVisualReview = review;
      refreshClientAcceptance(review);
      if (!resumedReview) state.trainingSession.rounds.push(round);
      state.trainingSession.phase = "reviewed";
      await persistTrainingSession();

      const reviewFingerprint = visualReviewFingerprint(review, state.currentAssembly);
      if (!resumedReview && seenReviewStates.has(reviewFingerprint) && !dualAcceptancePassed(review)) {
        state.trainingSession.phase = "reviewed";
        await persistTrainingSession();
        return await finishTrainingSession("needs_user", `训练暂停：第 ${roundIndex + 1} 轮与之前审查结果无进展，请输入新的尺寸或约束。`, new Error("visual review made no progress"));
      }
      seenReviewStates.add(reviewFingerprint);

      if (state.currentAssembly?.status === "validation_failed") {
        return await finishTrainingSession("failed", `训练记录完成：第 ${roundIndex + 1} 次视觉审查已完成，但该模型的几何验证未通过，未进入训练样本。`);
      }
      if (dualAcceptancePassed(review)) {
        return await finishTrainingSession("pass", `训练完成：第 ${roundIndex + 1} 次审查通过。`);
      }
      if ((review.status === "pass" || review.recommendedNextAction === "accept") && !geometryAcceptanceState().passed) {
        return await finishTrainingSession("failed", "训练暂停：视觉审查通过，但几何验收仍未通过，未进入训练样本。", new Error("geometry acceptance is still blocked"));
      }
      if (review.recommendedNextAction !== "revise") {
        return await finishTrainingSession("needs_user", `训练暂停：第 ${roundIndex + 1} 次审查需要用户确认。`);
      }
      if (roundIndex >= maxImprovements) {
        return await finishTrainingSession("max_rounds", `已达到 ${maxImprovements} 次自动改进上限，请人工检查。`);
      }
      if (state.trainingStopRequested) return await finishTrainingSession("stopped", "训练模式已停止。 ");

      setTrainingStatus("running", `第 ${roundIndex + 1} 次改进：正在生成局部补丁、构建并验证...`);
      state.trainingSession.phase = "improving";
      await persistTrainingSession();
      const improvement = await improveFromVisualReview({ rethrow: true, reReview: false });
      round.improvement = {
        reply: improvement.reply || "",
        editPatch: improvement.editPatch || null,
        revision: improvement.revision ? {
          id: improvement.revision.id || improvement.revision.currentRevision || null,
          status: improvement.revision.status || null,
          affectedPartIds: improvement.revision.affectedPartIds || []
        } : null,
        appliedRevision: improvement.assembly?.currentRevision || null,
        attempts: improvement.attempts || []
      };
      state.trainingSession.phase = "persisted";
      await persistTrainingSession();
      await waitForAssemblyModel(improvement.assembly?.id || assembly.id, improvement.assembly?.currentRevision);
    }
  } catch (error) {
    if (error.code === "AMBIGUOUS_IMPROVEMENT" || error.code === "REVIEW_STALE") {
      return finishTrainingSession("needs_user", `训练暂停：${error.message || error}`, error);
    }
    if (/timed out|timeout|超时/i.test(String(error?.message || error))) {
      return finishTrainingSession("timeout", `训练暂缓：视觉审查超时，当前装配和已有训练记录已保留；可稍后重新运行。`, error);
    }
    return finishTrainingSession("failed", `训练失败：${error.message || error}`, error);
  } finally {
    state.trainingRunning = false;
    updateTrainingControls();
  }
}

async function runAutomaticReviewLoop({ request, assembly }) {
  const maxImprovements = 6;
  if (state.autoReviewRunning || state.trainingRunning) return null;
  state.autoReviewRunning = true;
  updateTrainingControls();
  els.visualReviewPanel.hidden = false;
  els.visualReviewStatus.textContent = "自动审查中";
  els.visualImproveStatus.textContent = "生成完成后自动审查；发现可可靠修复的问题会自动改进。";
  const seenReviewStates = new Set();
  try {
    assembly = await ensureGeometryAcceptance(assembly);
    if (!assembly) return state.currentVisualReview;
    await waitForAssemblyModel(assembly.id, assembly.currentRevision);
    for (let roundIndex = 0; roundIndex <= maxImprovements; roundIndex += 1) {
      if (!state.currentAssembly) return null;
      assembly = state.currentAssembly;
      const review = await runVisualReview({ rethrow: true });
      const reviewFingerprint = visualReviewFingerprint(review, state.currentAssembly);
      if (dualAcceptancePassed(review)) {
        els.visualImproveStatus.textContent = `自动审查通过：第 ${roundIndex + 1} 轮。`;
        return review;
      }
      if (seenReviewStates.has(reviewFingerprint)) {
        review.recommendedNextAction = "ask_user";
        review.autoLoopStopReason = "no_progress";
        els.visualImproveStatus.textContent = "自动审查无进展：连续结果相同，等待新的尺寸、约束或人工输入。";
        renderVisualReview();
        return review;
      }
      seenReviewStates.add(reviewFingerprint);
      if ((review.status === "pass" || review.recommendedNextAction === "accept") && !geometryAcceptanceState().passed) {
        review.recommendedNextAction = "ask_user";
        review.autoLoopStopReason = "geometry_blocked";
        els.visualImproveStatus.textContent = `视觉审查通过，但几何验收仍有 ${geometryAcceptanceState().errors} 个阻断问题，继续等待几何修复。`;
        renderVisualReview();
        return review;
      }
      const actionable = review.findings?.some((finding) => (
        finding.actionability === "auto" && finding.confidence !== "low" && finding.partId
          && finding.proposedChange?.op && finding.verification?.method && finding.verification?.expected
      ));
      const reportRepairable = review.findings?.some((finding) => (
        finding.confidence === "high" && finding.message
          && finding.actionability === "needs_user"
          && (finding.category === "requirement" || (finding.category === "visual" && finding.partId))
      ));
      if (!actionable && reportRepairable && roundIndex < maxImprovements) {
        const repairResult = await repairFromVisualReviewReport(review);
        if (repairResult?.assembly?.status === "done") {
          assembly = repairResult.assembly;
          await waitForAssemblyModel(assembly.id, assembly.currentRevision);
          continue;
        }
        review.recommendedNextAction = "ask_user";
        review.autoLoopStopReason = "report_repair_failed";
        renderVisualReview();
        return review;
      }
      if (review.recommendedNextAction !== "revise" || !actionable) {
        els.visualImproveStatus.textContent = "审查完成：剩余问题需要后期输入尺寸、约束或人工确认。";
        return review;
      }
      if (roundIndex >= maxImprovements) {
        els.visualImproveStatus.textContent = `自动改进达到 ${maxImprovements} 轮上限，等待后期尺寸输入。`;
        return review;
      }
      els.visualImproveStatus.textContent = `审查发现可执行问题，自动改进第 ${roundIndex + 1} 轮...`;
      const improvement = await improveFromVisualReview({ rethrow: true, reReview: false });
      if (!improvement?.assembly || improvement.assembly.status !== "done") return review;
      await waitForAssemblyModel(improvement.assembly.id, improvement.assembly.currentRevision);
    }
  } catch (error) {
    els.visualImproveStatus.textContent = `自动审查/改进失败：${error.message || error}`;
    els.visualImproveStatus.classList.add("error");
    return null;
  } finally {
    state.autoReviewRunning = false;
    updateTrainingControls();
  }
}

async function waitForAssemblyModel(assemblyId, revisionId, timeoutMs = 20000) {
  const expected = assemblyModelKey({ id: assemblyId, currentRevision: revisionId });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.loadedAssemblyModelKey === expected && mesh) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待3D装配预览加载超时");
}

async function persistTrainingSession() {
  if (!state.trainingSession) return null;
  return api("/api/training/session", { method: "POST", body: state.trainingSession });
}

async function finishTrainingSession(status, message, error = null) {
  if (!state.trainingSession) return null;
  state.trainingSession.status = status;
  state.trainingSession.phase = "completed";
  state.trainingSession.completedAt = new Date().toISOString();
  state.trainingSession.finalRevision = state.currentAssembly?.currentRevision || null;
  state.trainingSession.finalReview = state.currentVisualReview || null;
  if (error) state.trainingSession.error = error.message || String(error);
  setTrainingStatus(status === "pass" ? "pass" : status === "failed" ? "fail" : "warning", message);
  pushMessage("assistant", message);
  try {
    return await persistTrainingSession();
  } catch (persistError) {
    els.log.classList.add("error");
    els.log.textContent = `训练结果归档失败：${persistError.message || persistError}`;
    return null;
  }
}

function setTrainingStatus(kind, message) {
  const panel = els.trainingStatus.closest(".training-panel");
  panel.classList.remove("running", "pass", "warning", "fail");
  if (kind) panel.classList.add(kind);
  els.trainingStatus.textContent = message;
}

function renderTrainingStatus() {
  if (state.trainingRunning) return;
  setTrainingStatus("", state.trainingMode ? "已启用：下一次生成将自动进入训练闭环。" : "未启动");
  updateTrainingControls();
}

function updateTrainingControls() {
  els.trainingModeEnabled.checked = state.trainingMode;
  els.trainingModeEnabled.disabled = state.trainingRunning;
  els.resetChatBtn.disabled = state.trainingRunning;
  els.trainingStopBtn.hidden = !state.trainingRunning;
  els.trainingStopBtn.disabled = !state.trainingRunning || state.trainingStopRequested;
  els.sendChatBtn.textContent = state.trainingMode ? "发送并启动训练" : "发送并生成模型";
  els.visualReviewBtn.disabled = state.trainingRunning || state.autoReviewRunning || !(state.currentAssembly?.id && ["done", "validation_failed"].includes(state.currentAssembly?.status) && mesh);
  updateVisualImproveButton();
}

async function captureReviewScreenshots() {
  const displayState = cadViewer?.captureDisplayState?.();
  const screenshots = [];
  try {
    cadViewer?.showAll();
    screenshots.push(
      captureReviewView("3d"),
      captureReviewView("front"),
      captureReviewView("top"),
      captureReviewView("side")
    );
    const enclosurePartIds = (state.currentAssembly?.parts || [])
      .filter((part) => /housing|cover|shell|enclosure|casing|箱体|箱盖|外壳|壳体/i.test(`${part.id || ""} ${part.name || ""} ${part.role || ""}`))
      .map((part) => part.id);
    if (enclosurePartIds.length) {
      cadViewer?.setReviewTransparency(enclosurePartIds, 0.08);
      screenshots.push(captureReviewView("3d", "section"));
    }
    if ((state.currentAssembly?.parts || []).length > 1 && screenshots.length < 6) {
      cadViewer?.restoreDisplayState?.(displayState);
      cadViewer?.setExplodedReview?.(0.22);
      cadViewer?.setReviewVisibility?.(enclosurePartIds, false);
      screenshots.push(captureReviewView("3d", "exploded"));
    }
    return screenshots;
  } finally {
    cadViewer?.restoreDisplayState?.(displayState);
    updateViewerControls();
    drawViewer();
  }
}

function captureReviewView(view, name = view) {
  const previous = {
    viewPreset: state.viewPreset,
    angleX: state.angleX,
    angleY: state.angleY,
    angleZ: state.angleZ,
    zoom: state.zoom
  };
  try {
    setViewPreset(view === "3d" ? "free" : view);
    state.zoom = view === "3d" ? Math.max(state.zoom, 1) : 1;
    drawViewer();
    return {
      view: name,
      name: `${name}.jpg`,
      dataUrl: els.canvas.toDataURL("image/jpeg", 0.82)
    };
  } finally {
    state.viewPreset = previous.viewPreset;
    state.angleX = previous.angleX;
    state.angleY = previous.angleY;
    state.angleZ = previous.angleZ;
    state.zoom = previous.zoom;
    cadViewer?.setViewPreset(previous.viewPreset);
    updateViewerControls();
    drawViewer();
  }
}

function updateVisualReviewButton() {
  els.visualReviewBtn.disabled = state.trainingRunning || state.autoReviewRunning || !(state.currentAssembly?.id && ["done", "validation_failed"].includes(state.currentAssembly?.status) && mesh);
  updateVisualImproveButton();
}

function updateVisualImproveButton() {
  const review = state.currentVisualReview;
  const currentRevision = state.currentAssembly?.currentRevision;
  const hasReportedFindings = Boolean(review && review.status !== "pass" && review.findings?.length);
  const hasFindings = Boolean(review && review.status !== "pass" && review.findings?.some((finding) => (
    finding.actionability === "auto" && finding.confidence !== "low" && finding.partId && finding.proposedChange?.op
      && finding.verification?.method && finding.verification?.expected
  )));
  const applied = review?.improvement?.status === "applied";
  const current = Boolean(review?.revisionId && currentRevision && review.revisionId === currentRevision);
  els.visualImproveBtn.hidden = !hasReportedFindings;
  els.visualImproveBtn.disabled = state.trainingRunning || state.autoReviewRunning || state.visualImprovementBusy || !hasFindings || !current || applied;
  els.visualImproveBtn.textContent = state.visualImprovementBusy ? "改进与复审中..." : applied ? "已生成改进版本" : hasFindings ? "根据反馈改进并复审" : "需测量或确认";
}

function renderVisualReview() {
  const review = state.currentVisualReview;
  if (!review) {
    els.visualReviewPanel.hidden = true;
    if (els.visualAcceptanceStatus) {
      els.visualAcceptanceStatus.textContent = "双重验收：等待几何与视觉审查";
      els.visualAcceptanceStatus.className = "visual-acceptance-status pending";
    }
    els.visualReviewStatus.textContent = "未运行";
    els.visualReviewSummary.textContent = "";
    els.visualReviewFindings.innerHTML = "";
    els.visualImproveStatus.textContent = "";
    els.visualImprovementTrace.innerHTML = "";
    updateVisualImproveButton();
    return;
  }
  els.visualReviewPanel.hidden = false;
  const acceptance = state.currentAssembly?.acceptance || refreshClientAcceptance(review);
  const geometry = acceptance?.geometry || geometryAcceptanceState();
  const visual = acceptance?.visual || {};
  if (els.visualAcceptanceStatus) {
    els.visualAcceptanceStatus.textContent = acceptance?.passed
      ? "双重验收：通过 · BREP/STEP 几何 + 视觉审查"
      : `双重验收：${geometry.passed ? "几何通过" : `几何阻断 ${geometry.errors || geometry.blockingErrorCount || 0} 项`} · ${visual.passed ? "视觉通过" : "视觉未通过"}`;
    els.visualAcceptanceStatus.className = `visual-acceptance-status ${acceptance?.passed ? "pass" : "pending"}`;
  }
  els.visualReviewPanel.dataset.status = review.status || "warning";
  els.visualReviewStatus.textContent = visualReviewStatusText(review.status);
  els.visualReviewSummary.textContent = review.summary || "没有摘要。";
  const findings = Array.isArray(review.findings) ? review.findings : [];
  els.visualReviewFindings.innerHTML = findings.length
    ? findings.map((finding) => `
      <article class="visual-review-finding ${escapeHtml(finding.severity || "warning")}">
        <div class="finding-head">
          <strong>${escapeHtml(finding.findingId || "问题")} · ${escapeHtml(finding.category || "visual")} · ${escapeHtml(finding.severity || "warning")}</strong>
          <span class="finding-badges">${escapeHtml(actionabilityText(finding.actionability))} · ${escapeHtml(confidenceText(finding.confidence))}</span>
        </div>
        <span>${escapeHtml(finding.message || "")}</span>
        ${finding.partId ? `<button type="button" class="finding-target" data-review-target data-part-id="${escapeHtml(finding.partId)}" data-feature-id="${escapeHtml(finding.featureId || "")}">定位 ${escapeHtml(finding.partId)}${finding.featureId ? ` / ${escapeHtml(finding.featureId)}` : ""}</button>` : `<small class="finding-unresolved">目标未唯一定位</small>`}
        ${finding.proposedChange?.op ? `<div class="finding-change"><b>拟修改</b><code>${escapeHtml(formatProposedChange(finding.proposedChange))}</code>${finding.proposedChange.reason ? `<small>${escapeHtml(finding.proposedChange.reason)}</small>` : ""}</div>` : ""}
        ${finding.verification?.method ? `<div class="finding-verification"><b>验证</b><span>${escapeHtml(finding.verification.method)}${finding.verification.expected ? ` → ${escapeHtml(finding.verification.expected)}` : ""}</span></div>` : ""}
        ${finding.evidence?.length ? `<small>${escapeHtml(finding.evidence.join(", "))}</small>` : ""}
      </article>
    `).join("")
    : `<div class="empty-list">未报告具体问题。</div>`;
  if (review.improvement?.status === "applied") {
    els.visualImproveStatus.textContent = `已从 ${review.revisionId} 生成改进版本 ${review.improvement.revisionId}，请重新审查。`;
  } else if (!review.revisionId) {
    els.visualImproveStatus.textContent = "这是旧版审查报告，需重新运行视觉审查后才能自动改进。";
  } else if (review.revisionId && review.revisionId !== state.currentAssembly?.currentRevision) {
    els.visualImproveStatus.textContent = "该报告对应旧版本，请重新运行视觉审查。";
  } else if (findings.length && !findings.some((finding) => finding.actionability === "auto" && finding.confidence !== "low" && finding.partId && finding.proposedChange?.op && finding.verification?.method && finding.verification?.expected)) {
    els.visualImproveStatus.textContent = "这些问题需要几何测量或用户确认，系统没有猜测参数并自动修改。";
  } else {
    els.visualImproveStatus.textContent = "";
  }
  renderVisualImprovementTrace(review);
  updateVisualImproveButton();
}

function focusReviewFinding(partId, featureId = null) {
  if (!partId) return;
  state.activePartId = partId;
  state.activeFeatureId = featureId || null;
  if (state.currentPlan) {
    state.currentPlan.activePartId = partId;
    state.currentPlan.activeFeatureId = featureId || null;
  }
  const planPart = state.currentPlan?.parts?.find((part) => part.id === partId);
  const treePart = state.parametricTree?.parts?.find((part) => part.id === partId);
  const feature = treePart?.featureTree?.find((item) => item.id === featureId)
    || planPart?.features?.find((item) => item.id === featureId);
  els.activePartName.textContent = feature
    ? `${planPart?.name || treePart?.name || partId} / ${feature.name || feature.id}`
    : planPart?.name || treePart?.name || partId;
  els.code.value = feature
    ? JSON.stringify({ partId, feature }, null, 2)
    : planPart ? partToFeatureJson(planPart) : JSON.stringify({ partId }, null, 2);
  localStorage.setItem("ai-cad-code", els.code.value);
  cadViewer?.selectPart(partId, { frame: true });
  renderParts();
  renderFeatureTree();
  updateViewerControls();
}

function renderVisualImprovementTrace(review) {
  const improvement = review?.improvement;
  const attempts = Array.isArray(improvement?.attempts) ? improvement.attempts : [];
  if (!improvement || !attempts.length) {
    els.visualImprovementTrace.innerHTML = "";
    return;
  }
  els.visualImprovementTrace.innerHTML = `
    <strong class="trace-title">问题 → 修改 → 验证</strong>
    ${attempts.map((attempt) => {
      const operations = attempt.patch?.operations || attempt.editPatch?.operations || [];
      const issues = attempt.validationReport?.issues || [];
      const errorCount = attempt.validationReport?.blockingErrorCount ?? attempt.validationErrorCount ?? 0;
      return `<article class="improvement-attempt ${escapeHtml(attempt.status || "failed")}">
        <div><b>候选 ${escapeHtml(String(attempt.index || 1))}</b><span>${escapeHtml(attempt.status || "unknown")} · 阻断错误 ${escapeHtml(String(errorCount))}</span></div>
        ${operations.length ? `<ul>${operations.map((operation) => `<li><code>${escapeHtml(formatPatchOperation(operation))}</code></li>`).join("")}</ul>` : `<small>未返回可显示的修改操作</small>`}
        ${attempt.reply ? `<p>${escapeHtml(attempt.reply)}</p>` : ""}
        ${issues.length ? `<small class="trace-errors">${escapeHtml(issues.slice(0, 4).map((issue) => `${issue.code || issue.severity}: ${issue.message || "验证失败"}`).join(" | "))}</small>` : errorCount ? `<small class="trace-errors">存在 ${escapeHtml(String(errorCount))} 个阻断错误，详细报告未返回</small>` : `<small class="trace-ok">验证通过</small>`}
      </article>`;
    }).join("")}
  `;
}

function formatProposedChange(change) {
  const path = change.path ? ` ${change.path}` : "";
  const value = change.value === null || change.value === undefined ? "" : ` = ${JSON.stringify(change.value)}`;
  return `${change.op}${path}${value}`;
}

function formatPatchOperation(operation) {
  const target = operation.featureId || operation.partId || operation.constraintId || "unknown-target";
  const path = operation.path ? ` ${operation.path}` : "";
  const value = operation.value === undefined ? "" : ` = ${JSON.stringify(operation.value)}`;
  return `${operation.op || "operation"} ${target}${path}${value}`;
}

function actionabilityText(value) {
  return ({ auto: "可自动修改", needs_measurement: "需要测量", needs_user: "需要确认", informational: "仅提示" })[value] || "需要确认";
}

function confidenceText(value) {
  return ({ high: "高置信", medium: "中置信", low: "低置信" })[value] || "低置信";
}

function visualReviewStatusText(status) {
  const map = {
    pass: "通过",
    warning: "有警告",
    fail: "未通过"
  };
  return map[status] || "有警告";
}

function scheduleRender() {
  if (!state.autoRenderReady) return;
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => previewCadQuery(), 700);
}

async function previewCadQuery({ force = false, download = false } = {}) {
  if (!els.code.value.trim()) return;
  const sequence = ++state.previewSeq;
  setBusy(els.renderBtn, true);
  els.renderState.textContent = "正在生成 CadQuery 预览...";
  try {
    const preview = await api("/api/preview", {
      method: "POST",
      body: { code: els.code.value }
    });
    if (!force && sequence !== state.previewSeq) return;
    state.currentJobId = preview.id;
    els.jobId.textContent = preview.id;
    els.renderState.textContent = "预览完成";
    els.log.classList.remove("error");
    els.log.textContent = JSON.stringify({
      id: preview.id,
      engine: "cadquery",
      output: preview.fcstdUrl ? "FreeCAD FCStd primary, STEP compatibility, STL preview" : "STEP compatibility, STL preview",
      part: preview.part?.name || preview.part?.id
    }, null, 2);
    if (preview.stlUrl) {
      state.viewMode = "part";
      els.downloadLink.hidden = false;
      els.downloadLink.href = preview.stlUrl;
      await loadStl(preview.stlUrl, { label: preview.part?.name || preview.part?.id || "当前零件" });
      if (download) window.location.href = preview.stlUrl;
    } else if (preview.pngUrl || preview.assemblyPngUrl) {
      showPreviewImage(preview.pngUrl || preview.assemblyPngUrl);
    }
    setDownload(els.fcstdLink, preview.fcstdUrl);
    setDownload(els.stepLink, preview.stepUrl);
    setDownload(els.assemblyStlLink, preview.assemblyStlUrl);
    setDownload(els.kinematicPackageLink, preview.kinematicPackageUrl);
    setDownload(els.constraintsLink, preview.constraintManifestUrl);
    setDownload(els.manifestLink, preview.manifestUrl);
  } catch (error) {
    setError(error);
  } finally {
    setBusy(els.renderBtn, false);
  }
}

function showPreviewImage(url) {
  cadViewer?.cancelPendingLoad();
  els.canvas.style.display = "none";
  els.canvas.hidden = true;
  els.previewImage.hidden = false;
  els.previewImage.style.opacity = "1";
  els.previewImage.src = `${url}?t=${Date.now()}`;
  els.emptyPreview.hidden = true;
}

function resetViewerStage() {
  clearGeneratedPreview("等待 3D 预览");
}

function clearGeneratedPreview(message = "等待 3D 预览") {
  cadViewer?.cancelPendingLoad();
  cadViewer?.clearModel();
  cadViewer?.render();
  mesh = null;
  state.loadedAssemblyModelKey = "";
  state.currentStlUrl = "";
  els.canvas.style.display = "none";
  els.canvas.hidden = true;
  els.previewImage.hidden = true;
  els.previewImage.removeAttribute("src");
  els.emptyPreview.hidden = false;
  els.viewerStats.textContent = message;
  updateViewerControls();
}

function resetView() {
  setViewPreset("free");
}

function setViewPreset(name) {
  const preset = VIEW_PRESETS[name] || VIEW_PRESETS.free;
  state.viewPreset = name in VIEW_PRESETS ? name : "free";
  state.angleX = preset.angleX;
  state.angleY = preset.angleY;
  state.angleZ = preset.angleZ;
  cadViewer?.setViewPreset(state.viewPreset);
  updateViewerControls();
}

function isOrthoView() {
  return Boolean(VIEW_PRESETS[state.viewPreset]?.ortho);
}

function updateViewerControls() {
  els.viewAssemblyBtn.disabled = !state.currentAssembly?.glbUrl && !state.currentAssembly?.stlUrl;
  els.viewPartBtn.disabled = !state.currentAssembly?.parts?.some((part) => part.stlUrl);
  els.resetViewBtn.disabled = !mesh;
  els.wireframeBtn.disabled = !mesh;
  const hasSelection = Boolean(cadViewer?.selectedPartId);
  els.hidePartBtn.disabled = !hasSelection;
  els.isolatePartBtn.disabled = !hasSelection;
  els.showAllPartsBtn.disabled = !mesh;
  els.ghostModeBtn.disabled = !hasSelection;
  els.ghostModeBtn.classList.toggle("active", state.ghostMode);
  updateVisualReviewButton();
  els.viewAssemblyBtn.classList.toggle("active", state.viewMode === "assembly");
  els.viewPartBtn.classList.toggle("active", state.viewMode === "part");
  els.wireframeBtn.classList.toggle("active", state.wireframe);
  for (const [button, preset] of [
    [els.view3dBtn, "free"],
    [els.viewFrontBtn, "front"],
    [els.viewTopBtn, "top"],
    [els.viewSideBtn, "side"]
  ]) {
    button.disabled = !mesh;
    button.classList.toggle("active", state.viewPreset === preset);
  }
}

function statusText(status) {
  const map = {
    queued: "已排队",
    building: "正在构建装配",
    rendering: "正在生成预览",
    exporting: "导出中",
    done: "完成",
    validation_failed: "模型已生成，验证未通过",
    error: "失败"
  };
  return map[status] || status;
}

function partToFeatureJson(part) {
  const payload = {
    id: part.id,
    name: part.name,
    role: part.role,
    mode: part.mode || "generated",
    standardPart: part.standardPart || null,
    sourceStepPath: part.sourceStepPath || null,
    primitives: part.primitives || [],
    features: part.features || [],
    pose: part.pose || { translate: [0, 0, 0], rotate: [0, 0, 0] }
  };
  return JSON.stringify(payload, null, 2);
}

function setBusy(button, busy) {
  button.disabled = busy;
}

function setError(error) {
  els.renderState.textContent = "错误";
  els.log.classList.add("error");
  els.log.textContent = error.message || String(error);
}

function renderFSB(snapshot, latest = null) {
  if (!els.fsbStatus) return;
  const document = fsb.document();
  const hasAnalysis = document.functions?.length && document.behaviors?.length && document.structures?.length;
  const status = hasAnalysis
    ? `已归档 · R→F→Be→S · ${latest ? `最近事件：${latest.type}` : "可检查候选"}`
    : latest ? `事件：${latest.type}` : "已连接 · 聊天发送后自动分析";
  els.fsbStatus.textContent = status;
  els.fsbSnapshot.textContent = JSON.stringify(snapshot || fsb.snapshot(), null, 2);
  els.fsbEvents.innerHTML = fsb.history().slice(-12).reverse().map((event) => `<div class="fsb-event"><strong>${escapeHtml(event.type)}</strong><br>${escapeHtml(new Date(event.at).toLocaleTimeString())} · ${escapeHtml(JSON.stringify(event.payload || {}))}</div>`).join("") || '<div class="empty-list">暂无事件</div>';
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setupViewer() {
  try {
    els.canvas.style.display = "block";
    els.canvas.hidden = false;
    cadViewer = new CadViewer(els.canvas, {
      onSelect: handleViewerSelection,
      onStats: updateViewerStats
    });
    cadViewer.resize();
  } catch (error) {
    els.viewerStats.textContent = "Three.js 初始化失败，将使用 PNG 备用预览";
    els.log.textContent = error.message || String(error);
  }
  updateViewerControls();
}

function handleViewerSelection(partId) {
  if (!partId) {
    updateViewerControls();
    renderParts();
    return;
  }
  const part = state.currentPlan?.parts?.find((item) => item.id === partId);
  if (!part) return;
  state.activePartId = part.id;
  const text = partToFeatureJson(part);
  els.code.value = text;
  localStorage.setItem("ai-cad-code", text);
  els.activePartName.textContent = part.name;
  renderParts();
  updateViewerControls();
}

function updateViewerStats(stats) {
  const selected = stats.selectedPartId ? ` | 选中 ${stats.selectedPartId}` : "";
  const format = stats.format ? `${stats.format} | ` : "";
  els.viewerStats.textContent = `${format}${stats.parts || stats.meshes} parts | ${stats.triangles.toLocaleString()} triangles${selected}`;
  mesh = stats.meshes ? stats : null;
  updateViewerControls();
}

async function loadGlb(url, options = {}) {
  if (!cadViewer) throw new Error("Three.js 查看器不可用");
  els.viewerStats.textContent = `加载 GLB：${options.label || "装配"}`;
  showThreeViewerStage();
  const stats = await cadViewer.loadGlb(url, options);
  if (!stats) return null;
  mesh = stats;
  state.viewMode = "assembly";
  state.ghostMode = false;
  updateViewerControls();
  return stats;
}

async function loadStl(url, options = {}) {
  if (!url) return;
  state.currentStlUrl = url;
  els.viewerStats.textContent = `加载 3D：${options.label || "STL"}`;
  updateViewerControls();
  if (!cadViewer) return;
  try {
    showThreeViewerStage();
    const stats = await cadViewer.loadStl(url, { ...options, partId: state.viewMode === "part" ? state.activePartId : null });
    if (!stats) return null;
    mesh = stats;
    updateViewerControls();
    return stats;
  } catch (error) {
    els.log.classList.add("error");
    els.log.textContent = `3D 预览失败，已保留 PNG 预览：${error.message || error}`;
    els.viewerStats.textContent = "3D 预览失败";
  }
}

function showThreeViewerStage() {
  els.canvas.style.display = "block";
  els.canvas.hidden = false;
  els.previewImage.hidden = true;
  els.previewImage.style.opacity = "0";
  els.emptyPreview.hidden = true;
  cadViewer?.resize();
}

function parseStl(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength >= 84) {
    const count = view.getUint32(80, true);
    const expectedLength = 84 + count * 50;
    if (expectedLength === buffer.byteLength) {
      return parseBinaryStl(view, count);
    }
  }
  return parseAsciiStl(new TextDecoder().decode(buffer));
}

function parseBinaryStl(view, count) {
  const vertices = [];
  const normals = [];
  let offset = 84;
  for (let i = 0; i < count; i++) {
    const normal = [
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true)
    ];
    offset += 12;
    for (let v = 0; v < 3; v++) {
      vertices.push(
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true)
      );
      normals.push(...normal);
      offset += 12;
    }
    offset += 2;
  }
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function parseAsciiStl(text) {
  const vertices = [];
  const normals = [];
  const facetPattern = /facet\s+normal\s+([^\n\r]+)[\s\S]*?outer\s+loop([\s\S]*?)endloop/gi;
  let match;
  while ((match = facetPattern.exec(text))) {
    const normal = match[1].trim().split(/\s+/).map(Number).slice(0, 3);
    const vertexLines = [...match[2].matchAll(/vertex\s+([^\n\r]+)/gi)];
    if (normal.length !== 3 || vertexLines.length < 3 || normal.some(Number.isNaN)) continue;
    for (const line of vertexLines.slice(0, 3)) {
      const vertex = line[1].trim().split(/\s+/).map(Number).slice(0, 3);
      if (vertex.length !== 3 || vertex.some(Number.isNaN)) continue;
      vertices.push(...vertex);
      normals.push(...normal);
    }
  }
  if (!vertices.length) throw new Error("无法解析 STL 文件。");
  return { vertices: new Float32Array(vertices), normals: new Float32Array(normals) };
}

function createMesh({ vertices, normals }, options = {}) {
  const bounds = computeBounds(vertices);
  if (options.keepLocal) {
    return {
      vertices,
      normals,
      count: vertices.length / 3,
      center: bounds.center,
      size: bounds.size
    };
  }
  if (!gl) {
    return {
      vertices,
      normals,
      count: vertices.length / 3,
      center: bounds.center,
      scale: 2 / Math.max(bounds.size[0], bounds.size[1], bounds.size[2], 1)
    };
  }
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  const normalBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);

  return {
    vertexBuffer,
    normalBuffer,
    count: vertices.length / 3,
    center: bounds.center,
    scale: 2 / Math.max(bounds.size[0], bounds.size[1], bounds.size[2], 1)
  };
}

function drawViewer() {
  if (cadViewer) {
    cadViewer.resize();
    return;
  }
  if (!mesh) return;
  if (!gl || !shader) return drawViewer2d();
  resizeCanvas();
  gl.viewport(0, 0, els.canvas.width, els.canvas.height);
  gl.clearColor(0.035, 0.045, 0.04, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(shader.program);

  const aspect = els.canvas.width / Math.max(els.canvas.height, 1);
  const rotation = multiply(
    rotateX(state.angleX),
    multiply(rotateY(state.angleY), rotateZ(state.angleZ))
  );
  const viewProjection = isOrthoView()
    ? multiply(
        ortho((1.7 / state.zoom) * aspect, 1.7 / state.zoom, 0.1, 100),
        multiply(translate(0, 0, -6), rotation)
      )
    : multiply(
        perspective(45 * Math.PI / 180, aspect, 0.1, 100),
        multiply(translate(0, 0, -4 / state.zoom), rotation)
      );
  const model = multiply(
    scale(mesh.scale, mesh.scale, mesh.scale),
    translate(-mesh.center[0], -mesh.center[1], -mesh.center[2])
  );
  const mvp = multiply(viewProjection, model);

  gl.uniformMatrix4fv(shader.uniforms.mvp, false, new Float32Array(mvp));
  gl.uniformMatrix4fv(shader.uniforms.model, false, new Float32Array(model));
  gl.uniform3f(shader.uniforms.light, 0.4, 0.7, 1.0);

  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertexBuffer);
  gl.enableVertexAttribArray(shader.attribs.position);
  gl.vertexAttribPointer(shader.attribs.position, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normalBuffer);
  gl.enableVertexAttribArray(shader.attribs.normal);
  gl.vertexAttribPointer(shader.attribs.normal, 3, gl.FLOAT, false, 0, 0);

  gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  if (state.wireframe) {
    gl.uniform1i(shader.uniforms.flat, 1);
    gl.drawArrays(gl.LINES, 0, mesh.count);
    gl.uniform1i(shader.uniforms.flat, 0);
  }
  drawViewerOverlay(viewProjection);
}

function drawViewerOverlay(viewProjection) {
  if (!gl || !shader) return;
  const gridSize = 1.65;
  const lines = [];
  for (let i = -10; i <= 10; i++) {
    const p = i / 10 * gridSize;
    lines.push(-gridSize, p, 0, gridSize, p, 0);
    lines.push(p, -gridSize, 0, p, gridSize, 0);
  }
  const axes = [
    0, 0, 0, gridSize * 1.16, 0, 0,
    0, 0, 0, 0, gridSize * 1.16, 0,
    0, 0, 0, 0, 0, gridSize * 1.16
  ];
  drawLines(lines, viewProjection, [0.34, 0.42, 0.38], 0.34);
  drawLines(axes, viewProjection, [0.9, 0.72, 0.38], 0.95);
}

function drawLines(vertices, matrix, color, alpha) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STREAM_DRAW);
  gl.uniformMatrix4fv(shader.uniforms.mvp, false, new Float32Array(matrix));
  gl.uniformMatrix4fv(shader.uniforms.model, false, new Float32Array(identity()));
  gl.uniform3f(shader.uniforms.lineColor, color[0], color[1], color[2]);
  gl.uniform1f(shader.uniforms.lineAlpha, alpha);
  gl.uniform1i(shader.uniforms.flat, 1);
  gl.enableVertexAttribArray(shader.attribs.position);
  gl.vertexAttribPointer(shader.attribs.position, 3, gl.FLOAT, false, 0, 0);
  gl.disableVertexAttribArray(shader.attribs.normal);
  gl.vertexAttrib3f(shader.attribs.normal, 0, 0, 1);
  gl.drawArrays(gl.LINES, 0, vertices.length / 3);
  gl.uniform1i(shader.uniforms.flat, 0);
  gl.deleteBuffer(buffer);
}

function drawViewer2d() {
  if (!ctx2d || !mesh?.vertices) return;
  resizeCanvas();
  const width = els.canvas.width;
  const height = els.canvas.height;
  ctx2d.clearRect(0, 0, width, height);
  ctx2d.fillStyle = "#0f1411";
  ctx2d.fillRect(0, 0, width, height);

  const triangles = [];
  const vertices = mesh.vertices;
  const normals = mesh.normals;
  const fit = 0.72 * Math.min(width, height) * state.zoom;
  const light = normalize3([0.35, -0.6, 0.72]);

  for (let index = 0; index < vertices.length; index += 9) {
    const p0 = projectVertex(vertices, index, mesh, fit, width, height);
    const p1 = projectVertex(vertices, index + 3, mesh, fit, width, height);
    const p2 = projectVertex(vertices, index + 6, mesh, fit, width, height);
    const normal = rotatePoint([
      normals[index] || 0,
      normals[index + 1] || 0,
      normals[index + 2] || 1
    ]);
    const shade = clamp(dot3(normalize3(normal), light), 0, 1);
    triangles.push({
      points: [p0, p1, p2],
      depth: (p0.z + p1.z + p2.z) / 3,
      shade
    });
  }

  triangles.sort((a, b) => a.depth - b.depth);
  for (const tri of triangles) {
    const warm = Math.round(118 + tri.shade * 120);
    const green = Math.round(84 + tri.shade * 92);
    const blue = Math.round(42 + tri.shade * 48);
    ctx2d.beginPath();
    ctx2d.moveTo(tri.points[0].x, tri.points[0].y);
    ctx2d.lineTo(tri.points[1].x, tri.points[1].y);
    ctx2d.lineTo(tri.points[2].x, tri.points[2].y);
    ctx2d.closePath();
    ctx2d.fillStyle = `rgb(${warm}, ${green}, ${blue})`;
    ctx2d.fill();
    ctx2d.strokeStyle = "rgba(255, 226, 168, 0.12)";
    ctx2d.lineWidth = Math.max(1, width / 900);
    ctx2d.stroke();
  }
}

function projectVertex(vertices, index, meshData, fit, width, height) {
  const centered = [
    (vertices[index] - meshData.center[0]) * meshData.scale,
    (vertices[index + 1] - meshData.center[1]) * meshData.scale,
    (vertices[index + 2] - meshData.center[2]) * meshData.scale
  ];
  const rotated = rotatePoint(centered);
  const perspectiveScale = isOrthoView() ? fit / 3.4 : fit / (3.4 - rotated[2] * 0.28);
  return {
    x: width / 2 + rotated[0] * perspectiveScale,
    y: height / 2 - rotated[1] * perspectiveScale,
    z: rotated[2]
  };
}

function rotatePoint(point) {
  const cz = Math.cos(state.angleZ);
  const sz = Math.sin(state.angleZ);
  const x0 = point[0] * cz - point[1] * sz;
  const y0 = point[0] * sz + point[1] * cz;
  const z0 = point[2];
  const cx = Math.cos(state.angleX);
  const sx = Math.sin(state.angleX);
  const cy = Math.cos(state.angleY);
  const sy = Math.sin(state.angleY);
  const y1 = y0 * cx - z0 * sx;
  const z1 = y0 * sx + z0 * cx;
  return [
    x0 * cy + z1 * sy,
    y1,
    -x0 * sy + z1 * cy
  ];
}

function createShaderProgram() {
  const vertex = compileShader(gl.VERTEX_SHADER, `
    attribute vec3 a_position;
    attribute vec3 a_normal;
    uniform mat4 u_mvp;
    uniform mat4 u_model;
    varying vec3 v_normal;
    void main() {
      gl_Position = u_mvp * vec4(a_position, 1.0);
      v_normal = mat3(u_model) * a_normal;
    }
  `);
  const fragment = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform vec3 u_light;
    uniform vec3 u_lineColor;
    uniform float u_lineAlpha;
    uniform int u_flat;
    varying vec3 v_normal;
    void main() {
      if (u_flat == 1) {
        gl_FragColor = vec4(u_lineColor, u_lineAlpha);
        return;
      }
      vec3 n = normalize(v_normal);
      float diffuse = max(dot(n, normalize(u_light)), 0.0);
      vec3 base = vec3(1.0, 0.72, 0.28);
      vec3 rim = vec3(0.52, 0.92, 0.82) * pow(1.0 - abs(n.z), 2.0);
      gl_FragColor = vec4(base * (0.34 + diffuse * 0.86) + rim * 0.42, 1.0);
    }
  `);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  return {
    program,
    attribs: {
      position: gl.getAttribLocation(program, "a_position"),
      normal: gl.getAttribLocation(program, "a_normal")
    },
    uniforms: {
      mvp: gl.getUniformLocation(program, "u_mvp"),
      model: gl.getUniformLocation(program, "u_model"),
      light: gl.getUniformLocation(program, "u_light"),
      lineColor: gl.getUniformLocation(program, "u_lineColor"),
      lineAlpha: gl.getUniformLocation(program, "u_lineAlpha"),
      flat: gl.getUniformLocation(program, "u_flat")
    }
  };
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function resizeCanvas() {
  const rect = els.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.floor(rect.width * ratio);
  const height = Math.floor(rect.height * ratio);
  if (els.canvas.width !== width || els.canvas.height !== height) {
    els.canvas.width = width;
    els.canvas.height = height;
  }
}

function computeBounds(vertices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], vertices[i + axis]);
      max[axis] = Math.max(max[axis], vertices[i + axis]);
    }
  }
  return {
    center: [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2
    ],
    size: [
      max[0] - min[0],
      max[1] - min[1],
      max[2] - min[2]
    ]
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(value) {
  const length = Math.hypot(value[0], value[1], value[2]) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0
  ];
}

function translate(x, y, z) {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1
  ];
}

function scale(x, y, z) {
  return [
    x, 0, 0, 0,
    0, y, 0, 0,
    0, 0, z, 0,
    0, 0, 0, 1
  ];
}

function identity() {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ];
}

function rotateX(rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [
    1, 0, 0, 0,
    0, c, s, 0,
    0, -s, c, 0,
    0, 0, 0, 1
  ];
}

function rotateY(rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1
  ];
}

function rotateZ(rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [
    c, s, 0, 0,
    -s, c, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ];
}

function ortho(halfWidth, halfHeight, near, far) {
  return [
    1 / halfWidth, 0, 0, 0,
    0, 1 / halfHeight, 0, 0,
    0, 0, -2 / (far - near), 0,
    0, 0, -(far + near) / (far - near), 1
  ];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      for (let i = 0; i < 4; i++) {
        out[col * 4 + row] += a[i * 4 + row] * b[col * 4 + i];
      }
    }
  }
  return out;
}
