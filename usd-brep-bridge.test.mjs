import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUsdBrepBridge } from "./usd-brep-bridge.js";

test("unconfigured and broken USD environments remain optional", async () => {
  const disabled = createUsdBrepBridge({ rootDir: ".", runProcess: () => assert.fail() });
  assert.equal((await disabled.status()).available, false);
  await assert.rejects(disabled.exportMesh({}), { status: 503 });
  const broken = createUsdBrepBridge({ python: "missing", rootDir: ".", runProcess: async () => { throw Error("missing"); } });
  assert.equal((await broken.status()).available, false);
});

test("export only accepts server-owned STL paths and passes spaced interpreter paths as one argument", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicad-usd-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assembly = path.join(root, "assembly");
  await mkdir(assembly);
  const source = path.join(assembly, "source.stl");
  const outside = path.join(root, "outside.stl");
  await writeFile(source, "solid mesh");
  await writeFile(outside, "solid outside");
  const calls = [];
  const bridge = createUsdBrepBridge({ python: "C:/Program Files/python.exe", rootDir: root,
    runProcess: async (...args) => { calls.push(args); return { stdout: '{"roundTrip":"passed","representation":"mesh"}', stderr: "" }; } });
  const output = path.join(assembly, "model.usda");
  await assert.rejects(bridge.exportMesh({ source: outside, output, outputDir: assembly }), { status: 400 });
  await assert.rejects(bridge.exportMesh({ source, output: path.join(root, "escape.usda"), outputDir: assembly }), { status: 400 });
  assert.equal(calls.length, 0);
  const result = await bridge.exportMesh({ source, output, outputDir: assembly });
  assert.equal(result.roundTrip, "passed");
  assert.equal(result.representation, "mesh");
  assert.equal(calls[0][0], "C:/Program Files/python.exe");
  assert.equal(calls[0][1][1], "--input");
});
