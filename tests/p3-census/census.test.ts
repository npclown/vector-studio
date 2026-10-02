import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  Cubic,
  Point,
  ReferenceFlattenedLine,
} from '../../packages/geometry-reference/src/index.js';
import { decodeOutput, type PackedPath } from '../../packages/geometry-wasm/src/abi.js';
import { certifyCubicBoundary } from '../geometry/cubic-boundary/oracle.js';
import { encodeCase, verifyCase } from '../geometry/differential/index.js';
import { inspectCubicPreparation } from '../geometry/simple-cubic-topology/oracle.js';
import {
  SCHEMA,
  appendJournalRow,
  captureSource,
  describeJournal,
  finishMetadata,
  policy,
  readExact,
  readJournalRows,
  sha256,
  writeIncomplete,
  writeJsonExclusive,
} from './artifact.mjs';
import type { CensusFailureStage } from './artifact.mjs';
import { differentialCase, fullSources, smokeSources, type CensusSource } from './fixtures.js';
import { assertRowShape, serializeBoundary, summarizeRows, type CensusRow } from './schema.js';

const root = path.resolve(import.meta.dirname, '../..');
const outputDirectory = process.env.P3_CENSUS_OUTPUT ?? '';
const mode = process.env.P3_CENSUS_RUN_MODE;
const phase = process.env.P3_CENSUS_PHASE;
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const bridge = 'engine::native_differential::run_framed_inputs';

class CensusFailure extends Error {
  constructor(
    readonly stage: CensusFailureStage,
    readonly index: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'CensusFailure';
  }
}

type Invocation = Readonly<{
  schema: string;
  mode: 'SMOKE' | 'FULL';
  metadata: Record<string, unknown>;
  policy: Record<string, unknown>;
}>;

function exactObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort()))
    throw new Error(`${label} keys mismatch`);
  return record;
}

function validateMetadata(value: unknown, label: string, terminal: boolean): void {
  const metadata = exactObject(value, label, ['source', 'nodeVersion', 'rust', 'executionRole']);
  if (metadata.nodeVersion !== 'v24.15.0' || metadata.executionRole !== 'NATIVE_ONLY')
    throw new Error(`${label} execution identity mismatch`);
  const rust = exactObject(metadata.rust, `${label}.rust`, ['release', 'commit', 'host']);
  if (
    rust.release !== '1.94.1' ||
    rust.commit !== 'e408947bfd200af42db322daf0fadfe7e26d3bd1' ||
    rust.host !== 'x86_64-pc-windows-msvc'
  )
    throw new Error(`${label} Rust identity mismatch`);
  const source = exactObject(metadata.source, `${label}.source`, [
    'head',
    'dirty',
    'manifest',
    'manifestStartSha256',
    'manifestEndSha256',
  ]);
  if (
    typeof source.head !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(source.head) ||
    typeof source.dirty !== 'boolean' ||
    typeof source.manifestStartSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(source.manifestStartSha256) ||
    (terminal
      ? typeof source.manifestEndSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(source.manifestEndSha256)
      : source.manifestEndSha256 !== null) ||
    !Array.isArray(source.manifest) ||
    source.manifest.length === 0 ||
    (terminal && source.manifestEndSha256 !== source.manifestStartSha256)
  )
    throw new Error(`${label} source identity mismatch`);
  let prior = '';
  source.manifest.forEach((entry, index) => {
    const item = exactObject(entry, `${label}.source.manifest[${index}]`, ['path', 'sha256']);
    if (
      typeof item.path !== 'string' ||
      item.path.length === 0 ||
      item.path <= prior ||
      typeof item.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(item.sha256)
    )
      throw new Error(`${label} source manifest entry mismatch`);
    prior = item.path;
  });
  if (source.manifestStartSha256 !== sha256(Buffer.from(JSON.stringify(source.manifest), 'utf8')))
    throw new Error(`${label} source manifest digest mismatch`);
}

function validateInvocation(value: unknown, modeValue: 'SMOKE' | 'FULL'): Invocation {
  const invocation = exactObject(value, 'invocation', ['metadata', 'mode', 'policy', 'schema']);
  if (
    invocation.schema !== SCHEMA ||
    invocation.mode !== modeValue ||
    JSON.stringify(invocation.policy) !== JSON.stringify(policy(modeValue))
  )
    throw new Error('invocation identity mismatch');
  validateMetadata(invocation.metadata, 'invocation.metadata', false);
  const source = (invocation.metadata as Record<string, unknown>).source as Record<string, unknown>;
  if (modeValue === 'FULL' && source.dirty !== false)
    throw new Error('FULL invocation source must be clean');
  return invocation as Invocation;
}

