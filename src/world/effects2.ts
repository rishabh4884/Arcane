import * as THREE from 'three';
import type { SpellEffect } from '../config/spells.ts';
import { HOLLOW_STAG } from './characters/bosses.ts';
import { animate, facingPlane, type SpellAnimation, type SpellContext } from './effects.ts';
import { tube } from './rig/Body.ts';
import { Character } from './rig/Character.ts';
import { terrainHeight } from './spatial.ts';
import { blackthornWake } from './fx/blackthorn.ts';
import { emberLash as stagedEmberLash } from './fx/emberLash.ts';
import { screech } from './fx/screech.ts';
import { thornsnare } from './fx/thornsnare.ts';
import { tidecaller } from './fx/tidecaller.ts';
import { wispSwarm } from './fx/wisps.ts';
import { Trail, WHITE, clamp01, easeOutBack, easeOutCubic, glowSprite, ringTexture } from './vfx.ts';

/**
 * THE NEWER SPELLS
 * ────────────────
 * Ember Lash, Thornsnare, Blackthorn Wake, Wisp Swarm and Sunflare, and the legendary spells taken
 * from the bosses. Multi-target spells receive the points and delays the Encounter resolved, so
 * each visible impact lands on the beat the damage does.
 */

const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();

function impactBurst(ctx: SpellContext, at: THREE.Vector3, color: THREE.Color, force = 1): void {
  ctx.particles?.burst(at, Math.round(20 * force), { speed: 3.5 * force, color: color.clone().lerp(WHITE, 0.4), size: 0.06, ttl: 0.6, gravity: 5, drag: 1.2, style: 'spark' });
  ctx.particles?.burst(at, Math.round(12 * force), { speed: 1.6 * force, color, size: 0.2 * force, sizeEnd: 0.02, ttl: 0.6, drag: 2.2, style: 'glow' });
  ctx.light?.(at, color, 7 * force, 0.4, 8);
}

/* Ember Lash, Thornsnare, Blackthorn Wake, Wisp Swarm, Tidecaller and Screech of Pain are staged in fx/. */

/* ─────────────────────────────── LANE SPELLS ─────────────────────────────── */

function laneOf(ctx: SpellContext, target: THREE.Vector3): { from: THREE.Vector3; dir: THREE.Vector3; length: number } {
  const from = ctx.lane?.from.clone() ?? (ctx.cameraPosition ?? new THREE.Vector3()).clone();
  const to = ctx.lane?.to.clone() ?? target.clone();
  const dir = to.clone().sub(from).setY(0);
  const length = Math.max(4, dir.length());
  return { from, dir: dir.normalize(), length };
}

