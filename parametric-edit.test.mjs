import test from "node:test";
import assert from "node:assert/strict";

import { checksumParametricPart, normalizeParametricPlan } from "./parametric-plan.js";
import { applyEditPatch, resolveFeatureTarget } from "./parametric-edit.js";


function editablePlan() {
  return normalizeParametricPlan({
    name: "fixture",
    constraints: [{ id: "keep-left", type: "fixed", partId: "left_bracket" }],
    parts: [
      {
        id: "left_bracket",
        name: "左支架",
        pose: { translate: [-30, 0, 0], rotate: [0, 0, 0] },
        featureTree: [
          { id: "left_bracket.base.01", name: "支架板", type: "base_box", params: { size: [60, 20, 6] } },
          { id: "left_bracket.hole.01", name: "第一个安装孔", type: "hole", dependsOn: ["left_bracket.base.01"], params: { diameter: 6, depth: 10, axis: "z", center: [-20, 0, 0] }, selector: { kind: "feature", tags: ["mounting", "index:1"] } },
          { id: "left_bracket.hole.02", name: "第二个安装孔", type: "hole", dependsOn: ["left_bracket.base.01"], params: { diameter: 6, depth: 10, axis: "z", center: [0, 0, 0] }, selector: { kind: "feature", tags: ["mounting", "index:2"] } },
          { id: "left_bracket.hole.03", name: "第三个安装孔", type: "hole", dependsOn: ["left_bracket.base.01"], params: { diameter: 6, depth: 10, axis: "z", center: [20, 0, 0] }, selector: { kind: "feature", tags: ["mounting", "index:3"] } }
        ]
      },
      {
        id: "right_bracket",
        name: "右支架",
        featureTree: [
          { id: "right_bracket.base.01", name: "支架板", type: "base_box", params: { size: [60, 20, 6] } },
          { id: "right_bracket.hole.03", name: "第三个安装孔", type: "hole", dependsOn: ["right_bracket.base.01"], params: { diameter: 6, depth: 10, axis: "z", center: [20, 0, 0] }, selector: { kind: "feature", tags: ["mounting", "index:3"] } }
        ]
      }
    ]
  });
}


test("set_param edits only the requested third hole", () => {
  const plan = editablePlan();
  const rightBefore = checksumParametricPart(plan.parts[1]);
  const result = applyEditPatch(plan, {
    baseRevision: "rev-0001",
    operations: [{
      op: "set_param",
      partId: "left_bracket",
      featureId: "left_bracket.hole.03",
      path: "params.diameter",
      value: 8
    }]
  }, { revisionId: "rev-0001" });

  assert.equal(result.plan.parts[0].featureTree[3].params.diameter, 8);
  assert.equal(result.plan.parts[0].featureTree[1].params.diameter, 6);
  assert.equal(checksumParametricPart(result.plan.parts[1]), rightBefore);
  assert.deepEqual(result.affectedPartIds, ["left_bracket"]);
  assert.equal(result.assemblyArtifactsDirty, true);
  assert.equal(result.diff[0].featureId, "left_bracket.hole.03");
});


test("thickening the left bracket leaves the right bracket checksum unchanged", () => {
  const plan = editablePlan();
  const rightBefore = checksumParametricPart(plan.parts[1]);
  const result = applyEditPatch(plan, {
    baseRevision: "rev-0001",
    operations: [{ op: "set_param", partId: "left_bracket", featureId: "left_bracket.base.01", path: "params.size.2", value: 9 }]
  }, { revisionId: "rev-0001" });

  assert.deepEqual(result.plan.parts[0].featureTree[0].params.size, [60, 20, 9]);
  assert.equal(checksumParametricPart(result.plan.parts[1]), rightBefore);
  assert.deepEqual(result.affectedPartIds, ["left_bracket"]);
});


