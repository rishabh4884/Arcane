import type { GestureDef } from '../config/gestures.ts';

/**
 * GESTURE DIAGRAMS
 * ────────────────
 * A small line-art hand that performs a gesture, built from the gesture's own data, so every sign,
 * sweep, sigil and two-hand motion in the library draws itself (and a rebinding redraws). Hands are
 * seen from behind, as the caster sees their own: the right hand's thumb sits on the left.
 * Motion is SMIL; with reduced motion the hand rests and the arrows carry the movement.
 */

type Shape = 'open' | 'fist' | 'point' | 'victory' | 'horns' | 'trident' | 'pinch';
type Pt = readonly [number, number];

const NS = 'http://www.w3.org/2000/svg';
const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
const LOOP = '2.6s';

/** Index, middle, ring, little: knuckle x, length, resting splay (degrees). */
const FINGERS = [[-10.5, 26, -8], [-3.5, 29, -2], [3.5, 27, 4], [10.5, 21, 10]] as const;
const RAISED: Record<Exclude<Shape, 'pinch'>, readonly number[]> = {
  open: [1, 1, 1, 1], fist: [0, 0, 0, 0], point: [1, 0, 0, 0], victory: [1, 1, 0, 0], horns: [1, 0, 0, 1], trident: [1, 1, 1, 0],
};
/** The index fingertip of an upright hand: what traces a sigil. */
const TIP: Pt = [FINGERS[0][0] + Math.sin(FINGERS[0][2] * Math.PI / 180) * FINGERS[0][1], -9 - Math.cos(FINGERS[0][2] * Math.PI / 180) * FINGERS[0][1]];

function node<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  n.append(...children);
  return n;
}

const line = (points: readonly Pt[]): string => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');

/** One hand, upright, wrist at y 35 and fingertips near y -38. */
function hand(shape: Shape, mirror = false): SVGGElement {
  const up = shape === 'pinch' ? [0, 0, 0, 0] : RAISED[shape];
  const splay = shape === 'victory' ? [-14, 8] : shape === 'horns' ? [-12, 0, 0, 16] : [];
  const fingers = FINGERS.map(([x, len, rest], i): readonly Pt[] => {
    if (!up[i]) return [[x, -9], [x, -13]];
    const a = (splay[i] ?? rest) * Math.PI / 180;
    return [[x, -9], [x + Math.sin(a) * len, -9 - Math.cos(a) * len]];
  });
  if (shape === 'pinch') fingers[0] = [[-10.5, -9], [-15, -18], [-21, -17]];
  const thumbOut = shape === 'open' || shape === 'pinch';
  const thumb: readonly Pt[] = shape === 'pinch' ? [[-13, 10], [-24, -4], [-21.5, -14]] : thumbOut ? [[-13, 10], [-27, -6]] : [[-11, 12], [-18.5, 1]];
  const bones = [...fingers, thumb].map(line).join('');
  const palm = 'M-15 -7Q-15 -11 -11 -11H11Q15 -11 15 -7V12Q15 22 6 25V35H-6V25Q-15 22 -15 12Z';
  return node('g', { class: 'gd-hand', transform: mirror ? 'scale(-1 1)' : '' },
    node('path', { class: 'gd-bone', d: bones }),
    node('path', { class: 'gd-flesh', d: bones }),
    node('path', { class: 'gd-palm', d: palm }));
}

/** A hand placed at a point, scaled, optionally offset so a given point of it sits on the origin. */
const place = (h: SVGGElement, [x, y]: Pt, scale: number, anchor: Pt = [0, 0]): SVGGElement =>
  node('g', { transform: `translate(${x} ${y}) scale(${scale}) translate(${-anchor[0]} ${-anchor[1]})` }, h);

function chevron([x, y]: Pt, angle: number): SVGPathElement {
  const c = Math.cos(angle), s = Math.sin(angle), p = (dx: number, dy: number): Pt => [x + dx * c - dy * s, y + dx * s + dy * c];
  return node('path', { class: 'gd-path', d: line([p(-6, -5), p(0, 0), p(-6, 5)]) });
}

