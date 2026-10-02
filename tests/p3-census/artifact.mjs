import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'p3-cubic-readiness-census/v1';
export const FAILURE_STAGES = [
  'CLI',
  'TOOLCHAIN',
  'SOURCE',
  'INPUT',
  'NATIVE',
  'OUTPUT',
  'ABI',
  'BOUND',
  'PROOF',
  'JOURNAL',
  'WORKER',
  'SUMMARY',
  'AUDIT',
];

const SOURCE_PATHS = [
  'packages/geometry-reference/src',
  'packages/geometry-wasm/src',
  'packages/geometry-wasm/kernel',
  'tests/geometry/differential',
  'tests/geometry/cubic-boundary',
  'tests/geometry/simple-cubic-topology',
  'tests/geometry/rounded-fill/exact.ts',
  'tests/geometry-benchmark/workload.ts',
  'tests/p3-census',
  'tooling/run-p3-cubic-census.mjs',
  'tooling/run-p3-cubic-census.d.mts',
  'tooling/test-geometry.mjs',
  'vitest.p3-cubic-census.config.ts',
  'eslint.config.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  '.node-version',
  'docs/plans/p3-cubic-census-contract.md',
];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedSource(file) {
  let text = readFileSync(file, 'utf8');
  if (text.startsWith('\ufeff')) text = text.slice(1);
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function captureSource(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const files = git('ls-files', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_PATHS)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'))
    .sort();
  if (files.length === 0) throw new Error('census source manifest is empty');
  const entries = files.map((file) => ({
    path: file,
    sha256: sha256(Buffer.from(normalizedSource(path.join(root, file)), 'utf8')),
  }));
  return {
    head: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain').length > 0,
    entries,
    sha256: sha256(Buffer.from(JSON.stringify(entries), 'utf8')),
  };
}

export function policy(mode) {
  return {
    scenario: mode === 'FULL' ? 'p2-batch/v1' : 'p3-cubic-census-smoke/v1',
    seed: mode === 'FULL' ? 0x12345678 : null,
    paths: mode === 'FULL' ? 1000 : 4,
    cubicsPerPath: mode === 'FULL' ? 32 : null,
    smokeFixtures:
      mode === 'SMOKE'
        ? ['triangle', 'endpoint-restoration', 'straight-32', 'bowtie-implicit-close']
        : null,
    toleranceBits: '3fc0000000000000',
    screenBits: ['3ff0000000000000', '0000000000000000', '0000000000000000', '3ff0000000000000'],
    inspector: { maxCubics: 32, maxLines: 4096, maxDepth: 20 },
    transport: {
      maxFrames: 1000,
      maxInputFrameBytes: 4096,
      maxTotalInputBytes: 4 * 1024 * 1024,
      maxOutputFrameBytes: 256 * 1024,
      maxTotalOutputBytes: 128 * 1024 * 1024,
      maxJournalRowBytes: 64 * 1024,
      maxJournalBytes: 64 * 1024 * 1024,
    },
    timeoutsMs: { native: 300_000, verification: 900_000 },
    excludedStages: ['PAIR_TOPOLOGY', 'INTERSECTIONS', 'ROUNDED_FILL', 'MESH'],
  };
}

export function writeJsonExclusive(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function createInvocation(root, outputDirectory, mode, rust) {
  const source = captureSource(root);
  const metadata = {
    source: {
      head: source.head,
      dirty: source.dirty,
      manifest: source.entries,
      manifestStartSha256: source.sha256,
      manifestEndSha256: null,
    },
    nodeVersion: process.version,
    rust,
    executionRole: 'NATIVE_ONLY',
  };
  const value = { schema: SCHEMA, mode, metadata, policy: policy(mode) };
  writeJsonExclusive(path.join(outputDirectory, 'invocation.json'), value);
  return value;
}

function completeLines(bytes) {
  let end = 0;
  let count = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      end = index + 1;
      count += 1;
    }
  }
  return { end, count };
}

