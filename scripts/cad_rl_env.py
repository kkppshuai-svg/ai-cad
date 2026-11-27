"""A bounded CAD design environment backed by AI-CAD's engineering verifier."""

from copy import deepcopy
from dataclasses import dataclass
import math
import random

from engineering_verification import bounds, cantilever_response, evaluate, finite_number


TASK_FORMAT = "ai-cad-rl-beam-task-v1"
ACTIONS = ("thicker", "wider", "thinner", "narrower", "stop")
DELTAS = ((0, 1), (1, 0), (0, -1), (-1, 0))
MAX_STEPS = 32
ANALYTICAL_COMPARISON = "analytical_interval_compared"


def checked_task(task):
    """Check topology and edit permissions; leave evidence judgments to the verifier."""
    if task.get("format") != TASK_FORMAT:
        raise ValueError(f"task format must be {TASK_FORMAT}")
    plan, contract = task["plan"], task["plan"]["engineeringVerification"]
    parts = plan["parts"]
    if (len(parts) != 1 or any(plan.get(key) for key in ("repairActions", "constraints", "joints", "relations"))):
        raise ValueError("only a standalone rectangular beam plan is supported")
    part = parts[0]
    if (any(part.get(key) for key in ("reuseStepPath", "sourceStepPath", "features"))
            or part.get("mode") == "standard_part"):
        raise ValueError("features and imported or standard parts are outside this environment")
    if "featureTree" in part:
        tree = part["featureTree"]
        if (len(tree) != 1 or tree[0].get("type") != "base_box" or not tree[0].get("enabled", True)
                or tree[0].get("dependencies")):
            raise ValueError("the feature tree must contain only its enabled base_box")
        box = tree[0]["params"]
        if box.get("type", "box") != "box":
            raise ValueError("base_box must build a box")
    else:
        if len(part.get("primitives", [])) != 1 or part["primitives"][0].get("type") != "box":
            raise ValueError("the plan must contain one box primitive")
        box = part["primitives"][0]
    if (any((item.get("pose") or {}).get("rotate", [0, 0, 0]) != [0, 0, 0] for item in (part, box))
            or not (len(box["size"]) == 3 and all(finite_number(v) for v in box["size"]))):
        raise ValueError("the beam must have positive dimensions and align with XYZ")
    if "featureTree" in part and "primitives" in part and (
        len(part["primitives"]) != 1 or part["primitives"][0].get("type") != "box"
        or part["primitives"][0].get("size") != box["size"]
    ):
        raise ValueError("the feature tree and compatibility primitive must agree")
    requirements = contract["requirements"]
    if not {"envelope", "deflection", "stress"}.issubset(row["kind"] for row in requirements):
        raise ValueError("the beam task requires envelope, deflection and stress checks")
    grids = []
    for key, initial in zip(("widthMm", "thicknessMm"), box["size"][1:]):
        axis = task["search"][key]
        lo, hi, step = (axis[k] for k in ("min", "max", "step"))
        if not all(finite_number(v) for v in (lo, hi, step)) or lo > hi:
            raise ValueError(f"invalid {key} search range")
        span = (hi - lo) / step
        if not math.isfinite(span) or span > 32 or not math.isclose(span, round(span), abs_tol=1e-8):
            raise ValueError(f"{key} must be an aligned grid of at most 33 values")
        count = round(span)
        if count == 0 and lo != hi:
            raise ValueError(f"{key} range is shorter than one step")
        grid = (lo,) if not count else (lo, *(round(lo + step * i, 9) for i in range(1, count)), hi)
        if any(a >= b for a, b in zip(grid, grid[1:])):
            raise ValueError(f"invalid {key} grid precision")
        start = next((i for i, x in enumerate(grid) if math.isclose(x, initial, rel_tol=0, abs_tol=1e-9)), None)
        if start is None:
            raise ValueError(f"initial {key} must lie on its authorized grid")
        if not lo <= initial <= hi:
            raise ValueError(f"initial {key} is outside its authorized range")
        grids.append(((*grid[:start], initial, *grid[start + 1:]), start))
    return box["size"][0], grids


@dataclass
class Candidate:
    coordinate: tuple
    size: tuple
    plan: dict
    report: dict
    volume: float | None
    deflection_ratio: float
    stress_ratio: float
    envelope_ratio: float
    evidence_blocked: bool

    @property
    def passed(self):
        return self.report["decision"] == "pass" and self.volume is not None

    @property
    def worst(self):
        return max(self.deflection_ratio, self.stress_ratio, self.envelope_ratio)


