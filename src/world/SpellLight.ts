import type * as THREE from 'three';
import { SPELL_LIGHTS } from './LanternLighting.ts';

export interface PaintedLight { position: THREE.Vector3; color: THREE.Color; level: number; radius: number }

/** A quick readable onset, then a finite settling tail. Shared by lit meshes and painted surfaces. */
export function spellFlashLevel(age: number, duration: number, peak: number): number {
  if (age < 0 || duration <= 0 || age >= duration || peak <= 0) return 0;
  const u = age / duration;
  return peak * Math.pow(1 - u, 1.6) * Math.min(1, u * 12 + 0.25);
}

/** Publish the strongest live sources without allocating GPU lights or changing shader programs.
 * Stable source order breaks ties; unused slots are explicitly cleared so old flashes cannot stick. */
export function publishPaintedLights(sources: readonly PaintedLight[], uniforms = SPELL_LIGHTS): void {
  const selected: number[] = [];
  for (let slot = 0; slot < uniforms.uSpellLights.value.length; slot++) {
    let best = -1, level = 0.005;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (source.level > level && Number.isFinite(source.level) && source.radius > 0 && !selected.includes(i)) { best = i; level = source.level; }
    }
    if (best < 0) {
      uniforms.uSpellLights.value[slot].set(0, 0, 0, 0);
      uniforms.uSpellColors.value[slot].set(0, 0, 0, 1);
    } else {
      selected.push(best);
      const s = sources[best];
      uniforms.uSpellLights.value[slot].set(s.position.x, s.position.y, s.position.z, Math.min(s.level, 3));
      uniforms.uSpellColors.value[slot].set(s.color.r, s.color.g, s.color.b, s.radius);
    }
  }
}
