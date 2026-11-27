import * as THREE from 'three';
import { animate, type SpellAnimation, type SpellContext } from '../effects.ts';
import { terrainHeight } from '../spatial.ts';
import { clamp01, easeOutCubic, rng } from '../vfx.ts';

/**
 * Screech of Pain: the Widow's cry, torn out of the caster. Rings of bent air roll out from the
 * mouth, jagged wail-lines crack across them, and the forest floor is stripped outward — leaves,
 * dust and anything standing in front of it thrown back.
 */

/** A ragged ring of shocked air: bright at the front, smeared behind, never quite round. */
function shockMaterial(color: THREE.Color, seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: color.clone() }, uOpacity: { value: 0 }, uTime: { value: 0 }, uSeed: { value: seed } },
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uSeed; varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float a = atan(p.y, p.x);
        float r = length(p);
        float rag = 0.04 * sin(a * 9.0 + uSeed) + 0.03 * sin(a * 23.0 - uTime * 20.0 + uSeed * 2.0) + 0.02 * sin(a * 47.0 + uSeed * 5.0);
        float d = r - (0.86 + rag);
        float front = exp(-d * d * 900.0);
        float smear = smoothstep(-0.28, 0.0, d) * (1.0 - step(0.0, d)) * 0.35;
        float a2 = (front + smear) * uOpacity;
        if (a2 < 0.003) discard;
        gl_FragColor = vec4(uColor * (0.6 + front), a2);
      }`,
  });
}

/** A jagged crack of sound: a narrow strip zig-zagging along an arc, in the ring's plane. */
function wailArc(random: () => number, material: THREE.Material): THREE.Mesh {
  const start = random() * Math.PI * 2, span = 0.5 + random() * 0.7, steps = 9;
  const positions: number[] = [], index: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = start + (i / steps) * span;
    const r = 0.86 + (i % 2 ? 1 : -1) * (0.03 + random() * 0.05);
    const w = 0.012 + 0.018 * Math.sin((i / steps) * Math.PI);
    positions.push(Math.cos(a) * (r - w), Math.sin(a) * (r - w), 0, Math.cos(a) * (r + w), Math.sin(a) * (r + w), 0);
    if (i < steps) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return new THREE.Mesh(geometry, material);
}

export function screech(_origin: THREE.Vector3, color: THREE.Color, ctx: SpellContext): SpellAnimation {
  const group = new THREE.Group();
  group.name = 'Screech of Pain';
  const cam = (ctx.cameraPosition ?? new THREE.Vector3(0, 1.8, 10)).clone();
  const q = ctx.cameraQuaternion.clone();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const flat = forward.clone().setY(0).normalize();
  const random = rng(Math.floor(Math.abs(cam.x * 13 + cam.z * 29)) + 5);
  const bone = color.clone();
  const bruise = new THREE.Color('#b0475a');
  const tan = Math.tan(THREE.MathUtils.degToRad((ctx.fov ?? 64) / 2));

  // Five rings roll out of the mouth one after another, each wider than the view at its depth.
  const waves = [0, 0.09, 0.2, 0.34, 0.52].map((at, k) => {
    const wave = new THREE.Group();
    wave.quaternion.copy(q);
    const material = shockMaterial(k === 2 ? bone.clone().lerp(bruise, 0.35) : bone, k * 1.7);
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    wave.add(ring);
    const arcMaterial = new THREE.MeshBasicMaterial({ color: bone, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const arcs = k < 3 ? Array.from({ length: 4 + k * 2 }, () => wailArc(random, arcMaterial)) : [];
    wave.add(...arcs);
    wave.visible = false;
    wave.renderOrder = 8;
    group.add(wave);
    return { wave, material, arcMaterial, at, spin: (random() - 0.5) * 0.8 };
  });

  // A ground ring tears the litter outward.
  const groundRing = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 72, 1), new THREE.MeshBasicMaterial({ color: bone, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  groundRing.rotation.x = -Math.PI / 2;
  const footing = cam.clone().setY(terrainHeight(cam.x, cam.z) + 0.08);
  groundRing.position.copy(footing);
  group.add(groundRing);

  const leaf = [new THREE.Color('#6d5b38'), new THREE.Color('#8b7a47'), new THREE.Color('#3f3a22')];
  const dust = new THREE.Color('#9c917d');
  const outward = new THREE.Vector3();
  let hit = 0;
  const life = 1.7;
  return animate(group, life, (_t, age) => {
    for (const w of waves) {
      const local = age - w.at;
      w.wave.visible = local >= 0 && local < 1.1;
      if (!w.wave.visible) continue;
      const depth = 0.9 + easeOutCubic(clamp01(local / 1.1)) * 17;
      w.wave.position.copy(cam).addScaledVector(forward, depth);
      w.wave.scale.setScalar(depth * tan * (1.15 + local * 0.5));
      w.wave.rotation.z = 0;
      w.wave.rotateZ(w.spin * local);
      const fade = clamp01(local / 0.06) * (1 - clamp01((local - 0.25) / 0.85));
      w.material.uniforms.uOpacity.value = fade * 0.9;
      w.material.uniforms.uTime.value = age;
      w.arcMaterial.opacity = fade * (Math.sin(age * 60 + w.spin * 9) > -0.3 ? 0.9 : 0.25);
    }
    const g = clamp01(age / 0.9);
    const radius = 0.5 + easeOutCubic(g) * 18;
    groundRing.scale.setScalar(radius);
    groundRing.material.opacity = (1 - g) * 0.55;
    // The ring front strips leaves and dust from the ground and flings them away from the caster.
    if (g < 1) {
      for (let n = 0; n < 6; n++) {
        const a = Math.atan2(flat.x, flat.z) + (random() - 0.5) * Math.PI * 1.6;
        outward.set(Math.sin(a), 0, Math.cos(a));
        const x = footing.x + outward.x * radius, z = footing.z + outward.z * radius, y = terrainHeight(x, z) + 0.1;
        ctx.particles?.emit({ x, y, z, vx: outward.x * (7 + random() * 5), vy: 1 + random() * 2.5, vz: outward.z * (7 + random() * 5), color: leaf[n % 3], size: 0.09, sizeEnd: 0.06, ttl: 1.1, gravity: 3, drag: 1.6, style: 'spark' });
        if (n < 2) ctx.mist?.emit({ x, y: y + 0.2, z, vx: outward.x * 6, vy: 0.6, vz: outward.z * 6, color: dust, size: 1, sizeEnd: 2.6, alpha: 0.28, ttl: 1.2, drag: 2, style: 'mist' });
      }
    }
    // Each creature the cry reaches is struck off its feet in a spray of grit.
    while (ctx.targets && ctx.delays && hit < ctx.delays.length && age >= ctx.delays[hit]) {
      const p = ctx.targets[hit++];
      outward.subVectors(p, cam).setY(0).normalize();
      ctx.particles?.burst(p, 18, { speed: 5, direction: outward.clone().setY(0.3), spread: 0.6, color: dust, size: 0.07, ttl: 0.7, gravity: 6, drag: 1, style: 'spark' });
      ctx.particles?.burst(p, 8, { speed: 2, color: bone, size: 0.3, sizeEnd: 0.04, ttl: 0.4, drag: 3, style: 'glow' });
    }
    if (age < 0.6) ctx.illuminate?.(1, cam.clone().addScaledVector(forward, 4), bone, 0.9 * (1 - age / 0.6), 14);
  }, 0.08, () => {
    ctx.screen?.flash('#efe3cf', 0.32, 'edge');
    ctx.screen?.shake(0.6);
  }, () => { for (const w of waves) w.arcMaterial.dispose(); });
}
