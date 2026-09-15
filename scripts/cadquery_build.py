import hashlib
import json
import math
import os
import shutil
import struct
import sys
import time

import cadquery as cq
from OCP.ShapeFix import ShapeFix_Shape


FINISH_FEATURES = {"fillet", "chamfer"}
BUILDER_VERSION = "cadquery-parametric-v9"
ENABLE_FINISH_FEATURES = os.environ.get("AICAD_ENABLE_FINISH_FEATURES") == "1"
PART_COLORS = [
    (0.31, 0.60, 0.96),
    (0.32, 0.78, 0.62),
    (0.95, 0.64, 0.28),
    (0.68, 0.52, 0.92),
    (0.91, 0.42, 0.49),
    (0.38, 0.72, 0.86),
]


class FeatureBuildError(RuntimeError):
    def __init__(self, feature_id, message):
        self.feature_id = feature_id
        super().__init__("Feature {}: {}".format(feature_id, message))


def log(message):
    print(message, file=sys.stderr, flush=True)


def vector(values, default=0):
    data = list(values or [])
    data += [default, default, default]
    return [float(data[0]), float(data[1]), float(data[2])]


def safe_name(value):
    text = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in str(value))
    return text[:60] or "part"


def assembly_root_name(plan):
    part_names = {
        safe_name(part.get("id", part.get("name", "part")))
        for part in plan.get("parts", [])
    }
    base = safe_name(plan.get("name", "AI_CAD_CadQuery_Assembly"))
    if base not in part_names:
        return base
    candidate = safe_name(base + "_assembly")
    suffix = 2
    while candidate in part_names:
        candidate = safe_name("{}_assembly_{}".format(base, suffix))
        suffix += 1
    return candidate


