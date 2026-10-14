import importlib.util
import math
from pathlib import Path
import tempfile
import unittest

HAS_NATIVE = importlib.util.find_spec("usd_brep") is not None


@unittest.skipUnless(HAS_NATIVE, "Run with the independent USD BRep Python environment")
class NativeKernelTests(unittest.TestCase):
    def test_box_cylinder_sphere_are_built_by_native_library(self):
        import usd_brep as b
        from usd_brep_build import build_solid
        for kind, params, expected in (
            ("box", {"size": [10, 20, 30]}, 6000),
            ("cylinder", {"radius": 4, "height": 6}, math.pi*16*6),
            ("sphere", {"radius": 3}, 36*math.pi)):
            solid, trace = build_solid({"featureTree": [{"id": "base", "type": "base_"+kind, "params": params}]})
            self.assertTrue(b.is_manifold_solid(solid))
            self.assertTrue(math.isclose(b.compute_volume(solid, 1e-8), expected, rel_tol=1e-6))
            self.assertEqual(trace[0]["operation"], "usd_brep.create_"+kind)

    def test_boolean_hole_and_exact_usd_roundtrip(self):
        from usd_brep_build import build
        import os
        with tempfile.TemporaryDirectory(prefix="native-test-", dir=os.path.realpath(tempfile.gettempdir())) as directory:
            report = build({"featureTree": [
                {"id": "base", "type": "base_box", "params": {"size": [40,30,6]}},
                {"id": "hole", "type": "hole", "dependsOn": ["base"], "params": {"diameter": 8, "depth": 20}}
            ]}, directory)
            self.assertTrue(math.isclose(report["volumeMm3"], 7200-math.pi*16*6, rel_tol=1e-6))
            self.assertEqual(report["representation"], "brep")
            self.assertEqual(report["roundTrip"], "passed")
            self.assertTrue((Path(directory) / "native-solid.usda").exists())
            self.assertIn("usd_brep.boolean_difference", [row["operation"] for row in report["featureTrace"]])

    def test_unknown_features_and_invalid_dimensions_do_not_fallback(self):
        from usd_brep_build import build_solid
        for node in ({"id": "unsupported", "type": "base_spur_gear", "params": {}},
                     {"id": "invalid", "type": "base_box", "params": {"size": [0, 10, 10]}}):
            with self.assertRaises(ValueError):
                build_solid({"featureTree": [node]})


if __name__ == "__main__":
    unittest.main()
