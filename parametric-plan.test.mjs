import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDependencyGraph,
  checksumParametricPart,
  normalizeFeatureNode,
  normalizeParametricPlan,
  resolveDimensionRefs
} from "./parametric-plan.js";
import * as parametricPlan from "./parametric-plan.js";

function legacyBracket() {
  return {
    name: "demo",
    parts: [{
      id: "bracket",
      primitives: [{ type: "box", size: [60, 20, 6], center: [0, 0, 3] }],
      features: [{ type: "hole", center: [0, 0, 0], diameter: 6 }]
    }]
  };
}

test("legacy primitives and features receive deterministic stable IDs", () => {
  const first = normalizeParametricPlan(legacyBracket());
  const second = normalizeParametricPlan(legacyBracket());

  assert.deepEqual(first.parts[0].featureTree, second.parts[0].featureTree);
  assert.equal(first.parts[0].featureTree[0].id, "bracket.base.01");
  assert.equal(first.parts[0].featureTree[1].id, "bracket.hole.01");
  assert.equal(first.parts[0].featureTree[0].type, "base_box");
});

test("normalization deep-clones its input and is idempotent", () => {
  const input = legacyBracket();
  const snapshot = structuredClone(input);
  const once = normalizeParametricPlan(input);
  const twice = normalizeParametricPlan(once);

  assert.deepEqual(input, snapshot);
  assert.deepEqual(twice, once);
  assert.notEqual(once, input);
  assert.notEqual(once.parts[0], input.parts[0]);
});

test("removes an unambiguous duplicate root pose already applied at part level", () => {
  const pose = { translate: [28, 29, 15], rotate: [90, 0, 0] };
  const input = {
    parts: [{
      id: "front_left_wheel",
      pose,
      featureTree: [{
        id: "front_left_wheel.base.01",
        type: "base_cylinder",
        params: { radius: 15, height: 8, center: true, pose }
      }]
    }]
  };

  const once = normalizeParametricPlan(input);
  const twice = normalizeParametricPlan(once);

  assert.deepEqual(once.parts[0].pose, pose);
  assert.equal(once.parts[0].featureTree[0].params.pose, undefined);
  assert.equal(once.parts[0].primitives[0].pose, undefined);
  assert.deepEqual(twice, once);
  assert.deepEqual(input.parts[0].featureTree[0].params.pose, pose);
});

test("preserves a distinct root-local pose", () => {
  const normalized = normalizeParametricPlan({
    parts: [{
      id: "offset_body",
      pose: { translate: [20, 0, 0], rotate: [0, 0, 0] },
      featureTree: [{
        id: "offset_body.base.01",
        type: "base_box",
        params: { size: [10, 10, 10], pose: { translate: [2, 0, 0], rotate: [0, 0, 0] } }
      }]
    }]
  });

  assert.deepEqual(normalized.parts[0].featureTree[0].params.pose.translate, [2, 0, 0]);
});

test("converts additional base solids into additive primitives while preserving IDs and dependencies", () => {
  const input = {
    parts: [{
      id: "stepper57_l_bracket",
      featureTree: [
        {
          id: "stepper57_l_bracket.base.01",
          type: "base_box",
          params: { size: [100, 80, 6], center: true }
        },
        {
          id: "stepper57_l_bracket.base.02",
          type: "base_box",
          dependsOn: ["stepper57_l_bracket.base.01"],
          params: {
            size: [80, 6, 80],
            center: true,
            pose: { translate: [0, 37, 43], rotate: [0, 0, 0] }
          }
        },
        {
          id: "stepper57_l_bracket.hole.01",
          type: "hole",
          dependsOn: ["stepper57_l_bracket.base.02"],
          params: { diameter: 28, depth: 14, axis: "y", center: [0, 37, 43] }
        }
      ]
    }]
  };
  const snapshot = structuredClone(input);

  const once = normalizeParametricPlan(input);
  const twice = normalizeParametricPlan(once);
  const [base, upright, hole] = once.parts[0].featureTree;

  assert.equal(base.type, "base_box");
  assert.equal(upright.id, "stepper57_l_bracket.base.02");
  assert.equal(upright.type, "add_primitive");
  assert.deepEqual(upright.dependsOn, ["stepper57_l_bracket.base.01"]);
  assert.deepEqual(upright.params, {
    primitive: {
      type: "box",
      size: [80, 6, 80],
      center: true,
      pose: { translate: [0, 37, 43], rotate: [0, 0, 0] }
    }
  });
  assert.deepEqual(hole.dependsOn, ["stepper57_l_bracket.base.02"]);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(twice, once);
});

