import test from "node:test";
import assert from "node:assert/strict";
import { normalizeParametricPlan } from "./parametric-plan.js";
import * as profileRepair from "./planner-profile-repair.js";

const { repairInvalidExtrudeProfile } = profileRepair;

test("repairs a shaft keyway into a shallow radial cut with semantic measurements", () => {
  const plan = {
    parts: [{
      id: "input_shaft",
      featureTree: [
        { id: "input_shaft.base.01", type: "base_cylinder", params: { radius: 10, height: 180 } },
        { id: "input_shaft.keyway.01", name: "输入轴键槽", type: "cut_box", params: { size: [6, 6, 30], center: [0, 0, 45], axis: "y" } }
      ],
      measurements: [
        { id: "input_shaft.keyway_width", kind: "feature_bbox", featureId: "input_shaft.keyway.01", axis: "x", target: 6 },
        { id: "input_shaft.keyway_depth", kind: "feature_bbox", featureId: "input_shaft.keyway.01", axis: "y", target: 6 },
        { id: "input_shaft.keyway_length", kind: "feature_bbox", featureId: "input_shaft.keyway.01", axis: "z", target: 30 }
      ]
    }]
  };

  profileRepair.repairShaftKeyways(plan);
  const keyway = plan.parts[0].featureTree[1];
  assert.deepEqual(keyway.params.center, [0, 7, 45]);
  assert.equal(keyway.params.axis, "z");
  assert.deepEqual(plan.parts[0].measurements.map(({ kind, property }) => ({ kind, property })), [
    { kind: "keyway", property: "width" },
    { kind: "keyway", property: "depth" },
    { kind: "keyway", property: "length" }
  ]);
});

test("infers an overall envelope without overwriting the user's target", () => {
  const plan = { parts: [{
    id: "ac_bracket",
    featureTree: [{ id: "base", type: "base_box", params: { size: [500, 4, 300] } }],
    measurements: [
      { id: "overall_depth", label: "总深", kind: "bbox", axis: "y", target: 4 },
      { id: "shelf_depth", label: "承托深度", kind: "feature_bbox", featureId: "shelf", axis: "y", target: 400 }
    ]
  }] };
  profileRepair.repairMechanicalMeasurements(plan);
  assert.equal(plan.parts[0].measurements[0].target, 4);
  assert.equal(plan.parts[0].measurements[0].effectiveTarget, 400);
});

test("reorders generated keyway dimensions and uses the local gear-seat radius", () => {
  const plan = { parts: [{
    id: "input_shaft",
    featureTree: [
      { id: "shaft.base", type: "base_cylinder", params: { radius: 12.5, height: 180 } },
      { id: "shaft.seat", type: "add_primitive", params: { primitive: { type: "cylinder", radius: 15, height: 35 } } },
      { id: "shaft.keyway", name: "键槽", type: "cut_box", dependsOn: ["shaft.seat"], params: { size: [6, 30, 6], center: [0, -2.5, 55] } },
      { id: "shaft.keywayWidth", type: "dimension", params: { name: "keywayWidth", value: 6 } },
      { id: "shaft.keywayDepth", type: "dimension", params: { name: "keywayDepth", value: 6 } },
      { id: "shaft.keywayLength", type: "dimension", params: { name: "keywayLength", value: 30 } }
    ],
    measurements: [{ id: "keyway_depth", label: "键槽深度", kind: "feature_bbox", featureId: "shaft.keyway", target: 6 }]
  }] };
  profileRepair.repairShaftKeyways(plan);
  const keyway = plan.parts[0].featureTree[2];
  assert.deepEqual(keyway.params.size, [6, 6, 30]);
  assert.deepEqual(keyway.params.center, [0, 12, 55]);
});

