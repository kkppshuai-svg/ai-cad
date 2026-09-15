import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { restoreJobFromRevisionState } from "./parametric-api.js";
import { getCurrentRevision, loadRevisionState } from "./revision-store.js";

export async function restoreAssemblyJob(revisionRoot, assemblyId) {
  const current = await getCurrentRevision(revisionRoot, assemblyId);
  if (!current?.id) return null;
  const state = await loadRevisionState(revisionRoot, assemblyId, current.id, { allowLegacyStateChecksum: true });
  const job = {
    id: assemblyId,
    status: "done",
    createdAt: current.createdAt || null,
    completedAt: current.promotedAt || current.updatedAt || null,
    outputDir: path.join(revisionRoot, assemblyId),
    plan: state.plan,
    parts: []
  };
  restoreJobFromRevisionState(job, current.id, state);
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