test("natural target resolution uses active part and reports ambiguity without it", () => {
  const plan = editablePlan();
  const ambiguous = resolveFeatureTarget(plan, { type: "hole", ordinal: 3 });
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.candidates.map((item) => item.featureId), ["left_bracket.hole.03", "right_bracket.hole.03"]);

  const resolved = resolveFeatureTarget(plan, { type: "hole", ordinal: 3, activePartId: "left_bracket" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.featureId, "left_bracket.hole.03");
});


test("rejects stale revisions and invalid patch paths without mutating input", () => {
  const plan = editablePlan();
  const before = structuredClone(plan);
  assert.throws(() => applyEditPatch(plan, {
    baseRevision: "rev-old",
    operations: [{ op: "set_param", partId: "left_bracket", featureId: "left_bracket.hole.03", path: "params.diameter", value: 8 }]
  }, { revisionId: "rev-0001" }), /base revision/i);
  assert.throws(() => applyEditPatch(plan, {
    baseRevision: "rev-0001",
    operations: [{ op: "set_param", partId: "left_bracket", featureId: "left_bracket.hole.03", path: "id", value: "hijack" }]
  }, { revisionId: "rev-0001" }), /path.*params/i);
  assert.deepEqual(plan, before);
});


test("supports feature, pose, and constraint patch operations", () => {
  const plan = editablePlan();
  const result = applyEditPatch(plan, {
    baseRevision: "rev-0001",
    operations: [
      { op: "disable_feature", partId: "left_bracket", featureId: "left_bracket.hole.02" },
      { op: "add_feature", partId: "right_bracket", feature: { id: "right_bracket.chamfer.01", type: "chamfer", dependsOn: ["right_bracket.base.01"], params: { distance: 1 }, selector: { kind: "axis_position", axis: "z", position: 0 } } },
      { op: "set_part_pose", partId: "right_bracket", pose: { translate: [30, 0, 0], rotate: [0, 0, 0] } },
      { op: "set_constraint", constraint: { id: "gap", type: "distance", from: { partId: "left_bracket" }, to: { partId: "right_bracket" }, value: 60 } },
      { op: "remove_constraint", constraintId: "keep-left" }
    ]
  }, { revisionId: "rev-0001" });

  assert.equal(result.plan.parts[0].featureTree[2].enabled, false);
  assert.ok(result.plan.parts[1].featureTree.some((node) => node.id === "right_bracket.chamfer.01"));
  assert.deepEqual(result.plan.parts[1].pose.translate, [30, 0, 0]);
  assert.deepEqual(result.plan.constraints.map((item) => item.id), ["gap"]);
  assert.deepEqual(result.affectedPartIds, ["left_bracket", "right_bracket"]);
});

test("updates an explicit BREP measurement target without changing geometry parameters", () => {
  const plan = editablePlan();
  plan.parts[0].measurements = [{ id: "left.overall_height", kind: "bbox", axis: "z", target: 8, tolerance: 0.1 }];

  const result = applyEditPatch(plan, {
    baseRevision: "rev-0001",
    operations: [{
      op: "set_measurement_target",
      partId: "left_bracket",
      measurementId: "left.overall_height",
      value: 10
    }]
  }, { revisionId: "rev-0001" });

  assert.equal(result.plan.parts[0].measurements[0].target, 10);
  assert.deepEqual(result.affectedPartIds, []);
  assert.deepEqual(result.assemblyAffectedPartIds, ["left_bracket"]);
  assert.equal(result.diff[0].before, 8);
  assert.equal(result.diff[0].after, 10);
});

test("marks an integrated part as requiring one connected solid", () => {
  const result = applyEditPatch(editablePlan(), {
    baseRevision: "rev-0001",
    operations: [{ op: "set_part_property", partId: "left_bracket", path: "requireSingleSolid", value: true }]
  }, { revisionId: "rev-0001" });

  assert.equal(result.plan.parts[0].requireSingleSolid, true);
  assert.deepEqual(result.affectedPartIds, []);
  assert.deepEqual(result.assemblyAffectedPartIds, ["left_bracket"]);
});

