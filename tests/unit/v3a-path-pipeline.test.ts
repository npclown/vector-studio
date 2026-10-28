import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIAGNOSTIC_CODES,
  type FillMeshBatchResult,
  type FillMeshRequest,
  type RendererInvalidationTarget,
  type RenderNodeSnapshot,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { E_MAX } from '../../packages/renderer-core/src/path-buckets.js';
import { buildPathFringe, pathFringeBytes } from '../../packages/renderer-core/src/path-fringe.js';
import {
  PATH_MESH_LIMITS,
  pathMeshNoticeDiagnostic,
  type PathFringeBuilder,
  type PathMeshNotice,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { FillMeshPortDouble } from '../support/fill-mesh-port-double.js';
import {
  ScriptedFillMeshPort,
  createCountingPort,
  createFailingPort,
  createPathHarness,
  createRangePort,
  failedResult,
  fringeDouble,
  identity,
  meshBytes,
  okResult,
  pathNode,
  rectangleNode,
  squareMesh,
  target,
} from '../support/v3a-path-harness.js';

// P3 V3 contract unit V3a: port consumption (section b), buckets in use (c), cache and memo
// (d) and the failure outcome (h). Functional evidence only: precision is UNVERIFIED.

const tagsOf = (port: ScriptedFillMeshPort, call = -1) =>
  port.calls.at(call)!.map((request) => request.tag);

function notice(
  nodeId: string | null,
  failureScope: PathMeshNotice['failureScope'],
  failureCode: PathMeshNotice['failureCode'],
  toleranceExponent: number | null,
): PathMeshNotice {
  // B2 stroke contract, section 9.8 (ST-U6): a fill-only notice carries paint 'fill', except the
  // paint-free port-version and mesh-pipeline-unavailable codes.
  const paint =
    failureCode === 'port-version' || failureCode === 'mesh-pipeline-unavailable' ? null : 'fill';
  return { nodeId, failureScope, failureCode, toleranceExponent, paint };
}

describe('V3a port consumption and cache key', () => {
  it('V3-A3: color, opacity, order, translation and an e-preserving transform make zero port calls', () => {
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: [pathNode('a', 0), pathNode('b', 20)] });
    expect(h.drawnIds()).toEqual(['a', 'b']);
    expect(port.callCount).toBe(1);
    const edits: Array<readonly [RenderNodeSnapshot[], string[]?]> = [
      [[pathNode('a', 0, { fill: { r: 0, g: 1, b: 0, a: 0.5 } }), pathNode('b', 20)]],
      [[pathNode('a', 0, { opacity: 0.25 }), pathNode('b', 20)]],
      [
        [pathNode('a', 0), pathNode('b', 20)],
        ['b', 'a'],
      ],
      [[pathNode('a', 0, { transform: [1, 0, 0, 1, 30, 40] }), pathNode('b', 20)]],
      [[pathNode('a', 0, { transform: [0, 1, -1, 0, 100, 0] }), pathNode('b', 20)]],
      [[pathNode('a', 0, { transform: [0.9, 0, 0, 0.9, 0, 0] }), pathNode('b', 20)]],
    ];
    for (const [nodes, order] of edits) {
      expect(h.replace(nodes, order).status).toBe('applied');
      h.prepare();
    }
    h.setZoom(1, { x: -3.5, y: 2.25 });
    expect(h.drawnIds()).toEqual(['a', 'b']);
    expect(port.callCount).toBe(1);
  });

  it('V3-A3: a geometry or fillRule change calls once with exactly that node', () => {
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: [pathNode('a', 0), pathNode('b', 20)] });
    h.prepare();
    h.replace([pathNode('a', 0), pathNode('b', 21)]);
    expect(h.drawnIds()).toEqual(['a', 'b']);
    expect(port.callCount).toBe(2);
    expect(tagsOf(port)).toEqual([21]);
    h.replace([pathNode('a', 0, { fillRule: 'evenodd' }), pathNode('b', 21)]);
    h.prepare();
    expect(port.callCount).toBe(3);
    expect(port.calls.at(-1)).toEqual([
      { requestId: 0, tag: 0, toleranceExponent: -3, fillRule: 'evenodd' },
    ]);
    h.prepare();
    expect(port.callCount).toBe(3);
  });

  it('V3-A3: an operationId change rebuilds every drawn path once', () => {
    const port = createCountingPort();
    const h = createPathHarness({
      port,
      nodes: [pathNode('a', 0), pathNode('b', 20), pathNode('hidden', 40, { visible: false })],
    });
    h.prepare();
    port.operationId = 'test/v3a-double-2';
    expect(h.drawnIds()).toEqual(['a', 'b']);
    expect(port.callCount).toBe(2);
    expect(tagsOf(port)).toEqual([0, 20]);
    h.prepare();
    expect(port.callCount).toBe(2);
  });

  it('V3-A3: a portVersion change calls nothing and serves nothing', () => {
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: [pathNode('a', 0), pathNode('b', 20)] });
    h.prepare();
    port.setPortVersion(1);
    const frame = h.prepare();
    expect(frame.draws).toEqual([]);
    expect(frame.notices).toEqual([
      notice('a', 'renderer', 'port-version', null),
      notice('b', 'renderer', 'port-version', null),
    ]);
    expect(h.prepare().notices).toEqual([]);
    expect(port.callCount).toBe(1);
    port.setPortVersion(0);
    expect(h.drawnIds()).toEqual(['a', 'b']);
    expect(port.callCount).toBe(1);
  });

  it('V3-A4: one batch per prepare with requestId equal to the batch index, and no call when nothing is missing', () => {
    const port = createCountingPort();
    const h = createPathHarness({
      port,
      nodes: [pathNode('a', 0), pathNode('b', 20), pathNode('c', 40)],
    });
    h.prepare();
    expect(port.calls).toEqual([
      [
        { requestId: 0, tag: 0, toleranceExponent: -3, fillRule: 'nonzero' },
        { requestId: 1, tag: 20, toleranceExponent: -3, fillRule: 'nonzero' },
        { requestId: 2, tag: 40, toleranceExponent: -3, fillRule: 'nonzero' },
      ],
    ]);
    h.prepare();
    h.prepare({ ...target, generation: 2 });
    expect(port.callCount).toBe(1);
  });

  it('V3-A4: hidden, fill null, empty, singular and culled paths call nothing', () => {
    const port = createCountingPort();
    const group: RenderNodeSnapshot = {
      id: 'group',
      parentId: null,
      transform: [1, 0, 0, 1, 0, 0],
      visible: false,
      opacity: 1,
      kind: 'container',
      clip: null,
      children: ['inGroup'],
    };
    const h = createPathHarness({
      port,
      nodes: [
        pathNode('hidden', 0, { visible: false }),
        group,
        pathNode('inGroup', 10, { parentId: 'group' }),
        pathNode('noFill', 20, { fill: null }),
        pathNode('empty', 30, { verbs: [], points: [] }),
        pathNode('singular', 40, { transform: [1, 1, 1, 1, 0, 0] }),
        pathNode('zero', 50, { transform: [0, 0, 0, 0, 0, 0] }),
        pathNode('culled', 5_000),
      ],
    });
    expect(h.prepare().draws).toEqual([]);
    expect(port.callCount).toBe(0);
    h.setZoom(1, { x: 4_900, y: 0 });
    expect(h.drawnIds()).toEqual(['culled']);
    expect(port.calls).toEqual([
      [{ requestId: 0, tag: 5_000, toleranceExponent: -3, fillRule: 'nonzero' }],
    ]);
  });
});

