import type {
  RenderNodeSnapshot,
  SceneAffine,
  SceneColor,
  SceneGradient,
  ScenePaint,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildGradientRecord,
  type GradientPaintRecord,
} from '../../packages/renderer-core/src/paint-records.js';
import { PathMeshPipeline } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import {
  ScriptedStrokeMeshPort,
  pathStroke,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';
import { createCountingPort } from '../support/v3a-path-harness.js';

// E23 contract (docs/plans/d9-e23-gradient-paint-contract.md), unit U2: gradient records
// (E23-A02), the out-of-range rule (E23-K8), invalidation (E23-A05 unit part) and run
// splitting (E23-A06 unit part), through the primitive scene source.

const identity = { documentId: 'e23-u2', pageId: 'page' } as const;
const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 1,
  targetFormat: 'bgra8unorm',
};
const red: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const blue: SceneColor = { r: 0, g: 0, b: 1, a: 1 };
const G1: SceneGradient = {
  kind: 'linear',
  transform: [200, 0, 0, 200, 50, 0],
  stops: [
    { offset: 0, color: red },
    { offset: 1, color: blue },
  ],
  spread: 'pad',
};
/** Valid under E23-S2; on a node scaled by 1e-10 its record leaves binary32 range (E23-K8). */
const TINY: SceneGradient = { ...G1, transform: [1e-30, 0, 0, 1e-30, 0, 0] };

function box(
  id: string,
  x: number,
  fill: ScenePaint | null,
  stroke: ScenePaint | null = null,
  transform: SceneAffine = [1, 0, 0, 1, x, 20],
  visible = true,
): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform,
    visible,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill, stroke: stroke === null ? null : { color: stroke, width: 2 } },
  };
}

function setup(nodes: readonly RenderNodeSnapshot[], withPaths = false) {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: 'supported',
    pathStrokes: 'supported',
    clips: 'supported',
    paints: 'gradient',
  });
  const port = createCountingPort();
  const strokePort = new ScriptedStrokeMeshPort();
  const source = new PrimitiveSceneSource(
    mirror,
    withPaths ? new PathMeshPipeline({ port, strokePort }) : undefined,
  );
  let revision = 0;
  const replace = (next: readonly RenderNodeSnapshot[]) => {
    revision += 1;
    const result = mirror.replaceSnapshot({
      identity,
      revision,
      nodes: next,
      rootOrder: next.filter((node) => node.parentId === null).map((node) => node.id),
    });
    expect(result.status).toBe('applied');
  };
  replace(nodes);
  return { mirror, source, port, strokePort, replace };
}

function apply(record: GradientPaintRecord, d: readonly [number, number]): [number, number] {
  const [a, b, c, e, tx, ty] = record.map as [number, number, number, number, number, number];
  return [a * d[0] + c * d[1] + tx, b * d[0] + e * d[1] + ty];
}

function runs(packet: PrimitivePacket): [number, string][] {
  return packet.draws.map((draw) => [draw.count, draw.paint ?? 'solid']);
}

describe('E23-A02 gradient records', () => {
  it('G = M⁻¹ · W⁻¹ · T(origin), composed in binary64 and rounded once', () => {
    const world: SceneAffine = [1, 0, 0, 1, 10, 20];
    const origin = { x: 4, y: 6 };
    const record = buildGradientRecord(G1, world, origin)!;
    // w = (160, 70) is local (150, 50), so g = ((150 - 50) / 200, 50 / 200).
    const [gx, gy] = apply(record, [160 - origin.x, 70 - origin.y]);
    expect(gx).toBeCloseTo(0.5, 6);
    expect(gy).toBeCloseTo(0.25, 6);
    expect(record.map.every((lane) => Math.fround(lane) === lane)).toBe(true);
    expect(record.map.map((lane) => lane + 0)).toEqual(
      [1 / 200, 0, 0, 1 / 200, (4 - 10 - 50) / 200, (6 - 20) / 200].map(Math.fround),
    );
  });

  it('stops are premultiplied in binary64 and rounded once', () => {
    const translucent: SceneGradient = {
      ...G1,
      stops: [
        { offset: 0.1, color: { r: 0.3, g: 1, b: 0, a: 0.5 } },
        { offset: 0.7, color: blue },
      ],
    };
    const record = buildGradientRecord(translucent, [1, 0, 0, 1, 0, 0], { x: 0, y: 0 })!;
    expect(record.offsets).toEqual([Math.fround(0.1), Math.fround(0.7)]);
    expect(record.colors).toEqual([0.15, 0.5, 0, 0.5, 0, 0, 1, 1].map(Math.fround));
    expect(record.kind).toBe('linear');
    expect(record.spread).toBe('pad');
  });

  it('E23-K8: a record outside binary32 range is null', () => {
    expect(buildGradientRecord(TINY, [1e-10, 0, 0, 1e-10, 0, 0], { x: 0, y: 0 })).toBeNull();
    expect(buildGradientRecord(TINY, [1, 0, 0, 1, 0, 0], { x: 0, y: 0 })).not.toBeNull();
  });
});

