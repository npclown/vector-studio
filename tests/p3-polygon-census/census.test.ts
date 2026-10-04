import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeOutput, type PackedPath } from '../../packages/geometry-wasm/src/abi.js';
import { encodeCase } from '../geometry/differential/index.js';
import {
  HISTORICAL_RECORDS,
  LIMITS,
  SCHEMA,
  appendJournalRow,
  assertAnalysisStable,
  assertCensusRow,
  assertExactKeys,
  captureAnalysis,
  describeJournal,
  expandWitnesses,
  finishMetadata,
  policy,
  readJournalRows,
  sha256,
  summarizeRows,
  writeIncomplete,
  writeJsonExclusive,
  type CensusRow,
  type CensusSummary,
  type FailureStage,
  type Mode,
} from './artifact.js';
import { auditEdges, auditExtractEdges } from './audit.js';
import { classifyEdges } from './classifier.js';
import { differentialCase, fullSources, type CensusSource } from '../p3-census/fixtures.js';
import { smokeFixtures } from './fixtures.js';
import {
  assertFrameEof,
  authenticateFrame,
  extractEdges,
  readInputFrame,
  readOutputFrame,
} from './transport.js';
import {
  RELATIONS,
  canonicalEdge,
  normalizedEdgeSha256,
  type CarriedPath,
  type Classification,
  type NormalizedPath,
} from './types.js';

const root = path.resolve(import.meta.dirname, '../..');
const outputDirectory = process.env.P3_POLYGON_OUTPUT ?? '';
const nativeDirectory = process.env.P3_POLYGON_NATIVE_DIR ?? '';
const runMode = process.env.P3_POLYGON_RUN_MODE;
const phase = process.env.P3_POLYGON_PHASE;
const historicalDirectory = path.join(root, 'docs/evidence/p3.2m2-cubic-readiness-2026-10-02');

type HistoricalRow = Readonly<{
  index: number;
  nodeId: string;
  requestId: number;
  sourceEpoch: number;
  sourceRevision: number;
  sourceSha256: string;
  inputFrameSha256: string;
  outputFrameSha256: string;
  emittedLines: number;
  implicitClosureEdges: 0 | 1;
  prospectiveEdges: number;
  maxDepth: number;
  depthHistogram: readonly number[];
  cubics: readonly Readonly<{ sourceVerbOrdinal: number; leaves: number }>[];
}>;

class ObservationFailure extends Error {
  constructor(
    readonly stage: FailureStage,
    readonly index: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ObservationFailure';
  }
}

function requiredEnvironment(): { mode: Mode; output: string } {
  if ((runMode !== 'SMOKE' && runMode !== 'FULL') || outputDirectory.length === 0)
    throw new Error('polygon census mode/output environment is missing');
  if (runMode === 'FULL' && nativeDirectory.length === 0)
    throw new Error('polygon census native directory is missing');
  return { mode: runMode, output: outputDirectory };
}

