import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectionFixture } from './mesh-projection/fixtures.js';
import {
  simulateMeshProjection,
  type ProjectionInput,
  type ProjectionPoint,
} from './mesh-projection/model.js';
import {
  absolute,
  add,
  bitsOf,
  compare,
  div,
  exactInteger,
  mul,
  rational,
  sub,
  type Rational,
} from './rounded-fill/exact.js';
import {
  adversarialDisplacement,
  EVALUATIONS_PER_VERTEX_AXIS,
  independentClearanceSummary,
  type IndependentClearanceSummary,
} from './position-certificate/adversarial.js';
import {
  certifyPosition,
  certifyWindow,
  clearanceSummary,
  originP1,
  originPX,
  pack64,
  sqrtUp,
  type PositionCertificate,
} from './position-certificate/certificate.js';
import {
  K_ARCHIVE,
  L_CAPTURES,
  loadCapture,
  loadFixtureRows,
  nativeRecovered,
  originSequences,
  prospectiveRows,
  sha256,
  termRows,
  type Browser,
  type CaptureRow,
  type Expectation,
  type LiteralRow,
} from './position-certificate/corpus.js';

/**
 * P3.1m N03: evidence for the frozen M01-M06 position certificate contract
 * (docs/plans/p3-position-certificate-contract.md). Test-only; no runtime behavior is adopted.
 */

const REPORT_PATH = 'docs/evidence/p3.1m-position-certificate/report.json';
const WRITE = process.env.P3_POSITION_CERTIFICATE_WRITE === '1';
const SOURCES = [
  'tests/geometry/position-certificate/certificate.ts',
  'tests/geometry/position-certificate/adversarial.ts',
  'tests/geometry/position-certificate/corpus.ts',
  'tests/geometry/position-certificate.test.ts',
] as const;
const BLOCK_TIMEOUT = 60_000;

type Q2 = readonly [Rational, Rational];
type Policy = 'fixture' | 'O-P1' | 'O-PX' | 'literal';

const ZERO = rational(0n);
const ONE = rational(1n);
const TWO = rational(2n);
const FOUR = rational(4n);
const pow2 = (exponent: number): Rational =>
  exponent >= 0 ? rational(1n << BigInt(exponent)) : rational(1n, 1n << BigInt(-exponent));

function gammaOf(operations: number): Rational {
  let product = add(ONE, mul(rational(5n, 2n), pow2(-23)));
  for (let index = 0; index < operations; index += 1) product = mul(product, add(ONE, pow2(-23)));
  return sub(product, ONE);
}
const GAMMA9 = gammaOf(9);

function q64(value: number): Rational {
  return rational(exactInteger(bitsOf(value)), 1n << 1074n);
}

/** Deterministic 6-significant-digit decimal of an exact rational. */
function approx(value: Rational | null): string | null {
  if (value === null) return null;
  if (value.n === 0n) return '0';
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n;
  let exponent = n.toString().length - value.d.toString().length;
  const scaled = (k: number) =>
    k <= 5 ? (n * 10n ** BigInt(5 - k)) / value.d : n / (value.d * 10n ** BigInt(k - 5));
  while (scaled(exponent) >= 1_000_000n) exponent += 1;
  while (scaled(exponent) < 100_000n) exponent -= 1;
  const numerator = exponent <= 5 ? n * 10n ** BigInt(5 - exponent) : n;
  const denominator = exponent <= 5 ? value.d : value.d * 10n ** BigInt(exponent - 5);
  let digits = (2n * numerator + denominator) / (2n * denominator);
  if (digits >= 1_000_000n) {
    digits /= 10n;
    exponent += 1;
  }
  const text = digits.toString();
  return `${negative ? '-' : ''}${text[0]}.${text.slice(1)}e${exponent}`;
}

function exact(value: Rational): Readonly<{ n: string; d: string }> {
  return { n: value.n.toString(), d: value.d.toString() };
}

function maxRational(left: Rational | null, right: Rational): Rational {
  return left === null || compare(right, left) > 0 ? right : left;
}

function referenced(input: ProjectionInput): number[] {
  return [...new Set(input.mesh.indices)].sort((a, b) => a - b);
}

