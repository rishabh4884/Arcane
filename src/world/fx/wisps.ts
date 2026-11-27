import * as THREE from 'three';
import { animate, type SpellAnimation, type SpellContext } from '../effects.ts';
import { forestLayout, terrainHeight, type TreeSite } from '../spatial.ts';
import { Trail, WHITE, clamp01, easeInOut, glowSprite, rng } from '../vfx.ts';

/**
 * Wisp Swarm: the wood answers. Fireflies wake in the crowns of the nearest trees, blink and drift
 * as a loose cloud, then fall on the hunted one by one, each landing on the beat of its hit.
 */

let trees: TreeSite[] | null = null;

/** The crowns closest to the caster, favouring the ones in view. */
function nearestCrowns(cam: THREE.Vector3, forward: THREE.Vector3, count: number): THREE.Vector3[] {
  trees ??= forestLayout();
  const scored = trees.map((t) => {
    const dx = t.x - cam.x, dz = t.z - cam.z, d = Math.hypot(dx, dz);
    const facing = (dx * forward.x + dz * forward.z) / (d || 1);
    return { t, score: d * (facing > -0.2 ? 1 : 2.5), d };
  }).filter((s) => s.d > 3 && s.d < 45).sort((a, b) => a.score - b.score).slice(0, count);
  if (!scored.length) return [cam.clone().addScaledVector(forward, 8).setY(cam.y + 3)];
  return scored.map(({ t }) => new THREE.Vector3(t.x, terrainHeight(t.x, t.z) + Math.min(t.height * 0.5, 9), t.z));
}

interface Fly {
  head: THREE.Sprite;
  trail: Trail | null;
  start: THREE.Vector3;
  drift: THREE.Vector3;
  to: THREE.Vector3 | null;
  delay: number;
  wake: number;
  seed: number;
  done: boolean;
}

