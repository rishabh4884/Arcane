import * as THREE from 'three';
import { SPELLS } from '../config/spells.ts';
import { levelById } from '../game/campaign.ts';
import type { SpellBook } from '../spells/SpellBook.ts';
import type { HandTracker, TrackerStats } from '../tracking/HandTracker.ts';
import type { HandFrame, HandSide } from '../tracking/types.ts';
import type { World } from '../world/World.ts';
import { handsAt } from './syntheticHands.ts';

/**
 * PERFORMANCE BENCHMARK  (`/?bench`)
 * ──────────────────────────────────
 * Plays real levels with no one at the camera, so any device can be measured the same way:
 *
 * - the webcam (or a browser's fake camera) runs through MediaPipe exactly as in play, so hand
 *   tracking costs what it really costs; its results are measured, then set aside;
 * - two synthetic hands sweep the wood and hold signs through the real gesture engine;
 * - every spell is cast in turn, and the caster never falls, so the fight keeps going.
 *
 * Frame times, main-thread time, draw calls, GPU resource counts, memory and the adaptive
 * resolution are recorded in five-second windows, so a slow drift over time shows as clearly as
 * a slow frame. Results go on screen and to `window.__arcaneBench` (JSON) when the run ends.
 *
 * Parameters: `bench=<seconds per level>` (default 30), `levels=3,11,22` (default 3,11,22,33,48),
 * `camera=0` (no camera), `hands=0`, `casts=0`, `warm=<seconds before recording>` (default 3).
 * Saves are never touched (see storage.ts), and cutscenes are skipped.
 *
 * DIAGNOSIS  (`/?bench&diagnose`)
 * ───────────────────────────────
 * One level at one fixed quality level, with one thing taken away at a time: the page's overlays,
 * the moon's shadows, the inner ink, edge anti-aliasing, the bloom, the whole post stack, half the
 * resolution, the spells, and last the camera. What each one gives back is what it costs on this
 * device, GPU timers or not. Where the browser has GPU timers, each pass's GPU time is recorded
 * too. `level=<id>` (default 20), `phase=<seconds>` (default 8), `rung=<n>` to pick the level.
 *
 * Results are also posted to `/__bench` on the page's own host, where `tools/bench-serve.mjs`
 * saves them (on any other server the post simply fails).
 */

export interface BenchDeps {
  world: World;
  game: { enter(): Promise<void>; play(id: number): void };
  book: SpellBook;
  tracker: HandTracker;
  cast(spellId: string, side?: HandSide | 'both', detail?: string): void;
  feed(hands: HandFrame[], timestamp: number): void;
}

interface Window5 {
  level: number;
  /** In a diagnosis: what was taken away for this window. */
  phase?: string;
  t: number;
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  over20: number;
  over33: number;
  /** Main-thread milliseconds per frame spent in the world's update and draw submission. */
  cpu: number;
  /** Main-thread milliseconds per second spent in long tasks (anything > 50 ms). */
  longTask: number;
  calls: number;
  triangles: number;
  pixelRatio: number;
  /** Quality rung (0 = best) and the GPU's own milliseconds per frame, where measurable. */
  rung: number;
  gpuMs: number;
  /** GPU milliseconds per frame for each post pass, where measurable (diagnosis only). */
  passes?: Record<string, number>;
  post: boolean;
  width: number;
  height: number;
  geometries: number;
  textures: number;
  programs: number;
  heapMB: number;
  inferenceMs: number;
  inferenceFps: number;
  /** Camera frame to hand result, milliseconds. */
  latencyMs: number;
  enemies: number;
  particles: number;
}

interface Pass { enabled: boolean; render: (...args: unknown[]) => void }

