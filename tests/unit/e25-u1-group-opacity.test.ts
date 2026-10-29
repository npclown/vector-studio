import type { RenderNodeSnapshot, RenderSceneSnapshot } from '@vector-studio/contracts';
import { DIAGNOSTIC_CODES, SCENE_MAX_ISOLATION_DEPTH } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  RetainedSceneMirror,
  type RetainedSceneMirrorOptions,
} from '../../packages/renderer-core/src/scene-mirror.js';

// E25 contract (docs/plans/d9-e25-isolated-opacity-contract.md), E25-A01 (validation half) through the retained
// scene mirror: the E25-S1 gate on non-unit container opacity and the E25-S2 isolation depth,
// including change sets that only reparent or only change an opacity. The service option
// `groups` and its `clips` check land with the layer passes (U3; contract section 7, U1 record).

const identity = { documentId: 'e25-u1', pageId: 'page' } as const;
const affine = [1, 0, 0, 1, 0, 0] as const;
const ISOLATED: RetainedSceneMirrorOptions = {
  pathNodes: 'unsupported',
  groupOpacity: 'supported',
};
const FLAT: RetainedSceneMirrorOptions = { pathNodes: 'unsupported' };

function container(
  id: string,
  parentId: string | null,
  children: string[],
  opacity = 1,
  visible = true,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: affine,
    visible,
    opacity,
    kind: 'container',
    children,
    clip: null,
  };
}

