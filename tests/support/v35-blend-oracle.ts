import type { RenderNodeSnapshot, SceneBlendMode, SceneColor } from '@vector-studio/contracts';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-A05: the CPU oracle of V35-R2
// to R4 for scenes of axis-aligned rectangles on whole device pixels (translations only, DPR 1,
// zoom 1), so that every pixel is fully in or out of each shape at any sample count. It renders
// the scene's nodes in paint order over the canvas clear colour (opaque black), with:
// - R2 on encoded sRGB, straight-alpha colour, `normal` as premultiplied source-over;
// - R3/R4 isolation as V35-K3 plans it under `groups: 'isolated'`: a container with
//   0 < opacity < 1, effects or a mode other than `passThrough` draws its children into a
//   transparent layer, composited once with its opacity and mode; a leaf with a mode other
//   than `normal` is composited from its own layer;
// - rect clips and P4 masks (`children[0]`'s rectangle), and drop shadows of sigma 0 at whole
//   pixel offsets, one per root (E41: the shadow `color · αL(p − offset)` under `L`).
// Every target and layer is stored at 8 bits, as the GPU stores them, so the oracle quantizes
// after each draw and each layer's content before its composite.

export type BlendImage = { width: number; height: number; data: Float64Array };

type Mask = Uint8Array | null;
type Rgb = readonly [number, number, number];

const quantize = (value: number) => Math.round(Math.min(Math.max(value, 0), 1) * 255) / 255;

function image(width: number, height: number): BlendImage {
  return { width, height, data: new Float64Array(width * height * 4) };
}

function quantizeImage(target: BlendImage) {
  for (let index = 0; index < target.data.length; index += 1) {
    target.data[index] = quantize(target.data[index]!);
  }
}

// W3C Compositing Level 1, section 10.
function hardLight(cb: number, cs: number) {
  return cs <= 0.5 ? cb * 2 * cs : cb + (2 * cs - 1) - cb * (2 * cs - 1);
}
function softLight(cb: number, cs: number) {
  if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
  const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
  return cb + (2 * cs - 1) * (d - cb);
}
function separable(mode: SceneBlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'multiply':
      return cb * cs;
    case 'screen':
      return cb + cs - cb * cs;
    case 'overlay':
      return hardLight(cs, cb);
    case 'darken':
      return Math.min(cb, cs);
    case 'lighten':
      return Math.max(cb, cs);
    case 'colorDodge':
      if (cb === 0) return 0;
      if (cs === 1) return 1;
      return Math.min(1, cb / (1 - cs));
    case 'colorBurn':
      if (cb === 1) return 1;
      if (cs === 0) return 0;
      return 1 - Math.min(1, (1 - cb) / cs);
    case 'hardLight':
      return hardLight(cb, cs);
    case 'softLight':
      return softLight(cb, cs);
    case 'difference':
      return Math.abs(cb - cs);
    case 'exclusion':
      return cb + cs - 2 * cb * cs;
    default:
      return cs;
  }
}
const lum = ([r, g, b]: Rgb) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(color: Rgb): Rgb {
  const l = lum(color);
  const n = Math.min(...color);
  const x = Math.max(...color);
  let out = color.map((c) => (n < 0 ? l + ((c - l) * l) / (l - n) : c)) as unknown as Rgb;
  out = out.map((c) => (x > 1 ? l + ((c - l) * (1 - l)) / (x - l) : c)) as unknown as Rgb;
  return out;
}
const setLum = (color: Rgb, l: number): Rgb => {
  const d = l - lum(color);
  return clipColor([color[0] + d, color[1] + d, color[2] + d]);
};
const sat = (color: Rgb) => Math.max(...color) - Math.min(...color);
function setSat(color: Rgb, s: number): Rgb {
  const max = Math.max(...color);
  const min = Math.min(...color);
  if (max <= min) return [0, 0, 0];
  return color.map((c) => ((c - min) * s) / (max - min)) as unknown as Rgb;
}

/** B(Cb, Cs) of V35-R2 for one of the 15 modes (`normal` is Cs). */
export function blendColor(mode: SceneBlendMode, cb: Rgb, cs: Rgb): Rgb {
  switch (mode) {
    case 'hue':
      return setLum(setSat(cs, sat(cb)), lum(cb));
    case 'saturation':
      return setLum(setSat(cb, sat(cs)), lum(cb));
    case 'color':
      return setLum(cs, lum(cb));
    case 'luminosity':
      return setLum(cb, lum(cs));
    default:
      return [
        separable(mode, cb[0], cs[0]),
        separable(mode, cb[1], cs[1]),
        separable(mode, cb[2], cs[2]),
      ];
  }
}

