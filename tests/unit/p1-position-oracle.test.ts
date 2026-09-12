import { expect, it } from 'vitest';
import { precisionFixtures } from '../support/p1-visual-corpus.js';
import { inspectNativePositions } from '../support/p1-position-oracle.js';

it('detects a native affine displacement beyond the visible 0.25px budget', () => {
  const fixture = precisionFixtures(1).find((value) =>
    value.id.includes('signplus-size16x8-stroke0-cameraorigin-zoom1-affineidentity'),
  )!;
  const observed = [
    { x: -1.75, y: -1.5, localX: -2, localY: -2 },
    { x: 18.25, y: -1.5, localX: 18, localY: -2 },
    { x: -1.75, y: 10.5, localX: -2, localY: 10 },
    { x: 18.25, y: 10.5, localX: 18, localY: 10 },
  ];
  expect(inspectNativePositions(fixture, 1, observed).pass).toBe(true);
  expect(
    inspectNativePositions(
      fixture,
      1,
      observed.map((point) => ({ ...point, x: point.x + 0.5 })),
    ).pass,
  ).toBe(false);
  expect(inspectNativePositions(fixture, 1, []).pass).toBe(false);
  const missingGuard = [
    { x: 0.25, y: 0.5, localX: 0, localY: 0 },
    { x: 16.25, y: 0.5, localX: 16, localY: 0 },
    { x: 0.25, y: 8.5, localX: 0, localY: 8 },
    { x: 16.25, y: 8.5, localX: 16, localY: 8 },
  ];
  expect(inspectNativePositions(fixture, 1, missingGuard).pass).toBe(false);
});