function earthshatter(target: THREE.Vector3, color: THREE.Color, ctx: SpellContext): SpellAnimation {
  const group = new THREE.Group();
  const { from, dir, length } = laneOf(ctx, target);
  const reach = Math.min(length, 45);
  const rock = new THREE.MeshStandardMaterial({ color: '#5e5446', roughness: 0.95, flatShading: true, emissive: '#2a1206' });
  const shards: Array<{ mesh: THREE.Mesh; at: number; base: number }> = [];
  for (let d = 2; d < reach; d += 0.9) {
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.TetrahedronGeometry(0.35 + Math.random() * 0.35, 0), rock);
      const p = from.clone().addScaledVector(dir, d).add(new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(s * (0.5 + Math.random() * 0.6)));
      p.y = terrainHeight(p.x, p.z) - 0.6;
      m.position.copy(p);
      m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      group.add(m);
      shards.push({ mesh: m, at: d / 22, base: p.y });
    }
  }
  // A glowing seam that runs ahead of the shards.
  const seamGeometry = new THREE.PlaneGeometry(reach, 0.5, 40, 1);
  seamGeometry.translate(reach / 2, 0, 0);
  const seam = new THREE.Mesh(seamGeometry, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uFront: { value: 0 }, uFade: { value: 1 }, uColor: { value: color.clone() } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uFront; uniform float uFade; uniform vec3 uColor; varying vec2 vUv;
      void main(){ if (vUv.x > uFront) discard; float e = 1.0 - abs(vUv.y * 2.0 - 1.0); float jag = 0.5 + 0.5 * sin(vUv.x * 140.0) * sin(vUv.x * 37.0);
        gl_FragColor = vec4(uColor * 1.8 + vec3(0.4, 0.2, 0.0), pow(e, 2.0 + jag * 2.0) * uFade); }`,
  }));
  seam.rotation.x = -Math.PI / 2;
  seam.rotation.z = Math.atan2(-dir.z, dir.x);
  seam.position.copy(from).setY(terrainHeight(from.x, from.z) + 0.08);
  group.add(seam);
  const life = reach / 22 + 1.6;
  return animate(group, life, (_t, age) => {
    const front = Math.min(1, (age * 22) / reach);
    (seam.material as THREE.ShaderMaterial).uniforms.uFront.value = front;
    (seam.material as THREE.ShaderMaterial).uniforms.uFade.value = clamp01(1 - (age - life + 0.8) / 0.8);
    for (const s of shards) {
      const k = age - s.at;
      const rise = k < 0 ? 0 : easeOutBack(clamp01(k / 0.25)) * (1 - clamp01((k - 0.9) / 0.6));
      s.mesh.position.y = s.base + rise * 1.1;
      if (k > 0 && k < 0.03) {
        ctx.particles?.burst(s.mesh.position.clone().setY(s.base + 0.6), 6, { speed: 3, direction: UP, spread: 1, color: new THREE.Color('#7a6a54'), size: 0.06, ttl: 0.7, gravity: 9, style: 'spark' });
        ctx.mist?.emit({ x: s.mesh.position.x, y: s.base + 0.7, z: s.mesh.position.z, vx: 0, vy: 0.6, vz: 0, color: new THREE.Color('#5d5040'), size: 0.9, sizeEnd: 2, alpha: 0.3, ttl: 1.2, drag: 1.5, style: 'mist' });
      }
    }
    if (age < reach / 22) ctx.screen?.shake(0.04);
  }, 0.18, () => { ctx.screen?.shake(0.35); ctx.screen?.flash('#d79a5b', 0.18); }, () => rock.dispose());
}

function spiritStag(target: THREE.Vector3, color: THREE.Color, ctx: SpellContext): SpellAnimation {
  const group = new THREE.Group();
  const { from, dir, length } = laneOf(ctx, target);
  const reach = Math.min(length, 48);
  // The freed Hollow Stag, made of light, gallops down your aim.
  const stag = new Character(HOLLOW_STAG, 0.5);
  stag.u.uExposure.value = 2.6;
  stag.u.uFlashColor.value.set('#e8f4ff');
  stag.u.uEyeColor.value.set('#ffffff');
  stag.u.uMist.value = 0;
  group.add(stag.group);
  const yaw = Math.atan2(dir.x, dir.z);
  stag.setYaw(yaw);
  const velocity = dir.clone().multiplyScalar(18);
  const look = (ctx.cameraPosition ?? new THREE.Vector3()).clone();
  const start = from.clone().addScaledVector(new THREE.Vector3(-dir.z, 0, dir.x), ctx.hand === 'left' ? -1.6 : 1.6).addScaledVector(dir, -1);
  const travel = reach / 18;
  const trail = new Trail(color, 1.2, 0.6, 40, 1);
  group.add(trail.mesh);
  let hitIndex = 0;
  stag.awaken(0.35);
  return animate(group, travel + 1.0, (_t, age, dt) => {
    const d = Math.min(age, travel) * 18;
    const p = stag.group.position.copy(start).addScaledVector(dir, d);
    p.y = terrainHeight(p.x, p.z);
    stag.update(dt, { pose: 'strike', progress: 0.5, attack: 'charge', velocity: age < travel ? velocity : new THREE.Vector3(), faceYaw: yaw, look, groundY: p.y });
    stag.overrides.flash = 0.7 + Math.sin(age * 20) * 0.15;
    if (age > travel) stag.overrides.dissolve = clamp01((age - travel) / 0.8);
    trail.push(tmp.copy(p).setY(p.y + 2.2));
    trail.update(dt, ctx.cameraPosition);
    trail.opacity = clamp01(1 - Math.max(0, age - travel) / 0.6);
    if (Math.random() < 0.9) ctx.particles?.emit({ x: p.x + (Math.random() - 0.5), y: p.y + Math.random() * 3, z: p.z + (Math.random() - 0.5), vx: -dir.x * 2, vy: 0.5, vz: -dir.z * 2, color: Math.random() < 0.5 ? color : new THREE.Color('#9fe8ff'), size: 0.1, sizeEnd: 0.01, ttl: 0.8, drag: 1.2, style: 'glow' });
    ctx.illuminate?.(1, tmp.copy(p).setY(p.y + 2), color, 1.4 * clamp01(age / 0.2) * clamp01(1 - Math.max(0, age - travel) / 0.8), 9);
    while (ctx.delays && hitIndex < ctx.delays.length && age >= ctx.delays[hitIndex]) { impactBurst(ctx, ctx.targets![hitIndex], color, 1.3); ctx.screen?.shake(0.12); hitIndex++; }
  }, 0.1, () => ctx.screen?.flash('#f2f7ff', 0.2), () => { trail.dispose(); stag.dispose(); });
}

/* ─────────────────────────────── AROUND THE CASTER ─────────────────────────────── */

function sunflare(origin: THREE.Vector3, color: THREE.Color, ctx: SpellContext): SpellAnimation {
  const group = new THREE.Group();
  group.name = 'Sunflare';
  const at = origin.clone();
  const bloom = glowSprite(color.clone().lerp(WHITE, 0.75), 0.1, undefined, 0);
  bloom.position.copy(at);
  group.add(bloom);
  return animate(group, 1.6, (_t, age) => {
    const gather = clamp01(age / 0.25);
    const fade = clamp01((age - 0.25) / 1.35);
    bloom.scale.setScalar(0.2 + gather * 0.5 + easeOutCubic(fade) * 16);
    bloom.material.opacity = gather * (1 - fade) ** 2;
    ctx.illuminate?.(0, at, color, 5 * gather * (1 - fade) ** 2, 42);
  }, 0.25, () => {
    ctx.screen?.flash('#fff5d5', 0.75);
    ctx.light?.(at, color, 26, 1.15, 45);
    ctx.particles?.burst(at, 30, { speed: 4.5, color, size: 0.1, sizeEnd: 0.018, ttl: 1.05, drag: 0.75, style: 'glow' });
  });
}

function moonveil(origin: THREE.Vector3, color: THREE.Color, ctx: SpellContext): SpellAnimation {
  const group = new THREE.Group();
  const cam = (ctx.cameraPosition ?? origin).clone();
  const shell = new THREE.Mesh(new THREE.SphereGeometry(2.6, 40, 24), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
    uniforms: { uColor: { value: color.clone() }, uAlpha: { value: 0 }, uTime: { value: 0 } },
    vertexShader: 'varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(normal); vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uColor; uniform float uAlpha; uniform float uTime; varying vec3 vN; varying vec3 vP;
      void main(){ float bands = 0.5 + 0.5 * sin(vP.y * 9.0 + uTime * 1.5 + sin(vP.x * 4.0 + uTime) * 1.5);
        float edge = 1.0 - abs(vN.z);
        gl_FragColor = vec4(uColor * 1.2, (0.05 + 0.18 * bands * edge) * uAlpha); }`,
  }));
  shell.position.copy(cam);
  group.add(shell);
  const life = 7;
  return animate(group, life, (_t, age) => {
    const on = clamp01(age / 0.4) * clamp01((life - age) / 0.8);
    const m = shell.material as THREE.ShaderMaterial;
    m.uniforms.uAlpha.value = on;
    m.uniforms.uTime.value = age;
    if (Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2, y = (Math.random() - 0.3) * 2;
      const p = cam.clone().add(new THREE.Vector3(Math.cos(a) * 2.4, y, Math.sin(a) * 2.4));
      ctx.particles?.emit({ x: p.x, y: p.y, z: p.z, vx: -Math.sin(a) * 0.4, vy: 0.15, vz: Math.cos(a) * 0.4, color, size: 0.05, sizeEnd: 0.01, ttl: 1.6, drag: 0.5, style: 'glow' });
    }
  }, 0.1, () => ctx.screen?.flash('#cbb8ff', 0.25));
}

