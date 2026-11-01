import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  E26_DRIVERS,
  E26_VIEWPORT,
  editDragOffset,
  panZoomCamera,
  theta,
} from '../e26/scenarios.js';

// E26-U1b (E26 contract, sections 3.3 and 3.4): the next-host `?bench=1` option in Node. Without
// `?bench=1` every bench flag is inert and nothing is installed; with it, frame capture stays off
// unless `?test=1` is also given, the drivers equal U1a's formulas, the injected rejection rejects
// the first (or every) set holding its node once armed and brackets isolation as the
// `e26-isolation` measure, and the write-start hook records every autosave write.

const root = path.resolve(import.meta.dirname, '../..');
type Camera = Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>;
type Query = Readonly<{
  doc: string | null;
  persist: boolean;
  reject: string | null;
  rejectMode: string;
  isolation: boolean;
}>;
type Write = { startMs: number; endMs: number | null; ok: boolean | null };
type BenchInstance = {
  readonly writes: readonly Write[];
  readonly latencies: readonly {
    inputMs: number;
    revision: number;
    doneMs: number | null;
    failed?: true;
  }[];
  readonly clock: { request(callback: (timestampMs: number) => void): number };
  wrapRenderer(renderer: Sync): Sync;
  wrapStore(store: Store): Store;
  attach(backend: unknown, canvas: unknown): void;
  setEditor(editor: unknown): void;
  hook(): {
    armReject(targets?: readonly string[], mode?: 'once' | 'persistent'): void;
    disarmReject(): void;
    rejections(): number;
    replaces: readonly { startMs: number; durationMs: number; nodes: number; status: string }[];
    isolations(): readonly { startMs: number; durationMs: number }[];
    noChangeMoves: readonly number[];
    driverSteps(): number;
    setDriver(driver: unknown): void;
  };
  dispose(): void;
};
/** The module's surface this test uses (the host is outside the test project's files). */
type BenchModule = {
  benchQuery(search: string): Query | null;
  pageBench(): unknown;
  benchBackendOptions(search: string, clock: unknown): Record<string, unknown>;
  BENCH_CANVAS: Readonly<{ width: number; height: number }>;
  BENCH_DRIVERS: Readonly<Record<string, number>>;
  benchTheta(tMs: number): number;
  benchDragOffset(tMs: number): { x: number; y: number };
  benchPanZoomCamera(fitted: Camera, tMs: number): Camera;
  benchDatabaseName(base: string): string;
  Bench: new (query: Query) => BenchInstance;
};
const bench = (await import(path.join(root, 'apps/next-host/src/e26-bench.ts'))) as BenchModule;
const route = (await import(path.join(root, 'apps/next-host/app/e26-bench-doc.json/route.ts'))) as {
  GET(request: Request): Promise<Response>;
};

type Listener = (event: unknown) => void;
type Sync = import('@vector-studio/react').RendererHandle['renderer'];
type Store = import('@vector-studio/persistence-idb').DocumentStore;
type ChangeSet = Parameters<Sync['applyChanges']>[0];
type Snapshot = Parameters<Sync['replaceSnapshot']>[0];
const asSync = (renderer: ReturnType<typeof accepting>) => renderer as unknown as Sync;

/** A window with a location and pointer listeners, enough for the bench in Node. */
function stubWindow(search: string) {
  const listeners = new Map<string, Listener[]>();
  vi.stubGlobal('window', {
    location: { search },
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    removeEventListener: (type: string, listener: Listener) =>
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      ),
  });
  return listeners;
}

afterEach(() => {
  vi.unstubAllGlobals();
  performance.clearMarks();
  performance.clearMeasures();
});

const leaf = (id: string) => ({
  id,
  parentId: null,
  transform: [1, 0, 0, 1, 0, 0] as const,
  visible: true,
  opacity: 1,
  kind: 'primitive' as const,
  geometry: { kind: 'rectangle' as const, width: 1, height: 1, cornerRadii: [0, 0, 0, 0] as const },
  style: { fill: { r: 0, g: 0, b: 0, a: 1 }, stroke: null },
});

/** A renderer that accepts every set and counts the sets it saw. */
function accepting() {
  let revision = 1;
  const seen: string[] = [];
  const current = () => ({ identity: { documentId: 'd', pageId: 'p' }, revision });
  return {
    seen,
    applyChanges(changes: { inserted: readonly { id: string }[] }) {
      seen.push(`apply:${changes.inserted.map((node) => node.id).join(',')}`);
      revision += 1;
      return { status: 'applied', current: current() };
    },
    replaceSnapshot() {
      seen.push('replace');
      revision += 1;
      return { status: 'applied', current: current() };
    },
    getSynchronizationState: () => ({ current: current() }),
    /** Sets the current revision directly (a submission behind an input's revision). */
    setRevision: (value: number) => {
      revision = value;
    },
    setCamera: () => ({ status: 'applied' }),
    getCameraState: () => null,
    dispose: () => {},
  };
}

