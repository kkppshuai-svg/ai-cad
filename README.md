# AI-CAD 参数化建模工作台

AI-CAD 是面向工程研发的本地参数化 CAD 工作台。它将文字或参考图转换为统一的 Concept-CAD 合同和稳定特征计划，通过 CadQuery/OpenCascade 构建 BREP，并在修订晋级前执行几何、尺寸、拓扑、装配约束、干涉、基础制造性及 STEP round-trip 验证。

> **项目状态：工程研发阶段。** 当前重点是零件建模准确性、验证覆盖率和自动修复闭环；系统输出不能替代工程师签核、载荷计算、FEA/CAM、材料验证或样件试制。

## 核心能力

- 对话式新建设计与基于稳定特征 ID 的局部修改；
- FBS（需求→功能→行为→结构）与 CAD 规划统一生成，避免重复语义；
- CadQuery 参数化特征树及 STEP、STL、GLB、FCStd 工程产物；
- OpenCascade BREP 检查、Shape Healing、几何事实提取和 STEP 回归验证；
- 尺寸偏差、零件干涉、约束冲突及基础制造风险检查；
- 确定性局部修复与 AI 最小范围修复，修复后自动重建并复验；
- 修订历史、失败候选保留、版本回退和审查证据归档；
- Codex 或 DeepSeek 规划入口，以及可控的回退策略；
- BREP latent/VAE 样本积累、检索和训练管线；
- step.parts 标准件搜索、下载、校验和缓存。

## 系统主链

```text
需求/参考图
  → 统一 Concept-CAD 规划（FBS + 参数化 CAD）
  → CadQuery/OpenCascade 构建 BREP
  → 多层验证与审查
  → 自动修复、重建、复验
  → 成功修订晋级
  → STEP / FCStd / STL / GLB / 验证报告
```

`feature-plan.json` 是设计权威源；导出文件与验证报告均由成功修订生成。普通请求默认建一个准确零件，只有用户明确要求时才创建多零件装配。

## 工程示例

<table>
  <tr>
    <th>渐开线正齿轮啮合</th>
    <th>行星减速机</th>
    <th>谐波减速机</th>
  </tr>
  <tr>
    <td><a href="docs/assets/examples/spur-gear-meshing.png"><img src="docs/assets/examples/spur-gear-meshing.png" alt="AI-CAD 渐开线正齿轮啮合示例" width="100%"></a></td>
    <td><a href="docs/assets/examples/planetary-reducer.png"><img src="docs/assets/examples/planetary-reducer.png" alt="AI-CAD 行星减速机示例" width="100%"></a></td>
    <td><a href="docs/assets/examples/harmonic-reducer.png"><img src="docs/assets/examples/harmonic-reducer.png" alt="AI-CAD 谐波减速机示例" width="100%"></a></td>
  </tr>
</table>

这些截图用于展示参数化齿轮、复杂多零件装配和工程预览能力，不代表模型已经完成载荷、寿命、传动精度或制造认证。完整说明见 [工程示例](docs/examples.md)。

## 快速开始

环境要求：Ubuntu 22.04 或兼容 Linux、Node.js 20+、Python 3 venv、可用的 Codex CLI。FreeCAD 为可选依赖。

```bash
git clone https://github.com/kkppshuai-svg/ai-cad.git
cd ai-cad
npm install
chmod +x scripts/setup_cadquery_env.sh launch-ai-cad.sh stop-ai-cad.sh
./scripts/setup_cadquery_env.sh
./launch-ai-cad.sh
```

浏览器打开 `http://127.0.0.1:3101`。停止服务：

```bash
./stop-ai-cad.sh
```

安装完成后建议先运行：

```bash
agents/aicad/scripts/check_agent_env.sh
npm run check
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档中心](docs/README.md) | 文档范围、阅读顺序和状态 |
| [安装与运行](docs/getting-started.md) | 环境要求、安装、启动和首次验证 |
| [系统架构](docs/architecture.md) | 模块边界、数据流、权威数据和运行时目录 |
| [配置参考](docs/configuration.md) | 服务、模型、超时、搜索、存储和安全配置 |
| [HTTP API](docs/api.md) | 本机 API、令牌、路由、状态码和 SSE |
| [验证与自动修复](docs/validation-and-repair.md) | 六层 BREP 审查、修订门禁和修复策略 |
| [工程示例](docs/examples.md) | 齿轮啮合、行星减速机和谐波减速机截图 |
| [FBS 系统规范](docs/fbs-system.md) | Concept-CAD 合同、FBS 边界和验收映射 |
| [参数化编辑](docs/parametric-editing.md) | 特征 schema、局部编辑和约束规则 |
| [开发与测试](docs/development.md) | 代码结构、测试、训练与提交要求 |
| [迁移说明](MIGRATION.md) | 新机器部署与运行数据迁移 |

交互式架构图在服务启动后访问 `http://127.0.0.1:3101/architecture.html`。

## 常用命令

```bash
npm start                         # 前台启动
npm run dev                       # Node watch 模式
npm run check                     # 完整静态检查与回归测试
npm run test:validation-repair    # 验证/修复循环测试
npm run train:10                  # 10 组样本回归
npm run train:30                  # 30 组样本回归
npm run train:50                  # 50 组样本回归
```

## 数据与产物

以下目录是运行数据，不应提交到 Git：

- `assemblies/`：构建、修订、验证和导出产物；
- `workspace/`：上传图片、latent 运行数据和临时状态；
- `renders/`：渲染结果；
- `logs/`：服务日志；
- `standard-parts-cache/`：标准件缓存；
- `aicad建模反馈/`、`aicad训练记录/`、`aicad人工评分/`：本地研发记录。

密钥只写入被 Git 忽略的 `.env.local`。不要提交 API key、个人路径、训练数据集或生成模型。