/** K's exact original-input reference R per vertex (origin independent). */
const referenceCache = new Map<ProjectionInput, Q2[]>();
function references(input: ProjectionInput): Q2[] {
  const cached = referenceCache.get(input);
  if (cached !== undefined) return cached;
  const [a, b, c, d, e, f] = input.affine.map(q64) as [
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  const [cx, cy] = input.camera.map(q64) as [Rational, Rational];
  const scale = mul(q64(input.zoom), q64(input.dpr));
  const result = input.mesh.vertices.map(([x, y]): Q2 => {
    const [qx, qy] = [q64(x), q64(y)];
    return [
      mul(sub(add(add(mul(a, qx), mul(c, qy)), e), cx), scale),
      mul(sub(add(add(mul(b, qx), mul(d, qy)), f), cy), scale),
    ];
  });
  referenceCache.set(input, result);
  return result;
}

/** Shader absolute monomial sum per vertex-axis on f32 lanes, for N02 vertex selection. */
function selectVertices(input: ProjectionInput, origin: ProjectionPoint): [number, 0 | 1][] {
  const fr = Math.fround;
  const xs = input.mesh.vertices.map((point) => point[0]);
  const ys = input.mesh.vertices.map((point) => point[1]);
  const mx = Math.min(...xs) / 2 + Math.max(...xs) / 2;
  const my = Math.min(...ys) / 2 + Math.max(...ys) / 2;
  const [a, b, c, d, e, g] = input.affine;
  const anchor = [fr(a * mx + c * my + e - origin[0]), fr(b * mx + d * my + g - origin[1])];
  const frame = [fr(origin[0] - input.camera[0]), fr(origin[1] - input.camera[1])];
  const linear = [fr(a), fr(b), fr(c), fr(d)].map(q64);
  const result: [number, 0 | 1][] = [];
  for (const axis of [0, 1] as const) {
    let best: Rational | null = null;
    let bestVertex = -1;
    for (const vertex of referenced(input)) {
      const [x, y] = input.mesh.vertices[vertex]!;
      const ux = q64(fr(x - mx));
      const uy = q64(fr(y - my));
      const sum = add(
        add(absolute(mul(linear[axis]!, ux)), absolute(mul(linear[axis + 2]!, uy))),
        add(absolute(q64(anchor[axis]!)), absolute(q64(frame[axis]!))),
      );
      if (best === null || compare(sum, best) > 0) {
        best = sum;
        bestVertex = vertex;
      }
    }
    result.push([bestVertex, axis]);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Independent M04 clearance evaluation (used for the mutated-summary unit control).

function sqrtUpIndependent(value: Rational): Rational {
  if (value.n <= 0n) return ZERO;
  // Smallest k with k^2 / 2^128 >= value: k = ceil(sqrt(ceil(value * 2^128))).
  const target = (value.n * (1n << 128n) + value.d - 1n) / value.d;
  let low = 0n;
  let high = 1n;
  while (high * high < target) high <<= 1n;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (middle * middle >= target) high = middle;
    else low = middle + 1n;
  }
  return rational(low, 1n << 64n);
}

type ClearanceOutcome = Readonly<{
  term: 'vertex' | 'edge' | 'triangle' | 'fan' | null;
  collinear: boolean | null;
}>;

function independentClearance(
  input: ProjectionInput,
  summary: IndependentClearanceSummary,
  delta2Max: Rational,
): ClearanceOutcome {
  const [a, b, c, d] = input.affine.map(q64) as [Rational, Rational, Rational, Rational];
  const s = mul(q64(input.zoom), q64(input.dpr));
  const s2 = mul(s, s);
  const detS = absolute(mul(s2, sub(mul(a, d), mul(b, c))));
  const frobenius2 = mul(s2, add(add(mul(a, a), mul(b, b)), add(mul(c, c), mul(d, d))));
  const sigmaMax = sqrtUpIndependent(frobenius2);
  const sigmaLo = div(detS, sigmaMax);
  const sigmaLo2 = mul(sigmaLo, sigmaLo);
  const delta = sqrtUpIndependent(delta2Max);
  const delta2 = mul(delta, delta);
  const strict = (left: Rational, right: Rational) => compare(left, right) > 0;
  if (summary.dV2 !== null && !strict(mul(sigmaLo2, summary.dV2), mul(FOUR, delta2)))
    return { term: 'vertex', collinear: null };
  if (summary.dE2 !== null && !strict(mul(sigmaLo2, summary.dE2), mul(FOUR, delta2)))
    return { term: 'edge', collinear: null };
  const rhs =
    summary.plo === null || summary.plo.n === 0n
      ? null
      : add(mul(mul(TWO, delta), sigmaMax), div(mul(FOUR, delta2), summary.plo));
  if (summary.rhoBar !== null && (rhs === null || !strict(mul(detS, summary.rhoBar), rhs)))
    return { term: 'triangle', collinear: null };
  if (summary.overlappingFan) return { term: 'fan', collinear: true };
  if (summary.kappaBar !== null && (rhs === null || !strict(mul(detS, summary.kappaBar), rhs)))
    return { term: 'fan', collinear: false };
  if (
    summary.lambdaBar !== null &&
    (rhs === null || !strict(mul(sigmaLo2, summary.lambdaBar), rhs))
  )
    return { term: 'fan', collinear: true };
  return { term: null, collinear: null };
}

// ---------------------------------------------------------------------------------------------
// Shared evaluation state.

type Displacements = {
  k: Rational | null;
  lChrome: Rational | null;
  lEdge: Rational | null;
  n02: Rational | null;
};

type RowRecord = Readonly<{
  id: string;
  policy: Policy;
  input: ProjectionInput;
  origin: ProjectionPoint;
  g: number | null;
  certificate: PositionCertificate;
  window: Readonly<{
    halfWidth: number;
    admitted: boolean;
    maxE2: Rational | null;
    cameras: number;
    skipped: number;
  }> | null;
  gamma9: PositionCertificate;
  displacement: Displacements;
  n02: Readonly<{
    vertexAxes: readonly (readonly [number, number])[];
    evaluations: number;
    maxAbs: readonly Rational[];
  }>;
}>;

const records = new Map<string, RowRecord>();
const failures: string[] = [];
const timings: Record<string, number> = {};
let fixtures: readonly ProjectionFixture[] = [];
const captures = {} as Record<Browser, readonly CaptureRow[]>;
let totalEvaluations = 0;
let totalVertexAxes = 0;

function withinOrFail(label: string, actual: Rational, bound: Rational | null): void {
  if (bound === null) return;
  if (compare(actual, bound) > 0) failures.push(`${label}: ${approx(actual)} > ${approx(bound)}`);
}

function dominance(
  label: string,
  input: ProjectionInput,
  certificate: PositionCertificate,
  actual: readonly (readonly [Rational, Rational])[],
): Rational | null {
  const R = references(input);
  let max: Rational | null = null;
  for (const vertex of referenced(input)) {
    for (const axis of [0, 1] as const) {
      const difference = absolute(sub(actual[vertex]![axis], R[vertex]![axis]));
      max = maxRational(max, difference);
      const bound = (axis === 0 ? certificate.ex : certificate.ey)[vertex] ?? null;
      withinOrFail(`${label}:v${vertex}:${axis}`, difference, bound);
    }
  }
  return max;
}

function kActual(input: ProjectionInput, origin: ProjectionPoint): Q2[] {
  const observation = simulateMeshProjection({ ...input, origin });
  if (!observation.ok) throw new Error(`${input.id}: K ${observation.stage}`);
  return observation.recovered.map(([x, y]) => [q64(x), q64(y)] as const);
}

function cameraGrid(origin: ProjectionPoint, halfWidth: number): ProjectionPoint[] {
  const cameras: ProjectionPoint[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      cameras.push([origin[0] + sx * halfWidth, origin[1] + sy * halfWidth]);
  const steps = [-0.75, -0.25, 0.25, 0.75];
  for (const sx of steps)
    for (const sy of steps) cameras.push([origin[0] + sx * halfWidth, origin[1] + sy * halfWidth]);
  return cameras;
}

function evaluateRow(
  id: string,
  policy: Policy,
  input: ProjectionInput,
  origin: ProjectionPoint,
  options: Readonly<{
    g?: number | null;
    halfWidth?: number | null;
    native?: Readonly<Record<Browser, CaptureRow>>;
    allVertices?: boolean;
  }>,
): RowRecord {
  const label = `${id}|${policy}`;
  const certificate = certifyPosition(input, origin);
  const gamma9 = certifyPosition(input, origin, { gamma: GAMMA9 });
  const displacement: Displacements = { k: null, lChrome: null, lEdge: null, n02: null };
  displacement.k = dominance(`${label}:K`, input, certificate, kActual(input, origin));
  if (options.native !== undefined) {
    displacement.lChrome = dominance(
      `${label}:L-chrome`,
      input,
      certificate,
      nativeRecovered(input, options.native.chrome),
    );
    displacement.lEdge = dominance(
      `${label}:L-edge`,
      input,
      certificate,
      nativeRecovered(input, options.native.edge),
    );
  }
  const vertexAxes: (readonly [number, 0 | 1])[] = options.allVertices
    ? referenced(input).flatMap((vertex) => [[vertex, 0] as const, [vertex, 1] as const])
    : selectVertices(input, origin);
  let evaluations = 0;
  const maxAbs: Rational[] = [];
  for (const [vertex, axis] of vertexAxes) {
    const result = adversarialDisplacement(input, origin, vertex, axis);
    if (result.evaluations !== EVALUATIONS_PER_VERTEX_AXIS)
      failures.push(`${label}:N02 count ${result.evaluations}`);
    evaluations += result.evaluations;
    maxAbs.push(result.maxAbs);
    displacement.n02 = maxRational(displacement.n02, result.maxAbs);
    const bound = (axis === 0 ? certificate.ex : certificate.ey)[vertex] ?? null;
    withinOrFail(`${label}:N02:v${vertex}:${axis}`, result.maxAbs, bound);
  }
  totalEvaluations += evaluations;
  totalVertexAxes += vertexAxes.length;

  // Pack64 >= Pack on every referenced vertex.
  if (certificate.reason !== 'lane-range' && certificate.reason !== 'singular') {
    const bounds = pack64(input, origin);
    for (const vertex of referenced(input))
      for (const axis of [0, 1] as const) {
        const pack = certificate.pack[vertex]?.[axis] ?? null;
        const upper = bounds[vertex]?.[axis] ?? null;
        if (pack === null || upper === null) failures.push(`${label}:pack-null:v${vertex}`);
        else if (compare(upper, pack) < 0) failures.push(`${label}:Pack64<Pack:v${vertex}:${axis}`);
      }
  }

  let window: RowRecord['window'] = null;
  const halfWidth = options.halfWidth ?? null;
  if (halfWidth !== null) {
    const result = certifyWindow(input, origin, halfWidth);
    let maxE2: Rational | null = null;
    let cameras = 0;
    let skipped = 0;
    const hasWindow = referenced(input).every(
      (vertex) => result.ewx[vertex] != null && result.ewy[vertex] != null,
    );
    if (hasWindow) {
      for (const vertex of referenced(input))
        maxE2 = maxRational(
          maxE2,
          add(
            mul(result.ewx[vertex]!, result.ewx[vertex]!),
            mul(result.ewy[vertex]!, result.ewy[vertex]!),
          ),
        );
      for (const camera of [...cameraGrid(origin, halfWidth), input.camera]) {
        const pointwise = certifyPosition({ ...input, camera }, origin);
        cameras += 1;
        if (pointwise.ex.every((value) => value === null)) {
          skipped += 1;
          continue;
        }
        for (const vertex of referenced(input)) {
          withinOrFail(
            `${label}:Ewin-x:v${vertex}@${camera.join(',')}`,
            pointwise.ex[vertex]!,
            result.ewx[vertex]!,
          );
          withinOrFail(
            `${label}:Ewin-y:v${vertex}@${camera.join(',')}`,
            pointwise.ey[vertex]!,
            result.ewy[vertex]!,
          );
        }
      }
    }
    window = { halfWidth, admitted: result.windowAdmitted, maxE2, cameras, skipped };
  }
  const record: RowRecord = {
    id,
    policy,
    input,
    origin,
    g: options.g ?? null,
    certificate,
    window,
    gamma9,
    displacement,
    n02: { vertexAxes, evaluations, maxAbs },
  };
  records.set(label, record);
  return record;
}

function timed<T>(name: string, run: () => T): T {
  const start = performance.now();
  try {
    return run();
  } finally {
    timings[name] = Math.round(performance.now() - start);
  }
}

function closeTo(actual: Rational, expected: number, digits: number): boolean {
  // Within one unit of the stated last significant digit.
  const exponent = Math.floor(Math.log10(Math.abs(expected)));
  const unit = 10 ** (exponent - digits + 1);
  const value = Number(approx(actual));
  return Math.abs(value - expected) <= unit;
}

function checkExpectation(row: LiteralRow, record: RowRecord, observed: string[]): void {
  const expected: Expectation = row.expected;
  const { certificate } = record;
  if (expected.status !== undefined && certificate.status !== expected.status)
    observed.push(
      `${row.id}: status ${certificate.status} (${certificate.reason}) expected ${expected.status}`,
    );
  if (expected.reason !== undefined && certificate.reason !== expected.reason)
    observed.push(`${row.id}: reason ${certificate.reason} expected ${expected.reason}`);
  if (expected.reasonNot !== undefined && certificate.reason === expected.reasonNot)
    observed.push(`${row.id}: reason ${certificate.reason} must not be ${expected.reasonNot}`);
  if (
    expected.delta2 !== undefined &&
    !closeTo(certificate.delta2Max, expected.delta2.value, expected.delta2.digits)
  )
    observed.push(
      `${row.id}: delta2Max ${approx(certificate.delta2Max)} expected ${expected.delta2.value}`,
    );
  if (expected.window !== undefined) {
    if (record.window === null) observed.push(`${row.id}: no window`);
    else {
      if (record.window.admitted !== expected.window.admitted)
        observed.push(
          `${row.id}: window admitted ${record.window.admitted} (${approx(record.window.maxE2)})`,
        );
      if (
        expected.window.value !== undefined &&
        (record.window.maxE2 === null ||
          !closeTo(record.window.maxE2, expected.window.value, expected.window.digits ?? 3))
      )
        observed.push(
          `${row.id}: window E2 ${approx(record.window.maxE2)} expected ${expected.window.value}`,
        );
    }
  }
  if (expected.gamma9 !== undefined) {
    if (
      record.gamma9.status !== expected.gamma9.status ||
      record.gamma9.reason !== expected.gamma9.reason
    )
      observed.push(`${row.id}: gamma9 ${record.gamma9.status} ${record.gamma9.reason}`);
    if (
      expected.gamma9.value !== undefined &&
      !closeTo(record.gamma9.delta2Max, expected.gamma9.value, expected.gamma9.digits ?? 3)
    )
      observed.push(
        `${row.id}: gamma9 delta2Max ${approx(record.gamma9.delta2Max)} expected ${expected.gamma9.value}`,
      );
  }
  const packs = referenced(row.input).flatMap((vertex) => certificate.pack[vertex] ?? []);
  if (expected.packNonzero && !packs.some((pack) => pack.n !== 0n))
    observed.push(`${row.id}: Pack is zero`);
  if (expected.packZero && packs.some((pack) => pack.n !== 0n))
    observed.push(`${row.id}: Pack is nonzero`);
}

function literalOrigin(
  row: LiteralRow,
  previous?: Readonly<{ origin: ProjectionPoint; g: number }>,
): {
  origin: ProjectionPoint;
  g: number | null;
} {
  if (row.policy === 'O-P1') return { origin: originP1(row.input.camera), g: null };
  if (row.policy === 'O-PX')
    return originPX(row.input.camera, row.input.zoom, row.input.dpr, previous);
  return { origin: row.origin, g: null };
}

const literalExpectationFailures: string[] = [];

describe('P3.1m position certificate', () => {
  it(
    'pins the K archive and both L captures and decodes every native row',
    () =>
      timed('archives', () => {
        fixtures = loadFixtureRows();
        expect(fixtures).toHaveLength(158);
        for (const browser of ['chrome', 'edge'] as const)
          captures[browser] = loadCapture(browser, fixtures);
        fixtures.forEach((fixture, index) => {
          for (const browser of ['chrome', 'edge'] as const)
            expect(nativeRecovered(fixture.input, captures[browser][index]!)).toHaveLength(
              fixture.input.mesh.vertices.length,
            );
        });
        expect(() => loadCapture('chrome', fixtures.slice(1))).toThrow('l-capture:chrome:count');
      }),
    BLOCK_TIMEOUT,
  );

  it(
    'fixture origin: K, L-Chrome, L-Edge and N02 dominance on all 158 rows',
    () =>
      timed('fixture', () => {
        fixtures.forEach((fixture, index) =>
          evaluateRow(fixture.id, 'fixture', fixture.input, fixture.input.origin, {
            native: { chrome: captures.chrome[index]!, edge: captures.edge[index]! },
          }),
        );
        expect(failures).toEqual([]);
      }),
    BLOCK_TIMEOUT,
  );

  for (const policy of ['O-P1', 'O-PX'] as const)
    for (const part of [0, 1, 2] as const)
      it(
        `${policy} derived origin (part ${part + 1}/3): K and N02 dominance and window bounds`,
        () =>
          timed(`${policy}-${part}`, () => {
            const slice = fixtures.slice([0, 40, 80][part], [40, 80, 158][part]);
            for (const fixture of slice) {
              const { input } = fixture;
              if (policy === 'O-P1') {
                const origin = originP1(input.camera);
                evaluateRow(fixture.id, policy, input, origin, { halfWidth: 512 });
              } else {
                const { origin, g } = originPX(input.camera, input.zoom, input.dpr);
                evaluateRow(fixture.id, policy, input, origin, { g, halfWidth: 2 * g });
              }
            }
            expect(failures).toEqual([]);
          }),
        BLOCK_TIMEOUT,
      );

  it(
    'prospective and term-targeting rows meet their M05 expectations',
    () =>
      timed('literal', () => {
        const rows = [...prospectiveRows(), ...termRows()];
        for (const row of rows) {
          const previous = row.id.startsWith('WIN-EDGE')
            ? { origin: [248, 0] as const, g: 8 }
            : undefined;
          const derived = literalOrigin(row, previous);
          expect(derived.origin, `${row.id} origin`).toEqual(row.origin);
          if (row.g !== null) expect(derived.g, `${row.id} g`).toBe(row.g);
          const record = evaluateRow(
            row.id,
            row.policy === 'literal' ? 'literal' : row.policy,
            row.input,
            derived.origin,
            {
              g: derived.g,
              halfWidth: row.halfWidth,
              allVertices: true,
            },
          );
          checkExpectation(row, record, literalExpectationFailures);
        }
        // WIN-EDGE: camera x = 264 = O + 2g keeps (248, 0); 264.25 re-snaps to (264, 0), g = 8.
        expect(originPX([264, 0], 64, 2, { origin: [248, 0], g: 8 })).toEqual({
          origin: [248, 0],
          g: 8,
        });
        expect(originPX([264.25, 0], 64, 2, { origin: [248, 0], g: 8 })).toEqual({
          origin: [264, 0],
          g: 8,
        });
        // THIN: position admits before the clearance rejection.
        expect(records.get('THIN|literal')!.certificate.reason).not.toMatch(/^position/);
        expect(failures).toEqual([]);
        expect(literalExpectationFailures).toEqual([]);
      }),
    BLOCK_TIMEOUT,
  );

  it(
    'N03 origin sequences re-derive the required O-P1 origins and admit at every step',
    () =>
      timed('n03', () => {
        for (const sequence of originSequences()) {
          let previous: ProjectionPoint | undefined;
          sequence.rows.forEach((row, index) => {
            const origin = originP1(row.input.camera, previous);
            expect(origin, row.id).toEqual([sequence.origins[index], 0]);
            previous = origin;
            const record = evaluateRow(row.id, 'O-P1', row.input, origin, { allVertices: true });
            checkExpectation(row, record, literalExpectationFailures);
          });
        }
        expect(failures).toEqual([]);
        expect(literalExpectationFailures).toEqual([]);
      }),
    BLOCK_TIMEOUT,
  );

  it(
    'records Gamma9 sensitivity and the exact N02 evaluation counts',
    () => {
      const fixtureAxes = [...records.values()].filter(
        (record) => record.policy !== 'literal' && !record.id.match(/^[A-Z]/),
      );
      for (const record of fixtureAxes) expect(record.n02.vertexAxes, record.id).toHaveLength(2);
      for (const record of records.values())
        expect(record.n02.evaluations).toBe(
          EVALUATIONS_PER_VERTEX_AXIS * record.n02.vertexAxes.length,
        );
      expect(totalEvaluations).toBe(EVALUATIONS_PER_VERTEX_AXIS * totalVertexAxes);
      const ext = records.get('EXT-32768|literal')!;
      expect(ext.certificate.status).toBe('ADMITTED');
      expect(ext.gamma9.reason).toBe('position:0');
      const flips = [...records.values()].filter(
        (record) => (record.gamma9.reason ?? null) !== (record.certificate.reason ?? null),
      );
      expect(flips.map((record) => record.id)).toEqual(['EXT-32768']);
    },
    BLOCK_TIMEOUT,
  );

  it(
    'unit control: gamma 0 breaks L or N02 dominance on named rows; packZero changes E',
    () =>
      timed('control-gamma', () => {
        const broken: Record<'lChrome' | 'lEdge' | 'n02', string[]> = {
          lChrome: [],
          lEdge: [],
          n02: [],
        };
        fixtures.forEach((fixture, index) => {
          const { input } = fixture;
          const zero = certifyPosition(input, input.origin, { gamma: ZERO });
          if (zero.ex.every((value) => value === null)) return;
          const R = references(input);
          const exceeds = (actual: readonly (readonly [Rational, Rational])[]) =>
            referenced(input).some((vertex) =>
              ([0, 1] as const).some(
                (axis) =>
                  compare(
                    absolute(sub(actual[vertex]![axis], R[vertex]![axis])),
                    (axis === 0 ? zero.ex : zero.ey)[vertex]!,
                  ) > 0,
              ),
            );
          if (exceeds(nativeRecovered(input, captures.chrome[index]!)))
            broken.lChrome.push(fixture.id);
          if (exceeds(nativeRecovered(input, captures.edge[index]!))) broken.lEdge.push(fixture.id);
          const record = records.get(`${fixture.id}|fixture`)!;
          if (
            record.n02.vertexAxes.some(
              ([vertex, axis], position) =>
                compare(record.n02.maxAbs[position]!, (axis === 0 ? zero.ex : zero.ey)[vertex]!) >
                0,
            )
          )
            broken.n02.push(fixture.id);
        });
        console.log(
          `P3.1m gamma-0 dominance failures: L-Chrome ${broken.lChrome.length}, L-Edge ${broken.lEdge.length}, N02 ${broken.n02.length}; first: ${[...broken.lChrome, ...broken.n02].slice(0, 3).join(', ')}`,
        );
        expect(broken.lChrome.length + broken.lEdge.length + broken.n02.length).toBeGreaterThan(0);
        gammaZeroFailures = broken;

        const pack = termRows().find((row) => row.id === 'PACK-R15')!;
        const normal = certifyPosition(pack.input, pack.origin);
        const zeroPack = certifyPosition(pack.input, pack.origin, { packZero: true });
        expect(
          referenced(pack.input).some(
            (vertex) =>
              compare(normal.ex[vertex]!, zeroPack.ex[vertex]!) !== 0 ||
              compare(normal.ey[vertex]!, zeroPack.ey[vertex]!) !== 0,
          ),
        ).toBe(true);
      }),
    BLOCK_TIMEOUT,
  );

  it(
    'unit control: independent clearance summaries match N01 and mutated summaries change outcomes',
    () =>
      timed('control-clearance', () => {
        const meshes = new Map<ProjectionInput['mesh'], string>();
        for (const record of records.values()) meshes.set(record.input.mesh, record.id);
        const keys = ['dV2', 'dE2', 'rhoBar', 'kappaBar', 'lambdaBar', 'plo'] as const;
        for (const [mesh, id] of meshes) {
          const mine = independentClearanceSummary(mesh);
          const theirs = clearanceSummary(mesh);
          for (const key of keys) {
            const left = mine[key];
            const right = theirs[key];
            if (left === null || right === null) expect(left, `${id}:${key}`).toBe(right);
            else expect(compare(left, right), `${id}:${key}`).toBe(0);
          }
          expect(mine.overlappingFan, `${id}:overlappingFan`).toBe(theirs.overlappingFan);
        }
        for (const record of records.values()) {
          const { certificate } = record;
          if (certificate.reason === 'lane-range' || certificate.reason === 'singular') continue;
          const outcome = independentClearance(
            record.input,
            independentClearanceSummary(record.input.mesh),
            certificate.delta2Max,
          );
          expect(outcome, `${record.id}|${record.policy}`).toEqual(certificate.clearance);
        }
        const thin = records.get('THIN|literal')!;
        const thinSummary = independentClearanceSummary(thin.input.mesh);
        expect(independentClearance(thin.input, thinSummary, thin.certificate.delta2Max).term).toBe(
          'vertex',
        );
        const mutatedThin = independentClearance(
          thin.input,
          { ...thinSummary, dV2: ONE },
          thin.certificate.delta2Max,
        );
        expect(mutatedThin.term).not.toBe('vertex');
        const rectangle = records.get('EXT-4096|literal')!;
        const rectangleSummary = independentClearanceSummary(rectangle.input.mesh);
        expect(rectangle.certificate.clearance.term).toBeNull();
        expect(
          independentClearance(
            rectangle.input,
            { ...rectangleSummary, rhoBar: ZERO },
            rectangle.certificate.delta2Max,
          ).term,
        ).toBe('triangle');
        expect(
          independentClearance(
            rectangle.input,
            { ...rectangleSummary, dV2: ZERO },
            rectangle.certificate.delta2Max,
          ).term,
        ).toBe('vertex');
      }),
    BLOCK_TIMEOUT,
  );

  it(
    'unit control: upward square-root bounds dominate the exact root',
    () => {
      const values = [
        rational(2n),
        rational(1n, 3n),
        pow2(-200),
        rational(10n ** 40n + 7n, 3n),
        ...[...records.values()].map((record) => record.certificate.delta2Max),
      ];
      for (const value of values)
        for (const root of [sqrtUp(value), sqrtUpIndependent(value)]) {
          expect(compare(mul(root, root), value)).toBeGreaterThanOrEqual(0);
          expect(root.d <= 1n << 64n).toBe(true);
          // Tight: one step of 2^-64 lower is below the root.
          const lower = sub(root, pow2(-64));
          if (compare(lower, ZERO) > 0) expect(compare(mul(lower, lower), value)).toBeLessThan(0);
        }
      expect(compare(sqrtUp(rational(4n)), TWO)).toBe(0);
    },
    BLOCK_TIMEOUT,
  );

  it(
    "unit control: N02 and N01 do not import each other; N02 reproduces K's RNE graph",
    () => {
      const imports = (file: string) =>
        [...readFileSync(path.resolve(file), 'utf8').matchAll(/from\s+'([^']+)'/g)].map(
          (match) => match[1]!,
        );
      const adversarial = imports('tests/geometry/position-certificate/adversarial.ts');
      const certificate = imports('tests/geometry/position-certificate/certificate.ts');
      expect(adversarial.some((source) => source.includes('certificate'))).toBe(false);
      expect(certificate.some((source) => source.includes('adversarial'))).toBe(false);
      expect(
        adversarial.every((source) =>
          ['../mesh-projection/model.js', '../rounded-fill/exact.js'].includes(source),
        ),
      ).toBe(true);
      for (const fixture of fixtures.slice(0, 20)) {
        const observation = simulateMeshProjection(fixture.input);
        if (!observation.ok) throw new Error(fixture.id);
        for (const axis of [0, 1] as const) {
          const roots = new Set<number>();
          adversarialDisplacement(fixture.input, fixture.input.origin, 0, axis, (root) =>
            roots.add(root),
          );
          expect(roots.has(observation.ndc[0]![axis]), `${fixture.id}:${axis}`).toBe(true);
        }
      }
    },
    BLOCK_TIMEOUT,
  );

  it(
    'regenerates report.json byte for byte',
    () => {
      const report = buildReport();
      const text = `${JSON.stringify(report, null, 2)}\n`;
      console.log(`P3.1m wall time (ms, observation only): ${JSON.stringify(timings)}`);
      if (WRITE) {
        mkdirSync(path.dirname(path.resolve(REPORT_PATH)), { recursive: true });
        writeFileSync(path.resolve(REPORT_PATH), text);
        mkdirSync(path.resolve('.tools'), { recursive: true });
        writeFileSync(
          path.resolve('.tools/p3-position-certificate-wall-time.json'),
          `${JSON.stringify({ timings }, null, 2)}\n`,
        );
      }
      expect(readFileSync(path.resolve(REPORT_PATH), 'utf8')).toBe(text);
    },
    BLOCK_TIMEOUT,
  );
});

let gammaZeroFailures: Record<string, string[]> = {};

function buildReport(): unknown {
  const rows = [...records.values()].map((record) => {
    const { certificate } = record;
    return {
      id: record.id,
      policy: record.policy,
      origin: [...record.origin],
      g: record.g,
      status: certificate.status,
      reason: certificate.reason,
      worstVertex: certificate.worstVertex,
      delta2Max: exact(certificate.delta2Max),
      delta2MaxApprox: approx(certificate.delta2Max),
      window:
        record.window === null
          ? null
          : {
              halfWidth: record.window.halfWidth,
              admitted: record.window.admitted,
              maxE2Approx: approx(record.window.maxE2),
              camerasChecked: record.window.cameras,
              camerasOutsideDomain: record.window.skipped,
            },
      clearance: { term: certificate.clearance.term, collinear: certificate.clearance.collinear },
      maxDisplacement: {
        k: approx(record.displacement.k),
        lChrome: approx(record.displacement.lChrome),
        lEdge: approx(record.displacement.lEdge),
        n02: approx(record.displacement.n02),
      },
      n02: {
        vertexAxes: record.n02.vertexAxes.map(([vertex, axis]) => [vertex, axis]),
        evaluations: record.n02.evaluations,
      },
      gamma9: {
        status: record.gamma9.status,
        reason: record.gamma9.reason,
        delta2MaxApprox: approx(record.gamma9.delta2Max),
      },
    };
  });
  const admitted = rows
    .filter((row) => row.status === 'ADMITTED')
    .map((row) => `${row.id}|${row.policy}`);
  const gamma9Changes = rows
    .filter((row) => row.status !== row.gamma9.status || row.reason !== row.gamma9.reason)
    .map((row) => ({
      id: row.id,
      policy: row.policy,
      gamma8: row.reason ?? 'ADMITTED',
      gamma9: row.gamma9.reason ?? 'ADMITTED',
    }));
  return {
    schema: 'p3-position-certificate-report-v1',
    contract: 'docs/plans/p3-position-certificate-contract.md',
    sourceHashes: Object.fromEntries(
      SOURCES.map((file) => [file, sha256(readFileSync(path.resolve(file)))]),
    ),
    archives: {
      k: { path: K_ARCHIVE.path, sha256: K_ARCHIVE.sha256 },
      lChrome: { path: L_CAPTURES.chrome.path, sha256: L_CAPTURES.chrome.sha256 },
      lEdge: { path: L_CAPTURES.edge.path, sha256: L_CAPTURES.edge.sha256 },
    },
    gamma: { gamma8: exact(gammaOf(8)), gamma9: exact(GAMMA9) },
    n02: {
      evaluationsPerVertexAxis: EVALUATIONS_PER_VERTEX_AXIS,
      vertexAxes: totalVertexAxes,
      evaluations: totalEvaluations,
    },
    counts: {
      rows: rows.length,
      admitted: admitted.length,
      byReason: Object.fromEntries(
        [...new Set(rows.map((row) => `${row.policy}:${row.reason ?? 'ADMITTED'}`))]
          .sort()
          .map((key) => [
            key,
            rows.filter((row) => `${row.policy}:${row.reason ?? 'ADMITTED'}` === key).length,
          ]),
      ),
    },
    admittedRows: admitted,
    gamma9Sensitivity: gamma9Changes,
    controls: { gammaZeroDominanceFailures: gammaZeroFailures },
    wallTime:
      'observation only; printed by the test and written to .tools, excluded for determinism',
    rows,
  };
}