test("an explicitly empty feature tree is authoritative over legacy arrays", () => {
  const part = normalizeParametricPlan({
    parts: [{
      id: "fixture",
      featureTree: [],
      primitives: [{ type: "box", size: [20, 20, 4] }],
      features: [{ type: "add", name: "boss", primitive: { type: "cylinder", diameter: 8, height: 6 } }]
    }]
  }).parts[0];

  assert.deepEqual(part.featureTree, []);
  assert.deepEqual(part.primitives, []);
  assert.deepEqual(part.features, []);
});

test("normalizes supported nodes and validates common node fields", () => {
  const supported = [
    ["base_box", { size: [3, 3, 3] }],
    ["base_cylinder", { diameter: 3, height: 3 }],
    ["base_cone", { radius1: 3, radius2: 2, height: 3 }],
    ["base_sphere", { radius: 3 }],
    ["base_ellipsoid", { radii: [3, 2, 4] }],
    ["add_extrude", { profile: { type: "rectangle", width: 4, height: 2 }, depth: 3 }],
    ["cut_extrude", { profile: { type: "circle", diameter: 2 }, depth: 3 }],
    ["cut_extrude", { profile: { type: "rounded_rectangle", width: 9.2, height: 3.4, cornerRadius: 1 }, depth: 3 }],
    ["hole", { diameter: 3 }],
    ["slot", { length: 6, width: 3, depth: 3 }],
    ["cut_box", { size: [3, 3, 3] }],
    ["add_primitive", { primitive: { type: "box", size: [3, 3, 3] } }],
    ["linear_pattern", { sourceFeatureId: "part.base.01", count: 2, spacing: 3 }],
    ["circular_pattern", { sourceFeatureId: "part.base.01", count: 2, angle: 360 }],
    ["fillet", { radius: 3 }],
    ["chamfer", { distance: 3 }],
    ["dimension", { name: "wall", value: 3 }]
  ];
  const counters = new Map();
  const nodes = supported.map(([type, params], index) => normalizeFeatureNode("part", {
    type,
    enabled: index !== 1,
    dependsOn: index ? ["part.base.01"] : [],
    params,
    selector: ["fillet", "chamfer"].includes(type)
      ? { kind: "axis_position", axis: "Z", position: 0 }
      : undefined
  }, index, counters));

  assert.deepEqual(nodes[0], {
    id: "part.base.01",
    type: "base_box",
    enabled: true,
    dependsOn: [],
    params: { size: [3, 3, 3] }
  });
  assert.equal(nodes[1].enabled, false);
  assert.deepEqual(nodes[14].selector, { kind: "axis_position", axis: "Z", position: 0 });
  assert.equal(nodes.at(-1).id, "part.dimension.01");

  assert.throws(() => normalizeFeatureNode("part", { type: "hole", enabled: "yes", diameter: 3 }, 0, new Map()), /enabled/i);
  assert.throws(() => normalizeFeatureNode("part", { type: "hole", dependsOn: "base", diameter: 3 }, 0, new Map()), /dependsOn/i);
  assert.throws(() => normalizeFeatureNode("part", { type: "hole", params: [] }, 0, new Map()), /params/i);
  assert.deepEqual(
    normalizeFeatureNode("part", { type: "fillet", selector: "all", radius: 2 }, 0, new Map()).selector,
    { kind: "legacy_all_edges" }
  );
});

test("normalizes a native parametric spur gear base", () => {
  const plan = normalizeParametricPlan({
    parts: [{
      id: "gear",
      featureTree: [{
        id: "gear.base.01",
        type: "base_spur_gear",
        params: { module: 10, teeth: 17, width: 20, boreRadius: 5 }
      }]
    }]
  });

  assert.equal(plan.parts[0].featureTree[0].type, "base_spur_gear");
  assert.deepEqual(plan.parts[0].primitives, [{ type: "spur_gear", module: 10, teeth: 17, width: 20, boreRadius: 5 }]);
});

test("allows a zero optional spur-gear bore while rejecting negative bores", () => {
  assert.doesNotThrow(() => normalizeFeatureNode("input_pinion", {
    id: "input_pinion.base.01",
    type: "base_spur_gear",
    params: { module: 2, teeth: 20, width: 8, boreRadius: 0 }
  }, 0, new Map()));
  assert.throws(() => normalizeFeatureNode("input_pinion", {
    id: "input_pinion.base.01",
    type: "base_spur_gear",
    params: { module: 2, teeth: 20, width: 8, boreRadius: -1 }
  }, 0, new Map()), /boreRadius.*positive/i);
});

