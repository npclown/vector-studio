import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  composeSceneAffine,
  getPrimitiveLocalStrokeBounds,
  hasFiniteSceneArithmetic,
  transformSceneBounds,
} from '../../packages/renderer-core/src/scene-numeric.js';

function primitive(geometry: Extract<RenderNodeSnapshot, { kind: 'primitive' }>['geometry']) {
  return {
    id: 'shape',
    parentId: null,
    kind: 'primitive',
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: 1,
    geometry,
    style: { fill: null, stroke: { width: 4, color: { r: 1, g: 1, b: 1, a: 1 } } },
  } satisfies RenderNodeSnapshot;
}

describe('retained scene independent Float64 bounds fixtures', () => {
  it('matches N01 hierarchy composition and scalar stroke-bound expectations', () => {
    const world = composeSceneAffine([2, 0, 0, 3, 10, 20], [1, 0, 0.25, 1, 4, 5]);
    expect(world).toEqual([2, 0, 0.5, 3, 18, 35]);
    const local = getPrimitiveLocalStrokeBounds(
      primitive({ kind: 'rectangle', width: 10, height: 20, cornerRadii: [0, 0, 0, 0] }),
    );
    expect(local).toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 22 });
    expect(transformSceneBounds(local!, world!)).toEqual({
      minX: 13,
      minY: 29,
      maxX: 53,
      maxY: 101,
    });
  });

  it('keeps stroke-inclusive line bounds conservative under reflection and shear', () => {
    const line = primitive({ kind: 'line', start: { x: -3, y: 5 }, end: { x: 7, y: -2 } });
    const local = getPrimitiveLocalStrokeBounds({
      ...line,
      style: { fill: null, stroke: { ...line.style.stroke, width: 2 } },
    });
    expect(local).toEqual({ minX: -4, minY: -3, maxX: 8, maxY: 6 });
    expect(transformSceneBounds(local!, [-1, 0, 0.25, 2, 10, -4])).toEqual({
      minX: 1.25,
      minY: -10,
      maxX: 15.5,
      maxY: 8,
    });
  });

  it('distinguishes primitive bound overflow from a structural container without geometry', () => {
    const node = primitive({
      kind: 'rectangle',
      width: Number.MAX_VALUE,
      height: 1,
      cornerRadii: [0, 0, 0, 0],
    });
    const overflowing = {
      ...node,
      style: { fill: null, stroke: { ...node.style.stroke, width: Number.MAX_VALUE } },
    };
    expect(getPrimitiveLocalStrokeBounds(overflowing)).toBeNull();
    expect(hasFiniteSceneArithmetic(new Map([[node.id, overflowing]]))).toBe(false);
    expect(
      getPrimitiveLocalStrokeBounds({
        id: 'group',
        parentId: null,
        kind: 'container',
        children: [],
        transform: [1, 0, 0, 1, 0, 0],
        visible: true,
        opacity: 1,
      }),
    ).toBeUndefined();
  });

  it('rejects real world composition overflow while retaining representable tiny coefficients', () => {
    expect(composeSceneAffine([Number.MAX_VALUE, 0, 0, 1, 0, 0], [2, 0, 0, 1, 0, 0])).toBeNull();
    expect(composeSceneAffine([1e-150, 0, 0, 1e150, 0, 0], [1, 0, 0, 1, 0, 0])).toEqual([
      1e-150, 0, 0, 1e150, 0, 0,
    ]);
  });
});
