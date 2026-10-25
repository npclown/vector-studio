// D9 E3 unit E3-U4: the GPU model check of docs/plans/d9-e3-b4-precision-contract.md section 7.1
// (executable form in section 16). Node builds the payload: each case's drawn mesh through the
// product path (harness.ts), its packed lanes, and for every stored point the exact p* and its
// β bounds. The readback page (apps/playground/e3-a04-readback.html) evaluates the shader's own
// meshPositionNdc in the vertex stage and toPhysical in the fragment stage for every point and
// returns the bits. modelCheck then requires every read-back position within β(p) of p*, the
// same NDC bits from two invocations of each vertex, and equal mesh bytes on both sides.
//
// E3-U5 (contract section 19): after the freeze the spec reads back the named subset of
// section 7.1 as well. For each draw that the GPU clips, the page also rasterizes the mesh and
// returns the pixel-centre coverage of a strip along the viewport edge, which clipCheck compares
// with exact coverage of M* away from its boundary (E3-Q11 (a)). At each T-junction of M*, the
// crack width between the read-back positions is reported (E3-Q10 (b), never gated).
import { createHash } from 'node:crypto';

import type { A04Case } from '../../../packages/geometry-reference/src/a04-region.js';
import { MESH_FILL_SHADER } from '../../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import { iterateA04Corpus } from './corpus.js';
import {
  boundaryCandidates,
  dNum,
  drawCase,
  guardBand,
  mapPoint,
  partnerOf,
  shaderLanes,
  tJunctionTriples,
  type Frame,
  type HarnessPorts,
  type MappedPoint,
} from './harness.js';
import { fill, polygon, rect } from './oracle-cases.js';
import { harnessCase, SMOKE_CASES } from './smoke.js';

/**
 * The readback cases before the freeze (section 16.2): the smoke cases, plus a far translation
 * (2^24, as the corpus's far placement), the smallest zoom at DPR 3, and a rectangle across the
 * viewport edge. None is a corpus case, so no kernel output on the corpus is read (section 5.5).
 */
export const READBACK_CASES: readonly A04Case[] = [
  ...SMOKE_CASES.map((s) => s.kase),
  harnessCase({
    id: 'readback/rect-far/T0/z1-d2',
    ...polygon(rect(0, 0, 96, 48)),
    paint: fill(),
    t: [2 ** 24, -(2 ** 24)],
    dpr: 2,
  }),
  harnessCase({
    id: 'readback/rect/T0/z0.01-d3',
    ...polygon(rect(0, 0, 9600, 4800)),
    paint: fill(),
    zoom: 0.01,
    dpr: 3,
  }),
  harnessCase({
    id: 'readback/rect-edge/T0/z1-d1',
    ...polygon(rect(0, 0, 96, 48)),
    paint: fill(),
    c: [60, 10],
  }),
];

/**
 * The named readback subset of section 7.1: the named rows of E3-C1, E3-C3, E3-C5, E3-C9 and
 * E3-C12 at every transform and pair. E3-C6 (partial placements) is added for the clip readback
 * of E3-Q11 (a). Generated rows (`g` followed by digits) are left out.
 */
export const READBACK_STRATA: ReadonlySet<string> = new Set(['C1', 'C3', 'C5', 'C6', 'C9', 'C12']);

export function isNamedReadbackCase(kase: A04Case): boolean {
  const [stratum, row] = String(kase.id).split('/');
  return READBACK_STRATA.has(stratum!) && !/^g\d/u.test(row ?? '');
}

/** The corpus cases of the named readback subset, in generation order. */
export function* namedReadbackCases(): Generator<A04Case> {
  for (const kase of iterateA04Corpus()) if (isNamedReadbackCase(kase)) yield kase;
}

/** Width in physical px of the strip along each viewport edge whose pixel centres are read. */
export const CLIP_STRIP = 4;

/** The strip's pixels in canonical order: rows top to bottom, each left to right. */
export function stripPixels(width: number, height: number): Int32Array {
  const out: number[] = [];
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (x < CLIP_STRIP || x >= width - CLIP_STRIP || y < CLIP_STRIP || y >= height - CLIP_STRIP)
        out.push(x, y);
  return Int32Array.from(out);
}

