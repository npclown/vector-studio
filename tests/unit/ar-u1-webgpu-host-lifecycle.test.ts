import type { RendererFactory } from '@vector-studio/react';
import { WebGpuUnavailableError, createWebGpuRendererFactory } from '@vector-studio/webgpu-host';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

// AR-U1 review r1 S2: the factory's lifecycle with the three renderer modules mocked: creation
// and stage order, wrapper chaining, reverse disposal, cleanup on an unsupported capability and
// on a throwing stage, WASM sources (bytes, a subarray view, a compiled module), and the type of
// the returned factory against `@vector-studio/react`'s `RendererFactory`.

const log: string[] = [];
let supported = true;

vi.mock('@vector-studio/geometry-wasm', () => {
  const port = (name: string) => (source: unknown) => {
    log.push(`${name}:${Object.prototype.toString.call(source)}`);
    return Promise.resolve({
      dispose: () => log.push(`dispose ${name}`),
      linearMemoryBytes: () => 0,
    });
  };
  return { createFillMeshPort: port('fill'), createStrokeMeshPort: port('stroke') };
});

vi.mock('@vector-studio/renderer-core', () => ({
  PrimitiveRendererService: class {
    constructor() {
      log.push('service');
    }
    dispose() {
      log.push('dispose service');
    }
  },
}));

vi.mock('@vector-studio/renderer-webgpu', () => ({
  createCanvasGlyphRaster: () => ({ portVersion: 1, operationId: 'raster', rasterize: () => null }),
  WebGpuBackend: class {
    constructor() {
      log.push('backend');
    }
    dispose() {
      log.push('dispose backend');
    }
    attachPrimitiveFrameSource() {
      log.push('attach');
      return { dispose: () => log.push('dispose source') };
    }
    initialize() {
      log.push('initialize');
      return Promise.resolve(
        supported
          ? { supported: true, capabilities: {} }
          : {
              supported: false,
              diagnostic: { code: 'capability.insecure-context', message: 'insecure.' },
            },
      );
    }
  },
}));

/** The smallest valid WASM module: magic and version only. */
const EMPTY = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const canvas = {} as HTMLCanvasElement;
const size = { width: 10, height: 10, devicePixelRatio: 1 };

beforeEach(() => {
  log.length = 0;
  supported = true;
});

describe('AR-U1 webgpu-host factory lifecycle', () => {
  it('returns a factory assignable to the React bindings RendererFactory', () => {
    expectTypeOf(createWebGpuRendererFactory({ wasm: EMPTY })).toExtend<RendererFactory>();
  });

  it('runs the stages around attach and initialize, chains wrappers, disposes in reverse', async () => {
    const wrapped = { name: 'wrapped' } as never;
    const benched = { name: 'benched' } as never;
    const handle = await createWebGpuRendererFactory({
      wasm: EMPTY,
      beforeInitialize: ({ renderer, addRelease }) => {
        log.push(`before:${renderer === wrapped ? 'wrapped' : 'service'}`);
        addRelease(() => log.push('dispose before'));
        return { renderer: wrapped };
      },
      afterInitialize: ({ renderer }) => {
        log.push(`after:${renderer === wrapped ? 'wrapped' : 'other'}`);
        return { renderer: benched, release: () => log.push('dispose after') };
      },
    })(canvas, size);
    expect(handle.renderer).toBe(benched);
    expect(log).toEqual([
      'fill:[object WebAssembly.Module]',
      'stroke:[object WebAssembly.Module]',
      'backend',
      'service',
      'before:service',
      'attach',
      'initialize',
      'after:wrapped',
    ]);
    log.length = 0;
    handle.dispose();
    handle.dispose();
    expect(log).toEqual([
      'dispose after',
      'dispose source',
      'dispose before',
      'dispose service',
      'dispose backend',
      'dispose stroke',
      'dispose fill',
    ]);
  });

  it('cleans up and throws WebGpuUnavailableError when WebGPU is unsupported', async () => {
    supported = false;
    const after = vi.fn();
    const run = createWebGpuRendererFactory({ wasm: EMPTY, afterInitialize: after })(canvas, size);
    await expect(run).rejects.toBeInstanceOf(WebGpuUnavailableError);
    expect(after).not.toHaveBeenCalled();
    expect(log.slice(-5)).toEqual([
      'dispose source',
      'dispose service',
      'dispose backend',
      'dispose stroke',
      'dispose fill',
    ]);
  });

  it('runs releases registered before a stage throws', async () => {
    const run = createWebGpuRendererFactory({
      wasm: EMPTY,
      beforeInitialize: ({ addRelease }) => {
        addRelease(() => log.push('dispose partial'));
        throw new Error('stage failed');
      },
    })(canvas, size);
    await expect(run).rejects.toThrow('stage failed');
    expect(log).not.toContain('attach');
    expect(log.slice(-5)).toEqual([
      'dispose partial',
      'dispose service',
      'dispose backend',
      'dispose stroke',
      'dispose fill',
    ]);
  });

  it('accepts a subarray view, an ArrayBuffer, a compiled module and a loader', async () => {
    const padded = new Uint8Array(EMPTY.length + 4);
    padded.set(EMPTY, 2);
    const module = await WebAssembly.compile(EMPTY);
    for (const wasm of [
      padded.subarray(2, 2 + EMPTY.length),
      EMPTY.slice().buffer,
      module,
      () => Promise.resolve(module),
    ]) {
      log.length = 0;
      const handle = await createWebGpuRendererFactory({ wasm })(canvas, size);
      expect(log[0]).toBe('fill:[object WebAssembly.Module]');
      handle.dispose();
    }
  });
});