function verdantBloom(origin: THREE.Vector3, color: THREE.Color, ctx: SpellContext): SpellAnimation {
  const group = new THREE.Group();
  const cam = (ctx.cameraPosition ?? origin).clone();
  const ground = cam.clone().setY(terrainHeight(cam.x, cam.z));
  // Flowers open across the ground in front of the caster.
  const petal = new THREE.MeshBasicMaterial({ color: '#ffd6f0', transparent: true });
  const petal2 = new THREE.MeshBasicMaterial({ color: '#fff3a8', transparent: true });
  const stem = new THREE.MeshBasicMaterial({ color: '#5f9a4a', transparent: true });
  const flowers: Array<{ g: THREE.Group; at: number }> = [];
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ctx.cameraQuaternion).setY(0).normalize();
  for (let i = 0; i < 40; i++) {
    const g = new THREE.Group();
    const d = 1.5 + Math.random() * 9, a = (Math.random() - 0.5) * 1.6;
    const p = ground.clone().addScaledVector(forward.clone().applyAxisAngle(UP, a), d);
    p.y = terrainHeight(p.x, p.z);
    g.position.copy(p);
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.3, 4), stem); s.position.y = 0.15; g.add(s);
    const mat = i % 3 ? petal : petal2;
    for (let k = 0; k < 5; k++) {
      const leaf = new THREE.Mesh(new THREE.CircleGeometry(0.05, 6), mat);
      leaf.position.set(Math.cos(k * 1.256) * 0.05, 0.31, Math.sin(k * 1.256) * 0.05);
      leaf.rotation.x = -Math.PI / 2 + 0.5;
      leaf.rotation.z = k * 1.256;
      g.add(leaf);
    }
    g.scale.setScalar(0.001);
    group.add(g);
    flowers.push({ g, at: 0.2 + d * 0.08 });
  }
  const ring = facingPlane(ringTexture(), color, 1, undefined);
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(ground).setY(ground.y + 0.1);
  group.add(ring);
  return animate(group, 4.5, (_t, age) => {
    for (const f of flowers) f.g.scale.setScalar(Math.max(0.001, easeOutBack(clamp01((age - f.at) / 0.5)) * clamp01((4.5 - age) / 0.8) * 2.2));
    ring.scale.setScalar(1 + easeOutCubic(clamp01(age / 1.2)) * 14);
    ring.material.opacity = clamp01(1 - age / 1.2) * 0.7;
    if (Math.random() < 0.8) {
      const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 2;
      ctx.particles?.emit({ x: cam.x + Math.cos(a) * r, y: ground.y + 0.2, z: cam.z + Math.sin(a) * r - 1.5, vx: 0, vy: 1 + Math.random(), vz: 0, color: Math.random() < 0.5 ? color : new THREE.Color('#ffd6f0'), size: 0.07, sizeEnd: 0.01, ttl: 1.6, drag: 0.6, style: 'glow' });
    }
  }, 0.3, () => ctx.screen?.flash('#bfffb0', 0.25), () => { petal.dispose(); petal2.dispose(); stem.dispose(); });
}

