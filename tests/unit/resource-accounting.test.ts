import {
  ResourceAccounting,
  estimateResourceBytes,
  estimateTextureBytes,
} from '@vector-studio/renderer-core';
import { describe, expect, it } from 'vitest';

describe('resource byte estimation', () => {
  it('uses the declared buffer size and count-only zero-byte rule', () => {
    expect(estimateResourceBytes({ category: 'buffer', size: 4096 })).toBe(4096);
    expect(estimateResourceBytes({ category: 'render-pipeline' })).toBe(0);
  });

  it('sums every 2D mip level, layer, sample, and texel byte', () => {
    expect(
      estimateTextureBytes({
        category: 'texture',
        dimension: '2d-array',
        width: 4,
        height: 4,
        depthOrArrayLayers: 2,
        mipLevelCount: 3,
        sampleCount: 4,
        bytesPerTexel: 4,
      }),
    ).toBe((16 + 4 + 1) * 2 * 4 * 4);
  });

  it('shrinks depth for 3D texture mip levels', () => {
    expect(
      estimateTextureBytes({
        category: 'texture',
        dimension: '3d',
        width: 4,
        height: 4,
        depthOrArrayLayers: 4,
        mipLevelCount: 3,
        sampleCount: 1,
        bytesPerTexel: 4,
      }),
    ).toBe((64 + 8 + 1) * 4);
  });

  it('rejects invalid or unsafe descriptor values', () => {
    expect(() => estimateResourceBytes({ category: 'buffer', size: -1 })).toThrow(RangeError);
    expect(() =>
      estimateTextureBytes({
        category: 'texture',
        dimension: '2d',
        width: 0,
        height: 1,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        sampleCount: 1,
        bytesPerTexel: 4,
      }),
    ).toThrow(RangeError);
  });
});

describe('ResourceAccounting', () => {
  it('tracks aggregate and per-category live and peak values', () => {
    const accounting = new ResourceAccounting();

    accounting.track('vertices', { category: 'buffer', size: 1024 });
    accounting.track('pipeline', { category: 'render-pipeline' });
    accounting.track('color', {
      category: 'texture',
      dimension: '2d',
      width: 4,
      height: 4,
      depthOrArrayLayers: 1,
      mipLevelCount: 1,
      sampleCount: 1,
      bytesPerTexel: 4,
    });

    expect(accounting.snapshot()).toMatchObject({
      created: 3,
      live: 3,
      liveBytes: 1088,
      peakLiveBytes: 1088,
      byCategory: {
        buffer: { created: 1, live: 1, liveBytes: 1024, peakLiveBytes: 1024 },
        texture: { created: 1, live: 1, liveBytes: 64, peakLiveBytes: 64 },
        'render-pipeline': { created: 1, live: 1, liveBytes: 0, peakLiveBytes: 0 },
      },
    });

    expect(accounting.release('vertices')).toBe(true);
    expect(accounting.release('missing')).toBe(false);
    expect(accounting.snapshot()).toMatchObject({ live: 2, liveBytes: 64, peakLiveBytes: 1088 });
  });

  it('rejects duplicate and empty resource identifiers', () => {
    const accounting = new ResourceAccounting();
    accounting.track('buffer', { category: 'buffer', size: 4 });

    expect(() => accounting.track('buffer', { category: 'buffer', size: 4 })).toThrow(
      'already tracked',
    );
    expect(() => accounting.track('', { category: 'sampler' })).toThrow(TypeError);
  });

  it('rejects aggregate byte totals outside the safe integer range without tracking', () => {
    const accounting = new ResourceAccounting();
    accounting.track('large', { category: 'buffer', size: Number.MAX_SAFE_INTEGER });

    expect(() => accounting.track('overflow', { category: 'buffer', size: 1 })).toThrow(RangeError);
    expect(accounting.snapshot()).toMatchObject({ created: 1, live: 1 });
  });

  it('clears live resources while preserving lifetime creation and peak evidence', () => {
    const accounting = new ResourceAccounting();
    accounting.track('buffer', { category: 'buffer', size: 128 });

    accounting.clear();

    expect(accounting.snapshot()).toMatchObject({
      created: 1,
      live: 0,
      liveBytes: 0,
      peakLiveBytes: 128,
      byCategory: {
        buffer: { created: 1, live: 0, liveBytes: 0, peakLiveBytes: 128 },
      },
    });
  });
});