/** f64 slack on the comparison of a read-back value with p* (both are rounded to binary64). */
const SLACK = 1 + 2 ** -20;

export type ReadbackDraw = Readonly<{
  id: string;
  paint: string;
  frame: Frame;
  linear: readonly [number, number, number, number];
  anchor: readonly [number, number];
  /** The stored binary32 offsets, x and y interleaved. */
  offsets: readonly number[];
  /** p* (nearest binary64) and β of the vertex and feature paths, per point. */
  expected: readonly Readonly<{
    x: number;
    y: number;
    betaVertex: number;
    betaFeature: number;
  }>[];
  /** SHA-256 of the offsets as little-endian binary32 bytes. */
  meshSha256: string;
  /** The mesh's triangle indices, for the clip readback. */
  indices: readonly number[];
  /** True when the GPU clips a triangle (section 15.3): the page then reads the edge strip. */
  clip: boolean;
  /** β_c of the case (vertex path and clip bound), as in measureCase. */
  betaC: number;
  /** Boundary candidates of M* as point index pairs (section 15.5). */
  boundary: readonly number[];
  /** T-junctions of M* as point index triples [v, a, b]. */
  junctions: readonly number[];
}>;

export type ReadbackPayload = Readonly<{
  shader: string;
  shaderSha256: string;
  draws: readonly ReadbackDraw[];
  /** Cases with no drawn mesh (rejected, empty or culled): nothing to read back. */
  skipped: readonly Readonly<{ id: string; kind: string }>[];
}>;

/** What the page returns for one draw: raw u32 words, so no value is canonicalized. */
export type ReadbackResult = Readonly<{
  id: string;
  /** Two passes over the points, four words per point: the NDC vec4f bits. */
  ndc: readonly number[];
  /** One pass, four words per point: the feature-path vec2f bits, the position index, 1. */
  feature: readonly number[];
  meshSha256: string;
  /** Clipped draws only: coverage of the strip's pixel centres, one bit each, packed in u32. */
  coverage?: readonly number[];
}>;

export type ReadbackPage = Readonly<{
  shaderSha256: string;
  adapter: Readonly<Record<string, unknown>>;
  results: readonly ReadbackResult[];
}>;

export function offsetsSha256(offsets: readonly number[]): string {
  return createHash('sha256')
    .update(new Uint8Array(Float32Array.from(offsets).buffer))
    .digest('hex');
}

/**
 * The payload for the given cases. A joint case of the corpus (E3-C9) is drawn with its partner,
 * as the measurement draws it, when `partners` is given.
 */
export function readbackPayload(
  cases: Iterable<A04Case>,
  ports: HarnessPorts,
  partners?: ReadonlyMap<string, A04Case>,
): ReadbackPayload {
  const draws: ReadbackDraw[] = [];
  const skipped: { id: string; kind: string }[] = [];
  for (const kase of cases) {
    const partner = partners === undefined ? undefined : partnerOf(kase, partners);
    let outcome;
    try {
      outcome = drawCase(kase, ports, partner === undefined ? {} : { partner });
    } catch (error) {
      skipped.push({ id: String(kase.id), kind: `error: ${String(error)}` });
      continue;
    }
    if (outcome.kind !== 'drawn') {
      skipped.push({ id: String(kase.id), kind: outcome.kind });
      continue;
    }
    const lanes = shaderLanes(outcome.draw, outcome.frame);
    const offsets = Array.from(outcome.draw.offsets);
    const expected = [];
    const points: MappedPoint[] = [];
    for (let i = 0; i + 1 < offsets.length; i += 2) {
      const p = mapPoint(offsets[i]!, offsets[i + 1]!, lanes);
      points.push(p);
      expected.push({
        x: dNum(p.x),
        y: dNum(p.y),
        betaVertex: p.betaVertex,
        betaFeature: p.betaFeature,
      });
    }
    draws.push({
      id: String(kase.id),
      paint: outcome.draw.paint ?? 'fill',
      frame: outcome.frame,
      linear: lanes.linear,
      anchor: lanes.anchor,
      offsets,
      expected,
      meshSha256: offsetsSha256(offsets),
      ...meshExtras(points, outcome.draw.mesh.indices, outcome.frame),
    });
  }
  return {
    shader: MESH_FILL_SHADER,
    shaderSha256: createHash('sha256').update(MESH_FILL_SHADER, 'utf8').digest('hex'),
    draws,
    skipped,
  };
}

