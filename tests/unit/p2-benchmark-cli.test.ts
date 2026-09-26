import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The dependency-free orchestration entry is authored as .mjs.
import * as entry from '../../tooling/run-p2-benchmark.mjs';

const cli = entry as {
  parseP2Arguments(args: string[]): { profile: string; environment: unknown };
  reserveP2Output(root: string, requested?: string): string;
  captureP2Source(): {
    head: string;
    files: Array<{ path: string; sha256: string }>;
    sha256: string;
  };
  captureP2Build(directory: string): { sha256: string };
  writeP2Json(file: string, value: unknown): void;
};

describe('P2 benchmark orchestration guards', () => {
  it('requires an explicit profile and reference observations before reserving or launching', () => {
    expect(cli.parseP2Arguments(['--profile', 'functional'])).toMatchObject({
      profile: 'functional',
      environment: null,
    });
    for (const args of [
      [],
      ['--profile', 'reference'],
      ['--profile', 'acceptance'],
      ['--profile', 'functional', '--profile', 'functional'],
      ['--profile', 'functional', '--unknown', 'x'],
      ['--profile', 'functional', '--output-dir'],
      ['--profile', 'functional', '--environment-json', 'x'],
    ]) {
      expect(() => cli.parseP2Arguments(args), JSON.stringify(args)).toThrow();
    }
    const directory = mkdtempSync(path.join(os.tmpdir(), 'p2-environment-'));
    const file = path.join(directory, 'environment.json');
    writeFileSync(file, '{}');
    expect(() =>
      cli.parseP2Arguments(['--profile', 'reference', '--environment-json', file]),
    ).toThrow();
    const observation = {
      value: 'observed by operator for this fixture',
      source: 'unit fixture, not hardware evidence',
    };
    writeFileSync(
      file,
      JSON.stringify({
        observedAt: '2026-09-26T00:00:00Z',
        displayRefreshHz: { value: 60, source: 'unit fixture' },
        power: observation,
        backgroundLoad: observation,
        driver: observation,
        display: observation,
      }),
    );
    expect(
      cli.parseP2Arguments(['--profile', 'reference', '--environment-json', file]).profile,
    ).toBe('reference');
  });

  it('reserves an exclusive bounded directory and never replaces a record', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'p2-output-'));
    for (const invalid of ['..', 'artifacts/p2.5', 'artifacts/p2.5/a/b', 'outside']) {
      expect(() => cli.reserveP2Output(root, invalid)).toThrow();
    }
    const directory = cli.reserveP2Output(root, 'artifacts/p2.5/fresh');
    expect(() => cli.reserveP2Output(root, 'artifacts/p2.5/fresh')).toThrow();
    const file = path.join(directory, 'record.json');
    cli.writeP2Json(file, { original: true });
    expect(() => cli.writeP2Json(file, { original: false })).toThrow();
  });

  it('fingerprints actual source and every production asset instead of trusting labels', () => {
    const source = cli.captureP2Source();
    expect(source.head).toMatch(/^[a-f0-9]{40}$/);
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.files.some((file) => file.path === 'packages/geometry-wasm/src/adapter.ts')).toBe(
      true,
    );
    expect(source.files.some((file) => file.path === 'tooling/run-p2-benchmark.mjs')).toBe(true);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'p2-assets-'));
    expect(() => cli.captureP2Build(directory)).toThrow();
    writeFileSync(path.join(directory, 'index.html'), 'fixture');
    writeFileSync(path.join(directory, 'geometry.wasm'), new Uint8Array([0, 97, 115, 109]));
    const before = cli.captureP2Build(directory);
    writeFileSync(path.join(directory, 'geometry.wasm'), new Uint8Array([0, 97, 115, 110]));
    expect(cli.captureP2Build(directory).sha256).not.toBe(before.sha256);
  });
});
