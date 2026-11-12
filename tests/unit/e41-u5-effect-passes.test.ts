import type { DeviceRect, LayerEffectRecord } from '@vector-studio/renderer-core';
import { describe, expect, it } from 'vitest';

import { effectOracle } from '../support/e41-effect-oracle.js';
import {
  EFFECT_PASS_RECORD_SIZE,
  EFFECT_SHADER,
  effectPipelineKey,
  packEffectPassRecord,
  planEffectPasses,
  type EffectPass,
  type EffectSurface,
} from '../../packages/renderer-webgpu/src/effect-pipeline.js';

// E41 contract, U5: the effect pass plan, run by a CPU twin of the effect module's fragment
// stages (in binary64, without 8-bit storage), against section 5.1 applied directly: a
// truncated, normalized separable Gaussian (K4's half-width) over `L / c`, shadows sampled
// bilinearly at their offsets, `R = c × (L₁ over Sₙ over … over S₁)`, then the layer blur.

type Image = { x: number; y: number; width: number; height: number; data: Float64Array };

function image(rect: DeviceRect): Image {
  return { ...rect, data: new Float64Array(rect.width * rect.height * 4) };
}

/**
 * A texel at absolute coordinates of an image, transparent outside it, or on the sides of the
 * V36-K3 edge mask (1 left, 2 top, 4 right, 8 bottom) the nearest texel of the image.
 */
function texel(source: Image, x: number, y: number, clamp = 0): number[] {
  let lx = x - source.x;
  let ly = y - source.y;
  if (clamp & 1) lx = Math.max(lx, 0);
  if (clamp & 2) ly = Math.max(ly, 0);
  if (clamp & 4) lx = Math.min(lx, source.width - 1);
  if (clamp & 8) ly = Math.min(ly, source.height - 1);
  if (lx < 0 || ly < 0 || lx >= source.width || ly >= source.height) return [0, 0, 0, 0];
  const at = (ly * source.width + lx) * 4;
  return [...source.data.subarray(at, at + 4)];
}

function bilinear(source: Image, px: number, py: number, clamp = 0): number[] {
  const bx = px - 0.5;
  const by = py - 0.5;
  const cx = Math.floor(bx);
  const cy = Math.floor(by);
  const wx = bx - cx;
  const wy = by - cy;
  const mix = (a: number[], b: number[], t: number) =>
    a.map((value, i) => value + (b[i]! - value) * t);
  const top = mix(texel(source, cx, cy, clamp), texel(source, cx + 1, cy, clamp), wx);
  const bottom = mix(texel(source, cx, cy + 1, clamp), texel(source, cx + 1, cy + 1, clamp), wx);
  return mix(top, bottom, wy);
}

