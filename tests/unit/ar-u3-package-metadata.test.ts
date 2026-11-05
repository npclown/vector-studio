import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALPHA_PACKAGES,
  ALPHA_REGISTRY,
  ALPHA_REPOSITORY,
  ALPHA_VERSION,
  // @ts-expect-error The repository's release tooling is JavaScript.
} from '../../tooling/alpha-packages.mjs';

// AR-U3 (alpha release plan): every package of the alpha set carries the same version and the
// release metadata, ships only `dist` and `src` with its README and LICENSE, and stays private
// until AR-U5 (the publish, after the user's go-ahead) removes the flag.

const root = path.resolve(import.meta.dirname, '../..');
const packages = ALPHA_PACKAGES as string[];
const registry = ALPHA_REGISTRY as string;
const version = ALPHA_VERSION as string;
const repository = ALPHA_REPOSITORY as string;

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  description?: string;
  license?: string;
  repository?: { type: string; url: string; directory: string };
  files?: string[];
  publishConfig?: { registry: string; tag: string };
  exports?: Record<string, string | Record<string, string>>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const manifest = (directory: string) =>
  JSON.parse(readFileSync(path.join(root, directory, 'package.json'), 'utf8')) as Manifest;

describe('AR-U3 alpha package metadata', () => {
  it('lists every workspace package except the test oracle and the apps', () => {
    expect(packages).toHaveLength(11);
    expect(packages).not.toContain('packages/geometry-reference');
    expect(version).toBe('0.1.0-alpha.0');
  });

  it.each(packages)('%s carries the release metadata', (directory) => {
    const pkg = manifest(directory);
    expect(pkg.name.startsWith('@vector-studio/')).toBe(true);
    expect(pkg.version).toBe(version);
    expect(pkg.private).toBe(true);
    expect(pkg.description?.length ?? 0).toBeGreaterThan(10);
    expect(pkg.license).toBe('UNLICENSED');
    expect(pkg.repository).toEqual({
      type: 'git',
      url: `git+${repository}.git`,
      directory,
    });
    expect(pkg.files).toEqual(['dist', 'src', '!dist/*.tsbuildinfo']);
    // The `alpha` dist-tag keeps a publish without `--tag` from moving `latest` (AR-U5).
    expect(pkg.publishConfig).toEqual({ registry, tag: 'alpha' });
    expect(existsSync(path.join(root, directory, 'README.md'))).toBe(true);
    expect(readFileSync(path.join(root, directory, 'LICENSE'), 'utf8')).toBe(
      readFileSync(path.join(root, 'LICENSE'), 'utf8'),
    );
  });

  it.each(packages)('%s exports only files it ships', (directory) => {
    const targets = Object.values(manifest(directory).exports ?? {}).flatMap((entry) =>
      typeof entry === 'string' ? [entry] : Object.values(entry),
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).toMatch(/^\.\/dist\//);
  });

  it('depends only on packages of the alpha set inside the workspace', () => {
    const names = new Set(packages.map((directory) => manifest(directory).name));
    for (const directory of packages) {
      const pkg = manifest(directory);
      for (const dependency of Object.keys({
        ...pkg.dependencies,
        ...pkg.peerDependencies,
      })) {
        if (dependency.startsWith('@vector-studio/')) expect(names.has(dependency)).toBe(true);
      }
    }
  });
});