function meshExtras(points: readonly MappedPoint[], indices: ArrayLike<number>, frame: Frame) {
  const mapped = { points, indices, width: frame.width, height: frame.height };
  const guard = guardBand(mapped);
  let betaVertex = 0;
  for (const p of points) betaVertex = Math.max(betaVertex, p.betaVertex, p.betaFeature);
  const candidates = boundaryCandidates(mapped);
  return {
    indices: Array.from(indices),
    clip: guard.crossing > 0,
    betaC: (betaVertex + guard.betaClip) * SLACK,
    boundary: candidates.flatMap((e) => [e.ia, e.ib]),
    junctions: tJunctionTriples(mapped, candidates).flat(),
  };
}

const view = new DataView(new ArrayBuffer(4));
export const f32OfBits = (bits: number): number => {
  view.setUint32(0, bits >>> 0);
  return view.getFloat32(0);
};
export const bitsOfF32 = (value: number): number => {
  view.setFloat32(0, value);
  return view.getUint32(0);
};

export type ModelCheck = Readonly<{
  passed: boolean;
  points: number;
  failures: readonly string[];
  /** The largest read-back error divided by its β, per path. */
  maxVertexRatio: number;
  maxFeatureRatio: number;
  /** T-junctions seen and the largest crack width between read-back positions, physical px. */
  junctions: number;
  maxCrackWidth: number;
  maxCrackDraw: string | null;
  /** The clip readback (E3-Q11 (a)): draws, strip pixels compared and left out, mismatches. */
  clip: Readonly<{ draws: number; compared: number; excluded: number; mismatches: number }>;
}>;

/**
 * Section 7.1's model check. The vertex-path read-back is the NDC value of meshPositionNdc, taken
 * back to pixels exactly as `(n + 1)·W/2` and `(1 − n)·H/2`; the fixed-function viewport
 * transform is not observed (section 16.3).
 */
