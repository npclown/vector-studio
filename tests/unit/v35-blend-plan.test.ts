// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-A04: scene validation and
// the gate (K1, K2), the plan of blend roots and isolating containers (K3, with the E25-K3 and
// S2 amendments and the depth count), the backdrop splits (K4), the budget and the 64-root
// limit with their fallback and diagnostic (K6), and the unavailable-pipeline fallback (K7).

import type {
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneAffine,
  SceneBlendMode,
  SceneClip,
  SceneEffect,
} from '@vector-studio/contracts';
import { DIAGNOSTIC_CODES, SCENE_MAX_ISOLATION_DEPTH } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  V35_BLEND_ROOTS_MAX,
  blendResourceLimitDiagnostic,
  planBackdropSplits,
} from '../../packages/renderer-core/src/backdrop-plan.js';
import { E25_LAYER_BYTES_MAX } from '../../packages/renderer-core/src/layer-plan.js';
import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import {
  RetainedSceneMirror,
  type RetainedSceneMirrorOptions,
} from '../../packages/renderer-core/src/scene-mirror.js';

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const identity = { documentId: 'v35-u4', pageId: 'page' } as const;
const SHADOW: SceneEffect = {
  kind: 'dropShadow',
  color: { r: 0, g: 0, b: 0, a: 0.5 },
  offsetX: 2,
  offsetY: 2,
  sigma: 1,
};

const V0: RetainedSceneMirrorOptions = {
  pathNodes: 'unsupported',
  clips: 'supported',
  groupOpacity: 'supported',
  effects: 'v0',
  blend: 'v0',
};
const NONE: RetainedSceneMirrorOptions = { ...V0, blend: 'none' };

function group(
  id: string,
  parentId: string | null,
  children: readonly string[],
  extra: Partial<{
    opacity: number;
    blendMode: SceneBlendMode;
    effects: readonly SceneEffect[];
    clip: SceneClip;
    visible: boolean;
  }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: IDENTITY,
    visible: extra.visible ?? true,
    opacity: extra.opacity ?? 1,
    kind: 'container',
    clip: extra.clip ?? null,
    children,
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
    ...(extra.blendMode === undefined ? {} : { blendMode: extra.blendMode }),
  };
}

function box(
  id: string,
  parentId: string | null,
  x: number,
  extra: Partial<{
    opacity: number;
    blendMode: SceneBlendMode;
    effects: readonly SceneEffect[];
    size: number;
    y: number;
  }> = {},
): RenderNodeSnapshot {
  const size = extra.size ?? 10;
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, extra.y ?? 20],
    visible: true,
    opacity: extra.opacity ?? 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: size, height: size, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
    ...(extra.blendMode === undefined ? {} : { blendMode: extra.blendMode }),
  };
}

function snapshot(nodes: readonly RenderNodeSnapshot[], revision = 1): RenderSceneSnapshot {
  const rootOrder = nodes.filter((node) => node.parentId === null).map((node) => node.id);
  return { identity, revision, nodes, rootOrder };
}

function status(result: ReturnType<RetainedSceneMirror['replaceSnapshot']>): string {
  return result.status === 'invalid-scene' ? result.reason : result.status;
}

function replace(nodes: readonly RenderNodeSnapshot[], options = V0): string {
  return status(new RetainedSceneMirror(undefined, options).replaceSnapshot(snapshot(nodes)));
}

const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 1,
  targetFormat: 'bgra8unorm',
  blendLayers: true,
};

function setup(nodes: readonly RenderNodeSnapshot[], options = V0) {
  const mirror = new RetainedSceneMirror(undefined, options);
  mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  const source = new PrimitiveSceneSource(mirror, undefined);
  expect(status(mirror.replaceSnapshot(snapshot(nodes)))).toBe('applied');
  return { mirror, source };
}

function layerSummary(packet: PrimitivePacket) {
  return (packet.layers?.layers ?? []).map((layer) => ({
    nodeId: layer.nodeId,
    opacity: layer.opacity,
    parent: layer.parent,
    ...(layer.blend === undefined ? {} : { blend: layer.blend }),
    ...(layer.backdrop === undefined ? {} : { backdrop: layer.backdrop }),
    ...(layer.effect === undefined ? {} : { effect: true }),
  }));
}