/** Composites premultiplied source `(ps, as)` onto `target` at `at` with `mode` (R2). */
function compositePixel(target: BlendImage, at: number, ps: Rgb, as: number, mode: SceneBlendMode) {
  if (as <= 0) return;
  const data = target.data;
  const ab = data[at + 3]!;
  if (mode === 'normal' || mode === 'passThrough') {
    for (let lane = 0; lane < 3; lane += 1)
      data[at + lane] = ps[lane]! + (1 - as) * data[at + lane]!;
    data[at + 3] = as + (1 - as) * ab;
    return;
  }
  const pb: Rgb = [data[at]!, data[at + 1]!, data[at + 2]!];
  const cb: Rgb = ab > 0 ? [pb[0] / ab, pb[1] / ab, pb[2] / ab] : [0, 0, 0];
  const cs: Rgb = [ps[0] / as, ps[1] / as, ps[2] / as];
  const mixed = blendColor(mode, cb, cs);
  for (let lane = 0; lane < 3; lane += 1) {
    data[at + lane] = as * (1 - ab) * cs[lane]! + as * ab * mixed[lane]! + (1 - as) * pb[lane]!;
  }
  data[at + 3] = as + ab * (1 - as);
}

type Box = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;

function translation(node: RenderNodeSnapshot): readonly [number, number] {
  const [a, b, c, d, e, f] = node.transform;
  if (a !== 1 || b !== 0 || c !== 0 || d !== 1) {
    throw new Error(`The oracle draws translations only (${node.id}).`);
  }
  return [e, f];
}

function rectOf(node: RenderNodeSnapshot, ox: number, oy: number): Box {
  if (node.kind !== 'primitive' || node.geometry.kind !== 'rectangle') {
    throw new Error(`The oracle draws rectangles only (${node.id}).`);
  }
  const [tx, ty] = translation(node);
  const x0 = ox + tx;
  const y0 = oy + ty;
  return { x0, y0, x1: x0 + node.geometry.width, y1: y0 + node.geometry.height };
}

function boxMask(width: number, height: number, box: Box, within: Mask): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = Math.max(0, Math.ceil(box.y0)); y < Math.min(height, box.y1); y += 1) {
    for (let x = Math.max(0, Math.ceil(box.x0)); x < Math.min(width, box.x1); x += 1) {
      const index = y * width + x;
      mask[index] = within === null ? 1 : within[index]!;
    }
  }
  return mask;
}

/** V35-K3: whether a container draws into its own layer under `groups: 'isolated'`. */
function containerIsolates(node: RenderNodeSnapshot) {
  return (
    (node.opacity > 0 && node.opacity < 1) ||
    (node.effects ?? []).length > 0 ||
    (node.blendMode !== undefined && node.blendMode !== 'passThrough')
  );
}

/** Renders `nodes` over opaque black at `width` x `height` device pixels (premultiplied). */
export function blendOracle(
  nodes: readonly RenderNodeSnapshot[],
  targetWidth: number,
  targetHeight: number,
): BlendImage {
  // Content up to MARGIN pixels past the target still reaches it through a drop shadow (an
  // effect root's L past the target, E41 U5b's shifted passes), so the oracle draws a wider
  // canvas and crops it.
  const full = renderOracle(nodes, targetWidth + 2 * MARGIN, targetHeight + 2 * MARGIN, MARGIN);
  const cropped = image(targetWidth, targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const from = ((y + MARGIN) * full.width + MARGIN) * 4;
    cropped.data.set(full.data.subarray(from, from + targetWidth * 4), y * targetWidth * 4);
  }
  return cropped;
}

const MARGIN = 64;

