// D9 E3 unit E3-U1: tests of the A04 corpus generator `a04-corpus/v1`
// (docs/plans/d9-e3-b4-precision-contract.md sections 5.1 and 13.9). No kernel, port or renderer
// is loaded: no kernel runs on the corpus before the freeze (section 5.5).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { STROKE_S2_FAMILIES } from '../../packages/geometry-reference/src/stroke-region.js';
import { fixedNativeDepthPositiveCubicFixtureRows } from './native-depth-positive-cubic/fixtures.js';
import { ob5DecisionCells, ob5ObservationCells } from './p3-al-ob5/corpus.js';
import { generateCellPaths } from './p3-b0/corpus.js';
import { cubicCases, lineCases } from './stroke-oracle/fixtures.js';
import {
  A04_CORPUS_VERSION,
  A04_SEEDS,
  CHEVRON_HEX,
  DEPTH_POSITIVE_HEX,
  F01_HEX,
  F06_HEX,
  F08_HEX,
  J05_HEX,
  OB5_HEX,
  TRANSFORM_HEX,
  drawGeneratedRows,
  dyadic,
  edgeScale,
  hex,
  pow2,
  roundRational,
  summarizeA04Corpus,
  unhex,
  type CanonicalCase,
} from './e3-a04/corpus.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const generatorPath = path.join(root, 'tests/geometry/e3-a04/corpus.ts');
const manifestPath = path.join(root, 'tests/geometry/e3-a04/corpus-v1.manifest.json');

type Manifest = Readonly<{
  version: string;
  generator: Readonly<{ path: string; sha256: string }>;
  seeds: Readonly<Record<string, number>>;
  counts: Readonly<Record<string, number>>;
  cases: number;
  bytes: number;
  corpusSha256: string;
  nodeVersion: string;
}>;

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

type Case = Readonly<{
  camera: { c: [string, string]; dpr: string; zoom: string };
  corpus: string;
  duplicateOf: string | null;
  gap: { local: string; m: number; phys: [string, string]; target: string } | null;
  id: string;
  index: number;
  joint: { group: string; role: string } | null;
  opacity: string;
  paint: Record<string, string>;
  partial: { extent: string; scaleExponent: number } | null;
  path: { points: string[]; verbs: string };
  placement: string;
  row: string;
  servedOffset: number;
  sizeClass: string | null;
  source: string;
  stratum: string;
  transform: string;
  viewport: [number, number];
  world: { l: [string, string, string, string]; t: [string, string] };
}>;

const KEYS = [
  'camera',
  'corpus',
  'duplicateOf',
  'gap',
  'id',
  'index',
  'joint',
  'opacity',
  'paint',
  'partial',
  'path',
  'placement',
  'row',
  'servedOffset',
  'sizeClass',
  'source',
  'stratum',
  'transform',
  'viewport',
  'world',
];

let summary: ReturnType<typeof summarizeA04Corpus>;
const cases: Case[] = [];

beforeAll(() => {
  summary = summarizeA04Corpus((value: CanonicalCase) => cases.push(value as unknown as Case));
});

// ---------------------------------------------------------------------------------------------
// Exact BigInt sine and cosine of a binary64 argument, correctly rounded (E3-N10). Taylor series
// in fixed point with 2^-320 units and a generous error bound; a value is accepted only when both
// ends of its enclosure round to the same binary64. No math library is used.

const P = 320n;

function sinCosFixed(x: number): { sin: bigint; cos: bigint; err: bigint } {
  if (!(Math.abs(x) < 8)) throw new Error('argument out of range');
  const { n, e } = dyadic(x);
  if (-e > Number(P)) throw new Error('argument too fine');
  const X = e >= 0 ? (n << BigInt(e)) << P : (n << P) >> BigInt(-e); // exact
  const X2 = (X * X) >> P;
  let sin = 0n;
  let cos = 0n;
  let ts = X;
  let tc = 1n << P;
  let k = 0n;
  while (ts !== 0n || tc !== 0n) {
    sin += ts;
    cos += tc;
    ts = -((ts * X2) >> P) / ((2n * k + 2n) * (2n * k + 3n));
    tc = -((tc * X2) >> P) / ((2n * k + 1n) * (2n * k + 2n));
    k += 1n;
    if (k > 400n) throw new Error('series did not converge');
  }
  // Each term carries a few units of truncation, amplified by at most |x|²/((2k+2)(2k+3)) < 11
  // per step over the first steps; 2^(k + 16) units bounds the total far above that.
  return { sin, cos, err: 1n << (k + 16n) };
}

