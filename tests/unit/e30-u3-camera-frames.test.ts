import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  ANY_CAMERA,
  cullRange,
  decisionRange,
  pointRange,
  rangeHolds,
} from '../../packages/renderer-core/src/camera-range.js';
import {
  bucketHint,
  bucketZoomRange,
  computePathBuckets,
  type PathLinearMap,
} from '../../packages/renderer-core/src/path-buckets.js';
import {
  reusedPathsForTesting,
  type PathMeshPipeline,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type { ClipChain } from '../../packages/renderer-core/src/clip-resolution.js';
import type { PrimitiveTarget } from '../../packages/renderer-core/src/primitive-packet.js';
import { packingCountsForTesting } from '../../packages/renderer-core/src/primitive-scene-source.js';
import {
  Model,
  identity,
  normalizer,
  random,
  randomScene,
  randomSet,
  target,
  twin,
  type Twin,
} from '../support/e26-twin-scene.js';
import { pathNode } from '../support/v3a-path-harness.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';

// E30 contract (docs/plans/d9-e30-renderer-cost-contract.md), section 4.1, U3a: the path mesh
// pipeline keeps a path's outcome over a range of cameras (its cull decision and buckets), not
// one camera. The oracle is E26-U5c's twin (reuse off, every path evaluated on every prepare),
// fed camera-only runs: pans of every size, smooth zooms across bucket boundaries, far jumps
// that move the origins or make the mesh frame non-finite, leaves entering and leaving the view.

type Camera = { x: number; y: number; zoom: number };

/** A pipeline's statistics without bucket computations, which a kept outcome skips. */
function comparable(pipeline: PathMeshPipeline): Record<string, number> {
  const statistics: Record<string, number> = { ...pipeline.getStatistics() };
  delete statistics.bucketComputations;
  return statistics;
}

function setCamera(twins: readonly Twin[], camera: Camera): void {
  for (const { mirror } of twins) {
    mirror.setCamera({ position: { x: camera.x, y: camera.y }, zoom: camera.zoom });
  }
}

/** The next camera of a camera-only run. */
function step(rng: () => number, camera: Camera): Camera {
  const move = rng();
  if (move < 0.35) {
    // A small pan, under a pixel to a few pixels.
    const size = 10 ** (-2 + rng() * 3);
    return { ...camera, x: camera.x + (rng() - 0.5) * size, y: camera.y + (rng() - 0.5) * size };
  }
  if (move < 0.55) {
    // A larger pan, so leaves enter and leave the view.
    return { ...camera, x: camera.x + (rng() - 0.5) * 120, y: camera.y + (rng() - 0.5) * 90 };
  }
  if (move < 0.8) {
    // A smooth zoom step; runs of them cross bucket boundaries.
    const factor = 1 + (rng() - 0.5) * 0.08;
    return { ...camera, zoom: Math.min(8, Math.max(0.125, camera.zoom * factor)) };
  }
  if (move < 0.9) {
    // Pan and zoom together, as the E26 path does.
    const factor = 1 + (rng() - 0.5) * 0.04;
    return {
      x: camera.x + (rng() - 0.5) * 8,
      y: camera.y + (rng() - 0.5) * 6,
      zoom: Math.min(8, Math.max(0.125, camera.zoom * factor)),
    };
  }
  if (move < 0.97) {
    // A far jump and back: the origins move.
    return Math.abs(camera.x) > 1000
      ? { ...camera, x: (rng() - 0.5) * 200, y: (rng() - 0.5) * 200 }
      : { ...camera, x: rng() < 0.5 ? -3000 : 3000, y: (rng() - 0.5) * 4000 };
  }
  // So far that the mesh frame is not finite (or the primitive frame not representable).
  return { ...camera, x: 1e30, y: -1e30 };
}

function runCameraDifferential(
  seed: number,
  frames: number,
  scene: (rng: () => number, model: Model) => void = (rng, model) =>
    randomScene(rng, model, 60 + Math.floor(rng() * 60)),
  next: (rng: () => number, camera: Camera) => Camera = step,
) {
  const rng = random(seed);
  const model = new Model();
  scene(rng, model);
  const kept = twin(false);
  const oracle = twin(true);
  const twins = [kept, oracle];
  const normalize = { kept: normalizer(), oracle: normalizer() };
  for (const { mirror } of twins) {
    expect(mirror.replaceSnapshot(model.snapshot()).status).toBe('applied');
  }
  let camera: Camera = { x: 0, y: 0, zoom: 1.3 };
  let frameTarget: PrimitiveTarget = target;
  let errors = 0;
  let cameraOnly = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    // Mostly camera-only frames; now and then a set or a surface change between runs.
    const pick = rng();
    if (pick < 0.04) {
      const set = randomSet(rng, model);
      if (set !== null) {
        for (const { mirror } of twins) expect(mirror.applyChanges(set).status).toBe('applied');
      }
    } else if (pick < 0.05) {
      frameTarget = {
        ...frameTarget,
        surfaceRevision: frameTarget.surfaceRevision + 1,
        devicePixelRatio: frameTarget.devicePixelRatio === 2 ? 1.5 : 2,
      };
    } else if (pick < 0.95) {
      camera = Math.abs(camera.x) > 1e20 ? { x: 0, y: 0, zoom: camera.zoom } : next(rng, camera);
      cameraOnly += 1;
    }
    setCamera(twins, camera);
    const prepared = twins.map(({ source }) => {
      try {
        return { packet: source.prepare(frameTarget), error: null };
      } catch (error) {
        return { packet: null, error: String(error) };
      }
    });
    const [left, right] = prepared as [(typeof prepared)[0], (typeof prepared)[0]];
    expect(left.error, `seed ${seed} frame ${frame}`).toBe(right.error);
    if (left.error !== null) errors += 1;
    expect(normalize.kept(left.packet), `seed ${seed} frame ${frame}`).toBe(
      normalize.oracle(right.packet),
    );
    expect(comparable(kept.pipeline), `seed ${seed} frame ${frame} statistics`).toEqual(
      comparable(oracle.pipeline),
    );
    if (left.packet !== null) {
      kept.source.acknowledge(receiptOf(left.packet));
      oracle.source.acknowledge(receiptOf(right.packet!));
    }
  }
  return {
    errors,
    cameraOnly,
    reused: reusedPathsForTesting(kept.pipeline),
    packing: packingCountsForTesting(kept.source),
  };
}

