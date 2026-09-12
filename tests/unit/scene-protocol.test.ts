import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneRejectionReason,
} from '@vector-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  RetainedSceneMirror,
  transitionCameraState,
} from '../../packages/renderer-core/src/scene-mirror.js';

const identity = { documentId: 'fixture-doc', pageId: 'fixture-page' } as const;
const transform = [1, 0, 0, 1, 0, 0] as const;

function container(
  id: string,
  children: readonly string[],
  parentId: string | null = null,
): RenderNodeSnapshot {
  return { id, parentId, transform, visible: true, opacity: 1, kind: 'container', children };
}

function rectangle(
  id: string,
  parentId: string | null,
  overrides: Partial<RenderNodeSnapshot> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform,
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
    ...overrides,
  } as RenderNodeSnapshot;
}

function ellipse(id: string, parentId: string | null): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform,
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'ellipse', width: 10, height: 10 },
    style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
  };
}

function baseSnapshot(revision = 0): RenderSceneSnapshot {
  return {
    identity,
    revision,
    nodes: [container('g', ['a', 'b']), rectangle('a', 'g'), ellipse('b', 'g')],
    rootOrder: ['g'],
  };
}

function changes(baseRevision: number, overrides: Partial<RenderChangeSet> = {}): RenderChangeSet {
  return {
    identity,
    baseRevision,
    revision: baseRevision + 1,
    inserted: [],
    updated: [],
    removed: [],
    orders: [],
    ...overrides,
  };
}

function reason(result: ReturnType<RetainedSceneMirror['replaceSnapshot']>): SceneRejectionReason {
  expect(result.status).toBe('invalid-scene');
  if (result.status !== 'invalid-scene') throw new Error('Expected invalid scene.');
  return result.reason;
}

