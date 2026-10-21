import type { FillMesh } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { buildPathFringe } from '../../packages/renderer-core/src/path-fringe.js';
import {
  pathMeshNoticeDiagnostic,
  type PathMeshNotice,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type { MeshResourceId } from '../../packages/renderer-core/src/primitive-packet.js';
import {
  ScriptedFillMeshPort,
  createCountingPort,
  createPathHarness,
  okResult,
  pathNode,
  rectangleNode,
  target,
} from '../support/v3a-path-harness.js';
import { MeshShadow, receiptOf, words } from '../support/v3b-mesh-harness.js';
import {
  BLUE,
  ScriptedStrokeMeshPort,
  createFailingStrokePort,
  createStrokeHarness,
  pathStroke,
  strokeFailed,
  strokeOk,
  strokeRingMesh,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';

// B2 stroke contract, section 9 (unit ST-U6, ST-A10): the stroke port beside the fill port,
// keys, memo and reuse per paint, one stroke batch per prepare with V3's isolation, the second
// path slot, fill-then-stroke draws, whole-path failure, the opacity staging rule
// (composition-unsupported), culling bounds, notices with a paint, and device-loss
// reconstruction. Functional evidence only: precision is UNVERIFIED against the 0.25
// physical-pixel target; no performance claim.

function notice(
  nodeId: string | null,
  failureScope: PathMeshNotice['failureScope'],
  failureCode: PathMeshNotice['failureCode'],
  toleranceExponent: number | null,
  paint: PathMeshNotice['paint'],
): PathMeshNotice {
  return { interim: 'd8', nodeId, failureScope, failureCode, toleranceExponent, paint };
}

function both() {
  return { fill: createCountingPort(), stroke: new ScriptedStrokeMeshPort() };
}

describe('ST-U6 stroke port calls and keys (sections 9.3 and 9.4)', () => {
  it('ST-A10: one stroke call per prepare after the fill call, requestId = batch index, carrying every stroke value', () => {
    const ports = both();
    const order: string[] = [];
    const fillBuild = ports.fill.buildFillMeshes.bind(ports.fill);
    ports.fill.buildFillMeshes = (requests) => (order.push('fill'), fillBuild(requests));
    const strokeBuild = ports.stroke.buildStrokeMeshes.bind(ports.stroke);
    ports.stroke.buildStrokeMeshes = (requests) => (order.push('stroke'), strokeBuild(requests));
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [
        strokedNode('a', 0, {
          stroke: pathStroke({ width: 1.5, cap: 'square', join: 'bevel', miterLimit: 2.5 }),
        }),
        pathNode('fillOnly', 20),
        strokedNode('strokeOnly', 40, { fill: null }),
        strokedNode('zero', 60, { stroke: pathStroke({ width: 0 }) }),
      ],
    });
    expect(h.drawn()).toEqual([
      'a:fill',
      'a:stroke',
      'fillOnly:fill',
      'strokeOnly:stroke',
      'zero:fill',
    ]);
    expect(order).toEqual(['fill', 'stroke']);
    expect(ports.fill.calls.map((call) => call.map((request) => request.tag))).toEqual([
      [0, 20, 60],
    ]);
    expect(ports.stroke.calls).toEqual([
      [
        {
          requestId: 0,
          tag: 0,
          toleranceExponent: -3,
          width: 1.5,
          cap: 'square',
          join: 'bevel',
          miterLimit: 2.5,
        },
        {
          requestId: 1,
          tag: 40,
          toleranceExponent: -3,
          width: 2,
          cap: 'butt',
          join: 'miter',
          miterLimit: 4,
        },
      ],
    ]);
    // Nothing is missing: no call at all.
    h.prepare();
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([1, 1]);
    expect(h.statistics()).toMatchObject({ portCalls: 1, strokePortCalls: 1, entries: 5 });
  });

  it('ST-A10: stroke color, node opacity and fill changes build no stroke mesh', () => {
    const ports = both();
    const nodes = [strokedNode('a', 0), strokedNode('s', 20, { fill: null })];
    const h = createStrokeHarness({ fillPort: ports.fill, strokePort: ports.stroke, nodes });
    h.prepare();
    h.replace([
      strokedNode('a', 0, {
        fill: { r: 0, g: 1, b: 0, a: 0.5 },
        stroke: pathStroke({ color: { r: 1, g: 1, b: 0, a: 0.25 } }),
      }),
      strokedNode('s', 20, { fill: null, opacity: 0.5, stroke: pathStroke({ color: BLUE }) }),
    ]);
    expect(h.drawn()).toEqual(['a:fill', 'a:stroke', 's:stroke']);
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([1, 1]);
    const frame = h.prepare();
    expect(frame.draws.map((draw) => [draw.nodeId, draw.paint, draw.fill, draw.opacity])).toEqual([
      ['a', 'fill', { r: 0, g: 1, b: 0, a: 0.5 }, 1],
      ['a', 'stroke', { r: 1, g: 1, b: 0, a: 0.25 }, 1],
      ['s', 'stroke', BLUE, 0.5],
    ]);
    // A fill appearing on a stroke-only path calls the fill port only.
    h.replace([strokedNode('a', 0), strokedNode('s', 20)]);
    expect(h.drawn()).toEqual(['a:fill', 'a:stroke', 's:fill', 's:stroke']);
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([2, 1]);
  });

  it('ST-A10: a change of any stroke key field makes that paint miss; the fill key is untouched', () => {
    const ports = both();
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [strokedNode('a', 0), strokedNode('b', 20)],
    });
    h.prepare();
    const changes = [
      { width: 3 },
      { width: 3, cap: 'round' as const },
      { width: 3, cap: 'round' as const, join: 'round' as const },
      { width: 3, cap: 'round' as const, join: 'round' as const, miterLimit: 10 },
    ];
    let strokeCalls = 1;
    for (const change of changes) {
      h.replace([strokedNode('a', 0, { stroke: pathStroke(change) }), strokedNode('b', 20)]);
      expect(h.drawn()).toEqual(['a:fill', 'a:stroke', 'b:fill', 'b:stroke']);
      strokeCalls += 1;
      expect(ports.stroke.callCount, JSON.stringify(change)).toBe(strokeCalls);
      expect(ports.stroke.calls.at(-1)!.map((request) => request.tag)).toEqual([0]);
      expect(ports.fill.callCount).toBe(1);
    }
    // A fillRule change rebuilds the fill only; a geometry change rebuilds both paints.
    h.replace([
      strokedNode('a', 0, { stroke: pathStroke(changes[3]), fillRule: 'evenodd' }),
      strokedNode('b', 20),
    ]);
    h.prepare();
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([2, strokeCalls]);
    h.replace([
      strokedNode('a', 0, {
        stroke: pathStroke(changes[3]),
        fillRule: 'evenodd',
        points: [0, 0, 10, 0, 10, 12],
      }),
      strokedNode('b', 20),
    ]);
    h.prepare();
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([3, strokeCalls + 1]);
    expect(ports.fill.calls.at(-1)!.map((request) => request.tag)).toEqual([0]);
    expect(ports.stroke.calls.at(-1)!.map((request) => request.tag)).toEqual([0]);
  });

  it('ST-A10: a stroke operationId change rebuilds every drawn stroke once and no fill', () => {
    const ports = both();
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [strokedNode('a', 0), strokedNode('b', 20), strokedNode('h', 40, { visible: false })],
    });
    h.prepare();
    ports.stroke.operationId = 'test/st-u6-stroke-double-2';
    expect(h.drawn()).toEqual(['a:fill', 'a:stroke', 'b:fill', 'b:stroke']);
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([1, 2]);
    expect(ports.stroke.calls[1]!.map((request) => request.tag)).toEqual([0, 20]);
    h.prepare();
    expect(ports.stroke.callCount).toBe(2);
  });

  it('ST-A10: a stroke portVersion change hides each stroked path (fill too), notifies with paint null, and calls nothing', () => {
    const ports = both();
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [strokedNode('a', 0), pathNode('f', 20)],
    });
    h.prepare();
    ports.stroke.setPortVersion(1);
    const frame = h.prepare();
    expect(frame.draws.map((draw) => draw.nodeId)).toEqual(['f']);
    expect(frame.notices).toEqual([notice('a', 'renderer', 'port-version', null, null)]);
    expect(h.prepare().notices).toEqual([]);
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([1, 1]);
    ports.stroke.setPortVersion(0);
    expect(h.drawn()).toEqual(['a:fill', 'a:stroke', 'f:fill']);
    expect(ports.stroke.callCount).toBe(1);
  });

  it('ST-A10: a stroke bucket e < -1020 is tolerance-range for the stroke paint, while the fill at e = -1021 passes the tolerance check', () => {
    // sigmaMax = 2^1000 * 2^18 = 2^1018 gives e = -1021, inside the fill range but below the
    // stroke's -1020. Such a scale cannot have finite f32 lanes, so the fill paint reaches its
    // next check, packing-range; each paint reports its own state and nothing is called.
    const ports = both();
    const big = 2 ** 1000;
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [strokedNode('a', 0, { transform: [big, 0, 0, big, 0, 0] })],
    });
    h.setZoom(2 ** 18);
    const frame = h.prepare();
    expect(frame.draws).toEqual([]);
    expect(frame.notices).toEqual([
      notice('a', 'renderer', 'packing-range', null, 'fill'),
      notice('a', 'renderer', 'tolerance-range', null, 'stroke'),
    ]);
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([0, 0]);
    expect(h.prepare().notices).toEqual([]);
    // One level coarser (e = -1020) the stroke passes its tolerance check too.
    h.setZoom(2 ** 17);
    expect(h.prepare().notices).toEqual([notice('a', 'renderer', 'packing-range', null, 'stroke')]);
  });

  it('ST-A10: the reuse rule applies per node and paint: a stroke built at e serves e + 1 and e + 2', () => {
    const ports = both();
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [strokedNode('a', 0)],
    });
    h.prepare();
    for (const zoom of [0.5, 0.25]) {
      h.setZoom(zoom);
      expect(h.drawn()).toEqual(['a:fill', 'a:stroke']);
      expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([1, 1]);
    }
    expect(h.prepare().draws.map((draw) => draw.toleranceExponent)).toEqual([-3, -3]);
    h.setZoom(0.125);
    h.prepare();
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([2, 2]);
    expect(ports.stroke.calls[1]![0]!.toleranceExponent).toBe(0);
  });
});