describe('E30-U3a camera ranges of kept path outcomes', () => {
  it('prepares the same packets as the reuse-off twin over 1,200 seeded camera-only frames', () => {
    let errors = 0;
    let cameraOnly = 0;
    const reused: number[] = [];
    const packing = { ranges: 0, ranged: 0, perCamera: 0 };
    for (const seed of [11, 12, 13, 14]) {
      const result = runCameraDifferential(seed, 300);
      errors += result.errors;
      cameraOnly += result.cameraOnly;
      reused.push(result.reused);
      packing.ranges += result.packing.ranges;
      packing.ranged += result.packing.ranged;
      packing.perCamera += result.packing.perCamera;
    }
    expect(cameraOnly).toBeGreaterThan(1000);
    // The far camera prepares in both sources (no frame throws in these seeds).
    expect(errors).toBe(0);
    expect(reused.every((count) => count > 2000)).toBe(true);
    // E30-U3b: the packing range bound decides most primitive checks of these runs.
    expect(packing.ranges).toBeGreaterThan(0);
    expect(packing.ranged).toBeGreaterThan(4 * packing.perCamera);
  }, 120_000);

  it('agrees on paths whose bounds sit within the cull guard of a clip edge', () => {
    // Paths a fraction of a world unit outside a rect clip's edge: whether they meet the clip
    // under the 2 px guard (2 / (zoom * DPR) world units) changes as the zoom sweeps.
    const scene = (rng: () => number, model: Model) => {
      const clipped = model.fresh();
      model.nodes.set(clipped, {
        id: clipped,
        parentId: null,
        transform: [1, 0, 0, 1, 0, 0],
        visible: true,
        opacity: 1,
        kind: 'container',
        clip: { kind: 'rect', x: 0, y: 0, width: 100, height: 100 },
        children: [],
      });
      model.rootOrder.push(clipped);
      const children: string[] = [];
      for (let index = 0; index < 24; index += 1) {
        const id = model.fresh();
        const gap = 0.02 + rng() * 1.6;
        const side = index % 4;
        // pathNode's triangle spans [tag, tag + 10] x [0, 10] in local units.
        const transform: [number, number, number, number, number, number] =
          side === 0
            ? [1, 0, 0, 1, 100 + gap, 20 + rng() * 60]
            : side === 1
              ? [1, 0, 0, 1, -10 - gap, 20 + rng() * 60]
              : side === 2
                ? [1, 0, 0, 1, 20 + rng() * 60, 100 + gap]
                : [1, 0, 0, 1, 20 + rng() * 60, -10 - gap];
        model.nodes.set(id, pathNode(id, 0, { parentId: clipped, transform }));
        children.push(id);
      }
      const container = model.nodes.get(clipped)!;
      model.nodes.set(clipped, { ...container, children } as typeof container);
    };
    const sweep = (rng: () => number, camera: Camera): Camera => {
      const factor = 1 + (rng() < 0.5 ? -1 : 1) * (0.005 + rng() * 0.03);
      return {
        x: -20 + (rng() - 0.5) * 2,
        y: -20 + (rng() - 0.5) * 2,
        zoom: Math.min(4, Math.max(0.3, camera.zoom * factor)),
      };
    };
    for (const seed of [21, 22]) runCameraDifferential(seed, 300, scene, sweep);
  }, 120_000);
});