test("drops invalid center-distance bbox assertions without rewriting the target", () => {
  const plan = { parts: [{
    id: "gearbox_upper_cover",
    featureTree: [{ id: "cover.base", type: "base_box", params: { size: [220, 288, 94] } }],
    measurements: [
      { id: "center_distance_measurement", label: "两轴中心距", kind: "feature_bbox", featureId: "cover.bore", axis: "y", target: 100 },
      { id: "overall_length", label: "箱盖总长", kind: "bbox", axis: "x", target: 288 }
    ]
  }] };
  profileRepair.repairMechanicalMeasurements(plan);
  assert.deepEqual(plan.parts[0].measurements, [{ id: "overall_length", label: "箱盖总长", kind: "bbox", axis: "x", target: 288 }]);
});

test("repairs safe CAD parameter aliases and optional zero bores before validation", () => {
  const plan = {
    parts: [{
      id: "input_pinion",
      featureTree: [
        { id: "input_pinion.base.01", type: "base_spur_gear", params: { module: 2, teeth: 20, width: 10, boreRadius: 0 } },
        { id: "input_pinion.hole.01", type: "hole", params: { radius: 3, depth: 0, axis: "z" } },
        { id: "input_pinion.fillet.01", type: "fillet", params: { radius: 0 }, selector: { kind: "legacy_all_edges" } }
      ]
    }]
  };
  profileRepair.repairInvalidMechanicalParameters(plan);
  const [gear, hole, fillet] = plan.parts[0].featureTree;
  assert.equal(gear.params.boreRadius, undefined);
  assert.equal(hole.params.diameter, 6);
  assert.equal(hole.params.depth, undefined);
  assert.equal(fillet.enabled, false);
  assert.equal(fillet.params.radius, 0.05);
  assert.equal(plan.parameterRepairAudit.length, 3);
});

test("infers through-hole and cut depths from a base-box axis extent", () => {
  const plan = { parts: [{ id: "plate", featureTree: [
    { id: "plate.base.01", type: "base_box", params: { size: [20, 30, 5] } },
    { id: "plate.hole.01", type: "hole", params: { diameter: 4, depth: 0, axis: "y" } },
    { id: "plate.cut.01", type: "cut_extrude", params: { profile: { type: "rectangle", width: 4, height: 4 }, depth: 0, axis: "x" } }
  ] }] };
  profileRepair.repairInvalidMechanicalParameters(plan);
  assert.equal(plan.parts[0].featureTree[1].params.depth, 30);
  assert.equal(plan.parts[0].featureTree[2].params.depth, 20);
});

test("repairs gearbox bearing measurements, housing clearance and intended fits", () => {
  const plan = {
    relations: [
      { type: "concentric", from: "input_shaft", to: "driving_gear" },
      { type: "gear", from: "driving_gear", to: "driven_gear" }
    ],
    parts: [
      {
        id: "driving_gear",
        pose: { translate: [0, -50, 0], rotate: [0, 90, 0] },
        featureTree: [{ id: "driving_gear.base.01", type: "base_cylinder", params: { radius: 27.5, height: 25 } }]
      },
      {
        id: "driven_gear",
        pose: { translate: [0, 50, 0], rotate: [0, 90, 0] },
        featureTree: [{ id: "driven_gear.base.01", type: "base_cylinder", params: { radius: 77.5, height: 25 } }]
      },
      {
        id: "gearbox_lower_housing",
        featureTree: [
          { id: "housing.base.01", type: "base_box", params: { size: [140, 160, 40], pose: { translate: [0, 0, -20] } } },
          { id: "housing.cavity.01", name: "内腔", type: "cut_box", params: { size: [124, 144, 32], center: [0, 0, -16] } }
        ],
        measurements: [{ id: "housing.height", kind: "bbox", axis: "z", target: 40 }]
      },
      {
        id: "input_bearing_left",
        featureTree: [
          { id: "bearing.base.01", type: "base_cylinder", params: { radius: 20, height: 14 } },
          { id: "bearing.bore.01", type: "hole", params: { diameter: 20, axis: "z" } }
        ],
        measurements: [{ id: "bearing.bore_diameter", label: "轴承孔径", kind: "feature_bbox", featureId: "bearing.bore.01", axis: "y", target: 20 }]
      }
    ]
  };

  profileRepair.repairShaftKeyways(plan);
  assert.equal(plan.parts[2].featureTree[0].params.size[1], 288);
  assert.equal(plan.parts[2].featureTree[0].params.size[2], 94);
  assert.equal(plan.parts[2].measurements[0].target, 94);
  assert.equal(plan.parts[3].measurements[0].kind, "cylinder_diameter");
  assert.deepEqual(plan.intendedContacts, [
    ["driving_gear", "input_shaft"],
    ["driven_gear", "driving_gear"]
  ]);
});

