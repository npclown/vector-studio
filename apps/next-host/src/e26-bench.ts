import type { Editor } from '@vector-studio/editor-core';
import type { DocumentStore } from '@vector-studio/persistence-idb';
import type { RendererHandle } from '@vector-studio/react';

// The scene contract's types, as the host's dependencies carry them (no `contracts` import).
type RendererSceneSynchronization = RendererHandle['renderer'];
type RenderChangeSet = Parameters<RendererSceneSynchronization['applyChanges']>[0];
type RenderSceneSnapshot = Parameters<RendererSceneSynchronization['replaceSnapshot']>[0];
type RenderNodeSnapshot = RenderSceneSnapshot['nodes'][number];
type SceneApplyResult = ReturnType<RendererSceneSynchronization['applyChanges']>;

// E26-U1b (E26 contract, sections 3.3 and 3.4): the host's `?bench=1` option. It installs the
// benchmark driver and the metric hooks and leaves frame capture off; `doc=`, `reject=` and
// `reject-mode=` are inert without it, and without `?bench=1` nothing here is installed, as
// `?test=1` works. The headed harness (U1c) drives a run through `window.__e26Bench`:
//
//   - the driver runs at the start of each render callback, by wrapping the backend's
//     `animationFrameClock`, so interaction updates land before prepare with no second loop;
//   - `pointerToWorkDoneMs` runs from the oldest coalesced event of a dispatched `pointermove`
//     to the resolution of `onSubmittedWorkDone` (the backend's `waitForSubmittedWork`) after the
//     first submission at or after the scene revision that input produced;
//   - long tasks come from a `PerformanceObserver`, and isolation is bracketed by the
//     injected-rejection wrapper as the `e26-isolation` measure, from the rejection to a
//     microtask queued at it, which runs after the command and its subscribers;
//   - every autosave write's start and end come from a store wrapper (the write-start hook).
//
// The drivers' formulas restate `tests/e26/scenarios.ts` (the host cannot import `tests/`); a
// unit test checks that both give the same values.

export type BenchDocument = 'm1-a13' | 'stress';

export type BenchQuery = Readonly<{
  /** The scenario document to load, or null. */
  doc: BenchDocument | null;
  persist: boolean;
  /** The scene node ID the injected rejection targets, or null. */
  reject: string | null;
  rejectMode: 'once' | 'persistent';
}>;

/** The bench option of `search`, or null without `?bench=1` (every other flag is then inert). */
export function benchQuery(search: string): BenchQuery | null {
  const params = new URLSearchParams(search);
  if (params.get('bench') !== '1') return null;
  const doc = params.get('doc');
  const reject = params.get('reject');
  return {
    doc: doc === 'm1-a13' || doc === 'stress' ? doc : null,
    persist: params.get('persist') === '1',
    reject: reject === null || reject === '' ? null : reject,
    rejectMode: params.get('reject-mode') === 'persistent' ? 'persistent' : 'once',
  };
}

/** The CSS size of the canvas: the E26 viewport under `?bench=1` (section 3.5). */
export const BENCH_CANVAS = Object.freeze({ width: 1280, height: 720 });

/** P1's theta(t) = 2·pi·((t mod period) / period), as `tests/e26/scenarios.ts` has it. */
export const BENCH_DRIVERS = Object.freeze({
  thetaPeriodMs: 10_000,
  dragX: 40,
  dragY: 30,
  pan: 0.05,
  zoomBase: 0.95,
  zoomSwing: 0.05,
});

export type BenchCamera = Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>;

export function benchTheta(tMs: number): number {
  const period = BENCH_DRIVERS.thetaPeriodMs;
  return (2 * Math.PI * (tMs % period)) / period;
}

/** The edit drag's pointer offset from its start, in CSS px. */
export function benchDragOffset(tMs: number): { x: number; y: number } {
  const angle = benchTheta(tMs);
  return {
    x: BENCH_DRIVERS.dragX * Math.sin(angle),
    y: BENCH_DRIVERS.dragY * (Math.cos(angle) - 1),
  };
}

/** The pan and zoom path's camera at t, from the fitted camera F, for a viewport in CSS px. */
export function benchPanZoomCamera(
  fitted: BenchCamera,
  tMs: number,
  viewport: Readonly<{ width: number; height: number }> = BENCH_CANVAS,
): BenchCamera {
  const angle = benchTheta(tMs);
  const c = Math.cos(angle);
  const viewW = viewport.width / fitted.zoom;
  const viewH = viewport.height / fitted.zoom;
  return {
    position: {
      x: fitted.position.x + BENCH_DRIVERS.pan * viewW * Math.sin(angle),
      y: fitted.position.y + BENCH_DRIVERS.pan * viewH * (c - 1),
    },
    zoom: fitted.zoom * (BENCH_DRIVERS.zoomBase + BENCH_DRIVERS.zoomSwing * c),
  };
}