function rect(id: string, parentId: string | null): RenderNodeSnapshot {
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

function snapshot(nodes: readonly RenderNodeSnapshot[], revision = 1): RenderSceneSnapshot {
  const rootOrder = nodes.filter((node) => node.parentId === null).map((node) => node.id);
  return { identity, revision, nodes, rootOrder };
}

function status(result: ReturnType<RetainedSceneMirror['replaceSnapshot']>): string {
  return result.status === 'invalid-scene' ? result.reason : result.status;
}

function replace(nodes: readonly RenderNodeSnapshot[], options = ISOLATED): string {
  return status(new RetainedSceneMirror(undefined, options).replaceSnapshot(snapshot(nodes)));
}

/** A chain of `levels` nested containers with the given opacity, the leaf `leaf` inside. */
function chain(
  levels: number,
  opacity: number | ((level: number) => number),
): RenderNodeSnapshot[] {
  const nodes: RenderNodeSnapshot[] = [];
  for (let level = 0; level < levels; level += 1) {
    const value = typeof opacity === 'number' ? opacity : opacity(level);
    const child = level + 1 < levels ? `g${level + 1}` : 'leaf';
    nodes.push(container(`g${level}`, level === 0 ? null : `g${level - 1}`, [child], value));
  }
  nodes.push(rect('leaf', `g${levels - 1}`));
  return nodes;
}

describe('E25-S1 gate', () => {
  it('rejects non-unit container opacity without the option, as before E25', () => {
    expect(replace([container('g', null, [], 0.5)], FLAT)).toBe('unsupported-feature');
    expect(replace([container('g', null, [], 0)], FLAT)).toBe('unsupported-feature');
    expect(replace([container('g', null, [], 1)], FLAT)).toBe('applied');
  });

  it('accepts container opacity 0, 0.5 and 1 with the option', () => {
    for (const opacity of [0, 0.5, 1]) {
      expect(replace([container('g', null, ['r'], opacity), rect('r', 'g')])).toBe('applied');
    }
  });

  it('keeps out-of-range opacity an input-value error', () => {
    expect(replace([container('g', null, [], 1.5)])).toBe('invalid-value');
    expect(replace([container('g', null, [], -0.1)], FLAT)).toBe('invalid-value');
  });

  it('applies the gate to change sets', () => {
    const mirror = new RetainedSceneMirror(undefined, FLAT);
    expect(status(mirror.replaceSnapshot(snapshot([container('g', null, [])])))).toBe('applied');
    const result = mirror.applyChanges({
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [],
      updated: [container('g', null, [], 0.25)],
      removed: [],
      orders: [],
    });
    expect(status(result)).toBe('unsupported-feature');
    const isolated = new RetainedSceneMirror(undefined, ISOLATED);
    expect(status(isolated.replaceSnapshot(snapshot([container('g', null, [])])))).toBe('applied');
    const accepted = isolated.applyChanges({
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [],
      updated: [container('g', null, [], 0.25)],
      removed: [],
      orders: [],
    });
    expect(status(accepted)).toBe('applied');
  });

  it('reserves the render.layer-resource-limit code', () => {
    expect(DIAGNOSTIC_CODES.LAYER_RESOURCE_LIMIT).toBe('render.layer-resource-limit');
  });
});

describe('E25-S2 isolation depth', () => {
  it('accepts depth 32 and rejects 33', () => {
    expect(SCENE_MAX_ISOLATION_DEPTH).toBe(32);
    expect(replace(chain(32, 0.5))).toBe('applied');
    expect(replace(chain(33, 0.5))).toBe('unsupported-feature');
  });

  it('does not count hidden containers or containers with opacity 0 or 1', () => {
    expect(replace(chain(40, 1))).toBe('applied');
    expect(replace(chain(40, (level) => (level % 2 === 0 ? 0.5 : 1)))).toBe('applied');
    expect(replace(chain(40, (level) => (level < 32 ? 0.5 : 0)))).toBe('applied');
    const hidden = chain(33, 0.5).map((node) =>
      node.id === 'g10' ? { ...node, visible: false } : node,
    );
    expect(replace(hidden)).toBe('applied');
  });

  it('counts only proper ancestors: a 33rd isolated container with no children is accepted', () => {
    const nodes = chain(32, 0.5).filter((node) => node.id !== 'leaf');
    const last = nodes[nodes.length - 1]!;
    nodes[nodes.length - 1] = { ...last, children: ['g32'] } as RenderNodeSnapshot;
    nodes.push(container('g32', 'g31', [], 0.5));
    expect(replace(nodes)).toBe('applied');
  });

  it('is checked on a change set that only changes an opacity', () => {
    const mirror = new RetainedSceneMirror(undefined, ISOLATED);
    const nodes = chain(33, (level) => (level === 0 ? 1 : 0.5));
    expect(status(mirror.replaceSnapshot(snapshot(nodes)))).toBe('applied');
    const result = mirror.applyChanges({
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [],
      updated: [container('g0', null, ['g1'], 0.5)],
      removed: [],
      orders: [],
    });
    expect(status(result)).toBe('unsupported-feature');
  });

  it('is checked on a change set that only reparents', () => {
    const mirror = new RetainedSceneMirror(undefined, ISOLATED);
    const deep = chain(32, 0.5);
    const outer = container('outer', null, ['g0x'], 0.5);
    const nodes = [...deep, outer, container('g0x', 'outer', [], 1)];
    expect(status(mirror.replaceSnapshot(snapshot(nodes)))).toBe('applied');
    // Moving the depth-32 chain under the isolated `outer` makes the leaf's depth 33.
    const result = mirror.applyChanges({
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [],
      updated: [
        container('g0', 'outer', ['g1'], 0.5),
        container('outer', null, ['g0x', 'g0'], 0.5),
      ],
      removed: [],
      orders: [{ parentId: null, children: ['outer'] }],
    });
    expect(status(result)).toBe('unsupported-feature');
    // Control: the same reparent under an opaque `outer` stays at depth 32.
    const control = new RetainedSceneMirror(undefined, ISOLATED);
    const opaque = [
      ...deep,
      container('outer', null, ['g0x'], 1),
      container('g0x', 'outer', [], 1),
    ];
    expect(status(control.replaceSnapshot(snapshot(opaque)))).toBe('applied');
    const moved = control.applyChanges({
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [],
      updated: [container('g0', 'outer', ['g1'], 0.5), container('outer', null, ['g0x', 'g0'], 1)],
      removed: [],
      orders: [{ parentId: null, children: ['outer'] }],
    });
    expect(status(moved)).toBe('applied');
  });
});
