import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

function textFromItem(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (Array.isArray(item.content)) return item.content.map(textFromItem).filter(Boolean).join("");
  if (Array.isArray(item.parts)) return item.parts.map(textFromItem).filter(Boolean).join("");
  return "";
}

export class CodexHarnessClient {
  constructor({ command = "codex", cwd = process.cwd(), env = process.env, model = null, reasoningEffort = null } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.child = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.threads = new Map();
    this.active = new Map();
    this.initialized = null;
  }

  get running() {
    return Boolean(this.child && !this.child.killed);
  }

  async ensureStarted() {
    if (this.running && this.initialized) return;
    if (this.child) this.close(new Error("Codex app-server restarted"));
    const args = ["app-server", "--stdio"];
    if (this.model) args.push("-c", `model=${JSON.stringify(this.model)}`);
    if (this.reasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(this.reasoningEffort)}`);
    this.child = spawn(this.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => this.#handleLine(line));
    this.child.on("error", (error) => this.close(error));
    this.child.on("close", (code, signal) => {
      if (this.child) this.close(new Error(`Codex app-server exited (${signal || code})`));
    });
    this.child.stderr.on("data", () => {});
    this.initialized = this.request("initialize", {
      clientInfo: { name: "ai_cad", title: "AI-CAD Engineering Workbench", version: "0.1.0" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: ["item/agentMessage/delta"] }
    });
    await this.initialized;
    this.notify("initialized", {});
  }

  request(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  async run({ key, prompt, images = [], cwd = this.cwd, timeoutMs = 120000 }) {
    await this.ensureStarted();
    let threadId = key ? this.threads.get(key) : null;
    if (!threadId) {
      const started = await this.request("thread/start", {
        cwd,
        model: this.model,
        allowProviderModelFallback: false,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        serviceName: "ai_cad"
      }, timeoutMs);
      threadId = started?.thread?.id;
      if (!threadId) throw new Error("Codex app-server did not return a thread id");
      if (key) this.threads.set(key, threadId);
    }
    const turn = await this.request("turn/start", {
      threadId,
      input: [
        { type: "text", text: prompt },
        ...images.map((image) => ({ type: "localImage", path: image.path || image }))
      ]
    }, timeoutMs);
    const turnId = turn?.turn?.id || turn?.id;
    if (!turnId) throw new Error("Codex app-server did not return a turn id");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.active.delete(threadId);
        void this.request("turn/interrupt", { threadId, turnId }, 10000).catch(() => {});
        reject(new Error(`Codex app-server turn timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.active.set(threadId, { turnId, text: "", timer, resolve, reject });
    });
  }

  async stop(key) {
    const threadId = this.threads.get(key);
    const active = threadId && this.active.get(threadId);
    if (!active) return { stopped: false };
    await this.request("turn/interrupt", { threadId, turnId: active.turnId }, 10000).catch(() => {});
    return { stopped: true };
  }

  close(error = new Error("Codex app-server closed")) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const entry of this.active.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.active.clear();
    this.initialized = null;
    this.rl?.close();
    this.rl = null;
    this.child = null;
  }

  shutdown() {
    const child = this.child;
    this.close(new Error("Codex app-server client shutdown"));
    child?.kill("SIGTERM");
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || "Codex app-server request failed"));
      else entry.resolve(message.result);
      return;
    }
    const params = message.params || {};
    const threadId = params.threadId || params.thread_id || params.turn?.threadId || params.item?.threadId;
    const active = threadId && this.active.get(threadId);
    if (!active) return;
    const item = params.item || params;
    if (message.method === "item/completed" && /agentMessage/i.test(String(item.type || item.kind || ""))) {
      active.text += textFromItem(item);
    }
    if (message.method === "turn/completed") {
      clearTimeout(active.timer);
      this.active.delete(threadId);
      const finalText = active.text || textFromItem(params.turn?.finalMessage) || textFromItem(params.turn);
      if (String(params.turn?.status || params.status || "").toLowerCase() === "interrupted") {
        active.reject(new Error("Codex app-server turn interrupted"));
      } else {
        active.resolve({ text: finalText, threadId, turnId: active.turnId, event: params });
      }
    }
  }
}