/** Runs the plan as the module would, with images instead of textures. */
function runPlan(
  passes: readonly EffectPass[],
  content: Image,
  result: DeviceRect,
  scratch: Readonly<{ width: number; height: number }>,
): Image {
  const surfaces: Record<EffectSurface, Image> = {
    content,
    result: image(result),
    scratch0: image({ x: 0, y: 0, ...scratch }),
    scratch1: image({ x: 0, y: 0, ...scratch }),
  };
  for (const pass of passes) {
    const target = surfaces[pass.target];
    const backing = surfaces[pass.source];
    // The source as the module sees it: its region at srcOrigin, transparent outside.
    const source: Image = {
      x: pass.srcOrigin[0],
      y: pass.srcOrigin[1],
      width: pass.srcSize[0],
      height: pass.srcSize[1],
      data: crop(backing, pass.srcSize[0], pass.srcSize[1]),
    };
    if (pass.clear) target.data.fill(0);
    const clamp = pass.edge;
    const written = new Float64Array(target.data);
    for (let row = 0; row < pass.height; row += 1) {
      for (let column = 0; column < pass.width; column += 1) {
        const x = column + pass.dstOrigin[0];
        const y = row + pass.dstOrigin[1];
        let value: number[];
        switch (pass.kind) {
          case 'downsample': {
            const sum = [0, 0, 0, 0];
            for (const [dx, dy] of [
              [0, 0],
              [1, 0],
              [0, 1],
              [1, 1],
            ] as const) {
              texel(source, 2 * x + dx, 2 * y + dy, clamp).forEach((v, i) => (sum[i]! += v / 4));
            }
            value = sum;
            break;
          }
          case 'blur': {
            const sum = [0, 0, 0, 0];
            let total = 0;
            for (let tap = -pass.radius; tap <= pass.radius; tap += 1) {
              const weight = Math.exp(-(tap * tap) / (2 * pass.sigma * pass.sigma));
              texel(source, x + tap * pass.dir[0], y + tap * pass.dir[1], clamp).forEach(
                (v, i) => (sum[i]! += weight * v),
              );
              total += weight;
            }
            value = sum.map((v) => v / total);
            break;
          }
          case 'upsample':
            value = bilinear(
              source,
              (x + 0.5) / pass.levelScale,
              (y + 0.5) / pass.levelScale,
              clamp,
            );
            break;
          case 'tint': {
            const alpha = bilinear(
              source,
              (x + 0.5 - pass.offset[0]) / pass.levelScale,
              (y + 0.5 - pass.offset[1]) / pass.levelScale,
            )[3]!;
            value = pass.color.map((c) => c * Math.min(alpha * pass.contentScale, 1));
            break;
          }
          case 'merge':
            value = texel(source, x, y, clamp).map((v) => Math.min(v * pass.contentScale, 1));
            break;
          case 'harden': {
            const alpha = Math.min(texel(source, x, y, clamp)[3]! * pass.contentScale, 1);
            value = [alpha, alpha, alpha, alpha];
            break;
          }
          case 'innerTint': {
            const alpha = bilinear(
              source,
              (x + 0.5 - pass.offset[0]) / pass.levelScale,
              (y + 0.5 - pass.offset[1]) / pass.levelScale,
              clamp,
            )[3]!;
            value = pass.color.map((c) => c * (1 - Math.min(alpha * pass.contentScale, 1)));
            break;
          }
          case 'coverage': {
            const alpha = Math.min(texel(source, x, y, clamp)[3]! * pass.contentScale, 1);
            value = [alpha, alpha, alpha, alpha];
            break;
          }
        }
        // Pixel (column, row) of the attachment.
        const at = (row * target.width + column) * 4;
        if (pass.kind === 'coverage') {
          // dst × src.a.
          for (let i = 0; i < 4; i += 1) written[at + i] = written[at + i]! * value[3]!;
        } else if (pass.kind === 'tint' || pass.kind === 'merge') {
          const keep = 1 - value[3]!;
          for (let i = 0; i < 4; i += 1) written[at + i] = value[i]! + written[at + i]! * keep;
        } else {
          for (let i = 0; i < 4; i += 1) written[at + i] = value[i]!;
        }
      }
    }
    target.data.set(written);
  }
  return surfaces.result;
}

/** The top-left width × height texels of an image, as a tightly packed copy. */
function crop(source: Image, width: number, height: number): Float64Array {
  const data = new Float64Array(width * height * 4);
  for (let row = 0; row < Math.min(height, source.height); row += 1) {
    const length = Math.min(width, source.width) * 4;
    data.set(
      source.data.subarray(row * source.width * 4, row * source.width * 4 + length),
      row * width * 4,
    );
  }
  return data;
}