describe('V35-K1 scene field and K2 gate', () => {
  it('accepts every mode under v0 and keeps a non-default mode on the node', () => {
    const modes: SceneBlendMode[] = [
      'multiply',
      'screen',
      'overlay',
      'darken',
      'lighten',
      'colorDodge',
      'colorBurn',
      'hardLight',
      'softLight',
      'difference',
      'exclusion',
      'hue',
      'saturation',
      'color',
      'luminosity',
    ];
    for (const mode of modes) {
      const mirror = new RetainedSceneMirror(undefined, V0);
      const nodes = [
        group('g', null, ['r'], { blendMode: mode }),
        box('r', 'g', 0, { blendMode: mode }),
      ];
      expect(status(mirror.replaceSnapshot(snapshot(nodes)))).toBe('applied');
      const view = mirror.readRetainedScene()!;
      expect(view.getNode('g')!.blendMode).toBe(mode);
      expect(view.getNode('r')!.blendMode).toBe(mode);
    }
  });

  it('drops the defaults, under either option, so the scene is the same value', () => {
    for (const options of [V0, NONE]) {
      const mirror = new RetainedSceneMirror(undefined, options);
      const nodes = [
        group('g', null, ['r'], { blendMode: 'passThrough' }),
        box('r', 'g', 0, { blendMode: 'normal' }),
      ];
      expect(status(mirror.replaceSnapshot(snapshot(nodes)))).toBe('applied');
      const view = mirror.readRetainedScene()!;
      expect('blendMode' in view.getNode('g')!).toBe(false);
      expect('blendMode' in view.getNode('r')!).toBe(false);
    }
  });

  it('rejects passThrough on a leaf and unknown modes as invalid-value', () => {
    for (const options of [V0, NONE]) {
      expect(replace([box('r', null, 0, { blendMode: 'passThrough' })], options)).toBe(
        'invalid-value',
      );
      expect(replace([box('r', null, 0, { blendMode: 'linearBurn' as never })], options)).toBe(
        'invalid-value',
      );
      expect(replace([group('g', null, [], { blendMode: 'plus' as never })], options)).toBe(
        'invalid-value',
      );
    }
  });

  it("reports a non-default mode as unsupported-feature under blend 'none'", () => {
    expect(replace([box('r', null, 0, { blendMode: 'multiply' })], NONE)).toBe(
      'unsupported-feature',
    );
    expect(replace([group('g', null, [], { blendMode: 'normal' })], NONE)).toBe(
      'unsupported-feature',
    );
    expect(replace([group('g', null, [], { blendMode: 'screen' })], NONE)).toBe(
      'unsupported-feature',
    );
  });

  it("the service option: 'v0' needs groups isolated, and asks for the blend pipeline", () => {
    const invalidate = { invalidate: () => undefined } as never;
    expect(() => new PrimitiveRendererService(invalidate, { blend: 'v0' })).toThrow(
      "blend: 'v0' needs groups: 'isolated'.",
    );
    expect(() => new PrimitiveRendererService(invalidate, { blend: 'v1' } as never)).toThrow(
      "blend must be 'none' or 'v0'.",
    );
    const on = new PrimitiveRendererService(invalidate, {
      blend: 'v0',
      groups: 'isolated',
      clips: 'all',
    });
    expect(on.requiresBlendPipeline).toBe(true);
    const off = new PrimitiveRendererService(invalidate, { groups: 'isolated', clips: 'all' });
    expect(off.requiresBlendPipeline).toBe(false);
    // The service's mirror follows the option.
    expect(
      on.replaceSnapshot(snapshot([box('r', null, 0, { blendMode: 'multiply' })])).status,
    ).toBe('applied');
    expect(
      status(off.replaceSnapshot(snapshot([box('r', null, 0, { blendMode: 'multiply' })]))),
    ).toBe('unsupported-feature');
  });
});

