import {
  PipelineCache,
  type PipelineCacheKey,
} from '../../packages/renderer-webgpu/src/pipeline-cache.js';
import { describe, expect, it, vi } from 'vitest';

const key = {
  shaderKey: 'shader',
  layoutKey: 'layout',
  vertexLayoutKey: 'vertex',
  targetFormat: 'bgra8unorm',
  renderStateKey: 'state',
  sampleCount: 1 as const,
};
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PipelineCache', () => {
  it('deduplicates structural keys, snapshots them, and reuses ready entries', async () => {
    const cache = new PipelineCache<string>(1);
    const factory = vi.fn((factoryKey: PipelineCacheKey) => {
      expect(Object.isFrozen(factoryKey)).toBe(true);
      return 'pipeline';
    });
    const mutable = { ...key };
    const first = cache.getOrCreate(mutable, factory);
    mutable.shaderKey = 'changed';
    const reversed = {
      sampleCount: 1 as const,
      renderStateKey: 'state',
      targetFormat: 'bgra8unorm',
      vertexLayoutKey: 'vertex',
      layoutKey: 'layout',
      shaderKey: 'shader',
    };
    expect(cache.getOrCreate(reversed, factory)).toBe(first);
    await expect(first).resolves.toBe('pipeline');
    await expect(cache.getOrCreate({ ...key }, factory)).resolves.toBe('pipeline');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('uses every key field and cannot collide on delimiters', async () => {
    const cache = new PipelineCache<string>(1);
    const factory = vi.fn((factoryKey: PipelineCacheKey) => JSON.stringify(factoryKey));
    const keys = [
      key,
      { ...key, shaderKey: 'shader-2' },
      { ...key, layoutKey: 'layout-2' },
      { ...key, vertexLayoutKey: 'vertex-2' },
      { ...key, targetFormat: 'rgba8unorm' },
      { ...key, renderStateKey: 'state-2' },
      { ...key, sampleCount: 4 as const },
      { ...key, shaderKey: 'a|b', layoutKey: 'c' },
      { ...key, shaderKey: 'a', layoutKey: 'b|c' },
    ];
    await Promise.all(keys.map((entry) => cache.getOrCreate(entry, factory)));
    expect(factory).toHaveBeenCalledTimes(keys.length);
  });

  it('registers before factory re-entry and retries failures', async () => {
    const cache = new PipelineCache<string>(1);
    let nested!: Promise<string>;
    const first = cache.getOrCreate(key, () => {
      nested = cache.getOrCreate({ ...key }, () => 'duplicate');
      return 'pipeline';
    });
    await expect(first).resolves.toBe('pipeline');
    await expect(nested).resolves.toBe('pipeline');
    await expect(
      cache.getOrCreate({ ...key, shaderKey: 'sync' }, () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    await expect(
      cache.getOrCreate({ ...key, shaderKey: 'async' }, () => Promise.reject(new Error('async'))),
    ).rejects.toThrow('async');
    await expect(
      cache.getOrCreate({ ...key, shaderKey: 'async' }, () => 'async-retry'),
    ).resolves.toBe('async-retry');
  });

  it('does not start work invalidated before its scheduled factory runs', async () => {
    const cache = new PipelineCache<string>(1);
    const factory = vi.fn(() => 'old');
    const lossPending = cache.getOrCreate(key, factory);
    cache.advanceGeneration(2);
    await expect(lossPending).rejects.toThrow('invalidated before it started');
    const disposePending = cache.getOrCreate(key, factory);
    cache.dispose();
    await expect(disposePending).rejects.toThrow('invalidated before it started');
    expect(factory).not.toHaveBeenCalled();
  });

  it('keeps same-key recreations when stale creation succeeds or fails', async () => {
    const released: string[] = [];
    const cache = new PipelineCache<string>(1, { release: (value) => released.push(value) });
    let resolveOld!: (value: string) => void;
    const old = cache.getOrCreate(
      key,
      () =>
        new Promise<string>((resolve) => {
          resolveOld = resolve;
        }),
    );
    await flush();
    cache.advanceGeneration(2);
    const fresh = cache.getOrCreate(key, () => 'fresh');
    resolveOld('old');
    await expect(old).rejects.toThrow('stale generation');
    await expect(fresh).resolves.toBe('fresh');
    let rejectOld!: (reason: Error) => void;
    const staleFailure = cache.getOrCreate(
      { ...key, shaderKey: 'failure' },
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    await flush();
    cache.advanceGeneration(3);
    const replacement = cache.getOrCreate({ ...key, shaderKey: 'failure' }, () => 'replacement');
    rejectOld(new Error('old failure'));
    await expect(staleFailure).rejects.toThrow('old failure');
    await expect(replacement).resolves.toBe('replacement');
    expect(released).toEqual(['old', 'fresh']);
  });

  it('releases successful values exactly once, including undefined and reentrant release', async () => {
    const released: Array<string | undefined> = [];
    const cache = new PipelineCache<string | undefined>(1, {
      release: (value) => {
        released.push(value);
        if (value === 'first') void cache.getOrCreate(key, () => 'second');
      },
    });
    await cache.getOrCreate(key, () => 'first');
    cache.advanceGeneration(2);
    await flush();
    await expect(
      cache.getOrCreate({ ...key, shaderKey: 'undefined' }, () => undefined),
    ).resolves.toBeUndefined();
    cache.dispose();
    cache.dispose();
    expect(released).toEqual(['first', 'second', undefined]);
  });

  it('disposes pending work and reports immutable successful-creation accounting', async () => {
    const cache = new PipelineCache<string>(1);
    let resolve!: (value: string) => void;
    const pending = cache.getOrCreate(
      key,
      () =>
        new Promise<string>((resolvePromise) => {
          resolve = resolvePromise;
        }),
    );
    await flush();
    cache.dispose();
    resolve('late');
    await expect(pending).rejects.toThrow('stale generation');
    await expect(cache.getOrCreate(key, () => 'never')).rejects.toThrow('disposed');
    expect(() => cache.advanceGeneration(2)).toThrow('disposed');
    expect(cache.snapshot()).toEqual({
      generation: 1,
      disposed: true,
      pendingEntries: 0,
      readyEntries: 0,
      successfulCreations: 1,
    });
    expect(Object.isFrozen(cache.snapshot())).toBe(true);
  });

  it('validates inputs', () => {
    const cache = new PipelineCache<string>(1);
    expect(() => new PipelineCache<string>(0)).toThrow(RangeError);
    expect(() => cache.advanceGeneration(1)).toThrow(RangeError);
    expect(() => cache.getOrCreate({ ...key, shaderKey: '' }, () => 'x')).toThrow(TypeError);
    expect(() => cache.getOrCreate({ ...key, sampleCount: 2 as 1 }, () => 'x')).toThrow(RangeError);
  });
});
