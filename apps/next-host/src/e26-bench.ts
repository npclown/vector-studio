import type { Editor } from '@vector-studio/editor-core';
import type { DocumentStore } from '@vector-studio/persistence-idb';
import type { RendererHandle } from '@vector-studio/react';
import { createTextDom, type TextDom, type TextDomOptions } from '@vector-studio/text-dom';
import { TEST_FONT_FAMILY } from './m6a-text-host';

// The scene contract's types, as the host's dependencies carry them (no `contracts` import).
type RendererSceneSynchronization = RendererHandle['renderer'];
type RenderChangeSet = Parameters<RendererSceneSynchronization['applyChanges']>[0];
type RenderSceneSnapshot = Parameters<RendererSceneSynchronization['replaceSnapshot']>[0];
type RenderNodeSnapshot = RenderSceneSnapshot['nodes'][number];
type SceneApplyResult = ReturnType<RendererSceneSynchronization['applyChanges']>;

// E26-U1b (E26 contract, sections 3.3 and 3.4): the host's `?bench=1` option. It installs the
// benchmark driver and the metric hooks and leaves frame capture off; `doc=`, `reject=` and
// `reject-mode=` and `isolation=` are inert without it, and without `?bench=1` nothing here is installed, as
// `?test=1` works. The headed harness (U1c) drives a run through `window.__e26Bench`:
//
//   - the driver runs at the start of each render callback, by wrapping the backend's
//     `animationFrameClock`, so interaction updates land before prepare with no second loop;
//   - `pointerToWorkDoneMs` runs from the oldest coalesced event of a dispatched `pointermove`
//     to the resolution of `onSubmittedWorkDone` (the backend's `waitForSubmittedWork`) after the
//     first submission at or after the scene revision that input produced;
//   - long tasks come from a `PerformanceObserver`, and isolation is bracketed by the
//     injected-rejection wrapper as the `e26-isolation` measure, from the first rejection of a
//     command to a microtask queued at it, which runs after the command and its subscribers
//     (one measure per command, however many sets a persistent rejection refuses). Under the
//     edit-drag driver the command runs inside the render callback, so the measure also holds
//     that frame's prepare and submit; pan-zoom commands and section 3.4's U1c runs do not;
//   - every autosave write's start and end come from a store wrapper (the write-start hook).
//
// The drivers' formulas restate `tests/e26/scenarios.ts` (the host cannot import `tests/`); a
// unit test checks that both give the same values.
//
// M9-U1 (M9 contract, section 4), with `?bench=1` only:
//   - `ui=1`: the page mounts the right column (layer tree, property panel, extension panels) in
//     place of the 17a2b0a Appearance aside; the canvas keeps its size and origin;
//   - `doc=m9-v2`: the v2 document, which `tests/m9/document.ts` generates and the harness writes
//     for the bench loader, as it writes the v1 documents; the page registers the committed test
//     font before the load and lists the test family as text-dom's fallback family
//     (`benchTextDomOptions`), so `M9_SECOND_FAMILY` text falls back to the committed font;
//   - the hook's `registerTestFont(family)` is the font-load change (marked `m9-font-load`), its
//     `enterTextEdit(id, offset)` the typing seam, and `keyLatencies` the `keyToWorkDoneMs`
//     samples: from the `keydown` `timeStamp` to the submitted work of the first submission at or
//     after the scene revision the key produced, as `pointerToWorkDoneMs` is.

export type BenchDocument = 'm1-a13' | 'stress' | 'm9-v2';
const BENCH_DOCUMENTS: readonly string[] = ['m1-a13', 'stress', 'm9-v2'];

export type BenchQuery = Readonly<{
  /** The scenario document to load, or null. */
  doc: BenchDocument | null;
  persist: boolean;
  /** The scene node ID the injected rejection targets, or null. */
  reject: string | null;
  rejectMode: 'once' | 'persistent';
  /**
   * E26-U6b (A06): `isolation=1` wraps the service with no `?reject=` target, so the harness arms
   * its own targets (`armReject(targets, mode)`) and reads the `replaceSnapshot` times.
   */
  isolation: boolean;
  /** M9-U1: `ui=1` mounts the right column in place of the Appearance aside. */
  ui: boolean;
}>;