describe('ST-U6 failures, isolation and memo (sections 9.4 and 9.6)', () => {
  it('ST-A10 (ST-A0 S5): a failing stroke hides the path including its fill; other nodes draw; the fill mesh stays cached', () => {
    const fill = createCountingPort();
    const stroke = createFailingStrokePort({ pathFailures: new Map([[20, 'work-limit']]) });
    const h = createStrokeHarness({
      fillPort: fill,
      strokePort: stroke,
      nodes: [strokedNode('a', 0), strokedNode('b', 20), pathNode('c', 40)],
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => `${draw.nodeId}:${draw.paint}`)).toEqual([
      'a:fill',
      'a:stroke',
      'c:fill',
    ]);
    expect(frame.notices).toEqual([notice('b', 'path', 'work-limit', -3, 'stroke')]);
    // b's fill mesh is cached: a, b and c fills plus a's stroke.
    expect(h.statistics()).toMatchObject({ entries: 4, memoEntries: 1 });
    for (let index = 0; index < 100; index += 1) h.prepare();
    expect([fill.callCount, stroke.callCount]).toEqual([1, 1]);
    // A key change retries once; the fill is served from the cache.
    h.replace([
      strokedNode('a', 0),
      strokedNode('b', 20, { stroke: pathStroke({ width: 1 }) }),
      pathNode('c', 40),
    ]);
    stroke.script = {};
    expect(h.drawn()).toEqual(['a:fill', 'a:stroke', 'b:fill', 'b:stroke', 'c:fill']);
    expect([fill.callCount, stroke.callCount]).toEqual([1, 2]);
  });

  it('ST-A10: invalid-stroke is a per-path stroke code; the same code from the fill port is invalid-response', () => {
    const stroke = new ScriptedStrokeMeshPort({
      request: (request) => strokeFailed(request, 'invalid-stroke'),
    });
    const fill = new ScriptedFillMeshPort({
      request: (request, tag) =>
        tag === 20
          ? ({
              requestId: request.requestId,
              toleranceExponent: request.toleranceExponent,
              status: 'failed',
              code: 'invalid-stroke',
            } as never)
          : okResult(request),
    });
    const h = createStrokeHarness({
      fillPort: fill,
      strokePort: stroke,
      nodes: [strokedNode('a', 0), pathNode('b', 20)],
    });
    const frame = h.prepare();
    expect(frame.draws).toEqual([]);
    expect(frame.notices).toEqual([
      notice('b', 'renderer', 'invalid-response', -3, 'fill'),
      notice('a', 'path', 'invalid-stroke', null, 'stroke'),
    ]);
  });

  it('ST-A10: one internal-error path in a stroke batch of 16 is isolated in depth-first order; the fill batch is untouched', () => {
    const fill = createCountingPort();
    const stroke = createFailingStrokePort({
      batchFailures: new Map([[5 * 20, 'internal-error']]),
    });
    const nodes = Array.from({ length: 16 }, (_, index) =>
      strokedNode(`p${String(index).padStart(2, '0')}`, index * 20),
    );
    const h = createStrokeHarness({ fillPort: fill, strokePort: stroke, nodes });
    const frame = h.prepare();
    expect(frame.draws).toHaveLength(30);
    expect(frame.draws.some((draw) => draw.nodeId === 'p05')).toBe(false);
    expect(frame.notices).toEqual([notice('p05', 'batch', 'internal-error', -3, 'stroke')]);
    expect(fill.callCount).toBe(1);
    expect(stroke.callCount).toBeLessThanOrEqual(1 + 2 * Math.ceil(Math.log2(16)));
    expect(stroke.calls.map((call) => call.length)).toEqual([16, 8, 4, 4, 2, 1, 1, 2, 8]);
    const settled = stroke.callCount;
    h.prepare();
    expect(stroke.callCount).toBe(settled);
  });

  it('ST-A10: the stroke port has its own call bound and DFS resumption', () => {
    const fill = createCountingPort();
    const stroke = new ScriptedStrokeMeshPort({
      batch: () => ({ status: 'batch-failed', code: 'internal-error' }),
    });
    const nodes = Array.from({ length: 40 }, (_, index) =>
      strokedNode(`p${String(index).padStart(2, '0')}`, index * 20, { fill: null }),
    );
    const h = createStrokeHarness({
      fillPort: fill,
      strokePort: stroke,
      nodes: [...nodes, pathNode('f', 600)],
      limits: { callsPerPrepare: 4 },
    });
    h.prepare();
    expect(stroke.callCount).toBe(4);
    expect(fill.callCount).toBe(1);
    h.prepare();
    expect(stroke.callCount).toBe(8);
    // The resumed ranges are never re-called whole.
    expect(stroke.calls[4]!.length).toBeLessThan(40);
  });

  it('ST-A10: a stroke disposed latch persists for the stroke port only', () => {
    const fill = createCountingPort();
    const stroke = createFailingStrokePort({ batchFailures: new Map([[0, 'disposed']]) });
    const h = createStrokeHarness({
      fillPort: fill,
      strokePort: stroke,
      nodes: [strokedNode('a', 0)],
    });
    expect(h.prepare().notices).toEqual([notice('a', 'batch', 'disposed', -3, 'stroke')]);
    h.replace([strokedNode('a', 0), strokedNode('b', 20), pathNode('c', 40)]);
    const frame = h.prepare();
    expect(frame.draws.map((draw) => draw.nodeId)).toEqual(['c']);
    expect(frame.notices).toEqual([notice('b', 'batch', 'disposed', -3, 'stroke')]);
    expect([fill.callCount, stroke.callCount]).toEqual([2, 1]);
  });

  it('ST-A10: an invalid stroke mesh is invalid-mesh with paint stroke; a fringe-unsupported stroke hides the path', () => {
    const bad: FillMesh = { ...strokeRingMesh(), bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
    const stroke = new ScriptedStrokeMeshPort({
      request: (request, tag) => strokeOk(request, tag, tag === 20 ? bad : strokeRingMesh(tag)),
    });
    const h = createStrokeHarness({
      fillPort: createCountingPort(),
      strokePort: stroke,
      nodes: [strokedNode('a', 0), strokedNode('b', 20)],
      fringeBuilder: (mesh, f) =>
        mesh.positions.length === 16 ? { status: 'unsupported' } : buildPathFringe(mesh, f),
    });
    const frame = h.prepare();
    expect(frame.draws).toEqual([]);
    expect(frame.notices).toEqual([
      notice('b', 'renderer', 'invalid-mesh', -3, 'stroke'),
      notice('a', 'renderer', 'fringe-unsupported', -3, 'stroke'),
    ]);
    // Both fill meshes stay cached; the stroke variant mark keeps the stroke mesh too.
    expect(h.statistics().entries).toBe(3);
  });
});

describe('ST-U6 review B1 and S1: an undrawable path never calls a port every frame', () => {
  // A byte budget of 1 evicts every entry outside the working set after each prepare, so an
  // entry built for a path that is never drawn would be rebuilt every frame.
  const tight = { byteBudget: 1 };

  it('ST-A10 (B1): a failed fill with an ok stroke makes no further call under budget pressure', () => {
    const fill = new ScriptedFillMeshPort({
      request: (request) =>
        ({
          requestId: request.requestId,
          toleranceExponent: request.toleranceExponent,
          status: 'failed',
          code: 'work-limit',
        }) as const,
    });
    const stroke = new ScriptedStrokeMeshPort();
    const h = createStrokeHarness({
      fillPort: fill,
      strokePort: stroke,
      nodes: [strokedNode('a', 0)],
      limits: tight,
    });
    expect(h.prepare().draws).toEqual([]);
    const calls = [fill.callCount, stroke.callCount];
    expect(calls).toEqual([1, 1]);
    for (let index = 0; index < 5; index += 1) expect(h.prepare().draws).toEqual([]);
    expect([fill.callCount, stroke.callCount]).toEqual(calls);
  });

  it('ST-A10 (B1): a failed stroke with an ok fill makes no further call under budget pressure', () => {
    const fill = createCountingPort();
    const stroke = createFailingStrokePort({ pathFailures: new Map([[0, 'numeric-range']]) });
    const h = createStrokeHarness({
      fillPort: fill,
      strokePort: stroke,
      nodes: [strokedNode('a', 0)],
      limits: tight,
    });
    expect(h.prepare().draws).toEqual([]);
    expect([fill.callCount, stroke.callCount]).toEqual([1, 1]);
    for (let index = 0; index < 5; index += 1) expect(h.prepare().draws).toEqual([]);
    expect([fill.callCount, stroke.callCount]).toEqual([1, 1]);
  });

  it('ST-A10 (B1): a port-version state on either port requests nothing for the other paint, even after eviction', () => {
    for (const changed of ['fill', 'stroke'] as const) {
      const ports = both();
      const h = createStrokeHarness({
        fillPort: ports.fill,
        strokePort: ports.stroke,
        nodes: [strokedNode('a', 0)],
        limits: tight,
      });
      if (changed === 'fill') ports.fill.setPortVersion(1);
      else ports.stroke.setPortVersion(1);
      for (let index = 0; index < 5; index += 1) expect(h.prepare().draws).toEqual([]);
      expect([ports.fill.callCount, ports.stroke.callCount], changed).toEqual([0, 0]);
    }
  });

  it('ST-A10 (S1): both ports changing version give exactly one port-version notice per node and transition', () => {
    const ports = both();
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [strokedNode('a', 0), strokedNode('b', 20)],
    });
    h.prepare();
    ports.fill.setPortVersion(1);
    expect(h.prepare().notices).toEqual([
      notice('a', 'renderer', 'port-version', null, null),
      notice('b', 'renderer', 'port-version', null, null),
    ]);
    ports.stroke.setPortVersion(1);
    expect(h.prepare().notices).toEqual([]);
    ports.fill.setPortVersion(0);
    expect(h.prepare().notices).toEqual([]);
    ports.stroke.setPortVersion(0);
    expect(h.drawn()).toEqual(['a:fill', 'a:stroke', 'b:fill', 'b:stroke']);
    // A new transition notifies once again.
    ports.fill.setPortVersion(1);
    ports.stroke.setPortVersion(1);
    expect(h.prepare().notices).toEqual([
      notice('a', 'renderer', 'port-version', null, null),
      notice('b', 'renderer', 'port-version', null, null),
    ]);
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([1, 1]);
  });
});

