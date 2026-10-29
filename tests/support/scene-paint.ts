import { isSceneGradient, type SceneColor, type ScenePaint } from '@vector-studio/contracts';

/** E23 U1: the colour of a paint a solid-colour test or oracle knows to be solid. */
export function solidColor(paint: ScenePaint): SceneColor {
  if (isSceneGradient(paint)) throw new TypeError('Expected a solid colour paint.');
  return paint;
}
