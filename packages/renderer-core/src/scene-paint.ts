import { isSceneGradient, type SceneColor, type ScenePaint } from '@vector-studio/contracts';

/**
 * E23 contract, unit U1: the solid colour of a paint for the solid-only draw paths. A gradient
 * reaches them only under the mirror option `paints: 'gradient'`, which no service sets before
 * the gradient draw paths exist (E23-S3), so a gradient here is a programming error.
 */
export function solidPaint(paint: ScenePaint): SceneColor {
  if (isSceneGradient(paint)) {
    throw new TypeError('A gradient paint reached a solid-only draw path (E23 U1).');
  }
  return paint;
}
