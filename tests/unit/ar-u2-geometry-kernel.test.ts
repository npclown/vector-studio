import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// AR-U2 (alpha release plan): the geometry kernel WASM ships in `@vector-studio/geometry-wasm`
// as `dist/kernel.wasm`, its URL from the `./kernel` entry, built by the same pinned command and
// path remaps as the identity-checked build in tooling/test-geometry.mjs.

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('packages/geometry-wasm/package.json')) as {
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
};

describe('AR-U2 geometry kernel packaging', () => {
  it('exports the kernel URL entry and the WASM file', () => {
    expect(manifest.exports['./kernel']).toEqual({
      types: './dist/kernel-url.d.ts',
      import: './dist/kernel-url.js',
    });
    expect(manifest.exports['./kernel.wasm']).toBe('./dist/kernel.wasm');
    expect(manifest.scripts.prepack).toBe(
      'tsc --build && node ../../tooling/build-geometry-kernel.mjs',
    );
  });

  it('resolves the URL next to the module, never from the main entry', () => {
    const source = read('packages/geometry-wasm/src/kernel-url.ts');
    expect(source).toMatch(
      /export const geometryKernelUrl: URL = new URL\('\.\/kernel\.wasm', import\.meta\.url\);/u,
    );
    expect(read('packages/geometry-wasm/src/index.ts')).not.toContain('kernel-url');
  });

  it('builds with the pinned toolchain, flags and path remaps of the identity build', () => {
    const build = read('tooling/build-geometry-kernel.mjs');
    const identity = read('tooling/test-geometry.mjs');
    for (const fragment of [
      "'1.94.1'",
      "'--locked'",
      "'--offline'",
      "'--release'",
      "'wasm32-unknown-unknown'",
      '`${root}=.`',
      "'src\\\\=src/'",
    ]) {
      expect(build, fragment).toContain(fragment);
      expect(identity, fragment).toContain(fragment);
    }
    expect(build).toContain("path.join(dist, 'kernel.wasm')");
    // The same compiler identity (release and commit) and the unremapped-path check.
    expect(build).toContain("'e408947bfd200af42db322daf0fadfe7e26d3bd1'");
    expect(identity).toContain("'e408947bfd200af42db322daf0fadfe7e26d3bd1'");
    expect(build).toContain("bytes.includes(Buffer.from('src\\\\'))");
  });
});
