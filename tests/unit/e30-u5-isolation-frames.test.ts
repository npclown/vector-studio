import type { RenderChangeSet, RenderNodeSnapshot } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { reconcileCountsForTesting } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import { derivationCountsForTesting } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import {
  Model,
  identity,
  isolationSets,
  normalizer,
  random,
  randomScene,
  target,
  textReceipts,
  twin,
} from '../support/e26-twin-scene.js';

// E30 contract (docs/plans/d9-e30-renderer-cost-contract.md), section 4.3, U5 (L4): the frame
// after an isolation. An isolation removes every node and inserts the page again in the next set;
// the mirror's view lists, for a reader of the last view, only the IDs whose node or geometry
// revision differ from that view, so a page inserted again unchanged is an unchanged frame and a
// page inserted again with a few leaves changed is a set of those leaves (U4). The oracle is the
// E26-U5c twin (`useFullDerivationForTesting`, the path pipeline without reuse): byte-identical
// packets.

function setup(seed: number) {
  const rng = random(seed);
  const model = new Model();
  randomScene(rng, model, 200);
  const incremental = twin(false);
  const oracle = twin(true);
  const normalize = { incremental: normalizer(), oracle: normalizer() };
  const receipts = { incremental: textReceipts(), oracle: textReceipts() };
  for (const { mirror } of [incremental, oracle]) {
    expect(mirror.replaceSnapshot(model.snapshot()).status).toBe('applied');
    mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  }
  const frame = (sets: RenderChangeSet[] = []) => {
    for (const set of sets) {
      for (const { mirror } of [incremental, oracle]) {
        expect(mirror.applyChanges(set).status).toBe('applied');
      }
    }
    const derivation = derivationCountsForTesting(incremental.source);
    const reconcile = reconcileCountsForTesting(incremental.pipeline);
    const left = incremental.source.prepare(target)!;
    const right = oracle.source.prepare(target)!;
    expect(normalize.incremental(left)).toBe(normalize.oracle(right));
    incremental.source.acknowledge(receipts.incremental.receipt(left));
    oracle.source.acknowledge(receipts.oracle.receipt(right));
    const after = derivationCountsForTesting(incremental.source);
    const reconciled = reconcileCountsForTesting(incremental.pipeline);
    return {
      reused: after.reused - derivation.reused,
      patched: after.patched - derivation.patched,
      full: after.full - derivation.full,
      reconciled: reconciled.full - reconcile.full,
      changed: reconciled.changed - reconcile.changed,
    };
  };
  return { model, frame };
}

/** The model's isolation sets, with `edit` applied to the re-inserted copy of node `id`. */
function isolation(
  model: Model,
  id?: string,
  edit?: (node: RenderNodeSnapshot) => RenderNodeSnapshot,
) {
  const [removal, reinsert] = isolationSets(model);
  if (id === undefined || edit === undefined) return [removal!, reinsert!];
  const next = edit(model.nodes.get(id)!);
  model.nodes.set(id, next);
  return [
    removal!,
    {
      ...reinsert!,
      inserted: reinsert!.inserted.map((node) => (node.id === id ? next : node)),
    },
  ];
}

const moved = (node: RenderNodeSnapshot): RenderNodeSnapshot => ({
  ...node,
  transform: [
    node.transform[0],
    node.transform[1],
    node.transform[2],
    node.transform[3],
    node.transform[4] + 3,
    node.transform[5],
  ],
});