export function wispSwarm(_origin: THREE.Vector3, target: THREE.Vector3, color: THREE.Color, ctx: SpellContext): SpellAnimation {
  const group = new THREE.Group();
  group.name = 'Wisp Swarm';
  const cam = (ctx.cameraPosition ?? new THREE.Vector3(0, 1.8, 10)).clone();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ctx.cameraQuaternion).setY(0).normalize();
  const random = rng(Math.floor(Math.abs(cam.x * 31 + cam.z * 17)) + 3);
  // With nothing to hunt, the swarm still falls on the aimed ground.
  const targets = ctx.targets?.length ? ctx.targets : [0, 1, 2, 3].map((i) => target.clone().add(new THREE.Vector3((i - 1.5) * 1.2, (i % 2) * 0.6, 0)));
  const delays = ctx.targets?.length ? ctx.delays ?? [] : [1.4, 1.55, 1.7, 1.85];
  const crowns = nearestCrowns(cam, forward, 4);

  const body = color.clone().lerp(new THREE.Color('#e9ff9a'), 0.35);
  const flies: Fly[] = [];
  const spawn = (to: THREE.Vector3 | null, delay: number, lead: boolean) => {
    const crown = crowns[Math.floor(random() * crowns.length)];
    const start = crown.clone().add(new THREE.Vector3((random() - 0.5) * 5, (random() - 0.5) * 3, (random() - 0.5) * 5));
    // The cloud drifts a little toward the hunt and down out of the leaves before it falls.
    const toward = (to ?? target).clone().sub(start).setY(0).normalize();
    const drift = toward.multiplyScalar(2 + random() * 2).add(new THREE.Vector3((random() - 0.5) * 2, -1 - random() * 1.5, (random() - 0.5) * 2));
    const head = glowSprite(lead ? body.clone().lerp(WHITE, 0.25) : body, lead ? 0.38 : 0.2 + random() * 0.1, undefined, 0);
    group.add(head);
    let trail: Trail | null = null;
    if (lead) { trail = new Trail(color, 0.07, 0.45, 32, 1); group.add(trail.mesh); }
    flies.push({ head, trail, start, drift, to, delay, wake: random() * 0.5, seed: random() * 6.28, done: false });
  };
  targets.forEach((to, i) => {
    const delay = delays[i] ?? 1.4;
    spawn(to, delay, true);
    spawn(to, delay + 0.06, false);
    spawn(to, delay + 0.12, false);
  });
  // A few that never hunt: they wake, blink, and settle back into the dark.
  for (let i = 0; i < 14; i++) spawn(null, 0, false);

  const p = new THREE.Vector3(), from = new THREE.Vector3(), c1 = new THREE.Vector3(), c2 = new THREE.Vector3();
  const curve = new THREE.CubicBezierCurve3(from, c1, c2, new THREE.Vector3());
  const life = Math.max(2.4, ...flies.map((f) => f.delay)) + 0.7;
  const wander = (f: Fly, age: number, out: THREE.Vector3) => {
    const s = clamp01((age - f.wake) / 1.6);
    out.copy(f.start).addScaledVector(f.drift, easeInOut(s));
    out.x += Math.sin(age * 1.9 + f.seed) * 0.6;
    out.y += Math.sin(age * 2.7 + f.seed * 2) * 0.35;
    out.z += Math.cos(age * 1.6 + f.seed) * 0.6;
    return out;
  };
  return animate(group, life, (_t, age, dt) => {
    for (const f of flies) {
      const blink = 0.55 + 0.45 * Math.sin(age * (7 + f.seed) + f.seed * 3) ** 2;
      const woke = clamp01((age - f.wake) / 0.35);
      if (!f.to) {
        wander(f, age, p);
        f.head.position.copy(p);
        f.head.material.opacity = woke * blink * clamp01((life - 0.6 - age) / 0.8) * 0.8;
        continue;
      }
      const dive = f.delay - 0.55;
      if (age < dive) wander(f, age, p);
      else {
        // The fall: from where the wander left it, a curl above the quarry, then down onto it.
        wander(f, dive, from);
        c1.copy(from).add(new THREE.Vector3(0, 1.2, 0));
        c2.copy(f.to).add(new THREE.Vector3(Math.sin(f.seed) * 1.2, 2.2, Math.cos(f.seed) * 1.2));
        curve.v3.copy(f.to);
        const u = clamp01((age - dive) / 0.55);
        curve.getPoint(u * u, p);
      }
      f.head.position.copy(p);
      f.head.visible = age < f.delay;
      f.head.material.opacity = woke * (age < dive ? blink : 1);
      if (f.trail) {
        if (age < f.delay && age >= dive - 0.2) f.trail.push(p);
        f.trail.update(dt, cam);
        f.trail.opacity = clamp01(1 - Math.max(0, age - f.delay) / 0.4);
      }
      if (!f.done && age >= f.delay) {
        f.done = true;
        if (f.trail) {
          ctx.particles?.burst(f.to, 14, { speed: 2.6, color: body.clone().lerp(WHITE, 0.4), size: 0.05, ttl: 0.6, gravity: 2, drag: 1.4, style: 'spark' });
          ctx.particles?.burst(f.to, 8, { speed: 1.2, color, size: 0.22, sizeEnd: 0.02, ttl: 0.6, drag: 2.2, style: 'glow' });
          ctx.light?.(f.to, color, 5, 0.35, 7);
        }
      }
    }
    // The crowns they leave glow faintly as the swarm wakes.
    const wakeGlow = clamp01(age / 0.4) * clamp01((1.6 - age) / 0.8);
    if (wakeGlow > 0) ctx.illuminate?.(1, crowns[0], body, 0.9 * wakeGlow, 10);
    if (age < 1.2 && random() < 0.5) {
      const crown = crowns[Math.floor(random() * crowns.length)];
      ctx.particles?.emit({ x: crown.x + (random() - 0.5) * 4, y: crown.y + (random() - 0.5) * 2, z: crown.z + (random() - 0.5) * 4, vx: 0, vy: -0.4, vz: 0, color: body, size: 0.06, ttl: 1, drag: 0.5, style: 'glow' });
    }
  }, 0.2, undefined, () => { for (const f of flies) f.trail?.dispose(); });
}