describe('V3a buckets in the pipeline', () => {
  it('V3-A5: e below E_MIN is tolerance-range with no call, notified once', () => {
    const port = createCountingPort();
    const big = 2 ** 1000;
    const h = createPathHarness({
      port,
      nodes: [pathNode('a', 0, { transform: [big, 0, 0, big, 0, 0] })],
    });
    h.setZoom(2 ** 20);
    expect(h.prepare().notices).toEqual([notice('a', 'renderer', 'tolerance-range', null)]);
    expect(h.prepare().notices).toEqual([]);
    expect(port.callCount).toBe(0);
  });

  it('V3-A5: f outside [F_MIN, F_MAX] is fringe-range with no call', () => {
    const port = createCountingPort();
    const h = createPathHarness({
      port,
      nodes: [pathNode('a', 0, { transform: [1, 0, 0, 2 ** -1030, 0, 0] })],
    });
    expect(h.prepare()).toEqual({
      draws: [],
      notices: [notice('a', 'renderer', 'fringe-range', null)],
    });
    expect(port.callCount).toBe(0);
  });

  it('V3-A5: the E_MAX clamp leaves e > E_MAX unsent here because f exceeds F_MAX first', () => {
    // Interpretation recorded in the plan: e > E_MAX needs sigmaMax < 2^-1026, so
    // sigmaMin <= sigmaMax gives f >= 1028 > F_MAX and the fringe-range state applies.
    const port = createCountingPort();
    const tiny = 2 ** -1040;
    const h = createPathHarness({
      port,
      nodes: [pathNode('a', 0, { transform: [tiny, 0, 0, tiny, 0, 0] })],
    });
    expect(h.prepare().notices).toEqual([notice('a', 'renderer', 'fringe-range', null)]);
    expect(port.callCount).toBe(0);
    expect(E_MAX).toBe(1023);
  });

  it('V3-A5: an exact nonzero determinant whose f32 lanes give zero or the opposite sign is packing-range with no call', () => {
    const port = createCountingPort();
    const h = createPathHarness({
      port,
      nodes: [
        pathNode('zero', 0, { transform: [1, 1 + 2 ** -40, 1, 1, 100, 0] }),
        pathNode('opposite', 20, {
          transform: [
            1 + 2 ** -24 - 2 ** -41,
            1,
            1 + 2 ** -24 + 2 ** -41,
            1 + 2 ** -24 - 2 ** -41,
            100,
            0,
          ],
        }),
      ],
    });
    expect(h.prepare()).toEqual({
      draws: [],
      notices: [
        notice('zero', 'renderer', 'packing-range', null),
        notice('opposite', 'renderer', 'packing-range', null),
      ],
    });
    expect(port.callCount).toBe(0);
  });

  it('V3-A5: a port answer of invalid-tolerance is authoritative and memoized', () => {
    const port = createRangePort(-10, 10);
    const h = createPathHarness({ port, nodes: [pathNode('a', 0)] });
    h.setZoom(512);
    expect(h.prepare()).toEqual({
      draws: [],
      notices: [notice('a', 'path', 'invalid-tolerance', -12)],
    });
    h.prepare();
    expect(port.callCount).toBe(1);
    h.setZoom(1);
    expect(h.drawnIds()).toEqual(['a']);
    expect(port.callCount).toBe(2);
  });

  it('V3-A5: a pan never recomputes the buckets', () => {
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: [pathNode('a', 0)] });
    h.prepare();
    const computed = h.statistics().bucketComputations;
    for (const x of [1, 2.5, -3, 7]) {
      h.setZoom(1, { x, y: x / 2 });
      h.prepare();
    }
    expect(h.statistics().bucketComputations).toBe(computed);
    h.setZoom(2);
    h.prepare();
    expect(h.statistics().bucketComputations).toBe(computed + 1);
  });
});

describe('V3a reuse rule', () => {
  function served(h: ReturnType<typeof createPathHarness>): number[] {
    return h.prepare().draws.map((draw) => draw.toleranceExponent);
  }

  it('V3-A6: after a build at e, buckets e + 1 and e + 2 serve it with no call', () => {
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: [pathNode('a', 0)] });
    expect(served(h)).toEqual([-3]);
    h.setZoom(0.5);
    expect(served(h)).toEqual([-3]);
    h.setZoom(0.25);
    expect(served(h)).toEqual([-3]);
    expect(port.callCount).toBe(1);
  });

  it('V3-A6: buckets e + 3 and e - 1 call', () => {
    const coarse = createCountingPort();
    const h = createPathHarness({ port: coarse, nodes: [pathNode('a', 0)] });
    h.prepare();
    h.setZoom(0.125);
    expect(served(h)).toEqual([0]);
    expect(coarse.calls.at(-1)![0]!.toleranceExponent).toBe(0);
    const fine = createCountingPort();
    const g = createPathHarness({ port: fine, nodes: [pathNode('a', 0)] });
    g.prepare();
    g.setZoom(2);
    expect(served(g)).toEqual([-4]);
    expect(fine.callCount).toBe(2);
  });

  it('V3-A6: a coarser entry never serves', () => {
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: [pathNode('a', 0)] });
    h.setZoom(0.5);
    expect(served(h)).toEqual([-2]);
    h.setZoom(1);
    expect(served(h)).toEqual([-3]);
    expect(port.calls.map((call) => call[0]!.toleranceExponent)).toEqual([-2, -3]);
  });
});

