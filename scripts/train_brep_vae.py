#!/usr/bin/env python3
import argparse
import copy
import json
from pathlib import Path

import numpy as np


def load_geometry_dataset(path):
    records = []
    names = None
    vectors = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        geometry = record.get("geometry") or {}
        current_names = geometry.get("featureNames")
        vector = geometry.get("vector")
        if not current_names or not isinstance(vector, list):
            continue
        if names is None:
            names = list(current_names)
        if list(current_names) != names or len(vector) != len(names):
            raise ValueError("geometry feature schema mismatch")
        records.append(record)
        vectors.append([float(value) for value in vector])
    if len(records) < 2:
        raise ValueError("BREP VAE requires at least two geometry samples")
    matrix = np.asarray(vectors, dtype=np.float64)
    if not np.isfinite(matrix).all():
        raise ValueError("geometry dataset contains non-finite values")
    return records, names, matrix


def init_params(input_dim, hidden_dim, latent_dim, rng):
    def weight(fan_in, fan_out):
        return rng.normal(0, np.sqrt(2.0 / max(fan_in + fan_out, 1)), size=(fan_in, fan_out))
    return {
        "w1": weight(input_dim, hidden_dim), "b1": np.zeros(hidden_dim),
        "w_mu": weight(hidden_dim, latent_dim), "b_mu": np.zeros(latent_dim),
        "w_lv": weight(hidden_dim, latent_dim), "b_lv": np.full(latent_dim, -1.5),
        "w2": weight(latent_dim, hidden_dim), "b2": np.zeros(hidden_dim),
        "w_out": weight(hidden_dim, input_dim), "b_out": np.zeros(input_dim),
    }


def forward(params, x, rng=None, sample=True):
    h = np.tanh(x @ params["w1"] + params["b1"])
    mu = h @ params["w_mu"] + params["b_mu"]
    raw_lv = h @ params["w_lv"] + params["b_lv"]
    logvar = np.clip(raw_lv, -8.0, 5.0)
    epsilon = (rng.normal(size=mu.shape) if sample and rng is not None else np.zeros_like(mu))
    std = np.exp(0.5 * logvar)
    z = mu + std * epsilon
    decoder_hidden = np.tanh(z @ params["w2"] + params["b2"])
    output = decoder_hidden @ params["w_out"] + params["b_out"]
    return {"x": x, "h": h, "mu": mu, "raw_lv": raw_lv, "logvar": logvar, "epsilon": epsilon, "std": std, "z": z, "dh": decoder_hidden, "out": output}


def loss_and_gradients(params, x, beta, rng):
    cache = forward(params, x, rng=rng, sample=True)
    batch, dim = x.shape
    latent_dim = cache["mu"].shape[1]
    residual = cache["out"] - x
    reconstruction = float(np.mean(residual ** 2))
    kl = float(np.mean(-0.5 * (1.0 + cache["logvar"] - cache["mu"] ** 2 - np.exp(cache["logvar"]))))
    d_out = 2.0 * residual / (batch * dim)
    grads = {}
    grads["w_out"] = cache["dh"].T @ d_out
    grads["b_out"] = d_out.sum(axis=0)
    d_dh = (d_out @ params["w_out"].T) * (1.0 - cache["dh"] ** 2)
    grads["w2"] = cache["z"].T @ d_dh
    grads["b2"] = d_dh.sum(axis=0)
    d_z = d_dh @ params["w2"].T
    d_mu = d_z + beta * cache["mu"] / (batch * latent_dim)
    d_lv = d_z * cache["epsilon"] * 0.5 * cache["std"]
    d_lv += beta * 0.5 * (np.exp(cache["logvar"]) - 1.0) / (batch * latent_dim)
    clip_mask = ((cache["raw_lv"] >= -8.0) & (cache["raw_lv"] <= 5.0)).astype(np.float64)
    d_lv *= clip_mask
    grads["w_mu"] = cache["h"].T @ d_mu
    grads["b_mu"] = d_mu.sum(axis=0)
    grads["w_lv"] = cache["h"].T @ d_lv
    grads["b_lv"] = d_lv.sum(axis=0)
    d_h = (d_mu @ params["w_mu"].T + d_lv @ params["w_lv"].T) * (1.0 - cache["h"] ** 2)
    grads["w1"] = x.T @ d_h
    grads["b1"] = d_h.sum(axis=0)
    return reconstruction + beta * kl, reconstruction, kl, grads