def file_sha256(target):
    digest = hashlib.sha256()
    with open(target, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def apply_pose(workplane, pose):
    translate = vector((pose or {}).get("translate", [0, 0, 0]))
    rx, ry, rz = vector((pose or {}).get("rotate", [0, 0, 0]))
    result = workplane
    if rx:
        result = result.rotate((0, 0, 0), (1, 0, 0), rx)
    if ry:
        result = result.rotate((0, 0, 0), (0, 1, 0), ry)
    if rz:
        result = result.rotate((0, 0, 0), (0, 0, 1), rz)
    if translate != [0, 0, 0]:
        result = result.translate(tuple(translate))
    return result


def pose_location(pose):
    translate = vector((pose or {}).get("translate", [0, 0, 0]))
    rx, ry, rz = vector((pose or {}).get("rotate", [0, 0, 0]))
    return cq.Location(tuple(translate), (rx, ry, rz))


def make_primitive(spec):
    kind = spec.get("type", "box")
    center = bool(spec.get("center", True))

    if kind == "box":
        sx, sy, sz = vector(spec.get("size", [10, 10, 10]), 10)
        return cq.Workplane("XY").box(sx, sy, sz, centered=center)

    if kind == "cylinder":
        radius = float(spec.get("radius", float(spec.get("diameter", 10)) / 2))
        height = float(spec.get("height", 10))
        extrusion = height / 2 if center else height
        result = cq.Workplane("XY").circle(radius).extrude(extrusion, both=center)
        if not center:
            result = result.translate((0, 0, height / 2))
        return result

    if kind == "sphere":
        return cq.Workplane("XY").sphere(float(spec.get("radius", 5)))

    if kind == "ellipsoid":
        rx, ry, rz = vector(spec.get("radii", [5, 5, 5]), 5)
        if min(rx, ry, rz) <= 0:
            raise ValueError("ellipsoid radii must be positive")
        matrix = cq.Matrix([
            [rx, 0, 0, 0],
            [0, ry, 0, 0],
            [0, 0, rz, 0],
            [0, 0, 0, 1],
        ])
        sphere = cq.Workplane("XY").sphere(1)
        return sphere.newObject([sphere.val().transformGeometry(matrix)])

    if kind == "cone":
        r1 = float(spec.get("radius1", spec.get("bottomRadius", 8)))
        r2 = float(spec.get("radius2", spec.get("topRadius", 3)))
        height = float(spec.get("height", 10))
        result = cq.Solid.makeCone(r1, r2, height)
        if center:
            result = result.translate((0, 0, -height / 2))
        return cq.Workplane("XY").newObject([result])

    if kind == "spur_gear":
        return make_spur_gear(spec)

    raise ValueError("Unsupported primitive type: {}".format(kind))


def make_spur_gear(spec):
    module = float(spec["module"])
    teeth = int(spec["teeth"])
    width = float(spec["width"])
    bore_radius = float(spec.get("boreRadius", float(spec.get("boreDiameter", 0)) / 2))
    pitch_radius = module * teeth / 2
    root_radius = max(pitch_radius - 1.25 * module, bore_radius + module)
    outer_radius = pitch_radius + module
    overlap = max(0.5 * module, 0.01)
    root_half_width = 0.275 * math.pi * module
    tip_half_width = 0.11 * math.pi * module
    extrusion = width / 2 if bool(spec.get("center", True)) else width

    gear = cq.Workplane("XY").circle(root_radius).extrude(extrusion, both=bool(spec.get("center", True)))
    tooth_profile = [
        (root_radius - overlap, -root_half_width),
        (outer_radius, -tip_half_width),
        (outer_radius, tip_half_width),
        (root_radius - overlap, root_half_width),
    ]
    tooth = cq.Workplane("XY").polyline(tooth_profile).close().extrude(extrusion, both=bool(spec.get("center", True)))
    for index in range(teeth):
        angle = 360.0 * index / teeth
        gear = gear.union(tooth.rotate((0, 0, 0), (0, 0, 1), angle))
    if bore_radius > 0:
        bore = cq.Workplane("XY").circle(bore_radius).extrude(width, both=True)
        gear = gear.cut(bore)
    if not bool(spec.get("center", True)):
        gear = gear.translate((0, 0, width / 2))
    return gear.clean()


def cylinder_tool(feature):
    # Parametric edits target the user-facing diameter. Some legacy plans also
    # contain a derived radius; diameter must win so changing only
    # params.diameter changes the BREP instead of leaving stale geometry.
    radius = float(feature["diameter"]) / 2 if feature.get("diameter") is not None else float(feature.get("radius", 2.5))
    depth = float(feature.get("depth", 1000))
    axis = str(feature.get("axis", "z")).lower()
    center = vector(feature.get("center", [0, 0, 0]))
    tool = cq.Workplane("XY").circle(radius).extrude(depth, both=True)
    if axis == "x":
        tool = tool.rotate((0, 0, 0), (0, 1, 0), 90)
    elif axis == "y":
        tool = tool.rotate((0, 0, 0), (1, 0, 0), 90)
    return tool.translate(tuple(center))


def slot_tool(feature):
    length = float(feature.get("length", 20))
    width = float(feature.get("width", feature.get("diameter", 5)))
    depth = float(feature.get("depth", 1000))
    axis = str(feature.get("axis", "x")).lower()
    center = vector(feature.get("center", [0, 0, 0]))
    radius = width / 2
    straight = max(length - width, 0.1)

    if axis == "x":
        box = cq.Workplane("XY").box(straight, width, depth)
        c1 = cq.Workplane("XY").circle(radius).extrude(depth, both=True).translate((-length / 2 + radius, 0, 0))
        c2 = cq.Workplane("XY").circle(radius).extrude(depth, both=True).translate((length / 2 - radius, 0, 0))
    else:
        box = cq.Workplane("XY").box(width, straight, depth)
        c1 = cq.Workplane("XY").circle(radius).extrude(depth, both=True).translate((0, -length / 2 + radius, 0))
        c2 = cq.Workplane("XY").circle(radius).extrude(depth, both=True).translate((0, length / 2 - radius, 0))

    return box.union(c1).union(c2).translate(tuple(center))


def apply_features(workplane, features):
    result = workplane
    for feature in features or []:
        kind = feature.get("type")
        if kind == "hole":
            result = result.cut(cylinder_tool(feature))
        elif kind == "slot":
            result = result.cut(slot_tool(feature))
        elif kind == "cut_box":
            tool = make_primitive({
                "type": "box",
                "size": feature.get("size", [10, 10, 10]),
                "center": True,
            })
            tool = apply_pose(tool, {
                "translate": feature.get("center", [0, 0, 0]),
                "rotate": feature.get("rotate", [0, 0, 0]),
            })
            result = result.cut(tool)
        elif kind == "add":
            primitive = feature.get("primitive", {"type": "box", "size": [10, 10, 10]})
            result = result.union(apply_pose(make_primitive(primitive), primitive.get("pose", {})))
        elif kind == "fillet":
            radius = float(feature.get("radius", 1))
            try:
                result = result.edges().fillet(radius)
            except Exception:
                pass
        elif kind == "chamfer":
            distance = float(feature.get("distance", 1))
            try:
                result = result.edges().chamfer(distance)
            except Exception:
                pass
    return result


def should_skip_finish_features(features):
    if not ENABLE_FINISH_FEATURES:
        return any(feature.get("type") in FINISH_FEATURES for feature in features or [])
    features = features or []
    finish_count = sum(1 for feature in features if feature.get("type") in FINISH_FEATURES)
    boolean_count = sum(1 for feature in features if feature.get("type") in {"add", "hole", "slot", "cut_box"})
    has_slots = any(feature.get("type") == "slot" for feature in features)
    return finish_count and (finish_count >= 4 or boolean_count >= 22 or (has_slots and boolean_count >= 16))


def stable_features(part):
    features = part.get("features", [])
    if not should_skip_finish_features(features):
        return features
    part_id = part.get("id", part.get("name", "part"))
    skipped = [feature.get("type") for feature in features if feature.get("type") in FINISH_FEATURES]
    log("Skipping finish features for {} to avoid OpenCascade native crash: {}".format(part_id, skipped))
    return [feature for feature in features if feature.get("type") not in FINISH_FEATURES]


def build_part(part, trace=None):
    if "featureTree" in part:
        return build_feature_tree(part, trace=trace)
    primitives = part.get("primitives") or [part.get("primitive") or {"type": "box", "size": [10, 10, 10]}]
    result = None
    for primitive in primitives:
        item = apply_pose(make_primitive(primitive), primitive.get("pose", {}))
        result = item if result is None else result.union(item)
    return apply_features(result, stable_features(part))


def build_feature_tree(part, trace=None):
    trace = trace if trace is not None else []
    result = None
    ordered_nodes = stable_topological_nodes(part.get("featureTree", []))
    nodes = {node.get("id"): node for node in ordered_nodes}
    for node in ordered_nodes:
        feature_id = node.get("id") or "unknown-feature"
        if node.get("enabled", True) is False:
            trace.append({"featureId": feature_id, "type": node.get("type"), "status": "disabled"})
            continue
        started = time.perf_counter()
        try:
            result = evaluate_node(result, node, nodes)
            if node.get("type") != "dimension":
                validate_node_shape(feature_id, result)
            trace.append({
                "featureId": feature_id,
                "type": node.get("type"),
                "status": "passed",
                "durationMs": round((time.perf_counter() - started) * 1000, 4),
                "facts": shape_facts(result),
            })
        except FeatureBuildError as exc:
            if node.get("type") in FINISH_FEATURES:
                trace.append({
                    "featureId": feature_id,
                    "type": node.get("type"),
                    "status": "skipped",
                    "durationMs": round((time.perf_counter() - started) * 1000, 4),
                    "error": str(exc),
                    "facts": shape_facts(result),
                })
                continue
            trace.append({"featureId": feature_id, "type": node.get("type"), "status": "failed", "error": str(exc)})
            raise
        except Exception as exc:
            if node.get("type") in FINISH_FEATURES:
                trace.append({
                    "featureId": feature_id,
                    "type": node.get("type"),
                    "status": "skipped",
                    "durationMs": round((time.perf_counter() - started) * 1000, 4),
                    "error": str(exc),
                    "facts": shape_facts(result),
                })
                continue
            wrapped = FeatureBuildError(feature_id, str(exc))
            trace.append({"featureId": feature_id, "type": node.get("type"), "status": "failed", "error": str(wrapped)})
            raise wrapped from exc
    if result is None:
        raise FeatureBuildError(part.get("id", "part"), "feature tree produced no geometry")
    return result


def stable_topological_nodes(feature_tree):
    nodes = list(feature_tree or [])
    by_id = {}
    original_index = {}
    for index, node in enumerate(nodes):
        feature_id = node.get("id")
        if not feature_id:
            raise FeatureBuildError("unknown-feature", "feature tree node requires an ID")
        if feature_id in by_id:
            raise FeatureBuildError(feature_id, "duplicate feature ID")
        by_id[feature_id] = node
        original_index[feature_id] = index
    dependents = {feature_id: [] for feature_id in by_id}
    remaining = {}
    for feature_id, node in by_id.items():
        dependencies = list(dict.fromkeys(node.get("dependsOn") or []))
        missing = [dependency for dependency in dependencies if dependency not in by_id]
        if missing:
            raise FeatureBuildError(feature_id, "missing dependency {}".format(missing[0]))
        remaining[feature_id] = len(dependencies)
        for dependency in dependencies:
            dependents[dependency].append(feature_id)
    ready = sorted((feature_id for feature_id, count in remaining.items() if count == 0), key=original_index.get)
    ordered = []
    while ready:
        feature_id = ready.pop(0)
        ordered.append(by_id[feature_id])
        for dependent in sorted(dependents[feature_id], key=original_index.get):
            remaining[dependent] -= 1
            if remaining[dependent] == 0:
                ready.append(dependent)
                ready.sort(key=original_index.get)
    if len(ordered) != len(nodes):
        cyclic = next(feature_id for feature_id, count in remaining.items() if count > 0)
        raise FeatureBuildError(cyclic, "feature dependency cycle")
    return ordered


def evaluate_node(result, node, nodes):
    kind = node.get("type")
    params = node.get("params") or {}
    if kind == "dimension":
        return result
    if kind.startswith("base_"):
        primitive = {"type": kind.removeprefix("base_"), **params}
        item = apply_pose(make_primitive(primitive), params.get("pose", {}))
        return item if result is None else result.union(item)
    if result is None:
        raise ValueError("feature requires existing base geometry")
    if kind in {"linear_pattern", "circular_pattern"}:
        return apply_pattern(result, node, nodes)
    if kind in {"fillet", "chamfer"}:
        return apply_named_finish(result, node)
    tool = tool_for_node(node)
    return apply_tool_operation(result, kind, tool)


def tool_for_node(node):
    kind = node.get("type")
    params = node.get("params") or {}
    if kind == "hole":
        return cylinder_tool(params)
    if kind == "slot":
        return slot_tool(params)
    if kind == "cut_box":
        tool = make_primitive({"type": "box", "size": params.get("size", [10, 10, 10]), "center": True})
        return apply_pose(tool, {"translate": params.get("center", [0, 0, 0]), "rotate": params.get("rotate", [0, 0, 0])})
    if kind == "add_primitive":
        primitive = params.get("primitive") or {}
        return apply_pose(make_primitive(primitive), primitive.get("pose", {}))
    if kind in {"add_extrude", "cut_extrude"}:
        return extrude_tool(params)
    raise ValueError("unsupported feature-tree operation: {}".format(kind))


def apply_tool_operation(result, kind, tool):
    if kind in {"hole", "slot", "cut_box", "cut_extrude"}:
        return result.cut(tool)
    if kind in {"add_primitive", "add_extrude"}:
        return result.union(tool).clean()
    raise ValueError("unsupported tool operation: {}".format(kind))


def extrude_tool(params):
    profile = params.get("profile") or {}
    center = vector(params.get("center", [0, 0, 0]))
    depth = float(params["depth"])
    both = bool(params.get("both", True))
    workplane = cq.Workplane("XY")
    profile_type = profile.get("type")
    if profile_type == "rectangle":
        workplane = workplane.rect(float(profile["width"]), float(profile["height"]))
        tool = workplane.extrude(depth, both=both)
    elif profile_type == "rounded_rectangle":
        width = float(profile["width"])
        height = float(profile["height"])
        radius = float(profile["cornerRadius"])
        if radius <= 0 or radius * 2 >= min(width, height):
            raise ValueError("rounded_rectangle cornerRadius must be positive and less than half its width and height")
        extrusion = depth / 2 if both else depth
        tool = cq.Workplane("XY").box(width - 2 * radius, height, extrusion * 2 if both else extrusion, centered=(True, True, both))
        tool = tool.union(cq.Workplane("XY").box(width, height - 2 * radius, extrusion * 2 if both else extrusion, centered=(True, True, both)))
        for x in (-width / 2 + radius, width / 2 - radius):
            for y in (-height / 2 + radius, height / 2 - radius):
                corner = cq.Workplane("XY").circle(radius).extrude(extrusion, both=both).translate((x, y, 0))
                tool = tool.union(corner)
    elif profile_type == "circle":
        radius = float(profile.get("radius", float(profile.get("diameter", 1)) / 2))
        workplane = workplane.circle(radius)
        tool = workplane.extrude(depth, both=both)
    elif profile_type == "slot":
        width = float(profile.get("width", profile.get("diameter")))
        workplane = workplane.slot2D(float(profile["length"]), width)
        tool = workplane.extrude(depth, both=both)
    elif profile_type == "polygon":
        workplane = workplane.polyline([tuple(point) for point in profile["points"]]).close()
        tool = workplane.extrude(depth, both=both)
    else:
        raise ValueError("unsupported extrude profile: {}".format(profile_type))
    axis = str(params.get("axis", "z")).lower()
    if axis == "x":
        tool = tool.rotate((0, 0, 0), (0, 1, 0), 90)
    elif axis == "y":
        tool = tool.rotate((0, 0, 0), (1, 0, 0), 90)
    return tool.translate(tuple(center))


def apply_pattern(result, node, nodes):
    params = node.get("params") or {}
    source_id = params.get("sourceFeatureId")
    source = nodes.get(source_id)
    if not source:
        raise ValueError("pattern source feature not found: {}".format(source_id))
    source_kind = source.get("type")
    if source_kind in {"fillet", "chamfer", "linear_pattern", "circular_pattern", "dimension"} or source_kind.startswith("base_"):
        raise ValueError("unsupported pattern source type: {}".format(source_kind))
    source_tool = tool_for_node(source)
    count = int(params["count"])
    for index in range(1, count):
        if node.get("type") == "linear_pattern":
            direction = vector(params.get("direction", [1, 0, 0]))
            length = math.sqrt(sum(component * component for component in direction))
            if length <= 1e-12:
                raise ValueError("linear pattern direction must be non-zero")
            unit = [component / length for component in direction]
            distance = float(params["spacing"]) * index
            copy_tool = source_tool.translate(tuple(component * distance for component in unit))
        else:
            axis = str(params.get("axis", "z")).lower()
            axis_vector = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1)}.get(axis)
            if not axis_vector:
                raise ValueError("circular pattern axis must be x, y, or z")
            center = tuple(vector(params.get("center", [0, 0, 0])))
            axis_end = tuple(center[i] + axis_vector[i] for i in range(3))
            step = float(params["angle"]) / count
            copy_tool = source_tool.rotate(center, axis_end, step * index)
        result = apply_tool_operation(result, source_kind, copy_tool)
    return result


