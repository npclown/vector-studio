import type {
  RenderNodeSnapshot,
  SceneAffine,
  SceneClip,
  SceneColor,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { PathMeshPipeline } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { createCountingPort, pathNode } from '../support/v3a-path-harness.js';

// P4 contract (docs/plans/p4-clip-mask.md), unit U2: clip chains, clip-aware culling (P4-K5),
// clip-state numbering and run splitting (section 4, Batching), mask sources never painted
// (P4-S2), empty and singular chains (P4-S1, P4-K2b), and clip-state writes (P4-A06, U2 part).

const identity = { documentId: 'p4-u2', pageId: 'page' } as const;
const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 1,
  targetFormat: 'bgra8unorm',
};
const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const red: SceneColor = { r: 1, g: 0, b: 0, a: 1 };

function group(
  id: string,
  parentId: string | null,
  children: readonly string[],
  clip: SceneClip,
  transform: SceneAffine = IDENTITY,
): RenderNodeSnapshot {
  return { id, parentId, transform, visible: true, opacity: 1, kind: 'container', clip, children };
}

function box(
  id: string,
  parentId: string | null,
  x: number,
  y = 20,
  size = 10,
  geometry: 'rectangle' | 'line' = 'rectangle',
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, y],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry:
      geometry === 'line'
        ? { kind: 'line', start: { x: 0, y: 0 }, end: { x: size, y: 0 } }
        : { kind: 'rectangle', width: size, height: size, cornerRadii: [0, 0, 0, 0] },
    style:
      geometry === 'line'
        ? { fill: null, stroke: { color: red, width: 1 } }
        : { fill: red, stroke: null },
  };
}

function rect(x: number, y: number, width: number, height: number): SceneClip {
  return { kind: 'rect', x, y, width, height };
}

function setup(nodes: readonly RenderNodeSnapshot[], withPaths = false) {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    clips: 'supported',
  });
  const port = createCountingPort();
  const source = new PrimitiveSceneSource(
    mirror,
    withPaths ? new PathMeshPipeline({ port }) : undefined,
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
  return { mirror, source, port, replace };
}

/** Each analytic draw as [count, clipState or 0]. */
function runs(packet: PrimitivePacket): [number, number][] {
  return packet.draws.map((draw) => [draw.count, draw.clipState ?? 0]);
}

function drawnCount(packet: PrimitivePacket): number {
  return packet.draws.reduce((sum, draw) => sum + draw.count, 0);
}

