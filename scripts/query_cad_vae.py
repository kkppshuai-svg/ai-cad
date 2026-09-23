#!/usr/bin/env python3
import argparse
import json
import math
import re
from pathlib import Path

import numpy as np


ZH_KEYWORDS = [
    "轴承",
    "连杆",
    "支架",
    "外壳",
    "孔",
    "槽",
    "圆角",
    "倒角",
    "舵机",
    "电机",
    "螺丝",
    "螺钉",
    "安装",
    "轮胎",
    "除草刷",
    "刷毛",
    "主轴",
    "圆形阵列",
    "径向",
]

CAD_INTENT_RULES = [
    ("feature:extrude", [r"\bextrud\w*", r"拉伸", r"挤出"]),
    ("operation:CutFeatureOperation", [r"\bcut\b", r"切除"]),
    ("curve:Circle3D", [r"\bcircle\b", r"圆形草图"]),
    ("concept:weeding-brush", [r"weeding[_\s-]*brush", r"weed[_\s-]*brush", r"除草刷"]),
    ("component:bristle", [r"bristles?", r"brush[_\s-]*(wire|line|hair)", r"刷毛"]),
    ("component:shaft", [r"\bshaft\b", r"\baxis\b", r"主轴", r"刷轴", r"中心轴"]),
    ("pattern:radial-array", [r"radial[_\s-]*array", r"circular[_\s-]*array", r"round[_\s-]*array", r"圆形阵列", r"环形阵列", r"径向"]),
]


def query_tokens(text):
    normalized = str(text or "").lower()
    tokens = set(re.findall(r"[a-z0-9.#+-]+", normalized))
    for word in ZH_KEYWORDS:
        if word in normalized:
            tokens.add(f"zh:{word}")
    for token, patterns in CAD_INTENT_RULES:
        if any(re.search(pattern, normalized) for pattern in patterns):
            tokens.add(token)
    if "孔" in normalized:
        tokens.add("feature:hole")
    if "槽" in normalized:
        tokens.add("feature:slot")
    if "圆角" in normalized:
        tokens.add("feature:fillet")
    if "倒角" in normalized:
        tokens.add("feature:chamfer")
    if "concept:weeding-brush" in tokens:
        tokens.add("component:shaft")
    return tokens


def encode_query(model, text):
    if model.get('format') == 'formalatent-structure-vae-v1':
        from structure_vae import StructureVAE
        return StructureVAE(model).encode([{'tokens':list(query_tokens(text))}])[0]
    vocabulary = {token: index for index, token in enumerate(model["vocabulary"])}
    vector = np.zeros(len(model["mean"]), dtype=np.float64)
    for token in query_tokens(text):
        index = vocabulary.get(token)
        if index is not None:
            vector[index] = 1.0
    components = np.asarray(model["components"], dtype=np.float64)
    mean = np.asarray(model["mean"], dtype=np.float64)
    return (vector - mean) @ components.T


def distance(a, b):
    return math.sqrt(sum((float(x) - float(y)) ** 2 for x, y in zip(a, b)))


def token_weight(token):
    if token.startswith("concept:"):
        return 34.0
    if token.startswith("pattern:"):
        return 30.0
    if token.startswith("component:"):
        return 24.0
    if token.startswith("zh:"):
        return 12.0
    return 8.0


def structural_score(query_token_set, sample_tokens):
    sample_token_set = set(sample_tokens or [])
    return sum(token_weight(token) for token in query_token_set if token in sample_token_set)


def quality_score(quality):
    quality = quality or {}
    score = 0.0
    if quality.get("score") == 100:
        score += 4.0
    elif quality.get("score") == 50:
        score += 1.0
    elif quality.get("score") == 0:
        score -= 4.0
    return score


def main():
    parser = argparse.ArgumentParser(description="Query a neural CAD structure VAE or legacy SVD model.")
    parser.add_argument("--model", default="cad-latent/model.json")
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()

    model = json.loads(Path(args.model).read_text(encoding="utf-8"))
    query_token_set = query_tokens(args.query)
    latent = encode_query(model, args.query)
    matches = []
    for sample in model.get("samples", []):
        sample_distance = distance(latent, sample.get("latent") or [])
        sample_structural_score = structural_score(query_token_set, sample.get("tokens") or [])
        sample_quality_score = quality_score(sample.get("quality"))
        matches.append({
            "id": sample.get("id"),
            "name": sample.get("name"),
            "quality": sample.get("quality"),
            "latent": sample.get("latent"),
            "distance": sample_distance,
            "structuralScore": sample_structural_score,
            "rankScore": round(sample_structural_score + sample_quality_score - sample_distance, 8),
        })
    matches.sort(key=lambda item: (-item["rankScore"], item["distance"], -(item.get("quality") or {}).get("score", 0)))
    print(json.dumps({
        "query": args.query,
        "queryTokens": sorted(query_token_set),
        "latent": latent.round(8).tolist(),
        "matches": matches[:max(1, args.limit)]
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
