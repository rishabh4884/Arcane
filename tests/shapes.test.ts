import { describe, expect, it } from 'vitest';
import { GESTURES } from '../src/config/gestures.ts';
import { handScale } from '../src/gestures/features.ts';
import { detectShape } from '../src/gestures/shapes.ts';
import { POSES, makeDuoDriver, makeHand, rotateHand, type HandSpec } from './helpers/synth.ts';

const { open, horns } = POSES;
const gestures = (...ids: string[]) => GESTURES.filter((g) => ids.includes(g.id));
const at = (x: number, ext: HandSpec['ext'], turn = 0, y = 0.5): HandSpec => ({ x, y, ext, turn });

/** Index fingers curled to meet above, thumbs pressed together below, wrists apart. */
function heart(): [HandSpec, HandSpec] {
  const shape = (x: number, turn: number, dx: number) => {
    const lm = rotateHand(makeHand(x, 0.5, open), turn);
    lm[8] = { x: 0.665 + dx, y: 0.4, z: 0 };
    lm[4] = { x: 0.665 + dx, y: 0.58, z: 0 };
    return { x, y: 0.5, ext: open, lm };
  };
  return [shape(0.55, 30, -0.004), shape(0.78, -30, 0.004)];
}

const SHAPES: Record<string, [HandSpec, HandSpec]> = {
  inward: [at(0.45, open, 90), at(0.9, open, -90)],
  cross: [at(0.62, open, 36), at(0.71, open, -36)],
  screech: [at(0.45, horns, 180), at(0.9, horns, 180)],
  heart: heart(),
};

const read = ([a, b]: [HandSpec, HandSpec], pose: 'open' | 'horns' = 'open') => {
  const hand = (h: HandSpec) => ({ landmarks: h.lm ?? rotateHand(makeHand(h.x, h.y, h.ext), h.turn ?? 0), pose: h.ext === horns ? 'horns' as const : pose });
  const L = hand(a), R = hand(b);
  return detectShape(L, R, (handScale(L.landmarks) + handScale(R.landmarks)) / 2);
};

describe('two-hand shapes', () => {
  it('reads each shape, and only that shape', () => {
    for (const [name, pair] of Object.entries(SHAPES)) expect(read(pair), name).toBe(name);
  });

  it('upright open hands and upright horns are no shape at all', () => {
    expect(read([at(0.45, open), at(0.9, open)])).toBeNull();
    expect(read([at(0.45, horns), at(0.9, horns)])).toBeNull();
    // Level palms pointing away from each other are not cupping a moon.
    expect(read([at(0.45, open, -90), at(0.9, open, 90)])).toBeNull();
  });

  it('casts each shape from the engine, never the sign it resembles', () => {
    const cases: Array<[string, string[]]> = [
      ['inward', ['crescent', 'eclipse', 'aegis']],
      ['cross', ['cross', 'eclipse', 'aegis']],
      ['screech', ['screech', 'maw']],
      ['heart', ['heart', 'aegis', 'eclipse']],
    ];
    const ids: Record<string, string> = { inward: 'crescent', cross: 'cross', screech: 'screech', heart: 'heart' };
    for (const [shape, live] of cases) {
      const d = makeDuoDriver(gestures(...live));
      d.hold(...SHAPES[shape], 1600);
      expect(d.log, shape).toEqual([`${ids[shape]}@both`]);
    }
  });

  it('hanging horns never open the Maw, even before Screech of Pain is learned', () => {
    const d = makeDuoDriver(gestures('maw'));
    d.hold(...SHAPES.screech, 1600);
    expect(d.log).toEqual([]);
    const up = makeDuoDriver(gestures('maw'));
    up.hold(at(0.45, horns), at(0.9, horns), 1600);
    expect(up.log).toEqual(['maw@both']);
  });

  it('level or crossed palms never fall back to Eclipse when their spell is not bound', () => {
    for (const shape of ['inward', 'cross']) {
      const d = makeDuoDriver(gestures('eclipse', 'aegis'));
      d.hold(...SHAPES[shape], 1600);
      expect(d.log, shape).toEqual([]);
    }
  });
});

describe('Aegis', () => {
  it('only charges on a raised palm, never a level one', () => {
    const level = makeDuoDriver(gestures('aegis'));
    level.hold(null, at(0.7, open, 90), 1600);
    level.hold(null, at(0.7, open, -80), 1600);
    expect(level.log).toEqual([]);
    const raised = makeDuoDriver(gestures('aegis'));
    raised.hold(null, at(0.7, open, 20), 1600);
    expect(raised.log).toEqual(['aegis@right']);
  });

  it('does not fire the moment a level palm is turned upright', () => {
    const d = makeDuoDriver(gestures('aegis'));
    d.hold(null, at(0.7, open, 90), 1500);
    d.hold(null, at(0.7, open, 0), 300);
    expect(d.log).toEqual([]);
  });
});