class BeamEnv:
    def __init__(self, task, *, max_steps, build_part=None):
        if type(max_steps) is not int or not 1 <= max_steps <= MAX_STEPS:
            raise ValueError(f"max_steps must be between 1 and {MAX_STEPS}")
        self.task = deepcopy(task)
        self.length, grids = checked_task(self.task)
        self.axes, self.start = map(tuple, zip(*grids))
        self.max_steps = max_steps
        self.reference_volume = self.length * self.axes[0][-1] * self.axes[1][-1]
        self.build_part = build_part
        self.cache = {}

    def candidate(self, coordinate):
        if coordinate in self.cache:
            return self.cache[coordinate]
        size = (self.length, *(axis[i] for axis, i in zip(self.axes, coordinate)))
        plan = deepcopy(self.task["plan"])
        part = plan["parts"][0]
        if coordinate != self.start:  # Keep the untouched input byte-equivalent at the data level.
            if "featureTree" in part:
                part["featureTree"][0]["params"]["size"] = list(size)
            if "primitives" in part:
                part["primitives"][0]["size"] = list(size)
        case = {**plan["engineeringVerification"], "design": {
            key: value for key, value in plan.items() if key != "engineeringVerification"
        }}
        report = evaluate(case, build_part=self.build_part)
        volume = None
        ratios = dict.fromkeys(("envelope", "deflection", "stress"), 0.0)
        blocked = False
        for item in report["verification"]["claims"] + report["validation"]["claims"]:
            evidence = item.get("evidence") or {}
            kind = item["kind"]
            if item["reason"] == "brep_bounds_compared":
                volume = evidence["volumeMm3"]
                ratio = max(a / b for a, b in zip(evidence["dimensionsMm"], evidence["limitMm"]))
                blocked |= evidence["dimensionsMm"][0] > evidence["limitMm"][0]
            elif item["reason"] == ANALYTICAL_COMPARISON and evidence["limit"] > 0:
                ratio = evidence["interval"][1] / evidence["limit"]
            else:
                blocked |= item["decision"] != "pass"
                continue
            ratios[kind] = max(ratios[kind], ratio)
        blocked |= volume is None
        candidate = Candidate(coordinate, size, plan, report, volume, ratios["deflection"], ratios["stress"],
                              ratios["envelope"], blocked)
        self.cache[coordinate] = candidate
        return candidate

    def reset(self):
        self.current = self.candidate(self.start)
        self.best = self.current if self.current.passed else None
        self.trace = []
        self.seen = {self.start}
        self.remaining = self.max_steps

    def neighbor(self, action):
        return tuple(v + d for v, d in zip(self.current.coordinate, DELTAS[action]))

    def actions(self):
        if not self.remaining or self.current.evidence_blocked:
            return ()
        moves = tuple(a for a in range(len(DELTAS)) if (
            (point := self.neighbor(a)) not in self.seen
            and all(0 <= i < len(axis) for i, axis in zip(point, self.axes))
        ))
        return (*moves, 4) if self.best else moves

    def potential(self):
        # A verified candidate dominates all violations, irrespective of material savings.
        violation = min(4, max(0, self.current.worst - 1))
        if self.best:
            return 3 * (1 - self.best.volume / self.reference_volume) + 3 - 0.08 * violation
        return -0.35 * math.log1p(violation)

    def step(self, action):
        if action not in self.actions():
            raise ValueError("invalid or unavailable action")
        before = self.potential()
        self.remaining -= 1
        if action == 4:
            self.remaining = 0
        else:
            point = self.neighbor(action)
            self.seen.add(point)
            self.current = self.candidate(point)
            if self.current.passed and (self.best is None or self.current.volume < self.best.volume):
                self.best = self.current
        reward = self.potential() - before - (0.025 if action != 4 else 0)
        self.trace.append({"action": ACTIONS[action], "sizeMm": self.current.size,
                           "decision": self.current.report["decision"], "reward": reward,
                           "designDigest": self.current.report["designDigest"]})
        return reward


def benchmark_tasks(split, count, seed):
    """Disjoint length grids and RNG seeds. Contracts vary independently of the learner."""
    if split not in ("train", "test"):
        raise ValueError("unknown benchmark split")
    rng = random.Random(seed)
    for index in range(count):
        length = rng.randrange(100, 177, 4) + (2 if split == "test" else 0)
        min_w, max_t = rng.randrange(10, 21, 2), min(length // 10, rng.randint(8, 13))
        max_w, min_t = min_w + rng.randrange(8, 21, 2), max(5, max_t - rng.randint(3, 6))
        young, force = rng.randrange(55_000, 105_001, 5_000), rng.randrange(15, 56, 5)
        # A preregistered feasible reference generates the target limits, not training labels.
        candidate_width = rng.randrange(min_w + 2, max_w + 1, 2)
        candidate_thickness = rng.randint(max(min_t + 2, max_t - 3), max_t)
        reference = cantilever_response((length, candidate_width, candidate_thickness), force * 1.08, young * 0.95)
        width = rng.choice((min_w, max_w, rng.randrange(min_w, max_w + 1, 2)))
        thickness = rng.choice((min_t, max_t, rng.randint(min_t, max_t)))
        yield {
            "format": TASK_FORMAT, "id": f"{split}-{index:04d}",
            "search": {"widthMm": {"min": min_w, "max": max_w, "step": 2},
                       "thicknessMm": {"min": min_t, "max": max_t, "step": 1}},
            "plan": {
                "name": "verification-rl-beam",
                "parts": [{"id": "beam", "primitives": [{"type": "box", "size": [length, width, thickness]}]}],
                "engineeringVerification": {
                    "requirements": [
                        {"id": "space", "kind": "envelope", "maxMm": [length, max_w, max_t]},
                        {"id": "stiffness", "kind": "deflection", "maxMm": reference["deflection"] * rng.uniform(1.01, 1.35)},
                        {"id": "strength", "kind": "stress", "maxMPa": reference["stress"] * rng.uniform(1.01, 1.3)},
                    ],
                    "loadCase": {"support": "ideal_clamp", "kind": "static_tip_force", "forceN": [force, force * 1.08]},
                    "material": {"youngMPa": [young * 0.95, young]},
                },
            },
        }
