import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectionInput } from './mesh-projection/model.js';
import { encodeInput } from './position-certificate/corpus.js';
import { add, compare, div, mul, rational, sub, type Rational } from './rounded-fill/exact.js';
import {
  buildMetricsText,
  loadCaptureDirectory,
  type CaptureCrop,
  type CaptureRow,
} from './coverage-oracle/capture-schema.js';
import { cropFor, type Crop } from './coverage-oracle/crop.js';
import { CANDIDATES, computeRowMetrics, type CandidatePasses } from './coverage-oracle/metrics.js';
import {
  CLASS_BAND,
  CLASS_EXTERIOR,
  CLASS_INTERIOR,
  coverageOracle,
  referenceAt,
} from './coverage-oracle/oracle.js';
import {
  admittedFixtureRows,
  coverageCorpus,
  coverageRowGeometry,
  literalRows,
  meshConformity,
  R15_LINEAR,
  type CoverageRowGeometry,
  type Q2,
} from './coverage-oracle/positions.js';
import {
  decodeRleBase64,
  encodeRle,
  encodeRleBase64,
  sampleSha256,
} from './coverage-oracle/rle.js';

// P3.1o O01 coverage oracle: docs/plans/p3-o01-coverage-experiment-contract.md.

const ZERO = rational(0n);
const ONE = rational(1n);
const FOUR = rational(4n);

function shape(
  id: string,
  vertices: readonly (readonly [number, number])[],
  indices: readonly number[],
  options: {
    linear?: readonly [number, number, number, number];
    translation?: readonly [number, number];
    width?: number;
    height?: number;
  } = {},
): ProjectionInput {
  return {
    id,
    mesh: { vertices, indices },
    affine: [...(options.linear ?? [1, 0, 0, 1]), ...(options.translation ?? [0, 0])],
    camera: [0, 0],
    origin: [0, 0],
    zoom: 1,
    dpr: 1,
    width: options.width ?? 64,
    height: options.height ?? 48,
  };
}

const RECT = [0, 1, 2, 0, 2, 3];
const SYNTHETIC: readonly ProjectionInput[] = [
  shape(
    'axis-rectangle',
    [
      [0, 0],
      [10.3, 0],
      [10.3, 7.6],
      [0, 7.6],
    ],
    RECT,
    { translation: [5.37, 6.81] },
  ),
  shape(
    'rotated-triangle',
    [
      [3.1, 2.2],
      [20.7, 9.4],
      [8.3, 25.9],
    ],
    [0, 1, 2],
    { linear: R15_LINEAR, translation: [12.25, 1.5] },
  ),
  shape(
    'shared-edge',
    [
      [4.2, 3.9],
      [30.6, 7.1],
      [27.4, 33.3],
      [6.8, 25.05],
    ],
    RECT,
  ),
  shape(
    'thin-sliver',
    [
      [2.5, 10.1],
      [55.25, 10.35],
      [55.25, 10.6],
    ],
    [0, 1, 2],
  ),
  shape(
    'partly-outside',
    [
      [0, 0],
      [30.5, 0],
      [30.5, 20.75],
      [0, 20.75],
    ],
    RECT,
    { translation: [-11.3, 33.6] },
  ),
  shape(
    'margin-only',
    [
      [0.25, 0.25],
      [2.5, 0.5],
      [1, 2.25],
    ],
    [0, 1, 2],
  ),
];
const EMPTY = shape(
  'empty-crop',
  [
    [0, 0],
    [5, 0],
    [5, 5],
  ],
  [0, 1, 2],
  { translation: [1000.5, 1000.5] },
);

function geometryOf(input: ProjectionInput): CoverageRowGeometry {
  const geometry = coverageRowGeometry(input);
  if ('unsupported' in geometry) throw new Error(geometry.unsupported);
  return geometry;
}

// ---------------------------------------------------------------------------------------------
// Brute-force reference: every crop pixel against every triangle and boundary segment, in
// generic rational arithmetic with no traversal, labels or parity.

