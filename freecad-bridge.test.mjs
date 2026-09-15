import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAssemblyConstraintManifest,
  buildPackageMates,
  renderFreeCadOpenScript,
} from "./freecad-bridge.js";

test("normalizes relation and joint mates for FreeCAD bridge input", () => {
  const parts = [{ id: "base" }, { id: "arm" }];
  const relations = [{ type: "mate", from: "base", to: "arm", description: "base mates to arm" }];
  const joints = [{ id: "arm_hinge", type: "revolute" }];
  const effectiveJoints = [{
    id: "arm_hinge",
    type: "revolute",
    parent: "base",
    child: "arm",
    origin: { xyz: [0.01, 0, 0.02], rpy: [0, 0, 0] },
    axis: [0, 0, 1],
    limit: { lower: -1, upper: 1, effort: 2, velocity: 3 }
  }];

  const mates = buildPackageMates({ parts, relations, joints, effectiveJoints });

  assert.equal(mates.length, 2);
  assert.equal(mates[0].id, "relation-1-base-arm");
  assert.equal(mates[0].valid, true);
  assert.equal(mates[1].id, "joint-1-arm_hinge");
  assert.equal(mates[1].source, "joint");
  assert.deepEqual(mates[1].origin.xyz, [0.01, 0, 0.02]);
  assert.deepEqual(mates[1].axis, [0, 0, 1]);
});

test("renders FreeCAD script that imports parts and creates mate metadata", () => {
  const script = renderFreeCadOpenScript();

  assert.match(script, /assembly-kinematics\.json/);
  assert.match(script, /assembly-constraints\.json/);
  assert.match(script, /Assembly::AssemblyObject/);
  assert.match(script, /Assembly::JointGroup/);
  assert.match(script, /JointObject\.Joint/);
  assert.match(script, /JointObject\.GroundedJoint/);
  assert.match(script, /Unsupported FreeCAD joint type/);
  assert.match(script, /\.Name \+ "\.Face1"/);
  assert.match(script, /\.Name \+ "\.Vertex1"/);
  assert.match(script, /AI_CAD_PartMeta_/);
  assert.match(script, /AI_CAD_Mate_/);
  assert.match(script, /MatesJson/);
  assert.match(script, /doc\.saveAs\(OUT_FILE\)/);
});

test("renders FreeCAD script with one editable container per logical part", () => {
  const script = renderFreeCadOpenScript();

  assert.match(script, /AI_CAD_Complete_Assembly_REFERENCE/);
  assert.match(script, /part_visible_count = 0/);
  assert.match(script, /doc\.addObject\("App::Part", "AI_CAD_Part_" \+ label\)/);
  assert.match(script, /container\.newObject\("Part::Feature", "Geometry"\)/);
  assert.match(script, /part\.get\("localStepFile"\) or part\.get\("placedStepFile"\)/);
  assert.match(script, /geometry\.Shape = Part\.makeCompound\(shapes\)/);
  assert.match(script, /container\.Placement = placement_from_pose/);
  assert.match(script, /doc\.removeObject\(obj\.Name\)/);
  assert.match(script, /add_json_prop\(container, "CadQueryFeatureJson"/);
  assert.match(script, /"featureTree": part\.get\("featureTree", \[\]\)/);
  assert.match(script, /add_json_prop\(container, "ParametricFeatureTreeJson", part\.get\("featureTree", \[\]\)\)/);
  assert.match(script, /add_string_prop\(container, "RevisionId", part\.get\("revisionId", ""\)\)/);
  assert.match(script, /imported_by_part\[part\.get\("id", ""\)\] = \[container, geometry\]/);
  assert.match(script, /part_visible_count \+= 1/);
  assert.match(script, /set_visibility\(assembly_objs, False\)/);
  assert.doesNotMatch(script, /add_to_group\(reference_group, assembly_objs\)/);
  assert.match(script, /if part_visible_count == 0:/);
});

test("builds a FreeCAD-oriented assembly constraint manifest without code", () => {
  const manifest = buildAssemblyConstraintManifest({
    assemblyName: "Arm",
    parts: [{ id: "base" }, { id: "arm" }],
    relations: [{ type: "align", from: "base", to: "arm", description: "align axes" }],
    joints: [{
      id: "arm_hinge",
      type: "revolute",
      parent: "base",
      child: "arm",
      origin: { xyz: [0.01, 0, 0.02], rpy: [0, 0, 0] },
      axis: [0, 0, 1],
      limit: { lower: -1, upper: 1 },
    }],
    effectiveJoints: [{
      id: "arm_hinge",
      type: "revolute",
      parent: "base",
      child: "arm",
      origin: { xyz: [0.01, 0, 0.02], rpy: [0, 0, 0] },
      axis: [0, 0, 1],
      limit: { lower: -1, upper: 1 },
    }],
  });

  assert.equal(manifest.format, "ai-cad-assembly-constraints-v1");
  assert.equal(manifest.assembly.name, "Arm");
  assert.equal(manifest.constraints[0].freecadJointType, "Revolute");
  assert.equal(manifest.constraints[0].from.part, "base");
  assert.equal(manifest.constraints[0].to.part, "arm");
  assert.deepEqual(manifest.constraints[0].connector1.originMm, [10, 0, 20]);
  assert.equal(manifest.constraints[1].source, "relation");
  assert.equal("code" in manifest.constraints[0], false);
});

test("adds normalized parametric constraints to the FreeCAD manifest", () => {
  const manifest = buildAssemblyConstraintManifest({
    assemblyName: "Slider",
    parts: [{ id: "base" }, { id: "carriage" }],
    constraints: [{
      id: "rail-slide",
      type: "slider",
      from: { partId: "base" },
      to: { partId: "carriage" },
      axis: [1, 0, 0],
      limit: { lower: 0, upper: 50 }
    }],
    relations: [],
    joints: [],
    effectiveJoints: []
  });

  assert.equal(manifest.constraints.length, 1);
  assert.equal(manifest.constraints[0].source, "constraint");
  assert.equal(manifest.constraints[0].freecadJointType, "Slider");
  assert.equal(manifest.constraints[0].from.part, "base");
  assert.equal(manifest.constraints[0].to.part, "carriage");
});
