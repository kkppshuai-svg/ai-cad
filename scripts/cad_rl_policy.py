"""CPU-only, epsilon-greedy semi-gradient Q-learning for CAD edit actions."""

from collections import defaultdict
import math
import random
from statistics import mean

from cad_rl_env import ACTIONS, BeamEnv, benchmark_tasks


FORMAT = "ai-cad-rl-q-policy-v1"
TRAIN_SEED = 6405
TEST_SEED = 9177
GAMMA = 0.95
ALPHA = 0.14


def bin_index(value, edges):
    return sum(value > edge for edge in edges)


def features(env):
    c = env.current
    w, t = c.coordinate
    max_w, max_t = (len(axis) - 1 for axis in env.axes)
    ratio_bins = (0.55, 0.70, 0.82, 0.92, 1.0, 1.15, 1.4, 1.8, 2.5, 4.0)
    d, s, e = (bin_index(v, ratio_bins) for v in (c.deflection_ratio, c.stress_ratio, c.envelope_ratio))
    worst = max(d, s, e)
    w_rel, t_rel = (bin_index(i / max(1, n), (0, 0.25, 0.55, 0.8, 0.99))
                    for i, n in zip((w, t), (max_w, max_t)))
    w_left, t_left = min(2, max_w - w), min(2, max_t - t)
    best = int(env.best is not None)
    current = int(c.passed)
    gap = (bin_index(c.volume / env.best.volume, (0.85, 0.95, 1.01, 1.15))
           if env.best and c.volume else -1)
    steps = bin_index(env.remaining, (1, 2, 4, 7))
    ratio_steps = (c.size[1] / env.axes[0][max(0, w - 1)], c.size[2] / env.axes[1][max(0, t - 1)])
    # Include current CAD evidence and relative action sizes, not task IDs or target solutions.
    w_step = bin_index(ratio_steps[0], (1.03, 1.07, 1.12, 1.20))
    t_step = bin_index(ratio_steps[1], (1.04, 1.08, 1.14, 1.23))
    encoded = (
        "bias", f"status:{best},{current}", f"margin:{worst}", f"deflection:{d}", f"stress:{s}",
        f"envelope:{e}", f"room:{w_left},{t_left}", f"width:{w_rel}", f"thickness:{t_rel}",
        f"margin-position:{worst},{w_rel},{t_rel}", f"limit-room:{d},{s},{w_left},{t_left}",
        f"width-margin:{w_rel},{worst}", f"thickness-margin:{t_rel},{worst}",
        f"remaining:{steps},{best},{worst}", f"gap:{gap},{current}",
        f"step-size:{worst},{w_step},{t_step}", f"mask:{sum(1 << a for a in env.actions())},{worst}",
    )
    if c.bands:
        margins, error = c.fit()
        wl, wh, dl, dh = (bin_index(v, ratio_bins) for v in margins)
        sides = tuple(sorted((sum(e["interval"]) / 2 > e["targetMm"])
                             for _, e in c.bands if "targetMm" in e))
        miss = bin_index(error, (0.1, 0.25, 0.5, 1, 2)) if error is not None else -1
        encoded += (f"mount:{wl},{wh}", f"travel:{dl},{dh}", f"target:{sides},{miss}",
                    f"fit-action:{wl},{wh},{dl},{dh}", f"fit-status:{current},{sides},{miss}")
    return encoded


class QPolicy:
    def __init__(self, weights=None):
        self.weights = [defaultdict(float, row) for row in (weights or [{} for _ in ACTIONS])]

    def value(self, x, action):
        return sum(self.weights[action].get(key, 0) for key in x)

    def act(self, env, actions, rng=None, epsilon=0):
        if rng is not None and rng.random() < epsilon:
            return rng.choice(actions)
        x = features(env)
        values = {a: self.value(x, a) for a in actions}
        best = max(values.values())
        ties = [a for a in actions if values[a] == best]
        return ties[0] if rng is None else rng.choice(ties)

    def learn(self, x, action, reward, env):
        next_actions = env.actions()
        next_x = features(env) if next_actions else ()
        target = reward + GAMMA * max((self.value(next_x, a) for a in next_actions), default=0)
        error = target - self.value(x, action)
        update = ALPHA * error / len(x)
        for key in x:
            self.weights[action][key] += update

    def checkpoint(self, training):
        return {"format": FORMAT, "actions": list(ACTIONS), "training": training,
                "weights": [dict(row) for row in self.weights]}

    @classmethod
    def load(cls, data):
        weights = data["weights"]
        if (data.get("format") != FORMAT or data.get("actions") != list(ACTIONS)
                or not isinstance(weights, list) or len(weights) != len(ACTIONS)
                or not all(isinstance(row, dict) and all(type(v) in (int, float) and math.isfinite(v)
                                                        for v in row.values()) for row in weights)):
            raise ValueError("invalid or incompatible policy checkpoint")
        return cls(weights)


