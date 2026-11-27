import * as THREE from 'three';
import { animate, facingPlane, type SpellAnimation, type SpellContext } from '../effects.ts';
import { terrainHeight } from '../spatial.ts';
import { WHITE, clamp01, glowSprite, ringTexture } from '../vfx.ts';

/**
 * Tidecaller: a serpent of moving water. It breaches beside the caster, swims for the main quarry
 * in humps that dip through the ground as if the wood were a sea, rears, and breaks over it; the
 * wave it becomes rolls on over everything else in sight.
 */

const RINGS = 46, RADIAL = 12;

const WATER_VERT = /* glsl */`
  varying vec2 vUv; varying vec3 vN; varying vec3 vView;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalMatrix * normal; vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

function waterMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uTime: { value: 0 }, uFade: { value: 1 },
      uDeep: { value: color.clone().multiplyScalar(0.35).lerp(new THREE.Color('#0d2f45'), 0.5) },
      uBody: { value: color.clone() },
      uFoam: { value: new THREE.Color('#eafcff') },
    },
    vertexShader: WATER_VERT,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform float uFade; uniform vec3 uDeep; uniform vec3 uBody; uniform vec3 uFoam;
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.2);
        // Currents run from head to tail and wrap round the body, so it reads as water moving, not glass.
        float flow = sin(vUv.x * 38.0 - uTime * 9.0 + sin(vUv.y * 12.566) * 1.4);
        float flow2 = sin(vUv.x * 71.0 - uTime * 14.0 + vUv.y * 25.13);
        float crest = smoothstep(0.7, 0.95, flow * 0.6 + flow2 * 0.4);
        float top = 0.5 + 0.5 * sin(vUv.y * 6.2832);
        vec3 col = mix(uDeep, uBody, 0.3 + 0.7 * top);
        col = mix(col, uFoam, clamp(crest * (0.45 + 0.55 * top) + fres * 0.5, 0.0, 1.0));
        float tail = 1.0 - smoothstep(0.7, 1.0, vUv.x);
        float alpha = (0.58 + 0.3 * fres + 0.3 * crest) * uFade * (0.35 + 0.65 * tail);
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }`,
  });
}

