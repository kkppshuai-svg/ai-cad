#!/usr/bin/env python3
import json
import math
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ASSEMBLIES_DIR = ROOT / "assemblies"
FEEDBACK_DIR = Path(os.environ.get("AICAD_CONVERSATION_DIR", "/home/kkkk/桌面/aicad建模反馈"))
CADQUERY_PYTHON = Path(os.environ.get("CADQUERY_PYTHON", ROOT / ".venv-cadquery" / "bin" / "python"))
BUILDER = ROOT / "scripts" / "cadquery_build.py"


def pose(translate=None, rotate=None):
    return {
        "translate": translate or [0, 0, 0],
        "rotate": rotate or [0, 0, 0],
    }


def box(size, translate=None, rotate=None):
    return {"type": "box", "size": size, "center": True, "pose": pose(translate, rotate)}


def cyl(diameter, height, translate=None, rotate=None):
    return {
        "type": "cylinder",
        "diameter": diameter,
        "height": height,
        "center": True,
        "pose": pose(translate, rotate),
    }


def cone(radius1, radius2, height, translate=None, rotate=None):
    return {
        "type": "cone",
        "radius1": radius1,
        "radius2": radius2,
        "height": height,
        "center": True,
        "pose": pose(translate, rotate),
    }


def part(part_id, name, role, primitives, features=None, translate=None, rotate=None, inertial=None):
    item = {
        "id": part_id,
        "name": name,
        "role": role,
        "primitives": primitives,
        "features": features or [],
        "pose": pose(translate, rotate),
    }
    if inertial:
        item["inertial"] = inertial
    return item


def hole(center, diameter, axis="z", depth=200):
    return {"type": "hole", "center": center, "axis": axis, "diameter": diameter, "depth": depth}


def slot(center, length, width, axis="x", depth=200):
    return {"type": "slot", "center": center, "axis": axis, "length": length, "width": width, "depth": depth}


def cut_box(center, size, rotate=None):
    return {"type": "cut_box", "center": center, "size": size, "rotate": rotate or [0, 0, 0]}


def add_primitive(primitive):
    return {"type": "add", "primitive": primitive}


def chamfer(distance=1.0):
    return {"type": "chamfer", "distance": distance}


def fillet(radius=1.0):
    return {"type": "fillet", "radius": radius}


def inertial(mass):
    return {
        "mass": mass,
        "origin": {"xyz": [0, 0, 0], "rpy": [0, 0, 0]},
        "inertia": {"ixx": 0.001, "ixy": 0, "ixz": 0, "iyy": 0.001, "iyz": 0, "izz": 0.001},
    }


def plan(name, reply, parts, process, checks, relations=None, joints=None):
    return {
        "name": name,
        "reply": reply,
        "trainingProcess": process,
        "trainingChecks": checks,
        "parts": parts,
        "relations": relations or [],
        "joints": joints or [],
        "activePartId": parts[0]["id"],
    }


def bolt_pattern(radius, z, diameter=4.6):
    return [
        hole([radius, radius, z], diameter),
        hole([-radius, radius, z], diameter),
        hole([radius, -radius, z], diameter),
        hole([-radius, -radius, z], diameter),
    ]


def radial_teeth(count, radius, tooth_size, z=0):
    items = []
    for i in range(count):
        angle = 360 * i / count
        rad = math.radians(angle)
        items.append(add_primitive(box(
            tooth_size,
            [radius * math.cos(rad), radius * math.sin(rad), z],
            [0, 0, angle],
        )))
    return items