describe('V35-K3 depth (the E25-S2 amendment)', () => {
  const max = SCENE_MAX_ISOLATION_DEPTH;
  /** `levels` nested containers with `mode`, opacity 1, then the leaf `leaf`. */
  const chain = (levels: number, mode: SceneBlendMode, leafMode?: SceneBlendMode) => {
    const nodes: RenderNodeSnapshot[] = [];
    for (let level = 0; level < levels; level += 1) {
      const child = level + 1 < levels ? `g${level + 1}` : 'leaf';
      nodes.push(
        group(`g${level}`, level === 0 ? null : `g${level - 1}`, [child], { blendMode: mode }),
      );
    }
    nodes.push(
      box('leaf', levels === 0 ? null : `g${levels - 1}`, 0, {
        ...(leafMode === undefined ? {} : { blendMode: leafMode }),
      }),
    );
    return nodes;
  };

  it('counts a normal container at opacity 1 and a container blend root as isolating', () => {
    expect(replace(chain(max, 'normal'))).toBe('applied');
    expect(replace(chain(max + 1, 'normal'))).toBe('unsupported-feature');
    expect(replace(chain(max + 1, 'multiply'))).toBe('unsupported-feature');
    // passThrough containers do not isolate.
    expect(replace(chain(max + 1, 'passThrough'))).toBe('applied');
  });

  it('gives a leaf blend root one layer of its own', () => {
    expect(replace(chain(max - 1, 'normal', 'screen'))).toBe('applied');
    expect(replace(chain(max, 'normal', 'screen'))).toBe('unsupported-feature');
  });

  it('does not count hidden ones or ones with opacity 0', () => {
    const hidden = chain(max + 1, 'normal').map((node) =>
      node.id === 'g0' ? { ...node, visible: false } : node,
    );
    expect(replace(hidden)).toBe('applied');
    const transparent = chain(max + 1, 'multiply').map((node) =>
      node.id === 'g0' ? { ...node, opacity: 0 } : node,
    );
    expect(replace(transparent)).toBe('applied');
  });

  it('checks the depth in a change set that only sets a mode', () => {
    const mirror = new RetainedSceneMirror(undefined, V0);
    const nodes = chain(max + 1, 'passThrough');
    expect(status(mirror.replaceSnapshot(snapshot(nodes)))).toBe('applied');
    const result = mirror.applyChanges({
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [],
      updated: nodes
        .filter((node) => node.kind === 'container')
        .map((node) => ({ ...node, blendMode: 'normal' as const })),
      removed: [],
      orders: [],
    });
    expect(status(result)).toBe('unsupported-feature');
  });
});

describe('V35-K3 blend roots and isolating containers in the plan', () => {
  it('makes a container blend root a layer with its mode and a backdrop request', () => {
    const { source } = setup([
      box('a', null, 0),
      group('g', null, ['b', 'c'], { blendMode: 'multiply', opacity: 0.75 }),
      box('b', 'g', 100),
      box('c', 'g', 104),
    ]);
    const packet = source.prepare(target)!;
    expect(layerSummary(packet)).toEqual([
      { nodeId: 'g', opacity: 0.75, parent: -1, blend: 'multiply', backdrop: { margin: 0 } },
    ]);
    expect(packet.draws.map((draw) => [draw.first, draw.count])).toEqual([[0, 1]]);
  });

  it('makes a leaf blend root a layer at opacity 1 whose draw keeps its opacity', () => {
    const { source } = setup([
      box('a', null, 0),
      box('b', null, 100, { blendMode: 'screen', opacity: 0.5 }),
    ]);
    const packet = source.prepare(target)!;
    expect(layerSummary(packet)).toEqual([
      { nodeId: 'b', opacity: 1, parent: -1, blend: 'screen', backdrop: { margin: 0 } },
    ]);
    expect(packet.layers!.layers[0]!.draws).toHaveLength(1);
  });

  it('makes an isolating container (normal) a layer composited with source-over', () => {
    const { source } = setup([group('g', null, ['b'], { blendMode: 'normal' }), box('b', 'g', 0)]);
    expect(layerSummary(source.prepare(target)!)).toEqual([
      { nodeId: 'g', opacity: 1, parent: -1 },
    ]);
  });

  it('keeps one layer for a node that is also an E25 layer or an effect root', () => {
    const { source } = setup([
      group('g', null, ['b'], { blendMode: 'difference', opacity: 0.5, effects: [SHADOW] }),
      box('b', 'g', 0),
      box('c', null, 100, { blendMode: 'overlay', effects: [SHADOW] }),
    ]);
    const packet = source.prepare(target)!;
    expect(layerSummary(packet)).toEqual([
      {
        nodeId: 'g',
        opacity: 0.5,
        parent: -1,
        blend: 'difference',
        backdrop: { margin: 0 },
        effect: true,
      },
      {
        nodeId: 'c',
        opacity: 1,
        parent: -1,
        blend: 'overlay',
        backdrop: { margin: 0 },
        effect: true,
      },
    ]);
  });

  it('nests a blend root inside an E25 layer and an isolating container', () => {
    const { source } = setup([
      group('outer', null, ['iso'], { opacity: 0.5 }),
      group('iso', 'outer', ['leaf', 'other'], { blendMode: 'normal' }),
      box('leaf', 'iso', 0, { blendMode: 'colorBurn' }),
      box('other', 'iso', 40),
    ]);
    expect(layerSummary(source.prepare(target)!)).toEqual([
      { nodeId: 'leaf', opacity: 1, parent: 1, blend: 'colorBurn', backdrop: { margin: 0 } },
      { nodeId: 'iso', opacity: 1, parent: 2 },
      { nodeId: 'outer', opacity: 0.5, parent: -1 },
    ]);
  });

  it("ignores a mask source's mode (P4-S2) and a passThrough container's", () => {
    const { source } = setup([
      group('m', null, ['s', 'c'], { clip: { kind: 'mask' } as SceneClip }),
      box('s', 'm', 0, { blendMode: 'multiply', size: 50 }),
      box('c', 'm', 0),
      group('p', null, ['d'], { blendMode: 'passThrough' }),
      box('d', 'p', 100),
    ]);
    expect(source.prepare(target)!.layers).toBeUndefined();
  });

  it('draws no layer for opacity 0 or a hidden blend root', () => {
    const { source } = setup([
      group('g', null, ['b'], { blendMode: 'multiply', opacity: 0 }),
      box('b', 'g', 0),
      box('c', null, 100, { blendMode: 'multiply' }),
      group('h', null, ['d'], { blendMode: 'screen', visible: false }),
      box('d', 'h', 0),
    ]);
    expect(layerSummary(source.prepare(target)!).map((layer) => layer.nodeId)).toEqual(['c']);
  });
});

