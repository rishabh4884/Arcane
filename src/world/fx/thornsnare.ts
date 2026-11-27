import * as THREE from 'three';
import { animate, type SpellAnimation, type SpellContext } from '../effects.ts';
import { tube, type V3 } from '../rig/Body.ts';
import { terrainHeight } from '../spatial.ts';
import { clamp01, easeOutBack, easeOutCubic, rng } from '../vfx.ts';

/**
 * Thornsnare in four beats: the soil splits in a ring of lit fissures; bramble vines lash up out of
 * it and coil around the quarry; they cinch and strain for as long as it is held; then they wither,
 * snap and draw back into the earth.
 */

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** Split soil: a dark disc of turned earth, fissures glowing with the spell's sap. */
function soilMaterial(color: THREE.Color, seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uReveal: { value: 0 }, uGlow: { value: 1 }, uFade: { value: 1 }, uSeed: { value: seed },
      uSoil: { value: new THREE.Color('#21180f') }, uLip: { value: new THREE.Color('#5a4630') }, uSap: { value: color.clone() },
    },
    vertexShader: VERT,
    fragmentShader: /* glsl */`
      uniform float uReveal; uniform float uGlow; uniform float uFade; uniform float uSeed;
      uniform vec3 uSoil; uniform vec3 uLip; uniform vec3 uSap; varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p), a = atan(p.y, p.x);
        float edge = (0.8 + 0.1 * sin(a * 6.0 + uSeed) + 0.05 * sin(a * 13.0 - uSeed)) * uReveal;
        if (r > edge) discard;
        // Fissures run out from the centre and one ragged ring cracks across them.
        float spoke = abs(sin(a * 3.5 + sin(r * 7.0 + uSeed) * 0.5));
        float fissure = (1.0 - smoothstep(0.015, 0.06, spoke)) * smoothstep(0.08, 0.3, r) * (1.0 - smoothstep(edge - 0.12, edge, r));
        float ring = 1.0 - smoothstep(0.01, 0.035, abs(r - 0.5 * uReveal - 0.035 * sin(a * 9.0 + uSeed)));
        float crack = max(fissure, ring * 0.85);
        float lip = smoothstep(edge - 0.16, edge - 0.02, r);
        vec3 col = mix(uSoil, uLip, lip * 0.7);
        col = mix(col, uSap * (0.6 + 1.4 * uGlow), crack);
        float alpha = (0.82 - lip * 0.5 + crack * 0.18) * uFade;
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }`,
  });
}

