import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseArguments,
  reserveOutput,
  validateNodeVersion,
  workerOutcome,
} from '../../tooling/run-p3-polygon-census.mjs';
import {
  SCHEMA,
  appendJournalRow,
  assertAnalysisStable,
  assertCensusRow,
  captureAnalysis,
  describeJournal,
  expandWitnesses,
  readExact,
  readJournalRows,
  sha256,
  summarizeRows,
  writeIncomplete,
  writeJsonExclusive,
  type CensusRow,
} from './artifact.js';
import { classifyEdges } from './classifier.js';
import {
  carriedSourceStartCarrier,
  emptyCounts,
  maximumCollapsedCarrier,
  signedZeroCarrier,
  smokeFixtures,
} from './fixtures.js';
import {
  assertFrameEof,
  authenticateFrame,
  extractEdges,
  readInputFrame,
  readOutputFrame,
} from './transport.js';
import { canonicalEdge, normalizedEdgeSha256, type CarriedPath } from './types.js';

const phase = process.env.P3_POLYGON_PHASE;
const root = path.resolve(import.meta.dirname, '../..');

function smokeRow(index = 0): CensusRow {
  const fixture = smokeFixtures()[0]!;
  const normalized = extractEdges(fixture.path);
  const classification = classifyEdges(normalized.edges);
  return {
    index,
    nodeId: fixture.id,
    inputFrameSha256: null,
    outputFrameSha256: null,
    rawEmitted: normalized.rawEmitted,
    omittedZero: normalized.omittedZero,
    retainedEmitted: normalized.retainedEmitted,
    closure: normalized.closure,
    normalizedEdges: normalized.normalizedEdges,
    normalizedEdgeSha256: normalizedEdgeSha256(normalized.edges),
    classification,
    witnesses: expandWitnesses(normalized.edges, classification, canonicalEdge),
  };
}

