import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { normalizeParametricPlan } from "./parametric-plan.js";
import * as parametricPlan from "./parametric-plan.js";
import { safePartId } from "./plan-validation.js";
import { buildAssemblyPlannerInstruction } from "./prompt-contract.js";
import * as profileRepair from "./planner-profile-repair.js";

const eligibleError = new Error(
  "Feature bracket.upright.01 add_extrude profile requires a type"
);

function classifyResponse(response) {
  if (response?.mode === "ambiguous") return "ambiguous";
  if (response?.mode === "edit_patch") return "editPatch";
  return "fullPlan";
}

function generatePlan(options) {
  assert.equal(typeof profileRepair.generatePlanWithProfileRepair, "function");
  return profileRepair.generatePlanWithProfileRepair({
    prepareFullPlan: () => {},
    classifyResponse,
    ...options
  });
}

function normalizeRawShape(plan) {
  if (!Array.isArray(plan.parts)) plan.parts = plan.components || [];
  for (const part of plan.parts) {
    if (!Array.isArray(part.features)) part.features = part.operations || [];
  }
}

function clamp(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function validateAssemblyPlanEquivalent(plan) {
  for (const part of plan.parts) {
    if (!part.id || !part.name) throw new Error("Each part requires id and name");
    part.id = safePartId(part.id);
    part.mode = part.mode === "standard_part" ? "standard_part" : "generated";
    if (part.mode === "standard_part") {
      part.primitives = [];
      part.features = [];
      part.featureTree = [];
      continue;
    }
    if (!Array.isArray(part.primitives) || part.primitives.length === 0) {
      part.primitives = [{ type: "box", size: [10, 10, 10], center: true }];
    }
    part.primitives = part.primitives.map((primitive) => ({
      type: "box",
      size: [0, 1, 2].map((index) => clamp(primitive.size?.[index], 10, 0.1, 5000)),
      center: primitive.center !== false
    }));
    if (!Array.isArray(part.features)) part.features = [];
    part.features = part.features.map((feature) => {
      if (["add_extrude", "cut_extrude"].includes(feature.type)) {
        return {
          type: feature.type,
          profile: structuredClone(feature.profile),
          depth: feature.depth
        };
      }
      if (feature.type === "hole") return { type: "hole", radius: 2.5, depth: 1000 };
      return { type: "cut_box", size: [10, 10, 10], rotate: [0, 0, 0] };
    });
  }
}

function normalizeCandidate(plan) {
  assert.equal(typeof profileRepair.normalizeGeneratedPlanCandidate, "function");
  return profileRepair.normalizeGeneratedPlanCandidate(plan, {
    normalizeShape: normalizeRawShape,
    preflightExtrudes: parametricPlan.preflightExtrudeProfiles,
    canonicalizePartId: safePartId,
    validateAssembly: validateAssemblyPlanEquivalent,
    normalizeParametric: normalizeParametricPlan
  });
}

test("generated candidate pipeline preserves default primitive insertion", () => {
  const plan = { parts: [{ id: "plate", name: "Plate" }] };
  const snapshot = structuredClone(plan);
  const result = normalizeCandidate(plan);

  assert.deepEqual(result.parts[0].primitives, [{
    type: "box", size: [10, 10, 10], center: true
  }]);
  assert.equal(result.parts[0].featureTree[0].type, "base_box");
  assert.deepEqual(plan, snapshot);
});

test("generated candidate pipeline preserves assembly numeric clamps", () => {
  const result = normalizeCandidate({ parts: [{
    id: "plate",
    name: "Plate",
    primitives: [{ type: "box", size: [0, 6000, "bad"] }]
  }] });

  assert.deepEqual(result.parts[0].primitives[0].size, [0.1, 5000, 10]);
  assert.deepEqual(result.parts[0].featureTree[0].params.size, [0.1, 5000, 10]);
});

test("generated candidate pipeline preserves standard-part geometry clearing", () => {
  const result = normalizeCandidate({ parts: [{
    id: "bearing",
    name: "Bearing",
    mode: "standard_part",
    standardPart: { query: "bearing" },
    primitives: [{ type: "box", size: [4, 4, 4] }],
    features: [{ type: "hole", diameter: 2 }]
  }] });

  assert.deepEqual(result.parts[0].primitives, []);
  assert.deepEqual(result.parts[0].features, []);
  assert.deepEqual(result.parts[0].featureTree, []);
});

for (const [container, geometry] of [
  ["featureTree", {
    featureTree: [{
      type: "add_extrude",
      params: { profile: { type: "spline" }, depth: 3 }
    }]
  }],
  ["legacy features", {
    features: [{ type: "cut_extrude", profile: { width: 4, height: 2 }, depth: 3 }]
  }]
]) {
  test(`standard-part malformed ${container} geometry is not repaired and is cleared`, async () => {
    const initialPlan = { parts: [{
      id: "bearing",
      name: "Bearing",
      mode: "standard_part",
      standardPart: { query: "bearing" },
      ...geometry
    }] };
    const snapshot = structuredClone(initialPlan);
    let plannerCalls = 0;

    const result = await generatePlan({
      originalRequest: "Add a bearing",
      invokePlanner: async () => {
        plannerCalls += 1;
        return initialPlan;
      },
      normalize: normalizeCandidate
    });

    assert.equal(plannerCalls, 1);
    assert.deepEqual(result.parts[0].primitives, []);
    assert.deepEqual(result.parts[0].features, []);
    assert.deepEqual(result.parts[0].featureTree, []);
    assert.deepEqual(initialPlan, snapshot);
  });
}

test("generated candidate pipeline sanitizes part IDs before assigning feature namespaces", () => {
  const result = normalizeCandidate({ parts: [{
    id: "Unsafe Part ID",
    name: "Plate",
    featureTree: [{
      type: "add_extrude",
      params: { profile: { type: "rectangle", width: 4, height: 2 }, depth: 3 }
    }]
  }] });

  assert.equal(result.parts[0].id, "unsafe-part-id");
  assert.equal(result.parts[0].featureTree[0].id, "unsafe-part-id.add_extrude.01");
});

test("profile repair uses the production-safe namespace for an unsafe part ID", async () => {
  const plannerCalls = [];

  const result = await generatePlan({
    originalRequest: "Create a plate",
    invokePlanner: async (...args) => {
      plannerCalls.push(args);
      return plannerCalls.length === 1 ? {
        parts: [{
          id: "Unsafe Part ID",
          name: "Plate",
          featureTree: [{
            type: "add_extrude",
            params: { profile: { type: "spline" }, depth: 3 }
          }]
        }]
      } : {
        parts: [{
          id: "Unsafe Part ID",
          name: "Plate",
          featureTree: [{
            type: "add_extrude",
            params: { profile: { type: "rectangle", width: 4, height: 2 }, depth: 3 }
          }]
        }]
      };
    },
    normalize: normalizeCandidate
  });

  assert.equal(plannerCalls.length, 2);
  assert.match(plannerCalls[1][0], /unsafe-part-id\.add_extrude\.01/);
  assert.doesNotMatch(plannerCalls[1][0], /Unsafe Part ID\.add_extrude\.01/);
  assert.equal(result.parts[0].id, "unsafe-part-id");
});

test("generated candidate pipeline preserves unrelated legacy fallback behavior", () => {
  const result = normalizeCandidate({ parts: [{
    id: "plate",
    name: "Plate",
    features: [{ type: "loft" }]
  }] });

  assert.equal(result.parts[0].features[0].type, "cut_box");
  assert.equal(result.parts[0].featureTree[1].type, "cut_box");
});

for (const featureType of ["add_extrude", "cut_extrude"]) {
  test(`malformed ID-less legacy ${featureType} reaches repair before sanitization`, async () => {
    const plannerCalls = [];
    const initialPlan = {
      components: [{
        name: "Plate",
        operations: [{ type: featureType, profile: { type: "spline" }, depth: 10 }]
      }]
    };
    const snapshot = structuredClone(initialPlan);

    const result = await generatePlan({
      originalRequest: "Create a plate",
      invokePlanner: async (...args) => {
        plannerCalls.push(args);
        return plannerCalls.length === 1 ? initialPlan : {
          parts: [{
            id: "plate",
            name: "Plate",
            features: [{
              type: featureType,
              profile: { type: "rectangle", width: 20, height: 10 },
              depth: 10
            }]
          }]
        };
      },
      normalize: normalizeCandidate
    });

    assert.equal(plannerCalls.length, 2);
    assert.match(plannerCalls[1][0], new RegExp(`plate-01\\.${featureType}\\.01`));
    assert.equal(result.parts[0].features[0].type, featureType);
    assert.equal(result.parts[0].featureTree[1].type, featureType);
    assert.deepEqual(initialPlan, snapshot);
  });
}

test("valid legacy add/cut extrudes survive sanitization and normalization", async () => {
  const moduleUrl = new URL("./plan-validation.js", import.meta.url);
  assert.equal(existsSync(moduleUrl), true, "plan-validation.js must expose the production sanitizer");
  const { sanitizeFeature } = await import(moduleUrl);

  for (const featureType of ["add_extrude", "cut_extrude"]) {
    const sanitized = sanitizeFeature({
      type: featureType,
      profile: { type: "rectangle", width: 20, height: 10 },
      depth: 6
    });
    const result = normalizeParametricPlan({
      parts: [{ id: "plate", features: [sanitized] }]
    });

    assert.deepEqual(sanitized, {
      type: featureType,
      profile: { type: "rectangle", width: 20, height: 10 },
      depth: 6
    });
    assert.equal(result.parts[0].features[0].type, featureType);
    assert.equal(result.parts[0].featureTree[0].type, featureType);
  }
});

test("server delegates preflight and the original final pipeline to the tested helper", async () => {
  const source = await readFile(new URL("./server.js", import.meta.url), "utf8");

  assert.match(source, /import\s*\{[^}]*normalizeGeneratedPlanCandidate[^}]*\}\s*from\s*"\.\/planner-profile-repair\.js"/s);
  assert.match(source, /import\s*\{[^}]*preflightExtrudeProfiles[^}]*\}\s*from\s*"\.\/parametric-plan\.js"/s);
  assert.match(source, /normalize:\s*\(plan\)\s*=>\s*normalizeGeneratedPlanCandidate\(/);
  assert.match(source, /preflightExtrudes:\s*preflightExtrudeProfiles/);
  assert.match(source, /canonicalizePartId:\s*safePartId/);
});