function clipPolygon(polygon: Q2[], axis: 0 | 1, at: Rational, keepAbove: boolean): Q2[] {
  const out: Q2[] = [];
  const inside = (p: Q2) => {
    const c = compare(p[axis], at);
    return keepAbove ? c >= 0 : c <= 0;
  };
  for (let index = 0; index < polygon.length; index += 1) {
    const p = polygon[index]!;
    const q = polygon[(index + 1) % polygon.length]!;
    const pin = inside(p);
    const qin = inside(q);
    if (pin) out.push(p);
    if (pin !== qin) {
      const t = div(sub(at, p[axis]), sub(q[axis], p[axis]));
      const point: Q2 = [add(p[0], mul(t, sub(q[0], p[0]))), add(p[1], mul(t, sub(q[1], p[1])))];
      if (!(compare(point[0], p[0]) === 0 && compare(point[1], p[1]) === 0)) out.push(point);
    }
  }
  return out;
}

function polygonArea(polygon: readonly Q2[]): Rational {
  let sum = ZERO;
  for (let index = 0; index < polygon.length; index += 1) {
    const p = polygon[index]!;
    const q = polygon[(index + 1) % polygon.length]!;
    sum = add(sum, sub(mul(p[0], q[1]), mul(q[0], p[1])));
  }
  return rational(sum.n < 0n ? -sum.n : sum.n, sum.d * 2n);
}

function segmentMeetsBox(a: Q2, b: Q2, low: Q2, high: Q2): boolean {
  let polygon: Q2[] = [a, b];
  for (const axis of [0, 1] as const) {
    polygon = clipPolygon(polygon, axis, low[axis], true);
    if (polygon.length === 0) return false;
    polygon = clipPolygon(polygon, axis, high[axis], false);
    if (polygon.length === 0) return false;
  }
  return true;
}

function pointSegmentSquared(p: Q2, a: Q2, b: Q2): Rational {
  const u: Q2 = [sub(b[0], a[0]), sub(b[1], a[1])];
  const v: Q2 = [sub(p[0], a[0]), sub(p[1], a[1])];
  const length2 = add(mul(u[0], u[0]), mul(u[1], u[1]));
  let t = div(add(mul(u[0], v[0]), mul(u[1], v[1])), length2);
  if (compare(t, ZERO) < 0) t = ZERO;
  if (compare(t, ONE) > 0) t = ONE;
  const dx = sub(p[0], add(a[0], mul(t, u[0])));
  const dy = sub(p[1], add(a[1], mul(t, u[1])));
  return add(mul(dx, dx), mul(dy, dy));
}

function pointBoxSquared(p: Q2, low: Q2, high: Q2): Rational {
  const axis = (k: 0 | 1) =>
    compare(p[k], low[k]) < 0
      ? sub(low[k], p[k])
      : compare(p[k], high[k]) > 0
        ? sub(p[k], high[k])
        : ZERO;
  return add(mul(axis(0), axis(0)), mul(axis(1), axis(1)));
}

function boxSegmentSquared(a: Q2, b: Q2, low: Q2, high: Q2): Rational {
  if (segmentMeetsBox(a, b, low, high)) return ZERO;
  const corners: Q2[] = [low, [high[0], low[1]], high, [low[0], high[1]]];
  let best = pointBoxSquared(a, low, high);
  for (const value of [
    pointBoxSquared(b, low, high),
    ...corners.map((corner) => pointSegmentSquared(corner, a, b)),
  ])
    if (compare(value, best) < 0) best = value;
  return best;
}

type Brute = { ref: Rational[]; cls: number[]; corner: number[]; seam: number[] };