describe('E30-U5 frames after an isolation', () => {
  it('keeps the derivation and every path when the page is inserted again unchanged', () => {
    for (const seed of [1, 2, 3]) {
      const { model, frame } = setup(seed);
      frame();
      frame();
      expect(frame(isolation(model)), `seed ${seed}`).toEqual({
        reused: 1,
        patched: 0,
        full: 0,
        reconciled: 0,
        changed: 0,
      });
      // Twice in one frame, and an unchanged frame after.
      expect(frame([...isolation(model), ...isolation(model)])).toMatchObject({ reused: 1 });
      expect(frame()).toMatchObject({ reused: 1, reconciled: 0, changed: 0 });
    }
  });

  it('derives only the leaves the re-inserted page changed', () => {
    for (const seed of [4, 5, 6]) {
      const { model, frame } = setup(seed);
      frame();
      const leaf = [...model.nodes.values()].find(
        (node) => node.kind === 'path' && !model.isMaskSource(node.id),
      )!;
      expect(frame(isolation(model, leaf.id, moved)), `seed ${seed}`).toMatchObject({
        patched: 1,
        full: 0,
        reconciled: 0,
      });
      // A container written differently: the whole derivation, as for any container set.
      const container = model.containers()[0]!;
      expect(
        frame(isolation(model, container.id, (node) => ({ ...node, opacity: 0.25 }))),
      ).toMatchObject({ full: 1 });
      // A leaf left out of the page: removed, so the root or a container order changes.
      const [removal, reinsert] = isolationSets(model);
      const dropped = model.rootOrder.find((id) => model.nodes.get(id)!.kind !== 'container')!;
      model.nodes.delete(dropped);
      model.rootOrder = model.rootOrder.filter((id) => id !== dropped);
      expect(
        frame([
          removal!,
          {
            ...reinsert!,
            inserted: reinsert!.inserted.filter((node) => node.id !== dropped),
            orders: [{ parentId: null, children: [...model.rootOrder] }],
          },
        ]),
      ).toMatchObject({ full: 1 });
    }
  });

  it('lists to a reader of an earlier view the IDs written since it', () => {
    const rng = random(7);
    const model = new Model();
    randomScene(rng, model, 60);
    const mirror = new RetainedSceneMirror(undefined, {
      pathNodes: 'supported',
      pathFills: 'supported',
      pathStrokes: 'supported',
      dashes: 'supported',
      clips: 'supported',
      paints: 'gradient',
      groupOpacity: 'supported',
      textNodes: 'supported',
    });
    expect(mirror.replaceSnapshot(model.snapshot()).status).toBe('applied');
    const first = mirror.readRetainedScene()!;
    const leaf = [...model.nodes.values()].find((node) => node.kind !== 'container')!;
    const next = moved(leaf);
    model.nodes.set(leaf.id, next);
    model.revision += 1;
    expect(
      mirror.applyChanges({
        identity,
        revision: model.revision,
        baseRevision: model.revision - 1,
        inserted: [],
        updated: [next],
        removed: [],
        orders: [],
      }).status,
    ).toBe('applied');
    const second = mirror.readRetainedScene()!;
    for (const set of isolation(model)) expect(mirror.applyChanges(set).status).toBe('applied');
    const third = mirror.readRetainedScene()!;
    expect(third.changedSince(second.changeSerial)).toEqual([]);
    expect([...new Set(third.changedSince(first.changeSerial))]).toEqual([leaf.id]);
    // A node inserted again with other path data is listed.
    const path = [...model.nodes.values()].find((node) => node.kind === 'path')!;
    for (const set of isolation(model, path.id, (node) =>
      node.kind === 'path'
        ? {
            ...node,
            geometry: { ...node.geometry, points: node.geometry.points.map((v) => v + 1) },
          }
        : node,
    )) {
      expect(mirror.applyChanges(set).status).toBe('applied');
    }
    const fourth = mirror.readRetainedScene()!;
    expect([...new Set(fourth.changedSince(third.changeSerial))]).toEqual([path.id]);
    // A leaf left out of the page is listed (removed), as the root order change is seen.
    const [removal, reinsert] = isolationSets(model);
    const dropped = model.rootOrder.find((id) => model.nodes.get(id)!.kind !== 'container')!;
    model.nodes.delete(dropped);
    model.rootOrder = model.rootOrder.filter((id) => id !== dropped);
    for (const set of [
      removal!,
      {
        ...reinsert!,
        inserted: reinsert!.inserted.filter((node) => node.id !== dropped),
        orders: [{ parentId: null, children: [...model.rootOrder] }],
      },
    ]) {
      expect(mirror.applyChanges(set).status).toBe('applied');
    }
    const fifth = mirror.readRetainedScene()!;
    expect([...new Set(fifth.changedSince(fourth.changeSerial))]).toEqual([dropped]);
    // A view built between the removal and the insertion holds an empty page: every node is
    // listed to a reader of the view before it.
    const [emptied, refilled] = isolationSets(model);
    expect(mirror.applyChanges(emptied!).status).toBe('applied');
    const between = mirror.readRetainedScene()!;
    expect(between.nodes).toHaveLength(0);
    expect(mirror.applyChanges(refilled!).status).toBe('applied');
    const sixth = mirror.readRetainedScene()!;
    expect(new Set(sixth.changedSince(fifth.changeSerial)).size).toBe(model.nodes.size);
    expect(new Set(sixth.changedSince(between.changeSerial)).size).toBe(model.nodes.size);
  });
});
