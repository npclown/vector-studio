import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateP2GeometryCorpus } from '../../packages/geometry-reference/src/index.js';
import {
  createGeometrySession,
  GeometrySession,
  type GeometryRequest,
  type GeometryKernelExports,
} from '../../packages/geometry-wasm/src/index.js';

let module: WebAssembly.Module;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
});

function request(nodeId = 'node', revision = 1): GeometryRequest {
  return {
    domainId: 'document/page',
    nodeId,
    requestId: 17,
    sourceEpoch: 1,
    sourceRevision: revision,
    verbs: new Uint8Array([0, 2]),
    points: new Float64Array([0, 0, 1, 0, 2, 0, 3, 0]),
    strokeStyleHash: 'solid',
    fillRule: 'nonzero',
    world: [1, 0, 0, 1],
    zoom: 1,
    devicePixelRatio: 1,
  };
}

function batch(session: GeometrySession, requests: readonly GeometryRequest[]) {
  const result = session.batch(requests);
  if (result.status !== 'OK') throw new Error(JSON.stringify(result));
  return result.results;
}

describe('P2 private adapter with real release WASM', () => {
  it('reuses sufficient arenas without reserve and still grows/retries when capacity is exhausted', async () => {
    const instance = await WebAssembly.instantiate(module, {});
    const kernel = instance.exports as unknown as GeometryKernelExports;
    let reserveCalls = 0;
    let processCalls = 0;
    const session = new GeometrySession(
      {
        ...kernel,
        reserve: (input, output) => {
          reserveCalls++;
          return kernel.reserve(input, output);
        },
        process: (length) => {
          processCalls++;
          return kernel.process(length);
        },
      },
      { cache: { maxNodes: 0, maxVariants: 0, maxPayloadBytes: 0 } },
    );
    const prepared = batch(session, [request()]);
    expect(reserveCalls).toBe(2);
    expect(processCalls).toBe(2);
    reserveCalls = 0;
    processCalls = 0;
    const epoch = kernel.memory_epoch();
    expect(batch(session, [request()])).toEqual(prepared);
    expect(reserveCalls).toBe(0);
    expect(processCalls).toBe(1);
    expect(kernel.memory_epoch()).toBe(epoch + 1);
    const more = [request('one'), request('two')];
    expect(batch(session, more)).toHaveLength(2);
    expect(reserveCalls).toBe(2);
    expect(processCalls).toBe(3);
    reserveCalls = 0;
    processCalls = 0;
    expect(batch(session, more)).toHaveLength(2);
    expect(reserveCalls).toBe(0);
    expect(processCalls).toBe(1);
    session.dispose();
  });

  it('accounts typed payload exactly and separates style/fill/bucket variants before an epoch reset', async () => {
    const session = await createGeometrySession(module);
    const a = request('a', 100);
    const b = request('b');
    batch(session, [a, b]);
    // Each input owns 2 verb bytes + 8 f64s; each result owns 2 verbs,
    // 4 f64s and 6 u32 provenance values. Bounds/string/object overhead is excluded.
    expect(session.snapshotStatistics().retainedPayloadBytes).toBe(2 * (66 + 58));
    const before = session.snapshotStatistics().kernelPathBuilds;
    batch(session, [{ ...a, strokeStyleHash: 'other' }]);
    batch(session, [{ ...a, fillRule: 'evenodd' }]);
    batch(session, [{ ...a, zoom: 2 }]);
    expect(session.snapshotStatistics().kernelPathBuilds - before).toBe(3);
    expect(session.snapshotStatistics().variantEntries).toBe(5);
    expect(session.snapshotStatistics().retainedPayloadBytes).toBe(2 * 66 + 5 * 58);
    batch(session, [{ ...a, sourceEpoch: 2, sourceRevision: 0 }]);
    expect(session.snapshotStatistics().variantEntries).toBe(2);
    expect(session.snapshotStatistics().retainedPayloadBytes).toBe(2 * (66 + 58));
    const after = session.snapshotStatistics().kernelPathBuilds;
    expect(batch(session, [a, b]).map((value) => value.status)).toEqual(['STALE_SOURCE', 'OK']);
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(after);
    session.dispose();
  });

  it('rejects aggregate oversized input before revision mutation and bounds all-cache-hit output', async () => {
    const session = await createGeometrySession(module);
    const original = request();
    batch(session, [original]);
    const wide = { ...request('wide'), points: new Float64Array(8192) };
    const before = session.snapshotStatistics();
    expect(
      session.batch([
        { ...original, sourceRevision: 2 },
        ...Array.from({ length: 1024 }, () => wide),
      ]),
    ).toMatchObject({
      status: 'BATCH_ERROR',
      error: { code: 'RESOURCE_LIMIT' },
    });
    expect(batch(session, [original])[0]?.status).toBe('OK');
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(before.kernelPathBuilds);
    const fixture = generateP2GeometryCorpus()[6059]!;
    const large: GeometryRequest = {
      ...request('large-output'),
      points: new Float64Array(fixture.cubic.flat()),
      world: fixture.world,
      zoom: fixture.zoom,
      devicePixelRatio: fixture.dpr,
    };
    const generated = batch(session, [large])[0]!;
    if (generated.status !== 'OK') throw new Error('Expected 8192-leaf fixture success');
    expect(generated.verbs).toHaveLength(8193);
    const built = session.snapshotStatistics().kernelPathBuilds;
    expect(session.batch(Array.from({ length: 1200 }, () => large))).toMatchObject({
      status: 'BATCH_ERROR',
      error: { code: 'RESOURCE_LIMIT' },
    });
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(built);
    expect(batch(session, [large])[0]?.status).toBe('OK');
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(built);
    session.dispose();
  });

  it('rejects sparse envelopes without breaking the session and handles numeric bucket extremes', async () => {
    const session = await createGeometrySession(module);
    expect(session.batch(new Array<GeometryRequest>(1))).toMatchObject({
      status: 'BATCH_ERROR',
      error: { code: 'INVALID_REQUEST' },
    });
    expect(batch(session, [request()])[0]?.status).toBe('OK');
    expect(batch(session, [{ ...request('nan-zoom'), zoom: Number.NaN }])[0]?.status).toBe(
      'INVALID_TOLERANCE',
    );
    expect(
      batch(session, [
        {
          ...request('factor-underflow'),
          zoom: Number.MIN_VALUE,
          devicePixelRatio: Number.MIN_VALUE,
        },
      ])[0]?.status,
    ).toBe('NUMERIC_RANGE');
    expect(
      batch(session, [
        {
          ...request('matrix-underflow'),
          world: [Number.MIN_VALUE, 0, 0, Number.MIN_VALUE],
          zoom: Number.MIN_VALUE,
        },
      ])[0]?.status,
    ).toBe('NUMERIC_RANGE');
    const scale = 0.25 / Number.MAX_VALUE + Number.MIN_VALUE;
    expect(
      batch(session, [{ ...request('huge-tolerance'), world: [scale, 0, 0, scale] }])[0]?.status,
    ).toBe('OK');
    const collapsed = batch(session, [{ ...request('collapsed'), world: [0, 0, 0, 0] }])[0]!;
    if (collapsed.status !== 'OK')
      throw new Error('Collapsed transform must preserve local geometry');
    expect(Array.from(collapsed.points.slice(-2))).toEqual([3, 0]);
    expect(collapsed.bounds.maxX).toBeGreaterThanOrEqual(3);
    const builds = session.snapshotStatistics().kernelPathBuilds;
    expect(batch(session, [{ ...request(), world: [1, 0, 0, 0] }])[0]?.status).toBe('OK');
    const angle = Math.PI / 7;
    batch(session, [
      {
        ...request(),
        world: [Math.cos(angle), -Math.sin(angle), Math.sin(angle), Math.cos(angle)],
      },
    ]);
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(builds);
    session.dispose();
  });

  it('preserves path-first errors and reuses only compatible physical tolerance buckets', async () => {
    const session = await createGeometrySession(module);
    expect(
      batch(session, [
        {
          ...request('invalid'),
          verbs: new Uint8Array([1]),
          points: new Float64Array([Number.NaN, 0]),
          zoom: 0,
        },
      ])[0]?.status,
    ).toBe('INVALID_PATH');
    expect(batch(session, [{ ...request('bad-zoom'), zoom: 0 }])[0]?.status).toBe(
      'INVALID_TOLERANCE',
    );
    expect(
      batch(session, [{ ...request('bad-world'), world: [Number.NaN, 0, 0, 1] }])[0]?.status,
    ).toBe('NUMERIC_RANGE');
    const curve = { ...request(), points: new Float64Array([0, 0, 0, 3, 3, 3, 3, 0]) };
    batch(session, [curve]);
    const initial = session.snapshotStatistics();
    batch(session, [{ ...curve, world: [0, -1, 1, 0] }]);
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(initial.kernelPathBuilds);
    batch(session, [{ ...curve, world: [2, 0, 0, 2] }]);
    const scaled = session.snapshotStatistics();
    expect(scaled.kernelPathBuilds).toBeGreaterThan(initial.kernelPathBuilds);
    batch(session, [{ ...curve, world: [0, -1, 1, 0], devicePixelRatio: 2 }]);
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(scaled.kernelPathBuilds);
    batch(session, [{ ...curve, world: [1, 3, 0, 1] }]);
    expect(session.snapshotStatistics().kernelPathBuilds).toBeGreaterThan(scaled.kernelPathBuilds);
    session.dispose();
  });

  it('batches 10000 paths, reuses unchanged input and rebuilds only the edited path', async () => {
    const session = await createGeometrySession(module);
    const requests = Array.from({ length: 10_000 }, (_, index) => ({
      ...request(`node-${index}`),
      requestId: index,
    }));
    const initial = batch(session, requests);
    expect(initial).toHaveLength(10_000);
    expect(initial.every((result) => result.status === 'OK')).toBe(true);
    const built = session.snapshotStatistics();
    expect(built.kernelPathBuilds).toBeGreaterThanOrEqual(10_000);
    expect(built.kernelPathBuilds).toBeLessThanOrEqual(20_000);
    expect(built.variantEntries).toBe(10_000);
    expect(built.residentNodes).toBe(10_000);
    expect(built.retainedPayloadBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    batch(session, requests);
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(built.kernelPathBuilds);
    expect(session.snapshotStatistics().hits - built.hits).toBe(10_000);

    const edited = requests.map((value, index) =>
      index === 4321
        ? {
            ...value,
            sourceRevision: 2,
            points: new Float64Array([0, 0, 1, 1, 2, 1, 3, 0]),
          }
        : value,
    );
    const results = batch(session, edited);
    expect(results[4321]?.sourceRevision).toBe(2);
    expect(session.snapshotStatistics().kernelPathBuilds - built.kernelPathBuilds).toBe(1);
    const afterEdit = session.snapshotStatistics().kernelPathBuilds;
    batch(
      session,
      edited.map((value, index) => (index === 4321 ? { ...value, devicePixelRatio: 2 } : value)),
    );
    expect(session.snapshotStatistics().kernelPathBuilds - afterEdit).toBe(1);
    expect(session.snapshotStatistics().variantEntries).toBe(10_000);
    expect(session.snapshotStatistics().residentNodes).toBe(9_999);
    expect(session.snapshotStatistics().evictions).toBe(1);
    session.dispose();
    expect(session.snapshotStatistics().retainedPayloadBytes).toBe(0);
    expect(session.snapshotStatistics().variantEntries).toBe(0);
  });

  it('owns input and output copies across hits, subsequent calls, growth and disposal', async () => {
    const session = await createGeometrySession(module);
    const source = request();
    const first = batch(session, [source])[0]!;
    if (first.status !== 'OK') throw new Error('Expected successful geometry');
    const original = Array.from(first.points);
    first.points[0] = 999;
    first.verbs[0] = 99;
    first.provenance[0] = 99;
    const hit = batch(session, [{ ...source, requestId: 99 }])[0]!;
    if (hit.status !== 'OK') throw new Error('Expected cache hit');
    expect(hit.requestId).toBe(99);
    expect(Array.from(hit.points)).toEqual(original);
    expect(hit.verbs[0]).toBe(0);
    expect(hit.provenance[0]).toBe(0);
    source.points[0] = 6;
    expect(batch(session, [source])[0]?.status).toBe('REVISION_CONFLICT');
    const before = session.snapshotStatistics().liveLinearMemoryBytes;
    batch(
      session,
      Array.from({ length: 2000 }, (_, index) => request(`growth-${index}`)),
    );
    expect(session.snapshotStatistics().liveLinearMemoryBytes).toBeGreaterThan(before);
    session.dispose();
    session.dispose();
    expect(Array.from(hit.points)).toEqual(original);
    expect(session.batch([request()]).status).toBe('BATCH_ERROR');
    const replacement = await createGeometrySession(module);
    expect(batch(replacement, [request()])[0]?.status).toBe('OK');
    replacement.dispose();
  });

  it('keeps opaque identities separate and evicts a whole node at the LRU limit', async () => {
    const session = await createGeometrySession(module, { cache: { maxNodes: 2, maxVariants: 3 } });
    const a = { ...request('b/c'), domainId: 'a' };
    const b = {
      ...request('c'),
      domainId: 'a/b',
      points: new Float64Array([0, 0, 1, 1, 2, 1, 3, 0]),
    };
    expect(batch(session, [a, b]).map((value) => value.status)).toEqual(['OK', 'OK']);
    batch(session, [{ ...a, zoom: 2 }]);
    expect(session.snapshotStatistics().variantEntries).toBe(3);
    batch(session, [a]);
    batch(session, [request('third')]);
    expect(session.snapshotStatistics().residentNodes).toBe(2);
    expect(session.snapshotStatistics().variantEntries).toBe(3);
    const builds = session.snapshotStatistics().kernelPathBuilds;
    batch(session, [{ ...a, zoom: 2 }]);
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(builds);
    expect(batch(session, [{ ...b, points: a.points }])[0]?.status).toBe('OK');
    expect(session.snapshotStatistics().kernelPathBuilds).toBeGreaterThan(builds);
    session.dispose();
  });

  it('invalidates old revisions before a failed build and prevents older in-batch cache publication', async () => {
    const session = await createGeometrySession(module);
    const source = request();
    batch(session, [source]);
    const invalid = {
      ...source,
      sourceRevision: 2,
      verbs: new Uint8Array([1]),
      points: new Float64Array([4, 5]),
    };
    expect(batch(session, [invalid])[0]?.status).toBe('INVALID_PATH');
    expect(
      batch(session, [{ ...source, strokeStyleHash: 'other', fillRule: 'evenodd', zoom: 4 }])[0]
        ?.status,
    ).toBe('STALE_SOURCE');
    const updated = {
      ...source,
      sourceRevision: 3,
      points: new Float64Array([0, 0, 1, 1, 2, 1, 3, 0]),
    };
    expect(batch(session, [updated])[0]?.status).toBe('OK');
    expect(batch(session, [{ ...source, sourceRevision: 3 }])[0]?.status).toBe('REVISION_CONFLICT');
    batch(session, [
      request('same-batch', 1),
      { ...request('same-batch', 2), points: updated.points },
    ]);
    const builds = session.snapshotStatistics().kernelPathBuilds;
    expect(
      batch(session, [{ ...request('same-batch', 2), points: updated.points }])[0]?.status,
    ).toBe('OK');
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(builds);
    expect(batch(session, [request('same-batch', 1)])[0]?.status).toBe('STALE_SOURCE');
    session.dispose();
  });

  it('retains a fitting registry/coarse variant when a finer result exceeds the payload budget', async () => {
    const session = await createGeometrySession(module, { cache: { maxPayloadBytes: 256 } });
    const source = {
      ...request(),
      points: new Float64Array([0, 0, 0, 20, 20, 20, 20, 0]),
      zoom: 0.01,
    };
    expect(batch(session, [source])[0]?.status).toBe('OK');
    const coarse = session.snapshotStatistics();
    expect(coarse.variantEntries).toBe(1);
    expect(batch(session, [{ ...source, zoom: 64 }])[0]?.status).toBe('OK');
    const fine = session.snapshotStatistics();
    expect(fine.variantEntries).toBe(1);
    expect(fine.residentNodes).toBe(1);
    expect(fine.retainedPayloadBytes).toBe(coarse.retainedPayloadBytes);
    batch(session, [source]);
    expect(session.snapshotStatistics().kernelPathBuilds).toBe(fine.kernelPathBuilds);
    const oversizeInput = {
      ...source,
      sourceRevision: 2,
      verbs: new Uint8Array(32),
      points: new Float64Array(64),
    };
    expect(batch(session, [oversizeInput])[0]?.status).toBe('OK');
    expect(session.snapshotStatistics().residentNodes).toBe(0);
    expect(session.snapshotStatistics().retainedPayloadBytes).toBe(0);
    expect(batch(session, [source])[0]?.status).toBe('OK');
    session.dispose();
  });

  it('fails closed when a real process call unexpectedly grows memory', async () => {
    const instance = await WebAssembly.instantiate(module);
    const exports = instance.exports;
    const process = exports.process as (length: number) => number;
    const memory = exports.memory as WebAssembly.Memory;
    const session = new GeometrySession({
      ...exports,
      process(length: number) {
        const status = process(length);
        memory.grow(1);
        return status;
      },
    } as unknown as ConstructorParameters<typeof GeometrySession>[0]);
    expect(session.batch([request()]).status).toBe('BATCH_ERROR');
    expect(session.batch([request()]).status).toBe('BATCH_ERROR');
    expect(session.snapshotStatistics().retainedPayloadBytes).toBe(0);
    session.dispose();
  });

  it.each([
    'reserved',
    'source-token',
    'epoch',
    'nonfinite-point',
    'bounds',
    'provenance',
  ] as const)(
    'rejects a corrupted real-kernel %s result without partial publication',
    async (mutation) => {
      const instance = await WebAssembly.instantiate(module);
      const exports = instance.exports;
      const process = exports.process as (length: number) => number;
      const get = (name: string) => (exports[name] as () => number)();
      const memory = exports.memory as WebAssembly.Memory;
      const session = new GeometrySession({
        ...exports,
        process(length: number) {
          const status = process(length);
          if (mutation === 'epoch') {
            (exports.reserve as (input: number, output: number) => number)(
              get('input_capacity'),
              get('output_capacity'),
            );
          } else if (status === 0) {
            const view = new DataView(memory.buffer);
            const output = get('output_ptr');
            if (mutation === 'nonfinite-point') {
              view.setFloat64(output + view.getUint32(output + 32, true), Number.NaN, true);
            } else if (mutation === 'bounds') {
              view.setFloat64(output + view.getUint32(output + 24, true) + 32, 1e9, true);
            } else if (mutation === 'provenance') {
              view.setUint32(output + view.getUint32(output + 36, true) + 8, 21, true);
            } else {
              const offset = mutation === 'reserved' ? 40 : view.getUint32(output + 24, true);
              view.setUint32(output + offset, 0xffffffff, true);
            }
          }
          return status;
        },
      } as unknown as ConstructorParameters<typeof GeometrySession>[0]);
      expect(session.batch([request('first'), request('second')]).status).toBe('BATCH_ERROR');
      expect(session.snapshotStatistics().variantEntries).toBe(0);
      expect(session.batch([request()]).status).toBe('BATCH_ERROR');
      session.dispose();
    },
  );
});
