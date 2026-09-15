import test from "node:test";
import assert from "node:assert/strict";
import { buildAssemblyPlannerInstruction } from "./prompt-contract.js";

test("planner prompt prioritizes stable part geometry and keeps assembly fields secondary", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "做一个带铰链的支架",
    searchContext: null,
    excellentCadqueryContext: "No examples",
  });

  assert.match(prompt, /CadQuery only generates part geometry/i);
  assert.match(prompt, /Part-model accuracy and build stability are the primary goals/i);
  assert.match(prompt, /Keep them empty for ordinary single-part modeling/i);
  assert.match(prompt, /Prefer one accurate, stable part/i);
  assert.match(prompt, /Do not write FreeCAD constraint code/i);
  assert.match(prompt, /Do not write .*addMate/i);
  assert.match(prompt, /CAD latent memory and the VAE learn reusable part structure/i);
  assert.match(prompt, /not STEP\/STL mesh files/i);
  assert.match(prompt, /"relations"/);
  assert.match(prompt, /"joints"/);
  assert.match(prompt, /PART_INTERFERENCE/);
  assert.match(prompt, /world-space partBounds and overlapBounds/i);
  assert.match(prompt, /does not merely transfer the collision elsewhere/i);
  assert.match(prompt, /Every measurable FBS acceptance condition must map to a stable part\.measurements entry/i);
  assert.match(prompt, /acceptanceChecks/);
});

test("planner prompt keeps the current request authoritative over FBS hypotheses", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [], fbs: { requirements: "做一个支架", functions: [{ label: "支撑" }], behaviors: [{ label: "传递载荷" }], structures: [{ label: "参数化支架" }] } },
    message: "做一个带散热鳍片的铝制外壳，尺寸 80x50x20 mm",
    searchContext: null,
    excellentCadqueryContext: "No examples"
  });
  assert.match(prompt, /current user message is the authoritative design intent/i);
  assert.match(prompt, /Approved FBS decision summary/i);
  assert.match(prompt, /FBS trace has already been analyzed and archived/i);
  assert.match(prompt, /Do not regenerate or expand functions, behaviors, or structures/i);
  assert.doesNotMatch(prompt, /Complete FBS trace data/);
});

test("planner prompt uses step.parts standard part mode for off-the-shelf hardware", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "加一个 608ZZ 轴承和 M3x12 内六角螺钉",
    searchContext: null,
    excellentCadqueryContext: "No examples",
  });

  assert.match(prompt, /"mode": "standard_part"/);
  assert.match(prompt, /"standardPart"/);
  assert.match(prompt, /step\.parts/);
  assert.match(prompt, /Do not invent exact standard part dimensions/i);
});

test("planner prompt includes CAD-specific reference context separately from web search", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "做一个 608ZZ 轴承连杆",
    searchContext: { enabled: false },
    excellentCadqueryContext: "legacy examples",
    cadReferenceContext: {
      enabled: true,
      standardPartCandidates: [{
        request: { provider: "step.parts", query: "608ZZ bearing" },
        id: "bearing_608zz",
        name: "608ZZ bearing"
      }],
      localCadqueryTemplates: [{
        name: "轴承连杆模板",
        pythonFile: "/examples/link.py",
        pythonExcerpt: "cq.Workplane('XY').slot2D(40, 8).extrude(4)"
      }],
      cadLatentMemory: [{
        id: "latent-1",
        name: "bearing_link",
        geometryPolicy: {
          learnedRepresentation: "CAD structure JSON",
          learnsGeometryFiles: false,
          usesStepStlFcstdAsEvidenceOnly: true
        },
        structure: { partCount: 2 },
        tokens: ["feature:hole"]
      }]
    }
  });

  assert.match(prompt, /Standard part candidates/i);
  assert.match(prompt, /bearing_608zz/);
  assert.match(prompt, /Local CadQuery template matches/i);
  assert.match(prompt, /轴承连杆模板/);
  assert.match(prompt, /Use local CadQuery templates only for modeling patterns/i);
  assert.match(prompt, /cadLatentMemory/i);
  assert.match(prompt, /usesStepStlFcstdAsEvidenceOnly/i);
});

