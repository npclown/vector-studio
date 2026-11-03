import type { RenderChangeSet, RenderNodeSnapshot } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  PathMeshPipeline,
  reconcileCountsForTesting,
  reusedPathsForTesting,
  type PathMeshLimits,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import {
  derivationCountsForTesting,
  packingCountsForTesting,
} from '../../packages/renderer-core/src/primitive-scene-source.js';
import { createFailingPort, type ScriptedFillMeshPort } from '../support/v3a-path-harness.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';
import {
  Model,
  identity,
  isolationSets,
  leaf,
  normalizer,
  random,
  randomScene,
  randomSet,
  target,
  textReceipts,
  transform,
  twin,
} from '../support/e26-twin-scene.js';

// E30 contract (docs/plans/d9-e30-renderer-cost-contract.md), section 4.2, U4: a frame after a
// set walks only what the set changed. The oracle is E26-U5c's twin (`useFullDerivationForTesting`
// and the path pipeline without reuse), fed the same sets, cameras and receipts: sets of 1 to 64
// leaves (moved, restyled, of another kind, mask sources), container edits, inserts, removals,
// reorders and isolations, with pans, zooms and still frames between them. Every packet and the
// pipelines' statistics must be identical.

type Rng = () => number;

/** A set that writes `count` leaves of the model in place, applied to the model. */
function leafSet(rng: Rng, model: Model, count: number): RenderChangeSet | null {
  const leaves = [...model.nodes.values()].filter((node) => node.kind !== 'container');
  if (leaves.length === 0) return null;
  const updated = new Map<string, RenderNodeSnapshot>();
  for (let index = 0; index < count; index += 1) {
    const node = leaves[Math.floor(rng() * leaves.length)]!;
    if (updated.has(node.id)) continue;
    const kind = rng();
    const next: RenderNodeSnapshot =
      model.isMaskSource(node.id) || kind < 0.6
        ? // Moved: a small step keeps most leaves in view.
          {
            ...node,
            transform: [
              node.transform[0],
              node.transform[1],
              node.transform[2],
              node.transform[3],
              node.transform[4] + (rng() - 0.5) * 20,
              node.transform[5] + (rng() - 0.5) * 20,
            ],
          }
        : kind < 0.75
          ? { ...node, transform: transform(rng) }
          : // Restyled, or a leaf of another kind under the same ID.
            { ...leaf(rng, node.id, node.parentId), transform: node.transform };
    updated.set(node.id, next);
  }
  for (const node of updated.values()) model.nodes.set(node.id, node);
  model.revision += 1;
  return {
    identity,
    revision: model.revision,
    baseRevision: model.revision - 1,
    inserted: [],
    updated: [...updated.values()],
    removed: [],
    orders: [],
  };
}

/** A pipeline's statistics without bucket computations, which a kept outcome skips. */
function comparable(pipeline: PathMeshPipeline): Record<string, number> {
  const statistics: Record<string, number> = { ...pipeline.getStatistics() };
  delete statistics.bucketComputations;
  return statistics;
}

