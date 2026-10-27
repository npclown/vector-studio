import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneClip,
  SceneColor,
} from '@vector-studio/contracts';
import { SCENE_MAX_CLIP_DEPTH } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  RetainedSceneMirror,
  type RetainedSceneMirrorOptions,
} from '../../packages/renderer-core/src/scene-mirror.js';

// P4 contract (docs/plans/p4-clip-mask.md), P4-A01: P4-S1 to S3, the mask-source rules and the
// clip depth, through the retained scene mirror.

const identity = { documentId: 'p4-u1', pageId: 'page' } as const;
const affine = [1, 0, 0, 1, 0, 0] as const;
const CLIPS: RetainedSceneMirrorOptions = {
  pathNodes: 'supported',
  pathStrokes: 'supported',
  clips: 'supported',
};
const rect: SceneClip = { kind: 'rect', x: 0, y: 0, width: 10, height: 10 };
const mask: SceneClip = { kind: 'mask' };

function container(
  id: string,
  parentId: string | null,
  children: readonly string[],
  clip: SceneClip = null,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: affine,
    visible: true,
    opacity: 1,
    kind: 'container',
    clip,
    children,
  };
}

function box(id: string, parentId: string | null): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: affine,
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 4, height: 4, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
  };
}

function path(
  id: string,
  parentId: string | null,
  visible = true,
  fill: SceneColor | null = null,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: affine,
    visible,
    opacity: 1,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 8, 0, 0, 8],
      fillRule: 'nonzero',
    },
    style: { fill, stroke: null },
  };
}

function snapshot(nodes: readonly unknown[], revision = 1): RenderSceneSnapshot {
  return {
    identity,
    revision,
    nodes,
    rootOrder: (nodes as RenderNodeSnapshot[]).filter((n) => n.parentId === null).map((n) => n.id),
  } as RenderSceneSnapshot;
}

function reason(result: ReturnType<RetainedSceneMirror['replaceSnapshot']>): string {
  return result.status === 'invalid-scene' ? result.reason : result.status;
}

function replace(nodes: readonly unknown[], options: RetainedSceneMirrorOptions = CLIPS): string {
  return reason(new RetainedSceneMirror(undefined, options).replaceSnapshot(snapshot(nodes)));
}

function change(fields: Partial<RenderChangeSet>): RenderChangeSet {
  return {
    identity,
    baseRevision: 1,
    revision: 2,
    inserted: [],
    updated: [],
    removed: [],
    orders: [],
    ...fields,
  };
}

/** A chain of `depth` nested clip containers c1..c<depth> with a leaf under the innermost. */
function chain(depth: number, kind: 'rect' | 'alternate' = 'alternate'): RenderNodeSnapshot[] {
  const nodes: RenderNodeSnapshot[] = [];
  for (let level = 1; level <= depth; level += 1) {
    const isMask = kind === 'alternate' && level % 2 === 0;
    const children = isMask ? [`s${level}`, level === depth ? 'leaf' : `c${level + 1}`] : [];
    if (!isMask) children.push(level === depth ? 'leaf' : `c${level + 1}`);
    nodes.push(
      container(`c${level}`, level === 1 ? null : `c${level - 1}`, children, isMask ? mask : rect),
    );
    if (isMask) nodes.push(box(`s${level}`, `c${level}`));
  }
  nodes.push(box('leaf', depth === 0 ? null : `c${depth}`));
  return nodes;
}