describe('E23 U2 paint part and runs', () => {
  it('a solid-only frame has no paint part and no paint or gradient field', () => {
    const { source } = setup([box('a', 10, red), box('b', 30, blue, red)]);
    const packet = source.prepare(target)!;
    expect(packet.paint).toBeUndefined();
    expect(Object.keys(packet.draws[0]!).sort()).toEqual(['count', 'first', 'variant']);
  });

  it('E23-A06: a solid/gradient change splits a run; consecutive gradients stay one run', () => {
    const { source } = setup([
      box('a', 10, red),
      box('b', 30, G1),
      box('c', 50, red, G1),
      box('d', 70, G1, G1),
      box('e', 90, red),
    ]);
    const packet = source.prepare(target)!;
    expect(runs(packet)).toEqual([
      [1, 'solid'],
      [3, 'gradient'],
      [1, 'solid'],
    ]);
    const paint = packet.paint!;
    expect(paint.records).toHaveLength(4);
    expect(paint.primitives.map(({ fill, stroke }) => [fill, stroke])).toEqual([
      [1, 0],
      [0, 2],
      [3, 4],
    ]);
    expect(paint.builds).toBe(4);
  });

  it('E23-A02/A05: a camera pan builds no record; an origin rebase rebuilds every record', () => {
    const { mirror, source } = setup([box('a', 10, G1), box('b', 30, red, G1)]);
    const first = source.prepare(target)!;
    expect(first.paint!.builds).toBe(2);
    mirror.setCamera({ position: { x: 5, y: 3 }, zoom: 2 });
    const panned = source.prepare(target)!;
    expect(panned.originRevision).toBe(first.originRevision);
    expect(panned.paint!.builds).toBe(0);
    expect(panned.paint!.records[0]).toBe(first.paint!.records[0]);
    mirror.setCamera({ position: { x: 5000, y: 0 }, zoom: 1 });
    const moved = source.prepare(target)!;
    expect(moved.originRevision).not.toBe(first.originRevision);
    expect(moved.paint?.builds ?? 0).toBe(moved.paint?.records.length ?? 0);
  });

  it('E23-A05: a stop edit rebuilds only that record and rewrites no style record', () => {
    const { mirror, source } = setup([box('a', 10, G1), box('b', 30, G1)]);
    source.prepare(target);
    const before = source.getPreparationStatistics();
    const edited: SceneGradient = { ...G1, stops: [{ offset: 0, color: blue }] };
    const result = mirror.applyChanges({
      identity,
      baseRevision: 1,
      revision: 2,
      inserted: [],
      updated: [box('a', 10, edited)],
      removed: [],
      orders: [],
    });
    expect(result.status).toBe('applied');
    const packet = source.prepare(target)!;
    expect(packet.paint!.builds).toBe(1);
    const after = source.getPreparationStatistics();
    expect(after.recordWrites.styles).toBe(before.recordWrites.styles);
    expect(after.geometryBuilds).toBe(before.geometryBuilds);
  });

  it('E23-K8: an out-of-range primitive paint is index 0; its other paint still draws', () => {
    const scaled: SceneAffine = [1e-10, 0, 0, 1e-10, 10, 20];
    const { source } = setup([box('a', 10, TINY, G1, scaled)]);
    const packet = source.prepare(target)!;
    expect(packet.paint!.primitives).toEqual([{ slot: 0, fill: 0, stroke: 1 }]);
    const both = setup([box('a', 10, TINY, TINY, scaled)]).source.prepare(target)!;
    expect(both.paint).toBeUndefined();
    expect(runs(both)).toEqual([[1, 'solid']]);
  });

  it('hidden primitives and primitive mask sources with gradients pack without a record', () => {
    const { source } = setup([
      box('h', 10, G1, null, [1, 0, 0, 1, 10, 20], false),
      {
        id: 'm',
        parentId: null,
        transform: [1, 0, 0, 1, 0, 0],
        visible: true,
        opacity: 1,
        kind: 'container',
        clip: { kind: 'mask' },
        children: ['s', 'c'],
      },
      { ...box('s', 0, G1), parentId: 'm' },
      { ...box('c', 0, red), parentId: 'm' },
    ]);
    const packet = source.prepare(target)!;
    expect(packet.paint).toBeUndefined();
    expect(packet.clip?.masks).toHaveLength(1);
  });
});