interface Internals {
  renderer: THREE.WebGLRenderer;
  post: {
    enabled: boolean;
    setEnabled(enabled: boolean): void;
    setFeatures(features: { smaa: boolean; ink: boolean }): void;
    composer: { passes: Pass[] };
    ink: Pass | null; celLight: Pass | null; bloom: Pass; smaa: Pass; grade: Pass;
  };
  governor: { index: number; fixed: boolean; set(index: number): void };
  gpuTimer: { begin(): void; end(): void; available: boolean };
  moonCatcher: THREE.Object3D | null;
  applyQuality(): void;
  resize(): void;
  encounter: { player: { health: number; maxHealth: number } };
  particles: { live: number };
  frame: (...args: unknown[]) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const pct = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export async function runBench(deps: BenchDeps): Promise<void> {
  const params = new URLSearchParams(location.search);
  const diagnose = params.has('diagnose');
  const seconds = Number(params.get('bench')) || 30;
  const levels = (params.get('levels') ?? '3,11,22,33,48').split(',').map(Number).filter((id) => levelById(id));
  const warm = Number(params.get('warm') ?? (diagnose ? 6 : 3));
  const world = deps.world;
  const internals = world as unknown as Internals;
  const renderer = internals.renderer;
  const panel = overlay();
  const result = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: params.has('draws') ? 'draws' : diagnose ? 'diagnose' : 'bench',
    status: 'starting' as 'starting' | 'running' | 'done' | 'failed',
    env: environment(renderer),
    params: Object.fromEntries(params),
    windows: [] as Window5[],
    levels: [] as Array<Record<string, number | boolean>>,
    phases: [] as Window5[],
    draws: [] as Array<{ label: string; ms: number; draws: number; tris: number }>,
    tracker: { started: false, delegate: '', error: '' },
    casts: 0,
  };
  (window as unknown as { __arcaneBench: typeof result }).__arcaneBench = result;
  const upload = () => { void fetch('/__bench', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) }).catch(() => undefined); };

  // Tracking runs for its real cost; its (empty or real) detections are measured and set aside.
  let tracker: TrackerStats | null = null;
  let inferenceSum = 0, inferenceCount = 0, ageSum = 0;
  deps.tracker.onFrame = (_hands, stats) => { tracker = stats; inferenceSum += stats.inferenceMs; ageSum += stats.resultAgeMs; inferenceCount++; };
  if (params.get('camera') !== '0') {
    try {
      // Enter opens the camera (a failure is reported by the game and the run goes on without it).
      await deps.game.enter();
      result.tracker.started = true;
    } catch (error) {
      result.tracker.error = String(error);
    }
  }
  deps.book.setLearned(SPELLS.filter((s) => s.tier === 'legend').map((s) => s.id));

  // Main-thread cost of each world frame (update + draw submission).
  let cpuSum = 0;
  const frame = internals.frame.bind(world);
  internals.frame = (...args: unknown[]) => { const t0 = performance.now(); frame(...args); cpuSum += performance.now() - t0; };
  renderer.info.autoReset = false;

  // Per-pass GPU time (diagnosis, where timers exist). Timer queries cannot nest, so the world's
  // own frame timer stands down while the passes are timed one by one.
  const drawsMode = params.has('draws');
  const passTimer = diagnose && !drawsMode ? new PassTimer(renderer, internals) : null;

  let longTaskSum = 0;
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) longTaskSum += e.duration; }).observe({ type: 'longtask', buffered: false });
  } catch { /* not every browser reports long tasks */ }

  // Two synthetic hands at 30 frames a second, through the real gesture engine.
  const start = performance.now();
  let seed = 7;
  const jitter = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
  const handsTimer = params.get('hands') === '0' ? 0 : window.setInterval(() => {
    const now = performance.now();
    deps.feed(handsAt((now - start) / 1000, jitter), now);
  }, 1000 / 30);
  // Every spell in turn; cooldowns refuse some, as they would in play.
  const spellIds = SPELLS.map((s) => s.id);
  let spellIndex = 0;
  let casting = params.get('casts') !== '0';
  const castTimer = window.setInterval(() => {
    if (!casting) return;
    const id = spellIds[spellIndex++ % spellIds.length];
    deps.cast(id, spellIndex % 2 ? 'right' : 'left', id === 'spell-1' ? '90% draw' : 'left');
    result.casts++;
  }, 1100);
  // The caster never falls, so the fight goes on for the whole run.
  const lifeTimer = window.setInterval(() => { const p = internals.encounter.player; p.health = p.maxHealth; }, 250);

  // Frame sampling: runs after the world's own frame callback each frame.
  let frameTimes: number[] = [];
  let calls = 0, triangles = 0, rendered = 0;
  let lastStamp = 0;
  let sampling = true;
  const sample = (stamp: number) => {
    if (!sampling) return;
    if (lastStamp) frameTimes.push(stamp - lastStamp);
    lastStamp = stamp;
    calls += renderer.info.render.calls;
    triangles += renderer.info.render.triangles;
    rendered++;
    renderer.info.reset();
    passTimer?.poll();
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  const collect = (level: number, t: number, phase?: string): Window5 => {
    const sorted = frameTimes.slice().sort((a, b) => a - b);
    const total = frameTimes.reduce((s, v) => s + v, 0);
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const snapshot = world.snapshot();
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const passes = passTimer?.take();
    const w: Window5 = {
      level, phase, t: round(t),
      frames: frameTimes.length,
      fps: round(frameTimes.length / Math.max(0.001, total / 1000)),
      p50: round(pct(sorted, 0.5)), p95: round(pct(sorted, 0.95)), p99: round(pct(sorted, 0.99)), max: round(sorted[sorted.length - 1] ?? 0),
      over20: round(100 * frameTimes.filter((v) => v > 20).length / Math.max(1, frameTimes.length)),
      over33: round(100 * frameTimes.filter((v) => v > 34).length / Math.max(1, frameTimes.length)),
      cpu: round(cpuSum / Math.max(1, rendered), 2),
      longTask: round(longTaskSum / Math.max(0.001, total / 1000)),
      calls: Math.round(calls / Math.max(1, rendered)),
      triangles: Math.round(triangles / Math.max(1, rendered)),
      pixelRatio: round(renderer.getPixelRatio(), 3),
      rung: world.quality().rung,
      gpuMs: passes ? round(Object.values(passes).reduce((s, v) => s + v, 0), 2) : round(world.quality().gpuMs ?? 0, 2),
      passes,
      post: internals.post.enabled,
      width: size.x, height: size.y,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
      heapMB: memory ? round(memory.usedJSHeapSize / 1048576) : 0,
      inferenceMs: round(inferenceCount ? inferenceSum / inferenceCount : 0, 2),
      inferenceFps: round((tracker as TrackerStats | null)?.fps ?? 0),
      latencyMs: round(inferenceCount ? ageSum / inferenceCount : 0, 1),
      enemies: snapshot.alive,
      particles: internals.particles.live,
    };
    if (!passes) delete w.passes;
    frameTimes = []; calls = 0; triangles = 0; rendered = 0; cpuSum = 0; longTaskSum = 0; inferenceSum = 0; inferenceCount = 0; ageSum = 0;
    return w;
  };

  // A won fight goes straight on: the next run of the same level starts once the result is in.
  let restartAt = 0;
  const keepFighting = (id: number) => {
    const mode = world.snapshot().mode;
    if ((mode === 'won' || mode === 'lost' || mode === 'idle') && !restartAt) restartAt = performance.now() + 3500;
    if (restartAt && performance.now() >= restartAt) { deps.game.play(id); restartAt = 0; }
  };
  const run = async (id: number, ms: number) => {
    for (const end = performance.now() + ms; performance.now() < end;) { await sleep(Math.min(500, end - performance.now())); keepFighting(id); }
  };

  result.status = 'running';
  try {
    if (drawsMode) {
      // `?bench&draws`: GPU time of every draw call, grouped by what drew it (where timers exist).
      const id = levelById(Number(params.get('level'))) ? Number(params.get('level')) : 20;
      deps.game.play(id);
      const forced = params.get('rung');
      if (forced !== null) internals.governor.set(Number(forced));
      internals.governor.fixed = true;
      internals.applyQuality();
      panel.textContent = `Draw timing: level ${id}, warming up…`;
      await run(id, warm * 1000);
      const timer = new DrawTimer(renderer, internals);
      await run(id, (Number(params.get('phase')) || 10) * 1000);
      result.draws = timer.report();
      timer.dispose();
      panel.textContent = '';
      const pre = document.createElement('pre');
      pre.style.margin = '0';
      pre.textContent = ['GPU ms/frame · draws/frame · triangles/frame · what', ...result.draws.slice(0, 40).map((d) => `${String(d.ms).padStart(6)} ${String(d.draws).padStart(5)} ${String(d.tris).padStart(9)}  ${d.label}`)].join('\n');
      panel.append(pre);
    } else if (diagnose) {
      const id = levelById(Number(params.get('level'))) ? Number(params.get('level')) : 20;
      const phaseSeconds = Number(params.get('phase')) || 8;
      deps.game.play(id);
      // One quality level for the whole diagnosis, so each phase differs in one thing only.
      const forced = params.get('rung');
      if (forced !== null) internals.governor.set(Number(forced));
      internals.governor.fixed = true;
      internals.applyQuality();
      panel.textContent = `Diagnosis: level ${id}, warming up…`;
      await run(id, warm * 1000);
      const restore: Array<() => void> = [];
      const phases: Array<[string, () => void]> = [
        ['as is', () => undefined],
        ['no overlays', () => restore.push(hideOverlays(renderer.domElement, panel))],
        ['no shadows', () => { renderer.shadowMap.autoUpdate = false; if (internals.moonCatcher) internals.moonCatcher.visible = false; restore.push(() => internals.applyQuality()); }],
        ['no ink', () => { if (internals.post.ink) internals.post.ink.enabled = false; restore.push(() => internals.applyQuality()); }],
        ['no smaa', () => { internals.post.smaa.enabled = false; restore.push(() => internals.applyQuality()); }],
        ['no bloom', () => { internals.post.bloom.enabled = false; restore.push(() => { internals.post.bloom.enabled = true; }); }],
        ['post off', () => { internals.post.setEnabled(false); restore.push(() => internals.applyQuality()); }],
        ['half res', () => {
          const ratio = renderer.getPixelRatio();
          renderer.setPixelRatio(ratio * 0.5); internals.resize();
          restore.push(() => { renderer.setPixelRatio(ratio); internals.resize(); });
        }],
        ['no spells', () => { casting = false; restore.push(() => { casting = params.get('casts') !== '0'; }); }],
        ['as is (again)', () => undefined],
        ['no camera', () => { deps.tracker.stop(); }],
      ];
      for (const [name, apply] of phases) {
        apply();
        panel.textContent = `Diagnosis: ${name}…`;
        // Let the change settle (a resize, the last spell fading, compiles) before measuring.
        await run(id, name === 'no spells' ? 4000 : 2000);
        collect(id, 0);
        await run(id, phaseSeconds * 1000);
        const w = collect(id, (performance.now() - start) / 1000, name);
        result.phases.push(w);
        panel.textContent = `Diagnosis: ${name} · ${w.fps} fps · p95 ${w.p95} ms`;
        while (restore.length) restore.pop()!();
        upload();
      }
    } else {
      for (const id of levels) {
        deps.game.play(id);
        restartAt = 0;
        panel.textContent = `Benchmark: level ${id}, warming up…`;
        await sleep(warm * 1000);
        collect(id, 0);
        const begin = performance.now();
        while (performance.now() - begin < seconds * 1000) {
          await run(id, 5000);
          const w = collect(id, (performance.now() - start) / 1000);
          result.windows.push(w);
          panel.textContent = `Benchmark: level ${id} · ${w.fps} fps · p95 ${w.p95} ms · ${w.width}×${w.height} @${w.pixelRatio} · rung ${w.rung}${w.post ? '' : ' · post off'}`;
        }
        const mine = result.windows.filter((w) => w.level === id);
        const frames = mine.reduce((s, w) => s + w.frames, 0);
        const avg = (key: keyof Window5) => round(mine.reduce((s, w) => s + (w[key] as number) * w.frames, 0) / Math.max(1, frames), 2);
        result.levels.push({ level: id, fps: avg('fps'), p50: avg('p50'), p95: avg('p95'), p99: avg('p99'), over20: avg('over20'), over33: avg('over33'), cpu: avg('cpu'), calls: avg('calls'), triangles: avg('triangles'), inference: avg('inferenceMs'), tracking: avg('inferenceFps'), latency: avg('latencyMs'), longTask: avg('longTask'), pixelRatio: mine[mine.length - 1]?.pixelRatio ?? 0, post: mine[mine.length - 1]?.post ?? false });
        upload();
      }
    }
    result.status = 'done';
  } catch (error) {
    result.status = 'failed';
    result.tracker.error ||= String(error);
  } finally {
    sampling = false;
    window.clearInterval(handsTimer);
    window.clearInterval(castTimer);
    window.clearInterval(lifeTimer);
    passTimer?.dispose();
    renderer.info.autoReset = true;
  }
  result.tracker.delegate = (tracker as TrackerStats | null)?.delegate ?? 'none';
  if (!drawsMode) {
    panel.textContent = '';
    panel.append(diagnose ? phaseTable(result.phases, result.env) : table(result.levels));
  }
  upload();
  console.info('[arcane-bench]', JSON.stringify(result));
}

