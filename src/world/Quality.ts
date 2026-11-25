/**
 * QUALITY
 * ───────
 * How much the renderer draws, chosen per device and adjusted while the game runs.
 *
 * The ladder trades the least visible things first: render resolution above the screen's own
 * pixels (retina density), then down to one pixel per screen pixel, then the figures' real-time moon
 * shadows (their soft contact shadows remain), then edge anti-aliasing, then the inner ink lines,
 * and only at the very bottom the post stack itself.
 *
 * The governor watches frame times in short windows and moves one rung at a time. It is built so
 * that quality does not quietly drain away over a session:
 *
 * - one-off hitches (a shader compile, garbage collection, a slow camera frame, loading) are never
 *   counted: only steady frame time decides, and the slowest frames of each window are set aside;
 * - when the GPU's own time is known and is small, a slow frame is the CPU's, and lowering the
 *   resolution would only blur the picture: it does not step down;
 * - a step down that did not make frames faster is undone, and stepping down rests for a while;
 * - when frames are comfortably fast it climbs back, on probation, and backs off if the climb fails;
 * - the level a device settles on is remembered, so the next session starts there.
 */

/** One rung of the ladder: everything the renderer may trade for frame time. */
export interface QualityLevel {
  /** Render pixels per CSS pixel, before the screen's own density caps it. */
  ratio: number;
  /** The moon's real-time figure shadows (contact shadows under every figure remain). */
  shadows: boolean;
  /** Edge anti-aliasing (SMAA). */
  smaa: boolean;
  /** Inner ink lines inside the drawn figures (their outlines remain). */
  ink: boolean;
  /** The post stack: bloom, cel light, grade. Off only at the very bottom. */
  post: boolean;
}

const FULL = { shadows: true, smaa: true, ink: true, post: true };
const RUNGS: readonly QualityLevel[] = [
  { ratio: 2, ...FULL },
  { ratio: 1.75, ...FULL },
  { ratio: 1.5, ...FULL },
  { ratio: 1.25, ...FULL },
  { ratio: 1.1, ...FULL },
  { ratio: 1, ...FULL },
  { ratio: 1, ...FULL, shadows: false },
  { ratio: 0.9, ...FULL, shadows: false, smaa: false },
  { ratio: 0.85, ...FULL, shadows: false, smaa: false, ink: false },
  { ratio: 0.75, ...FULL, shadows: false, smaa: false, ink: false },
  { ratio: 0.75, shadows: false, smaa: false, ink: false, post: false },
];

/** The ladder for a screen: no rung renders above the screen's own density; repeats collapse. */
export function ladderFor(deviceRatio: number): QualityLevel[] {
  const cap = Math.max(0.75, Math.min(2, Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1));
  const out: QualityLevel[] = [];
  for (const rung of RUNGS) {
    const level = { ...rung, ratio: Math.min(rung.ratio, cap) };
    const last = out[out.length - 1];
    if (last && last.ratio === level.ratio && last.shadows === level.shadows && last.smaa === level.smaa && last.ink === level.ink && last.post === level.post) continue;
    out.push(level);
  }
  return out;
}

export type GraphicsMode = 'auto' | 'high' | 'balanced' | 'low';

/** The fixed rung for a chosen graphics mode (auto starts from `auto`). */
export function rungFor(mode: GraphicsMode, ladder: readonly QualityLevel[], auto: number): number {
  if (mode === 'high') return 0;
  if (mode === 'low') return Math.max(0, ladder.length - 2);
  if (mode === 'balanced') {
    const i = ladder.findIndex((l) => l.ratio <= 1);
    return i < 0 ? 0 : i;
  }
  return Math.max(0, Math.min(ladder.length - 1, auto));
}

/** Where a device with no history starts: at most 1.5× density (1.25× on phones), climbing if it can. */
export function startingRung(ladder: readonly QualityLevel[], phone: boolean): number {
  const limit = phone ? 1.25 : 1.5;
  const i = ladder.findIndex((l) => l.ratio <= limit + 1e-6);
  return i < 0 ? 0 : i;
}

