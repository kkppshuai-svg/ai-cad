# 阵列源特征安全补全设计

## 目标

避免 AI 修复拉伸 profile 后，因为 `linear_pattern` 或 `circular_pattern` 漏写 `params.sourceFeatureId` 而使完整计划再次失败。

## 规则

在参数化节点规范化阶段，仅当阵列节点缺少 `sourceFeatureId` 时检查 `dependsOn`：

- 若恰好存在一个依赖，且该依赖对应同一零件中的可阵列化源特征，则补入 `params.sourceFeatureId`。
- 可阵列化源类型沿用构建器规则：排除基础体、`dimension`、`fillet`、`chamfer`、`linear_pattern` 和 `circular_pattern`。
- 若依赖为空、存在多个依赖、依赖不存在或唯一依赖类型不合法，保持现有明确错误，不做猜测。
- 显式提供的 `sourceFeatureId` 永远优先，并继续要求它出现在 `dependsOn` 中。

该行为属于旧计划兼容规范化，必须在依赖图最终校验之前完成，并且不修改调用者输入。

## 提示契约

完整计划提示中的阵列示例明确同时包含：

- `dependsOn: [sourceFeatureId]`
- `params.sourceFeatureId`
- 数量以及间距或角度

profile 修复提示继续要求返回完整 schema-valid 计划，并额外提醒阵列必须填写源特征 ID。

## 测试

- 唯一合法依赖可补全线性阵列和圆周阵列。
- 多个依赖、缺失依赖以及非法源类型仍失败。
- 显式源特征不会被覆盖。
- 规范化不修改输入且结果幂等。
- profile 修复后的计划漏写阵列源 ID 时能够通过规范化。
- 规划提示明确包含阵列源字段要求。

