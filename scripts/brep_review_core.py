"""Unit-aware, engine-independent geometry comparisons for solid serialization."""
import math

POLICY = {"version": "unified-brep-review-v2", "linearAbsoluteMm": 1e-6,
          "linearRelative": 1e-9, "volumeAbsoluteMm3": 1e-8, "volumeRelative": 1e-7}


def compare_geometry(original, restored):
    issues, comparisons = [], []
    if not original or not restored:
        return {"valid": False, "issues": [{"code": "ROUNDTRIP_REFERENCE_MISSING", "severity": "error",
                "message": "Original and restored geometry evidence are required"}], "comparisons": []}
    for name in ("volume", "bbox", "boundsMin", "boundsMax", "center"):
        left, right = original.get(name), restored.get(name)
        expected_size = 1 if name == "volume" else 3
        left_values = [left] if name == "volume" else left
        right_values = [right] if name == "volume" else right
        if not isinstance(left_values, (list, tuple)) or not isinstance(right_values, (list, tuple)) or len(left_values) != expected_size or len(right_values) != expected_size:
            issues.append({"code": "ROUNDTRIP_EVIDENCE_INCOMPLETE", "severity": "error", "metric": name, "message": f"Missing {name} geometry evidence"})
            continue
        for index, (expected, measured) in enumerate(zip(left_values, right_values)):
            if not isinstance(expected, (int, float)) or not isinstance(measured, (int, float)) or not math.isfinite(expected) or not math.isfinite(measured):
                issues.append({"code": "ROUNDTRIP_NONFINITE", "severity": "error", "metric": name, "message": "Geometry evidence contains a non-finite value"})
                continue
            if name == "volume":
                if expected <= 0 or measured <= 0:
                    issues.append({"code": "ROUNDTRIP_INVALID_SIGNED_VOLUME", "severity": "error", "message": "Round-trip solids require positive signed volumes"})
                tolerance = POLICY["volumeAbsoluteMm3"] + POLICY["volumeRelative"] * abs(expected)
            else:
                # Relative allowance follows object size, not distance from origin.
                scale = max(original.get("bbox", [1, 1, 1]))
                tolerance = POLICY["linearAbsoluteMm"] + POLICY["linearRelative"] * scale
            error = abs(measured - expected)
            passed = error <= tolerance
            comparisons.append({"metric": name, "axis": index, "expected": expected, "measured": measured,
                                "absoluteError": error, "tolerance": tolerance, "status": "pass" if passed else "fail"})
            if not passed:
                issues.append({"code": "ROUNDTRIP_GEOMETRY_DRIFT", "severity": "error", "metric": name,
                               "axis": index, "measured": measured, "target": expected, "tolerance": tolerance,
                               "message": f"Serialized solid changed {name}; error {error} exceeds {tolerance}"})
    if any(not isinstance(item.get("solidCount"), int) or item["solidCount"] < 1 for item in (original, restored)):
        issues.append({"code": "ROUNDTRIP_SOLID_EVIDENCE_MISSING", "severity": "error", "message": "Closed solid counts are missing"})
    elif original.get("solidCount") != restored.get("solidCount"):
        issues.append({"code": "ROUNDTRIP_SOLID_COUNT_CHANGED", "severity": "error", "message": "Serialization changed the number of closed solids"})
    return {"valid": not issues, "issues": issues, "comparisons": comparisons, "policy": POLICY,
            "coverage": "volume, body count, bounds and center; not a surface Hausdorff-distance proof"}
