import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestInfo } from '@playwright/test';

const defaultRunRoot = path.resolve(
  'artifacts/p1.5',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

export function p1EvidenceDirectory(info: TestInfo): string {
  const root = process.env.P1_EVIDENCE_OUTPUT_DIR ?? defaultRunRoot;
  const cleanupRoot = path.resolve('test-results');
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot === cleanupRoot || resolvedRoot.startsWith(`${cleanupRoot}${path.sep}`)) {
    throw new Error(
      'P1 evidence must be outside Playwright test-results cleanup. Use artifacts/p1.5/<unique-run-id>.',
    );
  }
  const directory = path.resolve(
    root,
    info.project.name,
    info.title.replaceAll(/[^a-zA-Z0-9.-]/gu, '_'),
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function p1Write(directory: string, name: string, data: string | Uint8Array): void {
  writeFileSync(path.join(directory, name), data, { flag: 'wx' });
}

export function p1Source() {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .split(/\r?\n/u)
    .filter(
      (file) =>
        /^(apps|packages|tests|tooling)\//u.test(file) ||
        /^(package.json|pnpm-lock.yaml|.*config.*)$/u.test(file),
    );
  const files = [...new Set(paths)].sort().map((file) => ({
    path: file,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  }));
  return {
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    worktree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }),
    files,
    manifestSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  };
}