describe('V35-K7 without the blend pipeline', () => {
  it('draws blend roots as normal and isolating containers as passThrough, without notices', () => {
    const nodes = [
      box('a', null, 0),
      group('g', null, ['b'], { blendMode: 'multiply' }),
      box('b', 'g', 100),
      group('n', null, ['c'], { blendMode: 'normal' }),
      box('c', 'n', 200, { blendMode: 'screen' }),
      group('o', null, ['d'], { blendMode: 'hue', opacity: 0.5 }),
      box('d', 'o', 300),
    ];
    const { source } = setup(nodes);
    const packet = source.prepare({ ...target, blendLayers: false })!;
    // Only the E25 layer stays, composited with source-over; the rest is drawn in the main pass.
    expect(layerSummary(packet)).toEqual([{ nodeId: 'o', opacity: 0.5, parent: -1 }]);
    expect(packet.draws.map((draw) => [draw.first, draw.count])).toEqual([[0, 3]]);
    expect(packet.layers!.blendNotices).toBeUndefined();
  });
});

describe('V35-A06 plan identity', () => {
  it("'v0' without blending plans the same packet as 'none'", () => {
    const nodes = [
      box('a', null, 0),
      group('g', null, ['b'], { opacity: 0.5 }),
      box('b', 'g', 100),
      box('c', null, 200, { effects: [SHADOW] }),
    ];
    const on = setup(nodes, V0).source.prepare(target)!;
    const off = setup(nodes, NONE).source.prepare({ ...target, blendLayers: false })!;
    expect(on.layers).toEqual(off.layers);
    expect(on.draws).toEqual(off.draws);
  });
});