/** The wave crests: a frilled dorsal fin and two curling ribbons that wind round the body. */
function foamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uFade: { value: 1 }, uFoam: { value: new THREE.Color('#f2fdff') } },
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform float uFade; uniform vec3 uFoam; varying vec2 vUv;
      void main() {
        float lace = 0.55 + 0.45 * sin(vUv.x * 90.0 - uTime * 16.0 + vUv.y * 9.0);
        float edge = smoothstep(1.0, 0.55, vUv.y) * smoothstep(0.0, 0.12, vUv.y);
        float tail = 1.0 - smoothstep(0.6, 1.0, vUv.x);
        gl_FragColor = vec4(uFoam, edge * lace * tail * 0.8 * uFade);
        #include <colorspace_fragment>
      }`,
  });
}

function grid(rows: number, cols: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const count = rows * cols;
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const uv = new Float32Array(count * 2), index: number[] = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    uv[(i * cols + j) * 2] = i / (rows - 1);
    uv[(i * cols + j) * 2 + 1] = j / (cols - 1);
    if (i < rows - 1 && j < cols - 1) {
      const a = i * cols + j, b = a + cols;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

export function tidecaller(target: THREE.Vector3, color: THREE.Color, ctx: SpellContext): SpellAnimation {
  const group = new THREE.Group();
  group.name = 'Tidecaller';
  const cam = (ctx.cameraPosition ?? new THREE.Vector3(0, 1.8, 10)).clone();
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ctx.cameraQuaternion).setY(0).normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(ctx.cameraQuaternion).setY(0).normalize();
  const sideSign = ctx.hand === 'left' ? -1 : 1;
  const end = (ctx.targets?.[0] ?? target).clone();
  const start = cam.clone().addScaledVector(forward, 3).addScaledVector(right, sideSign * 1.8);
  start.y = terrainHeight(start.x, start.z) - 1.6;
  const span = start.clone().setY(0).distanceTo(end.clone().setY(0));
  const D = Math.max(4, span);
  const crash = ctx.delays?.[0] ?? 0.75 + D / 16;
  const bodyLength = Math.min(10, Math.max(4, D * 0.6));
  const lateral = new THREE.Vector3().subVectors(end, start).setY(0).normalize();
  const across = new THREE.Vector3(-lateral.z, 0, lateral.x);

  /** The serpent's road: humps that dip through the ground, a sway, then up onto the quarry. */
  const path = (s: number, out: THREE.Vector3): THREE.Vector3 => {
    if (s <= 0) return out.copy(start).setY(start.y + s * D);
    const k = Math.min(1, s);
    out.lerpVectors(start, end, k);
    out.addScaledVector(across, 1.3 * Math.sin(Math.PI * k) * Math.sin(k * D / 9 * Math.PI * 2 + 0.7) * sideSign);
    const ground = terrainHeight(out.x, out.z);
    const swim = ground + 0.55 + 1.35 * Math.sin(k * D / 7 * Math.PI * 2 - Math.PI / 2 + 0.4) * Math.min(1, k * 6);
    const rise = k < 0.06 ? THREE.MathUtils.lerp(start.y, swim, k / 0.06) : swim;
    out.y = THREE.MathUtils.lerp(rise, end.y, THREE.MathUtils.smoothstep(k, 0.8, 1));
    return out;
  };

  const water = waterMaterial(color), foam = foamMaterial();
  const body = new THREE.Mesh(grid(RINGS, RADIAL + 1), water);
  const crests = new THREE.Mesh(grid(RINGS * 3, 2), foam);
  body.frustumCulled = crests.frustumCulled = false;
  body.renderOrder = 4; crests.renderOrder = 5;
  const eyes = [glowSprite('#e6fffb', 0.34, undefined, 1), glowSprite('#e6fffb', 0.34, undefined, 1)];
  const headGlow = glowSprite(color.clone().lerp(WHITE, 0.3), 2.4, undefined, 0.35);
  group.add(body, crests, headGlow, ...eyes);

  const ripples = [end, ...(ctx.targets?.slice(1) ?? [])].slice(0, 8).map(() => {
    const ring = facingPlane(ringTexture(), color.clone().lerp(WHITE, 0.4), 1);
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    group.add(ring);
    return { ring, at: Infinity, point: new THREE.Vector3() };
  });
  const ripple = (i: number, point: THREE.Vector3, age: number) => {
    const r = ripples[i];
    if (!r) return;
    r.at = age;
    r.point.copy(point).setY(terrainHeight(point.x, point.z) + 0.06);
  };

  const centres = Array.from({ length: RINGS }, () => new THREE.Vector3());
  const tangent = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3(), dir = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const foamColor = new THREE.Color('#eafcff');
  const radiusAt = (v: number) => {
    const head = v < 0.06 ? Math.sqrt(v / 0.06) * 0.82 : v < 0.14 ? THREE.MathUtils.lerp(0.82, 1, (v - 0.06) / 0.08) : 1 - THREE.MathUtils.smoothstep(v, 0.14, 1) * 0.9;
    return 0.72 * head;
  };
  let hit = 0;
  const life = crash + 1.5;
  return animate(group, life, (_t, age) => {
    water.uniforms.uTime.value = foam.uniforms.uTime.value = age;
    const after = Math.max(0, age - crash);
    const fade = 1 - clamp01(after / 0.75);
    water.uniforms.uFade.value = foam.uniforms.uFade.value = fade;
    const sHead = Math.pow(clamp01(age / crash), 1.15);
    // It rears in the last half second, then strikes down onto the quarry.
    const rear = Math.sin(Math.PI * clamp01((age - (crash - 0.55)) / 0.55)) * 2.6;
    for (let i = 0; i < RINGS; i++) {
      const v = i / (RINGS - 1);
      const s = sHead - (v * bodyLength) / D;
      path(s, centres[i]);
      centres[i].y += rear * Math.exp(-v * bodyLength / 2.2) - 5 * after * after;
    }
    const pos = body.geometry.attributes.position as THREE.BufferAttribute;
    const nrm = body.geometry.attributes.normal as THREE.BufferAttribute;
    const cpos = crests.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < RINGS; i++) {
      const v = i / (RINGS - 1);
      const c = centres[i];
      tangent.subVectors(centres[Math.max(0, i - 1)], centres[Math.min(RINGS - 1, i + 1)]);
      if (tangent.lengthSq() < 1e-8) tangent.copy(lateral);
      tangent.normalize();
      side.crossVectors(tangent, WORLD_UP);
      if (side.lengthSq() < 1e-6) side.copy(across);
      side.normalize();
      up.crossVectors(side, tangent).normalize();
      const r = radiusAt(v) * (1 + 0.09 * Math.sin(v * 40 - age * 12)) * (1 - 0.6 * clamp01(after / 0.6));
      for (let j = 0; j <= RADIAL; j++) {
        const a = (j / RADIAL) * Math.PI * 2;
        // The head is a little flattened, like a snout.
        dir.copy(side).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a) * (v < 0.12 ? 0.75 : 1));
        const k = i * (RADIAL + 1) + j;
        pos.setXYZ(k, c.x + dir.x * r, c.y + dir.y * r, c.z + dir.z * r);
        dir.normalize();
        nrm.setXYZ(k, dir.x, dir.y, dir.z);
      }
      // Dorsal crest: a frill of breaking wave, tallest behind the head, rolling backward.
      const frill = r * (0.55 + 0.45 * Math.sin(v * 34 - age * 10)) * (1 + 1.6 * Math.exp(-v * 9));
      const b = i * 2;
      cpos.setXYZ(b, c.x + up.x * r * 0.8, c.y + up.y * r * 0.8, c.z + up.z * r * 0.8);
      cpos.setXYZ(b + 1, c.x + up.x * (r * 0.8 + frill) + tangent.x * frill * 0.5, c.y + up.y * (r * 0.8 + frill), c.z + up.z * (r * 0.8 + frill) + tangent.z * frill * 0.5);
      // Two ribbons of spray winding round the body in opposite turns.
      for (let w = 0; w < 2; w++) {
        const a = v * 15 * (w ? -1 : 1) + age * 4 + w * Math.PI;
        dir.copy(side).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
        const o = (RINGS + w * RINGS + i) * 2;
        const inner = r * 1.02, outer = r * 1.02 + r * 0.42;
        cpos.setXYZ(o, c.x + dir.x * inner, c.y + dir.y * inner, c.z + dir.z * inner);
        cpos.setXYZ(o + 1, c.x + dir.x * outer + tangent.x * r * 0.3, c.y + dir.y * outer, c.z + dir.z * outer + tangent.z * r * 0.3);
      }
    }
    pos.needsUpdate = nrm.needsUpdate = cpos.needsUpdate = true;

    // Eyes and the glow that rides with the head.
    const head = centres[2];
    tangent.subVectors(centres[0], centres[4]).normalize();
    side.crossVectors(tangent, WORLD_UP).normalize();
    up.crossVectors(side, tangent).normalize();
    eyes.forEach((eye, k) => {
      eye.position.copy(head).addScaledVector(side, (k ? 1 : -1) * 0.38).addScaledVector(up, 0.26);
      eye.material.opacity = fade * (head.y > terrainHeight(head.x, head.z) ? 1 : 0);
    });
    headGlow.position.copy(head);
    headGlow.material.opacity = 0.35 * fade;
    if (fade > 0) ctx.illuminate?.(1, head, color, 1.3 * fade, 12);

    // Spray off the crest, drips off the belly, and a foaming wake where it cuts the ground.
    if (age < crash) {
      for (let n = 0; n < 3; n++) {
        const c = centres[Math.floor(Math.random() * RINGS * 0.6)];
        ctx.particles?.emit({ x: c.x, y: c.y + 0.5, z: c.z, vx: (Math.random() - 0.5) * 2.4, vy: 1.5 + Math.random() * 2.5, vz: (Math.random() - 0.5) * 2.4, color: Math.random() < 0.6 ? foamColor : color, size: 0.07, sizeEnd: 0.02, ttl: 0.8, gravity: 9, drag: 0.4, style: 'spark' });
      }
      for (let i = 0; i < RINGS; i += 5) {
        const c = centres[i];
        const g = terrainHeight(c.x, c.z);
        if (Math.abs(c.y - g) < 0.5 && Math.random() < 0.35) ctx.mist?.emit({ x: c.x, y: g + 0.15, z: c.z, vx: (Math.random() - 0.5), vy: 0.3, vz: (Math.random() - 0.5), color: foamColor, size: 0.7, sizeEnd: 1.6, alpha: 0.35, ttl: 0.9, drag: 1.2, style: 'mist' });
      }
    }
    // The main quarry takes the crash; the wave rolls on over the rest on their beats.
    while (hit < (ctx.delays?.length ?? 0) && age >= ctx.delays![hit]) {
      const p = ctx.targets![hit];
      if (hit > 0) {
        ctx.particles?.burst(p, 26, { speed: 4, direction: WORLD_UP, spread: 0.8, color: foamColor, size: 0.07, ttl: 0.8, gravity: 10, drag: 0.5, style: 'spark' });
        ctx.particles?.burst(p, 10, { speed: 1.5, color, size: 0.3, sizeEnd: 0.05, ttl: 0.6, drag: 2, style: 'glow' });
        ctx.light?.(p, color, 5, 0.35, 8);
      }
      ripple(hit, p, age);
      hit++;
    }
    for (const r of ripples) {
      const since = age - r.at;
      r.ring.visible = since >= 0 && since < 1;
      if (!r.ring.visible) continue;
      r.ring.position.copy(r.point);
      r.ring.scale.setScalar(0.8 + since * 7);
      r.ring.material.opacity = (1 - since) * 0.7;
    }
  }, crash, () => {
    ctx.particles?.burst(end, 70, { speed: 7, direction: WORLD_UP, spread: 0.85, color: foamColor, size: 0.08, sizeEnd: 0.02, ttl: 1, gravity: 12, drag: 0.4, style: 'spark' });
    ctx.particles?.burst(end, 26, { speed: 2.4, color, size: 0.45, sizeEnd: 0.05, ttl: 0.8, drag: 2, style: 'glow' });
    for (let i = 0; i < 10; i++) ctx.mist?.emit({ x: end.x + (Math.random() - 0.5) * 3, y: end.y, z: end.z + (Math.random() - 0.5) * 3, vx: (Math.random() - 0.5) * 3, vy: 1.2, vz: (Math.random() - 0.5) * 3, color: foamColor, size: 1.4, sizeEnd: 3.4, alpha: 0.4, ttl: 1.4, drag: 1.4, style: 'mist' });
    if (!ctx.delays?.length) ripple(0, end, crash);
    ctx.light?.(end, color, 9, 0.5, 12);
    ctx.screen?.shake(0.35);
    ctx.screen?.flash('#7fd8ee', 0.2, 'edge');
  });
}
