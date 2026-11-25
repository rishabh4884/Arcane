import type { HandFrame, HandSide, Vec3 } from '../tracking/types.ts';

/**
 * Synthetic hands for benchmarks: the same anatomically plausible 21-landmark hand the unit tests
 * build (tests/helpers/synth.ts), in tracking space, so the whole gesture pipeline runs on it.
 */

type Finger = 'index' | 'middle' | 'ring' | 'pinky';
export type Extended = Partial<Record<Finger, boolean>>;

export const POSES: Record<string, Extended> = {
  fist: {},
  victory: { index: true, middle: true },
  horns: { index: true, pinky: true },
  point: { index: true },
  trident: { index: true, middle: true, ring: true },
  open: { index: true, middle: true, ring: true, pinky: true },
};

const PALM = 0.15;
const ASPECT = 4 / 3;
const SEGMENTS = [0.4, 0.22, 0.18];
const CURLED = [85, 185, 245];
const rad = (d: number) => (d * Math.PI) / 180;
const FINGERS: Array<[Finger, number, number]> = [['index', -0.3, 0.97], ['middle', -0.1, 1.0], ['ring', 0.1, 0.95], ['pinky', 0.28, 0.88]];
const THUMB = [[-0.2, 0.2], [-0.45, 0.45], [-0.65, 0.7], [-0.8, 0.9]];

export function makeHand(cx: number, cy: number, ext: Extended): Vec3[] {
  const local: Vec3[] = new Array(21);
  local[0] = { x: 0, y: 0, z: 0 };
  THUMB.forEach(([x, y], i) => (local[1 + i] = { x: x * PALM, y: y * PALM, z: 0 }));
  FINGERS.forEach(([name, dx, dy], f) => {
    const base = 5 + f * 4;
    let pos = { x: dx * PALM, y: dy * PALM, z: 0 };
    local[base] = pos;
    const extended = ext[name] ?? false;
    for (let k = 0; k < 3; k++) {
      const a = rad(extended ? 0 : CURLED[k]);
      pos = { x: pos.x, y: pos.y + Math.cos(a) * SEGMENTS[k] * PALM, z: pos.z + Math.sin(a) * SEGMENTS[k] * PALM };
      local[base + 1 + k] = pos;
    }
  });
  const ids = [0, 5, 9, 13, 17];
  const mx = ids.reduce((s, i) => s + local[i].x, 0) / ids.length;
  const my = ids.reduce((s, i) => s + local[i].y, 0) / ids.length;
  return local.map((p) => ({ x: cx + (p.x - mx), y: cy - (p.y - my), z: p.z }));
}

/**
 * A scripted pair of hands: both drift over the frame on slow Lissajous paths (the cursor sweeping
 * the wood) and every few seconds one of them holds a sign still, which the gesture engine
 * recognises and casts exactly as it would from the camera.
 */
export function handsAt(seconds: number, jitter: () => number): HandFrame[] {
  const time = seconds * 1000;
  const cycle = seconds % 6;
  const signs = ['victory', 'fist', 'horns', 'trident'];
  const sign = signs[Math.floor(seconds / 6) % signs.length];
  const frames: HandFrame[] = [];
  const add = (side: HandSide, x: number, y: number, pose: Extended) => {
    const landmarks = makeHand(x, y, pose).map((p) => ({ x: p.x + jitter() * 0.002, y: p.y + jitter() * 0.002, z: p.z + jitter() * 0.002 }));
    frames.push({ time, landmarks, aspect: ASPECT, confidence: 0.95, side });
  };
  // The left hand sweeps; in the last part of each cycle it rests, holding the cycle's sign.
  const holding = cycle > 4.2;
  const lx = holding ? 0.42 : 0.42 + Math.sin(seconds * 0.9) * 0.16;
  const ly = holding ? 0.5 : 0.5 + Math.sin(seconds * 1.3 + 0.7) * 0.14;
  add('left', lx, ly, holding ? POSES[sign] : POSES.open);
  // The right hand keeps aiming across the wood with an open palm, moving too steadily to hold a ward.
  add('right', 0.92 + Math.sin(seconds * 0.7 + 2) * 0.18, 0.48 + Math.cos(seconds * 1.1) * 0.15, POSES.open);
  return frames;
}
