import test from "node:test";
import assert from "node:assert/strict";

import {
  extractStandardPartRequests,
  formatCadReferenceContextForPrompt,
  rankCadQueryTemplates,
  buildCadReferenceContext
} from "./cad-reference-context.js";

test("extracts step.parts standard part requests from conversation text", () => {
  const requests = extractStandardPartRequests("做一个带 608ZZ 轴承和 M3x12 螺钉的滑轮支架", {
    messages: [{ role: "user", content: "之前用 2020 铝型材" }]
  });

  assert.deepEqual(requests.slice(0, 2).map((item) => item.query), [
    "608ZZ bearing",
    "M3x12 screw"
  ]);
  assert.equal(requests[0].provider, "step.parts");
});

test("ranks local CadQuery templates by current request tokens", () => {
  const templates = rankCadQueryTemplates("做一个带轴承孔的连杆支架", [
    {
      name: "PCB 外壳",
      comment: "盒子和安装柱",
      plan: { parts: [{ id: "box", name: "外壳", role: "PCB enclosure" }] },
      pythonPath: "/examples/box.py",
      pythonExcerpt: "cq.Workplane('XY').box(80, 40, 20)"
    },
    {
      name: "轴承连杆支架",
      comment: "连杆、轴承孔、圆角支架",
      plan: { parts: [{ id: "link", name: "连杆", role: "bearing link bracket" }] },
      pythonPath: "/examples/link.py",
      pythonExcerpt: "cq.Workplane('XY').slot2D(40, 8).extrude(4)"
    }
  ]);

  assert.equal(templates[0].name, "轴承连杆支架");
  assert.equal(templates[0].pythonFile, "/examples/link.py");
  assert.match(templates[0].pythonExcerpt, /slot2D/);
});

test("builds CAD reference context while web search is disabled", async () => {
  const context = await buildCadReferenceContext({
    message: "需要 608ZZ 轴承支架",
    conversation: { messages: [] },
    loadExcellentExamples: async () => [],
    loadCadLatentSamples: async () => [{
      id: "latent-bearing-bracket",
      name: "bearing bracket",
      quality: { score: 100, cadqueryBuilt: true, freecadVisible: true, failedConstraintCount: 0 },
      structure: { partCount: 1, featureTypes: { hole: 2 } },
      tokens: ["zh:轴承", "zh:支架", "feature:hole"]
    }],
    searchStepParts: async (request) => ({
      id: "bearing_608zz",
      name: "608ZZ bearing",
      category: "bearing",
      standard: "",
      attributes: { bore1Mm: 8, outerDiameterMm: 22 },
      pageUrl: "https://www.step.parts/parts/bearing_608zz",
      apiUrl: "https://api.step.parts/v1/parts/bearing_608zz"
    })
  });

  assert.equal(context.enabled, true);
  assert.equal(context.standardPartCandidates[0].id, "bearing_608zz");
  assert.equal(context.standardPartCandidates[0].request.query, "608ZZ bearing");
  assert.equal(context.cadLatentMemory[0].id, "latent-bearing-bracket");
  assert.match(formatCadReferenceContextForPrompt(context), /CAD latent memory/);
});
