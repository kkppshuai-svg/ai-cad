#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import numpy as np


def load_samples(path: Path):
    samples = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        samples.append(json.loads(line))
    if not samples:
        raise SystemExit("dataset has no samples")
    return samples


def build_vocabulary(samples):
    tokens = sorted({token for sample in samples for token in sample.get("tokens", [])})
    return {token: index for index, token in enumerate(tokens)}


def vectorize_sample(sample, vocabulary):
    quality = sample.get("quality") or {}
    structure = sample.get("structure") or {}
    vector = np.zeros(len(vocabulary) + 6, dtype=np.float64)
    for token in sample.get("tokens", []):
        index = vocabulary.get(token)
        if index is not None:
            vector[index] = 1.0
    offset = len(vocabulary)
    vector[offset + 0] = float(quality.get("score") or 0) / 100.0
    vector[offset + 1] = 1.0 if quality.get("cadqueryBuilt") else 0.0
    vector[offset + 2] = 1.0 if quality.get("freecadVisible") else 0.0
    vector[offset + 3] = min(float(quality.get("failedConstraintCount") or 0), 8.0) / 8.0
    vector[offset + 4] = min(float(structure.get("partCount") or 0), 16.0) / 16.0
    vector[offset + 5] = min(float(structure.get("jointCount") or 0), 16.0) / 16.0
    return vector


def train_linear_vae_baseline(samples, latent_dim):
    vocabulary = build_vocabulary(samples)
    matrix = np.vstack([vectorize_sample(sample, vocabulary) for sample in samples])
    mean = matrix.mean(axis=0)
    centered = matrix - mean
    if min(centered.shape) == 1:
        components = np.eye(centered.shape[1], dtype=np.float64)[:latent_dim]
    else:
        _, _, vh = np.linalg.svd(centered, full_matrices=False)
        components = vh[:latent_dim]
    if components.shape[0] < latent_dim:
        pad = np.zeros((latent_dim - components.shape[0], centered.shape[1]), dtype=np.float64)
        components = np.vstack([components, pad])
    latents = centered @ components.T
    reconstructed = latents @ components + mean
    mse = float(np.mean((matrix - reconstructed) ** 2))
    return vocabulary, mean, components, latents, mse


def write_model(samples, vocabulary, mean, components, latents, mse, out_path: Path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    ordered_vocabulary = [token for token, _ in sorted(vocabulary.items(), key=lambda item: item[1])]
    payload = {
        "format": "ai-cad-linear-vae-baseline-v1",
        "createdAt": None,
        "sampleCount": len(samples),
        "latentDim": int(components.shape[0]),
        "vocabulary": ordered_vocabulary,
        "numericFeatures": [
            "quality.score",
            "quality.cadqueryBuilt",
            "quality.freecadVisible",
            "quality.failedConstraintCount",
            "structure.partCount",
            "structure.jointCount",
        ],
        "mean": mean.round(8).tolist(),
        "components": components.round(8).tolist(),
        "metrics": {
            "reconstructionMse": mse
        },
        "samples": [
            {
                "id": sample.get("id"),
                "name": sample.get("name"),
                "quality": sample.get("quality"),
                "tokens": sample.get("tokens") or [],
                "latent": latents[index].round(8).tolist(),
            }
            for index, sample in enumerate(samples)
        ],
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def main():
    parser = argparse.ArgumentParser(description="Train a lightweight CAD latent VAE baseline.")
    parser.add_argument("--dataset", default="cad-latent/training_samples.jsonl")
    parser.add_argument("--out", default="cad-latent/model.json")
    parser.add_argument("--latent-dim", type=int, default=8)
    args = parser.parse_args()

    samples = load_samples(Path(args.dataset))
    latent_dim = max(1, min(int(args.latent_dim), 64))
    vocabulary, mean, components, latents, mse = train_linear_vae_baseline(samples, latent_dim)
    payload = write_model(samples, vocabulary, mean, components, latents, mse, Path(args.out))
    print(json.dumps({
        "ok": True,
        "sampleCount": payload["sampleCount"],
        "latentDim": payload["latentDim"],
        "tokenCount": len(payload["vocabulary"]),
        "reconstructionMse": payload["metrics"]["reconstructionMse"],
        "model": str(Path(args.out))
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