/** Hide everything drawn over the game's canvas (HUD, spell bar, screen effects); returns the undo. */
function hideOverlays(canvas: HTMLElement, keep: HTMLElement): () => void {
  const hidden: HTMLElement[] = [];
  for (let node: HTMLElement | null = canvas; node && node !== document.body; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement?.children ?? [])) {
      if (sibling === node || sibling === keep || !(sibling instanceof HTMLElement) || sibling.tagName === 'VIDEO' || sibling.tagName === 'SCRIPT') continue;
      if (sibling.style.visibility === 'hidden') continue;
      sibling.style.visibility = 'hidden';
      hidden.push(sibling);
    }
  }
  return () => { for (const el of hidden) el.style.visibility = ''; };
}

/**
 * GPU time per post pass, one timer query per pass per frame (EXT_disjoint_timer_query_webgl2).
 * With the post stack off, the whole frame is timed as `scene`.
 */
class PassTimer {
  private readonly gl: WebGL2RenderingContext | null;
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly pending: Array<{ label: string; query: WebGLQuery }> = [];
  private readonly free: WebGLQuery[] = [];
  private sums: Record<string, number> = {};
  private frames = 0;
  private readonly undo: Array<() => void> = [];

  constructor(renderer: THREE.WebGLRenderer, internals: Internals) {
    const context = renderer.getContext();
    this.gl = typeof WebGL2RenderingContext !== 'undefined' && context instanceof WebGL2RenderingContext ? context : null;
    this.ext = (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null) ?? null;
    if (!this.gl || !this.ext) return;
    const post = internals.post;
    const label = (pass: Pass, i: number) => i === 0 ? 'scene' : pass === post.ink ? 'ink' : pass === post.celLight ? 'cel' : pass === post.bloom ? 'bloom'
      : pass === post.smaa ? 'smaa' : pass === post.grade ? 'grade' : 'output';
    // The world's whole-frame timer stands down (queries cannot nest); post off is timed as `scene`.
    const timer = internals.gpuTimer;
    const begin = timer.begin, end = timer.end;
    let whole: WebGLQuery | null = null;
    timer.begin = () => { if (!post.enabled) whole = this.start(); };
    timer.end = () => { if (whole) { this.stop('scene', whole); whole = null; } this.frames++; };
    this.undo.push(() => { timer.begin = begin; timer.end = end; });
    post.composer.passes.forEach((pass, i) => {
      const render = pass.render;
      const name = label(pass, i);
      pass.render = (...args: unknown[]) => {
        const query = this.start();
        render.apply(pass, args);
        if (query) this.stop(name, query);
      };
      this.undo.push(() => { pass.render = render; });
    });
  }

