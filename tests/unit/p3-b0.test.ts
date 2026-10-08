import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyze,
  classify,
  configHash,
  fitSeries,
  leaves,
  nearestRank,
  validateRecord,
  type B0Record,
  type DecisionOutput,
} from '../geometry/p3-b0/analysis.js';
import {
  corpusCells,
  encodeCorpus,
  generateCellPaths,
  scalarBits,
  scenarioConfig,
  snap,
  T_QUANTILE_95,
  VERB_CLOSE,
  VERB_CUBIC,
  VERB_MOVE,
  type CellSpec,
} from '../geometry/p3-b0/corpus.js';
import { parseArguments } from '../../tooling/run-p3-b0-benchmark.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = JSON.parse(
  readFileSync(path.join(root, 'tests/geometry/p3-b0/fixtures.json'), 'utf8'),
) as { paths: Record<string, { verbs: number[]; bits: string[] }> };
const cellById = new Map(corpusCells().map((cell) => [cell.id, cell]));

describe('P3 B0 corpus generator', () => {
  it('matches the bits of the independent Rust implementation', () => {
    for (const [name, id] of [
      ['P4/s=4#0', 'P4/s=4'],
      ['K2/s=3#0', 'K2/s=3'],
    ] as const) {
      const path0 = generateCellPaths(cellById.get(id)!, 1)[0]!;
      expect(path0.verbs).toEqual(fixtures.paths[name]!.verbs);
      expect(scalarBits(path0.points)).toEqual(fixtures.paths[name]!.bits);
    }
  });

  it('fixes the sweep, path counts and corpus order of the contract', () => {
    const cells = corpusCells();
    expect(cells).toHaveLength(66);
    expect(cells.filter((cell) => cell.role === 'decision')).toHaveLength(34);
    expect(cells.filter((cell) => cell.role === 'o1')).toHaveLength(26);
    expect(cells.filter((cell) => cell.role === 'o2').map((cell) => cell.id)).toEqual([
      'X/s=5',
      'X/s=7',
      'X/s=9',
      'X/s=11',
      'X/s=13',
      'X/s=15',
    ]);
    expect(cellById.get('P4/s=16')!.paths).toBe(100);
    expect(cellById.get('P8/s=8')!.paths).toBe(10);
    expect(cellById.get('O1/P2/s=3')!.paths).toBe(30);
  });

  it('keeps every decision cell inside the a priori caps', () => {
    for (const cell of corpusCells().filter((item) => item.role === 'decision')) {
      const { contours: c, cubicsPerContour: s } = cell;
      expect(leaves(cell)).toBeLessThanOrEqual(64);
      expect(c * (s + 2)).toBeLessThanOrEqual(24);
      expect(c * (6 * s + 2)).toBeLessThanOrEqual(104);
      expect(c * s).toBeLessThanOrEqual(16);
      expect(leaves(cell) + 2 * c).toBeLessThanOrEqual(72);
    }
  });

  it('snaps to 2^-10 with exact closure and a prefix-stable RNG', () => {
    for (const cell of corpusCells().filter((item) => item.snapped)) {
      const paths = generateCellPaths(cell, 3);
      for (const { verbs, points } of paths) {
        for (const value of points) expect(Number.isInteger(value * 1024)).toBe(true);
        let cursor = 0;
        let start: [number, number] = [0, 0];
        let last: [number, number] = [0, 0];
        for (const verb of verbs) {
          if (verb === VERB_MOVE) {
            start = [points[cursor]!, points[cursor + 1]!];
            last = start;
            cursor += 2;
          } else if (verb === VERB_CUBIC) {
            last = [points[cursor + 4]!, points[cursor + 5]!];
            cursor += 6;
          } else {
            expect(verb).toBe(VERB_CLOSE);
            expect(last).toEqual(start);
          }
        }
        expect(cursor).toBe(points.length);
      }
    }
    const cell = cellById.get('P4/s=16')!;
    expect(generateCellPaths(cell, 100).slice(0, 10)).toEqual(generateCellPaths(cell, 10));
  });

  it('rounds half-grid ties to even', () => {
    expect(snap(0.5 / 1024)).toBe(0);
    expect(snap(1.5 / 1024)).toBe(2 / 1024);
    expect(snap(-0.5 / 1024)).toBe(-0);
    expect(snap(2.6 / 1024)).toBe(3 / 1024);
  });

  it('frames the corpus deterministically', () => {
    const first = encodeCorpus(corpusCells());
    expect(new TextDecoder().decode(first.slice(0, 8))).toBe('P3B0COR1');
    expect(encodeCorpus(corpusCells())).toEqual(first);
  });
});