test("canonicalizes the driven native gear phase for a horizontal external pair", () => {
  const plan = normalizeParametricPlan({
    parts: [
      { id: "left", featureTree: [{ id: "left.base.01", type: "base_spur_gear", params: { module: 10, teeth: 17, width: 20 } }], pose: { translate: [0, 0, 0], rotate: [0, 0, 0] } },
      { id: "right", featureTree: [{ id: "right.base.01", type: "base_spur_gear", params: { module: 10, teeth: 20, width: 20 } }], pose: { translate: [185, 0, 0], rotate: [0, 0, 10.5882352941] } }
    ],
    constraints: [{ id: "mesh", type: "gear", from: { partId: "left" }, to: { partId: "right" }, ratio: -0.85 }]
  });

  assert.equal(plan.parts[1].pose.rotate[2], 9);
});

test("preserves explicit IDs while advancing deterministic counters", () => {
  const normalized = normalizeParametricPlan({
    parts: [{
      id: "plate",
      featureTree: [
        { id: "plate.hole.07", type: "hole", params: { diameter: 4 } },
        { type: "hole", params: { diameter: 5 } }
      ]
    }]
  });

  assert.deepEqual(normalized.parts[0].featureTree.map((node) => node.id), [
    "plate.hole.07",
    "plate.hole.08"
  ]);
});

test("reserves explicit IDs before assigning missing IDs", () => {
  const normalized = normalizeParametricPlan({
    parts: [{
      id: "plate",
      featureTree: [
        { type: "hole", params: { diameter: 5 } },
        { id: "plate.hole.01", type: "hole", params: { diameter: 4 } }
      ]
    }]
  });

  assert.deepEqual(normalized.parts[0].featureTree.map((node) => node.id), [
    "plate.hole.02",
    "plate.hole.01"
  ]);
});

test("automatic IDs avoid every explicit ID regardless of node type", () => {
  const normalized = normalizeParametricPlan({
    parts: [{
      id: "plate",
      featureTree: [
        { id: "plate.hole.01", type: "slot", params: {} },
        { type: "hole", params: {} }
      ]
    }]
  });

  assert.deepEqual(normalized.parts[0].featureTree.map((node) => node.id), [
    "plate.hole.01",
    "plate.hole.02"
  ]);
});

test("legacy defaults and cone aliases remain migratable", () => {
  const part = normalizeParametricPlan({
    parts: [{
      id: "legacy",
      primitives: [
        { type: "box" },
        { type: "cone", bottomRadius: 8, topRadius: 3 },
        { type: "sphere", diameter: 20 }
      ],
      features: [{ type: "hole" }, { type: "slot" }]
    }]
  }).parts[0];

  assert.equal(part.featureTree.length, 5);
  assert.deepEqual(part.primitives, [{ type: "box" }]);
  assert.deepEqual(part.features[0], {
    type: "add",
    primitive: { type: "cone", bottomRadius: 8, topRadius: 3 }
  });
  assert.deepEqual(part.features[1], {
    type: "add",
    primitive: { type: "sphere", radius: 10 }
  });
});

test("normalizes legacy vector centers into primitive poses without losing placement", () => {
  const base = normalizeFeatureNode("character", {
    type: "base_sphere",
    params: { radius: 42, center: [0, 0, 63] }
  }, 0, new Map());
  const added = normalizeFeatureNode("character", {
    type: "add_primitive",
    params: { primitive: { type: "ellipsoid", radii: [20, 12, 30], center: [0, -2, 70] } }
  }, 1, new Map());

  assert.deepEqual(base.params.pose.translate, [0, 0, 63]);
  assert.deepEqual(base.params.center, [0, 0, 63]);
  assert.deepEqual(added.params.primitive.pose.translate, [0, -2, 70]);
  assert.deepEqual(added.params.primitive.center, [0, -2, 70]);
  assert.throws(() => normalizeFeatureNode("character", {
    type: "base_sphere",
    params: { radius: 42, center: [0, 0, 63], pose: { translate: [0, 0, 0] } }
  }, 0, new Map()), /conflicting primitive center and pose\.translate/i);
});

test("infers a missing dimension value from equal legacy scalar fields", () => {
  const node = normalizeFeatureNode("stepper57_l_bracket", {
    id: "stepper57_l_bracket.dimension.01",
    name: "电机安装孔中心距",
    type: "dimension",
    params: {
      horizontalPitch: 47.14,
      verticalPitch: 47.14,
      faceCenter: [0, -27.5, 40]
    }
  }, 0, new Map());

  assert.equal(node.params.name, "电机安装孔中心距");
  assert.equal(node.params.value, 47.14);
  assert.deepEqual(node.params.faceCenter, [0, -27.5, 40]);
});

