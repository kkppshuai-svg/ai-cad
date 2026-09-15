import json
import subprocess
import sys
from pathlib import Path


def test_query_cad_vae_returns_nearest_samples(tmp_path):
    model = tmp_path / "model.json"
    model.write_text(json.dumps({
        "format": "ai-cad-linear-vae-baseline-v1",
        "latentDim": 2,
        "vocabulary": ["feature:hole", "zh:舵机", "zh:轮胎"],
        "numericFeatures": [],
        "mean": [0, 0, 0, 0, 0, 0, 0, 0, 0],
        "components": [
            [1, 1, 0, 0, 0, 0, 0, 0, 0],
            [0, 0, 1, 0, 0, 0, 0, 0, 0],
        ],
        "samples": [
            {"id": "servo", "name": "servo_bracket", "quality": {"score": 100}, "latent": [2, 0]},
            {"id": "tire", "name": "tire", "quality": {"score": 0}, "latent": [0, 1]},
        ],
    }), encoding="utf-8")

    result = subprocess.run(
        [sys.executable, "scripts/query_cad_vae.py", "--model", str(model), "--query", "舵机支架安装孔", "--limit", "1"],
        cwd=Path(__file__).resolve().parents[1],
        text=True,
        capture_output=True,
        check=True,
    )
    payload = json.loads(result.stdout)

    assert payload["matches"][0]["id"] == "servo"
    assert payload["matches"][0]["distance"] < 0.001


def test_query_cad_vae_boosts_structural_intent_tokens(tmp_path):
    model = tmp_path / "model.json"
    model.write_text(json.dumps({
        "format": "ai-cad-linear-vae-baseline-v1",
        "latentDim": 2,
        "vocabulary": [
            "feature:hole",
            "concept:weeding-brush",
            "component:bristle",
            "component:shaft",
            "pattern:radial-array",
            "150mm",
            "10",
        ],
        "numericFeatures": [],
        "mean": [0, 0, 0, 0, 0, 0, 0],
        "components": [
            [1, 0, 0, 0, 0, 0, 0],
            [0, 1, 1, 1, 1, 1, 1],
        ],
        "samples": [
            {"id": "die", "name": "simple_die", "quality": {"score": 100}, "latent": [1, 0], "tokens": ["feature:hole"]},
            {
                "id": "brush",
                "name": "weeding_brush_150mm_radial_array",
                "quality": {"score": 100},
                "latent": [0, 6],
                "tokens": [
                    "concept:weeding-brush",
                    "component:bristle",
                    "component:shaft",
                    "pattern:radial-array",
                    "150mm",
                    "10",
                ],
            },
        ],
    }), encoding="utf-8")

    result = subprocess.run(
        [
            sys.executable,
            "scripts/query_cad_vae.py",
            "--model",
            str(model),
            "--query",
            "做一个150mm除草刷，10列圆形阵列刷毛",
            "--limit",
            "1",
        ],
        cwd=Path(__file__).resolve().parents[1],
        text=True,
        capture_output=True,
        check=True,
    )
    payload = json.loads(result.stdout)

    assert payload["matches"][0]["id"] == "brush"
    assert set(payload["queryTokens"]) == {
        "10",
        "150mm",
        "component:bristle",
        "component:shaft",
        "concept:weeding-brush",
        "pattern:radial-array",
        "zh:圆形阵列",
        "zh:刷毛",
        "zh:除草刷",
    }
    assert payload["matches"][0]["structuralScore"] > payload["matches"][0]["distance"]