  private start(): WebGLQuery | null {
    const gl = this.gl!, ext = this.ext!;
    if (this.pending.length > 400) return null;
    const query = this.free.pop() ?? gl.createQuery();
    if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    return query;
  }

  private stop(label: string, query: WebGLQuery): void {
    this.gl!.endQuery(this.ext!.TIME_ELAPSED_EXT);
    this.pending.push({ label, query });
  }

  poll(): void {
    const gl = this.gl, ext = this.ext;
    if (!gl || !ext) return;
    while (this.pending.length && gl.getQueryParameter(this.pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
      const { label, query } = this.pending.shift()!;
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT) && Number.isFinite(ns)) this.sums[label] = (this.sums[label] ?? 0) + ns / 1e6;
      this.free.push(query);
    }
  }

  /** Milliseconds per frame for each pass since the last call (undefined without timers). */
  take(): Record<string, number> | undefined {
    if (!this.gl || !this.ext) return undefined;
    const out: Record<string, number> = {};
    for (const [label, ms] of Object.entries(this.sums)) out[label] = round(ms / Math.max(1, this.frames), 2);
    this.sums = {};
    this.frames = 0;
    return out;
  }

  dispose(): void {
    while (this.undo.length) this.undo.pop()!();
  }
}

/** GPU time of every draw call, by render target and by the object and material that drew it. */
class DrawTimer {
  private readonly gl: WebGL2RenderingContext | null;
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly pending: Array<{ label: string; query: WebGLQuery }> = [];
  private readonly free: WebGLQuery[] = [];
  private readonly stats = new Map<string, { ms: number; draws: number; tris: number }>();
  private readonly targets = new WeakMap<object, string>();
  private readonly labels = new WeakMap<object, string>();
  private targetCount = 0;
  private frames = 0;
  private readonly undo: Array<() => void> = [];