describe('ST-U6 review F1: a pending sibling paint does not churn the published one', () => {
  const tight = { byteBudget: 1 };
  const nodes = Array.from({ length: 8 }, (_, index) => strokedNode(`p${index}`, index * 20));

  it('ST-A10 (F1): a fill batch failing above one request, with callsPerPrepare 1, builds each stroke once', () => {
    const fill = new ScriptedFillMeshPort({
      batch: (requests) =>
        requests.length > 1 ? { status: 'batch-failed', code: 'internal-error' } : undefined,
    });
    const stroke = new ScriptedStrokeMeshPort();
    const h = createStrokeHarness({
      fillPort: fill,
      strokePort: stroke,
      nodes,
      limits: { callsPerPrepare: 1, ...tight },
    });
    for (let index = 0; index < 30; index += 1) h.prepare();
    expect(stroke.callCount).toBe(1);
    expect(h.prepare().draws.length).toBe(16);
    expect(h.statistics().evictions).toBe(0);
  });

  it('ST-A10 (F1): the reverse case, a stroke batch failing above one request with an ok fill, builds each fill once', () => {
    const fill = createCountingPort();
    const stroke = new ScriptedStrokeMeshPort({
      batch: (requests) =>
        requests.length > 1 ? { status: 'batch-failed', code: 'internal-error' } : undefined,
    });
    const h = createStrokeHarness({
      fillPort: fill,
      strokePort: stroke,
      nodes,
      limits: { callsPerPrepare: 1, ...tight },
    });
    for (let index = 0; index < 30; index += 1) h.prepare();
    expect(fill.callCount).toBe(1);
    expect(h.prepare().draws.length).toBe(16);
    expect(h.statistics().evictions).toBe(0);
  });
});

