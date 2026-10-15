import path from "node:path";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { applyEditPatch } from "./parametric-edit.js";
import { normalizeParametricPlan } from "./parametric-plan.js";
import { withAssemblyRevisionLock } from "./parametric-api.js";
import { createCandidateRevision, loadRevisionState, markRevisionFailed, writeRevisionState } from "./revision-store.js";
import { analyzeAssemblyConstraints } from "./assembly-constraints.js";
import { composeAssemblyValidationReport } from "./assembly-validation-report.js";
import { UnifiedReviewChannel } from "./unified-review-channel.js";

const native = "nvidia-usd-brep";
export const isNativeJob = job => job?.engine === native || job?.plan?.engine === native;

export function nativeAssemblyReviewEvidence(report, plan) {
  const parts = structuredClone(report.parts);
  const motion = report.motionReview;
  const motionPassed = motion?.status === "pass" && motion.engine === native && motion.cadqueryUsed === false
    && Number.isSafeInteger(motion.sampleCount) && motion.sampleCount >= 2
    && Number.isFinite(motion.minimumSampledClearanceMm) && motion.minimumSampledClearanceMm > 0
    && Number.isFinite(motion.intervalClearanceLowerEstimateMm) && motion.intervalClearanceLowerEstimateMm > 0
    && Array.isArray(motion.collisions) && motion.collisions.length === 0;
  if (parts.length > 1 && !motionPassed) {
    if (motion?.collisions?.length) {
      for (const collision of motion.collisions) {
        const partId = collision.parts[0];
        (parts.find(p=>p.partId===partId) || parts[0]).issues.push({ code:"MOTION_INTERFERENCE", severity:"error", partId,
          featureId:plan.parts.find(p=>p.id===partId)?.featureTree?.[0]?.id, ...collision,
          message:`运动干涉：${collision.parts.join(' / ')}，输入角 ${collision.inputAngleDeg.toFixed(4)}°` });
      }
    } else parts[0].issues.push({ code:"NATIVE_MOTION_REVIEW_UNVERIFIED", severity:"error",
      message:motion?.message || "装配运动范围或精度证据不足，须重新验证当前修订" });
  }
  return {parts,interferences:[],usdRoundTrip:report.usdRoundTrip,motionReview:motion || null,
    reviewStages: parts.length>1 ? [{stage:"motion_interference",status:motionPassed ? "pass" : motion?.status === "fail" ? "fail" : "unverified"}] : []};
}

