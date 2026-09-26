import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The repository's executable boundary policy is JavaScript tooling.
import { boundaries, workspaceImportTarget } from '../../tooling/boundary-policy.mjs';

const policy = boundaries as Map<string, Set<string>>;
const resolveImport = workspaceImportTarget as (
  specifier: string,
  sourcePath: string,
  roots: Map<string, string>,
) => string | null;
const root = path.resolve(import.meta.dirname, '../..');
const roots = new Map([
  ['@vector-studio/geometry-reference', path.join(root, 'packages/geometry-reference')],
  ['@vector-studio/geometry-wasm', path.join(root, 'packages/geometry-wasm')],
  ['@vector-studio/renderer-core', path.join(root, 'packages/renderer-core')],
  ['@vector-studio/contracts', path.join(root, 'packages/contracts')],
]);
const referenceSource = path.join(root, 'packages/geometry-reference/src/index.ts');

describe('test-only geometry package boundary', () => {
  it('keeps the production adapter independent of the reference and renderer', () => {
    expect([...policy.get('@vector-studio/geometry-wasm')!]).toEqual(['@vector-studio/contracts']);
    const adapter = path.join(root, 'packages/geometry-wasm/src/index.ts');
    expect(resolveImport('../../geometry-reference/src/index.js', adapter, roots)).toBe(
      '@vector-studio/geometry-reference',
    );
    expect(resolveImport('../../geometry-wasm/src/index.js', referenceSource, roots)).toBe(
      '@vector-studio/geometry-wasm',
    );
  });

  it('keeps the oracle independent and absent from every production dependency allowlist', () => {
    expect([...policy.get('@vector-studio/geometry-reference')!]).toEqual([
      '@vector-studio/contracts',
    ]);
    for (const [name, dependencies] of policy) {
      expect(dependencies.has('@vector-studio/geometry-reference'), name).toBe(false);
      expect(dependencies.has('@vector-studio/geometry-wasm'), name).toBe(false);
    }
  });

  it('recognizes forbidden imports through relative paths and package subpaths', () => {
    expect(resolveImport('../../renderer-core/src/index.js', referenceSource, roots)).toBe(
      '@vector-studio/renderer-core',
    );
    expect(resolveImport('@vector-studio/geometry-wasm/private', referenceSource, roots)).toBe(
      '@vector-studio/geometry-wasm',
    );
    expect(
      resolveImport(
        '../geometry-reference/src/index.js',
        path.join(root, 'packages/renderer-core/index.ts'),
        roots,
      ),
    ).toBe('@vector-studio/geometry-reference');
  });

  it('distinguishes local modules, allowed contracts and similarly prefixed directories', () => {
    expect(resolveImport('./numeric.js', referenceSource, roots)).toBe(
      '@vector-studio/geometry-reference',
    );
    expect(resolveImport('../../contracts/src/index.js', referenceSource, roots)).toBe(
      '@vector-studio/contracts',
    );
    expect(
      resolveImport('../../geometry-reference-copy/index.js', referenceSource, roots),
    ).toBeNull();
    expect(resolveImport('node:path', referenceSource, roots)).toBeNull();
  });
});
