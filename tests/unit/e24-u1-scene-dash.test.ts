import type {
  PathStroke,
  RenderChangeSet,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
} from '@vector-studio/contracts';
import { SCENE_MAX_DASH_ENTRIES } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  RetainedSceneMirror,
  type RetainedSceneMirrorOptions,
} from '../../packages/renderer-core/src/scene-mirror.js';

// E24 contract (docs/plans/d9-e24-dash-contract.md), E24-A01: E24-S1 to S3 through the retained
// scene mirror, with their reasons and precedence, and E24-S2's copy and replay equality.

const identity = { documentId: 'e24-u1', pageId: 'page' } as const;
const affine = [1, 0, 0, 1, 0, 0] as const;
const DASHES: RetainedSceneMirrorOptions = {
  pathNodes: 'supported',
  pathStrokes: 'supported',
  dashes: 'supported',
};
const SOLID: RetainedSceneMirrorOptions = { pathNodes: 'supported', pathStrokes: 'supported' };
const blue = { r: 0, g: 0, b: 1, a: 1 } as const;
const DASH = { pattern: [30, 20], phase: 0 } as const;

/** A stroke whose `dash` key is present with the given value, or absent when `NO_KEY`. */
const NO_KEY = Symbol('no dash key');
function stroke(dash: unknown = DASH, width = 2): Record<string, unknown> {
  const base = { color: blue, width, cap: 'butt', join: 'miter', miterLimit: 4 };
  return dash === NO_KEY ? base : { ...base, dash };
}

function path(id: string, pathStroke: unknown, parentId: string | null = null): RenderNodeSnapshot {
  return {
    id,
    parentId,
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
    style: { fill: null, stroke: pathStroke },
  } as RenderNodeSnapshot;
}

function container(id: string, parentId: string | null, children: string[]): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: affine,
    visible: true,
    opacity: 1,
    kind: 'container',
    children,
    clip: null,
  };
}

function snapshot(nodes: readonly RenderNodeSnapshot[], revision = 1): RenderSceneSnapshot {
  return { identity, revision, nodes, rootOrder: nodes.map((node) => node.id) };
}

function reason(result: ReturnType<RetainedSceneMirror['replaceSnapshot']>): string {
  return result.status === 'invalid-scene' ? result.reason : result.status;
}

function replace(
  nodes: readonly RenderNodeSnapshot[],
  options: RetainedSceneMirrorOptions = DASHES,
): string {
  return reason(new RetainedSceneMirror(undefined, options).replaceSnapshot(snapshot(nodes)));
}

function withDash(dash: unknown): string {
  return replace([path('p', stroke(dash))]);
}

