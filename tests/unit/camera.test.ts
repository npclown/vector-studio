import {
  createCameraTransform,
  invertAffine,
  multiplyAffine,
  transformPoint,
} from '../../packages/renderer-core/src/camera.js';
import { describe, expect, it } from 'vitest';

function expectPointClose(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(1e-8);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(1e-8);
}

function expectMatrixRelativelyClose(actual: readonly number[], expected: readonly number[]): void {
  expected.forEach((value, index) => {
    expect(Math.abs(actual[index]! - value)).toBeLessThanOrEqual(
      Math.max(Number.MIN_VALUE, Math.abs(value) * 1e-15),
    );
  });
}

describe('affine camera helpers', () => {
  it('uses column-vector composition, applying the right transform first', () => {
    const translate = [1, 0, 0, 1, 10, -4] as const;
    const shear = [1, 3, 2, 1, 0, 0] as const;

    expect(transformPoint(multiplyAffine(translate, shear), { x: 2, y: 5 })).toEqual({
      x: 22,
      y: 7,
    });
    expect(transformPoint(multiplyAffine(shear, translate), { x: 2, y: 5 })).toEqual({
      x: 14,
      y: 37,
    });
  });

  it('inverts a noncommuting affine matrix and round-trips points', () => {
    const matrix = [2, -3, 5, 7, -11.5, 9.25] as const;
    const inverse = invertAffine(matrix);
    const point = { x: -123.75, y: 456.125 };

    expectPointClose(transformPoint(inverse, transformPoint(matrix, point)), point);
    expectPointClose(transformPoint(multiplyAffine(matrix, inverse), point), point);
  });

  it('preserves extreme but finite invertible scales without an epsilon cutoff', () => {
    expectMatrixRelativelyClose(
      invertAffine([1e308, 1e308, -1e308, 1e308, 0, 0]),
      [5e-309, -5e-309, 5e-309, 5e-309, 0, 0],
    );
    expectMatrixRelativelyClose(
      invertAffine([1e308, 0, 0, 1e-308, 0, 0]),
      [1e-308, 0, 0, 1e308, 0, 0],
    );
    expectMatrixRelativelyClose(
      invertAffine([1e308, 1e-308, 1e308, -1e-308, 0, 0]),
      [5e-309, 5e-309, 5e307, -5e307, 0, 0],
    );
    expectMatrixRelativelyClose(
      invertAffine([1e308, 1e308, 1e-308, -1e-308, 0, 0]),
      [5e-309, 5e307, 5e-309, -5e307, 0, 0],
    );
    expectMatrixRelativelyClose(
      invertAffine([1e-300, 0, 0, 1e-300, 0, 0]),
      [1e300, 0, 0, 1e300, 0, 0],
    );
    expectMatrixRelativelyClose(
      invertAffine([1e-300, 1e-300, -1e-300, 1e-300, 0, 0]),
      [5e299, -5e299, 5e299, 5e299, 0, 0],
    );
    expect(invertAffine([1, 1, 1, 1 + Number.EPSILON, 0, 0])[0]).toBeGreaterThan(1e15);
  });
});

describe('createCameraTransform', () => {
  it.each([
    [1, 0.01],
    [1, 1],
    [1, 64],
    [1.5, 0.01],
    [1.5, 1],
    [1.5, 64],
    [2, 0.01],
    [2, 1],
    [2, 64],
  ])('keeps all conversions independent at DPR %s and zoom %s', (dpr, zoom) => {
    const camera = createCameraTransform({
      position: { x: -12.5, y: 3.25 },
      zoom,
      devicePixelRatio: dpr,
    });
    const documentPoint = { x: 4.5, y: -1.75 };
    const cssPoint = transformPoint(camera.documentToCss, documentPoint);
    const physicalPoint = transformPoint(camera.documentToPhysical, documentPoint);
    const expectedCss = { x: (documentPoint.x + 12.5) * zoom, y: (documentPoint.y - 3.25) * zoom };

    expectPointClose(cssPoint, expectedCss);
    expectPointClose(physicalPoint, { x: expectedCss.x * dpr, y: expectedCss.y * dpr });
    expectPointClose(transformPoint(camera.cssToDocument, cssPoint), documentPoint);
    expectPointClose(transformPoint(camera.cssToPhysical, cssPoint), physicalPoint);
    expectPointClose(transformPoint(camera.physicalToCss, physicalPoint), cssPoint);
    expectPointClose(transformPoint(camera.physicalToDocument, physicalPoint), documentPoint);
  });

  it.each([0.01, 1, 64])('round-trips fixture-domain points at zoom %s', (zoom) => {
    const camera = createCameraTransform({
      position: { x: -9999.75, y: 9999.5 },
      zoom,
      devicePixelRatio: 1.5,
    });

    for (const point of [
      { x: -10_000, y: 10_000 },
      { x: -0.125, y: 0.5 },
      { x: 10_000, y: -10_000 },
    ]) {
      expectPointClose(
        transformPoint(camera.physicalToDocument, transformPoint(camera.documentToPhysical, point)),
        point,
      );
    }
  });

  it('returns immutable snapshots that do not retain caller-owned inputs', () => {
    const position = { x: 3, y: -4 };
    const camera = createCameraTransform({ position, zoom: 2, devicePixelRatio: 1.5 });
    position.x = 99;

    expect(Object.isFrozen(camera)).toBe(true);
    expect(Object.isFrozen(camera.documentToCss)).toBe(true);
    expect(transformPoint(camera.documentToCss, { x: 3, y: -4 })).toEqual({ x: 0, y: 0 });
  });

  it('rejects malformed, non-finite, singular, and unrepresentable values', () => {
    expect(() => multiplyAffine([1, 0, 0, 1, 0] as never, [1, 0, 0, 1, 0, 0])).toThrow(TypeError);
    expect(() => multiplyAffine([Number.MAX_VALUE, 0, 0, 1, 0, 0], [2, 0, 0, 1, 0, 0])).toThrow(
      RangeError,
    );
    expect(() => transformPoint([Number.MAX_VALUE, 0, 0, 1, 0, 0], { x: 2, y: 0 })).toThrow(
      RangeError,
    );
    expect(() => invertAffine([Infinity, 0, 0, 1, 0, 0])).toThrow(RangeError);
    expect(() => invertAffine([1, 2, 2, 4, 0, 0])).toThrow(RangeError);
    expect(() => transformPoint([1, 0, 0, 1, 0, 0], { x: Infinity, y: 0 })).toThrow(RangeError);
    expect(() =>
      createCameraTransform({ position: { x: 0, y: 0 }, zoom: 0, devicePixelRatio: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      createCameraTransform({ position: { x: 0, y: 0 }, zoom: -1, devicePixelRatio: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      createCameraTransform({ position: { x: 0, y: 0 }, zoom: 1, devicePixelRatio: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      createCameraTransform({ position: { x: 0, y: 0 }, zoom: 1, devicePixelRatio: NaN }),
    ).toThrow(RangeError);
    expect(() => invertAffine([Number.MIN_VALUE, 0, 0, Number.MIN_VALUE, 0, 0])).toThrow(
      RangeError,
    );
    expect(() =>
      invertAffine([Number.MAX_VALUE, Number.MIN_VALUE, Number.MIN_VALUE, Number.MAX_VALUE, 0, 0]),
    ).toThrow(RangeError);
    expect(() =>
      createCameraTransform({
        position: { x: Number.MAX_VALUE, y: 0 },
        zoom: 2,
        devicePixelRatio: 1,
      }),
    ).toThrow(RangeError);
  });
});
