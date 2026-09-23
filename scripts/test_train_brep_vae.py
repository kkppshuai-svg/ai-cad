import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from train_brep_vae import load_geometry_dataset, train_brep_vae, write_model, load_model, encode_vectors
from query_brep_vae import rank_dataset_vector


class BrepVaeTrainingTests(unittest.TestCase):
    def make_dataset(self, path, count=12, dim=10):
        rng = np.random.default_rng(7)
        records = []
        for index in range(count):
            center = 0.2 if index < count // 2 else 0.8
            vector = np.clip(rng.normal(center, 0.04, size=dim), 0, 1).tolist()
            records.append({
                "id": f"sample-{index}",
                "name": f"Sample {index}",
                "geometry": {"featureNames": [f"f{i}" for i in range(dim)], "vector": vector}
            })
        path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")

    def test_trains_saves_loads_and_encodes_a_real_variational_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset_path = root / "dataset.jsonl"
            model_path = root / "model.json"
            self.make_dataset(dataset_path)
            records, names, matrix = load_geometry_dataset(dataset_path)

            model = train_brep_vae(records, names, matrix, latent_dim=3, hidden_dim=12, epochs=80, seed=11)
            write_model(model, model_path)
            loaded = load_model(model_path)
            latent = encode_vectors(loaded, matrix[:2])

            self.assertEqual(loaded["format"], "ai-cad-brep-vae-v2")
            self.assertEqual(loaded["latentDim"], 3)
            self.assertEqual(latent.shape, (2, 3))
            self.assertTrue(np.isfinite(latent).all())
            self.assertTrue(np.isfinite(loaded["metrics"]["reconstructionMse"]))
            self.assertTrue(np.isfinite(loaded["metrics"]["klLoss"]))

    def test_query_vector_ranks_its_own_saved_sample_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset_path = root / "dataset.jsonl"
            self.make_dataset(dataset_path)
            records, names, matrix = load_geometry_dataset(dataset_path)
            model = train_brep_vae(records, names, matrix, latent_dim=4, hidden_dim=16, epochs=60, seed=3)

            matches = rank_dataset_vector(model, matrix[5], limit=3)

            self.assertEqual(matches[0]["id"], "sample-5")
            self.assertAlmostEqual(matches[0]["distance"], 0.0, places=7)

    def test_can_fine_tune_from_a_compatible_pretrained_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            dataset_path = Path(tmp) / "dataset.jsonl"
            self.make_dataset(dataset_path)
            records, names, matrix = load_geometry_dataset(dataset_path)
            pretrained = train_brep_vae(records, names, matrix, latent_dim=3, hidden_dim=12, epochs=20, seed=5)

            fine_tuned = train_brep_vae(records[:6], names, matrix[:6], epochs=10, seed=6, initial_model=pretrained)

            self.assertEqual(fine_tuned["training"]["initializedFrom"], "ai-cad-brep-vae-v2")
            self.assertEqual(fine_tuned["latentDim"], pretrained["latentDim"])
            self.assertEqual(fine_tuned["normalization"], pretrained["normalization"])
            self.assertTrue(np.isfinite(fine_tuned["metrics"]["reconstructionMse"]))
            self.assertNotEqual(fine_tuned["weights"], pretrained["weights"])


if __name__ == "__main__":
    unittest.main()
