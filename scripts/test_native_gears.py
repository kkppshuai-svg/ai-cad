import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


@unittest.skipUnless(importlib.util.find_spec('usd_brep'), 'Requires NVIDIA USD BRep runtime')
class NativeGearTests(unittest.TestCase):
    def test_sampled_external_and_internal_profiles_are_closed_solids(self):
        import usd_brep as b
        from native_gears import gear
        external, evidence = gear({'module':2,'teeth':24,'width':10,'boreDiameter':10})
        self.assertTrue(b.is_manifold_solid(external))
        self.assertEqual(external.material_census()['solid_count'], 1)
        self.assertGreater(b.compute_volume(external, 1e-8), 0)
        self.assertLess(evidence['maxSampledMidpointChordErrorMm'], 0.003)
        internal, _ = gear({'module':2,'teeth':24,'width':10,'internal':True})
        self.assertTrue(b.is_manifold_solid(internal))
        self.assertEqual(internal.material_census()['solid_count'], 1)
        # A tooth cavity must create many faces; a plain annulus has only four.
        self.assertGreater(internal.face_count(), 24*4)

    def test_invalid_gears_fail_before_kernel_operations(self):
        from native_gears import gear
        for updates in ({'teeth':24.5},{'teeth':0},{'module':-1},{'width':0},{'backlash':3},{'boreDiameter':1000}):
            with self.assertRaises(ValueError):
                gear({'module':2,'teeth':24,'width':10,**updates})

    def test_assembly_export_keeps_two_separate_bodies(self):
        from usd_brep_assembly import build_assembly
        parts = [{'id':str(i),'featureTree':[{'id':'base','type':'base_box','params':{'size':[10,10,10]}}],
                  'pose':{'translate':[i*20,0,0]}} for i in range(2)]
        with tempfile.TemporaryDirectory() as directory:
            report = build_assembly({'parts':parts}, directory)
            self.assertEqual(report['bodyCount'],2)
            self.assertFalse(report['cadqueryUsed'])
            self.assertTrue(report['usdRoundTrip']['valid'])
            self.assertEqual(report['interferenceStatus'],'unverified')

    def test_planetary_fixture_satisfies_three_planet_assembly_condition(self):
        plan=json.loads((Path(__file__).resolve().parents[1]/'public/usd-planetary-5to1.json').read_text(encoding='utf-8'))
        gears=[p['featureTree'][0]['params'] for p in plan['parts'][:5]]
        zs,zp,zr=(gears[i]['teeth'] for i in (0,1,4))
        self.assertEqual(zr,zs+2*zp)
        self.assertEqual(1+zr/zs,5)
        self.assertEqual((zs+zr)%3,0)

    def test_native_rebuild_remeasures_volume_and_reports_unsupported_dimensions(self):
        from usd_brep_assembly import build_assembly
        part = {'id':'box','featureTree':[{'id':'box.base','type':'base_box','params':{'size':[10,10,10]}}],
                'measurements':[{'id':'volume','kind':'volume','target':2000,'tolerance':0.001},
                                {'id':'length','kind':'bbox','axis':'x','target':10}]}
        with tempfile.TemporaryDirectory() as directory:
            report = build_assembly({'parts':[part]}, directory)
            self.assertEqual(report['parts'][0]['measurements'][0]['status'],'fail')
            self.assertEqual(report['parts'][0]['measurements'][0]['measured'],1000)
            self.assertEqual(report['parts'][0]['measurements'][1]['status'],'unverified')
            self.assertEqual(len(report['parts'][0]['issues']),2)


if __name__ == '__main__':
    unittest.main()
