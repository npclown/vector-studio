// D9 E8 unit E8-U1: the E8 corpus `e8-corner/v1` (docs/plans/p3-rounded-knot-topology-contract.md,
// E8 addendum E8.6, E8-K6 and E8-K8). The generator and the encoded corpus are frozen by the
// SHA-256 values of `e8-corner/corpus-v1.manifest.json`. Every path runs natively through the
// four `CubicFillWorkspace` entries and the fill-v0 cascade (`emit_e8_corner_digests`), and
// through the release WASM's `fill_v0` (`P2_WASM_PATH`); both cascade digests cover the batch
// status, the result length and the published bytes, and must agree path by path (E8-K8). The
// per-family status counts are printed and written beside the capture for the plan record. Since
// E8-U2, the E8-K6 gate holds here for the lens families (no `unsupported-geometry` at either
// exponent); the wave family's remaining failures are classified in the E8-U2 evidence.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { packFillInput } from '../../tooling/compare-p3-fill-identity.mjs';
import {
  E8_CORNER_CORPUS_VERSION,
  E8_CORNER_FAMILIES,
  E8_CORNER_SHAPES,
  Lcg,
  encodeE8CornerCorpus,
  generateE8CornerCorpus,
} from './e8-corner/corpus.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(root, 'tests/geometry/e8-corner/corpus-v1.manifest.json');
const generatorPath = path.join(root, 'tests/geometry/e8-corner/corpus.ts');
const kernelManifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');

type Manifest = Readonly<{
  version: string;
  generator: Readonly<{ path: string; sha256: string }>;
  seeds: Readonly<Record<string, string>>;
  families: readonly string[];
  paths: number;
  bytes: number;
  corpusSha256: string;
}>;

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const corpus = generateE8CornerCorpus();
const bytes = encodeE8CornerCorpus(corpus);
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

type DigestRecord = Readonly<{ digest: string; allocations: number; code: string }>;

function parseDigests(text: string): Map<string, DigestRecord> {
  const records = new Map<string, DigestRecord>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [name, digest, allocations, code] = line.split('\t');
    if (name === undefined || digest === undefined || code === undefined)
      throw new Error(`malformed digest line ${line}`);
    if (records.has(name)) throw new Error(`duplicate case ${name}`);
    records.set(name, { digest, allocations: Number(allocations), code });
  }
  return records;
}

const caseName = (family: string, index: number) =>
  `rnd/${family}/${String(index).padStart(4, '0')}/fill_v0_cascade`;

