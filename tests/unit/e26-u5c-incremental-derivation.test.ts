import type { RenderChangeSet, RenderNodeSnapshot } from '@vector-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import * as packing from '../../packages/renderer-core/src/primitive-packing.js';
import {
  PathMeshPipeline,
  disablePathReuseForTesting,
  reusedPathsForTesting,
  type PathMeshDraw,
  type PathMeshLimits,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { derivationCountsForTesting } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { selectMeshOrigin } from '../../packages/renderer-core/src/path-mesh-packet.js';
import {
  ScriptedFillMeshPort,
  createCountingPort,
  createPathHarness,
  failedResult,
  identity as pathIdentity,
  meshBytes,
  okResult,
  pathNode,
  squareMesh,
  target as pathTarget,
} from '../support/v3a-path-harness.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';
import {
  Model,
  drawn,
  identity,
  isolationSets,
  normalizer,
  random,
  randomScene,
  randomSet,
  target,
  twin,
} from '../support/e26-twin-scene.js';

// E26 contract, U5c (section 4.4.1): the primitive source keeps its derivation between frames,
// re-derives only the leaves a set wrote (patch) or the whole scene otherwise, assesses the
// packing budget once per primitive and inputs, and skips the packing keys of kept primitives.
// The oracle is a twin source on the pre-U5c path (`useFullDerivationForTesting`), fed the same
// sets, cameras and receipts: every packet must be identical. Every 50th frame a fresh source on
// the same scene and camera must draw the same things.

// Counts the packing assessments while keeping the real functions; `failing.on` makes every
// assessment exceed the budget (and the U5d bound decline), so a frame throws as a far jump at a
// high zoom would.
const failing = vi.hoisted(() => ({ on: false }));
vi.mock('../../packages/renderer-core/src/primitive-packing.js', async (original) => {
  const actual =
    await original<typeof import('../../packages/renderer-core/src/primitive-packing.js')>();
  return {
    ...actual,
    assessPrimitivePacking: vi.fn((...args: Parameters<typeof actual.assessPrimitivePacking>) =>
      failing.on
        ? { quantizationPhysicalPixels: 1, arithmeticPhysicalPixels: 0 }
        : actual.assessPrimitivePacking(...args),
    ),
    primitivePackingWithinBudget: vi.fn(
      (...args: Parameters<typeof actual.primitivePackingWithinBudget>) =>
        !failing.on && actual.primitivePackingWithinBudget(...args),
    ),
  };
});
const assessments = vi.mocked(packing.assessPrimitivePacking);
const bounds = vi.mocked(packing.primitivePackingWithinBudget);

function runDifferential(seed: number, frames: number, limits?: Partial<PathMeshLimits>) {
  const rng = random(seed);
  const model = new Model();
  randomScene(rng, model, 60 + Math.floor(rng() * 60));
  const incremental = twin(false, limits);
  const oracle = twin(true, limits);
  const normalize = { incremental: normalizer(), oracle: normalizer() };
  for (const { mirror } of [incremental, oracle]) {
    expect(mirror.replaceSnapshot(model.snapshot()).status).toBe('applied');
  }
  let camera = { x: 0, y: 0, zoom: 1 };
  let frameTarget = target;
  let compared = 0;
  let fresh = 0;
  let errors = 0;
  let unacknowledged = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const step = rng();
    const sets: RenderChangeSet[] = [];
    failing.on = false;
    // A new surface generation, or a resize or DPR change, now and then.
    const surface = rng();
    if (surface < 0.03) frameTarget = { ...frameTarget, generation: frameTarget.generation + 1 };
    else if (surface < 0.06) {
      frameTarget = {
        ...frameTarget,
        surfaceRevision: frameTarget.surfaceRevision + 1,
        width: frameTarget.width === 640 ? 800 : 640,
        devicePixelRatio: frameTarget.devicePixelRatio === 2 ? 1.5 : 2,
      };
    }
    if (step < 0.45) {
      const set = randomSet(rng, model);
      if (set !== null) sets.push(set);
    } else if (step < 0.5) {
      sets.push(...isolationSets(model));
    } else if (step < 0.75) {
      // Pan, zoom, or a far jump that moves the primitive and mesh origins.
      const before = camera;
      const move = rng();
      camera =
        move < 0.3
          ? { ...camera, x: camera.x + (rng() - 0.5) * 60, y: camera.y + (rng() - 0.5) * 60 }
          : move < 0.45
            ? { ...camera, x: camera.x + (rng() - 0.5) * 60 }
            : move < 0.6
              ? { ...camera, y: camera.y + (rng() - 0.5) * 60 }
              : move < 0.85
                ? {
                    ...camera,
                    zoom: Math.min(8, Math.max(0.125, camera.zoom * (rng() < 0.5 ? 0.7 : 1.4))),
                  }
                : // A far jump and back, so the scene is in view about half of the time.
                  Math.abs(camera.x) > 1000
                  ? { ...camera, x: (rng() - 0.5) * 200, y: (rng() - 0.5) * 200 }
                  : { ...camera, x: rng() < 0.5 ? -3000 : 3000, y: (rng() - 0.5) * 4000 };
      // The new camera's assessments fail on some frames; both sources must throw the same. A
      // zoom at its bound leaves the camera, and so the memo's inputs, unchanged: the injected
      // failure would then break the assessment's purity, which the memo relies on.
      failing.on =
        rng() < 0.25 &&
        (camera.x !== before.x || camera.y !== before.y || camera.zoom !== before.zoom);
    }
    // Otherwise a frame with no change.
    for (const set of sets) {
      const results = [incremental, oracle].map(({ mirror }) => mirror.applyChanges(set).status);
      expect(results, `frame ${frame}`).toEqual(['applied', 'applied']);
    }
    for (const { mirror } of [incremental, oracle]) {
      mirror.setCamera({ position: { x: camera.x, y: camera.y }, zoom: camera.zoom });
    }
    const prepared = [incremental, oracle].map(({ source }) => {
      try {
        return { packet: source.prepare(frameTarget), error: null };
      } catch (error) {
        return { packet: null, error: String(error) };
      }
    });
    failing.on = false;
    const [left, right] = prepared as [(typeof prepared)[0], (typeof prepared)[0]];
    expect(left.error, `frame ${frame}`).toBe(right.error);
    if (left.error !== null) errors += 1;
    expect(normalize.incremental(left.packet), `frame ${frame}`).toBe(
      normalize.oracle(right.packet),
    );
    compared += 1;
    // The pipelines' statistics match too: entries, bytes, evictions and port calls. Bucket
    // computations are left out, since a kept outcome does not look its buckets up.
    expect(comparable(incremental.pipeline), `frame ${frame} statistics`).toEqual(
      comparable(oracle.pipeline),
    );
    // Some packets are replaced without a receipt.
    if (left.packet !== null && rng() < 0.1) unacknowledged += 1;
    else if (left.packet !== null) {
      incremental.source.acknowledge(receiptOf(left.packet));
      oracle.source.acknowledge(receiptOf(right.packet!));
    }
    if (frame % 50 === 49 && left.packet !== null) {
      const check = twin(true);
      check.mirror.replaceSnapshot(model.snapshot());
      check.mirror.setCamera({ position: { x: camera.x, y: camera.y }, zoom: camera.zoom });
      const packet = check.source.prepare(frameTarget);
      expect(drawn(check, packet), `frame ${frame} fresh`).toEqual(drawn(incremental, left.packet));
      fresh += 1;
    }
  }
  return {
    compared,
    fresh,
    errors,
    unacknowledged,
    counts: derivationCountsForTesting(incremental.source),
    pipeline: incremental.pipeline.getStatistics(),
    reusedPaths: reusedPathsForTesting(incremental.pipeline),
  };
}

