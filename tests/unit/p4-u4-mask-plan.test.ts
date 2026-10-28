import type {
  RenderNodeSnapshot,
  SceneAffine,
  SceneClip,
  SceneColor,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  PathMeshPipeline,
  type PathMeshDraw,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type { PrimitiveTarget } from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';
import {
  P4_MASK_TEXTURE_BYTES_MAX,
  clipResourceLimitDiagnostic,
} from '../../packages/renderer-core/src/clip-resolution.js';
import { ScriptedStrokeMeshPort, strokedNode } from '../support/st-u6-stroke-harness.js';
import { createCountingPort, pathNode } from '../support/v3a-path-harness.js';

// P4 contract (docs/plans/p4-clip-mask.md), unit U4a: the CPU side of mask levels. Mask
// sources are meshed as opaque white fills that never paint (P4-S2, P4-K2), mask levels are
// planned in paint order with their device bounds, parents, rect levels and cache keys, and the
// mask texture budget is reported on its transitions (section 5).

const identity = { documentId: 'p4-u4', pageId: 'page' } as const;
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
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: IDENTITY,
    visible: true,
    opacity: 1,
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

const MASK: SceneClip = { kind: 'mask' };

function setup(nodes: readonly RenderNodeSnapshot[]) {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: 'supported',
    pathStrokes: 'supported',
    clips: 'supported',
  });
  const port = createCountingPort();
  const strokePort = new ScriptedStrokeMeshPort();
  const pipeline = new PathMeshPipeline({ port, strokePort });
  let served: readonly PathMeshDraw[] = [];
  const pipelinePrepare = pipeline.prepare.bind(pipeline);
  pipeline.prepare = (input) => {
    served = pipelinePrepare(input);
    return served;
  };
  const source = new PrimitiveSceneSource(mirror, pipeline);
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
  return { mirror, source, port, strokePort, served: () => served, replace };
}

const sourcePoints = [0, 0, 200, 0, 0, 200];

