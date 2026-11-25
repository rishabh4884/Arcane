import { describe, expect, it } from 'vitest';
import { CursorGlide } from '../src/world/cursorGlide.ts';

/** Feed a hand moving right at `speed` (screen widths a second), one result every `every` ms. */
function sweep(glide: CursorGlide, every: number, speed: number, until: number, from = 0.2): void {
  for (let t = 0; t <= until; t += every) glide.push({ x: from + speed * t / 1000, y: 0.5 }, t);
}

describe('cursor glide', () => {
  it('moves the marker on between results instead of stopping at each one', () => {
    const glide = new CursorGlide();
    sweep(glide, 66, 0.6, 660);                  // 15 results a second
    const out = { x: 0, y: 0 };
    const shown: number[] = [];
    for (let t = 660; t < 726; t += 16.7) shown.push(glide.at(t, out)!.x);
    // Every drawn frame between two results is further along than the one before.
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThan(shown[i - 1]);
    // And it is about where the hand really is, not where it was at the last result.
    expect(glide.at(710, out)!.x).toBeCloseTo(0.2 + 0.6 * 0.71, 2);
  });

  it('never carries on for more than one interval when results stop', () => {
    const glide = new CursorGlide();
    sweep(glide, 66, 0.6, 330);
    const out = { x: 0, y: 0 };
    const inOneInterval = glide.at(330 + 66, out)!.x;
    expect(glide.at(330 + 2000, out)!.x).toBeCloseTo(inOneInterval, 3);
  });

  it('settles quickly when the hand stops', () => {
    const glide = new CursorGlide();
    sweep(glide, 66, 0.6, 330);
    const stop = 0.2 + 0.6 * 0.33;
    glide.push({ x: stop, y: 0.5 }, 396);
    glide.push({ x: stop, y: 0.5 }, 462);
    const out = { x: 0, y: 0 };
    // At most a hair past the resting hand one result after it stopped.
    expect(glide.at(500, out)!.x - stop).toBeLessThan(0.01);
  });

  it('starts a returning or new hand still, and hides a hand that is gone', () => {
    const glide = new CursorGlide();
    const out = { x: 0, y: 0 };
    expect(glide.at(0, out)).toBeNull();
    glide.push({ x: 0.3, y: 0.4 }, 0);
    expect(glide.at(50, out)).toEqual({ x: 0.3, y: 0.4 });
    glide.push(null, 66);
    expect(glide.at(80, out)).toBeNull();
    glide.push({ x: 0.9, y: 0.4 }, 900);        // back after a pause: no speed from the jump
    expect(glide.at(950, out)).toEqual({ x: 0.9, y: 0.4 });
  });

  it('keeps the marker on screen', () => {
    const glide = new CursorGlide();
    sweep(glide, 66, 3, 264, 0.1);
    const out = { x: 0, y: 0 };
    expect(glide.at(330, out)!.x).toBeLessThanOrEqual(1);
  });
});