/** A pipeline's statistics without bucket computations, which a kept outcome skips. */
function comparable(pipeline: PathMeshPipeline): Record<string, number> {
  const statistics: Record<string, number> = { ...pipeline.getStatistics() };
  delete statistics.bucketComputations;
  return statistics;
}

describe('E26-U5c kept and patched derivation', () => {
  it('prepares the same packets as the pre-U5c path over 1,200 seeded frames', () => {
    let compared = 0;
    let fresh = 0;
    let errors = 0;
    let unacknowledged = 0;
    const counts = { reused: 0, patched: 0, full: 0 };
    const stats: { evictions: number; reused: number }[] = [];
    // Seeds 3 and 4 run the path mesh pipeline under a small byte budget and memo, so entries
    // are evicted and trimmed between frames.
    for (const seed of [1, 2, 3, 4]) {
      const result = runDifferential(
        seed,
        300,
        seed < 3 ? undefined : { byteBudget: 24_576, memoCapacity: 8 },
      );
      compared += result.compared;
      fresh += result.fresh;
      errors += result.errors;
      unacknowledged += result.unacknowledged;
      counts.reused += result.counts.reused;
      counts.patched += result.counts.patched;
      counts.full += result.counts.full;
      stats.push({ evictions: result.pipeline.evictions, reused: result.reusedPaths });
    }
    expect(compared).toBe(1200);
    expect(fresh).toBeGreaterThanOrEqual(20);
    // Thrown frames and packets replaced without a receipt are both exercised.
    expect(errors).toBeGreaterThan(10);
    expect(unacknowledged).toBeGreaterThan(50);
    // Every path is taken many times.
    expect(counts.reused).toBeGreaterThan(300);
    expect(counts.patched).toBeGreaterThan(100);
    expect(counts.full).toBeGreaterThan(100);
    // The pipeline serves kept path outcomes, and evicts under the small budget.
    expect(stats.every((entry) => entry.reused > 1000)).toBe(true);
    expect(stats[2]!.evictions + stats[3]!.evictions).toBeGreaterThan(20);
  }, 120_000);
});