function renderOracle(
  nodes: readonly RenderNodeSnapshot[],
  width: number,
  height: number,
  origin: number,
): BlendImage {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const canvas = image(width, height);
  for (let index = 3; index < canvas.data.length; index += 4) canvas.data[index] = 1;

  const composite = (
    target: BlendImage,
    layer: BlendImage,
    opacity: number,
    mode: SceneBlendMode,
    clip: Mask,
  ) => {
    for (let index = 0; index < width * height; index += 1) {
      if (clip !== null && clip[index] === 0) continue;
      const at = index * 4;
      const as = layer.data[at + 3]! * opacity;
      const ps: Rgb = [
        layer.data[at]! * opacity,
        layer.data[at + 1]! * opacity,
        layer.data[at + 2]! * opacity,
      ];
      compositePixel(target, at, ps, as, mode);
    }
    quantizeImage(target);
  };

  const drawLeaf = (
    node: RenderNodeSnapshot,
    target: BlendImage,
    ox: number,
    oy: number,
    clip: Mask,
  ) => {
    if (node.kind !== 'primitive')
      throw new Error(`The oracle draws rectangles only (${node.id}).`);
    const fill = node.style.fill as SceneColor | null;
    if (fill === null) return;
    const mode = node.blendMode ?? 'normal';
    const alpha = fill.a * node.opacity;
    // A blend root's `R` is stored at 8 bits before its composite; a normal leaf blends straight.
    const store = mode === 'normal' ? (value: number) => value : quantize;
    const ps: Rgb = [store(fill.r * alpha), store(fill.g * alpha), store(fill.b * alpha)];
    const as = store(alpha);
    const area = boxMask(width, height, rectOf(node, ox, oy), clip);
    for (let index = 0; index < area.length; index += 1) {
      if (area[index] === 1) compositePixel(target, index * 4, ps, as, mode);
    }
    quantizeImage(target);
  };

  const drawList = (
    ids: readonly string[],
    target: BlendImage,
    ox: number,
    oy: number,
    clip: Mask,
  ) => {
    for (const id of ids) {
      const node = byId.get(id);
      if (node === undefined) throw new Error(`Unknown node ${id}.`);
      if (!node.visible || node.opacity <= 0) continue;
      if (node.kind !== 'container') {
        drawLeaf(node, target, ox, oy, clip);
        continue;
      }
      const [tx, ty] = translation(node);
      const x = ox + tx;
      const y = oy + ty;
      const isolated = containerIsolates(node);
      let own: Mask = null;
      let children = node.children;
      if (node.clip?.kind === 'rect') {
        const { x: cx, y: cy, width: cw, height: ch } = node.clip;
        own = boxMask(
          width,
          height,
          { x0: x + cx, y0: y + cy, x1: x + cx + cw, y1: y + cy + ch },
          null,
        );
      } else if (node.clip?.kind === 'mask') {
        const source = byId.get(children[0]!)!;
        own = boxMask(width, height, rectOf(source, x, y), null);
        children = children.slice(1);
      }
      const both = (a: Mask, b: Mask): Mask =>
        a === null ? b : b === null ? a : a.map((value, index) => value & b[index]!);
      if (!isolated) {
        drawList(children, target, x, y, both(clip, own));
        continue;
      }
      // The layer's content takes the container's own clip; ancestors clip its composite.
      let layer = image(width, height);
      drawList(children, layer, x, y, own);
      const effects = node.effects ?? [];
      if (effects.length > 1) throw new Error(`The oracle draws one effect (${node.id}).`);
      for (const effect of effects) {
        if (effect.kind !== 'dropShadow' || effect.sigma !== 0) {
          throw new Error(`The oracle draws sigma-0 drop shadows only (${node.id}).`);
        }
        const withShadow = image(width, height);
        const { color, offsetX, offsetY } = effect;
        for (let py = 0; py < height; py += 1) {
          for (let px = 0; px < width; px += 1) {
            const sx = px - offsetX;
            const sy = py - offsetY;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            const a = layer.data[(sy * width + sx) * 4 + 3]! * color.a;
            const at = (py * width + px) * 4;
            withShadow.data[at] = color.r * a;
            withShadow.data[at + 1] = color.g * a;
            withShadow.data[at + 2] = color.b * a;
            withShadow.data[at + 3] = a;
          }
        }
        composite(withShadow, layer, 1, 'normal', null);
        layer = withShadow;
      }
      quantizeImage(layer);
      const mode =
        node.blendMode === undefined || node.blendMode === 'passThrough'
          ? 'normal'
          : node.blendMode;
      composite(target, layer, node.opacity, mode, clip);
    }
  };

  const roots = nodes.filter((node) => node.parentId === null).map((node) => node.id);
  drawList(roots, canvas, origin, origin, null);
  return canvas;
}

