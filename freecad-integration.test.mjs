import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAssemblyConstraintManifest, renderFreeCadOpenScript } from "./freecad-bridge.js";

const freecadCmd = process.env.AICAD_FREECAD_CMD || "freecadcmd";
const cadqueryPython = process.env.AICAD_CADQUERY_PYTHON || path.resolve(".venv-cadquery/bin/python");
let prerequisites = true;
try {
  accessSync(cadqueryPython);
  execFileSync(freecadCmd, ["--version"], { stdio: "ignore" });
} catch {
  prerequisites = false;
}

test("FreeCAD bridge creates reopenable logical parts and live constraints", { skip: prerequisites ? false : "FreeCADCmd/CadQuery unavailable" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-freecad-integration-"));
  const generator = [
    "import cadquery as cq",
    `root = ${JSON.stringify(root)}`,
    "left = cq.Workplane('XY').box(20, 20, 6)",
    "right = cq.Workplane('XY').box(20, 20, 6)",
    "cq.exporters.export(left, root + '/left.step')",
    "cq.exporters.export(right, root + '/right.step')",
    "assembly = cq.Assembly(name='Integration')",
    "assembly.add(left, name='left')",
    "assembly.add(right, name='right', loc=cq.Location((30, 0, 0)))",
    "assembly.save(root + '/assembly.step')",
    "assembly.save(root + '/freecad_assembly.step')"
  ].join("\n");
  execFileSync(cadqueryPython, ["-c", generator], { cwd: root, stdio: "pipe" });

  const parts = [
    { id: "left", name: "Left", revisionId: "rev-0002", pose: { translate: [0, 0, 0], rotate: [0, 0, 0] }, localStepFile: "left.step", featureTree: [{ id: "left.base.01", type: "base_box", params: { size: [20, 20, 6] } }] },
    { id: "right", name: "Right", revisionId: "rev-0002", pose: { translate: [30, 0, 0], rotate: [0, 0, 0] }, localStepFile: "right.step", featureTree: [{ id: "right.base.01", type: "base_box", params: { size: [20, 20, 6] } }] }
  ];
  const constraints = buildAssemblyConstraintManifest({
    assemblyName: "Integration",
    parts,
    relations: [], joints: [], effectiveJoints: [],
    constraints: [
      { id: "fix-left", type: "fixed", to: { partId: "left" } },
      { id: "slide-right", type: "slider", from: { partId: "left" }, to: { partId: "right" }, axis: [1, 0, 0], limit: { lower: 0, upper: 50 } },
      { id: "point-mate", type: "coincident", from: { partId: "left" }, to: { partId: "right" } },
      { id: "axis-mate", type: "concentric", from: { partId: "left" }, to: { partId: "right" }, axis: [0, 0, 1] },
      { id: "gear-pair", type: "gear", from: { partId: "left" }, to: { partId: "right" }, axis: [0, 0, 1], ratio: -2 }
    ]
  });
  await writeFile(path.join(root, "assembly-kinematics.json"), `${JSON.stringify({ format: "ai-cad-kinematics-v2", assembly: { name: "Integration", units: { cad: "mm" } }, parts, relations: [], joints: [], mates: [], audit: {} }, null, 2)}\n`);
  await writeFile(path.join(root, "assembly-constraints.json"), `${JSON.stringify(constraints, null, 2)}\n`);
  const bridgeScript = renderFreeCadOpenScript();
  await writeFile(path.join(root, "open_in_freecad.py"), bridgeScript);
  execFileSync(freecadCmd, ["-c"], { cwd: root, input: "import os; globals()['__file__']=os.path.abspath('open_in_freecad.py'); exec(open('open_in_freecad.py', encoding='utf-8').read())\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  accessSync(path.join(root, "ai_cad_assembly.FCStd"));

  const inspector = [
    "import json, FreeCAD as App",
    `doc = App.openDocument(${JSON.stringify(path.join(root, "ai_cad_assembly.FCStd"))})`,
    "parts = [obj for obj in doc.Objects if obj.Name.startswith('AI_CAD_Part_')]",
    "geometries = [child for part in parts for child in getattr(part, 'Group', []) if child.Name.startswith('Geometry')]",
    "ground = doc.getObject('AI_CAD_Joint_fix_left')",
    "slider = doc.getObject('AI_CAD_Joint_slide_right')",
    "joint_types = {name: getattr(doc.getObject(name), 'JointType', '') for name in ['AI_CAD_Joint_slide_right', 'AI_CAD_Joint_point_mate', 'AI_CAD_Joint_axis_mate', 'AI_CAD_Joint_gear_pair']}",
    "payload = {'partCount': len(parts), 'revisionIds': [getattr(obj, 'RevisionId', '') for obj in parts], 'validShapes': all(not obj.Shape.isNull() and obj.Shape.isValid() for obj in geometries), 'grounded': hasattr(ground, 'ObjectToGround'), 'jointTypes': joint_types, 'referenceLengths': [len(slider.Reference1[1]), len(slider.Reference2[1])]}",
    `handle = open(${JSON.stringify(path.join(root, "inspection.json"))}, 'w', encoding='utf-8')`,
    "handle.write(json.dumps(payload))",
    "handle.close()"
  ].join("\n");
  await writeFile(path.join(root, "inspect.py"), inspector);
  execFileSync(freecadCmd, ["-c"], { cwd: root, input: "exec(open('inspect.py', encoding='utf-8').read())\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const payload = JSON.parse(await readFile(path.join(root, "inspection.json"), "utf8"));
  assert.equal(payload.partCount, 2);
  assert.deepEqual(payload.revisionIds, ["rev-0002", "rev-0002"]);
  assert.equal(payload.validShapes, true);
  assert.equal(payload.grounded, true);
  assert.deepEqual(payload.jointTypes, { AI_CAD_Joint_slide_right: "Slider", AI_CAD_Joint_point_mate: "Ball", AI_CAD_Joint_axis_mate: "Cylindrical", AI_CAD_Joint_gear_pair: "Gears" });
  assert.deepEqual(payload.referenceLengths, [2, 2]);
});
