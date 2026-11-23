"""Compare nominal checks and evidence-aware judgment on paired synthetic cases."""

import argparse
import json
from pathlib import Path

from engineering_verification import design_digest, evaluate


DECISIONS = ("pass", "fail", "hold")
MODES = ("baseline", "fixed_gate", "agent")


def design():
    return {
        "name": "Bench cantilever",
        "parts": [{"id": "beam", "primitives": [{"type": "box", "size": [120, 24, 8]}], "features": []}],
    }


def trial(case, trial_id="bench-1", measured_mm=0.17, uncertainty_mm=0.01):
    return {
        "id": trial_id,
        "designDigest": design_digest(case["design"]),
        "method": "physical_trial",
        "source": "synthetic fixture for the verification benchmark",
        **case["useContext"],
        "measuredMm": measured_mm,
        "uncertaintyMm": uncertainty_mm,
    }


def example(case_id, expected, rationale):
    case = {
        "id": case_id,
        "design": design(),
        "requirements": [
            {"id": "V-1", "kind": "envelope", "maxMm": [125, 25, 9]},
            {"id": "V-2", "kind": "deflection", "maxMm": 0.25},
            {"id": "V-3", "kind": "stress", "maxMPa": 20},
            {"id": "U-1", "kind": "use_trial", "maxMm": 0.25},
        ],
        "loadCase": {"support": "ideal_clamp", "kind": "static_tip_force", "forceN": 20},
        "material": {"youngMPa": 70_000},
        "useContext": {"environment": "bench-dry", "forceN": 20, "fixture": "end_clamp",
                       "materialId": "synthetic-alloy-A"},
    }
    case["trialEvidence"] = [trial(case)]
    return {"case": case, "expected": expected, "rationale": rationale}


def cases():
    yield example("complete-nominal", "pass",
                  "The CAD, analytical checks and matched intended-use trial meet their limits.")

    item = example("bounded-inputs-pass", "pass",
                   "The maximum analytical deflection and stress over both input ranges remain below their limits.")
    item["case"]["loadCase"]["forceN"] = [18, 22]
    item["case"]["material"]["youngMPa"] = [65_000, 75_000]
    yield item

    item = example("envelope-exceeded", "fail", "The 120 mm solid exceeds the 119 mm length limit.")
    item["case"]["requirements"][0]["maxMm"] = [119, 25, 9]
    yield item

    item = example("deflection-exceeded", "fail", "The analytical deflection is about 0.161 mm, above 0.10 mm.")
    item["case"]["requirements"][1]["maxMm"] = 0.10
    yield item

    item = example("stress-exceeded", "fail", "The analytical bending stress is 9.375 MPa, above 8 MPa.")
    item["case"]["requirements"][2]["maxMPa"] = 8
    yield item

    item = example("use-trial-exceeded", "fail",
                   "The matching trial interval [0.31, 0.33] mm lies above the intended-use limit.")
    item["case"]["trialEvidence"] = [trial(item["case"], measured_mm=0.32)]
    yield item

    item = example("missing-use-trial", "hold",
                   "Passing analytical checks leave the independent intended-use trial unobserved.")
    item["case"]["trialEvidence"] = []
    yield item

    item = example("stale-use-trial", "hold", "The only trial refers to a different design revision.")
    earlier_revision = design()
    earlier_revision["parts"][0]["primitives"][0]["size"][0] = 118
    item["case"]["trialEvidence"][0]["designDigest"] = design_digest(earlier_revision)
    yield item

    item = example("wrong-test-environment", "hold", "The recorded environment differs from the declared use.")
    item["case"]["trialEvidence"][0]["environment"] = "bench-wet"
    yield item

    item = example("wrong-test-load", "hold", "The trial ran at 10 N, while use is specified at 20 N.")
    item["case"]["trialEvidence"][0]["forceN"] = 10
    yield item

    item = example("wrong-test-material", "hold", "The only trial used a different material.")
    item["case"]["trialEvidence"][0]["materialId"] = "synthetic-alloy-B"
    yield item

    item = example("unattributed-trial", "hold", "The trial result has no recorded source.")
    del item["case"]["trialEvidence"][0]["source"]
    yield item

    item = example("analytical-interval-crosses-limit", "hold",
                   "The analytical deflection interval spans the 0.25 mm limit.")
    item["case"]["loadCase"]["forceN"] = [15, 35]
    item["case"]["material"]["youngMPa"] = [64_000, 76_000]
    yield item

    item = example("trial-interval-crosses-limit", "hold",
                   "The matching trial interval [0.225, 0.265] mm spans the 0.25 mm limit.")
    item["case"]["trialEvidence"] = [trial(item["case"], measured_mm=0.245, uncertainty_mm=0.02)]
    yield item

    item = example("contradictory-use-trials", "hold",
                   "Two in-scope trials support opposite intended-use verdicts.")
    item["case"]["trialEvidence"] = [
        trial(item["case"], trial_id="bench-1", measured_mm=0.32),
        trial(item["case"], trial_id="bench-2", measured_mm=0.17),
    ]
    yield item

    item = example("missing-modulus", "hold", "Deflection requires Young's modulus for the material.")
    del item["case"]["material"]["youngMPa"]
    yield item

    item = example("missing-analytical-load", "hold", "The analytical load case has no force.")
    del item["case"]["loadCase"]["forceN"]
    yield item

    item = example("perforated-section", "hold",
                   "A through-hole changes the section, outside the prismatic solid-beam method.")
    item["case"]["design"]["parts"][0]["features"] = [
        {"type": "hole", "diameter": 4, "depth": 10, "center": [0, 0, 0]}
    ]
    item["case"]["trialEvidence"] = [trial(item["case"])]
    yield item

    item = example("different-boundary-condition", "hold",
                   "A compliant support falls outside the ideal-clamp analytical model.")
    item["case"]["loadCase"]["support"] = "compliant_mount"
    yield item

    item = example("unsupported-required-claim", "hold",
                   "The required fatigue-life claim has no applicable verification method.")
    item["case"]["requirements"].append({"id": "V-4", "kind": "fatigue_life", "stage": "verification",
                                         "minCycles": 10_000})
    yield item


