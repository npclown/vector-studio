import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Locator, TestInfo } from '@playwright/test';

export interface EvidenceSource {
  readonly revision: string;
  readonly sourceWorktree: 'clean' | 'dirty';
  readonly sourceChanges: readonly string[];
}

function repositoryPath(value: string): string {
  return path.relative(process.cwd(), value).replaceAll('\\', '/');
}

function outputDirectory(testInfo: TestInfo): string {
  const requested = process.env.P0_EVIDENCE_OUTPUT_DIR;
  return requested === undefined ? testInfo.outputDir : path.resolve(requested);
}

export function evidenceSource(testInfo: TestInfo): EvidenceSource {
  const directory = repositoryPath(outputDirectory(testInfo));
  const ignoredRoots = [directory, 'docs/benchmarks/results', 'test-results'];
  const sourceChanges = execFileSync('git', ['status', '--short'], { encoding: 'utf8' })
    .split(/\r?\n/u)
    .filter((entry) => {
      if (entry === '') return false;
      const changedPath = entry.slice(3).replaceAll('\\', '/').replace(/\/$/u, '');
      return !ignoredRoots.some(
        (root) =>
          changedPath === root ||
          changedPath.startsWith(`${root}/`) ||
          root.startsWith(`${changedPath}/`),
      );
    });
  return {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceWorktree: sourceChanges.length === 0 ? 'clean' : 'dirty',
    sourceChanges,
  };
}

export function evidencePath(testInfo: TestInfo, fileName: string): string {
  const directory = outputDirectory(testInfo);
  mkdirSync(directory, { recursive: true });
  return path.join(directory, fileName);
}

export function writeEvidenceJson(testInfo: TestInfo, fileName: string, value: unknown): string {
  const destination = evidencePath(testInfo, fileName);
  writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return destination;
}

export async function captureEvidenceScreenshot(
  testInfo: TestInfo,
  fileName: string,
  locator: Locator,
): Promise<string> {
  const destination = evidencePath(testInfo, fileName);
  if (existsSync(destination)) throw new Error(`Evidence already exists: ${destination}`);
  await locator.screenshot({ path: destination });
  return destination;
}