def cases():
    return [
        plan(
            "train01_fdm_motor_bracket",
            "FDM电机支架：M4通孔放大、底板加厚、孔口倒角。",
            [
                part("base_plate", "加厚底板", "承力安装底座", [box([92, 58, 6])],
                     bolt_pattern(33, 0, 4.7) + [slot([0, 0, 0], 42, 6, "x"), chamfer(0.8)]),
                part("motor_wall", "电机立板", "电机固定面", [box([58, 7, 54])],
                     [hole([0, 0, 0], 22, "y", 30)] + bolt_pattern(18, 0, 4.7) + [chamfer(0.8)],
                     [0, -22, 30]),
                part("left_rib", "左加强肋", "三角近似加强肋", [box([7, 28, 42], [0, 0, 0], [0, 35, 0])], [], [-24, -12, 22]),
                part("right_rib", "右加强肋", "三角近似加强肋", [box([7, 28, 42], [0, 0, 0], [0, -35, 0])], [], [24, -12, 22]),
            ],
            "fdm",
            ["M4 holes 4.7mm", "base thickness 6mm", "support ribs present"],
        ),
        plan(
            "train02_fdm_snap_lid_box",
            "FDM滑盖盒：滑配按单边约0.35mm预留，卡扣根部加厚。",
            [
                part("tray", "开口盒体", "滑盖盒体和导轨", [
                    box([96, 58, 5], [0, 0, -2.5]),
                    box([96, 4, 18], [0, -29, 6.5]),
                    box([96, 4, 18], [0, 29, 6.5]),
                    box([4, 58, 18], [-48, 0, 6.5]),
                    box([4, 58, 18], [48, 0, 6.5]),
                    box([88, 3, 3], [0, -24.8, 16]),
                    box([88, 3, 3], [0, 24.8, 16]),
                ], [hole([-35, 0, -2.5], 3.4), hole([35, 0, -2.5], 3.4), fillet(1.2)]),
                part("sliding_lid", "滑动盒盖", "带止退卡扣的滑盖", [
                    box([88.8, 49.2, 3]),
                    box([14, 2.4, 5], [30, -24.2, -1]),
                    box([14, 2.4, 5], [30, 24.2, -1]),
                ], [chamfer(0.6)], [0, 0, 20]),
            ],
            "fdm",
            ["slide clearance 0.35mm per side", "snap roots >=1.2mm"],
        ),
        plan(
            "train03_fdm_hinge",
            "FDM铰链：6mm轴配6.6mm孔，耳片厚度3mm以上。",
            [
                part("fixed_leaf", "固定叶片", "带双耳的铰链叶片", [
                    box([50, 30, 4]),
                    cyl(10, 30, [-25, 0, 5], [90, 0, 0]),
                    cyl(10, 30, [25, 0, 5], [90, 0, 0]),
                ], [hole([-25, 0, 5], 6.6, "y", 40), hole([25, 0, 5], 6.6, "y", 40), hole([-15, 0, 0], 4.5), hole([15, 0, 0], 4.5), chamfer(0.7)]),
                part("moving_leaf", "活动叶片", "中间铰链耳", [
                    box([45, 28, 4]),
                    cyl(9.6, 26, [0, 0, 5], [90, 0, 0]),
                ], [hole([0, 0, 5], 6.6, "y", 34), hole([-14, 0, 0], 4.5), hole([14, 0, 0], 4.5)], [0, 0, 14]),
                part("hinge_pin", "铰链轴", "6mm转轴", [cyl(6, 70, [0, 0, 0], [90, 0, 0])], [chamfer(0.5)], [0, 0, 5]),
            ],
            "fdm",
            ["pin hole = shaft +0.6mm", "hinge ear thickness >=3mm"],
            joints=[{"id": "hinge_revolute", "type": "revolute", "parent": "fixed_leaf", "child": "moving_leaf", "origin": {"xyz": [0, 0, 0.005], "rpy": [0, 0, 0]}, "axis": [0, 1, 0], "limit": {"lower": -1.57, "upper": 1.57, "effort": 1, "velocity": 1}}],
        ),
        plan(
            "train04_fdm_timing_pulley",
            "FDM同步轮近似件：齿顶宽度大于0.8mm，中心孔放量。",
            [
                part("pulley", "同步轮", "25齿近似皮带轮", [
                    cyl(28, 14),
                    cyl(34, 2.2, [0, 0, -7.2]),
                    cyl(34, 2.2, [0, 0, 7.2]),
                ], [hole([0, 0, 0], 5.4, "z", 40), hole([8, 0, 0], 3.2, "z", 24)] + radial_teeth(25, 15.2, [1.1, 2.4, 13]) + [chamfer(0.4)]),
            ],
            "fdm",
            ["tooth features >=0.8mm", "shaft bore clearance +0.4mm"],
        ),
        plan(
            "train05_cnc_mounting_plate",
            "CNC安装板：槽宽不小于3mm，内角按刀具半径处理。",
            [
                part("plate", "CNC安装板", "带长槽和减重口袋的铝板", [box([120, 74, 8])],
                     [slot([-34, 0, 0], 34, 5, "y"), slot([34, 0, 0], 34, 5, "y"), cut_box([0, 0, 1.5], [38, 26, 5]), chamfer(1.0)] + bolt_pattern(46, 0, 5.2)),
            ],
            "cnc",
            ["slots >=3mm", "shallow pocket", "mount holes"],
        ),
        plan(
            "train06_cnc_pocket_bracket",
            "CNC口袋支架：避免深窄盲腔，口袋浅而宽。",
            [
                part("angle_block", "CNC角支架", "带浅口袋的角形支架", [
                    box([82, 18, 50], [0, -22, 25]),
                    box([82, 54, 10], [0, 0, 5]),
                ], [cut_box([0, -22, 25], [56, 8, 28]), slot([-26, 0, 5], 26, 5, "x"), slot([26, 0, 5], 26, 5, "x"), chamfer(1.2)]),
            ],
            "cnc",
            ["pocket depth ratio conservative", "tool-accessible slots"],
        ),
        plan(
            "train07_cnc_split_clamp",
            "CNC抱箍：3mm夹紧缝、止裂孔、螺钉通孔和沉台空间。",
            [
                part("split_clamp", "开口轴夹", "12mm轴用CNC开口抱箍", [cyl(42, 20)],
                     [hole([0, 0, 0], 12.2, "z", 50), cut_box([21, 0, 0], [4, 48, 24]), hole([17, 0, 0], 3.2, "z", 24), hole([0, -13, 0], 5.2, "x", 60), hole([0, 13, 0], 5.2, "x", 60), chamfer(1.0)]),
            ],
            "cnc",
            ["clamp split >=3mm", "crack-stop hole", "clearance screw holes"],
        ),
        plan(
            "train08_sla_sensor_bracket",
            "SLA传感器支架：小柱加粗，孔径轻微放量。",
            [
                part("sensor_bracket", "小型传感器支架", "光固化传感器固定架", [
                    box([38, 22, 2.2]),
                    box([4, 18, 22], [-17, 0, 10]),
                    box([4, 18, 22], [17, 0, 10]),
                    box([38, 4, 18], [0, -9, 10]),
                ], [hole([-11, 0, 0], 2.25), hole([11, 0, 0], 2.25), hole([0, -9, 13], 3.25, "y", 16), fillet(0.8)]),
            ],
            "resin",
            ["walls >=0.8mm", "posts >=1.5mm", "small holes +0.2mm"],
        ),
        plan(
            "train09_sla_hollow_shell",
            "SLA中空外壳：排液孔、加强筋和0.8mm以上壁厚。",
            [
                part("hollow_shell", "光固化中空外壳", "带排液孔的薄壁壳体", [
                    box([70, 42, 28]),
                    box([4, 34, 20], [-22, 0, 0]),
                    box([4, 34, 20], [22, 0, 0]),
                ], [cut_box([0, 0, 4], [62, 34, 24]), hole([-24, 0, -14], 4.0), hole([24, 0, -14], 4.0), fillet(1.0)]),
            ],
            "resin",
            ["drain holes", "broad panel ribs", "wall thickness >=0.8mm"],
        ),
        plan(
            "train10_mixed_process_case",
            "混合工艺外壳：跨工艺配合按FDM侧预留，定位和紧固分离。",
            [
                part("cnc_base", "CNC底座", "铝合金定位底座", [box([110, 70, 8])], bolt_pattern(44, 0, 4.6) + [slot([0, 0, 0], 52, 5, "x")]),
                part("fdm_cover", "FDM外罩", "带0.4mm装配余量的外罩", [box([112, 72, 36])], [cut_box([0, 0, -2], [104, 64, 34]), hole([0, 31, 6], 8, "y", 20), chamfer(0.8)], [0, 0, 22]),
                part("sla_clip", "SLA传感器夹", "小型传感器夹具", [box([24, 12, 14]), box([4, 18, 14], [-10, 0, 0]), box([4, 18, 14], [10, 0, 0])], [hole([0, 0, 0], 3.2, "z", 30)], [30, 0, 16]),
            ],
            "mixed",
            ["cross-process clearance uses least accurate process", "locating and clamping separated"],
        ),
        plan(
            "train11_pan_tilt_camera_mount",
            "云台相机支架：水平和俯仰轴均输出运动副。",
            [
                part("base", "旋转底座", "云台底座", [cyl(60, 8), cyl(18, 14, [0, 0, 9])], bolt_pattern(22, 0, 4.5)),
                part("yoke", "U形支架", "俯仰支撑叉", [box([54, 8, 52], [0, -24, 28]), box([54, 8, 52], [0, 24, 28]), box([54, 48, 8], [0, 0, 6])], [hole([0, -24, 32], 8.4, "y", 20), hole([0, 24, 32], 8.4, "y", 20)]),
                part("camera_plate", "相机板", "俯仰相机安装板", [box([46, 34, 6]), cyl(8, 44, [0, 0, 0], [90, 0, 0])], [hole([0, 0, 0], 6.6, "y", 60), hole([-14, 0, 0], 3.4), hole([14, 0, 0], 3.4)], [0, 0, 32]),
            ],
            "mechanism",
            ["two revolute joints", "pivot origins in meters"],
            joints=[
                {"id": "pan_joint", "type": "continuous", "parent": "base", "child": "yoke", "origin": {"xyz": [0, 0, 0.014], "rpy": [0, 0, 0]}, "axis": [0, 0, 1]},
                {"id": "tilt_joint", "type": "revolute", "parent": "yoke", "child": "camera_plate", "origin": {"xyz": [0, 0, 0.032], "rpy": [0, 0, 0]}, "axis": [0, 1, 0], "limit": {"lower": -1.2, "upper": 1.2, "effort": 1, "velocity": 1}},
            ],
        ),
        plan(
            "train12_linear_slider",
            "线性滑台：滑块与导轨使用prismatic运动副，滑配留0.4mm。",
            [
                part("rail", "导轨", "固定直线导轨", [box([130, 18, 10]), box([130, 6, 16], [0, 0, 7])], [slot([-42, 0, 0], 24, 5, "x"), slot([42, 0, 0], 24, 5, "x")]),
                part("carriage", "滑块", "带导向槽的移动滑块", [box([44, 26, 18])], [cut_box([0, 0, -4], [48, 7, 12]), hole([-14, 0, 5], 4.5), hole([14, 0, 5], 4.5)], [0, 0, 17]),
            ],
            "mechanism",
            ["prismatic joint", "FDM sliding clearance"],
            joints=[{"id": "slide_joint", "type": "prismatic", "parent": "rail", "child": "carriage", "origin": {"xyz": [0, 0, 0.017], "rpy": [0, 0, 0]}, "axis": [1, 0, 0], "limit": {"lower": -0.04, "upper": 0.04, "effort": 5, "velocity": 0.1}}],
        ),
        plan(
            "train13_four_bar_linkage",
            "四连杆机构：每个运动件给出明确revolute关节。",
            [
                part("ground", "机架", "四连杆固定机架", [box([120, 24, 8]), cyl(10, 12, [-45, 0, 10]), cyl(10, 12, [45, 0, 10])], [hole([-45, 0, 10], 6.4, "z", 30), hole([45, 0, 10], 6.4, "z", 30)]),
                part("left_link", "左摇杆", "左侧摇杆", [box([12, 58, 6], [0, 0, 0], [0, 0, 22])], [hole([0, -23, 0], 6.6), hole([0, 23, 0], 6.6)], [-45, 0, 22]),
                part("right_link", "右摇杆", "右侧摇杆", [box([12, 58, 6], [0, 0, 0], [0, 0, -22])], [hole([0, -23, 0], 6.6), hole([0, 23, 0], 6.6)], [45, 0, 22]),
                part("coupler", "连杆", "中间连杆", [box([92, 12, 6])], [hole([-41, 0, 0], 6.6), hole([41, 0, 0], 6.6)], [0, 32, 34]),
            ],
            "mechanism",
            ["moving links have joints", "pins use clearance"],
            joints=[
                {"id": "left_ground_joint", "type": "revolute", "parent": "ground", "child": "left_link", "origin": {"xyz": [-0.045, 0, 0.022], "rpy": [0, 0, 0]}, "axis": [0, 0, 1], "limit": {"lower": -1.4, "upper": 1.4, "effort": 1, "velocity": 1}},
                {"id": "right_ground_joint", "type": "revolute", "parent": "ground", "child": "right_link", "origin": {"xyz": [0.045, 0, 0.022], "rpy": [0, 0, 0]}, "axis": [0, 0, 1], "limit": {"lower": -1.4, "upper": 1.4, "effort": 1, "velocity": 1}},
                {"id": "coupler_reference_joint", "type": "revolute", "parent": "left_link", "child": "coupler", "origin": {"xyz": [-0.041, 0.032, 0.034], "rpy": [0, 0, 0]}, "axis": [0, 0, 1], "limit": {"lower": -3.14, "upper": 3.14, "effort": 1, "velocity": 1}},
            ],
        ),
        plan(
            "train14_parallel_gripper",
            "平行夹爪：左右夹爪使用相反方向prismatic关节。",
            [
                part("base", "夹爪基座", "平行夹爪固定座", [box([80, 34, 12]), box([72, 8, 10], [0, 0, 12])], [slot([0, 0, 6], 58, 5, "x")]),
                part("left_jaw", "左夹爪", "移动夹爪", [box([14, 28, 28]), box([24, 8, 8], [5, 0, -10])], [hole([0, 0, 8], 3.4, "y", 40)], [-20, 0, 24]),
                part("right_jaw", "右夹爪", "移动夹爪", [box([14, 28, 28]), box([24, 8, 8], [-5, 0, -10])], [hole([0, 0, 8], 3.4, "y", 40)], [20, 0, 24]),
            ],
            "mechanism",
            ["two prismatic joints", "jaw mounting holes"],
            joints=[
                {"id": "left_jaw_slide", "type": "prismatic", "parent": "base", "child": "left_jaw", "origin": {"xyz": [-0.02, 0, 0.024], "rpy": [0, 0, 0]}, "axis": [-1, 0, 0], "limit": {"lower": 0, "upper": 0.018, "effort": 10, "velocity": 0.1}},
                {"id": "right_jaw_slide", "type": "prismatic", "parent": "base", "child": "right_jaw", "origin": {"xyz": [0.02, 0, 0.024], "rpy": [0, 0, 0]}, "axis": [1, 0, 0], "limit": {"lower": 0, "upper": 0.018, "effort": 10, "velocity": 0.1}},
            ],
        ),
        plan(
            "train15_two_axis_robot_arm",
            "两轴机器人臂：肩肘关节明确，连杆分件输出。",
            [
                part("base", "机器人底座", "固定底座", [cyl(70, 10), cyl(22, 18, [0, 0, 14])], bolt_pattern(24, 0, 5.0), inertial=inertial(0.45)),
                part("upper_arm", "上臂", "第一连杆", [box([18, 86, 12]), cyl(18, 18, [0, -43, 0], [0, 90, 0]), cyl(18, 18, [0, 43, 0], [0, 90, 0])], [hole([0, -43, 0], 8.4, "x", 30), hole([0, 43, 0], 8.4, "x", 30)], [0, 43, 28], inertial=inertial(0.22)),
                part("forearm", "前臂", "第二连杆", [box([16, 72, 10]), cyl(16, 16, [0, -36, 0], [0, 90, 0]), cyl(16, 16, [0, 36, 0], [0, 90, 0])], [hole([0, -36, 0], 8.4, "x", 28), hole([0, 36, 0], 6.4, "x", 28)], [0, 115, 28], inertial=inertial(0.16)),
            ],
            "robot",
            ["revolute shoulder and elbow", "inertial present"],
            joints=[
                {"id": "shoulder_joint", "type": "revolute", "parent": "base", "child": "upper_arm", "origin": {"xyz": [0, 0.043, 0.028], "rpy": [0, 0, 0]}, "axis": [1, 0, 0], "limit": {"lower": -1.57, "upper": 1.57, "effort": 20, "velocity": 1}},
                {"id": "elbow_joint", "type": "revolute", "parent": "upper_arm", "child": "forearm", "origin": {"xyz": [0, 0.115, 0.028], "rpy": [0, 0, 0]}, "axis": [1, 0, 0], "limit": {"lower": -2.0, "upper": 2.0, "effort": 12, "velocity": 1}},
            ],
        ),
        plan(
            "train16_bearing_pillow_block",
            "轴承座：轴承孔、底部安装孔和加强肋齐全。",
            [
                part("pillow_block", "轴承座", "608轴承近似座", [
                    box([70, 26, 12], [0, 0, 0]),
                    box([42, 18, 40], [0, 0, 22]),
                    cyl(30, 20, [0, 0, 24], [90, 0, 0]),
                    box([8, 20, 32], [-26, 0, 16], [0, -22, 0]),
                    box([8, 20, 32], [26, 0, 16], [0, 22, 0]),
                ], [hole([0, 0, 24], 22.2, "y", 38), hole([-24, 0, 0], 5.0), hole([24, 0, 0], 5.0), chamfer(1.0)]),
            ],
            "cnc",
            ["bearing bore clearance", "ribs", "base mounting holes"],
        ),
        plan(
            "train17_electronics_standoff_tray",
            "电子板托盘：螺柱加粗，板边和孔位留FDM余量。",
            [
                part("tray", "电子板托盘", "带M3螺柱的托盘", [
                    box([100, 70, 3]),
                    cyl(7, 8, [-38, -24, 5.5]),
                    cyl(7, 8, [38, -24, 5.5]),
                    cyl(7, 8, [-38, 24, 5.5]),
                    cyl(7, 8, [38, 24, 5.5]),
                    box([100, 3, 8], [0, -35, 3]),
                    box([100, 3, 8], [0, 35, 3]),
                ], [hole([-38, -24, 6], 3.4), hole([38, -24, 6], 3.4), hole([-38, 24, 6], 3.4), hole([38, 24, 6], 3.4), chamfer(0.6)]),
            ],
            "fdm",
            ["M3 clearance 3.4mm", "standoffs not fragile"],
        ),
        plan(
            "train18_hinged_pipe_clamp",
            "管夹：一侧铰链一侧螺钉夹紧，轴孔留转动间隙。",
            [
                part("lower_half", "下半管夹", "固定半夹", [box([76, 22, 16]), cyl(28, 78, [0, 0, 8], [0, 90, 0])], [hole([0, 0, 8], 22.6, "x", 92), cut_box([0, 0, 20], [90, 40, 24]), hole([-33, 0, 12], 4.8, "z", 40)]),
                part("upper_half", "上半管夹", "活动半夹", [box([76, 22, 16]), cyl(28, 78, [0, 0, -8], [0, 90, 0])], [hole([0, 0, -8], 22.6, "x", 92), cut_box([0, 0, -20], [90, 40, 24]), hole([33, 0, -12], 4.8, "z", 40)], [0, 0, 30]),
                part("hinge_pin", "铰链销", "管夹转轴", [cyl(5, 30, [0, 0, 0], [90, 0, 0])], [], [-40, 0, 15]),
            ],
            "fdm",
            ["pipe clearance", "hinge clearance", "clamp screw hole"],
            joints=[{"id": "pipe_clamp_hinge", "type": "revolute", "parent": "lower_half", "child": "upper_half", "origin": {"xyz": [-0.04, 0, 0.015], "rpy": [0, 0, 0]}, "axis": [0, 1, 0], "limit": {"lower": 0, "upper": 1.2, "effort": 2, "velocity": 1}}],
        ),
        plan(
            "train19_dovetail_slide",
            "燕尾滑轨：导向面分件表达，滑配留0.35mm。",
            [
                part("dovetail_rail", "燕尾导轨", "固定燕尾轨", [box([120, 22, 8]), box([116, 14, 10], [0, 0, 9], [0, 0, 0])], [slot([-42, 0, 0], 22, 4.5, "x"), slot([42, 0, 0], 22, 4.5, "x")]),
                part("slider", "燕尾滑块", "移动滑块", [box([46, 34, 18])], [cut_box([0, 0, -5], [50, 15.4, 12]), hole([-14, 0, 5], 4.5), hole([14, 0, 5], 4.5)], [0, 0, 18]),
            ],
            "fdm",
            ["dovetail clearance", "mount slots"],
            joints=[{"id": "dovetail_slide", "type": "prismatic", "parent": "dovetail_rail", "child": "slider", "origin": {"xyz": [0, 0, 0.018], "rpy": [0, 0, 0]}, "axis": [1, 0, 0], "limit": {"lower": -0.04, "upper": 0.04, "effort": 5, "velocity": 0.1}}],
        ),
        plan(
            "train20_knob_with_set_screw",
            "旋钮：中心孔和侧向顶丝孔均预留加工间隙。",
            [
                part("knob", "滚花旋钮近似件", "带顶丝孔的旋钮", [cyl(36, 18), cyl(20, 8, [0, 0, 13])],
                     [hole([0, 0, 0], 6.4, "z", 50), hole([0, 18, 0], 3.4, "y", 40)] + radial_teeth(18, 19, [1.2, 3, 16]) + [chamfer(0.7)]),
            ],
            "fdm",
            ["shaft bore +0.4mm", "set screw pilot hole", "grip ribs printable"],
        ),
        plan(
            "train21_cable_chain_link",
            "拖链节：销孔转动间隙、卡扣根部加厚。",
            [
                part("chain_link", "拖链单节", "FDM可打印拖链节", [
                    box([38, 8, 12], [0, -11, 0]),
                    box([38, 8, 12], [0, 11, 0]),
                    box([6, 30, 12], [-16, 0, 0]),
                    box([6, 30, 12], [16, 0, 0]),
                    cyl(7, 8, [-21, -11, 0], [90, 0, 0]),
                    cyl(7, 8, [-21, 11, 0], [90, 0, 0]),
                    cyl(6, 8, [21, -11, 0], [90, 0, 0]),
                    cyl(6, 8, [21, 11, 0], [90, 0, 0]),
                ], [hole([-21, -11, 0], 4.6, "y", 20), hole([-21, 11, 0], 4.6, "y", 20), chamfer(0.5)]),
            ],
            "fdm",
            ["pin clearance", "snap root thickness", "open center"],
        ),
        plan(
            "train22_heatsink_bracket",
            "散热片支架：多片肋板用实体表达，安装槽可加工。",
            [
                part("heatsink_bracket", "散热支架", "带散热肋的固定板", [
                    box([90, 48, 5]),
                    box([4, 42, 26], [-28, 0, 15]),
                    box([4, 42, 26], [-14, 0, 15]),
                    box([4, 42, 26], [0, 0, 15]),
                    box([4, 42, 26], [14, 0, 15]),
                    box([4, 42, 26], [28, 0, 15]),
                ], [slot([-30, 0, 0], 20, 5, "y"), slot([30, 0, 0], 20, 5, "y"), chamfer(0.8)]),
            ],
            "cnc",
            ["machinable slots", "fins thick enough"],
        ),
        plan(
            "train23_gearbox_cover",
            "齿轮箱盖：轴承凸台、螺钉孔和检查窗都有明确特征。",
            [
                part("cover", "齿轮箱盖", "带轴承座凸台的箱盖", [
                    box([110, 76, 6]),
                    cyl(32, 10, [-28, 0, 5]),
                    cyl(32, 10, [28, 0, 5]),
                    box([72, 4, 10], [0, 32, 5]),
                ], [hole([-28, 0, 5], 16.2, "z", 30), hole([28, 0, 5], 16.2, "z", 30), cut_box([0, 0, 0], [30, 18, 20]), chamfer(1.0)] + bolt_pattern(42, 0, 4.5)),
            ],
            "cnc",
            ["bearing bores", "inspection pocket", "bolt pattern"],
        ),
        plan(
            "train24_servo_horn_adapter",
            "舵机盘适配器：中心孔、臂端孔和轻量化槽可打印。",
            [
                part("servo_horn", "舵机盘适配器", "十字舵盘", [
                    cyl(20, 5),
                    box([70, 12, 5]),
                    box([12, 70, 5]),
                ], [hole([0, 0, 0], 5.4, "z", 20), hole([-28, 0, 0], 3.2), hole([28, 0, 0], 3.2), hole([0, -28, 0], 3.2), hole([0, 28, 0], 3.2), slot([0, 0, 0], 42, 4, "x"), slot([0, 0, 0], 42, 4, "y"), chamfer(0.5)]),
            ],
            "fdm",
            ["small holes enlarged", "slots printable"],
        ),
        plan(
            "train25_syringe_pump_slider",
            "注射泵推杆滑块：导轨和推块为独立零件，滑块prismatic。",
            [
                part("pump_frame", "泵体导轨", "注射泵固定导轨", [box([150, 34, 8]), box([150, 6, 14], [0, -17, 8]), box([150, 6, 14], [0, 17, 8])], [slot([-52, 0, 0], 28, 5, "x"), slot([52, 0, 0], 28, 5, "x")]),
                part("plunger_block", "推杆滑块", "推动注射器活塞的滑块", [box([32, 32, 28]), box([42, 10, 10], [0, 0, -12])], [hole([0, 0, 6], 6.4, "x", 60), cut_box([0, 0, -13], [46, 7, 8])], [0, 0, 24]),
            ],
            "mechanism",
            ["prismatic slide", "lead screw hole"],
            joints=[{"id": "plunger_slide", "type": "prismatic", "parent": "pump_frame", "child": "plunger_block", "origin": {"xyz": [0, 0, 0.024], "rpy": [0, 0, 0]}, "axis": [1, 0, 0], "limit": {"lower": -0.06, "upper": 0.06, "effort": 20, "velocity": 0.02}}],
        ),
        plan(
            "train26_ball_screw_nut_mount",
            "丝杆螺母座：中心孔、法兰孔和减重口袋兼顾CNC可达性。",
            [
                part("nut_mount", "滚珠丝杆螺母座", "CNC螺母安装块", [
                    box([64, 48, 34]),
                    cyl(32, 8, [0, 0, 21]),
                ], [hole([0, 0, 0], 18.2, "z", 80), hole([18, 14, 17], 4.5), hole([-18, 14, 17], 4.5), hole([18, -14, 17], 4.5), hole([-18, -14, 17], 4.5), cut_box([0, 0, -8], [38, 24, 14]), chamfer(1.0)]),
            ],
            "cnc",
            ["through bore", "flange holes", "shallow accessible pocket"],
        ),
        plan(
            "train27_vacuum_nozzle_bracket",
            "真空吸嘴支架：锥形吸嘴和安装夹座分件，孔位留余量。",
            [
                part("mount_block", "吸嘴安装座", "夹持吸嘴的安装块", [box([46, 28, 24])], [hole([0, 0, 0], 10.4, "z", 50), cut_box([21, 0, 0], [4, 34, 28]), hole([0, 12, 4], 4.5, "x", 60)]),
                part("nozzle", "锥形吸嘴", "真空吸嘴", [cone(8, 3, 34), cyl(10, 12, [0, 0, 20])], [hole([0, 0, 0], 3.0, "z", 80), chamfer(0.4)], [0, 0, -18]),
            ],
            "mixed",
            ["separate nozzle and clamp", "bore clearance"],
        ),
        plan(
            "train28_microscope_slide_holder",
            "载玻片夹具：薄片限位、弹性压片和排液槽按树脂工艺加厚。",
            [
                part("slide_holder", "载玻片夹具", "SLA载玻片固定托", [
                    box([92, 34, 3]),
                    box([92, 3, 4], [0, -15, 2]),
                    box([92, 3, 4], [0, 15, 2]),
                    box([8, 24, 5], [-42, 0, 3]),
                    box([8, 24, 5], [42, 0, 3]),
                    box([34, 2, 2], [0, 10, 5]),
                ], [slot([0, 0, 0], 46, 3, "x"), hole([-36, 0, 0], 2.4), hole([36, 0, 0], 2.4), fillet(0.6)]),
            ],
            "resin",
            ["thin tabs thickened", "drain/relief slot", "small holes enlarged"],
        ),
        plan(
            "train29_drone_motor_arm_mount",
            "无人机电机臂座：电机孔距、臂夹紧孔和圆角加强兼顾FDM。",
            [
                part("arm_mount", "无人机电机臂座", "电机和方臂连接座", [
                    cyl(44, 6),
                    box([70, 24, 16], [34, 0, -3]),
                    box([18, 34, 20], [12, 0, 2]),
                ], [hole([0, 0, 0], 8.4), hole([16, 16, 0], 3.4), hole([-16, 16, 0], 3.4), hole([16, -16, 0], 3.4), hole([-16, -16, 0], 3.4), cut_box([42, 0, -3], [46, 14, 10]), hole([42, 0, 0], 4.5, "y", 40), chamfer(0.8)]),
            ],
            "fdm",
            ["motor bolt pattern", "arm socket clearance", "reinforced root"],
        ),
        plan(
            "train30_mini_vise",
            "迷你台钳：固定钳口、活动钳口、丝杆用装配关系表达。",
            [
                part("base", "台钳底座", "带导轨的底座", [box([120, 46, 12]), box([88, 8, 10], [0, -14, 12]), box([88, 8, 10], [0, 14, 12])], [slot([-42, 0, 0], 22, 5, "x"), slot([42, 0, 0], 22, 5, "x")]),
                part("fixed_jaw", "固定钳口", "固定夹持面", [box([18, 46, 34])], [hole([0, 0, 12], 5.0, "x", 40)], [-45, 0, 28]),
                part("moving_jaw", "活动钳口", "滑动夹持面", [box([18, 42, 32]), box([28, 14, 10], [10, 0, -14])], [hole([0, 0, 10], 6.4, "x", 50)], [25, 0, 28]),
                part("lead_screw", "丝杆", "夹紧丝杆近似件", [cyl(6, 86, [0, 0, 0], [0, 90, 0]), cyl(22, 8, [48, 0, 0], [0, 90, 0])], [chamfer(0.5)], [0, 0, 38]),
            ],
            "mechanism",
            ["moving jaw prismatic", "lead screw continuous"],
            joints=[
                {"id": "jaw_slide", "type": "prismatic", "parent": "base", "child": "moving_jaw", "origin": {"xyz": [0.025, 0, 0.028], "rpy": [0, 0, 0]}, "axis": [1, 0, 0], "limit": {"lower": -0.04, "upper": 0.02, "effort": 30, "velocity": 0.02}},
                {"id": "screw_rotate", "type": "continuous", "parent": "base", "child": "lead_screw", "origin": {"xyz": [0, 0, 0.038], "rpy": [0, 0, 0]}, "axis": [1, 0, 0]},
            ],
        ),
        plan(
            "train31_belt_tensioner",
            "皮带张紧器：偏心轮和摆臂独立，张紧轴使用revolute关节。",
            [
                part("base_plate", "张紧器底板", "带长槽的固定底板", [box([86, 42, 6])], [slot([-25, 0, 0], 28, 5, "x"), slot([25, 0, 0], 28, 5, "x")]),
                part("swing_arm", "摆臂", "可调张紧摆臂", [box([62, 12, 8]), cyl(18, 8, [-24, 0, 0]), cyl(14, 8, [24, 0, 0])], [hole([-24, 0, 0], 6.6), hole([24, 0, 0], 5.4)], [0, 0, 16]),
                part("idler_pulley", "惰轮", "皮带张紧轮", [cyl(24, 12), cyl(30, 2, [0, 0, -7]), cyl(30, 2, [0, 0, 7])], [hole([0, 0, 0], 5.4, "z", 30)], [24, 0, 16]),
            ],
            "mechanism",
            ["revolute tension arm", "idler bore clearance", "base adjustment slots"],
            joints=[
                {"id": "tension_arm_pivot", "type": "revolute", "parent": "base_plate", "child": "swing_arm", "origin": {"xyz": [-0.024, 0, 0.016], "rpy": [0, 0, 0]}, "axis": [0, 0, 1], "limit": {"lower": -0.5, "upper": 0.5, "effort": 3, "velocity": 1}},
                {"id": "idler_spin", "type": "continuous", "parent": "swing_arm", "child": "idler_pulley", "origin": {"xyz": [0.024, 0, 0.016], "rpy": [0, 0, 0]}, "axis": [0, 0, 1]},
            ],
        ),
        plan(
            "train32_limit_switch_bracket",
            "限位开关支架：小孔放量，长槽可调，薄壁按FDM加厚。",
            [
                part("switch_bracket", "限位开关支架", "FDM打印微动开关支架", [
                    box([48, 26, 4]),
                    box([48, 5, 28], [0, -10.5, 14]),
                    box([6, 26, 24], [-21, 0, 12]),
                    box([6, 26, 24], [21, 0, 12]),
                ], [hole([-12, -10.5, 16], 2.6, "y", 16), hole([12, -10.5, 16], 2.6, "y", 16), slot([0, 0, 0], 26, 4.5, "x")]),
            ],
            "fdm",
            ["small switch holes enlarged", "mount slot", "walls >=1.2mm"],
        ),
        plan(
            "train33_caster_mount_plate",
            "脚轮安装板：板厚和孔距清晰，FDM孔径预留。",
            [
                part("caster_plate", "脚轮安装板", "四孔脚轮底板", [box([72, 56, 7])],
                     [hole([-22, -16, 0], 5.2), hole([22, -16, 0], 5.2), hole([-22, 16, 0], 5.2), hole([22, 16, 0], 5.2), hole([0, 0, 0], 12.5), chamfer(0.8)]),
            ],
            "fdm",
            ["plate thickness 7mm", "M5 clearance", "center swivel clearance"],
        ),
        plan(
            "train34_encoder_mount",
            "编码器支架：轴孔、定位孔、安装槽按CNC可加工表达。",
            [
                part("encoder_mount", "编码器支架", "CNC编码器安装板", [
                    box([64, 46, 6]),
                    box([64, 8, 38], [0, -19, 19]),
                ], [hole([0, -19, 22], 12.2, "y", 20), hole([-20, -19, 22], 3.4, "y", 20), hole([20, -19, 22], 3.4, "y", 20), slot([-18, 0, 0], 20, 4, "y"), slot([18, 0, 0], 20, 4, "y")]),
            ],
            "cnc",
            ["shaft hole", "encoder screw holes", "adjustment slots >=3mm"],
        ),
        plan(
            "train35_fan_duct_40mm",
            "40mm风扇导风罩：安装孔、进出口和薄壁按FDM约束。",
            [
                part("fan_duct", "40mm风扇导风罩", "FDM风扇转接导风罩", [
                    box([52, 52, 8], [0, 0, 0]),
                    box([36, 36, 28], [0, 0, 18]),
                    box([28, 22, 34], [0, 20, 18]),
                ], [hole([0, 0, 0], 34, "z", 20), cut_box([0, 0, 18], [26, 26, 34]), cut_box([0, 25, 18], [20, 20, 28]), hole([-16, -16, 0], 3.4), hole([16, -16, 0], 3.4), hole([-16, 16, 0], 3.4), hole([16, 16, 0], 3.4)]),
            ],
            "fdm",
            ["40mm fan hole pattern", "duct wall >=1.2mm", "open airflow path"],
        ),
        plan(
            "train36_robot_chassis",
            "双轮机器人底盘：电机座、电池托和脚轮孔分区建模。",
            [
                part("chassis_plate", "机器人底盘", "双轮差速底盘板", [box([160, 110, 5])], [slot([-52, -34, 0], 32, 5, "x"), slot([52, -34, 0], 32, 5, "x"), hole([0, 42, 0], 8), hole([-55, 38, 0], 4.5), hole([55, 38, 0], 4.5)]),
                part("left_motor_mount", "左电机座", "减速电机安装座", [box([34, 28, 24]), box([44, 6, 28], [0, -17, 2])], [hole([0, -17, 6], 12, "y", 20), hole([-11, -17, 6], 3.4, "y", 20), hole([11, -17, 6], 3.4, "y", 20)], [-52, -34, 19]),
                part("right_motor_mount", "右电机座", "减速电机安装座", [box([34, 28, 24]), box([44, 6, 28], [0, -17, 2])], [hole([0, -17, 6], 12, "y", 20), hole([-11, -17, 6], 3.4, "y", 20), hole([11, -17, 6], 3.4, "y", 20)], [52, -34, 19]),
            ],
            "fdm",
            ["motor mount holes", "caster and battery mounting zones", "separate brackets"],
        ),
        plan(
            "train37_drawer_slide_pair",
            "抽屉滑轨样件：固定轨和滑块分件，滑动关节明确。",
            [
                part("outer_rail", "外轨", "固定抽屉滑轨", [box([150, 18, 8]), box([150, 4, 14], [0, -7, 5]), box([150, 4, 14], [0, 7, 5])], [slot([-50, 0, 0], 28, 4.5, "x"), slot([50, 0, 0], 28, 4.5, "x")]),
                part("inner_slide", "内滑块", "抽屉滑块", [box([72, 14, 10]), box([72, 6, 6], [0, 0, 8])], [hole([-24, 0, 3], 4.5), hole([24, 0, 3], 4.5)], [0, 0, 16]),
            ],
            "mechanism",
            ["prismatic drawer slide", "mount holes", "sliding clearance"],
            joints=[{"id": "drawer_slide_joint", "type": "prismatic", "parent": "outer_rail", "child": "inner_slide", "origin": {"xyz": [0, 0, 0.016], "rpy": [0, 0, 0]}, "axis": [1, 0, 0], "limit": {"lower": -0.055, "upper": 0.055, "effort": 8, "velocity": 0.2}}],
        ),
        plan(
            "train38_camera_hotshoe_mount",
            "相机热靴转接座：燕尾近似和1/4螺孔位置明确。",
            [
                part("hotshoe_adapter", "热靴转接座", "相机热靴近似转接件", [
                    box([32, 20, 4]),
                    box([24, 16, 5], [0, 0, 4]),
                    box([18, 12, 7], [0, 0, 9]),
                ], [hole([0, 0, 6], 6.8, "z", 24), slot([0, 0, 0], 18, 3, "x"), chamfer(0.4)]),
            ],
            "cnc",
            ["hotshoe dovetail approximation", "1/4 thread pilot", "slot >=3mm"],
        ),
        plan(
            "train39_terminal_block_cover",
            "端子排护罩：透明盖近似、线缆出口和螺钉柱分离。",
            [
                part("base_guard", "端子排底座", "端子排保护底座", [box([92, 34, 4]), box([92, 3, 18], [0, -15.5, 9]), box([92, 3, 18], [0, 15.5, 9]), cyl(7, 8, [-38, 0, 6]), cyl(7, 8, [38, 0, 6])], [hole([-38, 0, 7], 3.4), hole([38, 0, 7], 3.4)]),
                part("cover", "护罩盖", "带出线口的保护盖", [box([94, 36, 20])], [cut_box([0, 0, -2], [86, 28, 18]), cut_box([0, 18, 0], [60, 10, 10])], [0, 0, 16]),
            ],
            "fdm",
            ["cover clearance", "cable exit", "screw bosses"],
        ),
        plan(
            "train40_stepper_coupler",
            "步进电机联轴器：双端孔径和夹紧缝，CNC止裂孔。",
            [
                part("shaft_coupler", "开缝联轴器", "5mm到8mm轴夹联轴器", [cyl(24, 34)],
                     [hole([0, 0, -8], 5.1, "z", 18), hole([0, 0, 9], 8.1, "z", 22), cut_box([12, 0, 0], [3, 32, 38]), hole([9, 0, 0], 2.5, "z", 30), hole([0, -9, 0], 3.4, "x", 40), hole([0, 9, 0], 3.4, "x", 40), chamfer(0.6)]),
            ],
            "cnc",
            ["two shaft bores", "split gap", "crack-stop hole"],
        ),
        plan(
            "train41_imu_sensor_case",
            "IMU传感器小盒：薄壁、线缆孔、螺柱按SLA规则。",
            [
                part("imu_case", "IMU传感器盒", "SLA小型传感器外壳", [
                    box([42, 32, 18]),
                    cyl(4, 6, [-14, -10, -3]),
                    cyl(4, 6, [14, -10, -3]),
                    cyl(4, 6, [-14, 10, -3]),
                    cyl(4, 6, [14, 10, -3]),
                ], [cut_box([0, 0, 2], [36, 26, 16]), hole([0, 16, 2], 5, "y", 12), hole([-14, -10, -2], 2.2), hole([14, -10, -2], 2.2), hole([-14, 10, -2], 2.2), hole([14, 10, -2], 2.2), fillet(0.5)]),
            ],
            "resin",
            ["walls >=0.8mm", "cable hole", "small screw posts"],
        ),
        plan(
            "train42_cnc_right_angle_fixture",
            "直角定位治具：定位台阶、压板槽和CNC内角可加工。",
            [
                part("angle_fixture", "直角定位治具", "CNC加工直角装夹治具", [
                    box([96, 48, 12], [0, 0, 6]),
                    box([96, 12, 56], [0, -18, 34]),
                    box([10, 48, 44], [-38, 0, 28]),
                ], [slot([-24, 0, 6], 30, 5, "x"), slot([24, 0, 6], 30, 5, "x"), cut_box([0, -18, 34], [64, 6, 28]), chamfer(1.0)]),
            ],
            "cnc",
            ["right-angle datum", "clamp slots >=3mm", "shallow relief pocket"],
        ),
        plan(
            "train43_phone_clamp",
            "手机夹具：弹簧夹爪滑动、软垫近似和行程限制。",
            [
                part("clamp_body", "手机夹主体", "固定夹体", [box([86, 18, 16]), box([12, 52, 20], [-37, 0, 12])], [hole([-20, 0, 4], 4.5), hole([20, 0, 4], 4.5)]),
                part("moving_jaw", "活动夹爪", "滑动夹爪", [box([12, 52, 20]), box([20, 4, 4], [10, 0, -8])], [], [34, 0, 12]),
            ],
            "mechanism",
            ["jaw slide", "phone pad surfaces", "limited travel"],
            joints=[{"id": "phone_jaw_slide", "type": "prismatic", "parent": "clamp_body", "child": "moving_jaw", "origin": {"xyz": [0.034, 0, 0.012], "rpy": [0, 0, 0]}, "axis": [1, 0, 0], "limit": {"lower": -0.012, "upper": 0.02, "effort": 5, "velocity": 0.1}}],
        ),
        plan(
            "train44_panel_hinge_latch",
            "面板铰链锁扣：铰链和锁舌分件，运动副明确。",
            [
                part("frame_leaf", "框侧铰链片", "固定铰链片", [box([42, 24, 4]), cyl(8, 24, [-19, 0, 6], [90, 0, 0])], [hole([-19, 0, 6], 5.4, "y", 30), hole([10, 0, 0], 4.5)]),
                part("door_leaf", "门侧铰链片", "活动铰链片", [box([42, 24, 4]), cyl(7.6, 22, [19, 0, 6], [90, 0, 0]), box([18, 8, 8], [0, 0, 8])], [hole([19, 0, 6], 5.4, "y", 30), hole([-10, 0, 0], 4.5)], [0, 0, 12]),
                part("latch_tab", "锁舌", "旋转锁舌", [box([28, 8, 5]), cyl(10, 5, [-10, 0, 0])], [hole([-10, 0, 0], 4.5)], [48, 0, 12]),
            ],
            "mechanism",
            ["hinge revolute", "latch tab", "screw clearances"],
            joints=[
                {"id": "panel_hinge", "type": "revolute", "parent": "frame_leaf", "child": "door_leaf", "origin": {"xyz": [0, 0, 0.006], "rpy": [0, 0, 0]}, "axis": [0, 1, 0], "limit": {"lower": 0, "upper": 1.57, "effort": 1, "velocity": 1}},
                {"id": "latch_rotate", "type": "revolute", "parent": "door_leaf", "child": "latch_tab", "origin": {"xyz": [0.048, 0, 0.012], "rpy": [0, 0, 0]}, "axis": [0, 0, 1], "limit": {"lower": -1.57, "upper": 1.57, "effort": 1, "velocity": 1}},
            ],
        ),
        plan(
            "train45_pcb_panel_mount",
            "PCB面板安装框：螺柱、窗口和端口开孔按FDM约束。",
            [
                part("panel_frame", "PCB面板框", "带窗口和螺柱的安装框", [
                    box([120, 76, 5]),
                    cyl(7, 8, [-48, -28, 6]),
                    cyl(7, 8, [48, -28, 6]),
                    cyl(7, 8, [-48, 28, 6]),
                    cyl(7, 8, [48, 28, 6]),
                ], [cut_box([0, 0, 0], [82, 42, 10]), cut_box([0, 34, 0], [32, 10, 10]), hole([-48, -28, 6], 3.4), hole([48, -28, 6], 3.4), hole([-48, 28, 6], 3.4), hole([48, 28, 6], 3.4)]),
            ],
            "fdm",
            ["window cutout", "port cutout", "M3 standoffs"],
        ),
        plan(
            "train46_small_pneumatic_manifold",
            "小型气路歧管：多端口孔、安装孔和CNC倒角意图。",
            [
                part("manifold", "气路歧管", "CNC小型气路块", [box([86, 28, 24])],
                     [hole([-28, 0, 0], 6.2, "y", 40), hole([0, 0, 0], 6.2, "y", 40), hole([28, 0, 0], 6.2, "y", 40), hole([0, 0, 0], 8.2, "x", 100), hole([-32, 0, -8], 4.5, "z", 40), hole([32, 0, -8], 4.5, "z", 40), chamfer(0.8)]),
            ],
            "cnc",
            ["intersecting ports", "mount holes", "external chamfer intent"],
        ),
        plan(
            "train47_resin_lightpipe_holder",
            "导光柱支架：小孔放量、细柱加粗和遮光罩结构。",
            [
                part("lightpipe_holder", "导光柱支架", "SLA导光柱固定件", [
                    box([38, 18, 4]),
                    cyl(5, 12, [-12, 0, 8]),
                    cyl(5, 12, [0, 0, 8]),
                    cyl(5, 12, [12, 0, 8]),
                    box([38, 3, 14], [0, -8, 8]),
                ], [hole([-12, 0, 8], 2.25, "z", 24), hole([0, 0, 8], 2.25, "z", 24), hole([12, 0, 8], 2.25, "z", 24), hole([-15, 0, 0], 2.4), hole([15, 0, 0], 2.4), fillet(0.4)]),
            ],
            "resin",
            ["small holes enlarged", "posts >=1.5mm", "anti-light wall"],
        ),
        plan(
            "train48_gantry_endstop_slider",
            "龙门限位滑块：夹紧槽、传感器触发片和滑动调整。",
            [
                part("rail_clamp", "导轨夹块", "龙门导轨夹紧块", [box([46, 30, 20])], [cut_box([0, 0, -4], [50, 12, 12]), cut_box([20, 0, 0], [4, 36, 24]), hole([0, 12, 3], 4.5, "x", 60)]),
                part("trigger_flag", "触发片", "限位开关触发片", [box([24, 3, 34]), box([12, 14, 4], [0, 0, -15])], [slot([0, 0, -15], 12, 3.4, "x")], [0, -18, 12]),
            ],
            "fdm",
            ["clamp slot", "trigger flag", "adjustable screw slot"],
        ),
        plan(
            "train49_camera_gimbal_roll_axis",
            "相机横滚轴：支架、滚转环和相机板分件，连续转轴。",
            [
                part("roll_frame", "横滚框架", "云台横滚外框", [box([76, 8, 60], [0, -34, 30]), box([76, 8, 60], [0, 34, 30]), box([76, 68, 8], [0, 0, 4])], [hole([0, -34, 30], 8.4, "y", 20), hole([0, 34, 30], 8.4, "y", 20)]),
                part("roll_ring", "横滚环", "相机滚转环近似件", [cyl(52, 8, [0, 0, 0], [90, 0, 0]), box([44, 6, 8])], [hole([0, 0, 0], 36, "y", 20), hole([-16, 0, 0], 3.4), hole([16, 0, 0], 3.4)], [0, 0, 30]),
                part("camera_plate", "相机安装板", "小相机安装面", [box([38, 28, 5])], [hole([-12, 0, 0], 3.4), hole([12, 0, 0], 3.4)], [0, 0, 30]),
            ],
            "mechanism",
            ["continuous roll joint", "camera screw holes", "separate frame/ring/plate"],
            joints=[
                {"id": "roll_axis", "type": "continuous", "parent": "roll_frame", "child": "roll_ring", "origin": {"xyz": [0, 0, 0.03], "rpy": [0, 0, 0]}, "axis": [0, 1, 0]},
                {"id": "camera_plate_fixed", "type": "fixed", "parent": "roll_ring", "child": "camera_plate", "origin": {"xyz": [0, 0, 0.03], "rpy": [0, 0, 0]}, "axis": [0, 0, 1]},
            ],
        ),
        plan(
            "train50_bench_power_supply_panel",
            "台式电源面板：表头窗、旋钮孔、端子孔和安装孔齐全。",
            [
                part("front_panel", "电源前面板", "CNC或FDM台式电源面板", [box([160, 72, 4])],
                     [cut_box([-42, 8, 0], [50, 28, 10]), hole([24, 10, 0], 10.4), hole([52, 10, 0], 10.4), hole([24, -18, 0], 8.2), hole([52, -18, 0], 8.2), hole([-70, -28, 0], 4.5), hole([70, -28, 0], 4.5), hole([-70, 28, 0], 4.5), hole([70, 28, 0], 4.5), chamfer(0.6)]),
            ],
            "mixed",
            ["meter window", "knob and binding post holes", "panel mount holes"],
        ),
    ]