describe('ST-U6 draws, slots and composition (sections 9.5 and 9.6)', () => {
  it('ST-A10: a stroked path emits its fill draw then its stroke draw at one position, from two slots, with the stroke color lanes', () => {
    const ports = both();
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [
        rectangleNode('r1', 100),
        strokedNode('p', 0, {
          fill: { r: 1, g: 0, b: 0, a: 1 },
          stroke: pathStroke({ color: { r: 0, g: 0.25, b: 1, a: 0.75 } }),
        }),
        rectangleNode('r2', 200),
        strokedNode('s', 300, { fill: null }),
      ],
    });
    const packet = h.source.prepare(target)!;
    expect(packet.draws.map((draw) => [draw.first, draw.count])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    const slots = h.pipeline.getPathSlots();
    const strokeSlots = h.pipeline.getStrokeSlots();
    expect([...slots]).toEqual([
      ['p', 0],
      ['s', 2],
    ]);
    expect([...strokeSlots]).toEqual([
      ['p', 1],
      ['s', 3],
    ]);
    expect(
      packet.mesh!.draws.map((draw) => [draw.position, draw.instance, draw.triangleCount]),
    ).toEqual([
      [1, 0, 2],
      [1, 1, 8],
      [2, 3, 8],
    ]);
    const shadow = new MeshShadow();
    shadow.apply(packet);
    const instance = (slot: number) =>
      Array.from({ length: 12 }, (_, word) =>
        shadow.f32('meshInstances', slot * 64 + 4 * word),
      ).slice(8);
    expect(instance(0)).toEqual([1, 0, 0, 1]);
    expect(instance(1)).toEqual([0, 0.25, 1, 0.75].map(Math.fround));
    expect(instance(3)).toEqual([0, 0, 1, 1]);
    // The stroke record names the served stroke variant's bases.
    const u32 = (slot: number, word: number) => shadow.u32('meshInstances', slot * 64 + 4 * word);
    expect([u32(1, 12), u32(3, 12)]).toEqual([4, 12]);
  });

  it('ST-A10: a stroke slot is released when the stroke draws nothing, and reused', () => {
    const ports = both();
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [strokedNode('a', 0), strokedNode('b', 20)],
    });
    h.prepare();
    expect([...h.pipeline.getStrokeSlots()]).toEqual([
      ['a', 1],
      ['b', 3],
    ]);
    h.replace([strokedNode('a', 0, { stroke: null }), strokedNode('b', 20)]);
    expect(h.drawn()).toEqual(['a:fill', 'b:fill', 'b:stroke']);
    expect([...h.pipeline.getStrokeSlots()]).toEqual([['b', 3]]);
    h.replace([
      strokedNode('a', 0, { stroke: pathStroke({ width: 0 }) }),
      strokedNode('b', 20),
      strokedNode('c', 40),
    ]);
    h.prepare();
    expect([...h.pipeline.getPathSlots()]).toEqual([
      ['a', 0],
      ['b', 2],
      ['c', 1],
    ]);
    expect([...h.pipeline.getStrokeSlots()]).toEqual([
      ['b', 3],
      ['c', 4],
    ]);
  });

  it('ST-A10: a fill-only scene packs byte-identically with and without a stroke port', () => {
    const nodes = [pathNode('a', 0), rectangleNode('r', 40), pathNode('b', 20, { opacity: 0.5 })];
    const plain = createPathHarness({ port: createCountingPort(), nodes });
    const stroked = createStrokeHarness({
      fillPort: createCountingPort(),
      strokePort: new ScriptedStrokeMeshPort(),
      nodes,
    });
    const serialize = (packet: ReturnType<typeof plain.source.prepare>) =>
      JSON.stringify({
        resources: packet!.mesh!.resources.map((resource) => [resource.id, resource.capacityBytes]),
        writes: packet!.mesh!.writes.map((write) => [
          write.resourceId,
          write.byteOffset,
          Buffer.from(write.bytes).toString('hex'),
          write.records.map((record) => record.index),
        ]),
        draws: packet!.mesh!.draws,
        analytic: packet!.draws,
      });
    for (const zoom of [1, 2]) {
      plain.setZoom(zoom, { x: -1.5, y: 2.25 });
      stroked.setZoom(zoom, { x: -1.5, y: 2.25 });
      expect(serialize(stroked.source.prepare(target))).toBe(
        serialize(plain.source.prepare(target)),
      );
    }
  });

  it('ST-A10: two draws at opacity 1, and single-paint paths at opacity 0.5, are drawn', () => {
    const ports = both();
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [
        strokedNode('both', 0),
        pathNode('fill', 20, { opacity: 0.5 }),
        strokedNode('stroke', 40, { fill: null, opacity: 0.5 }),
        strokedNode('zeroWidth', 60, { opacity: 0.5, stroke: pathStroke({ width: 0 }) }),
        strokedNode('transparent', 80, { opacity: 0 }),
      ],
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => [draw.nodeId, draw.paint, draw.opacity])).toEqual([
      ['both', 'fill', 1],
      ['both', 'stroke', 1],
      ['fill', 'fill', 0.5],
      ['stroke', 'stroke', 0.5],
      ['zeroWidth', 'fill', 0.5],
      ['transparent', 'fill', 0],
      ['transparent', 'stroke', 0],
    ]);
    expect(frame.notices).toEqual([]);
  });

  it('ST-A10 (B2-Q6 a): both paints at 0 < opacity < 1 are composition-unsupported: no draw, no call, one notice per transition, cached meshes stay', () => {
    const ports = both();
    const nodes = (opacity: number) => [strokedNode('a', 0, { opacity }), pathNode('f', 20)];
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: nodes(0.5),
    });
    const first = h.prepare();
    expect(first.draws.map((draw) => draw.nodeId)).toEqual(['f']);
    expect(first.notices).toEqual([notice('a', 'renderer', 'composition-unsupported', null, null)]);
    expect([ports.fill.calls.flat().map((request) => request.tag), ports.stroke.callCount]).toEqual(
      [[20], 0],
    );
    expect(h.prepare().notices).toEqual([]);
    // It clears when the opacity reaches 1: both paints mesh once and draw.
    h.replace(nodes(1));
    expect(h.drawn()).toEqual(['a:fill', 'a:stroke', 'f:fill']);
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([2, 1]);
    // Back to 0.5: a new transition notifies again; the meshes stay cached and nothing is called.
    h.replace(nodes(0.25));
    const again = h.prepare();
    expect(again.draws.map((draw) => draw.nodeId)).toEqual(['f']);
    expect(again.notices).toEqual([notice('a', 'renderer', 'composition-unsupported', null, null)]);
    expect(h.statistics().entries).toBe(3);
    // It also clears when either paint goes: a null fill, or a stroke of width 0.
    h.replace([strokedNode('a', 0, { opacity: 0.25, fill: null }), pathNode('f', 20)]);
    expect(h.drawn()).toEqual(['a:stroke', 'f:fill']);
    h.replace([
      strokedNode('a', 0, { opacity: 0.25, stroke: pathStroke({ width: 0 }) }),
      pathNode('f', 20),
    ]);
    expect(h.drawn()).toEqual(['a:fill', 'f:fill']);
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([2, 1]);
    expect(
      pathMeshNoticeDiagnostic(notice('a', 'renderer', 'composition-unsupported', null, null), 3)
        .context,
    ).toEqual({
      interim: 'd8',
      nodeId: 'a',
      failureScope: 'renderer',
      failureCode: 'composition-unsupported',
      toleranceExponent: null,
      paint: null,
    });
  });
});

