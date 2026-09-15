# 参数化编辑、装配约束与自动验证

AI-CAD 以 `feature-plan.json` 为权威源。STEP、STL、GLB、FCStd 和验证报告都由当前成功修订生成。每个零件和特征具有稳定 ID，修改失败时继续保留上一成功修订。VAE/latent 学习管线从高分结构和 BREP 几何描述中学习，但不会覆盖用户明确尺寸。

## 对话式局部修改

生成装配后可以直接继续输入：

- `把左支架的第三个孔改成 8 mm`
- `只把左支架厚度从 6 mm 改成 9 mm`
- `禁用右支架的外侧圆角`
- `把滑块行程改成 80 mm`

规划器优先返回结构化 `editPatch`：

```json
{
  "baseRevision": "rev-0004",
  "operations": [
    {
      "op": "set_param",
      "partId": "left_bracket",
      "featureId": "left_bracket.hole.03",
      "path": "params.diameter",
      "value": 8
    }
  ]
}
```

只有几何受影响的零件重新执行 CadQuery 特征树；纯位姿或装配约束修改会复用全部匹配的局部 STEP。其他零件只有在参数树校验和、构建策略校验和、构建器版本、标准件源文件校验和与本地 STEP 校验和全部匹配时才会复用。STEP、FCStd、约束清单和验证报告仍会重新汇总。

若“第三个孔”同时匹配多个零件，系统返回候选列表，不猜测目标。先在特征树中选择零件或特征可提供明确的对话上下文。

## 参数化特征树

当前节点类型：

- 基础实体：`base_box`、`base_cylinder`、`base_cone`、`base_sphere`、`base_spur_gear`
- 拉伸：`add_extrude`、`cut_extrude`
- 布尔特征：`hole`、`slot`、`cut_box`、`add_primitive`
- 阵列：`linear_pattern`、`circular_pattern`
- 修饰：`fillet`、`chamfer`
- 参数：`dimension`

树会在构建前检查重复 ID、缺失依赖、依赖环、非法尺寸、无源阵列和失效选择器。圆角与倒角必须使用命名或轴向选择器，不会在选择失败时退回“处理全部边”。

## 装配约束

支持：

- `fixed`
- `coincident`
- `concentric`
- `distance`
- `angle`
- `revolute`
- `slider`
- `gear`

约束引用零件 datum 或特征中心轴，并输出每个零件剩余的 `tx/ty/tz/rx/ry/rz` 自由度。系统会把 datum 转到世界坐标后检查重合、同轴、距离和角度残差，并报告缺失 datum、冲突距离、非法行程和齿轮比例环路。

FreeCAD 交付中，点重合、同轴和齿轮约束分别使用 Assembly 的 `Ball`、`Cylindrical` 和 `Gears` Joint；桥接器遇到未知 Joint 类型会明确失败，不会静默降级为 Fixed。

## 验证和自动修复

每个候选修订执行：

1. 参数计划和依赖验证。
2. BREP 有效性、闭合实体、正体积、开壳和零厚度嫌疑检查。
3. 包围盒筛选加精确相交体积的装配干涉检查。
4. 约束冲突与剩余自由度分析。
5. 最小壁厚、孔边距和过小圆角风险提示。

`intendedContacts` 只表达允许接触的设计意图，不能豁免正体积穿透；只要精确相交体积超过容差，候选仍会被阻止。

允许自动执行的安全修复：

- 减小或禁用失败的装饰性圆角/倒角。
- 延长未贯穿的切削深度。
- 对无效 BREP 执行 clean 后重试。
- 对明确标记为安全的非正参数执行最小正值钳制。

系统不会静默修改孔中心、功能孔径、约束类型或零件数量。这些问题会进入 AI repair proposal；对话路径会自动请求一次最小范围 AI 修复补丁，初次生成失败时也会把验证报告交给规划器生成修复后的完整计划，再重新验证。

## 修订接口

- `GET /api/assembly/:id/feature-tree`
- `GET /api/assembly/:id/revisions`
- `GET /api/assembly/:id/validation`
- `POST /api/assembly/:id/edit`
- `POST /api/assembly/:id/revert`

所有 POST 请求继续要求本机 `X-AI-CAD-Token`。同一装配的写操作会串行执行，并在发布时比较候选父修订与当前修订；过期编辑返回 409。失败候选标记为 `failed`，不会改变 `current.json`。回退前会校验目标修订的计划、验证状态和交付文件校验和，再一次性恢复内存状态与磁盘指针。

## 限制

当前自由度分析是确定性工程检查，不是商业 CAD 的完整非线性装配求解器。可制造性检查是风险提示；没有材料、工艺、刀具和公差信息时，不代表已经完成生产认证。
