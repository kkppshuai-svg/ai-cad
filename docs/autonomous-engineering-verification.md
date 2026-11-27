# 自主工程验证

AI-CAD 从用户消息提取验收目标、限值与工况，并把任务关联到相应的 FBS 行为和验收条目。调用方也可以在 CadQuery 请求中显式提交 `engineeringVerification` 来指定本次验收条件。系统从本次构建的 BRep 读取尺寸，按要求使用计算或试验记录，随几何审查一起返回逐项证据。几何和工程验收均通过时，候选可以成为当前修订。证据不足时保留候选和下一步动作。

## 从 FBS 运行验证

选择 CadQuery，在对话里写明设计规格和验收要求。系统会把受支持的目标转为包络、应力或挠度检查，关联相应的 FBS 来源。在统一审查中查看方法、实测或计算值、结论和要补充的条件。

包络示例

> 生成一个支架，XYZ 包络上限 130 × 90 × 100 mm。

矩形悬臂梁示例

> 生成一个 120 × 24 × 8 mm 实心矩形悬臂梁，长宽厚沿 X/Y/Z。悬臂梁的挠度要尽量小。

当初次候选因缺少工况或限值待确认时，在同一对话里补充验收要求。系统沿用已保存的候选特征计划复验。

> 补充验收：一端理想固支，自由端沿 Z 方向施加 20 N 静载，弹性模量 70 GPa，最大允许挠度 0.25 mm。

试验验收可通过下述结构化接口提交。[FBS 概念设计系统](fbs-system.md)

## 指定工程验收合同

向 `POST /api/chat` 提交以下请求。请求令牌见 [HTTP API](api.md)。

```json
{
  "message": "生成一个 120 × 20 × 8 mm 的实心矩形悬臂梁，长、宽、厚分别沿 X、Y、Z，无孔无圆角。",
  "engineeringVerification": {
    "requirements": [
      { "id": "envelope", "kind": "envelope", "maxMm": [130, 25, 10] }
    ]
  }
}
```

读取响应中的 `assembly.validation.engineeringVerification`。子报告的 `decision` 为 `pass`（通过）、`fail`（不通过）或 `hold`（待确认）。`verification.claims` 和 `validation.claims` 按需求记录证据、原因与下一步。上述请求仅声明包络要求，使用确认的状态为 `not_requested`。

目前包络与梁计算适用于沿坐标轴建模的单个实体。依赖导入 STEP 或外部标准件的候选会返回待确认，需要补充可核对的工件与版本证据。

- `envelope.maxMm` 指定 X、Y、Z 三轴尺寸上限，单位 mm。
- `outside_width` 的 `minMm` 和 `maxMm` 约束单实体沿 Y 的**整体外宽**。孔距、局部夹持宽度、公差叠加和装配干涉需要各自的几何或试验证据。
- `deflection` 可指定 `minMm` 和 `maxMm` 作为工作挠度幅值范围。所有工况均在范围内才通过，预测区间完全落在范围外时失败，部分重合时待确认。`targetMm` 是允许范围内的优选值，可用于给合格候选排序。结构化 `loadCase.direction` 支持 `Z`、`+Z`、`-Z`，省略时沿用原模型的 Z 轴约定。
- 对话可写“整体安装外宽范围 20 至 26 mm。工作挠度范围 0.14 至 0.21 mm，目标工作挠度 0.165 mm。”并补充梁计算所需的工况。写“必须人工复核：装配后扳手能否伸入。”会在报告中保留原句和来源，结论为待确认。
- `deflection.maxMm` 或 `stress.maxMPa` 启用矩形悬臂梁计算。在同一 `engineeringVerification` 对象中提交 `loadCase`（`support: "ideal_clamp"`、`kind: "static_tip_force"`、`forceN`）与 `material.youngMPa`。力和弹性模量均可使用正数或 `[下界, 上界]`。
- `use_trial.maxMm` 要求实际用途试验。填写 `useContext` 的 `environment`、`forceN`、`fixture`、`materialId`。提交方核对试件与测量后，在 `trialEvidence` 提交记录，每条包含同样的四个工况字段、报告中的 `designDigest`、`method: "physical_trial"`、`id`、`source`、`measuredMm` 和 `uncertaintyMm`。

通过 `engineeringVerification` 显式提交的条件优先作为本次验收合同。修改已有模型时默认继承当前修订的条件。需要补充初次构建的试验记录时，可提交原条件及新增证据到 `/api/assembly/repair`，使用保留的特征计划复验。[修订和复验请求](api.md)

## 核查与确认

| 层次 | 要回答的问题 | 本原型的证据 |
| --- | --- | --- |
| 产品 Verification（核查） | 设计是否符合已规定的尺寸和计算验收要求？ | 从重建的 B-Rep 得到的包络尺寸，以及在规定假设下的挠度与应力区间 |
| 产品 Validation（确认） | 设计在预期环境、材料、装夹和载荷下，是否满足用户的使用需求？ | 与当前设计摘要和使用工况匹配的位移试验记录及测量区间 |
| 计算模型自身的 V&V | 计算程序是否正确实现模型？本次求解是否有足够精度？模型能否代表实际工况？ | 已知梁算例核对公式实现。求解误差与实际模型适用性仍需独立的验证工作 |