function makeExtrudePlan({
  featureId = "nema23_l_bracket.upright.01",
  featureType = "add_extrude",
  profile = { width: 42, height: 8 }
} = {}) {
  return {
    parts: [{
      id: "nema23_l_bracket",
      featureTree: [{
        id: featureId,
        type: featureType,
        params: { profile, depth: 50 }
      }]
    }]
  };
}

function makeIdlessExtrudePlan({
  featureType,
  profile,
  legacy = false,
  generatedPartId = false
}) {
  const params = { profile, depth: 50 };
  const feature = legacy
    ? { type: featureType, ...params }
    : { type: featureType, params };
  const part = generatedPartId ? { name: "Plate" } : { id: "plate" };
  if (legacy) part.features = [feature];
  else part.featureTree = [feature];
  return { parts: [part] };
}

test("builds a profile repair instruction with the original request and supported schemas", () => {
  assert.equal(typeof profileRepair.buildExtrudeProfileRepairInstruction, "function");

  const instruction = profileRepair.buildExtrudeProfileRepairInstruction({
    originalRequest: "Create a motor mounting bracket",
    featureId: "bracket.relief.02",
    featureType: "cut_extrude",
    validationError: "Feature bracket.relief.02 cut_extrude has unsupported parametric profile: spline"
  });

  assert.match(instruction, /Create a motor mounting bracket/);
  assert.match(instruction, /bracket\.relief\.02/);
  assert.match(instruction, /cut_extrude/);
  assert.match(instruction, /unsupported parametric profile: spline/);
  assert.match(instruction, /rectangle\s*\(width\s*,\s*height\s*\)/i);
  assert.match(instruction, /circle\s*\(radius\s*\|\s*diameter\s*\)/i);
  assert.match(instruction, /slot\s*\(length\s*,\s*width\s*\|\s*diameter\s*\)/i);
  assert.match(instruction, /polygon\s*\(points\s*\)/i);
  assert.match(instruction, /full JSON plan/i);
  assert.match(instruction, /dependsOn.*sourceFeatureId/is);
  assert.match(instruction, /params\.sourceFeatureId/i);
  assert.match(instruction, /linear_pattern.*count.*spacing/is);
  assert.match(instruction, /circular_pattern.*count.*angle/is);
  assert.match(instruction, /fillet.*params\.radius.*positive/is);
  assert.match(instruction, /chamfer.*params\.distance.*positive/is);
  assert.match(instruction, /must not include.*size.*dimensions/is);
  assert.match(instruction, /exactly one base_\* feature per generated part/i);
  assert.match(instruction, /additional solid.*add_primitive.*add_extrude/is);
  assert.match(instruction, /finish.*selector.*axis_position.*legacy_all_edges/is);
  assert.match(instruction, /do not use.*kind.*feature.*finish/is);
  assert.match(instruction, /profile and positive depth are both required/i);
  assert.match(instruction, /Change only the malformed feature fields needed for validation/i);
});

test("profile repair prompt includes the invalid plan and its existing depth", () => {
  const invalidPlan = makeExtrudePlan({
    featureId: "gear_01.tooth.01",
    profile: { width: 8, height: 3 }
  });
  const instruction = profileRepair.buildExtrudeProfileRepairInstruction({
    originalRequest: "Create a gear",
    featureId: "gear_01.tooth.01",
    featureType: "add_extrude",
    validationError: "Feature gear_01.tooth.01 add_extrude profile requires a type",
    invalidPlan
  });

  assert.match(instruction, /gear_01\.tooth\.01/);
  assert.match(instruction, /"depth": 50/);
  assert.match(instruction, /"width": 8/);
});