describe('ST-U6 culling bounds (section 9.7)', () => {
  // The viewport at zoom 1 and DPR 1 is [-2, 642] x [-2, 362] with P1's guard; every path below
  // has its points at x in [650, 660], so its fill is culled and only the stroke box can reach.
  const cases: ReadonlyArray<readonly [string, Parameters<typeof pathStroke>[0], boolean]> = [
    ['miter L = 8 reaches 642', { width: 2, join: 'miter', miterLimit: 8 }, true],
    ['miter L = 7.9 stops at 642.1', { width: 2, join: 'miter', miterLimit: 7.9 }, false],
    ['square cap 1.5 r reaches 641', { width: 12, join: 'round', cap: 'square' }, true],
    ['round cap and join r stop at 644', { width: 12, join: 'round', cap: 'round' }, false],
    ['bevel and butt r stop at 644', { width: 12, join: 'bevel', cap: 'butt' }, false],
    [
      'miter Number.MAX_VALUE uses 2^24',
      { width: 2, join: 'miter', miterLimit: Number.MAX_VALUE },
      true,
    ],
  ];
  for (const [name, stroke, expected] of cases) {
    it(`ST-A10: ${name}`, () => {
      const ports = both();
      const h = createStrokeHarness({
        fillPort: ports.fill,
        strokePort: ports.stroke,
        nodes: [strokedNode('a', 650, { stroke: pathStroke(stroke) })],
      });
      expect(h.drawn()).toEqual(expected ? ['a:stroke'] : []);
      expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([0, expected ? 1 : 0]);
    });
  }

  it('ST-A10: a singular world linear map draws neither paint and calls nothing', () => {
    const ports = both();
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [strokedNode('a', 0, { transform: [1, 0, 0, 0, 0, 0] })],
    });
    expect(h.prepare()).toEqual({ draws: [], notices: [] });
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual([0, 0]);
  });
});

