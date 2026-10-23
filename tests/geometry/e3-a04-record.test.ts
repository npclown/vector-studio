// D9 E3 unit E3-U3: tests of the A04 evidence record, its validator and writer, the verdict
// rules (sections 7.3 and 7.4; E3-A7, E3-A8, E3-A9; seeded defect E3-D10) and the freeze gate of
// the run command (section 5.5). Synthetic rows only: no corpus case is run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { FREEZE_NOTE, checkFreeze } from '../../tooling/e3-a04-freeze-gate.mjs';
import type { CaseRow } from './e3-a04/harness.js';
import {
  type ControlOutcome,
  type CorpusLayout,
  type EvidenceRecord,
  type Provenance,
  type RecordRow,
  DPRS,
  REQUIRED_CONTROLS,
  STRATUM_ORDER,
  TRANSFORMS,
  ZOOMS,
  RecordInvalid,
  buildCoverage,
  buildRecord,
  expectedPerStratum,
  groupStats,
  nearestRank,
  stringifyRecord,
  stratumAt,
  validateRecord,
  writeEvidenceRecord,
} from './e3-a04/record.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'e3-a04-record-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------
// Synthetic rows and records

const base: Omit<CaseRow, 'id' | 'status'> = {
  reason: null,
  rejection: null,
  variant: 'fringe',
  bucket: -3,
  servedExponent: -3,
  vertices: 4,
  triangles: 2,
  eLo: 0,
  eHi: 0.001,
  betaVertex: 0.0002,
  betaFeature: 0.0001,
  betaC: 0.0002,
  clip: { clipped: false, triangles: 0, crossings: 0, bound: 0 },
  noFlip: { ok: true, uncertain: 0 },
  u: 0.0012,
  l: 0,
  tJunctions: 0,
  crackBound: 0,
  storageCracks: 0,
  resolution: 0.001,
  work: 10,
  windowPoint: null,
  ms: 1,
};

type RowOverride = Partial<RecordRow>;

function row(index: number, over: RowOverride = {}): RecordRow {
  return {
    ...base,
    index,
    id: `C1/row${index}`,
    status: 'pass',
    stratum: 'C1',
    transform: 'T0',
    zoom: 1,
    dpr: 1,
    paint: 'fill',
    placement: 'center',
    servedOffset: 0,
    ...over,
  };
}

const provenance: Provenance = {
  sourceCommit: 'a'.repeat(40),
  dirty: false,
  contractSha256: 'b'.repeat(64),
  wasmSha256: 'c'.repeat(64),
  operations: { fill: 'geometry-wasm/fill-v0+r2', stroke: 'geometry-wasm/stroke-v0+r4' },
  corpus: { version: 'a04-corpus/v1', corpusSha256: 'd'.repeat(64), cases: 0 },
  generatorSha256: 'e'.repeat(64),
  oracleSha256: 'f'.repeat(64),
  shaderIdentitySha256: '1'.repeat(64),
  carrier: 'K4',
  builderPlacement: 'D8-interim TypeScript builders in renderer-core',
  node: 'v24.0.0',
  os: 'test',
};

const allControls: ControlOutcome[] = REQUIRED_CONTROLS.map((id) => ({
  id,
  expected: 'FAIL',
  observed: 'FAIL',
  ok: true,
  detail: 'test',
}));

const run = {
  id: 'r1',
  startedUtc: '2026-10-23T00:00:00.000Z',
  finishedUtc: '2026-10-23T00:01:00.000Z',
  stride: 1,
  shards: 1,
  caseMilliseconds: 1,
  wallMilliseconds: 1,
};

/** Every declared cell (paint x transform x pair) once: 144 rows, all in stratum C1. */
function cellRows(over: (cell: number) => RowOverride = () => ({})): RecordRow[] {
  const rows: RecordRow[] = [];
  for (const paint of ['fill', 'stroke'] as const)
    for (const transform of TRANSFORMS)
      for (const zoom of ZOOMS)
        for (const dpr of DPRS) {
          const index = rows.length;
          rows.push(row(index, { id: `cell${index}`, paint, transform, zoom, dpr, ...over(index) }));
        }
  return rows;
}

