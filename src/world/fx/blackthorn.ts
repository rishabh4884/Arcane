import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { animate, type SpellAnimation, type SpellContext } from '../effects.ts';
import { tube, type V3 } from '../rig/Body.ts';
import { terrainHeight } from '../spatial.ts';
import { clamp01, easeOutCubic, glowSprite, rng } from '../vfx.ts';

/**
 * Blackthorn Wake: the ground tears open down the lane and black thorn erupts from the furrow in
 * clusters, racing ahead on the beat of the damage. Shoots beside a struck creature lunge again and
 * shudder; then the whole hedge draws back into the earth.
 */

const SPEED = 34;
const VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** The torn furrow: a dark groove with turned-up lips of soil, sap smouldering just behind the front. */
function furrowMaterial(color: THREE.Color, length: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uFront: { value: 0 }, uFade: { value: 1 }, uLength: { value: length },
      uSoil: { value: new THREE.Color('#1a130d') }, uLip: { value: new THREE.Color('#4e3d2a') }, uSap: { value: color.clone() },
    },
    vertexShader: VERT,
    fragmentShader: /* glsl */`
      uniform float uFront; uniform float uFade; uniform float uLength;
      uniform vec3 uSoil; uniform vec3 uLip; uniform vec3 uSap; varying vec2 vUv;
      void main() {
        float d = vUv.x * uLength;
        if (d > uFront) discard;
        float y = abs(vUv.y * 2.0 - 1.0);
        float ragged = 0.78 + 0.12 * sin(d * 3.1) + 0.08 * sin(d * 7.7);
        if (y > ragged) discard;
        float groove = 1.0 - smoothstep(0.0, 0.32, y);
        float lip = smoothstep(ragged - 0.3, ragged - 0.08, y) * (1.0 - smoothstep(ragged - 0.08, ragged, y));
        float ember = groove * exp(-(uFront - d) * 0.35) * (0.6 + 0.4 * sin(d * 11.0));
        vec3 col = mix(uSoil, uLip, lip) + uSap * ember * 1.4;
        float alpha = (0.75 * groove + 0.6 * lip + 0.25) * smoothstep(0.0, 1.5, d) * uFade;
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }`,
  });
}

