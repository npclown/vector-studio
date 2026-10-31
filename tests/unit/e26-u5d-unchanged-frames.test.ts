import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { PathMeshPipeline } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import {
  PrimitiveSceneSource,
  useFullDerivationForTesting,
} from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import {
  ClipStateTable,
  MaskLevelMemo,
  MaskPlan,
  type ClipChain,
  type ClipMaskLevel,
  type MaskPlanInput,
} from '../../packages/renderer-core/src/clip-resolution.js';
import {
  disablePathReuseForTesting,
  reusedPathsForTesting,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import {
  ScriptedStrokeMeshPort,
  createStrokeHarness,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';
import {
  createCountingPort,
  createFailingPort,
  createPathHarness,
  pathNode,
  target,
} from '../support/v3a-path-harness.js';

// E26 contract (docs/plans/d9-e26-pointer-priority-contract.md), section 4.4.1, U5d-2: per-draw
// work on unchanged frames. The path mesh pipeline serves the last prepare's draws again when
// every path in it kept its outcome (joint fill draws and memoized failures included), the
// mesh packer skips a record whose inputs are the same, and the clip states and mask levels
// keep their records. The twin (reuse off) must agree on every frame.

const PERMANENT = 300;
const EXPIRING = 400;

function scene(): RenderNodeSnapshot[] {
  return [
    pathNode('plain-a', 0),
    pathNode('plain-b', 40),
    strokedNode('joint', 80, { opacity: 0.5 }),
    strokedNode('stroked', 120),
    pathNode('permanent', PERMANENT),
    pathNode('expiring', EXPIRING),
  ];
}

function harness(reuse: boolean) {
  const fill = createFailingPort({
    pathFailures: new Map([[PERMANENT, 'work-limit']]),
    batchFailures: new Map([[EXPIRING, 'resource-limit']]),
  });
  const stroke = new ScriptedStrokeMeshPort();
  const h = createStrokeHarness({
    fillPort: fill,
    strokePort: stroke,
    nodes: scene(),
    limits: { resourceLimitExpiryPrepares: 5 },
  });
  if (!reuse) disablePathReuseForTesting(h.pipeline);
  h.mirror.setCamera({ position: { x: -10, y: -10 }, zoom: 1 });
  return { ...h, fill, stroke };
}

type Harness = ReturnType<typeof harness>;

function observe(h: Harness) {
  const frame = h.prepare();
  const statistics = { ...h.pipeline.getStatistics() } as Record<string, unknown>;
  // A kept outcome does not look its buckets up (U5c-2), so the counts differ by design.
  delete statistics.bucketComputations;
  return {
    draws: frame.draws,
    view: {
      drawn: frame.draws.map((draw) => `${draw.nodeId}:${draw.paint ?? 'fill'}:${draw.composite}`),
      notices: frame.notices,
      fillCalls: h.fill.callCount,
      strokeCalls: h.stroke.calls.length,
      statistics,
    },
  };
}

describe('E26 U5d-2: the path pipeline on unchanged frames', () => {
  it('serves the last draws again, and agrees with the twin through expiry, zoom and edits', () => {
    const on = harness(true);
    const off = harness(false);
    let sameArray = 0;
    let previous: readonly unknown[] | null = null;
    const step = (action: (h: Harness) => void = () => {}) => {
      action(on);
      action(off);
      const left = observe(on);
      const right = observe(off);
      expect(left.view).toEqual(right.view);
      if (left.draws === previous) sameArray += 1;
      previous = left.draws;
    };
    for (let frame = 0; frame < 14; frame += 1) step();
    step((h) => h.mirror.setCamera({ position: { x: -10, y: -10 }, zoom: 1.5 }));
    for (let frame = 0; frame < 8; frame += 1) step();
    step((h) =>
      h.replace(scene().map((node) => (node.id === 'plain-b' ? pathNode('plain-b', 44) : node))),
    );
    for (let frame = 0; frame < 8; frame += 1) step();
    // The joint path and the permanently failing path are kept, so whole frames are served
    // again; the expiring memo ends a run of them every five prepares.
    expect(sameArray).toBeGreaterThanOrEqual(8);
    expect(reusedPathsForTesting(on.pipeline)).toBeGreaterThan(100);
    // The expiring failure was asked again after each expiry, by both pipelines alike.
    expect(on.fill.callCount).toBeGreaterThan(4);
  });

  it('evaluates afresh once an entry a kept frame served is evicted', () => {
    const on = harness(true);
    const off = harness(false);
    for (let frame = 0; frame < 4; frame += 1) {
      expect(observe(on).view).toEqual(observe(off).view);
    }
    // A zoom far away makes other entries; the byte budget then evicts the first ones.
    for (const h of [on, off]) h.mirror.setCamera({ position: { x: -10, y: -10 }, zoom: 64 });
    expect(observe(on).view).toEqual(observe(off).view);
    for (const h of [on, off]) h.mirror.setCamera({ position: { x: -10, y: -10 }, zoom: 1 });
    for (let frame = 0; frame < 4; frame += 1) {
      expect(observe(on).view).toEqual(observe(off).view);
    }
  });

  it("stamps a served frame's entries, so the byte budget evicts as the twin does", () => {
    // Two 152-byte entries fit the budget. Path b is served alone for ten frames while path a's
    // entry ages; a zoom onto a then needs a third entry, and the budget must evict a's old entry,
    // not b's (which an unstamped served frame would leave older).
    const run = (reuse: boolean) => {
      const port = createCountingPort();
      const h = createPathHarness({
        port,
        nodes: [pathNode('a', 0), pathNode('b', 300)],
        limits: { byteBudget: 304 },
      });
      if (!reuse) disablePathReuseForTesting(h.pipeline);
      const log: unknown[] = [];
      const frame = () => log.push([h.drawnIds(), port.callCount, h.statistics().evictions]);
      h.setZoom(1, { x: -10, y: -10 });
      for (let index = 0; index < 3; index += 1) frame();
      h.setZoom(1, { x: 250, y: -10 });
      for (let index = 0; index < 10; index += 1) frame();
      h.setZoom(4, { x: -2, y: -2 });
      frame();
      h.setZoom(1, { x: 250, y: -10 });
      frame();
      return { log, calls: port.callCount };
    };
    const kept = run(true);
    expect(kept).toEqual(run(false));
    // b's entry stayed resident: returning to it called no port.
    expect(kept.calls).toBe(2);
  });

  it('keeps a joint fill outcome only while its overlay is held', () => {
    const on = harness(true);
    observe(on);
    observe(on);
    const before = reusedPathsForTesting(on.pipeline);
    observe(on);
    // Every non-hidden path was kept on the third frame: four drawn paths and two failures.
    expect(reusedPathsForTesting(on.pipeline) - before).toBe(6);
  });
});

describe('E26 U5d-2: clip states and mask levels', () => {
  const chain = (key: string, levels: ClipChain['levels'], bounds: ClipChain['bounds']) =>
    Object.freeze({ key, levels, bounds, empty: false }) as ClipChain;
  const mask = (id: string): ClipMaskLevel =>
    Object.freeze({
      kind: 'mask',
      containerId: id,
      world: [1, 0, 0, 1, 0, 0],
      sourceId: `${id}-src`,
    });
  const rect = (id: string) =>
    Object.freeze({
      kind: 'rect' as const,
      containerId: id,
      toLocal: [1, 0, 0, 1, 0, 0] as const,
      width: 10,
      height: 10,
    });
  const bound = Object.freeze({ minX: 0, minY: 0, maxX: 50, maxY: 50 });

  it('keeps a chain record while the chain object and its index stay, as a fresh table builds it', () => {
    const kept = new ClipStateTable();
    const fresh = new ClipStateTable();
    fresh.disableReuseForTesting();
    const a = chain('a', [rect('a')], [bound]);
    const b = chain('b', [mask('b'), rect('r')], [bound, bound]);
    const frames: ClipChain[][] = [
      [a, b],
      [a, b],
      [b],
      [a, b],
      [chain('a', [rect('a2')], [bound]), b],
    ];
    let previous: readonly unknown[] = [];
    frames.forEach((drawn, index) => {
      const run = (table: ClipStateTable) => {
        table.begin();
        const states = drawn.map((entry) => table.stateOf(entry));
        return { states, records: table.end(), writes: table.writes };
      };
      const left = run(kept);
      expect(left).toEqual(run(fresh));
      if (index === 1) expect(left.records[0]).toBe(previous[0]);
      previous = left.records;
    });
  });

  it('reuses a level record only when its chain, parent, source, camera and target are the same', () => {
    const memo = new MaskLevelMemo();
    const outer = chain('o', [mask('o')], [bound]);
    const inner = chain('i', [mask('o'), mask('i')], [bound, bound]);
    const plan = (camera: MaskPlanInput['camera'], key = 'k', useMemo = true) => {
      const result = new MaskPlan({
        sourceOf: (level) => ({ source: { kind: 'mesh', nodeId: level.sourceId! }, key }),
        camera,
        target: { width: 200, height: 100, devicePixelRatio: 1, sampleCount: 4 },
        ...(useMemo ? { memo } : {}),
      });
      result.admit(outer);
      result.admit(inner);
      return result.levels;
    };
    const camera = { x: 0, y: 0, zoom: 1 };
    const first = plan(camera);
    const second = plan({ ...camera });
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second).toEqual(plan(camera, 'k', false));
    const moved = plan({ x: 1, y: 0, zoom: 1 });
    expect(moved[0]).not.toBe(first[0]);
    expect(moved).toEqual(plan({ x: 1, y: 0, zoom: 1 }, 'k', false));
    const resourced = plan({ x: 1, y: 0, zoom: 1 }, 'k2');
    expect(resourced[0]).not.toBe(moved[0]);
    expect(resourced[0]!.key).not.toBe(moved[0]!.key);
    // A changed parent record changes the child's record too.
    expect(resourced[1]).not.toBe(moved[1]);
  });
});

describe('E26 U5d-2: mask source results', () => {
  const sourceAt = (kind: 'primitive' | 'path', x: number, fillRule: 'nonzero' | 'evenodd') =>
    kind === 'primitive'
      ? ({
          id: 'src',
          parentId: 'm',
          transform: [1, 0, 0, 1, x, 0],
          visible: true,
          opacity: 1,
          kind: 'primitive',
          geometry: { kind: 'rectangle', width: 200, height: 200, cornerRadii: [0, 0, 0, 0] },
          style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
        } as RenderNodeSnapshot)
      : pathNode('src', 0, {
          parentId: 'm',
          transform: [1, 0, 0, 1, x, 0],
          fillRule,
          points: [0, 0, 200, 0, 0, 200],
        });
  const content: RenderNodeSnapshot = {
    ...pathNode('content', 0, { parentId: 'm', points: [10, 10, 60, 10, 10, 60] }),
  };
  const mask: RenderNodeSnapshot = {
    id: 'm',
    parentId: null,
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: 1,
    kind: 'container',
    clip: { kind: 'mask' },
    children: ['src', 'content'],
  };

  for (const kind of ['primitive', 'path'] as const) {
    it(`builds a ${kind} source's key afresh when its transform or fill rule changes`, () => {
      const make = (twin: boolean) => {
        const mirror = new RetainedSceneMirror(undefined, {
          pathNodes: 'supported',
          pathFills: 'supported',
          clips: 'supported',
        });
        const source = new PrimitiveSceneSource(
          mirror,
          new PathMeshPipeline({ port: createCountingPort() }),
        );
        if (twin) useFullDerivationForTesting(source);
        mirror.replaceSnapshot({
          identity: { documentId: 'u5d2', pageId: 'page' },
          revision: 1,
          nodes: [mask, sourceAt(kind, 0, 'nonzero'), content],
          rootOrder: ['m'],
        });
        mirror.setCamera({ position: { x: -5, y: -5 }, zoom: 1 });
        return { mirror, source };
      };
      const runs = [make(false), make(true)];
      // Each step: the source's x, its fill rule, and the mask container's x (which moves the
      // source's world while the source node stays the same object).
      const steps: Array<[number, 'nonzero' | 'evenodd', number]> = [
        [0, 'nonzero', 0],
        [0, 'nonzero', 0],
        [0.5, 'nonzero', 0],
        [0.5, 'nonzero', 0],
        [0.5, 'evenodd', 0],
        [0.5, 'evenodd', 0],
        [0.5, 'evenodd', 0.25],
        [0.5, 'evenodd', 0.25],
      ];
      let revision = 1;
      let last = steps[0]!;
      const keys: string[] = [];
      for (const step of steps) {
        const [x, fillRule, maskX] = step;
        const updated: RenderNodeSnapshot[] = [];
        if (x !== last[0] || fillRule !== last[1]) updated.push(sourceAt(kind, x, fillRule));
        if (maskX !== last[2]) updated.push({ ...mask, transform: [1, 0, 0, 1, maskX, 0] });
        last = step;
        if (updated.length > 0) {
          for (const { mirror } of runs) {
            const result = mirror.applyChanges({
              identity: { documentId: 'u5d2', pageId: 'page' },
              revision: revision + 1,
              baseRevision: revision,
              inserted: [],
              updated,
              removed: [],
              orders: [],
            });
            expect(result.status).toBe('applied');
          }
          revision += 1;
        }
        const [left, right] = runs.map(({ source }) => source.prepare(target)?.clip?.masks);
        expect(left).toEqual(right);
        keys.push(left![0]!.key);
      }
      // The move changes the key; for a path source, so does the fill rule.
      expect(keys[2]).not.toBe(keys[1]);
      if (kind === 'path') expect(keys[4]).not.toBe(keys[3]);
      expect(keys[6]).not.toBe(keys[5]);
    });
  }
});
