import { analyzeAssemblyConstraints } from "./assembly-constraints.js";

export function analyticVolume(part) {
  const nodes = (part.featureTree || []).filter(node => node.enabled !== false && node.type !== "dimension");
  if (!nodes.length) return null;
  const base = nodes[0], params = base.params || {};
  if (nodes.length === 1) {
    if (base.type === "base_box") return { value: params.size.reduce((a, v) => a * v, 1), formula: "x × y × z" };
    if (base.type === "base_cylinder") return { value: Math.PI * (params.radius ?? params.diameter / 2) ** 2 * params.height, formula: "πr²h" };
    if (base.type === "base_sphere") return { value: 4 * Math.PI * params.radius ** 3 / 3, formula: "4πr³/3" };
  }
  if (nodes.length !== 2 || base.type !== "base_box" || params.center === false || nodes[1].type !== "hole") return null;
  const hole = nodes[1].params, size = params.size;
  const radius = hole.diameter != null ? hole.diameter / 2 : hole.radius;
  const center = hole.center || [0, 0, 0];
  if (!Number.isFinite(radius) || !size || (hole.axis || "z") !== "z" ||
      (params.pose?.rotate || []).some(v => v !== 0) || (params.pose?.translate || []).some(v => v !== 0) ||
      Math.abs(center[0]) + radius >= size[0]/2 || Math.abs(center[1]) + radius >= size[1]/2 ||
      hole.depth < Math.abs(center[2]) + size[2]/2) return null;
  return { value: size[0]*size[1]*size[2] - Math.PI*radius**2*size[2], formula: "x × y × z − πr²z（完全贯穿圆孔）" };
}

export function buildKernelComparison(plan, results) {
  const reference = analyticVolume(plan.parts[0]);
  const measured = results.map(result => {
    if (result.status !== "passed") return result;
    const report = result.preview.nativeReport;
    const facts = result.preview.geometryFacts;
    const metrics = report ? { volumeMm3: report.volumeMm3, bboxMm: report.bboxMm, faceCount: report.faceCount,
      edgeCount: report.edgeCount, valid: report.manifoldSolid, modelingMs: report.modelingMs,
      roundTripVolumeDeltaMm3: Math.abs(report.volumeMm3-report.restoredVolumeMm3) }
      : { volumeMm3: facts?.volume, bboxMm: facts?.bbox, faceCount: facts?.faceCount, edgeCount: facts?.edgeCount, valid: result.preview.geometryValid, modelingMs: result.preview.modelingMs };
    return { ...result, metrics, analyticVolumeErrorMm3: reference && Number.isFinite(metrics.volumeMm3) ? Math.abs(metrics.volumeMm3-reference.value) : null };
  });
  const constraintAnalysis = analyzeAssemblyConstraints(plan);
  const both = measured.every(item => item.status === "passed" && Number.isFinite(item.metrics.volumeMm3));
  return { representation: "independently-built-brep", partId: plan.parts[0].id, engines: measured, reference,
    volumeDifferenceMm3: both ? Math.abs(measured[0].metrics.volumeMm3-measured[1].metrics.volumeMm3) : null,
    dof: { source: "AICAD rule-based assembly constraint analysis; shared by both kernels", analysis: constraintAnalysis },
    limitations: ["耗时包含进程启动、建模、验证和文件导出，不是纯内核基准。",
      "两个内核数值一致只表示一致性；有解析公式时才显示独立体积误差。",
      "自由度是 AICAD 约束规则的推断，不是内核自带的草图求解器，也不是数值雅可比秩验证。",
      "建模耗时只统计 Python 适配器执行特征的时间；单次测量不能代表通用性能。包围盒可能包含内核容差扩展，不等于尺寸制造误差。",
      "面数和边数可能因拓扑分割策略不同而不同，不能直接判定几何精度。"] };
}