def adam_step(params, grads, state, step, learning_rate):
    beta1, beta2, epsilon = 0.9, 0.999, 1e-8
    for name in params:
        gradient = np.clip(grads[name], -5.0, 5.0)
        state["m"][name] = beta1 * state["m"][name] + (1 - beta1) * gradient
        state["v"][name] = beta2 * state["v"][name] + (1 - beta2) * gradient * gradient
        m_hat = state["m"][name] / (1 - beta1 ** step)
        v_hat = state["v"][name] / (1 - beta2 ** step)
        params[name] -= learning_rate * m_hat / (np.sqrt(v_hat) + epsilon)


def evaluate(params, x, beta):
    cache = forward(params, x, sample=False)
    reconstruction = float(np.mean((cache["out"] - x) ** 2))
    kl = float(np.mean(-0.5 * (1 + cache["logvar"] - cache["mu"] ** 2 - np.exp(cache["logvar"]))))
    return reconstruction + beta * kl, reconstruction, kl


def train_brep_vae(records, feature_names, matrix, latent_dim=8, hidden_dim=64, epochs=400, beta=0.01, learning_rate=0.01, seed=42, initial_model=None, batch_size=64, warmup_epochs=20):
    rng = np.random.default_rng(seed)
    matrix = np.asarray(matrix, dtype=np.float64)
    if matrix.ndim != 2 or matrix.shape != (len(records), len(feature_names)) or len(records) < 2:
        raise ValueError("expected at least two records with matching feature vectors")
    if not np.isfinite(matrix).all() or not len(feature_names):
        raise ValueError("features must be nonempty and finite")
    if min(latent_dim, hidden_dim, epochs, batch_size) < 1 or warmup_epochs < 0 or not np.isfinite([beta, learning_rate]).all() or beta < 0 or learning_rate <= 0:
        raise ValueError("invalid training hyperparameters")
    if initial_model is not None:
        if list(initial_model.get("featureNames", [])) != list(feature_names):
            raise ValueError("pretrained model feature schema mismatch")
        if int(initial_model.get("inputDim", -1)) != matrix.shape[1]:
            raise ValueError("pretrained model input dimension mismatch")
        hidden_dim = int(initial_model["hiddenDim"])
        latent_dim = int(initial_model["latentDim"])
    order = rng.permutation(len(records))
    validation_count = max(1, int(round(len(records) * 0.2))) if len(records) >= 5 else 1
    validation_indices = order[:validation_count]
    train_indices = order[validation_count:]
    if not len(train_indices):
        train_indices = order
    # Fit statistics only on training data; retain the pretrained coordinate system.
    if initial_model is None:
        mean = matrix[train_indices].mean(axis=0)
        std = matrix[train_indices].std(axis=0)
        std[std < 1e-8] = 1.0
    else:
        mean = np.asarray(initial_model["normalization"]["mean"], dtype=np.float64)
        std = np.asarray(initial_model["normalization"]["std"], dtype=np.float64)
        if mean.shape != (matrix.shape[1],) or std.shape != mean.shape or not np.isfinite([mean, std]).all() or (std <= 0).any():
            raise ValueError("invalid pretrained normalization")
    normalized = (matrix - mean) / std
    train_x = normalized[train_indices]
    validation_x = normalized[validation_indices]
    params = init_params(matrix.shape[1], hidden_dim, latent_dim, rng)
    if initial_model is not None:
        pretrained_params = model_params(initial_model)
        for name in params:
            if pretrained_params[name].shape != params[name].shape or not np.isfinite(pretrained_params[name]).all():
                raise ValueError(f"invalid pretrained weight: {name}")
            params[name] = pretrained_params[name].copy()
    state = {"m": {name: np.zeros_like(value) for name, value in params.items()}, "v": {name: np.zeros_like(value) for name, value in params.items()}}
    best_params = copy.deepcopy(params)
    best_validation = evaluate(params, validation_x, beta)[0]
    stale = 0
    history = []
    step = 0
    for epoch in range(1, int(epochs) + 1):
        epoch_beta = beta * min(1.0, epoch / max(warmup_epochs, 1))
        shuffled = rng.permutation(len(train_x))
        for start in range(0, len(train_x), batch_size):
            batch_x = train_x[shuffled[start:start + batch_size]]
            total, reconstruction, kl, grads = loss_and_gradients(params, batch_x, epoch_beta, rng)
            step += 1
            adam_step(params, grads, state, step, learning_rate)
        validation_total, validation_reconstruction, validation_kl = evaluate(params, validation_x, beta)
        history.append({"epoch": epoch, "loss": total, "reconstruction": reconstruction, "kl": kl, "validationLoss": validation_total})
        if validation_total < best_validation - 1e-7:
            best_validation = validation_total
            best_params = copy.deepcopy(params)
            stale = 0
        else:
            stale += 1
        if stale >= 60:
            break
    params = best_params
    _, reconstruction, kl = evaluate(params, normalized, beta)
    latents = forward(params, normalized, sample=False)["mu"]
    return {
        "format": "ai-cad-brep-vae-v2",
        "sampleCount": len(records),
        "inputDim": matrix.shape[1],
        "hiddenDim": hidden_dim,
        "latentDim": latent_dim,
        "featureNames": list(feature_names),
        "normalization": {"mean": mean.tolist(), "std": std.tolist()},
        "weights": {name: value.tolist() for name, value in params.items()},
        "training": {"beta": beta, "learningRate": learning_rate, "epochsCompleted": len(history), "seed": seed, "batchSize": batch_size, "warmupEpochs": warmup_epochs,
                     "initializedFrom": initial_model.get("format") if initial_model is not None else None,
                     "implementationVersion": "3.0.0", "normalizationSource": "pretrained" if initial_model else "training-split",
                     "trainIndices": train_indices.tolist(), "validationIndices": validation_indices.tolist()},
        "metrics": {"reconstructionMse": reconstruction, "klLoss": kl, "validationLoss": best_validation},
        "samples": [
            {"id": record.get("id"), "name": record.get("name"), "assemblyId": record.get("assemblyId"), "latent": latents[index].tolist(), "geometryVector": matrix[index].tolist()}
            for index, record in enumerate(records)
        ],
    }