export function modelCheck(
  payload: ReadbackPayload,
  page: Pick<ReadbackPage, 'shaderSha256' | 'results'>,
): ModelCheck {
  const failures: string[] = [];
  let points = 0;
  let maxVertexRatio = 0;
  let maxFeatureRatio = 0;
  let junctions = 0;
  let maxCrackWidth = 0;
  let maxCrackDraw: string | null = null;
  const clip = { draws: 0, compared: 0, excluded: 0, mismatches: 0 };
  if (page.shaderSha256 !== payload.shaderSha256)
    failures.push(`shader SHA-256 ${page.shaderSha256} ≠ ${payload.shaderSha256}`);
  if (page.results.length !== payload.draws.length)
    failures.push(`${page.results.length} results for ${payload.draws.length} draws`);
  payload.draws.forEach((draw, d) => {
    const result = page.results[d];
    if (result === undefined || result.id !== draw.id) {
      failures.push(`${draw.id}: no result`);
      return;
    }
    if (result.meshSha256 !== draw.meshSha256)
      failures.push(`${draw.id}: mesh bytes ${result.meshSha256} ≠ ${draw.meshSha256}`);
    const n = draw.expected.length;
    if (result.ndc.length !== 8 * n || result.feature.length !== 4 * n) {
      failures.push(
        `${draw.id}: ${result.ndc.length / 4} NDC and ${result.feature.length / 4} feature words for ${n} points`,
      );
      return;
    }
    const { width, height } = draw.frame;
    for (let i = 0; i < n; i += 1) {
      points += 1;
      const e = draw.expected[i]!;
      const first = result.ndc.slice(4 * i, 4 * i + 4);
      const second = result.ndc.slice(4 * (n + i), 4 * (n + i) + 4);
      if (first.some((w, k) => w !== second[k]))
        failures.push(`${draw.id}#${i}: NDC bits differ between invocations`);
      const [nx, ny, nz, nw] = first.map(f32OfBits) as [number, number, number, number];
      if (nz !== 0 || nw !== 1) failures.push(`${draw.id}#${i}: NDC z, w = ${nz}, ${nw}`);
      const vx = ((nx + 1) * width) / 2;
      const vy = ((1 - ny) * height) / 2;
      const slack = 2 ** -40 * (Math.abs(e.x) + Math.abs(e.y) + width + height);
      const vertexError = Math.hypot(vx - e.x, vy - e.y);
      const vertexBound = e.betaVertex * SLACK + slack;
      maxVertexRatio = Math.max(maxVertexRatio, vertexError / e.betaVertex);
      if (!(vertexError <= vertexBound))
        failures.push(`${draw.id}#${i}: vertex path ${vertexError} > β ${e.betaVertex}`);
      const fx = f32OfBits(result.feature[4 * i]!);
      const fy = f32OfBits(result.feature[4 * i + 1]!);
      const featureError = Math.hypot(fx - e.x, fy - e.y);
      maxFeatureRatio = Math.max(maxFeatureRatio, featureError / e.betaFeature);
      if (!(featureError <= e.betaFeature * SLACK + slack))
        failures.push(`${draw.id}#${i}: feature path ${featureError} > β ${e.betaFeature}`);
      if (result.feature[4 * i + 2] !== i)
        failures.push(`${draw.id}#${i}: feature word 2 is ${result.feature[4 * i + 2]}`);
    }
    // E3-Q10 (b): the crack width at each T-junction, from the read-back vertex-path positions.
    const gpu = (i: number): [number, number] => {
      const nx = f32OfBits(result.ndc[4 * i]!);
      const ny = f32OfBits(result.ndc[4 * i + 1]!);
      return [((nx + 1) * width) / 2, ((1 - ny) * height) / 2];
    };
    for (let j = 0; j + 2 < draw.junctions.length; j += 3) {
      const [vx, vy] = gpu(draw.junctions[j]!);
      const [ax, ay] = gpu(draw.junctions[j + 1]!);
      const [bx, by] = gpu(draw.junctions[j + 2]!);
      const length = Math.hypot(bx - ax, by - ay);
      const crack =
        length === 0
          ? Math.hypot(vx - ax, vy - ay)
          : Math.abs((bx - ax) * (vy - ay) - (by - ay) * (vx - ax)) / length;
      junctions += 1;
      if (crack > maxCrackWidth) {
        maxCrackWidth = crack;
        maxCrackDraw = draw.id;
      }
    }
    if (draw.clip) {
      if (result.coverage === undefined) {
        failures.push(`${draw.id}: no clip coverage`);
        return;
      }
      const c = clipCheck(draw, result.coverage);
      clip.draws += 1;
      clip.compared += c.compared;
      clip.excluded += c.excluded;
      clip.mismatches += c.mismatches.length;
      for (const m of c.mismatches.slice(0, 5)) failures.push(`${draw.id}: clip ${m}`);
    }
  });
  return {
    passed: failures.length === 0,
    points,
    failures,
    maxVertexRatio,
    maxFeatureRatio,
    junctions,
    maxCrackWidth,
    maxCrackDraw,
    clip,
  };
}

/** Grid cell size, physical px, of the clip check's spatial index. */
const CELL = 16;

/**
 * The clip readback of E3-Q11 (a). For each pixel centre q of the edge strip farther than β_c
 * from every boundary candidate of M*, the GPU covers q exactly when M* contains q. Within β_c
 * of a candidate the GPU may differ, so those centres are left out. Pixel-centre coverage
 * confirms the clip model only to pixel resolution near the edge: a mismatch falsifies it,
 * agreement does not prove it (E3-Q11 (a), "the readback's limit").
 */
