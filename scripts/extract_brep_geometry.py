#!/usr/bin/env python3
import argparse
import json
import math
from pathlib import Path

import cadquery as cq
import numpy as np


SURFACE_TYPES = ["PLANE", "CYLINDER", "CONE", "SPHERE", "TORUS", "BSPLINE", "BEZIER", "OTHER"]
CURVE_TYPES = ["LINE", "CIRCLE", "ELLIPSE", "BSPLINE", "BEZIER", "HYPERBOLA", "PARABOLA", "OTHER"]
FEATURE_NAMES = [
    "topology.solid_count_log", "topology.shell_count_log", "topology.face_count_log",
    "topology.edge_count_log", "topology.vertex_count_log", "topology.valid", "topology.closed",
    "bbox.x_ratio", "bbox.y_ratio", "bbox.z_ratio", "bbox.xy_ratio", "bbox.yz_ratio", "bbox.xz_ratio",
    "mass.volume_normalized", "mass.area_normalized", "mass.compactness",
    *[f"surface.{name.lower()}_ratio" for name in SURFACE_TYPES],
    *[f"curve.{name.lower()}_ratio" for name in CURVE_TYPES],
    "face.area_mean", "face.area_std", "face.area_min", "face.area_max",
    "edge.length_mean", "edge.length_std", "edge.length_min", "edge.length_max",
    "adjacency.degree_mean", "adjacency.degree_std", "adjacency.degree_min", "adjacency.degree_max",
]


def safe_geom_type(obj, allowed):
    try:
        value = str(obj.geomType()).upper()
    except Exception:
        value = "OTHER"
    return value if value in allowed else "OTHER"


def normalized_stats(values, scale):
    if not values:
        return [0.0, 0.0, 0.0, 0.0]
    array = np.asarray(values, dtype=np.float64) / max(float(scale), 1e-12)
    return [float(array.mean()), float(array.std()), float(array.min()), float(array.max())]


def load_step_shape(step_path):
    imported = cq.importers.importStep(str(step_path))
    values = [value for value in imported.vals() if hasattr(value, "Solids")]
    if not values:
        raise ValueError("STEP contains no importable BREP shape")
    if len(values) == 1:
        return values[0]
    return cq.Compound.makeCompound(values)


