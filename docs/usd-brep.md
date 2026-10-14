# NVIDIA USD BRep 接入

工作台现有两个独立的建模后端：CadQuery/OpenCascade 和 NVIDIA USD BRep/SMLib。
USD BRep 运行环境可用时作为默认主通道，CadQuery 保留并行验证；当前仍待用户验收。两者共用[统一 BRep + 视觉审查](unified-brep-review.md)。
英伟达后端直接调用 `usd_brep.create_box`、`create_cylinder`、`create_sphere`、`boolean_difference` 和 `boolean_union` 构建精确实体，不经过 CadQuery。
建模内核选择影响“刷新 3D 预览”和聊天发送。英伟达模式下，AI 只规划允许的零件特征，然后由独立 USD BRep Python 环境执行。
适配器目前支持盒体、圆柱、球体、合并、圆孔、方槽以及移动和旋转。不支持的特征会报错，不会自动转到 CadQuery。
复杂装配、齿轮、圆角、拉伸、模式阵列和标准件导入仍需选择现有 CadQuery 链路。

## 原生实体与双内核对比

点击“加载带孔板示例”，在英伟达模式下会直接生成精确 BRep，并提供“下载 USD 精确实体”、USD 网格和 STL 预览。
“查看构建代码”打开本次使用的 Python 建模适配器，精确实体和构建报告保存在同一模型目录。
原生实体经过闭合实体检查、正体积检查和 USD 导出/读取体积比较；这不是工作台原有的完整制造、装配与视觉验收。
英伟达后端当前不提供 STEP/FCStd 导出。

点击“双内核实测对比”会用同一份规范化特征计划分别创建两个 BRep。
表格展示体积、内核包围尺寸、面/边数、解析体积绝对误差（仅有明确解析公式的简单形体）、特征建模耗时和端到端耗时。
包围盒可能含容差扩展，不能直接解释成制造尺寸误差；两个内核体积接近也不能证明任意复杂模型都同样精确。
单次建模测量不是通用性能基准，端到端导出流程也不同。

对比用刚体约束可选“未约束”或“固定到世界”。显示的自由度由工作台同一个规则分析器推断，分别为 6 或 0。
该分析不是两个几何内核自带的草图求解器，也不是通用数值约束求解或雅可比秩验证。它不代表草图参数的剩余自由度。

接口：`POST /api/preview` 添加 `engine: "usd-brep"` 即可原生建模；`POST /api/usd/generate` 负责 AI 特征规划和原生构建；`POST /api/kernels/compare` 接收 `part` 或 `code`，以及可选 `constraintMode: "free" | "fixed"`。

## 已有模型的网格导出

CadQuery 模型完成建模后，也可点击“导出 USD 网格”，再点击“下载 USD 网格”。
可点击“加载带孔板示例”直接体验完整导出流程，不需要调用 AI 规划服务。

这条兼容导出链路：当前成功修订的 STL → USD Mesh → USD BRep PolyBrep → USD Mesh 导出 → 重新读取并比较三角面的坐标与方向。
输出为 `.usda`，单位声明 `metersPerUnit = 0.001`，向上轴为 Z。
它用于场景交换和可视化；不包含原始特征树、装配约束、零件名称与材料，也不恢复精确 NURBS 曲面。
CadQuery 的精确工程几何仍使用 STEP，不能把这条网格通道称为精确 BRep 转换。英伟达原生实体通道是另外独立构建的 BRep。

## 配置

使用独立 CPython 3.12 环境，安装 `requirements-usd-brep.txt`，然后在被 Git 忽略的 `.env.local` 中设置：

```dotenv
USD_BREP_PYTHON=/absolute/path/to/usd-brep/venv/bin/python
```

Windows 设置为该环境的 `Scripts/python.exe` 路径。独立运行子进程，避免与 CadQuery 的运行时 DLL 混用。
英文安装路径可避免 USD 插件的中文路径加载问题；导出器把原生 USD 文件操作放在临时目录，再使用 Python 写回中文项目目录。

`GET /api/status` 返回 `usdBrep.available`、版本与 `representation: "mesh"`。
未配置或无法加载时不显示导出按钮，现有建模功能仍可用。

`POST /api/usd/export` 使用现有请求令牌保护，请求示例：

```json
{"assemblyId":"your-assembly-id","revisionId":"current-revision-id"}
```

只允许导出完成的模型；修订变化返回 409；源文件限定为模型目录内的 STL，大小上限 100 MB。
响应包含 `usdUrl`、三角面数量、版本、单位和 `roundTrip`。`runtimeWarnings` 表示原生运行时打印了警告。
已安装的 wheel 可能打印未提供 pxr Python 模块的警告，几何导出是否成功由重新读取校验判断。

## 验证

```bash
node --test usd-brep-bridge.test.mjs runtime-process.test.mjs api-routes.test.mjs
python -m unittest discover -s scripts -p test_usd_brep_export.py
node --test kernel-comparison.test.mjs
# 使用独立的 USD BRep Python 环境：
python -m unittest discover -s scripts -p test_usd_brep_build.py
```

官方资料：https://github.com/NVIDIA-Omniverse/usd-brep
API：https://nvidia-omniverse.github.io/usd-brep/latest/docs/python.html
