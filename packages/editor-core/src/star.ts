import type { Frame, JsonValue } from '@vector-studio/model';
import type { Extension, ExtensionApi } from './types.js';

// `ext.star`, the P5 sample extension (P5 plan, section 5). It uses only the public extension
// contract: a custom node type and a command that composes `createCustomNode`.

type StarData = Readonly<{ points: number; innerRatio: number }>;

function isStarData(data: JsonValue): data is StarData {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const keys = Object.keys(data).sort();
  if (keys.length !== 2 || keys[0] !== 'innerRatio' || keys[1] !== 'points') return false;
  const { points, innerRatio } = data as Record<string, JsonValue>;
  return (
    Number.isInteger(points) &&
    (points as number) >= 3 &&
    (points as number) <= 32 &&
    typeof innerRatio === 'number' &&
    innerRatio > 0 &&
    innerRatio < 1
  );
}

/** A star inscribed in the frame, first point at the top, outer and inner vertices alternating. */
function starPath(data: JsonValue, frame: Frame) {
  if (!isStarData(data)) throw new Error('ext.star: invalid data');
  const rx = frame.width / 2;
  const ry = frame.height / 2;
  const points: number[] = [];
  for (let i = 0; i < data.points * 2; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / data.points;
    const scale = i % 2 === 0 ? 1 : data.innerRatio;
    points.push(rx + Math.cos(angle) * rx * scale, ry + Math.sin(angle) * ry * scale);
  }
  return {
    verbs: [
      'move',
      ...Array.from({ length: data.points * 2 - 1 }, () => 'line' as const),
      'close',
    ] as const,
    points,
    fillRule: 'nonzero' as const,
  };
}

export const starExtension: Extension = Object.freeze({
  id: 'ext.star',
  nodeTypes: Object.freeze([
    Object.freeze({
      customType: 'ext.star',
      validate: isStarData,
      defaults: () => ({ points: 5, innerRatio: 0.5 }),
      toScene: starPath,
    }),
  ]),
  commands: Object.freeze([
    Object.freeze({
      id: 'ext.star.create',
      /** `args`: `{ frame, points?, innerRatio? }`. */
      run(args: JsonValue | undefined, api: ExtensionApi) {
        const input = (
          typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}
        ) as Record<string, JsonValue>;
        const data = {
          points: input.points ?? 5,
          innerRatio: input.innerRatio ?? 0.5,
        };
        return api.execute({
          type: 'createCustomNode',
          customType: 'ext.star',
          frame: input.frame as unknown as Frame,
          data,
          name: 'Star',
        });
      },
    }),
  ]),
});
