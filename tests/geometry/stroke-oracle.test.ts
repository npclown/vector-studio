/**
 * P3 B2 units ST-U3 and ST-U4 (`docs/plans/p3-b2-stroke-contract.md` sections 11.1 and 11.2):
 * the line and cubic fixtures through the oracle hand-off. It writes a `P3STKIN1` input, runs
 * the ignored Rust test `emit_stroke_dump` with the pinned toolchain, and checks every literal
 * expectation of the fixtures on the dumped meshes: V2's mesh checks on every `ok` (ST-O3), the
 * exact region against the ideal union where the ideal pieces are exact polygons (ST-O4), areas,
 * bounds, statuses, piece kinds, triples and named-point membership (ST-O5).
 *
 * ST-O1 to ST-O4 of the independent oracle of ST-U2
 * (`packages/geometry-reference/src/stroke-region.ts`) run on every dumped `ok` and `empty`
 * case, and ST-O1 and ST-O2 also on cubic cases whose front end completed before the
 * arrangement stopped them. Precision is UNVERIFIED against the 0.25 physical-pixel target
 * until B4.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkStrokeExactRegion,
  checkStrokeInventory,
  checkStrokePieceBounds,
  checkStrokeResolution,
  classifyStrokeSource,
  idealStrokeExactArea,
  idealStrokeVerticesBinary64,
  type Point,
  type StrokeOracleSource,
} from '../../packages/geometry-reference/src/index.js';
import { checkFillMesh, checkFillRegion } from '../support/fill-mesh-check.js';
import {
  encodeInput,
  oraclePieces,
  parseDump,
  type DumpEntry,
  type StrokeCase,
} from './stroke-oracle/dump.js';
import {
  area,
  boundaryLoops,
  CAPS,
  contains,
  cubicCases,
  D8_CASE,
  F25_LIMITS,
  F25_TURNS,
  HALF_SIXTEEN_GON,
  JOINS,
  lineCases,
  QUARTER_SIXTEEN_GON,
  SIXTEEN_GON,
  twiceArea,
} from './stroke-oracle/fixtures.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const CLOSE = 1e-12;

function runDump(input: string, dump: string): void {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const result = spawnSync(
    rustup,
    [
      'run',
      '1.94.1',
      'cargo',
      'test',
      '--release',
      '--manifest-path',
      manifest,
      '--locked',
      '--offline',
      '--lib',
      'stroke_dump_tests::emit_stroke_dump',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_STROKE_INPUT: input, P3_STROKE_DUMP: dump },
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

const rectangle = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Every coordinate an integer and every drawing segment horizontal or vertical. */
function axisAligned(source: StrokeCase): boolean {
  if (!source.points.every((value) => Number.isInteger(value))) return false;
  let scalar = 0;
  let current: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  for (const verb of source.verbs) {
    if (verb === 3) {
      if (current[0] !== start[0] && current[1] !== start[1]) return false;
      current = start;
      continue;
    }
    // A CUBIC verb consumes 6 scalars; it is axis-aligned only when its control points and end
    // all lie on the axis line through the current point.
    if (verb === 2) {
      const [x1, y1, x2, y2, x3, y3] = [0, 1, 2, 3, 4, 5].map((k) => source.points[scalar + k]!);
      scalar += 6;
      const sameX = x1 === current[0] && x2 === current[0] && x3 === current[0];
      const sameY = y1 === current[1] && y2 === current[1] && y3 === current[1];
      if (!sameX && !sameY) return false;
      current = [x3!, y3!];
      continue;
    }
    const next: [number, number] = [source.points[scalar]!, source.points[scalar + 1]!];
    scalar += 2;
    if (verb === 0) start = next;
    else if (next[0] !== current[0] && next[1] !== current[1]) return false;
    current = next;
  }
  return true;
}

let directory = '';
let entries = new Map<string, DumpEntry>();

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'p3-stroke-oracle-'));
  const input = path.join(directory, 'input.txt');
  const dump = path.join(directory, 'dump.txt');
  writeFileSync(input, encodeInput([...lineCases(), ...cubicCases()]));
  runDump(input, dump);
  entries = new Map(parseDump(readFileSync(dump, 'utf8')).map((entry) => [entry.name, entry]));
}, 900_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function entry(name: string): DumpEntry {
  const found = entries.get(name);
  if (!found) throw new Error(`missing dump case ${name}`);
  return found;
}