test("planner prompt describes attached reference images", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "照着这张图片建模",
    searchContext: null,
    excellentCadqueryContext: "No examples",
    imageAttachments: [{ name: "bracket.jpg" }, { name: "side-view.png" }]
  });

  assert.match(prompt, /attached 2 reference image/i);
  assert.match(prompt, /bracket\.jpg/);
  assert.match(prompt, /side-view\.png/);
  assert.match(prompt, /Estimate dimensions in millimeters/i);
  assert.match(prompt, /text message always overrides/i);
});

test("planner prompt reports no reference images when none attached", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "做一个支架",
    searchContext: null,
    excellentCadqueryContext: "No examples",
  });

  assert.match(prompt, /No reference images\./);
});

test("planner prompt requires canonical scalar dimension nodes", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "做一个四孔电机支架",
    searchContext: null,
    excellentCadqueryContext: "No examples"
  });

  assert.match(prompt, /"type": "dimension"/);
  assert.match(prompt, /"params": \{ "name": "motorPitch", "value": 47\.14 \}/);
  assert.match(prompt, /one dimension node per scalar/i);
});

test("planner prompt models Type-C enclosure openings as editable rounded rectangles", () => {
  const creationPrompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "外壳后面加一个tpyeC接口",
    searchContext: null,
    excellentCadqueryContext: "No examples"
  });
  const editPrompt = buildAssemblyPlannerInstruction({
    conversation: {
      currentRevision: "rev-0002",
      plan: { parts: [{ id: "case", featureTree: [{ id: "case.usbc.01", type: "slot", name: "USB-C接口" }] }] },
      messages: []
    },
    message: "接口不是tpyeC"
  });

  for (const prompt of [creationPrompt, editPrompt]) {
    assert.match(prompt, /tpyeC/i);
    assert.match(prompt, /rounded_rectangle/i);
    assert.match(prompt, /wall.normal|wall normal/i);
    assert.match(prompt, /not as slot|generic slot/i);
  }
  assert.match(editPrompt, /shape correction/i);
});

test("planner prompt uses visible connected ellipsoid construction for cartoon characters", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "做一个哆啦A梦卡通模型",
    searchContext: null,
    excellentCadqueryContext: "No examples"
  });

  assert.match(prompt, /cartoon characters.*character-specific construction/is);
  assert.match(prompt, /ellipsoids.*head.*torso.*eyes.*feet/is);
  assert.match(prompt, /-Y as the visible front/i);
  assert.match(prompt, /never place them inside the head or face ellipsoid/i);
  assert.match(prompt, /one connected solid/i);
  assert.match(prompt, /primitive\.pose\.translate/i);
});

test("full-plan prompt requires complete pattern source fields", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "做一个带四孔阵列的电机支架",
    searchContext: null,
    excellentCadqueryContext: "No examples"
  });

  assert.match(prompt, /dependsOn.*sourceFeatureId/is);
  assert.match(prompt, /params\.sourceFeatureId/i);
  assert.match(prompt, /linear_pattern.*count.*spacing/is);
  assert.match(prompt, /circular_pattern.*count.*angle/is);
});

test("planner prompt gives finish features type-specific parameter rules", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "做一个带倒角的电机支架",
    searchContext: null,
    excellentCadqueryContext: "No examples"
  });

  assert.match(prompt, /fillet.*params\.radius.*positive/is);
  assert.match(prompt, /chamfer.*params\.distance.*positive/is);
  assert.match(prompt, /fillet.*chamfer.*must not include.*size.*dimensions/is);
  assert.match(prompt, /finish.*selector.*axis_position.*legacy_all_edges/is);
  assert.match(prompt, /do not use.*kind.*feature.*finish/is);
});