/** Bark that grows along its length (the tube's `grad`), lit at the growing tip, greying as it dies. */
function vineMaterial(color: THREE.Color): { material: THREE.MeshStandardMaterial; grow: { value: number }; wither: { value: number } } {
  const grow = { value: 0 }, wither = { value: 0 };
  const material = new THREE.MeshStandardMaterial({ color: '#3a2b1d', roughness: 0.92 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGrow = grow;
    shader.uniforms.uWither = wither;
    shader.uniforms.uSap = { value: color };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float grad;\nvarying float vGrad;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrad = grad;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGrow;\nuniform float uWither;\nuniform vec3 uSap;\nvarying float vGrad;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vGrad > uGrow) discard;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float tip = (1.0 - smoothstep(0.0, 0.08, uGrow - vGrad)) * step(uGrow, 0.995);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.28, 0.25), uWither);
        totalEmissiveRadiance += uSap * (tip * 1.8 + 0.07 * (1.0 - uWither));`);
  };
  material.customProgramCacheKey = () => 'thornsnare-vine';
  return { material, grow, wither };
}

/** A hooked thorn, base at the origin, rising along +Y and curling toward +Z. */
function thornGeometry(): THREE.BufferGeometry {
  return tube([[0, -0.01, 0], [0, 0.07, 0.01], [0, 0.13, 0.05], [0, 0.15, 0.1]], [0.03, 0.017, 0.007, 0.001], { radial: 5, capEnd: false });
}

/** A pointed leaf in the XY plane, stem at the origin. */
function leafGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(0.09, 0.08, 0, 0.24);
  s.quadraticCurveTo(-0.09, 0.08, 0, 0);
  return new THREE.ShapeGeometry(s, 6);
}

interface Vine {
  mesh: THREE.Mesh;
  grow: { value: number };
  wither: { value: number };
  start: number;
  thorns: Array<{ mesh: THREE.Object3D; u: number }>;
  sway: number;
}

export function thornsnare(target: THREE.Vector3, color: THREE.Color, ctx: SpellContext): SpellAnimation {
  const group = new THREE.Group();
  group.name = 'Thornsnare';
  const thornGeo = thornGeometry(), leafGeo = leafGeometry();
  const at = (ctx.targets?.[0] ?? target).clone();
  at.y = terrainHeight(at.x, at.z);
  const random = rng(Math.floor(at.x * 131 + at.z * 71 + 7));

  const soil = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 6.4), soilMaterial(color, random() * 6.28));
  soil.rotation.x = -Math.PI / 2;
  soil.position.y = 0.04;
  soil.renderOrder = 2;
  group.add(soil);

  const thornMaterial = new THREE.MeshStandardMaterial({ color: '#1d150e', roughness: 0.6 });
  const leafMaterial = new THREE.MeshStandardMaterial({ color: '#3f5d2b', roughness: 0.8, side: THREE.DoubleSide, emissive: color.clone().multiplyScalar(0.06) });
  const coil = 0.72;
  const vines: Vine[] = [];
  const count = 7;
  const frame = new THREE.Matrix4(), x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const a0 = (i / count) * Math.PI * 2 + random() * 0.5;
    const turn = (i % 2 ? 1 : -1) * (1.0 + random() * 0.45) * Math.PI * 2;
    const base = 1.6 + random() * 0.7, height = 1.5 + random() * 1.1;
    // Out of the soil in a lashing arch, then round and up the quarry, closing in as it climbs.
    const points: V3[] = [];
    for (let k = 0; k <= 16; k++) {
      const u = k / 16;
      const angle = a0 + turn * Math.pow(u, 1.25);
      const r = coil + (base - coil) * Math.pow(1 - u, 2.2) + Math.sin(u * 23 + i) * 0.04;
      points.push([Math.cos(angle) * r, -0.3 + height * u + Math.sin(u * Math.PI) * 0.45, Math.sin(angle) * r]);
    }
    const geometry = tube(points, (u) => 0.012 + 0.11 * Math.pow(1 - u, 0.85), { radial: 7, segments: 40, wobble: 0.22, wobbleFrequency: 7, seed: i * 17 + 3, capStart: false });
    const { material, grow, wither } = vineMaterial(color);
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    // Barbs along the vine, hooked back toward the root so the vine reads as holding, not resting.
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
    const thorns: Vine['thorns'] = [];
    for (let u = 0.12 + random() * 0.05; u < 0.94; u += 0.07 + random() * 0.04) {
      const c = curve.getPointAt(u), t = curve.getTangentAt(u);
      const spin = random() * Math.PI * 2;
      y.set(Math.cos(spin), Math.sin(spin), 0);
      y.sub(z.copy(t).multiplyScalar(y.dot(t))).normalize();
      z.copy(t).negate();
      x.crossVectors(y, z).normalize();
      const r = 0.012 + 0.11 * Math.pow(1 - u, 0.85);
      const thorn = new THREE.Mesh(thornGeo, thornMaterial);
      frame.makeBasis(x, y, z);
      thorn.quaternion.setFromRotationMatrix(frame);
      thorn.position.copy(c).addScaledVector(y, r * 0.8);
      thorn.userData.size = 0.8 + (1 - u) * 1.1;
      thorn.scale.setScalar(0.001);
      mesh.add(thorn);
      thorns.push({ mesh: thorn, u });
    }
    for (let l = 0; l < 3; l++) {
      const u = 0.25 + l * 0.24 + random() * 0.08;
      const c = curve.getPointAt(u);
      const leaf = new THREE.Mesh(leafGeo, leafMaterial);
      leaf.position.copy(c);
      leaf.lookAt(c.clone().multiplyScalar(2).setY(c.y + 0.4));
      leaf.rotateZ(random() * Math.PI * 2);
      leaf.userData.size = 0.9 + random() * 0.6;
      leaf.scale.setScalar(0.001);
      mesh.add(leaf);
      thorns.push({ mesh: leaf, u });
    }
    vines.push({ mesh, grow, wither, start: 0.18 + i * 0.035 + random() * 0.05, thorns, sway: random() * 6.28 });
  }

  // Placed only now: the leaves above were aimed in the group's own space.
  group.position.copy(at);
  const life = 4.6, die = life - 0.95;
  let snapped = false, cinched = false;
  const dust = new THREE.Color('#6b5a44');
  return animate(group, life, (_t, age) => {
    const m = soil.material.uniforms;
    m.uReveal.value = easeOutCubic(clamp01(age / 0.35));
    m.uGlow.value = 0.25 + 0.75 * Math.exp(-Math.max(0, age - 0.5) * 2.2) + (age > die ? 0 : 0.12 * Math.sin(age * 5));
    m.uFade.value = 1 - clamp01((age - (life - 0.6)) / 0.6);
    // Cinch: the coils draw tight just after they close, then strain against the quarry.
    const cinch = easeOutBack(clamp01((age - 0.8) / 0.3));
    const strain = age > 1.1 && age < die ? 1 : 0;
    const shudder = strain * Math.max(0, Math.sin(age * 4.1)) ** 6;
    for (const v of vines) {
      const local = age - v.start;
      const grown = easeOutCubic(clamp01(local / 0.5));
      const withering = clamp01((age - die) / 0.3);
      const retreat = easeOutCubic(clamp01((age - die - 0.35) / 0.55));
      v.grow.value = grown * (1 - retreat);
      v.wither.value = withering;
      const squeeze = 1 - cinch * 0.1;
      v.mesh.scale.set(squeeze, 1 + cinch * 0.04, squeeze);
      v.mesh.rotation.y = Math.sin(age * 1.3 + v.sway) * 0.025 + strain * Math.sin(age * 19 + v.sway) * 0.012 + shudder * 0.05 * Math.sin(v.sway * 5);
      for (const th of v.thorns) {
        const k = clamp01((v.grow.value - th.u) / 0.08);
        th.mesh.scale.setScalar(Math.max(0.001, easeOutBack(k) * th.mesh.userData.size * (1 - withering * 0.3)));
      }
      if (!cinched && local > 0.05 && local < 0.5 && Math.random() < 0.5) {
        // Soil flung from the growing tip.
        const tip = v.mesh.geometry.attributes.position;
        const i = Math.floor(v.grow.value * (tip.count - 1));
        x.fromBufferAttribute(tip, Math.max(0, i)).applyMatrix4(v.mesh.matrixWorld);
        ctx.particles?.emit({ x: x.x, y: x.y, z: x.z, vx: (Math.random() - 0.5) * 2, vy: 1.5 + Math.random() * 2, vz: (Math.random() - 0.5) * 2, color: dust, size: 0.05, ttl: 0.7, gravity: 9, drag: 0.5, style: 'spark' });
      }
    }
    if (!cinched && age > 0.85) {
      cinched = true;
      ctx.screen?.shake(0.12);
      ctx.light?.(at.clone().setY(at.y + 1), color, 5, 0.5, 7);
    }
    if (!snapped && age > die + 0.3) {
      snapped = true;
      const centre = at.clone().setY(at.y + 1);
      ctx.particles?.burst(centre, 34, { speed: 3.4, radius: 0.8, color: new THREE.Color('#4a3a28'), size: 0.07, sizeEnd: 0.02, ttl: 0.9, gravity: 8, drag: 0.8, style: 'spark' });
      ctx.particles?.burst(centre, 10, { speed: 1, radius: 1, color: new THREE.Color('#6d6a52'), size: 0.12, sizeEnd: 0.02, ttl: 1.4, gravity: 2, drag: 2, style: 'glow' });
    }
    if (strain && Math.random() < 0.08) ctx.particles?.emit({ x: at.x + (Math.random() - 0.5) * 1.6, y: at.y + 0.3 + Math.random() * 2, z: at.z + (Math.random() - 0.5) * 1.6, vx: 0, vy: 0.4, vz: 0, color, size: 0.05, sizeEnd: 0.01, ttl: 1.1, drag: 1, gravity: -0.3, style: 'glow' });
  }, 0.55, () => {
    ctx.mist?.burst(at.clone().setY(at.y + 0.3), 16, { speed: 2.4, direction: new THREE.Vector3(0, 1, 0), spread: 2, color: new THREE.Color('#5d5040'), size: 0.9, sizeEnd: 2.2, alpha: 0.35, ttl: 1.4, drag: 1.6, style: 'mist' });
    ctx.particles?.burst(at, 36, { speed: 4.2, direction: new THREE.Vector3(0, 1, 0), spread: 1.2, color: dust, size: 0.06, ttl: 0.9, gravity: 9, drag: 0.6, style: 'spark' });
    ctx.screen?.shake(0.15);
  }, () => { thornMaterial.dispose(); leafMaterial.dispose(); });
}
