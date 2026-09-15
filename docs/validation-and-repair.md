# 验证与自动修复

## 1. 成功定义

候选计划必须实际构建为 BREP，并通过验证门禁，才能晋级为当前修订。“模型返回 JSON”“生成预览”或“给出修复建议”都不构成成功。

```text
validationReport.blockingErrorCount === 0
validationReport.valid !== false
```

错误（error）阻断晋级；警告（warning）保留用于工程决策；信息（info）记录预期接触等非阻断事实。

## 2. 六层审查链

| 层 | 实现目标 | 主要证据 |
| --- | --- | --- |
| 1. BRepCheck | 用 OpenCascade `BRepCheck_Analyzer` 判断拓扑/几何有效性 | valid、solid count、shell 状态 |
| 2. Shape Healing | 对失败形状执行保守 `ShapeFix_Shape`，仅接受重新通过检查的结果 | healing attempt、before/after validity |
| 3. 拓扑与几何事实 | 提取实体数、体积、包围盒、面/边类型和精确测量 | geometry facts、measurements |
| 4. FBS 验收 | 把概念验收条件映射到稳定测量 ID | acceptanceChecks、measurementId |
| 5. 局部自动修复 | 生成最小编辑或 BREP 清理动作 | repairAudit、editPatch、repairActions |
| 6. STEP round-trip | 导出 STEP 后重新读取并验证零件与装配 | stepRoundTrip report |

几何根因存在时，报告会压缩部分下游连锁错误，避免同一个无效实体产生大量重复告警。

## 3. 报告结构

```json
{
  "format": "ai-cad-validation-report-v1",
  "valid": false,
  "blockingErrorCount": 1,
  "summary": { "errors": 1, "warnings": 2, "info": 0 },
  "issues": [],
  "measurements": [],
  "unverifiedDimensions": [],
  "assemblyId": "...",
  "revisionId": "..."
}
```

每个 issue 应包含稳定 `code`、`severity`、`stage` 和人可读 `message`；能定位时还应包含 `partId`、`featureId`、相关零件或测量证据。

## 4. 尺寸规则

尺寸验证必须使用语义明确的测量 ID，不能把任意包围盒轴自动解释为“厚度”“总深”或“承重”。

- 长度单位统一使用毫米；
- 目标值、实测值与公差必须来自同一语义维度；
- 无法从 BREP 证明的条件进入 `unverifiedDimensions`，不得伪造通过；
- “承重”等性能要求不能用几何尺寸替代，需要材料、载荷和仿真/试验检查器；
- FBS 声明测量 ID 而报告无同名测量时，产生 `FBS_ACCEPTANCE_UNMAPPED`。

## 5. 修复分类

### 确定性修复

只处理有安全边界、不会改变功能语义的问题：

- 圆角或倒角失败：逐步减小，达到下限后可禁用装饰性收尾特征；
- `CUT_NOT_THROUGH`：把切除深度增加到验证器给出的必要值；
- `MINIMUM_POSITIVE_REQUIRED`：仅在问题标记 `safeToClamp` 时夹到正数下限；
- `INVALID_BREP` / `BREP_CLEAN_RETRY`：执行清理与重建。

### AI 最小修复

干涉、约束或复杂语义问题进入 AI 修复。候选必须保持：

- 功能孔径和孔中心；
- 零件数量与对象身份；
- 约束类型和装配语义；
- 用户明确尺寸、材料和安装方向。

候选若违反保护规则，将被拒绝且不进入构建。

## 6. 循环与终止

新建设计的外层验证—修复循环是有界循环；参数化局部编辑另有确定性重试。具体次数属于实现配置，修改时必须同步测试和文档，不能使用无限循环。

```text
最新报告 → 最小修复 → 候选修订 → 重建 → 完整复验
```

循环在以下任一条件终止：

- 所有阻断错误消除，候选晋级；
- 达到最大修复轮次；
- 无安全修复方案；
- 修复候选违反不变量；
- 用户停止当前 AI 规划。

失败终止时应返回 `validation_failed`、最新报告、修复审计和可用预览；不得把错误静默降级为成功。

## 7. 视觉审查

视觉审查是几何验证的补充，不替代 BREP 测量。审查报告必须绑定 `revisionId`；修订变化后旧报告视为过期。只有可操作 finding 才能进入自动改进，结果仍需通过完整 BREP、约束和 STEP round-trip 验证。

## 8. 回归测试

```bash
node --test cad-validation.test.mjs
node --test validation-repair-loop.test.mjs
node --test assembly-validation-report.test.mjs
node --test parametric-api.test.mjs
PYTHONPATH=scripts .venv-cadquery/bin/python scripts/test_parametric_build.py
```

修改错误码、严重级别、修复动作或门禁逻辑时，必须增加对应失败用例和成功复验用例。