describe('P4 U2 clip states', () => {
  it('an unclipped frame has no clip part and no clipState field', () => {
    const { source } = setup([
      group('g', null, ['a', 'b'], null),
      box('a', 'g', 10),
      box('b', 'g', 30),
    ]);
    const packet = source.prepare(target)!;
    expect(packet.clip).toBeUndefined();
    expect(packet.draws).toHaveLength(1);
    expect(Object.keys(packet.draws[0]!).sort()).toEqual(['count', 'first', 'variant']);
  });

  it('a clip-state change splits the analytic run without reordering', () => {
    const { source } = setup([
      box('a', null, 0),
      group('g', null, ['b', 'c'], rect(0, 0, 400, 300)),
      box('b', 'g', 20),
      box('c', 'g', 40),
      box('d', null, 60),
    ]);
    const packet = source.prepare(target)!;
    expect(runs(packet)).toEqual([
      [1, 0],
      [2, 1],
      [1, 0],
    ]);
    expect(packet.draws.map((draw) => draw.first)).toEqual([0, 1, 3]);
    expect(packet.clip!.states).toHaveLength(1);
    const state = packet.clip!.states[0]!;
    expect(state.index).toBe(1);
    expect(state.masks).toEqual([]);
    expect(state.rects).toEqual([{ toLocal: [1, 0, 0, 1, 0, 0], width: 400, height: 300 }]);
  });

  it('rect toLocal maps the container world into the clip rectangle frame', () => {
    const world: SceneAffine = [0, 2, -2, 0, 100, 50]; // rotate 90 degrees, scale 2, translate
    const { source } = setup([
      group('g', null, ['a'], rect(5, 7, 30, 40), world),
      box('a', 'g', 6, 8, 2),
    ]);
    const { toLocal } = source.prepare(target)!.clip!.states[0]!.rects[0]!;
    // A world point p maps to inverse(world) * p - (x, y).
    const map = (x: number, y: number) => [
      toLocal[0] * x + toLocal[2] * y + toLocal[4],
      toLocal[1] * x + toLocal[3] * y + toLocal[5],
    ];
    // Local (5, 7) of the container is world (100 - 14, 50 + 10) = (86, 60).
    expect(map(86, 60)).toEqual([0, 0]);
    expect(map(86 - 2 * 40, 60 + 2 * 30)).toEqual([30, 40]);
  });

  it('P4-K5: a leaf outside its clip bound is culled; one on the ramp is kept', () => {
    const { source } = setup([
      group('g', null, ['inside', 'outside', 'edge'], rect(0, 0, 100, 100)),
      box('inside', 'g', 10),
      box('outside', 'g', 200),
      box('edge', 'g', 101.5),
    ]);
    const packet = source.prepare(target)!;
    // 'edge' starts 1.5 px right of the clip; within the 2 px guard it stays.
    expect(drawnCount(packet)).toBe(2);
  });

  it('P4-S2: the mask source never paints; the rest is clipped by the mask state', () => {
    const { source } = setup([
      group('m', null, ['s', 'a', 'b'], { kind: 'mask' }),
      box('s', 'm', 0, 0, 100),
      box('a', 'm', 10),
      box('b', 'm', 30),
    ]);
    const packet = source.prepare(target)!;
    expect(runs(packet)).toEqual([[2, 1]]);
    expect(packet.clip!.states[0]!.masks).toEqual(['m']);
    expect(packet.clip!.states[0]!.rects).toEqual([]);
  });

  it('P4-S2: a hidden mask source still masks, and its content draws', () => {
    const hidden = { ...box('s', 'm', 0, 0, 100), visible: false } as RenderNodeSnapshot;
    const { source } = setup([
      group('m', null, ['s', 'a'], { kind: 'mask' }),
      hidden,
      box('a', 'm', 10),
    ]);
    expect(runs(source.prepare(target)!)).toEqual([[1, 1]]);
  });

  it('empty chains draw nothing: zero-size rect, empty mask, line source, mask outside', () => {
    const cases: RenderNodeSnapshot[][] = [
      [group('g', null, ['a'], rect(0, 0, 0, 50)), box('a', 'g', 10)],
      [
        group('m', null, ['s', 'a'], { kind: 'mask' }),
        box('s', 'm', 0, 0, 100, 'line'),
        box('a', 'm', 10),
      ],
      [
        group('m', null, ['s', 'a'], { kind: 'mask' }),
        box('s', 'm', 300, 300, 10),
        box('a', 'm', 10),
      ],
      [
        group('g', null, ['m'], rect(0, 0, 50, 50)),
        group('m', 'g', ['s', 'a'], { kind: 'mask' }),
        box('s', 'm', 200, 200, 10),
        box('a', 'm', 10),
      ],
    ];
    for (const nodes of cases) {
      const packet = setup([...nodes, box('after', null, 300)]).source.prepare(target)!;
      expect(runs(packet), nodes.map((n) => n.id).join()).toEqual([[1, 0]]);
      expect(packet.clip).toBeUndefined();
    }
  });

  it('P4-K2b: a singular clip container draws nothing of its subtree', () => {
    const { source } = setup([
      group('g', null, ['a'], rect(0, 0, 100, 100), [1, 0, 0, 0, 0, 0]),
      box('a', 'g', 10),
      box('after', null, 300),
    ]);
    expect(runs(source.prepare(target)!)).toEqual([[1, 0]]);
  });

  it('nesting: rects inside the innermost mask, masks listed, a later sibling unclipped (P4-K4)', () => {
    const { source } = setup([
      group('outer', null, ['m', 'sibling'], rect(0, 0, 300, 300)),
      group('m', 'outer', ['s', 'inner'], { kind: 'mask' }),
      box('s', 'm', 0, 0, 200),
      group('inner', 'm', ['a'], rect(1, 2, 100, 100)),
      box('a', 'inner', 10),
      box('sibling', 'outer', 50),
      box('after', null, 60),
    ]);
    const packet = source.prepare(target)!;
    expect(runs(packet)).toEqual([
      [1, 1],
      [1, 2],
      [1, 0],
    ]);
    const [deep, outer] = packet.clip!.states;
    // U4: the rect outside the mask is in the mask level's texture, so the content state keeps
    // only the rect inside it.
    expect(deep!.rects.map((r) => [r.width, r.height, r.toLocal[4], r.toLocal[5]])).toEqual([
      [100, 100, -1, -2],
    ]);
    expect(deep!.masks).toEqual(['m']);
    expect(
      packet.clip!.masks.map((level) => [level.id, level.parent, level.rects.length, level.source]),
    ).toEqual([['m', null, 1, { kind: 'primitive', slot: expect.any(Number) as number }]]);
    expect(outer!.rects).toHaveLength(1);
    expect(outer!.masks).toEqual([]);
  });

  it('P4-A06 (U2 part): clip-state records are written only when they change', () => {
    const nodes = [
      group('g', null, ['a', 'b'], rect(0, 0, 100, 100)),
      box('a', 'g', 10),
      box('b', 'g', 30),
    ];
    const { source, mirror, replace } = setup(nodes);
    source.prepare(target);
    expect(source.getClipStateWrites()).toBe(1);
    source.prepare(target);
    expect(source.getClipStateWrites()).toBe(1);
    // A camera pan rewrites no clip record: records are in world space.
    mirror.setCamera({ position: { x: 5, y: 3 }, zoom: 1 });
    source.prepare(target);
    expect(source.getClipStateWrites()).toBe(1);
    // Moving a clipped leaf changes no clip record.
    replace([nodes[0]!, box('a', 'g', 12), nodes[2]!]);
    source.prepare(target);
    expect(source.getClipStateWrites()).toBe(1);
    // Editing the clip rect rewrites its one record.
    replace([group('g', null, ['a', 'b'], rect(0, 0, 90, 100)), nodes[1]!, nodes[2]!]);
    source.prepare(target);
    expect(source.getClipStateWrites()).toBe(2);
  });

  it('paths: clipped mesh draws carry the state; a path outside its clip makes no port call', () => {
    const inside = pathNode('p', 10, { parentId: 'g' });
    const outside = pathNode('q', 500, { parentId: 'g' });
    const { source, port } = setup(
      [
        group('g', null, ['a', 'p', 'q'], rect(0, 0, 100, 100)),
        box('a', 'g', 40),
        inside,
        outside,
        box('after', null, 300),
      ],
      true,
    );
    const packet = source.prepare(target)!;
    expect(port.calls.flat().map((call) => call.tag)).toEqual([10]);
    expect(packet.mesh!.draws).toHaveLength(1);
    expect(packet.mesh!.draws[0]!.clipState).toBe(1);
    expect(runs(packet)).toEqual([
      [1, 1],
      [1, 0],
    ]);
    expect(packet.mesh!.draws[0]!.position).toBe(1);
  });

  it('paths: a mask path source is never drawn and its content is masked', () => {
    const sourcePath = pathNode('s', 0, {
      parentId: 'm',
      fill: null,
      points: [0, 0, 200, 0, 0, 200],
    });
    const content = pathNode('p', 10, { parentId: 'm', fill: red });
    const { source } = setup(
      [group('m', null, ['s', 'p'], { kind: 'mask' }), sourcePath, content],
      true,
    );
    const packet = source.prepare(target)!;
    expect(packet.mesh!.draws).toHaveLength(1);
    expect(packet.mesh!.draws[0]!.clipState).toBe(1);
    expect(packet.clip!.states[0]!.masks).toEqual(['m']);
  });

  it('chain keys are unambiguous whatever the ids contain', () => {
    const { source } = setup([
      group('a/b', null, ['x'], rect(0, 0, 100, 100)),
      box('x', 'a/b', 10),
      group('a', null, ['b'], rect(0, 0, 200, 200)),
      group('b', 'a', ['y'], rect(0, 0, 300, 300)),
      box('y', 'b', 20),
    ]);
    const packet = source.prepare(target)!;
    expect(runs(packet)).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(packet.clip!.states.map((state) => state.rects.length)).toEqual([1, 2]);
  });

  it('P4-K5: nested rects a sub-pixel gap apart do not cull the sliver they still cover', () => {
    const { source } = setup([
      group('outer', null, ['inner'], rect(0, 0, 10, 100)),
      group('inner', 'outer', ['a'], rect(10.5, 0, 10, 100)),
      box('a', 'inner', 0, 20, 30),
    ]);
    expect(runs(source.prepare(target)!)).toEqual([[1, 1]]);
  });

  it('state indices stay with their chain when another state appears or disappears', () => {
    const first = [group('g', null, ['a'], rect(0, 0, 100, 100)), box('a', 'g', 10)];
    const second = [group('h', null, ['b'], rect(0, 0, 200, 200)), box('b', 'h', 150)];
    const { source, mirror } = setup([...first, ...second]);
    let packet = source.prepare(target)!;
    expect(packet.clip!.states.map((state) => state.index)).toEqual([1, 2]);
    expect(source.getClipStateWrites()).toBe(2);
    // Pan so that only 'b' is in view: its state keeps index 2 and writes nothing.
    mirror.setCamera({ position: { x: 140, y: 0 }, zoom: 1 });
    packet = source.prepare(target)!;
    expect(runs(packet)).toEqual([[1, 2]]);
    expect(packet.clip!.maxIndex).toBe(2);
    // P4-A06: the culled state writes nothing and the drawn one keeps its record.
    expect(source.getClipStateWrites()).toBe(2);
    mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    packet = source.prepare(target)!;
    expect(packet.clip!.states.map((state) => state.index)).toEqual([1, 2]);
    expect(source.getClipStateWrites()).toBe(3);
  });

  it('a state change next to a mesh draw splits the run on both sides', () => {
    const { source } = setup(
      [
        box('a', null, 0),
        group('g', null, ['p', 'b'], rect(0, 0, 400, 300)),
        pathNode('p', 10, { parentId: 'g' }),
        box('b', 'g', 40),
        box('c', null, 60),
      ],
      true,
    );
    const packet = source.prepare(target)!;
    expect(runs(packet)).toEqual([
      [1, 0],
      [1, 1],
      [1, 0],
    ]);
    expect(packet.mesh!.draws.map((draw) => [draw.position, draw.clipState])).toEqual([[1, 1]]);
  });

  it('paths without clips: mesh draws and runs carry no clip fields', () => {
    const { source } = setup(
      [
        box('a', null, 0),
        pathNode('p', 10),
        box('b', null, 40),
        pathNode('q', 20),
        box('c', null, 60),
      ],
      true,
    );
    const packet = source.prepare(target)!;
    expect(packet.clip).toBeUndefined();
    expect(runs(packet)).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
    expect(packet.mesh!.draws.map((draw) => draw.position)).toEqual([1, 2]);
    for (const draw of packet.mesh!.draws) expect('clipState' in draw).toBe(false);
  });
});