产品核查与使用确认分别出具结论。核查中通过的梁计算可以解释某个设计的预期行为。使用确认需要对应实际用途的证据。计算模型自身的验证与确认是另一层，涉及代码实现、特定求解的精度，以及数学模型对现实系统的代表性。 [NASA 产品实现手册](https://www.nasa.gov/reference/5-0-product-realization/) · [NASA-STD-7009B §4.2.3–4.2.5](https://standards.nasa.gov/sites/default/files/standards/NASA/B/1/NASA-STD-7009B-Final-3-5-2024.pdf)

## 原型的三个判断

1. **验证什么。** 每项任务有独立 ID、验收量和限值。系统把显式声明的需求或受支持的 FBS 目标映射到核查或确认。已识别的任务缺少适用方法或必要条件时输出 `hold`。
2. **如何验证。** 包络取自当前方案重建得到的实体。悬臂梁采用理想固支、沿 Z 方向的自由端静载、线弹性模型。原型要求均匀实心矩形截面，梁长沿 X，宽沿 Y，厚沿 Z。原型限定梁长至少为厚度的 10 倍，预测挠度上界不超过梁长的 5%。载荷和弹模的上下界通过公式传播，得到应力与挠度区间。 [MIT 端载悬臂梁算例](https://ocw.mit.edu/courses/1-050-solid-mechanics-fall-2004/fd4eff39aec922b8c07660006f40686e_pset04_11.pdf)
3. **证据是否足够。** 区间整体满足要求时，该项通过。区间整体超限时，该项不通过。跨越限值意味着需要缩小不确定度或提高设计裕量。试验还要匹配方案摘要、材料、环境、装夹与载荷。适用试验给出相反结论时，报告保留各记录和冲突，交由人工核对。

最终报告保留需求 ID、方法、证据、原因及下一步动作。任一需求有明确超限证据时，总结论为 `fail`。否则，有未解决的必需需求则为 `hold`，其余情况为 `pass`。报告中的试验来源和材料是提交方声明，原型检查记录匹配关系和区间，试验真实性与仪器校准仍由试验流程提供证据。

## 配对实验

20 个合成案例使用同一个 CAD 构建器和计算公式。每个案例在运行前由算例和故障设置给出预期结论，包括 2 个通过、4 个超限和 14 个证据不足。案例覆盖缺载荷、方法不适用、试验版本或工况不符、区间跨限值和试验相互矛盾。

| 方法 | 正确判定 | 误放行 | 正确暂停 | 可判定案例被暂停 |
| --- | ---: | ---: | ---: | ---: |
| 固定名义值检查，仅汇总已完成项 | 6/20 | 14 | 0/14 | 0/6 |
| 固定名义值检查，缺项即暂停 | 10/20 | 10 | 4/14 | 0/6 |
| 自主工程验证原型 | 20/20 | 0 | 14/14 | 0/6 |

相对缺项即暂停的基线，原型在 10 个案例中纠正了错误放行，同时保留了 2 个正确通过和 4 个正确拒绝。两个基线都能发现明确超限。这轮差异来自对已有结果的适用性、区间与冲突判断。案例由项目内部构造，试验记录均为合成数据，覆盖一个梁模型。结果衡量的是这些受控证据故障的处理，外部泛化与新增方法的贡献仍需独立评估。

## 相关研究与比较口径

Physics-in-the-Loop 已研究 CAD 智能体通过物理工具反馈修改方案。CADEngBench 已把几何、装配和仿真纳入 CAD 评估。Assurance 2.0 已研究如何用自动推理检查证据与主张的关系以及未解决的反证。AI-CAD 的实验问题是，在工具和输入相同的条件下，证据判断能否降低误放行，并保留对证据充分设计的判断能力。进一步比较需要盲评的工程案例和多种工况。 [Physics-in-the-Loop](https://arxiv.org/abs/2605.19717) · [CADEngBench](https://arxiv.org/abs/2608.09296) · [Assurance 2.0 自动语义分析](https://doi.org/10.1017/S1471068424000425)

## 复现离线实验

在已安装仓库 CadQuery 依赖的 Python 环境，从 AI-CAD 根目录运行。

```powershell
python -m unittest discover -s scripts -p test_engineering_verification.py -v
python -X utf8 scripts/benchmark_engineering_verification.py --out workspace/aev-benchmark/report.json
```

逐案报告含完整 `input`、预期结论和三种方法的逐项证据。可以提取其中一条输入，单独运行核查与确认。下面选取缺少试验记录的案例，预期退出码为 2。

```powershell
python -X utf8 -c "import json; from pathlib import Path; folder=Path('workspace/aev-benchmark'); records=json.loads((folder/'report.json').read_bytes())['records']; case=next(row['input'] for row in records if row['id']=='missing-use-trial'); (folder/'case.json').write_text(json.dumps(case), encoding='utf-8')"
python -X utf8 scripts/engineering_verification.py --input workspace/aev-benchmark/case.json --out workspace/aev-benchmark/decision.json
```

离线输入额外包含 `design`，使用单零件 AI-CAD 计划。离线记录的 `designDigest` 取自 CLI 输出，在线试验记录的摘要取自同一候选的构建报告。CLI 的 `pass`、`fail` 与 `hold` 分别返回 0、1、2。

要让策略根据核查反馈学习下一步改什么，而不是只评判给定方案，参见 [CAD 强化学习](reinforcement-learning.md)。
