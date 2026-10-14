import copy
import math
import tempfile
import unittest
from pathlib import Path
from brep_review_core import compare_geometry

def box_facts():
    return {"solidCount":1,"volume":1000.,"bbox":[10.,10.,10.],"boundsMin":[0.,0.,0.],
            "boundsMax":[10.,10.,10.],"center":[5.,5.,5.]}

class RoundTripPrecisionTests(unittest.TestCase):
    def test_equal_volume_translation_is_detected(self):
        source=box_facts(); moved=copy.deepcopy(source)
        moved["boundsMin"][0]+=0.1; moved["boundsMax"][0]+=0.1; moved["center"][0]+=0.1
        result=compare_geometry(source,moved)
        self.assertFalse(result["valid"])
        self.assertTrue(any(issue.get("metric")=="center" for issue in result["issues"]))

    def test_nonfinite_missing_and_negative_evidence_fail_closed(self):
        for key,value in (("volume",math.inf),("volume",-1000.),("center",[math.nan,5.,5.]),("solidCount",None)):
            changed=box_facts(); changed[key]=value
            self.assertFalse(compare_geometry(changed,changed)["valid"])
        self.assertFalse(compare_geometry(None,box_facts())["valid"])

    def test_tolerance_is_unit_aware_and_does_not_grow_with_world_position(self):
        source=box_facts(); restored=copy.deepcopy(source); restored["volume"]+=0.00001
        self.assertTrue(compare_geometry(source,restored)["valid"])
        for key in ("boundsMin","boundsMax","center"):
            source[key][0]+=1e8; restored[key][0]+=1e8
        restored["center"][0]+=0.01
        self.assertFalse(compare_geometry(source,restored)["valid"])

class OcctAuditTests(unittest.TestCase):
    def test_step_reimport_detects_original_reference_translation(self):
        import cadquery as cq
        from cadquery_build import shape_facts,step_roundtrip_check
        shape=cq.Workplane("XY").box(10,10,10)
        reference=shape_facts(shape)
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/"moved.step"
            cq.exporters.export(shape.translate((1,0,0)),str(file))
            self.assertFalse(step_roundtrip_check(str(file),"moved",reference)["valid"])

    def test_sweep_prunes_separated_parts_and_keeps_true_interference(self):
        import cadquery as cq
        from cadquery_build import compute_interferences
        parts=[{"id":str(i),"shape":cq.Workplane("XY").box(2,2,2).translate((i*10,0,0))} for i in range(30)]
        stats={}; self.assertEqual(compute_interferences(parts,statistics=stats),[])
        self.assertEqual(stats["totalPairs"],435); self.assertEqual(stats["booleanChecks"],0)
        parts.append({"id":"overlap","shape":cq.Workplane("XY").box(2,2,2).translate((0.5,0,0))})
        result=compute_interferences(parts,statistics=stats)
        self.assertEqual(len(result),1); self.assertAlmostEqual(result[0]["volume"],6.)
        self.assertEqual(stats["booleanChecks"],1)

    def test_audit_bounds_ignore_display_tessellation(self):
        import cadquery as cq
        from cadquery_build import shape_facts
        plate=cq.Workplane("XY").box(40,30,6).faces(">Z").workplane().hole(8)
        compound=cq.Compound.makeCompound([plate.val()])
        workplane=cq.Workplane("XY").newObject([compound])
        before=shape_facts(workplane)
        compound.tessellate(0.1)
        after=shape_facts(workplane)
        self.assertTrue(compare_geometry(before,after)["valid"])
        self.assertAlmostEqual(after["bbox"][2],6.,places=5)

if __name__=="__main__": unittest.main()
