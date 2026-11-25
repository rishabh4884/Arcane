import { describe, expect, it } from 'vitest';
import { QualityGovernor, ladderFor, rungFor, startingRung } from '../src/world/Quality.ts';

/** Feed `seconds` of frames at `ms` each (and optionally a GPU time); returns every rung change. */
function run(g: QualityGovernor, seconds: number, ms: number | (() => number), gpu: number | null = null): number[] {
  const changes: number[] = [];
  let t = 0;
  while (t < seconds) {
    const frame = typeof ms === 'function' ? ms() : ms;
    const change = g.sample(frame / 1000, gpu);
    if (change !== null) changes.push(change);
    t += frame / 1000;
  }
  return changes;
}

describe('quality ladder', () => {
  it('never renders above the screen density and collapses repeated rungs', () => {
    const one = ladderFor(1);
    expect(Math.max(...one.map((l) => l.ratio))).toBe(1);
    for (let i = 1; i < one.length; i++) expect(one[i]).not.toEqual(one[i - 1]);
    const retina = ladderFor(3);
    expect(retina[0].ratio).toBe(2);
    expect(retina[retina.length - 1].post).toBe(false);
    // Quality is only traded away going down: no feature comes back on a lower rung.
    for (let i = 1; i < retina.length; i++) {
      expect(retina[i].ratio).toBeLessThanOrEqual(retina[i - 1].ratio);
      for (const key of ['shadows', 'smaa', 'ink', 'post'] as const) if (!retina[i - 1][key]) expect(retina[i][key]).toBe(false);
    }
  });

  it('starts new devices at a modest density and maps the graphics modes', () => {
    const ladder = ladderFor(2);
    expect(ladder[startingRung(ladder, false)].ratio).toBe(1.5);
    expect(ladder[startingRung(ladder, true)].ratio).toBe(1.25);
    expect(rungFor('high', ladder, 4)).toBe(0);
    expect(ladder[rungFor('balanced', ladder, 0)].ratio).toBe(1);
    expect(ladder[rungFor('low', ladder, 0)].post).toBe(true);
    expect(rungFor('auto', ladder, 3)).toBe(3);
  });
});