function runDifferential(
  seed: number,
  frames: number,
  limits?: Partial<PathMeshLimits>,
  port?: () => ScriptedFillMeshPort,
) {
  const rng = random(seed);
  const model = new Model();
  randomScene(rng, model, 150 + Math.floor(rng() * 100));
  const incremental = twin(false, limits, port);
  const oracle = twin(true, limits, port);
  const normalize = { incremental: normalizer(), oracle: normalizer() };
  // Text parts are acknowledged as a backend would; now and then a page is recreated in both
  // backends, so its entries are lost and drawn again (a separate generator keeps the sets).
  const receipts = { incremental: textReceipts(), oracle: textReceipts() };
  const backend = random(seed + 1_000);
  for (const { mirror } of [incremental, oracle]) {
    expect(mirror.replaceSnapshot(model.snapshot()).status).toBe('applied');
  }
  let camera = { x: 0, y: 0, zoom: 1 };
  const kinds = { leaves: 0, other: 0, camera: 0, still: 0 };
  for (let frame = 0; frame < frames; frame += 1) {
    const step = rng();
    const sets: RenderChangeSet[] = [];
    if (step < 0.45) {
      // 1 to 64 leaves, about evenly over the powers of two.
      const count = Math.max(1, Math.floor(2 ** (rng() * 6)));
      const set = leafSet(rng, model, count);
      if (set !== null) sets.push(set);
      kinds.leaves += 1;
    } else if (step < 0.6) {
      const set = randomSet(rng, model);
      if (set !== null) sets.push(set);
      kinds.other += 1;
    } else if (step < 0.62) {
      sets.push(...isolationSets(model));
      kinds.other += 1;
    } else if (step < 0.8) {
      const move = rng();
      camera =
        move < 0.6
          ? { ...camera, x: camera.x + (rng() - 0.5) * 40, y: camera.y + (rng() - 0.5) * 40 }
          : {
              ...camera,
              zoom: Math.min(4, Math.max(0.25, camera.zoom * (rng() < 0.5 ? 0.8 : 1.25))),
            };
      kinds.camera += 1;
    } else kinds.still += 1;
    // A leaf set and a camera move in the same frame, now and then.
    if (sets.length > 0 && rng() < 0.15) camera = { ...camera, x: camera.x + (rng() - 0.5) * 10 };
    for (const set of sets) {
      const results = [incremental, oracle].map(({ mirror }) => mirror.applyChanges(set).status);
      expect(results, `frame ${frame}`).toEqual(['applied', 'applied']);
    }
    for (const { mirror } of [incremental, oracle]) {
      mirror.setCamera({ position: { x: camera.x, y: camera.y }, zoom: camera.zoom });
    }
    const left = incremental.source.prepare(target);
    const right = oracle.source.prepare(target);
    expect(normalize.incremental(left), `seed ${seed} frame ${frame}`).toBe(
      normalize.oracle(right),
    );
    expect(comparable(incremental.pipeline), `seed ${seed} frame ${frame} statistics`).toEqual(
      comparable(oracle.pipeline),
    );
    if (left !== null && rng() < 0.9) {
      if (backend() < 0.03) {
        receipts.incremental.recreate(0);
        receipts.oracle.recreate(0);
      }
      incremental.source.acknowledge(receipts.incremental.receipt(left));
      oracle.source.acknowledge(receipts.oracle.receipt(right!));
    }
  }
  return {
    kinds,
    reconcile: reconcileCountsForTesting(incremental.pipeline),
    derivation: derivationCountsForTesting(incremental.source),
    cull: packingCountsForTesting(incremental.source).cull,
    masks: packingCountsForTesting(incremental.source).masks,
    text: packingCountsForTesting(incremental.source).text,
    evictions: incremental.pipeline.getStatistics().evictions,
  };
}

describe('E30-U4 set frames', () => {
  it('prepares the same packets as the full path over sets of 1 to 64 leaves', () => {
    const results = [1, 2, 3, 4, 5, 6].map((seed) =>
      // Seeds 3 and 4 run the path pipeline under a small byte budget and memo, so entries are
      // evicted and trimmed between frames. Seeds 5 and 6 limit the port to a few requests per
      // prepare, so new meshes wait over frames, and fail the requests of some paths (by the x
      // of their first point), so failures are memoized and replayed; seed 6 under a small memo.
      seed < 3
        ? runDifferential(seed, 250)
        : seed < 5
          ? runDifferential(seed, 250, { byteBudget: 24_576, memoCapacity: 8 })
          : runDifferential(
              seed,
              250,
              {
                requestsPerCall: 3,
                callsPerPrepare: 1,
                ...(seed === 6 ? { memoCapacity: 2 } : {}),
              },
              () =>
                createFailingPort({
                  pathFailures: new Map(
                    Array.from({ length: 16 }, (_, index) => 4 * index + 1).map(
                      (tag) => [tag, 'work-limit'] as const,
                    ),
                  ),
                }),
            ),
    );
    const sum = (pick: (result: (typeof results)[number]) => number) =>
      results.reduce((total, result) => total + pick(result), 0);
    expect(sum((result) => result.kinds.leaves)).toBeGreaterThan(350);
    expect(sum((result) => result.kinds.other)).toBeGreaterThan(100);
    // Leaf sets reconcile the replaced paths alone; the other sets reconcile in full.
    expect(sum((result) => result.reconcile.changed)).toBeGreaterThan(1_000);
    expect(sum((result) => result.reconcile.full)).toBeGreaterThan(100);
    expect(sum((result) => result.derivation.patched)).toBeGreaterThan(150);
    // Leaf sets inside the cull range decide only the replaced leaves.
    expect(sum((result) => result.cull.patched)).toBeGreaterThan(100);
    // Frames with the kept mask plan's inputs keep the plan.
    expect(sum((result) => result.masks.kept)).toBeGreaterThan(100);
    expect(sum((result) => result.masks.planned)).toBeGreaterThan(100);
    expect(sum((result) => result.text.repeated)).toBeGreaterThan(300);
    expect(sum((result) => result.text.planned)).toBeGreaterThan(300);
    expect(results[2]!.evictions + results[3]!.evictions).toBeGreaterThan(20);
  }, 120_000);
});

