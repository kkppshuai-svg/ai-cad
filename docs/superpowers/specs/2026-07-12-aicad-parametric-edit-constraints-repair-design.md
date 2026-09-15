# AI-CAD 参数化编辑、装配约束与自动修复设计

## 目标

把当前“生成几何文件”的 AI-CAD 升级为以参数化计划为源的可持续编辑系统。生成后的孔、圆角、拉伸、阵列、尺寸和装配约束必须保留稳定身份；用户可以通过对话准确修改局部特征，只重建受影响零件，并在交付前自动完成几何、约束、干涉和基础可制造性验证。

## 核心决策

`feature-plan.json` 是唯一权威源文件。STEP、STL、GLB、FCStd 和验证报告均为可重新生成的派生物。FreeCAD 文件继续作为可编辑交付格式，但 AI-CAD 不依赖 FreeCAD GUI 历史树反向推导参数。

每次成功构建保存一个不可变计划修订。局部修改以结构化 patch 应用到上一修订，保留修改前后版本、受影响节点和重建结果，从而支持撤销、审计和失败回滚。

## 参数化特征树

每个零件包含有序 `featureTree`。树节点使用稳定 ID，显式记录类型、参数、依赖、启用状态和选择器。旧版 `primitives` 与 `features` 在读入时迁移为树节点，输出继续保留兼容字段直到前端与样本库完成迁移。

第一阶段支持以下节点：

- `base_box`、`base_cylinder`、`base_cone`、`base_sphere`：基础实体。
- `add_extrude`、`cut_extrude`：参数化草图轮廓及拉伸深度。
- `hole`、`slot`、`cut_box`、`add_primitive`：现有布尔特征的稳定 ID 版本。
- `linear_pattern`、`circular_pattern`：引用一个源特征，按数量、间距或角度展开。
- `fillet`、`chamfer`：通过命名选择器定位边，不再无条件处理全部边。
- `dimension`：具名尺寸参数，可被其他节点通过 `$参数名` 引用。

节点示例：

```json
{
  "id": "bracket.hole.mount.03",
  "name": "第三个安装孔",
  "type": "hole",
  "enabled": true,
  "dependsOn": ["bracket.base"],
  "params": {
    "diameter": 6,
    "depth": 12,
    "axis": "z",
    "center": [20, 0, 0]
  },
  "selector": { "kind": "feature", "tags": ["mounting", "hole", "index:3"] }
}
```

构建器按依赖关系进行稳定拓扑排序。缺失依赖、循环依赖、重复 ID、非法参数和失效选择器在几何计算前被拒绝。每个节点产生单独的构建状态，失败报告必须包含零件 ID、节点 ID、操作类型和内核错误。

## 局部修改与增量重建

对话规划器不再默认返回完整替换计划。若存在上一版本，它首先返回 `editPatch`：

```json
{
  "baseRevision": "rev-0004",
  "operations": [
    {
      "op": "set_param",
      "partId": "left_bracket",
      "featureId": "bracket.hole.mount.03",
      "path": "params.diameter",
      "value": 8
    }
  ]
}
```

支持 `set_param`、`add_feature`、`remove_feature`、`enable_feature`、`disable_feature`、`set_part_pose`、`set_constraint` 和 `remove_constraint`。patch 应用前验证 base revision 和目标唯一性；“第三个孔”通过名称、类型、标签、序号和当前活动零件组合解析，歧义时不修改并返回候选列表。

依赖图计算受影响集合。修改尺寸或特征时，只重建目标零件以及依赖该零件定位或约束的装配派生物；未受影响零件沿用上一修订的 STEP/STL/GLB。装配 STEP、FCStd、约束清单和验证报告重新汇总，但不重新执行无关零件的几何构建。

失败 patch 不覆盖当前成功修订。系统保存失败报告，继续向用户展示上一个可用装配。

## 装配约束系统

装配约束从当前 joints/relations 扩展为稳定 ID 的 `constraints`：

- `fixed`：锁定零件六个自由度。
- `coincident`：点、轴或平面重合。
- `concentric`：两圆柱轴同轴。
- `distance`：沿指定方向保持距离。
- `angle`：两轴或两平面保持角度。
- `revolute`：保留单一旋转自由度和角度限制。
- `slider`：保留单一平移自由度和行程限制。
- `gear`：两个旋转自由度按齿数比或显式 ratio 联动。

每个约束引用零件局部 datum，而非不稳定的临时拓扑编号。datum 可来自特征中心轴、草图平面、命名面、零件原点或显式坐标系。构建器输出解析后的世界坐标 datum，FreeCAD 桥复用相同约束数据。

约束分析器建立刚体自由度模型，报告：

- 每个零件的剩余平移/旋转自由度。
- 未固定的装配根。
- 重复、冲突或无法解析的约束。
- 齿轮环路中的比例矛盾。
- slider/revolute 的轴向和 limit 合法性。

第一阶段求解目标是验证和确定性定位，不替代完整商业 CAD 数值求解器。已给定 pose 作为初值；可解析的 coincident、concentric、distance 和 angle 产生确定性修正，无法唯一求解时保留初值并报告剩余自由度。