function roundFixed(value: bigint, err: bigint): number {
  const den = 1n << P;
  const lo = roundRational(value - err, den, 'RN');
  const hi = roundRational(value + err, den, 'RN');
  if (lo !== hi) throw new Error('correct rounding not decided');
  return lo;
}

function rnSin(x: number): number {
  if (x === 0) return 0;
  const f = sinCosFixed(x);
  return roundFixed(f.sin, f.err);
}

function rnCos(x: number): number {
  if (x === 0) return 1;
  const f = sinCosFixed(x);
  return roundFixed(f.cos, f.err);
}

function hexList(text: string): number[] {
  return text.split(' ').map(unhex);
}

describe('E3-U1 a04-corpus/v1 regeneration (E3-A1)', () => {
  it('regenerates the manifest corpusSha256, counts and generator SHA-256', () => {
    const generatorSha = createHash('sha256').update(readFileSync(generatorPath)).digest('hex');
    expect(manifest.version).toBe(A04_CORPUS_VERSION);
    expect(manifest.generator.sha256).toBe(generatorSha);
    expect(manifest.seeds).toEqual({ ...A04_SEEDS });
    expect(summary.cases).toBe(manifest.cases);
    expect(summary.cases).toBe(27_462);
    expect(summary.counts).toEqual(manifest.counts);
    expect(summary.bytes).toBe(manifest.bytes);
    expect(summary.corpusSha256).toBe(manifest.corpusSha256);
  });

  it('has the annex totals per stratum (13.8)', () => {
    expect(summary.counts).toEqual({
      C1: 40 * 72 + 200 * 9,
      C2: 200 * 9,
      C3: 30 * 72 + 300 * 9,
      C4: 24 * 72,
      C5: 79 * 72 + 150 * 9,
      C6: 12 * 3 * 9,
      C7: 12 * 9,
      C8: 149 * 2 * 9,
      C9: 30 * 72 + 150 * 9,
      C10: 12,
      C11: 8 * 72,
      C12: 8 * 2 * 9,
    });
  });

  it('follows the schema, generation order and id format (13.2)', () => {
    const ids = new Set<string>();
    const order = ['C1', 'C2', 'C3', 'C4', 'C5', 'C9', 'C10', 'C11', 'C12', 'C6', 'C7', 'C8'];
    let stratumPosition = 0;
    cases.forEach((value, index) => {
      expect(Object.keys(value).sort()).toEqual(KEYS);
      expect(value.index).toBe(index);
      expect(value.corpus).toBe(A04_CORPUS_VERSION);
      expect(value.viewport).toEqual([640, 360]);
      const position = order.indexOf(value.stratum);
      expect(position).toBeGreaterThanOrEqual(stratumPosition);
      stratumPosition = position;
      const zoom = unhex(value.camera.zoom);
      const dpr = unhex(value.camera.dpr);
      const zoomLabel = zoom === 0.01 ? '0.01' : String(zoom);
      expect(value.id).toBe(
        `${value.stratum}/${value.row}/${value.transform}/z${zoomLabel}-d${String(dpr)}/${value.placement}/k${String(value.servedOffset)}`,
      );
      expect(ids.has(value.id)).toBe(false);
      ids.add(value.id);
      expect(value.path.points.length).toBe(
        2 *
          [...value.path.verbs].reduce(
            (sum, verb) => sum + ({ M: 1, L: 1, C: 3, Z: 0 }[verb] ?? NaN),
            0,
          ),
      );
      for (const bits of value.path.points) expect(bits).toMatch(/^[0-9a-f]{16}$/u);
      expect(value.servedOffset === 0 || value.stratum === 'C8').toBe(true);
      if (value.stratum === 'C8') expect([1, 2]).toContain(value.servedOffset);
    });
    for (const value of cases)
      if (value.duplicateOf !== null) expect(ids.has(value.duplicateOf)).toBe(true);
  });
});

