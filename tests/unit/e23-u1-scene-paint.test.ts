import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneGradient,
  ScenePaint,
} from '@vector-studio/contracts';
import { SCENE_MAX_GRADIENT_STOPS, isSceneGradient } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  RetainedSceneMirror,
  type RetainedSceneMirrorOptions,
} from '../../packages/renderer-core/src/scene-mirror.js';
import { solidPaint } from '../../packages/renderer-core/src/scene-paint.js';

// E23 contract (docs/plans/d9-e23-gradient-paint-contract.md), E23-A01: E23-S1 to S3 through the
// retained scene mirror, with their reasons and precedence.

const identity = { documentId: 'e23-u1', pageId: 'page' } as const;
const affine = [1, 0, 0, 1, 0, 0] as const;
const GRADIENTS: RetainedSceneMirrorOptions = {
  pathNodes: 'supported',
  pathStrokes: 'supported',
  paints: 'gradient',
};
const SOLID: RetainedSceneMirrorOptions = { pathNodes: 'supported', pathStrokes: 'supported' };
const red = { r: 1, g: 0, b: 0, a: 1 } as const;
const blue = { r: 0, g: 0, b: 1, a: 1 } as const;
const linear: SceneGradient = {
  kind: 'linear',
  transform: [200, 0, 0, 200, 50, 0],
  stops: [
    { offset: 0, color: red },
    { offset: 1, color: blue },
  ],
  spread: 'pad',
};

function rect(id: string, fill: unknown, stroke: unknown = null): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: affine,
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 300, height: 100, cornerRadii: [0, 0, 0, 0] },
    style: { fill, stroke },
  } as RenderNodeSnapshot;
}

function path(id: string, fill: unknown, strokeColor: unknown = null): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: affine,
    visible: true,
    opacity: 1,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 8, 0, 0, 8],
      fillRule: 'nonzero',
    },
    style: {
      fill,
      stroke:
        strokeColor === null
          ? null
          : { color: strokeColor, width: 2, cap: 'butt', join: 'miter', miterLimit: 4 },
    },
  } as RenderNodeSnapshot;
}

function snapshot(nodes: readonly RenderNodeSnapshot[], revision = 1): RenderSceneSnapshot {
  return { identity, revision, nodes, rootOrder: nodes.map((node) => node.id) };
}

function reason(result: ReturnType<RetainedSceneMirror['replaceSnapshot']>): string {
  return result.status === 'invalid-scene' ? result.reason : result.status;
}

function replace(
  nodes: readonly RenderNodeSnapshot[],
  options: RetainedSceneMirrorOptions = GRADIENTS,
): string {
  return reason(new RetainedSceneMirror(undefined, options).replaceSnapshot(snapshot(nodes)));
}

function withGradient(fields: Record<string, unknown>): unknown {
  return { ...linear, ...fields };
}

function stops(count: number): SceneGradient['stops'] {
  return Array.from({ length: count }, (_, index) => ({
    offset: index / Math.max(1, count - 1),
    color: red,
  }));
}