/** A faint guide from a to b, with an arrowhead at b (and at a too when it goes both ways). */
function arrow(a: Pt, b: Pt, both = false): SVGGElement {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  return node('g', {}, node('path', { class: 'gd-path gd-dash', d: line([a, b]) }), chevron(b, angle), ...(both ? [chevron(a, angle + Math.PI)] : []));
}

/** Animate a group's position along a path; `points` and `times` are SMIL keyPoints/keyTimes. */
function travel(g: SVGGElement, path: string, points: string, times: string, splines: string): SVGGElement {
  if (!calm.matches) g.append(node('animateMotion', { path, dur: LOOP, repeatCount: 'indefinite', keyPoints: points, keyTimes: times, calcMode: 'spline', keySplines: splines }));
  return g;
}

function fade(g: SVGGElement, values: string, times: string): SVGGElement {
  if (!calm.matches) g.append(node('animate', { attributeName: 'opacity', values, keyTimes: times, dur: LOOP, repeatCount: 'indefinite' }));
  return g;
}

/** The hold ring: fills while the sign is held, flares when it casts. */
function ring(r: number, [x, y]: Pt = [0, 0]): SVGGElement {
  const fill = node('circle', { class: 'gd-ring', cx: x, cy: y, r, pathLength: 1, 'stroke-width': 3, 'stroke-dasharray': 1, 'stroke-dashoffset': calm.matches ? 0 : 1, transform: `rotate(-90 ${x} ${y})` });
  if (!calm.matches) {
    fill.append(node('animate', { attributeName: 'stroke-dashoffset', values: '1;1;0;0;1', keyTimes: '0;.12;.6;.92;1', dur: LOOP, repeatCount: 'indefinite' }));
    fill.append(node('animate', { attributeName: 'stroke-width', values: '3;3;3;7;3', keyTimes: '0;.6;.62;.72;1', dur: LOOP, repeatCount: 'indefinite' }));
  }
  return node('g', {}, node('circle', { class: 'gd-track', cx: x, cy: y, r }), fill);
}

const EASE = '0 0 1 1;.55 0 .25 1;0 0 1 1';
const SWEEP: Record<string, readonly [Pt, Pt]> = { up: [[0, 26], [0, -22]], down: [[0, -22], [0, 26]], left: [[38, 0], [-38, 0]], right: [[-38, 0], [38, 0]] };

function swipe(shape: Shape, direction: string): SVGElement[] {
  if (direction === 'horizontal') {
    const h = travel(node('g', {}, place(hand(shape), [0, 0], 1.05)), 'M-40 0L40 0', '0;0;1;1;0', '0;.15;.45;.6;1', `0 0 1 1;${EASE.split(';')[1]};0 0 1 1;.55 0 .25 1`);
    return [arrow([-62, 52], [62, 52], true), h];
  }
  const [a, b] = SWEEP[direction] ?? SWEEP.up;
  const h = fade(travel(node('g', {}, place(hand(shape), [0, 0], 1.05)), line([a, b]), '0;0;1;1', '0;.3;.55;1', EASE), '0;1;1;1;0;0', '0;.12;.3;.6;.78;1');
  const guide = direction === 'up' || direction === 'down' ? arrow([62, a[1] * 1.4], [62, b[1] * 1.4]) : arrow([a[0] * 1.5, 52], [b[0] * 1.5, 52]);
  if (calm.matches) h.setAttribute('transform', `translate(${a[0]} ${a[1]})`);
  return [guide, h];
}

function sigil(direction: 'any' | 'cw' | 'ccw'): SVGElement[] {
  // Raised so the hand, hanging below its fingertip, stays in frame at the bottom of the loop.
  const r = 38, cy = -14, sweep = direction === 'ccw' ? 0 : 1;
  const path = `M0 ${cy - r}A${r} ${r} 0 1 ${sweep} 0 ${cy + r}A${r} ${r} 0 1 ${sweep} 0 ${cy - r}`;
  const h = node('g', {}, place(hand('point'), [0, 0], 0.6, TIP));
  if (!calm.matches) h.append(node('animateMotion', { path, dur: LOOP, repeatCount: 'indefinite' }));
  else h.setAttribute('transform', `translate(0 ${cy - r})`);
  const heads = direction === 'any' ? [chevron([r, cy], Math.PI / 2), chevron([-r, cy], Math.PI / 2)] : [chevron([sweep ? r : -r, cy], Math.PI / 2)];
  return [node('circle', { class: 'gd-path gd-dash', cx: 0, cy, r }), ...heads, h];
}

