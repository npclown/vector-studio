import type { RenderNodeSnapshot, RenderSceneSnapshot } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  RetainedSceneMirror,
  useFullChangeValidationForTesting,
} from '../../packages/renderer-core/src/scene-mirror.js';
import {
  createCountingPort,
  createPathHarness,
  identity,
  pathNode,
  rectangleNode,
  target,
} from '../support/v3a-path-harness.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';

// E26 contract, U5b (section 4.4.1), amending V3 section b and V3-A2: a path removed by a set
// and inserted again with equal path data before the next view is built keeps its geometry
// revision, so isolation's removal set and re-adds miss no mesh cache entry. Building a view or
// publishing a snapshot ends the window. The incremental publication and the full oracle agree.

const modes = ['incremental', 'full'] as const;

function mirrorFor(mode: (typeof modes)[number]): RetainedSceneMirror {
  const mirror = new RetainedSceneMirror(undefined, { pathNodes: 'supported' });
  if (mode === 'full') useFullChangeValidationForTesting(mirror);
  return mirror;
}

function snapshot(nodes: readonly RenderNodeSnapshot[], revision = 1): RenderSceneSnapshot {
  return { identity, revision, nodes, rootOrder: nodes.map((node) => node.id) };
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

function revisions(mirror: RetainedSceneMirror): Map<string, number | undefined> {
  const view = mirror.readRetainedScene()!;
  return new Map(view.nodes.map((node) => [node.id, view.getGeometryRevision(node.id)]));
}

describe.each(modes)('E26-U5b geometry revision reuse (%s publication)', (mode) => {
  const a = () => pathNode('a', 0) as RenderNodeSnapshot;
  const b = () => pathNode('b', 20) as RenderNodeSnapshot;
  const bMoved = () => pathNode('b', 20, { points: [0, 0, 10, 0, 9, 9] }) as RenderNodeSnapshot;

  it('a removal set and re-adds before the next view keep equal paths revisions', () => {
    const mirror = mirrorFor(mode);
    mirror.replaceSnapshot(snapshot([a(), b(), rectangleNode('r', 40) as RenderNodeSnapshot]));
    const before = revisions(mirror);
    const removal = mirror.applyChanges(change(2, { removed: ['a', 'b', 'r'], rootOrder: [] }));
    expect(removal.status).toBe('applied');
    expect(mirror.applyChanges(change(3, { inserted: [a()], rootOrder: ['a'] })).status).toBe(
      'applied',
    );
    expect(
      mirror.applyChanges(change(4, { inserted: [bMoved()], rootOrder: ['a', 'b'] })).status,
    ).toBe('applied');
    const after = revisions(mirror);
    expect(after.get('a')).toBe(before.get('a'));
    // Changed path data takes a new value, above every earlier one.
    expect(after.get('b')).toBeGreaterThan(Math.max(before.get('a')!, before.get('b')!));
  });

  it('building a view ends the window', () => {
    const mirror = mirrorFor(mode);
    mirror.replaceSnapshot(snapshot([a()]));
    const first = revisions(mirror).get('a')!;
    mirror.applyChanges(change(2, { removed: ['a'], rootOrder: [] }));
    mirror.readRetainedScene();
    mirror.applyChanges(change(3, { inserted: [a()], rootOrder: ['a'] }));
    expect(revisions(mirror).get('a')).toBeGreaterThan(first);
  });

  it('a snapshot publication ends the window', () => {
    const mirror = mirrorFor(mode);
    mirror.replaceSnapshot(snapshot([a()]));
    const first = revisions(mirror).get('a')!;
    mirror.applyChanges(change(2, { removed: ['a'], rootOrder: [] }));
    mirror.replaceSnapshot(snapshot([], 3));
    mirror.applyChanges(change(4, { inserted: [a()], rootOrder: ['a'] }));
    expect(revisions(mirror).get('a')).toBeGreaterThan(first);
  });

  it('a rejected set changes nothing, and a non-path insert drops the held revision', () => {
    const mirror = mirrorFor(mode);
    mirror.replaceSnapshot(snapshot([a()]));
    const first = revisions(mirror).get('a')!;
    mirror.applyChanges(change(2, { removed: ['a'], rootOrder: [] }));
    // Unknown node in the order: rejected, the held revision survives.
    expect(mirror.applyChanges(change(3, { inserted: [a()], rootOrder: ['a', 'x'] })).status).toBe(
      'invalid-scene',
    );
    mirror.applyChanges(
      change(3, { inserted: [rectangleNode('a', 0) as RenderNodeSnapshot], rootOrder: ['a'] }),
    );
    mirror.applyChanges(change(4, { removed: ['a'], rootOrder: [] }));
    mirror.applyChanges(change(5, { inserted: [a()], rootOrder: ['a'] }));
    expect(revisions(mirror).get('a')).toBeGreaterThan(first);
  });
});

it('E26-U5b: the incremental and full publications assign equal revisions over seeded sets with no view between them', () => {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
  const ids = Array.from({ length: 12 }, (_, index) => `p${index}`);
  const shapes = [0, 30, 60];
  for (let run = 0; run < 40; run += 1) {
    const mirrors = modes.map(mirrorFor);
    const held = new Map<string, number>();
    for (const id of ids.slice(0, 6)) held.set(id, shapes[Math.floor(random() * 3)]!);
    const node = (id: string) => pathNode(id, held.get(id)!) as RenderNodeSnapshot;
    for (const mirror of mirrors) mirror.replaceSnapshot(snapshot([...held.keys()].map(node)));
    let revision = 1;
    for (let step = 0; step < 30; step += 1) {
      revision += 1;
      const id = ids[Math.floor(random() * ids.length)]!;
      const parts: Parameters<typeof change>[1] = {};
      if (held.has(id) && random() < 0.6) {
        held.delete(id);
        parts.removed = [id];
      } else if (held.has(id)) {
        held.set(id, shapes[Math.floor(random() * 3)]!);
        parts.updated = [node(id)];
      } else {
        held.set(id, shapes[Math.floor(random() * 3)]!);
        parts.inserted = [node(id)];
      }
      parts.rootOrder = [...held.keys()];
      const results = mirrors.map((mirror) => mirror.applyChanges(change(revision, parts)).status);
      expect(results).toEqual(['applied', 'applied']);
      // A view now and then ends the window in both.
      if (random() < 0.2) {
        expect(revisions(mirrors[0]!)).toEqual(revisions(mirrors[1]!));
      }
    }
    expect(revisions(mirrors[0]!)).toEqual(revisions(mirrors[1]!));
  }
});

it('E26-U5b: after a removal set and re-adds that leave one path out, the next prepare calls no port and writes no record of a kept node', () => {
  const port = createCountingPort();
  const nodes = [
    pathNode('a', 0),
    pathNode('b', 20),
    rectangleNode('r', 40),
  ] as RenderNodeSnapshot[];
  const h = createPathHarness({ port, nodes });
  const first = h.source.prepare(target)!;
  h.source.acknowledge(receiptOf(first));
  const calls = port.calls.length;
  const set = (revision: number, parts: Parameters<typeof change>[1]) =>
    expect(h.mirror.applyChanges(change(revision, parts)).status).toBe('applied');
  // Isolation with b rejected: remove every held node, then add the units back without b.
  set(2, { removed: ['a', 'b', 'r'], rootOrder: [] });
  set(3, { inserted: [nodes[0]!, nodes[2]!], rootOrder: ['a', 'r'] });
  const after = h.source.prepare(target)!;
  expect(port.calls.length).toBe(calls);
  expect(after.sceneEpoch).toBe(first.sceneEpoch);
  expect(
    after.writes.filter((write) => write.resourceId !== 'order' && write.resourceId !== 'frame'),
  ).toEqual([]);
  expect(after.mesh!.writes.filter((write) => write.resourceId !== 'meshFrame')).toEqual([]);
  expect(after.mesh!.draws.length).toBe(1);
});
