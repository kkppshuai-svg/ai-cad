import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("server and frontend no longer expose OpenSCAD product surface", () => {
  const serverJs = readFileSync(new URL("./server.js", import.meta.url), "utf8");
  const appJs = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(serverJs, /openscadBin:\s*publicCommandName\(openscadBin\)/);
  assert.doesNotMatch(appJs, /OpenSCAD 辅助:/);
});