def apply_named_finish(result, node):
    selector = node.get("selector") or {}
    selected = select_named_edges(result, selector)
    if not selected.vals():
        raise FeatureBuildError(node.get("id"), "selector matched no edges")
    params = node.get("params") or {}
    if node.get("type") == "fillet":
        return selected.fillet(float(params["radius"]))
    return selected.chamfer(float(params["distance"]))


def select_named_edges(result, selector):
    kind = selector.get("kind")
    if kind in {"legacy_all_edges", "feature"}:
        return result.edges()
    if kind == "axis_position":
        axis = str(selector.get("axis", "")).lower()
        position = float(selector.get("position"))
        axis_selector = {"x": "|X", "y": "|Y", "z": "|Z"}.get(axis)
        if not axis_selector:
            raise ValueError("selector axis must be x, y, or z")
        return result.edges(axis_selector).filter(lambda edge: abs(getattr(edge.Center(), axis) - position) <= 1e-6)
    raise ValueError("unsupported edge selector: {}".format(kind))


def validate_node_shape(feature_id, workplane):
    if workplane is None or not workplane.vals():
        raise FeatureBuildError(feature_id, "operation produced no shape")
    shape = workplane.val()
    if not shape.isValid():
        raise FeatureBuildError(feature_id, "operation produced invalid BREP")
    solids = workplane.solids().vals()
    if not solids:
        raise FeatureBuildError(feature_id, "operation produced no solid")
    if sum(max(float(solid.Volume()), 0.0) for solid in solids) <= 1e-9:
        raise FeatureBuildError(feature_id, "operation produced non-positive volume")


def shape_facts(workplane):
    if workplane is None or not workplane.vals():
        return None
    shape = workplane.val()
    bounds = shape.BoundingBox()
    return {
        "solidCount": len(workplane.solids().vals()),
        "faceCount": len(workplane.faces().vals()),
        "edgeCount": len(workplane.edges().vals()),
        "volume": sum(float(solid.Volume()) for solid in workplane.solids().vals()),
        "bbox": [float(bounds.xlen), float(bounds.ylen), float(bounds.zlen)],
    }


