"""Import the game's actual procedural mesh, paint and skinning into an editable Blender scene.

First run: npx vite-node tools/export-character.ts stag
Then: Blender -b --factory-startup -P art/character_source.py -- stag
The saved source is for sculpting, paint review and posing; runtime builds still use TypeScript.
"""
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parent.parent
kind = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'stag'
data = json.loads((ROOT / 'art/build/characters' / f'{kind}.json').read_text())
attrs = data['attributes']

def triples(values):
    return [values[i:i + 3] for i in range(0, len(values), 3)]

def xyz(p):
    return Vector((p[0], -p[2], p[1]))  # Three Y-up to Blender Z-up, preserving handedness.

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
mesh = bpy.data.meshes.new(data['name'])
mesh.from_pydata([xyz(p) for p in triples(attrs['position']['data'])], [], triples(data['index']))
mesh.update()
obj = bpy.data.objects.new(data['name'], mesh)
bpy.context.collection.objects.link(obj)
for face in mesh.polygons:
    face.use_smooth = True
paint = mesh.color_attributes.new(name='Paint', type='FLOAT_COLOR', domain='POINT')
paint.data.foreach_set('color', [c for rgb in triples(attrs['color']['data']) for c in (*rgb, 1)])
for attr in ('aSurf', 'aAO', 'aCurv'):
    if attr in attrs and attrs[attr]['size'] == 1:
        channel = mesh.attributes.new(attr, 'FLOAT', 'POINT')
        channel.data.foreach_set('value', attrs[attr]['data'])
mat = bpy.data.materials.new('Painted colour — matte review')
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get('Principled BSDF')
bsdf.inputs['Roughness'].default_value = 1
bsdf.inputs['Specular IOR Level'].default_value = 0
colour = mat.node_tree.nodes.new('ShaderNodeVertexColor')
colour.layer_name = 'Paint'
mat.node_tree.links.new(colour.outputs['Color'], bsdf.inputs['Base Color'])
obj.data.materials.append(mat)

arm = bpy.data.armatures.new('Game skeleton')
rig = bpy.data.objects.new('Pose controls', arm)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
for bone in data['bones']:
    edit = arm.edit_bones.new(bone['name'])
    edit.head = xyz(bone['head'])
    child = next((b for b in data['bones'] if b['parent'] == bone['name']), None)
    tail = xyz(child['head']) if child else edit.head + Vector((0, 0, 0.12))
    edit.tail = tail if (tail - edit.head).length > 0.01 else edit.head + Vector((0, 0, 0.12))
    if bone['parent']:
        edit.parent = arm.edit_bones.get(bone['parent'])
bpy.ops.object.mode_set(mode='OBJECT')
rig.show_in_front = True
groups = [obj.vertex_groups.new(name=name) for name in data['names']]
indices, weights = attrs['skinIndex']['data'], attrs['skinWeight']['data']
for vertex in range(len(mesh.vertices)):
    for slot in range(4):
        k = vertex * 4 + slot
        if weights[k] > 0:
            groups[indices[k]].add([vertex], weights[k], 'REPLACE')
modifier = obj.modifiers.new('Game skin weights', 'ARMATURE')
modifier.object = rig
obj.parent = rig

scene = bpy.context.scene
scene.world.color = (0.18, 0.22, 0.22)
for area in bpy.context.screen.areas:
    if area.type == 'VIEW_3D':
        area.spaces.active.shading.color_type = 'VERTEX'
        area.spaces.active.region_3d.view_distance = 6
        area.spaces.active.region_3d.view_location = (0, 0, 2)
readme = bpy.data.texts.new('READ ME')
readme.write('Editable game mesh, vertex paint and weighted armature.\nRuntime source: src/world/characters/.\nRegenerate with tools/export-character.ts and art/character_source.py.\nBlender edits are not automatically imported into the game.\n')
out = ROOT / 'art/source/characters' / f'{kind}.blend'
out.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out), compress=True)
print(f'Saved editable mesh, paint and rig: {out}')
