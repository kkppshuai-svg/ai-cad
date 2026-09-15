import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeAssemblyConstraints,
  constraintToFreeCadManifest,
  normalizeConstraints,
  resolveDatum
} from "./assembly-constraints.js";


function mechanismPlan() {
  return {
    parts: [
      { id: "base", datums: [{ id: "rail", origin: [0, 0, 0], axis: [1, 0, 0] }] },
      { id: "slider", featureTree: [{ id: "slider.hole.01", type: "hole", params: { center: [0, 0, 0], axis: "x", diameter: 6, depth: 20 } }] },
      { id: "gear_a", datums: [{ id: "axis", origin: [0, 0, 0], axis: [0, 0, 1] }] },
      { id: "gear_b", datums: [{ id: "axis", origin: [20, 0, 0], axis: [0, 0, 1] }] }
    ],
    constraints: [
      { id: "fix-base", type: "fixed", to: { partId: "base" } },
      { id: "slide", type: "slider", from: { partId: "base", datumId: "rail" }, to: { partId: "slider", featureId: "slider.hole.01" }, axis: [1, 0, 0], limit: { lower: 0, upper: 50 } },
      { id: "gear", type: "gear", from: { partId: "gear_a", datumId: "axis" }, to: { partId: "gear_b", datumId: "axis" }, ratio: -2 }
    ]
  };
}


test("normalizes supported assembly constraint types", () => {
  const result = normalizeConstraints({
    parts: [{ id: "a" }, { id: "b" }],
    constraints: [
      { id: "c1", type: "coincident", from: { partId: "a" }, to: { partId: "b" } },
      { id: "c2", type: "concentric", from: { partId: "a" }, to: { partId: "b" } },
      { id: "c3", type: "distance", from: { partId: "a" }, to: { partId: "b" }, value: 10, axis: [1, 0, 0] },
      { id: "c4", type: "angle", from: { partId: "a" }, to: { partId: "b" }, value: 90 },
      { id: "c5", type: "revolute", parent: "a", child: "b", axis: [0, 0, 1] },
      { id: "c6", type: "prismatic", parent: "a", child: "b", axis: [1, 0, 0], limit: { lower: 0, upper: 20 } }
    ]
  });
  assert.deepEqual(result.map((item) => item.type), ["coincident", "concentric", "distance", "angle", "revolute", "slider"]);
  assert.deepEqual(result[4].from, { partId: "a" });
  assert.deepEqual(result[4].to, { partId: "b" });
});


test("resolves explicit and feature-derived datums", () => {
  const plan = mechanismPlan();
  assert.deepEqual(resolveDatum(plan, { partId: "base", datumId: "rail" }), { partId: "base", datumId: "rail", origin: [0, 0, 0], axis: [1, 0, 0], normal: [1, 0, 0] });
  const feature = resolveDatum(plan, { partId: "slider", featureId: "slider.hole.01" });
  assert.deepEqual(feature.origin, [0, 0, 0]);
  assert.deepEqual(feature.axis, [1, 0, 0]);
  assert.throws(() => resolveDatum(plan, { partId: "base", datumId: "missing" }), /datum.*missing/i);
});

test("prefers an explicit featureId over a stale datumId and supports tagged datum aliases", () => {
  const plan = {
    parts: [{
      id: "gear",
      pose: { translate: [92.5, 0, 0], rotate: [0, 0, 0] },
      featureTree: [{
        id: "gear.hole.01",
        type: "hole",
        params: { center: [0, 0, 0], axis: "z", diameter: 10, depth: 20 },
        selector: { kind: "feature", tags: ["datum:gear_axis"] }
      }]
    }]
  };

  const explicit = resolveDatum(plan, { partId: "gear", datumId: "missing", featureId: "gear.hole.01" });
  const tagged = resolveDatum(plan, { partId: "gear", datumId: "gear_axis" });

  assert.deepEqual(explicit.origin, [92.5, 0, 0]);
  assert.equal(explicit.featureId, "gear.hole.01");
  assert.deepEqual(tagged.origin, [92.5, 0, 0]);
  assert.equal(tagged.datumId, "gear_axis");
});


test("reports fixed, revolute, and slider degrees of freedom", () => {
  const plan = mechanismPlan();
  plan.parts.push({ id: "arm" });
  plan.constraints.push({ id: "hinge", type: "revolute", from: { partId: "base" }, to: { partId: "arm" }, axis: [0, 0, 1] });
  const report = analyzeAssemblyConstraints(plan);

  assert.equal(report.parts.base.remainingDof, 0);
  assert.deepEqual(report.parts.slider.free, ["tx"]);
  assert.deepEqual(report.parts.arm.free, ["rz"]);
  assert.equal(report.errors.length, 0);
});

test("single parts do not produce assembly unconstrained warnings", () => {
  const report = analyzeAssemblyConstraints({ parts: [{ id: "part" }], constraints: [] });
  assert.equal(report.parts.part.remainingDof, 6);
  assert.deepEqual(report.warnings, []);
});

test("degree-of-freedom reduction is monotonic and independent of constraint order", () => {
  const constraints = [
    { id: "fix", type: "fixed", to: { partId: "arm" } },
    { id: "hinge", type: "revolute", from: { partId: "base" }, to: { partId: "arm" }, axis: [0, 0, 1] }
  ];
  const forward = analyzeAssemblyConstraints({ parts: [{ id: "base" }, { id: "arm" }], constraints });
  const reverse = analyzeAssemblyConstraints({ parts: [{ id: "base" }, { id: "arm" }], constraints: [...constraints].reverse() });
  assert.equal(forward.parts.arm.remainingDof, 0);
  assert.deepEqual(forward.parts.arm, reverse.parts.arm);
});

