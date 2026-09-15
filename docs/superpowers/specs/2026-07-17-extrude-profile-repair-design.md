# 拉伸轮廓生成失败自动修复设计

## 目标

当 AI 生成的参数化计划包含 `add_extrude` 或 `cut_extrude`，但 `params.profile.type` 缺失或非法时，AI-CAD 不再直接把底层 schema 错误抛给用户。系统应把精确的校验错误和失败特征 ID 回传给规划器，并进行一次受限的计划重试。

## 方案

在 `generateAssemblyPlan` 的首次规划结果通过基础形状整理后，执行参数化计划规范化。若规范化失败且错误匹配拉伸 profile schema：

1. 提取失败的特征 ID、操作类型和原始校验消息。
2. 用原始用户请求与一个追加的修复指令重新调用规划器一次。指令明确要求返回完整有效计划，并列出仅允许的 profile 类型及其必填字段：`rectangle(width,height)`、`circle(radius|diameter)`、`slot(length,width|diameter)`、`polygon(points)`。
3. 对重试结果执行与首次结果相同的 `normalizePlanShape`、`validateAssemblyPlan` 和 `normalizeParametricPlan` 校验。

重试只发生一次，只覆盖 profile schema 失败；其他 schema、构建或网络错误维持现有错误路径。两次都失败时，返回包含原始 feature ID 与 profile 要求的用户可读错误，且不创建或提升候选修订。

## 边界与错误处理

- 不在服务端推测 profile 的形状或尺寸，不修改生成计划来“凑”出类型。
- 不对已有成功 revision 进行改写；失败计划仍无法进入构建流程。
- 保留现有超时快速重试语义；profile 修复重试与超时重试组合时，单次规划调用仍由超时策略保护。

## 测试

- 首次计划的 `add_extrude.profile` 缺少 `type` 时，规划器收到一次针对性修复调用，修复后有效计划被接受。
- 修复结果仍缺少 `type` 时，调用只发生两次，并返回包含特征 ID 的清晰错误。
- 非 profile schema 错误不触发修复调用。
- 现有有效计划只调用规划器一次。
