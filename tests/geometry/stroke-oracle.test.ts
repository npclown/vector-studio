/**
 * P3 B2 unit ST-U3 (`docs/plans/p3-b2-stroke-contract.md` sections 11.1 and 11.2): the line
 * fixtures through the oracle hand-off. It writes a `P3STKIN1` input, runs the ignored Rust test
 * `emit_stroke_dump` with the pinned toolchain, and checks every literal expectation of the
 * line fixtures on the dumped meshes: V2's mesh checks on every `ok` (ST-O3), the exact region
 * against the ideal union where the ideal pieces are exact polygons (ST-O4), areas, bounds,
 * statuses, piece kinds, triples and named-point membership (ST-O5).
 *
 * ST-O1 (piece bounds against the ideal pieces) and ST-O2 (inventory) are the independent oracle
 * of ST-U2 (`packages/geometry-reference/src/stroke-region.ts`); they join this file when ST-U2
 * lands. Precision is UNVERIFIED against the 0.25 physical-pixel target until B4.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Point } from '../../packages/geometry-reference/src/index.js';
import { checkFillMesh, checkFillRegion } from '../support/fill-mesh-check.js';
import { encodeInput, parseDump, type DumpEntry } from './stroke-oracle/dump.js';
import {
  area,
  boundaryLoops,
  CAPS,
  contains,
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

let directory = '';
let entries = new Map<string, DumpEntry>();

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'p3-stroke-oracle-'));
  const input = path.join(directory, 'input.txt');
  const dump = path.join(directory, 'dump.txt');
  writeFileSync(input, encodeInput(lineCases()));
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
    expect(entries.size).toBe(lineCases().length);
    for (const found of entries.values()) {
      expect(found.status, found.name).not.toBe('internal-error');
      if (found.status === 'ok') expect(checkFillMesh(found.mesh!), found.name).toEqual([]);
    }
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