describe('E24-A01 scene dash validation', () => {
  it('E24-S1: absent, null and well-formed dashes are accepted', () => {
    expect(withDash(NO_KEY)).toBe('applied');
    expect(withDash(null)).toBe('applied');
    expect(withDash(DASH)).toBe('applied');
    expect(withDash({ pattern: [0, 20], phase: -10 })).toBe('applied');
    expect(withDash({ pattern: [24, 12, 6], phase: 2 ** 40 })).toBe('applied');
    expect(withDash({ pattern: Array(SCENE_MAX_DASH_ENTRIES).fill(1), phase: 0 })).toBe('applied');
  });

  it('E24-S1: each malformed dash field is invalid-value', () => {
    const cases: unknown[] = [
      0,
      [30, 20],
      { pattern: [], phase: 0 },
      { pattern: [-1, 2], phase: 0 },
      { pattern: [Number.NaN, 2], phase: 0 },
      { pattern: [Number.POSITIVE_INFINITY], phase: 0 },
      { pattern: [0, 0], phase: 0 },
      { pattern: [Number.MAX_VALUE, Number.MAX_VALUE], phase: 0 },
      // E24-S1 as amended by the U2 review: an odd pattern's doubled period must be finite.
      { pattern: [1.5e308], phase: 0 },
      { pattern: [30, '20'], phase: 0 },
      { pattern: [30, 20], phase: Number.NaN },
      { pattern: [30, 20], phase: Number.POSITIVE_INFINITY },
      { pattern: [30, 20] },
      { phase: 0 },
      { pattern: [30, 20], phase: 0, extra: 1 },
      { pattern: '30 20', phase: 0 },
    ];
    for (const dash of cases) expect(withDash(dash), JSON.stringify(dash)).toBe('invalid-value');
    // A sparse pattern array has a hole, not an entry.
    // eslint-disable-next-line no-sparse-arrays
    expect(withDash({ pattern: [30, , 20], phase: 0 })).toBe('invalid-value');
    expect(replace([path('p', { ...stroke(), extra: 1 })])).toBe('invalid-value');
    // A present key holding undefined is neither absent nor null.
    expect(replace([path('p', { ...stroke(), dash: undefined })])).toBe('invalid-value');
  });

  it('E24-S1: more than 16 entries is unsupported-feature, after every entry is validated', () => {
    const many = Array<number>(SCENE_MAX_DASH_ENTRIES + 1).fill(1);
    expect(withDash({ pattern: many, phase: 0 })).toBe('unsupported-feature');
    expect(withDash({ pattern: [...many.slice(1), -1], phase: 0 })).toBe('invalid-value');
    // The entry count is structural: width 0 does not exempt it, under either support.
    expect(replace([path('p', stroke({ pattern: many, phase: 0 }, 0))])).toBe(
      'unsupported-feature',
    );
    expect(replace([path('p', stroke({ pattern: many, phase: 0 }, 0))], SOLID)).toBe(
      'unsupported-feature',
    );
  });

  it('E24-S1: graph reasons precede the entry count and the support gate; values precede both', () => {
    const cycle = (dash: unknown, options: RetainedSceneMirrorOptions = DASHES) =>
      reason(
        new RetainedSceneMirror(undefined, options).replaceSnapshot({
          identity,
          revision: 1,
          nodes: [
            container('c1', 'c2', ['c2']),
            container('c2', 'c1', ['c1']),
            path('p', stroke(dash)),
          ],
          rootOrder: ['p'],
        }),
      );
    const many = { pattern: Array<number>(SCENE_MAX_DASH_ENTRIES + 1).fill(1), phase: 0 };
    expect(cycle(many)).toBe('cycle');
    expect(cycle(DASH, SOLID)).toBe('cycle');
    expect(cycle({ pattern: [], phase: 0 })).toBe('invalid-value');
    const orphan = path('p', stroke(many), 'missing');
    const result = new RetainedSceneMirror(undefined, DASHES).replaceSnapshot({
      identity,
      revision: 1,
      nodes: [orphan],
      rootOrder: [],
    });
    expect(reason(result)).toBe('invalid-parent');
  });

  it("E24-S3: a dash is unsupported-feature unless dashes is 'supported' (default)", () => {
    expect(replace([path('p', stroke())], SOLID)).toBe('unsupported-feature');
    expect(replace([path('p', stroke())], { ...SOLID, dashes: 'unsupported' })).toBe(
      'unsupported-feature',
    );
    expect(replace([path('p', stroke(null))], SOLID)).toBe('applied');
    expect(replace([path('p', stroke(NO_KEY))], SOLID)).toBe('applied');
    // A stroke of width 0 draws nothing, so its dash is validated but not gated.
    expect(replace([path('p', stroke(DASH, 0))], SOLID)).toBe('applied');
    expect(replace([path('p', stroke({ pattern: [], phase: 0 }, 0))], SOLID)).toBe('invalid-value');
  });

  it('E24-S3: a change set that adds a dash under unsupported dashes is rejected', () => {
    const mirror = new RetainedSceneMirror(undefined, SOLID);
    expect(mirror.replaceSnapshot(snapshot([path('p', stroke(null))])).status).toBe('applied');
    const changes: RenderChangeSet = {
      identity,
      baseRevision: 1,
      revision: 2,
      inserted: [],
      updated: [path('p', stroke())],
      removed: [],
      orders: [],
    };
    expect(reason(mirror.applyChanges(changes))).toBe('unsupported-feature');
  });

  it('E24-S2: the copy keeps the producer form, frozen', () => {
    const mirror = new RetainedSceneMirror(undefined, DASHES);
    const nodes = [path('absent', stroke(NO_KEY)), path('null', stroke(null)), path('d', stroke())];
    expect(mirror.replaceSnapshot(snapshot(nodes)).status).toBe('applied');
    const scene = mirror.readRetainedScene()!;
    const strokeOf = (id: string) =>
      (scene.getNode(id) as Extract<RenderNodeSnapshot, { kind: 'path' }>).style.stroke!;
    expect(Object.hasOwn(strokeOf('absent'), 'dash')).toBe(false);
    expect(strokeOf('null').dash).toBeNull();
    const dashed: PathStroke = strokeOf('d');
    expect(dashed.dash).toEqual(DASH);
    expect(dashed.dash).not.toBe(DASH);
    expect(Object.isFrozen(dashed.dash)).toBe(true);
    expect(Object.isFrozen(dashed.dash!.pattern)).toBe(true);
  });

  it('E24-S2: replay equality treats absent and null as equal and compares dashes by value', () => {
    const mirror = new RetainedSceneMirror(undefined, DASHES);
    expect(mirror.replaceSnapshot(snapshot([path('p', stroke(NO_KEY))])).status).toBe('applied');
    expect(mirror.replaceSnapshot(snapshot([path('p', stroke(null))])).status).toBe('replayed');

    const dashed = new RetainedSceneMirror(undefined, DASHES);
    expect(dashed.replaceSnapshot(snapshot([path('p', stroke())])).status).toBe('applied');
    const copy = structuredClone(DASH);
    expect(dashed.replaceSnapshot(snapshot([path('p', stroke(copy))])).status).toBe('replayed');
    for (const changed of [
      { pattern: [30, 21], phase: 0 },
      { pattern: [30, 20, 30, 20], phase: 0 },
      { pattern: [30, 20], phase: 1 },
      null,
    ]) {
      expect(reason(dashed.replaceSnapshot(snapshot([path('p', stroke(changed))])))).toBe(
        'revision-conflict',
      );
    }
  });
});