test("planner prompt permits exactly one base feature per generated part", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { plan: null, messages: [] },
    message: "做一个L型电机支架",
    searchContext: null,
    excellentCadqueryContext: "No examples"
  });

  assert.match(prompt, /exactly one base_\* feature per generated part/i);
  assert.match(prompt, /additional solid.*add_primitive.*add_extrude/is);
  assert.match(prompt, /never emit.*base\.02/is);
  assert.match(prompt, /does not support a primitive\.positions array/i);
  assert.match(prompt, /repeated geometry.*linear_pattern.*circular_pattern/is);
});

test("planner prompt requires stable feature trees and local edit patches", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: {
      currentRevision: "rev-0004",
      activePartId: "left_bracket",
      activeFeatureId: "left_bracket.hole.03",
      plan: {
        parts: [{ id: "left_bracket", featureTree: [{ id: "left_bracket.hole.03", name: "第三个孔", type: "hole", params: { diameter: 6 } }] }]
      },
      validationReport: { issues: [{ code: "FINISH_FEATURE_FAILED", featureId: "left_bracket.fillet.01" }] },
      messages: []
    },
    message: "把第三个孔改成 8 mm",
    searchContext: null,
    excellentCadqueryContext: "No examples"
  });

  assert.match(prompt, /"featureTree"/);
  assert.match(prompt, /stable feature ID/i);
  assert.match(prompt, /"editPatch"/);
  assert.match(prompt, /"baseRevision": "rev-0004"/);
  assert.match(prompt, /set_param/);
  assert.match(prompt, /Do not regenerate the whole plan/i);
  assert.match(prompt, /ambiguous.*candidates/i);
  assert.match(prompt, /activeFeatureId/i);
  assert.match(prompt, /FINISH_FEATURE_FAILED/);
  assert.match(prompt, /never silently change functional dimensions/i);
  assert.match(prompt, /"op": "add_feature"[\s\S]*"feature": \{/);
  assert.match(prompt, /add_feature.*must place.*feature.*operation\.feature/is);
  assert.match(prompt, /set_part_pose operation example/i);
  assert.match(prompt, /complete pose under operation\.pose/i);
});

test("planner prompt forbids duplicating world placement inside base geometry", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { messages: [] },
    message: "做一个四轮小车"
  });

  assert.match(prompt, /Apply world placement exactly once in part\.pose/i);
  assert.match(prompt, /never duplicate part\.pose inside a primitive or base_\* feature/i);
});

test("planner prompt uses executable gear references and stable tooth construction", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: { messages: [] },
    message: "做一对啮合齿轮"
  });

  assert.match(prompt, /Do not invent datumId values/i);
  assert.match(prompt, /gear axes.*center-hole featureId/i);
  assert.match(prompt, /use one base_spur_gear/i);
  assert.match(prompt, /do not construct gear teeth with add_extrude, add_primitive, or circular_pattern/i);
  assert.match(prompt, /center distance module \* \(z1 \+ z2\) \/ 2/i);
  assert.match(prompt, /rotate the right gear by exactly 180 \/ z_right degrees/i);
});