def suite_cases(suite):
    all_cases = cases()
    if suite == "10":
        return all_cases[:10]
    if suite == "30":
        return all_cases[:30]
    if suite == "50":
        return all_cases
    raise ValueError(f"unsupported suite: {suite}")


def run_case(index, item, batch_dir):
    case_dir = batch_dir / f"{index:02d}_{item['name']}"
    case_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "name": item["name"],
        "outputDir": str(case_dir),
        "relations": item.get("relations", []),
        "joints": item.get("joints", []),
        "parts": item["parts"],
    }
    manifest_path = case_dir / "assembly-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    env = os.environ.copy()
    env["AI_CAD_CADQUERY_MANIFEST"] = str(manifest_path)
    proc = subprocess.run(
        [str(CADQUERY_PYTHON), str(BUILDER)],
        cwd=str(ROOT),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    )

    result = {
        "index": index,
        "name": item["name"],
        "process": item["trainingProcess"],
        "reply": item["reply"],
        "checks": item["trainingChecks"],
        "outputDir": str(case_dir),
        "returncode": proc.returncode,
        "stdout": proc.stdout[-2000:],
        "stderr": proc.stderr[-3000:],
        "status": "fail",
        "warnings": [],
        "missing": [],
    }
    if proc.returncode != 0:
        return result

    try:
        summary = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception as exc:
        result["warnings"].append(f"builder JSON parse failed: {exc}")
        summary = {}

    required = ["assembly.step", "assembly.stl", "assembly.png"]
    for filename in required:
        if not (case_dir / filename).exists():
            result["missing"].append(filename)
    for item_part in item["parts"]:
        safe_id = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in str(item_part["id"]))[:60]
        for suffix in [".step", ".stl"]:
            filename = f"{safe_id}{suffix}"
            if not (case_dir / filename).exists():
                result["missing"].append(filename)
    if "Skipping finish features" in proc.stderr:
        result["warnings"].append("finish features skipped by default crash guard")
    result["summary"] = summary
    result["status"] = "warn" if result["missing"] or result["warnings"] else "pass"
    return result


