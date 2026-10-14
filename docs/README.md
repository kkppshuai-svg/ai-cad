# AI-CAD 文档中心

[English overview](../README.md) · [中文首页](../README.zh-CN.md) · [English setup](getting-started.en.md)

本文档集描述 GitHub 主分支所对应的工程研发基线。文档以仓库当前实现为准；规划中的能力必须明确标注，不能写成已交付功能。

## 阅读顺序

1. [安装与运行](getting-started.md)：完成本地部署和首个模型验证。
2. [系统架构](architecture.md)：理解 Concept-CAD、构建、验证、修复和修订的职责边界。
3. [配置参考](configuration.md)：配置模型、超时、搜索、安全和数据目录。
4. [HTTP API](api.md)：集成前端、脚本或其他本机客户端。
5. [验证与自动修复](validation-and-repair.md)：理解“通过”“失败”和“已修复”的工程含义。
6. [工程示例](examples.md)：查看齿轮啮合与减速机建模截图。
7. [FBS 系统规范](fbs-system.md)：理解 FBS 如何进入 CAD 计划和 BREP 验收。
8. [参数化编辑](parametric-editing.md)：实现稳定特征 ID 和局部修订。
9. [开发与测试](development.md)：修改代码、运行回归和维护文档。

## 当前双内核与联合审查

- [USD BRep 接入](usd-brep.md)：NVIDIA 原生模式、支持范围及后端差异。
- [统一 BRep + 视觉审查](unified-brep-review.md)：几何证据、文件完整性、当前视觉与交付结论。
- [FormaLatent](https://github.com/kkppshuai-svg/formalatent)：独立表征学习与检索项目。
- [USD BRep Review](https://github.com/kkppshuai-svg/usd-brep-review)：独立审查通道；AICAD 当前保留工作台内实现。

## 文档约定

- `MUST` / **必须**：违反会破坏数据合同、安全边界或修订正确性。
- `SHOULD` / **应当**：默认工程策略；只有明确理由时才偏离。
- `MAY` / **可以**：可选能力或扩展点。
- “成功生成”表示当前验证规则通过，不表示真实工况已完成工程认证。
- “自动修复”表示系统已修改候选计划并重新构建、复验，不表示仅生成了一段修复建议。

## 文档维护规则

| 代码变化 | 必须更新 |
| --- | --- |
| 新增或修改 API | `docs/api.md` |
| 新增环境变量或默认值 | `docs/configuration.md` |
| 修改验证层、阻断规则或修复次数 | `docs/validation-and-repair.md` |
| 修改 FBS/Concept-CAD schema | `docs/fbs-system.md` |
| 修改安装依赖或启动方式 | `docs/getting-started.md`、`MIGRATION.md` |
| 修改模块职责或权威数据源 | `docs/architecture.md` |
