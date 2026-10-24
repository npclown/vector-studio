// D9 E3 unit E3-U4: the GPU model check of docs/plans/d9-e3-b4-precision-contract.md section 7.1
// (executable form in section 16). Node builds the payload: each case's drawn mesh through the
// product path (harness.ts), its packed lanes, and for every stored point the exact p* and its
// β bounds. The readback page (apps/playground/e3-a04-readback.html) evaluates the shader's own
// meshPositionNdc in the vertex stage and toPhysical in the fragment stage for every point and
// returns the bits. modelCheck then requires every read-back position within β(p) of p*, the
// same NDC bits from two invocations of each vertex, and equal mesh bytes on both sides.
import { createHash } from 'node:crypto';

import type { A04Case } from '../../../packages/geometry-reference/src/a04-region.js';
import { MESH_FILL_SHADER } from '../../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import { dNum, drawCase, mapPoint, shaderLanes, type Frame, type HarnessPorts } from './harness.js';
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

/** The payload for the given (non-corpus, before the freeze) cases. */
export function readbackPayload(cases: readonly A04Case[], ports: HarnessPorts): ReadbackPayload {
  const draws: ReadbackDraw[] = [];
  const skipped: { id: string; kind: string }[] = [];
  for (const kase of cases) {
    const outcome = drawCase(kase, ports);
    if (outcome.kind !== 'drawn') {
      skipped.push({ id: String(kase.id), kind: outcome.kind });
      continue;
    }
    const lanes = shaderLanes(outcome.draw, outcome.frame);
    const offsets = Array.from(outcome.draw.offsets);
    const expected = [];
    for (let i = 0; i + 1 < offsets.length; i += 2) {
      const p = mapPoint(offsets[i]!, offsets[i + 1]!, lanes);
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
    });
  }
  return {
    shader: MESH_FILL_SHADER,
    shaderSha256: createHash('sha256').update(MESH_FILL_SHADER, 'utf8').digest('hex'),
    draws,
    skipped,
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
  });
  return { passed: failures.length === 0, points, failures, maxVertexRatio, maxFeatureRatio };
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
    return { id: draw.id, ndc: [...ndc, ...ndc], feature, meshSha256: draw.meshSha256 };
  });
  return { shaderSha256: payload.shaderSha256, adapter: { emulated: true }, results };
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
