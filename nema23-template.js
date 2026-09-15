export function buildNema23LBracketPlan(message = "") {
  const text = String(message || "").toLowerCase();
  if (!/nema\s*23|nema23/.test(text) || !/(l型|l\s*-?型|l[- ]?bracket|安装支架|motor bracket)/i.test(text)) return null;

  const id = "nema23_l_motor_bracket";
  const node = (suffix, type, name, dependsOn, params, selector) => ({
    id: `${id}.${suffix}`,
    type,
    enabled: true,
    dependsOn,
    params,
    ...(name ? { name } : {}),
    ...(selector ? { selector } : {})
  });
  const feature = (suffix, type, name, params, tags) => node(suffix, type, name, [`${id}.vertical_plate.01`], params, { kind: "feature", tags });
  const dimension = (suffix, name, label, value, dependsOn = []) => node(suffix, "dimension", label, dependsOn, { name, value });

  return {
    reply: "已使用确定性 NEMA23 L 型支架模板生成，所有孔、槽、板厚和验收尺寸均保留为可编辑参数。",
    name: "nema23-l",
    parts: [{
      id,
      name: "NEMA23一体式L型电机安装支架",
      role: "承载 NEMA23 电机并通过底板平行调节槽实现安装位置调整的单一实体支架",
      mode: "generated",
      requireSingleSolid: true,
      featureTree: [
        node("base.01", "base_box", "底板基础实体", [], { size: [120, 80, 8], center: true }, { kind: "feature", tags: ["base", "bottom-plate"] }),
        node("vertical_plate.01", "add_primitive", "垂直立板", [`${id}.base.01`], { primitive: { type: "box", size: [8, 80, 80], center: true, pose: { translate: [-56, 0, 44], rotate: [0, 0, 0] } } }, { kind: "feature", tags: ["vertical-plate", "motor-mount"] }),
        feature("center_hole.01", "hole", "立板中心通孔", { diameter: 38.1, depth: 12, axis: "x", center: [-56, 0, 48] }, ["motor-clearance", "center-hole"]),
        feature("motor_hole.01", "hole", "电机安装孔左下", { diameter: 5.5, depth: 12, axis: "x", center: [-56, -23.57, 24.43] }, ["motor-mounting", "index:1"]),
        feature("motor_hole.02", "hole", "电机安装孔右下", { diameter: 5.5, depth: 12, axis: "x", center: [-56, 23.57, 24.43] }, ["motor-mounting", "index:2"]),
        feature("motor_hole.03", "hole", "电机安装孔左上", { diameter: 5.5, depth: 12, axis: "x", center: [-56, -23.57, 71.57] }, ["motor-mounting", "index:3"]),
        feature("motor_hole.04", "hole", "电机安装孔右上", { diameter: 5.5, depth: 12, axis: "x", center: [-56, 23.57, 71.57] }, ["motor-mounting", "index:4"]),
        node("adjust_slot.01", "slot", "底板调节槽左侧", [`${id}.base.01`], { length: 40, width: 6.5, depth: 12, axis: "x", center: [0, -25, 0] }, { kind: "feature", tags: ["base-adjustment", "parallel-slot", "index:1"] }),
        node("adjust_slot.02", "slot", "底板调节槽右侧", [`${id}.base.01`], { length: 40, width: 6.5, depth: 12, axis: "x", center: [0, 25, 0] }, { kind: "feature", tags: ["base-adjustment", "parallel-slot", "index:2"] }),
        dimension("dimension.01", "baseLength", "底板长度", 120),
        dimension("dimension.02", "baseWidth", "底板宽度", 80),
        dimension("dimension.03", "baseThickness", "底板厚度", 8),
        dimension("dimension.04", "plateWidth", "立板宽度", 80),
        dimension("dimension.05", "plateHeight", "立板高度", 80),
        dimension("dimension.06", "plateThickness", "立板厚度", 8),
        dimension("dimension.07", "centerHoleDiameter", "中心孔直径", 38.1, [`${id}.center_hole.01`]),
        dimension("dimension.08", "motorHoleDiameter", "电机安装孔直径", 5.5, [`${id}.motor_hole.01`, `${id}.motor_hole.02`, `${id}.motor_hole.03`, `${id}.motor_hole.04`]),
        dimension("dimension.09", "motorPitchHorizontal", "电机安装孔水平孔距", 47.14, [`${id}.motor_hole.01`, `${id}.motor_hole.02`]),
        dimension("dimension.10", "motorPitchVertical", "电机安装孔垂直孔距", 47.14, [`${id}.motor_hole.01`, `${id}.motor_hole.03`]),
        dimension("dimension.11", "adjustSlotLength", "调节槽长度", 40, [`${id}.adjust_slot.01`, `${id}.adjust_slot.02`]),
        dimension("dimension.12", "adjustSlotWidth", "调节槽宽度", 6.5, [`${id}.adjust_slot.01`, `${id}.adjust_slot.02`]),
        dimension("dimension.13", "adjustSlotCenterDistance", "调节槽中心距", 50, [`${id}.adjust_slot.01`, `${id}.adjust_slot.02`])
      ],
      measurements: [
        { id: `${id}.overall_length`, label: "支架底板总长", kind: "bbox", axis: "x", target: 120, tolerance: 0.1, unit: "mm" },
        { id: `${id}.overall_width`, label: "支架总宽", kind: "bbox", axis: "y", target: 80, tolerance: 0.1, unit: "mm" },
        { id: `${id}.overall_height`, label: "支架总高", kind: "bbox", axis: "z", target: 88, tolerance: 0.1, unit: "mm" }
      ],
      pose: { translate: [0, 0, 0], rotate: [0, 0, 0] }
    }],
    relations: [],
    joints: [],
    constraints: [],
    activePartId: id
  };
}