/** Section 5.1, directly. */
function oracle(content: Image, result: DeviceRect, effect: LayerEffectRecord): Image {
  const c = effect.contentOpacity;
  const blurImage = (source: Image, sigma: number, over: DeviceRect): Image => {
    const radius = Math.ceil(3 * sigma);
    const weights = Array.from({ length: 2 * radius + 1 }, (_, i) =>
      Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)),
    );
    const total = weights.reduce((a, b) => a + b, 0);
    const wide: DeviceRect = {
      x: over.x,
      y: over.y - radius,
      width: over.width,
      height: over.height + 2 * radius,
    };
    const horizontal = image(wide);
    for (let y = wide.y; y < wide.y + wide.height; y += 1)
      for (let x = wide.x; x < wide.x + wide.width; x += 1) {
        const at = ((y - wide.y) * wide.width + x - wide.x) * 4;
        weights.forEach((w, i) =>
          texel(source, x + i - radius, y).forEach(
            (v, k) => (horizontal.data[at + k]! += (w * v) / total),
          ),
        );
      }
    const out = image(over);
    for (let y = over.y; y < over.y + over.height; y += 1)
      for (let x = over.x; x < over.x + over.width; x += 1) {
        const at = ((y - over.y) * over.width + x - over.x) * 4;
        weights.forEach((w, i) =>
          texel(horizontal, x, y + i - radius).forEach(
            (v, k) => (out.data[at + k]! += (w * v) / total),
          ),
        );
      }
    return out;
  };
  const r = image(result);
  for (const shadow of effect.shadows) {
    // The blurred alpha of L₁ on L's grid, wide enough for every bilinear sample.
    const grid: DeviceRect = {
      x: Math.floor(result.x - shadow.dx) - 2,
      y: Math.floor(result.y - shadow.dy) - 2,
      width: result.width + 5,
      height: result.height + 5,
    };
    const blurred = shadow.sigmaPx > 0 ? blurImage(content, shadow.sigmaPx, grid) : content;
    const a = shadow.color.a;
    const color = [shadow.color.r * a, shadow.color.g * a, shadow.color.b * a, a];
    for (let y = result.y; y < result.y + result.height; y += 1)
      for (let x = result.x; x < result.x + result.width; x += 1) {
        const alpha = bilinear(blurred, x + 0.5 - shadow.dx, y + 0.5 - shadow.dy)[3]! / c;
        const at = ((y - result.y) * result.width + x - result.x) * 4;
        const keep = 1 - color[3]! * alpha;
        for (let k = 0; k < 4; k += 1) r.data[at + k] = color[k]! * alpha + r.data[at + k]! * keep;
      }
  }
  for (let y = result.y; y < result.y + result.height; y += 1)
    for (let x = result.x; x < result.x + result.width; x += 1) {
      const l = texel(content, x, y).map((v) => v / c);
      const at = ((y - result.y) * result.width + x - result.x) * 4;
      const keep = 1 - l[3]!;
      for (let k = 0; k < 4; k += 1) r.data[at + k] = l[k]! + r.data[at + k]! * keep;
    }
  return effect.blurSigmaPx !== null && effect.blurSigmaPx > 0
    ? blurImage(r, effect.blurSigmaPx, result)
    : r;
}

/** A content layer: an opaque-ish rectangle with a soft-coloured inner square, times c. */
function contentImage(rect: DeviceRect, c: number): Image {
  const out = image(rect);
  for (let y = 0; y < rect.height; y += 1)
    for (let x = 0; x < rect.width; x += 1) {
      const inner = x >= 4 && y >= 3 && x < rect.width - 5 && y < rect.height - 4;
      const ring = x >= 2 && y >= 2 && x < rect.width - 2 && y < rect.height - 2;
      const [cr, cg, cb, ca] = inner
        ? [0.2, 0.6, 0.9, 1]
        : ring
          ? [0.9, 0.3, 0.1, 0.6]
          : [0, 0, 0, 0];
      const at = (y * rect.width + x) * 4;
      out.data.set([cr * ca * c, cg * ca * c, cb * ca * c, ca * c], at);
    }
  return out;
}

/** A content layer with a different, non-zero texel everywhere, times c. */
function noiseImage(rect: DeviceRect, c: number): Image {
  const out = image(rect);
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < rect.width * rect.height; i += 1) {
    const a = 0.2 + 0.8 * next();
    out.data.set([next() * a * c, next() * a * c, next() * a * c, a * c], i * 4);
  }
  return out;
}

function maxDifference(a: Image, b: Image): number {
  let worst = 0;
  a.data.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - b.data[i]!))));
  return worst;
}

const black = { r: 0, g: 0, b: 0, a: 0.5 };
const content: DeviceRect = { x: 40, y: 30, width: 24, height: 18 };

function record(partial: Partial<LayerEffectRecord>): LayerEffectRecord {
  return {
    source: content,
    output: content,
    shadows: [],
    blurSigmaPx: null,
    contentOpacity: 1,
    ...partial,
  };
}