  constructor(private readonly renderer: THREE.WebGLRenderer, internals: Internals) {
    const context = renderer.getContext();
    this.gl = typeof WebGL2RenderingContext !== 'undefined' && context instanceof WebGL2RenderingContext ? context : null;
    this.ext = (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null) ?? null;
    const timer = internals.gpuTimer;
    const begin = timer.begin, end = timer.end;
    timer.begin = () => undefined;
    timer.end = () => { this.frames++; this.poll(); };
    this.undo.push(() => { timer.begin = begin; timer.end = end; });
    if (!this.gl || !this.ext) return;
    type Draw = (camera: THREE.Camera, scene: THREE.Scene | null, geometry: THREE.BufferGeometry, material: THREE.Material, object: THREE.Object3D, group: unknown) => void;
    const r = renderer as unknown as { renderBufferDirect: Draw };
    const draw = r.renderBufferDirect;
    r.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      const query = this.pending.length < 4000 ? (this.free.pop() ?? this.gl!.createQuery()) : null;
      if (query) this.gl!.beginQuery(this.ext!.TIME_ELAPSED_EXT, query);
      draw.call(renderer, camera, scene, geometry, material, object, group);
      if (!query) return;
      this.gl!.endQuery(this.ext!.TIME_ELAPSED_EXT);
      const label = `${this.target()} · ${this.label(object, material)}`;
      this.pending.push({ label, query });
      const s = this.stats.get(label) ?? { ms: 0, draws: 0, tris: 0 };
      const index = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
      s.draws++;
      s.tris += Math.round(index / 3) * ((object as THREE.InstancedMesh).isInstancedMesh ? (object as THREE.InstancedMesh).count : 1);
      this.stats.set(label, s);
    };
    this.undo.push(() => { r.renderBufferDirect = draw; });
  }

  private target(): string {
    const rt = this.renderer.getRenderTarget();
    if (!rt) return 'canvas';
    let name = this.targets.get(rt);
    if (!name) { name = `rt${++this.targetCount} ${rt.width}x${rt.height}`; this.targets.set(rt, name); }
    return name;
  }

  private label(object: THREE.Object3D, material: THREE.Material): string {
    const key = `${material.uuid}`;
    const cached = this.labels.get(object);
    if (cached?.startsWith(key)) return cached.slice(key.length);
    const names: string[] = [];
    for (let o: THREE.Object3D | null = object; o; o = o.parent) if (o.name && names.length < 3) names.push(o.name);
    const shader = material as THREE.ShaderMaterial;
    const kind = shader.isShaderMaterial ? `Shader[${Object.keys(shader.uniforms ?? {}).filter((u) => !u.startsWith('u') || u.length > 2).slice(0, 4).join(',')}]` : material.type;
    const flags = `${material.transparent ? ' transparent' : ''}${material.depthTest ? '' : ' no-depth'}${material.blending === THREE.AdditiveBlending ? ' additive' : ''}`;
    const text = `${object.type}${names.length ? ` "${names.join(' < ')}"` : ''} ${kind}${material.name ? `(${material.name})` : ''}${flags}`;
    this.labels.set(object, key + text);
    return text;
  }

  private poll(): void {
    const gl = this.gl, ext = this.ext;
    if (!gl || !ext) return;
    while (this.pending.length && gl.getQueryParameter(this.pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
      const { label, query } = this.pending.shift()!;
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT) && Number.isFinite(ns)) { const s = this.stats.get(label); if (s) s.ms += ns / 1e6; }
      this.free.push(query);
    }
  }

  report(): Array<{ label: string; ms: number; draws: number; tris: number }> {
    const frames = Math.max(1, this.frames);
    return [...this.stats.entries()].map(([label, s]) => ({ label, ms: round(s.ms / frames, 3), draws: round(s.draws / frames, 1), tris: Math.round(s.tris / frames) }))
      .sort((a, b) => b.ms - a.ms);
  }

  dispose(): void {
    while (this.undo.length) this.undo.pop()!();
  }
}

