// E17 acceptance check E17-A4 (docs/plans/d9-e17-mesh-write-once-coverage-contract.md): a
// simulated rasterizer over the gated V-4 A08 case-variants. It maps every drawn vertex (region
// and exterior, frame corners included) exactly with the E3 harness, snaps it to an 8-bit
// subpixel grid (1/256 px, the value whose model reproduced V-4's headed count images), and
// counts covers per sample with the top-left rule at the pixel centre (1x) and WebGPU's standard
// 4x pattern. It reports, near every triangle whose snapped orientation differs from its exact
// one:
//   - raw covers > 1 (today's product, E10's count pass without E17),
//   - the signed cover sum (triangles with their exact orientation minus inverted ones), which
//     E17's argument needs to equal the frame's orientation (1, or -1 under a reflection) at every
//     sample inside the snapped frame,
//   - count-0 samples in G3's "equal to 1" class, which write-once cannot repair.
// With E17-K1 the drawn count is min(raw, 1), so the check passes when the signed sum is 1
// everywhere in the frame and no "equal to 1" sample is uncovered. The model does not clip.
// Manual, never CI:
//
//   pnpm e17:snap-model [--wasm <path>]
//
// (tooling/run-e17-snap-model.mjs), which writes .tools/e17-snap-model/record.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../../packages/geometry-wasm/src/index.js';
import { buildReference, pixelClassForTesting } from '../../visual/viz-v4/metrics.js';
import { a08Subset } from '../../visual/viz-v4/subset.js';
import { drawCase, mapPoint, shaderLanes } from '../e3-a04/harness.js';

const root = path.resolve(import.meta.dirname, '../../..');
const SNAP = 256;
const SAMPLES_4X = [
  [0.375, 0.125],
  [0.875, 0.375],
  [0.125, 0.625],
  [0.625, 0.875],
] as const;
const CENTER = [[0.5, 0.5]] as const;
/** Windows above this many pixels are not scanned (reported as skipped). */
const WINDOW_LIMIT = 4_000_000;

type Pt = readonly [number, number];
type Prepared = Readonly<{
  sign: number;
  edges: readonly (readonly [Pt, Pt])[];
  topLeft: readonly boolean[];
  box: readonly [number, number, number, number];
}>;

const value = (d: { n: bigint; e: number }) => Number(d.n) * 2 ** d.e;
const area2 = (a: Pt, b: Pt, c: Pt) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** A snapped triangle as a rasterizer sees it, made counterclockwise; zero area covers nothing. */
function prepare(a: Pt, b: Pt, c: Pt): Prepared {
  const sign = Math.sign(area2(a, b, c));
  const [p, q, r] = sign < 0 ? [a, c, b] : [a, b, c];
  const edges = [
    [p, q],
    [q, r],
    [r, p],
  ] as const;
  // Top-left rule in y-down pixel space (the probes' convention, matched to the headed run).
  const topLeft = edges.map(([u, v]) => {
    const dx = v[0] - u[0];
    const dy = v[1] - u[1];
    return (dy === 0 && dx > 0) || dy < 0;
  });
  const xs = [a[0], b[0], c[0]];
  const ys = [a[1], b[1], c[1]];
  return {
    sign,
    edges,
    topLeft,
    box: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)],
  };
}

function covers(t: Prepared, x: number, y: number): boolean {
  if (t.sign === 0 || x < t.box[0] || x > t.box[1] || y < t.box[2] || y > t.box[3]) return false;
  for (let e = 0; e < 3; e += 1) {
    const [u, v] = t.edges[e]!;
    const f = (v[0] - u[0]) * (y - u[1]) - (v[1] - u[1]) * (x - u[0]);
    if (f < 0 || (f === 0 && !t.topLeft[e])) return false;
  }
  return true;
}