describe('E30-U4 counters', () => {
  function pathScene(count: number): RenderNodeSnapshot[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `p${String(index).padStart(3, '0')}`,
      parentId: null,
      transform: [1, 0, 0, 1, (index % 20) * 30, Math.floor(index / 20) * 30],
      visible: true,
      opacity: 1,
      kind: 'path' as const,
      geometry: {
        kind: 'path' as const,
        fillRule: 'nonzero' as const,
        verbs: ['move', 'line', 'line', 'close'] as const,
        points: [0, 0, 20, 0, 10, 20],
      },
      style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
    })) as unknown as RenderNodeSnapshot[];
  }

  it('evaluates and reconciles only the paths a set wrote, and nothing on an unchanged frame', () => {
    const nodes = pathScene(200);
    const state = twin(false);
    state.mirror.replaceSnapshot({
      identity,
      revision: 1,
      nodes,
      rootOrder: nodes.map((node) => node.id),
    });
    state.mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    const frame = () => {
      const before = {
        reused: reusedPathsForTesting(state.pipeline),
        reconcile: reconcileCountsForTesting(state.pipeline),
      };
      const packet = state.source.prepare(target)!;
      state.source.acknowledge(receiptOf(packet));
      const reconcile = reconcileCountsForTesting(state.pipeline);
      return {
        reused: reusedPathsForTesting(state.pipeline) - before.reused,
        full: reconcile.full - before.reconcile.full,
        changed: reconcile.changed - before.reconcile.changed,
      };
    };
    frame();
    frame();
    // An unchanged frame keeps every path and reconciles nothing.
    expect(frame()).toEqual({ reused: 200, full: 0, changed: 0 });
    let revision = 1;
    const current = new Map(nodes.map((node) => [node.id, node]));
    for (const count of [1, 2, 8, 64]) {
      revision += 1;
      const updated = [...current.values()].slice(0, count).map((node) => ({
        ...node,
        transform: [1, 0, 0, 1, node.transform[4] + 1, node.transform[5]] as const,
      })) as RenderNodeSnapshot[];
      for (const node of updated) current.set(node.id, node);
      expect(
        state.mirror.applyChanges({
          identity,
          revision,
          baseRevision: revision - 1,
          inserted: [],
          updated,
          removed: [],
          orders: [],
        }).status,
      ).toBe('applied');
      // The written paths are evaluated afresh and reconciled alone; the others are kept.
      expect(frame(), `${count} paths`).toEqual({ reused: 200 - count, full: 0, changed: count });
      expect(frame(), `${count} paths, then unchanged`).toEqual({
        reused: 200,
        full: 0,
        changed: 0,
      });
    }
  });
});

