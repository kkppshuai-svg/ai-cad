# AI CAD BREP VAE 与可编辑装配设计

## 目标

同时解决两个问题：让 latent 模型开始学习 STEP/BREP 的真实几何特征；让 FreeCAD 主交付文件中的每个逻辑零件成为可单独选择和继续直接建模编辑的对象。

## 根因

当前 `train_cad_vae.py` 实际执行 SVD/PCA，并非神经网络 VAE；输入只有稀疏文本 token 和 6 个质量/结构数字。24 条样本不足以直接训练大型 BREP 生成模型。

当前 FreeCAD 桥接脚本使用 `Import.insert()` 导入完整装配和逐零件 STEP。导入结果是一个或多个 `Part::Feature` 哑实体；复杂零件会被拆成多个对象。STEP 只能交换最终 BREP，不能恢复原始草图和特征历史。

## 可编辑装配方案

新增/升级 `ai_cad_assembly.FCStd` 的零件组织方式：

- 每个计划零件创建一个独立 `App::Part` 容器。
- 优先导入该零件的局部 STEP，而非已烘焙世界位姿的 STEP。
- 将导入产生的多个 shape 合并为一个逻辑 `Part::Feature`，作为容器内的 `Geometry` 对象。
- 位姿施加在零件容器上，保持局部几何和装配变换分离。
- 零件容器和 Geometry 保存 PartId、名称、角色、位姿 JSON、CadQuery 特征 JSON、局部 STEP 文件等属性。
- 约束引用新的 Geometry 对象；完整装配 STEP 继续作为隐藏参考。
- 用户可对每个 Geometry 使用 FreeCAD Part 布尔运算、切孔、拉伸、复制和移动。原始特征历史不会由 STEP 恢复，但源 JSON/Python 可用于重新生成。

验收要求：一个计划零件对应一个可见 Geometry；复杂多 solid 零件不再散落成多个顶层对象；容器 Placement 与计划 pose 一致；原 STEP/GLB/STL 输出不变。

## BREP 几何数据表示

新增固定长度几何描述向量，从 STEP 的 OpenCascade BREP 中提取：

- solid/shell/face/edge/vertex 数量；
- 包围盒尺寸、长宽高比例、体积、表面积、紧致度；
- 平面、圆柱面、圆锥面、球面、环面及其他曲面占比；
- 直线、圆、椭圆及其他曲线占比；
- 面积与边长的均值、标准差、最小值、最大值；
- 每个 face 的相邻 face 度数统计；
- 闭合性和有效性标记。

所有尺度特征以包围盒对角线或体积尺度归一化，使 latent 更关注形状而非绝对尺寸。提取失败的样本记录原因，不伪造全零几何。

## 真正的 VAE v2

实现轻量 NumPy MLP VAE，避免当前环境强制安装大型 GPU 框架：

- 输入：BREP 几何向量，可选拼接少量结构特征；
- 编码器：标准化输入 → hidden → `mu` 与 `logvar`；
- 重参数采样：`z = mu + exp(0.5 * logvar) * epsilon`；
- 解码器：latent → hidden → 重建几何向量；
- 损失：加权重建 MSE + beta KL；
- 训练：Adam、固定随机种子、训练/验证切分、早停；
- 输出：模型权重、标准化参数、每个样本的 `mu` latent、训练与验证指标。

查询时可以对指定 STEP 提取几何并编码，也可以对现有样本按 latent 距离检索。旧 `ai-cad-linear-vae-baseline-v1` 模型继续兼容，v2 使用新格式。

## 数据策略

本地 24 条样本只用于管线验证、微调和项目域检索。后续大规模训练导入 ABC STEP 或 DeepCAD 操作序列；先预训练几何编码器，再用本地 0/50/100 评分样本进行质量感知微调。BrepGen 作为长期研究方向，不纳入本轮直接训练。

## 文件变化

- `freecad-bridge.js`：生成一零件一容器/一 Geometry 的 FreeCAD 脚本。
- `scripts/extract_brep_geometry.py`：STEP → 几何向量与数据集。
- `scripts/train_brep_vae.py`：NumPy VAE v2 训练。
- `scripts/query_brep_vae.py`：STEP 编码与相似检索。
- `requirements-cadquery.txt`：继续依赖现有 CadQuery/OpenCascade/NumPy，不新增 GPU 强依赖。
- 对应 Python/Node 测试与 `npm run check` 集成。

## 验证

- 用包含多 solid 的真实装配生成 FCStd，FreeCADCmd 重新打开后检查容器数、Geometry 数、类型、solid 数和 Placement。
- 验证 Geometry 可被 FreeCAD Part cut/fuse 操作消费。
- 对至少若干现有 STEP 提取非零 BREP 向量。
- 训练 VAE v2，确认 KL 与重建损失有限、模型可保存/加载、同一 STEP 查询能命中自身。
- 运行全部既有测试，确保 STEP/STL/GLB、视觉审查和旧 latent 查询不回归。
