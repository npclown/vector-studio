import type {
  RenderNodeSnapshot,
  SceneAffine,
  SceneClip,
  SceneColor,
  SceneEffect,
} from '@vector-studio/contracts';
import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  E41_SIGMA_PX_MAX,
  blurLevels,
  cullTarget,
  deviceEffects,
  extendEffectReach,
  effectBounds,
  effectMargin,
  effectResourceLimitDiagnostic,
  largestSingularValue,
  planEffectBudget,
} from '../../packages/renderer-core/src/effect-plan.js';
import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), unit U4b: the effect-layer plan
// in renderer-core. E41-S9 device effects and K4's clamp and levels, K1 margins, K2 bounds
// (the off-screen caster, the mask-group clamp), the section 5.4 budget with its notices
// (E41-S8), effect roots as layers in the source's packet, and the service's `effects` option.

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const black: SceneColor = { r: 0, g: 0, b: 0, a: 0.5 };
const red: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const shadow = (offsetX: number, offsetY: number, sigma: number): SceneEffect => ({
  kind: 'dropShadow',
  color: black,
  offsetX,
  offsetY,
  sigma,
});
const blur = (sigma: number): SceneEffect => ({ kind: 'layerBlur', sigma });

describe('E41-S9 device effects, K4 clamp and levels', () => {
  it('takes the largest singular value of the linear part', () => {
    expect(largestSingularValue(IDENTITY)).toBeCloseTo(1, 12);
    const angle = 0.7;
    const rotation: SceneAffine = [
      Math.cos(angle),
      Math.sin(angle),
      -Math.sin(angle),
      Math.cos(angle),
      5,
      6,
    ];
    expect(largestSingularValue(rotation)).toBeCloseTo(1, 12);
    expect(largestSingularValue([3, 0, 0, 2, 0, 0])).toBeCloseTo(3, 12);
    expect(largestSingularValue([1, 0, 2, 1, 0, 0])).toBeCloseTo(1 + Math.SQRT2, 12);
  });

  it('rotates offsets with the root and scales offsets and σ by the camera', () => {
    const quarter: SceneAffine = [0, 1, -1, 0, 0, 0];
    const result = deviceEffects([shadow(4, 0, 2), blur(3)], quarter, 2);
    expect(result.shadows[0]!.dx).toBeCloseTo(0, 12);
    expect(result.shadows[0]!.dy).toBeCloseTo(8, 12);
    expect(result.shadows[0]!.sigmaPx).toBeCloseTo(4, 12);
    expect(result.blurSigmaPx).toBeCloseTo(6, 12);
    expect(result.clamped).toBe(0);
  });

  it('clamps σ_px to 256 and counts it', () => {
    const result = deviceEffects([shadow(0, 0, 200), blur(100)], IDENTITY, 2);
    expect(result.shadows[0]!.sigmaPx).toBe(E41_SIGMA_PX_MAX);
    expect(result.blurSigmaPx).toBe(200);
    expect(result.clamped).toBe(1);
  });

  it('downsamples by 2 per level until 32 taps per side suffice, at most 5 levels', () => {
    expect(blurLevels(0)).toBe(0);
    expect(blurLevels(10)).toBe(0);
    expect(blurLevels(10.7)).toBe(1);
    // F9: zoom 8, radius 40, σ_px 160: 4 levels.
    expect(blurLevels(160)).toBe(4);
    expect(blurLevels(256)).toBe(5);
    expect(blurLevels(1e6)).toBe(5);
  });

  it('E41-K1 margin: ⌈3σ_blur⌉ + max over shadows of ⌈3σᵢ⌉ + |offsetᵢ|', () => {
    const effects = deviceEffects([shadow(3, 4, 2), shadow(0, 1, 5), blur(1)], IDENTITY, 1);
    // Shadows: 6 + 5 = 11 and 15 + 1 = 16; blur 3.
    expect(effectMargin(effects)).toBe(19);
    expect(effectMargin(deviceEffects([blur(0)], IDENTITY, 1))).toBe(0);
  });
});

