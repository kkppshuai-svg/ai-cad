import path from "node:path";

export const CAD_EXPLORER_SKILL_DIR = process.env.AICAD_CAD_EXPLORER_SKILL_DIR
  || path.join(process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex"), "skills", "cad-explorer");
export const CAD_EXPLORER_NPM_PREFIX = path.join(CAD_EXPLORER_SKILL_DIR, "scripts", "explorer");

export function chooseExplorerPreviewFile(job, options = {}) {
  const partId = String(options.partId || "").trim();
  if (partId) {
    const part = (job?.parts || []).find((item) => item.id === partId);
    const partFile = firstFile(part?.stlPath, part?.localStlPath, part?.stepPath, part?.localStepPath, part?.sourceStepPath);
    if (partFile) return partFile;
  }
  return firstFile(job?.stlPath, job?.stepPath, job?.fcstdPath);
}

export function parseExplorerUrl(stdout) {
  const text = String(stdout || "");
  const match = text.match(/https?:\/\/127\.0\.0\.1:\d+\/[^\s"'<>]*/i)
    || text.match(/https?:\/\/localhost:\d+\/[^\s"'<>]*/i);
  return match ? match[0] : "";
}

export function buildExplorerCommandArgs({ workspaceRoot, filePath }) {
  const args = [
    "--prefix",
    CAD_EXPLORER_NPM_PREFIX,
    "run",
    "dev:ensure",
    "--"
  ];
  if (workspaceRoot) {
    args.push("--workspace-root", workspaceRoot);
  }
  args.push("--file", filePath);
  return args;
}

export function isPathInside(filePath, rootDir) {
  const relative = path.relative(path.resolve(rootDir), path.resolve(filePath));
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    || relative === "";
}

function firstFile(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}
