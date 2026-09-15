import json
import tempfile
import unittest
from pathlib import Path

import cadquery as cq

from extract_brep_geometry import FEATURE_NAMES, extract_step_features, augment_dataset


class BrepGeometryExtractionTests(unittest.TestCase):
    def test_box_and_cylinder_produce_stable_nonzero_geometry_vectors(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            box_path = root / "box.step"
            cylinder_path = root / "cylinder.step"
            cq.exporters.export(cq.Workplane("XY").box(10, 20, 30), str(box_path))
            cq.exporters.export(cq.Workplane("XY").cylinder(20, 5), str(cylinder_path))

            box = extract_step_features(box_path)
            cylinder = extract_step_features(cylinder_path)

            self.assertEqual(box["featureNames"], FEATURE_NAMES)
            self.assertEqual(len(box["vector"]), len(FEATURE_NAMES))
            self.assertTrue(all(value == value for value in box["vector"]))
            self.assertGreater(sum(abs(value) for value in box["vector"]), 0)
            self.assertGreater(box["features"]["surface.plane_ratio"], 0.9)
            self.assertGreater(cylinder["features"]["surface.cylinder_ratio"], 0)
            self.assertNotEqual(box["vector"], cylinder["vector"])

    def test_dataset_augmentation_links_assembly_ids_to_step_geometry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assemblies = root / "assemblies"
            assembly_dir = assemblies / "job-123"
            assembly_dir.mkdir(parents=True)
            cq.exporters.export(cq.Workplane("XY").box(8, 9, 10), str(assembly_dir / "assembly.step"))
            dataset = root / "samples.jsonl"
            dataset.write_text(json.dumps({"id": "sample", "assemblyId": "job-123", "tokens": []}) + "\n", encoding="utf-8")
            output = root / "geometry.jsonl"

            summary = augment_dataset(dataset, assemblies, output)

            self.assertEqual(summary["sampleCount"], 1)
            record = json.loads(output.read_text(encoding="utf-8").strip())
            self.assertEqual(record["id"], "sample")
            self.assertEqual(record["geometry"]["featureNames"], FEATURE_NAMES)
            self.assertTrue(record["geometry"]["stepPath"].endswith("assembly.step"))


if __name__ == "__main__":
    unittest.main()
