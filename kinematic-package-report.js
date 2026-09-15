import { existsSync } from "node:fs";

function normalizeVector(values, fallback) {
  const list = Array.isArray(values) ? values : [];
  return [0, 1, 2].map((index) => Number.isFinite(Number(list[index])) ? Number(list[index]) : fallback);
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.parseFloat(number.toFixed(9)).toString();
}

export function formatNumbers(values) {
  return normalizeVector(values, 0).map(formatNumber).join(" ");
}

// Markdown table cells must survive part names and descriptions that contain
// pipes or line breaks, both of which would otherwise split the row.
export function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

/**
 * Cross-check what actually landed in the FreeCAD kinematic package against
 * what the plan asked for.  `ok: false` means the package is internally
 * inconsistent — a part went missing, or a relation/joint points at a part
 * that was never packaged.
 */
export function buildPackageAudit({ job, packageParts, relations = [], joints = [], effectiveJoints = [], mates = [] }) {
  const expectedPartIds = (job.plan?.parts || []).map((part) => part.id);
  const packagedPartIds = packageParts.map((part) => part.id);
  const missingParts = expectedPartIds.filter((id) => !packagedPartIds.includes(id));
  const invalidRelations = relations.filter((relation) => !packagedPartIds.includes(relation.from) || !packagedPartIds.includes(relation.to));
  const invalidJoints = joints.filter((joint) => !packagedPartIds.includes(joint.child) || (joint.parent !== "world" && !packagedPartIds.includes(joint.parent)));
  return {
    ok: missingParts.length === 0 && invalidRelations.length === 0 && invalidJoints.length === 0,
    expectedPartCount: expectedPartIds.length,
    packagedPartCount: packagedPartIds.length,
    relationCount: relations.length,
    explicitJointCount: joints.length,
    effectiveJointCount: effectiveJoints.length,
    mateCount: mates.length,
    missingParts,
    invalidRelations,
    invalidJoints,
    files: {
      assemblyStep: Boolean(job.stepPath && existsSync(job.stepPath)),
      assemblyStl: Boolean(job.stlPath && existsSync(job.stlPath)),
      perPartLocalStep: packageParts.every((part) => Boolean(part.localStepFile)),
      perPartPlacedStep: packageParts.every((part) => Boolean(part.placedStepFile))
    }
  };
}

/** Human-readable mate/relation/joint index shipped as mates.md in the package. */
export function renderMatesMarkdown(kinematics) {
  const lines = [
    `# ${kinematics.assembly.name}`,
    "",
    "## Parts",
    "",
    "| id | name | local STEP | placed STEP |",
    "| --- | --- | --- | --- |"
  ];
  for (const part of kinematics.parts) {
    lines.push(`| ${markdownCell(part.id)} | ${markdownCell(part.name)} | ${markdownCell(part.localStepFile)} | ${markdownCell(part.placedStepFile)} |`);
  }
  lines.push("", "## Relations", "", "| type | from | to | description |", "| --- | --- | --- | --- |");
  for (const relation of kinematics.relations) {
    lines.push(`| ${markdownCell(relation.type)} | ${markdownCell(relation.from)} | ${markdownCell(relation.to)} | ${markdownCell(relation.description)} |`);
  }
  if (!kinematics.relations.length) lines.push("|  |  |  | no explicit relations |");
  lines.push("", "## Effective Joints", "", "| type | parent | child | origin xyz m | axis |", "| --- | --- | --- | --- | --- |");
  for (const joint of kinematics.effectiveJoints) {
    lines.push(`| ${markdownCell(joint.type)} | ${markdownCell(joint.parent)} | ${markdownCell(joint.child)} | ${markdownCell(formatNumbers(joint.origin?.xyz || [0, 0, 0]))} | ${markdownCell(formatNumbers(joint.axis || [0, 0, 1]))} |`);
  }
  if (!kinematics.effectiveJoints.length) lines.push("|  |  |  |  | no joints |");
  lines.push("", "## Audit", "", "```json", JSON.stringify(kinematics.audit, null, 2), "```", "");
  return lines.join("\n");
}
