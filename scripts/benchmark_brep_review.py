"""Compare the previous nested broad phase and the upgraded audit on equal input."""
import json
import statistics
import time
from pathlib import Path
import cadquery as cq
from cadquery_build import bounding_boxes_overlap, compute_interferences


def previous_algorithm(parts):
    results = []
    for index, left in enumerate(parts):
        for right in parts[index+1:]:
            if not bounding_boxes_overlap(left["shape"].val().BoundingBox(), right["shape"].val().BoundingBox(), 1e-7):
                continue
            intersection=left["shape"].intersect(right["shape"])
            volume=sum(solid.Volume(tol=1e-9) for solid in intersection.solids().vals())
            if volume > 1e-9:
                results.append((tuple(sorted((left["id"],right["id"]))),volume))
    return sorted(results)


def main():
    parts=[{"id":f"part-{i}","shape":cq.Workplane("XY").box(2,2,2).translate((i*10,0,0))} for i in range(40)]
    parts.append({"id":"overlap","shape":cq.Workplane("XY").box(2,2,2).translate((0.5,0,0))})
    baseline_times, upgraded_times=[],[]
    # Warm both paths once; collect matched-input medians, not one cold-start sample.
    previous_algorithm(parts); compute_interferences(parts)
    for _ in range(5):
        start=time.perf_counter(); old=previous_algorithm(parts); baseline_times.append((time.perf_counter()-start)*1000)
        stats={}; start=time.perf_counter(); new=compute_interferences(parts,statistics=stats); upgraded_times.append((time.perf_counter()-start)*1000)
        measured=sorted((tuple(entry["parts"]),entry["volume"]) for entry in new)
        assert old==measured, (old,measured)
    report={"result":"passed","model":"41 sparse parts, one true interference","matchedResults":True,"runs":5,
            "previousMedianMs":statistics.median(baseline_times),"upgradedMedianMs":statistics.median(upgraded_times),
            "statistics":stats,"coverage":"broad-phase/intersection audit only; not a universal CAD benchmark"}
    Path("output").mkdir(exist_ok=True)
    Path("output/review-performance.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
    print(json.dumps(report,indent=2))


if __name__=="__main__":main()