describe('P4 U4a mask plan', () => {
  for (const [name, overrides] of [
    ['no fill', { fill: null }],
    ['hidden', { visible: false }],
    ['opacity 0.3', { opacity: 0.3 }],
  ] as const) {
    it(`P4-S2: a path source (${name}) is meshed as an opaque white fill and never paints`, () => {
      const { source, port, served } = setup([
        group('m', null, ['s', 'p'], MASK),
        pathNode('s', 0, { parentId: 'm', points: sourcePoints, ...overrides }),
        pathNode('p', 10, { parentId: 'm', fill: red }),
      ]);
      const packet = source.prepare(target)!;
      expect(port.calls.flat().map((call) => call.tag)).toEqual([0, 10]);
      const draw = served().find((entry) => entry.nodeId === 's')!;
      expect(draw.maskSource).toBe(true);
      expect(draw.paint ?? 'fill').toBe('fill');
      expect(draw.opacity).toBe(1);
      expect(draw.fill).toEqual({ r: 1, g: 1, b: 1, a: 1 });
      expect(draw.composite).toBeUndefined();
      // Only the content draw paints; the source draw is the mask level's.
      expect(packet.mesh!.draws).toHaveLength(1);
      expect(packet.mesh!.draws[0]!.clipState).toBe(1);
      const [level] = packet.clip!.masks;
      expect(level!.id).toBe('m');
      expect(level!.source.kind).toBe('mesh');
      if (level!.source.kind !== 'mesh') return;
      expect(level!.source.nodeId).toBe('s');
      expect(level!.source.draw).not.toBeNull();
      expect(level!.source.draw!.triangleCount).toBeGreaterThan(0);
      expect(packet.draws).toEqual([]);
    });
  }

  it('P4-S2: a stroked path source makes no stroke request', () => {
    const { source, port, strokePort } = setup([
      group('m', null, ['s', 'p'], MASK),
      strokedNode('s', 0, { parentId: 'm', points: sourcePoints }),
      pathNode('p', 10, { parentId: 'm', fill: red }),
    ]);
    source.prepare(target);
    expect(port.calls.flat().map((call) => call.tag)).toEqual([0, 10]);
    expect(strokePort.callCount).toBe(0);
  });

  it('a primitive source names its slot; a line source covers nothing', () => {
    const drawn = setup([
      group('m', null, ['s', 'a'], MASK),
      box('s', 'm', 0, 0, 100),
      box('a', 'm', 10),
    ]).source.prepare(target)!;
    expect(drawn.clip!.masks.map((level) => level.source)).toEqual([
      { kind: 'primitive', slot: expect.any(Number) as number },
    ]);
    const line = setup([
      group('m', null, ['s', 'a'], MASK),
      box('s', 'm', 0, 0, 100, 'line'),
      box('a', 'm', 10),
    ]).source.prepare(target)!;
    expect(line.clip).toBeUndefined();
    expect(line.draws).toEqual([]);
  });

  it('the device rect is the bound widened by 2 px, rounded out and clamped to the target', () => {
    const { source, mirror } = setup([
      group('m', null, ['s', 'a'], MASK),
      box('s', 'm', 10.5, 20, 100),
      box('a', 'm', 30),
    ]);
    expect(source.prepare(target)!.clip!.masks[0]!.device).toEqual({
      x: 8,
      y: 18,
      width: 105,
      height: 104,
    });
    // At zoom 2 and DPR 1.5 a world unit is 3 px; the guard stays 2 px; the left and bottom edges clamp.
    mirror.setCamera({ position: { x: 20, y: 0 }, zoom: 2 });
    expect(source.prepare({ ...target, devicePixelRatio: 1.5 })!.clip!.masks[0]!.device).toEqual({
      x: 0,
      y: 58,
      width: 274,
      height: 302,
    });
  });

  it('nesting: the parent level first, rects between levels, the parent key inside the child key', () => {
    const { source } = setup([
      group('outer', null, ['os', 'r'], MASK),
      box('os', 'outer', 0, 0, 200),
      group('r', 'outer', ['inner'], rect(1, 2, 100, 100)),
      group('inner', 'r', ['is', 'a'], MASK),
      box('is', 'inner', 10, 10, 50),
      box('a', 'inner', 20),
    ]);
    const packet = source.prepare(target)!;
    const levels = packet.clip!.masks;
    expect(levels.map((level) => [level.id, level.parent, level.rects.length])).toEqual([
      ['outer', null, 0],
      ['inner', 'outer', 1],
    ]);
    expect(levels[1]!.rects[0]!.toLocal.slice(4)).toEqual([-1, -2]);
    expect((JSON.parse(levels[1]!.key) as unknown[])[0]).toBe(levels[0]!.key);
    const state = packet.clip!.states[0]!;
    expect(state.masks).toEqual(['outer', 'inner']);
    expect(state.rects).toEqual([]);
  });

  it('the key changes with the source and the camera, not with the content', () => {
    const nodes = [group('m', null, ['s', 'a'], MASK), box('s', 'm', 0, 0, 100), box('a', 'm', 10)];
    const { source, replace, mirror } = setup(nodes);
    const key = () => source.prepare(target)!.clip!.masks[0]!.key;
    const first = key();
    replace([nodes[0]!, nodes[1]!, box('a', 'm', 12)]);
    expect(key()).toBe(first);
    replace([nodes[0]!, box('s', 'm', 0, 0, 90), box('a', 'm', 12)]);
    const moved = key();
    expect(moved).not.toBe(first);
    mirror.setCamera({ position: { x: 1, y: 0 }, zoom: 1 });
    expect(key()).not.toBe(moved);
  });

  it('section 5: a level over the budget is not drawn and is reported once per transition', () => {
    const { source } = setup([
      group('m', null, ['s', 'a'], MASK),
      box('s', 'm', 0, 0, 5000),
      box('a', 'm', 10),
      box('after', null, 300),
    ]);
    const big: PrimitiveTarget = { ...target, width: 4096, height: 4096, sampleCount: 4 };
    const over = source.prepare(big)!;
    expect(over.draws.reduce((sum, draw) => sum + draw.count, 0)).toBe(1);
    expect(over.clip).toBeUndefined();
    expect(over.clipNotices).toEqual([
      { nodeId: 'm', bytes: 4096 * 4096 * 9, limit: P4_MASK_TEXTURE_BYTES_MAX },
    ]);
    const diagnostic = clipResourceLimitDiagnostic(over.clipNotices![0]!, 1);
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.CLIP_RESOURCE_LIMIT);
    expect(diagnostic.context).toEqual({
      nodeId: 'm',
      bytes: 4096 * 4096 * 9,
      limit: P4_MASK_TEXTURE_BYTES_MAX,
    });
    expect(source.prepare(big)!.clipNotices).toBeUndefined();
    const fits = source.prepare(target)!;
    expect(fits.clipNotices).toBeUndefined();
    expect(fits.clip!.masks).toHaveLength(1);
    expect(source.prepare(big)!.clipNotices).toHaveLength(1);
    // At 1x the transient pass is one stencil target: 4096² × 2 fits.
    expect(source.prepare({ ...big, sampleCount: 1 })!.clip!.masks).toHaveLength(1);
    expect(source.getMaskNoticesDropped()).toBe(0);
  });

  it('a path source draw between stroked content draws leaves the paint order intact', () => {
    const { source } = setup([
      group('m', null, ['s', 'p', 'q'], MASK),
      pathNode('s', 0, { parentId: 'm', points: sourcePoints }),
      strokedNode('p', 10, { parentId: 'm' }),
      pathNode('q', 20, { parentId: 'm', fill: red }),
      pathNode('after', 30),
    ]);
    const packet = source.prepare(target)!;
    expect(source.getLastDrawRecordForTesting()!.draws.map((d) => [d.nodeId, d.paint])).toEqual([
      ['p', 'fill'],
      ['p', 'stroke'],
      ['q', 'fill'],
      ['after', 'fill'],
    ]);
    expect(packet.mesh!.draws.map((draw) => draw.clipState ?? 0)).toEqual([1, 1, 1, 0]);
    const level = packet.clip!.masks[0]!;
    if (level.source.kind !== 'mesh') throw new Error('expected a mesh source');
    expect(level.source.draw).not.toBeNull();
    expect(packet.mesh!.draws.map((draw) => draw.instance)).not.toContain(
      level.source.draw!.instance,
    );
  });

  it('a mesh source key follows its geometry and fill rule, not its paint', () => {
    const nodes = (overrides: Parameters<typeof pathNode>[2]) => [
      group('m', null, ['s', 'a'], MASK),
      pathNode('s', 0, { parentId: 'm', points: sourcePoints, ...overrides }),
      box('a', 'm', 10),
    ];
    const { source, replace } = setup(nodes({}));
    const key = () => source.prepare(target)!.clip!.masks[0]!.key;
    const first = key();
    replace(nodes({ fill: { r: 0, g: 1, b: 0, a: 0.5 }, opacity: 0.4 }));
    expect(key()).toBe(first);
    replace(nodes({ fillRule: 'evenodd' }));
    const evenOdd = key();
    expect(evenOdd).not.toBe(first);
    replace(nodes({ fillRule: 'evenodd', points: [0, 0, 180, 0, 0, 200] }));
    expect(key()).not.toBe(evenOdd);
  });

  it('section 5: under an over-budget parent the child level is neither drawn nor reported', () => {
    const { source } = setup([
      group('outer', null, ['os', 'a', 'inner'], MASK),
      box('os', 'outer', 0, 0, 5000),
      box('a', 'outer', 10),
      group('inner', 'outer', ['is', 'b'], MASK),
      box('is', 'inner', 0, 0, 100),
      box('b', 'inner', 20),
      box('after', null, 300),
    ]);
    const packet = source.prepare({ ...target, width: 4096, height: 4096, sampleCount: 4 })!;
    expect(packet.draws.reduce((sum, draw) => sum + draw.count, 0)).toBe(1);
    expect(packet.clipNotices!.map((notice) => notice.nodeId)).toEqual(['outer']);
  });

  it('section 5: at most 32 notices per packet; a mask is reported again after clips leave', () => {
    const masks = Array.from({ length: 40 }, (_, index) => [
      group(`m${index}`, null, [`s${index}`, `a${index}`], MASK),
      box(`s${index}`, `m${index}`, 0, 0, 5000),
      box(`a${index}`, `m${index}`, 10),
    ]).flat();
    const { source, replace } = setup(masks);
    const big: PrimitiveTarget = { ...target, width: 4096, height: 4096, sampleCount: 4 };
    expect(source.prepare(big)!.clipNotices).toHaveLength(32);
    expect(source.prepare(big)!.clipNotices).toHaveLength(8);
    expect(source.prepare(big)!.clipNotices).toBeUndefined();
    replace([box('after', null, 300)]);
    expect(source.prepare(big)!.clipNotices).toBeUndefined();
    replace(masks.slice(0, 3));
    expect(source.prepare(big)!.clipNotices!.map((notice) => notice.nodeId)).toEqual(['m0']);
    expect(source.getMaskNoticesDropped()).toBe(0);
  });
});