test("includes legacy joints in degree-of-freedom analysis", () => {
  const report = analyzeAssemblyConstraints({
    parts: [{ id: "chassis" }, { id: "wheel" }, { id: "slider" }],
    joints: [
      { id: "ground", type: "fixed", parent: "world", child: "chassis" },
      { id: "wheel-axis", type: "continuous", parent: "chassis", child: "wheel", axis: [0, 1, 0] },
      { id: "slide", type: "prismatic", parent: "chassis", child: "slider", axis: [1, 0, 0], limit: { lower: -1, upper: 1 } }
    ]
  });

  assert.equal(report.parts.chassis.remainingDof, 0);
  assert.deepEqual(report.parts.wheel.free, ["ry"]);
  assert.deepEqual(report.parts.slider.free, ["tx"]);
  assert.equal(report.warnings.length, 0);
  assert.deepEqual(report.constraints.map((item) => item.id), ["joint:ground", "joint:wheel-axis", "joint:slide"]);
});

test("joint DOF analysis does not create false world-origin residuals for placed parts", () => {
  const report = analyzeAssemblyConstraints({
    parts: [{ id: "gear", pose: { translate: [92.5, 0, 0], rotate: [0, 0, 0] } }],
    joints: [{
      id: "world_to_gear",
      type: "revolute",
      parent: "world",
      child: "gear",
      origin: { xyz: [0.0925, 0, 0], rpy: [0, 0, 0] },
      axis: [0, 0, 1]
    }]
  });

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.parts.gear.free, ["rz"]);
});

test("rejects joints that reference missing parts", () => {
  const report = analyzeAssemblyConstraints({
    parts: [{ id: "base" }],
    joints: [{ id: "bad", type: "fixed", parent: "base", child: "missing" }]
  });
  assert.equal(report.errors[0].code, "INVALID_CONSTRAINT");
  assert.match(report.errors[0].message, /missing child part/i);
});

test("validates datum constraints in world coordinates", () => {
  const report = analyzeAssemblyConstraints({
    parts: [
      { id: "base", pose: { translate: [0, 0, 0], rotate: [0, 0, 0] }, datums: [{ id: "pin", origin: [0, 0, 0], axis: [0, 0, 1] }] },
      { id: "arm", pose: { translate: [5, 0, 0], rotate: [0, 0, 0] }, datums: [{ id: "hole", origin: [0, 0, 0], axis: [0, 0, 1] }] }
    ],
    constraints: [{ id: "mate", type: "coincident", from: { partId: "base", datumId: "pin" }, to: { partId: "arm", datumId: "hole" } }]
  });
  assert.ok(report.errors.some((item) => item.code === "CONSTRAINT_RESIDUAL" && item.constraintId === "mate"));
});


test("detects conflicting distances and inconsistent gear loops", () => {
  const distancePlan = {
    parts: [{ id: "a" }, { id: "b" }],
    constraints: [
      { id: "d1", type: "distance", from: { partId: "a" }, to: { partId: "b" }, axis: [1, 0, 0], value: 10 },
      { id: "d2", type: "distance", from: { partId: "a" }, to: { partId: "b" }, axis: [1, 0, 0], value: 12 }
    ]
  };
  assert.match(analyzeAssemblyConstraints(distancePlan).errors[0].code, /CONFLICTING_DISTANCE/);

  const gearPlan = {
    parts: [{ id: "a" }, { id: "b" }, { id: "c" }],
    constraints: [
      { id: "g1", type: "gear", from: { partId: "a" }, to: { partId: "b" }, ratio: 2 },
      { id: "g2", type: "gear", from: { partId: "b" }, to: { partId: "c" }, ratio: 3 },
      { id: "g3", type: "gear", from: { partId: "a" }, to: { partId: "c" }, ratio: 5 }
    ]
  };
  assert.ok(analyzeAssemblyConstraints(gearPlan).errors.some((item) => item.code === "GEAR_RATIO_CONFLICT"));
});


test("maps normalized constraints to FreeCAD-oriented manifest entries", () => {
  const entry = constraintToFreeCadManifest({
    id: "slide", type: "slider", from: { partId: "base" }, to: { partId: "carriage" },
    axis: [1, 0, 0], limit: { lower: 0, upper: 50 }
  });
  assert.equal(entry.freecadJointType, "Slider");
  assert.equal(entry.from.part, "base");
  assert.equal(entry.to.part, "carriage");
  assert.deepEqual(entry.connector1.axis, [1, 0, 0]);
  assert.equal(constraintToFreeCadManifest({ id: "gear", type: "gear", from: { partId: "a" }, to: { partId: "b" }, axis: [0, 0, 1], ratio: 2 }).freecadJointType, "Gears");
  assert.equal(constraintToFreeCadManifest({ id: "axis", type: "concentric", from: { partId: "a" }, to: { partId: "b" }, axis: [0, 0, 1] }).freecadJointType, "Cylindrical");
  assert.equal(constraintToFreeCadManifest({ id: "point", type: "coincident", from: { partId: "a" }, to: { partId: "b" } }).freecadJointType, "Ball");
});