describe('P4-A01 scene clip validation', () => {
  it('P4-S1, S3: a rect or mask clip is accepted where clips are supported', () => {
    expect(replace([container('g', null, ['a'], rect), box('a', 'g')])).toBe('applied');
    expect(replace([container('g', null, ['s', 'a'], mask), box('s', 'g'), box('a', 'g')])).toBe(
      'applied',
    );
    expect(
      replace([container('g', null, [], { kind: 'rect', x: -5, y: 2, width: 0, height: 0 })]),
    ).toBe('applied');
  });

  it('U1: a non-null clip is unsupported-feature until the renderer draws clips', () => {
    const options = { pathNodes: 'supported' } as const;
    expect(replace([container('g', null, [], rect)], options)).toBe('unsupported-feature');
    expect(replace([container('g', null, [], mask)], options)).toBe('unsupported-feature');
    expect(replace([container('g', null, [])], options)).toBe('applied');
  });

  it('P4-S3: a missing or malformed clip is invalid-value', () => {
    const base = container('g', null, []);
    const withoutClip = Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'clip'));
    const malformed: unknown[] = [
      undefined,
      {},
      { kind: 'circle' },
      { kind: 'mask', x: 0 },
      { kind: 'rect', x: 0, y: 0, width: 1 },
      { kind: 'rect', x: 0, y: 0, width: 1, height: 1, extra: 1 },
      { kind: 'rect', x: 0, y: 0, width: -1, height: 1 },
      { kind: 'rect', x: Number.NaN, y: 0, width: 1, height: 1 },
      { kind: 'rect', x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 },
      { kind: 'rect', x: 1e308, y: 0, width: 1e308, height: 1 },
      { kind: 'rect', x: '0', y: 0, width: 1, height: 1 },
    ];
    expect(replace([withoutClip])).toBe('invalid-value');
    for (const clip of malformed) {
      expect(replace([{ ...base, clip }]), JSON.stringify(clip)).toBe('invalid-value');
    }
  });

  it('P4-S2: an empty mask container is valid; a container source is unsupported-feature', () => {
    expect(replace([container('g', null, [], mask)])).toBe('applied');
    expect(
      replace([
        container('g', null, ['inner', 'a'], mask),
        container('inner', 'g', []),
        box('a', 'g'),
      ]),
    ).toBe('unsupported-feature');
    // A container later in the list is ordinary content.
    expect(
      replace([
        container('g', null, ['s', 'inner'], mask),
        box('s', 'g'),
        container('inner', 'g', []),
      ]),
    ).toBe('applied');
  });

  it('P4-S2: a fill-less or hidden path source needs a fill port, whatever its style', () => {
    const scene = [container('g', null, ['s', 'a'], mask), path('s', 'g', false), box('a', 'g')];
    expect(replace(scene)).toBe('applied');
    const noFills = {
      pathNodes: 'supported',
      pathFills: 'unsupported',
      clips: 'supported',
    } as const;
    expect(replace(scene, noFills)).toBe('unsupported-feature');
    // Each condition alone: a visible fill-less source and a hidden filled source.
    const red = { r: 1, g: 0, b: 0, a: 1 };
    for (const source of [path('s', 'g', true), path('s', 'g', false, red)]) {
      const nodes = [container('g', null, ['s', 'a'], mask), source, box('a', 'g')];
      expect(replace(nodes)).toBe('applied');
      expect(replace(nodes, noFills)).toBe('unsupported-feature');
    }
    // The same fill-less path is accepted as ordinary content without a fill port.
    expect(
      replace(
        [container('g', null, ['a', 's'], mask), box('a', 'g'), path('s', 'g', false)],
        noFills,
      ),
    ).toBe('applied');
  });

  it('P4-S2: removing, reordering or replacing the source is validated on the result', () => {
    const start = () => {
      const mirror = new RetainedSceneMirror(undefined, CLIPS);
      const result = mirror.replaceSnapshot(
        snapshot([
          container('g', null, ['s', 'a', 'inner'], mask),
          box('s', 'g'),
          box('a', 'g'),
          container('inner', 'g', []),
        ]),
      );
      expect(result.status).toBe('applied');
      return mirror;
    };
    // Removing the source makes 'a' the source: accepted.
    expect(
      reason(
        start().applyChanges(
          change({ removed: ['s'], orders: [{ parentId: 'g', children: ['a', 'inner'] }] }),
        ),
      ),
    ).toBe('applied');
    // Reordering so a container becomes the source: rejected.
    expect(
      reason(
        start().applyChanges(
          change({ orders: [{ parentId: 'g', children: ['inner', 's', 'a'] }] }),
        ),
      ),
    ).toBe('unsupported-feature');
    // Removing the two primitives leaves the container as source: rejected.
    expect(
      reason(
        start().applyChanges(
          change({ removed: ['s', 'a'], orders: [{ parentId: 'g', children: ['inner'] }] }),
        ),
      ),
    ).toBe('unsupported-feature');
    // Removing every child leaves an empty mask container: accepted.
    expect(
      reason(
        start().applyChanges(
          change({ removed: ['s', 'a', 'inner'], orders: [{ parentId: 'g', children: [] }] }),
        ),
      ),
    ).toBe('applied');
  });

  it('clip depth: 0, 1, 2 and 32 are accepted, 33 is rejected', () => {
    expect(SCENE_MAX_CLIP_DEPTH).toBe(32);
    for (const depth of [0, 1, 2, 32]) {
      expect(replace(chain(depth)), `depth ${depth}`).toBe('applied');
      expect(replace(chain(depth, 'rect')), `rect depth ${depth}`).toBe('applied');
    }
    expect(replace(chain(33))).toBe('unsupported-feature');
    expect(replace(chain(33, 'rect'))).toBe('unsupported-feature');
    // An empty 33rd clip container has depth 32 itself and no deeper node.
    const emptyInnermost = chain(32, 'rect').filter((node) => node.id !== 'leaf');
    const innermost = emptyInnermost[emptyInnermost.length - 1]!;
    emptyInnermost[emptyInnermost.length - 1] = {
      ...innermost,
      children: ['c33'],
    } as RenderNodeSnapshot;
    emptyInnermost.push(container('c33', 'c32', [], rect));
    expect(replace(emptyInnermost)).toBe('applied');
  });

  it('clip depth: unclipped containers do not count', () => {
    const nodes = chain(32, 'rect');
    const leaf = nodes.pop()!;
    nodes[nodes.length - 1] = {
      ...nodes[nodes.length - 1]!,
      children: ['plain'],
    } as RenderNodeSnapshot;
    nodes.push(container('plain', 'c32', ['leaf']), { ...leaf, parentId: 'plain' });
    expect(replace(nodes)).toBe('applied');
  });

  it('clip depth: a reparent-only change set that reaches 33 is rejected', () => {
    const mirror = new RetainedSceneMirror(undefined, CLIPS);
    const nodes = [...chain(32, 'rect'), container('extra', null, [], rect)];
    expect(reason(mirror.replaceSnapshot(snapshot(nodes)))).toBe('applied');
    const outer = nodes.find((node) => node.id === 'c1')!;
    const result = mirror.applyChanges(
      change({
        updated: [{ ...outer, parentId: 'extra' }],
        orders: [
          { parentId: null, children: ['extra'] },
          { parentId: 'extra', children: ['c1'] },
        ],
      }),
    );
    expect(reason(result)).toBe('unsupported-feature');
    expect(mirror.getSynchronizationState().current?.revision).toBe(1);
  });

  it('precedence: graph errors before the clip rules', () => {
    expect(replace([container('g', null, ['missing'], mask)])).toBe('unknown-node');
    expect(replace([...chain(33), container('x', 'nobody', [])])).toBe('invalid-parent');
    const deep = chain(33);
    const mirror = () => new RetainedSceneMirror(undefined, CLIPS);
    // invalid-order: the leaf is listed under c33 but also at the root.
    expect(reason(mirror().replaceSnapshot({ ...snapshot(deep), rootOrder: ['c1', 'leaf'] }))).toBe(
      'invalid-order',
    );
    // cycle: c1's parent is c33.
    const cyclic = deep.map((node) =>
      node.id === 'c1' ? ({ ...node, parentId: 'c33' } as RenderNodeSnapshot) : node,
    );
    expect(reason(mirror().replaceSnapshot({ ...snapshot(cyclic), rootOrder: [] }))).toBe('cycle');
  });

  it('U1: a change set cannot bring a non-null clip in while clips are unsupported', () => {
    const start = () => {
      const mirror = new RetainedSceneMirror(undefined, { pathNodes: 'supported' });
      expect(reason(mirror.replaceSnapshot(snapshot([container('g', null, [])])))).toBe('applied');
      return mirror;
    };
    const inserted = start();
    expect(
      reason(
        inserted.applyChanges(
          change({
            inserted: [container('h', null, [], rect)],
            orders: [{ parentId: null, children: ['g', 'h'] }],
          }),
        ),
      ),
    ).toBe('unsupported-feature');
    expect(inserted.getSynchronizationState().current?.revision).toBe(1);
    for (const clip of [rect, mask]) {
      const updated = start();
      expect(
        reason(updated.applyChanges(change({ updated: [container('g', null, [], clip)] }))),
      ).toBe('unsupported-feature');
      expect(updated.getSynchronizationState().current?.revision).toBe(1);
    }
  });

  it('P4-S2: change sets use the mirror fill support for a path source', () => {
    const nodes = [container('g', null, ['a', 's'], mask), box('a', 'g'), path('s', 'g')];
    const reorder = change({ orders: [{ parentId: 'g', children: ['s', 'a'] }] });
    const noFills = new RetainedSceneMirror(undefined, {
      pathNodes: 'supported',
      pathFills: 'unsupported',
      clips: 'supported',
    });
    expect(reason(noFills.replaceSnapshot(snapshot(nodes)))).toBe('applied');
    expect(reason(noFills.applyChanges(reorder))).toBe('unsupported-feature');
    const fills = new RetainedSceneMirror(undefined, CLIPS);
    expect(reason(fills.replaceSnapshot(snapshot(nodes)))).toBe('applied');
    expect(reason(fills.applyChanges(reorder))).toBe('applied');
  });

  it('replay: the same revision with a different clip is a revision conflict', () => {
    const mirror = new RetainedSceneMirror(undefined, CLIPS);
    expect(reason(mirror.replaceSnapshot(snapshot([container('g', null, [], rect)])))).toBe(
      'applied',
    );
    expect(reason(mirror.replaceSnapshot(snapshot([container('g', null, [], rect)])))).toBe(
      'replayed',
    );
    for (const clip of [null, mask, { ...rect, width: 11 }] as SceneClip[]) {
      expect(
        reason(mirror.replaceSnapshot(snapshot([container('g', null, [], clip)]))),
        JSON.stringify(clip),
      ).toBe('revision-conflict');
    }
  });
});
