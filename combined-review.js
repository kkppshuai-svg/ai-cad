import { reviewRevisionId } from "./review-policy.js";

// One orchestration path; geometry and visual evidence retain independent decisions.
export async function runCombinedReview({ job, channel, profile = "delivery", refresh = false,
  expectedRevision = null, visualRequested = false, screenshots = [], runVisual }) {
  const revision = reviewRevisionId(job);
  if (expectedRevision && expectedRevision !== revision) throw Object.assign(new Error("Review revision is stale"), { status: 409 });
  if (visualRequested && profile !== "delivery") throw Object.assign(new Error("Visual review requires delivery profile"), { status: 400 });
  if (visualRequested && (!Array.isArray(screenshots) || !screenshots.length)) throw Object.assign(new Error("Visual review requires screenshots"), { status: 400 });
  await channel.review(job, { profile: "geometry", refresh });
  let visualAttempt = null;
  if (visualRequested) {
    job.visualReview = null;
    try {
      await runVisual({ screenshots, revisionId: revision });
      visualAttempt = { status: "completed" };
    } catch (error) {
      visualAttempt = { status: "unavailable", message: error.message || String(error) };
    }
    if (reviewRevisionId(job) !== revision) throw Object.assign(new Error("Model changed during review"), { status: 409 });
  }
  return { ...await channel.review(job, { profile, refresh }), ...(visualAttempt ? { visualAttempt } : {}) };
}
