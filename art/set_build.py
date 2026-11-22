"""
Lay out a painted set and gather what its painter needs:

    blender -b --factory-startup -P art/set_build.py -- edge [--scale 0.5] [--proxies-only] [--shots | --shot <name>…] [--main]

1. compose the place from art/sets/<set>_layout.json (written by `npx vite-node tools/dump-set.ts`)
2. render its passes through the game camera (setscene.py) into art/build/sets/<set>/ as .npy
3. write public/art/sets/<set>/meta.json (the paint camera) and proxies.glb (the simplified kinds the
   painting is projected onto in the game, and the gate and lanterns where they stand)

then paint it with `python3 art/set_paint.py <set>` (npm run set -- <set> does both).
"""
import importlib
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402

from arcane_art import bl, setscene  # noqa: E402
from arcane_art.pipeline import ROOT  # noqa: E402
from arcane_art.set_artifacts import passes_complete, read_meta, write_json_atomic  # noqa: E402

TREE_KINDS = ['oak_edge_a', 'oak_edge_b', 'birch_edge_a', 'snag_edge_a']
DEPTH_MAX = 400.0


def compose(layout: dict, width: int, height: int) -> dict:
    bl.reset()
    setscene.ground_object(layout)
    makers = {}
    for kind in TREE_KINDS:
        def make(kind=kind):
            sp = importlib.import_module(f'assets.{kind}').spec()
            ob = setscene.sculpt_object(kind, sp, 2.6, sp.paint)
            setscene.tag(ob, 'trunk')
            return ob
        makers[kind] = make

    def make_rock():
        sp = importlib.import_module('assets.rock_edge_a').spec()
        ob = setscene.sculpt_object('rock_edge_a', sp, 2.0, sp.paint)
        setscene.tag(ob, 'rock')
        return ob
    makers['rock_edge_a'] = make_rock
    sources = [os.path.join(HERE, 'assets', f'{k}.py') for k in makers] + [os.path.join(HERE, 'assets', '_trees.py')]
    sources += [os.path.join(HERE, 'arcane_art', f) for f in ('sdf.py', 'paint.py', 'mesh.py')]
    protos = setscene.cached_prototypes(makers, os.path.join(ROOT, 'art', 'build', 'sets', 'prototypes.blend'), sources)
    for ob in protos.values():
        ob.hide_render = True
        ob.hide_viewport = True
    for i, t in enumerate(layout['trees']):
        setscene.place(protos[t['kind']], f"tree-{i}", t['x'], t['y'], t['z'], t['yaw'], t['scale'])
    for i, r in enumerate(layout['rocks']):
        o = setscene.place(protos['rock_edge_a'], f"rock-{i}", r['x'], r['y'], r['z'], r['rotation'][1], r['scale'])
        o.rotation_euler = (r['rotation'][0], -r['rotation'][2], r['rotation'][1])
    statics = []
    for site in layout.get('lanterns', []):
        statics += setscene.lantern_objects(site)
    if 'gate' in layout:
        g = layout['gate']
        statics.append(setscene.gate_object(g['x'], g['y'], g['z'], g['yaw']))
    if 'pool' in layout:
        setscene.pool_object(layout['pool'])
    rig = setscene.lights(layout)
    setscene.world()
    cam = setscene.game_camera(layout, width, height)
    return {'protos': protos, 'statics': statics, 'camera': cam, 'rig': rig}


def export_proxies(path: str, scene: dict) -> None:
    """Surface-painted trees and stones, plus the set's static pieces.

    Their paint belongs to the mesh, including the backs a shot never saw. Keep enough topology for
    branch junctions and crown silhouettes; the old 2600-face unpainted proxies tore the projection.
    """
    objs = []
    for kind, proto in scene['protos'].items():
        proto.name = f'proto-{kind}'          # free the kind's own name for the proxy
        levels = [14000, 4500, 1400] if kind != 'rock_edge_a' else [1800]
        for lod, faces in enumerate(levels):
            name = kind if lod == 0 else f'{kind}-lod{lod}'
            p = bl.duplicate(proto, name)
            assert p.name == name, p.name
            p.hide_render = False; p.hide_viewport = False
            bl.decimate(p, faces)
            # Quadric collapse can leave duplicate triangles at narrow SDF junctions. Remove these
            # before export; they otherwise z-fight and make the bark sparkle through camera motion.
            p.data.validate(clean_customdata=False)
            bm = bmesh.new()
            bm.from_mesh(p.data)
            # Tiny disconnected SDF remnants are floating flakes, not designed bark. A lone
            # triangle cannot be capped without recreating the duplicate we just removed.
            visited = set()
            flakes = []
            for face in bm.faces:
                if face in visited:
                    continue
                stack, component = [face], []
                while stack:
                    f = stack.pop()
                    if f in visited:
                        continue
                    visited.add(f); component.append(f)
                    stack.extend(n for e in f.edges for n in e.link_faces if n not in visited)
                if len(component) <= 8:
                    flakes.extend(component)
            if flakes:
                bmesh.ops.delete(bm, geom=flakes, context='FACES')
            boundary = [e for e in bm.edges if e.is_boundary]
            if boundary:
                bmesh.ops.holes_fill(bm, edges=boundary, sides=16)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(p.data)
            bm.free()
            p.data.update()
            p.location = (0, 0, 0); p.rotation_euler = (0, 0, 0); p.scale = (1, 1, 1)
            objs.append(p)
    for s in scene['statics']:
        p = bl.duplicate(s, f'static-{s.name}')
        objs.append(p)
    material = bpy.data.materials.new('Surface paint carrier')
    material.diffuse_color = (1, 1, 1, 1)
    material.use_nodes = True
    for o in objs:
        colors = bl.get_vertex_colors(o, 'albedo')
        # Leaf membership travels in colour alpha, used as a material selector, never transparency.
        colors[:, 3] = bl.get_vertex_colors(o, 'leaf')[:, 0] if 'leaf' in o.data.color_attributes else 0
        bl.set_vertex_colors(o, 'albedo', colors)
        o.data.color_attributes.active_color = o.data.color_attributes['albedo']
        o.data.color_attributes.render_color_index = o.data.color_attributes.find('albedo')
        o.data.materials.clear()
        o.data.materials.append(material)
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
                              export_materials='EXPORT', export_vertex_color='NAME', export_vertex_color_name='albedo',
                              export_all_vertex_colors=False, export_active_vertex_color_when_no_material=True,
                              export_normals=True, export_texcoords=False)
    # Retain an editable lit stage, not only a transient cache and flattened game export.
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    source = os.path.join(ROOT, 'art', 'source', 'sets', 'edge.blend')
    os.makedirs(os.path.dirname(source), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=source, compress=True)