describe('E3-U1 literal tables (E3-N10): exact BigInt re-derivation', () => {
  it('T1 and T2 are RN(cos x), RN(sin x) at the stated binary64 arguments; T5 and T6 follow', () => {
    for (const [id, x] of [
      ['T1', Math.PI / 6],
      ['T2', (37.21 * Math.PI) / 180],
    ] as const) {
      expect(x).toBe(id === 'T1' ? 0.5235987755982988 : 0.64943701466709);
      const c = rnCos(x);
      const s = rnSin(x);
      expect(TRANSFORM_HEX[id]).toEqual([hex(c), hex(-s), hex(s), hex(c)]);
    }
    expect(unhex(TRANSFORM_HEX.T1[2])).toBe(0.49999999999999994);
    const [a, b, c, d] = TRANSFORM_HEX.T2.map(unhex) as [number, number, number, number];
    expect(TRANSFORM_HEX.T5).toEqual([hex(-a), hex(-b), hex(c), hex(d)]);
    // T6 = (T2·T3)·T4, binary64 left to right.
    const t3 = [2.5, 0, 0, 0.375];
    const t4 = [1, 0.5, 0, 1];
    const mul = (p: readonly number[], q: readonly number[]) => [
      p[0]! * q[0]! + p[1]! * q[2]!,
      p[0]! * q[1]! + p[1]! * q[3]!,
      p[2]! * q[0]! + p[3]! * q[2]!,
      p[2]! * q[1]! + p[3]! * q[3]!,
    ];
    expect(TRANSFORM_HEX.T6).toEqual(mul(mul([a, b, c, d], t3), t4).map(hex));
    expect(TRANSFORM_HEX.T0.map(unhex)).toEqual([1, 0, 0, 1]);
    expect(TRANSFORM_HEX.T3.map(unhex)).toEqual([2.5, 0, 0, 0.375]);
    expect(TRANSFORM_HEX.T4.map(unhex)).toEqual([1, 0.5, 0, 1]);
    expect(TRANSFORM_HEX.T7.map(unhex)).toEqual([1, 0, 0, pow2(-12)]);
  });

  it('chevron arms are len·RN(sin), len·RN(cos) at (h * Math.PI) / 180', () => {
    const keys = Object.keys(CHEVRON_HEX);
    expect(keys.sort()).toEqual(
      ['6/60', '3/60', '1/60', '14/60', '14.4775/60', '15/60', '45/52', '30/52', '15/52'].sort(),
    );
    for (const key of keys) {
      const [h, length] = key.split('/').map(Number) as [number, number];
      const radians = (h * Math.PI) / 180;
      expect(CHEVRON_HEX[key]).toEqual([
        hex(length * rnSin(radians)),
        hex(length * rnCos(radians)),
      ]);
    }
  });

  it('f01, f06, f08 and j05 re-derive exactly, with rounding to integers clear of ties', () => {
    const roundClear = (value: number) => {
      const fraction = value - Math.floor(value);
      expect(Math.abs(fraction - 0.5)).toBeGreaterThan(1e-3);
      return Math.round(value);
    };
    const f01: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t = (2 * Math.PI * i) / 200;
      f01.push(roundClear(1024 * rnCos(t)), roundClear(1024 * rnSin(t)));
    }
    expect(hexList(F01_HEX)).toEqual(f01);
    for (const [table, count, degrees] of [
      [F06_HEX, 5, 72],
      [F08_HEX, 6, 60],
    ] as const) {
      const values: number[] = [];
      for (let k = 0; k < count; k += 1) {
        const t = (degrees * k * Math.PI) / 180;
        const c = rnCos(t);
        const s = rnSin(t);
        for (const [x, y] of [
          [8, -2],
          [8, 2],
        ])
          values.push(roundClear(x! * c - y! * s), roundClear(x! * s + y! * c));
      }
      expect(hexList(table)).toEqual(values);
    }
    const j05: number[] = [];
    for (const r of [16, 9.7])
      for (let i = 0; i < 32; i += 1) {
        const t = (2 * Math.PI * i) / 32;
        j05.push(r * rnCos(t), r * rnSin(t));
      }
    expect(hexList(J05_HEX).map(hex)).toEqual(j05.map(hex));
  });
});

function verbsOf(codes: readonly number[]): string {
  return codes.map((code) => ['M', 'L', 'C', 'Z'][code]!).join('');
}

function byRow(stratum: string, row: string): Case {
  const value = cases.find((c) => c.stratum === stratum && c.row === row && c.transform === 'T0');
  if (value === undefined) throw new Error(`no case ${stratum}/${row}`);
  return value;
}