const set = (ids: readonly string[]): ChangeSet => ({
  identity: { documentId: 'd', pageId: 'p' },
  revision: 9,
  baseRevision: 8,
  inserted: ids.map(leaf),
  updated: [],
  removed: [],
  orders: [],
});

describe('E26-U1b next-host bench option', () => {
  it('is inert without ?bench=1, and parses its flags with it', () => {
    expect(bench.benchQuery('')).toBeNull();
    expect(bench.benchQuery('?doc=m1-a13&persist=1&reject=r1&reject-mode=persistent')).toBeNull();
    expect(bench.benchQuery('?bench=0&doc=stress')).toBeNull();
    expect(bench.benchQuery('?bench=1')).toEqual({
      doc: null,
      persist: false,
      reject: null,
      rejectMode: 'once',
      isolation: false,
    });
    expect(bench.benchQuery('?isolation=1')).toBeNull();
    expect(bench.benchQuery('?bench=1&isolation=1')).toMatchObject({ isolation: true });
    expect(
      bench.benchQuery('?bench=1&doc=stress&persist=1&reject=n7&reject-mode=persistent'),
    ).toEqual({
      doc: 'stress',
      persist: true,
      reject: 'n7',
      rejectMode: 'persistent',
      isolation: false,
    });
    expect(bench.benchQuery('?bench=1&doc=other&reject=')).toMatchObject({
      doc: null,
      reject: null,
    });
    stubWindow('?doc=m1-a13&reject=r1');
    expect(bench.pageBench()).toBeNull();
  });

  it('keeps frame capture (COPY_SRC) off and passes the clock only under ?bench=1', () => {
    const clock = { request: () => 0, cancel: () => {} };
    expect(bench.benchBackendOptions('', clock)).toEqual({});
    expect(bench.benchBackendOptions('?doc=m1-a13', clock)).toEqual({});
    expect(bench.benchBackendOptions('?bench=1', clock)).toEqual({ animationFrameClock: clock });
    expect(bench.benchBackendOptions('?bench=1', null)).toEqual({});
    expect(bench.benchBackendOptions('?test=1', clock)).toEqual({ frameCaptureForTesting: true });
  });

  it('drives with the formulas of tests/e26/scenarios.ts', () => {
    expect(bench.BENCH_CANVAS).toEqual(E26_VIEWPORT);
    for (const key of Object.keys(bench.BENCH_DRIVERS)) {
      expect(bench.BENCH_DRIVERS[key], key).toBe(E26_DRIVERS[key as keyof typeof E26_DRIVERS]);
    }
    const fitted = { position: { x: -312.5, y: 41.25 }, zoom: 0.3125 };
    for (let t = -500; t < 25_000; t += 37.3) {
      expect(bench.benchTheta(t)).toBe(theta(t));
      expect(bench.benchDragOffset(t)).toEqual(editDragOffset(t));
      expect(bench.benchPanZoomCamera(fitted, t)).toEqual(panZoomCamera(fitted, t));
    }
  });

  it('rejects the first set holding the target once armed, and marks the isolation', async () => {
    stubWindow('?bench=1&reject=b');
    const state = new bench.Bench(bench.benchQuery('?bench=1&reject=b')!);
    const inner = accepting();
    const renderer = state.wrapRenderer(asSync(inner));
    expect(renderer.applyChanges(set(['b'])).status).toBe('applied');
    state.hook().armReject();
    expect(renderer.applyChanges(set(['a'])).status).toBe('applied');
    const rejected = renderer.applyChanges(set(['a', 'b']));
    expect(rejected).toMatchObject({ status: 'invalid-scene', reason: 'invalid-value' });
    // Once: the next set holding b is accepted.
    expect(renderer.applyChanges(set(['b'])).status).toBe('applied');
    expect(inner.seen).toEqual(['apply:b', 'apply:a', 'apply:b']);
    expect(state.hook().rejections()).toBe(1);
    // The measure is taken by a microtask queued at the rejection.
    expect(state.hook().isolations()).toEqual([]);
    await Promise.resolve();
    expect(state.hook().isolations()).toHaveLength(1);
    // Other members pass through to the renderer.
    expect(renderer.getSynchronizationState().current?.revision).toBe(4);
    state.dispose();
  });

  it('rejects every set holding the target in persistent mode, snapshots included', async () => {
    stubWindow('?bench=1&reject=b&reject-mode=persistent');
    const state = new bench.Bench(bench.benchQuery('?bench=1&reject=b&reject-mode=persistent')!);
    const inner = accepting();
    const renderer = state.wrapRenderer(asSync(inner));
    state.hook().armReject();
    for (let i = 0; i < 3; i += 1) {
      expect(renderer.applyChanges(set(['b'])).status).toBe('invalid-scene');
    }
    const snapshot: Snapshot = {
      identity: { documentId: 'd', pageId: 'p' },
      revision: 9,
      nodes: [leaf('b')],
      rootOrder: ['b'],
    };
    expect(renderer.replaceSnapshot(snapshot).status).toBe('invalid-scene');
    expect(renderer.applyChanges(set(['a'])).status).toBe('applied');
    expect(inner.seen).toEqual(['apply:a']);
    expect(state.hook().rejections()).toBe(4);
    // One measure for the command, from the first of its rejections.
    const before = performance.now();
    await Promise.resolve();
    const isolations = state.hook().isolations();
    expect(isolations).toHaveLength(1);
    expect(isolations[0]!.startMs).toBeLessThan(before);
    // A later command's rejections get their own measure.
    expect(renderer.applyChanges(set(['b'])).status).toBe('invalid-scene');
    await Promise.resolve();
    expect(state.hook().isolations()).toHaveLength(2);
    state.dispose();
  });

  it('E26-U6b: arming with targets and a mode replaces the query, and disarm stops it', async () => {
    stubWindow('?bench=1&isolation=1');
    const state = new bench.Bench(bench.benchQuery('?bench=1&isolation=1')!);
    const inner = accepting();
    const renderer = state.wrapRenderer(asSync(inner));
    expect(renderer).not.toBe(inner);
    // No `?reject=`: armed with nothing, nothing is refused.
    state.hook().armReject();
    expect(renderer.applyChanges(set(['a', 'b'])).status).toBe('applied');
    state.hook().armReject(['b', 'c'], 'persistent');
    expect(renderer.applyChanges(set(['b'])).status).toBe('invalid-scene');
    expect(renderer.applyChanges(set(['c'])).status).toBe('invalid-scene');
    expect(renderer.applyChanges(set(['a'])).status).toBe('applied');
    state.hook().disarmReject();
    expect(renderer.applyChanges(set(['b'])).status).toBe('applied');
    // A later arming keeps the targets and mode of the last one that gave them.
    state.hook().armReject();
    expect(renderer.applyChanges(set(['c'])).status).toBe('invalid-scene');
    expect(renderer.applyChanges(set(['c'])).status).toBe('invalid-scene');
    expect(state.hook().rejections()).toBe(4);
    state.hook().armReject(['a'], 'once');
    expect(renderer.applyChanges(set(['a'])).status).toBe('invalid-scene');
    expect(renderer.applyChanges(set(['a'])).status).toBe('applied');
    await Promise.resolve();
    state.dispose();
  });

  it('E26-U6b: times every replaceSnapshot the service handles, not the refused ones', () => {
    stubWindow('?bench=1&isolation=1');
    const state = new bench.Bench(bench.benchQuery('?bench=1&isolation=1')!);
    const renderer = state.wrapRenderer(asSync(accepting()));
    const snapshot = (ids: readonly string[]): Snapshot => ({
      identity: { documentId: 'd', pageId: 'p' },
      revision: 9,
      nodes: ids.map(leaf),
      rootOrder: [...ids],
    });
    renderer.replaceSnapshot(snapshot(['a', 'b', 'c']));
    renderer.applyChanges(set(['a']));
    state.hook().armReject(['b'], 'persistent');
    expect(renderer.replaceSnapshot(snapshot(['a', 'b'])).status).toBe('invalid-scene');
    renderer.replaceSnapshot(snapshot(['a']));
    const replaces = state.hook().replaces;
    expect(replaces.map(({ nodes, status }) => [nodes, status])).toEqual([
      [3, 'applied'],
      [1, 'applied'],
    ]);
    for (const entry of replaces) {
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(entry.startMs)).toBe(true);
    }
    state.dispose();
  });

  it('runs the driver before the backend callback and ends each input at its submitted work', async () => {
    const listeners = stubWindow('?bench=1');
    const frames: ((timestampMs: number) => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: (timestampMs: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    const state = new bench.Bench(bench.benchQuery('?bench=1')!);
    const inner = accepting();
    state.wrapRenderer(asSync(inner));
    let submitted = 0;
    let settle: () => void = () => {};
    state.attach(
      {
        setMode: () => {},
        startFrameMeasurements: () => {},
        stopFrameMeasurements: () => null,
        getFrameMeasurements: () => null,
        getStatistics: () => ({ framesSubmitted: submitted }),
        waitForSubmittedWork: () => new Promise<void>((resolve) => (settle = resolve)),
      },
      {},
    );
    const order: string[] = [];
    const cameras: unknown[] = [];
    state.setEditor({
      execute: (command: { camera: unknown }) => {
        order.push('driver');
        cameras.push(command.camera);
        return { ok: true, ids: [] };
      },
    });
    const fitted = { position: { x: 0, y: 0 }, zoom: 0.5 };
    state.hook().setDriver({ kind: 'pan-zoom', fitted, t0: 1000 });
    // A move that produced a revision, then one that produced none.
    const move = (timeStamp: number, coalesced: number, produce: boolean) => {
      const event = { timeStamp, getCoalescedEvents: () => [{ timeStamp: coalesced }] };
      for (const listener of listeners.get('pointermove') ?? []) {
        if (listener === (listeners.get('pointermove') ?? [])[1] && produce) {
          inner.applyChanges({ inserted: [] });
        }
        listener(event);
      }
    };
    move(500, 480, true);
    move(510, 505, false);
    expect(state.latencies).toEqual([{ inputMs: 480, revision: 2, doneMs: null }]);
    expect(state.hook().noChangeMoves).toEqual([505]);
    state.clock.request(() => {
      order.push('backend');
      submitted += 1;
    });
    frames.shift()!(3500);
    expect(order).toEqual(['driver', 'backend']);
    expect(cameras).toEqual([bench.benchPanZoomCamera(fitted, 2500)]);
    expect(state.hook().driverSteps()).toBe(1);
    settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.latencies[0]!.doneMs).toBeGreaterThan(0);
    state.dispose();
  });

  it('leaves inputs ahead of the submitted revision open, and marks a failed wait', async () => {
    const listeners = stubWindow('?bench=1');
    const frames: ((timestampMs: number) => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: (timestampMs: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    const state = new bench.Bench(bench.benchQuery('?bench=1')!);
    const inner = accepting();
    state.wrapRenderer(asSync(inner));
    let submitted = 0;
    let fail: (error: Error) => void = () => {};
    state.attach(
      {
        setMode: () => {},
        startFrameMeasurements: () => {},
        stopFrameMeasurements: () => null,
        getFrameMeasurements: () => null,
        getStatistics: () => ({ framesSubmitted: submitted }),
        waitForSubmittedWork: () => new Promise<void>((_, reject) => (fail = reject)),
      },
      {},
    );
    const [before, after] = listeners.get('pointermove') ?? [];
    const event = { timeStamp: 700, getCoalescedEvents: () => [{ timeStamp: 690 }] };
    before!(event);
    inner.applyChanges({ inserted: [] });
    after!(event);
    expect(state.latencies).toEqual([{ inputMs: 690, revision: 2, doneMs: null }]);
    // A submission whose scene is behind the input's revision does not end it.
    inner.setRevision(1);
    state.clock.request(() => {
      submitted += 1;
    });
    frames.shift()!(800);
    expect(state.latencies[0]!.doneMs).toBeNull();
    // The next submission at its revision claims it; a rejected wait marks it failed.
    inner.setRevision(2);
    state.clock.request(() => {
      submitted += 1;
    });
    frames.shift()!(816);
    expect(state.latencies[0]!.doneMs).toBeNaN();
    fail(new Error('device lost'));
    await Promise.resolve();
    await Promise.resolve();
    expect(state.latencies[0]).toMatchObject({ doneMs: Number.NaN, failed: true });
    state.dispose();
  });

  it('leaves the renderer unwrapped without ?reject=', () => {
    stubWindow('?bench=1');
    const state = new bench.Bench(bench.benchQuery('?bench=1')!);
    const inner = accepting();
    expect(state.wrapRenderer(asSync(inner))).toBe(inner);
    state.dispose();
  });

  it('records the start and end of every autosave write', async () => {
    stubWindow('?bench=1&persist=1');
    const state = new bench.Bench(bench.benchQuery('?bench=1&persist=1')!);
    let finish: (value: { ok: true }) => void = () => {};
    const store = state.wrapStore({
      read: () => Promise.resolve({ ok: true, envelope: null }),
      write: () => new Promise((resolve) => (finish = resolve)),
      clear: () => Promise.resolve({ ok: true }),
      close: () => {},
    } as never);
    const pending = store.write({} as never);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({ endMs: null, ok: null });
    finish({ ok: true });
    await pending;
    expect(state.writes[0]!.ok).toBe(true);
    expect(state.writes[0]!.endMs).toBeGreaterThanOrEqual(state.writes[0]!.startMs);
    expect(bench.benchDatabaseName('db')).toMatch(/^db-bench-/);
    expect(bench.benchDatabaseName('db')).not.toBe(bench.benchDatabaseName('db'));
    state.dispose();
  });

  it('serves only the two scenario documents', async () => {
    for (const query of ['', '?doc=../package', '?doc=m1-a13.json', '?doc=other']) {
      const response = await route.GET(new Request(`http://host/e26-bench-doc.json${query}`));
      expect(response.status, query).toBe(404);
    }
  });
});
