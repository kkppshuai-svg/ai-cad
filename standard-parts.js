import { resolveAndDownloadStepPart } from "./step-parts.js";

export async function hydrateStandardPartsForPlan(plan, {
  cacheDir,
  resolver = resolveAndDownloadStepPart,
} = {}) {
  if (!cacheDir) throw new Error("standard parts cacheDir is required");
  for (const part of plan.parts || []) {
    if (part.mode !== "standard_part") continue;
    try {
      const resolved = await resolver({
        request: part.standardPart,
        cacheDir,
      });
      part.standardPart = {
        ...part.standardPart,
        resolved,
      };
      part.sourceStepPath = resolved.localStepPath;
      part.primitives = [];
      part.features = [];
    } catch (error) {
      if (!applyKnownBearingFallback(part, error)) throw error;
    }
  }
  return plan;
}

function applyKnownBearingFallback(part, error) {
  const requestText = [
    part.id,
    part.name,
    part.role,
    part.standardPart?.id,
    part.standardPart?.query,
    part.standardPart?.tag,
  ].filter(Boolean).join(" ").toLowerCase();
  const match = requestText.match(/(?:^|[^0-9])620([45])(?:[^0-9]|$)/);
  if (!match || !/(bearing|轴承|deep[- ]?groove|深沟)/i.test(requestText)) return false;

  const size = match[1] === "4"
    ? { designation: "6204", boreDiameter: 20, outerDiameter: 47, width: 14 }
    : { designation: "6205", boreDiameter: 25, outerDiameter: 52, width: 15 };
  part.mode = "generated";
  part.sourceStepPath = null;
  part.standardPart = {
    ...part.standardPart,
    resolved: {
      provider: "local-parametric-fallback",
      id: size.designation,
      name: `${size.designation} deep groove ball bearing (local fallback)`,
      source: "local-parametric",
      fallback: true,
      reason: error?.message || "step.parts returned no result",
      nominal: size,
    },
  };
  part.featureTree = [
    {
      id: `${part.id}.base.01`,
      type: "base_cylinder",
      enabled: true,
      dependsOn: [],
      params: { radius: size.outerDiameter / 2, height: size.width, center: true },
      name: `${size.designation}轴承外圈（本地替代）`,
    },
    {
      id: `${part.id}.bore.01`,
      type: "hole",
      enabled: true,
      dependsOn: [`${part.id}.base.01`],
      params: { diameter: size.boreDiameter, depth: size.width + 4, axis: "z", center: [0, 0, 0] },
      name: `${size.designation}轴承内孔（本地替代）`,
    },
  ];
  part.primitives = [];
  part.features = [];
  return true;
}
