/**
 * The GPU's own time for a frame, where the browser exposes it (EXT_disjoint_timer_query_webgl2:
 * most desktop Chrome and Edge, many Android phones). Results arrive a frame or two late, which is
 * fine for steering quality. Elsewhere `ms` stays null and the governor relies on frame times alone.
 */
interface TimerExtension { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

export class GpuTimer {
  /** Latest measured GPU milliseconds, or null where it cannot be measured. */
  ms: number | null = null;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly ext: TimerExtension | null;
  private readonly pending: WebGLQuery[] = [];
  private readonly free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  constructor(context: WebGLRenderingContext | WebGL2RenderingContext) {
    this.gl = typeof WebGL2RenderingContext !== 'undefined' && context instanceof WebGL2RenderingContext ? context : null;
    this.ext = (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null) ?? null;
  }

  get available(): boolean { return this.ext !== null; }

  begin(): void {
    const gl = this.gl, ext = this.ext;
    if (!gl || !ext || this.active || this.pending.length > 4) return;
    const query = this.free.pop() ?? gl.createQuery();
    if (!query) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this.active = query;
  }

  end(): void {
    const gl = this.gl, ext = this.ext;
    if (!gl || !ext || !this.active) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Collect finished measurements; returns the latest GPU milliseconds (or null). */
  poll(): number | null {
    const gl = this.gl, ext = this.ext;
    if (!gl || !ext) return null;
    while (this.pending.length) {
      const query = this.pending[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.free.push(query);
      if (!disjoint && Number.isFinite(ns)) this.ms = ns / 1e6;
    }
    return this.ms;
  }

  dispose(): void {
    if (!this.gl) return;
    if (this.active && this.ext) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    for (const q of [...this.pending, ...this.free, ...(this.active ? [this.active] : [])]) this.gl.deleteQuery(q);
    this.pending.length = 0; this.free.length = 0; this.active = null;
  }
}