def heal_workplane(workplane):
    """Run a conservative OCCT ShapeFix pass and only accept a valid result."""
    result = {
        "attempted": False,
        "status": "not_needed",
        "message": None,
    }
    if workplane is None or not workplane.vals():
        return workplane, result
    shape = workplane.val()
    try:
        if shape.isValid() and workplane.solids().vals():
            return workplane, result
    except Exception as exc:
        result["message"] = "initial BRepCheck failed: {}".format(exc)
    result["attempted"] = True
    try:
        fixer = ShapeFix_Shape(shape.wrapped)
        fixer.Perform()
        healed = cq.Shape.cast(fixer.Shape())
        healed_wp = cq.Workplane("XY").newObject([healed])
        if healed.isValid() and healed_wp.solids().vals() and sum(float(s.Volume()) for s in healed_wp.solids().vals()) > 1e-9:
            result["status"] = "applied"
            result["message"] = "OCCT ShapeFix_Shape produced a valid closed solid"
            return healed_wp, result
        result["status"] = "failed"
        result["message"] = "ShapeFix result did not pass BRepCheck/solid checks"
    except Exception as exc:
        result["status"] = "failed"
        result["message"] = str(exc)
    return workplane, result


def step_roundtrip_check(path, label):
    evidence = {"label": label, "path": path, "valid": False, "facts": None, "error": None}
    if not path or not os.path.isfile(path):
        evidence["error"] = "STEP artifact missing"
        return evidence
    try:
        imported = cq.importers.importStep(path)
        evidence["facts"] = shape_facts(imported)
        evidence["valid"] = bool(imported.vals()) and all(shape.isValid() for shape in imported.vals()) and bool(imported.solids().vals()) and float(evidence["facts"]["volume"]) > 1e-9
        if not evidence["valid"]:
            evidence["error"] = "round-tripped STEP failed BRep/solid/volume checks"
    except Exception as exc:
        evidence["error"] = str(exc)
    return evidence


def step_roundtrip_report(step_path, part_outputs):
    parts = [step_roundtrip_check(item.get("localStepPath"), str(item.get("id"))) for item in part_outputs]
    assembly = step_roundtrip_check(step_path, "assembly")
    issues = [
        {"code": "STEP_ROUNDTRIP_FAILED", "severity": "error", "partId": item["label"], "message": item["error"]}
        for item in [assembly] + parts if not item["valid"]
    ]
    return {"valid": not issues, "assembly": assembly, "parts": parts, "issues": issues}


def measurement_axis_index(axis):
    value = str(axis or "z").lower()
    if value not in {"x", "y", "z"}:
        raise ValueError("measurement axis must be x, y, or z")
    return {"x": 0, "y": 1, "z": 2}[value]


def measure_from_facts(facts, measurement):
    if not facts:
        return None
    kind = str(measurement.get("kind", "bbox")).lower()
    if kind in {"bbox", "bbox_axis", "feature_bbox"}:
        bbox = facts.get("bbox")
        if not isinstance(bbox, list) or len(bbox) < 3:
            return None
        return float(bbox[measurement_axis_index(measurement.get("axis", "z"))])
    if kind == "volume":
        return float(facts.get("volume", 0.0))
    if kind == "solid_count":
        return float(facts.get("solidCount", 0))
    if kind == "face_count":
        return float(facts.get("faceCount", 0))
    if kind == "edge_count":
        return float(facts.get("edgeCount", 0))
    raise ValueError("unsupported measurement kind: {}".format(kind))


def feature_node(part, feature_id):
    for node in (part or {}).get("featureTree") or []:
        if str(node.get("id")) == str(feature_id):
            return node
    return None


def cylinder_diameter_measurement(shape, part, measurement):
    feature = feature_node(part, measurement.get("featureId"))
    params = (feature or {}).get("params") or {}
    primitive = params.get("primitive") or params
    pose = primitive.get("pose") or params.get("pose") or {}
    center = list(pose.get("translate") or params.get("center") or [0, 0, 0])
    center += [0, 0, 0]
    axis = str(measurement.get("axis") or primitive.get("axis") or "z").lower()
    axis_index = measurement_axis_index(axis)
    target = float(measurement.get("target"))
    candidates = []
    for face in shape.Faces():
        if str(face.geomType()).upper() != "CYLINDER":
            continue
        surface = face._geomAdaptor()
        if not hasattr(surface, "Radius"):
            continue
        bounds = face.BoundingBox()
        sizes = [float(bounds.xlen), float(bounds.ylen), float(bounds.zlen)]
        if sizes[axis_index] <= 1e-6:
            continue
        face_center = face.Center()
        coordinates = [float(face_center.x), float(face_center.y), float(face_center.z)]
        perpendicular = [index for index in range(3) if index != axis_index]
        location_error = sum((coordinates[index] - center[index]) ** 2 for index in perpendicular) ** 0.5
        candidates.append((abs(float(surface.Radius()) * 2.0 - target), location_error, float(surface.Radius()) * 2.0))
    if not candidates:
        raise ValueError("cylindrical BREP face was not found")
    candidates.sort(key=lambda item: (item[0], item[1]))
    return candidates[0][2]