function requiredEnvironment(): { mode: 'SMOKE' | 'FULL'; output: string } {
  if ((mode !== 'SMOKE' && mode !== 'FULL') || outputDirectory.length === 0)
    throw new Error('census mode/output environment is missing');
  return { mode, output: outputDirectory };
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function inputFrame(payload: Uint8Array): Buffer {
  return Buffer.concat([uint32(payload.byteLength), payload]);
}

function outputFrame(status: number, payload: Uint8Array): Buffer {
  return Buffer.concat([uint32(status), uint32(payload.byteLength), payload]);
}

function sourceHash(source: CensusSource): string {
  const verbCount = uint32(source.request.verbs.length);
  const scalarCount = uint32(source.request.points.length);
  const scalars = Buffer.alloc(source.request.points.length * 8);
  const view = new DataView(scalars.buffer, scalars.byteOffset, scalars.byteLength);
  source.request.points.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return sha256(Buffer.concat([verbCount, source.request.verbs, scalarCount, scalars]));
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

function extractSegments(
  source: CensusSource,
  verbs: Uint8Array,
  points: Float64Array,
  provenance: Uint32Array,
): readonly Readonly<{
  cubic: Cubic;
  sourceVerbOrdinal: number;
  lines: readonly ReferenceFlattenedLine[];
}>[] {
  const byOrdinal = source.cubics.map(() => [] as ReferenceFlattenedLine[]);
  let pointIndex = 0;
  verbs.forEach((verb, verbIndex) => {
    if (verb === 0) {
      pointIndex += 2;
      return;
    }
    if (verb !== 1) throw new Error('census output contains a non-MOVE/LINE verb');
    const ordinal = provenance[verbIndex * 3]!;
    const lines = byOrdinal[ordinal - 1];
    if (!lines) throw new Error(`census output has unexpected source ordinal ${ordinal}`);
    lines.push({
      end: [points[pointIndex]!, points[pointIndex + 1]!],
      provenance: {
        sourceVerbOrdinal: ordinal,
        endNumerator: provenance[verbIndex * 3 + 1]!,
        depth: provenance[verbIndex * 3 + 2]!,
      },
    });
    pointIndex += 2;
  });
  if (pointIndex !== points.length || byOrdinal.some((lines) => lines.length === 0))
    throw new Error('census output did not partition every source cubic');
  return source.cubics.map((cubic, index) => ({
    cubic,
    sourceVerbOrdinal: index + 1,
    lines: byOrdinal[index]!,
  }));
}

function samePoint(left: Point, right: Point): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function rowFromNative(
  source: CensusSource,
  inputPayload: Uint8Array,
  batchStatus: number,
  outputPayload: Uint8Array,
): CensusRow {
  const testCase = differentialCase(source);
  let decoded: ReturnType<typeof decodeOutput>;
  try {
    verifyCase(testCase, batchStatus, outputPayload);
    decoded = decodeOutput(outputPayload, [packed(source)]);
  } catch (error) {
    throw new CensusFailure('ABI', source.index, String(error));
  }
  const actual = decoded[0];
  if (batchStatus !== 0 || actual?.status !== 'OK')
    throw new CensusFailure('ABI', source.index, 'census native path did not succeed');
  let segments: ReturnType<typeof extractSegments>;
  try {
    segments = extractSegments(source, actual.verbs, actual.points, actual.provenance);
  } catch (error) {
    throw new CensusFailure('ABI', source.index, String(error));
  }
  const depths = Array.from({ length: 21 }, () => 0);
  let maxDepth = 0;
  let emittedLines = 0;
  segments.forEach((segment) => {
    segment.lines.forEach(({ provenance }) => {
      depths[provenance.depth] = (depths[provenance.depth] ?? 0) + 1;
      maxDepth = Math.max(maxDepth, provenance.depth);
    });
    emittedLines += segment.lines.length;
  });
  if (maxDepth > 7 || segments.some(({ lines }) => lines.length > 128) || emittedLines > 4096)
    throw new CensusFailure(
      'BOUND',
      source.index,
      'census observed a frozen flattening bound violation',
    );
  let cubics: CensusRow['cubics'];
  try {
    cubics = segments.map((segment) => {
      return {
        sourceVerbOrdinal: segment.sourceVerbOrdinal,
        leaves: segment.lines.length,
        boundary: serializeBoundary(
          certifyCubicBoundary({
            cubic: segment.cubic,
            lines: segment.lines,
            screen: [1, 0, 0, 1],
            sourceVerbOrdinal: segment.sourceVerbOrdinal,
          }),
        ),
      };
    });
  } catch (error) {
    throw new CensusFailure('PROOF', source.index, String(error));
  }
  if (source.expectedPreparation && cubics.some(({ boundary }) => boundary.status !== 'CERTIFIED'))
    throw new CensusFailure(
      'PROOF',
      source.index,
      `${source.id} smoke boundary proof did not certify`,
    );
  let preparation: CensusRow['preparation'];
  try {
    preparation = inspectCubicPreparation(segments);
  } catch (error) {
    throw new CensusFailure('PROOF', source.index, String(error));
  }
  if (source.expectedPreparation && preparation.status !== source.expectedPreparation)
    throw new CensusFailure(
      'PROOF',
      source.index,
      `${source.id} preparation ${preparation.status} != ${source.expectedPreparation}`,
    );
  const move: Point = [actual.points[0]!, actual.points[1]!];
  const last: Point = [actual.points.at(-2)!, actual.points.at(-1)!];
  const implicitClosureEdges = samePoint(move, last) ? 0 : 1;
  const prospectiveEdges = emittedLines + implicitClosureEdges;
  const sourceCaps = {
    verbs: source.request.verbs.length,
    scalars: source.request.points.length,
    maxVerbs: 24 as const,
    maxScalars: 104 as const,
    verdict:
      source.request.verbs.length <= 24 && source.request.points.length <= 104
        ? ('WITHIN_CHEAP_CAPS' as const)
        : ('EXCEEDS_CHEAP_CAPS' as const),
  };
  return {
    index: source.index,
    nodeId: source.request.nodeId,
    requestId: source.request.requestId,
    sourceEpoch: source.request.sourceEpoch,
    sourceRevision: source.request.sourceRevision,
    sourceSha256: sourceHash(source),
    inputFrameSha256: sha256(inputFrame(inputPayload)),
    outputFrameSha256: sha256(outputFrame(batchStatus, outputPayload)),
    batchStatus: 0,
    pathStatus: 0,
    abiVerified: true,
    sourceCaps,
    emittedLines,
    implicitClosureEdges,
    prospectiveEdges,
    maxDepth,
    depthHistogram: depths,
    cubics,
    preparation,
    prospectivePairs: (prospectiveEdges * (prospectiveEdges - 1)) / 2,
    pairStage: 'NOT_EVALUATED',
  };
}

function runNative(sources: readonly CensusSource[], directory: string): void {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('P2_NATIVE_RUSTUP is required');
  const nativeDirectory = path.join(directory, 'native');
  mkdirSync(nativeDirectory);
  const inputPath = path.join(nativeDirectory, 'input.bin');
  const outputPath = path.join(nativeDirectory, 'output.bin');
  const logPath = path.join(nativeDirectory, 'native.log');
  const inputFd = openSync(inputPath, 'wx');
  let totalInputBytes = 0;
  try {
    for (const source of sources) {
      try {
        const payload = encodeCase(differentialCase(source));
        if (payload.byteLength > 4096) throw new Error('census input frame exceeds 4096 bytes');
        totalInputBytes += payload.byteLength + 4;
        if (totalInputBytes > 4 * 1024 * 1024) throw new Error('census framed input exceeds 4 MiB');
        writeFileSync(inputFd, inputFrame(payload));
      } catch (error) {
        throw new CensusFailure('INPUT', source.index, String(error));
      }
    }
  } finally {
    closeSync(inputFd);
  }
  const result = spawnSync(
    rustup,
    [
      'run',
      '1.94.1',
      'cargo',
      'test',
      '--manifest-path',
      manifest,
      '--locked',
      '--offline',
      '--release',
      '--lib',
      bridge,
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        P2_NATIVE_INPUT: inputPath,
        P2_NATIVE_OUTPUT: outputPath,
        P3_CENSUS_MODE: 'bounded-v1',
      },
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
    },
  );
  writeFileSync(logPath, result.stdout + result.stderr, { encoding: 'utf8', flag: 'wx' });
  if (result.error) throw new CensusFailure('NATIVE', null, String(result.error));
  if (result.status !== 0)
    throw new CensusFailure('NATIVE', null, `native census failed (${String(result.status)})`);
  let outputFd: number;
  try {
    outputFd = openSync(outputPath, 'r');
  } catch (error) {
    throw new CensusFailure(
      'OUTPUT',
      null,
      `native census output is unavailable: ${String(error)}`,
    );
  }
  let totalOutputBytes = 0;
  try {
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      let prefix: Uint8Array<ArrayBuffer>;
      try {
        prefix = readExact(outputFd, 8);
      } catch (error) {
        throw new CensusFailure('OUTPUT', index, String(error));
      }
      const prefixView = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
      const batchStatus = prefixView.getUint32(0, true);
      const length = prefixView.getUint32(4, true);
      if (length > 256 * 1024)
        throw new CensusFailure('OUTPUT', index, 'native census frame exceeds 256 KiB');
      totalOutputBytes += length + 8;
      if (totalOutputBytes > 128 * 1024 * 1024)
        throw new CensusFailure('OUTPUT', index, 'native census output exceeds 128 MiB');
      let payload: Uint8Array<ArrayBuffer>;
      try {
        payload = readExact(outputFd, length);
      } catch (error) {
        throw new CensusFailure('OUTPUT', index, String(error));
      }
      const row = rowFromNative(source, encodeCase(differentialCase(source)), batchStatus, payload);
      try {
        assertRowShape(row);
        appendJournalRow(directory, row);
      } catch (error) {
        throw new CensusFailure('JOURNAL', index, String(error));
      }
    }
    if (readSync(outputFd, new Uint8Array(1)) !== 0)
      throw new CensusFailure('OUTPUT', null, 'extra native output frame');
  } finally {
    closeSync(outputFd);
  }
}