function hashFile(file: string, cap: number, exact?: number): string {
  const size = statSync(file).size;
  if (size > cap) throw new Error(`${path.basename(file)} exceeds its frozen byte cap`);
  if (exact !== undefined && size !== exact)
    throw new Error(`${path.basename(file)} byte length mismatch`);
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  const chunk = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function authenticateHistoricalRows(): readonly HistoricalRow[] {
  const records = [
    ['invocation.json', HISTORICAL_RECORDS.invocationSha256],
    ['census.json', HISTORICAL_RECORDS.censusSha256],
    ['rows.ndjson', HISTORICAL_RECORDS.rowsSha256],
    ['audit.json', HISTORICAL_RECORDS.auditSha256],
  ] as const;
  for (const [name, expected] of records) {
    const actual = hashFile(path.join(historicalDirectory, name), LIMITS.journalBytes);
    if (actual !== expected)
      throw new ObservationFailure('SOURCE', null, `historical ${name} SHA-256 mismatch`);
  }
  const lines = readFileSync(path.join(historicalDirectory, 'rows.ndjson'), 'utf8').split('\n');
  if (lines.at(-1) !== '')
    throw new ObservationFailure('SOURCE', null, 'historical rows lack terminal newline');
  lines.pop();
  if (lines.length !== 1000)
    throw new ObservationFailure('SOURCE', null, 'historical row count mismatch');
  return lines.map((line, index) => {
    const row = JSON.parse(line) as HistoricalRow;
    if (row.index !== index || row.nodeId !== `path-${index}`)
      throw new ObservationFailure('SOURCE', index, 'historical row order/identity mismatch');
    return row;
  });
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function packed(source: CensusSource): PackedPath {
  return {
    requestId: source.request.requestId,
    sourceEpoch: source.request.sourceEpoch,
    sourceRevision: source.request.sourceRevision,
    tolerance: 1 / 8,
    verbs: source.request.verbs,
    points: source.request.points,
  };
}

function sourceSha256(source: CensusSource): string {
  const scalarBytes = Buffer.alloc(source.request.points.length * 8);
  const view = new DataView(scalarBytes.buffer, scalarBytes.byteOffset, scalarBytes.byteLength);
  source.request.points.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return sha256(
    Buffer.concat([
      u32(source.request.verbs.length),
      source.request.verbs,
      u32(source.request.points.length),
      scalarBytes,
    ]),
  );
}

function checkHistoricalSource(
  source: CensusSource,
  recorded: HistoricalRow,
  index: number,
): Uint8Array<ArrayBuffer> {
  if (
    recorded.requestId !== source.request.requestId ||
    recorded.sourceEpoch !== source.request.sourceEpoch ||
    recorded.sourceRevision !== source.request.sourceRevision ||
    recorded.sourceSha256 !== sourceSha256(source)
  )
    throw new ObservationFailure(
      'SOURCE',
      index,
      'regenerated historical source identity mismatch',
    );
  const payload = encodeCase(differentialCase(source));
  if (payload.byteLength > LIMITS.inputFrameBytes)
    throw new ObservationFailure('INPUT', index, 'regenerated input frame exceeds 4096 bytes');
  return payload;
}

function validateDecoded(pathValue: CarriedPath, recorded: HistoricalRow, index: number): void {
  const lines = pathValue.verbs.length - 1;
  if (lines !== recorded.emittedLines || lines > LIMITS.rawEmitted)
    throw new ObservationFailure('ABI', index, 'historical emitted line count mismatch');
  const perSource = Array.from({ length: 32 }, () => 0);
  let maximumDepth = 0;
  const depthHistogram = Array.from({ length: 21 }, () => 0);
  for (let verb = 1; verb < pathValue.verbs.length; verb += 1) {
    const ordinal = pathValue.provenance[verb * 3]!;
    const depth = pathValue.provenance[verb * 3 + 2]!;
    if (ordinal < 1 || ordinal > 32 || depth > 7)
      throw new ObservationFailure('ABI', index, 'historical provenance exceeds frozen bounds');
    perSource[ordinal - 1]! += 1;
    if (perSource[ordinal - 1]! > 128)
      throw new ObservationFailure('ABI', index, 'historical source exceeds 128 emitted lines');
    depthHistogram[depth]! += 1;
    maximumDepth = Math.max(maximumDepth, depth);
  }
  if (
    recorded.cubics.length !== 32 ||
    recorded.cubics.some(
      (cubic, sourceIndex) =>
        cubic.sourceVerbOrdinal !== sourceIndex + 1 || cubic.leaves !== perSource[sourceIndex],
    ) ||
    recorded.maxDepth !== maximumDepth ||
    JSON.stringify(recorded.depthHistogram) !== JSON.stringify(depthHistogram)
  )
    throw new ObservationFailure('ABI', index, 'historical source partition/provenance mismatch');
}

function makeRow(
  index: number,
  nodeId: string,
  inputHash: string | null,
  outputHash: string | null,
  normalized: NormalizedPath,
  classification: Classification,
): CensusRow {
  if (
    normalized.rawEmitted !== normalized.omittedZero + normalized.retainedEmitted ||
    normalized.normalizedEdges !== normalized.retainedEmitted + normalized.closure ||
    classification.edges !== normalized.normalizedEdges ||
    classification.pairs !== (normalized.normalizedEdges * (normalized.normalizedEdges - 1)) / 2 ||
    classification.aabbRejected + classification.exactTested !== classification.pairs ||
    classification.peakCandidateRecords > normalized.normalizedEdges
  )
    throw new ObservationFailure('CLASSIFY', index, 'polygon classification arithmetic mismatch');
  const row: CensusRow = {
    index,
    nodeId,
    inputFrameSha256: inputHash,
    outputFrameSha256: outputHash,
    rawEmitted: normalized.rawEmitted,
    omittedZero: normalized.omittedZero,
    retainedEmitted: normalized.retainedEmitted,
    closure: normalized.closure,
    normalizedEdges: normalized.normalizedEdges,
    normalizedEdgeSha256: normalizedEdgeSha256(normalized.edges),
    classification,
    witnesses: expandWitnesses(normalized.edges, classification, canonicalEdge),
  };
  assertCensusRow(row, inputHash === null ? 'SMOKE' : 'FULL');
  return row;
}

function smokeRows(
  extractor: (path: CarriedPath) => NormalizedPath,
  classifier: (edges: NormalizedPath['edges']) => Classification,
): CensusRow[] {
  return smokeFixtures().map((fixture, index) => {
    let normalized: NormalizedPath;
    let classification: Classification;
    try {
      normalized = extractor(fixture.path);
      classification = classifier(normalized.edges);
    } catch (error) {
      throw new ObservationFailure('CLASSIFY', index, String(error));
    }
    const observed = {
      rawEmitted: normalized.rawEmitted,
      omittedZero: normalized.omittedZero,
      retainedEmitted: normalized.retainedEmitted,
      closure: normalized.closure,
      normalizedEdges: normalized.normalizedEdges,
      pairs: classification.pairs,
      counts: classification.counts,
      first: classification.first,
      aabbRejected: classification.aabbRejected,
      exactTested: classification.exactTested,
    };
    if (JSON.stringify(observed) !== JSON.stringify(fixture.expected))
      throw new ObservationFailure('CLASSIFY', index, `${fixture.id} literal expectation mismatch`);
    return makeRow(index, fixture.id, null, null, normalized, classification);
  });
}

function fullRows(
  extractor: (path: CarriedPath) => NormalizedPath,
  classifier: (edges: NormalizedPath['edges']) => Classification,
  onRow?: (row: CensusRow) => void,
): { rows: CensusRow[]; historical: Record<string, unknown> } {
  const recordedRows = authenticateHistoricalRows();
  const sources = fullSources();
  if (sources.length !== 1000)
    throw new ObservationFailure('SOURCE', null, 'regenerated source count mismatch');
  const inputPath = path.join(nativeDirectory, 'input.bin');
  const outputPath = path.join(nativeDirectory, 'output.bin');
  if (statSync(inputPath).size !== HISTORICAL_RECORDS.inputBytes)
    throw new ObservationFailure('INPUT', null, 'native input byte length mismatch');
  if (statSync(outputPath).size !== HISTORICAL_RECORDS.outputBytes)
    throw new ObservationFailure('OUTPUT', null, 'native output byte length mismatch');
  const input = openSync(inputPath, 'r');
  const output = openSync(outputPath, 'r');
  const inputHash = createHash('sha256');
  const outputHash = createHash('sha256');
  const rows: CensusRow[] = [];
  let inputBytes = 0;
  let outputBytes = 0;
  try {
    sources.forEach((source, index) => {
      const recorded = recordedRows[index]!;
      const regenerated = checkHistoricalSource(source, recorded, index);
      let inputFrame: ReturnType<typeof readInputFrame>;
      try {
        inputFrame = readInputFrame(input, inputBytes);
        authenticateFrame(inputFrame.frame, recorded.inputFrameSha256, 'native input frame');
        if (!Buffer.from(inputFrame.payload).equals(Buffer.from(regenerated)))
          throw new Error('native input regenerated bytes mismatch');
      } catch (error) {
        throw new ObservationFailure('INPUT', index, String(error));
      }
      inputBytes = inputFrame.totalBytes;
      inputHash.update(inputFrame.frame);

      let outputFrame: ReturnType<typeof readOutputFrame>;
      try {
        outputFrame = readOutputFrame(output, outputBytes);
        authenticateFrame(outputFrame.frame, recorded.outputFrameSha256, 'native output frame');
      } catch (error) {
        throw new ObservationFailure('OUTPUT', index, String(error));
      }
      outputBytes = outputFrame.totalBytes;
      outputHash.update(outputFrame.frame);
      if (outputFrame.status !== 0)
        throw new ObservationFailure('ABI', index, 'historical batch status is not OK');
      let decoded: ReturnType<typeof decodeOutput>;
      try {
        decoded = decodeOutput(outputFrame.payload, [packed(source)]);
      } catch (error) {
        throw new ObservationFailure('ABI', index, String(error));
      }
      const carried = decoded[0];
      if (!carried || carried.status !== 'OK')
        throw new ObservationFailure('ABI', index, 'historical path status is not OK');
      validateDecoded(carried, recorded, index);
      let normalized: NormalizedPath;
      let classification: Classification;
      try {
        normalized = extractor(carried);
        classification = classifier(normalized.edges);
      } catch (error) {
        throw new ObservationFailure('CLASSIFY', index, String(error));
      }
      if (
        normalized.rawEmitted !== recorded.emittedLines ||
        normalized.rawEmitted + recorded.implicitClosureEdges !== recorded.prospectiveEdges
      )
        throw new ObservationFailure('ABI', index, 'historical row edge arithmetic mismatch');
      const row = makeRow(
        index,
        recorded.nodeId,
        recorded.inputFrameSha256,
        recorded.outputFrameSha256,
        normalized,
        classification,
      );
      onRow?.(row);
      rows.push(row);
    });
    assertFrameEof(input, 'native input');
    assertFrameEof(output, 'native output');
  } finally {
    closeSync(input);
    closeSync(output);
  }
  if (
    inputBytes !== HISTORICAL_RECORDS.inputBytes ||
    outputBytes !== HISTORICAL_RECORDS.outputBytes
  )
    throw new ObservationFailure('OUTPUT', null, 'native stream framing byte total mismatch');
  const inputSha256 = inputHash.digest('hex');
  const outputSha256 = outputHash.digest('hex');
  return {
    rows,
    historical: { ...HISTORICAL_RECORDS, inputSha256, outputSha256 },
  };
}

function completeRun(mode: Mode, directory: string): void {
  const invocation = JSON.parse(
    readFileSync(path.join(directory, 'invocation.json'), 'utf8'),
  ) as Record<string, unknown>;
  let result: { rows: CensusRow[]; historical: Record<string, unknown> | null };
  if (mode === 'SMOKE') {
    const rows = smokeRows(extractEdges, classifyEdges);
    for (const row of rows) {
      try {
        appendJournalRow(directory, row);
      } catch (error) {
        throw new ObservationFailure('JOURNAL', row.index, String(error));
      }
    }
    result = { rows, historical: null };
  } else {
    result = fullRows(extractEdges, classifyEdges, (row) => {
      try {
        appendJournalRow(directory, row);
      } catch (error) {
        throw new ObservationFailure('JOURNAL', row.index, String(error));
      }
    });
  }
  const metadata = finishMetadata(root, invocation, result.historical);
  const analysis = metadata.analysis as Record<string, unknown>;
  const end = captureAnalysis(root);
  try {
    assertAnalysisStable(
      { head: analysis.head, dirty: analysis.dirty, manifestSha256: analysis.manifestStartSha256 },
      end,
      mode,
    );
    if (analysis.manifestStartSha256 !== analysis.manifestEndSha256)
      throw new Error('analysis terminal manifest mismatch');
  } catch (error) {
    throw new ObservationFailure('SOURCE', null, String(error));
  }
  writeJsonExclusive(path.join(directory, 'report.json'), {
    schema: SCHEMA,
    mode,
    completion: 'COMPLETE',
    metadata,
    policy: policy(mode),
    rows: describeJournal(directory),
    summary: summarizeRows(result.rows),
    failure: null,
  });
}

function auditSummary(rows: readonly CensusRow[]): CensusSummary {
  if (rows.length === 0) throw new Error('audit cannot summarize empty rows');
  const relationMap = () =>
    Object.fromEntries(RELATIONS.map((relation) => [relation, 0])) as CensusSummary['counts'];
  const totals = {
    rawEmitted: 0,
    omittedZero: 0,
    retainedEmitted: 0,
    closure: 0,
    normalizedEdges: 0,
    pairs: 0,
    aabbRejected: 0,
    exactTested: 0,
  };
  const counts = relationMap();
  const adjacent = relationMap();
  const nonadjacent = relationMap();
  const maxima = {
    normalizedEdges: { value: -1, index: 0 },
    pairs: { value: -1, index: 0 },
    exactTested: { value: -1, index: 0 },
    peakCandidateRecords: { value: -1, index: 0 },
  };
  const add = (left: number, right: number, label: string) => {
    const value = left + right;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`audit ${label} is not a safe count`);
    return value;
  };
  rows.forEach((row, index) => {
    if (row.index !== index) throw new Error('audit row order mismatch');
    totals.rawEmitted = add(totals.rawEmitted, row.rawEmitted, 'rawEmitted');
    totals.omittedZero = add(totals.omittedZero, row.omittedZero, 'omittedZero');
    totals.retainedEmitted = add(totals.retainedEmitted, row.retainedEmitted, 'retainedEmitted');
    totals.closure = add(totals.closure, row.closure, 'closure');
    totals.normalizedEdges = add(totals.normalizedEdges, row.normalizedEdges, 'normalizedEdges');
    totals.pairs = add(totals.pairs, row.classification.pairs, 'pairs');
    totals.aabbRejected = add(totals.aabbRejected, row.classification.aabbRejected, 'aabbRejected');
    totals.exactTested = add(totals.exactTested, row.classification.exactTested, 'exactTested');
    for (const relation of RELATIONS) {
      counts[relation] = add(counts[relation], row.classification.counts[relation], relation);
      adjacent[relation] = add(
        adjacent[relation],
        row.classification.adjacent[relation],
        `${relation} adjacent`,
      );
      nonadjacent[relation] = add(
        nonadjacent[relation],
        row.classification.nonadjacent[relation],
        `${relation} nonadjacent`,
      );
    }
    const values = {
      normalizedEdges: row.normalizedEdges,
      pairs: row.classification.pairs,
      exactTested: row.classification.exactTested,
      peakCandidateRecords: row.classification.peakCandidateRecords,
    };
    for (const key of Object.keys(maxima) as (keyof typeof maxima)[])
      if (values[key] > maxima[key].value) maxima[key] = { value: values[key], index };
  });
  return { rows: rows.length, ...totals, counts, adjacent, nonadjacent, maxima };
}

function semanticRow(row: CensusRow): unknown {
  const { peakCandidateRecords, ...classification } = row.classification;
  void peakCandidateRecords;
  return { ...row, classification };
}

function semanticSummary(summary: CensusSummary): unknown {
  const { peakCandidateRecords, ...maxima } = summary.maxima;
  void peakCandidateRecords;
  return { ...summary, maxima };
}

function validateAnalysisMetadata(value: unknown, terminal: boolean): Record<string, unknown> {
  const analysis = assertExactKeys(value, 'analysis metadata', [
    'head',
    'dirty',
    'nodeVersion',
    'manifest',
    'manifestStartSha256',
    'manifestEndSha256',
  ]);
  if (
    typeof analysis.head !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(analysis.head) ||
    typeof analysis.dirty !== 'boolean' ||
    analysis.nodeVersion !== 'v24.15.0' ||
    !Array.isArray(analysis.manifest) ||
    analysis.manifest.length === 0 ||
    typeof analysis.manifestStartSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(analysis.manifestStartSha256) ||
    (terminal
      ? analysis.manifestEndSha256 !== analysis.manifestStartSha256
      : analysis.manifestEndSha256 !== null)
  )
    throw new Error('analysis metadata identity mismatch');
  let prior = '';
  analysis.manifest.forEach((entry, index) => {
    const item = assertExactKeys(entry, `analysis manifest[${index}]`, ['path', 'sha256']);
    if (
      typeof item.path !== 'string' ||
      item.path <= prior ||
      typeof item.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(item.sha256)
    )
      throw new Error('analysis manifest entry mismatch');
    prior = item.path;
  });
  if (
    sha256(Buffer.from(JSON.stringify(analysis.manifest), 'utf8')) !== analysis.manifestStartSha256
  )
    throw new Error('analysis manifest digest mismatch');
  return analysis;
}

function auditRun(mode: Mode, directory: string): void {
  const reportFile = path.join(directory, 'report.json');
  const report = assertExactKeys(JSON.parse(readFileSync(reportFile, 'utf8')), 'report', [
    'schema',
    'mode',
    'completion',
    'metadata',
    'policy',
    'rows',
    'summary',
    'failure',
  ]);
  const recorded = readJournalRows(directory) as CensusRow[];
  recorded.forEach((row, index) => {
    assertCensusRow(row, mode);
    if (row.index !== index)
      throw new ObservationFailure('AUDIT', index, 'journal row order mismatch');
  });
  const replay =
    mode === 'SMOKE'
      ? { rows: smokeRows(auditExtractEdges, auditEdges), historical: null }
      : fullRows(auditExtractEdges, auditEdges);
  if (JSON.stringify(recorded.map(semanticRow)) !== JSON.stringify(replay.rows.map(semanticRow)))
    throw new ObservationFailure('AUDIT', null, 'independent row replay mismatch');
  const descriptor = describeJournal(directory);
  if (
    report.schema !== SCHEMA ||
    report.mode !== mode ||
    report.completion !== 'COMPLETE' ||
    report.failure !== null ||
    JSON.stringify(report.policy) !== JSON.stringify(policy(mode)) ||
    JSON.stringify(report.rows) !== JSON.stringify(descriptor) ||
    JSON.stringify(semanticSummary(report.summary as CensusSummary)) !==
      JSON.stringify(semanticSummary(auditSummary(replay.rows))) ||
    JSON.stringify(report.summary) !== JSON.stringify(summarizeRows(recorded))
  )
    throw new ObservationFailure('AUDIT', null, 'report terminal/schema/summary mismatch');
  const invocation = assertExactKeys(
    JSON.parse(readFileSync(path.join(directory, 'invocation.json'), 'utf8')),
    'invocation',
    ['schema', 'mode', 'metadata', 'policy'],
  );
  if (
    invocation.schema !== SCHEMA ||
    invocation.mode !== mode ||
    JSON.stringify(invocation.policy) !== JSON.stringify(policy(mode))
  )
    throw new ObservationFailure('AUDIT', null, 'invocation schema/mode/policy mismatch');
  const invocationMetadata = assertExactKeys(invocation.metadata, 'invocation metadata', [
    'historical',
    'analysis',
  ]);
  if (invocationMetadata.historical !== null)
    throw new ObservationFailure('AUDIT', null, 'invocation historical metadata must be null');
  const invocationAnalysis = validateAnalysisMetadata(invocationMetadata.analysis, false);
  const current = captureAnalysis(root);
  const reportMetadata = assertExactKeys(report.metadata, 'report metadata', [
    'historical',
    'analysis',
  ]);
  const reportAnalysis = validateAnalysisMetadata(reportMetadata.analysis, true);
  const expectedReportAnalysis = {
    ...invocationAnalysis,
    manifestEndSha256: invocationAnalysis.manifestStartSha256,
  };
  if (
    JSON.stringify(reportAnalysis) !== JSON.stringify(expectedReportAnalysis) ||
    current.head !== invocationAnalysis.head ||
    current.dirty !== invocationAnalysis.dirty ||
    JSON.stringify(current.manifest) !== JSON.stringify(invocationAnalysis.manifest) ||
    current.manifestSha256 !== invocationAnalysis.manifestStartSha256 ||
    (mode === 'FULL' && invocationAnalysis.dirty !== false) ||
    JSON.stringify(reportMetadata.historical) !== JSON.stringify(replay.historical)
  )
    throw new ObservationFailure('AUDIT', null, 'analysis source manifest drift');
  const peak = replay.rows.reduce<Readonly<{ value: number; index: number }> | null>(
    (maximum, row) =>
      maximum === null || row.classification.peakCandidateRecords > maximum.value
        ? { value: row.classification.peakCandidateRecords, index: row.index }
        : maximum,
    null,
  );
  writeJsonExclusive(path.join(directory, 'audit.json'), {
    schema: SCHEMA,
    status: 'PASS',
    reportSha256: sha256(readFileSync(reportFile)),
    rowsSha256: descriptor.sha256,
    rows: replay.rows.length,
    peakCandidateRecords: peak,
    failure: null,
  });
}

describe('P3 historical polygon relation census isolated worker', () => {
  it.skipIf(phase !== 'RUN')(
    'classifies analytic or authenticated historical carriers',
    () => {
      const environment = requiredEnvironment();
      try {
        completeRun(environment.mode, environment.output);
      } catch (error) {
        const failure = error instanceof ObservationFailure ? error : null;
        writeIncomplete(
          root,
          environment.output,
          failure?.stage ?? 'WORKER',
          String(error),
          failure?.index ?? null,
        );
        throw error;
      }
      expect(true).toBe(true);
    },
    900_000,
  );

  it.skipIf(phase !== 'AUDIT')(
    'independently extracts, classifies, and reconstructs every row',
    () => {
      const environment = requiredEnvironment();
      auditRun(environment.mode, environment.output);
      expect(true).toBe(true);
    },
    900_000,
  );
});