describe('E30-U4b cull counters', () => {
  it('decides only the primitives a set replaced, inside the kept range', () => {
    const nodes: RenderNodeSnapshot[] = Array.from({ length: 200 }, (_, index) => ({
      id: `r${String(index).padStart(3, '0')}`,
      parentId: null,
      transform: [1, 0, 0, 1, (index % 20) * 30, Math.floor(index / 20) * 30],
      visible: true,
      opacity: 1,
      kind: 'primitive',
      geometry: { kind: 'rectangle', width: 20, height: 20, cornerRadii: [0, 0, 0, 0] },
      style: { fill: { r: 0, g: 0, b: 1, a: 1 }, stroke: null },
    }));
    const incremental = twin(false);
    const oracle = twin(true);
    const normalize = { incremental: normalizer(), oracle: normalizer() };
    for (const { mirror } of [incremental, oracle]) {
      mirror.replaceSnapshot({ identity, revision: 1, nodes, rootOrder: nodes.map((n) => n.id) });
      mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    }
    const current = new Map(nodes.map((node) => [node.id, node]));
    let revision = 1;
    const frame = (updated: RenderNodeSnapshot[]) => {
      const before = packingCountsForTesting(incremental.source).cull;
      if (updated.length > 0) {
        revision += 1;
        for (const node of updated) current.set(node.id, node);
        for (const { mirror } of [incremental, oracle]) {
          const set = {
            identity,
            revision,
            baseRevision: revision - 1,
            inserted: [],
            updated,
            removed: [],
            orders: [],
          };
          expect(mirror.applyChanges(set).status).toBe('applied');
        }
      }
      const left = incremental.source.prepare(target)!;
      const right = oracle.source.prepare(target)!;
      expect(normalize.incremental(left)).toBe(normalize.oracle(right));
      incremental.source.acknowledge(receiptOf(left));
      oracle.source.acknowledge(receiptOf(right));
      const after = packingCountsForTesting(incremental.source).cull;
      return { culls: after.culls - before.culls, patched: after.patched - before.patched };
    };
    const moved = (count: number, dx: number) =>
      [...current.values()].slice(0, count).map((node) => ({
        ...node,
        transform: [1, 0, 0, 1, node.transform[4] + dx, node.transform[5]] as const,
      })) as RenderNodeSnapshot[];
    frame([]);
    frame([]);
    for (const count of [1, 8, 64]) {
      // A small move keeps each primitive in view; the others keep their decisions.
      expect(frame(moved(count, 1)), `${count} primitives`).toEqual({ culls: 0, patched: 1 });
    }
    // A move out of the view changes the drawn set, still by the replaced primitives alone.
    expect(frame(moved(4, 5_000))).toEqual({ culls: 0, patched: 1 });
    expect(frame(moved(4, -5_000))).toEqual({ culls: 0, patched: 1 });
  });
});

describe('E30-U4b text cull patch', () => {
  it('decides replaced text leaves and narrows the range by them', () => {
    const text = (index: number, x: number, visible = true): RenderNodeSnapshot => ({
      id: `t${String(index).padStart(2, '0')}`,
      parentId: null,
      transform: [1, 0, 0, 1, x, 200],
      visible,
      opacity: 1,
      kind: 'text',
      generation: 0,
      lang: 'ko',
      runs: [
        {
          fontList: '"Arial", sans-serif',
          size: 14,
          color: { r: 0, g: 0, b: 0, a: 1 },
          clusters: [
            { text: '\u4e00', x: 0, y: 10, advance: 8 },
            { text: '\u4e01', x: 8, y: 10, advance: 8 },
          ],
        },
      ],
    });
    const nodes = Array.from({ length: 10 }, (_, index) => text(index, 200 + index * 20));
    const incremental = twin(false);
    const oracle = twin(true);
    const normalize = { incremental: normalizer(), oracle: normalizer() };
    for (const { mirror } of [incremental, oracle]) {
      mirror.replaceSnapshot({ identity, revision: 1, nodes, rootOrder: nodes.map((n) => n.id) });
      mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    }
    let revision = 1;
    const frame = (updated: RenderNodeSnapshot[], x?: number) => {
      const before = packingCountsForTesting(incremental.source).cull;
      for (const { mirror } of [incremental, oracle]) {
        if (updated.length > 0) {
          const set = {
            identity,
            revision: revision + 1,
            baseRevision: revision,
            inserted: [],
            updated,
            removed: [],
            orders: [],
          };
          expect(mirror.applyChanges(set).status).toBe('applied');
        }
        if (x !== undefined) mirror.setCamera({ position: { x, y: 0 }, zoom: 1 });
      }
      if (updated.length > 0) revision += 1;
      const left = incremental.source.prepare(target)!;
      const right = oracle.source.prepare(target)!;
      expect(normalize.incremental(left)).toBe(normalize.oracle(right));
      incremental.source.acknowledge(receiptOf(left));
      oracle.source.acknowledge(receiptOf(right));
      const after = packingCountsForTesting(incremental.source).cull;
      return { culls: after.culls - before.culls, patched: after.patched - before.patched };
    };
    frame([]);
    frame([]);
    // Hidden by the set: the patch must not draw it.
    expect(frame([text(0, 200, false)])).toEqual({ culls: 0, patched: 1 });
    // Moved out of the view and back.
    expect(frame([text(1, 5_000)])).toEqual({ culls: 0, patched: 1 });
    expect(frame([text(1, 220)])).toEqual({ culls: 0, patched: 1 });
    // Moved to just inside the view's right edge (its bound reaches 14 units left of its origin):
    // a pan of 8 units, which the other leaves' decisions allow, takes it out, so the patch must
    // narrow the range by it.
    const right = target.width / target.devicePixelRatio;
    expect(frame([text(1, right + 10)])).toEqual({ culls: 0, patched: 1 });
    expect(frame([], -8)).toEqual({ culls: 1, patched: 0 });
  });
});