def metrics(records, mode):
    confusion = {expected: dict.fromkeys(DECISIONS, 0) for expected in DECISIONS}
    for record in records:
        confusion[record["expected"]][record[mode]["decision"]] += 1
    correct = sum(confusion[value][value] for value in DECISIONS)
    holds = sum(confusion[value]["hold"] for value in DECISIONS)
    decisive = len(records) - holds
    decisive_correct = confusion["pass"]["pass"] + confusion["fail"]["fail"]
    nonpass_cases = sum(sum(confusion[value].values()) for value in ("fail", "hold"))
    false_passes = confusion["fail"]["pass"] + confusion["hold"]["pass"]
    return {
        "cases": len(records),
        "correct": correct,
        "accuracy": correct / len(records),
        "falsePasses": false_passes,
        "falsePassesOnExpectedFail": confusion["fail"]["pass"],
        "falsePassesOnExpectedHold": confusion["hold"]["pass"],
        "falsePassRateAmongNonPassCases": false_passes / nonpass_cases,
        "holds": holds,
        "correctHolds": confusion["hold"]["hold"],
        "unnecessaryHolds": confusion["pass"]["hold"] + confusion["fail"]["hold"],
        "decisiveCoverage": decisive / len(records),
        "decisiveAccuracy": decisive_correct / decisive if decisive else None,
        "confusionExpectedByObserved": confusion,
    }


def paired_counts(records, reference_mode):
    comparisons = {
        (True, True): "bothCorrect",
        (False, True): "agentOnlyCorrect",
        (True, False): "baselineOnlyCorrect",
        (False, False): "neitherCorrect",
    }
    paired = dict.fromkeys(comparisons.values(), 0)
    for record in records:
        reference = record[reference_mode]["decision"] == record["expected"]
        agent = record["agent"]["decision"] == record["expected"]
        paired[comparisons[reference, agent]] += 1
    return paired


def run_benchmark():
    records = []
    for item in cases():
        case = item["case"]
        records.append({
            "id": case["id"],
            "expected": item["expected"],
            "rationale": item["rationale"],
            "input": case,
            **{mode: evaluate(case, mode=mode) for mode in MODES},
        })
    summaries = {mode: metrics(records, mode) for mode in MODES}
    return {
        "format": "ai-cad-engineering-verification-benchmark-v1",
        "protocol": {
            "pairing": "Both modes receive each identical input.",
            "reference": "Expected decisions were declared from the beam calculation and evidence scenarios.",
            "scope": "Controlled synthetic cases in one geometry and load domain. Trial records are synthetic.",
            "baseline": "Nominal CAD, analysis and trial checks. Unresolved claims are excluded from the verdict.",
            "fixedGate": "Same nominal checks. Unresolved claims prevent a pass.",
            "agent": "Applicability, input ranges and matching trial evidence contribute to the verdict.",
        },
        "metrics": summaries,
        "paired": paired_counts(records, "baseline"),
        "pairedFixedGate": paired_counts(records, "fixed_gate"),
        "records": records,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="Destination for the paired JSON report")
    args = parser.parse_args()
    report = run_benchmark()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps(
        {"report": str(args.out), "metrics": report["metrics"], "paired": report["paired"],
         "pairedFixedGate": report["pairedFixedGate"]},
        ensure_ascii=False, indent=2, allow_nan=False,
    ))
    return int(report["metrics"]["agent"]["correct"] != len(report["records"]))


if __name__ == "__main__":
    raise SystemExit(main())