## 自动验证与修复

验证分为四层，并输出 `validation-report.json`：

1. 计划验证：ID、引用、依赖环、尺寸范围、约束完整性。
2. 零件 BREP 验证：实体数量、有效性、闭合性、正体积、开壳、零厚度嫌疑、布尔或选择器失败。
3. 装配验证：零件包围盒快速筛选后进行精确相交体积计算，区分预期接触和实体干涉；同时报告自由度和约束冲突。
4. 基础可制造性规则：最小壁厚、孔到边距离、过小圆角、封闭不可达腔体和用户指定工艺规则。没有材料与工艺信息时只标记风险，不宣称可制造。

修复器只执行白名单中的确定性安全修复：

- 减小导致失败的圆角或倒角，按二分搜索寻找可用值。
- 延长未完全贯穿的切削工具。
- 将接近零的非法尺寸提升到配置的最小正值。
- 对布尔结果执行 `clean()`，并重试一次。
- 禁用单个失败的装饰性 finish 特征，同时在报告中保留警告。

修复不得静默改变功能尺寸、孔中心、装配基准、约束类型或零件数量。需要语义判断的问题生成 `repairProposal`，由对话模型基于完整错误上下文产生 patch，再走同一验证管线；验证失败则回滚。

## 数据流

1. 新建请求由规划器生成完整参数化计划；修改请求生成 edit patch。
2. 服务端规范化并校验计划或 patch，生成候选修订。
3. 依赖分析器计算受影响零件和装配派生物。
4. CadQuery 构建器逐节点构建受影响零件并记录节点结果。
5. 约束分析器解析 datum、计算定位、自由度和冲突。
6. 验证器执行 BREP、干涉与可制造性检查。
7. 安全修复器针对允许的问题重试；其余问题交给 AI 生成 repair patch。
8. 全部强制检查通过后原子提升候选修订为当前版本，并更新 STEP/GLB/FCStd。

## API 与界面

新增接口：

- `POST /api/assembly/:id/edit`：接收自然语言或结构化 patch，创建候选修订。
- `GET /api/assembly/:id/revisions`：列出修订、状态和修改摘要。
- `POST /api/assembly/:id/revert`：回到指定成功修订。
- `GET /api/assembly/:id/feature-tree`：返回参数化树、节点状态和 datum。
- `GET /api/assembly/:id/validation`：返回验证与修复报告。

现有聊天入口在存在当前装配时自动走 edit 接口。前端零件列表增加特征树和状态标记；验证区按 error/warning/info 展示问题、自动修复动作和剩余自由度。用户选择零件或特征后，对话解析优先使用当前选择作为定位上下文。

## 文件与模块边界

- `parametric-plan.js`：schema 迁移、稳定 ID、参数解析和依赖图。
- `parametric-edit.js`：目标解析、patch 校验、应用、diff 和受影响集合。
- `assembly-constraints.js`：datum 解析、约束规范化、自由度和冲突分析。
- `cad-validation.js`：计划级与装配级报告合并、修复策略和门禁。
- `scripts/cadquery_build.py`：节点级几何构建、BREP 检查、精确干涉和构建追踪。
- `server.js`：修订生命周期、API 编排和原子发布，不承载领域算法。
- `public/app.js`：特征树、修订、验证状态和局部修改交互。

## 错误处理与一致性

候选修订写入独立目录。构建和验证完成前，不修改当前修订指针。进程中断后，未完成候选标记为 `abandoned`；现有成功产物保持可用。所有报告包含 schema version、assembly ID、revision ID、输入计划 checksum 和生成时间。

缓存键由零件规范化树、构建器版本和标准件 checksum 组成，防止复用过期几何。修改装配约束但不修改零件几何时，零件缓存全部复用。

## 测试与验收

必须覆盖以下行为：

- 旧计划迁移后每个节点具有稳定且可重复的 ID。
- 修改“第三个孔直径为 8 mm”只改变对应节点，并只重建该零件。
- “只加厚左支架”修改目标基础尺寸，不影响右支架文件 checksum。
- 线性和圆周阵列可编辑数量、间距和角度，并生成预期实体。
- 圆角通过命名选择器执行；选择器失效时明确失败，不回退到全部边。
- 同轴、重合、距离、角度、齿轮和滑轨约束能够规范化并产生自由度报告。
- 冲突约束、齿轮比例环路和装配干涉被报告。
- 无效实体、开壳、非正体积、布尔失败和零厚度嫌疑阻止发布。
- 安全圆角降级修复留下审计记录；功能尺寸不会被静默改变。
- patch 或修复失败后当前成功修订及其下载链接保持不变。
- STEP、GLB、FCStd 和约束清单与当前修订 checksum 一致。

最终验证包括单元测试、API 集成测试、CadQuery 实际几何测试、FreeCAD FCStd 对象检查、一个多零件装配的精确干涉测试，以及 CAD Explorer 人工复核链接。

## 非目标

本阶段不实现完整草图二维约束求解器、任意 NURBS 历史编辑、商业 CAD 级拓扑命名证明、CAM 刀路、FEA 或安全认证。系统会保留扩展点，但不会用近似结果冒充这些能力。