/** The backend options the host passes: a bench clock under `?bench=1`, capture only with `?test=1`. */
export function benchBackendOptions<Clock>(
  search: string,
  clock: Clock | null,
): { frameCaptureForTesting?: true; animationFrameClock?: Clock } {
  const testing = new URLSearchParams(search).get('test') === '1';
  return {
    ...(testing ? { frameCaptureForTesting: true as const } : {}),
    ...(clock !== null && benchQuery(search) !== null ? { animationFrameClock: clock } : {}),
  };
}

/** The backend members the bench reads; `WebGpuBackend` has them all. */
export type BenchBackend = Readonly<{
  setMode(mode: 'continuous' | 'on-demand'): void;
  startFrameMeasurements(capacity?: number): void;
  stopFrameMeasurements(): unknown;
  getFrameMeasurements(): unknown;
  getStatistics(): Readonly<{ framesSubmitted: number }>;
  waitForSubmittedWork(): Promise<void>;
}>;

export type BenchDriver =
  | Readonly<{ kind: 'edit-drag'; startClient: Readonly<{ x: number; y: number }>; t0: number }>
  | Readonly<{ kind: 'pan-zoom'; fitted: BenchCamera; t0: number }>;

export type BenchWrite = { startMs: number; endMs: number | null; ok: boolean | null };
export type BenchLatency = { inputMs: number; revision: number; doneMs: number | null };
export type BenchLongTask = Readonly<{ startMs: number; durationMs: number }>;

export type BenchHook = Readonly<{
  query: BenchQuery;
  editor: () => Editor | null;
  backend: () => BenchBackend | null;
  /** The driver run at the start of each render callback, or null to stop it. */
  setDriver(driver: BenchDriver | null): void;
  /** Driver callbacks run so far, and those that sent a pointer move or camera. */
  driverSteps: () => number;
  /** Arms the injected rejection of `?reject=`. */
  armReject(): void;
  rejections: () => number;
  latencies: readonly BenchLatency[];
  noChangeMoves: () => number;
  writes: readonly BenchWrite[];
  longTasks: readonly BenchLongTask[];
  longTasksAvailable: boolean;
  /** `e26-isolation` measures, from the rejection to the end of the command. */
  isolations: () => readonly BenchLongTask[];
}>;

declare global {
  interface Window {
    /** Present only with `?bench=1` (E26 contract, section 3.3). */
    __e26Bench?: BenchHook;
  }
}

/** Whether a set holds scene node `id` (inserted, updated or as the snapshot's node). */
function holds(nodes: readonly RenderNodeSnapshot[], id: string): boolean {
  return nodes.some((node) => node.id === id);
}

/**
 * The page's bench state: one per page load under `?bench=1`. `clock` goes to the backend,
 * `wrapRenderer` around the service, `wrapStore` around the autosave store.
 */
