import test from "node:test";
import assert from "node:assert/strict";
import { hydrateStandardPartsForPlan } from "./standard-parts.js";

test("hydrates standard_part entries with local STEP path and provenance", async () => {
  const plan = {
    name: "bearing mount",
    parts: [{
      id: "bearing_608zz",
      name: "608ZZ bearing",
      role: "bearing",
      mode: "standard_part",
      standardPart: { provider: "step.parts", query: "608ZZ bearing" },
      pose: { translate: [1, 2, 3], rotate: [0, 0, 90] },
    }],
    relations: [],
    joints: [],
  };

  await hydrateStandardPartsForPlan(plan, {
    cacheDir: "/tmp/not-used",
    resolver: async ({ request }) => ({
      provider: "step.parts",
      id: "bearing_608zz",
      name: "608ZZ bearing",
      pageUrl: "https://www.step.parts/parts/bearing_608zz",
      apiUrl: "https://api.step.parts/v1/parts/bearing_608zz",
      sha256: "abc",
      checksumVerified: true,
      localStepPath: "/tmp/bearing.step",
      request,
    }),
  });

  assert.equal(plan.parts[0].sourceStepPath, "/tmp/bearing.step");
  assert.equal(plan.parts[0].standardPart.resolved.id, "bearing_608zz");
  assert.deepEqual(plan.parts[0].primitives, []);
  assert.deepEqual(plan.parts[0].features, []);
});

test("falls back to a local parametric 6204 bearing when step.parts has no match", async () => {
  const plan = {
    parts: [{
      id: "input_bearing_left",
      name: "输入左6204轴承",
      role: "deep groove ball bearing",
      mode: "standard_part",
      standardPart: { provider: "step.parts", query: "6204 deep groove ball bearing", tag: "6204" },
    }],
  };

  await hydrateStandardPartsForPlan(plan, {
    cacheDir: "/tmp/not-used",
    resolver: async () => {
      const error = new Error('No step.parts result matched standard part "6204 deep groove ball bearing"');
      error.code = "STEP_PARTS_NO_MATCH";
      throw error;
    },
  });

  assert.equal(plan.parts[0].mode, "generated");
  assert.equal(plan.parts[0].standardPart.resolved.provider, "local-parametric-fallback");
  assert.equal(plan.parts[0].featureTree[0].params.radius, 23.5);
  assert.equal(plan.parts[0].featureTree[1].params.diameter, 20);
});
