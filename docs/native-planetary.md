# 首个 NVIDIA 原生 BRep 装配实例

这是本项目首次将行星齿轮装配直接适配到 NVIDIA USD BRep / SMLib 的实验实例，不主张行业首创。太阳轮、三个行星轮、真实内齿圈、带三销的行星架分别保留为独立实体。

在工作台选择 NVIDIA USD BRep，点击“原生行星减速机 5:1”。也可读取 [`public/usd-planetary-5to1.json`](../public/usd-planetary-5to1.json)，向 `POST /api/preview` 提交 `{ "engine": "usd-brep", "plan": ... }`。请求需要当前工作台令牌。

| 参数 | 值 |
| --- | --- |
| 太阳轮 / 行星轮 / 内齿圈 | 24 / 36 / 96 齿 |
| 行星轮数量 | 3，120° 均布 |
| 模数 / 压力角 / 齿宽 | 2 mm / 20° / 10 mm |
| 中心距 | 60 mm |
| 每个齿轮的齿厚缩减或齿槽增宽 | 0.12 mm，非实测回差 |
| 运动假设 | 内齿圈固定，太阳轮输入，行星架输出 |
| 理论传动比 | 1 + 96 / 24 = 5 |
| 齿数关系 / 均布装配条件 | 96 = 24 + 2×36；(24+96)/3 = 40 |

## 几何通路

[`native_gears.py`](../scripts/native_gears.py)按渐开线公式计算齿面，每侧用 16 条原生直线近似，齿顶和齿根使用原生圆弧，随后由 `linear_sweep` 创建闭合实体。内齿圈以外圆和内齿空腔双轮廓拉伸生成。齿根过渡目前为径向直线，未生成刀具包络次摆线或齿根圆角。

24T 太阳轮的最大采样中点弦误差实测约 0.0021 mm；这是采样点的齿面离散误差指标，不是全曲线误差上界，也不是整机制造精度。USD 序列化容差与齿形近似误差分别记录，不能混用。

[`usd_brep_assembly.py`](../scripts/usd_brep_assembly.py)构建六个实体，检查闭合性、单实体和正体积，逐件导出及回读，再导出和回读整个装配，对比体积、实体数、包围盒和中心。实际报告中的 `cadqueryUsed: false` 表示该通路未调用 CadQuery/OpenCascade。首次实测构建与序列化约 20 秒，耗时受机器、采样密度和原生库版本影响。

产物：`native-solid.usda` 是原生 BRep；`native-mesh.usda` 和 `native-preview.stl` 用于显示。零件 ID 与单件 USD 文件绑定，装配中的原生 prim 命名由 NVIDIA 导出器生成。参数计划和构建报告保存在同一目录。

## 审查范围

闭合性和回读成功只证明实体及序列化检查通过。当前原生装配适配器将干涉状态标为 `unverified`，统一审查据此阻止装配通过；不能以六件实体均有效代替整体装配验证。运动啮合、接触、回差、强度、寿命和视觉审查仍需独立证据。该实例没有声称已配置可求解的运动约束。

独立实测：对首次导出的装配回读后，使用原生 `boolean_intersection` 检查三处太阳轮/行星轮和三处内齿圈/行星轮，六处交集均为零实体、零体积，耗时约 236 秒。记录与源 USD 的 SHA-256 绑定在本地产物目录的 `static-mesh-interference.json`。此记录只覆盖初始姿态的六处齿轮配对，不覆盖全部零件或连续运动，也不会自动授予后续修订通过状态。

测试：使用独立 NVIDIA Python 环境运行 `python -m unittest discover -s scripts -p test_native_gears.py -v`。

API 依据：[NVIDIA USD BRep Python API](https://nvidia-omniverse.github.io/usd-brep/latest/docs/python.html)。
