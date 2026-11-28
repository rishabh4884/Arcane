import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SPELL_LIGHT_GLSL, SPELL_LIGHTS } from './LanternLighting.ts';
import { type PaintCamera, viewLogScore } from './paintedShots.ts';
import { forestLayout } from './spatial.ts';
import { groundData, rockPlacements, treePlacements } from './woodlandLayout.ts';
import { forestPaint } from './render/ForestPaint.ts';
import { INK } from './render/InkPaint.ts';
import { FIGURE_LIGHT } from './rig/figureMaterial.ts';

/**
 * THE PAINTED SET
 * ───────────────
 * A place painted the way an animated series paints its backgrounds — composed through a camera and
 * repainted stroke by stroke (art/set_build.py, art/set_paint.py) — and stood up in the game by
 * projecting the painting onto the ground. Trees, stones and architecture carry their own
 * surface paint: every side remains drawn when the camera travels beyond a painting's viewpoint.
 * Creatures pass behind solid trunks, whose branches and crowns remain joined through a turn.
 *
 * Like a series, the set has a painting for every shot: the gameplay view's, and one for each cutscene
 * camera key that strays from it. Two paintings are projected at once; each frame the two that best
 * serve the camera are chosen and weighed, and each surface takes them in proportion to how well each
 * saw it, so a camera moving from one key to the next passes from one painting into the next. Ground
 * no painting saw keeps its terrain paint, and the sky beyond every frame is the live sky.
 */

interface SetMeta { position: [number, number, number]; lookAt: [number, number, number]; fov: number; aspect: number; near: number; far: number; width: number; height: number; depthMax: number; script?: string }

interface Painting { name: string; camera: PaintCamera; script?: string; paint: THREE.Texture; depth: THREE.Texture; vp: THREE.Matrix4; eye: THREE.Vector3 }

type Surface = 'ground' | 'tree' | 'rock' | 'sky';

const BASE = `${import.meta.env.BASE_URL ?? '/'}art/sets/`;

/** The two projected paintings and their weighing, shared by every surface of the set. */
function slotUniforms() {
  return {
    tPaintA: { value: null as THREE.Texture | null }, tDepthA: { value: null as THREE.Texture | null }, uPaintVPA: { value: new THREE.Matrix4() }, uPaintCamA: { value: new THREE.Vector3() },
    tPaintB: { value: null as THREE.Texture | null }, tDepthB: { value: null as THREE.Texture | null }, uPaintVPB: { value: new THREE.Matrix4() }, uPaintCamB: { value: new THREE.Vector3() },
    uMix: { value: 0 }, uDepthMax: { value: 400 }, uShotGround: { value: 0 },
  };
}
type Slots = ReturnType<typeof slotUniforms>;

