import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateContractsPurity,
  evaluatePackageBoundaries,
  stripComments,
  // @ts-expect-error The repository's executable boundary policy is JavaScript tooling.
} from '../../tooling/boundary-policy.mjs';

// P3 V2 contract section i: P-B1 negative fixtures, one per forbidden edge,
// and P-B2 contracts purity with seeded negative fixtures.

type Source = Readonly<{ path: string; text: string }>;
type Manifest = Readonly<{ name: string; dependencies?: Record<string, string> }>;

const evaluatePackage = evaluatePackageBoundaries as (input: {
  manifest: Manifest;
  sources: readonly Source[];
  packageRoots: Map<string, string>;
}) => string[];
const evaluateContracts = evaluateContractsPurity as (input: {
  sources: readonly Source[];
  contractsSourceRoot: string;
}) => string[];
const strip = stripComments as (text: string) => string;

const root = path.resolve(import.meta.dirname, '../..');
const packageRoots = new Map([
  ['@vector-studio/contracts', path.join(root, 'packages/contracts')],
  ['@vector-studio/geometry-reference', path.join(root, 'packages/geometry-reference')],
  ['@vector-studio/geometry-wasm', path.join(root, 'packages/geometry-wasm')],
  ['@vector-studio/renderer-core', path.join(root, 'packages/renderer-core')],
  ['@vector-studio/renderer-webgpu', path.join(root, 'packages/renderer-webgpu')],
  ['@vector-studio/playground', path.join(root, 'apps/playground')],
]);
const contractsSourceRoot = path.join(root, 'packages/contracts/src');

function sourceIn(packageName: string, text: string): Source {
  return { path: path.join(packageRoots.get(packageName)!, 'src', 'fixture.ts'), text };
}

function manifestOf(name: string, extra: readonly string[] = []): Manifest {
  return {
    name,
    dependencies: Object.fromEntries(
      ['@vector-studio/contracts', ...extra].map((dependency) => [dependency, 'workspace:*']),
    ),
  };
}

function importViolations(packageName: string, specifier: string, target: string): string[] {
  return evaluatePackage({
    manifest: manifestOf(packageName),
    sources: [sourceIn(packageName, `import { value } from '${specifier}';\n`)],
    packageRoots,
  }).filter((failure) => failure.includes(`source import of ${target}`));
}

describe('P-B1 geometry-wasm dependency edges', () => {
  for (const consumer of ['@vector-studio/renderer-core', '@vector-studio/renderer-webgpu']) {
    it(`rejects ${consumer} -> geometry-wasm by manifest, alias, subpath and relative import`, () => {
      expect(
        evaluatePackage({
          manifest: manifestOf(consumer, ['@vector-studio/geometry-wasm']),
          sources: [],
          packageRoots,
        }),
      ).toEqual([`${consumer}: manifest dependency on @vector-studio/geometry-wasm is forbidden`]);
      for (const specifier of [
        '@vector-studio/geometry-wasm',
        '@vector-studio/geometry-wasm/private',
        '../../geometry-wasm/src/index.js',
      ]) {
        expect(
          importViolations(consumer, specifier, '@vector-studio/geometry-wasm'),
          specifier,
        ).toHaveLength(1);
      }
    });
  }

  it('rejects contracts -> geometry-wasm by alias and relative import', () => {
    for (const specifier of ['@vector-studio/geometry-wasm', '../../geometry-wasm/src/index.js']) {
      expect(
        importViolations('@vector-studio/contracts', specifier, '@vector-studio/geometry-wasm'),
        specifier,
      ).toHaveLength(1);
    }
  });

  it('rejects geometry-wasm -> renderer-core and geometry-reference by alias and relative import', () => {
    for (const [specifier, target] of [
      ['@vector-studio/renderer-core', '@vector-studio/renderer-core'],
      ['../../renderer-core/src/index.js', '@vector-studio/renderer-core'],
      ['@vector-studio/geometry-reference', '@vector-studio/geometry-reference'],
      ['../../geometry-reference/src/index.js', '@vector-studio/geometry-reference'],
    ] as const) {
      expect(
        importViolations('@vector-studio/geometry-wasm', specifier, target),
        specifier,
      ).toHaveLength(1);
    }
  });

  it('allows the playground host and the adapter contracts edge', () => {
    expect(
      evaluatePackage({
        manifest: manifestOf('@vector-studio/playground', ['@vector-studio/geometry-wasm']),
        sources: [
          sourceIn(
            '@vector-studio/playground',
            "import { createFillMeshPort } from '@vector-studio/geometry-wasm';\n",
          ),
        ],
        packageRoots,
      }),
    ).toEqual([]);
    expect(
      evaluatePackage({
        manifest: manifestOf('@vector-studio/geometry-wasm'),
        sources: [
          sourceIn(
            '@vector-studio/geometry-wasm',
            "import type { FillMeshPort } from '@vector-studio/contracts';\n",
          ),
        ],
        packageRoots,
      }),
    ).toEqual([]);
  });
});