/** Five gnarled thorn shoots, each a tapered hooked spine with side thorns barbed back toward the root. */
function shootGeometries(): THREE.BufferGeometry[] {
  const random = rng(4049);
  const out: THREE.BufferGeometry[] = [];
  for (let v = 0; v < 5; v++) {
    const h = 1.6 + random() * 0.8, lean = (random() - 0.5) * 0.4, hook = 0.45 + random() * 0.35;
    const spine: V3[] = [[0, -0.6, 0], [lean * 0.2, h * 0.35, 0.02], [lean * 0.6, h * 0.72, 0.12], [lean * 0.7, h * 0.95, hook * 0.6], [lean * 0.5, h * 0.9, hook]];
    const parts = [tube(spine, (u) => 0.004 + 0.2 * Math.pow(1 - u, 1.1), { radial: 7, segments: 18, wobble: 0.3, wobbleFrequency: 9, seed: v * 13 + 1 })];
    const curve = new THREE.CatmullRomCurve3(spine.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
    for (let k = 0; k < 4; k++) {
      const u = 0.25 + k * 0.16 + random() * 0.05;
      const c = curve.getPointAt(u), side = k % 2 ? 1 : -1, len = 0.2 + (1 - u) * 0.25;
      parts.push(tube([[c.x, c.y, c.z], [c.x + side * len * 0.7, c.y + len * 0.2, c.z - 0.04], [c.x + side * len, c.y - len * 0.25, c.z - 0.1]], [0.05 * (1.2 - u), 0.02, 0.002], { radial: 5, segments: 6 }));
    }
    out.push(mergeGeometries(parts)!);
    parts.forEach((p) => p.dispose());
  }
  return out;
}

interface Shoot { object: THREE.Group; spine: THREE.Mesh; at: number; height: number; struck: number; seed: number; burst: boolean; splinter: boolean }

export function blackthornWake(target: THREE.Vector3, color: THREE.Color, ctx: SpellContext): SpellAnimation {
  const group = new THREE.Group();
  group.name = 'Blackthorn Wake';
  const from = ctx.lane?.from.clone() ?? (ctx.cameraPosition ?? new THREE.Vector3()).clone();
  const to = ctx.lane?.to.clone() ?? target.clone();
  const dir = to.clone().sub(from).setY(0);
  const reach = Math.min(50, Math.max(4, dir.length()));
  dir.normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x);
  const yaw = Math.atan2(dir.x, dir.z);
  const random = rng(Math.floor(Math.abs(from.x * 37 + from.z * 91 + reach * 7)) + 1);

  // The furrow follows the ground in short pieces so it never floats over a rise.
  const furrow = furrowMaterial(color, reach);
  for (let d = 0; d < reach; d += 5) {
    const len = Math.min(5, reach - d);
    const geometry = new THREE.PlaneGeometry(len, 2.8, 8, 1);
    geometry.rotateX(-Math.PI / 2);
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const uv = geometry.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const along = d + pos.getX(i) + len / 2, across = pos.getZ(i);
      const wx = from.x + dir.x * along + side.x * across, wz = from.z + dir.z * along + side.z * across;
      pos.setXYZ(i, wx, terrainHeight(wx, wz) + 0.05, wz);
      uv.setX(i, along / reach);
    }
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, furrow);
    mesh.renderOrder = 2;
    group.add(mesh);
  }

  const bark = new THREE.MeshStandardMaterial({ color: '#211812', roughness: 0.72, metalness: 0.05, emissive: color.clone().multiplyScalar(0.06) });
  const geometries = shootGeometries();
  const shoots: Shoot[] = [];
  const tips: Array<{ sprite: THREE.Sprite; shoot: Shoot }> = [];
  // The earliest hit landing beside a shoot makes it lunge again.
  const struckAt = (p: THREE.Vector3): number => {
    let at = -1;
    ctx.targets?.forEach((t, i) => {
      const delay = ctx.delays?.[i] ?? -1;
      if (Math.hypot(t.x - p.x, t.z - p.z) < 2.4 && delay >= 0 && (at < 0 || delay < at)) at = delay;
    });
    return at;
  };
  for (let d = 1.4; d <= reach; d += 1.05 + random() * 1.95) {
    const n = 1 + Math.floor(random() * 4);
    for (let k = 0; k < n; k++) {
      const s = (random() - 0.5) * 3.05;
      const along = d + (random() - 0.5) * 1.5;
      const p = from.clone().addScaledVector(dir, along).addScaledVector(side, s);
      p.y = terrainHeight(p.x, p.z);
      const object = new THREE.Group();
      const spine = new THREE.Mesh(geometries[Math.floor(random() * geometries.length)], bark);
      object.add(spine);
      object.position.copy(p);
      // Lean out of the furrow, hooks reaching down the lane.
      object.rotation.set((random() - 0.5) * 0.4, yaw + random() * Math.PI * 2, -s * 0.19 + (random() - 0.5) * 0.32);
      const struck = struckAt(p);
      const height = (0.44 + random() ** 1.45 * 1.12) * (struck >= 0 ? 1.24 : 1);
      object.scale.set(height, 0.001, height);
      object.visible = false;
      group.add(object);
      const shoot: Shoot = { object, spine, at: 0.18 + along / SPEED, height, struck, seed: random() * 6.28, burst: false, splinter: false };
      shoots.push(shoot);
      if (k === 0 && random() < 0.5) {
        const sprite = glowSprite(color, 0.5, undefined, 0);
        group.add(sprite);
        tips.push({ sprite, shoot });
      }
    }
  }

  const soil = new THREE.Color('#5b4733'), splinter = new THREE.Color('#2c2219');
  const hold = 1.05, sink = 0.45;
  const life = 0.18 + reach / SPEED + hold + sink + 0.3;
  const tip = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let hit = 0;
  return animate(group, life, (_t, age) => {
    const front = Math.min(reach, Math.max(0, (age - 0.12) * SPEED));
    furrow.uniforms.uFront.value = front;
    furrow.uniforms.uFade.value = 1 - clamp01((age - (life - 0.5)) / 0.5);
    for (const s of shoots) {
      const local = age - s.at;
      s.object.visible = local >= 0 && local < hold + sink;
      if (!s.object.visible) continue;
      const rise = easeOutCubic(clamp01(local / 0.13));
      const down = easeOutCubic(clamp01((local - hold) / sink));
      // A struck shoot lunges when its creature is hit and keeps shuddering; the rest barely breathe.
      const since = s.struck >= 0 ? age - s.struck : -1;
      const lunge = since >= 0 ? Math.exp(-since * 5) * 0.35 : 0;
      s.object.scale.y = Math.max(0.001, s.height * (rise * (1 - down) + lunge * (1 - down)));
      s.spine.rotation.x = since >= 0 ? Math.sin(age * 38 + s.seed) * Math.exp(-since * 3) * 0.1 : Math.sin(age * 3 + s.seed) * 0.02;
      const p = s.object.position;
      if (!s.burst) {
        s.burst = true;
        ctx.particles?.burst(p.clone().setY(p.y + 0.2), 7, { speed: 3.6, direction: up, spread: 0.9, color: soil, size: 0.07, sizeEnd: 0.02, ttl: 0.8, gravity: 10, drag: 0.4, style: 'spark' });
      }
      if (local > hold && !s.splinter) {
        s.splinter = true;
        ctx.particles?.burst(p.clone().setY(p.y + 0.6 * s.height), 4, { speed: 1.6, color: splinter, size: 0.05, ttl: 0.7, gravity: 7, drag: 0.6, style: 'spark' });
      }
    }
    for (const t of tips) {
      const local = age - t.shoot.at;
      tip.set(0, 1.75, 0.4).multiply(t.shoot.object.scale).applyEuler(t.shoot.object.rotation).add(t.shoot.object.position);
      t.sprite.position.copy(tip);
      t.sprite.material.opacity = local < 0 || !t.shoot.object.visible ? 0 : Math.exp(-local * 3) * 0.9;
    }
    while (ctx.targets && ctx.delays && hit < ctx.delays.length && age >= ctx.delays[hit]) {
      const p = ctx.targets[hit++];
      ctx.particles?.burst(p, 22, { speed: 3.8, color: splinter, size: 0.06, ttl: 0.7, gravity: 8, drag: 0.8, style: 'spark' });
      ctx.particles?.burst(p, 10, { speed: 1.4, color, size: 0.2, sizeEnd: 0.02, ttl: 0.5, drag: 2, style: 'glow' });
      ctx.light?.(p, color, 5, 0.35, 7);
    }
    if (age < 0.18 + reach / SPEED && Math.random() < 0.6) {
      const p = from.clone().addScaledVector(dir, front);
      ctx.mist?.emit({ x: p.x, y: terrainHeight(p.x, p.z) + 0.3, z: p.z, vx: (Math.random() - 0.5) * 2, vy: 0.8, vz: (Math.random() - 0.5) * 2, color: soil, size: 0.8, sizeEnd: 1.8, alpha: 0.3, ttl: 1.1, drag: 1.5, style: 'mist' });
    }
  }, 0.18, () => {
    ctx.screen?.shake(0.12);
  }, () => { bark.dispose(); for (const g of geometries) g.dispose(); });
}
