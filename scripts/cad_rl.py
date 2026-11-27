#!/usr/bin/env python3
"""Train, benchmark or run the opt-in AI-CAD engineering optimization policy."""

import argparse
import json
from pathlib import Path
import sys

from cad_rl_env import BeamEnv, MAX_STEPS
from cad_rl_policy import QPolicy, benchmark, rollout, train


def read_json(file):
    return json.loads(file.read_text(encoding="utf-8-sig"))


def write_json(file, data):
    text = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding="utf-8")


def task_file(file):
    value = read_json(file)
    if not isinstance(value, (list, dict)):
        raise ValueError("training tasks must be a task object or an array of task objects")
    return [value] if isinstance(value, dict) else value


def suggest(policy, task, steps):
    env = BeamEnv(task, max_steps=steps)
    best = rollout(env, policy.act)
    initial = env.candidate(env.start)
    return {
        "format": "ai-cad-rl-suggestion-v1", "taskId": task.get("id"),
        "decision": "verified_candidate" if best else "no_verified_candidate",
        "initialReport": initial.report, "initialSizeMm": initial.size,
        "candidate": ({"plan": best.plan, "sizeMm": best.size, "volumeMm3": best.volume,
                       "rankingObjective": "working_deflection_target" if best.fit()[1] is not None else "volume",
                       "normalizedTargetError": best.fit()[1],
                       "report": best.report, "changed": best.coordinate != env.start} if best else None),
        "lastReport": env.current.report, "candidateEvaluations": len(env.seen), "trace": env.trace,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    training = commands.add_parser("train", help="learn policy weights from CadQuery verification rewards")
    training.add_argument("--episodes", type=int, default=6000)
    training.add_argument("--tasks", type=int, default=200)
    training.add_argument("--suite", choices=("fit", "material"), help="default: fit, or the resumed suite")
    training.add_argument("--seed", type=int, default=42)
    training.add_argument("--steps", type=int, default=8)
    training.add_argument("--task-file", type=Path, help="optional real beam task or JSON array of tasks")
    training.add_argument("--resume", type=Path, help="start from an existing policy checkpoint")
    training.add_argument("--out", type=Path, required=True)
    testing = commands.add_parser("evaluate", help="compare a frozen policy with baselines on held-out cases")
    testing.add_argument("--model", type=Path, required=True)
    testing.add_argument("--tasks", type=int, default=120)
    testing.add_argument("--suite", choices=("fit", "material"), help="default: checkpoint training suite")
    testing.add_argument("--steps", type=int)
    testing.add_argument("--out", type=Path, required=True)
    proposing = commands.add_parser("suggest", help="export a verified candidate, never promote a revision")
    proposing.add_argument("--model", type=Path, required=True)
    proposing.add_argument("--input", type=Path, required=True)
    proposing.add_argument("--steps", type=int)
    proposing.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    inputs = (getattr(args, name, None) for name in ("model", "input", "resume", "task_file"))
    if args.out.resolve() in {file.resolve() for file in inputs if file}:
        parser.error("--out must be separate from all input paths")
    try:
        if args.command == "train":
            previous = read_json(args.resume) if args.resume else None
            prior_metrics = previous.get("training", {}) if previous else {}
            additions = task_file(args.task_file) if args.task_file else []
            policy, metrics = train(args.episodes, args.tasks, args.seed, args.steps,
                                    policy=QPolicy.load(previous) if previous is not None else None,
                                    additional_tasks=additions, suite_name=args.suite or prior_metrics.get(
                                        "suite", "material" if previous else "fit"))
            metrics["totalEpisodes"] = prior_metrics.get("totalEpisodes", 0) + metrics["episodes"]
            metrics["totalUpdates"] = prior_metrics.get("totalUpdates", 0) + metrics["updates"]
            metrics["builtInTrainingOnly"] = not additions and (
                previous is None or prior_metrics.get("builtInTrainingOnly") is True
            )
            write_json(args.out, policy.checkpoint(metrics))
            summary = metrics
        else:
            data = read_json(args.model)
            policy = QPolicy.load(data)
            steps = args.steps if args.steps is not None else data.get("training", {}).get("maxSteps", 8)
            if type(steps) is not int or not 1 <= steps <= MAX_STEPS:
                raise ValueError(f"steps must be between 1 and {MAX_STEPS}")
            if args.command == "evaluate":
                report = benchmark(policy, args.tasks, steps, args.suite or data.get("training", {}).get("suite", "material"))
                report["disjointByConstruction"] = data.get("training", {}).get("builtInTrainingOnly") is True
                summary = {key: report[key] for key in ("disjointByConstruction", "summary", "learnedVsBaseline")}
            else:
                report = suggest(policy, read_json(args.input), steps)
                summary = {"decision": report["decision"], "initialSizeMm": report["initialSizeMm"],
                           "candidateSizeMm": (report["candidate"] or {}).get("sizeMm"),
                           "candidateEvaluations": report["candidateEvaluations"]}
            write_json(args.out, report)
        print(json.dumps(summary, ensure_ascii=True, indent=2, allow_nan=False))
        return 2 if args.command == "suggest" and summary["decision"] == "no_verified_candidate" else 0
    except ModuleNotFoundError as exc:
        parser.exit(1, f"Missing CAD dependency ({exc}); run with the repository's CadQuery Python.\n")
    except (ArithmeticError, AttributeError, IndexError, KeyError, OSError, TypeError, ValueError) as exc:
        parser.exit(1, f"cad_rl: {exc}\n")


if __name__ == "__main__":
    sys.exit(main())
