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

// MVP M5-U3 (M5 contract, section 4.1): the boundary-policy entry of the new adapter package
// (M5-A09), with seeded manifests and sources.

const root = path.resolve(import.meta.dirname, '../..');
const policy = boundaries as Map<string, Set<string>>;
const denied = externalDenied as Map<string, Set<string>>;
const directories = packageDirectories as string[];
const evaluate = evaluatePackageBoundaries as (input: {
  manifest: { name: string; dependencies?: Record<string, string> };
  sources: { path: string; text: string }[];
  packageRoots: Map<string, string>;
}) => string[];

const packageRoots = new Map([
  ['@vector-studio/contracts', path.join(root, 'packages/contracts')],
  ['@vector-studio/editor-core', path.join(root, 'packages/editor-core')],
  ['@vector-studio/model', path.join(root, 'packages/model')],
  ['@vector-studio/persistence-idb', path.join(root, 'packages/persistence-idb')],
  ['@vector-studio/next-host', path.join(root, 'apps/next-host')],
]);
const ADAPTER = '@vector-studio/persistence-idb';
const adapterSource = path.join(root, 'packages/persistence-idb/src/seeded.ts');

describe('M5-A09 persistence-idb boundary policy', () => {
  it('allows the adapter model and contracts only', () => {
    expect([...policy.get(ADAPTER)!].sort()).toEqual([
      '@vector-studio/contracts',
      '@vector-studio/model',
    ]);
  });

  it('denies the UI packages and the fake IndexedDB package', () => {
    expect([...denied.get(ADAPTER)!].sort()).toEqual([
      'fake-indexeddb',
      'next',
      'react',
      'react-dom',
    ]);
  });

  it('lists the package directory and lets next-host depend on the adapter', () => {
    expect(directories).toContain('packages/persistence-idb');
    expect(policy.get('@vector-studio/next-host')!.has(ADAPTER)).toBe(true);
  });

  it('rejects the adapter importing editor-core', () => {
    const source = {
      path: adapterSource,
      text: "import { createEditor } from '@vector-studio/editor-core';\n",
    };
    expect(
      evaluate({
        manifest: {
          name: ADAPTER,
          dependencies: {
            '@vector-studio/editor-core': 'workspace:*',
            '@vector-studio/model': 'workspace:*',
          },
        },
        sources: [source],
        packageRoots,
      }),
    ).toEqual([
      '@vector-studio/persistence-idb: manifest dependency on @vector-studio/editor-core is forbidden',
      `${adapterSource}: source import of @vector-studio/editor-core is forbidden`,
    ]);
  });

  it('rejects the adapter importing editor-core by a relative path', () => {
    const source = {
      path: adapterSource,
      text: "import { createEditor } from '../../editor-core/src/index.js';\n",
    };
    expect(evaluate({ manifest: { name: ADAPTER }, sources: [source], packageRoots })).toEqual([
      `${adapterSource}: source import of @vector-studio/editor-core is forbidden`,
    ]);
  });

  it.each(['react', 'react-dom', 'next', 'fake-indexeddb'])(
    'rejects the adapter naming %s in its manifest and source',
    (name) => {
      const source = { path: adapterSource, text: `import value from '${name}';\n` };
      expect(
        evaluate({
          manifest: { name: ADAPTER, dependencies: { [name]: '1.0.0' } },
          sources: [source],
          packageRoots,
        }),
      ).toEqual([
        `@vector-studio/persistence-idb: manifest dependency on ${name} is forbidden`,
        `${adapterSource}: source import of ${name} is forbidden`,
      ]);
    },
  );

  it('passes next-host importing the adapter', () => {
    const source = {
      path: path.join(root, 'apps/next-host/src/seeded.ts'),
      text: "import { openDocumentStore } from '@vector-studio/persistence-idb';\n",
    };
    expect(
      evaluate({
        manifest: {
          name: '@vector-studio/next-host',
          dependencies: { [ADAPTER]: 'workspace:*' },
        },
        sources: [source],
        packageRoots,
      }),
    ).toEqual([]);
  });

  it('passes the adapter importing model and contracts', () => {
    const source = {
      path: adapterSource,
      text: "import type { PersistenceEnvelope } from '@vector-studio/model';\nimport type { SceneColor } from '@vector-studio/contracts';\n",
    };
    expect(
      evaluate({
        manifest: {
          name: ADAPTER,
          dependencies: {
            '@vector-studio/contracts': 'workspace:*',
            '@vector-studio/model': 'workspace:*',
          },
        },
        sources: [source],
        packageRoots,
      }),
    ).toEqual([]);
  });

  it('keeps the committed adapter on model only, with no editor-core, React or fake import', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, 'packages/persistence-idb/package.json'), 'utf8'),
    ) as { name: string; private: boolean; dependencies: Record<string, string> };
    expect([manifest.name, manifest.private, manifest.dependencies]).toEqual([
      ADAPTER,
      true,
      { '@vector-studio/model': 'workspace:*' },
    ]);
    const dir = path.join(root, 'packages/persistence-idb/src');
    const files = (await readdir(dir)).filter((file) => file.endsWith('.ts')).sort();
    expect(files).toEqual(['autosave.ts', 'codes.ts', 'index.ts', 'store.ts']);
    const sources = await Promise.all(
      files.map(async (file) => ({
        path: path.join(dir, file),
        text: await readFile(path.join(dir, file), 'utf8'),
      })),
    );
    expect(evaluate({ manifest, sources, packageRoots })).toEqual([]);
    const bare = sources.flatMap((source) =>
      [...source.text.matchAll(/\bfrom\s+'([^']+)'/g)]
        .map((match) => match[1]!)
        .filter((specifier) => !specifier.startsWith('./')),
    );
    expect([...new Set(bare)]).toEqual(['@vector-studio/model']);
    // The only browser global is the default factory, read in the store when none is injected.
    const globals = sources
      .filter((source) => /\bglobalThis\b/.test(source.text))
      .map((source) => path.basename(source.path));
    expect(globals).toEqual(['store.ts']);
    expect(sources.find((source) => source.path.endsWith('store.ts'))!.text).toContain(
      'options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory | undefined }).indexedDB',
    );
  });
});
