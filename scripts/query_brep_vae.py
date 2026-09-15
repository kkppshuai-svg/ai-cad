#!/usr/bin/env python3
import argparse
import json
import math

import numpy as np

from extract_brep_geometry import extract_step_features
from train_brep_vae import encode_vectors, load_model


def rank_dataset_vector(model, vector, limit=5):
    latent = encode_vectors(model, np.asarray([vector], dtype=np.float64))[0]
    matches = []
    for sample in model.get("samples", []):
        sample_latent = np.asarray(sample.get("latent") or [], dtype=np.float64)
        distance = float(np.linalg.norm(latent - sample_latent))
        matches.append({"id": sample.get("id"), "name": sample.get("name"), "assemblyId": sample.get("assemblyId"), "distance": distance})
    matches.sort(key=lambda item: (item["distance"], str(item.get("id"))))
    return matches[:max(1, int(limit))]


def main():
    parser = argparse.ArgumentParser(description="Encode STEP geometry and query the AI-CAD BREP VAE v2.")
    parser.add_argument("--model", default="cad-latent/brep_vae_model.json")
    parser.add_argument("--step", required=True)
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()
    model = load_model(args.model)
    geometry = extract_step_features(args.step)
    if geometry["featureNames"] != model["featureNames"]:
        raise SystemExit("geometry feature schema does not match model")
    latent = encode_vectors(model, np.asarray([geometry["vector"]], dtype=np.float64))[0]
    print(json.dumps({"step": args.step, "latent": latent.tolist(), "matches": rank_dataset_vector(model, geometry["vector"], args.limit)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