def load_model(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def model_params(model):
    return {name: np.asarray(value, dtype=np.float64) for name, value in model["weights"].items()}


def encode_vectors(model, matrix):
    matrix = np.asarray(matrix, dtype=np.float64)
    mean = np.asarray(model["normalization"]["mean"], dtype=np.float64)
    std = np.asarray(model["normalization"]["std"], dtype=np.float64)
    normalized = (matrix - mean) / std
    return forward(model_params(model), normalized, sample=False)["mu"]


def decode_latents(model, latents):
    """Decode latent coordinates to geometry descriptors, not a STEP solid."""
    latents = np.asarray(latents, dtype=np.float64)
    if latents.ndim != 2 or latents.shape[1] != model["latentDim"] or not np.isfinite(latents).all():
        raise ValueError("expected finite latent matrix with model latent dimension")
    params = model_params(model)
    normalized = np.tanh(latents @ params["w2"] + params["b2"]) @ params["w_out"] + params["b_out"]
    return normalized * np.asarray(model["normalization"]["std"]) + np.asarray(model["normalization"]["mean"])


def write_model(model, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Train the geometry-aware AI-CAD BREP VAE v2.")
    parser.add_argument("--dataset", default="cad-latent/brep_training_samples.jsonl")
    parser.add_argument("--out", default="cad-latent/brep_vae_model.json")
    parser.add_argument("--latent-dim", type=int, default=8)
    parser.add_argument("--hidden-dim", type=int, default=64)
    parser.add_argument("--epochs", type=int, default=400)
    parser.add_argument("--beta", type=float, default=0.01)
    parser.add_argument("--learning-rate", type=float, default=0.01)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--warmup-epochs", type=int, default=20)
    parser.add_argument("--init-model", help="Compatible BREP VAE model used to initialize fine-tuning.")
    args = parser.parse_args()
    records, feature_names, matrix = load_geometry_dataset(args.dataset)
    initial_model = load_model(args.init_model) if args.init_model else None
    model = train_brep_vae(records, feature_names, matrix, args.latent_dim, args.hidden_dim, args.epochs, args.beta, args.learning_rate, args.seed, initial_model, args.batch_size, args.warmup_epochs)
    write_model(model, args.out)
    print(json.dumps({"ok": True, "model": args.out, "sampleCount": model["sampleCount"], "metrics": model["metrics"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