describe('P3 B0 analysis', () => {
  it('uses nearest rank', () => {
    const sorted = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(nearestRank(sorted, 0.5)).toBe(10);
    expect(nearestRank(sorted, 0.95)).toBe(19);
    expect(nearestRank(sorted, 0.99)).toBe(20);
  });

  it('extrapolates an exact power law with a tight bound and an equal guard', () => {
    const points = [8, 16, 24, 32, 48, 64].map((value) => ({ leaves: value, ns: 3 * value ** 2 }));
    const fit = fitSeries('P8', 0, 'median', points, 256, T_QUANTILE_95);
    expect(fit.slope).toBeCloseTo(2, 10);
    expect(fit.predictionFactor).toBeCloseTo(1, 10);
    expect(fit.estimateNs).toBeCloseTo(3 * 256 ** 2, 3);
  });

  it('lets the curvature guard dominate a steepening cost', () => {
    const points = [8, 16, 24, 32, 48, 64].map((value) => ({
      leaves: value,
      ns: value + value ** 3 / 64,
    }));
    const fit = fitSeries('P8', 0, 'median', points, 256, T_QUANTILE_95);
    expect(fit.guard!).toBeGreaterThan(fit.predicted!);
    expect(fit.estimateNs!).toBeGreaterThanOrEqual(Math.exp(fit.guard!) * (1 - 1e-12));
  });

  it('recomputes a valid record and rejects a tampered one', () => {
    const record = syntheticRecord((value) => value ** 2);
    const complete = JSON.parse(
      JSON.stringify({ ...record, analysis: analyze(record) }),
    ) as B0Record;
    expect(() => validateRecord(complete)).not.toThrow();
    expect((complete.analysis as { verdict: string }).verdict).toBe('FEASIBLE');

    const tampered = JSON.parse(JSON.stringify(complete)) as {
      repetitions: { cells: { batchNs: number[] }[] }[];
    };
    tampered.repetitions[0]!.cells[0]!.batchNs[0]! += 1_000_000;
    expect(() => validateRecord(tampered as unknown as B0Record)).toThrow(/analysis differs/);

    const rehashed = JSON.parse(JSON.stringify(complete)) as B0Record & {
      scenario: { config: { decision: { wasmFactor: number } } };
    };
    rehashed.scenario.config.decision.wasmFactor = 1;
    expect(() => validateRecord(rehashed)).toThrow(/hash mismatch/);
  });

  it('turns a budget breach into INFEASIBLE and a failed check into INCONCLUSIVE', () => {
    const slow = syntheticRecord((value) => 2e5 * value ** 2);
    expect(analyze(slow).verdict).toBe('INFEASIBLE');
    const incomplete = { ...syntheticRecord((value) => value ** 2) };
    const short = { ...incomplete, repetitions: incomplete.repetitions.slice(0, 4) };
    expect(analyze(short).verdict).toBe('INCONCLUSIVE');
  });
});

describe('P3 B0 checks and H1', () => {
  type Mutable = { -readonly [K in keyof B0Record]: B0Record[K] } & Record<string, unknown>;
  const fresh = () => JSON.parse(JSON.stringify(syntheticRecord((value) => value ** 2))) as Mutable;
  const checkOf = (record: B0Record, id: string) =>
    analyze(record).checks.find((item) => item.id === id)!.pass;

  it('classifies admission codes from the decision paths only', () => {
    const ok = { status: 'OK', rounded: false, transverse: false, allocations: 0 };
    const cell = (codes: string[]) => ({
      cell: 'c',
      paths: codes.map((status) => ({ ...ok, status })),
    });
    const caps = scenarioConfig('reference').admission.capCodes;
    expect(classify(cell(['OK', 'OK']), caps).classification).toBe('ADMITTED');
    expect(classify(cell(['OK', 'EmissionStatus(5)']), caps)).toEqual({
      classification: 'CAP-BOUND',
      firstFailure: { path: 1, code: 'EmissionStatus(5)' },
    });
    expect(classify(cell(['Topology(KnotMismatch)']), caps).classification).toBe('NOT-ADMITTED');
    expect(
      classify(cell([...Array<string>(10).fill('OK'), 'OwnerLimit']), caps, 10).classification,
    ).toBe('ADMITTED');
  });

  it('fails linearity, checksum, clock and metadata checks into INCONCLUSIVE', () => {
    const slowLarge = fresh();
    for (const rep of slowLarge.repetitions as DecisionOutput[])
      (rep.linearity!.batch100Ns as number[]).fill(100 * 2 * 64 ** 2);
    expect(checkOf(slowLarge, '4-linearity')).toBe(false);
    expect(analyze(slowLarge).verdict).toBe('INCONCLUSIVE');

    const mismatch = fresh();
    (mismatch.repetitions[1]!.cells[3]!.checksums as string[])[0] = 'ffffffffffffffff';
    expect(checkOf(mismatch, '5-checksums-identical')).toBe(false);

    const coarseClock = fresh();
    for (const rep of coarseClock.repetitions as unknown as { clockQuantumNs: number }[])
      rep.clockQuantumNs = 1e9;
    expect(checkOf(coarseClock, '3-no-unverified-primary-cell')).toBe(false);

    const bare = fresh();
    bare.builds = {};
    expect(checkOf(bare, '8-metadata-complete')).toBe(false);
    expect(analyze(bare).verdict).toBe('INCONCLUSIVE');
  });

  it('decides H1 from top-level counts and undiminished unit costs', () => {
    const record = fresh();
    const largestNs = 10 * 64 ** 2;
    const diagnostic = (unitNs: number, overhead = 1) => ({
      kind: 'diagnostic' as const,
      clockQuantumNs: 1,
      observations: [],
      stages: ['P2/s=16', 'P4/s=16', 'P8/s=8'].map((cell) => {
        const s3 = overhead * (cell === 'P2/s=16' ? 10 * 32 ** 2 : largestNs);
        return {
          cell,
          s1Ns: [s3 * 0.1],
          s2Ns: [s3 * 0.6],
          s3Ns: [s3],
          counts: [{ routine: 'fill_exact::multiply', instance: 'i', calls: s3 / 100 }],
        };
      }),
      replay: {
        cell: 'P4/s=16',
        loops: 1,
        calls: 1,
        baselineNs: [10],
        routines: [
          { routine: 'fill_exact::multiply', instance: 'i', captured: 1, meansNs: [unitNs] },
        ],
      },
    });
    const verdicts = (unitNs: number, overhead = 1) =>
      analyze({ ...record, diagnostic: diagnostic(unitNs, overhead) }).h1!.map(
        (item) => item.verdict,
      );
    // share = calls * unit / s3 = unit / 100; the baseline of 10 ns is not subtracted.
    expect(verdicts(60)).toEqual(['Supported', 'Supported', 'Supported']);
    expect(verdicts(50)).toEqual(['Supported', 'Supported', 'Supported']);
    expect(verdicts(30)).toEqual(['Inconclusive', 'Inconclusive', 'Inconclusive']);
    expect(verdicts(20)).toEqual(['Not supported', 'Not supported', 'Not supported']);
    expect(verdicts(60, 1.6)).toEqual(['Inconclusive', 'Inconclusive', 'Inconclusive']);
  });
});