function environment(renderer: THREE.WebGLRenderer) {
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    gpu: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${screen.width}x${screen.height}`,
    cores: navigator.hardwareConcurrency,
    memoryGB: nav.deviceMemory ?? 0,
    gpuTimer: Boolean((gl as WebGL2RenderingContext).getExtension?.('EXT_disjoint_timer_query_webgl2')),
  };
}

function overlay(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'bench-panel';
  Object.assign(el.style, {
    position: 'fixed', left: '8px', top: '8px', zIndex: '9999', padding: '6px 10px', maxWidth: 'calc(100vw - 16px)',
    background: 'rgba(0,0,0,0.72)', color: '#e9f2ea', font: '12px/1.4 ui-monospace, Menlo, Consolas, monospace',
    borderRadius: '6px', pointerEvents: 'none', whiteSpace: 'pre-wrap', overflowX: 'auto',
  });
  document.body.append(el);
  return el;
}

function table(rows: Array<Record<string, number | boolean>>): HTMLElement {
  const pre = document.createElement('pre');
  pre.style.margin = '0';
  const head = 'level   fps    p50    p95    p99  >20ms  >33ms   cpu  calls  track(ms/Hz)  ratio post';
  pre.textContent = ['Benchmark done', head, ...rows.map((r) => [
    String(r.level).padStart(5), String(r.fps).padStart(6), String(r.p50).padStart(6), String(r.p95).padStart(6), String(r.p99).padStart(6),
    `${r.over20}%`.padStart(6), `${r.over33}%`.padStart(6), String(r.cpu).padStart(5), String(r.calls).padStart(6),
    `${r.inference}/${r.tracking}`.padStart(13), String(r.pixelRatio).padStart(6), r.post ? ' on' : ' off',
  ].join(' '))].join('\n');
  return pre;
}

function phaseTable(rows: Window5[], env: { gpu: string; viewport: string; devicePixelRatio: number }): HTMLElement {
  const pre = document.createElement('pre');
  pre.style.margin = '0';
  const head = 'phase            fps    p50    p95  >20ms   cpu  track(ms)   gpu(ms)';
  pre.textContent = [`Diagnosis done · ${env.gpu} · ${env.viewport}@${env.devicePixelRatio} · ratio ${rows[0]?.pixelRatio ?? '?'}`, head, ...rows.map((r) => [
    (r.phase ?? '').padEnd(14), String(r.fps).padStart(6), String(r.p50).padStart(6), String(r.p95).padStart(6), `${r.over20}%`.padStart(6),
    String(r.cpu).padStart(5), String(r.inferenceMs).padStart(10), (r.gpuMs ? String(r.gpuMs) : '–').padStart(9),
  ].join(' '))].join('\n');
  return pre;
}