function fixedTwin(nodes: readonly RenderNodeSnapshot[], camera: Camera): Twin {
  const state = twin(false);
  expect(
    state.mirror.replaceSnapshot({
      identity,
      revision: 1,
      nodes: [...nodes],
      rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
    }).status,
  ).toBe('applied');
  setCamera([state], camera);
  return state;
}

function prepare(state: Twin, camera: Camera): number {
  setCamera([state], camera);
  const before = reusedPathsForTesting(state.pipeline);
  const packet = state.source.prepare(target);
  expect(packet).not.toBeNull();
  state.source.acknowledge(receiptOf(packet!));
  return reusedPathsForTesting(state.pipeline) - before;
}

describe('E30-U3a counters', () => {
  // Ten paths in the middle of a 320 x 240 CSS view at zoom 1.3 (246 x 185 world units), one
  // culled just past its right edge.
  const nodes = [
    ...Array.from({ length: 10 }, (_, index) =>
      pathNode(`p${index}`, index * 4, { transform: [1, 0, 0, 1, 100, 100 + index * 3] }),
    ),
    pathNode('edge', 0, { transform: [1, 0, 0, 1, 260, 100] }),
  ];

  it('evaluates no path afresh on a camera-only frame inside the range', () => {
    const state = fixedTwin(nodes, { x: 0, y: 0, zoom: 1.3 });
    expect(prepare(state, { x: 0, y: 0, zoom: 1.3 })).toBe(0);
    // Pans and a small zoom keep every outcome, the culled one included.
    expect(prepare(state, { x: 3, y: -2, zoom: 1.3 })).toBe(11);
    expect(prepare(state, { x: 3.5, y: -2.25, zoom: 1.304 })).toBe(11);
    expect(prepare(state, { x: 1, y: 1, zoom: 1.295 })).toBe(11);
  });

  it('evaluates afresh only the paths whose range the camera leaves', () => {
    const state = fixedTwin(nodes, { x: 0, y: 0, zoom: 1.3 });
    prepare(state, { x: 0, y: 0, zoom: 1.3 });
    // A pan that brings the far path to the view's edge re-evaluates it alone.
    // The view's right edge (x + 320 / 1.3 + guard) reaches the edge path: it alone is
    // evaluated afresh, and its new outcome is kept on the next pan.
    expect(prepare(state, { x: 15, y: 0, zoom: 1.3 })).toBe(10);
    expect(prepare(state, { x: 15.5, y: 0.5, zoom: 1.3 })).toBe(11);
  });

  it('re-evaluates the paths whose buckets a zoom crosses, and keeps most outcomes', () => {
    // Two scales: a zoom that crosses one path's tolerance bucket keeps the other's.
    const scaled = [
      pathNode('unit', 0, { transform: [1, 0, 0, 1, 100, 100] }),
      pathNode('scaled', 0, { transform: [1.45, 0, 0, 1.45, 140, 100] }),
    ];
    const state = fixedTwin(scaled, { x: 0, y: 0, zoom: 1.3 });
    prepare(state, { x: 0, y: 0, zoom: 1.3 });
    const lanes = (scale: number): PathLinearMap => [scale, 0, 0, scale];
    // Walk the zoom up in small steps; a frame re-evaluates a path only where its buckets change.
    let zoom = 1;
    let total = 0;
    for (let index = 0; index < 120; index += 1) {
      const next = zoom * 1.006;
      const crossing = [1, 1.45].filter((scale) => {
        const before = computePathBuckets(lanes(scale), zoom, target.devicePixelRatio);
        const after = computePathBuckets(lanes(scale), next, target.devicePixelRatio);
        return (
          !before.singular && !after.singular && (before.e !== after.e || before.f !== after.f)
        );
      }).length;
      zoom = next;
      const reused = prepare(state, { x: 0, y: 0, zoom });
      // A crossing path is evaluated afresh; the zoom ratio of a range may also end it early,
      // never more paths than the scene has.
      expect(reused).toBeLessThanOrEqual(2 - crossing);
      total += reused;
    }
    // 216 of 240 outcomes are kept over the walk (deterministic): a step re-evaluates only its
    // crossing paths and the few whose zoom ratio ran out.
    expect(total).toBeGreaterThanOrEqual(200);
  });
});