describe('E30-U4b kept mask plan', () => {
  it('keeps the mask plan only under the same inputs, with mask levels drawn', () => {
    const rect = (id: string, parentId: string | null, x: number, y: number, size: number) =>
      ({
        id,
        parentId,
        transform: [1, 0, 0, 1, x, y],
        visible: true,
        opacity: 1,
        kind: 'primitive',
        geometry: { kind: 'rectangle', width: size, height: size, cornerRadii: [0, 0, 0, 0] },
        style: { fill: { r: 0, g: 1, b: 0, a: 1 }, stroke: null },
      }) as RenderNodeSnapshot;
    const nodes: RenderNodeSnapshot[] = [];
    const rootOrder: string[] = [];
    for (let mask = 0; mask < 4; mask += 1) {
      const id = `m${mask}`;
      const children = [`m${mask}s`, ...Array.from({ length: 6 }, (_, i) => `m${mask}c${i}`)];
      nodes.push({
        id,
        parentId: null,
        transform: [1, 0, 0, 1, mask * 70, 20],
        visible: true,
        opacity: 1,
        kind: 'container',
        clip: { kind: 'mask' },
        children,
      });
      rootOrder.push(id);
      nodes.push(rect(`m${mask}s`, id, 5, 5, 50));
      for (let i = 0; i < 6; i += 1) nodes.push(rect(`m${mask}c${i}`, id, i * 9, i * 7, 20));
    }
    const incremental = twin(false);
    const oracle = twin(true);
    const normalize = { incremental: normalizer(), oracle: normalizer() };
    for (const { mirror } of [incremental, oracle]) {
      expect(mirror.replaceSnapshot({ identity, revision: 1, nodes, rootOrder }).status).toBe(
        'applied',
      );
    }
    const rng = random(0xe30b6);
    const current = new Map(nodes.map((node) => [node.id, node]));
    let revision = 1;
    let camera = { x: 0, y: 0, zoom: 1 };
    let drawnMasks = 0;
    for (let frame = 0; frame < 200; frame += 1) {
      const step = rng();
      if (step < 0.3) {
        camera = { ...camera, x: camera.x + (rng() - 0.5) * 6, y: camera.y + (rng() - 0.5) * 6 };
      } else if (step < 0.4) {
        camera = { ...camera, zoom: camera.zoom * (rng() < 0.5 ? 0.9 : 1.1) };
      } else if (step < 0.7) {
        // Content leaves moved; now and then a mask source.
        const ids = [...current.keys()].filter((id) => id.includes('c') || rng() < 0.05);
        const updated = Array.from(
          { length: 1 + Math.floor(rng() * 3) },
          (): RenderNodeSnapshot => {
            const node = current.get(ids[Math.floor(rng() * ids.length)]!)!;
            const [a, b, c, d, e, f] = node.transform;
            return { ...node, transform: [a, b, c, d, e + (rng() - 0.5) * 8, f] };
          },
        );
        const unique = [...new Map(updated.map((node) => [node.id, node])).values()];
        revision += 1;
        for (const node of unique) current.set(node.id, node);
        for (const { mirror } of [incremental, oracle]) {
          const set = {
            identity,
            revision,
            baseRevision: revision - 1,
            inserted: [],
            updated: unique,
            removed: [],
            orders: [],
          };
          expect(mirror.applyChanges(set).status).toBe('applied');
        }
      }
      for (const { mirror } of [incremental, oracle]) {
        mirror.setCamera({ position: { x: camera.x, y: camera.y }, zoom: camera.zoom });
      }
      const left = incremental.source.prepare(target)!;
      const right = oracle.source.prepare(target)!;
      expect(normalize.incremental(left), `frame ${frame}`).toBe(normalize.oracle(right));
      if ((left.clip?.masks.length ?? 0) > 0) drawnMasks += 1;
      incremental.source.acknowledge(receiptOf(left));
      oracle.source.acknowledge(receiptOf(right));
    }
    const counts = packingCountsForTesting(incremental.source).masks;
    expect(drawnMasks).toBeGreaterThan(150);
    expect(counts.kept).toBeGreaterThan(30);
    expect(counts.planned).toBeGreaterThan(100);
  });
});