const DUAL: Record<string, readonly [Pt, Pt]> = { apart: [[26, 6], [60, 6]], together: [[60, 6], [26, 6]], lift: [[42, 26], [42, -18]], drop: [[42, -18], [42, 26]] };

function twinMotion(motion: string): SVGElement[] {
  const [a, b] = DUAL[motion] ?? DUAL.apart;
  return [-1, 1].flatMap((side) => {
    const from: Pt = [a[0] * side, a[1]], to: Pt = [b[0] * side, b[1]];
    const h = fade(travel(node('g', {}, place(hand('open', side < 0), [0, 0], 0.82)), line([from, to]), '0;0;1;1', '0;.3;.6;1', EASE), '0;1;1;1;0;0', '0;.12;.3;.65;.8;1');
    if (calm.matches) h.setAttribute('transform', `translate(${from[0]} ${from[1]})`);
    const vertical = from[0] === to[0];
    return [arrow(vertical ? [from[0] + side * 30, from[1]] : [from[0], 50], vertical ? [to[0] + side * 30, to[1]] : [to[0], 50]), h];
  });
}

function bow(): SVGElement[] {
  const drawn = 52, rest = 0;
  const aim = place(hand('point', true), [-52, 4], 0.85);
  const pull = node('g', {}, place(hand('pinch'), [0, 4], 0.85, [-21, -15]));
  const string = node('line', { class: 'gd-path', x1: -46, y1: -4, x2: calm.matches ? drawn : rest, y2: 4 });
  const bolt = node('path', { class: 'gd-bolt', d: 'M-60 -20L-92 -34', opacity: 0 });
  if (!calm.matches) {
    const times = '0;.15;.62;.68;1', splines = '0 0 1 1;.4 0 .6 1;.7 0 1 1;0 0 1 1';
    pull.append(node('animateMotion', { path: `M${rest} 0L${drawn} 0`, dur: LOOP, repeatCount: 'indefinite', keyPoints: '0;0;1;0;0', keyTimes: times, calcMode: 'spline', keySplines: splines }));
    string.append(node('animate', { attributeName: 'x2', values: `${rest};${rest};${drawn};${rest};${rest}`, keyTimes: times, dur: LOOP, repeatCount: 'indefinite', calcMode: 'spline', keySplines: splines }));
    bolt.append(node('animate', { attributeName: 'opacity', values: '0;0;1;0', keyTimes: '0;.66;.7;.85', dur: LOOP, repeatCount: 'indefinite' }));
  } else pull.setAttribute('transform', `translate(${drawn} 0)`);
  return [string, bolt, aim, pull, arrow([8, 52], [56, 52])];
}

/** An animated diagram of how to perform a gesture. Decorative: the hint text says it in words. */
export function createGestureDiagram(g: GestureDef): SVGSVGElement {
  const parts: SVGElement[] =
    g.kind === 'pose' ? [ring(46), place(hand(g.pose), [0, 4], 1.15)]
    : g.kind === 'swipe' ? swipe(g.hand ?? (g.group === 'strike' ? 'fist' : 'open'), g.direction)
    : g.kind === 'circle' ? sigil(g.direction)
    : g.kind === 'dual-pose' ? [ring(34, [-46, 4]), ring(34, [46, 4]), place(hand(g.pose, true), [-46, 6], 0.82), place(hand(g.pose), [46, 6], 0.82)]
    : g.kind === 'dual-motion' ? twinMotion(g.motion)
    : bow();
  return node('svg', { class: `gesture-diagram gesture-diagram--${g.kind}`, viewBox: '-100 -72 200 144', 'aria-hidden': 'true', focusable: 'false' }, ...parts);
}