describe('E3-U1 source checks (13.4)', () => {
  it('c14 to c19 and f02 equal generateCellPaths of the AL-OB5 cells', () => {
    const [w2, w4, w8] = ob5DecisionCells() as [never, never, never];
    const [w8u] = ob5ObservationCells() as [never];
    const cells: Record<string, Parameters<typeof generateCellPaths>[0]> = {
      'OB5-W2': w2,
      'OB5-W4': w4,
      'OB5-W8': w8,
      'OB5-W2U': { ...(w2 as object), snapped: false } as never,
      'OB5-W4U': { ...(w4 as object), snapped: false } as never,
      'OB5-W8U': w8u,
    };
    const rows = ['OB5-W2', 'OB5-W4', 'OB5-W8', 'OB5-W2U', 'OB5-W4U', 'OB5-W8U'];
    rows.forEach((id, index) => {
      const expected = generateCellPaths(cells[id]!, 1)[0]!;
      expect(OB5_HEX[`${id}/path0`]).toBe(expected.points.map(hex).join(' '));
      const value = byRow('C3', `c${String(14 + index)}`);
      expect(value.path.verbs).toBe(verbsOf(expected.verbs));
      expect(value.path.points).toEqual(expected.points.map(hex));
      expect(value.source).toBe(`AL-OB5/${id}/path0`);
    });
    const path1 = generateCellPaths(cells['OB5-W8']!, 2)[1]!;
    expect(OB5_HEX['OB5-W8/path1']).toBe(path1.points.map(hex).join(' '));
    expect(byRow('C11', 'f02').path.points).toEqual(path1.points.map(hex));
  });

  it('c20 to c23 equal the depth-positive fixture contours', () => {
    const rows = fixedNativeDepthPositiveCubicFixtureRows();
    expect(rows.map((row) => `${row.id}/${row.rule}`)).toEqual([
      'depth-positive/star/nonzero',
      'depth-positive/star/evenodd',
      'depth-positive/zero-closure/nonzero',
      'depth-positive/zero-closure/evenodd',
    ]);
    rows.forEach((fixture, index) => {
      let verbs = '';
      const points: number[] = [];
      for (const contour of fixture.contours) {
        verbs += 'M';
        points.push(...contour.cubics[0]![0]);
        for (const cubic of contour.cubics) {
          verbs += 'C';
          points.push(...cubic[1], ...cubic[2], ...cubic[3]);
        }
        if (contour.closeVerbOrdinal !== null) verbs += 'Z';
      }
      expect(DEPTH_POSITIVE_HEX[fixture.id]).toBe(`${verbs}|${points.map(hex).join(' ')}`);
      const value = byRow('C3', `c${String(20 + index)}`);
      expect(value.source).toBe(fixture.id);
      expect(value.paint).toEqual({ kind: 'fill', rule: fixture.rule });
      expect(value.path.verbs).toBe(verbs);
      expect(value.path.points).toEqual(points.map(hex));
    });
  });

  it('C5 and C9 rows equal the stroke-oracle fixtures they name', () => {
    const fixtures = new Map([...lineCases(), ...cubicCases()].map((c) => [c.name, c]));
    let checked = 0;
    for (const stratum of ['C5', 'C9'])
      for (const value of cases.filter(
        (c) =>
          c.stratum === stratum &&
          c.transform === 'T0' &&
          c.camera.zoom === hex(1) &&
          c.camera.dpr === hex(1) &&
          !c.row.startsWith('g'),
      )) {
        const fixture = fixtures.get(value.source);
        if (fixture === undefined) continue;
        checked += 1;
        expect(value.path.verbs).toBe(verbsOf(fixture.verbs));
        expect(value.path.points).toEqual(fixture.points.map(hex));
        expect(value.paint).toEqual({
          cap: fixture.cap,
          join: fixture.join,
          kind: 'stroke',
          miterLimit: hex(fixture.miterLimit),
          width: hex(fixture.width),
        });
      }
    // C5: 37 fixture-named rows (ST-F1 to ST-F12 variants, ST-F13, ST-F14a/b, ST-F21, ST-F24 ×2,
    // ST-F25 ×12, ST-U4/tip-ratio); C9: ST-F16, ST-F20 ×9, ST-U4/folded-arc.
    expect(checked).toBe(48);
    STROKE_S2_FAMILIES.forEach((family, index) => {
      const value = byRow('C9', `k0${String(index + 1)}`);
      expect(value.source).toBe(`ST-F15/${family.name}`);
      expect(value.path.points).toEqual(family.controls.flat().map(hex));
      expect(value.paint.width).toBe(hex(family.width));
    });
  });

  it('l76 to l79 match the Rust source spans at 5c691ad (SHA-256) and their literals', () => {
    const commit = '5c691ada9eb58be3d994fb82a4a1dd28f6602a58';
    const file = 'packages/geometry-wasm/kernel/src/stroke_outline_tests.rs';
    const show = () =>
      execFileSync('git', ['show', `${commit}:${file}`], { cwd: root, encoding: 'utf8' });
    let blob: string;
    try {
      blob = show();
    } catch {
      // A shallow CI checkout lacks the commit: fetch exactly that commit, then read the blob.
      execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', commit], { cwd: root });
      blob = show();
    }
    const lines = blob.split('\n');
    const span = (first: number, last: number) =>
      lines
        .slice(first - 1, last)
        .map((line) => `${line}\n`)
        .join('');
    const spans = [
      ['l76', 728, 739, 'd69b3811ec71f4d5e82fbc5788b11a872cd0b89ddd5bc6cd7c4f1eafe2bb8fdc'],
      ['l78-l79', 1752, 1776, '26fb12cd9d5c027f22d05dbb09eabe8051642b7e15da03bcaf8ac65a12471dde'],
      ['l77', 1890, 1901, '97844117e971f7683235531d54617d67d74079e31873ee14f68ad1ded9673dd8'],
    ] as const;
    for (const [, first, last, sha] of spans)
      expect(createHash('sha256').update(span(first, last)).digest('hex')).toBe(sha);
    const rust = (literal: string) => Number(literal.replaceAll('_', ''));
    // l77: the chevron path, w = 12, round caps and joins.
    const l77 = byRow('C5', 'l77');
    const l77Literals = [
      '-4.401_143_883_191_439',
      '1_051.984_338_572_202_7',
      '-3.125',
      '1000.0',
      '-1.848_856_116_808_561',
      '1_051.984_338_572_202_7',
    ];
    expect(span(1891, 1893).replace(/\s+/gu, '')).toBe(
      `.m(${l77Literals[0]!},${l77Literals[1]!}).l(${l77Literals[2]!},${l77Literals[3]!}).l(${l77Literals[4]!},${l77Literals[5]!});`,
    );
    expect(l77.path.points.map(unhex)).toEqual(l77Literals.map(rust));
    expect(span(1901, 1901)).toContain(
      'request(12.0, StrokeCap::Round, StrokeJoin::Round, 4.0, exponent)',
    );
    expect(l77.paint).toEqual({
      cap: 'round',
      join: 'round',
      kind: 'stroke',
      miterLimit: hex(4),
      width: hex(12),
    });
    // l78 and l79: M(0,0) L(b) L(c), w = 12, butt, round join.
    expect(span(1755, 1755)).toContain('("3-1", [3.0, 1.0], [-1.0, -0.333_333_333_333_333_26])');
    expect(span(1758, 1759).replace(/\s+/gu, '')).toBe(
      '[1.0,7.0],[-0.333_333_333_333_333_26,-2.333_333_333_333_332],',
    );
    expect(span(1766, 1766)).toContain('request(12.0, BUTT, StrokeJoin::Round, 4.0, -3)');
    expect(byRow('C5', 'l78').path.points.map(unhex)).toEqual([
      0,
      0,
      3,
      1,
      -1,
      rust('-0.333_333_333_333_333_26'),
    ]);
    expect(byRow('C5', 'l79').path.points.map(unhex)).toEqual([
      0,
      0,
      1,
      7,
      rust('-0.333_333_333_333_333_26'),
      rust('-2.333_333_333_333_332'),
    ]);
    for (const row of ['l78', 'l79'])
      expect(byRow('C5', row).paint).toEqual({
        cap: 'butt',
        join: 'round',
        kind: 'stroke',
        miterLimit: hex(4),
        width: hex(12),
      });
    // l76: 64 subpaths M(0, 4i) L(4, 4i), w = 2, square caps, miter 4.
    expect(span(730, 733)).toContain('let y = f64::from(row) * 4.0;');
    expect(span(737, 737)).toContain('request(2.0, StrokeCap::Square, MITER, 4.0, -3)');
    const l76 = byRow('C5', 'l76');
    expect(l76.path.verbs).toBe('ML'.repeat(64));
    const expected: number[] = [];
    for (let i = 0; i < 64; i += 1) expected.push(0, 4 * i, 4, 4 * i);
    expect(l76.path.points.map(unhex)).toEqual(expected);
    expect(l76.paint).toEqual({
      cap: 'square',
      join: 'miter',
      kind: 'stroke',
      miterLimit: hex(4),
      width: hex(2),
    });
    // Non-failing drift report against HEAD for the manual freeze step (13.4).
    const head = readFileSync(path.join(root, file), 'utf8');
    for (const [rows, first, last] of spans) {
      const text = span(first, last);
      const at = head.indexOf(text);
      console.log(
        at >= 0
          ? `E3-U1 span drift report: ${rows} unchanged in HEAD at line ${String(head.slice(0, at).split('\n').length)}`
          : `E3-U1 span drift report: ${rows} DIFFERS in HEAD; locate by function name and review before the freeze`,
      );
    }
  });
});