const cellLayout: CorpusLayout = { cases: 144, counts: { C1: 144 } };

function recordOf(
  rows: readonly RecordRow[],
  layout: CorpusLayout,
  extra: Partial<Parameters<typeof buildRecord>[0]> = {},
): EvidenceRecord {
  return buildRecord({
    run,
    provenance: { ...provenance, corpus: { ...provenance.corpus, cases: layout.cases } },
    gpu: { adapter: 'test', browser: 'test', passed: true },
    controls: allControls,
    rows,
    ...extra,
  });
}

// ---------------------------------------------------------------------------------------------

describe('statistics (section 7.3)', () => {
  it('nearest rank, as docs/benchmarks/README.md declares it', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(nearestRank(values, 99)).toBe(99);
    expect(nearestRank(values, 50)).toBe(50);
    expect(nearestRank([5, 6, 7], 99)).toBe(7);
    expect(nearestRank([], 50)).toBeNull();
  });
  it('group counts: measured is PASS and FAIL; the rest are counted apart', () => {
    const g = groupStats([
      row(0, { u: 0.1 }),
      row(1, { status: 'fail', u: null, l: 0.5 }),
      row(2, { status: 'undecided', reason: 'x', u: 0.2 }),
      row(3, { status: 'window-empty', u: null, l: null }),
      row(4, { status: 'rejected', rejection: { source: 'port-failed', code: 'work-limit' } }),
    ]);
    expect(g).toMatchObject({
      cases: 5,
      measured: 2,
      pass: 1,
      fail: 1,
      undecided: 1,
      windowEmpty: 1,
      rejected: 1,
      unbounded: 1,
    });
    expect(g.rejectedBySource).toEqual({ 'port-failed': 1 });
    expect(g.maxU).toEqual({ value: 0.2, id: 'C1/row2' });
    expect(g.maxL).toEqual({ value: 0.5, id: 'C1/row1' });
    expect(g.rejectionRate).toBeCloseTo(0.2);
  });
});

describe('verdict (section 7.3, E3-A9)', () => {
  it('PASS only when every measured case passes, the controls are met, the GPU check passed and every cell is covered', () => {
    const record = recordOf(cellRows(), cellLayout);
    expect(record.coverage).toMatchObject({ cells: 144, covered: 144 });
    expect(record.verdict.verdict).toBe('PASS');
    expect(validateRecord(record, cellLayout)).toEqual([]);
  });
  it('one FAIL fails A04', () => {
    const record = recordOf(
      cellRows((i) => (i === 7 ? { status: 'fail', u: null, l: 0.3 } : {})),
      cellLayout,
    );
    expect(record.verdict.verdict).toBe('FAIL');
  });
  it('an UNDECIDED case keeps A04 UNVERIFIED, never a pass (E3-Q5)', () => {
    const record = recordOf(
      cellRows((i) => (i === 3 ? { status: 'undecided', reason: 'straddles', u: 0.26 } : {})),
      cellLayout,
    );
    expect(record.verdict.verdict).toBe('UNVERIFIED');
    expect(record.verdict.reasons.join(' ')).toMatch(/UNDECIDED/u);
  });
  it('a declared cell with no measured case is UNVERIFIED (E3-A8)', () => {
    const rows = cellRows((i) =>
      i === 5 ? { status: 'rejected', rejection: { source: 'port-failed', code: 'work-limit' } } : {},
    );
    const record = recordOf(rows, cellLayout);
    expect(record.coverage.unverified).toHaveLength(1);
    expect(record.coverage.unverified[0]).toMatchObject({ paint: 'fill', transform: 'T0' });
    expect(record.verdict.verdict).toBe('UNVERIFIED');
    // A window-empty or undecided case does not cover its cell either.
    expect(buildCoverage([row(0, { status: 'window-empty' })]).covered).toBe(0);
  });
  it('a missing GPU model check, an unmet control or a missing control gives UNVERIFIED', () => {
    expect(recordOf(cellRows(), cellLayout, { gpu: null }).verdict.verdict).toBe('UNVERIFIED');
    const unmet = allControls.map((c, i) => (i === 2 ? { ...c, ok: false } : c));
    const a = recordOf(cellRows(), cellLayout, { controls: unmet });
    expect(a.verdict.verdict).toBe('UNVERIFIED');
    expect(a.verdict.reasons.join(' ')).toMatch(/controls not met: E3-PC3/u);
    const b = recordOf(cellRows(), cellLayout, { controls: allControls.slice(1) });
    expect(b.verdict.reasons.join(' ')).toMatch(/controls missing: E3-PC1/u);
    // E3-A5: before the controls are met no corpus result counts, not even a FAIL.
    const c = recordOf(
      cellRows((i) => (i === 0 ? { status: 'fail', u: null, l: 0.3 } : {})),
      cellLayout,
      { controls: unmet },
    );
    expect(c.verdict.verdict).toBe('UNVERIFIED');
  });
  it('a stride run is a SAMPLE and gives no verdict', () => {
    const rows = [row(0), row(25)];
    const layout: CorpusLayout = { cases: 50, counts: { C1: 50 } };
    const record = recordOf(rows, layout, { run: { ...run, stride: 25 } });
    expect(record.verdict.verdict).toBe('SAMPLE');
    expect(validateRecord(record, layout)).toEqual([]);
  });
});