describe('E41-U5 effect pass plan against section 5.1', () => {
  const cases: [string, DeviceRect, Partial<LayerEffectRecord>, number][] = [
    ['no effects (merge only)', content, {}, 1e-12],
    [
      'one shadow, integer offset',
      { x: 30, y: 20, width: 50, height: 44 },
      { shadows: [{ color: black, dx: 4, dy: 6, sigmaPx: 3 }] },
      1e-9,
    ],
    [
      'one shadow, fractional offset, leaf root at c = 0.5',
      { x: 30, y: 20, width: 50, height: 44 },
      {
        shadows: [{ color: { r: 0.1, g: 0.2, b: 0.8, a: 0.7 }, dx: -2.5, dy: 3.25, sigmaPx: 2.2 }],
        contentOpacity: 0.5,
      },
      1e-9,
    ],
    [
      'two shadows in list order and a layer blur',
      { x: 24, y: 14, width: 60, height: 52 },
      {
        shadows: [
          { color: black, dx: 3, dy: 3, sigmaPx: 4 },
          { color: { r: 1, g: 0, b: 0, a: 1 }, dx: -5, dy: 1, sigmaPx: 0 },
        ],
        blurSigmaPx: 1.5,
      },
      1e-9,
    ],
  ];
  it.each(cases)('%s', (_, result, partial, tolerance) => {
    const effect = record({ output: result, ...partial });
    const l = contentImage(content, effect.contentOpacity);
    const plan = planEffectPasses(content, result, effect);
    const actual = runPlan(plan.passes, l, result, plan.scratch);
    // R is c × the result; the oracle is too.
    const expected = oracle(l, result, effect);
    expect(maxDifference(actual, expected)).toBeLessThan(tolerance);
  });

  // `R` well inside a content layer that is non-zero everywhere: every region edge matters.
  const wide: DeviceRect = { x: -90, y: -84, width: 230, height: 220 };
  const inside: [string, DeviceRect, Partial<LayerEffectRecord>][] = [
    [
      'fractional offsets, one level',
      { x: 20, y: 30, width: 31, height: 23 },
      {
        shadows: [
          { color: black, dx: 2.75, dy: -3.5, sigmaPx: 5 },
          { color: { r: 0.3, g: 0.9, b: 0.2, a: 0.8 }, dx: -4.25, dy: 1.5, sigmaPx: 2.5 },
          { color: black, dx: 0.5, dy: 0.25, sigmaPx: 0 },
        ],
        blurSigmaPx: 3,
        contentOpacity: 0.75,
      },
    ],
    [
      'downsampled shadow and blur',
      { x: 25, y: 35, width: 21, height: 17 },
      { shadows: [{ color: black, dx: 3.5, dy: -2.25, sigmaPx: 12 }], blurSigmaPx: 11 },
    ],
    [
      'two levels',
      { x: 21, y: 33, width: 19, height: 15 },
      { shadows: [{ color: black, dx: -1.75, dy: 2.5, sigmaPx: 23 }], blurSigmaPx: 22 },
    ],
    // U5b: L and R past the target's top-left corner (negative pixels), at every level.
    [
      'past the target, one level',
      { x: -61, y: -53, width: 27, height: 19 },
      {
        shadows: [{ color: black, dx: 3.25, dy: -2.5, sigmaPx: 6 }],
        blurSigmaPx: 2,
      },
    ],
    [
      'past the target, two levels',
      { x: -45, y: -37, width: 23, height: 21 },
      { shadows: [{ color: black, dx: -5.5, dy: 1.75, sigmaPx: 23 }], blurSigmaPx: 13 },
    ],
  ];
  it.each(inside)('%s, with R inside L', (_, result, partial) => {
    const effect = record({ source: wide, output: result, ...partial });
    const l = noiseImage(wide, effect.contentOpacity);
    const plan = planEffectPasses(wide, result, effect);
    const actual = runPlan(plan.passes, l, result, plan.scratch);
    // Both are R₁ = R / c; the composite applies c.
    const expected = effectOracle(l, result, effect);
    expect(maxDifference(actual, expected)).toBeLessThan(1e-9);
  });

  it('downsamples large σ (K4) and stays near the exact result', () => {
    const result: DeviceRect = { x: 0, y: 0, width: 120, height: 100 };
    const effect = record({
      output: result,
      shadows: [{ color: black, dx: 6, dy: 8, sigmaPx: 14 }],
      blurSigmaPx: 12,
    });
    const l = contentImage(content, 1);
    const plan = planEffectPasses(content, result, effect);
    expect(plan.passes.filter((pass) => pass.kind === 'downsample')).toHaveLength(2);
    expect(plan.passes.filter((pass) => pass.kind === 'upsample')).toHaveLength(1);
    const actual = runPlan(plan.passes, l, result, plan.scratch);
    const expected = oracle(l, result, effect);
    // A05's tolerance for downsampled σ is 6/255.
    expect(maxDifference(actual, expected)).toBeLessThan(6 / 255);
  });

  it('plans level regions inside the scratch textures and clears R once', () => {
    const result: DeviceRect = { x: 2, y: 4, width: 200, height: 150 };
    const effect = record({
      output: result,
      shadows: [
        { color: black, dx: 6, dy: 8, sigmaPx: 40 },
        { color: black, dx: 0, dy: 2, sigmaPx: 1 },
      ],
      blurSigmaPx: 100,
    });
    const plan = planEffectPasses(content, result, effect);
    expect(plan.passes.filter((pass) => pass.clear)).toHaveLength(1);
    expect(plan.passes.find((pass) => pass.target === 'result')!.clear).toBe(true);
    for (const pass of plan.passes) {
      expect(pass.source).not.toBe(pass.target);
      expect(pass.radius).toBeLessThanOrEqual(32);
      if (pass.target === 'result') {
        expect([pass.width, pass.height]).toEqual([result.width, result.height]);
      } else {
        expect(pass.width).toBeLessThanOrEqual(plan.scratch.width);
        expect(pass.height).toBeLessThanOrEqual(plan.scratch.height);
      }
    }
    // σ = 100 needs ⌈300 / 2^k⌉ ≤ 32: four levels.
    const blurs = plan.passes.filter((pass) => pass.kind === 'blur');
    expect(blurs.at(-1)!.sigma).toBeCloseTo(100 / 16);
  });

  it('treats a tiny σ as 0 and skips a shadow that cannot reach R', () => {
    const tiny = planEffectPasses(
      content,
      content,
      record({ shadows: [{ color: black, dx: 1, dy: 1, sigmaPx: 1e-30 }], blurSigmaPx: 1e-30 }),
    );
    expect(tiny.passes.map((pass) => pass.kind)).toEqual(['tint', 'merge']);
    const far = planEffectPasses(
      content,
      content,
      record({ shadows: [{ color: black, dx: 500, dy: 0, sigmaPx: 4 }] }),
    );
    expect(far.passes.map((pass) => pass.kind)).toEqual(['merge']);
  });

  it('packs records as the module reads them', () => {
    expect(EFFECT_SHADER).toContain('struct EffectPass');
    const plan = planEffectPasses(
      content,
      content,
      record({ shadows: [{ color: black, dx: 1.5, dy: -2, sigmaPx: 2 }], contentOpacity: 0.5 }),
    );
    const tint = plan.passes.find((pass) => pass.kind === 'tint')!;
    const bytes = packEffectPassRecord(tint);
    expect(bytes.byteLength).toBe(EFFECT_PASS_RECORD_SIZE);
    const view = new DataView(bytes.buffer);
    expect(view.getFloat32(32, true)).toBe(1.5);
    expect(view.getFloat32(36, true)).toBe(-2);
    expect(view.getFloat32(52, true)).toBe(2);
    expect(view.getFloat32(76, true)).toBe(0.5);
    expect(effectPipelineKey('bgra8unorm', 'tint').renderStateKey).toContain('source-over');
    expect(effectPipelineKey('bgra8unorm', 'blur').renderStateKey).toContain('replace');
  });
});

