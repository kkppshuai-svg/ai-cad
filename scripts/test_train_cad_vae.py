import json
import subprocess
import sys
from pathlib import Path


def test_train_cad_vae_writes_model(tmp_path):
    dataset = tmp_path / "samples.jsonl"
    model = tmp_path / "model.json"
    samples = [
        {
            "id": "servo",
            "name": "servo_bracket",
            "tokens": ["zh:舵机", "zh:支架", "feature:hole", "quality:excellent"],
            "quality": {"score": 100, "cadqueryBuilt": True, "freecadVisible": True, "failedConstraintCount": 0},
            "structure": {"partCount": 1, "featureTypes": {"hole": 2}},
        },
        {
            "id": "tire-fail",
            "name": "bad_tire",
            "tokens": ["zh:轮胎", "freecad:constraint-failed"],
            "quality": {"score": 0, "cadqueryBuilt": False, "freecadVisible": False, "failedConstraintCount": 1},
            "structure": {"partCount": 1, "featureTypes": {}},
        },
        {
            "id": "case",
            "name": "electronics_case",
            "tokens": ["zh:外壳", "feature:hole", "primitive:box:1"],
            "quality": {"score": 50, "cadqueryBuilt": True, "freecadVisible": True, "failedConstraintCount": 0},
            "structure": {"partCount": 1, "featureTypes": {"hole": 4}},
        },
    ]
    dataset.write_text("\n".join(json.dumps(sample) for sample in samples) + "\n", encoding="utf-8")

    result = subprocess.run(
        [sys.executable, "scripts/train_cad_vae.py", "--dataset", str(dataset), "--out", str(model), "--latent-dim", "2", "--backend", "svd"],
        cwd=Path(__file__).resolve().parents[1],
        text=True,
        capture_output=True,
        check=True,
    )

    payload = json.loads(model.read_text(encoding="utf-8"))
    assert payload["format"] == "ai-cad-linear-vae-baseline-v1"
    assert payload["latentDim"] == 2
    assert "feature:hole" in payload["vocabulary"]
    assert len(payload["samples"]) == 3
    assert all(len(item["latent"]) == 2 for item in payload["samples"])
    assert payload["samples"][0]["tokens"] == samples[0]["tokens"]
    assert "reconstructionMse" in payload["metrics"]
    assert "sampleCount" in result.stdout