test("retries a missing add_extrude profile type once with the original error context", async () => {
  const calls = [];
  const repairedPlan = makeExtrudePlan({
    profile: { type: "rectangle", width: 42, height: 8 }
  });

  const result = await repairInvalidExtrudeProfile({
    plan: makeExtrudePlan(),
    normalize: normalizeParametricPlan,
    retry: async (context) => {
      calls.push(context);
      return repairedPlan;
    }
  });

  assert.deepEqual(calls, [{
    featureId: "nema23_l_bracket.upright.01",
    featureType: "add_extrude",
    message: "Feature nema23_l_bracket.upright.01 add_extrude profile requires a type"
  }]);
  assert.notStrictEqual(result, repairedPlan);
  assert.equal(result.parts[0].featureTree[0].enabled, true);
  assert.deepEqual(result.parts[0].featureTree[0].dependsOn, []);
  assert.equal(result.parts[0].featureTree[0].params.profile.type, "rectangle");
});

test("retries a missing add_extrude depth before CadQuery build", async () => {
  const calls = [];
  const invalidPlan = makeExtrudePlan();
  delete invalidPlan.parts[0].featureTree[0].params.depth;

  const result = await repairInvalidExtrudeProfile({
    plan: invalidPlan,
    normalize: normalizeParametricPlan,
    retry: async (context) => {
      calls.push(context);
      return makeExtrudePlan({ profile: { type: "rectangle", width: 42, height: 8 } });
    }
  });

  assert.deepEqual(calls, [{
    featureId: "nema23_l_bracket.upright.01",
    featureType: "add_extrude",
    message: "Feature nema23_l_bracket.upright.01 add_extrude requires depth"
  }]);
  assert.equal(result.parts[0].featureTree[0].params.depth, 50);
});

test("merges a targeted repair with the original extrude depth", async () => {
  const initialPlan = {
    parts: [{
      id: "gear_01",
      featureTree: [{
        id: "gear_01.tooth.01",
        type: "add_extrude",
        dependsOn: [],
        params: { profile: { width: 8, height: 3 }, depth: 20 }
      }]
    }]
  };
  const retriedPlan = {
    parts: [{
      id: "gear_01",
      featureTree: [{
        id: "gear_01.tooth.01",
        type: "add_extrude",
        dependsOn: [],
        params: { profile: { type: "rectangle", width: 8, height: 3 } }
      }]
    }]
  };

  const result = await repairInvalidExtrudeProfile({
    plan: initialPlan,
    normalize: normalizeParametricPlan,
    retry: async () => retriedPlan
  });

  assert.equal(result.parts[0].featureTree[0].params.depth, 20);
  assert.deepEqual(result.parts[0].featureTree[0].params.profile, {
    type: "rectangle",
    width: 8,
    height: 3
  });
  assert.equal(retriedPlan.parts[0].featureTree[0].params.depth, undefined);
});

test("repairs a completely missing add_extrude profile and preserves depth", async () => {
  const calls = [];
  const initialPlan = {
    parts: [{
      id: "spur_gear_01",
      featureTree: [{
        id: "spur_gear_01.tooth.01",
        type: "add_extrude",
        dependsOn: [],
        params: { depth: 20 }
      }]
    }]
  };
  const retriedPlan = {
    parts: [{
      id: "spur_gear_01",
      featureTree: [{
        id: "spur_gear_01.tooth.01",
        type: "add_extrude",
        dependsOn: [],
        params: { profile: { type: "rectangle", width: 12, height: 6 } }
      }]
    }]
  };

  const result = await repairInvalidExtrudeProfile({
    plan: initialPlan,
    normalize: normalizeParametricPlan,
    retry: async (context) => {
      calls.push(context);
      return retriedPlan;
    }
  });

  assert.deepEqual(calls, [{
    featureId: "spur_gear_01.tooth.01",
    featureType: "add_extrude",
    message: "Feature spur_gear_01.tooth.01 add_extrude requires profile"
  }]);
  assert.equal(result.parts[0].featureTree[0].params.depth, 20);
  assert.deepEqual(result.parts[0].featureTree[0].params.profile, {
    type: "rectangle",
    width: 12,
    height: 6
  });
});