def keyway_geometry_measurement(shape, part, measurement):
    """Measure a rectangular keyway from its planar BREP floor face.

    The feature parameters are used only to locate the intended cut. Width,
    length and floor position are measured from the resulting BREP faces and
    vertices, so a copied target number cannot make this pass by itself.
    """
    feature = feature_node(part, measurement.get("featureId"))
    params = (feature or {}).get("params") or {}
    size = list(params.get("size") or [])
    axis = str(measurement.get("axis") or params.get("axis") or "z").lower()
    if axis not in {"x", "y", "z"}:
        raise ValueError("keyway axis must be x, y, or z")
    long_index = measurement_axis_index(axis)
    width_axis = str(measurement.get("widthAxis") or ({"x": "y", "y": "x", "z": "x"}[axis])).lower()
    depth_axis = str(measurement.get("depthAxis") or ({"x": "z", "y": "z", "z": "y"}[axis])).lower()
    width_index = measurement_axis_index(width_axis)
    depth_index = measurement_axis_index(depth_axis)
    if len({long_index, width_index, depth_index}) != 3:
        raise ValueError("keyway axes must be distinct")
    center = list(params.get("center") or measurement.get("center") or [0, 0, 0])
    center += [0, 0, 0]
    expected_width = measurement.get("expectedWidth")
    expected_length = measurement.get("expectedLength")
    if expected_width is None and len(size) >= 3:
        expected_width = size[width_index]
    if expected_length is None and len(size) >= 3:
        expected_length = size[long_index]
    tolerance = abs(float(measurement.get("tolerance", 0.1)))
    long_half = float(expected_length) / 2.0 if expected_length is not None else None
    faces = []
    for face in shape.Faces():
        if str(face.geomType()).upper() != "PLANE":
            continue
        bounds = face.BoundingBox()
        sizes = [float(bounds.xlen), float(bounds.ylen), float(bounds.zlen)]
        if sizes[depth_index] > max(tolerance, 1e-4):
            continue
        if long_half is not None:
            long_center = (float(getattr(bounds, ["xmin", "ymin", "zmin"][long_index])) + float(getattr(bounds, ["xmax", "ymax", "zmax"][long_index]))) / 2.0
            if abs(long_center - float(center[long_index])) > max(tolerance, 0.2):
                continue
            if abs(sizes[long_index] - float(expected_length)) > max(tolerance * 4.0, 0.5):
                continue
        if expected_width is not None and abs(sizes[width_index] - float(expected_width)) > max(tolerance * 4.0, 0.5):
            continue
        faces.append((face, bounds, sizes))
    if not faces:
        raise ValueError("keyway floor face was not found in BREP")
    face, floor_bounds, floor_sizes = min(faces, key=lambda item: abs(item[2][width_index] * item[2][long_index]))
    mins = [float(floor_bounds.xmin), float(floor_bounds.ymin), float(floor_bounds.zmin)]
    maxs = [float(floor_bounds.xmax), float(floor_bounds.ymax), float(floor_bounds.zmax)]
    floor = (mins[depth_index] + maxs[depth_index]) / 2.0
    long_min, long_max = mins[long_index], maxs[long_index]
    cylinder_candidates = []
    for surrounding_face in shape.Faces():
        if str(surrounding_face.geomType()).upper() != "CYLINDER":
            continue
        surface = surrounding_face._geomAdaptor()
        if not hasattr(surface, "Radius"):
            continue
        surrounding_bounds = surrounding_face.BoundingBox()
        surrounding_sizes = [float(surrounding_bounds.xlen), float(surrounding_bounds.ylen), float(surrounding_bounds.zlen)]
        if surrounding_sizes[long_index] <= 1e-6:
            continue
        face_min = [float(surrounding_bounds.xmin), float(surrounding_bounds.ymin), float(surrounding_bounds.zmin)][long_index]
        face_max = [float(surrounding_bounds.xmax), float(surrounding_bounds.ymax), float(surrounding_bounds.zmax)][long_index]
        if face_max < long_min - tolerance or face_min > long_max + tolerance:
            continue
        position = surface.Position().Location()
        axis_center = [float(position.X()), float(position.Y()), float(position.Z())]
        if any(abs(axis_center[index] - float(center[index])) > max(tolerance, 0.2) for index in range(3) if index not in {long_index, depth_index}):
            continue
        cylinder_candidates.append((float(surface.Radius()), axis_center[depth_index]))
    if cylinder_candidates:
        radius, axis_origin = max(cylinder_candidates, key=lambda item: item[0])
        side = 1.0 if floor >= axis_origin else -1.0
        outer = axis_origin + side * radius
    else:
        side = 1.0 if floor >= float(center[depth_index]) else -1.0
        vertex_values = []
        for vertex in shape.Vertices():
            point = vertex.Center()
            coordinates = [float(point.x), float(point.y), float(point.z)]
            if coordinates[long_index] < long_min - tolerance or coordinates[long_index] > long_max + tolerance:
                continue
            vertex_values.append(coordinates[depth_index])
        if not vertex_values:
            raise ValueError("keyway surrounding BREP boundary was not found")
        outer = max(vertex_values) if side > 0 else min(vertex_values)
    return {
        "width": float(floor_sizes[width_index]),
        "depth": abs(float(outer) - floor),
        "length": float(floor_sizes[long_index]),
        "floorCoordinate": floor,
        "outerCoordinate": float(outer),
        "floorFace": bounding_box_report(floor_bounds),
    }


def inferred_measurement_specs(part):
    """Convert legacy dimension nodes into safe BREP measurements.

    Only dimensions with a stable geometric interpretation are inferred. The
    remaining dimensions stay explicitly unverified instead of being treated
    as proof just because the same value exists in the plan.
    """
    inferred = []
    unverified = []
    supported = {
        "overallLength": ("bbox", None),
        "inputDiameter": ("cylinder_diameter", "x"),
        "bearingSeatDiameter": ("cylinder_diameter", "x"),
        "outputDiameter": ("cylinder_diameter", "x"),
        "gearWidth": ("feature_bbox", "z"),
    }
    keyway_properties = {
        "keywayWidth": "width",
        "keywayDepth": "depth",
        "keywayLength": "length",
    }
    for node in (part or {}).get("featureTree") or []:
        if node.get("type") != "dimension" or node.get("enabled", True) is False:
            continue
        params = node.get("params") or {}
        name = str(params.get("name") or "")
        if name in keyway_properties:
            inferred.append({
                "id": node.get("id") or name,
                "label": node.get("name") or name,
                "name": name,
                "kind": "keyway",
                "property": keyway_properties[name],
                "featureId": (node.get("dependsOn") or [None])[0],
                "target": params.get("value"),
                "tolerance": params.get("tolerance", 0.1),
                "unit": "mm",
                "inferred": True,
            })
            continue
        if name not in supported:
            if name and params.get("value") is not None:
                unverified.append({
                    "id": node.get("id"),
                    "label": node.get("name") or name,
                    "name": name,
                    "target": params.get("value"),
                    "category": "engineering" if any(token in name.lower() for token in ("load", "capacity", "force", "torque", "承重", "载荷", "强度")) else "dimension",
                    "reason": "当前通用 BREP 测量器尚未支持该尺寸语义",
                })
            continue
        depends_on = list(node.get("dependsOn") or [])
        inferred.append({
            "id": node.get("id") or name,
            "label": node.get("name") or name,
            "name": name,
            "kind": supported[name][0],
            "axis": supported[name][1],
            "featureId": depends_on[0] if supported[name][0] == "feature_bbox" and depends_on else None,
            "target": params.get("value"),
            "tolerance": params.get("tolerance", 0.1),
            "unit": "mm",
            "inferred": True,
        })
    return inferred, unverified


def choose_bbox_axis(facts, target, preferred=None):
    if preferred:
        return preferred
    bbox = (facts or {}).get("bbox") or []
    if len(bbox) < 3:
        return "z"
    matches = [index for index, value in enumerate(bbox) if abs(float(value) - float(target)) <= 1e-5]
    index = matches[0] if matches else max(range(3), key=lambda item: float(bbox[item]))
    return ["x", "y", "z"][index]