def extract_step_features(step_path):
    step_path = Path(step_path).resolve()
    shape = load_step_shape(step_path)
    solids = list(shape.Solids())
    shells = list(shape.Shells())
    faces = list(shape.Faces())
    edges = list(shape.Edges())
    vertices = list(shape.Vertices())
    bbox = shape.BoundingBox()
    dims = np.asarray([max(float(bbox.xlen), 0.0), max(float(bbox.ylen), 0.0), max(float(bbox.zlen), 0.0)])
    diagonal = max(float(np.linalg.norm(dims)), 1e-9)
    longest = max(float(dims.max()), 1e-9)
    volume = float(sum(max(float(solid.Volume()), 0.0) for solid in solids))
    area = float(sum(max(float(face.Area()), 0.0) for face in faces))

    surface_counts = {name: 0 for name in SURFACE_TYPES}
    for face in faces:
        surface_counts[safe_geom_type(face, SURFACE_TYPES)] += 1
    curve_counts = {name: 0 for name in CURVE_TYPES}
    for edge in edges:
        curve_counts[safe_geom_type(edge, CURVE_TYPES)] += 1

    edge_faces = {}
    face_edge_hashes = []
    for face_index, face in enumerate(faces):
        hashes = set()
        for edge in face.Edges():
            edge_hash = int(edge.hashCode())
            hashes.add(edge_hash)
            edge_faces.setdefault(edge_hash, set()).add(face_index)
        face_edge_hashes.append(hashes)
    degrees = []
    for face_index, hashes in enumerate(face_edge_hashes):
        neighbors = set()
        for edge_hash in hashes:
            neighbors.update(edge_faces.get(edge_hash, set()))
        neighbors.discard(face_index)
        degrees.append(len(neighbors))

    valid = bool(shape.isValid())
    closed = bool(solids) and all(not solid.isNull() for solid in solids)
    compactness = 0.0
    if area > 1e-12 and volume > 1e-12:
        compactness = float((36.0 * math.pi * volume * volume) / (area * area * area))

    features = {
        "topology.solid_count_log": math.log1p(len(solids)),
        "topology.shell_count_log": math.log1p(len(shells)),
        "topology.face_count_log": math.log1p(len(faces)),
        "topology.edge_count_log": math.log1p(len(edges)),
        "topology.vertex_count_log": math.log1p(len(vertices)),
        "topology.valid": 1.0 if valid else 0.0,
        "topology.closed": 1.0 if closed else 0.0,
        "bbox.x_ratio": float(dims[0] / longest),
        "bbox.y_ratio": float(dims[1] / longest),
        "bbox.z_ratio": float(dims[2] / longest),
        "bbox.xy_ratio": float(min(dims[0], dims[1]) / max(dims[0], dims[1], 1e-9)),
        "bbox.yz_ratio": float(min(dims[1], dims[2]) / max(dims[1], dims[2], 1e-9)),
        "bbox.xz_ratio": float(min(dims[0], dims[2]) / max(dims[0], dims[2], 1e-9)),
        "mass.volume_normalized": float(volume / (diagonal ** 3)),
        "mass.area_normalized": float(area / (diagonal ** 2)),
        "mass.compactness": compactness,
    }
    face_total = max(len(faces), 1)
    edge_total = max(len(edges), 1)
    for name in SURFACE_TYPES:
        features[f"surface.{name.lower()}_ratio"] = surface_counts[name] / face_total
    for name in CURVE_TYPES:
        features[f"curve.{name.lower()}_ratio"] = curve_counts[name] / edge_total
    for key, value in zip(["mean", "std", "min", "max"], normalized_stats([face.Area() for face in faces], diagonal ** 2)):
        features[f"face.area_{key}"] = value
    for key, value in zip(["mean", "std", "min", "max"], normalized_stats([edge.Length() for edge in edges], diagonal)):
        features[f"edge.length_{key}"] = value
    for key, value in zip(["mean", "std", "min", "max"], normalized_stats(degrees, 1.0)):
        features[f"adjacency.degree_{key}"] = value

    vector = [float(features[name]) for name in FEATURE_NAMES]
    return {
        "format": "ai-cad-brep-geometry-v1",
        "stepPath": str(step_path),
        "featureNames": FEATURE_NAMES,
        "vector": vector,
        "features": features,
        "facts": {
            "solidCount": len(solids), "faceCount": len(faces), "edgeCount": len(edges),
            "bboxMm": dims.round(8).tolist(), "volumeMm3": volume, "areaMm2": area,
        },
    }


def resolve_sample_step(sample, assemblies_dir):
    assembly_id = str(sample.get("assemblyId") or "").strip()
    candidates = []
    if assembly_id:
        candidates.append(Path(assemblies_dir) / assembly_id / "assembly.step")
    explicit = sample.get("stepPath") or sample.get("geometry", {}).get("stepPath")
    if explicit:
        candidates.insert(0, Path(explicit))
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def augment_dataset(dataset_path, assemblies_dir, output_path):
    records = []
    failures = []
    for line in Path(dataset_path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        sample = json.loads(line)
        step_path = resolve_sample_step(sample, assemblies_dir)
        if not step_path:
            failures.append({"id": sample.get("id"), "error": "STEP not found"})
            continue
        try:
            geometry = extract_step_features(step_path)
        except Exception as exc:
            failures.append({"id": sample.get("id"), "error": str(exc)})
            continue
        records.append({**sample, "geometry": geometry})
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")
    return {"format": "ai-cad-brep-dataset-v1", "sampleCount": len(records), "failureCount": len(failures), "failures": failures}


def main():
    parser = argparse.ArgumentParser(description="Extract normalized BREP geometry features from STEP files.")
    parser.add_argument("--step")
    parser.add_argument("--dataset")
    parser.add_argument("--assemblies", default="assemblies")
    parser.add_argument("--out")
    args = parser.parse_args()
    if args.step:
        print(json.dumps(extract_step_features(args.step), ensure_ascii=False, indent=2))
        return
    if not args.dataset or not args.out:
        raise SystemExit("use --step FILE or --dataset FILE --out FILE")
    print(json.dumps(augment_dataset(args.dataset, args.assemblies, args.out), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