describe('E30-U3a range arithmetic', () => {
  const view = { width: 640, height: 480, devicePixelRatio: 2 };

  it('holds a bucket range only where the buckets hold', () => {
    const rng = random(5);
    let widened = 0;
    for (let index = 0; index < 400; index += 1) {
      const scale = 0.05 + rng() * 20;
      const angle = rng() * Math.PI;
      const linear: PathLinearMap = [
        scale * Math.cos(angle),
        scale * Math.sin(angle) * (0.3 + rng()),
        -scale * Math.sin(angle),
        scale * Math.cos(angle),
      ];
      const zoom = 0.1 + rng() * 6;
      const buckets = computePathBuckets(linear, zoom, view.devicePixelRatio);
      const hint = bucketHint(linear, buckets);
      if (hint === null) continue;
      const [low, high] = bucketZoomRange(hint, zoom, view.devicePixelRatio, zoom / 2, zoom * 2);
      if (high > low) widened += 1;
      expect(low).toBeLessThanOrEqual(zoom);
      expect(high).toBeGreaterThanOrEqual(zoom);
      for (let sample = 0; sample <= 16; sample += 1) {
        const at = low + ((high - low) * sample) / 16;
        const exact = computePathBuckets(linear, at, view.devicePixelRatio);
        expect(exact.singular).toBe(false);
        if (exact.singular || buckets.singular) continue;
        // f may be -0 for +0 (the hint's note): the same exponent.
        expect(exact.e === buckets.e && exact.f === buckets.f).toBe(true);
      }
    }
    expect(widened).toBeGreaterThan(300);
  });

  it('keeps every cull decision over its box and zoom interval', () => {
    const rng = random(9);
    const viewport = (camera: { x: number; y: number; zoom: number }) => {
      const guard = 2 / (camera.zoom * view.devicePixelRatio);
      return {
        minX: camera.x - guard,
        minY: camera.y - guard,
        maxX: camera.x + view.width / view.devicePixelRatio / camera.zoom + guard,
        maxY: camera.y + view.height / view.devicePixelRatio / camera.zoom + guard,
      };
    };
    const meets = (
      bounds: { minX: number; minY: number; maxX: number; maxY: number },
      box: ReturnType<typeof viewport>,
    ) =>
      bounds.maxX >= box.minX &&
      bounds.minX <= box.maxX &&
      bounds.maxY >= box.minY &&
      bounds.minY <= box.maxY;
    let ranged = 0;
    for (let index = 0; index < 300; index += 1) {
      const camera = { x: (rng() - 0.5) * 400, y: (rng() - 0.5) * 300, zoom: 0.25 + rng() * 4 };
      const items = Array.from({ length: 6 }, () => {
        const minX = (rng() - 0.5) * 900;
        const minY = (rng() - 0.5) * 700;
        const bounds = {
          minX,
          minY,
          maxX: minX + rng() * 60,
          maxY: minY + rng() * 60,
        };
        return { bounds, clip: null, drawn: meets(bounds, viewport(camera)) };
      });
      const range = decisionRange(
        { position: { x: camera.x, y: camera.y }, zoom: camera.zoom },
        view,
        undefined,
        items,
      );
      expect(rangeHolds(range, { position: { x: camera.x, y: camera.y }, zoom: camera.zoom })).toBe(
        true,
      );
      if (range.zoomMax > range.zoomMin) ranged += 1;
      for (let sample = 0; sample < 40; sample += 1) {
        const at = {
          x: range.minX + (range.maxX - range.minX) * rng(),
          y: range.minY + (range.maxY - range.minY) * rng(),
          zoom: range.zoomMin + (range.zoomMax - range.zoomMin) * rng(),
        };
        if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
        for (const item of items) expect(meets(item.bounds, viewport(at))).toBe(item.drawn);
      }
    }
    expect(ranged).toBeGreaterThan(100);
  });

  it('declines a zoom interval over which a clip chain test changes', () => {
    const camera = { position: { x: 0, y: 0 }, zoom: 1 };
    const bounds = { minX: 10, minY: 10, maxX: 20, maxY: 20 };
    // The clip's edge is 0.9 world units from the bounds: met with the 1-unit guard at zoom 1.
    const clip: ClipChain = {
      key: 'clip',
      levels: [],
      empty: false,
      bounds: [{ minX: 20.9, minY: 0, maxX: 40, maxY: 40 }],
    };
    expect(cullRange(camera, view, 1, 1, [{ bounds, clip, drawn: true }])).not.toBeNull();
    // At zoom 1.2 the guard is 0.83 units, so the chain test fails inside the interval.
    expect(cullRange(camera, view, 1 / 1.2, 1.2, [{ bounds, clip, drawn: true }])).toBeNull();
    expect(rangeHolds(ANY_CAMERA, camera)).toBe(true);
    expect(rangeHolds(pointRange(camera), { ...camera, zoom: 1.0000001 })).toBe(false);
  });
});
