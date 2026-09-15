// FBS workspace + event bus. The staged model follows R->F->Be->S from the paper.
const KEY = "ai-cad-fsb-events";
const DOC_KEY = "ai-cad-fbs-document";
export function createFSB({ getState = () => ({}), onRender = () => {} } = {}) {
  const listeners = new Map();
  let seq = 0;
  let events = (() => { try { return JSON.parse(localStorage.getItem(KEY) || "[]").slice(-40); } catch { return []; } })();
  let document = (() => { try { return { experimentId: crypto.randomUUID(), requirements: "", functions: [], behaviors: [], structures: [], selectedFunction: null, selectedBehavior: null, selectedStructure: null, criteria: "", stageHistory: [], ...JSON.parse(localStorage.getItem(DOC_KEY) || "{}") }; } catch { return { experimentId: crypto.randomUUID(), requirements: "", functions: [], behaviors: [], structures: [], selectedFunction: null, selectedBehavior: null, selectedStructure: null, criteria: "", stageHistory: [] }; } })();
  const snapshot = () => { const s = getState() || {}; return {
    conversationId: s.conversationId || null, assemblyId: s.currentAssembly?.id || null,
    assemblyStatus: s.currentAssembly?.status || "idle", activePartId: s.activePartId || null,
    revision: s.currentAssembly?.currentRevision || null, validation: s.validationReport?.status || "unknown",
    training: s.trainingSession?.status || (s.trainingRunning ? "running" : "idle"), preview: s.viewMode || "assembly", fbs: document
  }; };
  const emit = (type, payload = {}) => { const event = { id: ++seq, type, payload, at: new Date().toISOString() }; events = [...events, event].slice(-40); localStorage.setItem(KEY, JSON.stringify(events)); [...(listeners.get(type) || []), ...(listeners.get("*") || [])].forEach((fn) => fn(event)); onRender({ events, event, snapshot: snapshot() }); return event; };
  const clearDocument = () => {
    document = { experimentId: crypto.randomUUID(), requirements: "", functions: [], behaviors: [], structures: [], selectedFunction: null, selectedBehavior: null, selectedStructure: null, criteria: "", stageHistory: [] };
    localStorage.removeItem(DOC_KEY);
    emit("fbs.reset");
    return structuredClone(document);
  };
  return { emit, snapshot, document: () => structuredClone(document), updateDocument(patch = {}) { document = { ...document, ...patch }; localStorage.setItem(DOC_KEY, JSON.stringify(document)); emit("fbs.updated", { fields: Object.keys(patch) }); return structuredClone(document); }, history: () => [...events], on(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); return () => listeners.set(type, list.filter((item) => item !== fn)); }, clearDocument, clearHistory() { events = []; localStorage.removeItem(KEY); onRender({ events, snapshot: snapshot() }); } };
}