test("reports a clear missing-profile failure when the retry is still incomplete", async () => {
  await assert.rejects(
    repairInvalidExtrudeProfile({
      plan: {
        parts: [{ id: "spur_gear_01", featureTree: [{
          id: "spur_gear_01.tooth.01",
          type: "add_extrude",
          params: { depth: 20 }
        }] }]
      },
      normalize: normalizeParametricPlan,
      retry: async () => ({
        parts: [{ id: "spur_gear_01", featureTree: [{
          id: "spur_gear_01.tooth.01",
          type: "add_extrude",
          params: {}
        }] }]
      })
    }),
    /spur_gear_01\.tooth\.01.*profile repair failed.*requires profile/i
  );
});

test("targeted profile repair keeps the original assembly when retry omits parts", async () => {
  await assert.rejects(
    repairInvalidExtrudeProfile({
      plan: {
        name: "gear_pair",
        parts: [{ id: "gear_left", featureTree: [{
          id: "gear_left.tooth.01",
          type: "add_extrude",
          params: { depth: 20, profile: {} }
        }] }]
      },
      normalize: normalizeParametricPlan,
      retry: async () => ({ name: "gear_pair", parts: [] })
    }),
    (error) => {
      assert.doesNotMatch(error.message, /Assembly plan requires at least one part/);
      assert.match(error.message, /profile requires a type/i);
      return true;
    }
  );
});

test("retries an invalid chamfer selector once and accepts a repaired selector", async () => {
  const calls = [];
  const makePlan = (selector) => ({
    parts: [{
      id: "chassis",
      featureTree: [
        { id: "chassis.base.01", type: "base_box", params: { size: [80, 40, 6] } },
        {
          id: "chassis.chamfer.01",
          type: "chamfer",
          dependsOn: ["chassis.base.01"],
          params: { distance: 1 },
          selector
        }
      ]
    }]
  });

  const result = await repairInvalidExtrudeProfile({
    plan: makePlan({ kind: "mystery_edges" }),
    normalize: normalizeParametricPlan,
    retry: async (context) => {
      calls.push(context);
      return makePlan({ kind: "legacy_all_edges" });
    }
  });

  assert.deepEqual(calls, [{
    featureId: "chassis.chamfer.01",
    featureType: "chamfer",
    message: "Feature chassis.chamfer.01 chamfer requires a valid selector"
  }]);
  assert.deepEqual(result.parts[0].featureTree[1].selector, { kind: "legacy_all_edges" });
});

test("accepts a repaired plan whose pattern omits sourceFeatureId but has one legal dependency", async () => {
  const initialPlan = {
    parts: [{
      id: "stepper_57_l_bracket",
      featureTree: [{
        id: "stepper_57_l_bracket.base.03",
        type: "add_extrude",
        params: { profile: { width: 60, height: 8 }, depth: 40 }
      }]
    }]
  };
  const repairedPlan = {
    parts: [{
      id: "stepper_57_l_bracket",
      featureTree: [
        {
          id: "stepper_57_l_bracket.base.03",
          type: "add_extrude",
          params: { profile: { type: "rectangle", width: 60, height: 8 }, depth: 40 }
        },
        {
          id: "stepper_57_l_bracket.hole.seed",
          type: "hole",
          dependsOn: ["stepper_57_l_bracket.base.03"],
          params: { diameter: 5 }
        },
        {
          id: "stepper_57_l_bracket.hole.01",
          type: "linear_pattern",
          dependsOn: ["stepper_57_l_bracket.hole.seed"],
          params: { count: 4, spacing: 10 }
        }
      ]
    }]
  };

  const result = await repairInvalidExtrudeProfile({
    plan: initialPlan,
    normalize: normalizeParametricPlan,
    retry: async () => repairedPlan
  });

  assert.equal(
    result.parts[0].featureTree[2].params.sourceFeatureId,
    "stepper_57_l_bracket.hole.seed"
  );
});