function projectedMaterial(slots: Slots, surface: Surface, fallback: THREE.Color, tint: { value: THREE.Color }, time: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: { SKY: surface === 'sky' ? 1 : 0, SWAY: surface === 'tree' ? 1 : 0, GROUND: surface === 'ground' ? 1 : 0 },
    side: surface === 'sky' ? THREE.BackSide : THREE.FrontSide,
    depthWrite: surface !== 'sky', vertexColors: true,
    uniforms: { ...slots, uFallback: { value: fallback }, uTint: tint, uTime: time, ...SPELL_LIGHTS, ...INK, uAir: FIGURE_LIGHT.uAir },
    vertexShader: /* glsl */`
      uniform float uTime;
      varying vec3 vRestWorld;
      varying vec3 vNormalW;
      varying vec3 vColor;
      void main() {
        vColor = color.rgb;
        vec4 local = vec4(position, 1.0);
        vec3 n = normal;
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
          n = mat3(instanceMatrix) * n;
        #endif
        vec4 world = modelMatrix * local;
        vRestWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * n);
        #if SWAY
          // Crowns breathe in the wind; the painting rides on them, sampled where the leaves rest.
          float h = max(0.0, position.y - 5.0);
          float gust = 0.6 + 0.4 * sin(uTime * 0.23 + world.x * 0.02);
          world.xyz += vec3(sin(uTime * 0.7 + world.x * 0.15 + world.z * 0.1), 0.0, cos(uTime * 0.55 + world.z * 0.13)) * h * 0.006 * gust;
        #endif
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tPaintA; uniform sampler2D tDepthA; uniform mat4 uPaintVPA; uniform vec3 uPaintCamA;
      uniform sampler2D tPaintB; uniform sampler2D tDepthB; uniform mat4 uPaintVPB; uniform vec3 uPaintCamB;
      uniform float uMix; uniform float uDepthMax; uniform float uShotGround; uniform vec3 uFallback; uniform vec3 uTint; uniform float uTime;
      varying vec3 vRestWorld;
      varying vec3 vNormalW;
      varying vec3 vColor;
      uniform vec3 uFillDir; uniform vec3 uMidColor; uniform vec3 uLitColor; uniform vec3 uShadeColor; uniform vec3 uAir;
      ${SPELL_LIGHT_GLSL}
      float psHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float psNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(psHash(i), psHash(i + vec2(1.0, 0.0)), f.x), mix(psHash(i + vec2(0.0, 1.0)), psHash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      // Clouds passing the moon: soft shadows drifting slowly over the floor and the trees.
      float cloudShade(vec3 w) {
        vec2 q = w.xz * 0.03 + vec2(uTime * 0.018, uTime * 0.007);
        float n = psNoise(q) * 0.65 + psNoise(q * 2.3 + 4.1) * 0.35;
        return 1.0 - 0.09 * smoothstep(0.42, 0.78, n);
      }
      // One painting's view of this point: its colour, and how surely it saw it (0 if not at all).
      vec3 project(sampler2D tPaint, sampler2D tDepth, mat4 vp, vec3 cam, out float seen) {
        vec4 clip = vp * vec4(vRestWorld, 1.0);
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
        vec2 inner = min(uv, 1.0 - uv);
        seen = clip.w > 0.0 ? smoothstep(0.0, 0.02, min(inner.x, inner.y)) : 0.0;
        if (seen > 0.0) {
          vec2 dRG = texture2D(tDepth, uv).rg;
          float painted = (dRG.r * 255.0 * 256.0 + dRG.g * 255.0) / 65535.0 * uDepthMax;
          #if SKY
            // A whole-scene painting must never paste its foreground trees onto the sky dome.
            seen *= step(uDepthMax - 0.1, painted);
          #else
            // Agreement is two-sided: a nearer floor cannot borrow a distant trunk or sky pixel.
            float error = abs(distance(vRestWorld, cam) - painted);
            float tolerance = max(0.12, painted * 0.004);
            seen *= 1.0 - smoothstep(tolerance, tolerance * 2.0, error);
          #endif
        }
        return texture2D(tPaint, uv).rgb;
      }
      void main() {
        vec3 projected = vec3(0.0);
        float w = 0.0;
        #if GROUND
        // Gameplay can turn through the sides of the original painting. The floor carries its own
        // paint through those moves; authored cutscene shots still use their camera-matched art.
        if (uShotGround > 0.001)
        #endif
        {
          float seenA, seenB;
          vec3 a = project(tPaintA, tDepthA, uPaintVPA, uPaintCamA, seenA);
          vec3 b = project(tPaintB, tDepthB, uPaintVPB, uPaintCamB, seenB);
          float wA = (1.0 - uMix) * seenA, wB = uMix * seenB;
          w = wA + wB;
          projected = (a * wA + b * wB) / max(w, 1e-4);
        }
        #if SKY
          // Beyond every painting's frame the live sky shows through.
          if (w < 0.002) discard;
          vec3 col = projected * uTint;
        #else
          float light = dot(normalize(vNormalW), uFillDir) * 0.5 + 0.5;
          vec3 local = vColor * mix(uShadeColor, mix(uMidColor, uLitColor, smoothstep(0.72, 0.82, light)), smoothstep(0.4, 0.5, light));
          #if GROUND
            vec2 brush = vRestWorld.xz;
            brush.x += brush.y * 0.21;
            float patches = psNoise(brush * vec2(0.84, 0.58));
            float marks = psNoise(brush * vec2(3.1, 0.96));
            float detail = smoothstep(0.24, 0.76, patches) * 0.24 + smoothstep(0.66, 0.87, marks) * 0.11;
            local = mix(local, vColor * (0.59 + detail + light * 0.27) + uAir * 0.19, 0.82);
          #endif
          float air = (1.0 - exp(-max(length(vRestWorld - cameraPosition) - 8.0, 0.0) / 62.0)) * 0.92;
          local = mix(local, uAir, min(air, 0.88));
          float coverage = clamp(w * 8.0, 0.0, 1.0);
          #if GROUND
            coverage *= uShotGround;
          #endif
          vec3 col = mix(local, projected, coverage) * uTint * cloudShade(vRestWorld);
          col += col * spellIllumination(vRestWorld) * 1.2;
        #endif
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

async function loadPainting(dir: string, name: string): Promise<Painting> {
  const [metadata, painted, depthMap] = await Promise.allSettled([
    fetch(`${dir}/meta.json`).then((r) => { if (!r.ok) throw new Error(`no painting at ${dir} (${r.status})`); return r.json() as Promise<SetMeta>; }),
    new THREE.TextureLoader().loadAsync(`${dir}/paint.webp`),
    new THREE.TextureLoader().loadAsync(`${dir}/depth.png`),
  ]);
  if (metadata.status === 'rejected' || painted.status === 'rejected' || depthMap.status === 'rejected') {
    // The other resources can finish after the first failure; retain them until they can be freed.
    if (painted.status === 'fulfilled') painted.value.dispose();
    if (depthMap.status === 'fulfilled') depthMap.value.dispose();
    const failure = [metadata, painted, depthMap].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    throw failure.reason;
  }
  const meta = metadata.value, paint = painted.value, depth = depthMap.value;
  paint.colorSpace = THREE.SRGBColorSpace;
  paint.anisotropy = 8;
  depth.colorSpace = THREE.NoColorSpace;
  // The packed R/G value is an affine encoding, so filtering then decoding is still linear depth.
  // Nearest sampling on a receding floor made every texel a different visibility terrace.
  depth.minFilter = THREE.LinearFilter; depth.magFilter = THREE.LinearFilter; depth.generateMipmaps = false;
  const cam = new THREE.PerspectiveCamera(meta.fov, meta.aspect, meta.near, meta.far);
  cam.position.fromArray(meta.position);
  cam.lookAt(new THREE.Vector3().fromArray(meta.lookAt));
  cam.updateMatrixWorld(true);
  return {
    name, script: meta.script, paint, depth, eye: cam.position.clone(),
    vp: new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    camera: { name, position: meta.position, lookAt: meta.lookAt, fov: meta.fov, aspect: meta.aspect },
  };
}

export class PaintedSet {
  readonly group = new THREE.Group();
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly slots = slotUniforms();
  /** A region not yet painted borrows this painting, retinted. */
  private readonly tint = { value: new THREE.Color(1, 1, 1) };
  private readonly time = { value: 0 };
  private readonly shots = new Map<string, Painting>();
  private shotScript: string | null = null;
  private shotGeneration = 0;
  private loadingShots: Promise<void> | null = null;
  private manifest: Array<{ name: string; script: string }> = [];
  private slotA: Painting | null = null;
  private slotB: Painting | null = null;
  private readonly eye = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  /** The gameplay view painted in each region's light (the same view, so only the painting differs). */
  private readonly regionPaints = new Map<string, THREE.Texture>();
  private readonly regionLoads = new Map<string, Promise<THREE.Texture | null>>();
  private region = '';
  private disposed = false;

  private constructor(private readonly name: string, private readonly gameplay: Painting) { this.group.name = 'Painted set'; }

  /** Load a painted set by name, or null if it has not been built. */
  static async load(name: string): Promise<PaintedSet | null> {
    try {
      const [painting, proxies, manifest] = await Promise.all([
        loadPainting(`${BASE}${name}`, name),
        new GLTFLoader().loadAsync(`${BASE}${name}/proxies.glb`),
        fetch(`${BASE}${name}/shots.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      ]);
      const set = new PaintedSet(name, painting);
      set.manifest = Array.isArray(manifest) ? manifest : [];
      set.build(proxies.scene);
      set.assign(painting, painting, 0);
      return set;
    } catch (error) {
      console.info(`[arcane] painted set "${name}" is not available; the cut-out wood stands instead`, error);
      return null;
    }
  }

  private build(proxies: THREE.Object3D): void {
    const make = (surface: Surface, fallback: string) => {
      const m = projectedMaterial(this.slots, surface, new THREE.Color(fallback), this.tint, this.time);
      this.materials.push(m);
      return m;
    };
    const sites = forestLayout();
    // The ground: the very terrain the creatures walk on.
    const gd = groundData(sites);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(gd.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(gd.colors, 3));
    g.setIndex(new THREE.BufferAttribute(gd.index, 1));
    g.computeVertexNormals();
    this.geometries.push(g);
    const ground = new THREE.Mesh(g, make('ground', '#1f2620'));
    ground.name = 'Painted ground';
    this.group.add(ground);
    // Trunks and stones: the painting's stand-ins, where the layout put them.
    const kinds = new Map<string, THREE.BufferGeometry>();
    const statics: THREE.Mesh[] = [];
    const carriers = new Set<THREE.Material>();
    proxies.updateMatrixWorld(true);
    proxies.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((material) => carriers.add(material));
      this.geometries.push(m.geometry);
      if (m.name.startsWith('static-')) statics.push(m); else kinds.set(m.name, m.geometry);
    });
    for (const material of carriers) material.dispose();
    const dummy = new THREE.Object3D();
    const byKind = new Map<string, ReturnType<typeof treePlacements>>();
    for (const t of treePlacements(sites)) {
      const kind = t.lod === 0 ? t.kind : `${t.kind}-lod${t.lod}`;
      const key = kinds.has(kind) ? kind : t.kind;
      if (!byKind.has(key)) byKind.set(key, []);
      byKind.get(key)!.push(t);
    }
    const treeMaterial = forestPaint(this.time, this.tint);
    const stoneMaterial = forestPaint(this.time, this.tint, false);
    const glowMaterial = forestPaint(this.time, this.tint, false, true);
    this.materials.push(treeMaterial, stoneMaterial, glowMaterial);
    for (const [kind, list] of byKind) {
      const geo = kinds.get(kind);
      if (!geo) { console.warn(`[arcane] painted set has no stand-in for ${kind}; its trees will not hide what passes behind them`); continue; }
      const inst = new THREE.InstancedMesh(geo, treeMaterial, list.length);
      list.forEach((t, i) => { dummy.position.set(t.x, t.y, t.z); dummy.rotation.set(0, t.yaw, 0); dummy.scale.setScalar(t.scale); dummy.updateMatrix(); inst.setMatrixAt(i, dummy.matrix); });
      inst.computeBoundingSphere();
      inst.name = `Painted ${kind}`;
      this.group.add(inst);
    }
    const rockGeo = kinds.get('rock_edge_a');
    if (rockGeo) {
      const rocks = rockPlacements(sites);
      const inst = new THREE.InstancedMesh(rockGeo, stoneMaterial, rocks.length);
      rocks.forEach((r, i) => { dummy.position.set(r.x, r.y, r.z); dummy.rotation.set(...r.rotation); dummy.scale.set(...r.scale); dummy.updateMatrix(); inst.setMatrixAt(i, dummy.matrix); });
      inst.computeBoundingSphere();
      inst.name = 'Painted stones';
      this.group.add(inst);
    }
    // The gate and the lanterns stand where they were painted.
    for (const m of statics) {
      const placed = new THREE.Mesh(m.geometry, m.name.includes('glass') ? glowMaterial : stoneMaterial);
      placed.applyMatrix4(m.matrixWorld);
      placed.name = `Painted ${m.name.slice(7)}`;
      this.group.add(placed);
    }
    // The living sky is directional and shares the region's light. Projecting a whole-scene image
    // onto a dome duplicated foreground trunks in the gaps whenever the camera left its keyframe.
  }

  private assign(a: Painting, b: Painting, mix: number): void {
    const s = this.slots;
    if (this.slotA !== a) { s.tPaintA.value = a.paint; s.tDepthA.value = a.depth; s.uPaintVPA.value.copy(a.vp); s.uPaintCamA.value.copy(a.eye); this.slotA = a; }
    if (this.slotB !== b) { s.tPaintB.value = b.paint; s.tDepthB.value = b.depth; s.uPaintVPB.value.copy(b.vp); s.uPaintCamB.value.copy(b.eye); this.slotB = b; }
    s.uMix.value = mix;
    s.uShotGround.value = (a === this.gameplay ? 0 : 1 - mix) + (b === this.gameplay ? 0 : mix);
  }

  /** Load a cutscene's own backgrounds (the shots its camera keys were painted for). */
  async prepareShots(script: string): Promise<void> {
    if (this.disposed) return;
    if (this.shotScript !== script) { this.releaseShots(); this.shotScript = script; }
    if (this.loadingShots) return this.loadingShots;
    const generation = this.shotGeneration;
    const wanted = this.manifest.filter((m) => m.script === script && !this.shots.has(m.name));
    const pending = Promise.all(wanted.map((m) => loadPainting(`${BASE}${this.name}/shots/${m.name}`, m.name).catch(() => null))).then((loaded) => {
      for (const p of loaded) if (p) {
        if (this.disposed || generation !== this.shotGeneration) { p.paint.dispose(); p.depth.dispose(); }
        else this.shots.set(p.name, p);
      }
    });
    this.loadingShots = pending;
    try { await pending; }
    finally { if (this.loadingShots === pending) this.loadingShots = null; }
  }

  /** Let the cutscene's backgrounds go; the gameplay painting stays. */
  releaseShots(): void {
    this.shotGeneration++;
    this.shotScript = null;
    this.loadingShots = null;
    this.assign(this.gameplay, this.gameplay, 0);
    for (const p of this.shots.values()) { p.paint.dispose(); p.depth.dispose(); }
    this.shots.clear();
  }

  setTint(color: THREE.Color): void { this.tint.value.copy(color); }

  /** Paint the gameplay view in a region's own light; a region not yet painted keeps the set's own. */
  async useRegion(key: string): Promise<void> {
    if (this.disposed || key === this.region) return;
    this.region = key;
    if (!this.regionPaints.has(this.name)) this.regionPaints.set(this.name, this.gameplay.paint);
    let paint = this.regionPaints.get(key);
    if (!paint) {
      let pending = this.regionLoads.get(key);
      if (!pending) {
        pending = new THREE.TextureLoader().loadAsync(`${BASE}${this.name}/regions/${key}/paint.webp`).catch(() => null).then((loaded) => {
          if (this.disposed) { loaded?.dispose(); return null; }
          const result = loaded ?? this.regionPaints.get(this.name)!;
          result.colorSpace = THREE.SRGBColorSpace;
          result.anisotropy = 8;
          this.regionPaints.set(key, result);
          return result;
        }).finally(() => this.regionLoads.delete(key));
        this.regionLoads.set(key, pending);
      }
      const loaded = await pending;
      if (!loaded || this.disposed) return;
      paint = loaded;
    }
    if (this.region !== key) return;          // a later region was asked for meanwhile
    this.gameplay.paint = paint;
    if (this.slotA === this.gameplay) this.slots.tPaintA.value = paint;
    if (this.slotB === this.gameplay) this.slots.tPaintB.value = paint;
  }

  update(dt: number, camera?: THREE.PerspectiveCamera): void {
    this.time.value += dt;
    if (!camera || !this.shots.size) {
      if (this.slotA !== this.gameplay || this.slots.uMix.value !== 0) this.assign(this.gameplay, this.gameplay, 0);
      return;
    }
    // The two paintings that best serve this camera, weighed by how well each does.
    // Rank in log space: long camera moves can put every raw exponential below floating-point
    // precision. Adding a floor there made unrelated paintings tie (including the gameplay view).
    const scored = [this.gameplay, ...this.shots.values()].map((p) => ({ p, s: viewLogScore(p.camera, camera, this.eye, this.dir) }));
    scored.sort((x, y) => y.s - x.s);
    const [first, second] = scored;
    // Keep each painting in the slot it already holds, so the weighing never jumps.
    let a = first, b = second;
    if (this.slotB === first.p || this.slotA === second.p) { a = second; b = first; }
    const weightA = Math.exp(a.s - first.s), weightB = Math.exp(b.s - first.s);
    this.assign(a.p, b.p, weightB / (weightA + weightB));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseShots();
    for (const m of this.materials) m.dispose();
    for (const g of this.geometries) g.dispose();
    for (const t of new Set([this.gameplay.paint, this.gameplay.depth, ...this.regionPaints.values()])) t.dispose();
    this.regionPaints.clear();
    this.regionLoads.clear();
    this.group.removeFromParent();
  }
}
