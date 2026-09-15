# 系统架构

## 1. 架构目标

AI-CAD 采用 STEP-first、计划驱动和验证门禁架构。系统优先保证参数化计划、BREP 证据和修订状态一致，再提供预览、训练和辅助导出。

## 2. 逻辑链路

```text
Browser UI
  │  HTTP + SSE
  ▼
Node.js Server
  ├─ Conversation/FBS context
  ├─ LLM provider seam ── Codex / DeepSeek
  ├─ Concept-CAD normalization
  ├─ Parametric edit + revision store
  └─ Validation/repair orchestration
          │
          ▼
CadQuery Python Builder
  ├─ OpenCascade BREP
  ├─ STEP/STL/GLB/FCStd evidence
  └─ geometry-validation.json
          │
          ▼
Validation Gate
  ├─ topology and geometry facts
  ├─ measurements and FBS acceptance
  ├─ interference and constraints
  ├─ manufacturability warnings
  └─ STEP round-trip
          │
          ├─ pass → promote revision → viewer/export/latent queue
          └─ fail → deterministic or AI repair → rebuild
```

## 3. 权威数据

| 数据 | 权威来源 | 说明 |
| --- | --- | --- |
| 设计意图 | 当前用户消息 + 统一 `concept` | 历史和学习样本不能覆盖明确输入 |
| 参数化模型 | `feature-plan.json` / 当前修订中的 plan | STEP、STL、GLB 不是编辑权威源 |
| 当前版本 | revision store 中已晋级修订 | 失败候选不得替换当前版本 |
| 几何事实 | CadQuery/OCP 构建器输出的验证报告 | UI 不自行猜测尺寸或拓扑 |
| 验收状态 | `ai-cad-validation-report-v1` | 错误阻断，警告保留但不必阻断 |
| FBS 追溯 | `ai-cad-concept-cad-contract-v1` 归档 | 后续规划只消费紧凑摘要 |

## 4. 模块边界

| 模块 | 主要职责 |
| --- | --- |
| `server.js` | HTTP/SSE、运行时依赖、路由装配、服务生命周期 |
| `api-routes.js` | API 路由表与匹配规则 |
| `conversation-turn.js` | 单轮规划、FBS 上下文和修复编排 |
| `llm-provider.js` | Codex/DeepSeek 路由与回退策略 |
| `prompt-contract.js` | Concept-CAD、编辑补丁和修复提示合同 |
| `parametric-plan.js` | 特征计划规范化与 checksum |
| `parametric-edit.js` | 局部编辑补丁和依赖保护 |
| `parametric-api.js` | 参数化 API、增量重建和修订锁 |
| `assembly-build.js` | 候选修订的构建、验证和晋级流程 |
| `cad-validation.js` | 报告合并、门禁、问题分类和确定性修复 |
| `assembly-validation-report.js` | 分层验证报告组合 |
| `validation-repair-loop.js` | 有界的构建—审查—修复循环 |
| `revision-store.js` | 候选、失败、当前修订和回退状态 |
| `scripts/cadquery_build.py` | CadQuery/OCP 几何构建与 STEP 回归验证 |
| `cad-latent-training.js` | 已通过样本的队列、数据集和 VAE 训练连续性 |
| `public/` | 对话、工程预览、特征树、审查和修订 UI |

## 5. 修订生命周期

```text
planned → candidate → building → validating
                            ├─ pass → current
                            └─ fail → failed/superseded
                                         └─ repaired candidate → ...
```

每个写操作使用当前修订作为基线。陈旧基线返回 `STALE_REVISION`，避免并发修改覆盖新版本。未受影响零件只有在计划 checksum、构建策略 checksum 和 STEP 文件 checksum 均匹配时才允许复用。

## 6. 运行时目录

| 目录 | 内容 | Git 策略 |
| --- | --- | --- |
| `assemblies/` | 装配任务、修订、产物和验证证据 | 忽略 |
| `workspace/uploads/` | 对话参考图 | 忽略 |
| `workspace/latent-learning/` | latent/VAE 运行数据 | 忽略 |
| `renders/` | 预览渲染 | 忽略 |
| `logs/` | 服务日志 | 忽略 |
| `standard-parts-cache/` | step.parts 缓存 | 忽略 |
| `aicad-fbs-experiments/` | Concept-CAD 追溯归档 | 按研发策略管理 |

## 7. 运动学边界

运动学关系使用 `assembly-constraints.json` 和 `assembly-kinematics.json` 表达，并可通过 FreeCAD 桥接继续处理。核心构建不依赖外部机器人描述或仿真运行时。

仓库内的交互式架构源位于 `docs/architecture/aicad.architecture.json`；生成页面为 `public/architecture.html`。