describe('V35-K6 budget and the first 64 blend roots', () => {
  const big: PrimitiveTarget = {
    ...target,
    width: 3840,
    height: 2160,
    sampleCount: 4,
  };
  const full = (id: string, parentId: string | null, extra = {}) =>
    box(id, parentId, -100, { size: 5000, y: -100, ...extra });

  it('drops the V-35 layers of a tree over the budget and keeps its content', () => {
    // An E25 layer holding a blend-only container: two full-screen layers, the snapshot and the
    // tile set need 4 × 33,177,600 + 25,165,824 bytes, over the 96 MiB budget.
    const nodes = [
      group('outer', null, ['inner'], { opacity: 0.5 }),
      group('inner', 'outer', ['leaf'], { blendMode: 'multiply' }),
      full('leaf', 'inner'),
    ];
    const { source } = setup(nodes);
    const packet = source.prepare(big)!;
    expect(layerSummary(packet)).toEqual([{ nodeId: 'outer', opacity: 0.5, parent: -1 }]);
    expect(packet.layers!.layers[0]!.draws).toHaveLength(1);
    expect(packet.layers!.notices).toEqual([]);
    expect(packet.layers!.blendNotices).toEqual([
      {
        nodeId: 'outer',
        bytes: 3 * 33_177_600 + 25_165_824,
        limit: E25_LAYER_BYTES_MAX,
        reason: 'budget',
      },
    ]);
    // One notice per transition: the next frame over the budget raises none.
    const next = source.prepare({ ...big, generation: 2 })!;
    expect(next.layers!.blendNotices).toBeUndefined();
    expect(source.getBlendNoticesDropped()).toBe(0);
  });

  it('dissolves a top-level blend-only root over the budget: its content draws directly', () => {
    const nodes = [
      group('g', null, ['inner'], { blendMode: 'screen' }),
      group('inner', 'g', ['leaf'], { blendMode: 'normal' }),
      full('leaf', 'inner'),
    ];
    // Two full-screen layers, one snapshot and the tile set: 124,698,624 bytes.
    const packet = setup(nodes).source.prepare(big)!;
    expect(packet.layers!.layers).toEqual([]);
    expect(packet.draws.map((draw) => [draw.first, draw.count])).toEqual([[0, 1]]);
    expect(packet.layers!.blendNotices).toEqual([
      expect.objectContaining({ nodeId: 'g', reason: 'budget' }),
    ]);
  });

  it('draws the blend roots past the first 64 of a frame as normal, one notice each', () => {
    const count = V35_BLEND_ROOTS_MAX + 2;
    const nodes = Array.from({ length: count }, (_, index) =>
      box(`b${index}`, null, (index % 30) * 20, {
        blendMode: 'multiply',
        y: 20 * Math.floor(index / 30),
      }),
    );
    const { source } = setup(nodes);
    const packet = source.prepare(target)!;
    const blended = packet.layers!.layers.filter((layer) => layer.blend !== undefined);
    expect(blended).toHaveLength(V35_BLEND_ROOTS_MAX);
    expect(blended.map((layer) => layer.nodeId)).toEqual(
      nodes.slice(0, V35_BLEND_ROOTS_MAX).map((node) => node.id),
    );
    // The last two draw in the main pass.
    expect(packet.draws.map((draw) => draw.count).reduce((sum, value) => sum + value, 0)).toBe(2);
    expect(packet.layers!.blendNotices).toEqual([
      { nodeId: `b${count - 2}`, bytes: 0, limit: V35_BLEND_ROOTS_MAX, reason: 'count' },
      { nodeId: `b${count - 1}`, bytes: 0, limit: V35_BLEND_ROOTS_MAX, reason: 'count' },
    ]);
  });

  it('raises render.blend-resource-limit', () => {
    const diagnostic = blendResourceLimitDiagnostic(
      { nodeId: 'g', bytes: 10, limit: 5, reason: 'budget' },
      3,
    );
    expect(diagnostic).toMatchObject({
      code: DIAGNOSTIC_CODES.BLEND_RESOURCE_LIMIT,
      severity: 'warning',
      generation: 3,
      context: { nodeId: 'g', bytes: 10, limit: 5, reason: 'budget' },
    });
    expect(DIAGNOSTIC_CODES.BLEND_RESOURCE_LIMIT).toBe('render.blend-resource-limit');
  });
});

describe('V35-K4 backdrop splits', () => {
  const view = { width: 640, height: 360 };
  it('one split in the main pass, none without a backdrop request', () => {
    const splits = planBackdropSplits(
      [
        { parent: -1, bound: { x: 10, y: 10, width: 20, height: 20 }, backdrop: { margin: 0 } },
        { parent: -1, bound: { x: 50, y: 10, width: 20, height: 20 } },
      ],
      view,
      1024,
      1024,
    );
    expect(splits).toEqual([{ layer: 0, tile: -1, rect: { x: 10, y: 10, width: 20, height: 20 } }]);
  });

  it('one split per tile pass of the parent that the composite reaches', () => {
    const splits = planBackdropSplits(
      [
        { parent: 2, bound: { x: 100, y: 10, width: 40, height: 20 }, backdrop: { margin: 0 } },
        { parent: 2, bound: { x: 0, y: 0, width: 20, height: 20 }, backdrop: { margin: 0 } },
        { parent: -1, bound: { x: 0, y: 0, width: 300, height: 100 } },
      ],
      view,
      128,
      64,
    );
    // Parent tiles: 3 columns (0, 128, 256) × 2 rows (0, 64).
    expect(splits).toEqual([
      { layer: 0, tile: 0, rect: { x: 100, y: 10, width: 28, height: 20 } },
      { layer: 0, tile: 1, rect: { x: 128, y: 10, width: 12, height: 20 } },
      { layer: 1, tile: 0, rect: { x: 0, y: 0, width: 20, height: 20 } },
    ]);
  });

  it('grows the snapshot by the margin inside the pass (V-36), clamped to it', () => {
    const splits = planBackdropSplits(
      [{ parent: -1, bound: { x: 0, y: 10, width: 20, height: 20 }, backdrop: { margin: 3 } }],
      view,
      1024,
      1024,
    );
    expect(splits[0]!.rect).toEqual({ x: 0, y: 7, width: 23, height: 26 });
  });
});
