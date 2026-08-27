import { computeSurfaceSize } from '@vector-studio/renderer-webgpu';
import { describe, expect, it } from 'vitest';

describe('computeSurfaceSize', () => {
  it('applies DPR, rounding, and the device dimension limit', () => {
    expect(computeSurfaceSize({ width: 800.25, height: 300.25 }, 2, 1024)).toEqual({
      css: { width: 800.25, height: 300.25 },
      physical: { width: 1024, height: 601 },
      devicePixelRatio: 2,
      suspended: false,
    });
  });

  it('preserves zero area as a suspended surface', () => {
    expect(computeSurfaceSize({ width: 0, height: 100 }, 2, 4096)).toMatchObject({
      physical: { width: 0, height: 200 },
      suspended: true,
    });
  });

  it('rejects invalid CSS, DPR, and device-limit inputs', () => {
    expect(() => computeSurfaceSize({ width: -1, height: 1 }, 1, 4096)).toThrow(RangeError);
    expect(() => computeSurfaceSize({ width: 1, height: 1 }, 0, 4096)).toThrow(RangeError);
    expect(() => computeSurfaceSize({ width: 1, height: 1 }, 1, 0)).toThrow(RangeError);
  });
});