function rect(id: string, x: number, parentId: string | null = null): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, 10],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 40, height: 40, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 0, g: 0, b: 1, a: 1 }, stroke: null },
  };
}

/** Both twins on the scene, then each frame's sets and camera; every packet must match. */
function scripted(
  nodes: readonly RenderNodeSnapshot[],
  frames: readonly Readonly<{ sets?: readonly RenderChangeSet[]; x?: number }>[],
) {
  const incremental = twin(false);
  const oracle = twin(true);
  const normalize = { incremental: normalizer(), oracle: normalizer() };
  const packets: PrimitivePacket[] = [];
  for (const { mirror } of [incremental, oracle]) {
    mirror.replaceSnapshot({
      identity,
      revision: 1,
      nodes,
      rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
    });
  }
  for (const [index, frame] of frames.entries()) {
    for (const set of frame.sets ?? []) {
      for (const { mirror } of [incremental, oracle]) {
        expect(mirror.applyChanges(set).status).toBe('applied');
      }
    }
    for (const { mirror } of [incremental, oracle]) {
      mirror.setCamera({ position: { x: frame.x ?? 0, y: 0 }, zoom: 1 });
    }
    const left = incremental.source.prepare(target)!;
    const right = oracle.source.prepare(target)!;
    expect(normalize.incremental(left), `frame ${index}`).toBe(normalize.oracle(right));
    incremental.source.acknowledge(receiptOf(left));
    oracle.source.acknowledge(receiptOf(right));
    packets.push(left);
  }
  return { packets, counts: derivationCountsForTesting(incremental.source) };
}

function update(revision: number, updated: RenderNodeSnapshot[]): RenderChangeSet {
  return {
    identity,
    revision,
    baseRevision: revision - 1,
    inserted: [],
    updated,
    removed: [],
    orders: [],
  };
}

