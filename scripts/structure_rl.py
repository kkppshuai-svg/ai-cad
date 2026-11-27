"""Learn mounting-structure choices from measured CAD outcomes (one-step contextual Q-learning)."""
import argparse
from functools import lru_cache
import json
import math
from pathlib import Path
import random

import cadquery as cq
from cadquery_build import build_part
from cad_rl import read_json, write_json


ROOT = Path(__file__).resolve().parents[1]
LIBRARY = ROOT / "cad-latent/training_samples.jsonl"
FORMAT = "ai-cad-mount-policy-v1"


def motifs(path=LIBRARY):
    sources = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        sample = json.loads(line)
        quality = sample["quality"]
        if not (quality.get("retainedForLearning") and quality.get("cadqueryBuilt")
                and quality.get("score") == 100 and quality.get("failedConstraintCount") == 0):
            continue
        structure = sample["structure"]
        features = structure.get("featureTypes", {})
        if structure.get("partCount") != 1 or not structure.get("primitiveTypes", {}).get("box"):
            continue
        roles = " ".join(structure.get("partRoles", [])).lower()
        if features.get("hole") == 4 and any(term in roles for term in ("安装孔", "mounting hole")):
            sources.setdefault("four_holes",set()).add(sample["id"])
        if features.get("slot") == 2 and any(term in roles for term in ("调节槽", "adjustment slot")):
            sources.setdefault("twin_slots",set()).add(sample["id"])
    if len(sources) != 2:
        raise ValueError("both verified source motifs are required")
    return {action:sorted(ids) for action,ids in sources.items()}


def checked(task):
    keys = {"pitchMm", "pinCount", "travelMm", "minSeatFraction"}
    if set(task) != keys:
        raise ValueError(f"mount contract fields must be {sorted(keys)}")
    pitch, count, travel, seat = (task[k] for k in ("pitchMm","pinCount","travelMm","minSeatFraction"))
    if not all(type(v) in (float, int) and math.isfinite(v) for v in (pitch,count,travel,seat)):
        raise ValueError("mount contract requires finite numbers")
    if not (12 <= pitch <= 48 and count in (2,4) and 0 <= travel <= 12 and 0 < seat <= 1):
        raise ValueError("unsupported fixture dimensions or limits")
    return pitch, count, travel, seat


def state(count, travel, seat):
    return f"{count:g}/{int(travel > 0.2)}/{int(seat >= 0.8)}"