export function clipCheck(
  draw: Pick<ReadbackDraw, 'frame' | 'expected' | 'indices' | 'boundary' | 'betaC'>,
  coverage: readonly number[],
): Readonly<{ compared: number; excluded: number; mismatches: string[] }> {
  const { width, height } = draw.frame;
  const pts = draw.expected;
  let scale = width + height;
  for (const p of pts) scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y));
  // f64 evaluation of distances from binary64 copies of p*: a margin far above its rounding.
  const thr = draw.betaC * SLACK + 2 ** -30 * scale + 2 ** -20;
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const strip = (cx: number, cy: number) =>
    cx * CELL < CLIP_STRIP ||
    (cx + 1) * CELL > width - CLIP_STRIP ||
    cy * CELL < CLIP_STRIP ||
    (cy + 1) * CELL > height - CLIP_STRIP;
  const triCells = new Map<number, number[]>();
  const edgeCells = new Map<number, number[]>();
  const register = (
    cells: Map<number, number[]>,
    item: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) => {
    const c0 = Math.max(0, Math.floor(x0 / CELL));
    const c1 = Math.min(cols - 1, Math.floor(x1 / CELL));
    const r0 = Math.max(0, Math.floor(y0 / CELL));
    const r1 = Math.min(rows - 1, Math.floor(y1 / CELL));
    for (let cy = r0; cy <= r1; cy += 1)
      for (let cx = c0; cx <= c1; cx += 1) {
        if (!strip(cx, cy)) continue;
        const key = cy * cols + cx;
        const list = cells.get(key);
        if (list === undefined) cells.set(key, [item]);
        else list.push(item);
      }
  };
  for (let t = 0; t + 2 < draw.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => pts[draw.indices[t + k]!]!);
    register(
      triCells,
      t,
      Math.min(a!.x, b!.x, c!.x) - thr,
      Math.min(a!.y, b!.y, c!.y) - thr,
      Math.max(a!.x, b!.x, c!.x) + thr,
      Math.max(a!.y, b!.y, c!.y) + thr,
    );
  }
  for (let e = 0; e + 1 < draw.boundary.length; e += 2) {
    const a = pts[draw.boundary[e]!]!;
    const b = pts[draw.boundary[e + 1]!]!;
    register(
      edgeCells,
      e,
      Math.min(a.x, b.x) - thr,
      Math.min(a.y, b.y) - thr,
      Math.max(a.x, b.x) + thr,
      Math.max(a.y, b.y) + thr,
    );
  }
  const segmentDistance = (qx: number, qy: number, a: { x: number; y: number }, b: typeof a) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((qx - a.x) * dx + (qy - a.y) * dy) / l2));
    return Math.hypot(qx - (a.x + t * dx), qy - (a.y + t * dy));
  };
  const contains = (qx: number, qy: number, t: number) => {
    const [a, b, c] = [0, 1, 2].map((k) => pts[draw.indices[t + k]!]!) as [
      (typeof pts)[number],
      (typeof pts)[number],
      (typeof pts)[number],
    ];
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (area === 0) return false;
    const s = Math.sign(area);
    const side = (p: typeof a, r: typeof a) =>
      s * ((r.x - p.x) * (qy - p.y) - (r.y - p.y) * (qx - p.x)) >= 0;
    return side(a, b) && side(b, c) && side(c, a);
  };
  const pixels = stripPixels(width, height);
  let compared = 0;
  let excluded = 0;
  const mismatches: string[] = [];
  for (let k = 0; 2 * k < pixels.length; k += 1) {
    const px = pixels[2 * k]!;
    const py = pixels[2 * k + 1]!;
    const qx = px + 0.5;
    const qy = py + 0.5;
    const key = Math.floor(py / CELL) * cols + Math.floor(px / CELL);
    const near = (edgeCells.get(key) ?? []).some(
      (e) => segmentDistance(qx, qy, pts[draw.boundary[e]!]!, pts[draw.boundary[e + 1]!]!) <= thr,
    );
    if (near) {
      excluded += 1;
      continue;
    }
    compared += 1;
    const inside = (triCells.get(key) ?? []).some((t) => contains(qx, qy, t));
    const covered = ((coverage[k >>> 5]! >>> (k & 31)) & 1) === 1;
    if (inside !== covered)
      mismatches.push(
        `pixel (${px}, ${py}): GPU ${covered ? 'covers' : 'misses'} it, M* ${inside ? 'contains' : 'does not contain'} it`,
      );
  }
  return { compared, excluded, mismatches };
}

