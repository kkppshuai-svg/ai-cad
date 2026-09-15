import json
import math
import os
import sys

import FreeCAD
import Mesh
import Part


def v(values, default=0):
    data = list(values or [])
    data += [default, default, default]
    return FreeCAD.Vector(float(data[0]), float(data[1]), float(data[2]))


def safe_name(value):
    text = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in str(value))
    return text[:60] or "part"


def placement_from_pose(pose):
    pose = pose or {}
    translate = v(pose.get("translate", [0, 0, 0]))
    rx, ry, rz = [float(x) for x in (list(pose.get("rotate", [0, 0, 0])) + [0, 0, 0])[:3]]
    placement = FreeCAD.Placement(translate, FreeCAD.Rotation())
    placement = placement.multiply(FreeCAD.Placement(FreeCAD.Vector(), FreeCAD.Rotation(FreeCAD.Vector(1, 0, 0), rx)))
    placement = placement.multiply(FreeCAD.Placement(FreeCAD.Vector(), FreeCAD.Rotation(FreeCAD.Vector(0, 1, 0), ry)))
    placement = placement.multiply(FreeCAD.Placement(FreeCAD.Vector(), FreeCAD.Rotation(FreeCAD.Vector(0, 0, 1), rz)))
    return placement


def make_primitive(spec):
    kind = spec.get("type", "box")
    center = bool(spec.get("center", True))

    if kind == "box":
        size = spec.get("size", [10, 10, 10])
        sx, sy, sz = [float(x) for x in (list(size) + [10, 10, 10])[:3]]
        shape = Part.makeBox(sx, sy, sz)
        if center:
            shape.translate(FreeCAD.Vector(-sx / 2, -sy / 2, -sz / 2))
        return shape

    if kind == "cylinder":
        radius = float(spec.get("radius", spec.get("diameter", 10) / 2))
        height = float(spec.get("height", 10))
        shape = Part.makeCylinder(radius, height)
        if center:
            shape.translate(FreeCAD.Vector(0, 0, -height / 2))
        return shape

    if kind == "sphere":
        return Part.makeSphere(float(spec.get("radius", 5)))

    if kind == "cone":
        r1 = float(spec.get("radius1", spec.get("bottomRadius", 8)))
        r2 = float(spec.get("radius2", spec.get("topRadius", 3)))
        height = float(spec.get("height", 10))
        shape = Part.makeCone(r1, r2, height)
        if center:
            shape.translate(FreeCAD.Vector(0, 0, -height / 2))
        return shape

    raise ValueError("Unsupported primitive type: {}".format(kind))


def apply_local_pose(shape, spec):
    pose = spec.get("pose", {})
    shape.Placement = placement_from_pose(pose).multiply(shape.Placement)
    return shape


def cylinder_tool(feature, base_shape):
    radius = float(feature.get("radius", feature.get("diameter", 5) / 2))
    depth = float(feature.get("depth", 1000))
    axis = feature.get("axis", "z").lower()
    center = v(feature.get("center", [0, 0, 0]))
    tool = Part.makeCylinder(radius, depth)
    tool.translate(FreeCAD.Vector(0, 0, -depth / 2))
    if axis == "x":
        tool.rotate(FreeCAD.Vector(), FreeCAD.Vector(0, 1, 0), 90)
    elif axis == "y":
        tool.rotate(FreeCAD.Vector(), FreeCAD.Vector(1, 0, 0), 90)
    tool.translate(center)
    return tool


def slot_tool(feature):
    length = float(feature.get("length", 20))
    width = float(feature.get("width", feature.get("diameter", 5)))
    depth = float(feature.get("depth", 1000))
    axis = feature.get("axis", "x").lower()
    center = v(feature.get("center", [0, 0, 0]))
    r = width / 2
    if axis == "x":
        box = Part.makeBox(max(length - width, 0.1), width, depth)
        box.translate(FreeCAD.Vector(-(length - width) / 2, -width / 2, -depth / 2))
        c1 = Part.makeCylinder(r, depth)
        c2 = Part.makeCylinder(r, depth)
        c1.translate(FreeCAD.Vector(-length / 2 + r, 0, -depth / 2))
        c2.translate(FreeCAD.Vector(length / 2 - r, 0, -depth / 2))
    else:
        box = Part.makeBox(width, max(length - width, 0.1), depth)
        box.translate(FreeCAD.Vector(-width / 2, -(length - width) / 2, -depth / 2))
        c1 = Part.makeCylinder(r, depth)
        c2 = Part.makeCylinder(r, depth)
        c1.translate(FreeCAD.Vector(0, -length / 2 + r, -depth / 2))
        c2.translate(FreeCAD.Vector(0, length / 2 - r, -depth / 2))
    tool = box.fuse(c1).fuse(c2)
    tool.translate(center)
    return tool