it('E17-A4: write-once coverage on the snap model', async () => {
  const wasm = process.env.P2_WASM_PATH;
  if (wasm === undefined) throw new Error('P2_WASM_PATH is required');
  const module = await WebAssembly.compile(new Uint8Array(readFileSync(wasm)));
  const ports = {
    fill: await createFillMeshPort(module),
    stroke: await createStrokeMeshPort(module),
  };
  const rows: Record<string, unknown>[] = [];
  let caseVariants = 0;
  for (const c of a08Subset().filter((entry) => entry.gated)) {
    const outcome = drawCase(c.kase, ports, { fringe: 'on' });
    if (outcome.kind !== 'drawn' || outcome.draw.fringe === null) continue;
    const { draw, frame } = outcome;
    const lanes = shaderLanes(draw, frame);
    const fringe = outcome.draw.fringe.data;
    const exact: Pt[] = [];
    for (let i = 0; i < draw.offsets.length / 2; i += 1) {
      const p = mapPoint(draw.offsets[2 * i]!, draw.offsets[2 * i + 1]!, lanes);
      exact.push([value(p.x), value(p.y)]);
    }
    for (let k = 0; k < 4; k += 1) {
      const p = mapPoint(fringe.corners[2 * k]!, fringe.corners[2 * k + 1]!, lanes);
      exact.push([value(p.x), value(p.y)]);
    }
    const snapped = exact.map(([x, y]) => [Math.round(x * SNAP), Math.round(y * SNAP)] as Pt);
    const triangles: [number, number, number][] = [];
    for (let t = 0; t < fringe.triangles.length / 8; t += 1) {
      triangles.push([
        fringe.triangles[8 * t]!,
        fringe.triangles[8 * t + 1]!,
        fringe.triangles[8 * t + 2]!,
      ]);
    }
    const prepared = triangles.map(([a, b, d]) => prepare(snapped[a]!, snapped[b]!, snapped[d]!));
    const changed = triangles
      .map((_, k) => k)
      .filter((k) => {
        const [a, b, d] = triangles[k]!;
        return Math.sign(area2(exact[a]!, exact[b]!, exact[d]!)) !== prepared[k]!.sign;
      });
    // The snapped frame: the corners' images, a convex quadrilateral (an affine image of a box).
    const n = exact.length - 4;
    const frameQuad = [0, 1, 2, 3].map((k) => snapped[n + k]!);
    const frameSign = Math.sign(area2(frameQuad[0]!, frameQuad[1]!, frameQuad[2]!));
    const insideFrame = (x: number, y: number) =>
      frameQuad.every((u, k) => {
        const v = frameQuad[(k + 1) % 4]!;
        return frameSign * ((v[0] - u[0]) * (y - u[1]) - (v[1] - u[1]) * (x - u[0])) > 0;
      });
    const { width, height } = frame;
    const pixels = new Set<number>();
    let skipped = 0;
    for (const k of changed) {
      const points = triangles[k]!.flatMap((i) => [
        exact[i]!,
        [snapped[i]![0] / SNAP, snapped[i]![1] / SNAP],
      ]);
      const x0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p[0]))) - 1);
      const x1 = Math.min(width - 1, Math.ceil(Math.max(...points.map((p) => p[0]))) + 1);
      const y0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1]))) - 1);
      const y1 = Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p[1]))) + 1);
      if (x1 < x0 || y1 < y0) continue;
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > WINDOW_LIMIT) {
        skipped += 1;
        continue;
      }
      for (let j = y0; j <= y1; j += 1) for (let i = x0; i <= x1; i += 1) pixels.add(j * width + i);
    }
    let reference: ReturnType<typeof buildReference> | null = null;
    for (const variant of ['fringe-1x', 'fringe-4x'] as const) {
      caseVariants += 1;
      const samples = variant === 'fringe-4x' ? SAMPLES_4X : CENTER;
      let rawOver = 0;
      let signedOff = 0;
      let holesEqual = 0;
      const examples: string[] = [];
      for (const q of pixels) {
        const i = q % width;
        const j = Math.floor(q / width);
        const raw: number[] = [];
        let pixelHole = false;
        for (const [sx, sy] of samples) {
          const x = Math.round((i + sx) * SNAP);
          const y = Math.round((j + sy) * SNAP);
          let count = 0;
          let signed = 0;
          for (const t of prepared) {
            if (!covers(t, x, y)) continue;
            count += 1;
            signed += t.sign;
          }
          raw.push(count);
          if (insideFrame(x, y) && signed !== frameSign) {
            signedOff += 1;
            if (examples.length < 3) examples.push(`signed(${i},${j})=${signed}`);
          }
          if (count === 0) pixelHole = true;
        }
        if (raw.some((count) => count > 1)) {
          rawOver += 1;
          if (examples.length < 3) examples.push(`raw(${i},${j})[${raw.join(',')}]`);
        }
        if (pixelHole) {
          reference ??= buildReference(draw, frame);
          const cls = pixelClassForTesting(reference, i, j, 0.708);
          if (cls.inside || cls.within) {
            holesEqual += 1;
            if (examples.length < 3) examples.push(`hole(${i},${j})`);
          }
        }
      }
      if (changed.length > 0)
        rows.push({
          key: c.key,
          variant,
          changed: changed.length,
          skipped,
          pixels: pixels.size,
          rawOver,
          signedOff,
          holesEqual,
          examples,
        });
    }
  }
  const summary = {
    caseVariants,
    withChangedTriangles: rows.length,
    rawOverCaseVariants: rows.filter((r) => (r.rawOver as number) > 0).length,
    writeOnceOverCaseVariants: 0,
    signedOffCaseVariants: rows.filter((r) => (r.signedOff as number) > 0).length,
    holesEqualCaseVariants: rows.filter((r) => (r.holesEqual as number) > 0).length,
    skippedWindows: rows.reduce((s, r) => s + (r.skipped as number), 0) / 2,
  };
  const out = path.join(root, '.tools', 'e17-snap-model');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'record.json'), `${JSON.stringify({ summary, rows }, null, 1)}\n`);
  console.log(JSON.stringify(summary));
  expect(summary.signedOffCaseVariants).toBe(0);
  expect(summary.holesEqualCaseVariants).toBe(0);
});
