"""Build exact solids with NVIDIA USD BRep; no CadQuery/OpenCascade imports."""
import json
import math
import os
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import time
from importlib.metadata import version

import usd_brep as b
from usd_brep_export import stage_units
from brep_review_core import compare_geometry


SUPPORTED = {"base_box", "base_cylinder", "base_sphere", "base_spur_gear", "hole", "cut_box", "add_primitive", "dimension"}


def number(value, positive=False):
    result = float(value)
    if not math.isfinite(result) or abs(result) > 10000 or (positive and result <= 0):
        raise ValueError("Dimensions must be finite, within 10000 mm, and positive where required")
    return result


def vector(value, default=(0, 0, 0)):
    value = default if value is None else value
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError("Expected a three-component vector")
    return tuple(number(v) for v in value)


def apply_pose(solid, pose=None):
    pose = pose or {}
    if set(pose) - {"translate", "rotate"}:
        raise ValueError("Native pose accepts translate in mm and rotate in degrees only")
    for axis, angle in zip(((1, 0, 0), (0, 1, 0), (0, 0, 1)), vector(pose.get("rotate"))):
        if angle:
            b.rotate(solid, (0, 0, 0), axis, angle)
    shift = vector(pose.get("translate"))
    if any(shift):
        b.translate(solid, shift)
    return solid


def primitive(spec):
    kind = spec.get("type", "box")
    centered = spec.get("center", True)
    if not isinstance(centered, bool):
        raise ValueError("Primitive center must be boolean")
    if kind == "box":
        size = vector(spec.get("size"), (10, 10, 10))
        for value in size:
            number(value, positive=True)
        origin = tuple(-v / 2 for v in size) if centered else (0, 0, 0)
        solid = b.create_box(origin, *size)
    elif kind == "cylinder":
        radius = number(spec.get("radius", number(spec.get("diameter", 10)) / 2), positive=True)
        height = number(spec.get("height", 10), positive=True)
        solid = b.create_cylinder((0, 0, -height / 2 if centered else 0), radius, height)
    elif kind == "spur_gear":
        from native_gears import gear
        solid, _ = gear(spec)
        if not centered:
            b.translate(solid, (0, 0, float(spec['width'])/2))
    elif kind == "sphere":
        solid = b.create_sphere((0, 0, 0), number(spec.get("radius", 5), positive=True))
    else:
        raise ValueError(f"NVIDIA backend does not yet support primitive {kind}; no fallback was used")
    return apply_pose(solid, spec.get("pose"))


def hole_tool(params):
    radius = number(params["diameter"] / 2 if "diameter" in params else params.get("radius", 2.5), positive=True)
    depth = number(params.get("depth", 1000), positive=True)
    solid = b.create_cylinder((0, 0, -depth), radius, depth * 2)
    axis = params.get("axis", "z")
    if axis == "x":
        b.rotate(solid, (0, 0, 0), (0, 1, 0), 90)
    elif axis == "y":
        b.rotate(solid, (0, 0, 0), (1, 0, 0), 90)
    elif axis != "z":
        raise ValueError("Hole axis must be x, y, or z")
    b.translate(solid, vector(params.get("center")))
    return solid


def ordered_nodes(nodes):
    if not isinstance(nodes, list) or not nodes or len(nodes) > 64:
        raise ValueError("Provide between 1 and 64 feature-tree nodes")
    ids = [node.get("id") for node in nodes]
    if any(not isinstance(value, str) or not value for value in ids) or len(set(ids)) != len(ids):
        raise ValueError("Feature IDs must be unique nonempty strings")
    pending, done, ordered = list(nodes), set(), []
    while pending:
        ready = next((node for node in pending if set(node.get("dependsOn", [])) <= done), None)
        if ready is None:
            raise ValueError("Feature dependency is missing or cyclic")
        ordered.append(ready)
        done.add(ready["id"])
        pending.remove(ready)
    return ordered


def build_solid(part):
    solid, trace = None, []
    nodes = ordered_nodes(part.get("featureTree"))
    # Reject unsupported operations before starting the native kernel.
    for node in nodes:
        if node.get("enabled", True) and node.get("type") not in SUPPORTED:
            raise ValueError(f"NVIDIA backend does not yet support {node.get('type')}; no fallback was used")
    for node in nodes:
        if not node.get("enabled", True):
            continue
        kind, params = node["type"], node.get("params", {})
        if kind == "dimension":
            continue
        if kind.startswith("base_"):
            item = primitive({**params, "type": kind[5:]})
            solid = item if solid is None else b.boolean_union(solid, item)
            operation = "usd_brep.linear_sweep" if kind == "base_spur_gear" else f"usd_brep.create_{kind[5:]}"
        else:
            if solid is None:
                raise ValueError("Create base geometry before applying a feature")
            if kind == "hole":
                solid = b.boolean_difference(solid, hole_tool(params))
                operation = "usd_brep.boolean_difference"
            elif kind == "cut_box":
                tool = primitive({"type": "box", "size": params.get("size", [10, 10, 10]), "center": True,
                                  "pose": {"translate": params.get("center", [0, 0, 0]), "rotate": params.get("rotate", [0, 0, 0])}})
                solid = b.boolean_difference(solid, tool)
                operation = "usd_brep.boolean_difference"
            elif kind == "add_primitive":
                solid = b.boolean_union(solid, primitive(params.get("primitive", {})))
                operation = "usd_brep.boolean_union"
        trace.append({"id": node["id"], "type": kind, "operation": operation})
    if solid is None:
        raise ValueError("Feature tree did not create a solid")
    return apply_pose(solid, part.get("pose")), trace