/** Frame time aimed for: 60 frames a second. Faster displays are welcome but not chased. */
const TARGET_MS = 1000 / 60;
const WINDOW_SECONDS = 1.5;
const MIN_FRAMES = 20;

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function trimmedMean(values: number[], drop: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const keep = Math.max(1, Math.round(sorted.length * (1 - drop)));
  let sum = 0;
  for (let i = 0; i < keep; i++) sum += sorted[i];
  return sum / keep;
}

export class QualityGovernor {
  /** Current rung (0 = best). */
  index: number;
  /** Seconds the current rung has been held (for remembering it). */
  held = 0;
  private frames: number[] = [];
  private gpu: number[] = [];
  private windowTime = 0;
  private clock = 0;
  private settle = 0;
  private slowWindows = 0;
  private fastWindows = 0;
  /** A step down that has to prove it helped: the frame time before it, and windows left to judge. */
  private downTrial: { from: number; before: number; windows: number } | null = null;
  /** A step up on probation. */
  private upTrial: { from: number; windows: number } | null = null;
  private downRestUntil = 0;
  private downRest = 15;
  private readonly upRestUntil = new Map<number, number>();
  private readonly upBackoff = new Map<number, number>();

  /**
   * The share of a frame the renderer's GPU work may take. While the camera is tracking, hand
   * tracking runs its model on the same GPU every camera frame, and it can only start once the
   * game's queued work is done: a GPU kept nearly full makes every tracking frame wait, which both
   * slows tracking and stalls the game's next frame. Measured on a laptop GPU: keeping the game's
   * GPU time near 60% of the frame cut tracking stalls from 45 ms to 16 ms and frames over 33 ms
   * from a third to under 4%.
   */
  gpuShare = 0.85;

  constructor(readonly ladder: readonly QualityLevel[], start: number, public fixed = false) {
    this.index = Math.max(0, Math.min(ladder.length - 1, start));
  }

  get level(): QualityLevel { return this.ladder[this.index]; }

  /** Forget the current window (after a resize, a level change, loading or a hidden tab). */
  reset(settleSeconds = 0.75): void {
    this.frames = [];
    this.gpu = [];
    this.windowTime = 0;
    this.settle = Math.max(this.settle, settleSeconds);
  }

  /** Move to a rung directly (settings). */
  set(index: number): void {
    this.index = Math.max(0, Math.min(this.ladder.length - 1, index));
    this.slowWindows = this.fastWindows = 0;
    this.downTrial = this.upTrial = null;
    this.held = 0;
    this.reset();
  }

  /**
   * One rendered frame: the seconds since the previous one and, where the browser can measure it,
   * the GPU's own milliseconds for a recent frame. Returns the new rung when it changes.
   */
  sample(dt: number, gpuMs: number | null = null): number | null {
    if (!Number.isFinite(dt) || dt <= 0) return null;
    this.clock += dt;
    this.held += dt;
    if (this.fixed) return null;
    if (this.settle > 0) { this.settle -= dt; return null; }
    const ms = dt * 1000;
    // A frame over 100 ms is a hitch (compile, collection, a stalled tab), not the steady cost.
    if (ms <= 100) this.frames.push(ms);
    if (gpuMs !== null && Number.isFinite(gpuMs) && gpuMs > 0) this.gpu.push(gpuMs);
    this.windowTime += dt;
    if (this.windowTime < WINDOW_SECONDS) return null;
    if (this.frames.length < MIN_FRAMES) { this.reset(0); return null; }
    // The window's mean frame time, less its slowest 5% (a collection, a compile). Not more: on a
    // real display a frame that misses the refresh shows for two, so a fifth of frames missing it is
    // a visible stutter however fast the rest are. Whether resolution is what would fix it is for the
    // GPU's own time to say (below), or failing that, for a step down that has to prove it helped.
    const frame = trimmedMean(this.frames, 0.05);
    // The GPU's median: a burst of shader compiles or uploads inflates a few frames, not the middle.
    const gpu = this.gpu.length >= 5 ? median(this.gpu) : null;
    this.frames = [];
    this.gpu = [];
    this.windowTime = 0;
    return this.decide(frame, gpu);
  }

