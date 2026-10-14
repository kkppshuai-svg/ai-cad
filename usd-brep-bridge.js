import path from "node:path";
import { realpath, stat } from "node:fs/promises";

function within(file, root) {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function createUsdBrepBridge({ python, rootDir, runProcess }) {
  if (python && /[\0\r\n]/.test(python)) throw new Error("USD_BREP_PYTHON contains control characters");
  const script = path.join(rootDir, "scripts", "usd_brep_export.py");
  return {
    async buildBrep({ part, outputDir }) {
      if (!python) throw Object.assign(new Error("USD_BREP_PYTHON is not configured"), { status: 503 });
      try {
        const result = await runProcess(python, [path.join(rootDir, "scripts", "usd_brep_build.py")], {
          input: JSON.stringify({ part, outputDir }), timeoutMs: 120000, maxBuffer: 200000
        });
        return { ...JSON.parse(result.stdout), runtimeWarnings: Boolean(result.stderr.trim()) };
      } catch (error) {
        const match = error.message.match(/\{"error":.*"code": "USD_BREP_UNSUPPORTED_OR_INVALID"\}/);
        if (match) throw Object.assign(new Error(JSON.parse(match[0]).error), { status: 422, code: "USD_BREP_UNSUPPORTED_OR_INVALID" });
        throw error;
      }
    },
    async status() {
      if (!python) return { available: false, representation: "mesh", error: "USD_BREP_PYTHON is not configured" };
      try {
        const result = await runProcess(python, [script, "--probe"], { timeoutMs: 15000 });
        return { available: true, ...JSON.parse(result.stdout) };
      } catch {
        return { available: false, representation: "mesh", error: "USD BRep could not be loaded; check USD_BREP_PYTHON" };
      }
    },
    async exportMesh({ source, output, outputDir }) {
      if (!python) throw Object.assign(new Error("Set USD_BREP_PYTHON to a Python 3.12 environment with usd-brep installed"), { status: 503 });
      const root = await realpath(outputDir);
      const input = await realpath(source);
      if (!within(input, root) || !within(path.resolve(output), root)) {
        throw Object.assign(new Error("USD export paths must stay inside the assembly directory"), { status: 400 });
      }
      if (path.extname(input).toLowerCase() !== ".stl") throw new Error("USD mesh export requires STL input");
      if ((await stat(input)).size > 100_000_000) throw Object.assign(new Error("STL exceeds the 100 MB USD export limit"), { status: 413 });
      const result = await runProcess(python, [script, "--input", input, "--output", path.join(root, path.basename(output))], {
        timeoutMs: 120000, maxBuffer: 200000
      });
      return { ...JSON.parse(result.stdout), runtimeWarnings: Boolean(result.stderr.trim()) };
    }
  };
}