describe('ST-U6 accounting, fringe and device loss', () => {
  it('ST-A10: statistics report strokePortLinearMemoryBytes, and pathMeshMemoryBytes includes it', () => {
    const h = createStrokeHarness({
      fillPort: createCountingPort(),
      strokePort: new ScriptedStrokeMeshPort(),
      nodes: [strokedNode('a', 0)],
      memoryBytes: () => 1000,
      strokeMemoryBytes: () => 300,
    });
    h.prepare();
    const statistics = h.statistics();
    const fillBytes = 64 + 24 + 32 + 32;
    const strokeBytes = 128 + 96 + 64 + 64;
    expect(statistics).toMatchObject({
      entries: 2,
      bytes: fillBytes + strokeBytes,
      portLinearMemoryBytes: 1000,
      strokePortLinearMemoryBytes: 300,
      pathMeshMemoryBytes: fillBytes + strokeBytes + 1300,
    });
    const strokeOnly = createStrokeHarness({
      strokePort: new ScriptedStrokeMeshPort(),
      nodes: [strokedNode('a', 0, { fill: null })],
      strokeMemoryBytes: () => 300,
    });
    strokeOnly.prepare();
    expect(strokeOnly.statistics()).toMatchObject({
      bytes: strokeBytes,
      strokePortLinearMemoryBytes: 300,
      pathMeshMemoryBytes: strokeBytes + 300,
    });
    expect(strokeOnly.statistics()).not.toHaveProperty('portLinearMemoryBytes');
  });

  it('ST-A10: the stroke mesh uses the fringe builder unchanged', () => {
    const h = createStrokeHarness({
      fillPort: createCountingPort(),
      strokePort: new ScriptedStrokeMeshPort(),
      nodes: [strokedNode('a', 0)],
      fringeBuilder: buildPathFringe,
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => [draw.paint, draw.fringe !== null])).toEqual([
      ['fill', true],
      ['stroke', true],
    ]);
    expect(frame.draws[1]!.fringe!.data.regionTriangles).toBe(8);
  });

  it('ST-A10: a generation change reconstructs fill and stroke records byte for byte with zero port calls', () => {
    const ports = both();
    const h = createStrokeHarness({
      fillPort: ports.fill,
      strokePort: ports.stroke,
      nodes: [strokedNode('a', 0), rectangleNode('r', 40), strokedNode('b', 20, { fill: null })],
    });
    h.setZoom(1.25, { x: -3.5, y: 1.75 });
    const shadow = new MeshShadow();
    const first = h.source.prepare(target)!;
    shadow.apply(first);
    h.source.acknowledge(receiptOf(first));
    const calls = [ports.fill.callCount, ports.stroke.callCount];
    const lost = h.source.prepare({ ...target, generation: 2 })!;
    expect(lost.mode).toBe('reconstruct');
    expect([ports.fill.callCount, ports.stroke.callCount]).toEqual(calls);
    const covered = new Map<MeshResourceId, Set<number>>();
    for (const write of lost.mesh!.writes) {
      const before = shadow.bytes.get(write.resourceId)!;
      expect(write.bytes).toEqual(
        before.subarray(write.byteOffset, write.byteOffset + write.bytes.byteLength),
      );
      const indices = covered.get(write.resourceId) ?? new Set<number>();
      for (const record of write.records) indices.add(record.index);
      covered.set(write.resourceId, indices);
    }
    // Slots: a fill 0, a stroke 1, b fill 2 (no draw: fill null), b stroke 3.
    expect(covered.get('meshInstances')).toEqual(new Set([0, 1, 3]));
    expect(lost.mesh!.draws).toEqual(first.mesh!.draws);
    expect(words(lost.mesh!.writes[0]!.bytes, 'f32').length).toBeGreaterThan(0);
  });
});