/** The bench option of `search`, or null without `?bench=1` (every other flag is then inert). */
export function benchQuery(search: string): BenchQuery | null {
  const params = new URLSearchParams(search);
  if (params.get('bench') !== '1') return null;
  const doc = params.get('doc');
  const reject = params.get('reject');
  return {
    doc: doc !== null && BENCH_DOCUMENTS.includes(doc) ? (doc as BenchDocument) : null,
    persist: params.get('persist') === '1',
    reject: reject === null || reject === '' ? null : reject,
    rejectMode: params.get('reject-mode') === 'persistent' ? 'persistent' : 'once',
    isolation: params.get('isolation') === '1',
    ui: params.get('ui') === '1',
  };
}

/** M9-U1: whether the page mounts the bench's Appearance aside (not with `ui=1`). */
export function benchAside(query: BenchQuery | null): boolean {
  return query !== null && !query.ui;
}

/** M9-U1: whether the bench registers the committed test font before its load (`doc=m9-v2`). */
export function benchTextFont(search: string): boolean {
  return benchQuery(search)?.doc === 'm9-v2';
}

/**
 * M9-U1: the text-dom options the bench adds for `doc=m9-v2`: the test family as the fallback
 * family, so a run naming the uninstalled second family lays out in the committed font until
 * the font-load change registers it; none otherwise.
 */
export function benchTextDomOptions(search: string): { fallbackFamilies?: readonly string[] } {
  return benchTextFont(search) ? { fallbackFamilies: [TEST_FONT_FAMILY] } : {};
}

