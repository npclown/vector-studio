import type {
  RenderNodeSnapshot,
  SceneAffine,
  SceneClip,
  SceneColor,
} from '@vector-studio/contracts';
import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  E25_LAYER_BYTES_MAX,
  layerBound,
  layerResourceLimitDiagnostic,
  layerTileBytes,
  planLayerBudget,
} from '../../packages/renderer-core/src/layer-plan.js';
import { PathMeshPipeline } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { ScriptedStrokeMeshPort } from '../support/st-u6-stroke-harness.js';
import { createCountingPort, pathNode } from '../support/v3a-path-harness.js';

// E25 contract (docs/plans/d9-e25-isolated-opacity-contract.md), unit U2: the layer plan in
// renderer-core. E25-A02 (post-order layers, E25-K5 bounds, composites, main-pass draws, opacity
// 0, empty bounds, the budget), the unit part of E25-A04 (opacity edits cost no port call) and
// of E25-A07 (one notice per over-budget tree root on its transition).

const identity = { documentId: 'e25-u2', pageId: 'page' } as const;
const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 1,
  targetFormat: 'bgra8unorm',
};
const UHD: PrimitiveTarget = { ...target, width: 3840, height: 2160, sampleCount: 4 };
const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const red: SceneColor = { r: 1, g: 0, b: 0, a: 1 };

function group(
  id: string,
  parentId: string | null,
  children: readonly string[],
  opacity: number,
  clip: SceneClip | null = null,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: IDENTITY,
    visible: true,
    opacity,
    kind: 'container',
    clip,
    children,
  };
}

function box(
  id: string,
  parentId: string | null,
  x: number,
  y = 20,
  width = 10,
  height = width,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, y],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width, height, cornerRadii: [0, 0, 0, 0] },
    style: { fill: red, stroke: null },
  };
}

function setup(nodes: readonly RenderNodeSnapshot[], withPaths = false) {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: 'supported',
    pathStrokes: 'supported',
    clips: 'supported',
    groupOpacity: 'supported',
  });
  mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
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

function runs(draws: PrimitivePacket['draws']): [number, number][] {
  return draws.map((draw) => [draw.first, draw.count]);
}

/** The packet's composites and layers checked against the section 4 rules. */
function checkComposites(packet: PrimitivePacket): void {
  const part = packet.layers!;
  expect(part.composites.map((composite) => composite.layer).sort()).toEqual(
    part.layers.map((_, index) => index),
  );
  for (const composite of part.composites) {
    expect(composite.target).toBe(part.layers[composite.layer]!.parent);
  }
  part.layers.forEach((layer, index) => {
    // Post-order: a layer comes after every layer nested in it.
    if (layer.parent !== -1) expect(layer.parent).toBeGreaterThan(index);
    expect(layer.bound.x % 2).toBe(0);
    expect(layer.bound.y % 2).toBe(0);
  });
}

