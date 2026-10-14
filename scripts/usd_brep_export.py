"""Bridge existing millimeter STL geometry through NVIDIA USD BRep's mesh API.

This is a visualization export, not a conversion to exact NURBS BRep.
Native USD I/O is staged in an ASCII temporary path for Windows compatibility.
"""
import argparse
from collections import Counter
import json
import math
import os
from pathlib import Path
import re
import struct
import tempfile
from importlib.metadata import version


def read_stl(filename):
    if Path(filename).stat().st_size > 100_000_000:
        raise ValueError("STL exceeds 100 MB")
    data = Path(filename).read_bytes()
    if len(data) > 100_000_000:
        raise ValueError("STL exceeds 100 MB")
    triangles = []
    count = struct.unpack_from("<I", data, 80)[0] if len(data) >= 84 else 0
    if len(data) >= 84 and len(data) == 84 + count * 50:
        for offset in range(84, len(data), 50):
            coordinates = struct.unpack_from("<9f", data, offset + 12)
            triangles.append([tuple(coordinates[i:i + 3]) for i in (0, 3, 6)])
    else:
        text = data.decode("ascii")
        if not text.lstrip().lower().startswith("solid") or "endsolid" not in text.lower():
            raise ValueError("Invalid binary or ASCII STL")
        vertices = []
        for line in text.splitlines():
            tokens = line.strip().split()
            if tokens and tokens[0].lower() == "vertex":
                if len(tokens) != 4:
                    raise ValueError("Invalid STL vertex")
                vertices.append(tuple(float(value) for value in tokens[1:]))
        if len(vertices) % 3:
            raise ValueError("Incomplete STL triangle")
        triangles = [vertices[i:i + 3] for i in range(0, len(vertices), 3)]
    if not triangles:
        raise ValueError("STL contains no triangles")
    points, indices, lookup = [], [], {}
    for triangle in triangles:
        for point in triangle:
            if not all(math.isfinite(value) for value in point):
                raise ValueError("STL contains non-finite coordinates")
            point = tuple(struct.unpack("<f", struct.pack("<f", value))[0] for value in point)
            if point not in lookup:
                lookup[point] = len(points)
                points.append(point)
            indices.append(lookup[point])
    return points, indices


def mesh_stage(points, indices):
    point_text = ", ".join("(" + ", ".join(repr(v) for v in point) + ")" for point in points)
    return ('#usda 1.0\n(\n    metersPerUnit = 0.001\n    upAxis = "Z"\n)\n'
            'def Xform "World" {\n def Mesh "Mesh0" {\n'
            f'  point3f[] points = [{point_text}]\n'
            f'  int[] faceVertexCounts = [{", ".join(["3"] * (len(indices) // 3))}]\n'
            f'  int[] faceVertexIndices = [{", ".join(map(str, indices))}]\n'
            '  uniform token subdivisionScheme = "none"\n }\n}\n')


def stage_units(text):
    header, body = text.split("\n", 1)
    if body.lstrip().startswith("("):
        body = re.sub(r"^\s*\(", '(\n    metersPerUnit = 0.001\n    upAxis = "Z"', body, count=1)
    else:
        body = '(\n    metersPerUnit = 0.001\n    upAxis = "Z"\n)\n' + body
    return header + "\n" + body


def triangle_signature(points, triangles):
    """Compare oriented faces independently of vertex and face ordering."""
    result = Counter()
    for face in triangles:
        vertices = tuple(tuple(points[index]) for index in face)
        result[min(vertices, vertices[1:] + vertices[:1], vertices[2:] + vertices[:2])] += 1
    return result


def check_round_trip(mesh, points, indices):
    arrays = mesh.to_mesh_arrays()
    faces = arrays["faces"]
    triangles = []
    offset = 0
    while offset < len(faces):
        count = faces[offset]
        if count != 3 or offset + count >= len(faces):
            raise RuntimeError("USD mesh round trip changed triangular topology")
        triangles.append(faces[offset + 1:offset + 4])
        offset += 4
    expected = [indices[i:i + 3] for i in range(0, len(indices), 3)]
    if triangle_signature(arrays["points"], triangles) != triangle_signature(points, expected):
        raise RuntimeError("USD mesh round trip changed geometry or face winding")


def export_mesh(source, destination):
    import usd_brep as brep
    points, indices = read_stl(source)
    # Resolve Windows redirections before native USD's atomic rename.
    temp_root = os.path.realpath(tempfile.gettempdir())
    with tempfile.TemporaryDirectory(prefix="aicad-usd-", dir=temp_root) as directory:
        seed = Path(directory) / "input.usda"
        exported = Path(directory) / "output.usda"
        seed.write_text(mesh_stage(points, indices), encoding="utf-8")
        meshes = brep.usd.import_meshes(str(seed))
        if len(meshes) != 1:
            raise RuntimeError("Expected one mesh from the STL bridge")
        brep.usd.export_mesh(meshes[0], str(exported))
        text = stage_units(exported.read_text(encoding="utf-8"))
        exported.write_text(text, encoding="utf-8")
        restored = brep.usd.import_meshes(str(exported))
        if len(restored) != 1:
            raise RuntimeError("USD mesh round trip failed")
        check_round_trip(restored[0], points, indices)
        destination = Path(destination)
        destination.write_text(text, encoding="utf-8")
    return {"engine": "nvidia-usd-brep", "version": version("usd-brep"),
            "representation": "mesh", "metersPerUnit": 0.001, "upAxis": "Z",
            "vertices": len(points), "triangles": len(indices) // 3,
            "roundTrip": "passed"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.probe:
        import usd_brep  # noqa: F401
        result = {"version": version("usd-brep"), "representation": "mesh"}
    else:
        if not args.input or not args.output:
            parser.error("--input and --output are required")
        result = export_mesh(args.input, args.output)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
