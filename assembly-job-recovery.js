import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { restoreJobFromRevisionState } from "./parametric-api.js";
import { engineeringPromotionBlock } from "./cad-validation.js";
import { getCurrentRevision, listRevisions, loadRevisionState } from "./revision-store.js";
import { restoreNativeJob } from "./native-revisions.js";

export async function restoreAssemblyJob(revisionRoot, assemblyId) {
  const native = await restoreNativeJob(revisionRoot, assemblyId);
  if (native) {
    const visual = await restoreVisualReview(revisionRoot, assemblyId);
    if (visual?.revisionId === native.currentRevision) native.visualReview = visual;
    return native;
  }
  const current = await getCurrentRevision(revisionRoot, assemblyId);
  const revision = current || (await listRevisions(revisionRoot, assemblyId)).find(({ failure }) => engineeringPromotionBlock(failure?.validationReport));
  if (!revision) return null;
  const state = await loadRevisionState(revisionRoot, assemblyId, revision.id, { allowLegacyStateChecksum: Boolean(current) });
  const job = {
    id: assemblyId,
    status: "done",
    createdAt: revision.createdAt || null,
    completedAt: revision.promotedAt || revision.updatedAt || null,
    outputDir: path.join(revisionRoot, assemblyId),
    plan: state.plan,
    parts: []
  };
  restoreJobFromRevisionState(job, revision.id, state);
  if (!current) {
    delete job.currentRevision;
    job.pendingRevision = revision.id;
    job.status = "validation_failed";
    job.revisionDisposition = engineeringPromotionBlock(job.validationReport);
    return job;
  }
  job.visualReview = await restoreVisualReview(revisionRoot, assemblyId);
  return job;
}

async function restoreVisualReview(revisionRoot, assemblyId) {
  const reviewDir = path.join(revisionRoot, assemblyId, "visual-review");
  try {
    const report = JSON.parse(await readFile(path.join(reviewDir, "visual-review.json"), "utf8"));
    if (!report || report.assemblyId !== assemblyId) return null;
    return {
      ...report,
      jsonPath: path.join(reviewDir, "visual-review.json"),
      mdPath: path.join(reviewDir, "visual-review.md"),
      jsonUrl: `/assemblies/${assemblyId}/visual-review/visual-review.json`,
      mdUrl: `/assemblies/${assemblyId}/visual-review/visual-review.md`
    };
  } catch {
    return null;
  }
}

export async function restoreLatestAssemblyJob(revisionRoot) {
  let entries;
  try {
    entries = await readdir(revisionRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const native = await restoreNativeJob(revisionRoot, entry.name);
      if (native) { candidates.push({ assemblyId: entry.name, current: { updatedAt: native.modifiedAt || native.createdAt } }); continue; }
      const current = await getCurrentRevision(revisionRoot, entry.name);
      if (current?.id) candidates.push({ assemblyId: entry.name, current });
    } catch {
      // Ignore incomplete and failed assembly directories.
    }
  }
  candidates.sort((left, right) => {
    const leftTime = Date.parse(left.current.promotedAt || left.current.updatedAt || left.current.createdAt || 0) || 0;
    const rightTime = Date.parse(right.current.promotedAt || right.current.updatedAt || right.current.createdAt || 0) || 0;
    return rightTime - leftTime;
  });
  if (!candidates.length) return null;
  return restoreAssemblyJob(revisionRoot, candidates[0].assemblyId);
}