describe('E25-A02 layer plan', () => {
  it('has no layers part without isolated containers', () => {
    const { source } = setup([group('g', null, ['a'], 1), box('a', 'g', 0)]);
    const packet = source.prepare(target)!;
    expect(packet.layers).toBeUndefined();
    expect(runs(packet.draws)).toEqual([[0, 1]]);
  });

  it('E25-K3: an opacity-1 container draws as its children placed under its parent', () => {
    const grouped = setup(
      [
        box('a', null, 0),
        group('g', null, ['b', 'p'], 1),
        box('b', 'g', 20),
        pathNode('p', 40, { parentId: 'g' }),
        box('c', null, 60),
      ],
      true,
    );
    const flat = setup(
      [box('a', null, 0), box('b', null, 20), pathNode('p', 40), box('c', null, 60)],
      true,
    );
    const left = grouped.source.prepare(target)!;
    const right = flat.source.prepare(target)!;
    expect(left.layers).toBeUndefined();
    expect(left.draws).toEqual(right.draws);
    expect(left.mesh!.draws.map((draw) => draw.position)).toEqual(
      right.mesh!.draws.map((draw) => draw.position),
    );
  });

  it('moves a layer’s draws out of the main pass and places its composite', () => {
    const { source } = setup([
      box('a', null, 0),
      group('g', null, ['b', 'c'], 0.5),
      box('b', 'g', 100),
      box('c', 'g', 105),
      box('d', null, 200),
    ]);
    const packet = source.prepare(target)!;
    checkComposites(packet);
    expect(runs(packet.draws)).toEqual([
      [0, 1],
      [3, 1],
    ]);
    const layer = packet.layers!.layers[0]!;
    expect(layer).toMatchObject({ nodeId: 'g', opacity: 0.5, parent: -1 });
    expect(runs(layer.draws)).toEqual([[1, 2]]);
    // Content [100, 115] × [20, 30], widened by 1 px to [99, 116] × [19, 31], made even.
    expect(layer.bound).toEqual({ x: 98, y: 18, width: 18, height: 14 });
    expect(packet.layers!.composites).toEqual([
      { layer: 0, target: -1, position: 1, meshOrder: 0 },
    ]);
    expect(packet.layers!.notices).toEqual([]);
  });

  it('lists nested layers in post-order with composites in their targets’ paint order', () => {
    const { source } = setup([
      group('outer', null, ['a', 'inner', 'c'], 0.5),
      box('a', 'outer', 0),
      group('inner', 'outer', ['b'], 0.5),
      box('b', 'inner', 20),
      box('c', 'outer', 40),
      group('next', null, ['d'], 0.8),
      box('d', 'next', 60),
    ]);
    const packet = source.prepare(target)!;
    checkComposites(packet);
    const part = packet.layers!;
    expect(part.layers.map((layer) => [layer.nodeId, layer.parent])).toEqual([
      ['inner', 1],
      ['outer', -1],
      ['next', -1],
    ]);
    expect(packet.draws).toEqual([]);
    expect(runs(part.layers[0]!.draws)).toEqual([[1, 1]]);
    expect(runs(part.layers[1]!.draws)).toEqual([
      [0, 1],
      [2, 1],
    ]);
    expect(runs(part.layers[2]!.draws)).toEqual([[3, 1]]);
    expect(part.composites).toEqual([
      { layer: 1, target: -1, position: 0, meshOrder: 0 },
      { layer: 0, target: 1, position: 1, meshOrder: 0 },
      { layer: 2, target: -1, position: 0, meshOrder: 0 },
    ]);
    const inner = part.layers[0]!.bound;
    const outer = part.layers[1]!.bound;
    expect(inner.x).toBeGreaterThanOrEqual(outer.x);
    expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
  });

  it('counts mesh positions within the layer and orders composites against mesh draws', () => {
    const { source } = setup(
      [
        pathNode('q', 0),
        group('g', null, ['p', 'b'], 0.5),
        pathNode('p', 20, { parentId: 'g' }),
        box('b', 'g', 40),
        pathNode('s', 60),
      ],
      true,
    );
    const packet = source.prepare(target)!;
    checkComposites(packet);
    const part = packet.layers!;
    expect(packet.draws).toEqual([]);
    // Main pass: q, the composite of g, then s; all at analytic position 0.
    expect(packet.mesh!.draws.map((draw) => draw.position)).toEqual([0, 0]);
    expect(part.composites).toEqual([{ layer: 0, target: -1, position: 0, meshOrder: 1 }]);
    expect(part.layers[0]!.meshDraws.map((draw) => draw.position)).toEqual([0]);
    expect(runs(part.layers[0]!.draws)).toEqual([[0, 1]]);
    // The layer's bound covers the path's point box [20, 30] × [0, 10] and the box.
    expect(part.layers[0]!.bound).toEqual({ x: 18, y: 0, width: 34, height: 32 });
  });

  it('E25-K3: opacity 0 makes no layer, no draw and no path request', () => {
    const { source, port } = setup(
      [group('g', null, ['p', 'b'], 0), pathNode('p', 20, { parentId: 'g' }), box('b', 'g', 40)],
      true,
    );
    const packet = source.prepare(target)!;
    expect(packet.layers).toBeUndefined();
    expect(packet.draws).toEqual([]);
    expect(packet.mesh?.draws ?? []).toEqual([]);
    expect(port.calls.flat()).toEqual([]);
  });

  it('gives no layer for an empty bound', () => {
    const { source } = setup([group('g', null, ['b'], 0.5), box('b', 'g', 5000)]);
    const packet = source.prepare(target)!;
    expect(packet.layers).toBeUndefined();
    expect(packet.draws).toEqual([]);
  });

  it('E25-K5: the bound is clip-bounded, even and clamped to the target', () => {
    const { source } = setup([
      group('g', null, ['b'], 0.5, { kind: 'rect', x: 0, y: 0, width: 50, height: 50 }),
      box('b', 'g', 0, 0, 200),
    ]);
    expect(source.prepare(target)!.layers!.layers[0]!.bound).toEqual({
      x: 0,
      y: 0,
      width: 52,
      height: 52,
    });
    const odd = setup([group('g', null, ['b'], 0.5), box('b', 'g', 101.3, 7.6, 5)]);
    // [100.3, 107.3] × [6.6, 13.6] rounds out to [100, 108] × [6, 14].
    expect(odd.source.prepare(target)!.layers!.layers[0]!.bound).toEqual({
      x: 100,
      y: 6,
      width: 8,
      height: 8,
    });
    expect(
      layerBound(
        [{ minX: 630, minY: 350, maxX: 700, maxY: 400 }],
        [],
        null,
        { x: 0, y: 0, zoom: 1 },
        target,
        null,
      ),
    ).toEqual({ x: 628, y: 348, width: 12, height: 12 });
  });

  it('applies the camera and DPR', () => {
    const { mirror, source } = setup([group('g', null, ['b'], 0.5), box('b', 'g', 10, 10)]);
    mirror.setCamera({ position: { x: 5, y: 5 }, zoom: 2 });
    const packet = source.prepare({ ...target, devicePixelRatio: 2, width: 1280, height: 720 })!;
    // World [10, 20] maps to device [20, 60]; widened to [19, 61], made even.
    expect(packet.layers!.layers[0]!.bound).toEqual({ x: 18, y: 18, width: 44, height: 44 });
  });
});

