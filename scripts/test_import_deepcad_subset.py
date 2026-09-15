import json
import tempfile
import unittest
from pathlib import Path

from extract_brep_geometry import extract_step_features
from import_deepcad_subset import build_step_from_document, select_split_ids


def rectangle_document():
    curves = [
        {"type": "Line3D", "start_point": {"x": 0, "y": 0}, "end_point": {"x": 20, "y": 0}},
        {"type": "Line3D", "start_point": {"x": 20, "y": 0}, "end_point": {"x": 20, "y": 10}},
        {"type": "Line3D", "start_point": {"x": 20, "y": 10}, "end_point": {"x": 0, "y": 10}},
        {"type": "Line3D", "start_point": {"x": 0, "y": 10}, "end_point": {"x": 0, "y": 0}},
    ]
    return {
        "entities": {
            "sketch": {
                "type": "Sketch",
                "transform": {
                    "origin": {"x": 0, "y": 0, "z": 0},
                    "x_axis": {"x": 1, "y": 0, "z": 0},
                    "y_axis": {"x": 0, "y": 1, "z": 0},
                    "z_axis": {"x": 0, "y": 0, "z": 1},
                },
                "profiles": {"profile": {"loops": [{"is_outer": True, "profile_curves": curves}]}},
            },
            "extrude": {
                "type": "ExtrudeFeature",
                "profiles": [{"sketch": "sketch", "profile": "profile"}],
                "start_extent": {"type": "ProfilePlaneStartDefinition"},
                "operation": "NewBodyFeatureOperation",
                "extent_type": "OneSideFeatureExtentType",
                "extent_one": {"distance": {"value": 5}},
            },
        },
        "sequence": [{"type": "ExtrudeFeature", "entity": "extrude"}],
        "properties": {"bounding_box": {}},
    }


class DeepCadSubsetTests(unittest.TestCase):
    def test_split_selection_is_seeded_and_stable(self):
        values = [f"0000/{index:08d}" for index in range(30)]
        self.assertEqual(select_split_ids(values, 6, 17), select_split_ids(values, 6, 17))
        self.assertNotEqual(select_split_ids(values, 6, 17), select_split_ids(values, 6, 18))
        self.assertEqual(len(select_split_ids(values, 6, 17)), 6)

    def test_builds_valid_step_usable_by_brep_extractor(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "rectangle.step"
            build_step_from_document(rectangle_document(), output)
            geometry = extract_step_features(output)

            self.assertTrue(output.exists())
            self.assertEqual(len(geometry["vector"]), 44)
            self.assertEqual(geometry["facts"]["solidCount"], 1)
            self.assertGreater(geometry["facts"]["volumeMm3"], 990)


if __name__ == "__main__":
    unittest.main()