export class Bench {
  readonly query: BenchQuery;
  readonly latencies: BenchLatency[] = [];
  readonly writes: BenchWrite[] = [];
  readonly longTasks: BenchLongTask[] = [];
  readonly longTasksAvailable: boolean;
  private editorRef: Editor | null = null;
  private backendRef: BenchBackend | null = null;
  private rendererRef: RendererSceneSynchronization | null = null;
  private canvasRef: HTMLCanvasElement | null = null;
  private driver: BenchDriver | null = null;
  private steps = 0;
  private armed = false;
  private rejected = 0;
  private noChange = 0;
  private lastSubmitted = 0;
  private lastRevision = 0;
  private pendingInput: number | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(query: BenchQuery) {
    this.query = query;
    let available = false;
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
          }
        });
        observer.observe({ type: 'longtask', buffered: true });
        this.cleanups.push(() => observer.disconnect());
        available = true;
      } catch {
        available = false;
      }
    }
    this.longTasksAvailable = available;
    // The oldest coalesced event of each dispatched move, before the canvas handles it, and the
    // revision it produced, after (the bubbling window listener runs after the canvas's).
    const before = (event: Event) => {
      const move = event as PointerEvent;
      const first =
        typeof move.getCoalescedEvents === 'function' ? move.getCoalescedEvents()[0] : undefined;
      this.pendingInput = (first ?? move).timeStamp;
    };
    const after = () => {
      const input = this.pendingInput;
      this.pendingInput = null;
      if (input === null || this.rendererRef === null) return;
      const revision = this.rendererRef.getSynchronizationState().current?.revision ?? 0;
      if (revision > this.lastRevision) {
        this.lastRevision = revision;
        this.latencies.push({ inputMs: input, revision, doneMs: null });
      } else this.noChange += 1;
    };
    window.addEventListener('pointermove', before, { capture: true });
    window.addEventListener('pointermove', after);
    this.cleanups.push(() => {
      window.removeEventListener('pointermove', before, { capture: true });
      window.removeEventListener('pointermove', after);
    });
  }

  /** The backend's clock: the driver first, then the backend's callback, then the endpoint. */
  readonly clock = {
    request: (callback: (timestampMs: number) => void): number =>
      requestAnimationFrame((timestampMs) => {
        this.drive(timestampMs);
        callback(timestampMs);
        this.submitted();
      }),
    cancel: (handle: number): void => cancelAnimationFrame(handle),
  };

  attach(backend: BenchBackend, canvas: HTMLCanvasElement): void {
    this.backendRef = backend;
    this.canvasRef = canvas;
    this.lastSubmitted = backend.getStatistics().framesSubmitted;
  }

  detach(): void {
    this.backendRef = null;
    this.canvasRef = null;
    this.rendererRef = null;
  }

  setEditor(editor: Editor | null): void {
    this.editorRef = editor;
  }

  /** The service, with the injected rejection of `?reject=` (section 3.4) when armed. */
  wrapRenderer<T extends RendererSceneSynchronization>(renderer: T): T {
    this.rendererRef = renderer;
    const target = this.query.reject;
    if (target === null) return renderer;
    const reject = (nodes: readonly RenderNodeSnapshot[]): SceneApplyResult | null => {
      if (!this.armed || !holds(nodes, target)) return null;
      if (this.query.rejectMode === 'once') this.armed = false;
      this.rejected += 1;
      // Isolation runs inside the command that sent this set; the microtask runs after it.
      performance.mark('e26-isolation-start');
      queueMicrotask(() => performance.measure('e26-isolation', 'e26-isolation-start'));
      return {
        status: 'invalid-scene',
        reason: 'invalid-value',
        current: renderer.getSynchronizationState().current,
      };
    };
    return new Proxy(renderer, {
      get: (object, key) => {
        if (key === 'applyChanges') {
          return (changes: RenderChangeSet) =>
            reject([...changes.inserted, ...changes.updated]) ?? object.applyChanges(changes);
        }
        if (key === 'replaceSnapshot') {
          return (snapshot: RenderSceneSnapshot) =>
            reject(snapshot.nodes) ?? object.replaceSnapshot(snapshot);
        }
        const value: unknown = Reflect.get(object, key, object);
        return typeof value === 'function' ? (value as () => unknown).bind(object) : value;
      },
    });
  }

  /** The autosave store, recording the start and end of every write (the write-start hook). */
  wrapStore(store: DocumentStore): DocumentStore {
    return {
      read: () => store.read(),
      clear: () => store.clear(),
      close: () => store.close(),
      write: async (envelope) => {
        const write: BenchWrite = { startMs: performance.now(), endMs: null, ok: null };
        this.writes.push(write);
        try {
          const result = await store.write(envelope);
          write.ok = result.ok;
          return result;
        } finally {
          write.endMs = performance.now();
        }
      },
    };
  }

  private drive(timestampMs: number): void {
    const driver = this.driver;
    if (driver === null) return;
    this.steps += 1;
    const t = timestampMs - driver.t0;
    if (driver.kind === 'edit-drag') {
      const canvas = this.canvasRef;
      if (canvas === null) return;
      const offset = benchDragOffset(t);
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          buttons: 1,
          clientX: driver.startClient.x + offset.x,
          clientY: driver.startClient.y + offset.y,
        }),
      );
    } else {
      this.editorRef?.execute({
        type: 'setViewport',
        camera: benchPanZoomCamera(driver.fitted, t),
      });
    }
  }

  /** After a callback that submitted: the endpoint of every input at or below its revision. */
  private submitted(): void {
    const backend = this.backendRef;
    const renderer = this.rendererRef;
    if (backend === null || renderer === null) return;
    const count = backend.getStatistics().framesSubmitted;
    if (count === this.lastSubmitted) return;
    this.lastSubmitted = count;
    const revision = renderer.getSynchronizationState().current?.revision ?? 0;
    const waiting = this.latencies.filter(
      (entry) => entry.doneMs === null && entry.revision <= revision,
    );
    if (waiting.length === 0) return;
    // Claimed now, so a later submission does not resolve them again.
    for (const entry of waiting) entry.doneMs = Number.NaN;
    void backend.waitForSubmittedWork().then(() => {
      const now = performance.now();
      for (const entry of waiting) entry.doneMs = now;
    });
  }

  hook(): BenchHook {
    return {
      query: this.query,
      editor: () => this.editorRef,
      backend: () => this.backendRef,
      setDriver: (driver) => {
        this.driver = driver;
      },
      driverSteps: () => this.steps,
      armReject: () => {
        this.armed = true;
      },
      rejections: () => this.rejected,
      latencies: this.latencies,
      noChangeMoves: () => this.noChange,
      writes: this.writes,
      longTasks: this.longTasks,
      longTasksAvailable: this.longTasksAvailable,
      isolations: () =>
        performance
          .getEntriesByName('e26-isolation', 'measure')
          .map((entry) => ({ startMs: entry.startTime, durationMs: entry.duration })),
    };
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }
}

let current: Bench | null = null;

/** The page's bench under `?bench=1`, created once with its hook; null otherwise. */
export function pageBench(): Bench | null {
  if (typeof window === 'undefined') return null;
  if (current !== null) return current;
  const query = benchQuery(window.location.search);
  if (query === null) return null;
  current = new Bench(query);
  window.__e26Bench = current.hook();
  return current;
}

/** A per-run database name under `?bench=1&persist=1`, so no run restores another's write. */
export function benchDatabaseName(base: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  return `${base}-bench-${random}`;
}
