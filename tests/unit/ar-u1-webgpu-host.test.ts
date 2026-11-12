import path from 'node:path';
import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';
import {
  GeometryWasmUnavailableError,
  WebGpuUnavailableError,
  createWebGpuRendererFactory,
  editorRendererOptions,
  webGpuUnavailableMessage,
} from '@vector-studio/webgpu-host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundaries,
  evaluatePackageBoundaries,
  externalDenied,
  packageDirectories,
  // @ts-expect-error The repository's executable boundary policy is JavaScript tooling.
} from '../../tooling/boundary-policy.mjs';

// AR-U1 (alpha release plan; ADR 0004): the packaged WebGPU host composition. Its boundary
// entry, its UI-package denial, the renderer packages' unchanged geometry-wasm denial, the
// editor service options, the unavailable-WebGPU message and the WASM load failure.

const root = path.resolve(import.meta.dirname, '../..');
const policy = boundaries as Map<string, Set<string>>;
const denied = externalDenied as Map<string, Set<string>>;
const evaluate = evaluatePackageBoundaries as (input: {
  manifest: { name: string; dependencies?: Record<string, string> };
  sources: { path: string; text: string }[];
  packageRoots: Map<string, string>;
}) => string[];

const HOST = '@vector-studio/webgpu-host';
const packageRoot = path.join(root, 'packages/webgpu-host');
const packageRoots = new Map([
  ['@vector-studio/contracts', path.join(root, 'packages/contracts')],
  ['@vector-studio/geometry-wasm', path.join(root, 'packages/geometry-wasm')],
  ['@vector-studio/react', path.join(root, 'packages/react')],
  [HOST, packageRoot],
]);
const planted = path.join(packageRoot, 'src/planted.ts');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AR-U1 webgpu-host boundary policy', () => {
  it('allows the renderer, geometry and contracts packages and denies the UI packages', () => {
    expect([...policy.get(HOST)!].sort()).toEqual([
      '@vector-studio/contracts',
      '@vector-studio/geometry-wasm',
      '@vector-studio/renderer-core',
      '@vector-studio/renderer-webgpu',
    ]);
    expect([...denied.get(HOST)!].sort()).toEqual(['next', 'react', 'react-dom']);
    expect(packageDirectories as string[]).toContain('packages/webgpu-host');
  });

  it('keeps geometry-wasm out of the renderer packages', () => {
    expect(policy.get('@vector-studio/renderer-webgpu')!.has('@vector-studio/geometry-wasm')).toBe(
      false,
    );
    expect(policy.get('@vector-studio/renderer-core')!.has('@vector-studio/geometry-wasm')).toBe(
      false,
    );
    expect(policy.get('@vector-studio/react')!.has(HOST)).toBe(false);
  });

  it('rejects a planted import of the React bindings or of react', () => {
    const failures = evaluate({
      manifest: { name: HOST, dependencies: { '@vector-studio/contracts': 'workspace:*' } },
      sources: [
        {
          path: planted,
          text: "import { EditorCanvas } from '@vector-studio/react';\nimport 'react';\n",
        },
      ],
      packageRoots,
    });
    expect(failures.join('\n')).toContain('@vector-studio/react');
    expect(failures.join('\n')).toContain('react');
  });
});

describe('AR-U1 webgpu-host entry', () => {
  it('gives the editor service options', () => {
    const port = { portVersion: 1, operationId: 'x', rasterize: () => null } as never;
    expect(editorRendererOptions(port)).toEqual({
      clips: 'all',
      paints: 'gradient',
      groups: 'isolated',
      text: 'atlas',
      effects: 'v0',
      blend: 'v0',
      glyphRaster: port,
    });
  });

  it('names the fix for an insecure context and a missing API', () => {
    const insecure = webGpuUnavailableMessage({
      code: DIAGNOSTIC_CODES.INSECURE_CONTEXT,
      message: 'WebGPU requires a secure context.',
    } as never);
    expect(insecure).toMatch(/^WebGPU is not available: WebGPU requires a secure context\./);
    expect(insecure).toContain('localhost');
    expect(insecure).toContain('https://');
    const missing = webGpuUnavailableMessage({
      code: DIAGNOSTIC_CODES.API_UNAVAILABLE,
      message: 'The WebGPU API is unavailable.',
    } as never);
    expect(missing).toContain('Chrome or Edge');
    const error = new WebGpuUnavailableError({
      code: DIAGNOSTIC_CODES.INSECURE_CONTEXT,
      message: 'WebGPU requires a secure context.',
    } as never);
    expect(error.name).toBe('WebGpuUnavailableError');
    expect(error.diagnostic.code).toBe(DIAGNOSTIC_CODES.INSECURE_CONTEXT);
  });

  it('throws GeometryWasmUnavailableError when the WASM URL answers 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    );
    const factory = createWebGpuRendererFactory({ wasm: '/missing.wasm' });
    const run = factory({} as HTMLCanvasElement, { width: 1, height: 1, devicePixelRatio: 1 });
    await expect(run).rejects.toBeInstanceOf(GeometryWasmUnavailableError);
    await expect(run).rejects.toThrow('/missing.wasm (HTTP 404)');
  });
});