describe('E26-U5c kept path outcomes across a frame that is not clean', () => {
  // A path evaluated afresh drops its kept outcome, so neither its evicted entries nor the mesh
  // origin of an earlier frame under the same camera are served again (U5c-2 review S1 to S3).
  // Each scenario runs with the pipeline's reuse on and off; the draws and statistics match.
  const both = <T>(scenario: (reuse: boolean) => T): T => {
    const kept = scenario(true);
    expect(kept).toEqual(scenario(false));
    return kept;
  };
  const view = (draws: readonly PathMeshDraw[]) =>
    draws.map((draw) => ({
      nodeId: draw.nodeId,
      offsets: Array.from(draw.offsets ?? []),
      linear: Array.from(draw.linear ?? []),
      anchor: draw.anchor,
    }));
  const statistics = (harness: ReturnType<typeof createPathHarness>) =>
    comparable(harness.pipeline);

  it('does not serve a kept outcome whose entry a failing frame evicted', () => {
    const frames = both((reuse) => {
      let fail = false;
      const port = new ScriptedFillMeshPort({
        request: (request) => (fail ? failedResult(request, 'invalid-path') : okResult(request)),
      });
      const harness = createPathHarness({
        port,
        nodes: [pathNode('a', 0)],
        limits: { byteBudget: 1 },
      });
      if (!reuse) disablePathReuseForTesting(harness.pipeline);
      harness.setZoom(1);
      const first = [harness.drawnIds(), harness.drawnIds()];
      fail = true;
      harness.setZoom(8);
      const failing = harness.drawnIds();
      harness.setZoom(1);
      const back = harness.drawnIds();
      fail = false;
      const recovered = harness.drawnIds();
      return { first, failing, back, recovered, statistics: statistics(harness) };
    });
    expect(frames.first).toEqual([['a'], ['a']]);
    expect(frames.failing).toEqual([]);
    expect(frames.back).toEqual([]);
    expect(frames.statistics.evictions).toBeGreaterThan(0);
  });

  it('stamps the entries of a kept outcome as served, for the eviction order of the budget', () => {
    // a is drawn on frame 1 and kept on frames 2 and 3; b is drawn on frame 2 and hidden on
    // frame 3. Panning to c evicts the least recently served entry: b's, not a's.
    const frames = both((reuse) => {
      const port = createCountingPort();
      const nodes = [pathNode('a', 0), pathNode('b', 20, { visible: false }), pathNode('c', 5000)];
      const harness = createPathHarness({
        port,
        nodes,
        limits: { byteBudget: 2 * meshBytes(squareMesh()) },
      });
      if (!reuse) disablePathReuseForTesting(harness.pipeline);
      let revision = 1;
      const update = (node: RenderNodeSnapshot) => {
        revision += 1;
        const result = harness.mirror.applyChanges({
          identity: pathIdentity,
          revision,
          baseRevision: revision - 1,
          inserted: [],
          updated: [node],
          removed: [],
          orders: [],
        });
        expect(result.status).toBe('applied');
      };
      harness.setZoom(1);
      const drawn = [harness.drawnIds()];
      update(pathNode('b', 20));
      drawn.push(harness.drawnIds());
      update(pathNode('b', 20, { visible: false }));
      drawn.push(harness.drawnIds());
      harness.setZoom(1, { x: 4900, y: 0 });
      drawn.push(harness.drawnIds());
      harness.setZoom(1);
      drawn.push(harness.drawnIds());
      return { drawn, statistics: statistics(harness) };
    });
    expect(frames.drawn).toEqual([['a'], ['a', 'b'], ['a'], ['c'], ['a']]);
    expect(frames.statistics.evictions).toBeGreaterThan(0);
  });

  it('serves the mesh origin of the frame, not of a kept outcome under the same camera', () => {
    const g = selectMeshOrigin({ x: 0, y: 0 }, 1, pathTarget.devicePixelRatio, null)!.g;
    const frames = both((reuse) => {
      const port = createCountingPort();
      const harness = createPathHarness({
        port,
        nodes: [pathNode('a', 0, { points: [0, 0, 1000, 0, 1000, 300] })],
      });
      if (!reuse) disablePathReuseForTesting(harness.pipeline);
      harness.setZoom(1, { x: 0, y: 0 });
      const first = [view(harness.prepare().draws), view(harness.prepare().draws)];
      port.setPortVersion(1);
      harness.setZoom(1, { x: 2.5 * g, y: 0 });
      const unclean = harness.drawnIds();
      port.setPortVersion(0);
      harness.setZoom(1, { x: 0, y: 0 });
      return { first, unclean, back: view(harness.prepare().draws) };
    });
    expect(frames.unclean).toEqual([]);
    // The origin moved during the unclean frame, so the same camera now packs other lanes.
    expect(frames.back).not.toEqual(frames.first[0]);
  });
});

