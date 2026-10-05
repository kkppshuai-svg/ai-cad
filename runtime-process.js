import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export async function loadEnvFile(filePath, env = process.env) {
  if (!existsSync(filePath)) return;
  const text = await readFile(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (env[key] !== undefined) continue;
    env[key] = parseEnvValue(match[2]);
  }
}

function parseEnvValue(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "");
}

export function buildChildEnv(source) {
  const env = {};
  const allowed = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "AI_CAD_CADQUERY_MANIFEST",
    "FREECAD_CMD",
    "CADQUERY_PYTHON",
    "QT_QPA_PLATFORM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "TAVILY_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_HOME",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT"
  ];
  for (const name of allowed) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

export function createProcessRunner(rootDir) {
  return function runProcess(command, args, options = {}) {
    const timeoutMs = options.timeoutMs || 30000;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd || rootDir,
        env: buildChildEnv(options.env || process.env),
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      });
      if (options.input !== undefined) {
        child.stdin.end(options.input);
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        settled = true;
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const maxBuffer = options.maxBuffer || 120000;
      child.stdout.on("data", (data) => {
        stdout += data.toString();
        if (stdout.length > maxBuffer) stdout = stdout.slice(-maxBuffer);
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
        if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) return resolve({ stdout, stderr });
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        reject(new Error(`${command} exited with ${reason}\n${stderr || stdout}`));
      });
    });
  };
}