def write_stl(mesh, destination):
    arrays = mesh.to_mesh_arrays()
    points, stream = arrays["points"], arrays["faces"]
    triangles, offset = [], 0
    while offset < len(stream):
        count = stream[offset]
        face = stream[offset + 1:offset + 1 + count]
        if count < 3 or len(face) != count:
            raise RuntimeError("Invalid native tessellation face")
        triangles.extend((face[0], face[i], face[i + 1]) for i in range(1, count - 1))
        offset += count + 1
    with Path(destination).open("wb") as handle:
        handle.write(b"Built by NVIDIA USD BRep / SMLib".ljust(80, b"\0"))
        handle.write(struct.pack("<I", len(triangles)))
        for indices in triangles:
            a, c, d = (points[index] for index in indices)
            u, v = [c[i] - a[i] for i in range(3)], [d[i] - a[i] for i in range(3)]
            normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
            length = math.sqrt(sum(value*value for value in normal))
            normal = [value/length for value in normal] if length else [0, 0, 0]
            handle.write(struct.pack("<12fH", *normal, *a, *c, *d, 0))
    return len(points), len(triangles)


def build(part, output_dir):
    build_start = time.perf_counter()
    solid, trace = build_solid(part)
    modeling_ms = (time.perf_counter() - build_start) * 1000
    if not b.is_manifold_solid(solid):
        raise ValueError("NVIDIA kernel did not produce a closed manifold solid")
    volume = b.compute_volume(solid, relative_accuracy=1e-8)
    bounds = solid.bounding_box()
    def facts(body, mass):
        box = body.bounding_box()
        census = body.material_census()
        return {"solidCount": census["solid_count"], "volume": mass, "bbox": [box[1][i]-box[0][i] for i in range(3)],
                "boundsMin": list(box[0]), "boundsMax": list(box[1]), "center": list(body.center()),
                "faceCount": body.face_count(), "edgeCount": body.edge_count()}
    original_facts = facts(solid, volume)
    if part.get("requireSingleSolid") and original_facts["solidCount"] != 1:
        raise ValueError("Part is required to contain one connected solid")
    if not math.isfinite(volume) or volume <= 0:
        raise ValueError("Native solid volume is invalid")
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="aicad-native-", dir=os.path.realpath(tempfile.gettempdir())) as directory:
        exact = Path(directory) / "solid.usda"
        mesh_file = Path(directory) / "mesh.usda"
        b.usd.export_brep(solid, str(exact))
        exact.write_text(stage_units(exact.read_text(encoding="utf-8")), encoding="utf-8")
        restored = b.usd.import_breps(str(exact))
        if len(restored) != 1 or not b.is_manifold_solid(restored[0]):
            raise RuntimeError("Native BRep USD round trip did not preserve a solid")
        restored_volume = b.compute_volume(restored[0], relative_accuracy=1e-8)
        roundtrip = compare_geometry(original_facts, facts(restored[0], restored_volume))
        if not roundtrip["valid"]:
            raise RuntimeError("Native BRep USD round trip changed geometry: " + json.dumps(roundtrip["issues"]))
        mesh = b.tessellate(solid, chord_height_tolerance=0.05, curve_angle_tolerance_deg=10,
                            surface_angle_tolerance_deg=10)
        vertices, triangles = write_stl(mesh, output / "native-preview.stl")
        b.usd.export_mesh(mesh, str(mesh_file))
        mesh_file.write_text(stage_units(mesh_file.read_text(encoding="utf-8")), encoding="utf-8")
        shutil.copyfile(exact, output / "native-solid.usda")
        shutil.copyfile(mesh_file, output / "native-mesh.usda")
    report = {"engine": "nvidia-usd-brep", "kernel": "SMLib", "version": version("usd-brep"),
              "representation": "brep", "cadqueryUsed": False, "volumeMm3": volume,
              "restoredVolumeMm3": restored_volume, "manifoldSolid": True,
              "faceCount": solid.face_count(), "edgeCount": solid.edge_count(),
              "bboxMm": [solid.bounding_box()[1][i] - solid.bounding_box()[0][i] for i in range(3)],
              "vertices": vertices, "triangles": triangles,
              "roundTrip": "passed", "metersPerUnit": 0.001, "upAxis": "Z", "featureTrace": trace}
    report["modelingMs"] = modeling_ms
    report["facts"] = original_facts
    report["usdRoundTrip"] = roundtrip
    report["bboxMethod"] = "conservative vertex/edge/face union; may include tolerance padding"
    if any(node.get('type') == 'base_spur_gear' for node in part.get('featureTree', [])):
        report['gearProfile'] = 'sampled involute; radial root transitions; motion and strength unverified'
    (output / "native-build-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        print(json.dumps(build(request["part"], request["outputDir"])))
    except ValueError as error:
        print(json.dumps({"error": str(error), "code": "USD_BREP_UNSUPPORTED_OR_INVALID"}))
        sys.exit(2)