test("valid initial full plan uses one semantic planner call", async () => {
  const calls = [];
  const initialPlan = { id: "valid" };

  const result = await generatePlan({
    originalRequest: "Create a bracket",
    invokePlanner: async (...args) => {
      calls.push(args);
      return initialPlan;
    },
    normalize: (plan) => ({ ...plan, normalized: true })
  });

  assert.deepEqual(calls, [["Create a bracket"]]);
  assert.deepEqual(result, { id: "valid", normalized: true });
});

test("eligible malformed plan makes one full-plan repair semantic call with required context", async () => {
  const calls = [];
  const initialPlan = { id: "invalid" };
  const repairedPlan = { id: "repaired" };

  const result = await generatePlan({
    originalRequest: "Create a motor mounting bracket",
    invokePlanner: async (...args) => {
      calls.push(args);
      return calls.length === 1 ? initialPlan : repairedPlan;
    },
    normalize: (plan) => {
      if (plan === initialPlan) throw eligibleError;
      return { ...plan, normalized: true };
    }
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["Create a motor mounting bracket"]);
  assert.deepEqual(calls[1][1], { forceFullPlan: true });
  assert.match(calls[1][0], /Create a motor mounting bracket/);
  assert.match(calls[1][0], /bracket\.upright\.01/);
  assert.match(calls[1][0], /add_extrude/);
  assert.match(calls[1][0], /profile requires a type/);
  assert.match(calls[1][0], /rectangle\(width,height\)/);
  assert.deepEqual(result, { id: "repaired", normalized: true });
});

test("unrelated initial validation failure does not make a repair call", async () => {
  const unrelated = new Error("parts must be an array");
  let calls = 0;

  await assert.rejects(
    generatePlan({
      originalRequest: "Create a bracket",
      invokePlanner: async () => {
        calls += 1;
        return { id: "invalid" };
      },
      normalize: () => {
        throw unrelated;
      }
    }),
    (error) => error === unrelated
  );

  assert.equal(calls, 1);
});

test("retries an empty assembly plan once as a complete full plan", async () => {
  const responses = [{ name: "empty", parts: [] }, { name: "gear_pair", parts: [{ id: "left" }, { id: "right" }] }];
  const calls = [];

  const result = await generatePlan({
    originalRequest: "Create a gear pair",
    invokePlanner: async (message, options = {}) => {
      calls.push({ message, options });
      return responses[calls.length - 1];
    },
    normalize: (plan) => {
      if (!Array.isArray(plan.parts) || plan.parts.length === 0) throw new Error("Assembly plan requires at least one part");
      return plan;
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.forceFullPlan, true);
  assert.match(calls[1].message, /non-empty parts array/i);
  assert.equal(result.parts.length, 2);
});

for (const repairResponse of [
  { mode: "ambiguous", candidates: [] },
  { mode: "edit_patch", editPatch: { operations: [] } }
]) {
  test(`repair rejects ${repairResponse.mode} instead of accepting it as a full plan`, async () => {
    let calls = 0;

    await assert.rejects(
      generatePlan({
        originalRequest: "Create a bracket",
        invokePlanner: async () => {
          calls += 1;
          return calls === 1 ? { id: "invalid" } : repairResponse;
        },
        normalize: (plan) => {
          if (plan.id === "invalid") throw eligibleError;
          return plan;
        }
      }),
      (error) => {
        assert.match(error.message, /^Feature bracket\.upright\.01 add_extrude profile repair failed:/);
        assert.match(error.cause?.message || "", /full JSON plan/i);
        return true;
      }
    );

    assert.equal(calls, 2);
  });
}

test("failed repair preserves retry validation cause and makes no third semantic call", async () => {
  const initialPlan = { id: "invalid" };
  const repairedPlan = { id: "still-invalid" };
  const retryValidationError = new Error(
    "Feature bracket.upright.01 add_extrude rectangle profile requires height"
  );
  let calls = 0;

  await assert.rejects(
    generatePlan({
      originalRequest: "Create a bracket",
      invokePlanner: async () => {
        calls += 1;
        return calls === 1 ? initialPlan : repairedPlan;
      },
      normalize: (plan) => {
        if (plan === initialPlan) throw eligibleError;
        throw retryValidationError;
      }
    }),
    (error) => {
      assert.strictEqual(error.cause, retryValidationError);
      assert.match(error.message, /rectangle profile requires height/i);
      return true;
    }
  );

  assert.equal(calls, 2);
});

test("existing-revision repair explicitly builds its second prompt in full-plan mode", async () => {
  const conversation = {
    currentRevision: "rev-0004",
    plan: { name: "bracket", parts: [{ id: "bracket", featureTree: [] }] },
    messages: [{ role: "user", content: "Create the original bracket" }]
  };
  const imageAttachments = [{ name: "bracket.png" }];
  const prompts = [];
  let calls = 0;

  await generatePlan({
    originalRequest: "Repair the bracket",
    invokePlanner: async (plannerMessage, options = {}) => {
      calls += 1;
      prompts.push(buildAssemblyPlannerInstruction({
        conversation,
        message: plannerMessage,
        searchContext: null,
        excellentCadqueryContext: "fixture example",
        imageAttachments,
        forceFullPlan: options.forceFullPlan
      }));
      return calls === 1 ? { id: "invalid" } : { id: "valid" };
    },
    normalize: (plan) => {
      if (plan.id === "invalid") throw eligibleError;
      return plan;
    }
  });

  assert.equal(calls, 2);
  assert.match(prompts[0], /"editPatch"/);
  assert.match(prompts[1], /full JSON plan/i);
  assert.doesNotMatch(prompts[1], /"editPatch"/);
  assert.match(prompts[1], /"currentRevision": "rev-0004"/);
  assert.match(prompts[1], /"name": "bracket"/);
  assert.match(prompts[1], /bracket\.png/);
});