test("infers a missing dimension value from one legacy scalar field", () => {
  const node = normalizeFeatureNode("plate", {
    name: "板厚",
    type: "dimension",
    params: { thickness: 6 }
  }, 0, new Map());

  assert.equal(node.params.value, 6);
});

test("rejects conflicting or valueless legacy dimension groups", () => {
  assert.throws(() => normalizeFeatureNode("plate", {
    name: "孔距",
    type: "dimension",
    params: { horizontalPitch: 47.14, verticalPitch: 50 }
  }, 0, new Map()), /dimension requires value/i);

  assert.throws(() => normalizeFeatureNode("plate", {
    name: "孔中心",
    type: "dimension",
    params: { faceCenter: [0, 0, 10] }
  }, 0, new Map()), /dimension requires value/i);
});

test("rejects duplicate part IDs and feature IDs outside their part namespace", () => {
  assert.throws(() => normalizeParametricPlan({ parts: [
    { id: "plate", featureTree: [] },
    { id: "plate", featureTree: [] }
  ] }), /duplicate part id.*plate/i);

  assert.throws(() => normalizeParametricPlan({ parts: [{
    id: "plate",
    featureTree: [{ id: "other.hole.01", type: "hole", params: {} }]
  }] }), /feature id.*other\.hole\.01.*namespace.*plate/i);
});

test("validates executable schemas for extrudes, patterns, primitives, and finishes", () => {
  assert.throws(() => normalizeFeatureNode("p", {
    type: "add_extrude",
    params: { depth: 3 }
  }, 0, new Map()), /add_extrude.*profile/i);
  assert.throws(() => normalizeFeatureNode("p", {
    type: "cut_extrude",
    params: { profile: { type: "spline" }, depth: 3 }
  }, 0, new Map()), /unsupported.*profile.*spline/i);
  assert.throws(() => normalizeFeatureNode("p", {
    type: "cut_extrude",
    params: { profile: { type: "rounded_rectangle", width: 9.2, height: 3.4, cornerRadius: 1.7 }, depth: 3 }
  }, 0, new Map()), /cornerRadius must be less than half/i);
  const inferredPattern = normalizeFeatureNode("p", {
    type: "linear_pattern",
    dependsOn: ["p.hole.01"],
    params: { count: 3, spacing: 5 }
  }, 0, new Map());
  assert.equal(inferredPattern.params.sourceFeatureId, "p.hole.01");
  assert.throws(() => normalizeFeatureNode("p", {
    type: "circular_pattern",
    dependsOn: ["p.base.01"],
    params: { sourceFeatureId: "p.hole.01", count: 3, angle: 360 }
  }, 0, new Map()), /sourceFeatureId.*dependsOn/i);
  assert.throws(() => normalizeFeatureNode("p", {
    type: "add_primitive",
    params: {}
  }, 0, new Map()), /add_primitive.*primitive/i);
  assert.throws(() => normalizeFeatureNode("p", {
    type: "add_primitive",
    params: { primitive: { type: "torus" } }
  }, 0, new Map()), /supported primitive/i);
  const finishWithoutSelector = normalizeFeatureNode("p", {
    type: "fillet",
    params: { radius: 2 }
  }, 0, new Map());
  assert.deepEqual(finishWithoutSelector.selector, { kind: "legacy_all_edges" });
  assert.throws(() => normalizeFeatureNode("p", {
    type: "fillet",
    params: { radius: 2 },
    selector: { foo: true }
  }, 0, new Map()), /fillet.*valid selector/i);
  assert.throws(() => normalizeFeatureNode("p", {
    type: "chamfer",
    params: {},
    selector: { kind: "named", name: "outer-edge" }
  }, 0, new Map()), /chamfer.*distance/i);
});

