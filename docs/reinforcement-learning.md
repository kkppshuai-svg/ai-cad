# CAD 强化学习：让验证反馈更新编辑策略

现有人工评分用于归档与筛选样本，VAE 用于表示与检索；两者不会根据一次尺寸编辑的后果更新下一步动作。这个模块训练的是 **参数编辑策略**，不训练或替换 Codex／DeepSeek，也不训练验收模型本身。

## 训练环境

1. **状态**：当前形体的 BRep 测量证据、挠度和应力的最坏工况／限值之比、可编辑尺寸范围、剩余步数、已找到的合格方案。
2. **动作**：梁宽或厚度增减一个获准的步长，或停止并保留已核查通过的最轻方案。长度、载荷、材料、包络和验收限值均不允许改动。
3. **反馈**：新候选通过仓库的 `cadquery_build.build_part` 在 CadQuery/OpenCascade 重建为实体，再由 `engineering_verification.evaluate` 读取 BRep 事实并执行真实的梁公式检查。未通过时少量奖励缩小超限；找到通过方案时增加奖励；之后节省体积增加奖励，每次编辑有小成本。相同任务下重访同一候选可以复用报告，不能把不同工况合并为同一验收证据。
4. **学习**：epsilon-greedy 探索，用半梯度 Q-learning 将 TD 误差写入特征—动作权重。checkpoint 保存权重和训练记录；下一轮可以加载权重继续学习。冻结评估和候选导出均不更新权重。

策略不参与判定合格。只输出原验收器判为 `pass` 的候选；证据不足不会改写为通过。缺载荷、超出验证模型适用范围、缺少适用的物理试验等情况会阻止继续探索。尺寸引起的数值区间跨限时，允许继续尝试新的尺寸，但那次 `hold` 仍不是合格候选。候选导出不写工作台当前修订，也不等同于完整构建流程、STEP 往返或工业验收。

## 复现训练、评估和建议

先按仓库说明安装 CadQuery 环境，再用同一解释器运行；不需要 GPU、PyTorch 或 API Key。Linux/macOS 的解释器通常为 `./.venv-cadquery/bin/python`，Windows 通常为 `.\.venv-cadquery\Scripts\python.exe`。以下假定 `python` 已指向该环境，从仓库根目录运行：

```bash
python scripts/cad_rl.py train --out workspace/rl/policy.json
python scripts/cad_rl.py evaluate --model workspace/rl/policy.json --out workspace/rl/benchmark.json
python scripts/cad_rl.py suggest --model workspace/rl/policy.json --input examples/rl-cantilever.json --out workspace/rl/suggestion.json
```

`suggest` 支持一根沿 XYZ 放置的实心矩形悬臂梁（单 `box` primitive 或单 `base_box` 特征），不支持孔、进口／复用 STEP 或装配。按 [示例输入](../examples/rl-cantilever.json) 提供原有 `plan.engineeringVerification`（包络、挠度、应力）及 `search` 中可授权改变的宽度／厚度网格。初始尺寸必须落在各自网格上。输出保留原件报告、逐步动作及候选计划和验证报告；没有合格候选时输出 `candidate: null`，退出码为 2。应先审阅候选，再进入原生构建和修订流程。

可用自定义任务继续训练。`--task-file` 接受单个任务或任务数组；`--tasks 0` 表示本轮不掺入内置算例。`--resume` 和 `--out` 应指向不同文件，以便回退。

```bash
python scripts/cad_rl.py train --resume workspace/rl/policy.json --tasks 0 --task-file examples/rl-cantilever.json --episodes 200 --out workspace/rl/policy-v2.json
```

继续训练可能过拟合；用于验收的实际任务必须另行保留，不能先用于训练再用来宣称泛化。对含自定义任务的 checkpoint，内置评估会明确报告无法保证训练与测试集天然隔离。

## 内置对照实验

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
