import type { RenderNodeSnapshot, SceneBlendMode, SceneColor } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { blendOracle, compareBlend, excessSlack } from '../support/v35-blend-oracle.js';

// V35-A05 amendment (2026-11-12): the oracle's one-step slack. A stored 8-bit value may be one
// step away on a GPU (the band colour 0.9 is 230 on SwiftShader and 229 on the reference PC's
// NVIDIA GPU); steep modes amplify that step, and the comparison allows the excess.

const rect = (
  id: string,
  [x, y, width, height]: readonly [number, number, number, number],
  fill: SceneColor,
  blendMode?: SceneBlendMode,
): RenderNodeSnapshot => ({
  id,
  parentId: null,
  transform: [1, 0, 0, 1, x, y],
  visible: true,
  opacity: 1,
  kind: 'primitive',
  geometry: { kind: 'rectangle', width, height, cornerRadii: [0, 0, 0, 0] },
  style: { fill, stroke: null },
  ...(blendMode === undefined ? {} : { blendMode }),
});

const RED = { r: 0.9, g: 0.25, b: 0.15, a: 1 };
const SOURCE = { r: 0.3, g: 0.7, b: 0.45, a: 0.75 };
const scene = (mode: SceneBlendMode) => [
  rect('band', [0, 0, 8, 8], RED),
  rect('root', [0, 0, 8, 8], SOURCE, mode),
];

describe('V35-A05 oracle slack', () => {
  it('is zero without a blend root and grows with the mode slope', () => {
    expect(blendOracle([rect('band', [0, 0, 8, 8], RED)], 8, 8).slack.every((v) => v === 0)).toBe(
      true,
    );
    const slack = (mode: SceneBlendMode) => blendOracle(scene(mode), 8, 8).slack[0]! * 255;
    // darken takes the source here, so one source step moves it by αs · αb · ds · 255 = 1.
    expect(slack('darken')).toBeCloseTo(1, 5);
    expect(slack('colorBurn')).toBeGreaterThan(3);
    expect(slack('colorBurn')).toBeGreaterThan(slack('multiply'));
  });

  it('accepts the reference GPU colorBurn pixel, and no more than its excess', () => {
    const expected = blendOracle(scene('colorBurn'), 8, 8);
    // The oracle stores the band as 230, the GPU as 229; the GPU's pixel is 183 against 186.
    expect(Math.round(expected.data[0]! * 255)).toBe(186);
    const actual = new Uint8Array(8 * 8 * 4);
    for (let index = 0; index < 64; index += 1) {
      actual.set(
        [0, 1, 2].map((lane) => Math.round(expected.data[index * 4 + lane]! * 255)),
        index * 4,
      );
      actual[index * 4 + 3] = 255;
    }
    actual[0] = 183;
    expect(compareBlend(actual, expected, 2).over).toBe(0);
    actual[0] = Math.floor(expected.data[0]! * 255 - 2 - excessSlack(expected, 0) - 1);
    expect(compareBlend(actual, expected, 2).over).toBe(1);
  });
});
