"""Decide whether available CAD, calculation, and trial evidence supports a design."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys


METHODS = {
    "envelope": ("verification", "cad_brep_bounds"),
    "outside_width": ("verification", "cad_brep_y_span"),
    "mount_fixture": ("verification", "pin_sweep_and_washer_seat"),
    "deflection": ("verification", "cantilever_analysis"),
    "stress": ("verification", "cantilever_analysis"),
    "use_trial": ("validation", "physical_trial"),
}
MISSING_INPUTS = {
    "maxMm": "允许的尺寸或挠度上限（mm）",
    "minMm": "工程要求给出的下限（mm）",
    "targetMm": "所声明的优选工作挠度（mm）",
    "maxMPa": "允许应力上限（MPa）",
    "loadCase.support": "装夹方式（例如一端理想固支）",
    "loadCase.kind": "载荷位置、方向与类型（例如自由端沿 Z 方向的静载）",
    "loadCase.forceN": "力的大小（N）",
    "material.youngMPa": "材料弹性模量（MPa 或 GPa）",
}
MODES = ("baseline", "fixed_gate", "agent")
FORMAT = "ai-cad-engineering-verification-v1"


def design_digest(plan):
    canonical = json.dumps(plan, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def finite_number(value, *, zero=False):
    return (type(value) in (int, float) and math.isfinite(value)
            and (value >= 0 if zero else value > 0))


def bounds(value):
    values = value if isinstance(value, list) else [value, value]
    if len(values) != 2 or not all(finite_number(v) for v in values) or values[0] > values[1]:
        return None
    return values


def upper_limit(interval, limit):
    if interval[1] <= limit:
        return "pass"
    if interval[0] > limit:
        return "fail"
    return "hold"


def within_band(interval, minimum, maximum):
    if interval[0] >= minimum and interval[1] <= maximum:
        return "pass"
    if interval[1] < minimum or interval[0] > maximum:
        return "fail"
    return "hold"


def claim(decision, reason, evidence=None, action=None):
    return {"decision": decision, "reason": reason, "evidence": evidence, "nextAction": action}


def uses_external_geometry(part):
    return (part.get("reuseStepPath") or part.get("sourceStepPath")
            or part.get("mode") == "standard_part")


def dimension_scope(plan):
    parts = plan.get("parts", [])
    if len(parts) != 1:
        return "single_part_required"
    part = parts[0]
    if uses_external_geometry(part):
        return "inline_geometry_required"
    if not (part.get("primitives") or part.get("primitive") or part.get("featureTree")):
        return "explicit_geometry_required"
    if (part.get("pose") or {}).get("rotate") not in (None, [0, 0, 0]):
        return "world_aligned_part_required"
    return None


def cad_dimensions(plan, build_part):
    error = dimension_scope(plan)
    if error:
        return None, error
    part = plan["parts"][0]
    if build_part is None:
        from cadquery_build import build_part
    try:
        shape = build_part(part).val()
        if len(shape.Solids()) != 1 or not shape.isValid() or shape.Volume() <= 0:
            return None, "invalid_brep"
        box = shape.BoundingBox()
        dimensions = [box.xlen, box.ylen, box.zlen]
        volume = shape.Volume()
        if not all(finite_number(v) for v in [*dimensions, volume]):
            return None, "invalid_brep"
        return {"dimensionsMm": dimensions, "volumeMm3": volume, "solidCount": 1}, None
    except (RuntimeError, ValueError, TypeError, KeyError) as exc:
        return {"buildError": str(exc)}, "cad_build_error"


def built_dimensions(plan, reports):
    error = dimension_scope(plan)
    if error:
        return None, error
    part = plan["parts"][0]
    part_id = part.get("id") or part.get("name") or "part"
    if len(reports) != 1 or reports[0].get("partId") != part_id:
        return None, "missing_brep_evidence"
    report = reports[0]
    facts = report.get("facts", {})
    brep_valid = report.get("brepCheck", {}).get("valid")
    if brep_valid is False or facts.get("solidCount") == 0:
        return None, "invalid_brep"
    if brep_valid is not True:
        return None, "missing_brep_evidence"
    if facts.get("solidCount") != 1:
        return None, "single_solid_required"
    dimensions, volume = facts.get("bbox"), facts.get("volume")
    if (not isinstance(dimensions, list) or len(dimensions) != 3
            or not all(finite_number(value) for value in [*dimensions, volume])):
        return None, "missing_brep_evidence"
    return {"partId": part_id, "dimensionsMm": dimensions, "volumeMm3": volume, "solidCount": 1}, None


def is_rectangular_beam(plan, geometry):
    part = plan["parts"][0]
    tree = part.get("featureTree")
    if tree is not None:
        nodes = [node for node in tree if node.get("enabled", True) and node["type"] != "dimension"]
        box_only = len(nodes) == 1 and nodes[0]["type"] == "base_box"
    else:
        primitives = part.get("primitives") or [part.get("primitive", {})]
        box_only = len(primitives) == 1 and primitives[0].get("type") == "box" and not part.get("features")
    length, width, height = geometry["dimensionsMm"]
    return (box_only and length / height >= 10
            and math.isclose(geometry["volumeMm3"], length * width * height, rel_tol=1e-7))


def cantilever_response(dimensions, force, young):
    length, width, height = dimensions
    inertia = width * height ** 3 / 12
    return {
        "stress": force * length * height / (2 * inertia),
        "deflection": force * length ** 3 / (3 * young * inertia),
    }


def calculation(case, geometry, mode):
    load = case.get("loadCase", {})
    force = bounds(load.get("forceN"))
    young = bounds(case.get("material", {}).get("youngMPa"))
    if force is None or young is None:
        return None, "missing_force_or_modulus", "提供正值的载荷与弹性模量范围。"
    if mode == "agent":
        if load.get("direction", "Z") not in ("Z", "+Z", "-Z"):
            return None, "load_direction_out_of_scope", "此方法计算沿 Z 的挠度幅值。请提供适用于所声明方向的计算或试验证据。"
        if (load.get("support"), load.get("kind")) != ("ideal_clamp", "static_tip_force"):
            return None, "load_model_mismatch", "提供固支端静载模型，或选择适合该工况的计算方法。"
        if not is_rectangular_beam(case["design"], geometry):
            return None, "beam_model_out_of_scope", "提供适用于该几何和截面的分析或试验证据。"
        low = cantilever_response(geometry["dimensionsMm"], force[0], young[1])
        high = cantilever_response(geometry["dimensionsMm"], force[1], young[0])
        if high["deflection"] > 0.05 * geometry["dimensionsMm"][0]:
            return None, "small_deflection_scope_exceeded", "补做适用于大变形的分析。"
    else:
        low = high = cantilever_response(geometry["dimensionsMm"], sum(force) / 2, sum(young) / 2)
    return {
        "stress": [low["stress"], high["stress"]],
        "deflection": [low["deflection"], high["deflection"]],
        "forceN": force, "youngMPa": young,
    }, None, None


def trial_claim(case, limit, digest, mode):
    readings = case.get("trialEvidence", [])
    context = case.get("useContext", {})
    if mode != "agent":
        nominal = [item["measuredMm"] for item in readings if finite_number(item.get("measuredMm"), zero=True)]
        if not nominal:
            return claim("hold", "no_nominal_trial_reading")
        measured = nominal[-1]
        verdict = upper_limit([measured, measured], limit)
        return claim(verdict, "nominal_trial_reading", {"intervalMm": [measured, measured]})

    required = ("environment", "forceN", "fixture", "materialId")
    if (not all(isinstance(context.get(key), str) and context[key].strip()
                for key in ("environment", "fixture", "materialId"))
            or not finite_number(context.get("forceN"))):
        return claim("hold", "use_context_incomplete", action="明确使用环境、实际载荷、材料标识和装夹方式。")
    eligible, excluded = [], []
    for reading in readings:
        reasons = []
        if reading.get("designDigest") != digest:
            reasons.append("revision_mismatch")
        if reading.get("method") != "physical_trial" or not all(
            isinstance(reading.get(key), str) and reading[key].strip() for key in ("id", "source")
        ):
            reasons.append("missing_trial_provenance")
        if (not finite_number(reading.get("forceN"))
                or any(reading.get(key) != context[key] for key in required)):
            reasons.append("use_context_mismatch")
        measured, uncertainty = reading.get("measuredMm"), reading.get("uncertaintyMm")
        if not all(finite_number(value, zero=True) for value in (measured, uncertainty)):
            reasons.append("invalid_measurement_interval")
        if reasons:
            excluded.append({"id": reading.get("id"), "reasons": reasons})
            continue
        interval = [max(0, measured - uncertainty), measured + uncertainty]
        eligible.append({"id": reading["id"], "source": reading["source"],
                         "intervalMm": interval, "decision": upper_limit(interval, limit)})
    evidence = {"eligible": eligible, "excluded": excluded, "requiredUseContext": context, "limitMm": limit}
    decisions = {record["decision"] for record in eligible}
    if not decisions:
        return claim("hold", "no_applicable_trial", evidence, "提供当前设计和指定工况的试验记录及测量不确定度。")
    if {"pass", "fail"}.issubset(decisions):
        return claim("hold", "conflicting_trials", evidence, "人工复核冲突试验的试件、装夹、载荷和测量记录。")
    if "fail" in decisions:
        return claim("fail", "trial_limit_exceeded", evidence, "修改方案或复核已声明的使用需求。")
    if "hold" in decisions:
        return claim("hold", "trial_interval_crosses_limit", evidence, "缩小测量不确定度或提高设计裕量。")
    return claim("pass", "applicable_trials_within_limit", evidence)


def mount_fixture_claim(case, requirement, located_entries):
    from structure_rl import checked, fixture_evidence, fixture_checks
    parts = case["design"].get("parts", [])
    if len(parts) != 1 or not located_entries or len(located_entries) != 1:
        return claim("hold", "placed_mount_geometry_required", action="构建单实体安装板并提供当前装配位置的 BRep。")
    plate = located_entries[0]["shape"]
    try:
        pitch,count,travel,seat = checked(requirement["fixture"])
        top_faces, bottom_faces = plate.faces(">Z"), plate.faces("<Z")
        if (top_faces.size() != 1 or bottom_faces.size() != 1 or
                any(face.geomType() != "PLANE" or abs(abs(face.normalAt().z) - 1) > 1e-9
                    or abs(face.Center().z - z) > 1e-7
                    for face,z in [(top_faces.val(),2), (bottom_faces.val(),-2)])):
            return claim("hold", "fixture_datum_out_of_scope", action="该夹具定义要求板面位于 Z=±2 mm。")
        pins = [(x,y) for x in [-pitch/2,pitch/2][:int(count)//2] for y in [-pitch/2,pitch/2]]
        evidence = fixture_evidence(plate,pins,travel)
        checks = fixture_checks(evidence,seat)
        return claim("pass" if all(checks.values()) else "fail", "mount_fixture_checked",
                     {**evidence,"checks":checks,"fixture":requirement["fixture"]})
    except (KeyError, TypeError, ValueError, RuntimeError, ArithmeticError) as exc:
        return claim("hold", "fixture_check_unavailable", {"reason":str(exc)})


def evaluate(case, mode="agent", *, build_part=None, geometry_reports=None, located_entries=None):
    if mode not in MODES:
        raise ValueError(f"unknown evaluation mode: {mode}")
    design = case["design"]
    digest = design_digest(design)
    requirements = case["requirements"]
    if not requirements or len({item["id"] for item in requirements}) != len(requirements):
        raise ValueError("requirements must contain unique IDs")
    for item in requirements:
        expected_stage = METHODS.get(item["kind"], (item.get("stage", "verification"), None))[0]
        if expected_stage not in ("verification", "validation") or item.get("stage", expected_stage) != expected_stage:
            raise ValueError(f"invalid stage for requirement {item['id']}")
    claims = {"verification": [], "validation": []}
    kinds = {item["kind"] for item in requirements if not item.get("missing")}
    needs_geometry = bool(kinds & {"envelope", "outside_width", "stress", "deflection"})
    geometry, error = None, None
    if needs_geometry:
        if geometry_reports is None:
            geometry, error = cad_dimensions(design, build_part)
        else:
            geometry, error = built_dimensions(design, geometry_reports)
    analysis = calculation(case, geometry, mode) if needs_geometry and not error and (
        kinds & {"stress", "deflection"}
    ) else (None, error, "提供可重放的单零件 CAD 方案。")
    for requirement in requirements:
        kind = requirement["kind"]
        stage, method = METHODS.get(kind, (requirement.get("stage", "verification"), None))
        limit = requirement.get("maxMPa" if kind == "stress" else "maxMm")
        if requirement.get("missing"):
            missing = requirement["missing"]
            if not isinstance(missing, list) or any(field not in MISSING_INPUTS for field in missing):
                raise ValueError(f"invalid missing inputs for requirement {requirement['id']}")
            action = "请补充：" + "、".join(MISSING_INPUTS[field] for field in missing) + "。"
            result = claim("hold", "engineering_inputs_missing", {"missingInputs": missing}, action)
        elif method is None:
            statement = requirement.get("statement")
            result = claim("hold", "no_supported_method",
                           {"statement": statement} if isinstance(statement, str) else None,
                           action="人工确认该要求的验收方法与所需证据。")
        elif kind == "mount_fixture":
            result = mount_fixture_claim(case, requirement, located_entries)
        elif kind == "outside_width":
            lower = requirement.get("minMm")
            if not finite_number(lower, zero=True) or not finite_number(limit) or lower > limit:
                result = claim("hold", "invalid_width_band", action="补充整体 Y 向安装外宽的上下限，单位 mm。")
            elif error:
                result = claim("fail" if error == "invalid_brep" else "hold", error, geometry)
            else:
                width = geometry["dimensionsMm"][1]
                result = claim(within_band([width, width], lower, limit), "brep_width_compared",
                               {"measuredMm": width, "minMm": lower, "maxMm": limit})
        elif kind == "envelope":
            if not isinstance(limit, list) or len(limit) != 3 or not all(finite_number(v) for v in limit):
                raise ValueError("envelope maxMm must contain three positive limits")
            if error:
                result = claim("fail" if error == "invalid_brep" else "hold", error, geometry,
                               "检查并重建有效的单零件 CAD 实体。")
            else:
                result = claim("pass" if all(a <= b for a, b in zip(geometry["dimensionsMm"], limit)) else "fail",
                               "brep_bounds_compared", {**geometry, "limitMm": limit})
        elif not finite_number(limit, zero=True):
            raise ValueError(f"invalid limit for requirement {requirement['id']}")
        elif kind == "use_trial":
            result = trial_claim(case, limit, digest, mode)
        elif kind == "deflection" and ("minMm" in requirement or "targetMm" in requirement):
            lower = requirement.get("minMm", 0)
            target = requirement.get("targetMm")
            if (not finite_number(lower, zero=True) or lower > limit or ("targetMm" in requirement and
                    (not finite_number(target, zero=True) or not lower <= target <= limit))):
                result = claim("hold", "invalid_deflection_band", action="请核对工作挠度上下限和可选的优选值。")
            elif analysis[0] is None:
                result = claim("hold", analysis[1], geometry, analysis[2])
            else:
                interval = analysis[0]["deflection"]
                evidence = {"interval": interval, "minMm": lower, "maxMm": limit, "unit": "mm",
                            "forceN": analysis[0]["forceN"], "youngMPa": analysis[0]["youngMPa"]}
                if target is not None:
                    evidence["targetMm"] = target
                    evidence["worstTargetErrorMm"] = max(abs(value - target) for value in interval)
                result = claim(within_band(interval, lower, limit), "working_deflection_compared", evidence)
        elif analysis[0] is None:
            result = claim("hold", analysis[1], geometry, analysis[2])
        else:
            evidence = analysis[0]
            unit = "MPa" if kind == "stress" else "mm"
            decision = upper_limit(evidence[kind], limit)
            result = claim(decision, "analytical_interval_compared", {
                "interval": evidence[kind], "limit": limit, "unit": unit,
                "forceN": evidence["forceN"], "youngMPa": evidence["youngMPa"], **geometry,
            }, "缩小载荷和材料区间，或提高设计裕量。" if decision == "hold" else None)
        entry = {"id": requirement["id"], "kind": kind, "method": method, **result}
        if requirement.get("sourceIds"):
            entry["sourceIds"] = requirement["sourceIds"]
        claims[stage].append(entry)

    def aggregate(results):
        decisions = {result["decision"] for result in results}
        if not decisions:
            return "not_requested"
        if "fail" in decisions:
            return "fail"
        if "hold" in decisions:
            return "hold"
        return "pass"

    all_claims = claims["verification"] + claims["validation"]
    decision = aggregate(all_claims)
    if mode == "baseline":
        observed = [item for item in all_claims if item["decision"] != "hold"]
        decision = aggregate(observed) if observed else "hold"
    report = {
        "format": FORMAT, "id": case.get("id"),
        "mode": mode, "designDigest": digest, "decision": decision,
        "needsHumanReview": decision == "hold",
        **{stage: {"decision": aggregate(items), "claims": items} for stage, items in claims.items()},
    }
    if case.get("source") == "fbs":
        report["source"] = "fbs"
    return report


def manifest_design(manifest):
    # Bind trials to the builder input, including topology-affecting repairs.
    return {key: value for key, value in manifest.items()
            if key not in {"outputDir", "engineeringVerification"}}


def manifest_hold(reason, action, *, digest=None, details=None):
    return {
        "format": FORMAT, "mode": "agent", "designDigest": digest,
        "decision": "hold", "needsHumanReview": True, "reason": reason,
        "nextAction": action, "details": details,
        "verification": {"decision": "not_requested", "claims": []},
        "validation": {"decision": "not_requested", "claims": []},
    }


def evaluate_manifest(manifest, geometry_reports, located_entries=None):
    if "engineeringVerification" not in manifest:
        return None
    design = manifest_design(manifest)
    if any(uses_external_geometry(part) for part in design.get("parts", [])):
        return manifest_hold("design_binding_unavailable", "为导入或复用的 STEP 提供可核验的版本与工件证据。")
    contract = manifest["engineeringVerification"]
    try:
        digest = design_digest(design)
    except (ValueError, TypeError):
        return manifest_hold("design_binding_unavailable", "检查设计输入并重建可追溯的 CAD 版本。")
    if not geometry_reports:
        return manifest_hold("missing_brep_evidence", "构建当前设计并取得几何报告。", digest=digest)
    if not isinstance(contract, dict):
        return manifest_hold("invalid_engineering_verification_contract", "将验证需求与工况填写为 JSON 对象。", digest=digest)
    fields = ("id", "source", "requirements", "loadCase", "material", "useContext", "trialEvidence")
    case = {**{field: contract[field] for field in fields if field in contract}, "design": design}
    try:
        report = evaluate(case, geometry_reports=geometry_reports, located_entries=located_entries)
        json.dumps(report, allow_nan=False)
    except (ArithmeticError, AttributeError, KeyError, TypeError, ValueError) as exc:
        return manifest_hold("invalid_engineering_verification_contract", "检查验证需求、单位、工况和证据字段。",
                             digest=digest, details=str(exc))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--mode", choices=MODES, default="agent")
    args = parser.parse_args()
    if args.out and args.out.resolve() == args.input.resolve():
        parser.error("--out must differ from --input")
    case = json.loads(args.input.read_text(encoding="utf-8-sig"))
    report = evaluate(case, args.mode)
    result = json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(result, encoding="utf-8")
    sys.stdout.write(result)
    return {"pass": 0, "fail": 1, "hold": 2}[report["decision"]]


if __name__ == "__main__":
    sys.exit(main())