describe('P3 B0 runner arguments', () => {
  it('accepts the two profiles and rejects malformed invocations', () => {
    expect(parseArguments(['--profile', 'functional'])).toEqual({
      profile: 'functional',
      environmentJson: null,
    });
    expect(parseArguments(['--profile', 'reference', '--environment-json', 'env.json'])).toEqual({
      profile: 'reference',
      environmentJson: 'env.json',
    });
    expect(() => parseArguments(['--profile', 'reference'])).toThrow(/environment-json/);
    expect(() => parseArguments(['--profile', 'fast'])).toThrow();
    expect(() => parseArguments(['--profile', 'functional', '--profile', 'functional'])).toThrow();
    expect(() => parseArguments(['--unknown', 'x'])).toThrow();
  });
});

function syntheticRecord(perPathNs: (leaves: number) => number): B0Record {
  const config = scenarioConfig('reference');
  const decision = config.cells.filter((cell) => cell.role === 'decision');
  const pathsOf = (cell: CellSpec) =>
    Array.from({ length: cell.paths }, () => ({
      status: 'OK',
      flatCommands: leaves(cell) + 2 * cell.contours,
      vertices: 4 * leaves(cell),
      triangles: 4 * leaves(cell) - 2,
      rounded: false,
      transverse: false,
      allocations: 0,
    }));
  const repetitions: DecisionOutput[] = Array.from({ length: 5 }, (_, repetition) => ({
    kind: 'decision',
    repetition,
    clockQuantumNs: 1,
    workspace: { inlineBytes: 1, allocatedBytes: 1 },
    admission: decision.map((cell) => ({ cell: cell.id, paths: pathsOf(cell) })),
    order: decision.map((cell) => cell.id),
    cells: decision.map((cell) => {
      const base = perPathNs(leaves(cell));
      return {
        cell: cell.id,
        workspaceNs: 1,
        batchAllocations: 0,
        batchNs: Array.from({ length: 20 }, (_, index) => 10 * base * (1 + (index % 3) * 0.001)),
        pathNs: Array.from({ length: 200 }, (_, index) => base * (1 + (index % 5) * 0.002)),
        checksums: Array.from({ length: 20 }, () => '00000000000000aa'),
      };
    }),
    linearity: {
      cell: 'P4/s=16',
      batch10Ns: Array.from({ length: 20 }, () => 10 * perPathNs(64)),
      checksums10: Array.from({ length: 20 }, () => '00000000000000aa'),
      batch100Ns: Array.from({ length: 5 }, () => 100 * perPathNs(64)),
      checksums100: Array.from({ length: 5 }, () => '00000000000000bb'),
    },
  }));
  return {
    schemaVersion: 1,
    scenario: {
      id: config.scenario.id,
      version: config.scenario.version,
      profile: 'reference',
      config,
      configHash: configHash(config),
    },
    run: { commit: 'test', runner: 'p3-b0-runner/1', sourceManifest: { file: 'hash' } },
    environment: {
      observedAt: '2026-10-08T00:00:00Z',
      os: 'test',
      cpu: 'test',
      logicalCores: 1,
      memoryBytes: 1,
      timezone: 'UTC',
      power: { value: 'AC', source: 'test' },
      backgroundLoad: { value: 'idle', source: 'test' },
    },
    builds: { toolchain: {}, decision: {}, diagnostic: {} },
    corpus: { sha256: '0', bytes: 0 },
    repetitions,
    diagnostic: null,
  };
}