def write_report(results, batch_dir, suite):
    FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    total = len(results)
    json_path = FEEDBACK_DIR / f"AI-CAD建模{suite}组训练结果-{stamp}.json"
    md_path = FEEDBACK_DIR / f"AI-CAD建模{suite}组训练反馈-{stamp}.md"

    counts = {
        "pass": sum(1 for item in results if item["status"] == "pass"),
        "warn": sum(1 for item in results if item["status"] == "warn"),
        "fail": sum(1 for item in results if item["status"] == "fail"),
    }
    process_counts = {}
    for item in results:
        process_counts.setdefault(item["process"], {"total": 0, "pass": 0, "warn": 0, "fail": 0})
        process_counts[item["process"]]["total"] += 1
        process_counts[item["process"]][item["status"]] += 1

    payload = {
        "savedAt": datetime.now().isoformat(timespec="seconds"),
        "suite": suite,
        "batchDir": str(batch_dir),
        "counts": counts,
        "processCounts": process_counts,
        "results": results,
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        f"# AI-CAD 建模 {suite} 组训练反馈",
        "",
        f"- 批次目录: `{batch_dir}`",
        f"- 总数: {total}",
        f"- 通过: {counts['pass']}",
        f"- 警告: {counts['warn']}",
        f"- 失败: {counts['fail']}",
        "",
        "## 验证口径",
        "",
        "本报告不把“模型能生成”直接等同于“满足真实需求”。每组按以下证据链判断：",
        "",
        "- 需求假设：若用户未给载荷、材料、工艺、标准件型号，则按训练用保守工艺假设评价。",
        "- 几何证据：`assembly-manifest.json`中的尺寸、孔径、槽宽、壁厚、零件位姿和特征是否对应验收指标。",
        "- 构建证据：CadQuery是否成功输出装配STEP、装配STL、PNG，以及每个零件STEP/STL。",
        "- 制造性证据：FDM/CNC/SLA规则是否被反映到孔径、间隙、槽宽、倒角/圆角意图和最小壁厚。",
        "- 装配/运动证据：有相对运动的机构必须输出明确`joints`；关节平移使用米、旋转使用弧度，CAD pose仍用毫米和角度。",
        "- 未验证项：真实强度、寿命、热变形、加工设备限制、标准件精确适配和实物手感，需要FEA、CAM检查或样件试制验证。",
        "",
        "## 方案原理",
        "",
        "训练流程采用“需求分解 -> 结构化特征计划 -> CadQuery实体构建 -> 产物检查 -> 规则反馈沉淀”。反馈只引用可追溯证据：一条优化建议必须能对应到具体工艺规则、模型特征或失败日志；无法从当前模型证明的内容标为后续验证项。",
        "",
        "## 分组结果",
        "",
        "| # | 名称 | 工艺/类型 | 状态 | 验收指标 | 备注 |",
        "|---:|---|---|---|---|---|",
    ]
    for item in results:
        notes = []
        if item["missing"]:
            notes.append("缺失: " + ", ".join(item["missing"]))
        if item["warnings"]:
            notes.extend(item["warnings"])
        if not notes:
            notes.append("STEP/STL/PNG完成")
        checks = "<br>".join(item.get("checks") or [])
        lines.append(f"| {item['index']} | `{item['name']}` | {item['process']} | {item['status']} | {checks} | {'; '.join(notes)} |")

    lines.extend([
        "",
        "## 本批优化反馈",
        "",
        f"- CadQuery主构建链路在{suite}组样本中可稳定输出装配STEP、装配STL和PNG预览；这只能证明几何构建链路可用，不等同于真实工况已验证。",
        "- 倒角/圆角特征当前默认被builder的崩溃保护跳过，因此带倒角/圆角意图的样本只能判为warn；提示词里仍可保留倒角/圆角意图，但UI和报告必须标明“精修特征可能被稳定模式跳过”。",
        "- 运动机构样本应强制输出显式`joints`，关节原点使用米和弧度；几何位姿仍保持毫米和角度，不能混用。",
        "- FDM样本中，孔、轴、滑槽、卡扣、铰链都应默认按工艺加间隙：M3约3.4mm、M4约4.6-4.8mm、6mm转轴孔约6.6mm。",
        "- CNC样本中，槽宽和夹紧缝不要小于3mm，口袋优先浅而宽；内矩形切口需要圆角或dogbone策略，当前feature schema还缺少显式dogbone特征。",
        "- SLA样本中，薄壁不应低于0.8-1.0mm，小柱不应低于1.5mm，中空壳体要有排液/通气孔和面板加强筋。",
        "- 对复杂外形如齿轮、滚花、燕尾和半圆管夹，当前只能用基础体近似；建议后续扩展`pattern`、`revolve`、`sweep`、`thread/knurl`或专用齿形特征，减少大量手写add primitives。",
        "- 装配输出可用，但直接 builder 批跑不会生成完整运动学关系包。若要做全链路 CI，建议增加一个直接 plan 装配 API，或把 server 中的 kinematic 打包函数抽成可复用 CLI。",
        "",
        "## 建议沉淀到提示词的规则",
        "",
        "- 用户未说明工艺时，先声明采用通用保守制造假设；用户选择FDM/CNC/SLA后，所有孔径、槽宽、壁厚和配合面必须按对应工艺调整。",
        "- 生成机械装配时，独立运动件必须独立成 part，不要 boolean 合并；铰链、滑轨、丝杆、摇杆、夹爪必须有对应的运动关节。",
        "- 每个零件控制在少量基础体和特征内，避免为了视觉细节堆叠过多小boolean；把可制造性和装配基准优先级放在外观细节前。",
        "",
        f"JSON原始结果: `{json_path}`",
    ])
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return json_path, md_path, counts