describe('E25-A04 invalidation (unit part)', () => {
  const scene = (opacity: number, visible = true) => [
    { ...group('g', null, ['p', 'b'], opacity), visible },
    pathNode('p', 20, { parentId: 'g' }),
    box('b', 'g', 40),
  ];

  /** A change set that only changes the container's opacity. */
  const edit = (mirror: RetainedSceneMirror, opacity: number, revision: number) => {
    const result = mirror.applyChanges({
      identity,
      baseRevision: revision - 1,
      revision,
      inserted: [],
      updated: [group('g', null, ['p', 'b'], opacity)],
      removed: [],
      orders: [],
    });
    expect(result.status).toBe('applied');
  };

  it('an opacity edit 0.5 to 0.7 costs no port call or geometry build and changes one record', () => {
    const { mirror, source, port } = setup(scene(0.5), true);
    const first = source.prepare(target)!;
    const calls = port.calls.length;
    const before = source.getPreparationStatistics();
    edit(mirror, 0.7, 2);
    const edited = source.prepare(target)!;
    expect(port.calls.length).toBe(calls);
    const after = source.getPreparationStatistics();
    expect(after.geometryBuilds).toBe(before.geometryBuilds);
    expect(after.recordWrites).toEqual(before.recordWrites);
    expect(edited.layers!.layers.map((layer) => layer.opacity)).toEqual([0.7]);
    expect({ ...edited.layers!.layers[0]!, opacity: 0.5 }).toEqual(first.layers!.layers[0]!);
  });

  it('edits from 1 to 0.5 and back cost no port call', () => {
    const { mirror, source, port } = setup(scene(1), true);
    expect(source.prepare(target)!.layers).toBeUndefined();
    const calls = port.calls.length;
    edit(mirror, 0.5, 2);
    expect(source.prepare(target)!.layers!.layers).toHaveLength(1);
    edit(mirror, 1, 3);
    expect(source.prepare(target)!.layers).toBeUndefined();
    expect(port.calls.length).toBe(calls);
  });

  it('an edit from 0 to 0.5 costs what making the subtree visible costs', () => {
    const fromZero = setup(scene(0), true);
    fromZero.source.prepare(target);
    edit(fromZero.mirror, 0.5, 2);
    fromZero.source.prepare(target);
    const fromHidden = setup(scene(0.5, false), true);
    fromHidden.source.prepare(target);
    expect(
      fromHidden.mirror.applyChanges({
        identity,
        baseRevision: 1,
        revision: 2,
        inserted: [],
        updated: [group('g', null, ['p', 'b'], 0.5)],
        removed: [],
        orders: [],
      }).status,
    ).toBe('applied');
    fromHidden.source.prepare(target);
    expect(fromZero.port.calls.flat()).toEqual(fromHidden.port.calls.flat());
    expect(fromZero.port.calls.flat().length).toBeGreaterThan(0);
  });

  it('pan and zoom cost what they cost without the container', () => {
    const isolated = setup(scene(0.5), true);
    const flat = setup([pathNode('p', 20), box('b', null, 40)], true);
    for (const { mirror, source } of [isolated, flat]) {
      source.prepare(target);
      mirror.setCamera({ position: { x: 3, y: 2 }, zoom: 1 });
      source.prepare(target);
      mirror.setCamera({ position: { x: 3, y: 2 }, zoom: 4 });
      source.prepare(target);
    }
    expect(isolated.port.calls.length).toBe(flat.port.calls.length);
    expect(isolated.source.getPreparationStatistics().geometryBuilds).toBe(
      flat.source.getPreparationStatistics().geometryBuilds,
    );
  });
});