// V-36 contract (docs/plans/viz-v36-inner-shadow-background-blur-contract.md), V36-K1b, K2 and
// K3: inner shadows (harden, blur, innerTint, coverage, merge) against section 4.1, the cut
// sides and the edge mask.
describe('V36 inner shadow passes against section 4.1', () => {
  const red = { r: 1, g: 0.1, b: 0.1, a: 0.8 };
  const cases: [string, DeviceRect, Partial<LayerEffectRecord>][] = [
    [
      'one inner shadow, integer offset',
      { x: 36, y: 26, width: 32, height: 26 },
      { innerShadows: [{ color: black, dx: 2, dy: 3, sigmaPx: 2 }] },
    ],
    [
      'σ 0 at a fractional offset, leaf root at c = 0.5',
      content,
      { innerShadows: [{ color: red, dx: -1.5, dy: 2.25, sigmaPx: 0 }], contentOpacity: 0.5 },
    ],
    [
      'an offset past the shape (full colour inside)',
      content,
      { innerShadows: [{ color: red, dx: 0, dy: 400, sigmaPx: 3 }] },
    ],
    [
      'two inner shadows over a drop shadow, then a layer blur',
      { x: 24, y: 14, width: 60, height: 52 },
      {
        shadows: [{ color: black, dx: 3, dy: 3, sigmaPx: 4 }],
        innerShadows: [
          { color: black, dx: 0, dy: 4, sigmaPx: 2 },
          { color: red, dx: -3, dy: -1, sigmaPx: 1.5 },
        ],
        blurSigmaPx: 1.5,
        contentOpacity: 0.75,
      },
    ],
    [
      'downsampled σ (two levels)',
      { x: 30, y: 20, width: 44, height: 38 },
      { innerShadows: [{ color: black, dx: 1.25, dy: -2.5, sigmaPx: 23 }] },
    ],
  ];
  it.each(cases)('%s', (_, result, partial) => {
    const effect = record({ output: result, ...partial });
    const l = contentImage(content, effect.contentOpacity);
    const plan = planEffectPasses(content, result, effect);
    const actual = runPlan(plan.passes, l, result, plan.scratch);
    expect(maxDifference(actual, effectOracle(l, result, effect))).toBeLessThan(1e-9);
  });

  it('gives a translucent interior an edge-only shadow (hardened coverage)', () => {
    const result = content;
    const effect = record({ innerShadows: [{ color: black, dx: 0, dy: 3, sigmaPx: 0 }] });
    const l = contentImage(content, 1);
    const plan = planEffectPasses(content, result, effect);
    const actual = runPlan(plan.passes, l, result, plan.scratch);
    // Deep inside the 60 %-alpha ring's interior (the inner square), R equals L there.
    const at = (10 * content.width + 12) * 4;
    expect([...actual.data.subarray(at, at + 4)]).toEqual([...l.data.subarray(at, at + 4)]);
  });

  it('reads L clamped on cut sides (K1b): no band along a cut edge', () => {
    // A layer that is solid everywhere, cut at its top by the target: the true content goes on.
    const cut: DeviceRect = { x: 0, y: 0, width: 30, height: 20 };
    const l = image(cut);
    for (let i = 0; i < cut.width * cut.height; i += 1) l.data.set([0.2, 0.4, 0.6, 1], i * 4);
    const shadow = { color: black, dx: 0, dy: 5, sigmaPx: 2 };
    const clamped = planEffectPasses(
      cut,
      cut,
      record({ source: cut, output: cut, innerShadows: [shadow], innerClamp: 2 }),
    );
    const actual = runPlan(clamped.passes, l, cut, clamped.scratch);
    // The oracle on the uncut layer (taller above): rows near the top see no edge.
    const tall: DeviceRect = { x: 0, y: -40, width: 30, height: 60 };
    const uncut = image(tall);
    for (let i = 0; i < tall.width * tall.height; i += 1) uncut.data.set([0.2, 0.4, 0.6, 1], i * 4);
    const expected = effectOracle(uncut, cut, record({ innerShadows: [shadow] }));
    const top = (column: number, data: Float64Array) => [
      ...data.subarray(column * 4, column * 4 + 4),
    ];
    expect(top(15, actual.data)).toEqual([0.2, 0.4, 0.6, 1]);
    expect(maxDifference(actual, expected)).toBeLessThan(1e-9);
    // Without the mask the cut reads as an edge and darkens the top rows.
    const unmasked = planEffectPasses(
      cut,
      cut,
      record({ source: cut, output: cut, innerShadows: [shadow] }),
    );
    const banded = runPlan(unmasked.passes, l, cut, unmasked.scratch);
    expect(top(15, banded.data)[3]!).toBe(1);
    expect(top(15, banded.data)[0]!).toBeLessThan(0.15);
  });

  it('plans harden, blur, innerTint, coverage and merge after the content', () => {
    const plan = planEffectPasses(
      content,
      content,
      record({
        shadows: [{ color: black, dx: 1, dy: 1, sigmaPx: 0 }],
        innerShadows: [{ color: black, dx: 0, dy: 2, sigmaPx: 3 }],
        innerClamp: 5,
      }),
    );
    expect(plan.passes.map((pass) => pass.kind)).toEqual([
      'tint',
      'merge',
      'harden',
      'blur',
      'blur',
      'innerTint',
      'coverage',
      'merge',
    ]);
    const [, , harden, horizontal, vertical, tint, coverage, merge] = plan.passes;
    expect(harden!.target).toBe('scratch1');
    expect(harden!.edge).toBe(5);
    expect(harden!.contentScale).toBe(127);
    expect(horizontal!.source).toBe('scratch1');
    // The harden region is exactly what the horizontal pass reads.
    expect([harden!.dstOrigin, harden!.width, harden!.height]).toEqual([
      horizontal!.srcOrigin,
      ...horizontal!.srcSize,
    ]);
    expect(tint!.source).toBe(vertical!.target);
    expect(tint!.target).not.toBe(vertical!.target);
    expect(tint!.contentScale).toBe(1);
    expect(coverage!.source).toBe('content');
    expect(coverage!.target).toBe(tint!.target);
    expect(coverage!.contentScale).toBe(127);
    expect([merge!.source, merge!.target, merge!.contentScale]).toEqual([
      tint!.target,
      'result',
      1,
    ]);
    for (const pass of plan.passes.filter((entry) => entry.target !== 'result')) {
      expect(pass.width).toBeLessThanOrEqual(plan.scratch.width);
      expect(pass.height).toBeLessThanOrEqual(plan.scratch.height);
    }
    expect(plan.passes.filter((pass) => pass.kind !== 'harden').every((p) => p.edge === 0)).toBe(
      true,
    );
  });

  it('packs the edge mask and keys the coverage blend', () => {
    expect(EFFECT_SHADER).toContain('fn hardenMain');
    expect(EFFECT_SHADER).toContain('fn innerTintMain');
    expect(EFFECT_SHADER).toContain('fn coverageMain');
    const plan = planEffectPasses(
      content,
      content,
      record({ innerShadows: [{ color: black, dx: 0, dy: 1, sigmaPx: 0 }] }),
    );
    const pass = plan.passes.find((entry) => entry.kind === 'coverage')!;
    const view = (bytes: Uint8Array) => new DataView(bytes.buffer);
    expect(view(packEffectPassRecord(pass)).getInt32(56, true)).toBe(0);
    expect(view(packEffectPassRecord({ ...pass, edge: 15 })).getInt32(56, true)).toBe(15);
    expect(effectPipelineKey('bgra8unorm', 'coverage').renderStateKey).toContain(
      'destination-times-source-alpha',
    );
    expect(effectPipelineKey('bgra8unorm', 'harden').renderStateKey).toContain('replace');
    expect(effectPipelineKey('bgra8unorm', 'innerTint').renderStateKey).toContain('replace');
    expect(effectPipelineKey('bgra8unorm', 'blur').shaderKey).toBe('e41-effect-v1#blur');
  });

  it('clamps texels on the masked sides only', () => {
    const source: Image = image({ x: 0, y: 0, width: 2, height: 1 });
    source.data.set([0.5, 0, 0, 1, 0, 0.5, 0, 1]);
    const wide = { x: -2, y: 0, width: 6, height: 1 };
    const passes = planEffectPasses(
      { x: 0, y: 0, width: 2, height: 1 },
      wide,
      record({ source: { x: 0, y: 0, width: 2, height: 1 } }),
    ).passes;
    const run = (edge: number) =>
      runPlan(
        passes.map((pass) => ({ ...pass, edge })),
        source,
        wide,
        { width: 0, height: 0 },
      ).data;
    expect([...run(15).subarray(0, 4)]).toEqual([0.5, 0, 0, 1]);
    expect([...run(15).subarray(20, 24)]).toEqual([0, 0.5, 0, 1]);
    expect([...run(1).subarray(20, 24)]).toEqual([0, 0, 0, 0]);
    expect([...run(4).subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });
});