describe('E3-A7 and E3-D10: the validator reconciles the record with the corpus', () => {
  const rows = cellRows((i) =>
    i % 40 === 3
      ? { status: 'rejected', rejection: { source: 'port-failed', code: 'work-limit' } }
      : {},
  );
  const record = recordOf(rows, cellLayout);

  it('accepts a record that reconciles', () => {
    expect(validateRecord(record, cellLayout)).toEqual([]);
    expect(record.rejections.length).toBeGreaterThan(0);
  });
  it('E3-D10: a rejected case silently dropped from the record is refused', () => {
    const dropped = record.cases.filter((r) => r.id !== record.rejections[0]!.id);
    // Even when the aggregates, rejection list and coverage are rebuilt from the shorter list.
    const rebuilt = recordOf(dropped, cellLayout);
    const problems = validateRecord(rebuilt, cellLayout);
    expect(problems.join('\n')).toMatch(/143 rows for 144 attempted cases/u);
    expect(problems.join('\n')).toMatch(/stratum C1: 143 rows, 144 attempted/u);
    // And when only the rows are cut from a finished record.
    const cut = { ...record, cases: dropped } as EvidenceRecord;
    expect(validateRecord(cut, cellLayout).join('\n')).toMatch(/aggregates do not match/u);
  });
  it('refuses tampered aggregates, a tampered verdict, duplicates and wrong strata', () => {
    const tampered = {
      ...record,
      aggregates: {
        ...record.aggregates,
        overall: { ...record.aggregates.overall, rejected: 0 },
      },
    } as EvidenceRecord;
    expect(validateRecord(tampered, cellLayout).join('\n')).toMatch(/aggregates do not match/u);
    const lie = { ...record, verdict: { verdict: 'PASS', reasons: ['x'] } } as EvidenceRecord;
    expect(validateRecord(lie, cellLayout).join('\n')).toMatch(/verdict does not follow/u);
    const twice = { ...record, cases: [record.cases[0]!, ...record.cases.slice(0, -1)] };
    expect(validateRecord(twice as EvidenceRecord, cellLayout).join('\n')).toMatch(/twice/u);
    const strata = recordOf(cellRows((i) => (i === 0 ? { stratum: 'C2' } : {})), cellLayout);
    expect(validateRecord(strata, cellLayout).join('\n')).toMatch(/is stratum C1, not C2/u);
  });
  it('refuses a dirty run, a status without its evidence, and a wrong corpus size', () => {
    const dirty = recordOf(cellRows(), cellLayout, {
      provenance: { ...provenance, dirty: true, corpus: { ...provenance.corpus, cases: 144 } },
    });
    expect(validateRecord(dirty, cellLayout).join('\n')).toMatch(/dirty run is not accepted/u);
    expect(validateRecord(dirty, cellLayout, { allowDirty: true })).toEqual([]);
    const lying = recordOf(cellRows((i) => (i === 1 ? { u: 0.3 } : {})), cellLayout);
    expect(validateRecord(lying, cellLayout).join('\n')).toMatch(/PASS without U <= 0.25/u);
    const noCode = recordOf(cellRows((i) => (i === 1 ? { status: 'rejected' } : {})), cellLayout);
    expect(validateRecord(noCode, cellLayout).join('\n')).toMatch(/rejected without a code/u);
    const small: CorpusLayout = { cases: 150, counts: { C1: 150 } };
    expect(validateRecord(record, small).join('\n')).toMatch(/corpus cases 144 != 150/u);
  });
  it('the corpus layout maps each index to its stratum, and strides to their counts', () => {
    const layout: CorpusLayout = { cases: 10, counts: { C1: 4, C2: 3, C3: 3 } };
    expect(STRATUM_ORDER.slice(0, 3)).toEqual(['C1', 'C2', 'C3']);
    expect([0, 3, 4, 6, 7, 9, 10].map((i) => stratumAt(layout, i))).toEqual([
      'C1',
      'C1',
      'C2',
      'C2',
      'C3',
      'C3',
      null,
    ]);
    expect(expectedPerStratum(layout, 1)).toMatchObject({ C1: 4, C2: 3, C3: 3, C4: 0 });
    // Indices 0, 3, 6, 9 for stride 3: C1 has 0 and 3, C2 has 6, C3 has 9.
    expect(expectedPerStratum(layout, 3)).toMatchObject({ C1: 2, C2: 1, C3: 1 });
  });
});

