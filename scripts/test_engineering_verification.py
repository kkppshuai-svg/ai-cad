import unittest
from unittest.mock import patch

from engineering_verification import cantilever_response, design_digest, evaluate, evaluate_manifest


class EngineeringVerificationTests(unittest.TestCase):
    def test_calculation_matches_a_known_end_loaded_beam(self):
        # L=120 mm, I=1024 mm^4, fixed-end moment=2400 N mm.
        result = cantilever_response([120, 24, 8], force=20, young=70_000)
        self.assertAlmostEqual(result["stress"], 9.375)
        self.assertAlmostEqual(result["deflection"], 0.1607142857142857)

    def test_product_validation_does_not_inherit_verification_pass(self):
        design = {"parts": []}
        context = {"environment": "bench", "forceN": 20, "fixture": "clamp", "materialId": "A"}
        case = {
            "design": design, "useContext": context,
            "requirements": [{"id": "U-1", "kind": "use_trial", "maxMm": 0.25}],
            "trialEvidence": [{
                "id": "run-1", "source": "test fixture", "method": "physical_trial",
                "designDigest": design_digest(design), **context,
                "measuredMm": 0.21, "uncertaintyMm": 0.02,
            }],
        }
        complete = evaluate(case)
        self.assertEqual(complete["verification"]["decision"], "not_requested")
        self.assertEqual(complete["validation"]["decision"], "pass")
        case["trialEvidence"][0]["materialId"] = "B"
        wrong_material = evaluate(case)
        self.assertEqual(wrong_material["decision"], "hold")
        self.assertTrue(wrong_material["needsHumanReview"])
        evidence = wrong_material["validation"]["claims"][0]["evidence"]
        self.assertEqual(evidence["excluded"][0]["reasons"], ["use_context_mismatch"])

    def test_manifest_checks_use_built_geometry_instead_of_rebuilding(self):
        manifest, reports = built_cantilever()
        contract = manifest["engineeringVerification"]
        contract["requirements"] += [{"id": "deflection", "kind": "deflection", "maxMm": 0.25}]
        contract["loadCase"] = {"support": "ideal_clamp", "kind": "static_tip_force", "forceN": 20}
        contract["material"] = {"youngMPa": 70_000}
        contract["design"] = {"parts": []}
        contract["geometry_reports"] = [{"partId": "beam", "facts": {"bbox": [1, 1, 1]}}]
        with patch("engineering_verification.cad_dimensions", side_effect=AssertionError("unexpected second build")):
            outcome = evaluate_manifest(manifest, reports)
            self.assertEqual(outcome["decision"], "pass")
            self.assertEqual(outcome["verification"]["claims"][0]["evidence"]["partId"], "beam")
            reports[0]["facts"]["bbox"][0] = 130
            self.assertEqual(evaluate_manifest(manifest, reports)["decision"], "fail")

    def test_manifest_trial_digest_does_not_depend_on_output_or_contract(self):
        manifest, reports = built_cantilever()
        outcome = evaluate_manifest(manifest, reports)
        digest = outcome["designDigest"]
        context = {"forceN": 20, "fixture": "fixed", "environment": "bench", "materialId": "A"}
        manifest["outputDir"] = "new-output"
        manifest["engineeringVerification"].update({
            "requirements": [{"id": "trial", "kind": "use_trial", "maxMm": 0.25}],
            "useContext": context,
            "trialEvidence": [{"id": "run-1", "source": "test bench", "method": "physical_trial",
                               "designDigest": digest, "measuredMm": 0.17, "uncertaintyMm": 0.01, **context}],
        })
        outcome = evaluate_manifest(manifest, reports)
        self.assertEqual(outcome["decision"], "pass")
        self.assertEqual(outcome["designDigest"], digest)
        manifest["repairActions"] = [{"type": "clean_and_retry"}]
        outcome = evaluate_manifest(manifest, reports)
        self.assertEqual(outcome["decision"], "hold")
        self.assertNotEqual(outcome["designDigest"], digest)

    def test_manifest_holds_for_missing_or_unbound_evidence(self):
        manifest, reports = built_cantilever()
        self.assertEqual(evaluate_manifest(manifest, [])["reason"], "missing_brep_evidence")
        for field in ("sourceStepPath", "reuseStepPath"):
            with self.subTest(field=field):
                manifest["parts"][0][field] = "external.step"
                outcome = evaluate_manifest(manifest, reports)
                self.assertEqual(outcome["decision"], "hold")
                self.assertEqual(outcome["reason"], "design_binding_unavailable")
                self.assertIsNone(outcome["designDigest"])
                del manifest["parts"][0][field]
        manifest["engineeringVerification"]["requirements"] = []
        outcome = evaluate_manifest(manifest, reports)
        self.assertEqual(outcome["decision"], "hold")
        self.assertEqual(outcome["reason"], "invalid_engineering_verification_contract")
        del manifest["engineeringVerification"]
        self.assertIsNone(evaluate_manifest(manifest, reports))

    def test_fbs_input_gaps_preserve_other_claims_and_trace(self):
        manifest, reports = built_cantilever()
        contract = manifest["engineeringVerification"]
        contract["source"] = "fbs"
        contract["requirements"].append({"id": "fbs-deflection", "kind": "deflection",
                                         "sourceIds": ["be-stiffness", "ac-deflection"],
                                         "missing": ["maxMm", "loadCase.forceN"]})
        result = evaluate_manifest(manifest, reports)
        measured, pending = result["verification"]["claims"]
        self.assertEqual(result["source"], "fbs")
        self.assertEqual(result["decision"], "hold")
        self.assertEqual(measured["decision"], "pass")
        self.assertEqual(pending["decision"], "hold")
        self.assertEqual(pending["evidence"]["missingInputs"], ["maxMm", "loadCase.forceN"])
        self.assertEqual(pending["sourceIds"], ["be-stiffness", "ac-deflection"])


def built_cantilever():
    return ({
        "name": "cantilever",
        "outputDir": "output",
        "parts": [{"id": "beam", "featureTree": [{"id": "beam.base", "type": "base_box",
                                                    "params": {"size": [120, 24, 8]}}]}],
        "engineeringVerification": {"requirements": [{"id": "envelope", "kind": "envelope",
                                                        "maxMm": [125, 25, 9]}]},
    }, [{"partId": "beam", "brepCheck": {"valid": True},
         "facts": {"bbox": [120, 24, 8], "volume": 23_040, "solidCount": 1}}])