  private move(to: number): number {
    const from = this.index;
    this.index = Math.max(0, Math.min(this.ladder.length - 1, to));
    this.slowWindows = this.fastWindows = 0;
    this.held = 0;
    this.reset();
    return from === this.index ? -1 : this.index;
  }

  private decide(frame: number, gpu: number | null): number | null {
    const slow = frame > TARGET_MS * 1.12;         // under ~53 fps
    const verySlow = frame > TARGET_MS * 1.9;      // under ~32 fps
    const fast = frame <= TARGET_MS * 1.06;
    const budget = TARGET_MS * this.gpuShare;
    // A slow frame whose GPU time is well inside the budget is the CPU's: resolution will not help.
    const gpuBound = gpu === null || gpu > budget * 0.8;
    // Over its share of the GPU, the game is what holds frames (and tracking) back, even when the
    // frame rate only dips a little.
    const overBudget = gpu !== null && gpu > budget && frame > TARGET_MS * 1.04;

    // Judge a step down: if frames did not get faster, the GPU was not what held them back.
    if (this.downTrial) {
      this.downTrial.windows--;
      if (frame < this.downTrial.before * 0.93) {
        this.downTrial = null;
      } else if (this.downTrial.windows <= 0) {
        const back = this.downTrial.from;
        this.downTrial = null;
        // Each step down that did not help makes the next attempt wait longer (30 s … 4 min).
        this.downRest = Math.min(240, this.downRest * 2);
        this.downRestUntil = this.clock + this.downRest;
        const moved = this.move(back);
        return moved < 0 ? null : moved;
      } else {
        return null;
      }
    }
    // Judge a step up: a climb that made frames slow goes back down and waits longer next time.
    if (this.upTrial) {
      this.upTrial.windows--;
      if (slow || overBudget) {
        const back = this.upTrial.from;
        const rung = this.index;
        const wait = Math.min(240, (this.upBackoff.get(rung) ?? 15) * 2);
        this.upBackoff.set(rung, wait);
        this.upRestUntil.set(rung, this.clock + wait);
        this.upTrial = null;
        const moved = this.move(back);
        return moved < 0 ? null : moved;
      }
      if (this.upTrial.windows <= 0) this.upTrial = null;
    }

    if (((slow && gpuBound) || overBudget) && this.index < this.ladder.length - 1 && this.clock >= this.downRestUntil) {
      this.fastWindows = 0;
      this.slowWindows++;
      // Two slow windows in a row, always: one window can be a burst of compiles or a level loading.
      if (this.slowWindows >= 2) {
        const from = this.index;
        // Far too slow, or far over its GPU share: take two rungs at once so a weak device settles
        // in seconds, not minutes. Never jump onto the last rung (the post stack off): that one is
        // only taken from the rung above it, after that rung too has proved too slow.
        const over = gpu === null ? 1 : gpu / budget;
        const steps = verySlow || over > 1.4 ? 2 : 1;
        const lastWithPost = this.ladder.length - 2;
        const to = this.index < lastWithPost ? Math.min(this.index + steps, lastWithPost) : this.index + 1;
        const moved = this.move(to);
        if (moved < 0) return null;
        // Where the GPU's time is measured the step is known to be the GPU's; elsewhere it must prove it.
        if (gpu === null) this.downTrial = { from, before: frame, windows: 2 };
        return moved;
      }
      return null;
    }
    this.slowWindows = 0;

    // Room to climb: the next rung up costs up to a third more GPU time.
    const headroom = gpu === null ? true : gpu < budget * 0.7;
    if (fast && headroom && this.index > 0 && this.clock >= (this.upRestUntil.get(this.index - 1) ?? 0)) {
      this.fastWindows++;
      // Without GPU timing the only sign of headroom is a long run of fast frames.
      if (this.fastWindows >= (gpu === null ? 6 : 3)) {
        const from = this.index;
        const moved = this.move(this.index - 1);
        if (moved < 0) return null;
        this.upTrial = { from, windows: 2 };
        return moved;
      }
      return null;
    }
    this.fastWindows = 0;
    return null;
  }
}