def main():
    if any(arg in {"-h", "--help"} for arg in sys.argv[1:]):
        print(
            "usage: aicad_training_30.py [--suite 10|30|50]\n\n"
            "Run AI-CAD CadQuery training/regression cases.\n"
            "--suite 10 runs the original 10 manufacturing-feedback cases.\n"
            "--suite 30 runs the full 30-case regression set.\n"
            "--suite 50 runs the extended 50-case sample regression set.\n"
            "Outputs are written to assemblies/training-<suite>-* and "
            "/home/kkkk/桌面/aicad建模反馈/AI-CAD建模<suite>组训练反馈-*.md.\n"
        )
        return 0
    suite = "30"
    args = list(sys.argv[1:])
    while args:
        arg = args.pop(0)
        if arg == "--suite" and args:
            suite = args.pop(0)
            continue
        raise SystemExit("unknown arguments: " + " ".join(sys.argv[1:]))
    if suite not in {"10", "30", "50"}:
        raise SystemExit("--suite must be 10, 30, or 50")

    batch_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    batch_dir = ASSEMBLIES_DIR / f"training-{suite}-{batch_stamp}"
    batch_dir.mkdir(parents=True, exist_ok=True)
    items = suite_cases(suite)
    expected = int(suite)
    if len(items) != expected:
        raise SystemExit(f"expected {expected} cases, got {len(items)}")

    results = []
    for index, item in enumerate(items, 1):
        print(f"[{index:02d}/{expected}] {item['name']}", flush=True)
        try:
            results.append(run_case(index, item, batch_dir))
        except subprocess.TimeoutExpired as exc:
            results.append({
                "index": index,
                "name": item["name"],
                "process": item["trainingProcess"],
                "reply": item["reply"],
                "checks": item["trainingChecks"],
                "outputDir": str(batch_dir / f"{index:02d}_{item['name']}"),
                "status": "fail",
                "returncode": None,
                "stdout": (exc.stdout or "")[-2000:] if isinstance(exc.stdout, str) else "",
                "stderr": "timeout",
                "warnings": [],
                "missing": [],
            })
        except Exception as exc:
            results.append({
                "index": index,
                "name": item["name"],
                "process": item["trainingProcess"],
                "reply": item["reply"],
                "checks": item["trainingChecks"],
                "outputDir": str(batch_dir / f"{index:02d}_{item['name']}"),
                "status": "fail",
                "returncode": None,
                "stdout": "",
                "stderr": str(exc),
                "warnings": [],
                "missing": [],
            })

    json_path, md_path, counts = write_report(results, batch_dir, suite)
    print(json.dumps({
        "batchDir": str(batch_dir),
        "report": str(md_path),
        "json": str(json_path),
        "counts": counts,
    }, ensure_ascii=False, indent=2))
    return 0 if counts["fail"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
