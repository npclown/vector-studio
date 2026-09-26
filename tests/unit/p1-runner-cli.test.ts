import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

type P1RunnerCli = Readonly<{
  parseP1Arguments: (args: readonly string[]) => Readonly<{
    profile: 'functional' | 'reference';
    outputDirectory: string | undefined;
    environment: P1ReferenceEnvironment | undefined;
  }>;
  validateP1Environment: (value: unknown) => P1ReferenceEnvironment;
  reserveP1Output: (root: string, requested?: string) => string;
}>;

type P1ReferenceEnvironment = Readonly<{
  observedAt: string;
  displayRefreshHz: Readonly<{ value: number; source: string }>;
  power: Readonly<{ value: string; source: string }>;
  backgroundLoad: Readonly<{ value: string; source: string }>;
  driver: Readonly<{ value: string; source: string }>;
  display: Readonly<{ value: string; source: string }>;
}>;

// @ts-expect-error The deliberately dependency-free CLI is an untyped .mjs module.
import * as untypedRunnerCli from '../../tooling/run-p1-benchmark.mjs';

const { parseP1Arguments, reserveP1Output, validateP1Environment } =
  untypedRunnerCli as unknown as P1RunnerCli;

const temporaryDirectories: string[] = [];
const cliPath = fileURLToPath(new URL('../../tooling/run-p1-benchmark.mjs', import.meta.url));

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vector-studio-p1-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

function referenceEnvironment(): P1ReferenceEnvironment {
  return {
    observedAt: '2026-09-26T06:00:00.000Z',
    displayRefreshHz: { value: 60, source: 'Windows display settings' },
    power: { value: 'AC / balanced', source: 'operator preflight' },
    backgroundLoad: { value: 'No unrelated GPU load', source: 'operator preflight' },
    driver: { value: 'Driver 1.2.3', source: 'adapter report' },
    display: { value: 'Monitor 1', source: 'operator preflight' },
  };
}

function writeEnvironment(directory: string, value: unknown, name = 'environment.json'): string {
  const file = path.join(directory, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

describe('P1 runner CLI', () => {
  it('accepts explicit functional or metadata-backed reference profiles', () => {
    expect(parseP1Arguments(['--profile', 'functional'])).toEqual({
      profile: 'functional',
      outputDirectory: undefined,
      environment: undefined,
    });
    expect(
      parseP1Arguments(['--profile', 'functional', '--output-dir', 'artifacts/p1.6b/run-a']),
    ).toEqual({
      profile: 'functional',
      outputDirectory: 'artifacts/p1.6b/run-a',
      environment: undefined,
    });
    const metadata = referenceEnvironment();
    const root = temporaryDirectory();
    const metadataFile = writeEnvironment(root, metadata);
    expect(
      parseP1Arguments(['--profile', 'reference', '--environment-json', metadataFile]),
    ).toEqual({ profile: 'reference', outputDirectory: undefined, environment: metadata });

    for (const arguments_ of [
      [],
      ['--profile', 'acceptance'],
      ['--profile', 'functional', '--unknown', 'value'],
      ['--profile', 'functional', '--profile', 'functional'],
      ['--profile', 'functional', '--output-dir'],
      ['--output-dir', 'artifacts/p1.6b/run-a'],
    ]) {
      expect(() => parseP1Arguments(arguments_)).toThrow();
    }
  });

  it('rejects every missing or malformed reference metadata field', () => {
    const valid = referenceEnvironment();
    for (const key of [
      'displayRefreshHz',
      'power',
      'backgroundLoad',
      'driver',
      'display',
    ] as const) {
      const missing = structuredClone(valid) as Record<string, unknown>;
      delete missing[key];
      expect(() => validateP1Environment(missing)).toThrow();
    }
    for (const key of ['power', 'backgroundLoad', 'driver', 'display'] as const) {
      const emptyValue = structuredClone(valid);
      (emptyValue[key] as { value: string }).value = '';
      expect(() => validateP1Environment(emptyValue)).toThrow();
      const emptySource = structuredClone(valid);
      (emptySource[key] as { source: string }).source = '';
      expect(() => validateP1Environment(emptySource)).toThrow();
    }
    expect(() =>
      validateP1Environment({ ...valid, displayRefreshHz: { value: 0, source: 'x' } }),
    ).toThrow();
    expect(() =>
      validateP1Environment({ ...valid, displayRefreshHz: { value: Number.NaN, source: 'x' } }),
    ).toThrow();
    expect(() =>
      validateP1Environment({ ...valid, displayRefreshHz: { value: 60, source: '' } }),
    ).toThrow();
    expect(() => validateP1Environment({ ...valid, observedAt: 'not-an-iso-timestamp' })).toThrow();
  });

  it('rejects invalid CLI arguments before it can launch a build', () => {
    const directory = temporaryDirectory();
    const marker = path.join(directory, 'package-manager-was-launched');
    const fakePackageManager = path.join(directory, 'fake-package-manager.mjs');
    writeFileSync(
      fakePackageManager,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.P1_CLI_SENTINEL, 'launched');",
    );

    const result = spawnSync(process.execPath, [cliPath, '--profile', 'reference'], {
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: fakePackageManager, P1_CLI_SENTINEL: marker },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('require --environment-json');
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects incomplete and malformed reference JSON before build or output reservation', () => {
    const directory = temporaryDirectory();
    const marker = path.join(directory, 'package-manager-was-launched');
    const fakePackageManager = path.join(directory, 'fake-package-manager.mjs');
    writeFileSync(
      fakePackageManager,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.P1_CLI_SENTINEL, 'launched');",
    );
    const incomplete = structuredClone(referenceEnvironment()) as Record<string, unknown>;
    delete incomplete.driver;
    for (const metadata of [incomplete, '{not JSON']) {
      const metadataFile = writeEnvironment(directory, metadata, `bad-${typeof metadata}.json`);
      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          '--profile',
          'reference',
          '--environment-json',
          metadataFile,
          '--output-dir',
          path.join('artifacts', 'p1.6b', 'must-not-exist'),
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, npm_execpath: fakePackageManager, P1_CLI_SENTINEL: marker },
        },
      );
      expect(result.status).toBe(2);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(path.join(directory, 'artifacts'))).toBe(false);
    }
  });

  it('reserves only a fresh immediate artifact child and never replaces a collision', () => {
    const root = temporaryDirectory();
    const requested = path.join('artifacts', 'p1.6b', 'run-a');
    const first = reserveP1Output(root, requested);
    const sentinel = path.join(first, 'preserve-me.txt');
    writeFileSync(sentinel, 'immutable observation');

    expect(first).toBe(path.join(root, requested));
    expect(() => reserveP1Output(root, requested)).toThrow();
    expect(readFileSync(sentinel, 'utf8')).toBe('immutable observation');

    const automatic = reserveP1Output(root);
    expect(path.dirname(automatic)).toBe(path.join(root, 'artifacts', 'p1.6b'));
    expect(existsSync(automatic)).toBe(true);
  });

  it('rejects cleanup, parent, nested, root, and outside output directories', () => {
    const root = temporaryDirectory();
    const parent = path.join('artifacts', 'p1.6b');
    const rejected = [
      path.join('test-results', 'p1-run'),
      parent,
      path.join(parent, 'nested', 'run-a'),
      '.',
      '..',
      path.join(root, 'outside-artifacts'),
    ];

    for (const requested of rejected) {
      expect(() => reserveP1Output(root, requested)).toThrow(
        'Use a fresh immediate child of artifacts/p1.6b outside test cleanup.',
      );
    }
  });
});