function bruteForce(geometry: CoverageRowGeometry, crop: Crop): Brute {
  const result: Brute = { ref: [], cls: [], corner: [], seam: [] };
  const P = geometry.preimage;
  const boundaryVertices = [...new Set(geometry.boundaryEdges.flatMap((e) => [e.a, e.b]))];
  for (let j = crop.y; j < crop.y + crop.h; j += 1)
    for (let i = crop.x; i < crop.x + crop.w; i += 1) {
      const low: Q2 = [rational(BigInt(i)), rational(BigInt(j))];
      const high: Q2 = [rational(BigInt(i + 1)), rational(BigInt(j + 1))];
      let ref = ZERO;
      for (const [a, b, c] of geometry.triangles) {
        let polygon: Q2[] = [P[a]!, P[b]!, P[c]!];
        for (const [axis, at, keep] of [
          [0, low[0], true],
          [0, high[0], false],
          [1, low[1], true],
          [1, high[1], false],
        ] as const) {
          polygon = clipPolygon(polygon, axis, at, keep);
          if (polygon.length < 3) break;
        }
        if (polygon.length >= 3) ref = add(ref, polygonArea(polygon));
      }
      const near = geometry.boundaryEdges.some(
        (edge) => compare(boxSegmentSquared(P[edge.a]!, P[edge.b]!, low, high), FOUR) < 0,
      );
      const cls = near ? CLASS_BAND : compare(ref, ONE) === 0 ? CLASS_INTERIOR : CLASS_EXTERIOR;
      if (!near && cls === CLASS_EXTERIOR) expect(ref).toEqual(ZERO);
      result.ref.push(ref);
      result.cls.push(cls);
      result.corner.push(
        near && boundaryVertices.some((v) => compare(pointBoxSquared(P[v]!, low, high), FOUR) < 0)
          ? 1
          : 0,
      );
      result.seam.push(
        cls === CLASS_INTERIOR &&
          geometry.internalEdges.some((edge) => segmentMeetsBox(P[edge.a]!, P[edge.b]!, low, high))
          ? 1
          : 0,
      );
    }
  return result;
}

function expectMatchesBruteForce(input: ProjectionInput) {
  const geometry = geometryOf(input);
  const crop = cropFor(geometry);
  expect(crop).not.toBeNull();
  const oracle = coverageOracle(geometry, crop!);
  const brute = bruteForce(geometry, crop!);
  const total = crop!.w * crop!.h;
  let mismatches = 0;
  for (let index = 0; index < total; index += 1) {
    if (
      compare(referenceAt(oracle, index), brute.ref[index]!) !== 0 ||
      oracle.classes[index] !== brute.cls[index] ||
      oracle.corner[index] !== brute.corner[index] ||
      oracle.seam[index] !== brute.seam[index]
    )
      mismatches += 1;
  }
  expect(mismatches, input.id).toBe(0);
  return { geometry, crop: crop!, oracle };
}

