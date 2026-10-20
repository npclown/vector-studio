import type {
  RenderNodeSnapshot,
  RendererInvalidationTarget,
  RenderSceneSnapshot,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import {
  STROKE_MITER_BOUND_CAP,
  getPathLocalStrokeBounds,
} from '../../packages/renderer-core/src/scene-numeric.js';
import {
  createCountingPort,
  identity,
  pathNode,
  rectangleNode,
} from '../support/v3a-path-harness.js';
import {
  ScriptedStrokeMeshPort,
  pathStroke,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';

// B2 stroke contract, section 5 (unit ST-U6, ST-A10 validation rows): the scene field
// PathStroke, its validation rows and precedence, the stroke bounds box with the ST-A0 S3
// cap, the mirror options pathStrokes and pathFills (ST-A0 S4), replay equality and the
// geometry revision. Functional evidence only: precision is UNVERIFIED against the 0.25
// physical-pixel target.

const invalidation: RendererInvalidationTarget = {
  invalidate: () => undefined,
  setMode: () => undefined,
};

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

function strokeMirror(): RetainedSceneMirror {
  return new RetainedSceneMirror(undefined, { pathNodes: 'supported', pathStrokes: 'supported' });
}

function reasonFor(node: unknown, mirror = strokeMirror()): string {
  const result = mirror.replaceSnapshot(snapshot([node], 1, [(node as { id: string }).id]));
  return result.status === 'invalid-scene' ? result.reason : result.status;
}

const stroked = strokedNode('p', 0);

function withStroke(stroke: unknown): unknown {
  return { ...stroked, style: { fill: stroked.style.fill, stroke } };
}

describe('ST-U6 PathStroke validation rows (section 5)', () => {
  it('ST-A10: style fields other than exactly fill and stroke are invalid-value', () => {
    expect(reasonFor(stroked)).toBe('applied');
    expect(reasonFor({ ...stroked, style: { fill: null } })).toBe('invalid-value');
    expect(reasonFor({ ...stroked, style: { stroke: null } })).toBe('invalid-value');
    expect(reasonFor({ ...stroked, style: { fill: null, stroke: null, dash: null } })).toBe(
      'invalid-value',
    );
  });

  it('ST-A10: a stroke that is not null and not an object with exactly the five fields is invalid-value', () => {
    const base = pathStroke() as Record<string, unknown>;
    for (const candidate of [
      undefined,
      0,
      'stroke',
      [],
      {},
      { ...base, dash: [1, 2] },
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'miterLimit')),
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'cap')),
    ]) {
      expect(reasonFor(withStroke(candidate))).toBe('invalid-value');
    }
    expect(reasonFor(withStroke(null))).toBe('applied');
  });

  it('ST-A10: an invalid stroke color is invalid-value', () => {
    for (const color of [
      null,
      { r: 2, g: 0, b: 0, a: 1 },
      { r: 0, g: 0, b: 0 },
      { r: 0, g: 0, b: 0, a: Number.NaN },
      { r: 0, g: 0, b: 0, a: 1, extra: 0 },
    ]) {
      expect(reasonFor(withStroke({ ...pathStroke(), color }))).toBe('invalid-value');
    }
  });

  it('ST-A10: a width that is not a number, nonfinite or negative is invalid-value', () => {
    for (const width of ['2', -1, -Number.MIN_VALUE, Number.NaN, Infinity, -Infinity, null]) {
      expect(reasonFor(withStroke({ ...pathStroke(), width }))).toBe('invalid-value');
    }
    expect(reasonFor(withStroke(pathStroke({ width: 0 })))).toBe('applied');
    expect(reasonFor(withStroke(pathStroke({ width: Number.MIN_VALUE })))).toBe('applied');
  });

  it('ST-A10: a cap or join outside its three strings is invalid-value', () => {
    for (const cap of ['Butt', 'miter', '', null]) {
      expect(reasonFor(withStroke({ ...pathStroke(), cap }))).toBe('invalid-value');
    }
    for (const join of ['Miter', 'butt', 'arcs', null]) {
      expect(reasonFor(withStroke({ ...pathStroke(), join }))).toBe('invalid-value');
    }
    for (const cap of ['butt', 'round', 'square'] as const) {
      for (const join of ['miter', 'round', 'bevel'] as const) {
        expect(reasonFor(withStroke(pathStroke({ cap, join })))).toBe('applied');
      }
    }
  });

  it('ST-A10: a miterLimit that is not a number, nonfinite or below 1 is invalid-value, for every join kind', () => {
    for (const join of ['miter', 'round', 'bevel'] as const) {
      for (const miterLimit of ['4', 0.9999999999999999, 0, -1, Number.NaN, Infinity, null]) {
        expect(reasonFor(withStroke({ ...pathStroke({ join }), miterLimit }))).toBe(
          'invalid-value',
        );
      }
      expect(reasonFor(withStroke(pathStroke({ join, miterLimit: 1 })))).toBe('applied');
    }
  });

  it('ST-A10 (ST-A0 S3): miterLimit Number.MAX_VALUE is valid; the stroke bounds box uses k = min(L, 2^24)', () => {
    const huge = pathStroke({ width: 4, join: 'miter', miterLimit: Number.MAX_VALUE });
    expect(reasonFor(withStroke(huge))).toBe('applied');
    // Without the cap, r * L would be Infinity.
    expect(2 * Number.MAX_VALUE).toBe(Infinity);
    expect(getPathLocalStrokeBounds([0, 0, 10, 10], huge)).toEqual({
      minX: -2 * STROKE_MITER_BOUND_CAP,
      minY: -2 * STROKE_MITER_BOUND_CAP,
      maxX: 10 + 2 * STROKE_MITER_BOUND_CAP,
      maxY: 10 + 2 * STROKE_MITER_BOUND_CAP,
    });
    expect(STROKE_MITER_BOUND_CAP).toBe(2 ** 24);
  });

  it('ST-A10: the stroke bounds box factor is max(1, min(L, 2^24) for miter, 1.5 for square)', () => {
    const box = (overrides: Parameters<typeof pathStroke>[0]) =>
      getPathLocalStrokeBounds([0, 0, 10, 0], pathStroke({ width: 2, ...overrides }))!.minX;
    expect(box({ join: 'miter', miterLimit: 4, cap: 'butt' })).toBe(-4);
    expect(box({ join: 'miter', miterLimit: 1, cap: 'square' })).toBe(-1.5);
    expect(box({ join: 'miter', miterLimit: 1.2, cap: 'square' })).toBe(-1.5);
    expect(box({ join: 'round', miterLimit: 100, cap: 'square' })).toBe(-1.5);
    expect(box({ join: 'bevel', miterLimit: 100, cap: 'round' })).toBe(-1);
    expect(box({ join: 'round', miterLimit: 100, cap: 'butt' })).toBe(-1);
    // No box for width 0, a null stroke or an empty path.
    expect(getPathLocalStrokeBounds([0, 0], pathStroke({ width: 0 }))).toBeNull();
    expect(getPathLocalStrokeBounds([0, 0], null)).toBeNull();
    expect(getPathLocalStrokeBounds([], pathStroke())).toBeNull();
  });

  it('ST-A10: nonfinite world bounds of the stroke bounds box are invalid-value for a nonempty path with width > 0', () => {
    // The point box is finite; only the stroke box overflows.
    const wide = pathStroke({ width: 1e308, join: 'miter', miterLimit: 4 });
    expect(reasonFor(withStroke(wide))).toBe('invalid-value');
    const scaled = strokedNode('p', 0, {
      transform: [1e300, 0, 0, 1e300, 0, 0],
      stroke: pathStroke({ width: 1e10, join: 'bevel' }),
    });
    expect(reasonFor(scaled)).toBe('invalid-value');
    // Exempt: an empty path and a width-0 stroke.
    expect(reasonFor(strokedNode('p', 0, { verbs: [], points: [], stroke: wide }))).toBe('applied');
    expect(
      reasonFor(
        strokedNode('p', 0, {
          transform: [1e300, 0, 0, 1e300, 0, 0],
          stroke: pathStroke({ width: 0, join: 'bevel' }),
        }),
      ),
    ).toBe('applied');
  });

  it('ST-A10: width > 0 while pathStrokes is unsupported is unsupported-feature; width 0 is accepted without a stroke port', () => {
    const fillOnly = new RetainedSceneMirror(undefined, { pathNodes: 'supported' });
    expect(reasonFor(stroked, fillOnly)).toBe('unsupported-feature');
    const zero = strokedNode('p', 0, { stroke: pathStroke({ width: 0 }) });
    expect(reasonFor(zero, new RetainedSceneMirror(undefined, { pathNodes: 'supported' }))).toBe(
      'applied',
    );
    expect(reasonFor(zero)).toBe('applied');
    expect(reasonFor(stroked)).toBe('applied');
  });

  it('ST-A10 (ST-A0 S4): pathFills defaults to pathNodes; with pathFills unsupported a fill is unsupported-feature and a stroke-only path is accepted', () => {
    // A V3 call keeps its meaning: fills accepted.
    expect(
      reasonFor(pathNode('p', 0), new RetainedSceneMirror(undefined, { pathNodes: 'supported' })),
    ).toBe('applied');
    const strokeOnly = () =>
      new RetainedSceneMirror(undefined, {
        pathNodes: 'supported',
        pathFills: 'unsupported',
        pathStrokes: 'supported',
      });
    expect(reasonFor(stroked, strokeOnly())).toBe('unsupported-feature');
    expect(reasonFor(pathNode('p', 0), strokeOnly())).toBe('unsupported-feature');
    expect(reasonFor(strokedNode('p', 0, { fill: null }), strokeOnly())).toBe('applied');
    expect(reasonFor(strokedNode('p', 0, { fill: null, stroke: null }), strokeOnly())).toBe(
      'applied',
    );
  });

  it('ST-A10: precedence keeps invalid stroke values before graph reasons before an unsupported stroke', () => {
    const fillOnly = () => new RetainedSceneMirror(undefined, { pathNodes: 'supported' });
    // An unsupported stroke beside an unknown root id: the graph reason wins.
    expect(fillOnly().replaceSnapshot(snapshot([stroked], 1, ['p', 'missing']))).toMatchObject({
      reason: 'unknown-node',
    });
    // An invalid stroke value beside the same graph error: invalid-value wins.
    expect(
      fillOnly().replaceSnapshot(
        snapshot([withStroke({ ...pathStroke(), width: -1 })], 1, ['p', 'missing']),
      ),
    ).toMatchObject({ reason: 'invalid-value' });
    // applyChanges: an unsupported stroke update is reported after graph checks.
    const mirror = fillOnly();
    expect(mirror.replaceSnapshot(snapshot([rectangleNode('r', 0)])).status).toBe('applied');
    const change = {
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [stroked],
      updated: [],
      removed: [],
      orders: [{ parentId: null, children: ['r', 'p'] }],
    };
    expect(mirror.applyChanges(change)).toMatchObject({ reason: 'unsupported-feature' });
    expect(
      mirror.applyChanges({ ...change, orders: [{ parentId: null, children: ['r'] }] }),
    ).toMatchObject({ reason: 'invalid-order' });
  });

  it('ST-A10: replay equality compares every stroke field with ===, color channels included', () => {
    const mirror = strokeMirror();
    expect(mirror.replaceSnapshot(snapshot([stroked])).status).toBe('applied');
    expect(mirror.replaceSnapshot(snapshot([strokedNode('p', 0)])).status).toBe('replayed');
    const variants = [
      { width: 2.5 },
      { cap: 'round' as const },
      { join: 'bevel' as const },
      { miterLimit: 4.5 },
      { color: { r: 0, g: 0, b: 1, a: 0.5 } },
      { color: { r: 0, g: 0.25, b: 1, a: 1 } },
    ];
    for (const overrides of variants) {
      expect(
        mirror.replaceSnapshot(snapshot([strokedNode('p', 0, { stroke: pathStroke(overrides) })]))
          .status,
        JSON.stringify(overrides),
      ).toBe('invalid-scene');
    }
    expect(mirror.replaceSnapshot(snapshot([strokedNode('p', 0, { stroke: null })]))).toMatchObject(
      { reason: 'revision-conflict' },
    );
    // -0 equals +0 under ===.
    expect(
      mirror.replaceSnapshot(
        snapshot([
          strokedNode('p', 0, { stroke: pathStroke({ color: { r: -0, g: 0, b: 1, a: 1 } }) }),
        ]),
      ).status,
    ).toBe('replayed');
  });

  it('ST-A10: stroke fields leave the geometry revision unchanged; accepted strokes are owned frozen copies', () => {
    const mirror = strokeMirror();
    expect(mirror.replaceSnapshot(snapshot([stroked], 1)).status).toBe('applied');
    const before = mirror.readRetainedScene()!.getGeometryRevision('p');
    const input = pathStroke({ width: 3, cap: 'square', join: 'round', miterLimit: 2 });
    expect(
      mirror.replaceSnapshot(snapshot([strokedNode('p', 0, { stroke: input })], 2)).status,
    ).toBe('applied');
    expect(mirror.readRetainedScene()!.getGeometryRevision('p')).toBe(before);
    const stored = mirror.readRetainedScene()!.getNode('p') as Extract<
      RenderNodeSnapshot,
      { kind: 'path' }
    >;
    expect(stored.style.stroke).toEqual(input);
    expect(stored.style.stroke).not.toBe(input);
    expect(Object.isFrozen(stored.style.stroke)).toBe(true);
    expect(Object.isFrozen(stored.style.stroke!.color)).toBe(true);
  });
});