describe('E30-U4 mirror views', () => {
  it('keeps every view of a version as it was, over layered and copied views', () => {
    const rng = random(0xe30a4);
    const model = new Model();
    randomScene(rng, model, 120);
    const mirror = twin(false).mirror;
    expect(mirror.replaceSnapshot(model.snapshot()).status).toBe('applied');
    type Kept = {
      view: NonNullable<ReturnType<typeof mirror.readRetainedScene>>;
      nodes: Map<string, RenderNodeSnapshot>;
      revisions: Map<string, number | undefined>;
    };
    const kept: Kept[] = [];
    const ids = new Set<string>();
    let layered = 0;
    for (let step = 0; step < 400; step += 1) {
      const choice = rng();
      const set =
        choice < 0.6
          ? leafSet(rng, model, Math.max(1, Math.floor(2 ** (rng() * 7))))
          : choice < 0.97
            ? randomSet(rng, model)
            : null;
      if (set !== null) expect(mirror.applyChanges(set).status).toBe('applied');
      else if (choice >= 0.97) {
        model.revision += 1;
        expect(mirror.replaceSnapshot(model.snapshot()).status).toBe('applied');
      }
      // Some versions are never read, so a layer can span several sets.
      if (rng() < 0.3) continue;
      const view = mirror.readRetainedScene()!;
      for (const id of model.nodes.keys()) ids.add(id);
      // A revision only for a path node, at every ID ever seen.
      const misplaced = [...ids].filter(
        (id) =>
          (model.nodes.get(id)?.kind === 'path') !== (view.getGeometryRevision(id) !== undefined) ||
          (!model.nodes.has(id) && view.getNode(id) !== undefined),
      );
      expect(misplaced, `step ${step}`).toEqual([]);
      // The view holds the model's nodes, in ordinal order.
      expect(view.nodes.map((node) => node.id)).toEqual(
        [...model.nodes.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      for (const node of view.nodes) expect(node).toEqual(model.nodes.get(node.id));
      kept.push({
        view,
        nodes: new Map(
          [...ids].flatMap((id) => {
            const node = view.getNode(id);
            return node === undefined ? [] : [[id, node] as const];
          }),
        ),
        revisions: new Map([...ids].map((id) => [id, view.getGeometryRevision(id)])),
      });
      if (kept.length > 24) kept.shift();
      // Every kept view still answers as it did when it was read, removed IDs included.
      for (const entry of kept) {
        const differing = [...ids].filter(
          (id) =>
            entry.view.getNode(id) !== entry.nodes.get(id) ||
            entry.view.getGeometryRevision(id) !== entry.revisions.get(id),
        );
        expect(differing, `step ${step}`).toEqual([]);
      }
      layered += kept.length;
    }
    expect(layered).toBeGreaterThan(4_000);
  }, 30_000);
});
