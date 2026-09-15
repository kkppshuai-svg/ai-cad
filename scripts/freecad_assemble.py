import json
import math
import os
import sys

import FreeCAD
import Mesh
import Part


def vec(values):
    padded = list(values or []) + [0, 0, 0]
    return FreeCAD.Vector(float(padded[0]), float(padded[1]), float(padded[2]))


def placement_from_pose(pose):
    translate = vec(pose.get("translate", [0, 0, 0]))
    rotate = pose.get("rotate", [0, 0, 0]) or [0, 0, 0]
    rx, ry, rz = [float(v) for v in (list(rotate) + [0, 0, 0])[:3]]
    placement = FreeCAD.Placement(translate, FreeCAD.Rotation())
    placement = placement.multiply(FreeCAD.Placement(FreeCAD.Vector(), FreeCAD.Rotation(FreeCAD.Vector(1, 0, 0), rx)))
    placement = placement.multiply(FreeCAD.Placement(FreeCAD.Vector(), FreeCAD.Rotation(FreeCAD.Vector(0, 1, 0), ry)))
    placement = placement.multiply(FreeCAD.Placement(FreeCAD.Vector(), FreeCAD.Rotation(FreeCAD.Vector(0, 0, 1), rz)))
    return placement


def safe_name(value):
    text = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in str(value))
    return text[:60] or "part"


def main():
    manifest_path = os.environ.get("AI_CAD_MANIFEST")
    if not manifest_path and len(sys.argv) >= 2 and sys.argv[-1].endswith(".json"):
        manifest_path = sys.argv[-1]
    if not manifest_path:
        raise SystemExit("usage: AI_CAD_MANIFEST=manifest.json freecadcmd freecad_assemble.py")

    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    out_dir = manifest["outputDir"]
    os.makedirs(out_dir, exist_ok=True)

    doc = FreeCAD.newDocument(safe_name(manifest.get("name", "AI_CAD_Assembly")))
    objects = []

    for part in manifest.get("parts", []):
        stl_path = part["stlPath"]
        mesh = Mesh.Mesh(stl_path)
        shape = Part.Shape()
        shape.makeShapeFromMesh(mesh.Topology, 0.1)
        try:
            shape = Part.Solid(shape)
        except Exception:
            pass
        obj = doc.addObject("Part::Feature", safe_name(part.get("name", "part")))
        obj.Shape = shape
        obj.Placement = placement_from_pose(part.get("pose", {}))
        obj.Label = part.get("name", obj.Name)
        objects.append(obj)

    doc.recompute()

    fcstd_path = os.path.join(out_dir, "assembly.FCStd")
    step_path = os.path.join(out_dir, "assembly.step")
    doc.saveAs(fcstd_path)

    try:
        import Import

        Import.export(objects, step_path)
    except Exception as exc:
        with open(os.path.join(out_dir, "step-export-error.txt"), "w", encoding="utf-8") as handle:
            handle.write(str(exc))
        step_path = None

    summary = {
        "fcstdPath": fcstd_path,
        "stepPath": step_path,
        "partCount": len(objects),
        "relations": manifest.get("relations", []),
    }
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