describe('E23-A01 scene paint validation', () => {
  it('E23-S1: solid colours and gradients are accepted in every paint slot', () => {
    expect(replace([rect('a', red, { color: blue, width: 2 })])).toBe('applied');
    expect(replace([rect('a', linear, { color: linear, width: 2 })])).toBe('applied');
    expect(replace([path('p', linear, linear)])).toBe('applied');
    const radial = withGradient({ kind: 'radial', transform: [100, 0, 0, 50, 100, 50] });
    expect(replace([rect('a', radial)])).toBe('applied');
    for (const spread of ['pad', 'reflect', 'repeat']) {
      expect(replace([rect('a', withGradient({ spread }))])).toBe('applied');
    }
    expect(replace([rect('a', withGradient({ stops: stops(1) }))])).toBe('applied');
    expect(replace([rect('a', withGradient({ stops: stops(SCENE_MAX_GRADIENT_STOPS) }))])).toBe(
      'applied',
    );
    // Equal offsets make a hard stop (E23-K3).
    const hard = [
      { offset: 0, color: red },
      { offset: 0.5, color: red },
      { offset: 0.5, color: blue },
      { offset: 1, color: blue },
    ];
    expect(replace([rect('a', withGradient({ stops: hard }))])).toBe('applied');
  });

  it('E23-S1: a paint with mixed or missing fields is invalid-value', () => {
    expect(replace([rect('a', { ...red, kind: 'linear' })])).toBe('invalid-value');
    expect(replace([rect('a', { ...linear, extra: 1 })])).toBe('invalid-value');
    const missing = { kind: linear.kind, transform: linear.transform, stops: linear.stops };
    expect(replace([rect('a', missing)])).toBe('invalid-value');
    expect(replace([rect('a', { r: 1, g: 0, b: 0 })])).toBe('invalid-value');
  });

  it('E23-S2: each malformed gradient field is invalid-value', () => {
    const cases: readonly Record<string, unknown>[] = [
      { kind: 'conic' },
      { spread: 'clamp' },
      { transform: [1, 0, 0, 1, 0] },
      { transform: [1, 0, 0, 1, 0, Number.NaN] },
      { transform: [1, 2, 2, 4, 0, 0] },
      { transform: [0, 0, 0, 0, 0, 0] },
      // Non-zero binary64 determinant with a non-finite inverse.
      { transform: [1e-200, 0, 0, 1e-200, 0, 0] },
      { stops: [] },
      { stops: 'red' },
      { stops: [{ offset: 0, color: red, extra: true }] },
      { stops: [{ offset: -0.1, color: red }] },
      { stops: [{ offset: 1.1, color: red }] },
      { stops: [{ offset: Number.POSITIVE_INFINITY, color: red }] },
      { stops: [{ offset: 0, color: { r: 2, g: 0, b: 0, a: 1 } }] },
      {
        stops: [
          { offset: 0.6, color: red },
          { offset: 0.4, color: blue },
        ],
      },
    ];
    for (const fields of cases) {
      expect(replace([rect('a', withGradient(fields))]), JSON.stringify(fields)).toBe(
        'invalid-value',
      );
      expect(replace([path('p', null, withGradient(fields))]), JSON.stringify(fields)).toBe(
        'invalid-value',
      );
    }
  });

  it('E23-S2: more than 16 stops is unsupported-feature, after every stop is validated', () => {
    const many = stops(SCENE_MAX_GRADIENT_STOPS + 1);
    expect(replace([rect('a', withGradient({ stops: many }))])).toBe('unsupported-feature');
    expect(replace([path('p', null, withGradient({ stops: many }))])).toBe('unsupported-feature');
    const decreasing = [...many.slice(0, -1), { offset: 0.5, color: red }];
    expect(replace([rect('a', withGradient({ stops: decreasing }))])).toBe('invalid-value');
  });

  it('E23-S2: the stop count is reported after the graph checks', () => {
    const many = withGradient({ stops: stops(SCENE_MAX_GRADIENT_STOPS + 1) });
    const orphan = { ...rect('a', many), parentId: 'missing' } as RenderNodeSnapshot;
    const result = new RetainedSceneMirror(undefined, GRADIENTS).replaceSnapshot({
      identity,
      revision: 1,
      nodes: [orphan],
      rootOrder: [],
    });
    expect(reason(result)).toBe('invalid-parent');
  });

  it("E23-S3: gradients are unsupported-feature under paints 'solid', the default", () => {
    expect(replace([rect('a', linear)], SOLID)).toBe('unsupported-feature');
    expect(replace([rect('a', red, { color: linear, width: 2 })], SOLID)).toBe(
      'unsupported-feature',
    );
    expect(replace([path('p', linear)], SOLID)).toBe('unsupported-feature');
    expect(replace([path('p', null, linear)], SOLID)).toBe('unsupported-feature');
    expect(replace([rect('a', red), path('p', red, blue)], SOLID)).toBe('applied');
  });

  it('E23-S3: a change set that adds a gradient under solid support is rejected', () => {
    const mirror = new RetainedSceneMirror(undefined, SOLID);
    expect(mirror.replaceSnapshot(snapshot([rect('a', red)])).status).toBe('applied');
    const changes: RenderChangeSet = {
      identity,
      baseRevision: 1,
      revision: 2,
      inserted: [],
      updated: [rect('a', linear)],
      removed: [],
      orders: [],
    };
    expect(reason(mirror.applyChanges(changes))).toBe('unsupported-feature');
  });

  it('replay equality compares gradients field by field', () => {
    const mirror = new RetainedSceneMirror(undefined, GRADIENTS);
    expect(mirror.replaceSnapshot(snapshot([rect('a', linear)])).status).toBe('applied');
    const copy = structuredClone(linear) as ScenePaint;
    expect(mirror.replaceSnapshot(snapshot([rect('a', copy)])).status).toBe('replayed');
    const moved = withGradient({
      stops: [
        { offset: 0, color: red },
        { offset: 0.9, color: blue },
      ],
    });
    expect(reason(mirror.replaceSnapshot(snapshot([rect('a', moved)])))).toBe('revision-conflict');
  });

  it('isSceneGradient and solidPaint discriminate by kind', () => {
    expect(isSceneGradient(linear)).toBe(true);
    expect(isSceneGradient(red)).toBe(false);
    expect(solidPaint(red)).toBe(red);
    expect(() => solidPaint(linear)).toThrow(TypeError);
  });
});
