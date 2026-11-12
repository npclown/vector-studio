// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), section 5.1 with K4: the CPU
// oracle of an effect root's result `R₁ = L₁ over Sₙ over … over S₁` (then the layer blur;
// V-36 section 4.1 adds inner shadows over `L₁` before it),
// from its content `L` (premultiplied, carrying the leaf root's content opacity c). Each blur
// downsamples its whole source by 2 per level (box) while K4 needs it, blurs at σ / 2^k with
// ⌈3 σ / 2^k⌉ taps per side (at most 32), normalized over the taps, and is sampled bilinearly;
// the layer blur sees `R₁` transparent beyond `result`. Binary64, without 8-bit storage.

export type OracleRect = Readonly<{ x: number; y: number; width: number; height: number }>;
/** Premultiplied RGBA in [0, 1] over a rectangle of absolute pixels. */
export type OracleImage = {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Float64Array;
};
export type OracleShadow = Readonly<{
  color: Readonly<{ r: number; g: number; b: number; a: number }>;
  dx: number;
  dy: number;
  sigmaPx: number;
}>;
export type OracleEffect = Readonly<{
  shadows: readonly OracleShadow[];
  /** V-36 contract, section 4.1: inner shadows over the content, in list order. */
  innerShadows?: readonly OracleShadow[];
  blurSigmaPx: number | null;
  contentOpacity: number;
}>;

export function oracleImage(rect: OracleRect): OracleImage {
  return { ...rect, data: new Float64Array(rect.width * rect.height * 4) };
}

/** A texel at absolute coordinates, transparent outside the image. */
export function oracleTexel(source: OracleImage, x: number, y: number): number[] {
  const lx = x - source.x;
  const ly = y - source.y;
  if (lx < 0 || ly < 0 || lx >= source.width || ly >= source.height) return [0, 0, 0, 0];
  const at = (ly * source.width + lx) * 4;
  return [...source.data.subarray(at, at + 4)];
}

/** Bilinear at a point in pixel units (texel i spans [i, i + 1)). */
export function oracleBilinear(source: OracleImage, px: number, py: number): number[] {
  const bx = px - 0.5;
  const by = py - 0.5;
  const cx = Math.floor(bx);
  const cy = Math.floor(by);
  const wx = bx - cx;
  const wy = by - cy;
  const mix = (a: number[], b: number[], t: number) =>
    a.map((value, i) => value + (b[i]! - value) * t);
  const top = mix(oracleTexel(source, cx, cy), oracleTexel(source, cx + 1, cy), wx);
  const bottom = mix(oracleTexel(source, cx, cy + 1), oracleTexel(source, cx + 1, cy + 1), wx);
  return mix(top, bottom, wy);
}

/** K4's levels for σ in device pixels. */
export function oracleLevels(sigmaPx: number): number {
  let levels = 0;
  while (levels < 5 && Math.ceil((3 * sigmaPx) / 2 ** levels) > 32) levels += 1;
  return levels;
}

function blurred(
  source: OracleImage,
  sigmaPx: number,
): Readonly<{ level: OracleImage; scale: number }> {
  const levels = oracleLevels(sigmaPx);
  let level = source;
  for (let k = 0; k < levels; k += 1) {
    const x0 = Math.floor(level.x / 2) - 1;
    const y0 = Math.floor(level.y / 2) - 1;
    const next = oracleImage({
      x: x0,
      y: y0,
      width: Math.ceil((level.x + level.width) / 2) + 1 - x0,
      height: Math.ceil((level.y + level.height) / 2) + 1 - y0,
    });
    for (let y = 0; y < next.height; y += 1)
      for (let x = 0; x < next.width; x += 1) {
        const sum = [0, 0, 0, 0];
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          oracleTexel(level, 2 * (x + x0) + dx, 2 * (y + y0) + dy).forEach(
            (v, i) => (sum[i]! += v / 4),
          );
        }
        next.data.set(sum, (y * next.width + x) * 4);
      }
    level = next;
  }
  const sigma = sigmaPx / 2 ** levels;
  const radius = Math.min(Math.ceil(3 * sigma), 32);
  const weights = Array.from({ length: 2 * radius + 1 }, (_, i) =>
    Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  const pass = (from: OracleImage, dx: number, dy: number): OracleImage => {
    const out = oracleImage({
      x: from.x - radius * dx,
      y: from.y - radius * dy,
      width: from.width + 2 * radius * dx,
      height: from.height + 2 * radius * dy,
    });
    for (let y = 0; y < out.height; y += 1)
      for (let x = 0; x < out.width; x += 1) {
        const sum = [0, 0, 0, 0];
        weights.forEach((w, i) =>
          oracleTexel(from, x + out.x + (i - radius) * dx, y + out.y + (i - radius) * dy).forEach(
            (v, k) => (sum[k]! += (w * v) / total),
          ),
        );
        out.data.set(sum, (y * out.width + x) * 4);
      }
    return out;
  };
  return { level: pass(pass(level, 1, 0), 0, 1), scale: 2 ** levels };
}