test("existing revisions use a materially shorter local-edit prompt contract", () => {
  const plan = {
    name: "bearing fixture",
    parts: [{
      id: "left_bracket",
      name: "左支架",
      featureTree: [{
        id: "left_bracket.hole.03",
        name: "第三个安装孔",
        type: "hole",
        params: { diameter: 6 }
      }]
    }],
    constraints: [{ id: "bearing_axis", type: "concentric" }]
  };
  const common = {
    message: "把第三个孔改成 8 mm，其他功能尺寸和零件数量不变",
    searchContext: { results: [{ title: "large web context" }] },
    excellentCadqueryContext: "large example context ".repeat(20),
    cadReferenceContext: { enabled: true, localCadqueryTemplates: [{ name: "fixture" }] }
  };
  const editPrompt = buildAssemblyPlannerInstruction({
    ...common,
    conversation: {
      currentRevision: "rev-0004",
      activePartId: "left_bracket",
      activeFeatureId: "left_bracket.hole.03",
      validationReport: { issues: [{ code: "FINISH_FEATURE_FAILED" }] },
      plan,
      messages: [{ role: "user", content: "先做一个支架" }]
    }
  });
  const creationPrompt = buildAssemblyPlannerInstruction({
    ...common,
    conversation: { currentRevision: null, plan, messages: [] }
  });

  assert.match(editPrompt, /"editPatch"/);
  assert.match(editPrompt, /"ambiguous"/);
  assert.match(editPrompt, /"currentRevision": "rev-0004"/);
  assert.match(editPrompt, /"activePartId": "left_bracket"/);
  assert.match(editPrompt, /"activeFeatureId": "left_bracket\.hole\.03"/);
  assert.match(editPrompt, /FINISH_FEATURE_FAILED/);
  assert.match(editPrompt, /"featureTree"/);
  assert.match(editPrompt, /left_bracket\.hole\.03/);
  assert.match(editPrompt, /把第三个孔改成 8 mm/);
  assert.match(editPrompt, /functional dimensions/i);
  assert.match(editPrompt, /part count/i);
  assert.match(editPrompt, /"op": "add_feature"[\s\S]*"feature": \{/);
  assert.match(editPrompt, /add_feature.*must place.*feature.*operation\.feature/is);
  assert.doesNotMatch(editPrompt, /"primitives": \[/);
  assert.doesNotMatch(editPrompt, /High-score local CadQuery examples/i);
  assert.ok(editPrompt.length < creationPrompt.length * 0.55, `${editPrompt.length} should be materially shorter than ${creationPrompt.length}`);
});

test("existing revision planner is forbidden from spending time on repository tools", () => {
  const instruction = buildAssemblyPlannerInstruction({
    conversation: { currentRevision: "rev-0001", plan: { parts: [] }, messages: [] },
    message: "把孔改成8毫米"
  });
  assert.match(instruction, /do not inspect the repository/i);
  assert.match(instruction, /do not.*run commands.*call tools/i);
});

test("force-full-plan keeps existing revision context while selecting the full-plan contract", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: {
      currentRevision: "rev-0004",
      activePartId: "bracket",
      plan: { name: "motor bracket", parts: [{ id: "bracket", featureTree: [] }] },
      messages: [{ role: "user", content: "Create the original bracket" }]
    },
    message: "Repair bracket.upright.01 profile",
    searchContext: { results: [{ title: "CadQuery rectangle profile" }] },
    excellentCadqueryContext: "fixture example",
    formattedCadReferenceContext: "bearing candidate",
    imageAttachments: [{ name: "bracket.png" }],
    forceFullPlan: true
  });

  assert.match(prompt, /full JSON plan/i);
  assert.doesNotMatch(prompt, /"editPatch"/);
  assert.doesNotMatch(prompt, /reply and editPatch only/i);
  assert.match(prompt, /"currentRevision": "rev-0004"/);
  assert.match(prompt, /"name": "motor bracket"/);
  assert.match(prompt, /Create the original bracket/);
  assert.match(prompt, /CadQuery rectangle profile/);
  assert.match(prompt, /fixture example/);
  assert.match(prompt, /bearing candidate/);
  assert.match(prompt, /bracket\.png/);
});

test("existing-revision prompt still permits full plans for structural changes", () => {
  const prompt = buildAssemblyPlannerInstruction({
    conversation: {
      currentRevision: "rev-0004",
      plan: { parts: [{ id: "base", featureTree: [] }] },
      messages: []
    },
    message: "增加一个独立护罩零件并装配到基座",
    searchContext: null,
    excellentCadqueryContext: ""
  });

  assert.match(prompt, /structural change.*complete updated plan/i);
  assert.match(prompt, /adding or removing parts/i);
});