describe('E41-K3 reach', () => {
  it('grows a leaf’s cull bound by the summed world reach, against the outer clip', () => {
    const outer = extendEffectReach(null, [shadow(40, 0, 2)], IDENTITY, null);
    expect(outer.margin).toBeCloseTo(46, 12);
    const inner = extendEffectReach(outer, [blur(1)], [2, 0, 0, 2, 0, 0], null);
    expect(inner.margin).toBeCloseTo(52, 12);
    const bounds = { minX: -30, minY: 20, maxX: -20, maxY: 30 };
    expect(cullTarget(bounds, null, outer).bounds).toEqual({
      minX: -76,
      minY: -26,
      maxX: 26,
      maxY: 76,
    });
    expect(cullTarget(bounds, null, undefined).bounds).toBe(bounds);
  });
});

describe('E41-K2 bounds', () => {
  const view = { x: 0, y: 0, width: 640, height: 360 };

  it('gives the source and output bounds with even rounding', () => {
    const effects = deviceEffects([shadow(4, 6, 2)], IDENTITY, 1);
    const bounds = effectBounds({ minX: 99, minY: 19, maxX: 111, maxY: 31 }, view, effects);
    expect(bounds).toEqual({
      source: { x: 98, y: 18, width: 14, height: 14 },
      // m = 6 + ⌈√52⌉ = 14: [85, 125] × [5, 45].
      output: { x: 84, y: 4, width: 42, height: 42 },
    });
  });

  it('keeps an off-screen caster whose shadow reaches the view', () => {
    const effects = deviceEffects([shadow(40, 0, 2)], IDENTITY, 1);
    const content = { minX: -31, minY: 19, maxX: -19, maxY: 31 };
    const bounds = effectBounds(content, view, effects)!;
    expect(bounds.source.x).toBeLessThan(0);
    expect(bounds.output).toEqual({ x: 0, y: 0, width: 28, height: 78 });
    // Too far: the shadow misses the view too.
    expect(effectBounds({ ...content, minX: -131, maxX: -119 }, view, effects)).toBeNull();
    // A mask group under the root clamps both bounds to the target (disclosed limit).
    expect(effectBounds(content, view, effects, view)).toBeNull();
  });

  it('bounds the source by the reach of each shadow into the view', () => {
    const effects = deviceEffects([shadow(0, 100, 1)], IDENTITY, 1);
    // Content far below the view: only the part that casts into the view is kept.
    const bounds = effectBounds({ minX: 10, minY: 300, maxX: 20, maxY: 900 }, view, effects)!;
    // (V − offset) ⊕ 3 reaches y ≤ 263; V itself reaches 360.
    expect(bounds.source).toEqual({ x: 10, y: 300, width: 10, height: 60 });
  });
});