test("infers missing pattern sourceFeatureId from one legal dependency", () => {
  const input = {
    parts: [{
      id: "stepper_57_l_bracket",
      featureTree: [
        { id: "stepper_57_l_bracket.base.01", type: "base_box", params: { size: [60, 40, 8] } },
        { id: "stepper_57_l_bracket.hole.seed", type: "hole", dependsOn: ["stepper_57_l_bracket.base.01"], params: { diameter: 5 } },
        { id: "stepper_57_l_bracket.hole.01", type: "linear_pattern", dependsOn: ["stepper_57_l_bracket.hole.seed"], params: { count: 4, spacing: 10 } },
        { id: "stepper_57_l_bracket.slot.seed", type: "slot", dependsOn: ["stepper_57_l_bracket.base.01"], params: { length: 12, width: 4, depth: 10 } },
        { id: "stepper_57_l_bracket.slot.01", type: "circular_pattern", dependsOn: ["stepper_57_l_bracket.slot.seed"], params: { count: 4, angle: 360 } }
      ]
    }]
  };
  const snapshot = structuredClone(input);

  const once = normalizeParametricPlan(input);
  const twice = normalizeParametricPlan(once);

  assert.equal(once.parts[0].featureTree[2].params.sourceFeatureId, "stepper_57_l_bracket.hole.seed");
  assert.equal(once.parts[0].featureTree[4].params.sourceFeatureId, "stepper_57_l_bracket.slot.seed");
  assert.deepEqual(input, snapshot);
  assert.deepEqual(twice, once);
});

test("does not infer an ambiguous or missing pattern dependency", () => {
  assert.throws(() => normalizeParametricPlan({
    parts: [{
      id: "plate",
      featureTree: [
        { id: "plate.hole.01", type: "hole", params: { diameter: 4 } },
        { id: "plate.hole.02", type: "hole", params: { diameter: 4 } },
        { type: "linear_pattern", dependsOn: ["plate.hole.01", "plate.hole.02"], params: { count: 3, spacing: 8 } }
      ]
    }]
  }), /linear_pattern.*sourceFeatureId/i);

  assert.throws(() => normalizeParametricPlan({
    parts: [{
      id: "plate",
      featureTree: [
        { type: "linear_pattern", dependsOn: ["plate.hole.missing"], params: { count: 3, spacing: 8 } }
      ]
    }]
  }), /missing dependency.*plate\.hole\.missing/i);
});

test("rejects inference from an illegal pattern source type", () => {
  assert.throws(() => normalizeParametricPlan({
    parts: [{
      id: "plate",
      featureTree: [
        { id: "plate.base.01", type: "base_box", params: { size: [30, 20, 4] } },
        { type: "linear_pattern", dependsOn: ["plate.base.01"], params: { count: 3, spacing: 8 } }
      ]
    }]
  }), /unsupported pattern source type.*base_box/i);
});

test("preserves an explicit pattern sourceFeatureId", () => {
  const normalized = normalizeParametricPlan({
    parts: [{
      id: "plate",
      featureTree: [
        { id: "plate.hole.01", type: "hole", params: { diameter: 4 } },
        { id: "plate.hole.02", type: "hole", params: { diameter: 5 } },
        {
          type: "linear_pattern",
          dependsOn: ["plate.hole.01", "plate.hole.02"],
          params: { sourceFeatureId: "plate.hole.02", count: 3, spacing: 8 }
        }
      ]
    }]
  });

  assert.equal(normalized.parts[0].featureTree[2].params.sourceFeatureId, "plate.hole.02");
});

test("unsupported profile validation includes the generated feature ID and feature type", () => {
  assert.throws(() => normalizeParametricPlan({
    parts: [{
      id: "plate",
      featureTree: [{
        type: "cut_extrude",
        params: { profile: { type: "spline" }, depth: 3 }
      }]
    }]
  }), {
    message: "Feature plate.cut_extrude.01 cut_extrude has unsupported parametric profile: spline"
  });
});

for (const [container, makePart, expectedId] of [
  ["featureTree", (type) => ({
    id: "Unsafe Part ID",
    featureTree: [{ type, params: { profile: { type: "spline" }, depth: 3 } }]
  }), "Unsafe Part ID"],
  ["legacy features", (type) => ({
    name: "Plate",
    features: [{ type, profile: { type: "spline" }, depth: 3 }]
  }), "plate-01"]
]) {
  for (const featureType of ["add_extrude", "cut_extrude"]) {
    test(`preflights malformed ID-less ${container} ${featureType} with canonical feature context`, () => {
      assert.equal(typeof parametricPlan.preflightExtrudeProfiles, "function");
      const plan = { parts: [makePart(featureType)] };
      const snapshot = structuredClone(plan);

      assert.throws(() => parametricPlan.preflightExtrudeProfiles(plan), {
        message: `Feature ${expectedId}.${featureType}.01 ${featureType} has unsupported parametric profile: spline`
      });
      assert.deepEqual(plan, snapshot);
    });
  }
}

