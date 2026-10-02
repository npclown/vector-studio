import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertToolchainPresent,
  reserveOutput,
  validateToolchainIdentity,
  workerOutcome,
} from '../../tooling/run-p3-cubic-census.mjs';
import {
  SCHEMA,
  appendJournalRow,
  describeJournal,
  readExact,
  readJournalRows,
  sha256,
  writeIncomplete,
  writeJsonExclusive,
} from './artifact.mjs';
import { assertRowShape, summarizeRows, type CensusRow } from './schema.js';

const phase = process.env.P3_CENSUS_PHASE;
const root = path.resolve(import.meta.dirname, '../..');

function row(index: number, cells: number, rational: readonly [string, string]): CensusRow {
  return {
    index,
    nodeId: `row-${index}`,
    requestId: index + 1,
    sourceEpoch: 1,
    sourceRevision: 1,
    sourceSha256: 'a'.repeat(64),
    inputFrameSha256: 'b'.repeat(64),
    outputFrameSha256: 'c'.repeat(64),
    batchStatus: 0,
    pathStatus: 0,
    abiVerified: true,
    sourceCaps: {
      verbs: 2,
      scalars: 8,
      maxVerbs: 24,
      maxScalars: 104,
      verdict: 'WITHIN_CHEAP_CAPS',
    },
    emittedLines: 1,
    implicitClosureEdges: 1,
    prospectiveEdges: 2,
    maxDepth: 0,
    depthHistogram: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    cubics: [
      {
        sourceVerbOrdinal: 1,
        leaves: 1,
        boundary: {
          status: 'CERTIFIED',
          cells,
          finding: null,
          maxCertifiedSquared: { numerator: rational[0], denominator: rational[1] },
        },
      },
    ],
    preparation: { status: 'PREPARED', finding: null },
    prospectivePairs: 1,
    pairStage: 'NOT_EVALUATED',
  };
}

