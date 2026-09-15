import json
import math
import tempfile
import unittest
from pathlib import Path

import cadquery as cq

from cadquery_build import (
    FeatureBuildError,
    build_part,
    build_manifest_part,
    apply_repair_actions,
    assembly_root_name,
    compute_interferences,
    dimension_measurements,
    export_part,
    extrude_tool,
    geometry_validation,
    make_primitive,
    write_feature_trace,
)


class ParametricBuildTests(unittest.TestCase):
    def base_box(self):
        return {"id": "plate.base.01", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [60, 40, 8]}}

    def test_assembly_root_name_avoids_single_part_name_collision(self):
        plan = {
            "name": "doraemon_character",
            "parts": [
                {"id": "doraemon_character"},
                {"id": "doraemon_character_assembly"},
            ],
        }

        root_name = assembly_root_name(plan)
        assembly = cq.Assembly(name=root_name)
        assembly.add(cq.Workplane("XY").box(10, 10, 10), name="doraemon_character")

        self.assertEqual(root_name, "doraemon_character_assembly_2")
        self.assertIn("doraemon_character", assembly.objects)

    def test_centered_cylinder_height_is_total_height_not_each_side(self):
        cylinder = make_primitive({"type": "cylinder", "radius": 10, "height": 8, "center": True})
        bbox = cylinder.val().BoundingBox()

        self.assertAlmostEqual(bbox.zlen, 8, places=6)
        self.assertAlmostEqual(bbox.zmin, -4, places=6)
        self.assertAlmostEqual(bbox.zmax, 4, places=6)
        self.assertAlmostEqual(cylinder.val().Volume(), 3.141592653589793 * 10 * 10 * 8, places=5)

    def test_hole_diameter_wins_over_stale_derived_radius_after_parametric_edit(self):
        part = {
            "id": "plate",
            "featureTree": [
                {"id": "plate.base.01", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [20, 20, 4]}},
                {"id": "plate.hole.01", "type": "hole", "enabled": True, "dependsOn": ["plate.base.01"], "params": {"diameter": 6.5, "radius": 2.75, "depth": 10, "axis": "z", "center": [0, 0, 0]}},
            ],
        }

        built = build_part(part)

        circular_wires = [wire for wire in built.faces(">Z").wires().vals() if len(wire.Edges()) == 1]
        self.assertEqual(len(circular_wires), 1)
        self.assertAlmostEqual(circular_wires[0].Length(), math.pi * 6.5, places=5)

    def test_ellipsoid_primitive_has_requested_radii(self):
        ellipsoid = make_primitive({"type": "ellipsoid", "radii": [20, 12, 30]})
        bbox = ellipsoid.val().BoundingBox()

        self.assertTrue(ellipsoid.val().isValid())
        self.assertAlmostEqual(bbox.xlen, 40, places=5)
        self.assertAlmostEqual(bbox.ylen, 24, places=5)
        self.assertAlmostEqual(bbox.zlen, 60, places=5)

    def test_cartoon_ellipsoid_construction_forms_one_connected_character_solid(self):
        features = [
            {"id": "character.base.01", "type": "base_ellipsoid", "enabled": True, "dependsOn": [], "params": {"radii": [36, 30, 45], "pose": {"translate": [0, 0, 48]}}},
            {"id": "character.head.01", "type": "add_primitive", "enabled": True, "dependsOn": ["character.base.01"], "params": {"primitive": {"type": "ellipsoid", "radii": [46, 38, 44], "pose": {"translate": [0, 0, 112]}}}},
            {"id": "character.face.01", "type": "add_primitive", "enabled": True, "dependsOn": ["character.head.01"], "params": {"primitive": {"type": "ellipsoid", "radii": [32, 8, 30], "pose": {"translate": [0, -34, 108]}}}},
            {"id": "character.eye.left", "type": "add_primitive", "enabled": True, "dependsOn": ["character.face.01"], "params": {"primitive": {"type": "ellipsoid", "radii": [8, 4, 11], "pose": {"translate": [-9, -39, 128]}}}},
            {"id": "character.eye.right", "type": "add_primitive", "enabled": True, "dependsOn": ["character.face.01"], "params": {"primitive": {"type": "ellipsoid", "radii": [8, 4, 11], "pose": {"translate": [9, -39, 128]}}}},
            {"id": "character.nose.01", "type": "add_primitive", "enabled": True, "dependsOn": ["character.face.01"], "params": {"primitive": {"type": "sphere", "radius": 6, "pose": {"translate": [0, -39, 111]}}}},
            {"id": "character.arm.left", "type": "add_primitive", "enabled": True, "dependsOn": ["character.base.01"], "params": {"primitive": {"type": "ellipsoid", "radii": [16, 12, 25], "pose": {"translate": [-32, 0, 55]}}}},
            {"id": "character.arm.right", "type": "add_primitive", "enabled": True, "dependsOn": ["character.base.01"], "params": {"primitive": {"type": "ellipsoid", "radii": [16, 12, 25], "pose": {"translate": [32, 0, 55]}}}},
            {"id": "character.foot.left", "type": "add_primitive", "enabled": True, "dependsOn": ["character.base.01"], "params": {"primitive": {"type": "ellipsoid", "radii": [21, 18, 10], "pose": {"translate": [-17, -3, 7]}}}},
            {"id": "character.foot.right", "type": "add_primitive", "enabled": True, "dependsOn": ["character.base.01"], "params": {"primitive": {"type": "ellipsoid", "radii": [21, 18, 10], "pose": {"translate": [17, -3, 7]}}}},
        ]

        built = build_part({"id": "character", "featureTree": features})
        bbox = built.val().BoundingBox()

        self.assertTrue(built.val().isValid())
        self.assertEqual(len(built.solids().vals()), 1)
        self.assertGreater(bbox.zlen, 150)
        self.assertGreater(bbox.xlen, 95)

    def test_native_spur_gear_is_one_solid_with_requested_width_and_bore(self):
        gear = make_primitive({"type": "spur_gear", "module": 10, "teeth": 17, "width": 20, "boreRadius": 5})
        bbox = gear.val().BoundingBox()

        self.assertEqual(len(gear.solids().vals()), 1)
        self.assertAlmostEqual(bbox.zlen, 20, places=6)
        self.assertGreaterEqual(bbox.xlen, 188.9)
        self.assertEqual(len(gear.faces("<Z").wires().vals()), 2)

    def test_native_spur_gear_pair_has_no_interference_at_standard_center_distance(self):
        left = make_primitive({"type": "spur_gear", "module": 10, "teeth": 17, "width": 20, "boreRadius": 5})
        right = make_primitive({"type": "spur_gear", "module": 10, "teeth": 20, "width": 20, "boreRadius": 5})
        right = right.rotate((0, 0, 0), (0, 0, 1), 9).translate((185, 0, 0))

        report = compute_interferences([{"id": "left", "shape": left}, {"id": "right", "shape": right}])

        self.assertEqual(report, [])

    def test_geometry_validation_measures_explicit_brep_dimensions(self):
        part = {
            "id": "shaft",
            "featureTree": [
                {"id": "shaft.base.01", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [30, 20, 160]}},
            ],
            "measurements": [
                {"id": "shaft.length", "label": "总长", "kind": "bbox", "axis": "z", "target": 160, "tolerance": 0.01},
                {"id": "shaft.width", "label": "宽度", "kind": "feature_bbox", "featureId": "shaft.base.01", "axis": "x", "target": 30, "tolerance": 0.01},
            ],
        }
        trace = []
        built = build_part(part, trace=trace)
        report = geometry_validation("shaft", built, trace=trace, part=part)

        self.assertEqual(report["blockingErrorCount"], 0)
        self.assertTrue(all(item["status"] == "pass" for item in report["measurements"]))
        self.assertAlmostEqual(report["measurements"][0]["measured"], 160, places=6)
        self.assertAlmostEqual(report["measurements"][1]["measured"], 30, places=6)

    def test_hole_feature_bbox_diameter_uses_cylindrical_brep_face(self):
        part = {
            "id": "die",
            "featureTree": [
                {"id": "die.base", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [10, 10, 10]}},
                {"id": "die.pip", "type": "hole", "enabled": True, "dependsOn": ["die.base"], "params": {"diameter": 1.2, "depth": 0.8, "axis": "z", "center": [0, 0, 5]}},
            ],
            "measurements": [
                {"id": "die.pip_diameter", "label": "点孔直径", "kind": "feature_bbox", "featureId": "die.pip", "axis": "x", "target": 1.2, "tolerance": 0.05},
            ],
        }
        trace = []
        built = build_part(part, trace=trace)
        report = geometry_validation("die", built, trace=trace, part=part)

        self.assertEqual(report["blockingErrorCount"], 0)
        self.assertEqual(report["measurements"][0]["kind"], "cylinder_diameter")
        self.assertAlmostEqual(report["measurements"][0]["measured"], 1.2, places=5)

    def test_geometry_validation_blocks_brep_dimension_mismatch(self):
        part = {
            "id": "shaft",
            "featureTree": [
                {"id": "shaft.base.01", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [30, 20, 160]}},
            ],
            "measurements": [
                {"id": "shaft.length", "label": "总长", "kind": "bbox", "axis": "z", "target": 150, "tolerance": 0.01},
            ],
        }
        trace = []
        built = build_part(part, trace=trace)
        report = geometry_validation("shaft", built, trace=trace, part=part)

        self.assertEqual(report["blockingErrorCount"], 1)
        self.assertEqual(report["issues"][0]["code"], "DIMENSION_MISMATCH")

    def test_geometry_validation_blocks_disconnected_shape_when_single_solid_is_required(self):
        part = {
            "id": "integrated_bracket",
            "requireSingleSolid": True,
            "featureTree": [
                {"id": "integrated_bracket.base.01", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [20, 20, 4]}},
                {"id": "integrated_bracket.add_primitive.01", "type": "add_primitive", "enabled": True, "dependsOn": ["integrated_bracket.base.01"], "params": {"primitive": {"type": "box", "size": [4, 4, 4], "pose": {"translate": [20, 0, 0]}}}},
            ],
        }
        built = build_part(part)
        report = geometry_validation("integrated_bracket", built, part=part)

        self.assertEqual(report["facts"]["solidCount"], 2)
        self.assertEqual(report["blockingErrorCount"], 1)
        self.assertEqual(report["issues"][0]["code"], "MULTIPLE_SOLIDS")

    def test_legacy_dimension_nodes_are_inferred_only_for_supported_brep_semantics(self):
        part = {
            "id": "shaft",
            "featureTree": [
                {"id": "shaft.base.01", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [30, 20, 160]}},
                {"id": "shaft.dimension.01", "type": "dimension", "enabled": True, "dependsOn": [], "params": {"name": "overallLength", "value": 160}},
                {"id": "shaft.dimension.02", "type": "dimension", "enabled": True, "dependsOn": [], "params": {"name": "pressureAngle", "value": 20}},
            ],
        }
        trace = []
        built = build_part(part, trace=trace)
        report = geometry_validation("shaft", built, trace=trace, part=part)

        self.assertEqual(report["blockingErrorCount"], 0)
        self.assertEqual(report["measurements"][0]["status"], "pass")
        self.assertEqual(report["unverifiedDimensions"][0]["name"], "pressureAngle")

    def test_rectangular_keyway_dimensions_are_measured_from_brep_faces(self):
        part = {
            "id": "shaft",
            "featureTree": [
                {"id": "shaft.base.01", "type": "base_cylinder", "enabled": True, "dependsOn": [], "params": {"radius": 15, "height": 65, "center": True}},
                {"id": "shaft.keyway.01", "type": "cut_box", "enabled": True, "dependsOn": ["shaft.base.01"], "params": {"size": [8, 3.3, 25], "center": [0, 13.35, 0], "axis": "z"}},
                {"id": "shaft.dimension.width", "type": "dimension", "enabled": True, "dependsOn": ["shaft.keyway.01"], "params": {"name": "keywayWidth", "value": 8}},
                {"id": "shaft.dimension.depth", "type": "dimension", "enabled": True, "dependsOn": ["shaft.keyway.01"], "params": {"name": "keywayDepth", "value": 3.3}},
                {"id": "shaft.dimension.length", "type": "dimension", "enabled": True, "dependsOn": ["shaft.keyway.01"], "params": {"name": "keywayLength", "value": 25}},
            ],
        }
        trace = []
        built = build_part(part, trace=trace)
        report = geometry_validation("shaft", built, trace=trace, part=part)

        measured = {item["name"]: item for item in report["measurements"]}
        self.assertEqual(report["blockingErrorCount"], 0)
        self.assertAlmostEqual(measured["keywayWidth"]["measured"], 8, places=6)
        self.assertAlmostEqual(measured["keywayDepth"]["measured"], 3.3, places=6)
        self.assertAlmostEqual(measured["keywayLength"]["measured"], 25, places=6)
        self.assertTrue(all(measured[name]["source"] == "keyway-brep" for name in measured))

    def test_rectangular_keyway_measurement_works_after_step_round_trip(self):
        part = {
            "id": "shaft",
            "featureTree": [
                {"id": "shaft.base.01", "type": "base_cylinder", "enabled": True, "dependsOn": [], "params": {"radius": 15, "height": 65, "center": True}},
                {"id": "shaft.keyway.01", "type": "cut_box", "enabled": True, "dependsOn": ["shaft.base.01"], "params": {"size": [8, 3.3, 25], "center": [0, 13.35, 0], "axis": "z"}},
                {"id": "shaft.dimension.width", "type": "dimension", "enabled": True, "dependsOn": ["shaft.keyway.01"], "params": {"name": "keywayWidth", "value": 8}},
                {"id": "shaft.dimension.depth", "type": "dimension", "enabled": True, "dependsOn": ["shaft.keyway.01"], "params": {"name": "keywayDepth", "value": 3.3}},
                {"id": "shaft.dimension.length", "type": "dimension", "enabled": True, "dependsOn": ["shaft.keyway.01"], "params": {"name": "keywayLength", "value": 25}},
            ],
        }
        built = build_part(part)
        with tempfile.TemporaryDirectory() as tmp:
            step_path = Path(tmp) / "shaft.step"
            cq.exporters.export(built, str(step_path))
            imported = cq.importers.importStep(str(step_path))
            report = geometry_validation("shaft", imported, trace=[], part=part)

        values = {item["name"]: item["measured"] for item in report["measurements"]}
        self.assertAlmostEqual(values["keywayWidth"], 8, places=6)
        self.assertAlmostEqual(values["keywayDepth"], 3.3, places=6)
        self.assertAlmostEqual(values["keywayLength"], 25, places=6)

    def test_cut_extrude_changes_volume_and_emits_trace(self):
        trace = []
        part = {
            "id": "plate",
            "featureTree": [
                self.base_box(),
                {
                    "id": "plate.cut_extrude.01", "type": "cut_extrude", "enabled": True,
                    "dependsOn": ["plate.base.01"],
                    "params": {"depth": 10, "profile": {"type": "rectangle", "width": 20, "height": 10}, "center": [0, 0, 0]}
                }
            ]
        }
        built = build_part(part, trace=trace)
        self.assertGreater(built.val().Volume(), 0)
        self.assertLess(built.val().Volume(), 60 * 40 * 8)
        self.assertEqual([item["featureId"] for item in trace], ["plate.base.01", "plate.cut_extrude.01"])
        self.assertTrue(all(item["status"] == "passed" for item in trace))

    def test_type_c_rounded_rectangle_uses_world_center_and_wall_normal_axis(self):
        tool = extrude_tool({
            "axis": "y",
            "center": [3, -6, 2],
            "depth": 4,
            "profile": {"type": "rounded_rectangle", "width": 9.2, "height": 3.4, "cornerRadius": 1.0},
        })
        bbox = tool.val().BoundingBox()

        self.assertTrue(tool.val().isValid())
        self.assertAlmostEqual(bbox.xlen, 9.2, places=6)
        self.assertAlmostEqual(bbox.ylen, 4.0, places=6)
        self.assertAlmostEqual(bbox.zlen, 3.4, places=6)
        self.assertAlmostEqual((bbox.xmin + bbox.xmax) / 2, 3.0, places=6)
        self.assertAlmostEqual((bbox.ymin + bbox.ymax) / 2, -6.0, places=6)
        self.assertAlmostEqual((bbox.zmin + bbox.zmax) / 2, 2.0, places=6)

    def test_additional_base_node_is_built_as_an_additive_solid(self):
        trace = []
        part = {
            "id": "bracket",
            "featureTree": [
                {"id": "bracket.base.01", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [20, 20, 2]}},
                {
                    "id": "bracket.base.02", "type": "base_box", "enabled": True,
                    "dependsOn": ["bracket.base.01"],
                    "params": {"size": [20, 2, 20], "pose": {"translate": [0, 9, 9]}}
                }
            ]
        }

        built = build_part(part, trace=trace)

        self.assertTrue(built.val().isValid())
        self.assertGreater(built.val().Volume(), 20 * 20 * 2)
        self.assertEqual([item["featureId"] for item in trace], ["bracket.base.01", "bracket.base.02"])
        self.assertTrue(all(item["status"] == "passed" for item in trace))

    def test_linear_pattern_builds_three_holes(self):
        part = {
            "id": "plate",
            "featureTree": [
                self.base_box(),
                {"id": "plate.hole.01", "type": "hole", "enabled": True, "dependsOn": ["plate.base.01"], "params": {"diameter": 5, "depth": 12, "axis": "z", "center": [-15, 0, 0]}},
                {"id": "plate.linear_pattern.01", "type": "linear_pattern", "enabled": True, "dependsOn": ["plate.hole.01"], "params": {"sourceFeatureId": "plate.hole.01", "count": 3, "spacing": 15, "direction": [1, 0, 0]}}
            ]
        }
        built = build_part(part)
        circular_edges = [edge for edge in built.edges().vals() if edge.geomType() == "CIRCLE"]
        self.assertGreaterEqual(len(circular_edges), 6)

    def test_circular_pattern_builds_six_holes(self):
        part = {
            "id": "disc",
            "featureTree": [
                {"id": "disc.base.01", "type": "base_cylinder", "enabled": True, "dependsOn": [], "params": {"diameter": 60, "height": 8}},
                {"id": "disc.hole.01", "type": "hole", "enabled": True, "dependsOn": ["disc.base.01"], "params": {"diameter": 4, "depth": 12, "axis": "z", "center": [20, 0, 0]}},
                {"id": "disc.circular_pattern.01", "type": "circular_pattern", "enabled": True, "dependsOn": ["disc.hole.01"], "params": {"sourceFeatureId": "disc.hole.01", "count": 6, "angle": 360, "axis": "z", "center": [0, 0, 0]}}
            ]
        }
        built = build_part(part)
        circular_edges = [edge for edge in built.edges().vals() if edge.geomType() == "CIRCLE"]
        self.assertGreaterEqual(len(circular_edges), 12)

    def test_named_fillet_uses_selector_and_unmatched_finish_is_skipped(self):
        valid = {
            "id": "block",
            "featureTree": [
                {"id": "block.base.01", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [20, 20, 20]}},
                {"id": "block.fillet.01", "type": "fillet", "enabled": True, "dependsOn": ["block.base.01"], "params": {"radius": 2}, "selector": {"kind": "axis_position", "axis": "z", "position": 0}}
            ]
        }
        built = build_part(valid)
        self.assertTrue(built.val().isValid())
        self.assertGreater(len(built.faces().vals()), 6)

        invalid = {
            "id": "block",
            "featureTree": [
                {"id": "block.base.01", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [20, 20, 20]}},
                {"id": "block.fillet.01", "type": "fillet", "enabled": True, "dependsOn": ["block.base.01"], "params": {"radius": 2}, "selector": {"kind": "axis_position", "axis": "z", "position": 999}}
            ]
        }
        trace = []
        fallback = build_part(invalid, trace=trace)
        self.assertTrue(fallback.val().isValid())
        self.assertEqual(trace[-1]["featureId"], "block.fillet.01")
        self.assertEqual(trace[-1]["status"], "skipped")
        self.assertIn("selector", trace[-1]["error"].lower())

    def test_semantic_finish_selector_is_compatible_and_failed_finish_is_skipped(self):
        trace = []
        part = {
            "id": "block",
            "featureTree": [
                {"id": "block.base.01", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [20, 20, 4]}},
                {
                    "id": "block.chamfer.01", "type": "chamfer", "enabled": True,
                    "dependsOn": ["block.base.01"], "params": {"distance": 100},
                    "selector": {"kind": "feature", "tags": ["decorative", "outer_edges"]}
                },
                {
                    "id": "block.hole.01", "type": "hole", "enabled": True,
                    "dependsOn": ["block.chamfer.01"],
                    "params": {"diameter": 4, "depth": 10, "axis": "z", "center": [0, 0, 0]}
                }
            ]
        }

        built = build_part(part, trace=trace)
        report = geometry_validation("block", built, trace=trace)

        self.assertTrue(built.val().isValid())
        self.assertEqual([item["status"] for item in trace], ["passed", "skipped", "passed"])
        self.assertEqual(trace[1]["featureId"], "block.chamfer.01")
        self.assertTrue(report["valid"])
        self.assertEqual(report["blockingErrorCount"], 0)
        self.assertTrue(any(
            issue["code"] == "FINISH_FEATURE_SKIPPED" and issue["featureId"] == "block.chamfer.01"
            for issue in report["issues"]
        ))

    def test_failed_node_is_recorded_in_trace(self):
        trace = []
        part = {
            "id": "bad",
            "featureTree": [
                {"id": "bad.base.01", "type": "base_box", "enabled": True, "dependsOn": [], "params": {"size": [10, 10, 10]}},
                {"id": "bad.hole.01", "type": "hole", "enabled": True, "dependsOn": ["bad.base.01"], "params": {"diameter": 0, "depth": 10, "axis": "z", "center": [0, 0, 0]}}
            ]
        }
        with self.assertRaises(FeatureBuildError):
            build_part(part, trace=trace)
        self.assertEqual(trace[-1]["featureId"], "bad.hole.01")
        self.assertEqual(trace[-1]["status"], "failed")

    def test_writes_versioned_feature_trace(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "feature-trace.json"
            write_feature_trace(output, {"plate": [{"featureId": "plate.base.01", "status": "passed"}]})
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["format"], "ai-cad-feature-trace-v1")
            self.assertEqual(payload["parts"]["plate"][0]["featureId"], "plate.base.01")

    def test_geometry_validation_blocks_open_shell_and_accepts_solid(self):
        solid = cq.Workplane("XY").box(10, 10, 10)
        valid = geometry_validation("solid", solid)
        self.assertTrue(valid["valid"])
        self.assertEqual(valid["blockingErrorCount"], 0)

        face = cq.Face.makePlane(10, 10)
        shell = cq.Workplane("XY").newObject([face])
        invalid = geometry_validation("shell", shell)
        self.assertFalse(invalid["valid"])
        self.assertGreater(invalid["blockingErrorCount"], 0)
        self.assertTrue(any(issue["code"] in {"OPEN_SHELL", "NO_SOLID"} for issue in invalid["issues"]))

    def test_geometry_validation_blocks_disconnected_patterned_gear_teeth(self):
        part = {
            "id": "gear",
            "featureTree": [
                {"id": "gear.base.01", "type": "base_cylinder", "params": {"radius": 10, "height": 4}},
                {
                    "id": "gear.tooth.01", "type": "add_primitive",
                    "params": {"primitive": {"type": "box", "size": [2, 3, 4], "pose": {"translate": [12, 0, 0]}}},
                    "selector": {"kind": "feature", "tags": ["gear_tooth", "source"]},
                },
                {"id": "gear.pattern.01", "type": "circular_pattern", "params": {"sourceFeatureId": "gear.tooth.01", "count": 8, "angle": 360}},
            ],
        }
        disconnected = cq.Workplane("XY").cylinder(4, 10).union(
            cq.Workplane("XY").box(2, 3, 4).translate((12, 0, 0))
        )

        report = geometry_validation("gear", disconnected, part=part)

        self.assertFalse(report["valid"])
        self.assertTrue(any(issue["code"] == "DISCONNECTED_GEAR_TEETH" for issue in report["issues"]))

    def test_geometry_validation_accepts_fused_patterned_gear_teeth(self):
        part = {
            "id": "gear",
            "featureTree": [
                {"id": "gear.base.01", "type": "base_cylinder", "params": {"radius": 10, "height": 4}},
                {
                    "id": "gear.tooth.01", "type": "add_primitive",
                    "params": {"primitive": {"type": "box", "size": [4, 3, 4], "pose": {"translate": [9, 0, 0]}}},
                    "selector": {"kind": "feature", "tags": ["gear_tooth", "source"]},
                },
                {"id": "gear.pattern.01", "type": "circular_pattern", "params": {"sourceFeatureId": "gear.tooth.01", "count": 8, "angle": 360}},
            ],
        }
        fused = cq.Workplane("XY").cylinder(4, 10).union(
            cq.Workplane("XY").box(4, 3, 4).translate((9, 0, 0))
        )

        report = geometry_validation("gear", fused, part=part)

        self.assertTrue(report["valid"])
        self.assertEqual(report["facts"]["solidCount"], 1)

    def test_exact_interference_distinguishes_overlap_from_contact(self):
        first = cq.Workplane("XY").box(10, 10, 10)
        overlapping = cq.Workplane("XY").box(10, 10, 10).translate((5, 0, 0))
        touching = cq.Workplane("XY").box(10, 10, 10).translate((10, 0, 0))

        overlap_report = compute_interferences([{"id": "a", "shape": first}, {"id": "b", "shape": overlapping}])
        self.assertEqual(len(overlap_report), 1)
        self.assertGreater(overlap_report[0]["volume"], 0)
        self.assertEqual(overlap_report[0]["partBounds"]["a"]["min"], [-5.0, -5.0, -5.0])
        self.assertEqual(overlap_report[0]["partBounds"]["b"]["max"], [10.0, 5.0, 5.0])
        self.assertEqual(overlap_report[0]["overlapBounds"]["size"], [5.0, 10.0, 10.0])

        touch_report = compute_interferences([{"id": "a", "shape": first}, {"id": "b", "shape": touching}])
        self.assertEqual(touch_report, [])

        intended_overlap = compute_interferences(
            [{"id": "a", "shape": first}, {"id": "b", "shape": overlapping}],
            intended_contacts=[["a", "b"]],
        )
        self.assertEqual(len(intended_overlap), 1)
        self.assertTrue(intended_overlap[0]["intendedContact"])

    def test_feature_tree_executes_in_stable_dependency_order(self):
        trace = []
        part = {
            "id": "plate",
            "featureTree": [
                self.base_box(),
                {"id": "plate.linear_pattern.01", "type": "linear_pattern", "enabled": True, "dependsOn": ["plate.hole.01"], "params": {"sourceFeatureId": "plate.hole.01", "count": 3, "spacing": 15, "direction": [1, 0, 0]}},
                {"id": "plate.hole.01", "type": "hole", "enabled": True, "dependsOn": ["plate.base.01"], "params": {"diameter": 5, "depth": 12, "axis": "z", "center": [-15, 0, 0]}},
            ],
        }
        build_part(part, trace=trace)
        self.assertEqual([item["featureId"] for item in trace], ["plate.base.01", "plate.hole.01", "plate.linear_pattern.01"])

    def test_reuses_cached_step_without_evaluating_feature_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            cached = Path(tmp) / "cached.step"
            cq.exporters.export(cq.Workplane("XY").box(12, 8, 4), str(cached))
            trace = []
            built = build_manifest_part({
                "id": "cached",
                "reuseStepPath": str(cached),
                "featureTree": [{"id": "cached.bad.01", "type": "unsupported", "params": {}}]
            }, trace)
            self.assertAlmostEqual(built.val().Volume(), 12 * 8 * 4, places=5)
            self.assertEqual(trace[0]["status"], "reused")

    def test_cached_local_step_export_preserves_exact_source_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.step"
            output = Path(tmp) / "output.step"
            output_stl = Path(tmp) / "output.stl"
            built = cq.Workplane("XY").box(12, 8, 4)
            cq.exporters.export(built, str(source))

            export_part(built, str(output), str(output_stl), reuse_step_path=str(source))

            self.assertEqual(output.read_bytes(), source.read_bytes())
            self.assertTrue(output_stl.exists())

    def test_clean_and_retry_action_cleans_only_the_target_part(self):
        trace = []
        built = cq.Workplane("XY").box(10, 10, 10)
        repaired = apply_repair_actions(built, "target", [{"type": "clean_and_retry", "partId": "target"}], trace)
        self.assertTrue(repaired.val().isValid())
        self.assertEqual(trace[-1]["status"], "repaired")
        untouched_trace = []
        untouched = apply_repair_actions(built, "other", [{"type": "clean_and_retry", "partId": "target"}], untouched_trace)
        self.assertIs(untouched, built)
        self.assertEqual(untouched_trace, [])


if __name__ == "__main__":
    unittest.main()