test("repairs unambiguous legacy set_part_pose payload shapes without mutating the patch", () => {
  const patch = {
    baseRevision: "rev-0001",
    operations: [
      { op: "set_part_pose", partId: "left_bracket", value: { translate: [-40, 2, 3], rotate: [0, 0, 5] } },
      { op: "set_part_pose", partId: "right_bracket", translate: [40, -2, 3], rotate: [0, 0, -5] }
    ]
  };
  const before = structuredClone(patch);
  const result = applyEditPatch(editablePlan(), patch, { revisionId: "rev-0001" });

  assert.deepEqual(result.plan.parts[0].pose, { translate: [-40, 2, 3], rotate: [0, 0, 5] });
  assert.deepEqual(result.plan.parts[1].pose, { translate: [40, -2, 3], rotate: [0, 0, -5] });
  assert.deepEqual(patch, before);
});

test("set_part_pose still rejects incomplete legacy payloads", () => {
  assert.throws(() => applyEditPatch(editablePlan(), {
    baseRevision: "rev-0001",
    operations: [{ op: "set_part_pose", partId: "right_bracket", translate: [40, 0, 0] }]
  }, { revisionId: "rev-0001" }), /requires pose/i);
});

test("repairs unambiguous legacy add_feature payload shapes without mutating the patch", () => {
  const patch = {
    baseRevision: "rev-0001",
    operations: [
      {
        op: "add_feature",
        partId: "left_bracket",
        id: "left_bracket.hole.04",
        type: "hole",
        dependsOn: ["left_bracket.base.01"],
        params: { diameter: 5, depth: 10, axis: "z", center: [25, 0, 0] },
        selector: { kind: "feature", tags: ["mounting", "index:4"] }
      },
      {
        op: "add_feature",
        partId: "right_bracket",
        value: {
          id: "right_bracket.hole.04",
          type: "hole",
          dependsOn: ["right_bracket.base.01"],
          params: { diameter: 5, depth: 10, axis: "z", center: [25, 0, 0] }
        }
      }
    ]
  };
  const snapshot = structuredClone(patch);

  const result = applyEditPatch(editablePlan(), patch, { revisionId: "rev-0001" });

  assert.ok(result.plan.parts[0].featureTree.some((node) => node.id === "left_bracket.hole.04"));
  assert.ok(result.plan.parts[1].featureTree.some((node) => node.id === "right_bracket.hole.04"));
  assert.deepEqual(patch, snapshot);
});

test("still rejects add_feature operations without a complete typed feature", () => {
  assert.throws(() => applyEditPatch(editablePlan(), {
    baseRevision: "rev-0001",
    operations: [{ op: "add_feature", partId: "left_bracket", params: { diameter: 5 } }]
  }, { revisionId: "rev-0001" }), /add_feature requires feature/i);
});


test("remove_feature rejects removing a node with dependents", () => {
  const plan = editablePlan();
  assert.throws(() => applyEditPatch(plan, {
    baseRevision: "rev-0001",
    operations: [{ op: "remove_feature", partId: "left_bracket", featureId: "left_bracket.base.01" }]
  }, { revisionId: "rev-0001" }), /dependent/i);
});

test("constraint-only edits dirty assembly artifacts without rebuilding local part geometry", () => {
  const result = applyEditPatch(editablePlan(), {
    baseRevision: "rev-0001",
    operations: [{ op: "set_constraint", constraint: { id: "align", type: "coincident", from: { partId: "left_bracket" }, to: { partId: "right_bracket" } } }]
  }, { revisionId: "rev-0001" });
  assert.deepEqual(result.geometryAffectedPartIds, []);
  assert.deepEqual(result.affectedPartIds, []);
  assert.deepEqual(result.assemblyAffectedPartIds, ["left_bracket", "right_bracket"]);
  assert.equal(result.assemblyArtifactsDirty, true);
});