describe('retained scene protocol S01-S09', () => {
  it('S01 detaches caller data and logically replays reordered node enumeration', () => {
    const invalidate = vi.fn();
    const mirror = new RetainedSceneMirror(invalidate);
    const input = structuredClone(baseSnapshot()) as unknown as {
      nodes: Array<RenderNodeSnapshot>;
      rootOrder: string[];
    } & RenderSceneSnapshot;
    expect(mirror.replaceSnapshot(input).status).toBe('applied');
    const originalView = mirror.readRetainedScene()!;
    (input.rootOrder as string[])[0] = 'a';
    (input.nodes[1]!.transform as unknown as number[])[4] = 99;
    const style = (input.nodes[1] as Extract<RenderNodeSnapshot, { kind: 'primitive' }>).style;
    (style.fill as { r: number }).r = 0;
    expect(originalView.getNode('a')).toEqual(rectangle('a', 'g'));
    expect(originalView.rootOrder).toEqual(['g']);
    expect(() => {
      (originalView.getNode('a')!.transform as unknown as number[])[0] = 9;
    }).toThrow(TypeError);

    const ordered = baseSnapshot();
    const replay: RenderSceneSnapshot = {
      ...ordered,
      nodes: [ordered.nodes[2]!, ordered.nodes[0]!, ordered.nodes[1]!],
    };
    const pending = mirror.getPendingChangeState();
    expect(mirror.replaceSnapshot(replay).status).toBe('replayed');
    expect(mirror.getPendingChangeState()).toEqual(pending);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(mirror.getSynchronizationState())).toBe(true);
  });

  it('S02 enforces snapshot revision domains and atomic replacement', () => {
    const mirror = new RetainedSceneMirror();
    expect(mirror.replaceSnapshot(baseSnapshot(5)).status).toBe('applied');
    expect(reason(mirror.replaceSnapshot(baseSnapshot(4)))).toBe('stale-snapshot');
    const changed: RenderSceneSnapshot = {
      ...baseSnapshot(5),
      nodes: [container('g', ['a', 'b']), rectangle('a', 'g', { opacity: 0.5 }), ellipse('b', 'g')],
    };
    expect(reason(mirror.replaceSnapshot(changed))).toBe('revision-conflict');
    expect(mirror.replaceSnapshot(baseSnapshot(9)).status).toBe('applied');
    expect(
      mirror.replaceSnapshot({
        ...baseSnapshot(0),
        identity: { documentId: 'other', pageId: 'page' },
      }).status,
    ).toBe('applied');
  });

  it('S03 requires a valid snapshot to initialize and leave resync', () => {
    const mirror = new RetainedSceneMirror();
    expect(mirror.applyChanges({} as RenderChangeSet).status).toBe('resync-required');
    expect(mirror.replaceSnapshot(baseSnapshot()).status).toBe('applied');
    expect(
      mirror.applyChanges({
        ...changes(0),
        identity: { documentId: 'wrong', pageId: 'fixture-page' },
      }).status,
    ).toBe('resync-required');
    expect(mirror.applyChanges(changes(0)).status).toBe('resync-required');
    expect(reason(mirror.replaceSnapshot({ ...baseSnapshot(), revision: 0.5 }))).toBe(
      'invalid-value',
    );
    expect(mirror.getSynchronizationState().status).toBe('resync-required');
    expect(mirror.replaceSnapshot(baseSnapshot()).status).toBe('replayed');
    expect(mirror.getSynchronizationState().status).toBe('synchronized');
  });

  it('S04 rejects duplicate and conflicting operations without invalidation', () => {
    const invalidate = vi.fn();
    const mirror = new RetainedSceneMirror(invalidate);
    mirror.replaceSnapshot(baseSnapshot());
    const pending = mirror.getPendingChangeState();
    expect(
      reason(
        mirror.replaceSnapshot({
          ...baseSnapshot(1),
          nodes: [rectangle('a', null), rectangle('a', null)],
        }),
      ),
    ).toBe('duplicate-id');
    expect(
      reason(mirror.applyChanges(changes(0, { inserted: [rectangle('x', null)], removed: ['x'] }))),
    ).toBe('conflicting-operation');
    expect(
      reason(
        mirror.applyChanges(
          changes(0, {
            orders: [
              { parentId: null, children: ['g'] },
              { parentId: null, children: ['g'] },
            ],
          }),
        ),
      ),
    ).toBe('conflicting-operation');
    expect(
      reason(
        mirror.applyChanges(
          changes(0, {
            updated: [container('g', ['a', 'b'])],
            orders: [{ parentId: 'g', children: ['a', 'b'] }],
          }),
        ),
      ),
    ).toBe('conflicting-operation');
    expect(mirror.getPendingChangeState()).toEqual(pending);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('S05 applies unknown, parent, cycle, and order precedence', () => {
    const evaluate = (delta: RenderChangeSet) => {
      const mirror = new RetainedSceneMirror();
      mirror.replaceSnapshot(baseSnapshot());
      return reason(mirror.applyChanges(delta));
    };
    expect(evaluate(changes(0, { updated: [rectangle('missing', null)] }))).toBe('unknown-node');
    expect(evaluate(changes(0, { orders: [{ parentId: 'missing', children: [] }] }))).toBe(
      'unknown-node',
    );
    expect(evaluate(changes(0, { orders: [{ parentId: 'a', children: [] }] }))).toBe(
      'invalid-parent',
    );
    expect(
      reason(
        new RetainedSceneMirror().replaceSnapshot({
          identity,
          revision: 0,
          nodes: [rectangle('x', 'missing')],
          rootOrder: [],
        }),
      ),
    ).toBe('invalid-parent');
    const cycle = {
      identity,
      revision: 0,
      nodes: [container('g', ['h'], 'h'), container('h', ['g'], 'g')],
      rootOrder: [],
    } satisfies RenderSceneSnapshot;
    expect(reason(new RetainedSceneMirror().replaceSnapshot(cycle))).toBe('cycle');
    expect(
      reason(new RetainedSceneMirror().replaceSnapshot({ ...baseSnapshot(), rootOrder: ['a'] })),
    ).toBe('invalid-order');

    const unknownBeforeParent = {
      identity,
      revision: 0,
      nodes: [container('a', ['unknown']), rectangle('z', 'missing')],
      rootOrder: ['a'],
    } satisfies RenderSceneSnapshot;
    expect(reason(new RetainedSceneMirror().replaceSnapshot(unknownBeforeParent))).toBe(
      'unknown-node',
    );
    expect(
      evaluate(
        changes(0, {
          updated: [container('g', ['a', 'b', 'unknown'])],
          orders: [{ parentId: 'a', children: [] }],
        }),
      ),
    ).toBe('unknown-node');
  });

  it('S06 requires explicit reparenting and accepts valid final graphs', () => {
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot(baseSnapshot());
    expect(
      reason(
        mirror.applyChanges(
          changes(0, { removed: ['g'], orders: [{ parentId: null, children: [] }] }),
        ),
      ),
    ).toBe('invalid-parent');
    expect(
      mirror.applyChanges(
        changes(0, {
          removed: ['g'],
          updated: [rectangle('a', null), ellipse('b', null)],
          orders: [{ parentId: null, children: ['a', 'b'] }],
        }),
      ),
    ).toMatchObject({ status: 'applied' });

    const second = new RetainedSceneMirror();
    second.replaceSnapshot(baseSnapshot());
    expect(
      second.applyChanges(
        changes(0, {
          inserted: [container('h', ['a'])],
          updated: [container('g', ['b']), rectangle('a', 'h')],
          orders: [{ parentId: null, children: ['g', 'h'] }],
        }),
      ),
    ).toMatchObject({ status: 'applied' });
  });

  it('S07 rejects exact-shape, numeric, sparse-array, and arithmetic failures atomically', () => {
    const invalidInputs: unknown[] = [
      { ...baseSnapshot(), revision: 0.5 },
      { ...baseSnapshot(), revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...baseSnapshot(), extra: true },
      { ...baseSnapshot(), identity: { documentId: '', pageId: 'fixture-page' } },
      { ...baseSnapshot(), nodes: [rectangle('a', null, { opacity: NaN })], rootOrder: ['a'] },
      { ...baseSnapshot(), nodes: [rectangle('a', null, { opacity: 2 })], rootOrder: ['a'] },
      {
        ...baseSnapshot(),
        nodes: [rectangle('a', null, { transform: [1, 0, 0, 1, Infinity, 0] })],
        rootOrder: ['a'],
      },
      {
        ...baseSnapshot(),
        nodes: [
          rectangle('a', null, {
            geometry: { kind: 'rectangle', width: -1, height: 1, cornerRadii: [0, 0, 0, 0] },
          }),
        ],
        rootOrder: ['a'],
      },
      {
        ...baseSnapshot(),
        nodes: [
          rectangle('a', null, {
            geometry: { kind: 'rectangle', width: 1, height: 1, cornerRadii: [-1, 0, 0, 0] },
          }),
        ],
        rootOrder: ['a'],
      },
      {
        ...baseSnapshot(),
        nodes: [
          rectangle('a', null, {
            style: { fill: null, stroke: { color: { r: 1, g: 1, b: 1, a: 1 }, width: -1 } },
          }),
        ],
        rootOrder: ['a'],
      },
      {
        ...baseSnapshot(),
        nodes: [
          rectangle('a', null, { style: { fill: { r: 2, g: 0, b: 0, a: 1 }, stroke: null } }),
        ],
        rootOrder: ['a'],
      },
      {
        ...baseSnapshot(),
        nodes: [rectangle('a', null, { geometry: { kind: 'ellipse', width: 1 } as never })],
        rootOrder: ['a'],
      },
      {
        ...baseSnapshot(),
        nodes: [
          rectangle('a', null, { style: { fill: null, stroke: null, extra: true } as never }),
        ],
        rootOrder: ['a'],
      },
      {
        ...baseSnapshot(),
        nodes: [
          rectangle('a', null, {
            geometry: {
              kind: 'rectangle',
              width: Number.MAX_VALUE,
              height: 1,
              cornerRadii: [0, 0, 0, 0],
            },
            style: {
              fill: null,
              stroke: { color: { r: 1, g: 1, b: 1, a: 1 }, width: Number.MAX_VALUE },
            },
          }),
        ],
        rootOrder: ['a'],
      },
      {
        ...baseSnapshot(),
        nodes: [
          container('g', ['a']),
          rectangle('a', 'g', {
            transform: [Number.MAX_VALUE, 0, 0, 1, 0, 0],
            geometry: { kind: 'rectangle', width: 2, height: 1, cornerRadii: [0, 0, 0, 0] },
          }),
        ],
        rootOrder: ['g'],
      },
    ];
    const sparse: unknown[] = [];
    sparse.length = 1;
    invalidInputs.push({ ...baseSnapshot(), nodes: sparse });
    const tuple = [1, 0, 0, 1, 0, 0] as number[] & { extra?: boolean };
    tuple.extra = true;
    invalidInputs.push({
      ...baseSnapshot(),
      nodes: [rectangle('a', null, { transform: tuple as never })],
      rootOrder: ['a'],
    });

    for (const input of invalidInputs) {
      const mirror = new RetainedSceneMirror();
      expect(reason(mirror.replaceSnapshot(input as RenderSceneSnapshot))).toBe('invalid-value');
      expect(mirror.readRetainedScene()).toBeNull();
    }

    const invalidate = vi.fn();
    const initialized = new RetainedSceneMirror(invalidate);
    initialized.replaceSnapshot(baseSnapshot());
    const view = initialized.readRetainedScene();
    const pending = initialized.getPendingChangeState();
    expect(
      reason(
        initialized.applyChanges(
          changes(0, {
            updated: [rectangle('a', 'g', { opacity: Infinity })],
          }),
        ),
      ),
    ).toBe('invalid-value');
    expect(initialized.readRetainedScene()!.nodes).toBe(view!.nodes);
    expect(view!.getNode('a')).toEqual(rectangle('a', 'g'));
    expect(initialized.getPendingChangeState()).toEqual(pending);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('S07 validates a hierarchy deeper than the JavaScript call stack iteratively', () => {
    const depth = 12_000;
    const nodes: RenderNodeSnapshot[] = [];
    for (let index = 0; index < depth; index += 1) {
      const id = `n${String(index).padStart(5, '0')}`;
      const child = index + 1 < depth ? `n${String(index + 1).padStart(5, '0')}` : 'leaf';
      nodes.push(
        container(id, [child], index === 0 ? null : `n${String(index - 1).padStart(5, '0')}`),
      );
    }
    nodes.push(rectangle('leaf', `n${String(depth - 1).padStart(5, '0')}`));
    const mirror = new RetainedSceneMirror();
    expect(
      mirror.replaceSnapshot({ identity, revision: 0, nodes, rootOrder: ['n00000'] }).status,
    ).toBe('applied');
  });

  it('S08 distinguishes unsupported visual behavior from unknown discriminants', () => {
    const line = rectangle('a', null, {
      geometry: { kind: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
      style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
    });
    expect(
      reason(
        new RetainedSceneMirror().replaceSnapshot({
          identity,
          revision: 0,
          nodes: [line],
          rootOrder: ['a'],
        }),
      ),
    ).toBe('unsupported-feature');
    expect(
      reason(
        new RetainedSceneMirror().replaceSnapshot({
          identity,
          revision: 0,
          nodes: [{ ...container('g', []), opacity: 0.5 }],
          rootOrder: ['g'],
        }),
      ),
    ).toBe('unsupported-feature');
    expect(
      reason(
        new RetainedSceneMirror().replaceSnapshot({
          ...baseSnapshot(),
          nodes: [{ ...rectangle('a', null), kind: 'mystery' } as never],
          rootOrder: ['a'],
        }),
      ),
    ).toBe('invalid-value');
  });

  it('S09 keeps camera independent, handles overflow, and disposes terminally', () => {
    const invalidate = vi.fn();
    const mirror = new RetainedSceneMirror(invalidate);
    expect(mirror.getCameraState()).toEqual({
      camera: { position: { x: 0, y: 0 }, zoom: 1 },
      revision: 0,
    });
    expect(mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 }).status).toBe('unchanged');
    expect(mirror.setCamera({ position: { x: 2, y: -3 }, zoom: 4 }).status).toBe('applied');
    expect(mirror.getSynchronizationState().current).toBeNull();
    const beforeInvalid = mirror.getPendingChangeState();
    expect(mirror.setCamera({ position: { x: Infinity, y: 0 }, zoom: 1 })).toEqual({
      status: 'invalid-camera',
      reason: 'invalid-value',
    });
    expect(mirror.getPendingChangeState()).toEqual(beforeInvalid);
    expect(
      transitionCameraState(
        { camera: { position: { x: 0, y: 0 }, zoom: 1 }, revision: Number.MAX_SAFE_INTEGER },
        { position: { x: 1, y: 0 }, zoom: 1 },
      ),
    ).toEqual({ status: 'invalid-camera', reason: 'revision-overflow' });
    mirror.replaceSnapshot(baseSnapshot());
    expect(mirror.getCameraState()?.camera.position).toEqual({ x: 2, y: -3 });
    mirror.replaceSnapshot({
      ...baseSnapshot(),
      identity: { documentId: 'other-document', pageId: 'other-page' },
    });
    expect(mirror.getCameraState()).toEqual({
      camera: { position: { x: 2, y: -3 }, zoom: 4 },
      revision: 1,
    });
    mirror.dispose();
    mirror.dispose();
    expect(mirror.getSynchronizationState()).toEqual({ status: 'disposed', current: null });
    expect(mirror.getCameraState()).toBeNull();
    expect(mirror.readRetainedScene()).toBeNull();
    expect(mirror.replaceSnapshot(baseSnapshot()).status).toBe('disposed');
    expect(mirror.applyChanges(changes(0)).status).toBe('disposed');
    expect(mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 }).status).toBe('disposed');
  });

  it('uses category precedence for paired failures and preserves publication', () => {
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot(baseSnapshot());
    expect(reason(mirror.applyChanges({ ...changes(99), revision: NaN }))).toBe('invalid-value');
    expect(
      reason(
        mirror.applyChanges(
          changes(0, {
            inserted: [rectangle('x', null)],
            removed: ['x'],
            updated: [rectangle('unknown', null)],
          }),
        ),
      ),
    ).toBe('conflicting-operation');

    const parentAndCycle = {
      identity,
      revision: 1,
      nodes: [container('g', ['h'], 'h'), container('h', ['g'], 'g'), rectangle('z', 'missing')],
      rootOrder: [],
    } satisfies RenderSceneSnapshot;
    expect(reason(new RetainedSceneMirror().replaceSnapshot(parentAndCycle))).toBe(
      'invalid-parent',
    );
    const cycleAndOrder = {
      ...parentAndCycle,
      nodes: parentAndCycle.nodes.slice(0, 2),
      rootOrder: ['g'],
    };
    expect(reason(new RetainedSceneMirror().replaceSnapshot(cycleAndOrder))).toBe('cycle');
    const overflowAndOrder = {
      identity,
      revision: 0,
      nodes: [
        rectangle('a', null, {
          transform: [Number.MAX_VALUE, 0, 0, 1, 0, 0],
          geometry: { kind: 'rectangle', width: 2, height: 1, cornerRadii: [0, 0, 0, 0] },
        }),
      ],
      rootOrder: [],
    } satisfies RenderSceneSnapshot;
    expect(reason(new RetainedSceneMirror().replaceSnapshot(overflowAndOrder))).toBe(
      'invalid-value',
    );
    expect(mirror.replaceSnapshot(baseSnapshot()).status).toBe('replayed');
  });
});
