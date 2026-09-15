# AI-CAD FBS 概念设计系统

| 项目 | 内容 |
| --- | --- |
| 文档状态 | 工程研发基线 |
| 合同版本 | `ai-cad-concept-cad-contract-v1` |
| FBS 数据版本 | `ai-cad-fbs-analysis-v1` |
| 适用分支 | `feature/fbs-system` |
| 核心实现 | `fbs-workflow.js`、`prompt-contract.js`、`cad-validation.js`、`server.js` |

## 1. 目的与范围

本系统在自然语言需求与可执行 CAD 特征计划之间建立一条可追溯的概念链：

```text
需求 R → 功能 F → 行为 Be → 结构 S → CAD 特征与参数 → BREP 验证
```

FBS 的职责是解释“为什么设计成这样”，并把关键意图转换成可测量的验收条件。CAD 规划的职责是解释“具体怎样建模”。两者通过同一个 Concept-CAD 合同传递，不进行第二次概念推导，也不在 CAD 计划中重复 FBS 的论证文本。

当前版本面向工程研发，不提供面向终端用户的模式切换。系统不能替代载荷计算、材料验证、有限元分析、加工验证或样件试验。

## 2. 设计原则

1. **单一概念源**：一次新建设计只产生一份 `concept`；后续局部尺寸修改复用该概念链。
2. **当前输入优先**：用户当前消息是设计意图的权威来源。历史对话、检索样本、latent/VAE 结果不得覆盖明确尺寸、对象或功能。
3. **语义与几何分层**：FBS 保存需求、功能、行为、结构及来源关系；CAD 计划只保存零件、特征、参数、位姿和测量项。
4. **验收必须可测**：关键验收条件通过 `measurementId` 映射到稳定的 CAD 测量项。
5. **失败不得晋级**：存在阻断错误或未映射的 FBS 验收条件时，候选修订不能成为当前版本。
6. **修复范围最小**：自动修复优先修改失败特征；不得静默改变功能孔径、孔中心、约束语义或零件数量。

## 3. 模块职责

| 模块 | 责任 | 不承担的责任 |
| --- | --- | --- |
| `fbs-workflow.js` | 规范化 R→F→Be→S 数据；生成紧凑规划摘要 | 生成几何、执行 BREP 检查 |
| `prompt-contract.js` | 定义统一 Concept-CAD 输出合同；约束模型避免重复推导 | 持久化与几何构建 |
| `server.js` | 管理对话状态、归档概念合同、驱动构建和修复循环 | 直接实现 CAD 内核算法 |
| `cad-validation.js` | 合并验证证据；检查 FBS 验收映射；决定修订能否晋级 | 推断新的功能或结构概念 |
| `public/fsb.js` | 保存前端 FBS 文档快照和事件记录 | 作为后端权威数据源 |

> `public/fsb.js` 的文件名保留了早期 FSB 拼写以兼容现有引用；概念和界面统一使用 **FBS**。

## 4. 统一数据合同

### 4.1 Concept-CAD 顶层结构

```json
{
  "reply": "已生成参数化安装板",
  "name": "motor_mount_plate",
  "concept": {
    "requirements": "安装指定电机并保持孔位可制造",
    "criteria": "关键尺寸由 BREP 测量验证",
    "functions": [],
    "behaviors": [],
    "structures": [],
    "acceptanceChecks": []
  },
  "parts": [],
  "relations": [],
  "joints": [],
  "constraints": []
}
```

`concept` 与 `parts` 必须在同一次规划响应中产生。禁止另行生成一份与 CAD 计划脱节的 FBS 文档。

### 4.2 FBS 节点

每个功能、行为和结构节点使用相同基础字段：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `id` | string | 稳定且唯一；仅使用字母、数字、点、下划线和连字符 |
| `label` | string | 简洁描述节点的工程含义 |
| `rationale` | string | 说明节点为何来自上游意图；仅保留在追溯记录中 |
| `specifications` | string[] | 可检查的规格或约束，最多 12 项 |
| `upstreamIds` | string[] | 指向直接上游节点，形成 F→Be→S 追溯关系 |

完整链至少包含一个 `function`、一个 `behavior` 和一个 `structure`。缺失任一层时，规范化过程拒绝该结果并由服务器生成明确的降级映射。

### 4.3 验收条件

```json
{
  "id": "ac-hole-diameter",
  "statement": "安装孔直径满足设计值",
  "measurementId": "mount_plate.hole_diameter",
  "tolerance": 0.05,
  "sourceIds": ["s-mounting-hole"]
}
```

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `id` | 是 | 验收条件稳定 ID |
| `statement` | 是 | 人可读的验收语句 |
| `measurementId` | 对可量化条件必需 | 对应 `part.measurements` 中的稳定测量 ID |
| `tolerance` | 否 | 允许偏差，单位与对应测量一致 |
| `sourceIds` | 否 | 产生该条件的 FBS 节点 ID |

