import { loadJSON, saveJSON } from '../storage.ts';
import type { HandFrame } from './types.ts';

/** Must match the installed `@mediapipe/tasks-vision` version. */
const MEDIAPIPE_VERSION = '0.10.35';

/** Directory URLs must end with `/` or `new URL(file, dir)` drops the last path segment. */
const abs = (path: string): string => new URL(path, document.baseURI).href;

const WASM_ROOTS = [
  abs('mediapipe/wasm/'),
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm/`,
];
const MODEL_URLS = [
  abs('models/hand_landmarker.task'),
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
];
const LATE_RESULT_MS = 180;
/** Where this device's tracking settled last time ('worker' once the page proved too slow for it). */
const TRACKING_KEY = 'arcane.tracking.v1';
/**
 * Inference on the page blocks the game's frame while it runs. Above this (the median of recent
 * camera frames), the model moves to a worker: a frame that waits 10 ms or more for the hand model
 * misses the display's refresh.
 */
const SLOW_MAIN_THREAD_MS = 10;

type Delegate = 'GPU' | 'CPU' | 'main-thread' | 'loading';
interface WorkerReady { type: 'ready'; delegate: 'GPU' | 'CPU'; wasmRoot: string }
interface WorkerResult {
  type: 'result';
  timestamp: number;
  aspect: number;
  inferenceMs: number;
  landmarks: Array<Array<{ x: number; y: number; z: number }>>;
  handedness: Array<{ categoryName: string; score: number } | null>;
}
interface WorkerError { type: 'error'; message: string; fatal?: boolean }
interface WorkerDropped { type: 'dropped' }
type WorkerMessage = WorkerReady | WorkerResult | WorkerError | WorkerDropped;

export interface TrackerStats {
  /** Measured rate of completed MediaPipe inferences, not render FPS. */
  fps: number;
  /** Current camera-track rate reported by the browser. */
  cameraFps: number;
  /** User-selected camera cap (30 or 60). */
  requestedFps: 30 | 60;
  /** Raw detections before identity binding. */
  detectedHands: number;
  /** Wall-clock time for the latest inference (worker or compatibility fallback). */
  inferenceMs: number;
  /** Age of the captured video frame when its result was consumed. */
  resultAgeMs: number;
  /** Slow results are reported for diagnosis, not converted into missing hands. */
  lateResults: number;
  /** Captured-frame timestamp used by MediaPipe and the gesture engine. */
  timestamp: number;
  /** Selected MediaPipe delegate after initialization. */
  delegate: Delegate;
}

type FrameMetadata = { expectedDisplayTime: number; mediaTime: number; captureTime?: number };
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: FrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

/**
 * MediaPipe runs on the page first, where a fast device (Apple silicon) answers within a few
 * milliseconds and with the least delay. On the page, though, its inference blocks the game's frame
 * for as long as it runs, and on most other devices that is 16-80 ms: every camera frame then cost
 * the game a missed refresh. When the page is measured to be too slow, the model moves to a worker
 * and runs on the CPU there, so it neither blocks the game's frames nor competes for its GPU; the
 * device remembers this. `?tracking=main|worker` and `?delegate=cpu|gpu` choose by hand. Neither
 * path suppresses valid hands solely because inference was slow.
 */
export class HandTracker {
  onFrame: (hands: HandFrame[], stats: TrackerStats) => void = () => {};
  /** Called when the model starts running somewhere else (with whether it now uses the GPU). */
  onInferenceMoved: (usesGpu: boolean) => void = () => {};

  /** Whether the hand model runs on the GPU (shared with the game's rendering). */
  get usesGpu(): boolean {
    if (this.landmarker) return this.mainDelegate === 'GPU';
    if (this.worker) return this.delegate === 'GPU';
    return false;
  }

  private readonly video: VideoWithFrameCallback = document.createElement('video');
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private workerReady: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private running = false;
  private busy = false;
  private raf = 0;
  private videoFrameCallback = 0;
  private lastVideoTime = -1;
  private lastTimestamp = 0;
  private fps = 0;
  private inferenceMs = 0;
  private resultAgeMs = 0;
  private lateResults = 0;
  private delegate: TrackerStats['delegate'] = 'loading';
  /** The page's own delegate, when the model runs on the page. */
  private mainDelegate: 'GPU' | 'CPU' = 'GPU';
  /** Frames handed to the worker and not yet answered. */
  private inFlight = 0;
  /**
   * One frame at a time: a second frame queued behind the one being read would wait a whole inference
   * and arrive that much older. Instead, the moment the worker is free it is handed the newest frame
   * the camera has delivered meanwhile. (`?trackq=2` queues one, for comparison.)
   */
  private readonly maxInFlight = new URLSearchParams(window.location.search).get('trackq') === '2' ? 2 : 1;
  /** The newest camera frame not yet handed to the worker. */
  private newest: { videoTime: number; displayTime: number; capturedAt: number } | null = null;
  /** When each frame in the worker was captured (by its timestamp), to measure the true delay. */
  private readonly capturedAt = new Map<number, number>();
  private switching = false;
  private readonly recent: number[] = [];
  private modelBuffer: Uint8Array | null = null;
  private landmarker: import('@mediapipe/tasks-vision').HandLandmarker | null = null;
  private requestedFps: 30 | 60;
  private frameRateApply: Promise<void> = Promise.resolve();

  constructor(requestedFps: 30 | 60 = 30) {
    this.requestedFps = requestedFps;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.lastVideoTime = -1;
    this.lastTimestamp = 0;
    this.lastDeliveredTimestamp = 0;
    this.fps = 0;
    this.inferenceMs = 0;
    this.resultAgeMs = 0;
    this.lateResults = 0;
    this.delegate = 'loading';
    await this.openCamera();
    try {
      await this.loadModel();
    } catch (error) {
      this.stopCamera();
      this.closeInference();
      throw error;
    }
    this.running = true;
    this.schedule();
  }

  /** Change the requested camera cap without tearing down MediaPipe or the active tracks. */
  setFrameRate(fps: 30 | 60): Promise<void> {
    this.requestedFps = fps;
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return Promise.resolve();
    this.frameRateApply = this.frameRateApply
      .catch(() => undefined)
      .then(() => track.applyConstraints({ frameRate: { ideal: fps, max: fps } }));
    return this.frameRateApply;
  }

  stop(): void {
    this.running = false;
    this.busy = false;
    this.inFlight = 0;
    this.newest = null;
    this.capturedAt.clear();
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.videoFrameCallback) this.video.cancelVideoFrameCallback?.(this.videoFrameCallback);
    this.raf = 0;
    this.videoFrameCallback = 0;
    this.recent.length = 0;
    this.closeInference();
    this.stopCamera();
  }

  private async openCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException('Camera access needs a secure (https) page.', 'SecurityError');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 480, max: 640 },
        height: { ideal: 360, max: 480 },
        frameRate: { ideal: this.requestedFps, max: this.requestedFps },
      },
    });
    const v = this.video;
    v.srcObject = this.stream;
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('aria-hidden', 'true');
    Object.assign(v.style, {
      position: 'fixed',
      width: '2px',
      height: '2px',
      opacity: '0',
      pointerEvents: 'none',
      left: '0',
      top: '0',
    });
    document.body.appendChild(v);
    await v.play();
  }

  private async loadModel(): Promise<void> {
    let model: Uint8Array | null = null;
    let lastError: unknown;
    for (const url of MODEL_URLS) {
      try {
        model = await loadModelBuffer(url);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!model) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
      throw new Error(`Could not fetch the hand model (${detail}).`, { cause: lastError });
    }

    this.modelBuffer = model;
    const mode = trackingMode();
    if (mode === 'main' || (mode === 'auto' && loadJSON<string>(TRACKING_KEY) !== 'worker')) {
      await this.initializeMainThread(model);
      return;
    }
    try {
      if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') {
        throw new Error('This browser cannot transfer camera frames to a worker.');
      }
      await this.initializeWorker(model);
    } catch (error) {
      if (!this.stream) throw error;
      console.warn('[arcane] worker inference unavailable; using main-thread fallback.', error);
      this.closeInference();
      await this.initializeMainThread(model);
    }
  }

  private async initializeWorker(model: Uint8Array): Promise<void> {
    const worker = new Worker(new URL('./hand-landmarker.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.workerReady = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.handleWorkerMessage(event.data);
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The hand-tracking worker stopped unexpectedly.');
      this.readyReject?.(error);
      this.readyReject = null;
      if (this.worker === worker && this.running) {
        this.worker = null;
        worker.terminate();
        this.busy = false;
        this.inFlight = 0;
        void this.initializeMainThread(this.modelBuffer ?? model).then(() => this.schedule()).catch((fallbackError: unknown) => {
          console.error('[arcane] main-thread inference fallback failed', fallbackError);
          this.running = false;
        });
      }
    };
    const modelBuffer = model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength);
    worker.postMessage({ type: 'init', wasmRoots: WASM_ROOTS, modelBuffer, delegates: workerDelegates() }, [modelBuffer]);
    try {
      await this.workerReady;
    } finally {
      this.workerReady = null;
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  private async initializeMainThread(model: Uint8Array): Promise<void> {
    const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
    const target = window as Window & { dbg?: unknown };
    if (typeof target.dbg !== 'function') target.dbg = (...args: unknown[]) => console.debug(...args);
    let lastError: unknown;
    for (const wasmRoot of WASM_ROOTS) {
      for (const delegate of mainDelegates()) {
        try {
          const vision = await FilesetResolver.forVisionTasks(wasmRoot);
          this.landmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetBuffer: model, delegate },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
          this.delegate = 'main-thread';
          this.mainDelegate = delegate;
          return;
        } catch (error) {
          lastError = error;
          this.landmarker?.close();
          this.landmarker = null;
        }
      }
    }
    throw new Error(`Could not initialize main-thread hand tracking (${String(lastError)}).`, { cause: lastError });
  }

  private schedule(): void {
    if (!this.running || this.busy || this.videoFrameCallback || this.raf) return;
    if (this.video.requestVideoFrameCallback) {
      this.videoFrameCallback = this.video.requestVideoFrameCallback((now, metadata) => {
        this.videoFrameCallback = 0;
        // The camera's own capture time where the browser gives it; otherwise when the frame arrived.
        this.tick(metadata.expectedDisplayTime, metadata.mediaTime, metadata.captureTime ?? now);
      });
    } else {
      this.raf = requestAnimationFrame((now) => {
        this.raf = 0;
        this.tick(now, this.video.currentTime, now);
      });
    }
  }

  private tick(displayTime: number, videoTime: number, capturedAt: number): void {
    if (!this.running || this.busy || (!this.worker && !this.landmarker) || this.video.readyState < 2) {
      this.schedule();
      return;
    }
    if (videoTime === this.lastVideoTime) {
      this.schedule();
      return;
    }

    if (!this.landmarker) {
      // To the worker: now if it is free, or the moment it is (see maxInFlight).
      this.newest = { videoTime, displayTime, capturedAt };
      if (this.inFlight < this.maxInFlight) this.sendNewest();
      this.schedule();
      return;
    }

    this.lastVideoTime = videoTime;
    const timestamp = Math.max(displayTime, this.lastTimestamp + 0.01);
    this.lastTimestamp = timestamp;
    const aspect = this.video.videoWidth / this.video.videoHeight || 4 / 3;
    // Straight away: the camera frame arrives just before the world's own frame, when the GPU has
    // the least of the game's work queued ahead of the model's. (Measured: deferring inference
    // until after the world's frame made it wait behind that whole frame and halved tracking.)
    this.busy = true;
    this.inferOnMainThread(timestamp, aspect, capturedAt);
  }

  /** Hand the worker the newest camera frame it has not seen. */
  private sendNewest(): void {
    const worker = this.worker;
    const next = this.newest;
    if (!this.running || !worker || !next || next.videoTime === this.lastVideoTime || this.video.readyState < 2) return;
    this.newest = null;
    this.lastVideoTime = next.videoTime;
    const timestamp = Math.max(next.displayTime, this.lastTimestamp + 0.01);
    this.lastTimestamp = timestamp;
    const aspect = this.video.videoWidth / this.video.videoHeight || 4 / 3;
    this.capturedAt.set(timestamp, next.capturedAt);
    this.inFlight++;
    void createImageBitmap(this.video).then((frame) => {
      if (!this.running || !worker || this.worker !== worker) {
        frame.close();
        this.inFlight = Math.max(0, this.inFlight - 1);
        return;
      }
      worker.postMessage({
        type: 'frame',
        frame,
        timestamp,
        aspect,
      }, [frame]);
    }).catch((error: unknown) => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.capturedAt.delete(timestamp);
      console.warn('[arcane] could not transfer camera frame to worker', error);
    });
  }

  /** The worker answered (or gave a frame up): free a place, and hand it the newest frame at once. */
  private workerFree(timestamp?: number): number | undefined {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const captured = timestamp === undefined ? undefined : this.capturedAt.get(timestamp);
    if (timestamp !== undefined) this.capturedAt.delete(timestamp);
    if (this.capturedAt.size > 8) this.capturedAt.clear();
    this.sendNewest();
    return captured;
  }

  private inferOnMainThread(timestamp: number, aspect: number, capturedAt = timestamp): void {
    if (!this.running || !this.landmarker) { this.busy = false; return; }
    const started = performance.now();
    try {
      const result = this.landmarker.detectForVideo(this.video, timestamp);
      const elapsed = performance.now() - started;
      this.judgeMainThread(elapsed);
      this.deliverResult(
        timestamp,
        capturedAt,
        aspect,
        elapsed,
        result.landmarks.map((hand) => hand.map(({ x, y, z }) => ({ x, y, z }))),
        result.handedness.map((categories) => categories[0]
          ? { categoryName: categories[0].categoryName, score: categories[0].score }
          : null),
      );
    } catch (error) {
      console.warn('[arcane] main-thread inference failed', error);
      this.busy = false;
    }
    this.schedule();
  }

  /** On the page and choosing automatically: move to a worker once the page proves too slow. */
  private judgeMainThread(ms: number): void {
    if (trackingMode() !== 'auto' || this.switching || this.worker) return;
    this.recent.push(ms);
    if (this.recent.length > 30) this.recent.shift();
    if (this.recent.length < 30) return;
    const sorted = this.recent.slice().sort((a, b) => a - b);
    if (sorted[15] > SLOW_MAIN_THREAD_MS) void this.moveToWorker();
  }

  private async moveToWorker(): Promise<void> {
    if (this.switching || this.worker || !this.modelBuffer || typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') return;
    this.switching = true;
    try {
      // The page keeps tracking while the worker starts; the switch happens once it is ready.
      await this.initializeWorker(this.modelBuffer);
      if (!this.running || !this.worker) return;
      this.landmarker?.close();
      this.landmarker = null;
      saveJSON(TRACKING_KEY, 'worker');
      this.onInferenceMoved(this.usesGpu);
    } catch (error) {
      console.warn('[arcane] hand tracking could not move to a worker; it stays on the page.', error);
      // (Typed afresh: the guard above narrowed it, but initialization assigned it meanwhile.)
      const worker = this.worker as Worker | null;
      if (worker) { worker.terminate(); this.worker = null; }
      this.inFlight = 0;
    } finally {
      this.switching = false;
      this.recent.length = 0;
    }
  }

  private handleWorkerMessage(message: WorkerMessage): void {
    if (message.type === 'ready') {
      this.delegate = message.delegate;
      this.readyResolve?.();
      return;
    }
    if (message.type === 'dropped') {
      this.workerFree();
      return;
    }
    if (message.type === 'error') {
      if (message.fatal) {
        this.readyReject?.(new Error(`Could not initialize MediaPipe in a worker: ${message.message}`));
        return;
      }
      console.warn('[arcane] MediaPipe skipped a frame', message.message);
      this.workerFree();
      this.schedule();
      return;
    }

    const captured = this.workerFree(message.timestamp);
    this.deliverResult(
      message.timestamp,
      captured ?? message.timestamp,
      message.aspect,
      message.inferenceMs,
      message.landmarks,
      message.handedness,
    );
    this.schedule();
  }

  private deliverResult(
    timestamp: number,
    capturedAt: number,
    aspect: number,
    inferenceMs: number,
    detections: Array<Array<{ x: number; y: number; z: number }>>,
    handedness: Array<{ categoryName: string; score: number } | null>,
  ): void {
    this.busy = false;
    // From the camera's capture (where known) to this result: what the player feels as delay.
    const ageMs = Math.max(0, performance.now() - capturedAt);
    this.resultAgeMs = ageMs;
    if (ageMs > LATE_RESULT_MS) this.lateResults += 1;
    const elapsed = timestamp - this.lastDeliveredTimestamp;
    this.lastDeliveredTimestamp = timestamp;
    if (elapsed >= 1000) {
      this.fps = 0;
    } else if (elapsed > 0) {
      const sampleFps = 1000 / elapsed;
      this.fps = this.fps === 0 ? sampleFps : this.fps + (sampleFps - this.fps) * 0.18;
    }
    this.inferenceMs = inferenceMs;
    const hands: HandFrame[] = detections.flatMap((landmarks, index) => {
      if (landmarks.length !== 21) return [];
      const handed = handedness[index];
      return [{
        time: timestamp,
        aspect,
        confidence: handed?.score ?? 1,
        side: parseSide(handed?.categoryName),
        // Preserve the previous mirror coordinate system for gesture thresholds.
        landmarks: landmarks.map((point) => ({
          x: (1 - point.x) * aspect,
          y: point.y,
          z: point.z * aspect,
        })),
      }];
    });
    const track = this.stream?.getVideoTracks()[0];
    this.onFrame(hands, {
      fps: this.fps,
      cameraFps: track?.getSettings().frameRate ?? 0,
      requestedFps: this.requestedFps,
      detectedHands: detections.length,
      inferenceMs,
      resultAgeMs: ageMs,
      lateResults: this.lateResults,
      timestamp,
      delegate: this.delegate,
    });
  }

  private closeInference(): void {
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'close' });
      } catch {
        // terminate below is authoritative if the worker is already shutting down
      }
      this.worker.terminate();
      this.worker = null;
    }
    this.landmarker?.close();
    this.landmarker = null;
    this.readyReject?.(new Error('Hand tracking stopped before initialization completed.'));
    this.readyReject = null;
    this.readyResolve = null;
  }

  private stopCamera(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.video.remove();
  }

  private lastDeliveredTimestamp = 0;
}

/** `?tracking=main|worker` holds tracking in one place; otherwise it is chosen per device. */
function trackingMode(): 'main' | 'worker' | 'auto' {
  const mode = new URLSearchParams(window.location.search).get('tracking')?.toLowerCase();
  return mode === 'main' || mode === 'worker' ? mode : 'auto';
}

function delegateParam(): 'cpu' | 'gpu' | null {
  const value = new URLSearchParams(window.location.search).get('delegate')?.toLowerCase();
  return value === 'cpu' || value === 'gpu' ? value : null;
}

/** On the page: GPU first (fastest where the page is fast enough at all); `?delegate=cpu` tries the CPU first. */
function mainDelegates(): Array<'GPU' | 'CPU'> {
  return delegateParam() === 'cpu' ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
}

/**
 * In a worker: CPU first. There the model neither blocks the game nor waits behind its frames on the
 * GPU (measured on a laptop GPU at 1920x1200: 56 fps with 5% late frames, against 45 fps and 27% with
 * the model on the GPU). `?delegate=gpu` tries the GPU first.
 */
function workerDelegates(): Array<'GPU' | 'CPU'> {
  return delegateParam() === 'gpu' ? ['GPU', 'CPU'] : ['CPU', 'GPU'];
}

async function loadModelBuffer(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model fetch failed (${response.status}) from ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** MediaPipe labels handedness assuming the camera image is already mirrored. */
function parseSide(label: string | undefined): HandFrame['side'] {
  const side = label?.toLowerCase();
  if (side === 'left') return 'right';
  if (side === 'right') return 'left';
  return undefined;
}