def dimension_measurements(part, shape, trace=None, tolerance=1e-7):
    """Measure explicit acceptance dimensions from the built BREP.

    A measurement can target the final part (`kind: bbox`) or the BREP state
    captured after a feature (`kind: feature_bbox`). The latter is useful for
    semantic dimensions such as a shaft diameter or gear width without using
    screenshots or trusting the planner's original numbers alone.
    """
    explicit_specs = list((part or {}).get("measurements") or [])
    inferred_specs, unverified = inferred_measurement_specs(part)
    explicit_ids = {str(item.get("id")) for item in explicit_specs if item.get("id")}
    def semantic_tokens(value):
        import re
        text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(value or ""))
        return {token for token in re.split(r"[^a-zA-Z0-9一二三四五六七八九十]+", text.lower()) if token}
    explicit_semantics = [semantic_tokens(" ".join(str(item.get(key) or "") for key in ("id", "name", "label"))) for item in explicit_specs]
    unverified = [item for item in unverified if not any(semantic_tokens(item.get("name") or item.get("label")) & tokens for tokens in explicit_semantics)]
    specs = explicit_specs + [item for item in inferred_specs if str(item.get("id")) not in explicit_ids]
    if not specs:
        return [], unverified
    final_facts = shape_facts(cq.Workplane("XY").newObject([shape]))
    trace_by_feature = {
        str(item.get("featureId")): item
        for item in (trace or [])
        if item.get("featureId") and item.get("facts")
    }
    results = []
    for index, spec in enumerate(specs):
        item = dict(spec or {})
        measurement_id = str(item.get("id") or "measurement-{}".format(index + 1))
        label = str(item.get("label") or measurement_id)
        kind = str(item.get("kind", "bbox")).lower()
        source = "brep"
        facts = final_facts
        feature_id = item.get("featureId")
        if kind == "feature_bbox":
            source = "feature-brep"
            trace_item = trace_by_feature.get(str(feature_id))
            facts = trace_item.get("facts") if trace_item else None
            feature = feature_node(part, feature_id)
            if feature and feature.get("type") == "hole" and item.get("property") in {None, "diameter"}:
                kind = "cylinder_diameter"
                item["kind"] = kind
        result = {
            "id": measurement_id,
            "label": label,
            "name": item.get("name"),
            "kind": kind,
            "property": item.get("property"),
            "source": source,
            "featureId": feature_id,
            "axis": item.get("axis"),
            "target": item.get("target", item.get("value")),
            "tolerance": item.get("tolerance", 0.01),
            "unit": item.get("unit", "mm"),
        }
        try:
            target = float(item.get("effectiveTarget", result["target"]))
            allowed = abs(float(result["tolerance"]))
            if kind == "keyway":
                geometry = keyway_geometry_measurement(shape, part, item)
                result["evidence"] = geometry
                measured = geometry.get(str(item.get("property") or "width"))
                result["source"] = "keyway-brep"
            elif kind == "cylinder_diameter":
                measured = cylinder_diameter_measurement(shape, part, item)
                result["source"] = "cylinder-brep"
            else:
                if not item.get("axis") and kind in {"bbox", "bbox_axis", "feature_bbox"}:
                    result["axis"] = choose_bbox_axis(facts, target)
                measured = measure_from_facts(facts, item)
            result["measured"] = measured
            if item.get("effectiveTarget") is not None:
                result["targetOriginal"] = result["target"]
                result["target"] = target
                result["targetSource"] = item.get("targetSource", "inferred")
            result["delta"] = None if measured is None else measured - target
            result["passed"] = measured is not None and abs(result["delta"]) <= allowed
            result["status"] = "pass" if result["passed"] else "fail"
        except (TypeError, ValueError, KeyError) as exc:
            result["measured"] = None
            result["delta"] = None
            result["passed"] = False
            result["status"] = "unmeasurable"
            result["error"] = str(exc)
        results.append(result)
    return results, unverified


def write_feature_trace(path, parts):
    payload = {"format": "ai-cad-feature-trace-v1", "parts": parts}
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return str(path)


def has_patterned_gear_teeth(part):
    features = (part or {}).get("featureTree") or []
    tooth_sources = {
        feature.get("id")
        for feature in features
        if "gear_tooth" in ((feature.get("selector") or {}).get("tags") or [])
        and feature.get("type") in {"add_primitive", "add_extrude"}
    }
    return any(
        feature.get("type") == "circular_pattern"
        and (feature.get("params") or {}).get("sourceFeatureId") in tooth_sources
        for feature in features
    )


def geometry_validation(part_id, workplane, tolerance=1e-7, trace=None, part=None):
    issues = []
    workplane, healing = heal_workplane(workplane)
    values = workplane.vals() if workplane is not None else []
    if not values:
        issues.append({"code": "NO_SHAPE", "severity": "error", "message": "No BREP shape was produced"})
        return {"partId": part_id, "valid": False, "blockingErrorCount": 1, "issues": issues, "facts": {}, "shapeHealing": healing, "reviewStages": [{"stage": "brepcheck", "status": "fail"}, {"stage": "shape_healing", "status": healing["status"]}]}
    shape = workplane.val()
    try:
        shape_valid = bool(shape.isValid())
    except Exception:
        shape_valid = False
    if not shape_valid:
        issues.append({"code": "INVALID_BREP", "severity": "error", "message": "OpenCascade reports an invalid BREP"})
    solids = workplane.solids().vals()
    if not solids:
        issues.append({"code": "NO_SOLID", "severity": "error", "message": "BREP contains no closed solid"})
        issues.append({"code": "OPEN_SHELL", "severity": "error", "message": "Geometry is an open shell or surface"})
    volume = sum(max(float(solid.Volume()), 0.0) for solid in solids)
    if solids and volume <= tolerance:
        issues.append({"code": "NON_POSITIVE_VOLUME", "severity": "error", "message": "Solid volume is not positive"})
    bbox = shape.BoundingBox()
    dimensions = [float(bbox.xlen), float(bbox.ylen), float(bbox.zlen)]
    if solids and min(dimensions) <= tolerance:
        issues.append({"code": "ZERO_THICKNESS_SUSPECT", "severity": "error", "message": "A bounding-box dimension is at or below the zero-thickness tolerance"})
    if len(solids) > 1 and has_patterned_gear_teeth(part):
        issues.append({
            "code": "DISCONNECTED_GEAR_TEETH",
            "severity": "error",
            "message": "Patterned gear teeth are disconnected solids; move the source tooth inward so it overlaps the gear root body and fuses into one solid",
        })
    if len(solids) > 1 and bool((part or {}).get("requireSingleSolid")):
        issues.append({
            "code": "MULTIPLE_SOLIDS",
            "severity": "error",
            "measured": len(solids),
            "target": 1,
            "message": "Part is required to remain one connected solid",
        })
    for item in trace or []:
        if item.get("status") == "skipped" and item.get("type") in FINISH_FEATURES:
            issues.append({
                "code": "FINISH_FEATURE_SKIPPED",
                "severity": "warning",
                "featureId": item.get("featureId"),
                "message": item.get("error") or "Decorative finish could not be applied",
            })
    measurements, unverified_dimensions = dimension_measurements(part, shape, trace=trace, tolerance=tolerance)
    unverified_conditions = [item for item in unverified_dimensions if item.get("category") == "engineering"]
    unverified_dimensions = [item for item in unverified_dimensions if item.get("category") != "engineering"]
    for measurement in measurements:
        if measurement.get("status") == "fail":
            target = measurement.get("target")
            measured = measurement.get("measured")
            tolerance_value = measurement.get("tolerance")
            issues.append({
                "code": "DIMENSION_MISMATCH",
                "severity": "error",
                "measurementId": measurement.get("id"),
                "featureId": measurement.get("featureId"),
                "measured": measured,
                "target": target,
                "tolerance": tolerance_value,
                "message": "尺寸{}实测 {}，目标 {} ± {}，未通过 BREP 几何验证".format(
                    measurement.get("label"), measured, target, tolerance_value
                ),
            })
        elif measurement.get("status") == "unmeasurable":
            issues.append({
                "code": "DIMENSION_UNMEASURABLE",
                "severity": "error",
                "measurementId": measurement.get("id"),
                "featureId": measurement.get("featureId"),
                "message": "尺寸{}无法从当前 BREP 几何测量确认".format(measurement.get("label")),
            })
    blocking = sum(1 for issue in issues if issue["severity"] == "error")
    return {
        "partId": part_id,
        "valid": blocking == 0,
        "blockingErrorCount": blocking,
        "issues": issues,
        "measurements": measurements,
        "unverifiedDimensions": unverified_dimensions,
        "unverifiedConditions": unverified_conditions,
        "shapeHealing": healing,
        "brepCheck": {"analyzer": "BRepCheck_Analyzer", "valid": shape_valid},
        "reviewStages": [
            {"stage": "brepcheck", "status": "pass" if shape_valid else "fail"},
            {"stage": "shape_healing", "status": healing["status"]},
            {"stage": "topology_facts", "status": "pass" if solids and volume > tolerance else "fail"},
            {"stage": "fbs_acceptance", "status": "pass" if not any(item.get("status") != "pass" for item in measurements) else "fail"},
        ],
        "facts": {
            "solidCount": len(solids),
            "shellCount": len(workplane.shells().vals()),
            "faceCount": len(workplane.faces().vals()),
            "edgeCount": len(workplane.edges().vals()),
            "volume": volume,
            "bbox": dimensions,
        },
    }