describe('E41 section 5.4 budget', () => {
  const effect = (width: number, height: number) =>
    ({
      kind: 'effect',
      source: { x: 0, y: 0, width, height },
      output: { x: 0, y: 0, width, height },
    }) as const;

  it('admits a full-screen root at 1080p with effects (63.9 MB with R, scratch and tiles)', () => {
    const plan = planEffectBudget(
      [{ rootId: 'a', layers: [effect(1920, 1080)], withoutEffects: [], effectRoots: ['a'] }],
      4,
      8192,
    );
    expect([...plan.withEffects]).toEqual(['a']);
    expect(plan.effectNotices).toEqual([]);
  });

  it('drops a tree’s effects at 4K, keeping its isolated layers, with one notice', () => {
    const plan = planEffectBudget(
      [
        {
          rootId: 'a',
          layers: [effect(3840, 2160)],
          withoutEffects: [{ rootId: 'a', layers: [{ width: 3840, height: 2160 }] }],
          effectRoots: ['a'],
        },
      ],
      4,
      8192,
    );
    expect(plan.withEffects.size).toBe(0);
    expect([...plan.plainAdmitted]).toEqual(['a']);
    expect(plan.effectNotices).toHaveLength(1);
    expect(plan.effectNotices[0]).toMatchObject({ nodeId: 'a', overTextureLimit: false });
    expect(plan.layerNotices).toEqual([]);
  });

  it('drops effects for a bound over the texture limit, and gives a layer notice when even E25 does not fit', () => {
    const over = planEffectBudget(
      [{ rootId: 'a', layers: [effect(100, 100)], withoutEffects: [], effectRoots: ['a'] }],
      1,
      64,
    );
    expect(over.withEffects.size).toBe(0);
    expect(over.admitted.size).toBe(0);
    expect(over.layerNotices).toEqual([]);
    expect(over.effectNotices[0]!.overTextureLimit).toBe(true);
    const none = planEffectBudget(
      [
        {
          rootId: 'b',
          layers: [effect(8000, 8000)],
          withoutEffects: [{ rootId: 'b', layers: [{ width: 8000, height: 8000 }] }],
          effectRoots: ['b'],
        },
      ],
      1,
      16384,
    );
    expect(none.admitted.size).toBe(0);
    expect(none.plainAdmitted.size).toBe(0);
    expect(none.layerNotices.map((notice) => notice.nodeId)).toEqual(['b']);
  });

  it('builds the render.effect-resource-limit diagnostic', () => {
    const diagnostic = effectResourceLimitDiagnostic(
      { nodeId: 'a', bytes: 200, limit: 100, overTextureLimit: false },
      3,
    );
    expect(diagnostic).toMatchObject({
      code: DIAGNOSTIC_CODES.EFFECT_RESOURCE_LIMIT,
      severity: 'warning',
      generation: 3,
      context: { nodeId: 'a', bytes: 200, limit: 100, overTextureLimit: false },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The source's packet.

const identity = { documentId: 'e41-u4b', pageId: 'page' } as const;
const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 1,
  targetFormat: 'bgra8unorm',
};

function group(
  id: string,
  parentId: string | null,
  children: readonly string[],
  opacity = 1,
  extra: Partial<{ effects: readonly SceneEffect[]; clip: SceneClip }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: IDENTITY,
    visible: true,
    opacity,
    kind: 'container',
    clip: extra.clip ?? null,
    children,
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
  };
}

function box(
  id: string,
  parentId: string | null,
  x: number,
  extra: Partial<{ effects: readonly SceneEffect[]; opacity: number; size: number }> = {},
): RenderNodeSnapshot {
  const size = extra.size ?? 10;
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, 20],
    visible: true,
    opacity: extra.opacity ?? 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: size, height: size, cornerRadii: [0, 0, 0, 0] },
    style: { fill: red, stroke: null },
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
  };
}

function setup(nodes: readonly RenderNodeSnapshot[], maxTextureDimension2D?: number) {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'unsupported',
    clips: 'supported',
    groupOpacity: 'supported',
    effects: 'v0',
  });
  mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  const source = new PrimitiveSceneSource(
    mirror,
    undefined,
    maxTextureDimension2D === undefined ? {} : { maxTextureDimension2D },
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
  return { mirror, source, replace };
}

function runs(draws: PrimitivePacket['draws']): [number, number][] {
  return draws.map((draw) => [draw.first, draw.count]);
}

