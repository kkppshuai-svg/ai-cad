import test from "node:test";
import assert from "node:assert/strict";
import { runAssemblyValidationRepairLoop } from "./validation-repair-loop.js";

test("continues with the latest validation report until the build converges", async () => {
  const reports = [{ blockingErrorCount: 5 }, { blockingErrorCount: 4 }];
  const repairInputs = [];
  const result = await runAssemblyValidationRepairLoop({
    initialPlan: { revision: 0 },
    build: async (plan, attempt) => {
      if (attempt < reports.length) {
        const error = new Error("validation blocked");
        error.validationReport = reports[attempt];
        throw error;
      }
      return { status: "done", plan };
    },
    repair: async ({ plan, validationReport, attempt }) => {
      repairInputs.push(validationReport.blockingErrorCount);
      return { ...plan, revision: attempt + 1 };
    }
  });
  assert.deepEqual(repairInputs, [5, 4]);
  assert.equal(result.plan.revision, 2);
});

test("stops after the configured repair limit", async () => {
  let builds = 0;
  await assert.rejects(runAssemblyValidationRepairLoop({
    initialPlan: {},
    build: async () => {
      builds += 1;
      const error = new Error("still blocked");
      error.validationReport = { blockingErrorCount: 1 };
      throw error;
    },
    repair: async ({ plan }) => plan,
    maximumRepairs: 2
  }), /still blocked/);
  assert.equal(builds, 2);
});

test("returns the latest generated preview when validation repair itself fails", async () => {
  const preview = { id: "preview-1", status: "validation_failed", stlUrl: "/preview.stl" };
  const result = await runAssemblyValidationRepairLoop({
    initialPlan: {},
    build: async () => {
      const error = new Error("validation blocked");
      error.validationReport = { blockingErrorCount: 2 };
      error.previewAssembly = preview;
      throw error;
    },
    repair: async () => {
      throw new Error("planner returned an invalid repair");
    },
    returnPreviewOnFailure: true,
  });
  assert.equal(result, preview);
});

test("uses deterministic fallback and continues when AI repair fails", async () => {
  let builds = 0;
  const result = await runAssemblyValidationRepairLoop({
    initialPlan: { revision: 0 },
    build: async (plan) => {
      builds += 1;
      if (plan.revision === 0) {
        const error = new Error("validation blocked");
        error.validationReport = { blockingErrorCount: 2 };
        error.failedPlan = plan;
        throw error;
      }
      return { status: "done", plan };
    },
    repair: async () => { throw new Error("invalid AI repair"); },
    repairFallback: async ({ plan, repairError }) => ({ ...plan, revision: 1, fallbackReason: repairError.message })
  });
  assert.equal(builds, 2);
  assert.equal(result.plan.revision, 1);
  assert.equal(result.plan.fallbackReason, "invalid AI repair");
});

test("stops when repair keeps returning the same plan", async () => {
  await assert.rejects(runAssemblyValidationRepairLoop({
    initialPlan: { revision: 0 },
    build: async () => {
      const error = new Error("validation blocked");
      error.validationReport = { blockingErrorCount: 1 };
      throw error;
    },
    repair: async ({ plan }) => ({ ...plan }),
    maximumRepairs: 5
  }), (error) => error.code === "REPAIR_NO_PROGRESS");
});