/** M9-U1: the host composition's text-dom factory with those options, or none (the default). */
export function benchComposition(search: string): {
  createTextDom?: (options: TextDomOptions) => TextDom;
} {
  if (!benchTextFont(search)) return {};
  const extra = benchTextDomOptions(search);
  return { createTextDom: (options) => createTextDom({ ...options, ...extra }) };
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
/**
 * `doneMs` is NaN while claimed by a submission and stays NaN with `failed` if the wait rejects.
 * E30-U1b (E30 contract, section 3, latency split), all `performance.now()` values: a move's
 * `dispatchMs` and `handlerEndMs` bracket its `pointermove` dispatch (the capture window listener
 * runs first, the bubbling one after the canvas's handlers, which hold the editor's gesture
 * update, projection and scene set), and `claimMs` is the end of the render callback whose
 * submission claimed the sample. A reader pairs `claimMs` with that callback's `vs-prepare`
 * measure (the last one starting before it) for the wait to prepare. Keys carry `claimMs` only.
 */
export type BenchLatency = {
  inputMs: number;
  revision: number;
  doneMs: number | null;
  failed?: true;
  dispatchMs?: number;
  handlerEndMs?: number;
  claimMs?: number;
};
export type BenchLongTask = Readonly<{ startMs: number; durationMs: number }>;

/** M9-U1: one font-load change, from the call to the first submitted work after its last bump. */
export type BenchFontLoad = {
  family: string;
  startMs: number;
  /** When the registration settled (`registerFont` resolved). */
  settledMs: number | null;
  /** The end of the measure: the first submitted work after the last generation bump. */
  endMs: number | null;
  status: string | null;
  generationBefore: number;
  generationAfter: number | null;
  /**
   * The port's listener dispatches during the load (since V-21 one per increment batch, not one
   * per increment), and the time of the last one.
   */
  bumps: number;
  lastBumpMs: number | null;
  revisionBefore: number;
  revisionAfter: number | null;
};

/** M9-U1: the page's text port, as the font-load change uses it. */
export type BenchFontPort = Readonly<{
  /** Registers the committed test font under `family`. */
  register(family: string): Promise<string>;
  generation(): number;
  /** Runs `listener` on each port dispatch (since V-21, once per batch of increases); returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}>;

/** The frames the font-load measure waits, at most, for the generation to stop changing. */
const FONT_SETTLE_MAX_FRAMES = 300;

/** One animation frame, or a 16 ms timer where there is none (Node). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/** E26-U6b: one `replaceSnapshot` the service handled (not one the injected rejection refused). */
export type BenchReplace = Readonly<{
  startMs: number;
  durationMs: number;
  nodes: number;
  status: string;
}>;

export type BenchHook = Readonly<{
  query: BenchQuery;
  editor: () => Editor | null;
  backend: () => BenchBackend | null;
  /** The driver run at the start of each render callback, or null to stop it. */
  setDriver(driver: BenchDriver | null): void;
  /** Driver callbacks run so far, and those that sent a pointer move or camera. */
  driverSteps: () => number;
  /**
   * Arms the injected rejection of `?reject=`. E26-U6b (A06): `targets` and `mode`, when given,
   * replace the query's target and mode from this arming on, so one run can measure isolation
   * with one and with 16 persistent rejections.
   */
  armReject(targets?: readonly string[], mode?: 'once' | 'persistent'): void;
  /** E26-U6b: disarms the injected rejection. */
  disarmReject(): void;
  rejections: () => number;
  latencies: readonly BenchLatency[];
  /** The input timestamps of dispatched moves that produced no new scene revision. */
  noChangeMoves: readonly number[];
  writes: readonly BenchWrite[];
  longTasks: readonly BenchLongTask[];
  longTasksAvailable: boolean;
  /** `e26-isolation` measures, from the rejection to the end of the command. */
  isolations: () => readonly BenchLongTask[];
  /** E26-U6b (A06's R): every `replaceSnapshot` the service handled, timed around the call. */
  replaces: readonly BenchReplace[];
  /** M9-U1: `keyToWorkDoneMs` samples, one per key that produced a scene revision. */
  keyLatencies: readonly BenchLatency[];
  /** M9-U1: the `keydown` timestamps of keys that produced no new scene revision. */
  noChangeKeys: readonly number[];
  /**
   * M9-U1: the font-load change: registers the committed test font under `family`, marked
   * `m9-font-load` (a mark at the call, a measure to the settled registration). Resolves to the
   * registration status, or `unavailable` before the page gave the bench its text port.
   */
  registerTestFont(family: string): Promise<string>;
  fontLoads: readonly BenchFontLoad[];
  /** M9-U1: the typing seam, `enterTextEdit` on `id` with anchor and focus at `offset`. */
  enterTextEdit(id: string, offset: number): Readonly<{ ok: boolean; code?: string }>;
  /**
   * V20-U1 (V-20 contract, section 5): renders per counted component since the bench was
   * installed, from `@vector-studio/ui`'s render probe: `layers`, `layer-row` (one per row the
   * layer tree renders), `properties`, `appearance`, `panels` and `aside`.
   */
  renders: () => Readonly<Record<string, number>>;
  /**
   * V21-U1 (V-21 contract, U1): the text probe's records since the bench was installed, in
   * order: text-dom's `port-bump` (each increment's source and generation), its
   * `port-dispatch` (the increments it carries and its time) and the editor's `editor-dispatch`
   * (the relayout's split), the editor's before the dispatch's own.
   */
  textDispatches: () => readonly Readonly<Record<string, unknown>>[];
}>;

declare global {
  interface Window {
    /** Present only with `?bench=1` (E26 contract, section 3.3). */
    __e26Bench?: BenchHook;
  }
}

/** Whether a set holds one of the scene nodes `ids` (inserted, updated or a snapshot's node). */
function holds(nodes: readonly RenderNodeSnapshot[], ids: ReadonlySet<string>): boolean {
  return ids.size > 0 && nodes.some((node) => ids.has(node.id));
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
  private targets: ReadonlySet<string>;
  private mode: 'once' | 'persistent';
  private rejected = 0;
  readonly replaces: BenchReplace[] = [];
  private lastSubmitted = 0;
  private pendingInput: Readonly<{ inputMs: number; revision: number; dispatchMs: number }> | null =
    null;
  private pendingKey: Readonly<{ inputMs: number; revision: number }> | null = null;
  readonly keyLatencies: BenchLatency[] = [];
  readonly noChangeKeys: number[] = [];
  readonly fontLoads: BenchFontLoad[] = [];
  private fontPort: BenchFontPort | null = null;
  private isolationStart: number | null = null;
  readonly noChangeMoves: number[] = [];
  private readonly cleanups: (() => void)[] = [];

  constructor(query: BenchQuery) {
    this.query = query;
    this.targets = new Set(query.reject === null ? [] : [query.reject]);
    this.mode = query.rejectMode;
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
      this.pendingInput = {
        inputMs: (first ?? move).timeStamp,
        revision: this.revision(),
        dispatchMs: performance.now(),
      };
    };
    const after = () => {
      const handlerEndMs = performance.now();
      const input = this.pendingInput;
      this.pendingInput = null;
      if (input === null || this.rendererRef === null) return;
      const revision = this.revision();
      if (revision > input.revision) {
        this.latencies.push({
          inputMs: input.inputMs,
          revision,
          doneMs: null,
          dispatchMs: input.dispatchMs,
          handlerEndMs,
        });
      } else this.noChangeMoves.push(input.inputMs);
    };
    window.addEventListener('pointermove', before, { capture: true });
    window.addEventListener('pointermove', after);
    // M9-U1: a key's revision, as a move's. The textarea applies a typed character on
    // `beforeinput` and a command key on `keydown`; the bubbling window listeners run after the
    // page's own, and the first that sees a new revision ends the key. A key still pending at
    // the next `keydown` produced none (not at its `keyup`, which may follow the next keydown
    // when keys are sent without waiting).
    const keyBefore = (event: Event) => {
      const input = this.pendingKey;
      if (input !== null) this.noChangeKeys.push(input.inputMs);
      this.pendingKey = { inputMs: event.timeStamp, revision: this.revision() };
    };
    const keyAfter = () => {
      const input = this.pendingKey;
      if (input === null || this.rendererRef === null) return;
      const revision = this.revision();
      if (revision <= input.revision) return;
      this.pendingKey = null;
      this.keyLatencies.push({ inputMs: input.inputMs, revision, doneMs: null });
    };
    const keyListeners: [string, (event: Event) => void, boolean][] = [
      ['keydown', keyBefore, true],
      ['keydown', keyAfter, false],
      ['beforeinput', keyAfter, false],
      ['input', keyAfter, false],
      ['keyup', keyAfter, true],
    ];
    for (const [type, listener, capture] of keyListeners) {
      window.addEventListener(type, listener, { capture });
    }
    this.cleanups.push(() => {
      window.removeEventListener('pointermove', before, { capture: true });
      window.removeEventListener('pointermove', after);
      for (const [type, listener, capture] of keyListeners) {
        window.removeEventListener(type, listener, { capture });
      }
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

  private revision(): number {
    return this.rendererRef?.getSynchronizationState().current?.revision ?? 0;
  }

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

  /** M9-U1: the page's text port for the font-load change, or null to drop it. */
  setFontPort(port: BenchFontPort | null): void {
    this.fontPort = port;
  }

  /**
   * M9-U1: the font-load change (`registerTestFont(family)`), marked `m9-font-load`. text-dom
   * dispatches its listeners on a later task (since V-21, once after the face settles, or at its
   * 3,000 ms cap and again at the settle), and the editor re-projects on each dispatch, so the
   * measure runs from the call to the
   * first submitted work after the last bump: frames are awaited until two pass with no bump
   * (at least two after the registration settles, at most `FONT_SETTLE_MAX_FRAMES`), then the
   * backend's submitted work. It records the generation and the scene revision before and after.
   */
  private async registerTestFont(family: string): Promise<string> {
    const port = this.fontPort;
    if (port === null) return 'unavailable';
    const load: BenchFontLoad = {
      family,
      startMs: performance.now(),
      settledMs: null,
      endMs: null,
      status: null,
      generationBefore: port.generation(),
      generationAfter: null,
      bumps: 0,
      lastBumpMs: null,
      revisionBefore: this.revision(),
      revisionAfter: null,
    };
    this.fontLoads.push(load);
    performance.mark('m9-font-load', { startTime: load.startMs });
    const unsubscribe = port.subscribe(() => {
      load.bumps += 1;
      load.lastBumpMs = performance.now();
    });
    try {
      load.status = await port.register(family);
      load.settledMs = performance.now();
      let quiet = 0;
      for (let frame = 0; frame < FONT_SETTLE_MAX_FRAMES && quiet < 2; frame += 1) {
        const bumps = load.bumps;
        await nextFrame();
        quiet = load.bumps === bumps ? quiet + 1 : 0;
      }
      await this.backendRef?.waitForSubmittedWork().catch(() => undefined);
    } catch (error) {
      load.status = `error: ${String(error)}`;
    } finally {
      unsubscribe();
      load.endMs = performance.now();
      load.generationAfter = port.generation();
      load.revisionAfter = this.revision();
      performance.measure('m9-font-load', { start: load.startMs, end: load.endMs });
    }
    return load.status;
  }

  /**
   * With `?reject=` or `isolation=1`: the service, with the injected rejection (section 3.4) when
   * armed, and every `replaceSnapshot` it handles timed (E26-U6b, A06's R).
   */
  wrapRenderer<T extends RendererSceneSynchronization>(renderer: T): T {
    this.rendererRef = renderer;
    // The frame scenarios run on the unwrapped service.
    if (this.query.reject === null && !this.query.isolation) return renderer;
    const reject = (nodes: readonly RenderNodeSnapshot[]): SceneApplyResult | null => {
      if (!this.armed || !holds(nodes, this.targets)) return null;
      if (this.mode === 'once') this.armed = false;
      this.rejected += 1;
      // Isolation runs inside the command that sent this set; the microtask runs after it. Later
      // rejections in the same command (persistent mode) keep the first start.
      if (this.isolationStart === null) {
        const start = performance.now();
        this.isolationStart = start;
        queueMicrotask(() => {
          this.isolationStart = null;
          performance.measure('e26-isolation', { start, end: performance.now() });
        });
      }
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
          return (snapshot: RenderSceneSnapshot) => {
            const refused = reject(snapshot.nodes);
            if (refused !== null) return refused;
            const start = performance.now();
            const result = object.replaceSnapshot(snapshot);
            this.replaces.push({
              startMs: start,
              durationMs: performance.now() - start,
              nodes: snapshot.nodes.length,
              status: result.status,
            });
            return result;
          };
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
    const waiting = [...this.latencies, ...this.keyLatencies].filter(
      (entry) => entry.doneMs === null && entry.revision <= revision,
    );
    if (waiting.length === 0) return;
    // Claimed now, so a later submission does not resolve them again.
    const claimMs = performance.now();
    for (const entry of waiting) {
      entry.doneMs = Number.NaN;
      entry.claimMs = claimMs;
    }
    backend.waitForSubmittedWork().then(
      () => {
        const now = performance.now();
        for (const entry of waiting) entry.doneMs = now;
      },
      () => {
        for (const entry of waiting) entry.failed = true;
      },
    );
  }

  /** V20-U1: the render probe `pageBench` installs; counts renders per id. */
  readonly countRender = (id: string): void => {
    this.renderCounts[id] = (this.renderCounts[id] ?? 0) + 1;
  };

  private readonly renderCounts: Record<string, number> = {};

  /** V21-U1: the text probe `pageBench` installs; keeps each record as given. */
  readonly recordText = (record: Readonly<Record<string, unknown>>): void => {
    this.textRecords.push(record);
  };

  private readonly textRecords: Readonly<Record<string, unknown>>[] = [];

  hook(): BenchHook {
    return {
      query: this.query,
      editor: () => this.editorRef,
      backend: () => this.backendRef,
      setDriver: (driver) => {
        this.driver = driver;
      },
      driverSteps: () => this.steps,
      armReject: (targets, mode) => {
        if (targets !== undefined) this.targets = new Set(targets);
        if (mode !== undefined) this.mode = mode;
        this.armed = true;
      },
      disarmReject: () => {
        this.armed = false;
      },
      rejections: () => this.rejected,
      latencies: this.latencies,
      noChangeMoves: this.noChangeMoves,
      writes: this.writes,
      longTasks: this.longTasks,
      longTasksAvailable: this.longTasksAvailable,
      isolations: () =>
        performance
          .getEntriesByName('e26-isolation', 'measure')
          .map((entry) => ({ startMs: entry.startTime, durationMs: entry.duration })),
      replaces: this.replaces,
      keyLatencies: this.keyLatencies,
      noChangeKeys: this.noChangeKeys,
      registerTestFont: (family) => this.registerTestFont(family),
      fontLoads: this.fontLoads,
      enterTextEdit: (id, offset) => {
        const editor = this.editorRef;
        if (editor === null) return { ok: false, code: 'bench.no-editor' };
        const result = editor.execute({ type: 'enterTextEdit', id, anchor: offset, focus: offset });
        return result.ok ? { ok: true } : { ok: false, code: result.code };
      },
      renders: () => ({ ...this.renderCounts }),
      textDispatches: () => [...this.textRecords],
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
  (globalThis as { __vsRenderProbe?: (id: string) => void }).__vsRenderProbe = current.countRender;
  (
    globalThis as { __vsTextProbe?: (record: Readonly<Record<string, unknown>>) => void }
  ).__vsTextProbe = current.recordText;
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
