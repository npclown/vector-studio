import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { aggregateP2Records, p2Hash } from '../support/p2-benchmark-record.js';
import type { P2ProfileName } from './types.js';
// @ts-expect-error The orchestration entry is authored as .mjs.
import * as environmentEntry from '../../tooling/run-p1-benchmark.mjs';

const environmentValidator = environmentEntry as { validateP1Environment(value: unknown): unknown };

type Manifest = { files: Array<{ path: string; sha256: string }>; sha256: string };
type Source = Manifest & { head: string; dirty: boolean };
const directory = process.env.P2_RUN_DIR;
if (!directory) throw new Error('Run through pnpm benchmark:p2.');
const read = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(directory, file), 'utf8'));

it('independently evaluates every repetition after source/build integrity checks', () => {
  const invocation = read('invocation.json') as {
    profile: P2ProfileName;
    source: Source;
    environment: unknown;
    host: { cpu: string; logicalCores: number; memoryBytes: number };
    observedAt: string;
    command: string[];
  };
  const completion = read('completion.json') as {
    sourceEnd?: Source;
    buildEnd?: Manifest;
    sourceMatches: boolean;
    buildMatches: boolean;
    failure: string | null;
  };
  let build: Manifest & {
    wasmSha256: string;
    buildMode?: string;
    compilerObservation?: string;
    rust?: Record<string, unknown>;
  };
  const integrityFindings: string[] = [];
  try {
    build = read('build.json') as typeof build;
  } catch (error) {
    build = { files: [], sha256: '', wasmSha256: '' };
    integrityFindings.push(`Missing build: ${String(error)}`);
  }
  const manifestValid = (manifest: Manifest | undefined) =>
    !!manifest &&
    Array.isArray(manifest.files) &&
    manifest.files.length > 0 &&
    new Set(manifest.files.map((file) => file.path)).size === manifest.files.length &&
    manifest.files.every(
      (file) =>
        typeof file.path === 'string' && file.path.length > 0 && /^[a-f0-9]{64}$/.test(file.sha256),
    ) &&
    p2Hash(manifest.files) === manifest.sha256;
  if (
    !manifestValid(invocation.source) ||
    !manifestValid(completion.sourceEnd) ||
    !/^[a-f0-9]{40}$/.test(invocation.source.head) ||
    typeof invocation.source.dirty !== 'boolean' ||
    typeof completion.sourceEnd?.dirty !== 'boolean' ||
    invocation.source.head !== completion.sourceEnd?.head ||
    invocation.source.sha256 !== completion.sourceEnd?.sha256 ||
    !completion.sourceMatches
  )
    integrityFindings.push('Source-start/end integrity failed.');
  if (
    !manifestValid(build) ||
    !manifestValid(completion.buildEnd) ||
    build.sha256 !== completion.buildEnd?.sha256 ||
    !completion.buildMatches ||
    build.files.find((file) => file.path === 'geometry.wasm')?.sha256 !== build.wasmSha256
  )
    integrityFindings.push('Build/WASM integrity failed.');
  if (completion.failure !== null) integrityFindings.push(String(completion.failure));
  if (
    build.buildMode !== 'production' ||
    !build.compilerObservation?.includes('release: 1.94.1') ||
    !build.compilerObservation.includes('commit-hash: e408947bfd200af42db322daf0fadfe7e26d3bd1') ||
    !build.compilerObservation.includes('host: x86_64-pc-windows-msvc') ||
    p2Hash(build.rust ?? null) !==
      p2Hash({
        version: '1.94.1',
        commit: 'e408947bfd200af42db322daf0fadfe7e26d3bd1',
        target: 'wasm32-unknown-unknown',
        profile: 'release',
        optLevel: 3,
        lto: true,
        codegenUnits: 1,
        panic: 'abort',
        strip: true,
        remapPathPrefix: '<repository>=.',
      })
  )
    integrityFindings.push('Compiler/release production provenance differs.');
  if (
    !invocation.host.cpu ||
    invocation.host.logicalCores <= 0 ||
    invocation.host.memoryBytes <= 0 ||
    !Number.isFinite(Date.parse(invocation.observedAt)) ||
    invocation.command[0] !== 'pnpm'
  )
    integrityFindings.push('Incomplete command/host provenance.');
  if (invocation.profile !== 'functional' && invocation.profile !== 'reference')
    throw new Error('Invalid invocation profile');
  if (invocation.profile === 'reference') {
    try {
      environmentValidator.validateP1Environment(invocation.environment);
    } catch (error) {
      integrityFindings.push(`Invalid reference observations: ${String(error)}`);
    }
  }
  const records = readdirSync(directory)
    .filter((file) => /^(chrome|edge)-r.*\.json$/.test(file))
    .sort()
    .map((file) => {
      try {
        return read(file);
      } catch (error) {
        integrityFindings.push(`${file}: ${String(error)}`);
        return null;
      }
    });
  const aggregate = aggregateP2Records(records, {
    profile: invocation.profile,
    sourceSha256: invocation.source.sha256,
    buildSha256: build.sha256,
    wasmSha256: build.wasmSha256,
    integrityFindings,
  });
  writeFileSync(path.join(directory, 'aggregate.json'), JSON.stringify(aggregate, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(`P2 ${aggregate.disposition}; records: ${directory}`);
  expect(aggregate.disposition, JSON.stringify(aggregate)).toBe(
    invocation.profile === 'functional' ? 'FUNCTIONAL_PASS' : 'PASS',
  );
});
