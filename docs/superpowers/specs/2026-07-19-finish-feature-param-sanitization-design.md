# 修饰特征参数清理设计

## 目标

修复规划器为 `chamfer` 或 `fillet` 混入实体尺寸字段后，参数化计划在构建前错误触发 `size values must be positive` 的问题，同时继续严格拒绝真正无效的倒角和圆角尺寸。

## 根因

`normalizeFeatureNode` 会把节点顶层兼容字段和 `params` 合并，再对其中所有名为 `size` 或 `dimensions` 的数组执行正数校验。规划提示中的旧式 `features` 示例把多种特征字段放在同一个通用对象中，模型可能因此给 `chamfer` 或 `fillet` 输出无意义的实体尺寸字段。

CadQuery 修饰特征实际只读取 `chamfer.params.distance` 或 `fillet.params.radius`，因此这些实体尺寸字段既不参与建模，又会在通用校验阶段造成误报。

## 规范化规则

在功能尺寸校验之前，对修饰特征执行保守清理：

- `chamfer` 删除合并后参数中的 `size` 和 `dimensions`，保留 `distance` 及其他未明确判定为实体尺寸的扩展字段。
- `fillet` 同样删除 `size` 和 `dimensions`，保留 `radius`。
- 清理同时覆盖节点顶层兼容字段和显式 `params`，因为二者会先合并成新的参数对象。
- 不修改调用者输入，规范化结果保持幂等。
- 不补写、不取绝对值、不钳制 `distance` 或 `radius`；缺失、非数字、零或负数继续按现有规则失败。
- 基础体、切割和其他真正使用 `size` 或 `dimensions` 的特征继续执行严格正数校验。

## 规划提示契约

规划提示明确区分修饰特征参数：

- `fillet` 只使用正数 `params.radius` 和有效边选择器。
- `chamfer` 只使用正数 `params.distance` 和有效边选择器。
- 两者不得携带 `size` 或 `dimensions`。

旧式兼容 `features` 示例也增加说明，避免通用示例被理解为每种字段都适用于每种特征。

## 测试

- 带负值 `size` 的 `chamfer` 可规范化，且输出中不再包含 `size`。
- 带无效 `dimensions` 的 `fillet` 可规范化，且输出中不再包含 `dimensions`。
- 顶层兼容字段和 `params` 内字段都被清理。
- 合法 `distance`、`radius` 保持不变。
- 非正 `distance` 或 `radius` 仍失败。
- `base_box` 等真正使用 `size` 的节点仍拒绝非正尺寸。
- 规范化不修改输入且结果幂等。
- 规划提示包含修饰特征的专用参数约束。
