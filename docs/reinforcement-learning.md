# CAD 强化学习：让验证反馈更新编辑策略

现有人工评分用于归档与筛选样本，VAE 用于表示与检索；两者不会根据一次尺寸编辑的后果更新下一步动作。这个模块训练的是 **参数编辑策略**，不训练或替换 Codex／DeepSeek，也不训练验收模型本身。

## 从优秀结构样本学习安装方案

`structure_rl.py` 读取仓库的带评分结构样本，从已构建、保留学习、100 分且无失败约束的单部件记录识别四安装孔和双调节槽。识别依据是结构特征、数量和用途描述。样本提供结构类型与来源 ID，毫米级布置由两个参数模板生成。可用 `--samples` 提供同一格式的 JSONL，用 `train --input` 加入自定义夹具任务。

每个任务是一次结构选择。策略在探索中试选四孔板或双槽板，依据实际构建结果更新该用途下的动作价值。两类方案都必须形成一个有效实体。直径 4 mm 的销沿 X 移动，其整个直线行程对应的扫掠体与板取交，检查穿透体积。两个行程端点分别检查外径 10 mm、内径 4.4 mm 垫圈环面覆盖实体的面积比例。两销位于左列，四销为方形布置。BRep 计算给出几何压紧面积和行程可达性，载荷下的抗滑、疲劳和紧固力另需证据。

```bash
python scripts/structure_rl.py train --out workspace/rl/mount-policy.json
python scripts/structure_rl.py evaluate --model workspace/rl/mount-policy.json --out workspace/rl/mount-results.json
python scripts/structure_rl.py suggest --model workspace/rl/mount-policy.json --input examples/rl-adjustable-mount.json --out workspace/rl/mount-candidate.json
```

默认训练执行 400 次奖励更新。用 4 种未见过的孔距各测试 4 种需求组合，在 16 个合成任务中，学习策略输出 12 个合格方案。另 4 个在两种候选结构下都无法满足要求，输出为空。固定使用任一模板均通过 8 个。这项实验测试了同类安装结构对新孔距的适配，任务中的销数、调节行程和压紧要求组合在训练时出现过。

## 梁尺寸训练环境

1. **状态**：当前形体的 BRep 测量证据、挠度和应力的最坏工况／限值之比、可编辑尺寸范围、剩余步数、已找到的合格方案。
2. 策略每次可增减一个获准的宽度或厚度步长，也可停止并返回迄今最符合目标的合格方案。
3. CadQuery/OpenCascade 重建实体，Verification 从 BRep 测量尺寸并计算工作载荷范围内的梁响应。缩小超限和首次满足全部要求可获得奖励，每次编辑有小成本。指定优选工作挠度时，后续奖励来自减小最不利工况对目标的偏差。合格方案误差相同时保留体积较小者。没有优选挠度的任务沿用节材目标。
4. **学习**：epsilon-greedy 探索，用半梯度 Q-learning 将 TD 误差写入特征—动作权重。checkpoint 保存权重和训练记录；下一轮可以加载权重继续学习。冻结评估和候选导出均不更新权重。

策略不参与判定合格。只输出原验收器判为 `pass` 的候选；证据不足不会改写为通过。缺载荷、超出验证模型适用范围、缺少适用的物理试验等情况会阻止继续探索。尺寸引起的数值区间跨限时，允许继续尝试新的尺寸，但那次 `hold` 仍不是合格候选。候选导出不写工作台当前修订，也不等同于完整构建流程、STEP 往返或工业验收。

## 复现训练、评估和建议

先按仓库说明安装 CadQuery 环境，再用同一解释器运行；不需要 GPU、PyTorch 或 API Key。Linux/macOS 的解释器通常为 `./.venv-cadquery/bin/python`，Windows 通常为 `.\.venv-cadquery\Scripts\python.exe`。以下假定 `python` 已指向该环境，从仓库根目录运行：

```bash
python scripts/cad_rl.py train --out workspace/rl/policy.json
python scripts/cad_rl.py evaluate --model workspace/rl/policy.json --out workspace/rl/benchmark.json
python scripts/cad_rl.py suggest --model workspace/rl/policy.json --input examples/rl-cantilever-fit.json --out workspace/rl/suggestion.json
```

