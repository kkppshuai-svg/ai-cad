import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { attachUnifiedDecision, reviewRevisionId, REVIEW_POLICY } from "./review-policy.js";

const digest = value => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
function inside(file, root) {
  const relative = path.relative(root, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export class UnifiedReviewChannel {
  constructor({ maximumEntries = 128 } = {}) { this.maximumEntries = maximumEntries; this.cache = new Map(); }

  async bind(job) {
    const root = await realpath(job.outputDir);
    const files = [...new Set([job.stepPath, job.usdBrepPath, job.stlPath, job.glbPath,
      ...(job.parts || []).flatMap(part => [part.localStepPath, part.localUsdBrepPath])].filter(Boolean))];
    job.reviewPlanChecksum = digest(job.plan);
    job.reviewBindings = await Promise.all(files.map(async file => {
      try {
        const resolved = await realpath(file);
        if (!inside(resolved, root)) throw Error("Artifact is outside the model directory");
        return { path: file, sha256: await fileDigest(resolved) };
      } catch { return { path: file, sha256: null }; }
    }));
    return { boundArtifacts: files.length };
  }

  async review(job, { profile = "geometry", refresh = false } = {}) {
    if (!["geometry", "delivery"].includes(profile)) throw Object.assign(new Error("Unknown review profile"), { status: 400 });
    const start = performance.now();
    const issues = [];
    const root = await realpath(job.outputDir);
    const fingerprints = [];
    if (job.validationReport?.review?.protocol !== REVIEW_POLICY.version || digest(job.validationReport?.review?.policy) !== digest(REVIEW_POLICY)) {
      issues.push({ code: "REVIEW_POLICY_CHANGED", severity: "error", stage: "integrity", message: "Review policy differs from the validated build; rebuild the model under the current precision policy" });
    }
    if (!job.reviewBindings?.length) issues.push({ code: "REVIEW_EVIDENCE_UNBOUND", severity: "error", stage: "integrity", message: "Review evidence is not bound to current artifact content; rebuild this model" });
    if (job.reviewPlanChecksum !== digest(job.plan)) issues.push({ code: "REVIEW_PLAN_CHANGED", severity: "error", stage: "integrity", message: "Feature plan changed after geometry validation; rebuild this model" });
    for (const binding of job.reviewBindings || []) {
      let current = null;
      try {
        const resolved = await realpath(binding.path);
        if (inside(resolved, root)) current = await fileDigest(resolved);
      } catch { /* Missing artifacts must fail closed. */ }
      fingerprints.push([binding.path, current]);
      if (!current || current !== binding.sha256) issues.push({ code: "REVIEW_ARTIFACT_CHANGED", severity: "error", stage: "integrity", artifact: path.basename(binding.path), message: "Artifact content is missing or changed since kernel validation; rebuild the model" });
    }
    const key = digest({ source: job.validationReport, plan: job.reviewPlanChecksum, currentPlan: digest(job.plan),
      policy: REVIEW_POLICY, bindings: job.reviewBindings, fingerprints, visual: job.visualReview || null, revision: reviewRevisionId(job), profile });
    const cached = !refresh && this.cache.get(key);
    if (cached) return { ...structuredClone(cached), review: { ...cached.review,
      cache: { hit: true, durationMs: performance.now()-start, evidenceHash: key, artifactCount: fingerprints.length } } };
    const source = structuredClone(job.validationReport || { valid: false, issues: [{ code: "MISSING_UNIFIED_REVIEW", severity: "error", message: "Kernel review evidence is missing" }] });
    source.issues = [...(source.issues || []), ...issues];
    source.summary = { errors: 0, warnings: 0, info: 0 };
    for (const issue of source.issues) source.summary[issue.severity === "error" ? "errors" : issue.severity === "warning" ? "warnings" : "info"] += 1;
    source.blockingErrorCount = source.summary.errors;
    source.valid = source.valid === true && source.blockingErrorCount === 0;
    const report = attachUnifiedDecision(source, { engine: job.engine, revisionId: reviewRevisionId(job),
      visualReview: job.visualReview, cache: { hit: false, durationMs: performance.now()-start, evidenceHash: key, artifactCount: fingerprints.length } });
    report.status = profile === "geometry" ? report.review.geometryDecision : report.review.deliveryDecision;
    report.profile = profile;
    report.reviewRevisionId = reviewRevisionId(job);
    report.visualEvidence = job.visualReview ? { revisionId: job.visualReview.revisionId, status: job.visualReview.status,
      summary: job.visualReview.summary, findings: job.visualReview.findings || [] } : null;
    this.cache.set(key, structuredClone(report));
    while (this.cache.size > this.maximumEntries) this.cache.delete(this.cache.keys().next().value);
    return report;
  }
}