describe('V3a cache accounting and eviction', () => {
  const fringeArrays = (f: number) => [
    new Float32Array(8),
    new Uint32Array(8 * (2 + Math.abs(f))),
    new Uint32Array(3),
    new Uint32Array(16),
  ];
  const fringeBytes = (f: number) =>
    fringeArrays(f).reduce((sum, array) => sum + array.byteLength, 0);
  // V3c: the seam returns a structured fringe; the double's four arrays are its owned arrays.
  const fringeOf = (f: number) => {
    const [corners, triangles, lists, features] = fringeArrays(f) as [
      Float32Array,
      Uint32Array,
      Uint32Array,
      Uint32Array,
    ];
    return fringeDouble(corners, triangles, lists, features);
  };

  it('V3-A7: bytes equal the sum of owned byteLengths per entry and per fringe variant, corners included', () => {
    const meshes = new Map([
      [0, squareMesh(10, 0)],
      [20, squareMesh(10, 5)],
    ]);
    const port = new ScriptedFillMeshPort({
      request: (request, tag) => okResult(request, meshes.get(tag)),
    });
    const h = createPathHarness({ port, nodes: [pathNode('a', 0), pathNode('b', 20)] });
    h.prepare();
    const expected = meshBytes(meshes.get(0)!) + meshBytes(meshes.get(20)!);
    expect(h.statistics()).toMatchObject({ entries: 2, bytes: expected, peakBytes: expected });
    expect(h.statistics()).not.toHaveProperty('portLinearMemoryBytes');

    const builder: PathFringeBuilder = (_mesh, f) => ({ status: 'built', fringe: fringeOf(f) });
    const withFringe = createPathHarness({
      port: createCountingPort(),
      nodes: [pathNode('a', 0)],
      fringeBuilder: builder,
    });
    const frame = withFringe.prepare();
    expect(frame.draws.map((draw) => draw.fringeBucket)).toEqual([1]);
    expect(withFringe.statistics().bytes).toBe(meshBytes(squareMesh()) + fringeBytes(1));
  });

  it('V3-A7: portLinearMemoryBytes reports the injected hook, read once per prepare', () => {
    let reads = 0;
    const h = createPathHarness({
      port: createCountingPort(),
      nodes: [pathNode('a', 0)],
      memoryBytes: () => {
        reads += 1;
        return 65_536;
      },
    });
    h.prepare();
    expect(reads).toBe(1);
    expect(h.statistics()).toMatchObject({
      bytes: 152,
      portLinearMemoryBytes: 65_536,
      pathMeshMemoryBytes: 65_688,
    });
    const invalidation: RendererInvalidationTarget = {
      invalidate: () => undefined,
      setMode: () => undefined,
    };
    const service = new PrimitiveRendererService(invalidation, {
      fillMesh: createCountingPort(),
      fillMeshMemoryBytes: () => 1_024,
    });
    service.replaceSnapshot({ identity, revision: 1, nodes: [pathNode('a', 0)], rootOrder: ['a'] });
    service.prepare(target);
    // V3c: the service installs the exact fringe builder, so its entry also owns one variant.
    const fringe = buildPathFringe(squareMesh(), 1);
    if (fringe.status !== 'built') throw new Error('square fringe not built');
    const bytes = 152 + pathFringeBytes(fringe.fringe);
    expect(service.getPathMeshStatistics()).toMatchObject({
      bytes,
      portLinearMemoryBytes: 1_024,
      pathMeshMemoryBytes: bytes + 1_024,
    });
    expect(new PrimitiveRendererService(invalidation).getPathMeshStatistics()).toBeNull();
  });

  it('V3-A7: unreachable entries drop at once on removal, geometry, fillRule and operationId changes', () => {
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: [pathNode('a', 0), pathNode('b', 20)] });
    h.prepare();
    expect(h.statistics().entries).toBe(2);
    h.replace([pathNode('a', 0)]);
    h.prepare();
    expect(h.statistics()).toMatchObject({ entries: 1, bytes: 152 });
    h.replace([pathNode('a', 0, { points: [0, 0, 10, 0, 10, 12] })]);
    h.prepare();
    expect(h.statistics()).toMatchObject({ entries: 1, bytes: 152 });
    h.replace([pathNode('a', 0, { points: [0, 0, 10, 0, 10, 12], fillRule: 'evenodd' })]);
    h.prepare();
    expect(h.statistics()).toMatchObject({ entries: 1 });
    // A hidden node's entry is reachable but an operationId change drops it at once.
    h.replace([
      pathNode('a', 0, { points: [0, 0, 10, 0, 10, 12], fillRule: 'evenodd', visible: false }),
    ]);
    port.operationId = 'test/next';
    h.prepare();
    expect(h.statistics()).toMatchObject({ entries: 0, bytes: 0, evictions: 0 });
    expect(port.callCount).toBe(3);
  });

  it('V3-A7: at most three tolerance variants per node, dropping the farthest from the current e', () => {
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: [pathNode('a', 0)] });
    for (const zoom of [1, 8, 64, 512]) {
      h.setZoom(zoom);
      h.prepare();
    }
    expect(port.calls.map((call) => call[0]!.toleranceExponent)).toEqual([-3, -6, -9, -12]);
    expect(h.statistics()).toMatchObject({ entries: 3, evictions: 1 });
    h.setZoom(8);
    h.prepare();
    expect(port.callCount).toBe(4);
    h.setZoom(1);
    h.prepare();
    expect(port.callCount).toBe(5);
  });

  it('V3-A7: at most two fringe variants per entry, dropping the farthest from the current f', () => {
    const built: number[] = [];
    const builder: PathFringeBuilder = (_mesh, f) => {
      built.push(f);
      return { status: 'built', fringe: fringeOf(f) };
    };
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: [pathNode('a', 0)], fringeBuilder: builder });
    for (const zoom of [1, 0.5, 0.25]) {
      h.setZoom(zoom);
      expect(h.prepare().draws).toHaveLength(1);
    }
    expect(built).toEqual([1, 2, 3]);
    expect(port.callCount).toBe(1);
    expect(h.statistics().bytes).toBe(152 + fringeBytes(2) + fringeBytes(3));
    // f = 1 is served by the f' = 2 variant (f <= f' <= f + 1) without a rebuild.
    h.setZoom(1);
    expect(h.prepare().draws.map((draw) => draw.fringeBucket)).toEqual([2]);
    expect(built).toEqual([1, 2, 3]);
  });

  it('V3-A7: budget eviction is least-recently-drawn outside the working set; a working set above budget is kept and counted', () => {
    const port = createCountingPort();
    const nodes = [pathNode('a', 0), pathNode('b', 20), pathNode('c', 40)];
    const h = createPathHarness({ port, nodes, limits: { byteBudget: 400 } });
    expect(h.drawnIds()).toEqual(['a', 'b', 'c']);
    expect(h.statistics()).toMatchObject({
      entries: 3,
      bytes: 456,
      peakBytes: 456,
      evictions: 0,
      overBudgetFrames: 1,
    });
    h.replace([
      pathNode('a', 0),
      pathNode('b', 20, { visible: false }),
      pathNode('c', 40, { visible: false }),
    ]);
    h.prepare();
    expect(h.statistics()).toMatchObject({
      entries: 2,
      bytes: 304,
      evictions: 1,
      overBudgetFrames: 1,
    });
    h.replace(nodes);
    expect(h.drawnIds()).toEqual(['a', 'b', 'c']);
    expect(tagsOf(port)).toEqual([20]);
    expect(PATH_MESH_LIMITS.byteBudget).toBe(67_108_864);
  });
});

