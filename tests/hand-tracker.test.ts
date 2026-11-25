import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({
  resolveFiles: vi.fn(),
  create: vi.fn(),
  detect: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: model.resolveFiles },
  HandLandmarker: { createFromOptions: model.create },
}));

describe('camera inference recovery', () => {
  let deliverFrame: (now: number, metadata: { expectedDisplayTime: number; mediaTime: number }) => void;
  let clock: number;
  let video: Record<string, unknown>;
  let workerConstructor: ReturnType<typeof vi.fn>;
  let applyConstraints: ReturnType<typeof vi.fn>;
  let stopTrack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    workerConstructor = vi.fn(function () { throw new Error('The default path must not create a worker.'); });
    applyConstraints = vi.fn().mockResolvedValue(undefined);
    stopTrack = vi.fn();
    const track = {
      applyConstraints,
      getSettings: () => ({ frameRate: 30 }),
      stop: stopTrack,
    };
    const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
    video = {
      style: {},
      readyState: 4,
      currentTime: 0,
      videoWidth: 640,
      videoHeight: 480,
      play: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(),
      setAttribute: vi.fn(),
      requestVideoFrameCallback: vi.fn((callback) => { deliverFrame = callback; return 1; }),
      cancelVideoFrameCallback: vi.fn(),
    };
    vi.stubGlobal('document', {
      baseURI: 'https://arcane.test/',
      createElement: () => video,
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal('window', { location: { search: '' } });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
    vi.stubGlobal('Worker', workerConstructor);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    model.resolveFiles.mockResolvedValue({});
    model.create.mockResolvedValue({ detectForVideo: model.detect, close: model.close });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts with direct video inference on the page and creates no worker', async () => {
    const { HandTracker } = await import('../src/tracking/HandTracker.ts');
    const tracker = new HandTracker(60);
    await tracker.start();
    expect(workerConstructor).not.toHaveBeenCalled();
    expect(model.create).toHaveBeenCalledWith({}, expect.objectContaining({
      baseOptions: expect.objectContaining({ delegate: 'GPU' }),
      numHands: 2,
      runningMode: 'VIDEO',
    }));
    tracker.stop();
    expect(model.close).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('delivers a valid detection even when inference takes more than 180 ms', async () => {
    const { HandTracker } = await import('../src/tracking/HandTracker.ts');
    const tracker = new HandTracker(30);
    tracker.onFrame = vi.fn();
    model.detect.mockImplementation(() => {
      clock = 1320;
      return {
        landmarks: [Array.from({ length: 21 }, () => ({ x: 0.4, y: 0.5, z: 0 }))],
        handedness: [[{ categoryName: 'Left', score: 0.95 }]],
      };
    });
    await tracker.start();
    deliverFrame(1000, { expectedDisplayTime: 1000, mediaTime: 1 });

    expect(model.detect).toHaveBeenCalledWith(video, 1000);
    expect(tracker.onFrame).toHaveBeenCalledWith(
      [expect.objectContaining({ time: 1000, landmarks: expect.any(Array) })],
      expect.objectContaining({ detectedHands: 1, resultAgeMs: 320, lateResults: 1 }),
    );
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
    tracker.stop();
  });

  it('stays on the page while the page is fast enough', async () => {
    const { HandTracker } = await import('../src/tracking/HandTracker.ts');
    const tracker = new HandTracker(30);
    model.detect.mockImplementation(() => { clock += 4; return { landmarks: [], handedness: [] }; });
    await tracker.start();
    for (let i = 1; i <= 60; i++) deliverFrame(clock, { expectedDisplayTime: clock, mediaTime: i });
    expect(model.detect).toHaveBeenCalledTimes(60);
    expect(workerConstructor).not.toHaveBeenCalled();
    expect(tracker.usesGpu).toBe(true);
    tracker.stop();
  });

  it('moves a slow page model to a CPU worker, one frame at a time and always the newest, and says so', async () => {
    const posted: Array<{ type: string; delegates?: string[]; timestamp?: number }> = [];
    let worker: { onmessage: ((event: { data: unknown }) => void) | null } | null = null;
    workerConstructor = vi.fn(function (this: Record<string, unknown>) {
      this.postMessage = (message: { type: string }) => { posted.push(message); };
      this.terminate = vi.fn();
      this.onmessage = null;
      this.onerror = null;
      worker = this as unknown as typeof worker;
    });
    vi.stubGlobal('Worker', workerConstructor);
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));
    const { HandTracker } = await import('../src/tracking/HandTracker.ts');
    const tracker = new HandTracker(30);
    const moved = vi.fn();
    tracker.onInferenceMoved = moved;
    // 25 ms on the page: every camera frame would cost the game a missed refresh.
    model.detect.mockImplementation(() => { clock += 25; return { landmarks: [], handedness: [] }; });
    await tracker.start();
    for (let i = 1; i <= 30; i++) deliverFrame(clock, { expectedDisplayTime: clock, mediaTime: i });
    expect(workerConstructor).toHaveBeenCalledOnce();
    expect(posted[0]).toEqual(expect.objectContaining({ type: 'init', delegates: ['CPU', 'GPU'] }));
    // The page keeps tracking until the worker is ready.
    deliverFrame(clock, { expectedDisplayTime: clock, mediaTime: 31 });
    expect(model.detect).toHaveBeenCalledTimes(31);
    worker!.onmessage!({ data: { type: 'ready', delegate: 'CPU', wasmRoot: '' } });
    await Promise.resolve(); await Promise.resolve();
    expect(model.close).toHaveBeenCalled();
    expect(moved).toHaveBeenCalledWith(false);
    expect(tracker.usesGpu).toBe(false);
    // Camera frames now go to the worker, one at a time: the frames that arrive while it works are
    // not queued behind it.
    for (let i = 32; i <= 36; i++) deliverFrame(clock, { expectedDisplayTime: clock + i, mediaTime: i });
    await new Promise((r) => setTimeout(r, 0));
    const frames = () => posted.filter((m) => m.type === 'frame');
    expect(frames()).toHaveLength(1);
    expect(model.detect).toHaveBeenCalledTimes(31);
    // The moment it answers, it is handed the newest of them.
    const first = frames()[0].timestamp!;
    tracker.onFrame = vi.fn();
    worker!.onmessage!({ data: { type: 'result', timestamp: first, aspect: 4 / 3, inferenceMs: 40, landmarks: [], handedness: [] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(frames()).toHaveLength(2);
    expect(frames()[1].timestamp).toBeCloseTo(clock + 36);
    expect(tracker.onFrame).toHaveBeenCalledOnce();
    tracker.stop();
  });

  it('preserves the requested 30/60 FPS controls on the direct path', async () => {
    const { HandTracker } = await import('../src/tracking/HandTracker.ts');
    const tracker = new HandTracker(60);
    await tracker.start();
    await tracker.setFrameRate(30);
    expect(applyConstraints).toHaveBeenLastCalledWith({ frameRate: { ideal: 30, max: 30 } });
    await tracker.setFrameRate(60);
    expect(applyConstraints).toHaveBeenLastCalledWith({ frameRate: { ideal: 60, max: 60 } });
    tracker.stop();
  });
});