def compute_interferences(parts, tolerance=1e-7, intended_contacts=None):
    intended = {tuple(sorted(pair)) for pair in (intended_contacts or [])}
    reports = []
    for left_index in range(len(parts)):
        for right_index in range(left_index + 1, len(parts)):
            left = parts[left_index]
            right = parts[right_index]
            pair = tuple(sorted((str(left["id"]), str(right["id"]))))
            left_shape = left["shape"]
            right_shape = right["shape"]
            if not bounding_boxes_overlap(left_shape.val().BoundingBox(), right_shape.val().BoundingBox(), tolerance):
                continue
            intersection = left_shape.intersect(right_shape)
            volume = sum(max(float(solid.Volume()), 0.0) for solid in intersection.solids().vals())
            if volume > tolerance:
                left_bounds = bounding_box_report(left_shape.val().BoundingBox())
                right_bounds = bounding_box_report(right_shape.val().BoundingBox())
                reports.append({
                    "parts": list(pair),
                    "volume": volume,
                    "severity": "error",
                    "code": "PART_INTERFERENCE",
                    "intendedContact": pair in intended,
                    "partBounds": {
                        str(left["id"]): left_bounds,
                        str(right["id"]): right_bounds,
                    },
                    "overlapBounds": overlap_bounds(left_bounds, right_bounds),
                })
    return reports


def bounding_box_report(bounds):
    minimum = [float(bounds.xmin), float(bounds.ymin), float(bounds.zmin)]
    maximum = [float(bounds.xmax), float(bounds.ymax), float(bounds.zmax)]
    return {
        "min": minimum,
        "max": maximum,
        "size": [maximum[index] - minimum[index] for index in range(3)],
        "center": [(maximum[index] + minimum[index]) / 2.0 for index in range(3)],
    }


def overlap_bounds(left, right):
    minimum = [max(left["min"][index], right["min"][index]) for index in range(3)]
    maximum = [min(left["max"][index], right["max"][index]) for index in range(3)]
    return {
        "min": minimum,
        "max": maximum,
        "size": [max(0.0, maximum[index] - minimum[index]) for index in range(3)],
        "center": [(maximum[index] + minimum[index]) / 2.0 for index in range(3)],
    }


def bounding_boxes_overlap(left, right, tolerance):
    return all([
        min(left.xmax, right.xmax) - max(left.xmin, right.xmin) > tolerance,
        min(left.ymax, right.ymax) - max(left.ymin, right.ymin) > tolerance,
        min(left.zmax, right.zmax) - max(left.zmin, right.zmin) > tolerance,
    ])


def import_step_part(part):
    source = part.get("sourceStepPath")
    if not source or not os.path.exists(source):
        raise ValueError("Standard part {} is missing sourceStepPath".format(part.get("id", part.get("name", "part"))))
    imported = cq.importers.importStep(source)
    if hasattr(imported, "val"):
        return imported
    return cq.Workplane("XY").newObject(imported.vals())


def build_manifest_part(part, trace=None):
    trace = trace if trace is not None else []
    reuse_path = part.get("reuseStepPath")
    if reuse_path:
        if not os.path.exists(reuse_path):
            raise ValueError("Reusable STEP does not exist: {}".format(reuse_path))
        built = cq.importers.importStep(reuse_path)
        trace.append({"featureId": part.get("id", "part"), "type": "cached_step", "status": "reused", "sourceStepPath": reuse_path, "facts": shape_facts(built)})
        return built
    if part.get("mode") == "standard_part":
        built = import_step_part(part)
        trace.append({"featureId": part.get("id", "part"), "type": "standard_part", "status": "imported", "facts": shape_facts(built)})
        return built
    return build_part(part, trace=trace)


def apply_repair_actions(workplane, part_id, actions, trace=None):
    trace = trace if trace is not None else []
    result = workplane
    for action in actions or []:
        if action.get("type") != "clean_and_retry" or action.get("partId") not in (None, part_id):
            continue
        result = result.clean()
        trace.append({"featureId": action.get("featureId") or part_id, "type": "clean_and_retry", "status": "repaired", "facts": shape_facts(result)})
    return result


def export_part(workplane, step_path, stl_path, reuse_step_path=None):
    if reuse_step_path:
        shutil.copy2(reuse_step_path, step_path)
    else:
        cq.exporters.export(workplane, step_path)
    cq.exporters.export(workplane, stl_path)


def export_located_part(workplane, location, stl_path):
    solids = [shape.located(location) for shape in workplane.vals()]
    compound = cq.Compound.makeCompound(solids)
    cq.exporters.export(compound, stl_path)


def read_stl_triangles(stl_path):
    with open(stl_path, "rb") as handle:
        data = handle.read()
    if len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        expected = 84 + count * 50
        if expected == len(data):
            triangles = []
            offset = 84
            for _ in range(count):
                offset += 12
                tri = []
                for _ in range(3):
                    tri.append(struct.unpack_from("<fff", data, offset))
                    offset += 12
                offset += 2
                triangles.append(tri)
            return triangles

    text = data.decode("utf-8", "ignore")
    vertices = []
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) == 4 and parts[0].lower() == "vertex":
            vertices.append(tuple(float(value) for value in parts[1:4]))
    return [vertices[index:index + 3] for index in range(0, len(vertices), 3) if len(vertices[index:index + 3]) == 3]


