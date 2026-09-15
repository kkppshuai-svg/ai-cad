import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseExplorerPreviewFile,
  isPathInside,
  parseExplorerUrl
} from "./cad-explorer-link.js";

test("chooses assembly STL before STEP because raw STEP needs a generated GLB artifact", () => {
  const file = chooseExplorerPreviewFile({
    stepPath: "/tmp/assembly.step",
    stlPath: "/tmp/assembly.stl",
    parts: []
  });

  assert.equal(file, "/tmp/assembly.stl");
});

test("chooses selected part STL before STEP because raw STEP needs a generated GLB artifact", () => {
  const file = chooseExplorerPreviewFile({
    stepPath: "/tmp/assembly.step",
    stlPath: "/tmp/assembly.stl",
    parts: [{
      id: "bearing",
      stepPath: "/tmp/bearing.step",
      stlPath: "/tmp/bearing.stl"
    }]
  }, { partId: "bearing" });

  assert.equal(file, "/tmp/bearing.stl");
});

test("falls back to selected part STEP when no STL is available", () => {
  const file = chooseExplorerPreviewFile({
    stepPath: "/tmp/assembly.step",
    parts: [{ id: "part_a", stepPath: "/tmp/part_a.step" }]
  }, { partId: "part_a" });

  assert.equal(file, "/tmp/part_a.step");
});

test("parses Explorer URL from dev:ensure output", () => {
  assert.equal(
    parseExplorerUrl("CAD Explorer ready: http://127.0.0.1:5174/?file=assemblies/a.step\n"),
    "http://127.0.0.1:5174/?file=assemblies/a.step"
  );
});

test("checks Explorer preview files stay inside assembly output directory", () => {
  assert.equal(isPathInside("/tmp/aicad/assembly/a.step", "/tmp/aicad/assembly"), true);
  assert.equal(isPathInside("/tmp/aicad/assembly/nested/part.step", "/tmp/aicad/assembly"), true);
  assert.equal(isPathInside("/tmp/aicad/other/a.step", "/tmp/aicad/assembly"), false);
});