describe('V3a failure classes, memo and notices', () => {
  it('V3-A8: a port-failed path is not drawn and not cached, others draw in order, and the memo stops repeat calls', () => {
    const port = createFailingPort({ pathFailures: new Map([[20, 'work-limit']]) });
    const h = createPathHarness({
      port,
      nodes: [pathNode('a', 0), pathNode('b', 20), pathNode('c', 40)],
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => draw.nodeId)).toEqual(['a', 'c']);
    expect(frame.notices).toEqual([notice('b', 'path', 'work-limit', -3)]);
    expect(h.statistics()).toMatchObject({ entries: 2, memoEntries: 1 });
    for (let index = 0; index < 100; index += 1) {
      expect(h.prepare().notices).toEqual([]);
    }
    expect(port.callCount).toBe(1);
    h.replace([pathNode('a', 0), pathNode('b', 21), pathNode('c', 40)]);
    expect(h.drawnIds()).toEqual(['a', 'b', 'c']);
    expect(port.callCount).toBe(2);
    expect(tagsOf(port)).toEqual([21]);
  });

  it('V3-A8: invalid-path is memoized without the exponent, so a zoom change makes no call', () => {
    const port = createFailingPort({ pathFailures: new Map([[0, 'invalid-path']]) });
    const h = createPathHarness({ port, nodes: [pathNode('a', 0)] });
    expect(h.prepare().notices).toEqual([notice('a', 'path', 'invalid-path', null)]);
    h.setZoom(64);
    h.prepare();
    expect(port.callCount).toBe(1);
  });

  it('V3-A8: one internal-error path in a batch of 16 is isolated within 2*ceil(log2 16) extra calls, depth-first left-first', () => {
    const tags = Array.from({ length: 16 }, (_, index) => index * 30);
    const port = createFailingPort({ batchFailures: new Map([[150, 'internal-error']]) });
    const memoAtCall: number[] = [];
    const nodes = tags.map((tag, index) => pathNode(`p${String(index).padStart(2, '0')}`, tag));
    const h = createPathHarness({ port, nodes });
    port.script.beforeCall = () => memoAtCall.push(h.statistics().memoEntries);
    const frame = h.prepare();
    const ranges = port.calls.map((call) => call.map((request) => request.tag / 30));
    const span = (first: number, end: number) =>
      Array.from({ length: end - first }, (_, index) => first + index);
    expect(ranges).toEqual([
      span(0, 16),
      span(0, 8),
      span(0, 4),
      span(4, 8),
      span(4, 6),
      [4],
      [5],
      span(6, 8),
      span(8, 16),
    ]);
    expect(port.callCount - 1).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(16)));
    for (const call of port.calls)
      expect(call.map((request) => request.requestId)).toEqual(span(0, call.length));
    // The failing leaf [5] is memoized before the next call.
    expect(memoAtCall).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1]);
    expect(frame.draws.map((draw) => draw.nodeId)).toEqual(
      nodes.map((node) => node.id).filter((id) => id !== 'p05'),
    );
    expect(frame.notices).toEqual([notice('p05', 'batch', 'internal-error', -3)]);
    h.prepare();
    expect(port.callCount).toBe(9);
  });

  it('V3-A8: all paths defective, n = 1000: bounded calls, progress, resume from the DFS stack, all memoized within 1999 calls', () => {
    const count = 1_000;
    const port = new ScriptedFillMeshPort({
      batch: () => ({ status: 'batch-failed', code: 'internal-error' }),
    });
    const nodes = Array.from({ length: count }, (_, index) =>
      pathNode(`n${String(index).padStart(4, '0')}`, index * 0.5),
    );
    const h = createPathHarness({ port, nodes });
    const calledRanges = new Set<string>();
    const notices: PathMeshNotice[] = [];
    let previousMemo = 0;
    let prepares = 0;
    while (h.statistics().memoEntries < count) {
      const before = port.callCount;
      notices.push(...h.prepare().notices);
      prepares += 1;
      const calls = port.callCount - before;
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThanOrEqual(32);
      const memo = h.statistics().memoEntries;
      expect(memo).toBeGreaterThan(previousMemo);
      previousMemo = memo;
      for (const call of port.calls.slice(before)) {
        const key = call.map((request) => request.tag).join(',');
        expect(calledRanges.has(key)).toBe(false);
        calledRanges.add(key);
      }
      expect(prepares).toBeLessThan(200);
    }
    expect(port.callCount).toBeLessThanOrEqual(2 * count - 1);
    // Every node of the bisection tree is called exactly once: 2n - 1 calls, 32 per prepare.
    expect(port.callCount).toBe(1_999);
    expect(prepares).toBe(Math.ceil(1_999 / 32));
    while (h.statistics().noticesQueued > 0) notices.push(...h.prepare().notices);
    expect(notices).toHaveLength(count);
    expect(new Set(notices.map((entry) => entry.nodeId)).size).toBe(count);
    expect(notices.every((entry) => entry.failureCode === 'internal-error')).toBe(true);
    const settled = port.callCount;
    h.prepare();
    expect(port.callCount).toBe(settled);
  });

  it('V3-A8: resumption drops vanished, undrawable and changed keys and calls no new key until the stack is empty', () => {
    const count = 64;
    const port = new ScriptedFillMeshPort({
      batch: () => ({ status: 'batch-failed', code: 'internal-error' }),
    });
    const nodes = Array.from({ length: count }, (_, index) =>
      pathNode(`n${String(index).padStart(2, '0')}`, index * 5),
    );
    const h = createPathHarness({ port, nodes });
    h.prepare();
    expect(port.callCount).toBe(32);
    const firstPrepareTags = new Set(port.calls.flat().map((request) => request.tag));
    // n63 removed, n62 hidden, n61 changed (new tag 400.5), and a new node (tag 401.5).
    const edited = [
      ...nodes.slice(0, 61),
      pathNode('n61', 400.5),
      pathNode('n62', 62 * 5, { visible: false }),
      pathNode('new', 401.5),
    ];
    h.replace(edited);
    const before = port.callCount;
    for (let guard = 0; h.statistics().memoEntries < 63; guard += 1) {
      expect(guard).toBeLessThan(50);
      h.prepare();
    }
    const later = port.calls.slice(before);
    const forbidden = new Set([63 * 5, 62 * 5, 61 * 5]);
    for (const call of later) {
      for (const request of call) expect(forbidden.has(request.tag)).toBe(false);
    }
    const isNew = (tag: number) => tag === 400.5 || tag === 401.5;
    const firstNew = later.findIndex((call) => call.some((request) => isNew(request.tag)));
    let lastOld = -1;
    later.forEach((call, index) => {
      if (call.some((request) => !isNew(request.tag))) lastOld = index;
    });
    expect(firstNew).toBeGreaterThan(lastOld);
    expect(later[firstNew]!.map((request) => request.tag)).toEqual([400.5, 401.5]);
    // No range is called twice across prepares.
    const keys = port.calls.map((call) => call.map((request) => request.tag).join(','));
    expect(new Set(keys).size).toBe(keys.length);
    expect(firstPrepareTags.has(0)).toBe(true);
  });

  it('V3-A8: at most 32 notices per packet, oldest first; the queue holds 4,096 and counts overflow', () => {
    expect(PATH_MESH_LIMITS.noticesPerPacket).toBe(32);
    expect(PATH_MESH_LIMITS.noticeQueueCapacity).toBe(4_096);
    const tags = Array.from({ length: 40 }, (_, index) => index * 10);
    const port = createFailingPort({
      pathFailures: new Map(tags.map((tag) => [tag, 'unsupported-geometry'])),
    });
    const ids = tags.map((_, index) => `p${String(index).padStart(2, '0')}`);
    const h = createPathHarness({
      port,
      nodes: tags.map((tag, index) => pathNode(ids[index]!, tag)),
    });
    const first = h.prepare();
    expect(first.notices.map((entry) => entry.nodeId)).toEqual(ids.slice(0, 32));
    expect(h.statistics().noticesQueued).toBe(8);
    expect(h.prepare().notices.map((entry) => entry.nodeId)).toEqual(ids.slice(32));

    const capped = createPathHarness({
      port: createFailingPort({
        pathFailures: new Map(tags.slice(0, 15).map((tag) => [tag, 'work-limit'])),
      }),
      nodes: tags.slice(0, 15).map((tag, index) => pathNode(ids[index]!, tag)),
      limits: { noticeQueueCapacity: 10 },
    });
    expect(capped.prepare().notices.map((entry) => entry.nodeId)).toEqual(ids.slice(0, 10));
    expect(capped.statistics()).toMatchObject({ noticesDropped: 5, noticesQueued: 0 });
  });

  it('V3-A8: queued notices are kept across a throwing prepare', () => {
    const tags = Array.from({ length: 41 }, (_, index) => index * 10);
    const port = createFailingPort({
      pathFailures: new Map(tags.map((tag) => [tag, 'numeric-range'])),
    });
    const ids = tags.map((_, index) => `p${String(index).padStart(2, '0')}`);
    const forty = tags.slice(0, 40).map((tag, index) => pathNode(ids[index]!, tag));
    const h = createPathHarness({ port, nodes: forty });
    h.prepare();
    const bad = {
      ...(rectangleNode('bad', 0) as Extract<RenderNodeSnapshot, { kind: 'primitive' }>),
      transform: [1, 1 + 2 ** -40, 1, 1, 0, 0] as const,
    };
    h.replace([...forty, pathNode(ids[40]!, tags[40]!), bad]);
    expect(() => h.source.prepare(target)).toThrow();
    expect(h.statistics().noticesQueued).toBe(9);
    // The port result of the throwing prepare was published before packing: no repeat call.
    const calls = port.callCount;
    h.replace([...forty, pathNode(ids[40]!, tags[40]!)]);
    expect(h.prepare().notices.map((entry) => entry.nodeId)).toEqual(ids.slice(32));
    expect(port.callCount).toBe(calls);
  });

  it('V3-A8: an isolated resource-limit expires after 256 prepare calls, allowing one retry', () => {
    const port = createFailingPort({ batchFailures: new Map([[0, 'resource-limit']]) });
    const h = createPathHarness({ port, nodes: [pathNode('a', 0)] });
    expect(h.prepare().notices).toEqual([notice('a', 'batch', 'resource-limit', -3)]);
    for (let index = 0; index < 255; index += 1) h.prepare();
    expect(port.callCount).toBe(1);
    expect(h.prepare().notices).toEqual([notice('a', 'batch', 'resource-limit', -3)]);
    expect(port.callCount).toBe(2);
    for (let index = 0; index < 10; index += 1) h.prepare();
    expect(port.callCount).toBe(2);
  });

  it('V3-A8: batch disposed latches; every later new key fails as batch disposed without a call', () => {
    const port = createFailingPort({ batchFailures: new Map([[0, 'disposed']]) });
    const h = createPathHarness({ port, nodes: [pathNode('a', 0), pathNode('b', 20)] });
    expect(h.prepare()).toEqual({
      draws: [],
      notices: [notice('a', 'batch', 'disposed', -3), notice('b', 'batch', 'disposed', -3)],
    });
    port.script = {};
    h.replace([pathNode('a', 0), pathNode('b', 20), pathNode('c', 40)]);
    expect(h.prepare()).toEqual({ draws: [], notices: [notice('c', 'batch', 'disposed', -3)] });
    expect(port.callCount).toBe(1);
  });

  it('V3-A8: invalid-request is not split and memoizes every key of the batch', () => {
    const port = createFailingPort({ batchFailures: new Map([[20, 'invalid-request']]) });
    const h = createPathHarness({ port, nodes: [pathNode('a', 0), pathNode('b', 20)] });
    expect(h.prepare().notices).toEqual([
      notice('a', 'batch', 'invalid-request', -3),
      notice('b', 'batch', 'invalid-request', -3),
    ]);
    h.prepare();
    expect(port.callCount).toBe(1);
  });

  it('V3-A8: the memo cap evicts least recently consulted entries and counts memoOverCapFrames', () => {
    const tags = [0, 20, 40, 60, 80];
    const port = createFailingPort({
      pathFailures: new Map(tags.map((tag) => [tag, 'work-limit'])),
    });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const nodes = tags.map((tag, index) => pathNode(ids[index]!, tag));
    const h = createPathHarness({ port, nodes, limits: { memoCapacity: 3 } });
    h.prepare();
    expect(h.statistics()).toMatchObject({ memoEntries: 5, memoOverCapFrames: 1 });
    h.replace(nodes.map((node, index) => (index < 3 ? { ...node, visible: false } : node)));
    h.prepare();
    expect(h.statistics()).toMatchObject({ memoEntries: 3, memoOverCapFrames: 1 });
    h.replace(nodes);
    h.prepare();
    expect(port.callCount).toBe(2);
    expect(tagsOf(port)).toEqual([0, 20]);
    expect(PATH_MESH_LIMITS.memoCapacity).toBe(4_096);
  });

  it('V3-A8: a fringe-unsupported variant keeps the mesh cached and a different f prime retries', () => {
    const built: number[] = [];
    const builder: PathFringeBuilder = (_mesh, f) => {
      built.push(f);
      return f === 1
        ? { status: 'unsupported' }
        : { status: 'built', fringe: fringeDouble(new Float32Array(8), new Uint32Array(8)) };
    };
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: [pathNode('a', 0)], fringeBuilder: builder });
    expect(h.prepare()).toEqual({
      draws: [],
      notices: [notice('a', 'renderer', 'fringe-unsupported', -3)],
    });
    expect(h.prepare()).toEqual({ draws: [], notices: [] });
    expect(built).toEqual([1]);
    expect(h.statistics()).toMatchObject({ entries: 1, bytes: 152 });
    h.setZoom(0.5);
    expect(h.prepare().draws.map((draw) => [draw.toleranceExponent, draw.fringeBucket])).toEqual([
      [-3, 2],
    ]);
    expect(built).toEqual([1, 2]);
    expect(port.callCount).toBe(1);
  });

  it('V3-A8: packing-range and tolerance-range keep the mesh, make no call, and notify only on state transitions', () => {
    const port = createCountingPort();
    const plain = pathNode('a', 0, { transform: [1, 0, 0, 1, 100, 0] });
    const mismatch = pathNode('a', 0, { transform: [1, 1 + 2 ** -40, 1, 1, 100, 0] });
    const h = createPathHarness({ port, nodes: [plain] });
    expect(h.drawnIds()).toEqual(['a']);
    h.replace([mismatch]);
    expect(h.prepare()).toEqual({
      draws: [],
      notices: [notice('a', 'renderer', 'packing-range', null)],
    });
    expect(h.prepare()).toEqual({ draws: [], notices: [] });
    h.replace([plain]);
    expect(h.prepare()).toMatchObject({ notices: [] });
    expect(h.drawnIds()).toEqual(['a']);
    h.replace([mismatch]);
    expect(h.prepare().notices).toEqual([notice('a', 'renderer', 'packing-range', null)]);
    h.replace([pathNode('a', 0, { transform: [2 ** 1000, 0, 0, 2 ** 1000, 0, 0] })]);
    h.setZoom(2 ** 20);
    expect(h.prepare().notices).toEqual([notice('a', 'renderer', 'tolerance-range', null)]);
    expect(h.prepare().notices).toEqual([]);
    expect(h.statistics()).toMatchObject({ entries: 1, bytes: 152 });
    h.replace([plain]);
    h.setZoom(1);
    expect(h.drawnIds()).toEqual(['a']);
    expect(port.callCount).toBe(1);
  });

  it('V3-A8: notices format as the path mesh failure warning (section h, E11-U4)', () => {
    expect(DIAGNOSTIC_CODES.PATH_MESH_FAILURE).toBe('render.path-mesh-failure');
    const diagnostic = pathMeshNoticeDiagnostic(notice('p', 'path', 'work-limit', -3), 7);
    expect(diagnostic.message.startsWith('Path ')).toBe(true);
    expect({ ...diagnostic, message: 'checked above' }).toEqual({
      code: 'render.path-mesh-failure',
      severity: 'warning',
      message: 'checked above',
      generation: 7,
      context: {
        nodeId: 'p',
        failureScope: 'path',
        failureCode: 'work-limit',
        toleranceExponent: -3,
        paint: 'fill',
      },
    });
    expect(
      pathMeshNoticeDiagnostic(notice(null, 'renderer', 'mesh-pipeline-unavailable', null), 1)
        .context,
    ).toMatchObject({ nodeId: null, failureScope: 'renderer' });
  });
});