function completeObservation(modeValue: 'SMOKE' | 'FULL', directory: string): void {
  const invocation = validateInvocation(
    JSON.parse(readFileSync(path.join(directory, 'invocation.json'), 'utf8')),
    modeValue,
  );
  const rawRows = readJournalRows(directory);
  rawRows.forEach(assertRowShape);
  const rows = rawRows as CensusRow[];
  const expected = modeValue === 'FULL' ? 1000 : 4;
  if (rows.length !== expected) throw new Error(`census completed ${rows.length}/${expected} rows`);
  let metadata: Record<string, unknown>;
  try {
    metadata = finishMetadata(root, invocation);
  } catch (error) {
    throw new CensusFailure('SOURCE', null, String(error));
  }
  const source = metadata.source as {
    manifestStartSha256: string;
    manifestEndSha256: string;
  };
  if (source.manifestStartSha256 !== source.manifestEndSha256)
    throw new CensusFailure('SOURCE', null, 'census source changed during execution');
  writeJsonExclusive(path.join(directory, 'census.json'), {
    schema: SCHEMA,
    mode: modeValue,
    completion: 'COMPLETE',
    metadata,
    policy: invocation.policy,
    rows: describeJournal(directory),
    summary: summarizeRows(rows),
    failure: null,
  });
}