describe('P-B2 contracts purity', () => {
  const contractsSource = (text: string): Source => ({
    path: path.join(contractsSourceRoot, 'fixture.ts'),
    text,
  });
  const check = (text: string): string[] =>
    evaluateContracts({ sources: [contractsSource(text)], contractsSourceRoot });

  it('reports the seeded negative fixtures', () => {
    expect(check('export type Handle = { memory: WebAssembly.Memory };\n')).toHaveLength(1);
    expect(check("import type { Renderer } from '../../renderer-core/src/index.js';\n")).toEqual([
      expect.stringContaining('leaves packages/contracts/src') as string,
    ]);
    expect(check("import type { ReactNode } from 'react';\n")).toEqual([
      expect.stringContaining('bare specifier react') as string,
    ]);
    expect(check("export * from '@vector-studio/geometry-wasm';\n").length).toBeGreaterThan(0);
  });

  it('reports GPU types and every WASM handle pattern outside comments', () => {
    for (const text of [
      'export type Texture = GPUTexture;',
      'export type A = { wasmModule: number };',
      'export type A = { pointer: number };',
      'export type A = { linearMemory: number };',
      'export type A = { memoryEpoch: number };',
      'export type A = { arena: number };',
      'export type A = { ptr: number };',
      'export type A = { inputPtr: number };',
    ]) {
      expect(check(`${text}\n`), text).not.toEqual([]);
    }
  });

  it('accepts comments, other meanings of memory, epoch and offset, and relative imports', () => {
    expect(
      check(
        [
          "import type { SceneEpoch } from './scene.js';",
          '/** Names the operation, for example the geometry-wasm/fill-v0 WebAssembly pointer. */',
          '// GPUBuffer, arena and inputPtr appear only in this comment.',
          "export type Failure = 'OUT_OF_MEMORY';",
          'export type Range = { offset: number; epoch: SceneEpoch };',
          '',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('strips comments with the TypeScript scanner, not inside literals', () => {
    expect(check("export const marker = '// WebAssembly';\n")).toHaveLength(1);
    expect(check('export const marker = `/* arena ${1} */`;\n')).toHaveLength(1);
    expect(strip('const a = 1; // wasm\n/* ptr */ const b = `x${a}y`;')).not.toMatch(/wasm|ptr/u);
    expect(strip('const a = `x${a}y`; // wasm')).toContain('`x${a}y`');
  });

  it('passes on the real contracts sources', async () => {
    const entries = await readdir(contractsSourceRoot, { withFileTypes: true });
    const sources = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map(async (entry) => {
          const sourcePath = path.join(contractsSourceRoot, entry.name);
          return { path: sourcePath, text: await readFile(sourcePath, 'utf8') };
        }),
    );
    expect(sources.some((source) => source.text.includes("'geometry-wasm/fill-v0'"))).toBe(true);
    expect(evaluateContracts({ sources, contractsSourceRoot })).toEqual([]);
  });
});