@lru_cache(maxsize=512)
def measure(pitch, count, travel, action):
    ys = [-pitch/2, pitch/2]
    xs = [-pitch/2, pitch/2]
    pins = [(x, y) for x in xs[:int(count)//2] for y in ys]
    cuts = ([{"type":"hole","diameter":4.4,"center":[x,y,0]} for x in xs for y in ys]
            if action == "four_holes" else
            [{"type":"slot","axis":"x","width":4.4,"length":4.4 + max(4, travel),
              "center":[xs[0],y,0]} for y in ys])
    plan = {"name":"mount-candidate","parts":[{"id":"plate","primitives":[
        {"type":"box","size":[pitch+28,pitch+18,4]}],"features":cuts}]}
    plate = build_part(plan["parts"][0])
    return {"plan":plan, **fixture_evidence(plate,pins,travel)}


def fixture_evidence(plate,pins,travel):
    shape = plate.val()
    top = plate.faces(">Z").val()
    collisions, seats = [], []
    for x,y in pins:
        # The capsule is the exact swept volume of a 4 mm pin in straight X translation.
        sketch = cq.Workplane("XY").center(x,y)
        sweep = (sketch.slot2D(4 + travel, 4) if travel else sketch.circle(2)).extrude(4,both=True).val()
        collisions.append(shape.intersect(sweep).Volume())
        # Area of material under a washer annulus at both final clamping positions.
        for end in sorted({x-travel/2,x+travel/2}):
            annulus = cq.Face.makeFromWires(cq.Workplane("XY").circle(5).val(),
                                            [cq.Workplane("XY").circle(2.2).val()]).translate((end,y,2))
            seats.append(top.intersect(annulus).Area()/annulus.Area())
    return {"oneValidSolid":shape.isValid() and len(shape.Solids()) == 1,
            "maxPinSweepOverlapMm3":max(collisions), "minEndSeatFraction":min(seats)}


def fixture_checks(evidence,seat):
    return {"connectedSolid":evidence["oneValidSolid"],
              "pinPathClear":evidence["maxPinSweepOverlapMm3"] <= 1e-7,
              "clampingFootprint":evidence["minEndSeatFraction"] + 1e-8 >= seat}


def verify(task, action):
    if action not in ("four_holes", "twin_slots"):
        raise ValueError("unsupported mounting motif")
    pitch,count,travel,seat = checked(task)
    evidence = measure(pitch,count,travel,action)
    checks = fixture_checks(evidence,seat)
    passed = all(checks.values())
    return {**evidence,"checks":checks,"passed":passed,
            "reward":1 + min(1,evidence["minEndSeatFraction"]) if passed else -1}


def tasks(split):
    for pitch in range(16 + int(split == "test"), 33, 4):
        for count, travel, seat in [(4,0,0.9),(2,6,0.65),(2,0,0.65),(4,6,0.9)]:
            yield {"pitchMm":pitch,"pinCount":count,"travelMm":travel,"minSeatFraction":seat}


def choose(q, key, actions):
    return max(actions, key=lambda a:q.get(key,{}).get(a,0))


def run(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=["train","evaluate","suggest"])
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--model",type=Path)
    parser.add_argument("--input",type=Path)
    parser.add_argument("--samples",type=Path,default=LIBRARY)
    parser.add_argument("--episodes",type=int,default=400)
    args = parser.parse_args(argv)
    if any(p and p.resolve()==args.out.resolve() for p in (args.input,args.model,args.samples)):
        parser.error("use a separate output path")
    sources = motifs(args.samples)
    actions = sorted(sources)
    if args.command == "train":
        if args.episodes < 1:
            parser.error("episodes must be positive")
        rng = random.Random(42)
        suite = list(tasks("train"))
        if args.input:
            extra = read_json(args.input)
            extra = extra if isinstance(extra,list) else [extra]
            for task in extra:
                checked(task)
            suite.extend(extra)
        q = {}
        for i in range(args.episodes):
            task = rng.choice(suite)
            _,count,travel,seat = checked(task)
            key = state(count,travel,seat)
            row = q.setdefault(key,{a:0.0 for a in actions})
            action = rng.choice(actions) if rng.random()<0.30 else choose(q,key,actions)
            reward = verify(task,action)["reward"]
            row[action] += 0.2*(reward-row[action])
        result = {"format":FORMAT,"sources":sources,"q":q,"updates":args.episodes,"customTraining":bool(args.input)}
    else:
        if not args.model or (args.command=="suggest" and not args.input):
            parser.error("provide --model and, for suggest, --input")
        model = read_json(args.model)
        if model["format"] != FORMAT or model["sources"] != sources:
            parser.error("checkpoint and source catalog mismatch")
        rows = []
        for task in ([read_json(args.input)] if args.command=="suggest" else tasks("test")):
            _,count,travel,seat = checked(task)
            action = choose(model["q"],state(count,travel,seat),actions)
            report = verify(task,action).copy()
            plan = report.pop("plan")
            plan = {**plan,"engineeringVerification":{"requirements":[
                {"id":"mount-interface","kind":"mount_fixture","fixture":task}]}}
            row = {"task":task,"motif":action,"sourceIds":sources[action],"report":report,
                   "candidate":plan if report["passed"] else None}
            if args.command=="evaluate":
                row["allActions"] = {a:verify(task,a)["passed"] for a in actions}
            rows.append(row)
        result = rows[0] if args.command=="suggest" else {"cases":rows,
            "passed":sum(r["report"]["passed"] for r in rows),
            "feasible":sum(any(r["allActions"].values()) for r in rows),
            "fixedActionPasses":{a:sum(r["allActions"][a] for r in rows) for a in actions}}
    write_json(args.out,result)
    print(json.dumps({k:v for k,v in result.items() if k not in ("cases","q","candidate")}, ensure_ascii=False))


if __name__ == "__main__":
    run()