/**
 * A CPU stand-in for the page: binary32 evaluation of toPhysical and the NDC step, unfused, in
 * WGSL's association. For unit tests of the check only; it is not evidence.
 */
export function emulatedReadback(payload: ReadbackPayload): ReadbackPage {
  const f = Math.fround;
  const results = payload.draws.map((draw) => {
    const [l0, l1, l2, l3] = draw.linear;
    const [bx, by] = draw.anchor;
    const [ox, oy] = draw.frame.originMinusCamera;
    const { zoom, dpr, width, height } = draw.frame;
    const ndc: number[] = [];
    const feature: number[] = [];
    for (let i = 0; i + 1 < draw.offsets.length; i += 2) {
      const ux = draw.offsets[i]!;
      const uy = draw.offsets[i + 1]!;
      const px = f(f(f(f(f(f(l0 * ux) + f(l2 * uy)) + bx) + ox) * zoom) * dpr);
      const py = f(f(f(f(f(f(l1 * ux) + f(l3 * uy)) + by) + oy) * zoom) * dpr);
      const nx = f(f(f(px * 2) / width) - 1);
      const ny = f(1 - f(f(py * 2) / height));
      ndc.push(bitsOfF32(nx), bitsOfF32(ny), bitsOfF32(0), bitsOfF32(1));
      feature.push(bitsOfF32(px), bitsOfF32(py), i / 2, 1);
    }
    return {
      id: draw.id,
      ndc: [...ndc, ...ndc],
      feature,
      meshSha256: draw.meshSha256,
      ...(draw.clip ? { coverage: emulatedCoverage(draw) } : {}),
    };
  });
  return { shaderSha256: payload.shaderSha256, adapter: { emulated: true }, results };
}

/** The stand-in's strip coverage: pixel centres inside a triangle of p*, in binary64. */
export function emulatedCoverage(
  draw: Pick<ReadbackDraw, 'frame' | 'expected' | 'indices'>,
): number[] {
  const pixels = stripPixels(draw.frame.width, draw.frame.height);
  const words = new Array<number>(Math.ceil(pixels.length / 64)).fill(0);
  const pts = draw.expected;
  for (let k = 0; 2 * k < pixels.length; k += 1) {
    const qx = pixels[2 * k]! + 0.5;
    const qy = pixels[2 * k + 1]! + 0.5;
    for (let t = 0; t + 2 < draw.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((j) => pts[draw.indices[t + j]!]!) as [
        (typeof pts)[number],
        (typeof pts)[number],
        (typeof pts)[number],
      ];
      const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const side = (p: typeof a, r: typeof a) =>
        Math.sign(area) * ((r.x - p.x) * (qy - p.y) - (r.y - p.y) * (qx - p.x)) >= 0;
      if (area !== 0 && side(a, b) && side(b, c) && side(c, a)) {
        words[k >>> 5] = (words[k >>> 5]! | (1 << (k & 31))) >>> 0;
        break;
      }
    }
  }
  return words;
}

/**
 * E3-PC12: one read-back position replaced by p* + 2β(p) along x, on both paths. modelCheck must
 * then fail.
 */
export function perturbedReadback(
  payload: ReadbackPayload,
  page: ReadbackPage,
  drawIndex: number,
  point: number,
): ReadbackPage {
  const draw = payload.draws[drawIndex]!;
  const e = draw.expected[point]!;
  const n = draw.expected.length;
  const results = page.results.map((r, d) => {
    if (d !== drawIndex) return r;
    const ndc = [...r.ndc];
    const nx = bitsOfF32(((e.x + 2 * e.betaVertex) * 2) / draw.frame.width - 1);
    ndc[4 * point] = nx;
    ndc[4 * (n + point)] = nx;
    const feature = [...r.feature];
    feature[4 * point] = bitsOfF32(e.x + 2 * e.betaFeature);
    return { ...r, ndc, feature };
  });
  return { ...page, results };
}