def apply_features(shape, features):
    for feature in features or []:
        kind = feature.get("type")
        if kind == "hole":
            shape = shape.cut(cylinder_tool(feature, shape))
        elif kind == "slot":
            shape = shape.cut(slot_tool(feature))
        elif kind == "cut_box":
            tool = make_primitive({"type": "box", "size": feature.get("size", [10, 10, 10]), "center": True})
            apply_local_pose(tool, {"pose": {"translate": feature.get("center", [0, 0, 0]), "rotate": feature.get("rotate", [0, 0, 0])}})
            shape = shape.cut(tool)
        elif kind == "add":
            tool = make_primitive(feature.get("primitive", {"type": "box", "size": [10, 10, 10]}))
            apply_local_pose(tool, feature.get("primitive", {}))
            shape = shape.fuse(tool)
        elif kind == "fillet":
            radius = float(feature.get("radius", 1))
            try:
                shape = shape.makeFillet(radius, shape.Edges)
            except Exception:
                pass
        elif kind == "chamfer":
            distance = float(feature.get("distance", 1))
            try:
                shape = shape.makeChamfer(distance, shape.Edges)
            except Exception:
                pass
    try:
        shape = shape.removeSplitter()
    except Exception:
        pass
    return shape


def build_part(part):
    primitives = part.get("primitives") or [part.get("primitive") or {"type": "box", "size": [10, 10, 10]}]
    shape = None
    for primitive in primitives:
        item = make_primitive(primitive)
        apply_local_pose(item, primitive)
        shape = item if shape is None else shape.fuse(item)
    return apply_features(shape, part.get("features", []))


def main():
    manifest_path = os.environ.get("AI_CAD_NATIVE_MANIFEST")
    if not manifest_path and len(sys.argv) >= 2:
        manifest_path = sys.argv[-1]
    if not manifest_path:
        raise SystemExit("usage: AI_CAD_NATIVE_MANIFEST=manifest.json freecadcmd freecad_build_native.py")

    with open(manifest_path, "r", encoding="utf-8") as handle:
        plan = json.load(handle)

    out_dir = plan["outputDir"]
    os.makedirs(out_dir, exist_ok=True)
    doc = FreeCAD.newDocument(safe_name(plan.get("name", "AI_CAD_Native_Assembly")))
    objects = []
    part_outputs = []

    for part in plan.get("parts", []):
        shape = build_part(part)
        obj = doc.addObject("Part::Feature", safe_name(part.get("id", part.get("name", "part"))))
        obj.Shape = shape
        obj.Label = part.get("name", obj.Name)
        obj.Placement = placement_from_pose(part.get("pose", {}))
        objects.append(obj)

        part_step = os.path.join(out_dir, safe_name(part.get("id", obj.Name)) + ".step")
        part_stl = os.path.join(out_dir, safe_name(part.get("id", obj.Name)) + ".stl")
        try:
            Part.export([obj], part_step)
        except Exception:
            part_step = None
        Mesh.export([obj], part_stl)
        part_outputs.append({
            "id": part.get("id"),
            "name": part.get("name"),
            "stepPath": part_step,
            "stlPath": part_stl,
        })

    doc.recompute()
    fcstd_path = os.path.join(out_dir, "assembly.FCStd")
    step_path = os.path.join(out_dir, "assembly.step")
    stl_path = os.path.join(out_dir, "assembly.stl")
    doc.saveAs(fcstd_path)
    Part.export(objects, step_path)
    Mesh.export(objects, stl_path)

    print(json.dumps({
        "fcstdPath": fcstd_path,
        "stepPath": step_path,
        "stlPath": stl_path,
        "parts": part_outputs,
        "relations": plan.get("relations", []),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