describe('E26-U5c derivation paths', () => {
  it('keeps the derivation on a frame without a set and patches one written leaf', () => {
    const nodes = [rect('a', 0), rect('b', 60), rect('c', 120)];
    const { counts } = scripted(nodes, [{}, {}, { x: 30 }, { sets: [update(2, [rect('b', 70)])] }]);
    // One full derivation of 3 leaves, two kept frames, one patch of 1 leaf.
    expect(counts).toEqual({ reused: 2, patched: 1, full: 1, leaves: 4 });
  });

  it('derives in full when a written leaf is a mask source', () => {
    const mask: RenderNodeSnapshot = {
      id: 'm',
      parentId: null,
      transform: [1, 0, 0, 1, 0, 0],
      visible: true,
      opacity: 1,
      kind: 'container',
      clip: { kind: 'mask' },
      children: ['s', 'c'],
    };
    const source = rect('s', 0, 'm');
    const content = rect('c', 10, 'm');
    // Moving the source away empties the mask, so the content is no longer drawn.
    const { packets, counts } = scripted(
      [mask, source, content],
      [{}, { sets: [update(2, [{ ...source, transform: [1, 0, 0, 1, 5000, 10] }])] }],
    );
    expect(counts.patched).toBe(0);
    expect(counts.full).toBe(2);
    expect(packets[1]!.draws).not.toEqual(packets[0]!.draws);
  });

  it('derives in full after a container, root order or structure change', () => {
    const group: RenderNodeSnapshot = {
      id: 'g',
      parentId: null,
      transform: [1, 0, 0, 1, 0, 0],
      visible: true,
      opacity: 1,
      kind: 'container',
      clip: null,
      children: ['a'],
    };
    const { counts } = scripted(
      [group, rect('a', 0, 'g'), rect('b', 60)],
      [
        {},
        { sets: [update(2, [{ ...group, transform: [1, 0, 0, 1, 5, 5] }])] },
        {
          sets: [
            {
              identity,
              revision: 3,
              baseRevision: 2,
              inserted: [],
              updated: [],
              removed: [],
              orders: [{ parentId: null, children: ['b', 'g'] }],
            },
          ],
        },
        {
          sets: [
            {
              identity,
              revision: 4,
              baseRevision: 3,
              inserted: [rect('c', 200)],
              updated: [],
              removed: [],
              orders: [{ parentId: null, children: ['b', 'g', 'c'] }],
            },
          ],
        },
      ],
    );
    expect(counts).toMatchObject({ reused: 0, patched: 0, full: 4 });
  });

  it('rewrites the transforms when a frame that moved the origin threw', () => {
    // Frame 1 at the first origin; frame 2 jumps 5,000 and throws after selecting the new
    // origin; frame 3 at the same camera keeps that origin and must rebase the transforms.
    const nodes = [rect('a', 0), rect('b', 5060)];
    const incremental = twin(false);
    const oracle = twin(true);
    const normalize = { incremental: normalizer(), oracle: normalizer() };
    for (const { mirror } of [incremental, oracle]) {
      mirror.replaceSnapshot({ identity, revision: 1, nodes, rootOrder: ['a', 'b'] });
    }
    const frame = (x: number, fail: boolean) => {
      failing.on = fail;
      try {
        return [incremental, oracle].map(({ mirror, source }) => {
          mirror.setCamera({ position: { x, y: 0 }, zoom: 1 });
          try {
            const packet = source.prepare(target)!;
            source.acknowledge(receiptOf(packet));
            return packet;
          } catch {
            return null;
          }
        });
      } finally {
        failing.on = false;
      }
    };
    frame(0, false);
    expect(frame(5000, true)).toEqual([null, null]);
    const [left, right] = frame(5000, false);
    expect(normalize.incremental(left!)).toBe(normalize.oracle(right!));
    expect(left!.writes.some((write) => write.resourceId === 'transforms')).toBe(true);
  });

  it('checks a kept primitive once per camera, target and origin', () => {
    const nodes = Array.from({ length: 10 }, (_, index) => rect(`r${index}`, index * 50));
    const incremental = twin(false);
    incremental.mirror.replaceSnapshot({
      identity,
      revision: 1,
      nodes,
      rootOrder: nodes.map((node) => node.id),
    });
    const frame = (x: number, next: PrimitiveTarget = target) => {
      incremental.mirror.setCamera({ position: { x, y: 0 }, zoom: 1 });
      assessments.mockClear();
      bounds.mockClear();
      const packet = incremental.source.prepare(next)!;
      incremental.source.acknowledge(receiptOf(packet));
      // U5d: the unclipped bound decides these primitives, so none reaches the assessment.
      expect(assessments.mock.calls.length).toBe(0);
      return bounds.mock.calls.length;
    };
    const visible = frame(0);
    expect(visible).toBeGreaterThan(0);
    expect(frame(0)).toBe(0);
    // A camera move, a new target and a return to the first camera each assess again.
    expect(frame(10)).toBe(visible);
    expect(frame(10, { ...target, width: 600 })).toBeGreaterThan(0);
    expect(frame(0)).toBeGreaterThan(0);
    // The oracle assesses every visible primitive twice, as before U5c, without the bound.
    const oracle = twin(true);
    oracle.mirror.replaceSnapshot({
      identity,
      revision: 1,
      nodes,
      rootOrder: nodes.map((n) => n.id),
    });
    oracle.mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    oracle.source.acknowledge(receiptOf(oracle.source.prepare(target)!));
    assessments.mockClear();
    bounds.mockClear();
    oracle.source.prepare(target);
    expect(assessments.mock.calls.length).toBe(2 * visible);
    expect(bounds.mock.calls.length).toBe(0);
  });
});