function okMesh(name: string) {
  const found = entry(name);
  expect(found.status, name).toBe('ok');
  if (!found.mesh) throw new Error(`${name} has no mesh`);
  return found.mesh;
}

function expectArea(name: string, expected: number): void {
  expect(Math.abs(area(okMesh(name)) - expected), name).toBeLessThanOrEqual(CLOSE);
}

function expectRegion(name: string, contours: Point[][], expected: number): void {
  expect(checkFillRegion(okMesh(name), contours, 'nonzero', expected), name).toEqual([]);
}

function kinds(name: string): string[] {
  return entry(name).pieces.map((piece) => piece.kind);
}

describe('ST-U3 line strokes through the dump hand-off', () => {
  it('dumps every case and every ok mesh passes the V2 mesh checks (ST-O3)', () => {
    expect(entries.size).toBe(lineCases().length + cubicCases().length);
    for (const found of entries.values()) {
      expect(found.status, found.name).not.toBe('internal-error');
      if (found.status === 'ok') expect(checkFillMesh(found.mesh!), found.name).toEqual([]);
    }
  });

  it("ST-O1 to ST-O4 of ST-U2's independent oracle on every dumped case", () => {
    const failures: string[] = [];
    let exactRegions = 0;
    let checked = 0;
    for (const source of lineCases()) {
      const found = entry(source.name);
      if (found.status !== 'ok' && found.status !== 'empty') continue;
      checked += 1;
      const oracleSource: StrokeOracleSource = {
        verbs: source.verbs,
        points: source.points,
        width: source.width,
        cap: source.cap,
        join: source.join,
        miterLimit: source.miterLimit,
        toleranceExponent: source.exponent,
      };
      const pieces = oraclePieces(found, source);
      const report = (oracle: string, result: { ok: boolean; findings: readonly string[] }) => {
        if (!result.ok) failures.push(`${source.name} ${oracle}: ${result.findings.join('; ')}`);
      };
      report('ST-O1', checkStrokePieceBounds(oracleSource, pieces));
      report('ST-O2', checkStrokeInventory(oracleSource, pieces));
      if (found.status !== 'ok') continue;
      // ST-O4's scope (section 11.1): axis-aligned segments, integer data, no arcs. A rational
      // non-axis normal (ST-F5, ST-F25) has an exact ideal polygon, but its binary64 samples and
      // the arrangement's rounding are inexact, so it takes ST-O3's tau band.
      // Exact mode also needs every ideal vertex to round-trip through binary64: with a width
      // below the spacing of the coordinates (M(0,2^40) L(1,2^40), w = 2^-30) the ideal corner
      // is not representable and the emitted polygon cannot equal it.
      const exactIdeal = idealStrokeVerticesBinary64(oracleSource) && axisAligned(source);
      report(
        'ST-O3',
        checkStrokeResolution(
          pieces,
          found.mesh!,
          exactIdeal ? 'exact' : 'band',
          2 ** (source.exponent - 2),
        ),
      );
      if (exactIdeal) {
        exactRegions += 1;
        report('ST-O4', checkStrokeExactRegion(oracleSource, found.mesh!));
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBe(65);
    expect(exactRegions).toBeGreaterThan(0);
  });

  it('ST-F1 to ST-F3: caps (ST-O4 on butt and square)', () => {
    expectRegion('ST-F1', [rectangle(0, -1, 4, 1)], 8);
    expect(okMesh('ST-F1').bounds).toEqual({ minX: 0, minY: -1, maxX: 4, maxY: 1 });
    expectRegion('ST-F2', [rectangle(-1, -1, 5, 1)], 12);
    expect(okMesh('ST-F2').bounds).toEqual({ minX: -1, minY: -1, maxX: 5, maxY: 1 });
    expectArea('ST-F3', 8 + SIXTEEN_GON);
    expect(
      entry('ST-F3')
        .pieces.filter((piece) => piece.kind === 'round-cap')
        .map((piece) => piece.disk),
    ).toEqual([16, 16]);
  });

  it('ST-F4: joins and the miter tip', () => {
    expectRegion(
      'ST-F4/miter-2',
      [rectangle(0, -1, 4, 1), rectangle(3, 0, 5, 4), rectangle(4, -1, 5, 0)],
      16,
    );
    const miter = entry('ST-F4/miter-2').pieces.find((piece) => piece.kind === 'miter');
    expect(miter?.points).toContainEqual([5, -1]);
    expectArea('ST-F4/miter-1', 15.5);
    expect(kinds('ST-F4/miter-1')).toEqual(['line-sweep', 'bevel', 'line-sweep']);
    expectArea('ST-F4/bevel', 15.5);
    expectArea('ST-F4/round', 15 + QUARTER_SIXTEEN_GON);
  });

  it('ST-F5: the exact miter decision at ratio 5/4 and its neighbours', () => {
    for (const [name, miter] of [
      ['ST-F5/1.25', true],
      ['ST-F5/below', false],
      ['ST-F5/above', true],
    ] as const) {
      okMesh(name);
      expect(kinds(name).includes('miter'), name).toBe(miter);
      expect(kinds(name).includes('bevel'), name).toBe(!miter);
      if (miter) {
        const limit = name === 'ST-F5/1.25' ? 1.25 : 1.2500000000000002;
        const gTip = 64 * 2 ** -53 * (25 + limit ** 3);
        const tip = entry(name)
          .pieces.find((piece) => piece.kind === 'miter')!
          .points.find(([x]) => x > 25.5)!;
        expect(Math.abs(tip[0] - 25.75), name).toBeLessThanOrEqual(gTip);
        expect(Math.abs(tip[1] + 1), name).toBeLessThanOrEqual(gTip);
      }
    }
  });

  it('ST-F6: an exact reversal adds nothing for miter and bevel, a disk for round', () => {
    for (const name of ['ST-F6/miter', 'ST-F6/bevel']) {
      expectRegion(name, [rectangle(0, -1, 4, 1)], 8);
      expect(kinds(name)).toEqual(['line-sweep', 'line-sweep']);
    }
    expectArea('ST-F6/round', 8 + HALF_SIXTEEN_GON);
  });

  it('ST-F7 to ST-F10: MOVE-only, zero-length and collapsed subpaths', () => {
    for (const cap of CAPS)
      for (const join of JOINS) {
        expect(entry(`ST-F7/${cap}-${join}`).status).toBe('empty');
        expect(entry(`ST-F9/${cap}-${join}`).status).toBe('empty');
      }
    expect(entry('ST-F8/butt').status).toBe('empty');
    expectArea('ST-F8/round', SIXTEEN_GON);
    expectRegion('ST-F8/square', [rectangle(3, 4, 5, 6)], 4);
    expect(okMesh('ST-F8/square').bounds).toEqual({ minX: 3, minY: 4, maxX: 5, maxY: 6 });
    expectArea('ST-F10', 16);
    expect(kinds('ST-F10')).toEqual(['line-sweep', 'miter', 'line-sweep']);
  });

  it('ST-F11: a closed square ignores its cap', () => {
    const hole: Point[] = rectangle(1, 1, 3, 3).reverse();
    for (const cap of CAPS) {
      expectRegion(`ST-F11/miter-${cap}`, [rectangle(-1, -1, 5, 5), hole], 32);
      expectArea(`ST-F11/bevel-${cap}`, 30);
      expectArea(`ST-F11/round-${cap}`, 28 + SIXTEEN_GON);
    }
  });

  it('ST-F12: the implicit closing edge is not stroked (ST-O5)', () => {
    const mesh = okMesh('ST-F12');
    expect(contains(mesh, 0, 4)).toBe(false);
    expect(contains(mesh, -0.5, 4)).toBe(false);
    expect(contains(mesh, 4, 4)).toBe(true);
    expect(contains(mesh, 4, 0.5)).toBe(true);
  });

  it('ST-F13: a forward continuation shares its triple and adds no join', () => {
    expectArea('ST-F13', 25.298221281347036);
    expect(kinds('ST-F13')).toEqual(['line-sweep', 'line-sweep']);
    const [first, second] = entry('ST-F13').segments;
    expect(second!.start).toEqual(first!.end);
    expect(first!.join?.class).toBe('continuation');
    expect(boundaryLoops(okMesh('ST-F13'))).toBe(1);
  });

  it('ST-F14: self-overlap is covered once (ST-O3, ST-O4)', () => {
    expectRegion('ST-F14a', [rectangle(0, 1, 4, 3), rectangle(1, 0, 3, 4)], 12);
    expectRegion(
      'ST-F14b',
      [
        rectangle(0, 1, 4, 3),
        rectangle(3, 2, 5, 4),
        rectangle(2, 3, 4, 5),
        rectangle(1, 0, 3, 4),
        rectangle(4, 1, 5, 2),
        rectangle(4, 4, 5, 5),
        rectangle(1, 4, 2, 5),
      ],
      20,
    );
    expect(kinds('ST-F14b').filter((kind) => kind === 'miter')).toHaveLength(3);
  });

  it('ST-F21 to ST-F24: thin, collapsed and out-of-range strokes', () => {
    // 2^-18 exactly: twice the area is 2^-17, that is 2^2131 units of 2^-2148.
    expect(twiceArea(okMesh('ST-F21'))).toBe(1n << 2131n);
    expect(entry('ST-F22').status).toBe('empty');
    expect(entry('ST-F23').status).toBe('numeric-range');
    expect(entry('ST-F24/2^30').status).toBe('numeric-range');
    okMesh('ST-F24/4');
    expect(kinds('ST-F24/4')).toContain('bevel');
  });

  it('ST-U4 tip guard: a kept sqrt-2 miter with L = 1e4 is ok (actual ratio, not L)', () => {
    expect(kinds('ST-U4/tip-ratio')).toEqual(['line-sweep', 'miter', 'line-sweep']);
    expectRegion(
      'ST-U4/tip-ratio',
      [rectangle(0, -10, 10, 10), rectangle(0, 0, 20, 10), rectangle(10, -10, 20, 0)],
      400,
    );
  });

  it('ST-F25: miter exactly where the ratio is at most L', () => {
    for (const [turn, , ratio] of F25_TURNS)
      for (const limit of F25_LIMITS) {
        const name = `ST-F25/${turn}/${String(limit)}`;
        okMesh(name);
        // Math.SQRT2 rounds above sqrt 2, so it keeps the 90 degree miter.
        const miter = turn === 'sqrt2' ? limit >= Math.SQRT2 : ratio <= limit;
        expect(kinds(name).includes('miter'), name).toBe(miter);
      }
  });

  it('ST-F26: current-cap disk fixtures (labelled; a limit raise may re-baseline them)', () => {
    okMesh('ST-F26/disk-256');
    expect(entry('ST-F26/disk-256').pieces.some((piece) => piece.disk === 256)).toBe(true);
    expect(entry('ST-F26/disk-512').status).toBe('work-limit');
  });
});

// ---------------------------------------------------------------------------
// ST-U4: cubic strokes

const oracleSource = (source: StrokeCase): StrokeOracleSource => ({
  verbs: source.verbs,
  points: source.points,
  width: source.width,
  cap: source.cap,
  join: source.join,
  miterLimit: source.miterLimit,
  toleranceExponent: source.exponent,
});

const cubicSource = (name: string): StrokeCase => {
  const found = cubicCases().find((source) => source.name === name);
  if (!found) throw new Error(`no cubic case ${name}`);
  return found;
};

/** The front end finished with stored pieces (an arrangement stop other than its input cap). */
const frontEndComplete = (found: DumpEntry): boolean =>
  found.status === 'ok' ||
  found.status === 'empty' ||
  (found.failure?.stage === 'arrangement' && found.failure.error !== 'Rounded(InputLimit)');

const seeded = (name: string): boolean => name.startsWith('ST-D');

/**
 * ST-O3's union-area band costs seconds per case beyond a few dozen pieces; it runs on the `ok`
 * cubic cases of at most 32 pieces, and every `ok` mesh gets the V2 mesh checks.
 */
const BAND_PIECES = 32;

describe('ST-U4 cubic strokes through the dump hand-off', () => {
  it('ST-O1 and ST-O2 on every cubic case whose front end completed', () => {
    const failures: string[] = [];
    const checked: string[] = [];
    for (const source of cubicCases()) {
      if (seeded(source.name)) continue;
      const found = entry(source.name);
      expect(found.status, source.name).not.toBe('internal-error');
      if (found.status === 'ok') expect(checkFillMesh(found.mesh!), source.name).toEqual([]);
      const pieces = oraclePieces(found, source);
      if (frontEndComplete(found)) {
        const bounds = checkStrokePieceBounds(oracleSource(source), pieces);
        if (!bounds.ok) failures.push(`${source.name} ST-O1: ${bounds.findings.join('; ')}`);
        checked.push(source.name);
      }
      if (frontEndComplete(found) || found.failure?.error === 'Rounded(InputLimit)') {
        const inventory = checkStrokeInventory(oracleSource(source), pieces);
        if (!inventory.ok) failures.push(`${source.name} ST-O2: ${inventory.findings.join('; ')}`);
      }
    }
    expect(failures).toEqual([]);
    expect(checked.length).toBeGreaterThan(40);
  }, 900_000);

  it('ST-O3 (tau band) on the ok cubic cases of at most 32 pieces, ST-O4 on ST-F19', () => {
    const failures: string[] = [];
    let banded = 0;
    for (const source of cubicCases()) {
      if (seeded(source.name)) continue;
      const found = entry(source.name);
      if (found.status !== 'ok' || found.pieces.length > BAND_PIECES) continue;
      const result = checkStrokeResolution(
        oraclePieces(found, source),
        found.mesh!,
        'band',
        2 ** (source.exponent - 2),
      );
      if (!result.ok) failures.push(`${source.name} ST-O3: ${result.findings.join('; ')}`);
      banded += 1;
    }
    const f19 = oracleSource(cubicSource('ST-F19'));
    expect(idealStrokeExactArea(f19)).not.toBeNull();
    const exact = checkStrokeExactRegion(f19, okMesh('ST-F19'));
    if (!exact.ok) failures.push(`ST-F19 ST-O4: ${exact.findings.join('; ')}`);
    expect(failures).toEqual([]);
    expect(banded).toBeGreaterThan(30);
  }, 900_000);

  it('ST-F15: R1 and R2 ok at every e, R3 and R4 ok at e = -3, the rest ok or work-limit', () => {
    const listed: string[] = [];
    for (const source of cubicCases()) {
      if (!source.name.startsWith('ST-F15/')) continue;
      const found = entry(source.name);
      const family = source.name.slice('ST-F15/'.length, 'ST-F15/'.length + 2);
      const required =
        family === 'R1' ||
        family === 'R2' ||
        (source.exponent === -3 && (family === 'R3' || family === 'R4'));
      if (required) expect(found.status, source.name).toBe('ok');
      else expect(['ok', 'work-limit'], source.name).toContain(found.status);
      if (found.status === 'work-limit')
        listed.push(`${source.name}: ${found.failure?.error ?? ''}`);
    }
    // The listed work-limit cases (ST-A3), recorded in the plan entry: 16 up to stroke-v0+r4;
    // 15 since D9 E2-U1 (r5), where the seam merge makes one of them ok.
    expect(listed).toHaveLength(15);
  });

  it('ST-F16: one reversal at t* = 1/2, cusp center (0.5, 0.75), n = 32, (0.5, 0.8) inside', () => {
    // STROKE_V0_LIMITS: up to stroke-v0+r4 the arrangement's node cap stopped ST-F16 after a
    // complete front end (its expected status by user decision, 2026-10-20; contract dated
    // note). Since D9 E2-U1 (r5) the seam merge gives the arrangement 9 contours, and it is ok.
    expect(entry('ST-F16').status).toBe('ok');
    // The literal expectation under the kernel's test-only wide arrangement limits.
    const classes = classifyStrokeSource(oracleSource(cubicSource('ST-F16'))).cubics;
    expect(classes.map((cubic) => [cubic.kind, cubic.stationary?.value])).toEqual([['cusp', 0.5]]);
    const found = entry('ST-F16/wide');
    expect(found.segments[0]!.cubic).toBe('cusp');
    const disks = found.pieces.filter((piece) => piece.kind === 'cusp-disk');
    expect(disks).toHaveLength(1);
    expect(disks[0]!.t[0]).toBe(0.5);
    expect(disks[0]!.samples[0][1]).toEqual([0.5, 0.75]);
    expect(disks[0]!.disk).toBe(32);
    expect(contains(okMesh('ST-F16/wide'), 0.5, 0.8)).toBe(true);
  });

  it('ST-F16p: the cusp disk at production limits (e = -5, n = 8)', () => {
    // Literal fixed before the first run (ST-A0 review): ok at STROKE_V0_LIMITS, one cusp disk
    // at t = 1/2 with center exactly (0.5, 0.75) and n = 8, (0.5, 0.8) inside.
    const found = entry('ST-F16p');
    expect(found.status).toBe('ok');
    expect(found.segments[0]!.cubic).toBe('cusp');
    const disks = found.pieces.filter((piece) => piece.kind === 'cusp-disk');
    expect(disks).toHaveLength(1);
    expect(disks[0]!.t[0]).toBe(0.5);
    expect(disks[0]!.samples[0][1]).toEqual([0.5, 0.75]);
    expect(disks[0]!.disk).toBe(8);
    expect(contains(okMesh('ST-F16p'), 0.5, 0.8)).toBe(true);
  });

  it('ST-F17 to ST-F20: collinear reversal and continuation, stationary start', () => {
    expectArea('ST-F17/butt', 6 + HALF_SIXTEEN_GON);
    expectArea('ST-F17/square', 8 + HALF_SIXTEEN_GON);
    expectArea('ST-F17/round', 6 + SIXTEEN_GON);
    for (const cap of CAPS) {
      const disks = entry(`ST-F17/${cap}`).pieces.filter((piece) => piece.kind === 'cusp-disk');
      expect(
        disks.map((piece) => piece.samples[0][1]),
        cap,
      ).toEqual([[0, 0]]);
    }
    const f18 = okMesh('ST-F18');
    // Start tangent (1, 0): the start triple is (0, -1), (0, 0), (0, 1).
    expect(entry('ST-F18').segments[0]!.start).toEqual([
      [0, -1],
      [0, 0],
      [0, 1],
    ]);
    expect(contains(f18, -0.9, 0.9)).toBe(true);
    expect(contains(f18, -1.1, 0)).toBe(false);
    expect(contains(f18, -0.5, 1.1)).toBe(false);
    expectRegion('ST-F19', [rectangle(-1, -1, 1, 1)], 4);
    expect(okMesh('ST-F19').bounds).toEqual({ minX: -1, minY: -1, maxX: 1, maxY: 1 });
    expect(kinds('ST-F19')).toEqual(['line-sweep']);
    for (const cap of CAPS)
      for (const [probe, kind] of [
        ['endpoint', 'endpoint-stationary'],
        ['reversal', 'collinear'],
        ['continuation', 'collinear'],
      ] as const) {
        const name = `ST-F20/${probe}-${cap}`;
        okMesh(name);
        expect(entry(name).segments[0]!.cubic, name).toBe(kind);
        const oracle = classifyStrokeSource(oracleSource(cubicSource(name))).cubics[0]!;
        expect(oracle.kind, name).toBe(kind);
        expect(oracle.turningPoints.length, name).toBe(probe === 'reversal' ? 1 : 0);
      }
  });

  it('seeded defects ST-D6 to ST-D8 fail their named checks; the controls pass', () => {
    const check = (name: string) => {
      const source = cubicSource(name);
      const pieces = oraclePieces(entry(name), source);
      return {
        bounds: checkStrokePieceBounds(oracleSource(source), pieces).ok,
        inventory: checkStrokeInventory(oracleSource(source), pieces).ok,
      };
    };
    const control = check;
    // ST-D6: the user join at generated knots, rejected by ST-O2 on ST-F15 and ST-F16.
    for (const [name, clean] of [
      ['ST-D6/ST-F16', 'ST-F16/wide'],
      ['ST-D6/ST-F15/R3-zoom1-dpr3', 'ST-F15/R3-zoom1-dpr3'],
    ] as const) {
      expect(control(clean).inventory, clean).toBe(true);
      expect(check(name).inventory, name).toBe(false);
    }
    // ST-D7: the cusp disk omitted, rejected by ST-F16's membership and by ST-O2.
    expect(contains(okMesh('ST-D7/ST-F16'), 0.5, 0.8)).toBe(false);
    expect(check('ST-D7/ST-F16').inventory).toBe(false);
    // ST-D8: the named ST-F15 case does not expose factor 2 (ST-O1 still passes; recorded) ...
    expect(control(D8_CASE).bounds).toBe(true);
    expect(check(`ST-D8/${D8_CASE}`).bounds).toBe(true);
    // ... so the synthetic folded-band fixture does: factor 4 gives two depth-1 leaves that
    // ST-O1 accepts, factor 2 one depth-0 leaf that ST-O1 rejects.
    expect(control('ST-U4/folded-arc').bounds).toBe(true);
    expect(check('ST-D8/ST-U4/folded-arc').bounds).toBe(false);
    const depths = (name: string) =>
      entry(name)
        .pieces.filter((piece) => piece.kind === 'cubic-leaf')
        .map((piece) => piece.depth);
    expect(depths('ST-U4/folded-arc')).toEqual([1, 1]);
    expect(depths('ST-D8/ST-U4/folded-arc')).toEqual([0]);
  }, 900_000);
});
