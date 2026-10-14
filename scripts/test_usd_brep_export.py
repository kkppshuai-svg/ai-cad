from pathlib import Path
import struct
import tempfile
import unittest

from usd_brep_export import check_round_trip, read_stl, stage_units


class StlBridgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.file = Path(self.directory.name) / "mesh.stl"

    def test_binary_with_solid_header_and_ascii_have_same_geometry(self):
        coordinates = (0, 0, 0, 10, 0, 0, 0, 20, 0)
        self.file.write_bytes(b"solid binary".ljust(80, b"\0") + struct.pack("<I", 1)
                              + struct.pack("<12fH", 0, 0, 1, *coordinates, 0))
        binary = read_stl(self.file)
        self.file.write_text("solid test\nfacet normal 0 0 1\nouter loop\n"
                             "vertex 0 0 0\nvertex 10 0 0\nvertex 0 20 0\n"
                             "endloop\nendfacet\nendsolid test\n")
        self.assertEqual(read_stl(self.file), binary)
        self.assertEqual(binary[1], [0, 1, 2])

    def test_empty_truncated_and_nonfinite_inputs_are_rejected(self):
        for text in ("", "solid a\nendsolid a", "solid a\nvertex 0 0 0\nendsolid a",
                     "solid a\nvertex nan 0 0\nvertex 1 0 0\nvertex 0 1 0\nendsolid a"):
            self.file.write_text(text)
            with self.assertRaises((ValueError, UnicodeError)):
                read_stl(self.file)

    def test_round_trip_accepts_reindexing_but_rejects_geometry_or_winding_changes(self):
        points = [(0., 0., 0.), (1., 0., 0.), (0., 1., 0.)]

        class Mesh:
            def __init__(self, vertices, faces):
                self.vertices, self.faces = vertices, faces

            def to_mesh_arrays(self):
                return {"points": self.vertices, "faces": self.faces}

        check_round_trip(Mesh(points[::-1], [3, 2, 1, 0]), points, [0, 1, 2])
        for mesh in (Mesh(points, [3, 0, 2, 1]),
                     Mesh([(0., 0., 0.), (2., 0., 0.), points[2]], [3, 0, 1, 2])):
            with self.assertRaises(RuntimeError):
                check_round_trip(mesh, points, [0, 1, 2])

    def test_units_are_declared_with_or_without_existing_stage_metadata(self):
        for text in ('#usda 1.0\ndef Xform "World" {}',
                     '#usda 1.0\n(\n defaultPrim = "World"\n)\ndef Xform "World" {}'):
            result = stage_units(text)
            self.assertIn("metersPerUnit = 0.001", result)
            self.assertIn('upAxis = "Z"', result)
            self.assertIn('def Xform "World"', result)


if __name__ == "__main__":
    unittest.main()