export async function persistNativeState(root, job) {
  const artifacts = { usd: job.usdBrepPath, stl: job.stlPath, motion:job.motionReviewPath,
    parts: (job.parts || []).map(p => ({ usd: p.localUsdBrepPath })) };
  const state = structuredClone(job);
  delete state.pendingReviewProposal;
  await writeRevisionState(root, job.id, job.currentRevision, { plan: job.plan, validationReport: job.validationReport,
    constraintReport: job.constraintReport, parts: job.parts, nativeJob: state, artifacts });
  const target = path.join(root, job.id, "native-head.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ revisionId: job.currentRevision, savedAt: new Date().toISOString() }), "utf8");
  await rename(temporary, target);
}

export async function initializeNativeRevision({ root, job, channel }) {
  job.plan = normalizeParametricPlan({ ...job.plan, engine: native });
  const revision = await createCandidateRevision(root, job.id, job.plan, { summary: "原生模型初始可编辑版本" });
  job.currentRevision = revision.id;
  job.revisionDisposition = "draft";
  job.createdAt ||= new Date().toISOString();
  job.modifiedAt = new Date().toISOString();
  job.nativeCodePath = path.join(job.outputDir, job.plan.parts.length > 1 ? "usd_brep_assembly.py" : "usd_brep_build.py");
  job.usdMeshPath = path.join(job.outputDir, "native-mesh.usda");
  job.nativeReportPath = path.join(job.outputDir, "native-build-report.json");
  try {
    const report=JSON.parse(await readFile(job.nativeReportPath,"utf8"));
    job.parts=job.parts.map(part=>({...part,
      stlPath:report.parts ? path.join(job.outputDir,`${part.id}.stl`) : job.stlPath,
      geometryValidation:report.parts?.find(p=>p.partId===part.id) || part.geometryValidation,
      featureTrace:(Array.isArray(report.featureTrace) ? report.featureTrace : report.featureTrace?.[part.id] || []).map(t=>({...t,featureId:t.id})) }));
  } catch(error) { if(error.code!=="ENOENT") throw error; }
  try { await readFile(path.join(job.outputDir,"motion-review.json")); job.motionReviewPath=path.join(job.outputDir,"motion-review.json"); } catch { /* No motion report for a single part. */ }
  job.validationReport.revisionId = revision.id;
  await channel.bind(job);
  job.latestUnifiedReview = await channel.review(job, { profile: "delivery" });
  await persistNativeState(root, job);
  return revision;
}

export async function restoreNativeJob(root, id) {
  let head;
  try { head = JSON.parse(await readFile(path.join(root, id, "native-head.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const state = await loadRevisionState(root, id, head.revisionId);
  if (!isNativeJob(state.nativeJob)) throw new Error("Native revision engine evidence is missing");
  const job = state.nativeJob;
  job.latestUnifiedReview = await new UnifiedReviewChannel().review(job, { profile: "delivery", refresh: true });
  return job;
}

export async function revertNativeRevision({ root, job, revisionId, channel }) {
  return withAssemblyRevisionLock(root, job.id, async () => {
    const state = await loadRevisionState(root, job.id, revisionId);
    if (!isNativeJob(state.nativeJob)) throw Object.assign(new Error("目标不是完整的原生修订"), { status: 422 });
    const restored = structuredClone(state.nativeJob);
    restored.visualReview = null;
    delete restored.pendingReviewProposal;
    restored.modifiedAt = new Date().toISOString();
    restored.latestUnifiedReview = await channel.review(restored, { profile: "delivery", refresh: true });
    if (restored.latestUnifiedReview.issues?.some(i => i.stage === "integrity" && i.severity === "error")) throw Object.assign(new Error("目标原生修订的证据校验失败"), { status: 422 });
    await persistNativeState(root, restored);
    for (const key of Object.keys(job)) delete job[key];
    Object.assign(job, restored);
    return { id: revisionId, status: "draft", visualReReviewRequired: true };
  });
}

export async function editNativeRevision({ root, job, patch, bridge, channel, sourceDir, provenance = null }) {
  return withAssemblyRevisionLock(root, job.id, async () => {
    if (!isNativeJob(job)) throw new Error("Native editing requires a native job");
    if (!patch?.baseRevision || patch.baseRevision !== job.currentRevision) {
      throw Object.assign(new Error("修改补丁已过期，请重新审查当前修订"), { status: 409, code: "REVIEW_STALE" });
    }
    const integrity = await channel.review(job, { profile: "delivery", refresh: true });
    if (integrity.issues?.some(i => i.stage === "integrity" && i.severity === "error")) {
      throw Object.assign(new Error("原生实体或计划已变化，禁止复用旧审查修改"), { status: 409, code: "REVIEW_ARTIFACT_CHANGED" });
    }
    if (provenance?.evidenceHash && provenance.evidenceHash !== integrity.review.cache.evidenceHash) {
      throw Object.assign(new Error("审查证据已变化，请重新生成修改建议"), { status: 409, code: "REVIEW_STALE" });
    }
    const edit = applyEditPatch(job.plan, patch, { revisionId: job.currentRevision });
    const plan = { ...edit.plan, engine: native };
    const revision = await createCandidateRevision(root, job.id, plan, { parentRevision: job.currentRevision,
      affectedPartIds: [...new Set([...edit.affectedPartIds, ...edit.assemblyAffectedPartIds])], diff: edit.diff,
      summary: provenance ? "联合审查后二次修改 · NVIDIA 原生重建" : "原生参数修改" });
    const outputDir = path.join(root, job.id, "revisions", revision.id, "artifacts");
    await mkdir(outputDir, { recursive: true });
    try {
      // All parts rebuild under NVIDIA. Never use STEP reuse or a CadQuery fallback.
      const report = await bridge.buildAssembly({ plan, outputDir });
      if (report.engine !== native || report.cadqueryUsed !== false || !report.usdRoundTrip?.valid) {
        throw new Error("原生构建缺少 NVIDIA 内核或 USD 回读证据");
      }
      const parts = plan.parts.map(part => ({ ...part, localUsdBrepPath: path.join(outputDir, `${part.id}.usda`),
        stlPath: path.join(outputDir, `${part.id}.stl`), geometryValidation: report.parts.find(p => p.partId === part.id),
        featureTrace: (report.featureTrace[part.id] || []).map(t => ({ ...t, featureId: t.id })) }));
      const geometryValidation = nativeAssemblyReviewEvidence(report,plan);
      const staging = { id: job.id, outputDir: path.join(root, job.id), engine: native, plan, parts,
        currentRevision: revision.id, revisionDisposition: "draft", createdAt: job.createdAt || new Date().toISOString(), modifiedAt: new Date().toISOString(),
        stlPath: path.join(outputDir, "native-preview.stl"), usdBrepPath: path.join(outputDir, "native-solid.usda"),
        usdMeshPath: path.join(outputDir, "native-mesh.usda"), nativeReportPath: path.join(outputDir, "native-build-report.json"),
        nativeCodePath: path.join(outputDir, "usd_brep_assembly.py"), visualReview: null, status: "validation_failed",
        motionReviewPath:report.motionReview ? path.join(outputDir,"motion-review.json") : null,
        modificationAudit: [...(job.modificationAudit || []), { sourceRevision: job.currentRevision, revisionId: revision.id,
          patch, provenance, diff: edit.diff, at: new Date().toISOString() }] };
      staging.constraintReport = analyzeAssemblyConstraints(plan);
      staging.validationReport = composeAssemblyValidationReport({ plan, constraintReport: staging.constraintReport,
        assemblyId: job.id, revisionId: revision.id, buildSummary: { engine: native, parts,
          usdBrepPath: staging.usdBrepPath, geometryValidation } });
      await channel.bind(staging);
      staging.latestUnifiedReview = await channel.review(staging, { profile: "delivery", refresh: true });
      staging.status = staging.latestUnifiedReview.review.geometryDecision === "pass" ? "done" : "validation_failed";
      for (const script of ["usd_brep_assembly.py", "usd_brep_build.py", "usd_brep_export.py", "native_gears.py", "native_motion_review.py", "brep_review_core.py"]) {
        await copyFile(path.join(sourceDir, "scripts", script), path.join(outputDir, script));
      }
      await writeFile(path.join(outputDir, "modification-audit.json"), JSON.stringify(staging.modificationAudit, null, 2), "utf8");
      await writeFile(path.join(outputDir, "unified-review.json"), JSON.stringify(staging.latestUnifiedReview, null, 2), "utf8");
      await persistNativeState(root, staging);
      for (const key of Object.keys(job)) delete job[key];
      Object.assign(job, staging);
      return { status: "draft", id: revision.id, currentRevision: revision.id, geometryPassed: staging.status === "done",
        visualReReviewRequired: true, engine: native, affectedPartIds: edit.affectedPartIds,
        validationReport: staging.latestUnifiedReview };
    } catch (error) {
      await markRevisionFailed(root, job.id, revision.id, { code: "NATIVE_BUILD_FAILED", message: error.message });
      return { status: "failed", id: revision.id, code: "NATIVE_BUILD_FAILED", message: error.message,
        currentRevision: job.currentRevision, engine: native };
    }
  });
}
