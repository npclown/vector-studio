import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
} from '@vector-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

const identity = { documentId: 'transaction-corpus', pageId: 'page' } as const;
const affine = [1, 0, 0, 1, 0, 0] as const;

function container(id: string, children: readonly string[]): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: affine,
    visible: true,
    opacity: 1,
    kind: 'container',
    children,
  };
}

function leaf(id: string, parentId: string, x: number): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, 0],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
  };
}

function change(baseRevision: number, fields: Partial<RenderChangeSet>): RenderChangeSet {
  return {
    identity,
    baseRevision,
    revision: baseRevision + 3,
    inserted: [],
    updated: [],
    removed: [],
    orders: [],
    ...fields,
  };
}

describe('retained scene independent transaction corpus', () => {
  it('matches a literal final snapshot after inserts, reparents, reorders and removals', () => {
    const invalidation = vi.fn();
    const mirror = new RetainedSceneMirror(invalidation);
    const initial: RenderSceneSnapshot = {
      identity,
      revision: 0,
      nodes: [container('left', []), container('right', [])],
      rootOrder: ['left', 'right'],
    };
    expect(mirror.replaceSnapshot(initial).status).toBe('applied');

    // Opaque IDs must not become prototype keys or get normalized by the mirror.
    const ids = ['__proto__', 'constructor', 'toString', 'é', 'a\u0000b'];
    let revision = 0;
    for (let index = 0; index < ids.length; index++) {
      const delta = change(revision, {
        inserted: [leaf(ids[index]!, 'left', index + 0.25)],
        orders: [{ parentId: 'left', children: ids.slice(0, index + 1) }],
      });
      expect(mirror.applyChanges(delta).status).toBe('applied');
      revision = delta.revision;
    }

    const reparent = change(revision, {
      updated: [leaf('constructor', 'right', 1.25), leaf('é', 'right', 3.25)],
      orders: [
        { parentId: 'left', children: ['a\u0000b', 'toString', '__proto__'] },
        { parentId: 'right', children: ['é', 'constructor'] },
        { parentId: null, children: ['right', 'left'] },
      ],
    });
    expect(mirror.applyChanges(reparent).status).toBe('applied');
    revision = reparent.revision;
    const removal = change(revision, {
      removed: ['toString'],
      orders: [{ parentId: 'left', children: ['a\u0000b', '__proto__'] }],
    });
    expect(mirror.applyChanges(removal).status).toBe('applied');
    revision = removal.revision;

    const expected: RenderSceneSnapshot = {
      identity,
      revision,
      rootOrder: ['right', 'left'],
      nodes: [
        leaf('é', 'right', 3.25),
        container('right', ['é', 'constructor']),
        leaf('__proto__', 'left', 0.25),
        leaf('constructor', 'right', 1.25),
        container('left', ['a\u0000b', '__proto__']),
        leaf('a\u0000b', 'left', 4.25),
      ],
    };
    const pending = mirror.getPendingChangeState();
    const calls = invalidation.mock.calls.length;
    const retained = mirror.readRetainedScene();
    expect(retained?.version).toEqual({ identity, revision });
    expect(retained?.rootOrder).toEqual(expected.rootOrder);
    expect(retained?.nodes).toEqual(
      [...expected.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
    for (const node of expected.nodes) expect(retained?.getNode(node.id)).toEqual(node);
    // Same-revision replay is a public semantic equality check against this independently
    // authored final graph, including child order and every untouched payload field.
    expect(mirror.replaceSnapshot(expected).status).toBe('replayed');
    expect(mirror.getPendingChangeState()).toEqual(pending);
    expect(invalidation).toHaveBeenCalledTimes(calls);
    expect(mirror.getSynchronizationState()).toEqual({
      status: 'synchronized',
      current: { identity, revision },
    });
  });

  it('never publishes any portion of a malformed multi-operation transaction', () => {
    const invalidation = vi.fn();
    const mirror = new RetainedSceneMirror(invalidation);
    const initial: RenderSceneSnapshot = {
      identity,
      revision: 7,
      nodes: [container('left', ['a']), leaf('a', 'left', 0)],
      rootOrder: ['left'],
    };
    expect(mirror.replaceSnapshot(initial).status).toBe('applied');
    const pending = mirror.getPendingChangeState();
    const retained = mirror.readRetainedScene();
    const bad = change(7, {
      inserted: [leaf('b', 'left', 100)],
      updated: [leaf('a', 'left', 99)],
      orders: [{ parentId: 'left', children: ['b'] }],
    });
    expect(mirror.applyChanges(bad)).toMatchObject({
      status: 'invalid-scene',
      reason: 'invalid-order',
    });
    expect(mirror.getPendingChangeState()).toEqual(pending);
    expect(mirror.readRetainedScene()?.nodes).toBe(retained?.nodes);
    expect(mirror.readRetainedScene()?.getNode('b')).toBeUndefined();
    expect(invalidation).toHaveBeenCalledTimes(1);
    expect(mirror.replaceSnapshot(initial).status).toBe('replayed');
    expect(mirror.applyChanges(change(7, { updated: [leaf('a', 'left', 0.5)] })).status).toBe(
      'applied',
    );
    expect(retained?.getNode('a')?.transform[4]).toBe(0);
    expect(mirror.readRetainedScene()?.getNode('a')?.transform[4]).toBe(0.5);
  });
});