def render_shot(shot: dict, build: str, public: str, scale: float, moon) -> None:
    """One cutscene shot's passes, through its own camera, at a size that matches its field of view."""
    W, H = int(2560 * scale), int(1280 * scale)
    cam = setscene.paint_camera(shot['position'], shot['lookAt'], shot['fov'], W, H)
    out = os.path.join(build, 'shots', shot['name'])
    # Metadata is the completion marker. Invalidate the old marker before replacing any passes,
    # including an explicit rebuild of a previously completed shot.
    meta_path = os.path.join(out, 'meta.json')
    if os.path.exists(meta_path):
        os.remove(meta_path)
    t = time.time()
    rig = {'moon': bpy.data.objects['moon'], 'lamps': [o for o in bpy.data.objects if o.name.startswith('lamp-')]}
    for path in setscene.render_passes(os.path.join(out, 'exr'), rig, samples=40):
        key = os.path.splitext(os.path.basename(path))[0]
        np.save(os.path.join(out, f'{key}.npy'), setscene.read_exr(path).astype(np.float32 if key in ('position', 'ids') else np.float16))
    meta = {'name': shot['name'], 'script': shot['script'], 'key': shot['key'], 'region': shot.get('region', 'edge'), 'position': shot['position'], 'lookAt': shot['lookAt'],
            'fov': math.degrees(cam.data.angle_y), 'aspect': W / H, 'near': cam.data.clip_start, 'far': cam.data.clip_end,
            'width': W, 'height': H, 'depthMax': DEPTH_MAX, 'moon': moon}
    # Publish the build marker last, after the painter's output directory has its camera metadata.
    for d in (os.path.join(public, 'shots', shot['name']), out):
        write_json_atomic(os.path.join(d, 'meta.json'), meta)
    print(f"[set] shot {shot['name']} in {time.time() - t:.0f}s", flush=True)


def main() -> None:
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    name = next((a for a in argv if not a.startswith('--')), 'edge')
    scale = float(argv[argv.index('--scale') + 1]) if '--scale' in argv else 1.0
    W, H = int(3072 * scale), int(1536 * scale)
    layout = setscene.load(os.path.join(ROOT, 'art', 'sets', f'{name}_layout.json'))
    build = os.path.join(ROOT, 'art', 'build', 'sets', name)
    public = os.path.join(ROOT, 'public', 'art', 'sets', name)
    t0 = time.time()
    scene = compose(layout, W, H)
    if '--shots' in argv or '--shot' in argv:
        wanted = {argv[i + 1] for i, a in enumerate(argv) if a == '--shot'}
        for shot in layout.get('shots', []):
            if wanted and shot['name'] not in wanted:
                continue
            shot_build = os.path.join(build, 'shots', shot['name'])
            if '--missing' in argv and passes_complete(shot_build):
                # Restoring a lost output metadata file does not require another Blender render.
                write_json_atomic(os.path.join(public, 'shots', shot['name'], 'meta.json'), read_meta(shot_build))
                continue
            render_shot(shot, build, public, scale, layout['moon'])
        print(f'[set] {name} shots rendered in {time.time() - t0:.0f}s', flush=True)
        if '--main' not in argv:
            return
        cam = setscene.game_camera(layout, W, H)
        scene['camera'] = cam
    if '--proxies-only' in argv:
        export_proxies(os.path.join(public, 'proxies.glb'), scene)
        print(f'[set] {name} proxies written in {time.time() - t0:.0f}s', flush=True)
        return
    exrs = setscene.render_passes(os.path.join(build, 'exr'), scene['rig'])
    for path in exrs:
        arr = setscene.read_exr(path)
        key = os.path.splitext(os.path.basename(path))[0]
        np.save(os.path.join(build, f'{key}.npy'), arr.astype(np.float32 if key in ('position', 'ids') else np.float16))
    export_proxies(os.path.join(public, 'proxies.glb'), scene)
    cam = scene['camera']
    c = layout['camera']
    pos = np.asarray(c['position'], float)
    meta = {'position': c['position'], 'lookAt': c['lookAt'], 'fov': math.degrees(cam.data.angle_y), 'aspect': W / H,
            'near': cam.data.clip_start, 'far': cam.data.clip_end, 'width': W, 'height': H, 'depthMax': DEPTH_MAX,
            'moon': layout['moon']}
    os.makedirs(public, exist_ok=True)
    with open(os.path.join(public, 'meta.json'), 'w') as f:
        json.dump(meta, f, indent=2)
    with open(os.path.join(build, 'meta.json'), 'w') as f:
        json.dump({**meta, 'layout': os.path.join('art', 'sets', f'{name}_layout.json'), 'camera_position': pos.tolist()}, f, indent=2)
    print(f'[set] {name} laid out and its passes rendered in {time.time() - t0:.0f}s', flush=True)


main()