/** `R₁` over `result`; the composite draws it at the root's opacity times c. */
export function effectOracle(
  content: OracleImage,
  result: OracleRect,
  effect: OracleEffect,
): OracleImage {
  const c = effect.contentOpacity;
  const r = oracleImage(result);
  const each = (visit: (x: number, y: number, at: number) => void) => {
    for (let y = result.y; y < result.y + result.height; y += 1)
      for (let x = result.x; x < result.x + result.width; x += 1)
        visit(x, y, ((y - result.y) * result.width + x - result.x) * 4);
  };
  for (const shadow of effect.shadows) {
    const { level, scale } =
      shadow.sigmaPx > 0 ? blurred(content, shadow.sigmaPx) : { level: content, scale: 1 };
    const a = shadow.color.a;
    const color = [shadow.color.r * a, shadow.color.g * a, shadow.color.b * a, a];
    each((x, y, at) => {
      const alpha = Math.min(
        oracleBilinear(level, (x + 0.5 - shadow.dx) / scale, (y + 0.5 - shadow.dy) / scale)[3]! / c,
        1,
      );
      const keep = 1 - color[3]! * alpha;
      for (let k = 0; k < 4; k += 1) r.data[at + k] = color[k]! * alpha + r.data[at + k]! * keep;
    });
  }
  each((x, y, at) => {
    const l = oracleTexel(content, x, y).map((v) => Math.min(v / c, 1));
    const keep = 1 - l[3]!;
    for (let k = 0; k < 4; k += 1) r.data[at + k] = l[k]! + r.data[at + k]! * keep;
  });
  // V36 section 4.1: Iⱼ = colorⱼ × h(p) × (1 − (G ∗ h)(p − offsetⱼ)), h = min(127 α(L) / c, 1).
  if ((effect.innerShadows ?? []).length > 0) {
    const hard = oracleImage(content);
    for (let i = 0; i < content.width * content.height; i += 1) {
      const h = Math.min((127 * content.data[i * 4 + 3]!) / c, 1);
      hard.data.set([h, h, h, h], i * 4);
    }
    for (const shadow of effect.innerShadows ?? []) {
      const { level, scale } =
        shadow.sigmaPx > 0 ? blurred(hard, shadow.sigmaPx) : { level: hard, scale: 1 };
      const a = shadow.color.a;
      const color = [shadow.color.r * a, shadow.color.g * a, shadow.color.b * a, a];
      each((x, y, at) => {
        const b = oracleBilinear(
          level,
          (x + 0.5 - shadow.dx) / scale,
          (y + 0.5 - shadow.dy) / scale,
        )[3]!;
        const inner = color.map((v) => v * (1 - Math.min(b, 1)) * oracleTexel(hard, x, y)[3]!);
        const keep = 1 - inner[3]!;
        for (let k = 0; k < 4; k += 1) r.data[at + k] = inner[k]! + r.data[at + k]! * keep;
      });
    }
  }
  if (effect.blurSigmaPx === null || !(effect.blurSigmaPx > 0)) return r;
  const { level, scale } = blurred(r, effect.blurSigmaPx);
  const out = oracleImage(result);
  each((x, y, at) => out.data.set(oracleBilinear(level, (x + 0.5) / scale, (y + 0.5) / scale), at));
  return out;
}