describe('P3.1o O01 coverage oracle: synthetic shapes against brute force', () => {
  for (const input of SYNTHETIC)
    it(input.id, () => {
      const { oracle, crop } = expectMatchesBruteForce(input);
      expect(crop.w * crop.h).toBeGreaterThan(0);
      expect(oracle.classes.includes(CLASS_BAND)).toBe(true);
    });

  it('empty crop', () => {
    expect(cropFor(geometryOf(EMPTY))).toBeNull();
  });

  it('literal rows', () => {
    for (const input of literalRows()) expectMatchesBruteForce(input);
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------

describe('P3.1o O01 positions and literal rows', () => {
  const literals = literalRows();

  it('builds the six contract rows with linear, then translation, then zoom', () => {
    expect(literals.map((row) => row.id)).toEqual([
      'F07-Z16',
      'F07-Z16R15',
      'F11-Z8',
      'SQ-Z1',
      'SQ-Z1R15',
      'THIN-Z1',
    ]);
    for (const row of literals) {
      expect(meshConformity(row.mesh)).toBeNull();
      expect(row.affine.slice(4)).toEqual([10.265625, 10.7734375]);
      expect([row.camera, row.origin, row.dpr, row.width, row.height]).toEqual([
        [0, 0],
        [0, 0],
        1,
        640,
        360,
      ]);
    }
    // R = (linear(v) + translation) * zoom for an identity row: vertex (2, 2) of F07-Z16.
    const f07 = geometryOf(literals[0]!);
    expect(f07.reference[4]).toEqual([
      rational((2n * 64n + 657n) * 16n, 64n),
      rational((2n * 128n + 1379n) * 16n, 128n),
    ]);
  });

  it('has no integer physical coordinate on an axis-aligned boundary edge of an unrotated row', () => {
    for (const input of literals.filter((row) => row.affine[1] === 0 && row.affine[2] === 0)) {
      const geometry = geometryOf(input);
      let axisAligned = 0;
      for (const edge of geometry.boundaryEdges) {
        const a = geometry.preimage[edge.a]!;
        const b = geometry.preimage[edge.b]!;
        for (const axis of [0, 1] as const)
          if (compare(a[axis], b[axis]) === 0) {
            axisAligned += 1;
            expect(a[axis].d, `${input.id}:${edge.a}-${edge.b}`).not.toBe(1n);
            const R = geometry.reference[edge.a]![axis];
            expect(R.d).not.toBe(1n);
          }
      }
      expect(axisAligned).toBe(geometry.boundaryEdges.length);
    }
  });

  it('lists the contract internal edges of F07 and F11', () => {
    const edges = (id: string) =>
      geometryOf(literals.find((row) => row.id === id)!).internalEdges.map((e) => [e.a, e.b]);
    expect(edges('F07-Z16')).toEqual([
      [0, 4],
      [1, 3],
      [1, 4],
    ]);
    expect(edges('F07-Z16R15')).toEqual(edges('F07-Z16'));
    // F11: the span 2-3 and the fan diagonals 0-2, 0-3, 2-6, 2-7.
    expect(edges('F11-Z8')).toEqual([
      [0, 2],
      [0, 3],
      [2, 3],
      [2, 6],
      [2, 7],
    ]);
    const f11 = geometryOf(literals.find((row) => row.id === 'F11-Z8')!);
    const span = f11.preimage;
    expect(compare(span[2]![1], span[3]![1])).toBe(0);
  });

  it('rounds NDC once and preimages exactly', () => {
    for (const input of literals) {
      const geometry = geometryOf(input);
      geometry.ndc.forEach(([x, y], vertex) => {
        expect(Math.fround(x)).toBe(x);
        expect(Math.fround(y)).toBe(y);
        const R = geometry.reference[vertex]!;
        const exactX = sub(div(mul(rational(2n), R[0]), rational(BigInt(input.width))), ONE);
        // |ndc - exact| <= half an f32 ulp near |exact|: rounding moves by less than 2^-24 relative.
        const error = sub(rational(BigInt(Math.round(x * 2 ** 40)), 1n << 40n), exactX);
        expect(Math.abs(Number(error.n) / Number(error.d))).toBeLessThan(2 ** -20);
        const P = geometry.preimage[vertex]!;
        expect(P[0]).toEqual(
          div(
            mul(add(rational(BigInt(Math.round(x * 2 ** 40)), 1n << 40n), ONE), rational(640n)),
            rational(2n),
          ),
        );
        expect(P[1].d & (P[1].d - 1n)).toBe(0n);
      });
      expect(compare(geometry.maxPreimageError.squared, rational(1n, 1n << 20n))).toBeLessThan(0);
    }
  });

  it('selects the 143 R0a admitted fixture rows and every one passes conformity', () => {
    const rows = admittedFixtureRows();
    expect(rows).toHaveLength(143);
    for (const row of rows) expect(meshConformity(row.input.mesh), row.id).toBeNull();
    const corpus = coverageCorpus();
    expect(corpus).toHaveLength(149);
    expect(corpus.map((row) => row.rowIndex)).toEqual(corpus.map((_, index) => index));
    expect(corpus.slice(143).map((row) => row.kind)).toEqual(Array(6).fill('literal'));
  }, 600_000);

  it('reports a malformed mesh as INPUT_UNSUPPORTED', () => {
    const reversed = shape(
      'reversed',
      [
        [0, 0],
        [0, 5],
        [5, 0],
      ],
      [0, 1, 2],
    );
    expect(coverageRowGeometry(reversed)).toEqual({
      unsupported: 'INPUT_UNSUPPORTED:inspect:REVERSED_TRIANGLE',
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('P3.1o O01 run-length encoding', () => {
  it('round-trips u8 and u16 crops and hashes decoded bytes', () => {
    const u8 = Uint8Array.from([0, 0, 0, 255, 255, 7, 0, 0]);
    expect([...encodeRle(u8)]).toEqual([0, 3, 255, 2, 7, 1, 0, 2]);
    expect(decodeRleBase64(encodeRleBase64(u8), 8, 'u8')).toEqual(u8);
    const u16 = Uint16Array.from([0x3c00, 0x3c00, 0x0001, 0xffff]);
    expect(decodeRleBase64(encodeRleBase64(u16), 4, 'u16')).toEqual(u16);
    expect(sampleSha256(u16)).toBe(
      sampleSha256(Uint8Array.from([0x00, 0x3c, 0x00, 0x3c, 0x01, 0x00, 0xff, 0xff])),
    );
    expect(() => decodeRleBase64(encodeRleBase64(u8), 9, 'u8')).toThrow('rle:total');
    expect(() => decodeRleBase64(encodeRleBase64(u16), 4, 'u8')).toThrow('rle:value');
  });
});

// ---------------------------------------------------------------------------------------------

function idealPasses(
  geometry: CoverageRowGeometry,
  crop: Crop,
  bias: (index: number) => number = () => 0,
): CandidatePasses[] {
  const oracle = coverageOracle(geometry, crop);
  const total = crop.w * crop.h;
  const main = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) {
    const ref = referenceAt(oracle, index);
    const k = Number((ref.n * 255n * 2n + ref.d) / (2n * ref.d));
    main[index] = Math.min(255, Math.max(0, k + bias(index)));
  }
  const max = new Uint16Array(total).fill(0x3c00);
  const sum = new Uint16Array(total).fill(0x3c00);
  sum[0] = 0x4000;
  return CANDIDATES.map((candidate) => ({
    candidate,
    main1: main,
    main4: main.map((value, index) => (index === 1 ? value ^ 1 : value)),
    diagMax: max,
    diagAdd: sum,
  }));
}

describe('P3.1o O01 metrics', () => {
  it('computes exact metrics and N/A rules deterministically', () => {
    const literal = literalRows().find((row) => row.id === 'THIN-Z1')!;
    const geometry = geometryOf(literal);
    const crop = cropFor(geometry)!;
    const oracle = coverageOracle(geometry, crop);
    const passes = idealPasses(geometry, crop);
    const metrics = computeRowMetrics(geometry, crop, oracle, passes);
    expect(JSON.stringify(computeRowMetrics(geometry, crop, oracle, passes))).toBe(
      JSON.stringify(metrics),
    );
    const sample = metrics.candidates[0]!.samples[0];
    // THIN-Z1 (0.3125 px tall) has no interior pixel and no internal-edge seam pixel.
    expect(sample.interiorError).toBe('N/A:none');
    expect(sample.seamError).toBe('N/A:none');
    expect(sample.exteriorError).toEqual({ n: '0', d: '1', approx: '0.00000e+0' });
    // The reference area is the exact preimage rectangle area (12.5 before NDC rounding).
    const area = polygonArea([0, 1, 2, 3].map((v) => geometry.preimage[v]!));
    expect(sample.thinArea?.reference).toMatchObject({
      n: area.n.toString(),
      d: area.d.toString(),
    });
    expect(Math.abs(Number(sample.thinArea?.reference.approx) - 12.5)).toBeLessThan(1e-4);
    expect(metrics.candidates[0]!.difference1x4x.n).toBe('1');
    expect(
      metrics.candidates[0]!.overlap.exterior.count + metrics.candidates[0]!.overlap.band.count,
    ).toBe(1);
    // Rounded ideal coverage deviates by at most 1/510.
    const band = sample.band.withCorners;
    expect(typeof band.maxAbs === 'object' && Number(band.maxAbs.approx) <= 1 / 510).toBe(true);
    expect(typeof sample.boundaryShift).toBe('object');

    const margin = geometryOf(SYNTHETIC.find((row) => row.id === 'margin-only')!);
    const marginCrop = cropFor(margin)!;
    const marginMetrics = computeRowMetrics(
      margin,
      marginCrop,
      coverageOracle(margin, marginCrop),
      idealPasses(margin, marginCrop),
    );
    expect(marginMetrics.candidates[0]!.samples[0].boundaryShift).toBe('N/A:L=0');
    expect(marginMetrics.candidates[0]!.samples[0].thinArea).toBeUndefined();
  });

  it('reports a uniform outward shift of one level per boundary length', () => {
    const geometry = geometryOf(literalRows().find((row) => row.id === 'SQ-Z1')!);
    const crop = cropFor(geometry)!;
    const oracle = coverageOracle(geometry, crop);
    const metrics = computeRowMetrics(geometry, crop, oracle, idealPasses(geometry, crop));
    const sample = metrics.candidates[1]!.samples[1];
    expect(sample.interiorError).toEqual({ n: '0', d: '1', approx: '0.00000e+0' });
    expect(sample.seamError).toEqual({ n: '0', d: '1', approx: '0.00000e+0' });
    expect(metrics.classes.seam).toBeGreaterThan(0);
    const shift = sample.boundaryShift;
    expect(typeof shift === 'object' && Math.abs(Number(shift.approx)) < 1 / 255).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe('P3.1o O01 capture reader and metrics document', () => {
  it('reads a capture, merges split parts and writes byte-identical metrics', () => {
    const corpus = coverageCorpus();
    const directory = mkdtempSync(path.join(tmpdir(), 'p3-coverage-'));
    try {
      const rows: CaptureRow[] = corpus.map((row) => {
        const geometry = coverageRowGeometry(row.input);
        const base = {
          rowIndex: row.rowIndex,
          id: row.id,
          kind: row.kind,
          input: encodeInput(row.input),
          width: row.input.width,
          height: row.input.height,
        };
        if ('unsupported' in geometry)
          return {
            ...base,
            status: 'INPUT_UNSUPPORTED',
            reason: geometry.unsupported,
            crop: null,
            crops: [],
          };
        const crop = cropFor(geometry);
        if (row.kind !== 'literal' || row.id !== 'SQ-Z1' || crop === null)
          return { ...base, status: 'NOT_RUN', reason: null, crop, crops: [] };
        const passes = idealPasses(geometry, crop);
        const crops: CaptureCrop[] = passes.flatMap((pass) =>
          (
            [
              [1, 'main', 'rgba8unorm', pass.main1],
              [4, 'main', 'rgba8unorm', pass.main4],
              [1, 'diagMax', 'rgba16float', pass.diagMax],
              [1, 'diagAdd', 'rgba16float', pass.diagAdd],
            ] as const
          ).map(([sampleCount, kind, format, samples]) => ({
            candidate: pass.candidate,
            sampleCount,
            pass: kind,
            format,
            rleBase64: encodeRleBase64(samples),
            sha256: sampleSha256(samples),
          })),
        );
        return {
          ...base,
          status: 'RENDERED',
          reason: null,
          crop,
          ndcBits: geometry.ndcBits,
          crops,
        };
      });
      writeFileSync(
        path.join(directory, 'capture.json'),
        JSON.stringify({ schema: 'p3-coverage-capture-v1', rows }),
      );
      const text = buildMetricsText(loadCaptureDirectory(directory));
      expect(buildMetricsText(loadCaptureDirectory(directory))).toBe(text);
      const document = JSON.parse(text) as {
        counts: Record<string, number>;
        rows: { status: string; metrics: unknown }[];
      };
      expect(document.counts.rendered).toBe(1);
      expect(document.counts.rows).toBe(149);
      expect(text.endsWith('}\n')).toBe(true);

      // Split per candidate through capture-index.json.
      const split = mkdtempSync(path.join(tmpdir(), 'p3-coverage-split-'));
      try {
        const parts = CANDIDATES.map((candidate) => {
          const file = `capture-${candidate}.json`;
          const body = JSON.stringify({
            schema: 'p3-coverage-capture-v1',
            rows: rows.map((row) => ({
              ...row,
              crops: row.crops.filter((crop) => crop.candidate === candidate),
            })),
          });
          writeFileSync(path.join(split, file), body);
          return { path: file, sha256: sampleSha256(Buffer.from(body, 'utf8')) };
        });
        writeFileSync(
          path.join(split, 'capture-index.json'),
          JSON.stringify({ schema: 'p3-coverage-capture-index-v1', parts }),
        );
        const splitText = buildMetricsText(loadCaptureDirectory(split));
        const strip = (value: string) => value.replace(/"capture": \{[^}]*\}/u, '');
        expect(strip(splitText)).toBe(strip(text));
        expect(readFileSync(path.join(split, 'capture-index.json'), 'utf8')).toContain('parts');
      } finally {
        rmSync(split, { recursive: true, force: true });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 600_000);
});
