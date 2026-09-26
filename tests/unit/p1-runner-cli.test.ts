import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

type P1RunnerCli = Readonly<{
  parseP1Arguments: (args: readonly string[]) => Readonly<{
    profile: 'functional';
    outputDirectory: string | undefined;
  }>;
  reserveP1Output: (root: string, requested?: string) => string;
}>;

// @ts-expect-error The deliberately dependency-free CLI is an untyped .mjs module.
import * as untypedRunnerCli from '../../tooling/run-p1-benchmark.mjs';

const { parseP1Arguments, reserveP1Output } = untypedRunnerCli as unknown as P1RunnerCli;

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

describe('P1 runner CLI', () => {
  it('requires exactly one explicit functional profile and only accepts a single optional output directory', () => {
    expect(parseP1Arguments(['--profile', 'functional'])).toEqual({
      profile: 'functional',
      outputDirectory: undefined,
    });
    expect(
      parseP1Arguments(['--profile', 'functional', '--output-dir', 'artifacts/p1.6a/run-a']),
    ).toEqual({ profile: 'functional', outputDirectory: 'artifacts/p1.6a/run-a' });

    for (const arguments_ of [
      [],
      ['--profile', 'reference'],
      ['--profile', 'acceptance'],
      ['--profile', 'functional', '--unknown', 'value'],
      ['--profile', 'functional', '--profile', 'functional'],
      ['--profile', 'functional', '--output-dir'],
      ['--output-dir', 'artifacts/p1.6a/run-a'],
    ]) {
      expect(() => parseP1Arguments(arguments_)).toThrow();
    }
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
    expect(result.stderr).toContain('supports only explicit --profile functional');
    expect(existsSync(marker)).toBe(false);
  });

  it('reserves only a fresh immediate artifact child and never replaces a collision', () => {
    const root = temporaryDirectory();
    const requested = path.join('artifacts', 'p1.6a', 'run-a');
    const first = reserveP1Output(root, requested);
    const sentinel = path.join(first, 'preserve-me.txt');
    writeFileSync(sentinel, 'immutable observation');

    expect(first).toBe(path.join(root, requested));
    expect(() => reserveP1Output(root, requested)).toThrow();
    expect(readFileSync(sentinel, 'utf8')).toBe('immutable observation');

    const automatic = reserveP1Output(root);
    expect(path.dirname(automatic)).toBe(path.join(root, 'artifacts', 'p1.6a'));
    expect(existsSync(automatic)).toBe(true);
  });

  it('rejects cleanup, parent, nested, root, and outside output directories', () => {
    const root = temporaryDirectory();
    const parent = path.join('artifacts', 'p1.6a');
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
        'Use a fresh immediate child of artifacts/p1.6a outside test cleanup.',
      );
    }
  });
});