describe('E23 U2 mesh paints', () => {
  const stroke = (color: ScenePaint) => pathStroke({ color, width: 4 });

  it('fill and stroke draws carry their record; paint edits make no port call (E23-A05)', () => {
    const { source, port, strokePort, replace } = setup(
      [strokedNode('p', 0, { fill: red, stroke: stroke(blue) })],
      true,
    );
    const solid = source.prepare(target)!;
    expect(solid.paint).toBeUndefined();
    expect(solid.mesh!.draws.every((draw) => draw.gradient === undefined)).toBe(true);
    const calls = [port.calls.length, strokePort.calls.length];
    replace([strokedNode('p', 0, { fill: G1, stroke: stroke(G1) })]);
    const packet = source.prepare(target)!;
    expect([port.calls.length, strokePort.calls.length]).toEqual(calls);
    expect(packet.mesh!.draws.map((draw) => draw.gradient)).toEqual([1, 2]);
    const record = packet.paint!.records[0]!;
    const origin = packet.paint!.meshOrigin;
    // The node is at the identity, so the document point (150, 0) has t = (150 - 50) / 200.
    expect(apply(record, [150 - origin.x, 0 - origin.y])[0]).toBeCloseTo(0.5, 5);
    replace([strokedNode('p', 0, { fill: red, stroke: stroke(blue) })]);
    expect(source.prepare(target)!.paint).toBeUndefined();
    expect([port.calls.length, strokePort.calls.length]).toEqual(calls);
  });

  it('E23-K8: a path with separate draws skips only the out-of-range draw', () => {
    const transform: SceneAffine = [1e-10, 0, 0, 1e-10, 0, 0];
    const { source } = setup(
      [strokedNode('p', 0, { transform, fill: TINY, stroke: stroke(G1) })],
      true,
    );
    const packet = source.prepare(target)!;
    expect(packet.mesh?.draws.map((draw) => draw.gradient) ?? []).toEqual([1]);
  });

  it('E23-K8: a joint path draws neither paint when either record is out of range', () => {
    const transform: SceneAffine = [1e-10, 0, 0, 1e-10, 0, 0];
    const { source } = setup(
      [strokedNode('p', 0, { transform, opacity: 0.5, fill: G1, stroke: stroke(TINY) })],
      true,
    );
    const packet = source.prepare(target)!;
    expect(packet.mesh?.draws ?? []).toHaveLength(0);
    const control = setup(
      [strokedNode('p', 0, { opacity: 0.5, fill: G1, stroke: stroke(G1) })],
      true,
    ).source.prepare(target)!;
    expect(control.mesh!.draws.map((draw) => [draw.composite ?? 'plain', draw.gradient])).toEqual([
      ['joint-fill', 1],
      ['plain', 2],
    ]);
  });
});