`suggest` 支持一根沿 XYZ 放置的实心矩形悬臂梁（单 `box` primitive 或单 `base_box` 特征），不支持孔、进口／复用 STEP 或装配。按 [示例输入](../examples/rl-cantilever.json) 提供原有 `plan.engineeringVerification`（包络、挠度、应力）及 `search` 中可授权改变的宽度／厚度网格。初始尺寸必须落在各自网格上。输出保留原件报告、逐步动作及候选计划和验证报告；没有合格候选时输出 `candidate: null`，退出码为 2。应先审阅候选，再进入原生构建和修订流程。

可用自定义任务继续训练。`--task-file` 接受单个任务或任务数组；`--tasks 0` 表示本轮不掺入内置算例。`--resume` 和 `--out` 应指向不同文件，以便回退。

```bash
python scripts/cad_rl.py train --resume workspace/rl/policy.json --tasks 0 --task-file examples/rl-cantilever.json --episodes 200 --out workspace/rl/policy-v2.json
```

继续训练可能过拟合；用于验收的实际任务必须另行保留，不能先用于训练再用来宣称泛化。对含自定义任务的 checkpoint，内置评估会明确报告无法保证训练与测试集天然隔离。

## 内置对照实验

新训练默认使用 `fit` 算例。在包络和强度检查之外，每个任务有整体安装外宽范围、工作挠度范围和优选挠度。每个合格方案的目标误差取挠度预测区间两端到目标的最大绝对距离，除以允许区间宽度。多个优选目标同时存在时取最大的归一化误差。报告分别列出通过率以及通过案例的目标误差，配对指标仅统计双方均通过的案例。

种子 42、每案最多编辑 8 步，在相同的 120 个留出算例上，旧节材策略通过 65 个，按用途重新训练的策略通过 104 个，梁公式贪心法通过 111 个。两个学习策略采用同一套新验收条件。这组结果衡量矩形梁在所声明的安装和工作条件下的适配。

例如有弹性行程要求时，安装外宽必须处于 20–26 mm，挠度必须处于 0.14–0.21 mm，优选值为 0.165 mm。示例运行选出 120 × 22 × 8 mm，计算挠度范围为 0.1534–0.2077 mm。旧节材示例中的 120 × 16 × 10 mm 通过强度检查，但只有 16 mm 宽，不能用于这个安装位。[用途适配示例](../examples/rl-cantilever-fit.json)

### 复现第一版节材实验

在 `train` 和 `evaluate` 命令中指定 `--suite material` 可复现下表。旧 checkpoint 默认沿用原训练套件。

默认参数：固定随机种子，200 个训练任务运行 6,000 轮；另用 120 个测试任务，训练与测试的梁长网格及任务种子分离。每种策略每个任务最多改 8 步，初始候选也计入评估次数。对照中的物理贪心法使用现有计算结果与梁公式的比例关系预估下一步，不额外构建预估候选。

| 策略 | 找到通过候选 | 平均候选评估次数 | RL 在双方都通过的案例中平均节材 |
| --- | ---: | ---: | ---: |
| 不改初始尺寸 | 40/120 | 1.00 | 25.07% |
| 随机合法编辑 | 85/120 | 5.94 | 12.47% |
| 固定顺序编辑 | 117/120 | 7.92 | 6.19% |
| 梁公式贪心 | 117/120 | 4.36 | 2.20% |
| 已训练 Q 策略 | 117/120 | 5.33 | — |

默认运行更新了 34,667 次权重，实际评估了 4,212 个不同的任务–候选组合。用训练种子 `17`、`42`、`73` 在同一测试集复跑，RL 分别通过 `116`、`117`、`117` 个；在与物理贪心共同通过的案例上，分别平均节材 `0.95%`、`2.20%`、`1.24%`。相较贪心，RL 平均多评估了约一个候选，也并非每次都能匹配其通过率。三个种子仍共享同一类合成设计，同一材料下体积用作重量代理。这一实验没有证明优于专门优化器或网格穷举，也不代表对任意 CAD、装配干涉、有限元或实际载荷验证的泛化。

演示输入从 `120 × 22 × 6 mm` 不通过，得到 `120 × 16 × 10 mm` 通过候选。它是补强任务，因此不与不合格的初始件比较节材。

运行回归测试：

```bash
python -m unittest discover -s scripts -p test_cad_rl.py -v
```