test("extrude preflight preserves the full multiline illegal profile type", () => {
  assert.equal(typeof parametricPlan.preflightExtrudeProfiles, "function");

  assert.throws(() => parametricPlan.preflightExtrudeProfiles({
    parts: [{
      id: "plate",
      featureTree: [{
        type: "cut_extrude",
        params: { profile: { type: "spline\nprofile" }, depth: 3 }
      }]
    }]
  }), {
    message: "Feature plate.cut_extrude.01 cut_extrude has unsupported parametric profile: spline\nprofile"
  });
});

test("extrude preflight reports a missing profile type with generated feature context", () => {
  assert.equal(typeof parametricPlan.preflightExtrudeProfiles, "function");

  assert.throws(() => parametricPlan.preflightExtrudeProfiles({
    parts: [{
      name: "Plate",
      features: [{ type: "add_extrude", profile: { width: 4, height: 2 }, depth: 3 }]
    }]
  }), {
    message: "Feature plate-01.add_extrude.01 add_extrude profile requires a type"
  });
});

test("extrude preflight ignores unrelated legacy validation failures", () => {
  assert.equal(typeof parametricPlan.preflightExtrudeProfiles, "function");

  assert.doesNotThrow(() => parametricPlan.preflightExtrudeProfiles({
    parts: [{ id: "plate", features: [{ type: "loft" }] }]
  }));
  assert.doesNotThrow(() => parametricPlan.preflightExtrudeProfiles({
    parts: [{
      id: "plate",
      features: [{ type: "add_extrude", profile: { type: "rectangle", width: 4 }, depth: 3 }]
    }]
  }));
  assert.doesNotThrow(() => parametricPlan.preflightExtrudeProfiles({ parts: "invalid" }));
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
  test(`extrude preflight ignores malformed ${container} geometry on standard parts`, () => {
    const plan = { parts: [{
      id: "bearing",
      mode: "standard_part",
      ...geometry
    }] };
    const snapshot = structuredClone(plan);

    assert.doesNotThrow(() => parametricPlan.preflightExtrudeProfiles(plan));
    assert.deepEqual(plan, snapshot);
  });
}

test("rejects unsupported feature types and non-positive functional dimensions", () => {
  assert.throws(() => normalizeFeatureNode("part", { type: "loft" }, 0, new Map()), /unsupported.*loft/i);
  assert.throws(() => normalizeFeatureNode("part", { type: "hole", diameter: 0 }, 0, new Map()), /diameter.*positive/i);
  assert.throws(() => normalizeFeatureNode("part", { type: "base_box", size: [10, -2, 4] }, 0, new Map()), /size.*positive/i);
  assert.throws(() => normalizeFeatureNode("part", { type: "linear_pattern", count: 0, spacing: 4 }, 0, new Map()), /count.*positive/i);
  assert.throws(() => normalizeFeatureNode("part", { type: "base_cone", radius1: -2, radius2: 1, height: 4 }, 0, new Map()), /radius1.*positive/i);
  assert.throws(() => normalizeFeatureNode("part", { type: "hole", diameter: "six" }, 0, new Map()), /diameter.*number/i);
  assert.throws(() => normalizeFeatureNode("part", { type: "dimension", name: "wall" }, 0, new Map()), /dimension.*value/i);
  assert.deepEqual(
    normalizeFeatureNode("part", { type: "fillet", radius: 2 }, 0, new Map()).selector,
    { kind: "legacy_all_edges" }
  );
  assert.throws(() => normalizeFeatureNode("part", {
    type: "chamfer",
    distance: 0,
    selector: { kind: "legacy_all_edges" }
  }, 0, new Map()), /distance.*positive/i);
  assert.throws(() => normalizeFeatureNode("part", {
    type: "fillet",
    radius: -1,
    selector: { kind: "legacy_all_edges" }
  }, 0, new Map()), /radius.*positive/i);
});

test("drops irrelevant solid dimensions from finish features without mutating input", () => {
  const input = {
    parts: [{
      id: "nema57_l_bracket",
      featureTree: [
        { id: "nema57_l_bracket.base.01", type: "base_box", params: { size: [80, 50, 8] } },
        {
          id: "nema57_l_bracket.chamfer.01",
          type: "chamfer",
          dependsOn: ["nema57_l_bracket.base.01"],
          distance: 1,
          size: [80, -25, 8],
          selector: { kind: "axis_position", axis: "z", position: 0 }
        },
        {
          id: "nema57_l_bracket.fillet.01",
          type: "fillet",
          dependsOn: ["nema57_l_bracket.chamfer.01"],
          params: { radius: 2, dimensions: [80, 0, 8] },
          selector: { kind: "axis_position", axis: "z", position: 8 }
        }
      ]
    }]
  };
  const snapshot = structuredClone(input);

  const once = normalizeParametricPlan(input);
  const twice = normalizeParametricPlan(once);
  const [, chamfer, fillet] = once.parts[0].featureTree;

  assert.deepEqual(chamfer.params, { distance: 1 });
  assert.deepEqual(fillet.params, { radius: 2 });
  assert.deepEqual(input, snapshot);
  assert.deepEqual(twice, once);
});

test("converts semantic finish selectors into executable all-edge selectors", () => {
  const input = {
    type: "chamfer",
    params: { distance: 0.8 },
    selector: { kind: "feature", tags: ["decorative", "outer_edges"] }
  };
  const snapshot = structuredClone(input);

  const normalized = normalizeFeatureNode("bracket", input, 0, new Map());

  assert.deepEqual(normalized.selector, { kind: "legacy_all_edges" });
  assert.deepEqual(input, snapshot);
});

test("normalizes common planner finish selector aliases without mutating input", () => {
  const inputs = [
    { type: "chamfer", params: { distance: 0.8 }, selector: "all_edges" },
    { type: "chamfer", params: { distance: 0.8, edgeSelector: { kind: "outer_edges" } } },
    { type: "fillet", params: { radius: 1 }, selector: { kind: "named", name: "perimeter edges" } },
    { type: "fillet", params: { radius: 1 }, selector: { tags: ["decorative", "outer"] } }
  ];
  const snapshot = structuredClone(inputs);

  for (const [index, input] of inputs.entries()) {
    const normalized = normalizeFeatureNode("chassis", input, index, new Map());
    assert.deepEqual(normalized.selector, { kind: "legacy_all_edges" });
    assert.equal(normalized.params.edgeSelector, undefined);
  }
  assert.deepEqual(inputs, snapshot);
});

test("normalizes numeric axis-position finish selectors", () => {
  const normalized = normalizeFeatureNode("chassis", {
    type: "chamfer",
    params: { distance: 0.8 },
    selector: { kind: "axis_position", axis: "Z", position: "4" }
  }, 0, new Map());

  assert.deepEqual(normalized.selector, { kind: "axis_position", axis: "Z", position: 4 });
});

test("resolves named dimension references recursively without mutating the plan", () => {
  const plan = normalizeParametricPlan({
    parts: [{
      id: "plate",
      featureTree: [
        { type: "dimension", params: { name: "holeDiameter", value: 6 } },
        { type: "hole", params: { diameter: "$holeDiameter", countersink: { diameter: "$holeDiameter" } } }
      ]
    }]
  });
  const resolved = resolveDimensionRefs(plan);

  assert.equal(resolved.parts[0].featureTree[1].params.diameter, 6);
  assert.equal(resolved.parts[0].featureTree[1].params.countersink.diameter, 6);
  assert.equal(plan.parts[0].featureTree[1].params.diameter, "$holeDiameter");
  assert.equal(resolved.parts[0].features[0].diameter, 6);
});

test("dimension names are scoped per part", () => {
  const resolved = resolveDimensionRefs(normalizeParametricPlan({ parts: [
    {
      id: "left",
      featureTree: [
        { type: "dimension", params: { name: "width", value: 4 } },
        { type: "hole", params: { diameter: "$width" } }
      ]
    },
    {
      id: "right",
      featureTree: [
        { type: "dimension", params: { name: "width", value: 8 } },
        { type: "hole", params: { diameter: "$width" } }
      ]
    }
  ] }));

  assert.equal(resolved.parts[0].featureTree[1].params.diameter, 4);
  assert.equal(resolved.parts[1].featureTree[1].params.diameter, 8);

  assert.throws(() => resolveDimensionRefs(normalizeParametricPlan({ parts: [
    { id: "left", featureTree: [{ type: "dimension", params: { name: "width", value: 4 } }] },
    { id: "right", featureTree: [{ type: "hole", params: { diameter: "$width" } }] }
  ] })), /part right.*missing dimension.*width/i);
});

test("revalidates type-specific ranges after resolving dimensions", () => {
  const plan = normalizeParametricPlan({ parts: [{
    id: "plate",
    featureTree: [
      { type: "dimension", params: { name: "copies", value: 1 } },
      { type: "hole", params: { diameter: 4 } },
      {
        type: "linear_pattern",
        dependsOn: ["plate.hole.01"],
        params: { sourceFeatureId: "plate.hole.01", count: "$copies", spacing: 8 }
      }
    ]
  }] });

  assert.throws(() => resolveDimensionRefs(plan), /linear_pattern.*count.*at least 2/i);
});

test("rejects malformed plan containers instead of silently dropping data", () => {
  assert.throws(() => normalizeParametricPlan({ parts: { id: "bad" } }), /parts.*array/i);
  assert.throws(() => normalizeParametricPlan({ parts: [{ id: "bad", featureTree: { type: "hole" } }] }), /featureTree.*array/i);
  assert.throws(() => normalizeParametricPlan({ parts: [{ id: "bad", featureTree: [], primitives: {} }] }), /primitives.*array/i);
  assert.throws(() => normalizeParametricPlan({ parts: [{ id: "bad", featureTree: [], features: {} }] }), /features.*array/i);
});

test("rejects missing and non-string node types with clear errors", () => {
  assert.throws(() => normalizeParametricPlan({ parts: [{
    id: "p",
    primitives: [{ size: [1, 2, 3] }]
  }] }), /primitive.*type.*non-empty string/i);
  assert.throws(() => normalizeParametricPlan({ parts: [{
    id: "p",
    features: [{ type: 42 }]
  }] }), /feature.*type.*non-empty string/i);
  assert.throws(() => normalizeFeatureNode("p", { params: {} }, 0, new Map()), /feature.*type.*non-empty string/i);
});

test("rejects missing and duplicate named dimensions", () => {
  assert.throws(() => resolveDimensionRefs({
    parts: [{ id: "p", featureTree: [{ id: "p.hole.01", type: "hole", params: { diameter: "$missing" } }] }]
  }), /missing dimension.*missing/i);

  assert.throws(() => resolveDimensionRefs({
    parts: [{ id: "p", featureTree: [
      { id: "p.dimension.01", type: "dimension", params: { name: "width", value: 2 } },
      { id: "p.dimension.02", type: "dimension", params: { name: "width", value: 3 } }
    ] }]
  }), /duplicate dimension.*width/i);
});

test("dependency graph returns stable topological order and queryable edges", () => {
  const graph = buildDependencyGraph([
    { id: "finish", dependsOn: ["cut", "boss"] },
    { id: "base", dependsOn: [] },
    { id: "boss", dependsOn: ["base"] },
    { id: "cut", dependsOn: ["base"] }
  ]);

  assert.deepEqual(graph.topologicalOrder, ["base", "boss", "cut", "finish"]);
  assert.deepEqual(graph.dependencies.get("finish"), ["cut", "boss"]);
  assert.deepEqual(graph.reverseDependencies.get("base"), ["boss", "cut"]);
  assert.equal(graph.nodesById.get("cut").id, "cut");
});

test("dependency graph rejects cycles", () => {
  assert.throws(() => buildDependencyGraph([
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] }
  ]), /cycle/i);
});

