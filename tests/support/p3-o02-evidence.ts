import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestInfo } from '@playwright/test';

/** P3.1o O02 evidence helpers. Distinct from the P1 helpers; never reuses P1 roots. */

export const CONTRACT_NOTE = 'docs/plans/p3-o02-a5-coverage-contract.md';
export const K_ARCHIVE = 'docs/evidence/p3.1k-projection/observations-20261005T073041.json';
export const R0A_REPORT = 'docs/evidence/p3.1n-r0a-wedge/report.json';
/** The `main` squash-merge commit that integrated the FROZEN O02 contract (PR #113). */
export const CONTRACT_COMMIT = '159909283dd2cf23aa94d2ec113e6ec5692e513a';

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

const git = (args: readonly string[]): string =>
  execFileSync('git', [...args], { encoding: 'utf8' });

export function evidenceRoot(): string {
  const root = process.env.P3_O02_OUTPUT_DIR;
  if (root === undefined || root === '') {
    throw new Error('P3_O02_OUTPUT_DIR is unset; run pnpm test:gpu:p3-o02.');
  }
  const resolved = path.resolve(root);
  const cleanup = path.resolve('test-results');
  if (resolved === cleanup || resolved.startsWith(`${cleanup}${path.sep}`)) {
    throw new Error('P3 O02 evidence must be outside Playwright test-results.');
  }
  const repository = path.resolve(git(['rev-parse', '--show-toplevel']).trim());
  const relative = path.relative(repository, resolved);
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (inside) {
    try {
      execFileSync('git', ['check-ignore', '-q', `${relative.replaceAll(path.sep, '/')}/probe`]);
    } catch {
      throw new Error('An in-repository evidence root must be ignored by git.');
    }
  }
  return resolved;
}

/** Creates parents recursively, then the case directory exclusively. */
export function caseDirectory(info: TestInfo): string {
  const parent = path.resolve(evidenceRoot(), info.project.name);
  mkdirSync(parent, { recursive: true });
  const directory = path.join(parent, info.title.replaceAll(/[^a-zA-Z0-9.-]/gu, '_'));
  mkdirSync(directory);
  return directory;
}

/** Writes `<name>.tmp` exclusively, then renames it to the absent final name. */
export function writeExclusiveJson(directory: string, name: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const finalPath = path.join(directory, name);
  const temporary = `${finalPath}.tmp`;
  if (existsSync(finalPath)) throw new Error(`${finalPath} already exists.`);
  writeFileSync(temporary, text, { flag: 'wx' });
  if (existsSync(finalPath)) throw new Error(`${finalPath} already exists.`);
  // renameSync replaces on Windows; the case directory itself was created exclusively.
  renameSync(temporary, finalPath);
  const digest = sha256(text);
  console.log(`${finalPath} sha256=${digest}`);
  return digest;
}

export function sha256OfFile(file: string): string {
  return sha256(readFileSync(file));
}

export function sourceManifest() {
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard'])
    .split(/\r?\n/u)
    .filter(
      (file) =>
        /^(apps|packages|tests|tooling)\//u.test(file) ||
        /^(package.json|pnpm-lock.yaml|.*config.*)$/u.test(file),
    );
  const files = [...new Set(paths)].sort().map((file) => ({
    path: file,
    sha256: sha256OfFile(file),
  }));
  return {
    baseCommit: git(['rev-parse', 'HEAD']).trim(),
    worktree: git(['status', '--short']),
    files,
    manifestSha256: sha256(JSON.stringify(files)),
    contractNoteSha256: sha256OfFile(CONTRACT_NOTE),
    kArchiveSha256: sha256OfFile(K_ARCHIVE),
    r0aReportSha256: sha256OfFile(R0A_REPORT),
  };
}

export type SourceManifest = ReturnType<typeof sourceManifest>;

export function sameManifest(start: SourceManifest, end: SourceManifest): boolean {
  return JSON.stringify(start) === JSON.stringify(end);
}

export function contractIdentity(baseCommit: string) {
  let ancestor: boolean;
  let noteSha256: string | null = null;
  let blobId: string | null = null;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', CONTRACT_COMMIT, baseCommit]);
    ancestor = true;
    noteSha256 = sha256(execFileSync('git', ['show', `${CONTRACT_COMMIT}:${CONTRACT_NOTE}`]));
    blobId = git(['rev-parse', `${CONTRACT_COMMIT}:${CONTRACT_NOTE}`]).trim();
  } catch {
    ancestor = false;
  }
  return {
    commit: CONTRACT_COMMIT,
    ancestorOfBase: ancestor,
    path: CONTRACT_NOTE,
    noteSha256AtCommit: noteSha256,
    blobIdAtCommit: blobId,
    workingTreeNoteSha256: sha256OfFile(CONTRACT_NOTE),
  };
}