describe('E3-U1 construction checks', () => {
  it('partial placements exceed the longer side of Ω after an exact power-of-two rescale', () => {
    const partial = cases.filter((c) => c.placement === 'partial');
    expect(partial.length).toBe(12 * 9);
    for (const value of partial) {
      expect(value.stratum).toBe('C6');
      const extent = unhex(value.partial!.extent);
      const dpr = unhex(value.camera.dpr);
      expect(extent).toBeGreaterThan(640 * dpr + 4);
      expect(extent).toBeGreaterThanOrEqual(4096);
      expect(extent).toBeLessThan(8192);
    }
    for (const value of cases) expect(value.partial === null).toBe(value.placement !== 'partial');
  });

  it('every generic scalar comes from a 53-bit draw (E3-N13)', () => {
    const { rows, streams } = drawGeneratedRows();
    let wide = 0;
    let total = 0;
    for (const stream of streams)
      for (const draw of stream.generic) {
        const u = (draw.hi * 2 ** 21 + (draw.lo >>> 11)) / 2 ** 53;
        expect(draw.value).toBe((2 * u - 1) * draw.scale);
        total += 1;
        const { n } = dyadic(draw.value);
        const odd = n === 0n ? 0n : n / (n & -n);
        if ((odd < 0n ? -odd : odd).toString(2).length > 32) wide += 1;
      }
    // C1 coordinates are one-draw, then snapped; only its generic translations are 53-bit draws.
    for (const draw of streams[0]!.generic) expect(draw.scale).toBe(1024);
    expect(total).toBeGreaterThan(1000);
    expect(wide / total).toBeGreaterThan(0.9);
    // Every C2, C5 and C9 anchor before rescaling is a recorded 53-bit draw (or a draw/4, the C2
    // hole of family 2). C3 controls are computed from anchors and coord/4 offsets.
    const drawn = new Set(streams.flatMap((s) => s.generic.map((d) => d.value)));
    const recorded = { has: (v: number) => drawn.has(v) || drawn.has(v * 4) };
    for (const stratum of ['C2', 'C5', 'C9'] as const)
      for (const row of rows[stratum])
        for (const contour of row.path) {
          expect(recorded.has(contour.start[0]) && recorded.has(contour.start[1])).toBe(true);
          for (const segment of contour.segments)
            expect(recorded.has(segment.p[0]) && recorded.has(segment.p[1])).toBe(true);
        }
  });

  it('C7 edge scales: s = 1 exactly at the four attainable pairs, RD below the edge elsewhere', () => {
    const attainable = new Set(['1/1', '1/2', '64/1', '64/2']);
    for (const zoom of [0.01, 1, 64])
      for (const dpr of [1, 2, 3]) {
        const edge = edgeScale(zoom, dpr);
        expect(edge.exact).toBe(attainable.has(`${String(zoom)}/${String(dpr)}`));
        expect(edge.s === 1).toBe(edge.exact);
      }
    const c7 = cases.filter((c) => c.stratum === 'C7');
    expect(c7.length).toBe(108);
    expect(c7.filter((c) => c.duplicateOf !== null).length).toBe(12 * 4);
    for (const value of c7) expect(value.transform).toBe('edge');
  });

  it('C4 gaps realize [g, 2g) on every case with g > 0', () => {
    const c4 = cases.filter((c) => c.stratum === 'C4');
    expect(c4.filter((c) => c.gap !== null).length).toBe(21 * 72);
    for (const value of c4) {
      if (value.gap === null) continue;
      const g = unhex(value.gap.target);
      expect(unhex(value.gap.local)).toBe(g * 2 ** -value.gap.m);
      expect(unhex(value.gap.phys[0])).toBeGreaterThanOrEqual(g);
      expect(unhex(value.gap.phys[0])).toBeLessThanOrEqual(unhex(value.gap.phys[1]));
      expect(unhex(value.gap.phys[1])).toBeLessThanOrEqual(2 * g);
    }
  });
});