test("dependency graph rejects duplicate IDs and missing dependencies", () => {
  assert.throws(() => buildDependencyGraph([
    { id: "same", dependsOn: [] },
    { id: "same", dependsOn: [] }
  ]), /duplicate.*same/i);

  assert.throws(() => buildDependencyGraph([
    { id: "cut", dependsOn: ["missing"] }
  ]), /missing dependenc.*missing/i);

  assert.throws(() => buildDependencyGraph([
    { id: "cut", dependsOn: "base" }
  ]), /dependsOn.*array/i);
});

test("part checksums are SHA-256 and stable across key order", () => {
  const first = normalizeParametricPlan(legacyBracket()).parts[0];
  const second = {
    features: structuredClone(first.features),
    featureTree: structuredClone(first.featureTree),
    primitives: structuredClone(first.primitives),
    id: first.id
  };

  assert.match(checksumParametricPart(first), /^[a-f0-9]{64}$/);
  assert.equal(checksumParametricPart(first), checksumParametricPart(second));
});

test("generates legacy primitives and features compatibility views", () => {
  const part = normalizeParametricPlan({
    parts: [{
      id: "bracket",
      featureTree: [
        { type: "base_box", params: { size: [60, 20, 6], center: [0, 0, 3] } },
        { type: "hole", params: { center: [0, 0, 0], diameter: 6 } },
        { type: "fillet", params: { radius: 2 }, selector: { kind: "axis_position", axis: "Z", position: 0 } }
      ]
    }]
  }).parts[0];

  assert.deepEqual(part.primitives, [{ type: "box", size: [60, 20, 6], center: [0, 0, 3] }]);
  assert.deepEqual(part.features, [
    { type: "hole", center: [0, 0, 0], diameter: 6 },
    { type: "fillet", radius: 2, selector: { kind: "axis_position", axis: "Z", position: 0 } }
  ]);
});