describe('ST-U6 service options (section 9.1)', () => {
  it('ST-A10: the stroke port shape check and the memory hook check throw TypeError', () => {
    const bad = [
      null,
      {},
      { portVersion: 1, operationId: 'x', buildStrokeMeshes: () => undefined },
      { portVersion: 0, operationId: '', buildStrokeMeshes: () => undefined },
      { portVersion: 0, operationId: 'x', buildStrokeMeshes: 1 },
      { portVersion: 0, operationId: 'x', buildFillMeshes: () => undefined },
    ];
    for (const strokeMesh of bad) {
      expect(
        () => new PrimitiveRendererService(invalidation, { strokeMesh: strokeMesh as never }),
      ).toThrow(TypeError);
    }
    expect(
      () =>
        new PrimitiveRendererService(invalidation, {
          strokeMesh: new ScriptedStrokeMeshPort(),
          strokeMeshMemoryBytes: 5 as never,
        }),
    ).toThrow(TypeError);
  });

  it('ST-A10 (ST-A0 S4): pathNodes is supported with a fill port, a stroke port or both; fills need the fill port, strokes the stroke port', () => {
    const fill = pathNode('f', 0);
    const strokeOnly = strokedNode('s', 20, { fill: null });
    const both = strokedNode('b', 40);
    const apply = (service: PrimitiveRendererService, node: RenderNodeSnapshot) => {
      const result = service.replaceSnapshot(snapshot([node]));
      return result.status === 'invalid-scene' ? result.reason : result.status;
    };
    const none = () => new PrimitiveRendererService(invalidation);
    const fillService = () =>
      new PrimitiveRendererService(invalidation, { fillMesh: createCountingPort() });
    const strokeService = () =>
      new PrimitiveRendererService(invalidation, { strokeMesh: new ScriptedStrokeMeshPort() });
    const bothService = () =>
      new PrimitiveRendererService(invalidation, {
        fillMesh: createCountingPort(),
        strokeMesh: new ScriptedStrokeMeshPort(),
      });
    expect([fill, strokeOnly, both].map((node) => apply(none(), node))).toEqual([
      'unsupported-feature',
      'unsupported-feature',
      'unsupported-feature',
    ]);
    expect([fill, strokeOnly, both].map((node) => apply(fillService(), node))).toEqual([
      'applied',
      'unsupported-feature',
      'unsupported-feature',
    ]);
    expect([fill, strokeOnly, both].map((node) => apply(strokeService(), node))).toEqual([
      'unsupported-feature',
      'applied',
      'unsupported-feature',
    ]);
    expect([fill, strokeOnly, both].map((node) => apply(bothService(), node))).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
    expect(none().requiresMeshPipeline).toBe(false);
    expect(fillService().requiresMeshPipeline).toBe(true);
    expect(strokeService().requiresMeshPipeline).toBe(true);
    expect(strokeService().getPathMeshStatistics()).toMatchObject({
      portCalls: 0,
      strokePortCalls: 0,
    });
    // A fill-only service reports no stroke statistics.
    expect(fillService().getPathMeshStatistics()).not.toHaveProperty('strokePortCalls');
  });
});