describe('V3a response validation', () => {
  const ok = (requests: readonly FillMeshRequest[]) => requests.map((request) => okResult(request));

  function run(
    answer: (requests: readonly FillMeshRequest[]) => unknown,
    expected: readonly PathMeshNotice[],
    drawn: readonly string[] = [],
  ) {
    const port = new ScriptedFillMeshPort({
      batch: (requests) => answer(requests) as FillMeshBatchResult,
    });
    const h = createPathHarness({ port, nodes: [pathNode('a', 0), pathNode('b', 20)] });
    const frame = h.prepare();
    expect(frame.notices).toEqual(expected);
    expect(frame.draws.map((draw) => draw.nodeId)).toEqual(drawn);
    expect(h.statistics().entries).toBe(drawn.length);
    h.prepare();
    expect(port.callCount).toBe(1);
  }

  const both = (code: 'invalid-response' | 'invalid-mesh') => [
    notice('a', 'renderer', code, -3),
    notice('b', 'renderer', code, -3),
  ];

  it('V3-A9: a throwing port and malformed batch results are invalid-response for every key in the call', () => {
    run(() => {
      throw new Error('port failure');
    }, both('invalid-response'));
    run(() => null, both('invalid-response'));
    run(() => ({ status: 'pending' }), both('invalid-response'));
    run(() => ({ status: 'batch-failed', code: 'busy' }), both('invalid-response'));
    run(() => ({ status: 'ok', results: 'none' }), both('invalid-response'));
    run((requests) => ({ status: 'ok', results: ok(requests).slice(1) }), both('invalid-response'));
    run(
      (requests) => ({ status: 'ok', results: [...ok(requests), ok(requests)[0]] }),
      both('invalid-response'),
    );
  });

  it('V3-A9: wrong order, requestId or exponent echoes, statuses and codes are invalid-response for that result', () => {
    run(
      (requests) => ({ status: 'ok', results: ok(requests).reverse() }),
      both('invalid-response'),
    );
    run(
      (requests) => ({
        status: 'ok',
        results: [okResult(requests[0]!), { ...okResult(requests[1]!), requestId: 7 }],
      }),
      [notice('b', 'renderer', 'invalid-response', -3)],
      ['a'],
    );
    run(
      (requests) => ({
        status: 'ok',
        results: [{ ...okResult(requests[0]!), toleranceExponent: -2 }, okResult(requests[1]!)],
      }),
      [notice('a', 'renderer', 'invalid-response', -3)],
      ['b'],
    );
    run(
      (requests) => ({
        status: 'ok',
        results: [
          { ...failedResult(requests[0]!, 'work-limit'), code: 'gone' },
          { ...okResult(requests[1]!), status: 'maybe' },
        ],
      }),
      both('invalid-response'),
    );
    run(
      (requests) => ({
        status: 'ok',
        results: [
          okResult(requests[0]!),
          Object.defineProperty({}, 'requestId', {
            get: () => {
              throw new Error('getter');
            },
          }),
        ],
      }),
      [notice('b', 'renderer', 'invalid-response', -3)],
      ['a'],
    );
  });

  it('V3-A9: every invalid-mesh case is a renderer-scope notice with no draw', () => {
    const square = squareMesh();
    const meshes: unknown[] = [
      undefined,
      { ...square, positions: Float64Array.from([Number.NaN, 0, 10, 0, 10, 10, 0, 10]) },
      { ...square, positions: Float64Array.from([0, 0, 10, 0, 10, Infinity, 0, 10]) },
      { ...square, indices: Uint32Array.from([0, 1, 4, 0, 2, 3]) },
      { ...square, indices: Uint32Array.from([0, 1, 2, 0, 2]) },
      { ...square, indices: new Uint32Array(0) },
      { ...square, boundaryEdges: Uint32Array.from([0, 1, 1]) },
      { ...square, boundaryEdges: Uint32Array.from([0, 1, 1, 9]) },
      { ...square, bounds: { ...square.bounds, maxX: 11 } },
      { ...square, bounds: null },
      { ...square, positions: [0, 0, 10, 0, 10, 10, 0, 10] },
      {
        ...square,
        positions: new Float64Array(0),
        indices: new Uint32Array(0),
        boundaryEdges: new Uint32Array(0),
      },
    ];
    for (const mesh of meshes) {
      run(
        (requests) => ({
          status: 'ok',
          results: requests.map((request) => ({ ...okResult(request), mesh })),
        }),
        both('invalid-mesh'),
      );
    }
  });
});

