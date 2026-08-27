import type { PixelSize, RendererSurfaceSize } from '@vector-studio/contracts';

function requireFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be finite and non-negative.`);
  }
}

export function computeSurfaceSize(
  css: PixelSize,
  devicePixelRatio: number,
  maxTextureDimension2D: number,
): RendererSurfaceSize {
  requireFiniteNonNegative(css.width, 'css.width');
  requireFiniteNonNegative(css.height, 'css.height');

  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new RangeError('devicePixelRatio must be finite and positive.');
  }
  if (!Number.isSafeInteger(maxTextureDimension2D) || maxTextureDimension2D <= 0) {
    throw new RangeError('maxTextureDimension2D must be a positive safe integer.');
  }

  const toPhysical = (value: number): number => {
    if (value === 0) {
      return 0;
    }
    return Math.min(maxTextureDimension2D, Math.max(1, Math.round(value * devicePixelRatio)));
  };

  const physical = Object.freeze({
    width: toPhysical(css.width),
    height: toPhysical(css.height),
  });

  return Object.freeze({
    css: Object.freeze({ ...css }),
    physical,
    devicePixelRatio,
    suspended: physical.width === 0 || physical.height === 0,
  });
}
