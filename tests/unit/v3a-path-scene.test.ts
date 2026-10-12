import type {
  RenderNodeSnapshot,
  RendererInvalidationTarget,
  RenderSceneSnapshot,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import {
  RetainedSceneMirror,
  setNextGeometryRevisionForTesting,
} from '../../packages/renderer-core/src/scene-mirror.js';
import {
  createCountingPort,
  identity,
  pathNode,
  rectangleNode,
  type PathNode,
} from '../support/v3a-path-harness.js';

// P3 V3 contract, section a (V3-A1) and section b's geometry revision (V3-A2).

const invalidation: RendererInvalidationTarget = {
  invalidate: () => undefined,
  setMode: () => undefined,
};

function supportedMirror(): RetainedSceneMirror {
  return new RetainedSceneMirror(undefined, { pathNodes: 'supported' });
}

function snapshot(nodes: readonly unknown[], revision = 1, rootOrder?: readonly string[]) {
  return {
    identity,
    revision,
    nodes,
    rootOrder:
      rootOrder ??
      (nodes as RenderNodeSnapshot[])
        .filter((node) => node.parentId === null)
        .map((node) => node.id),
  } as RenderSceneSnapshot;
}

function reasonFor(node: unknown, mirror = supportedMirror()): string {
  const result = mirror.replaceSnapshot(snapshot([node], 1, [(node as { id: string }).id]));
  return result.status === 'invalid-scene' ? result.reason : result.status;
}

function withGeometry(geometry: Record<string, unknown>): unknown {
  return { ...pathNode('p', 0), geometry };
}

const square = pathNode('p', 0);

describe('V3a path node validation', () => {
  it('V3-A1: node fields other than exactly the eight path fields are invalid-value', () => {
    expect(reasonFor(square)).toBe('applied');
    expect(reasonFor({ ...square, children: [] })).toBe('invalid-value');
    const missingStyle = Object.fromEntries(
      Object.entries(square).filter(([key]) => key !== 'style'),
    );
    expect(reasonFor(missingStyle)).toBe('invalid-value');
  });

  it('V3-A1: geometry fields other than kind, verbs, points and fillRule, or a kind other than path, are invalid-value', () => {
    expect(reasonFor(withGeometry({ ...square.geometry, extra: 1 }))).toBe('invalid-value');
    expect(reasonFor(withGeometry({ ...square.geometry, kind: 'rectangle' }))).toBe(
      'invalid-value',
    );
    expect(
      reasonFor({
        ...square,
        geometry: { kind: 'rectangle', width: 1, height: 1, cornerRadii: [0, 0, 0, 0] },
      }),
    ).toBe('invalid-value');
  });

  it('V3-A1: unknown verbs, grammar violations, point-count mismatches and bad coordinates are invalid-value', () => {
    const geometry = square.geometry;
    const cases: Array<Record<string, unknown>> = [
      { ...geometry, verbs: ['move', 'arc'], points: [0, 0, 1, 1] },
      { ...geometry, verbs: ['line'], points: [1, 1] },
      { ...geometry, verbs: ['close'], points: [] },
      { ...geometry, verbs: ['move', 'line', 'close', 'close'], points: [0, 0, 1, 1] },
      { ...geometry, verbs: ['move', 'close', 'line'], points: [0, 0, 1, 1] },
      { ...geometry, verbs: ['move', 'cubic'], points: [0, 0, 1, 1] },
      { ...geometry, points: [...geometry.points, 1] },
      { ...geometry, points: geometry.points.slice(0, -2) },
      { ...geometry, points: [Number.NaN, ...geometry.points.slice(1)] },
      { ...geometry, points: [Number.POSITIVE_INFINITY, ...geometry.points.slice(1)] },
      { ...geometry, points: ['0', ...geometry.points.slice(1)] },
      { ...geometry, verbs: 'move' },
    ];
    for (const candidate of cases) expect(reasonFor(withGeometry(candidate))).toBe('invalid-value');
    // The grammar admits consecutive MOVEs, MOVE-only subpaths, open and closed subpaths.
    for (const verbs of [
      ['move', 'move'],
      ['move', 'close'],
      ['move', 'line', 'close', 'move', 'line'],
    ] as const) {
      const points = verbs.flatMap((verb) => (verb === 'close' ? [] : [1, 2]));
      expect(reasonFor(withGeometry({ ...geometry, verbs, points }))).toBe('applied');
    }
  });

  it('V3-A1: a missing or unknown fillRule is invalid-value', () => {
    const withoutRule = Object.fromEntries(
      Object.entries(square.geometry).filter(([key]) => key !== 'fillRule'),
    );
    expect(reasonFor(withGeometry(withoutRule))).toBe('invalid-value');
    expect(reasonFor(withGeometry({ ...square.geometry, fillRule: 'winding' }))).toBe(
      'invalid-value',
    );
    expect(reasonFor(withGeometry({ ...square.geometry, fillRule: 'evenodd' }))).toBe('applied');
  });

  it('V3-A1: style fields other than exactly fill, or an invalid fill color, are invalid-value', () => {
    expect(reasonFor({ ...square, style: { fill: null, stroke: null } })).toBe('invalid-value');
    expect(reasonFor({ ...square, style: {} })).toBe('invalid-value');
    expect(reasonFor({ ...square, style: { fill: { r: 2, g: 0, b: 0, a: 1 } } })).toBe(
      'invalid-value',
    );
    expect(reasonFor({ ...square, style: { fill: null } })).toBe('applied');
  });

  it('V3-A1: a nonfinite world transform or nonfinite point-box world bounds is invalid-value; an empty path is exempt', () => {
    const huge = [1e308, 0, 0, 1e308, 0, 0] as const;
    expect(reasonFor(pathNode('p', 0, { transform: huge }))).toBe('invalid-value');
    expect(reasonFor(pathNode('p', 0, { transform: huge, verbs: [], points: [] }))).toBe('applied');
    const mirror = supportedMirror();
    const parent: RenderNodeSnapshot = {
      id: 'g',
      parentId: null,
      transform: [1e300, 0, 0, 1e300, 0, 0],
      visible: true,
      opacity: 1,
      kind: 'container',
      children: ['p'],
    };
    const child = pathNode('p', 0, { parentId: 'g', transform: [1e300, 0, 0, 1e300, 0, 0] });
    const result = mirror.replaceSnapshot(snapshot([parent, child], 1, ['g']));
    expect(result).toMatchObject({ status: 'invalid-scene', reason: 'invalid-value' });
  });

  it('V3-A1: a path node without a port is unsupported-feature, from the mirror default and from a service without a port', () => {
    expect(reasonFor(square, new RetainedSceneMirror())).toBe('unsupported-feature');
    const service = new PrimitiveRendererService(invalidation);
    expect(service.replaceSnapshot(snapshot([square]))).toMatchObject({
      status: 'invalid-scene',
      reason: 'unsupported-feature',
    });
    const withPort = new PrimitiveRendererService(invalidation, { fillMesh: createCountingPort() });
    expect(withPort.replaceSnapshot(snapshot([square])).status).toBe('applied');
  });

  it('V3-A1: an empty path and a grammar-valid path the kernel cannot mesh are accepted', () => {
    expect(reasonFor(pathNode('p', 0, { verbs: [], points: [] }))).toBe('applied');
    expect(reasonFor(pathNode('p', 0, { verbs: ['move'], points: [0, 0] }))).toBe('applied');
  });

  it('V3-A1: D1 precedence keeps invalid-value before graph reasons before unsupported-feature', () => {
    const unsupported = new RetainedSceneMirror();
    // A path (unsupported) beside an unknown root id: the graph reason wins.
    expect(unsupported.replaceSnapshot(snapshot([square], 1, ['p', 'missing']))).toMatchObject({
      reason: 'unknown-node',
    });
    // Invalid path content beside the same graph error: invalid-value wins.
    expect(
      unsupported.replaceSnapshot(
        snapshot([withGeometry({ ...square.geometry, fillRule: 'x' })], 1, ['p', 'missing']),
      ),
    ).toMatchObject({ reason: 'invalid-value' });
    // A duplicate id precedes unsupported-feature as well.
    expect(unsupported.replaceSnapshot(snapshot([square, square], 1, ['p']))).toMatchObject({
      reason: 'duplicate-id',
    });
    // applyChanges: a path insert without a port is reported after graph checks.
    const primitives = new RetainedSceneMirror();
    expect(primitives.replaceSnapshot(snapshot([rectangleNode('r', 0)])).status).toBe('applied');
    const change = {
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [pathNode('q', 0)],
      updated: [],
      removed: [],
      orders: [{ parentId: null, children: ['r', 'q'] }],
    };
    expect(primitives.applyChanges(change)).toMatchObject({ reason: 'unsupported-feature' });
    expect(
      primitives.applyChanges({ ...change, orders: [{ parentId: null, children: ['r'] }] }),
    ).toMatchObject({ reason: 'invalid-order' });
  });

  it('V3-A1: replay equality and revision-conflict include verbs, points, fillRule and fill', () => {
    const mirror = supportedMirror();
    expect(mirror.replaceSnapshot(snapshot([square])).status).toBe('applied');
    expect(mirror.replaceSnapshot(snapshot([pathNode('p', 0)])).status).toBe('replayed');
    const zeroed = pathNode('p', 0, { points: [-0, 0, 10, 0, 10, 10] });
    expect(mirror.replaceSnapshot(snapshot([zeroed])).status).toBe('replayed');
    const conflicts: PathNode[] = [
      pathNode('p', 0, { points: [0, 0, 10, 0, 10, 11] }),
      pathNode('p', 0, { verbs: ['move', 'line', 'line'] }),
      pathNode('p', 0, { fillRule: 'evenodd' }),
      pathNode('p', 0, { fill: { r: 0, g: 1, b: 0, a: 1 } }),
      pathNode('p', 0, { fill: null }),
    ];
    for (const conflict of conflicts) {
      expect(mirror.replaceSnapshot(snapshot([conflict]))).toMatchObject({
        status: 'invalid-scene',
        reason: 'revision-conflict',
      });
    }
  });

  it('V3-A1: accepted verbs and points are owned frozen copies', () => {
    const mirror = supportedMirror();
    const verbs: PathNode['geometry']['verbs'][number][] = ['move', 'line', 'line', 'close'];
    const points = [0, 0, 10, 0, 10, 10];
    const node = pathNode('p', 0, { verbs, points });
    expect(mirror.replaceSnapshot(snapshot([node])).status).toBe('applied');
    verbs[1] = 'cubic';
    points[0] = 99;
    const stored = mirror.readRetainedScene()!.getNode('p') as PathNode;
    expect(stored.geometry.verbs).toEqual(['move', 'line', 'line', 'close']);
    expect(stored.geometry.points).toEqual([0, 0, 10, 0, 10, 10]);
    expect(Object.isFrozen(stored.geometry.verbs)).toBe(true);
    expect(Object.isFrozen(stored.geometry.points)).toBe(true);
    expect(Object.isFrozen(stored.geometry)).toBe(true);
    expect(Object.isFrozen(stored.style)).toBe(true);
  });

  it('V3-A1: the service port shape check throws TypeError for a malformed port', () => {
    const port = createCountingPort();
    const malformed: unknown[] = [
      { portVersion: 1, operationId: 'x', buildFillMeshes: () => undefined },
      { portVersion: 0, operationId: '', buildFillMeshes: () => undefined },
      { portVersion: 0, operationId: 7, buildFillMeshes: () => undefined },
      { portVersion: 0, operationId: 'x' },
      { portVersion: 0, operationId: 'x', buildFillMeshes: 'nope' },
      null,
    ];
    for (const fillMesh of malformed) {
      expect(
        () => new PrimitiveRendererService(invalidation, { fillMesh: fillMesh as never }),
      ).toThrow(TypeError);
    }
    expect(
      () =>
        new PrimitiveRendererService(invalidation, {
          fillMesh: port,
          fillMeshMemoryBytes: 5 as never,
        }),
    ).toThrow(TypeError);
    expect(() => new PrimitiveRendererService(invalidation, { fillMesh: port })).not.toThrow();
  });
});

describe('V3a geometry revision', () => {
  function revisionOf(mirror: RetainedSceneMirror, id: string): number | undefined {
    return mirror.readRetainedScene()!.getGeometryRevision(id);
  }

  function change(
    revision: number,
    parts: Partial<{
      inserted: RenderNodeSnapshot[];
      updated: RenderNodeSnapshot[];
      removed: string[];
      rootOrder: string[];
    }>,
  ) {
    return {
      identity,
      revision,
      baseRevision: revision - 1,
      inserted: parts.inserted ?? [],
      updated: parts.updated ?? [],
      removed: parts.removed ?? [],
      orders: parts.rootOrder === undefined ? [] : [{ parentId: null, children: parts.rootOrder }],
    };
  }

  it('V3-A2: an equal republish keeps the revision; changed points or verbs take a new value', () => {
    const mirror = supportedMirror();
    mirror.replaceSnapshot(snapshot([pathNode('a', 0), pathNode('b', 20)]));
    const a = revisionOf(mirror, 'a')!;
    const b = revisionOf(mirror, 'b')!;
    expect(a).toBeGreaterThanOrEqual(1);
    expect(b).not.toBe(a);
    // Opacity, transform, fill and fillRule changes keep the revision.
    expect(
      mirror.applyChanges(
        change(2, {
          updated: [
            pathNode('a', 0, {
              opacity: 0.5,
              transform: [2, 0, 0, 2, 5, 5],
              fill: null,
              fillRule: 'evenodd',
            }),
          ],
        }),
      ).status,
    ).toBe('applied');
    expect(revisionOf(mirror, 'a')).toBe(a);
    // -0 to +0 keeps it under the === rule.
    mirror.applyChanges(change(3, { updated: [pathNode('a', -0)] }));
    expect(revisionOf(mirror, 'a')).toBe(a);
    mirror.applyChanges(
      change(4, { updated: [pathNode('a', 0, { points: [0, 0, 10, 0, 9, 9] })] }),
    );
    const afterPoints = revisionOf(mirror, 'a')!;
    expect(afterPoints).toBeGreaterThan(Math.max(a, b));
    mirror.applyChanges(
      change(5, {
        updated: [
          pathNode('a', 0, { verbs: ['move', 'line', 'line'], points: [0, 0, 10, 0, 9, 9] }),
        ],
      }),
    );
    expect(revisionOf(mirror, 'a')).toBeGreaterThan(afterPoints);
    expect(revisionOf(mirror, 'b')).toBe(b);
  });

  it('V3-A2: reinsertion after removal and a kind change take a new value', () => {
    const mirror = supportedMirror();
    mirror.replaceSnapshot(snapshot([pathNode('a', 0)]));
    const first = revisionOf(mirror, 'a')!;
    mirror.applyChanges(change(2, { removed: ['a'], rootOrder: [] }));
    expect(revisionOf(mirror, 'a')).toBeUndefined();
    mirror.applyChanges(change(3, { inserted: [pathNode('a', 0)], rootOrder: ['a'] }));
    const reinserted = revisionOf(mirror, 'a')!;
    expect(reinserted).toBeGreaterThan(first);
    // Kind change: path to primitive and back to the same path data.
    mirror.replaceSnapshot(snapshot([rectangleNode('a', 0)], 4));
    expect(revisionOf(mirror, 'a')).toBeUndefined();
    mirror.replaceSnapshot(snapshot([pathNode('a', 0)], 5));
    expect(revisionOf(mirror, 'a')).toBeGreaterThan(reinserted);
  });

  it('V3-A2: an identity switch with equal path data keeps the revision', () => {
    const mirror = supportedMirror();
    mirror.replaceSnapshot(snapshot([pathNode('a', 0), pathNode('b', 20)]));
    const a = revisionOf(mirror, 'a');
    const b = revisionOf(mirror, 'b');
    const switched = mirror.replaceSnapshot({
      identity: { documentId: 'other', pageId: 'page-2' },
      revision: 0,
      nodes: [pathNode('a', 0), pathNode('b', 21)],
      rootOrder: ['a', 'b'],
    });
    expect(switched.status).toBe('applied');
    expect(revisionOf(mirror, 'a')).toBe(a);
    expect(revisionOf(mirror, 'b')).not.toBe(b);
  });

  it('V3-A2: overflow returns invalid-value with the previous version and publishes nothing', () => {
    const mirror = supportedMirror();
    mirror.replaceSnapshot(snapshot([pathNode('a', 0)]));
    setNextGeometryRevisionForTesting(mirror, Number.MAX_SAFE_INTEGER);
    expect(
      mirror.applyChanges(change(2, { inserted: [pathNode('b', 20)], rootOrder: ['a', 'b'] })),
    ).toMatchObject({ status: 'applied' });
    expect(revisionOf(mirror, 'b')).toBe(Number.MAX_SAFE_INTEGER);
    const before = mirror.readRetainedScene()!;
    const pending = mirror.getPendingChangeState();
    const overflow = mirror.applyChanges(
      change(3, { inserted: [pathNode('c', 40)], rootOrder: ['a', 'b', 'c'] }),
    );
    expect(overflow).toEqual({
      status: 'invalid-scene',
      reason: 'invalid-value',
      current: { identity, revision: 2 },
    });
    const after = mirror.readRetainedScene()!;
    expect(after.version).toEqual(before.version);
    expect(after.sceneEpoch).toBe(before.sceneEpoch);
    expect(after.getNode('c')).toBeUndefined();
    expect(mirror.getPendingChangeState().invalidationToken).toBe(pending.invalidationToken);
    // A replace that keeps every path's data needs no new value and still publishes.
    expect(mirror.replaceSnapshot(snapshot([pathNode('a', 0), pathNode('b', 20)], 4)).status).toBe(
      'applied',
    );
    expect(mirror.replaceSnapshot(snapshot([pathNode('a', 1)], 5))).toMatchObject({
      reason: 'invalid-value',
      current: { revision: 4 },
    });
  });
});