def train(episodes, tasks, seed, steps, *, policy=None, additional_tasks=(), suite_name="material"):
    if (not 1 <= episodes <= 1_000_000 or not 0 <= tasks <= 20_000
            or not 1 <= tasks + len(additional_tasks) <= 20_000):
        raise ValueError("invalid number of training episodes or tasks")
    rng = random.Random(seed)
    suite = [BeamEnv(task, max_steps=steps) for task in benchmark_tasks("train", tasks, TRAIN_SEED, suite_name)]
    suite.extend(BeamEnv(task, max_steps=steps) for task in additional_tasks)
    policy = policy if policy is not None else QPolicy()
    history, returns = [], []
    updates, passes = 0, 0
    window = max(1, episodes // 10)
    for i in range(episodes):
        env = rng.choice(suite)
        env.reset()
        epsilon = 0.06 + 0.59 * (1 - i / max(1, episodes - 1)) ** 1.5
        total = 0
        while actions := env.actions():
            x = features(env)
            a = policy.act(env, actions, rng, epsilon)
            reward = env.step(a)
            policy.learn(x, a, reward, env)
            total += reward
            updates += 1
        returns.append(total)
        passes += env.best is not None
        if (i + 1) % window == 0 or i + 1 == episodes:
            history.append({"episode": i + 1, "epsilon": round(epsilon, 4),
                            "meanReturn": mean(returns), "passRate": passes / len(returns)})
            returns, passes = [], 0
    return policy, {"episodes": episodes, "suite": suite_name, "trainTasks": tasks, "customTasks": len(additional_tasks),
                    "seed": seed, "trainTaskSeed": TRAIN_SEED,
                    "maxSteps": steps, "updates": updates, "distinctCandidateEvaluations": sum(len(env.cache) for env in suite),
                    "learningCurve": history}


def rollout(env, choose):
    env.reset()
    while (actions := env.actions()) and choose is not None:
        env.step(choose(env, actions))
    return env.best


def fixed_order(env, actions):
    order = (2, 3, 4) if env.best else (0, 1, 2, 3)
    return next(a for a in order if a in actions)


def greedy_physics(env, actions):
    """Beam-specific one-step model, using no additional CAD evaluations."""
    c = env.current
    limits = [item["maxMm"] for item in env.task["plan"]["engineeringVerification"]["requirements"]
              if item["kind"] == "envelope"]

    def projection(action):
        if action == 4:
            return 0, *env.best.rank, action
        wi, ti = env.neighbor(action)
        w, t = env.axes[0][wi], env.axes[1][ti]
        w_scale, t_scale = c.size[1] / w, c.size[2] / t
        ratio = max(c.deflection_ratio * w_scale * t_scale ** 3, c.stress_ratio * w_scale * t_scale ** 2,
                    *(a / b for limit in limits for a, b in zip((env.length, w, t), limit)))
        margins, error = c.fit(w / c.size[1], w_scale * t_scale ** 3)
        return (max(0, max(ratio, *margins) - 1 - 1e-12), error or 0, env.length * w * t, action)

    return min(actions, key=projection)


def benchmark(policy, tasks, steps, suite_name="material"):
    if not 1 <= tasks <= 20_000:
        raise ValueError("invalid number of evaluation tasks")
    rows = []
    for index, task in enumerate(benchmark_tasks("test", tasks, TEST_SEED, suite_name)):
        rng = random.Random(TEST_SEED + index + 1)
        env = BeamEnv(task, max_steps=steps)
        row = {"taskId": task["id"], "task": task, "initialReport": env.candidate(env.start).report, "results": {}}
        for name, choose in (
            ("noEdit", None), ("random", lambda e, a: rng.choice(a)), ("fixedOrder", fixed_order),
            ("greedyPhysics", greedy_physics), ("learned", policy.act),
        ):
            best = rollout(env, choose)
            row["results"][name] = {"passed": best is not None, "sizeMm": best.size if best else None,
                                    "normalizedTargetError": best.fit()[1] if best else None,
                                    "volumeMm3": best.volume if best else None,
                                    "volumeFraction": best.volume / env.reference_volume if best else None,
                                    "candidateEvaluations": len(env.seen), "trace": env.trace}
        rows.append(row)
    summaries = {}
    for name in rows[0]["results"]:
        results = [row["results"][name] for row in rows]
        passed = [r for r in results if r["passed"]]
        errors = [r["normalizedTargetError"] for r in passed if r["normalizedTargetError"] is not None]
        summaries[name] = {"passed": len(passed), "passRate": len(passed) / tasks,
                           "meanNormalizedTargetErrorOnPasses": mean(errors) if errors else None,
                           "meanVerifiedVolumeFraction": mean(r["volumeFraction"] for r in passed) if passed else None,
                           "meanCandidateEvaluations": mean(r["candidateEvaluations"] for r in results)}
    paired = {}
    for name in ("noEdit", "random", "fixedOrder", "greedyPhysics"):
        common, deltas = 0, []
        target_gains = []
        learned_only = baseline_only = 0
        for row in rows:
            learned, baseline = (row["results"][k] for k in ("learned", name))
            if learned["passed"] and baseline["passed"]:
                common += 1
                deltas.append(1 - learned["volumeMm3"] / baseline["volumeMm3"])
                if learned["normalizedTargetError"] is not None:
                    target_gains.append(baseline["normalizedTargetError"] - learned["normalizedTargetError"])
            learned_only += learned["passed"] and not baseline["passed"]
            baseline_only += baseline["passed"] and not learned["passed"]
        paired[name] = {"bothPassed": common, "learnedOnlyPassed": learned_only, "baselineOnlyPassed": baseline_only,
                        "meanNormalizedTargetErrorReductionOnCommonPasses": mean(target_gains) if target_gains else None,
                        "meanLearnedVolumeSavingsOnCommonPasses": mean(deltas) if deltas else None}
    return {"format": "ai-cad-rl-benchmark-v1", "suite": suite_name, "testTasks": tasks, "testTaskSeed": TEST_SEED,
            "maxEditSteps": steps, "summary": summaries, "learnedVsBaseline": paired, "cases": rows}