test("retries an unsupported cut_extrude profile type", async () => {
  const calls = [];
  const invalidPlan = makeExtrudePlan({
    featureId: "nema23_l_bracket.relief.01",
    featureType: "cut_extrude",
    profile: { type: "spline", width: 12, height: 4 }
  });

  const result = await repairInvalidExtrudeProfile({
    plan: invalidPlan,
    normalize: normalizeParametricPlan,
    retry: async (context) => {
      calls.push(context);
      return makeExtrudePlan({
        featureId: "nema23_l_bracket.relief.01",
        featureType: "cut_extrude",
        profile: { type: "rectangle", width: 12, height: 4 }
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].featureId, "nema23_l_bracket.relief.01");
  assert.equal(calls[0].featureType, "cut_extrude");
  assert.match(calls[0].message, /unsupported parametric profile: spline/i);
  assert.equal(result.parts[0].featureTree[0].enabled, true);
  assert.equal(result.parts[0].featureTree[0].params.profile.type, "rectangle");
});

test("retries an unsupported profile type containing a newline", async () => {
  const calls = [];
  const invalidPlan = makeExtrudePlan({
    featureType: "cut_extrude",
    profile: { type: "spline\nprofile" }
  });

  const result = await repairInvalidExtrudeProfile({
    plan: invalidPlan,
    normalize: normalizeParametricPlan,
    retry: async (context) => {
      calls.push(context);
      return makeExtrudePlan({
        featureType: "cut_extrude",
        profile: { type: "rectangle", width: 12, height: 4 }
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].featureId, "nema23_l_bracket.upright.01");
  assert.equal(calls[0].featureType, "cut_extrude");
  assert.equal(
    calls[0].message,
    "Feature nema23_l_bracket.upright.01 cut_extrude has unsupported parametric profile: spline\nprofile"
  );
  assert.equal(result.parts[0].featureTree[0].params.profile.type, "rectangle");
});

for (const featureType of ["add_extrude", "cut_extrude"]) {
  test(`retries an unsupported ID-less ${featureType} using its generated feature ID`, async () => {
    const calls = [];
    const generatedPartId = featureType === "add_extrude";
    const partId = generatedPartId ? "plate-01" : "plate";
    const result = await repairInvalidExtrudeProfile({
      plan: makeIdlessExtrudePlan({
        featureType,
        profile: { type: "spline" },
        generatedPartId
      }),
      normalize: normalizeParametricPlan,
      retry: async (context) => {
        calls.push(context);
        return makeIdlessExtrudePlan({
          featureType,
          profile: { type: "rectangle", width: 12, height: 4 },
          generatedPartId
        });
      }
    });

    assert.deepEqual(calls, [{
      featureId: `${partId}.${featureType}.01`,
      featureType,
      message: `Feature ${partId}.${featureType}.01 ${featureType} has unsupported parametric profile: spline`
    }]);
    assert.equal(result.parts[0].featureTree[0].id, `${partId}.${featureType}.01`);
    assert.equal(result.parts[0].featureTree[0].params.profile.type, "rectangle");
  });
}

test("retries an unsupported ID-less extrude from the legacy features container", async () => {
  const calls = [];
  const result = await repairInvalidExtrudeProfile({
    plan: makeIdlessExtrudePlan({
      featureType: "cut_extrude",
      profile: { type: "spline" },
      legacy: true
    }),
    normalize: normalizeParametricPlan,
    retry: async (context) => {
      calls.push(context);
      return makeIdlessExtrudePlan({
        featureType: "cut_extrude",
        profile: { type: "rectangle", width: 12, height: 4 },
        legacy: true
      });
    }
  });

  assert.deepEqual(calls, [{
    featureId: "plate.cut_extrude.01",
    featureType: "cut_extrude",
    message: "Feature plate.cut_extrude.01 cut_extrude has unsupported parametric profile: spline"
  }]);
  assert.equal(result.parts[0].featureTree[0].id, "plate.cut_extrude.01");
  assert.equal(result.parts[0].featureTree[0].params.profile.type, "rectangle");
});

test("returns a normalized valid plan without retrying", async () => {
  let calls = 0;
  const validPlan = makeExtrudePlan({
    profile: { type: "rectangle", width: 42, height: 8 }
  });

  const result = await repairInvalidExtrudeProfile({
    plan: validPlan,
    normalize: normalizeParametricPlan,
    retry: async () => {
      calls += 1;
      return {};
    }
  });

  assert.equal(calls, 0);
  assert.notStrictEqual(result, validPlan);
  assert.deepEqual(result.parts[0].featureTree[0].dependsOn, []);
  assert.equal(result.parts[0].featureTree[0].enabled, true);
  assert.equal(result.parts[0].features[0].type, "add_extrude");
});

test("does not retry unrelated schema failures and rethrows the original error", async () => {
  let calls = 0;
  let originalError;

  await assert.rejects(
    repairInvalidExtrudeProfile({
      plan: { parts: "invalid" },
      normalize: (plan) => {
        try {
          return normalizeParametricPlan(plan);
        } catch (error) {
          originalError = error;
          throw error;
        }
      },
      retry: async () => {
        calls += 1;
        return {};
      }
    }),
    (error) => error === originalError
  );
  assert.equal(calls, 0);
});

test("preserves original profile dimensions when the retry omits one", async () => {
  let calls = 0;
  const normalizationInputs = [];
  const initialPlan = makeExtrudePlan();
  const retriedPlan = makeExtrudePlan({
    profile: { type: "rectangle", width: 42 }
  });

  const result = await repairInvalidExtrudeProfile({
    plan: initialPlan,
    normalize: (plan) => {
      normalizationInputs.push(plan);
      return normalizeParametricPlan(plan);
    },
    retry: async () => {
      calls += 1;
      return retriedPlan;
    }
  });

  assert.equal(calls, 1);
  assert.equal(normalizationInputs.length, 2);
  assert.strictEqual(normalizationInputs[0], initialPlan);
  assert.notStrictEqual(normalizationInputs[1], retriedPlan);
  assert.equal(result.parts[0].featureTree[0].params.profile.type, "rectangle");
  assert.equal(result.parts[0].featureTree[0].params.profile.height, 8);
});

test("rejects an unsupported profile after exactly one revalidated retry", async () => {
  let calls = 0;
  const normalizationInputs = [];
  const initialPlan = makeExtrudePlan({
    featureId: "nema23_l_bracket.relief.01",
    featureType: "cut_extrude",
    profile: { type: "spline" }
  });
  const retriedPlan = makeExtrudePlan({
    featureId: "nema23_l_bracket.relief.01",
    featureType: "cut_extrude",
    profile: { type: "bezier" }
  });

  await assert.rejects(
    repairInvalidExtrudeProfile({
      plan: initialPlan,
      normalize: (plan) => {
        normalizationInputs.push(plan);
        return normalizeParametricPlan(plan);
      },
      retry: async () => {
        calls += 1;
        return retriedPlan;
      }
    }),
    (error) => {
      assert.match(
        error.message,
        /nema23_l_bracket\.relief\.01.*profile repair failed.*(?:requires a supported type|unsupported(?: parametric)? profile)/i
      );
      assert.match(error.cause?.message || "", /unsupported parametric profile: bezier/i);
      return true;
    }
  );
  assert.equal(calls, 1);
  assert.equal(normalizationInputs.length, 2);
  assert.strictEqual(normalizationInputs[0], initialPlan);
  assert.notStrictEqual(normalizationInputs[1], retriedPlan);
  assert.deepEqual(normalizationInputs[1], retriedPlan);
});

test("repairs malformed finish selectors before parametric normalization", () => {
  const plan = {
    parts: [{
      id: "gearbox_lower_housing",
      featureTree: [
        { id: "gearbox_lower_housing.edge_fillet.01", type: "fillet", params: { radius: 2 }, selector: { kind: "feature", tags: ["outer"] } },
        { id: "gearbox_lower_housing.edge_chamfer.01", type: "chamfer", params: { distance: 1 } }
      ]
    }]
  };
  profileRepair.repairFinishSelectors(plan);
  assert.deepEqual(plan.parts[0].featureTree.map((feature) => feature.selector), [
    { kind: "legacy_all_edges" },
    { kind: "legacy_all_edges" }
  ]);
});

test("converts an incomplete gearbox rectangle cavity into a deterministic cut box", () => {
  const plan = {
    parts: [{
      id: "gearbox_lower_housing",
      name: "下箱体",
      featureTree: [
        { id: "gearbox_lower_housing.base.01", type: "base_box", params: { size: [140, 160, 40], pose: { translate: [0, 0, -20] } } },
        { id: "gearbox_lower_housing.cavity.01", name: "下箱体内腔", type: "cut_extrude", dependsOn: ["gearbox_lower_housing.base.01"], params: { profile: { type: "rectangle", height: 144 }, axis: "z", depth: 32 } },
        { id: "gearbox_lower_housing.wall.01", type: "dimension", params: { name: "wallThickness", value: 8 } }
      ]
    }]
  };

  profileRepair.repairBoxCavities(plan);
  const cavity = plan.parts[0].featureTree[1];
  assert.equal(cavity.type, "cut_box");
  assert.deepEqual(cavity.params, { size: [124, 144, 32], center: [0, 0, -16] });
});

test("moves safe rectangle width and height aliases into the profile", () => {
  const plan = { parts: [{ id: "plate", featureTree: [{
    id: "plate.cut.01",
    type: "cut_extrude",
    params: { profile: { type: "rectangle" }, size: [24, 12], depth: 4 }
  }] }] };
  profileRepair.repairProfileAliases(plan);
  assert.deepEqual(plan.parts[0].featureTree[0].params.profile, { type: "rectangle", width: 24, height: 12 });
});

test("converts a depthless shaft gear seat into a deterministic cylinder", () => {
  const plan = {
    relations: [{ type: "concentric", from: "input_shaft", to: "driving_gear" }],
    parts: [
      {
        id: "input_shaft",
        featureTree: [
          { id: "input_shaft.base.01", type: "base_cylinder", params: { radius: 10, height: 90 } },
          { id: "input_shaft.gear_seat.01", name: "主动齿轮安装段", type: "add_extrude", params: { profile: { type: "circle", radius: 12.5 }, center: [0, 0, 5] } }
        ]
      },
      {
        id: "driving_gear",
        featureTree: [{ id: "driving_gear.base.01", type: "base_spur_gear", params: { module: 2.5, teeth: 20, width: 25 } }]
      }
    ]
  };

  profileRepair.repairMechanicalExtrudes(plan);
  const seat = plan.parts[0].featureTree[1];
  assert.equal(seat.type, "add_primitive");
  assert.deepEqual(seat.params.primitive, {
    type: "cylinder",
    radius: 12.5,
    height: 25,
    center: true,
    pose: { translate: [0, 0, 5], rotate: [0, 0, 0] }
  });
});

test("repairs a non-positive gearbox input center dimension from center distance", () => {
  const plan = { parts: [{ id: "gearbox_lower_housing", featureTree: [
    { id: "gearbox_lower_housing.input_center.01", type: "dimension", params: { name: "input_center", value: 0 } },
    { id: "gearbox_lower_housing.center_distance.01", type: "dimension", params: { name: "center_distance", value: 72 } }
  ] }] };
  profileRepair.repairInvalidMechanicalDimensions(plan);
  assert.equal(plan.parts[0].featureTree[0].params.value, 72);
  assert.match(plan.parts[0].featureTree[0].params.repairNote, /center distance/);
});