function runNative(directory: string): Map<string, DigestRecord> {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const input = path.join(directory, 'e8-corner-v1.bin');
  const output = path.join(directory, 'native.tsv');
  writeFileSync(input, bytes, { flag: 'wx' });
  const result = spawnSync(
    rustup,
    [
      'run',
      '1.94.1',
      'cargo',
      'test',
      '--release',
      '--manifest-path',
      kernelManifest,
      '--locked',
      '--offline',
      '--lib',
      'e8_direction_hint_tests::emit_e8_corner_digests',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_E8_CORNER_CORPUS: input, P3_E8_CORNER_OUTPUT: output },
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  return parseDigests(readFileSync(output, 'utf8'));
}

type FillKernel = Readonly<{
  memory: WebAssembly.Memory;
  fill_v0_reserve(input: number, output: number): number;
  fill_v0_input_ptr(): number;
  fill_v0_output_ptr(): number;
  fill_v0_process(length: number): number;
  fill_v0_result_len(): number;
  fill_v0_required_output_bytes(): number;
}>;

async function runWasm(): Promise<Map<string, DigestRecord>> {
  const file = process.env.P2_WASM_PATH;
  if (!file) throw new Error('Run pnpm test:geometry to build the release WASM.');
  const { instance } = await WebAssembly.instantiate(readFileSync(file), {});
  const kernel = instance.exports as unknown as FillKernel;
  // The capacities of the native harness (`p3_b0r_identity`): 64 KiB in, 1 MiB out.
  expect(kernel.fill_v0_reserve(64 * 1024, 1024 * 1024)).toBe(0);
  const records = new Map<string, DigestRecord>();
  for (const family of corpus) {
    family.paths.forEach((pathData, index) => {
      const input = packFillInput(
        pathData.verbs,
        pathData.points,
        pathData.rule,
        pathData.exponent,
        index,
      );
      new Uint8Array(kernel.memory.buffer, kernel.fill_v0_input_ptr() >>> 0, input.length).set(
        input,
      );
      const status = kernel.fill_v0_process(input.length);
      const length = kernel.fill_v0_result_len() >>> 0;
      const required = kernel.fill_v0_required_output_bytes() >>> 0;
      const output = new Uint8Array(
        kernel.memory.buffer,
        kernel.fill_v0_output_ptr() >>> 0,
        length,
      );
      const hash = createHash('sha256');
      hash.update(
        `entry=fill_v0_cascade\nstatus=${status}\nresult_len=${length}\nrequired_output_bytes=${required}\n`,
      );
      hash.update(output);
      const code =
        status === 0
          ? `path_status=${new DataView(output.buffer, output.byteOffset + 68, 4).getUint32(0, true)}`
          : `batch_status=${status}`;
      records.set(caseName(family.id, index), { digest: hash.digest('hex'), allocations: 0, code });
    });
  }
  return records;
}

let native = new Map<string, DigestRecord>();
let wasm = new Map<string, DigestRecord>();
let directory = '';

beforeAll(async () => {
  const tools = path.join(root, '.tools');
  mkdirSync(tools, { recursive: true });
  directory = mkdtempSync(path.join(tools, 'e8-corner-'));
  native = runNative(directory);
  wasm = await runWasm();
}, 900_000);

describe('E8 corpus e8-corner/v1', () => {
  it('regenerates the frozen manifest: generator, seeds, families and corpus SHA-256', () => {
    expect(manifest.version).toBe(E8_CORNER_CORPUS_VERSION);
    expect(manifest.generator.sha256).toBe(sha256(readFileSync(generatorPath)));
    expect(manifest.seeds).toEqual(
      Object.fromEntries(E8_CORNER_FAMILIES.map(({ id, seed }) => [id, `0x${seed.toString(16)}`])),
    );
    expect(manifest.families).toEqual(corpus.map(({ id }) => id));
    expect(corpus.every(({ paths }) => paths.length === E8_CORNER_SHAPES)).toBe(true);
    expect(manifest.paths).toBe(corpus.length * E8_CORNER_SHAPES);
    expect(manifest.bytes).toBe(bytes.length);
    expect(manifest.corpusSha256).toBe(sha256(bytes));
  });

  it('draws in-range integers from the written LCG constants', () => {
    const random = new Lcg(1n);
    const draws = Array.from({ length: 10_000 }, () => random.int(-3, 3));
    expect(Math.min(...draws)).toBe(-3);
    expect(Math.max(...draws)).toBe(3);
  });

  it('agrees native and release WASM path by path in status and mesh bytes (E8-K8)', () => {
    let compared = 0;
    for (const family of corpus) {
      family.paths.forEach((_, index) => {
        const name = caseName(family.id, index);
        const nativeRecord = native.get(name);
        const wasmRecord = wasm.get(name);
        expect(nativeRecord, name).toBeDefined();
        expect(wasmRecord?.code, name).toBe(nativeRecord?.code);
        expect(wasmRecord?.digest, name).toBe(nativeRecord?.digest);
        expect(nativeRecord?.allocations, name).toBe(0);
        compared += 1;
      });
    }
    expect(compared).toBe(manifest.paths);
  });

  it('reports only path statuses, never a batch or internal failure, and records the rates', () => {
    const names: { readonly [status: string]: string } = {
      '0': 'ok',
      '1': 'empty',
      '5': 'work-limit',
      '6': 'unsupported-geometry',
    };
    const counts: { [family: string]: { [status: string]: number } } = {};
    for (const family of corpus) {
      const row: { [status: string]: number } = {};
      family.paths.forEach((_, index) => {
        const code = native.get(caseName(family.id, index))!.code;
        expect(code, family.id).toMatch(/^path_status=[0-6]$/u);
        const status = code.slice('path_status='.length);
        const name = names[status] ?? `status-${status}`;
        row[name] = (row[name] ?? 0) + 1;
      });
      counts[family.id] = row;
    }
    for (const [family, row] of Object.entries(counts)) {
      if (family.startsWith('lens')) expect(row['unsupported-geometry'] ?? 0, family).toBe(0);
    }
    const summary = JSON.stringify(counts, null, 2);
    writeFileSync(path.join(directory, 'rates.json'), `${summary}\n`, { flag: 'wx' });
    console.log(`e8-corner/v1 cascade statuses (native = WASM):\n${summary}`);
  });
});