function scanJournal(file) {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(64 * 1024);
  let offset = 0;
  let prefixBytes = 0;
  let count = 0;
  try {
    while (offset < size) {
      const length = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (length === 0) throw new Error('journal ended before its recorded size');
      const current = chunk.subarray(0, length);
      hash.update(current);
      for (let index = 0; index < length; index += 1) {
        if (current[index] === 0x0a) {
          prefixBytes = offset + index + 1;
          count += 1;
        }
      }
      offset += length;
    }
  } finally {
    closeSync(fd);
  }
  const prefixHash = createHash('sha256');
  const prefixFd = openSync(file, 'r');
  let prefixOffset = 0;
  try {
    while (prefixOffset < prefixBytes) {
      const length = readSync(
        prefixFd,
        chunk,
        0,
        Math.min(chunk.length, prefixBytes - prefixOffset),
        prefixOffset,
      );
      if (length === 0) throw new Error('journal prefix ended unexpectedly');
      prefixHash.update(chunk.subarray(0, length));
      prefixOffset += length;
    }
  } finally {
    closeSync(prefixFd);
  }
  return {
    bytes: size,
    count,
    sha256: hash.digest('hex'),
    prefixBytes,
    prefixSha256: prefixHash.digest('hex'),
  };
}

export function describeJournal(outputDirectory) {
  const file = path.join(outputDirectory, 'rows.ndjson');
  if (!existsSync(file)) {
    return { path: 'rows.ndjson', sha256: sha256(Buffer.alloc(0)), bytes: 0, count: 0 };
  }
  const scanned = scanJournal(file);
  const descriptor = {
    path: 'rows.ndjson',
    sha256: scanned.sha256,
    bytes: scanned.bytes,
    count: scanned.count,
  };
  if (scanned.prefixBytes !== scanned.bytes) {
    descriptor.completePrefix = {
      bytes: scanned.prefixBytes,
      count: scanned.count,
      sha256: scanned.prefixSha256,
    };
  }
  return descriptor;
}

export function appendJournalRow(outputDirectory, row) {
  const bytes = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
  if (bytes.length > 64 * 1024) throw new Error('census journal row exceeds 64 KiB');
  const file = path.join(outputDirectory, 'rows.ndjson');
  const current = existsSync(file) ? statSync(file).size : 0;
  if (current + bytes.length > 64 * 1024 * 1024) throw new Error('census journal exceeds 64 MiB');
  const fd = openSync(file, 'a');
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readJournalRows(outputDirectory) {
  const file = path.join(outputDirectory, 'rows.ndjson');
  if (!existsSync(file)) return [];
  if (statSync(file).size > 64 * 1024 * 1024) throw new Error('journal exceeds 64 MiB');
  const bytes = readFileSync(file);
  const complete = completeLines(bytes);
  if (complete.end !== bytes.length) throw new Error('journal has a partial tail');
  const text = bytes.toString('utf8');
  return text.length === 0
    ? []
    : text
        .slice(0, -1)
        .split('\n')
        .map((line) => {
          if (Buffer.byteLength(line, 'utf8') + 1 > 64 * 1024)
            throw new Error('census journal row exceeds 64 KiB');
          return JSON.parse(line);
        });
}

export function finishMetadata(root, invocation) {
  const end = captureSource(root);
  return {
    ...invocation.metadata,
    source: { ...invocation.metadata.source, manifestEndSha256: end.sha256 },
  };
}

export function writeIncomplete(root, outputDirectory, stage, message, index = null) {
  if (!FAILURE_STAGES.includes(stage)) throw new Error('unknown census failure stage');
  if (typeof message !== 'string' || message.length === 0)
    throw new Error('census failure message is empty');
  if (index !== null && (!Number.isSafeInteger(index) || index < 0))
    throw new Error('census failure index is invalid');
  const terminal = path.join(outputDirectory, 'census.json');
  if (existsSync(terminal)) return;
  const invocation = JSON.parse(
    readFileSync(path.join(outputDirectory, 'invocation.json'), 'utf8'),
  );
  let metadata = invocation.metadata;
  let capturedMessage = message;
  try {
    metadata = finishMetadata(root, invocation);
  } catch (error) {
    capturedMessage = `${message}; source end capture failed: ${String(error)}`;
  }
  writeJsonExclusive(terminal, {
    schema: SCHEMA,
    mode: invocation.mode,
    completion: 'INCOMPLETE',
    metadata,
    policy: invocation.policy,
    rows: describeJournal(outputDirectory),
    summary: null,
    failure: { stage, message: capturedMessage, index },
  });
}

export function readExact(fd, length) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, null);
    if (count === 0) throw new Error('truncated framed native output');
    offset += count;
  }
  return bytes;
}