describe('quality governor', () => {
  it('ignores invalid samples and holds the top level at a steady 60 fps', () => {
    const g = new QualityGovernor(ladderFor(2), 0);
    expect(g.sample(NaN)).toBeNull();
    expect(g.sample(-1)).toBeNull();
    expect(run(g, 20, 16.7)).toEqual([]);
    expect(g.index).toBe(0);
  });

  it('is not moved by hitches: compiles and collections', () => {
    const g = new QualityGovernor(ladderFor(2), 0);
    let n = 0;
    // 60 fps with a 300 ms stall every two seconds and a 40 ms one every thirtieth frame.
    const frames = () => (++n % 120 === 0 ? 300 : n % 30 === 0 ? 40 : 16.7);
    expect(run(g, 30, frames)).toEqual([]);
    expect(g.index).toBe(0);
  });

  it('counts frames that miss the display refresh, but blurs only when the GPU is the cause', () => {
    // On a 60 Hz display a late frame shows for two refreshes: a fifth of them late is a stutter.
    let n = 0;
    const stutter = () => (++n % 5 === 0 ? 33.3 : 16.7);
    const gpuBound = new QualityGovernor(ladderFor(2), 0);
    expect(run(gpuBound, 4, stutter, 15)[0]).toBe(1);        // the GPU is near its share: one rung down
    n = 0;
    const cpuBound = new QualityGovernor(ladderFor(2), 0);
    expect(run(cpuBound, 30, stutter, 4)).toEqual([]);      // the GPU is idle: resolution would not help
    // Without GPU timing it may try one step, and undoes it when frames do not improve.
    n = 0;
    const blind = new QualityGovernor(ladderFor(2), 2);
    run(blind, 30, stutter);
    expect(blind.index).toBe(2);
  });

  it('steps down under sustained GPU load, quickly when far too slow', () => {
    const g = new QualityGovernor(ladderFor(2), 0);
    const changes = run(g, 3.5, 45);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]).toBe(2);              // two rungs at once
    const slow = new QualityGovernor(ladderFor(2), 0);
    run(slow, 4, 22);
    expect(slow.index).toBe(1);              // one rung for moderately slow frames
  });

  it('does not step down for one bad window (a level loading, a burst of shader compiles)', () => {
    const g = new QualityGovernor(ladderFor(2), 0);
    expect(run(g, 1.6, 60, 90)).toEqual([]);  // one window of very slow frames and inflated GPU time
    expect(run(g, 20, 16.7, 6)).toEqual([]);
    expect(g.index).toBe(0);
  });

  it('does not blur the picture when the CPU, not the GPU, is what is slow', () => {
    const g = new QualityGovernor(ladderFor(2), 1);
    expect(run(g, 20, 26, 5)).toEqual([]);
    expect(g.index).toBe(1);
  });

  it('undoes a step down that did not make frames faster, and waits before trying again', () => {
    const g = new QualityGovernor(ladderFor(2), 1);
    const changes = run(g, 12, 26);          // no GPU timing; frames stay slow whatever the level
    expect(changes[0]).toBe(2);
    expect(changes[1]).toBe(1);              // back where it was
    expect(g.index).toBe(1);
    expect(run(g, 15, 26)).toEqual([]);      // resting
  });

  it('keeps a step down that helped', () => {
    const g = new QualityGovernor(ladderFor(2), 1);
    let level = g.index;
    let t = 0;
    while (t < 12) {
      const ms = level <= 1 ? 26 : 16.7;     // the lower rung is fast enough
      const change = g.sample(ms / 1000);
      if (change !== null) level = change;
      t += ms / 1000;
    }
    expect(g.index).toBe(2);
  });

  it('climbs back when there is headroom, and backs off when the climb fails', () => {
    const g = new QualityGovernor(ladderFor(2), 4);
    run(g, 30, 16.7, 4);
    expect(g.index).toBeLessThan(4);
    const climbing = new QualityGovernor(ladderFor(2), 3);
    let level = climbing.index;
    let t = 0, changes = 0;
    while (t < 60) {
      const ms = level < 3 ? 25 : 16.7;      // anything above rung 3 is too much for this device
      const change = climbing.sample(ms / 1000);
      if (change !== null) { level = change; changes++; }
      t += ms / 1000;
    }
    expect(climbing.index).toBe(3);
    expect(changes).toBeLessThanOrEqual(6); // a few probes a minute at most, not a flicker
  });

  it('leaves the GPU room for hand tracking while the camera is on', () => {
    // Frames a touch under 60 fps with the game taking 12 ms of GPU time a frame.
    const idle = new QualityGovernor(ladderFor(2), 3);
    expect(run(idle, 10, 17.6, 12)).toEqual([]);  // no camera: 12 ms is within its share
    const tracking = new QualityGovernor(ladderFor(2), 3);
    tracking.gpuShare = 0.6;
    expect(run(tracking, 10, 17.6, 12)[0]).toBe(4); // camera on: over its share, so it steps down
  });

  it('settles fast when the GPU is far over its share', () => {
    const g = new QualityGovernor(ladderFor(2), 0);
    g.gpuShare = 0.6;
    expect(run(g, 3.5, 26, 24)[0]).toBe(2);         // 2.4x over: two rungs at once
  });

  it('never jumps onto the last rung (post off): it must be slow on the rung above first', () => {
    const ladder = ladderFor(2);
    const last = ladder.length - 1;
    const g = new QualityGovernor(ladder, last - 2);
    g.gpuShare = 0.6;
    const changes = run(g, 3.5, 40, 30);
    expect(changes[0]).toBe(last - 1);               // a two-rung jump stops short of the bottom
    expect(ladder[g.index].post).toBe(true);
  });

  it('holds a fixed level whatever the frames say', () => {
    const g = new QualityGovernor(ladderFor(2), 3, true);
    expect(run(g, 10, 60)).toEqual([]);
    expect(g.index).toBe(3);
  });
});
