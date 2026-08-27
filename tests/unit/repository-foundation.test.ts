import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('repository foundation', () => {
  it('pins the package manager and Node version', async () => {
    const rootManifest = await readJson('package.json');
    const nodeVersion = (await readFile(path.join(repositoryRoot, '.node-version'), 'utf8')).trim();

    expect(rootManifest.packageManager).toBe('pnpm@11.1.2');
    expect(nodeVersion).toBe('24.15.0');
    expect(rootManifest.engines).toEqual({ node: '24.15.0', pnpm: '11.1.2' });
  });

  it('exposes every planned root command', async () => {
    const rootManifest = await readJson('package.json');
    const scripts = rootManifest.scripts as Record<string, string>;
    const requiredScripts = [
      'build',
      'check',
      'test:unit',
      'test:browser',
      'test:gpu',
      'benchmark:p0',
    ] as const;

    for (const script of requiredScripts) {
      expect(typeof scripts[script], script).toBe('string');
    }
  });
});