export type BlendComparison = Readonly<{
  worst: number;
  at: readonly [number, number] | null;
  over: number;
  /** The first pixels over the tolerance, for the report. */
  overAt: readonly (readonly [number, number])[];
  detail: Readonly<{ actual: readonly number[]; expected: readonly number[] }> | null;
}>;

/** Compares RGBA8 `actual` with the oracle's premultiplied image over an opaque canvas. */
/**
 * The pixels within `radius` (Chebyshev) of a rectangle, clip or mask corner, and of those
 * corners moved by an enclosing drop shadow's offset. P1's analytic rectangle coverage is
 * approximate there (about a pixel of rounding at a sharp corner, with or without blending),
 * so the comparison leaves them out; edges are exact.
 */
export function cornerPixels(
  nodes: readonly RenderNodeSnapshot[],
  width: number,
  height: number,
  radius = 2,
): Uint8Array {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const mask = new Uint8Array(width * height);
  const mark = (x: number, y: number, shifts: readonly (readonly [number, number])[]) => {
    for (const [sx, sy] of shifts) {
      const cx = Math.round(x + sx);
      const cy = Math.round(y + sy);
      for (let py = Math.max(0, cy - radius); py < Math.min(height, cy + radius); py += 1) {
        for (let px = Math.max(0, cx - radius); px < Math.min(width, cx + radius); px += 1) {
          mask[py * width + px] = 1;
        }
      }
    }
  };
  const box = (b: Box, shifts: readonly (readonly [number, number])[]) => {
    for (const [x, y] of [
      [b.x0, b.y0],
      [b.x1, b.y0],
      [b.x0, b.y1],
      [b.x1, b.y1],
    ] as const) {
      mark(x, y, shifts);
    }
  };
  const visit = (
    id: string,
    ox: number,
    oy: number,
    shifts: readonly (readonly [number, number])[],
  ) => {
    const node = byId.get(id)!;
    if (node.kind !== 'container') {
      box(rectOf(node, ox, oy), shifts);
      return;
    }
    const [tx, ty] = translation(node);
    const x = ox + tx;
    const y = oy + ty;
    const own = (node.effects ?? []).flatMap((effect) =>
      effect.kind === 'dropShadow'
        ? shifts.map(([sx, sy]) => [sx + effect.offsetX, sy + effect.offsetY] as const)
        : [],
    );
    const inner = [...shifts, ...own];
    if (node.clip?.kind === 'rect') {
      const { x: cx, y: cy, width: cw, height: ch } = node.clip;
      box({ x0: x + cx, y0: y + cy, x1: x + cx + cw, y1: y + cy + ch }, inner);
    }
    for (const child of node.children) visit(child, x, y, inner);
  };
  for (const node of nodes) if (node.parentId === null) visit(node.id, 0, 0, [[0, 0]]);
  return mask;
}

export function compareBlend(
  actual: Uint8Array,
  expected: BlendImage,
  tolerance: number,
  excluded: Uint8Array | null = null,
): BlendComparison {
  let worst = 0;
  let at: readonly [number, number] | null = null;
  let over = 0;
  const overAt: (readonly [number, number])[] = [];
  let detail: BlendComparison['detail'] = null;
  for (let index = 0; index < expected.width * expected.height; index += 1) {
    if (excluded !== null && excluded[index] === 1) continue;
    let pixelWorst = 0;
    for (let lane = 0; lane < 3; lane += 1) {
      const difference = Math.abs(
        actual[index * 4 + lane]! - expected.data[index * 4 + lane]! * 255,
      );
      pixelWorst = Math.max(pixelWorst, difference);
    }
    if (pixelWorst > tolerance) {
      over += 1;
      if (overAt.length < 64)
        overAt.push([index % expected.width, Math.floor(index / expected.width)]);
    }
    if (pixelWorst > worst) {
      worst = pixelWorst;
      at = [index % expected.width, Math.floor(index / expected.width)];
      detail = {
        actual: Array.from(actual.subarray(index * 4, index * 4 + 4)),
        expected: Array.from(
          expected.data.subarray(index * 4, index * 4 + 4),
          (value) => Math.round(value * 255 * 100) / 100,
        ),
      };
    }
  }
  return { worst, at, over, overAt, detail };
}
