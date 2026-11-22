/** Preserve an editable copy of a procedural character, including its actual skin weights.
 * npx vite-node tools/export-character.ts stag
 * Blender -b --factory-startup -P art/character_source.py -- stag
 * Runtime TypeScript remains the source of truth; the blend is a modeling/posing review source. */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { Body } from '../src/world/rig/Body.ts';
import { DESIGNS } from '../src/world/characters/index.ts';

const kind = process.argv[2] ?? 'stag';
const design = DESIGNS[kind as keyof typeof DESIGNS];
if (!design) throw new Error(`Unknown character: ${kind}`);
const body = new Body(); design.build(body);
const baked = body.bake(); baked.root.updateMatrixWorld(true);
const bones: {name:string; parent:string|null; head:number[]}[] = [];
baked.root.traverse((bone) => {
  if (bone instanceof THREE.Bone) bones.push({name:bone.name,parent:bone.parent?.name ?? null,head:bone.getWorldPosition(new THREE.Vector3()).toArray()});
});
const attributes = Object.fromEntries(Object.entries(baked.geometry.attributes).map(([name,a])=>[name, {size:a.itemSize,data:Array.from(a.array)}]));
mkdirSync('art/build/characters', {recursive:true});
writeFileSync(`art/build/characters/${kind}.json`, JSON.stringify({kind,name:design.name,attributes,index:Array.from(baked.geometry.index!.array),bones,names:baked.names}));
console.log(`${design.name}: ${baked.geometry.attributes.position.count} vertices, ${bones.length} bones`);