def render_png(stl_path, png_path):
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    except Exception:
        return None

    triangles = read_stl_triangles(stl_path)
    if not triangles:
        return None

    xs = [vertex[0] for tri in triangles for vertex in tri]
    ys = [vertex[1] for tri in triangles for vertex in tri]
    zs = [vertex[2] for tri in triangles for vertex in tri]
    cx = (min(xs) + max(xs)) / 2
    cy = (min(ys) + max(ys)) / 2
    cz = (min(zs) + max(zs)) / 2
    radius = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs), 1) / 2

    fig = plt.figure(figsize=(7.5, 5.6), dpi=150)
    fig.patch.set_alpha(0)
    ax = fig.add_subplot(111, projection="3d")
    ax.set_facecolor((0.04, 0.05, 0.04, 1))
    mesh = Poly3DCollection(triangles, linewidths=0.12, edgecolors=(0.95, 0.78, 0.42, 0.28))
    mesh.set_facecolor((0.95, 0.58, 0.16, 0.92))
    ax.add_collection3d(mesh)
    ax.set_xlim(cx - radius, cx + radius)
    ax.set_ylim(cy - radius, cy + radius)
    ax.set_zlim(cz - radius, cz + radius)
    ax.view_init(elev=24, azim=-48)
    ax.set_axis_off()
    try:
        ax.set_box_aspect((1, 1, 1))
    except Exception:
        pass
    plt.tight_layout(pad=0)
    fig.savefig(png_path, transparent=False, facecolor=ax.get_facecolor())
    plt.close(fig)
    return png_path


def main():
    manifest_path = os.environ.get("AI_CAD_CADQUERY_MANIFEST")
    if not manifest_path and len(sys.argv) >= 2:
        manifest_path = sys.argv[-1]
    if not manifest_path:
        raise SystemExit("usage: AI_CAD_CADQUERY_MANIFEST=manifest.json python cadquery_build.py")

    with open(manifest_path, "r", encoding="utf-8") as handle:
        plan = json.load(handle)

    out_dir = plan["outputDir"]
    os.makedirs(out_dir, exist_ok=True)

    assembly = cq.Assembly(name=assembly_root_name(plan))
    located_parts = []
    located_entries = []
    part_outputs = []
    feature_traces = {}
    geometry_reports = []

    for part_index, part in enumerate(plan.get("parts", [])):
        part_id = safe_name(part.get("id", part.get("name", "part")))
        log("Building part {}".format(part_id))
        part_trace = []
        built = build_manifest_part(part, trace=part_trace)
        built = apply_repair_actions(built, part.get("id") or part_id, plan.get("repairActions", []), part_trace)
        built, healing = heal_workplane(built)
        feature_traces[part.get("id") or part_id] = part_trace
        geometry_report = geometry_validation(part.get("id") or part_id, built, trace=part_trace, part=part)
        geometry_report["shapeHealing"] = healing
        for stage in geometry_report.get("reviewStages", []):
            if stage.get("stage") == "shape_healing":
                stage["status"] = healing.get("status")
        geometry_reports.append(geometry_report)
        location = pose_location(part.get("pose", {}))
        located = apply_pose(built, part.get("pose", {}))
        part_step = os.path.join(out_dir, part_id + ".step")
        part_local_step = os.path.join(out_dir, part_id + ".local.step")
        part_stl = os.path.join(out_dir, part_id + ".stl")
        part_local_stl = os.path.join(out_dir, part_id + ".local.stl")
        part_png = os.path.join(out_dir, part_id + ".png")
        log("Exporting part {}".format(part_id))
        export_part(built, part_local_step, part_local_stl, reuse_step_path=part.get("reuseStepPath"))
        cq.exporters.export(located, part_step)
        export_located_part(built, location, part_stl)
        render_png(part_stl, part_png)
        color = PART_COLORS[part_index % len(PART_COLORS)]
        assembly.add(built, name=part_id, loc=location, color=cq.Color(*color))
        located_parts.append(located)
        located_entries.append({"id": part.get("id") or part_id, "shape": located})
        part_outputs.append({
            "id": part.get("id"),
            "name": part.get("name"),
            "mode": part.get("mode", "generated"),
            "standardPart": part.get("standardPart"),
            "sourceStepPath": part.get("sourceStepPath"),
            "stepPath": part_step,
            "localStepPath": part_local_step,
            "localStepChecksum": file_sha256(part_local_step),
            "sourceStepChecksum": file_sha256(part.get("sourceStepPath")) if part.get("sourceStepPath") and os.path.isfile(part.get("sourceStepPath")) else None,
            "builderVersion": BUILDER_VERSION,
            "stlPath": part_stl,
            "localStlPath": part_local_stl,
            "pngPath": part_png if os.path.exists(part_png) else None,
            "featureTrace": part_trace,
            "geometryValidation": geometry_report,
        })

    feature_trace_path = os.path.join(out_dir, "feature-trace.json")
    write_feature_trace(feature_trace_path, feature_traces)
    interferences = compute_interferences(located_entries, intended_contacts=plan.get("intendedContacts", []))
    geometry_validation_path = os.path.join(out_dir, "geometry-validation.json")
    validation_payload = {
        "format": "ai-cad-geometry-validation-v1",
        "parts": geometry_reports,
        "interferences": interferences,
        "blockingErrorCount": sum(report["blockingErrorCount"] for report in geometry_reports) + sum(
            1 for report in interferences if not report.get("intendedContact")
        ),
    }
    step_path = os.path.join(out_dir, "assembly.step")
    stl_path = os.path.join(out_dir, "assembly.stl")
    glb_path = os.path.join(out_dir, "assembly.glb")
    glb_warning = None
    if located_parts:
        assembly.save(step_path)
        try:
            assembly.save(glb_path, exportType="GLTF")
        except Exception as exc:
            glb_warning = "GLB export failed: {}".format(exc)
            log(glb_warning)
            glb_path = None
        compound = cq.Compound.makeCompound([part.val() for part in located_parts])
        cq.exporters.export(compound, stl_path)
        png_path = os.path.join(out_dir, "assembly.png")
        render_png(stl_path, png_path)
    else:
        step_path = None
        stl_path = None
        glb_path = None
        png_path = None

    step_roundtrip = step_roundtrip_report(step_path, part_outputs)
    validation_payload["stepRoundTrip"] = step_roundtrip
    validation_payload["reviewStages"] = [
        {"stage": "brepcheck", "status": "pass" if all(item.get("valid") for item in geometry_reports) else "fail"},
        {"stage": "shape_healing", "status": "applied" if any(item.get("shapeHealing", {}).get("status") == "applied" for item in geometry_reports) else "not_needed"},
        {"stage": "topology_facts", "status": "pass" if all(item.get("facts", {}).get("solidCount", 0) >= 1 for item in geometry_reports) else "fail"},
        {"stage": "fbs_acceptance", "status": "pending"},
        {"stage": "local_repair", "status": "delegated_to_validation_loop"},
        {"stage": "step_roundtrip", "status": "pass" if step_roundtrip["valid"] else "fail"},
    ]
    validation_payload["blockingErrorCount"] += len(step_roundtrip["issues"])
    with open(geometry_validation_path, "w", encoding="utf-8") as handle:
        json.dump(validation_payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    print(json.dumps({
        "engine": "cadquery",
        "builderVersion": BUILDER_VERSION,
        "fcstdPath": None,
        "stepPath": step_path,
        "stlPath": stl_path,
        "glbPath": glb_path if glb_path and os.path.exists(glb_path) else None,
        "glbWarning": glb_warning,
        "pngPath": png_path if png_path and os.path.exists(png_path) else None,
        "featureTracePath": feature_trace_path,
        "geometryValidationPath": geometry_validation_path,
        "geometryValidation": validation_payload,
        "parts": part_outputs,
        "relations": plan.get("relations", []),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
