"""The shipped woodland must carry surface paint and closed, non-degenerate tree meshes."""
import collections
import json
from pathlib import Path
import struct
import unittest

import numpy as np


class ForestAssets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.blob = (Path(__file__).resolve().parents[2] / 'public/art/sets/edge/proxies.glb').read_bytes()
        length = struct.unpack_from('<I', cls.blob, 12)[0]
        cls.doc = json.loads(cls.blob[20:20 + length])
        cls.base = 28 + length

    def read(self, index):
        a = self.doc['accessors'][index]
        v = self.doc['bufferViews'][a['bufferView']]
        width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
        dtype = {5126: '<f4', 5125: '<u4', 5123: '<u2', 5121: 'u1'}[a['componentType']]
        out = np.frombuffer(self.blob, dtype=dtype, count=a['count'] * width,
                            offset=self.base + v.get('byteOffset', 0) + a.get('byteOffset', 0)).reshape(-1, width)
        if a.get('normalized'):
            out = out.astype(float) / np.iinfo(dtype).max
        return out

    def test_all_pieces_carry_nonwhite_surface_paint(self):
        for mesh in self.doc['meshes']:
            with self.subTest(mesh=mesh['name']):
                p = mesh['primitives'][0]
                col = self.read(p['attributes']['COLOR_0'])
                self.assertTrue(np.isfinite(col).all())
                self.assertLess(col[:, :3].mean(), 0.9)
                self.assertEqual(col.shape[1], 4)

    def test_tree_shells_are_closed_without_duplicate_faces_or_zero_area(self):
        trees = [m for m in self.doc['meshes'] if any(m['name'].startswith(k) for k in ('oak_', 'birch_', 'snag_'))]
        self.assertEqual(len(trees), 12)  # four species, three distances
        for mesh in trees:
            with self.subTest(mesh=mesh['name']):
                p = mesh['primitives'][0]
                vertices = self.read(p['attributes']['POSITION'])
                normals = self.read(p['attributes']['NORMAL'])
                faces = self.read(p['indices']).reshape(-1, 3)
                self.assertTrue(np.isfinite(vertices).all() and np.isfinite(normals).all())
                area = np.linalg.norm(np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]], vertices[faces[:, 2]] - vertices[faces[:, 0]]), axis=1)
                self.assertTrue((area > 1e-10).all())
                # glTF may split vertices at colour/normal seams. Weld exact positions for topology.
                _, vertex_ids = np.unique(vertices, axis=0, return_inverse=True)
                welded = vertex_ids[faces]
                self.assertEqual(len(set(tuple(sorted(t)) for t in welded)), len(faces))
                edges = collections.Counter(tuple(sorted(e)) for t in welded for e in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])))
                self.assertEqual(set(edges.values()), {2})
                self.assertLessEqual(len(faces), 14200)


if __name__ == '__main__':
    unittest.main()
