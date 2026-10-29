import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boundaries,
  evaluatePackageBoundaries,
  externalDenied,
  packageDirectories,
  // @ts-expect-error The repository's executable boundary policy is JavaScript tooling.
} from '../../tooling/boundary-policy.mjs';

// MVP M6a-U4 (M6a contract, section 4; M6a-A04, M6a-A14): the boundary-policy entry of
// `@vector-studio/text-dom`, the `text-dom -> contracts` edge ADR 0003 names, with planted
// manifests and sources.

const root = path.resolve(import.meta.dirname, '../..');
const policy = boundaries as Map<string, Set<string>>;
const denied = externalDenied as Map<string, Set<string>>;
const directories = packageDirectories as string[];
const evaluate = evaluatePackageBoundaries as (input: {
  manifest: { name: string; dependencies?: Record<string, string> };
  sources: { path: string; text: string }[];
  packageRoots: Map<string, string>;
}) => string[];

const TEXT_DOM = '@vector-studio/text-dom';
const packageRoot = path.join(root, 'packages/text-dom');
const packageRoots = new Map([
  ['@vector-studio/contracts', path.join(root, 'packages/contracts')],
  ['@vector-studio/model', path.join(root, 'packages/model')],
  ['@vector-studio/editor-core', path.join(root, 'packages/editor-core')],
  [TEXT_DOM, packageRoot],
  ['@vector-studio/next-host', path.join(root, 'apps/next-host')],
]);
const planted = path.join(packageRoot, 'src/planted.ts');

describe('M6a-A04 text-dom boundary policy', () => {
  it('allows contracts only and denies the UI packages', () => {
    expect([...policy.get(TEXT_DOM)!]).toEqual(['@vector-studio/contracts']);
    expect([...denied.get(TEXT_DOM)!].sort()).toEqual(['next', 'react', 'react-dom']);
  });

  it('lists the package directory; only next-host among the others may depend on it', () => {
    expect(directories).toContain('packages/text-dom');
    expect(
      [...policy].filter(([, allowed]) => allowed.has(TEXT_DOM)).map(([name]) => name),
    ).toEqual(['@vector-studio/next-host']);
  });

  it('passes the committed manifest and sources', async () => {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ '@vector-studio/contracts': 'workspace:*' });
    const names = (await readdir(path.join(packageRoot, 'src'))).filter((name) =>
      name.endsWith('.ts'),
    );
    const sources = await Promise.all(
      names.map(async (name) => {
        const sourcePath = path.join(packageRoot, 'src', name);
        return { path: sourcePath, text: await readFile(sourcePath, 'utf8') };
      }),
    );
    expect(sources.length).toBeGreaterThan(0);
    expect(evaluate({ manifest, sources, packageRoots })).toEqual([]);
  });

  it('fails a planted model import, by manifest, package name and relative path', () => {
    expect(
      evaluate({
        manifest: { name: TEXT_DOM, dependencies: { '@vector-studio/model': 'workspace:*' } },
        sources: [
          { path: planted, text: "import { parseDocument } from '@vector-studio/model';\n" },
          { path: planted, text: "import type { TextNode } from '../../model/src/index.js';\n" },
        ],
        packageRoots,
      }),
    ).toEqual([
      '@vector-studio/text-dom: manifest dependency on @vector-studio/model is forbidden',
      `${planted}: source import of @vector-studio/model is forbidden`,
      `${planted}: source import of @vector-studio/model is forbidden`,
    ]);
  });

  it.each(['react', 'react-dom', 'next'])('fails a planted %s import', (name) => {
    expect(
      evaluate({
        manifest: { name: TEXT_DOM, dependencies: { [name]: '1.0.0' } },
        sources: [{ path: planted, text: `import value from '${name}';\n` }],
        packageRoots,
      }),
    ).toEqual([
      `@vector-studio/text-dom: manifest dependency on ${name} is forbidden`,
      `${planted}: source import of ${name} is forbidden`,
    ]);
  });

  it('fails an editor-core import and passes next-host importing text-dom', () => {
    expect(
      evaluate({
        manifest: { name: TEXT_DOM },
        sources: [
          { path: planted, text: "import { createEditor } from '@vector-studio/editor-core';\n" },
        ],
        packageRoots,
      }),
    ).toEqual([`${planted}: source import of @vector-studio/editor-core is forbidden`]);
    expect(
      evaluate({
        manifest: { name: '@vector-studio/next-host', dependencies: { [TEXT_DOM]: 'workspace:*' } },
        sources: [
          {
            path: path.join(root, 'apps/next-host/src/planted.ts'),
            text: "import { createTextDom } from '@vector-studio/text-dom';\n",
          },
        ],
        packageRoots,
      }),
    ).toEqual([]);
  });
});