describe('E25-A07 budget (unit part)', () => {
  const FULL = 3840 * 2160 * 4;
  const TILES = 1024 * 1024 * 24;

  /** A chain of `levels` nested full-screen isolated containers named `${name}0`, ... */
  function tree(name: string, levels: number, opacity = 0.5): RenderNodeSnapshot[] {
    const nodes: RenderNodeSnapshot[] = [];
    for (let level = 0; level < levels; level += 1) {
      const child = level + 1 < levels ? `${name}${level + 1}` : `${name}-leaf`;
      nodes.push(
        group(
          `${name}${level}`,
          level === 0 ? null : `${name}${level - 1}`,
          [child],
          level === 0 ? opacity : 0.5,
        ),
      );
    }
    nodes.push(box(`${name}-leaf`, `${name}${levels - 1}`, 0, 0, 3840, 2160));
    return nodes;
  }

  it('states the section 4 figures', () => {
    expect(E25_LAYER_BYTES_MAX).toBe(100_663_296);
    expect(FULL).toBe(33_177_600);
    expect(layerTileBytes(3840, 2160, 4)).toBe(TILES);
    expect(layerTileBytes(3840, 2160, 1)).toBe(1024 * 1024 * 5);
    expect(layerTileBytes(300, 2000, 4)).toBe(300 * 1024 * 24);
    const layer = { width: 3840, height: 2160 };
    const two = planLayerBudget([{ rootId: 'a', layers: [layer, layer] }], 4);
    expect([...two.admitted]).toEqual(['a']);
    expect(2 * FULL + TILES).toBe(91_521_024);
    const three = planLayerBudget([{ rootId: 'a', layers: [layer, layer, layer] }], 4);
    expect(three.admitted.size).toBe(0);
    expect(three.notices).toEqual([
      { nodeId: 'a', bytes: 124_698_624, limit: E25_LAYER_BYTES_MAX },
    ]);
  });

  it('O9: drops a three-layer tree whole and still draws later leaves and trees', () => {
    const nodes = [...tree('a', 3), box('leaf', null, 10), ...tree('b', 2)];
    const { source, replace } = setup(nodes);
    const packet = source.prepare(UHD)!;
    checkComposites(packet);
    expect(packet.layers!.notices).toEqual([
      { nodeId: 'a0', bytes: 3 * FULL + TILES, limit: E25_LAYER_BYTES_MAX },
    ]);
    expect(packet.layers!.layers.map((layer) => layer.nodeId)).toEqual(['b1', 'b0']);
    expect(packet.layers!.layers[1]!.bound).toEqual({ x: 0, y: 0, width: 3840, height: 2160 });
    // The order stream holds the drawn leaves only: `leaf` in the main pass, then b's leaf.
    expect(runs(packet.draws)).toEqual([[0, 1]]);
    expect(runs(packet.layers!.layers[0]!.draws)).toEqual([[1, 1]]);
    // The notice is raised once, on the transition.
    expect(source.prepare(UHD)!.layers!.notices).toEqual([]);
    // With a0 at opacity 1 the tree has two layers (root a1) and fits; b no longer fits.
    replace([...tree('a', 3, 1), box('leaf', null, 10), ...tree('b', 2)]);
    const reduced = source.prepare(UHD)!;
    checkComposites(reduced);
    expect(reduced.layers!.layers.map((layer) => layer.nodeId)).toEqual(['a2', 'a1']);
    expect(reduced.layers!.notices).toEqual([
      { nodeId: 'b0', bytes: 4 * FULL + TILES, limit: E25_LAYER_BYTES_MAX },
    ]);
    expect(source.getLayerNoticesDropped()).toBe(0);
  });

  it('a notices-only part, then none after the root’s opacity returns to 1', () => {
    const { source, replace } = setup(tree('a', 3));
    const packet = source.prepare(UHD)!;
    expect(packet.layers).toEqual({
      layoutVersion: 0,
      layers: [],
      composites: [],
      notices: [{ nodeId: 'a0', bytes: 3 * FULL + TILES, limit: E25_LAYER_BYTES_MAX }],
    });
    expect(packet.draws).toEqual([]);
    expect(source.prepare(UHD)!.layers).toBeUndefined();
    replace(tree('a', 3, 1));
    expect(source.prepare(UHD)!.layers!.notices).toEqual([]);
    // Back over the budget: a new transition, a new notice.
    replace(tree('a', 3));
    expect(source.prepare(UHD)!.layers!.notices.map((notice) => notice.nodeId)).toEqual(['a0']);
  });

  it('builds the render.layer-resource-limit diagnostic', () => {
    const diagnostic = layerResourceLimitDiagnostic(
      { nodeId: 'a0', bytes: 124_698_624, limit: E25_LAYER_BYTES_MAX },
      7,
    );
    expect(diagnostic).toMatchObject({
      code: DIAGNOSTIC_CODES.LAYER_RESOURCE_LIMIT,
      severity: 'warning',
      generation: 7,
      context: { nodeId: 'a0', bytes: 124_698_624, limit: E25_LAYER_BYTES_MAX },
    });
  });
});
