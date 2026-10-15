import importlib.util
import json
from pathlib import Path
import unittest


@unittest.skipUnless(importlib.util.find_spec('usd_brep') and importlib.util.find_spec('shapely'), 'Requires NVIDIA USD BRep and Shapely')
class NativeMotionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from usd_brep_build import build_solid
        cls.plan=json.loads((Path(__file__).resolve().parents[1]/'public/usd-planetary-5to1.json').read_text(encoding='utf-8'))
        cls.bodies=[build_solid(part)[0] for part in cls.plan['parts']]

    def test_native_planetary_mesh_cycle_has_clearance(self):
        from native_motion_review import review_motion
        report=review_motion(self.plan,self.bodies)
        self.assertEqual(report['status'],'pass',report)
        self.assertGreater(report['minimumSampledClearanceMm'],0.05)
        self.assertGreater(report['intervalClearanceLowerEstimateMm'],0)
        self.assertEqual(report['fullCarrierCycleInputDeg'],1800)
        self.assertEqual(report['symmetryRepeats'],96)

    def test_tab_clear_at_start_collides_with_sun_during_motion(self):
        import copy,math
        from usd_brep_build import build_solid
        from native_motion_review import review_motion
        plan=copy.deepcopy(self.plan)
        plan['parts'][-1]['featureTree'].append({'id':'carrier.interfering_tab','type':'add_primitive','dependsOn':['carrier.pin3'],
            'params':{'primitive':{'type':'cylinder','radius':0.4,'height':12,
                'pose':{'translate':[24*math.cos(math.radians(37.5)),24*math.sin(math.radians(37.5)),6]}}}})
        bodies=[body.copy() for body in self.bodies]
        bodies[-1]=build_solid(plan['parts'][-1])[0]
        report=review_motion(plan,bodies,initial_intervals=60,max_intervals=60)
        self.assertEqual(report['status'],'fail',report)
        self.assertGreater(report['collisions'][0]['inputAngleDeg'],0)
        self.assertIn('sun',report['collisions'][0]['parts'])

    def test_sun_end_face_contact_is_not_silently_ignored(self):
        import copy
        from usd_brep_build import build_solid
        from native_motion_review import review_motion
        plan=copy.deepcopy(self.plan)
        plan['parts'][0]['featureTree'][0]['params']['width']=12
        bodies=[body.copy() for body in self.bodies]
        bodies[0]=build_solid(plan['parts'][0])[0]
        report=review_motion(plan,bodies,initial_intervals=10,max_intervals=10)
        self.assertEqual(report['status'],'fail',report)
        self.assertTrue(any(c['kind']=='unintended_surface_contact' and 'carrier' in c['parts'] for c in report['collisions']))

    def test_unsupported_non_symmetric_gear_changes_fail_closed(self):
        import copy
        from native_motion_review import review_motion
        plan=copy.deepcopy(self.plan)
        plan['parts'][0]['featureTree'].append({'id':'sun.cut','type':'cut_box','params':{'size':[1,1,1]}})
        self.assertEqual(review_motion(plan,self.bodies)['status'],'unverified')


if __name__=='__main__':
    unittest.main()
