import { isSceneGradient, type SceneColor, type ScenePaint } from '@vector-studio/contracts';

/**
 * E23 contract, unit U1: the colour of a paint that the page or test knows to be solid. The
 * solid-colour pages and their oracles narrow `ScenePaint` with it; a gradient throws.
 */
export function solidColor(paint: ScenePaint): SceneColor {
  if (isSceneGradient(paint)) throw new TypeError('Expected a solid colour paint.');
  return paint;
}
