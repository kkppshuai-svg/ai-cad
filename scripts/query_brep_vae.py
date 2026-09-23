#!/usr/bin/env python3
import argparse
import json
import math

import numpy as np

from train_brep_vae import encode_vectors, load_model


def rank_dataset_vector(model, vector, limit=5):
    from vae_runtime import VaeRuntime
    return VaeRuntime(model).search([vector], limit=max(1, int(limit)))[0]


def main():
    parser = argparse.ArgumentParser(description="Encode STEP geometry and query the AI-CAD BREP VAE v2.")
    parser.add_argument("--model", default="cad-latent/brep_vae_model.json")
    parser.add_argument("--step", required=True)
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()
    model = load_model(args.model)
    from extract_brep_geometry import extract_step_features
    geometry = extract_step_features(args.step)
    if geometry["featureNames"] != model["featureNames"]:
        raise SystemExit("geometry feature schema does not match model")
    latent = encode_vectors(model, np.asarray([geometry["vector"]], dtype=np.float64))[0]
    print(json.dumps({"step": args.step, "latent": latent.tolist(), "matches": rank_dataset_vector(model, geometry["vector"], args.limit)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
