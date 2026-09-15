export async function runAssemblyValidationRepairLoop({ initialPlan, build, repair, repairFallback, onRepair, maximumRepairs = 3, returnPreviewOnFailure = false }) {
  if (typeof build !== "function") throw new TypeError("build is required");
  if (typeof repair !== "function") throw new TypeError("repair is required");
  let plan = initialPlan;
  const seenPlans = new Set();
  for (let attempt = 0; attempt <= maximumRepairs; attempt += 1) {
    try {
      return await build(plan, attempt);
    } catch (error) {
      if (!error?.validationReport || attempt >= maximumRepairs) {
        if (returnPreviewOnFailure && error?.previewAssembly) return error.previewAssembly;
        throw error;
      }
      let repairError = null;
      try {
        plan = await repair({ plan, validationReport: error.validationReport, attempt });
      } catch (cause) {
        repairError = cause;
        plan = null;
      }
      if (!plan && typeof repairFallback === "function") {
        try {
          plan = await repairFallback({
            plan: error.failedPlan || plan || initialPlan,
            validationReport: error.validationReport,
            attempt,
            repairError
          });
        } catch (fallbackError) {
          if (returnPreviewOnFailure && error?.previewAssembly) return error.previewAssembly;
          throw fallbackError;
        }
      }
      if (!plan) {
        if (returnPreviewOnFailure && error?.previewAssembly) return error.previewAssembly;
        throw repairError || error;
      }
      let fingerprint = "";
      try { fingerprint = JSON.stringify(plan); } catch { fingerprint = `attempt:${attempt}`; }
      if (seenPlans.has(fingerprint)) {
        const stalled = new Error(`Assembly validation repair made no progress: ${error.message || "validation remains blocked"}`);
        stalled.code = "REPAIR_NO_PROGRESS";
        stalled.validationReport = error.validationReport;
        stalled.previewAssembly = error.previewAssembly;
        if (returnPreviewOnFailure && stalled.previewAssembly) return stalled.previewAssembly;
        throw stalled;
      }
      seenPlans.add(fingerprint);
      if (typeof onRepair === "function") await onRepair({ plan, validationReport: error.validationReport, attempt });
    }
  }
  throw new Error("Assembly validation repair loop exhausted unexpectedly");
}