function stillness(color: THREE.Color, ctx: SpellContext): SpellAnimation {
  const group = new THREE.Group();
  const cam = (ctx.cameraPosition ?? new THREE.Vector3()).clone();
  const ground = cam.clone().setY(terrainHeight(cam.x, cam.z) + 0.15);
  const rings = [0, 0.25, 0.5].map(() => {
    const r = facingPlane(ringTexture(), color, 1, undefined);
    r.rotation.x = -Math.PI / 2;
    r.position.copy(ground);
    group.add(r);
    return r;
  });
  return animate(group, 2.4, (_t, age) => {
    rings.forEach((r, i) => {
      const k = clamp01((age - i * 0.25) / 1.8);
      r.scale.setScalar(1 + easeOutCubic(k) * 70);
      r.material.opacity = (1 - k) * 0.6;
    });
  }, 0.1, () => {
    ctx.screen?.flash('#dfe9ec', 0.35);
    ctx.particles?.burst(cam.clone().add(new THREE.Vector3(0, 0, -3).applyQuaternion(ctx.cameraQuaternion)), 60, { speed: 0.3, radius: 5, color, size: 0.05, ttl: 3, drag: 4, style: 'glow' });
  });
}

/** Route a newer spell to its animation. */
export function createSpellAnimation2(kind: SpellEffect, origin: THREE.Vector3, target: THREE.Vector3, color: THREE.Color, ctx: SpellContext): SpellAnimation | null {
  switch (kind) {
    case 'fire': return stagedEmberLash(origin, target, color, ctx);
    case 'roots': return thornsnare(target, color, ctx);
    case 'blade': return blackthornWake(target, color, ctx);
    case 'wisps': return wispSwarm(origin, target, color, ctx);
    case 'flare': return sunflare(origin, color, ctx);
    case 'quake': return earthshatter(target, color, ctx);
    case 'veil': return moonveil(origin, color, ctx);
    case 'tide': return tidecaller(target, color, ctx);
    case 'bloom': return verdantBloom(origin, color, ctx);
    case 'stag': return spiritStag(target, color, ctx);
    case 'screech': return screech(origin, color, ctx);
    case 'stillness': return stillness(color, ctx);
    default: return null;
  }
}
