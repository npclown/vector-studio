import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDifferentialCases,
  encodeCase,
  runPositiveControls,
  verifyCase,
} from './differential/index.js';

const root = path.resolve(import.meta.dirname, '../..');
const bridge = 'engine::native_differential::run_framed_inputs';
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');

function native(input: string, output: string) {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  return spawnSync(
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
      env: { ...process.env, P2_NATIVE_INPUT: input, P2_NATIVE_OUTPUT: output },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    },
  );
}

function directory() {
  const base = path.join(root, '.tools');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, 'geometry-native-'));
}

function readExact(fd: number, length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, null);
    if (!count) throw new Error('Native bridge returned a truncated result frame');
    offset += count;
  }
  return bytes;
}

describe('P2 independent native Rust differential', () => {
  it('verifies every frozen and named case against the independent TS oracle', () => {
    const cases = createDifferentialCases();
    expect(cases.length).toBeGreaterThan(10_000);
    expect(new Set(cases.map((fixture) => fixture.id)).size).toBe(cases.length);
    const artifact = directory();
    const input = path.join(artifact, 'input.bin');
    const output = path.join(artifact, 'output.bin');
    const fd = openSync(input, 'wx');
    try {
      for (const fixture of cases) {
        const bytes = encodeCase(fixture);
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(bytes.length);
        writeFileSync(fd, prefix);
        writeFileSync(fd, bytes);
      }
    } finally {
      closeSync(fd);
    }
    const result = native(input, output);
    writeFileSync(path.join(artifact, 'native.log'), result.stdout + result.stderr, { flag: 'wx' });
    if (result.error) throw result.error;
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`P2 native differential frames: ${cases.length}`);
    const retries = Number(
      /P2 native differential capacity retries: (\d+)/.exec(result.stdout)?.[1],
    );
    expect(retries).toBeGreaterThan(0);
    const reader = openSync(output, 'r');
    let verified = 0;
    let current = 'positive-controls';
    try {
      const positiveControls = runPositiveControls();
      const categories: Record<string, number> = {};
      for (const fixture of cases) {
        current = fixture.id;
        const prefix = readExact(reader, 8);
        const view = new DataView(prefix.buffer);
        const status = view.getUint32(0, true);
        const length = view.getUint32(4, true);
        if (length > 256 * 1024 * 1024) throw new Error('Native output exceeds ABI cap');
        verifyCase(fixture, status, readExact(reader, length));
        categories[fixture.category] = (categories[fixture.category] ?? 0) + 1;
        verified++;
      }
      expect(readSync(reader, new Uint8Array(1))).toBe(0);
      expect(verified).toBe(cases.length);
      expect(categories.corpus).toBe(10_000);
      for (const category of [
        'named-cubic',
        'named-packed',
        'metamorphic',
        'subdivision',
        'edge',
      ]) {
        expect(categories[category], category).toBeGreaterThan(0);
      }
      writeFileSync(
        path.join(artifact, 'summary.json'),
        JSON.stringify(
          { status: 'PASS', verified, categories, exactSizeRetries: retries, positiveControls },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
      console.log(`Native differential evidence: ${artifact}; verified ${verified} cases`);
    } catch (error) {
      writeFileSync(
        path.join(artifact, 'failure.json'),
        JSON.stringify(
          { verified, current, error: String(error), fixture: cases.find((c) => c.id === current) },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
      throw error;
    } finally {
      closeSync(reader);
    }
  });

  it('rejects missing, empty, partial, oversized input and preexisting output', () => {
    const artifact = directory();
    const cases: Array<[string, Uint8Array | null]> = [
      ['missing', null],
      ['empty', new Uint8Array()],
      ['partial-prefix', new Uint8Array([48])],
      ['partial-payload', new Uint8Array([48, 0, 0, 0, 1])],
      ['over-cap', new Uint8Array([1, 0, 0, 4])],
    ];
    for (const [name, bytes] of cases) {
      const input = path.join(artifact, `${name}.bin`);
      if (bytes) writeFileSync(input, bytes, { flag: 'wx' });
      const result = native(input, path.join(artifact, `${name}-output.bin`));
      if (result.error) throw result.error;
      expect(result.status, name).not.toBe(0);
    }
    const input = path.join(artifact, 'empty.bin');
    const output = path.join(artifact, 'existing.bin');
    writeFileSync(output, 'preserve-me', { flag: 'wx' });
    const result = native(input, output);
    if (result.error) throw result.error;
    expect(result.status).not.toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('preserve-me');
  });
});
