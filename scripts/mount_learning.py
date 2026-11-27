"""Exercise both mounting motifs, train from 100 distinct tasks and gate the next checkpoint."""
import argparse
import json
import os
from pathlib import Path
from uuid import uuid4

from structure_rl import ROOT, FORMAT, checked, choose, motifs, read_json, state, verify, write_json


def evidence(task, action):
    report = verify(task, action).copy()
    return report.pop("plan"), report


def explore(model, task):
    pitch, count, travel, seat = checked(task)
    actions = sorted(motifs())
    preferred = choose(model["q"], state(count, travel, seat), actions)
    attempts = {}
    best = None
    best_reward = -float("inf")
    for action in [preferred, *(a for a in actions if a != preferred)]:
        plan, report = evidence(task, action)
        attempts[action] = report
        if report["passed"] and report["reward"] > best_reward:
            best, best_reward = (action,plan), report["reward"]
    plan = None
    if best:
        plan = {**best[1],"engineeringVerification":{"requirements":[
            {"id":"mount-interface","kind":"mount_fixture","fixture":task}]}}
    return {"task":task,"preferred":preferred,"attempts":attempts,"action":best[0] if best else None,"plan":plan}


def suite(test=False):
    for i in range(8 if test else 25):
        for j,(count,travel) in enumerate([(2,0),(2,4+i%6),(4,0),(4,4+i%6)]):
            yield {"pitchMm":16+i+(0.75 if test else 0.25),"pinCount":count,
                   "travelMm":travel,"minSeatFraction":[0.60,0.72,0.82,0.92][(i+j)%4]}


def freeze(q, task, reports, actions):
    _,n,t,s = checked(task)
    a = choose(q,state(n,t,s),actions)
    return {"action":a,"passed":reports[a]["passed"],"reward":reports[a]["reward"]}


def train(old, experience):
    from copy import deepcopy
    candidate = deepcopy(old)
    q = candidate["q"]
    actions = sorted(motifs())
    groups, test = [], []
    held_out = list(suite(True))
    def update(task, adjustments=None):
        _,n,t,s = checked(task)
        row = q.setdefault(state(n,t,s), {a:0.0 for a in actions})
        reports = {}
        for a in actions:
            _, report = evidence(task,a)
            target = report["reward"]
            if report["passed"] and adjustments and a in adjustments:
                target += (adjustments[a]-100)/100
            row[a] += 0.2*(target-row[a])
            reports[a] = report
        return reports
    feedback = {}
    seen = {}
    for f in sorted(experience.glob("*.json")):
        event = read_json(f)
        if event.get("type") == "rating":
            feedback[(event.get("assemblyId"),event.get("revision"),event["designDigest"])] = event["score"]
        if "task" in event:
            task = event["task"]
            try:
                checked(task)
            except (TypeError,ValueError,KeyError):
                continue
            if task not in held_out:
                key = json.dumps(task,sort_keys=True)
                seen.setdefault(key,{})
                if event.get("action") in actions and event.get("designDigest") and event.get("decision")=="pass":
                    seen[key][event["action"]] = (event.get("assemblyId"),event.get("revision"),event["designDigest"])
    for key, links in seen.items():
        update(json.loads(key),{a:feedback[d] for a,d in links.items() if d in feedback})
    for task in suite():
        groups.append({"task":task,"attempts":update(task)})
    for task in held_out:
        reports = {a:evidence(task,a)[1] for a in actions}
        test.append({"task":task,"old":freeze(old["q"],task,reports,actions),
                     "new":freeze(q,task,reports,actions),"feasible":any(r["passed"] for r in reports.values())})
    def summary(k):
        return {"passed":sum(r[k]["passed"] for r in test),"totalReward":sum(r[k]["reward"] for r in test)}
    before,after=summary("old"),summary("new")
    promote = (after["passed"]>=before["passed"] and after["totalReward"]>=before["totalReward"] and before!=after
               and all(not r["old"]["passed"] or r["new"]["passed"] for r in test))
    candidate["updates"] += 2*(len(groups)+len(seen))
    report={"trainingGroups":len(groups),"replayedGroups":len(seen),"updates":2*(len(groups)+len(seen)),
            "heldOut":len(test),"before":before,"after":after,"promote":promote,"training":groups,"test":test}
    return candidate, report


def atomic(file, value):
    tmp=file.with_name(f".{file.name}-{uuid4().hex}.tmp")
    write_json(tmp,value)
    os.replace(tmp,file)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=["train","explore"])
    parser.add_argument("--model",type=Path,default=ROOT/"models/mount-active.json")
    parser.add_argument("--input",type=Path)
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--experience",type=Path,default=ROOT/"workspace/rl/experience")
    parser.add_argument("--activate",action="store_true")
    args=parser.parse_args()
    model=read_json(args.model)
    if model["format"]!=FORMAT or model["sources"]!=motifs():
        parser.error("incompatible source catalog or checkpoint")
    if args.command=="explore":
        if not args.input or args.out.resolve() in (args.input.resolve(),args.model.resolve()):
            parser.error("separate input and output files required")
        atomic(args.out,explore(model,read_json(args.input)))
        return
    policy,report=train(model,args.experience)
    atomic(args.out/"candidate.json",policy)
    atomic(args.out/"report.json",report)
    if args.activate and report["promote"]:
        atomic(args.model,policy)
    print(json.dumps({k:v for k,v in report.items() if k not in ("training","test")}))


if __name__=="__main__":
    main()
