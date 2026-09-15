import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCadLatentSample,
  rankCadLatentSamples,
  formatCadLatentContextForPrompt,
} from "./cad-latent-memory.js";

test("builds a compact CAD latent sample from a rated assembly", () => {
  const sample = buildCadLatentSample({
    rating: {
      id: "rating-1",
      score: 100,
      comment: "轴承孔和倒角支架可复用",
      savedAt: "2026-06-01T00:00:00.000Z",
      assemblyId: "assembly-1",
    },
    plan: {
      name: "bearing_link_bracket",
      parts: [{
        id: "link",
        name: "轴承连杆",
        role: "bearing link bracket",
        mode: "generated",
        primitives: [{ type: "box" }, { type: "cylinder" }],
        features: [{ type: "hole" }, { type: "fillet" }]
      }],
      relations: [{ type: "mate", from: "link", to: "bearing", description: "轴承孔同轴" }],
      joints: [{ id: "hinge", type: "revolute", parent: "world", child: "link" }]
    },
    assembly: {
      fcstdUrl: "/assemblies/assembly-1/ai_cad_assembly.FCStd",
      stepUrl: "/assemblies/assembly-1/assembly.step",
      freeCadBridgeReport: {
        visiblePartObjectCount: 2,
        failedConstraints: []
      }
    }
  });

  assert.equal(sample.id, "rating-1");
  assert.equal(sample.quality.score, 100);
  assert.equal(sample.quality.cadqueryBuilt, true);
  assert.equal(sample.quality.freecadVisible, true);
  assert.equal(sample.quality.failedConstraintCount, 0);
  assert.deepEqual(sample.geometryPolicy, {
    learnedRepresentation: "CAD structure JSON",
    learnsGeometryFiles: false,
    usesStepStlFcstdAsEvidenceOnly: true,
  });
  assert.deepEqual(sample.structure.partCount, 1);
  assert.ok(sample.tokens.includes("feature:hole"));
  assert.ok(sample.tokens.includes("joint:revolute"));
  assert.ok(sample.tokens.includes("zh:轴承"));
  assert.doesNotMatch(sample.tokens.join(" "), /\.step|\.stl|\.FCStd|assembly\.step|ai_cad_assembly/i);
});

test("marks automatic training-loop passes without pretending they are human excellent ratings", () => {
  const sample = buildCadLatentSample({
    rating: { id: "training:loop-1", score: 50, trainingVerified: true, retainedForLearning: false },
    plan: { name: "trained bracket", parts: [{ id: "bracket", role: "安装支架", primitives: [{ type: "box" }], features: [{ type: "hole" }] }] },
    assembly: { status: "done", stepUrl: "/assembly.step" }
  });

  assert.equal(sample.quality.trainingVerified, true);
  assert.equal(sample.quality.retainedForLearning, false);
  assert.ok(sample.tokens.includes("quality:visual-loop-pass"));
  assert.ok(!sample.tokens.includes("quality:excellent"));
});

test("ranks CAD latent samples by request similarity and quality", () => {
  const samples = [
    buildCadLatentSample({
      rating: { id: "bad-tire", score: 0, comment: "失败", assemblyId: "a0" },
      plan: { name: "tire", parts: [{ id: "tire", name: "轮胎", role: "tire", primitives: [], features: [] }] },
      assembly: { stepUrl: null, freeCadBridgeReport: { visiblePartObjectCount: 0, failedConstraints: [{ id: "bad" }] } }
    }),
    buildCadLatentSample({
      rating: { id: "good-servo", score: 100, comment: "舵机支架孔位清楚", assemblyId: "a1" },
      plan: {
        name: "servo_mount",
        parts: [{ id: "bracket", name: "舵机支架", role: "servo bracket", primitives: [{ type: "box" }], features: [{ type: "hole" }, { type: "fillet" }] }],
        relations: [],
        joints: []
      },
      assembly: { stepUrl: "/a.step", freeCadBridgeReport: { visiblePartObjectCount: 1, failedConstraints: [] } }
    })
  ];

  const ranked = rankCadLatentSamples("做一个带安装孔的舵机支架", samples);

  assert.equal(ranked[0].id, "good-servo");
  assert.equal(ranked[0].quality.score, 100);
  assert.ok(ranked[0].similarity > 0);
});

test("ranks weeding brush radial bristle memory above unrelated excellent samples", () => {
  const samples = [
    buildCadLatentSample({
      rating: { id: "excellent-die", score: 100, comment: "孔位清楚", assemblyId: "a-die" },
      plan: {
        name: "simple_die",
        parts: [{ id: "die", name: "骰子", role: "cube with drilled pips", primitives: [{ type: "box" }], features: [{ type: "hole" }] }],
        relations: [],
        joints: []
      },
      assembly: { stepUrl: "/die.step", freeCadBridgeReport: { visiblePartObjectCount: 1, failedConstraints: [] } }
    }),
    buildCadLatentSample({
      rating: { id: "excellent-weeding-brush", score: 100, comment: "150mm主轴，10列圆形阵列刷毛", assemblyId: "a-brush" },
      plan: {
        name: "weeding_brush_150mm_radial_array",
        parts: [
          { id: "shaft", name: "150mm主刷轴", role: "central shaft along X axis", primitives: [{ type: "cylinder" }], features: [{ type: "hole" }] },
          { id: "bristles", name: "刷毛阵列", role: "10 columns of radial bristles around shaft", primitives: [{ type: "cylinder" }], features: [] }
        ],
        relations: [{ type: "reference", from: "shaft", to: "bristles", description: "圆形阵列径向刷毛" }],
        joints: [{ id: "fixed", type: "fixed", parent: "shaft", child: "bristles" }]
      },
      assembly: { stepUrl: "/brush.step", freeCadBridgeReport: { visiblePartObjectCount: 2, failedConstraints: [] } }
    })
  ];

  const ranked = rankCadLatentSamples("做一个150mm除草刷，10列圆形阵列刷毛", samples);

  assert.equal(ranked[0].id, "excellent-weeding-brush");
  assert.ok(ranked[0].tokens.includes("concept:weeding-brush"));
  assert.ok(ranked[0].tokens.includes("component:bristle"));
  assert.ok(ranked[0].tokens.includes("pattern:radial-array"));
});

test("formats CAD latent memory for planner prompt", () => {
  const sample = buildCadLatentSample({
    rating: { id: "good-box", score: 100, comment: "盒子壁厚和安装柱可复用", assemblyId: "a2" },
    plan: {
      name: "electronics_case",
      parts: [{ id: "case", name: "电子外壳", role: "electronics enclosure", primitives: [{ type: "box" }], features: [{ type: "hole" }] }],
      relations: [],
      joints: []
    },
    assembly: { stepUrl: "/a.step", freeCadBridgeReport: { visiblePartObjectCount: 1, failedConstraints: [] } }
  });

  const prompt = formatCadLatentContextForPrompt({ samples: [sample] });

  assert.match(prompt, /CAD latent memory/);
  assert.match(prompt, /learns CAD structure JSON, not STEP\/STL\/FCStd/i);
  assert.match(prompt, /uses STEP\/STL\/FCStd only as build evidence/i);
  assert.match(prompt, /electronics_case/);
  assert.match(prompt, /feature:hole/);
  assert.doesNotMatch(prompt, /excellent_cadquery.py/);
  assert.doesNotMatch(prompt, /\.step|\.stl|\.FCStd|\/a\.step/i);
});