function auditObservation(modeValue: 'SMOKE' | 'FULL', directory: string): void {
  const census = JSON.parse(readFileSync(path.join(directory, 'census.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const rawRows = readJournalRows(directory);
  rawRows.forEach(assertRowShape);
  const rows = rawRows as CensusRow[];
  const sources = modeValue === 'FULL' ? fullSources() : smokeSources();
  const invocation = validateInvocation(
    JSON.parse(readFileSync(path.join(directory, 'invocation.json'), 'utf8')),
    modeValue,
  );
  const censusKeys = [
    'completion',
    'failure',
    'metadata',
    'mode',
    'policy',
    'rows',
    'schema',
    'summary',
  ];
  if (
    JSON.stringify(Object.keys(census).sort()) !== JSON.stringify(censusKeys) ||
    census.schema !== SCHEMA ||
    census.mode !== modeValue ||
    census.completion !== 'COMPLETE' ||
    census.failure !== null ||
    JSON.stringify(census.policy) !== JSON.stringify(invocation.policy)
  )
    throw new Error('audit terminal/invocation identity mismatch');
  validateMetadata(census.metadata, 'census.metadata', true);
  if (rows.length !== sources.length) throw new Error('audit source/row count mismatch');
  let auditedInputBytes = 0;
  rows.forEach((row, index) => {
    const source = sources[index]!;
    if (
      row.index !== index ||
      row.nodeId !== source.request.nodeId ||
      row.requestId !== source.request.requestId ||
      row.sourceEpoch !== source.request.sourceEpoch ||
      row.sourceRevision !== source.request.sourceRevision
    )
      throw new Error(`audit row identity mismatch at ${index}`);
    if (row.sourceSha256 !== sourceHash(source))
      throw new Error(`audit source hash mismatch at ${index}`);
    const encoded = encodeCase(differentialCase(source));
    if (encoded.byteLength > 4096) throw new Error(`audit input frame too large at ${index}`);
    auditedInputBytes += encoded.byteLength + 4;
    if (auditedInputBytes > 4 * 1024 * 1024)
      throw new Error(`audit total input too large at ${index}`);
    if (row.inputFrameSha256 !== sha256(inputFrame(encoded)))
      throw new Error(`audit input frame hash mismatch at ${index}`);
    const verdict =
      source.request.verbs.length <= 24 && source.request.points.length <= 104
        ? 'WITHIN_CHEAP_CAPS'
        : 'EXCEEDS_CHEAP_CAPS';
    if (
      row.sourceCaps.verbs !== source.request.verbs.length ||
      row.sourceCaps.scalars !== source.request.points.length ||
      row.sourceCaps.verdict !== verdict ||
      row.cubics.length !== source.cubics.length ||
      row.cubics.some(({ sourceVerbOrdinal }, cubicIndex) => sourceVerbOrdinal !== cubicIndex + 1)
    )
      throw new Error(`audit regenerated source structure mismatch at ${index}`);
  });
  const nativeOutput = openSync(path.join(directory, 'native/output.bin'), 'r');
  let auditedOutputBytes = 0;
  try {
    rows.forEach((row, index) => {
      const prefix = readExact(nativeOutput, 8);
      const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
      const status = view.getUint32(0, true);
      const length = view.getUint32(4, true);
      if (length > 256 * 1024) throw new Error(`audit output frame too large at ${index}`);
      auditedOutputBytes += length + 8;
      if (auditedOutputBytes > 128 * 1024 * 1024)
        throw new Error(`audit total output too large at ${index}`);
      const payload = readExact(nativeOutput, length);
      if (
        status !== row.batchStatus ||
        row.outputFrameSha256 !== sha256(outputFrame(status, payload))
      )
        throw new Error(`audit output frame hash mismatch at ${index}`);
      const regenerated = rowFromNative(
        sources[index]!,
        encodeCase(differentialCase(sources[index]!)),
        status,
        payload,
      );
      assertRowShape(regenerated);
      if (JSON.stringify(row) !== JSON.stringify(regenerated))
        throw new Error(`audit regenerated row mismatch at ${index}`);
    });
    if (readSync(nativeOutput, new Uint8Array(1)) !== 0)
      throw new Error('audit found extra native output');
  } finally {
    closeSync(nativeOutput);
  }
  const descriptor = describeJournal(directory);
  if (JSON.stringify(census.rows) !== JSON.stringify(descriptor))
    throw new Error('audit journal descriptor mismatch');
  const summary = summarizeRows(rows);
  if (JSON.stringify(census.summary) !== JSON.stringify(summary))
    throw new Error('audit summary mismatch');
  const current = captureSource(root);
  const invocationSource = invocation.metadata.source as Record<string, unknown>;
  const expectedMetadata = {
    ...invocation.metadata,
    source: { ...invocationSource, manifestEndSha256: current.sha256 },
  };
  if (JSON.stringify(census.metadata) !== JSON.stringify(expectedMetadata))
    throw new Error('audit source manifest mismatch');
  writeJsonExclusive(path.join(directory, 'audit.json'), {
    schema: SCHEMA,
    mode: modeValue,
    status: 'PASS',
    censusSha256: sha256(readFileSync(path.join(directory, 'census.json'))),
    rowsSha256: descriptor.sha256,
    rows: descriptor.count,
    summary,
    failure: null,
  });
}

describe('P3 cubic census isolated worker', () => {
  it.skipIf(phase !== 'RUN')(
    'runs the frozen native preparation observation',
    () => {
      const environment = requiredEnvironment();
      try {
        const sources = environment.mode === 'FULL' ? fullSources() : smokeSources();
        runNative(sources, environment.output);
        completeObservation(environment.mode, environment.output);
      } catch (error) {
        const failure = error instanceof CensusFailure ? error : null;
        writeIncomplete(
          root,
          environment.output,
          failure?.stage ?? 'WORKER',
          String(error),
          failure?.index ?? null,
        );
        throw error;
      }
    },
    900_000,
  );

  it.skipIf(phase !== 'AUDIT')('independently regenerates sources and summary', () => {
    const environment = requiredEnvironment();
    auditObservation(environment.mode, environment.output);
    expect(true).toBe(true);
  });
});
