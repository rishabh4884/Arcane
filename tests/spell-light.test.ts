import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { publishPaintedLights, spellFlashLevel, type PaintedLight } from '../src/world/SpellLight.ts';

describe('spell light on drawn surfaces', () => {
  it('rises promptly, settles and ends exactly with its flash', () => {
    expect(spellFlashLevel(0, 0.4, 10)).toBe(2.5);
    expect(spellFlashLevel(0.025, 0.4, 10)).toBeGreaterThan(7);
    expect(spellFlashLevel(0.3, 0.4, 10)).toBeLessThan(2);
    expect(spellFlashLevel(0.4, 0.4, 10)).toBe(0);
    expect(spellFlashLevel(2, 0.4, 10)).toBe(0);
    expect(spellFlashLevel(0, 0, 10)).toBe(0);
  });
  it('preserves source colour, reach and position and clears expired light', () => {
    const uniforms = {uSpellLights:{value:[new THREE.Vector4(),new THREE.Vector4()]},uSpellColors:{value:[new THREE.Vector4(),new THREE.Vector4()]}};
    const source = (level:number, x:number): PaintedLight => ({position:new THREE.Vector3(x,2,3),color:new THREE.Color('#ffb363'),level,radius:8});
    const a=source(0.3,1), b=source(1.5,4), c=source(0.8,7);
    publishPaintedLights([a,b,c],uniforms);
    expect(uniforms.uSpellLights.value[0].toArray()).toEqual([4,2,3,1.5]);
    expect(uniforms.uSpellLights.value[1].toArray()).toEqual([7,2,3,0.8]);
    expect(uniforms.uSpellColors.value[0].toArray()).toEqual([...b.color.toArray(),8]);
    a.level=0; b.level=0; c.level=0;
    publishPaintedLights([a,b,c],uniforms);
    expect(uniforms.uSpellLights.value.every((u)=>u.w===0)).toBe(true);
  });
  it('keeps simultaneous equal flashes in stable order and rejects invalid sources', () => {
    const uniforms = {uSpellLights:{value:[new THREE.Vector4(),new THREE.Vector4()]},uSpellColors:{value:[new THREE.Vector4(),new THREE.Vector4()]}};
    const sources = [Number.NaN,1,1,Number.POSITIVE_INFINITY].map((level,i)=>({position:new THREE.Vector3(i,0,0),color:new THREE.Color('white'),level,radius:5}));
    publishPaintedLights(sources, uniforms);
    expect(uniforms.uSpellLights.value.map((v)=>v.x)).toEqual([1,2]);
  });
});