describe('the writer (section 7.4)', () => {
  const rows = cellRows();
  const record = recordOf(rows, cellLayout);
  const now = new Date('2026-10-23T12:34:56.789Z');

  it('writes record.json and record.md under <UTC stamp>-<run id> and round-trips the json', () => {
    const dir = writeEvidenceRecord(path.join(scratch, 'a'), record, cellLayout, now);
    expect(path.basename(dir)).toBe('20261023T123456Z-r1');
    const parsed = JSON.parse(readFileSync(path.join(dir, 'record.json'), 'utf8')) as unknown;
    expect(parsed).toEqual(JSON.parse(JSON.stringify(record)));
    expect(readFileSync(path.join(dir, 'record.md'), 'utf8')).toMatch(/Verdict as measured: \*\*PASS\*\*/u);
    expect(stringifyRecord(record).split('\n').length).toBeGreaterThan(rows.length);
  });
  it('refuses to replace an existing record', () => {
    const root = path.join(scratch, 'b');
    writeEvidenceRecord(root, record, cellLayout, now);
    expect(() => writeEvidenceRecord(root, record, cellLayout, now)).toThrow(/refusing to replace/u);
  });
  it('never writes a record that does not reconcile', () => {
    const root = path.join(scratch, 'c');
    const bad = { ...record, cases: record.cases.slice(1) } as EvidenceRecord;
    expect(() => writeEvidenceRecord(root, bad, cellLayout, now)).toThrow(RecordInvalid);
    expect(existsSync(root)).toBe(false);
  });
  it('refuses an unsafe run id', () => {
    const bad = { ...record, run: { ...record.run, id: '../x' } } as EvidenceRecord;
    expect(() => writeEvidenceRecord(path.join(scratch, 'd'), bad, cellLayout, now)).toThrow(
      /unsafe run id/u,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The freeze gate (section 5.5)

describe('freeze gate', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');

  function tree(name: string, mutate: (files: Record<string, string>) => void = () => {}) {
    const root = path.join(scratch, name);
    const files: Record<string, string> = {
      'tests/geometry/e3-a04/corpus.ts': 'generator',
      'packages/geometry-reference/src/a04-region.ts': 'oracle',
    };
    files['tests/geometry/e3-a04/corpus-v1.manifest.json'] = JSON.stringify({
      version: 'a04-corpus/v1',
      corpusSha256: sha('corpus'),
      cases: 1,
      counts: { C1: 1 },
      generator: { path: 'tests/geometry/e3-a04/corpus.ts', sha256: sha('generator') },
    });
    files[FREEZE_NOTE] = JSON.stringify({
      version: 'a04-corpus/v1',
      frozenOn: '2026-10-30',
      corpusSha256: sha('corpus'),
      generatorSha256: sha('generator'),
      oracleSha256: sha('oracle'),
      freezeCheck: { checked: 1, ok: 1, oracleWork: 0, oracleUnsupported: 0, oracleInconsistent: 0 },
    });
    mutate(files);
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    return root;
  }

  it('is frozen only when the note exists and still describes the files on disk', () => {
    expect(checkFreeze(tree('ok'))).toMatchObject({ frozen: true, problems: [] });
  });
  it('refuses without a freeze note', () => {
    const root = tree('none', (f) => {
      delete f[FREEZE_NOTE];
    });
    const r = checkFreeze(root);
    expect(r.frozen).toBe(false);
    expect(r.problems[0]).toMatch(/no freeze note/u);
  });
  it('refuses a drifted generator or oracle, a different corpus hash, or an unclean freeze check', () => {
    const drift = (name: string, file: string) =>
      checkFreeze(tree(name, (f) => void (f[file] = 'changed'))).problems.join('\n');
    expect(drift('g', 'tests/geometry/e3-a04/corpus.ts')).toMatch(/generator changed/u);
    expect(drift('o', 'packages/geometry-reference/src/a04-region.ts')).toMatch(/oracle changed/u);
    const other = checkFreeze(
      tree('c', (f) => {
        const note = JSON.parse(f[FREEZE_NOTE]!) as Record<string, unknown>;
        f[FREEZE_NOTE] = JSON.stringify({ ...note, corpusSha256: sha('else') });
      }),
    );
    expect(other.problems.join('\n')).toMatch(/corpusSha256 differs/u);
    const unclean = checkFreeze(
      tree('w', (f) => {
        const note = JSON.parse(f[FREEZE_NOTE]!) as Record<string, unknown>;
        f[FREEZE_NOTE] = JSON.stringify({
          ...note,
          freezeCheck: { checked: 5, ok: 4, oracleWork: 1, oracleUnsupported: 0, oracleInconsistent: 0 },
        });
      }),
    );
    expect(unclean.problems.join('\n')).toMatch(/ORACLE-WORK/u);
    const malformed = checkFreeze(tree('m', (f) => void (f[FREEZE_NOTE] = '{')));
    expect(malformed.frozen).toBe(false);
  });
  it.skipIf(existsSync(path.join(repo, FREEZE_NOTE)))(
    'without a freeze note in the repository the real gate refuses',
    () => {
      expect(checkFreeze(repo).frozen).toBe(false);
    },
  );
  it.skipIf(existsSync(path.join(repo, FREEZE_NOTE)))(
    'pnpm e3-a04:run refuses before it runs anything, with or without --stride',
    () => {
      for (const extra of [[], ['--stride', '25'], ['--sample', '25', '--shards', '2']]) {
        const result = spawnSync(process.execPath, ['tooling/run-e3-a04.mjs', ...extra], {
          cwd: repo,
          encoding: 'utf8',
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(/refuses to run: a04-corpus\/v1 is not frozen/u);
        expect(result.stderr).toMatch(/no freeze note/u);
      }
    },
  );
  it('the run mode of the vitest file refuses on its own without a freeze note', () => {
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'vitest.e3-a04-run.config.ts',
        '--reporter=dot',
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, E3_A04_RUN_MODE: 'controls', E3_A04_RUN_OUT: path.join(scratch, 'x') },
      },
    );
    if (existsSync(path.join(repo, FREEZE_NOTE))) return;
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/refusing to run on a04-corpus\/v1/u);
    expect(existsSync(path.join(scratch, 'x', 'controls.json'))).toBe(false);
  }, 120_000);
});
