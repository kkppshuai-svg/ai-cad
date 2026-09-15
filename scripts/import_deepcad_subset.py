#!/usr/bin/env python3
import argparse
import io
import json
import random
import tarfile
from pathlib import Path

import cadquery as cq
import numpy as np

from extract_brep_geometry import extract_step_features


def select_split_ids(values, count, seed):
    values = list(values)
    random.Random(seed).shuffle(values)
    return values[: max(0, min(int(count), len(values)))]


def vector(stat):
    return np.asarray([float(stat.get("x", 0)), float(stat.get("y", 0)), float(stat.get("z", 0))])


def transformed_point(point, transform):
    origin = vector(transform["origin"])
    x_axis = vector(transform["x_axis"])
    y_axis = vector(transform["y_axis"])
    local = vector(point)
    result = origin + local[0] * x_axis + local[1] * y_axis
    return cq.Vector(*result)


def edge_from_curve(curve, transform):
    kind = curve["type"]
    if kind == "Line3D":
        return cq.Edge.makeLine(transformed_point(curve["start_point"], transform), transformed_point(curve["end_point"], transform))
    normal = cq.Vector(*vector(transform["z_axis"]))
    x_direction = cq.Vector(*vector(transform["x_axis"]))
    if kind == "Circle3D":
        return cq.Edge.makeCircle(abs(float(curve["radius"])), transformed_point(curve["center_point"], transform), normal)
    if kind == "Arc3D":
        start_angle = float(curve["start_angle"])
        end_angle = float(curve["end_angle"])
        mid_angle = 0.5 * (start_angle + end_angle)
        reference = vector(curve["reference_vector"])[:2]
        rotation = np.asarray([[np.cos(mid_angle), -np.sin(mid_angle)], [np.sin(mid_angle), np.cos(mid_angle)]])
        center = vector(curve["center_point"])
        mid_local = center.copy()
        mid_local[:2] += rotation @ reference * float(curve["radius"])
        return cq.Edge.makeThreePointArc(
            transformed_point(curve["start_point"], transform),
            transformed_point({"x": mid_local[0], "y": mid_local[1], "z": 0}, transform),
            transformed_point(curve["end_point"], transform),
        )
    raise ValueError(f"unsupported DeepCAD curve: {kind}")


def face_from_profile(profile, transform):
    wires = []
    for loop in profile["loops"]:
        edges = [edge_from_curve(curve, transform) for curve in loop["profile_curves"]]
        wires.append(cq.Wire.assembleEdges(edges))
    if not wires:
        raise ValueError("profile contains no loops")
    outer_index = next((i for i, loop in enumerate(profile["loops"]) if loop.get("is_outer")), 0)
    outer = wires.pop(outer_index)
    return cq.Face.makeFromWires(outer, wires)


def extruded_shape(document, entity):
    shapes = []
    for reference in entity["profiles"]:
        sketch = document["entities"][reference["sketch"]]
        profile = sketch["profiles"][reference["profile"]]
        face = face_from_profile(profile, sketch["transform"])
        normal = cq.Vector(*vector(sketch["transform"]["z_axis"]))
        one = float(entity["extent_one"]["distance"]["value"])
        shape = cq.Solid.extrudeLinear(face, normal.multiply(one))
        extent_type = entity.get("extent_type", "OneSideFeatureExtentType")
        if extent_type == "SymmetricFeatureExtentType":
            shape = shape.fuse(cq.Solid.extrudeLinear(face, normal.multiply(-one)))
        elif extent_type == "TwoSidesFeatureExtentType":
            two = float(entity["extent_two"]["distance"]["value"])
            shape = shape.fuse(cq.Solid.extrudeLinear(face, normal.multiply(-two)))
        shapes.append(shape)
    if not shapes:
        return None
    result = shapes[0]
    for shape in shapes[1:]:
        result = result.fuse(shape)
    return result


def build_shape_from_document(document):
    body = None
    for item in document["sequence"]:
        if item.get("type") != "ExtrudeFeature":
            continue
        entity = document["entities"][item["entity"]]
        new_shape = extruded_shape(document, entity)
        if new_shape is None:
            continue
        operation = entity["operation"]
        if body is None or operation in ("NewBodyFeatureOperation", "JoinFeatureOperation"):
            body = new_shape if body is None else body.fuse(new_shape)
        elif operation == "CutFeatureOperation":
            body = body.cut(new_shape)
        elif operation == "IntersectFeatureOperation":
            body = body.intersect(new_shape)
        else:
            raise ValueError(f"unsupported DeepCAD operation: {operation}")
    if body is None:
        raise ValueError("document contains no extrude operations")
    return body.clean()


def build_step_from_document(document, output_path):
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cq.exporters.export(build_shape_from_document(document), str(output_path))
    return output_path


def read_member_json(archive, member_name):
    member = archive.extractfile(member_name)
    if member is None:
        raise FileNotFoundError(member_name)
    return json.load(io.TextIOWrapper(member, encoding="utf-8"))


def import_subset(archive_path, split_path, output_dir, dataset_path, count=100, seed=42, split="train"):
    split_data = json.loads(Path(split_path).read_text(encoding="utf-8"))
    selected = select_split_ids(split_data[split], count, seed)
    output_dir = Path(output_dir)
    records, failures = [], []
    with tarfile.open(archive_path, "r:gz") as archive:
        for deepcad_id in selected:
            try:
                document = read_member_json(archive, f"cad_json/{deepcad_id}.json")
                step_path = build_step_from_document(document, output_dir / f"{deepcad_id.replace('/', '_')}.step")
                geometry = extract_step_features(step_path)
                records.append({
                    "format": "ai-cad-latent-sample-v1",
                    "id": f"deepcad-{deepcad_id.replace('/', '-')}",
                    "name": f"DeepCAD {deepcad_id}",
                    "source": {"dataset": "DeepCAD", "split": split, "deepcadId": deepcad_id},
                    "geometry": geometry,
                })
            except Exception as exc:
                failures.append({"deepcadId": deepcad_id, "error": str(exc)})
    dataset_path = Path(dataset_path)
    dataset_path.parent.mkdir(parents=True, exist_ok=True)
    dataset_path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")
    return {"selectedCount": len(selected), "sampleCount": len(records), "failureCount": len(failures), "failures": failures}


def main():
    parser = argparse.ArgumentParser(description="Import a deterministic DeepCAD subset as STEP-backed BREP training records.")
    parser.add_argument("--archive", default="pretraining-data/deepcad-archive/data/cad_json.tar.gz")
    parser.add_argument("--split-file", default="pretraining-data/deepcad-archive/data/train_val_test_split.json")
    parser.add_argument("--output-dir", default="pretraining-data/deepcad-step")
    parser.add_argument("--dataset", default="pretraining-data/deepcad_brep_samples.jsonl")
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--split", choices=["train", "validation", "test"], default="train")
    args = parser.parse_args()
    result = import_subset(args.archive, args.split_file, args.output_dir, args.dataset, args.count, args.seed, args.split)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
