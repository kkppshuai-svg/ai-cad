# 统一 BRep 审查

工作台的“统一审查”汇总内核构建证据、序列化回读、尺寸验收、干涉、约束规则与视觉审查。首次构建、参数编辑采用同一个报告组合器；验证查询和版本回退也经过内容完整性检查。协议为 `unified-brep-review-v2`。

通道已抽出为独立仓库 [USD BRep Review](https://github.com/kkppshuai-svg/usd-brep-review)，通过 NVIDIA `usd_brep` API 原生建模或直接审查自包含精确 USDA，可作为 Node.js SDK 或 CLI 使用。独立版无需启动 AICAD，视觉审查器通过回调接入。AICAD 当前保留工作台内的实现；独立仓库提供外部复用入口，不表示工作台已经切换为 npm 依赖。

当前以 NVIDIA USD BRep 为主通道（运行环境可用时默认选用），CadQuery/OpenCascade 保留并行验证。阶段标记为 `parallel-validation`，用户验收标记为 `pending`。复杂装配和原生尚不支持的特征继续由用户选择 CadQuery 构建，不把原生支持范围扩大为完整 CAD 功能。

“统一审查”默认一次核对 BRep、采集 3D/前/顶/侧视图、执行视觉检查，再输出同一份交付报告；自动视觉审查流程也调用 `/api/review`。旧视觉接口保留兼容，但工作台不再提供单独的视觉执行按钮。视觉服务失败时报告保留几何结果，交付等待补充，不能沿用上一次视觉通过。该操作只审查，人工尚未验证期间不隐式修改模型。原有用户启动的自动修复/训练流程继续使用修订门禁。

## 决策和证据

几何通过必须有有效的内核报告、有限的正体积、实体数量、几何范围及通过的 STEP/USD 回读报告，且没有阻断错误。缺少证据、未支持的必需尺寸检查、NaN/Infinity 或负体积均不能通过。完整交付还要求当前修订的视觉审查通过，旧修订的视觉报告不能代替新模型审查。

构建完成后，把特征计划和实际 STEP/USD BRep、预览网格及零件实体文件绑定到 SHA-256。每次查询仍重新读取文件计算摘要，核对计划和精度策略，再复用内核证据；查询不会重新调用内核。文件、计划或策略变化会阻断复用，要求重建。缓存最多 128 项，策略算法升级需同步更新协议版本。升级前没有绑定证据的历史修订需重建后才能通过统一审查或回退门禁。

## 精确性

OpenCascade 使用带几何控制的精确 BRepCheck，修复后的形状重新验证，避免重复修复。范围通过 `BRepBndLib.AddOptimal` 从几何求取，排除显示三角网格缓存和形状容差扩张；质量属性使用带符号体积，避免负体积被绝对值隐藏。

STEP 和 NVIDIA USD BRep 导出后重新读取，对比有效性、实体数量、体积、绝对上下界和重心。相同体积但整体平移也会被发现；比较尺度取对象大小，不能用距离原点很远的位置放宽容差。简单盒体、圆柱、球和满足适用条件的通孔提供独立解析体积参考。

| 策略 | 数值 |
| --- | --- |
| 线性绝对容差 | 1e-6 mm |
| 线性相对容差 | 1e-9 |
| 体积绝对容差 | 1e-8 mm³ |
| 体积相对容差 | 1e-7 |
| OCCT 体积积分相对容差 | 1e-9 |
| SMLib 体积积分相对容差 | 1e-8 |

这些是软件数值检查策略，不是加工精度承诺。NVIDIA 的范围包含内核保守扩张，目前仅体积能够作为原生适配器的必需测量验收；其他必需测量会阻断，不能用保守包围盒冒充精确尺寸。SMLib 流形拓扑检查与 OCCT 几何检查的覆盖分别披露。当前未证明全表面 Hausdorff 距离等价；约束是刚体规则分析，制造风险是启发式检查，不包含通用草图求解或承重仿真。

## 速度和复现

干涉检查预计算每个零件的几何范围，采用 sweep-and-prune 筛选候选，仅对候选执行精确 BRep 布尔求交。求交失败成为阻断错误，不能当作无干涉。

本机 41 个稀疏零件、一个真实重叠的案例，预热后 5 次中位数：旧路径 26.36 ms，新路径 7.63 ms，约 3.45 倍；820 对筛选为 1 次精确求交，结果一致。这只衡量该案例的干涉检查，不代表全部建模或密集装配的加速比例。

```powershell
& $env:CADQUERY_PYTHON scripts/benchmark_brep_review.py
npm run check
```

性能结果保存到 `output/review-performance.json`。本机浏览器验证分别构建两个真实内核示例，检查几何通过、完整交付待补充及报告下载；结果在 `output/unified-review-browser-report.json`。

## API

`POST /api/review` 请求：`{ "assemblyId": "模型ID", "profile": "delivery", "revisionId": "审查版本ID", "runVisual": true, "screenshots": [{ "view": "3d", "dataUrl": "data:image/jpeg;base64,..." }], "refresh": false }`。`profile` 可选 `geometry` 或 `delivery`，默认 `delivery`。`runVisual: true` 需要交付范围和截图；不提供时仅组合已有视觉证据，不调用视觉模型。预览返回独立的 `reviewRevisionId`，绑定模型 ID 和特征计划摘要；它不是可编辑的参数修订。提供陈旧版本返回 409。`refresh` 强制重新组合报告，仍核对已有构建证据，不会触发重建。

响应包含 `status`、`issues`、`review.geometryDecision`、`review.visualDecision`、`review.deliveryDecision`、检查策略与覆盖范围、`review.cache` 和 `reportUrl`。`GET /api/assembly/:id/validation` 同样核对绑定证据，保留原有修订和约束字段。
