import unittest
from structure_rl import motifs, verify


class MountStructureTest(unittest.TestCase):
    def test_same_pin_fixture_changes_verdict_with_travel_and_bearing_requirement(self):
        task = {"pitchMm":23, "pinCount":2, "travelMm":6, "minSeatFraction":0.65}
        self.assertTrue(motifs()["twin_slots"])
        slot = verify(task, "twin_slots")
        self.assertTrue(slot["passed"])
        hole = verify(task, "four_holes")
        self.assertFalse(hole["checks"]["pinPathClear"])
        self.assertTrue(verify({**task, "travelMm":0}, "four_holes")["passed"])
        self.assertFalse(verify({**task, "minSeatFraction":1}, "twin_slots")["checks"]["clampingFootprint"])
        self.assertFalse(verify({**task,"pinCount":4}, "twin_slots")["passed"])
