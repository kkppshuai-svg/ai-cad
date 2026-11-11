const list = (value) => Array.isArray(value) ? value : [];
const partId = (value) => typeof value === "string" ? value : value?.partId;
const baseTypes = new Set(["box", "cylinder", "cone", "sphere", "ellipsoid", "spur_gear"]);

function addOperations(part, id, nodes, edges) {
  const native = Array.isArray(part.featureTree) && part.featureTree.length > 0;
  const operations = native
    ? part.featureTree.filter((node) => node.enabled !== false).map((node) => {
        const base = node.type?.startsWith("base_") && baseTypes.has(node.type.slice(5));
        return { node, kind: base ? "primitive" : "feature", type: base ? node.type.slice(5) : node.type };
      })
    : [
        ...list(part.primitives).map((node) => ({ node, kind: "primitive", type: node.type })),
        ...list(part.features).map((node) => ({ node, kind: "feature", type: node.type })),
      ];
  const operationIds = new Map();
  for (const [order, { node, kind, type }] of operations.entries()) {
    const operationId = `${id}:${kind}:${order}`;
    if (node.id) operationIds.set(node.id, operationId);
    nodes.push({ id: operationId, kind, type: type === "add" ? "add_primitive" : type || "unknown", order });
    edges.push({ kind: "contains", from: id, to: operationId });
  }
  if (native) {
    for (const { node } of operations) {
      const from = operationIds.get(node.id);
      for (const dependency of list(node.dependsOn)) {
        const to = operationIds.get(dependency);
        if (from && to && from !== to) edges.push({ kind: "depends_on", from, to });
      }
    }
  }
}

export function buildCadStructureGraph(plan) {
  const parts = list(plan.parts);
  const nodes = [];
  const edges = [];
  const partNodes = new Map();
  for (const [index, part] of parts.entries()) {
    const id = `part:${index}`;
    if (part.id && !partNodes.has(part.id)) partNodes.set(part.id, id);
    nodes.push({ id, kind: "part", role: part.role || "" });
    addOperations(part, id, nodes, edges);
  }
  for (const relation of list(plan.relations)) {
    const from = partNodes.get(partId(relation.from));
    const to = partNodes.get(partId(relation.to));
    if (from && to) edges.push({ kind: "relation", type: relation.type || "reference", from, to });
  }
  for (const joint of list(plan.joints)) {
    const parent = partId(joint.parent || joint.from) || "world";
    const from = parent === "world" ? "world" : partNodes.get(parent);
    const to = partNodes.get(partId(joint.child || joint.to));
    if (!from || !to) continue;
    if (from === "world" && !nodes.some((node) => node.id === "world")) {
      nodes.push({ id: "world", kind: "world" });
    }
    edges.push({ kind: "joint", type: joint.type || "fixed", from, to });
  }
  return { format: "ai-cad-structure-graph-v1", nodes, edges };
}