describe('E41 section 5.2 effect roots in the packet', () => {
  it('makes a leaf root a layer at opacity 1 with its effect record', () => {
    const { source } = setup([
      box('a', null, 0),
      box('b', null, 100, { effects: [shadow(4, 6, 2)] }),
      box('c', null, 200),
    ]);
    const packet = source.prepare(target)!;
    expect(runs(packet.draws)).toEqual([
      [0, 1],
      [2, 1],
    ]);
    const layer = packet.layers!.layers[0]!;
    expect(layer).toMatchObject({
      nodeId: 'b',
      opacity: 1,
      parent: -1,
      bound: { x: 98, y: 18, width: 14, height: 14 },
      effect: {
        output: { x: 84, y: 4, width: 42, height: 42 },
        shadows: [{ color: black, dx: 4, dy: 6, sigmaPx: 2 }],
        blurSigmaPx: null,
        contentOpacity: 1,
      },
    });
    expect(runs(layer.draws)).toEqual([[1, 1]]);
    expect(packet.layers!.composites).toEqual([{ layer: 0, target: -1, position: 1, order: 0 }]);
    expect(source.getEffectStatistics()).toEqual({ roots: 1, clampedSigmas: 0 });
  });

  it('keeps a leaf root’s opacity in its draws and composites at 1', () => {
    const { source } = setup([box('b', null, 100, { opacity: 0.5, effects: [blur(1)] })]);
    const layer = source.prepare(target)!.layers!.layers[0]!;
    expect(layer.opacity).toBe(1);
    expect(layer.effect!.contentOpacity).toBe(0.5);
    expect(layer.effect!.blurSigmaPx).toBe(1);
  });

  it('draws a translucent container root as one layer with its opacity', () => {
    const { source } = setup([
      group('g', null, ['a', 'b'], 0.5, { effects: [shadow(0, 2, 1)] }),
      box('a', 'g', 100),
      box('b', 'g', 120),
    ]);
    const part = source.prepare(target)!.layers!;
    expect(part.layers).toHaveLength(1);
    expect(part.layers[0]).toMatchObject({ nodeId: 'g', opacity: 0.5 });
    expect(part.layers[0]!.effect!.contentOpacity).toBe(1);
    expect(runs(part.layers[0]!.draws)).toEqual([[0, 2]]);
  });

  it('nests an effect root in an E25 layer and an E25 layer in an effect root', () => {
    const { source } = setup([
      group('outer', null, ['root'], 0.5),
      group('root', 'outer', ['inner'], 1, { effects: [shadow(30, 0, 1)] }),
      group('inner', 'root', ['a'], 0.5),
      box('a', 'inner', 100),
    ]);
    const part = source.prepare(target)!.layers!;
    expect(part.layers.map((layer) => layer.nodeId)).toEqual(['inner', 'root', 'outer']);
    const [inner, root, outer] = part.layers;
    expect(inner!.parent).toBe(1);
    expect(root!.parent).toBe(2);
    expect(root!.effect).toBeDefined();
    // The E25 layer around the root holds the root's output reach (K2c), shadow included.
    expect(outer!.bound.x + outer!.bound.width).toBeGreaterThanOrEqual(
      root!.effect!.output.x + root!.effect!.output.width,
    );
  });

  it('has no packet layer for an off-screen caster until U5 draws its shadow (5.3)', () => {
    const { source } = setup([
      box('a', null, 10),
      box('b', null, -30, { effects: [shadow(40, 0, 2)] }),
    ]);
    const packet = source.prepare(target)!;
    expect(packet.layers?.layers ?? []).toEqual([]);
    expect(runs(packet.draws)).toEqual([[0, 1]]);
  });

  it('keeps every packet bound inside the target and its parent (E25 preflight)', () => {
    const { source } = setup([
      group('outer', null, ['b', 'c'], 0.5),
      box('b', 'outer', 0.5, { effects: [shadow(4, 4, 2)] }),
      box('c', 'outer', 630, { effects: [shadow(-4, 4, 2)] }),
    ]);
    const part = source.prepare(target)!.layers!;
    for (const layer of part.layers) {
      expect(layer.bound.x).toBeGreaterThanOrEqual(0);
      expect(layer.bound.y).toBeGreaterThanOrEqual(0);
      expect(layer.bound.x + layer.bound.width).toBeLessThanOrEqual(target.width);
      expect(layer.bound.y + layer.bound.height).toBeLessThanOrEqual(target.height);
      if (layer.parent !== -1) {
        const parent = part.layers[layer.parent]!.bound;
        expect(layer.bound.x).toBeGreaterThanOrEqual(parent.x);
        expect(layer.bound.x + layer.bound.width).toBeLessThanOrEqual(parent.x + parent.width);
      }
    }
    expect(part.layers.filter((layer) => layer.effect !== undefined)).toHaveLength(2);
  });

  it('casts a clipped root’s shadow outside its own clip', () => {
    const { source } = setup([
      group('card', null, ['a'], 1, {
        effects: [shadow(50, 0, 0)],
        clip: { kind: 'rect', x: 100, y: 20, width: 10, height: 10 },
      }),
      box('a', 'card', 90, { size: 40 }),
    ]);
    const layer = source.prepare(target)!.layers!.layers[0]!;
    // The source is the clip ([99, 111] even); the output reaches the shadow at +50.
    expect(layer.effect!.source).toEqual({ x: 98, y: 18, width: 14, height: 14 });
    expect(layer.effect!.output.x + layer.effect!.output.width).toBeGreaterThanOrEqual(160);
  });

  it('clamps a mask group that is itself an effect root to the target', () => {
    const odd: PrimitiveTarget = { ...target, width: 641 };
    const { source } = setup([
      group('m', null, ['s', 'c'], 1, {
        effects: [shadow(40, 0, 2), blur(2)],
        clip: { kind: 'mask' },
      }),
      box('s', 'm', 600),
      box('c', 'm', 600),
    ]);
    const layer = source.prepare(odd)!.layers!.layers[0]!;
    expect(layer.nodeId).toBe('m');
    // Without the clamp the output would reach V ⊕ b, 641 + 6.
    expect(layer.effect!.output.x + layer.effect!.output.width).toBe(641);
  });

  it('drops only the isolated subtree over budget when a tree drops its effects', () => {
    const big: PrimitiveTarget = { ...target, width: 8000, height: 8000 };
    const { source } = setup(
      [
        group('card', null, ['a', 'big'], 1, { effects: [shadow(2, 2, 1)] }),
        box('a', 'card', 10),
        group('big', 'card', ['b'], 0.5),
        box('b', 'big', 0, { size: 8000 }),
      ],
      16384,
    );
    const packet = source.prepare(big)!;
    // `a` still draws in the main pass; `big` is not drawn, with the notice on it.
    expect(packet.draws.reduce((sum, draw) => sum + draw.count, 0)).toBe(1);
    expect(packet.layers!.layers).toEqual([]);
    expect(packet.layers!.notices.map((notice) => notice.nodeId)).toEqual(['big']);
    expect(packet.layers!.effectNotices!.map((notice) => notice.nodeId)).toEqual(['card']);
  });

  it('clamps a root that holds a mask group to the target', () => {
    const mask = group('m', 'root', ['s', 'c'], 1, { clip: { kind: 'mask' } });
    const { source } = setup([
      group('root', null, ['m'], 1, { effects: [shadow(40, 0, 2)] }),
      mask,
      box('s', 'm', -30),
      box('c', 'm', -30),
    ]);
    const packet = source.prepare(target);
    expect(packet?.layers?.layers.some((layer) => layer.nodeId === 'root') ?? false).toBe(false);
  });

  it('drops effects over the texture limit: a leaf root draws in its parent, one notice', () => {
    const { source } = setup(
      [box('a', null, 0), box('b', null, 100, { effects: [shadow(4, 6, 2)], size: 100 })],
      64,
    );
    const packet = source.prepare(target)!;
    expect(packet.layers!.layers).toEqual([]);
    expect(runs(packet.draws)).toEqual([[0, 2]]);
    expect(packet.layers!.effectNotices).toEqual([
      expect.objectContaining({ nodeId: 'b', overTextureLimit: true }),
    ]);
    // One notice per transition (E41-S8): the next frame over the limit raises none.
    const next = source.prepare({ ...target, generation: 2 })!;
    expect(next.layers?.effectNotices).toBeUndefined();
    expect(source.getEffectNoticesDropped()).toBe(0);
  });

  it('keeps an isolated root as an E25 layer when its effects are dropped', () => {
    const { source } = setup(
      [
        group('g', null, ['a'], 0.5, { effects: [shadow(0, 2, 1)] }),
        box('a', 'g', 100, { size: 100 }),
      ],
      64,
    );
    const part = source.prepare(target)!.layers!;
    expect(part.layers).toHaveLength(1);
    expect(part.layers[0]).toMatchObject({ nodeId: 'g', opacity: 0.5 });
    expect(part.layers[0]!.effect).toBeUndefined();
  });
});

describe('E41-S6 service option', () => {
  const invalidate = { invalidate: () => undefined } as never;
  it('requires groups isolated for effects v0', () => {
    expect(() => new PrimitiveRendererService(invalidate, { effects: 'v0' })).toThrow(
      "effects: 'v0' needs groups: 'isolated'.",
    );
    expect(() => new PrimitiveRendererService(invalidate, { effects: 'blur' } as never)).toThrow(
      "effects must be 'none' or 'v0'.",
    );
    expect(
      () =>
        new PrimitiveRendererService(invalidate, {
          effects: 'v0',
          groups: 'isolated',
          clips: 'all',
        }),
    ).not.toThrow();
  });
});
