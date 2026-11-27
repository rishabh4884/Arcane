import { LM, type Vec3 } from '../tracking/types.ts';
import { handDirection, palmCenter } from './features.ts';
import type { PoseName } from './poses.ts';

/** Two-hand shapes read from where the hands point and touch, not only from which fingers are out. */
export type ShapeName = 'inward' | 'heart' | 'cross' | 'screech';

export interface ShapeHand { landmarks: readonly Vec3[]; pose: PoseName }

const deg = (d: number) => Math.cos((d * Math.PI) / 180);
const gap = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The shape both hands make together, or null. `scale` is the mean palm length.
 * Angle bands never overlap, so one frame can only ever read as one shape:
 * inward is within 30° of level, a cross leans 20–55° off vertical, screech horns hang more than 45° down.
 */
export function detectShape(a: ShapeHand, b: ShapeHand, scale: number): ShapeName | null {
  const s = Math.max(scale, 1e-6);
  // Order by wrist on screen: the crossing hands and the inward palms are read left to right.
  const [L, R] = a.landmarks[LM.WRIST].x <= b.landmarks[LM.WRIST].x ? [a, b] : [b, a];
  const lw = L.landmarks[LM.WRIST], rw = R.landmarks[LM.WRIST];
  const ld = handDirection(L.landmarks), rd = handDirection(R.landmarks);
  const wrists = gap(lw, rw) / s;

  // Heart: index tips kiss above, thumb tips kiss below, wrists apart. Finger states blur here, so geometry only.
  const li = L.landmarks[LM.INDEX_TIP], ri = R.landmarks[LM.INDEX_TIP];
  const lt = L.landmarks[LM.THUMB_TIP], rt = R.landmarks[LM.THUMB_TIP];
  if (
    gap(li, ri) / s < 0.55 && gap(lt, rt) / s < 0.55 && wrists > 1 &&
    ((lt.y + rt.y) - (li.y + ri.y)) / 2 / s > 0.6
  ) return 'heart';

  if (L.pose === 'horns' && R.pose === 'horns' && ld.y > deg(45) && rd.y > deg(45)) return 'screech';
  if (L.pose !== 'open' || R.pose !== 'open') return null;

  // Inward: palms level, fingers of each hand pointing at the other hand.
  if (ld.x > deg(30) && rd.x < -deg(30)) return 'inward';

  // Cross: both lean upward on opposite diagonals and the palms overlap, the wrists do not.
  const lean = (d: { x: number; y: number }) => d.y < 0 && -d.y <= deg(20) && -d.y >= deg(55);
  if (
    lean(ld) && lean(rd) && ld.x > 0 && rd.x < 0 &&
    gap(palmCenter(L.landmarks), palmCenter(R.landmarks)) / s < 1.1 && wrists > 0.6
  ) return 'cross';
  return null;
}