describe.skipIf(phase === 'RUN' || phase === 'AUDIT')('P3 census schema mechanics', () => {
  it('derives deterministic counts, exact rational maxima, and first ties', () => {
    const summary = summarizeRows([row(0, 3, ['1', '128']), row(1, 3, ['1', '128'])]);
    expect(summary.rows).toBe(2);
    expect(summary.boundaryStatusCounts).toEqual({ CERTIFIED: 2 });
    expect(summary.boundaryCells).toEqual({
      total: 6,
      max: { value: 3, index: 0, sourceVerbOrdinal: 1 },
    });
    expect(summary.maxCertifiedSquared).toEqual({
      value: { numerator: '1', denominator: '128' },
      index: 0,
      sourceVerbOrdinal: 1,
    });
    expect(summary.prospectivePairs).toEqual({ total: 2, max: { value: 1, index: 0 } });
  });

  it('describes the whole journal and its complete prefix without truncating a tail', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'p3-census-mechanics-'));
    const complete = `${JSON.stringify(row(0, 1, ['0', '1']))}\n`;
    const tail = '{"partial":';
    writeFileSync(path.join(directory, 'rows.ndjson'), complete + tail, 'utf8');
    expect(describeJournal(directory)).toEqual({
      path: 'rows.ndjson',
      sha256: sha256(Buffer.from(complete + tail)),
      bytes: Buffer.byteLength(complete + tail),
      count: 1,
      completePrefix: {
        bytes: Buffer.byteLength(complete),
        count: 1,
        sha256: sha256(Buffer.from(complete)),
      },
    });
    expect(() => readJournalRows(directory)).toThrow('partial tail');
    expect(readFileSync(path.join(directory, 'rows.ndjson'), 'utf8')).toBe(complete + tail);
  });

  it('rejects missing, extra, and inconsistent fixed row fields', () => {
    const valid = row(0, 1, ['0', '1']);
    expect(() => assertRowShape(valid)).not.toThrow();
    expect(() => assertRowShape({ ...valid, extra: 1 })).toThrow('keys mismatch');
    expect(() => assertRowShape({ ...valid, abiVerified: false })).toThrow('fixed status');
    expect(() => assertRowShape({ ...valid, depthHistogram: [1] })).toThrow('histogram');
    expect(() => assertRowShape({ ...valid, maxDepth: 8 })).toThrow('maxDepth');
    expect(() => assertRowShape({ ...valid, emittedLines: 4097 })).toThrow('emittedLines');
    expect(() =>
      assertRowShape({ ...valid, cubics: Array.from({ length: 33 }, () => valid.cubics[0]!) }),
    ).toThrow('cubics');
    expect(() =>
      assertRowShape({
        ...valid,
        cubics: [{ ...valid.cubics[0]!, leaves: 129 }],
      }),
    ).toThrow('cubic leaves');
    expect(() =>
      assertRowShape({
        ...valid,
        cubics: [
          {
            ...valid.cubics[0]!,
            boundary: {
              ...valid.cubics[0]!.boundary,
              cells: 1_048_577,
            },
          },
        ],
      }),
    ).toThrow('boundary cells');
    expect(() =>
      assertRowShape({
        ...valid,
        cubics: [
          {
            ...valid.cubics[0]!,
            boundary: {
              ...valid.cubics[0]!.boundary,
              maxCertifiedSquared: { numerator: '1', denominator: '32' },
            },
          },
        ],
      }),
    ).toThrow('exceeds tolerance');
    expect(() =>
      assertRowShape({
        ...valid,
        cubics: [
          {
            ...valid.cubics[0]!,
            boundary: {
              ...valid.cubics[0]!.boundary,
              status: 'WORK_LIMIT',
            },
          },
        ],
      }),
    ).toThrow('certificate');
    expect(() =>
      assertRowShape({
        ...valid,
        cubics: [
          {
            ...valid.cubics[0]!,
            boundary: {
              status: 'WORK_LIMIT',
              cells: 1,
              finding: '',
              maxCertifiedSquared: null,
            },
          },
        ],
      }),
    ).toThrow('no finding');
  });

  it('preserves an existing artifact and rejects an oversized journal row', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'p3-census-exclusive-'));
    const terminal = path.join(directory, 'census.json');
    writeJsonExclusive(terminal, { retained: true });
    expect(() => writeJsonExclusive(terminal, { retained: false })).toThrow();
    expect(JSON.parse(readFileSync(terminal, 'utf8'))).toEqual({ retained: true });
    expect(() => appendJournalRow(directory, { payload: 'x'.repeat(64 * 1024) })).toThrow('64 KiB');
    writeFileSync(
      path.join(directory, 'rows.ndjson'),
      `${JSON.stringify({ payload: 'x'.repeat(64 * 1024) })}\n`,
      'utf8',
    );
    expect(() => readJournalRows(directory)).toThrow('64 KiB');
  });

  it('publishes a terminal incomplete prefix when end-source capture fails', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'p3-census-incomplete-'));
    writeJsonExclusive(path.join(directory, 'invocation.json'), {
      schema: SCHEMA,
      mode: 'SMOKE',
      metadata: { retained: true },
      policy: { retained: true },
    });
    appendJournalRow(directory, row(0, 1, ['0', '1']));
    writeIncomplete(
      path.join(directory, 'missing-source-root'),
      directory,
      'SOURCE',
      'original failure',
      0,
    );
    const terminal = JSON.parse(readFileSync(path.join(directory, 'census.json'), 'utf8')) as {
      completion: string;
      summary: unknown;
      rows: { count: number };
      failure: { message: string; index: number | null };
    };
    expect(terminal.completion).toBe('INCOMPLETE');
    expect(terminal.summary).toBeNull();
    expect(terminal.rows.count).toBe(1);
    expect(terminal.failure.index).toBe(0);
    expect(terminal.failure.message).toContain('original failure');
    expect(terminal.failure.message).toContain('source end capture failed');
  });

  it('rejects a truncated framed read without inventing bytes', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'p3-census-truncated-'));
    const file = path.join(directory, 'native.bin');
    writeFileSync(file, Buffer.from([1, 2, 3]));
    const fd = openSync(file, 'r');
    try {
      expect(() => readExact(fd, 4)).toThrow('truncated framed native output');
    } finally {
      closeSync(fd);
    }
  });

  it('rejects unknown and mixed CLI modes before toolchain or geometry work', () => {
    for (const args of [[], ['--unknown'], ['--smoke', '--output', 'x'], ['--full']]) {
      const result = spawnSync(
        process.execPath,
        [path.join(root, 'tooling/run-p3-cubic-census.mjs'), ...args],
        { cwd: root, encoding: 'utf8', timeout: 10_000 },
      );
      expect(result.status, args.join(' ')).not.toBe(0);
      expect(result.stderr).toContain('Expected exactly --smoke or --full');
    }
  });

  it('requires the complete pinned toolchain identity and successful worker outcome', () => {
    const identity = {
      nodeVersion: '24.15.0',
      release: '1.94.1',
      commit: 'e408947bfd200af42db322daf0fadfe7e26d3bd1',
      host: 'x86_64-pc-windows-msvc',
    };
    expect(validateToolchainIdentity(identity)).toEqual({
      release: identity.release,
      commit: identity.commit,
      host: identity.host,
    });
    for (const [key, value] of [
      ['nodeVersion', undefined],
      ['release', '1.94.0'],
      ['commit', '0'.repeat(40)],
      ['host', 'aarch64-pc-windows-msvc'],
    ] as const) {
      expect(() => validateToolchainIdentity({ ...identity, [key]: value })).toThrow();
    }
    expect(() => assertToolchainPresent(path.join(os.tmpdir(), 'missing-p3-rustup.exe'))).toThrow(
      'missing',
    );
    expect(() => workerOutcome({ status: 0 }, 'mechanics')).not.toThrow();
    expect(() => workerOutcome({ status: 1 }, 'mechanics')).toThrow('failed');
    expect(() => workerOutcome({ status: null, signal: 'SIGTERM' }, 'mechanics')).toThrow(
      'SIGTERM',
    );
    expect(() =>
      workerOutcome({ status: null, error: new Error('spawn failed') }, 'mechanics'),
    ).toThrow('spawn failed');
  });

  it('rejects existing and out-of-tree FULL output destinations', () => {
    const activeOutput = process.env.P3_CENSUS_OUTPUT;
    expect(activeOutput).toBeTruthy();
    expect(() => reserveOutput('FULL', path.relative(root, activeOutput!))).toThrow(
      'already exists',
    );
    expect(() => reserveOutput('FULL', path.join(root, 'p3-census-outside'))).toThrow(
      'below repository .tools',
    );
  });
});
