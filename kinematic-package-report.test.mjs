import test from "node:test";
import assert from "node:assert/strict";
import { buildPackageAudit, formatNumbers, markdownCell, renderMatesMarkdown } from "./kinematic-package-report.js";

function packagedPart(id) {
  return { id, name: id, localStepFile: `parts/local/${id}.step`, placedStepFile: `parts/placed/${id}.step` };
}

const job = { plan: { parts: [{ id: "base" }, { id: "arm" }] }, stepPath: "/missing/assembly.step", stlPath: null };

test("a package containing every planned part with valid links audits clean", () => {
  const audit = buildPackageAudit({
    job,
    packageParts: [packagedPart("base"), packagedPart("arm")],
    relations: [{ type: "mounted_on", from: "arm", to: "base" }],
    joints: [{ id: "j1", type: "revolute", parent: "base", child: "arm" }],
    effectiveJoints: [{ id: "j1" }],
    mates: [{ id: "m1" }]
  });

  assert.equal(audit.ok, true);
  assert.equal(audit.expectedPartCount, 2);
  assert.equal(audit.packagedPartCount, 2);
  assert.equal(audit.relationCount, 1);
  assert.equal(audit.mateCount, 1);
  assert.equal(audit.files.perPartLocalStep, true);
  assert.equal(audit.files.perPartPlacedStep, true);
});

test("a planned part missing from the package fails the audit", () => {
  const audit = buildPackageAudit({ job, packageParts: [packagedPart("base")] });

  assert.equal(audit.ok, false);
  assert.deepEqual(audit.missingParts, ["arm"]);
});

test("a relation pointing at an unpackaged part fails the audit", () => {
  const audit = buildPackageAudit({
    job,
    packageParts: [packagedPart("base"), packagedPart("arm")],
    relations: [{ type: "mounted_on", from: "arm", to: "gripper" }]
  });

  assert.equal(audit.ok, false);
  assert.equal(audit.invalidRelations.length, 1);
  assert.equal(audit.invalidRelations[0].to, "gripper");
});

test("a joint may be parented to world but not to an unpackaged part", () => {
  const grounded = buildPackageAudit({
    job,
    packageParts: [packagedPart("base"), packagedPart("arm")],
    joints: [{ id: "ground", type: "fixed", parent: "world", child: "base" }]
  });
  assert.equal(grounded.ok, true);

  const dangling = buildPackageAudit({
    job,
    packageParts: [packagedPart("base"), packagedPart("arm")],
    joints: [{ id: "j2", type: "fixed", parent: "column", child: "arm" }]
  });
  assert.equal(dangling.ok, false);
  assert.equal(dangling.invalidJoints.length, 1);
});

test("a part with no placed STEP is reported in the file checks", () => {
  const audit = buildPackageAudit({
    job,
    packageParts: [packagedPart("base"), { id: "arm", localStepFile: "parts/local/arm.step", placedStepFile: null }]
  });

  assert.equal(audit.files.perPartLocalStep, true);
  assert.equal(audit.files.perPartPlacedStep, false);
  // Artifact presence is reported, not enforced: ok only tracks consistency.
  assert.equal(audit.ok, true);
});

test("missing artifact paths report false rather than throwing", () => {
  const audit = buildPackageAudit({ job: { plan: { parts: [] } }, packageParts: [] });

  assert.equal(audit.files.assemblyStep, false);
  assert.equal(audit.files.assemblyStl, false);
  assert.equal(audit.ok, true);
});

test("markdownCell escapes pipes and collapses whitespace", () => {
  assert.equal(markdownCell("a|b"), "a\\|b");
  assert.equal(markdownCell("  left \n bracket  "), "left bracket");
  assert.equal(markdownCell(null), "");
  assert.equal(markdownCell(0), "0");
});

test("formatNumbers pads short vectors and rejects non-finite values", () => {
  assert.equal(formatNumbers([1, 2, 3]), "1 2 3");
  assert.equal(formatNumbers([1.5]), "1.5 0 0");
  assert.equal(formatNumbers([Number.NaN, "x", 2]), "0 0 2");
  assert.equal(formatNumbers(undefined), "0 0 0");
});

test("mates markdown renders parts, relations, joints, and the audit block", () => {
  const markdown = renderMatesMarkdown({
    assembly: { name: "bracket" },
    parts: [{ id: "base", name: "底板", localStepFile: "parts/local/base.step", placedStepFile: "parts/placed/base.step" }],
    relations: [{ type: "mounted_on", from: "arm", to: "base", description: "臂装在底板上" }],
    effectiveJoints: [{ type: "revolute", parent: "base", child: "arm", origin: { xyz: [0, 0, 0.05] }, axis: [0, 0, 1] }],
    audit: { ok: true }
  });

  assert.match(markdown, /^# bracket$/m);
  assert.match(markdown, /\| base \| 底板 \| parts\/local\/base\.step \| parts\/placed\/base\.step \|/);
  assert.match(markdown, /\| mounted_on \| arm \| base \| 臂装在底板上 \|/);
  assert.match(markdown, /\| revolute \| base \| arm \| 0 0 0\.05 \| 0 0 1 \|/);
  assert.match(markdown, /```json\n\{\n  "ok": true\n\}\n```/);
});

test("mates markdown emits placeholder rows when there is nothing to list", () => {
  const markdown = renderMatesMarkdown({
    assembly: { name: "single" },
    parts: [],
    relations: [],
    effectiveJoints: [],
    audit: {}
  });

  assert.match(markdown, /no explicit relations/);
  assert.match(markdown, /no joints/);
});