describe('E26-U5c mirror change log', () => {
  const setOf = (revision: number, parts: Partial<RenderChangeSet>): RenderChangeSet => ({
    identity,
    revision,
    baseRevision: revision - 1,
    inserted: [],
    updated: [],
    removed: [],
    orders: [],
    ...parts,
  });

  it('lists the IDs written between two views and forgets them at a snapshot', () => {
    const mirror = twin(false).mirror;
    mirror.replaceSnapshot({ identity, revision: 1, nodes: [rect('a', 0)], rootOrder: ['a'] });
    const first = mirror.readRetainedScene()!;
    expect(first.changedSince(first.changeSerial)).toEqual([]);
    mirror.applyChanges(setOf(2, { updated: [rect('a', 5)] }));
    mirror.applyChanges(
      setOf(3, { inserted: [rect('b', 9)], orders: [{ parentId: null, children: ['a', 'b'] }] }),
    );
    const second = mirror.readRetainedScene()!;
    expect(second.changedSince(first.changeSerial)).toEqual(['a', 'b']);
    expect(second.changedSince(second.changeSerial)).toEqual([]);
    // A root order change alone writes no ID; the reader compares rootOrder.
    mirror.applyChanges(setOf(4, { orders: [{ parentId: null, children: ['b', 'a'] }] }));
    const third = mirror.readRetainedScene()!;
    expect(third.changedSince(second.changeSerial)).toEqual([]);
    expect(third.rootOrder).toEqual(['b', 'a']);
    // A serial from the future or not an integer is unknown.
    expect(second.changedSince(third.changeSerial + 1)).toBeNull();
    expect(third.changedSince(0.5)).toBeNull();
    mirror.replaceSnapshot({ identity, revision: 5, nodes: [rect('a', 0)], rootOrder: ['a'] });
    const fourth = mirror.readRetainedScene()!;
    expect(fourth.changedSince(third.changeSerial)).toBeNull();
    expect(third.changedSince(first.changeSerial)).toBeNull();
    expect(fourth.changedSince(fourth.changeSerial)).toEqual([]);
  });

  it('answers null for sets published by the full oracle and past the log cap', async () => {
    const { useFullChangeValidationForTesting } =
      await import('../../packages/renderer-core/src/scene-mirror.js');
    const full = twin(false).mirror;
    useFullChangeValidationForTesting(full);
    full.replaceSnapshot({ identity, revision: 1, nodes: [rect('a', 0)], rootOrder: ['a'] });
    const before = full.readRetainedScene()!;
    full.applyChanges(setOf(2, { updated: [rect('a', 5)] }));
    expect(full.readRetainedScene()!.changedSince(before.changeSerial)).toBeNull();

    const mirror = twin(false).mirror;
    const ids = Array.from({ length: 40_000 }, (_, index) => `r${index}`);
    mirror.replaceSnapshot({
      identity,
      revision: 1,
      nodes: ids.map((id) => rect(id, 0)),
      rootOrder: ids,
    });
    const start = mirror.readRetainedScene()!;
    mirror.applyChanges(setOf(2, { updated: ids.map((id) => rect(id, 1)) }));
    const middle = mirror.readRetainedScene()!;
    expect(middle.changedSince(start.changeSerial)).toHaveLength(40_000);
    // 80,000 logged IDs pass the 65,536 cap: earlier serials are forgotten.
    mirror.applyChanges(setOf(3, { updated: ids.map((id) => rect(id, 2)) }));
    const last = mirror.readRetainedScene()!;
    expect(last.changedSince(start.changeSerial)).toBeNull();
    expect(last.changedSince(middle.changeSerial)).toBeNull();
    expect(last.changedSince(last.changeSerial)).toEqual([]);
  });
});
