/**
 * CURSOR GLIDE
 * ────────────
 * Hand tracking delivers a new palm position 12–30 times a second, depending on the device; the
 * game draws 60. Easing the marker to each new position makes it move, stop, and move again at the
 * tracker's pace. Instead, between results the marker carries on at the hand's own speed (measured
 * from the last results), for at most one result's interval: it moves continuously, it stays a
 * little ahead of the last result rather than behind it, and it cannot run away if results stop.
 */
export class CursorGlide {
  private x = 0;
  private y = 0;
  private vx = 0;
  private vy = 0;
  private t = 0;
  private present = false;
  /** Recent time between results, ms. */
  private interval = 1000 / 30;

  /** A new tracked position (0…1 on screen), or null when the hand is not seen, at `now` ms. */
  push(point: { x: number; y: number } | null, now: number): void {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      this.present = false;
      this.vx = this.vy = 0;
      return;
    }
    const dt = now - this.t;
    if (!this.present || dt <= 0 || dt > MAX_GAP_MS) {
      // A hand appearing (or returning after a pause) starts still where it is.
      this.vx = this.vy = 0;
    } else {
      // The hand's speed between the last two results, lightly smoothed: the positions are already
      // filtered, and a long average would carry the marker past a hand that has stopped.
      const ix = (point.x - this.x) / dt, iy = (point.y - this.y) / dt;
      this.vx += (ix - this.vx) * VELOCITY_RESPONSE;
      this.vy += (iy - this.vy) * VELOCITY_RESPONSE;
      this.interval += (Math.min(dt, MAX_LEAD_MS) - this.interval) * 0.3;
    }
    this.x = point.x;
    this.y = point.y;
    this.t = now;
    this.present = true;
  }

  /** Where to show the hand at `now` ms (written into `out`), or null when it is not seen. */
  at(now: number, out: { x: number; y: number }): { x: number; y: number } | null {
    if (!this.present) return null;
    const lead = Math.max(0, Math.min(now - this.t, this.interval, MAX_LEAD_MS));
    out.x = clamp01(this.x + this.vx * lead);
    out.y = clamp01(this.y + this.vy * lead);
    return out;
  }
}

/** A gap longer than this is a pause, not the tracker's pace: no speed is carried across it. */
const MAX_GAP_MS = 250;
/** Never carry a position on for longer than this. */
const MAX_LEAD_MS = 100;
/** How much of each new speed reading is taken (1 = the latest reading alone). */
const VELOCITY_RESPONSE = 0.7;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