describe('V3a device loss, ownership and host injection', () => {
  it('V3-A15 (CPU part): a generation change makes zero port calls and serves the same CPU meshes', () => {
    const port = createCountingPort();
    const h = createPathHarness({
      port,
      nodes: [pathNode('a', 0), rectangleNode('r', 40), pathNode('b', 20)],
    });
    const before = h.prepare();
    const after = h.prepare({ ...target, generation: 2 });
    expect(port.callCount).toBe(1);
    expect(after.draws).toEqual(before.draws);
    after.draws.forEach((draw, index) => expect(draw.mesh).toBe(before.draws[index]!.mesh));
  });

  it('V3-A15 (CPU part): dispose clears the cache and never disposes the host-owned port', () => {
    const port = new FillMeshPortDouble();
    let disposed = 0;
    const original = port.dispose.bind(port);
    port.dispose = () => {
      disposed += 1;
      original();
    };
    const invalidation: RendererInvalidationTarget = {
      invalidate: () => undefined,
      setMode: () => undefined,
    };
    const service = new PrimitiveRendererService(invalidation, { fillMesh: port });
    service.dispose();
    service.dispose();
    expect(disposed).toBe(0);
    expect(service.prepare(target)).toBeNull();
  });

  // V4 removed the V3-A18 test ("no host injects a port"), as V3-A18 foresaw, when the
  // playground gained the real port. This V4 test keeps the remaining hosts port-free. B2 ST-U8
  // adds the stroke page as a second host, on V4's pattern: it injects both real ports. The
  // visualization track's V-1 appearance page is the third host, its V-2 path-data page the
  // fourth, its V-3 integration page the fifth and its V-4 A08 corpus page the sixth, on the
  // same pattern.
  it('V4: only the path page, the ST-U8 stroke page, the V-1 appearance page, the V-2 path-data page, the V-3 integration page, the V-4 A08 corpus page and the P4 clip and mask page inject the real ports; the V3 smoke fixture keeps its static double', () => {
    const root = join(__dirname, '../../apps/playground');
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|js|mjs|html|json)$/.test(entry)) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    const v4Host = files.filter((file) => /[\\/]src[\\/]p3-v4-paths\.ts$/.test(file));
    expect(v4Host).toHaveLength(1);
    const hostSource = readFileSync(v4Host[0]!, 'utf8');
    expect(hostSource).toMatch(/from '@vector-studio\/geometry-wasm'/);
    expect(hostSource).toMatch(/fillMesh: adapter/);
    // B2 ST-U8: the stroke page injects both real ports.
    const b2Host = files.filter((file) => /[\\/]src[\\/]p3-b2-strokes\.ts$/.test(file));
    expect(b2Host).toHaveLength(1);
    const b2Source = readFileSync(b2Host[0]!, 'utf8');
    expect(b2Source).toMatch(/from '@vector-studio\/geometry-wasm'/);
    expect(b2Source).toMatch(/fillMesh: fill,/);
    expect(b2Source).toMatch(/strokeMesh: strokes,/);
    // Visualization track V-1: the appearance page injects both real ports, as ST-U8 does. Only
    // its host file wires them; its scene, state and html files stay under the deny-list below.
    const vizHost = files.filter((file) => /[\\/]src[\\/]viz-v1-appearance\.ts$/.test(file));
    expect(vizHost).toHaveLength(1);
    const vizSource = readFileSync(vizHost[0]!, 'utf8');
    expect(vizSource).toMatch(/from '@vector-studio\/geometry-wasm'/);
    expect(vizSource).toMatch(/fillMesh: fill,/);
    expect(vizSource).toMatch(/strokeMesh: strokes,/);
    // Visualization track V-2: the path-data page is the fourth host, on the same pattern. Only its
    // host file wires the ports; its parse, state and html files stay under the deny-list below.
    const viz2Host = files.filter((file) => /[\\/]src[\\/]viz-v2-path-data\.ts$/.test(file));
    expect(viz2Host).toHaveLength(1);
    const viz2Source = readFileSync(viz2Host[0]!, 'utf8');
    expect(viz2Source).toMatch(/from '@vector-studio\/geometry-wasm'/);
    expect(viz2Source).toMatch(/fillMesh: fill,/);
    expect(viz2Source).toMatch(/strokeMesh: strokes,/);
    // Visualization track V-3: the A07 integration page is the fifth host, on the same pattern.
    // Only its host file wires the ports; its scene and html files stay under the deny-list below.
    const viz3Host = files.filter((file) => /[\\/]src[\\/]viz-v3-integration\.ts$/.test(file));
    expect(viz3Host).toHaveLength(1);
    const viz3Source = readFileSync(viz3Host[0]!, 'utf8');
    expect(viz3Source).toMatch(/from '@vector-studio\/geometry-wasm'/);
    expect(viz3Source).toMatch(/fillMesh: fill,/);
    expect(viz3Source).toMatch(/strokeMesh: strokes,/);
    // Visualization track V-4: the A08 corpus page is the sixth host. It wraps each real port in a
    // recorder for the MESH-MISMATCH check; its cases file stays under the deny-list below.
    const viz4Host = files.filter((file) => /[\\/]src[\\/]viz-v4-a08-corpus\.ts$/.test(file));
    expect(viz4Host).toHaveLength(1);
    const viz4Source = readFileSync(viz4Host[0]!, 'utf8');
    expect(viz4Source).toMatch(/from '@vector-studio\/geometry-wasm'/);
    expect(viz4Source).toMatch(/fillMesh: recordedFill\(fill\),/);
    expect(viz4Source).toMatch(/strokeMesh: recordedStroke\(stroke\),/);
    // P4 U5: the clip and mask check page is the seventh host, on V-3's pattern.
    const p4Host = files.filter((file) => /[\\/]src[\\/]p4-clip-mask\.ts$/.test(file));
    expect(p4Host).toHaveLength(1);
    const p4Source = readFileSync(p4Host[0]!, 'utf8');
    expect(p4Source).toMatch(/from '@vector-studio\/geometry-wasm'/);
    expect(p4Source).toMatch(/fillMesh: fill,/);
    expect(p4Source).toMatch(/strokeMesh: strokes,/);
    const host = [
      ...v4Host,
      ...b2Host,
      ...vizHost,
      ...viz2Host,
      ...viz3Host,
      ...viz4Host,
      ...p4Host,
    ];
    // The manifest and project-reference edges of that import (boundary rule P-B1).
    const edges = files.filter((file) =>
      /[\\/]playground[\\/](package|tsconfig)\.json$/.test(file),
    );
    expect(edges).toHaveLength(2);
    // The V3-A14 smoke fixture page and the E10-U3 test-hooks check page are test fixtures with a
    // static test-double port.
    const fixture = files.filter((file) => /(p3-v3-mesh|e10-test-hooks)\.(ts|html)$/.test(file));
    expect(fixture).toHaveLength(4);
    for (const file of fixture)
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/geometry-wasm/);
    const allowed = new Set([...host, ...edges, ...fixture]);
    for (const file of files.filter((candidate) => !allowed.has(candidate))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/fillMesh|strokeMesh|geometry-wasm/);
    }
  });
});