describe.skipIf(phase === 'RUN' || phase === 'AUDIT')('P3 polygon census mechanics', () => {
  it('normalizes signed zero and source boundaries from the actual carried point', () => {
    const normalized = extractEdges(signedZeroCarrier());
    expect({
      rawEmitted: normalized.rawEmitted,
      omittedZero: normalized.omittedZero,
      retainedEmitted: normalized.retainedEmitted,
      closure: normalized.closure,
      normalizedEdges: normalized.normalizedEdges,
      rawIndices: normalized.edges.map((edge) => edge.rawIndex),
    }).toEqual({
      rawEmitted: 5,
      omittedZero: 2,
      retainedEmitted: 3,
      closure: 0,
      normalizedEdges: 3,
      rawIndices: [1, 3, 4],
    });
    expect(Object.is(normalized.edges[0]!.start[0], 0)).toBe(true);
    expect(Object.is(normalized.edges[0]!.start[1], -0)).toBe(true);
    const signedClassification = classifyEdges(normalized.edges);
    const counts = emptyCounts();
    counts.ENDPOINT_TOUCH = 3;
    const nonadjacent = emptyCounts();
    expect(signedClassification.counts).toEqual(counts);
    expect(signedClassification.adjacent).toEqual(counts);
    expect(signedClassification.nonadjacent).toEqual(nonadjacent);
    expect(signedClassification.first).toEqual({
      DISJOINT: null,
      PROPER_CROSSING: null,
      ENDPOINT_TOUCH: [0, 1],
      T_JUNCTION: null,
      COLLINEAR_POINT: null,
      COINCIDENT_SAME: null,
      COINCIDENT_REVERSED: null,
      COLLINEAR_OVERLAP: null,
    });

    const carried = extractEdges(carriedSourceStartCarrier());
    expect(carried.edges[1]!.start).toEqual([1, 0]);
    expect(carried.edges[1]!.start).toEqual(carried.edges[0]!.end);
    const carriedClassification = classifyEdges(carried.edges);
    expect(carriedClassification.counts).toEqual(counts);
    expect(carriedClassification.adjacent).toEqual(counts);
    expect(carriedClassification.nonadjacent).toEqual(nonadjacent);
    expect(carriedClassification.first).toEqual(signedClassification.first);
  });

  it('accepts the exact raw/provenance cap before inspecting any excess item', () => {
    const carrier = maximumCollapsedCarrier();
    for (const [command, source, numerator] of [
      [1, 1, 1],
      [128, 1, 128],
      [129, 2, 1],
      [256, 2, 128],
      [3969, 32, 1],
      [4096, 32, 128],
    ] as const) {
      expect(Array.from(carrier.provenance.slice(command * 3, command * 3 + 3))).toEqual([
        source,
        numerator,
        7,
      ]);
    }
    const normalized = extractEdges(carrier);
    expect(normalized).toEqual({
      edges: [],
      rawEmitted: 4096,
      omittedZero: 4096,
      retainedEmitted: 0,
      closure: 0,
      normalizedEdges: 0,
    });
  });

  it('rejects malformed cardinality, provenance, nonfinite values, and caps with literal errors', () => {
    const valid = smokeFixtures()[0]!.path;
    const cases: readonly [CarriedPath, string][] = [
      [{ ...valid, points: valid.points.slice(0, -1) }, 'carried point cardinality mismatch'],
      [
        { ...valid, provenance: valid.provenance.slice(0, -1) },
        'carried provenance cardinality mismatch',
      ],
      [{ ...valid, verbs: Uint8Array.of(1, 1, 1, 1) }, 'carried path must begin with MOVE'],
      [
        { ...valid, points: Float64Array.of(0, 0, 2, 0, Number.NaN, 2, 0, 0) },
        'carried path contains a nonfinite point',
      ],
    ];
    for (const [carrier, message] of cases) expect(() => extractEdges(carrier)).toThrow(message);
    const badPartition = carriedSourceStartCarrier();
    badPartition.provenance.set([2, 1, 0], 3);
    badPartition.provenance.set([1, 1, 0], 6);
    expect(() => extractEdges(badPartition)).toThrow('LINE source ordinals are not partitioned');
    const badDepth = carriedSourceStartCarrier();
    badDepth.provenance[5] = 8;
    expect(() => extractEdges(badDepth)).toThrow('LINE provenance outside frozen bounds');
    const overCap = new Uint8Array(4098);
    overCap[0] = 0;
    overCap.fill(255, 1);
    expect(() =>
      extractEdges({ verbs: overCap, points: new Float64Array(0), provenance: new Uint32Array(0) }),
    ).toThrow('raw emitted line cap exceeded');
  });

  it('describes a partial journal without truncating its complete fsynced prefix', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'p3-polygon-partial-'));
    const complete = `${JSON.stringify(smokeRow())}\n`;
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
    expect(() => readJournalRows(directory)).toThrow('journal has a partial tail');
    expect(readFileSync(path.join(directory, 'rows.ndjson'), 'utf8')).toBe(complete + tail);
  });

  it('rejects row schema additions and every frozen arithmetic corruption', () => {
    const row = smokeRow();
    expect(() => assertCensusRow(row, 'SMOKE')).not.toThrow();
    expect(() => assertCensusRow({ ...row, extra: true }, 'SMOKE')).toThrow(
      'polygon row keys mismatch',
    );
    expect(() => assertCensusRow({ ...row, rawEmitted: 4097 }, 'SMOKE')).toThrow(
      'normalization exceeds frozen bounds',
    );
    expect(() => assertCensusRow({ ...row, omittedZero: 1 }, 'SMOKE')).toThrow(
      'normalization arithmetic mismatch',
    );
    expect(() =>
      assertCensusRow(
        { ...row, classification: { ...row.classification, exactTested: 0 } },
        'SMOKE',
      ),
    ).toThrow('classification arithmetic mismatch');
    expect(() =>
      assertCensusRow(
        {
          ...row,
          classification: {
            ...row.classification,
            counts: { ...row.classification.counts, EXTRA: 0 },
          },
        },
        'SMOKE',
      ),
    ).toThrow('classification.counts keys mismatch');
    expect(() =>
      assertCensusRow(
        { ...row, witnesses: { ...row.witnesses, DISJOINT: { pair: [0, 1] } } },
        'SMOKE',
      ),
    ).toThrow('row.witnesses.DISJOINT must be null');
  });

  it('summarizes safe totals and keeps earliest maxima ties', () => {
    const first = smokeRow(0);
    const second = { ...smokeRow(1), nodeId: 'smoke/triangle-copy' };
    const summary = summarizeRows([first, second]);
    expect(summary.rows).toBe(2);
    expect(summary.pairs).toBe(6);
    expect(summary.counts.ENDPOINT_TOUCH).toBe(6);
    expect(summary.maxima.normalizedEdges).toEqual({ value: 3, index: 0 });
    expect(summary.maxima.pairs).toEqual({ value: 3, index: 0 });
  });

  it('preserves existing artifacts, rejects oversized rows, and publishes incomplete prefixes', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'p3-polygon-exclusive-'));
    const terminal = path.join(directory, 'report.json');
    writeJsonExclusive(terminal, { retained: true });
    expect(() => writeJsonExclusive(terminal, { retained: false })).toThrow();
    expect(JSON.parse(readFileSync(terminal, 'utf8'))).toEqual({ retained: true });
    expect(() => appendJournalRow(directory, { payload: 'x'.repeat(65_536) })).toThrow(
      'row exceeds 64 KiB',
    );
    const preexisting = mkdtempSync(path.join(os.tmpdir(), 'p3-polygon-preexisting-'));
    writeFileSync(path.join(preexisting, 'rows.ndjson'), '', 'utf8');
    expect(() => appendJournalRow(preexisting, smokeRow())).toThrow(
      'journal already exists before exclusive creation',
    );
    const changedLength = mkdtempSync(path.join(os.tmpdir(), 'p3-polygon-length-'));
    appendJournalRow(changedLength, smokeRow());
    writeFileSync(path.join(changedLength, 'rows.ndjson'), 'tamper', { flag: 'a' });
    expect(() => appendJournalRow(changedLength, smokeRow(1))).toThrow(
      'journal length changed during execution',
    );

    const incomplete = mkdtempSync(path.join(os.tmpdir(), 'p3-polygon-incomplete-'));
    writeJsonExclusive(path.join(incomplete, 'invocation.json'), {
      schema: SCHEMA,
      mode: 'SMOKE',
      metadata: { retained: true },
      policy: { retained: true },
    });
    appendJournalRow(incomplete, smokeRow());
    writeIncomplete(
      path.join(incomplete, 'missing-root'),
      incomplete,
      'SOURCE',
      'literal original failure',
      0,
    );
    const report = JSON.parse(readFileSync(path.join(incomplete, 'report.json'), 'utf8')) as {
      completion: string;
      summary: unknown;
      rows: { count: number };
      failure: { stage: string; message: string; index: number | null };
    };
    expect(report.completion).toBe('INCOMPLETE');
    expect(report.summary).toBeNull();
    expect(report.rows.count).toBe(1);
    expect(report.failure).toEqual(expect.objectContaining({ stage: 'SOURCE', index: 0 }));
    expect(report.failure.message).toContain('literal original failure');
    expect(report.failure.message).toContain('analysis end capture failed');
  });

  it('rejects truncated frame reads and strict CLI variants before worker work', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'p3-polygon-frame-'));
    const file = path.join(directory, 'frame.bin');
    writeFileSync(file, Buffer.from([1, 2, 3]));
    const fd = openSync(file, 'r');
    try {
      expect(() => readExact(fd, 4, 'literal frame')).toThrow('truncated literal frame');
    } finally {
      closeSync(fd);
    }
    expect(parseArguments(['--smoke'])).toEqual({
      mode: 'SMOKE',
      nativeDirectory: null,
      requested: null,
    });
    expect(parseArguments(['--full', '--native-dir', 'native', '--output', '.tools/out'])).toEqual({
      mode: 'FULL',
      nativeDirectory: 'native',
      requested: '.tools/out',
    });
    for (const args of [
      [],
      ['--full'],
      ['--smoke', '--output', 'x'],
      ['--full', '--output', 'x', '--native-dir', 'n'],
    ])
      expect(() => parseArguments(args)).toThrow('Expected exactly --smoke or --full');
  });

  it('enforces framing caps before payload allocation, authenticates bytes, and rejects trailing data', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'p3-polygon-framing-'));
    const inputFile = path.join(directory, 'input.bin');
    const input = Buffer.alloc(7);
    input.writeUInt32LE(2, 0);
    input.set([7, 8], 4);
    input[6] = 9;
    writeFileSync(inputFile, input);
    let fd = openSync(inputFile, 'r');
    try {
      const frame = readInputFrame(fd, 0);
      expect([...frame.payload]).toEqual([7, 8]);
      expect(() => authenticateFrame(frame.frame, '0'.repeat(64), 'literal input frame')).toThrow(
        'literal input frame SHA-256 mismatch',
      );
      expect(() => assertFrameEof(fd, 'literal input')).toThrow('trailing literal input frame');
    } finally {
      closeSync(fd);
    }

    const oversizedInput = path.join(directory, 'oversized-input.bin');
    const inputPrefix = Buffer.alloc(4);
    inputPrefix.writeUInt32LE(4097);
    writeFileSync(oversizedInput, inputPrefix);
    fd = openSync(oversizedInput, 'r');
    try {
      expect(() => readInputFrame(fd, 0)).toThrow('native input frame exceeds 4096 bytes');
    } finally {
      closeSync(fd);
    }

    const oversizedOutput = path.join(directory, 'oversized-output.bin');
    const outputPrefix = Buffer.alloc(8);
    outputPrefix.writeUInt32LE(0, 0);
    outputPrefix.writeUInt32LE(262145, 4);
    writeFileSync(oversizedOutput, outputPrefix);
    fd = openSync(oversizedOutput, 'r');
    try {
      expect(() => readOutputFrame(fd, 0)).toThrow('native output frame exceeds 256 KiB');
    } finally {
      closeSync(fd);
    }
  });

  it('requires Node 24.15.0 and a successful isolated worker result', () => {
    expect(() => validateNodeVersion('24.15.0')).not.toThrow();
    expect(() => validateNodeVersion('24.14.0')).toThrow('Node 24.15.0 is required');
    expect(() => workerOutcome({ status: 0 }, 'literal worker')).not.toThrow();
    expect(() => workerOutcome({ status: 1 }, 'literal worker')).toThrow(
      'literal worker failed (1)',
    );
    expect(() => workerOutcome({ status: null, signal: 'SIGTERM' }, 'literal worker')).toThrow(
      'SIGTERM',
    );
    expect(() =>
      workerOutcome({ status: null, error: new Error('literal spawn failure') }, 'literal worker'),
    ).toThrow('literal spawn failure');
  });

  it('rejects existing and aliased FULL output before creating a directory', () => {
    const activeOutput = process.env.P3_POLYGON_OUTPUT;
    if (activeOutput)
      expect(() => reserveOutput('FULL', path.relative(root, activeOutput))).toThrow(
        'already exists',
      );
    const child = path.join(root, '.tools', `p3-alias-control-${process.pid}`);
    expect(existsSync(child)).toBe(false);
    expect(() =>
      reserveOutput('FULL', path.relative(root, child), path.join(root, '.tools')),
    ).toThrow('must not overlap the native input directory');
    expect(existsSync(child)).toBe(false);
  });

  it('uses the captured analysis identity to reject manifest, HEAD, and dirty drift', () => {
    const current = captureAnalysis(root);
    expect(() => assertAnalysisStable(current, current, 'SMOKE')).not.toThrow();
    expect(() =>
      assertAnalysisStable(current, { ...current, manifestSha256: '0'.repeat(64) }, 'SMOKE'),
    ).toThrow('analysis source changed during execution');
    expect(() =>
      assertAnalysisStable(current, { ...current, head: '0'.repeat(40) }, 'SMOKE'),
    ).toThrow('analysis source changed during execution');
    expect(() =>
      assertAnalysisStable({ ...current, dirty: true }, { ...current, dirty: true }, 'FULL'),
    ).toThrow('FULL analysis source must remain clean');
  });
});