当前 `validateFbsAcceptanceCoverage` 检查的是**测量映射完整性**：若声明了 `measurementId`，但 BREP 验证报告没有同名测量项，则生成阻断错误 `FBS_ACCEPTANCE_UNMAPPED`。测量值是否满足目标范围，由几何验证器对应的尺寸规则负责。

## 5. 执行链路

```text
用户输入
  ↓
一次 AI 规划：concept(R/F/Be/S/验收) + CAD plan
  ↓
FBS 规范化、会话保存、Concept-CAD 合同归档
  ↓
CadQuery 构建 STEP/BREP
  ↓
几何测量 + 干涉/约束/制造性验证 + FBS 验收映射检查
  ├─ 无阻断错误 → 晋级当前修订 → 可进入 latent 学习队列
  └─ 有阻断错误 → 确定性局部修复 / AI 最小修复 → 重建并复验
```

新对话生成新的 FBS 文档。已有修订的局部编辑默认返回 `editPatch`，复用原有概念链，只改目标 CAD 特征。若用户改变了产品对象、用途或核心约束，应视为新的概念修订，而不是把旧 FBS 强行套用到新设计。

## 6. 验证与自动修复

候选修订只有满足以下条件才可晋级：

- `validationReport.blockingErrorCount === 0`；
- `validationReport.valid !== false`；
- 每个声明了 `measurementId` 的 FBS 验收条件均能在 BREP 测量结果中找到；
- 构建产物、零件几何报告及计划零件 ID 相互一致。

修复分两层执行：

1. **确定性修复**：处理可安全判定的圆角/倒角失败、切除深度不足、正数下限和 BREP 清理重试。
2. **AI 最小修复**：处理干涉、约束或其他语义问题；候选方案必须通过功能尺寸与装配语义保护检查后才能重建。

每轮修复都重新构建并重新验证，不以“生成了修复建议”作为成功。自动修复次数耗尽后保留失败报告和预览证据，不会把失败候选设为当前版本。

## 7. 持久化与追溯

服务器将统一合同写入：

```text
${AICAD_FBS_DIR:-aicad-fbs-experiments}/<experimentId>-concept-cad.json
```

归档格式为 `ai-cad-concept-cad-contract-v1`，包含：

- `experimentId`：概念实验标识；
- `analysis`：规范化后的 FBS 数据；
- `plan.name` 与 `plan.partIds`：对应 CAD 计划摘要；
- `savedAt`：保存时间。

完整论证只进入归档；传给后续 CAD 规划器的是去除 `rationale` 的紧凑摘要，以减少上下文重复和语义漂移。

## 8. 运行与测试

运行 FBS 单元测试：

```bash
node --test fbs-workflow.test.mjs
node --test cad-validation.test.mjs
node --test prompt-contract.test.mjs
```

完整工程检查：

```bash
npm run check
```

最少应覆盖以下回归场景：

- 完整 F→Be→S 链可以被规范化；
- 缺少任一核心层时拒绝结果；
- CAD 规划摘要不携带重复的 `rationale`；
- 验收条件能映射到 BREP 测量 ID；
- 未映射验收条件阻止修订晋级；
- 局部尺寸修改复用概念链且不重建无关零件；
- 自动修复不能改变受保护的功能尺寸和装配语义。

## 9. 已知边界

- FBS 链提高意图可追溯性，但不保证生成方案天然正确；最终准确性取决于输入规格、CAD 构建器和验证覆盖率。
- 未提供明确工程规格时，FBS 只能保留假设，不能替代型号、载荷、材料和制造约束。
- 纯定性条件无法由 BREP 数值测量直接证明，应标记为未验证，或接入对应仿真/试验检查器。
- latent/VAE 只提供结构模式和失败模式参考，不是 FBS 的权威来源，也不得覆盖用户明确要求。

## 10. 理论来源与工程化差异

本实现参考 Chen 等人在 *Toward Controllable Generative Design: A Conceptual Design Generation Approach Leveraging the Function–Behavior–Structure Ontology and Large Language Models* 中提出的 FBS 引导概念生成思路（*Journal of Mechanical Design*, 2024, 146(12), DOI: [10.1115/1.4065562](https://doi.org/10.1115/1.4065562)）。

论文侧重以 FBS 分阶段支持可控概念生成；AI-CAD 的工程实现将其收敛为一次统一的 Concept-CAD 合同，并增加稳定 ID、BREP 测量映射、修订门禁和自动修复闭环。上述机制是本项目的工程扩展，不应被表述为论文原有实现。
