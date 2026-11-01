import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as ProbeModule from '../../apps/next-host/src/m6c-text-probe.js';
import type { Pixels } from '../m6c-next-host/m6c-agreement.js';
import {
  applyAffine,
  clusterKeys,
  deviceMap,
  devicePolygon,
  deviceRect,
  inkOutside,
  invertAffine,
  judgeCluster,
  localInkShare,
  OPEN_RULE,
  pixelState,
  rasterKeySets,
  signedDistance,
  uniformPixels,
  type Affine,
  type KeyLeaf,
} from '../m6c-next-host/m6c-scene.js';

// MVP M6c-U4 (docs/plans/mvp-m6c-gpu-text-contract.md, section 10; M6c-A05, A08): the pure half
// of the headed scene and typing specs (tests/m6c-next-host/m6c-scene.spec.ts and
// m6c-typing.spec.ts): the cover rules (signed distances, pixel states), the per-pixel cluster
// judgement against a shown frame and its text-free background, the local ink share that tells a
// rotated draw from an unrotated one, and the E28 raster keys recomputed apart from the renderer,
// which are checked here against the probe's own `clusterPlacements` (renderer-core's K1 to K3).

const appDir = path.resolve(import.meta.dirname, '../../apps/next-host');
const probe = (await import(path.join(appDir, 'src/m6c-text-probe.ts'))) as typeof ProbeModule;

/** A crop of uniform `rgb` at `(x, y)` with the listed pixels set. */
function pixels(
  x: number,
  y: number,
  width: number,
  height: number,
  rgb: readonly [number, number, number],
  set: Readonly<Record<string, readonly [number, number, number]>> = {},
): Pixels {
  const out = uniformPixels({ x, y, width, height }, rgb);
  for (const [key, value] of Object.entries(set)) {
    const [col, row] = key.split(',').map(Number) as [number, number];
    out.rgba.set(value, (row * width + col) * 4);
  }
  return out;
}
const gray = (coverage: number): [number, number, number] => [
  255 - coverage,
  255 - coverage,
  255 - coverage,
];

describe('M6c-U4 device geometry', () => {
  it('maps page points by zoom and DPR less the camera, and inverts', () => {
    const map = deviceMap([1, 0, 0, 1, 30, 40], { position: { x: 10, y: 20 }, zoom: 2 }, 1.5);
    expect(map).toEqual([3, 0, 0, 3, 60, 60]);
    expect(applyAffine(map, 1, 2)).toEqual([63, 66]);
    const rotated: Affine = [Math.cos(0.4), Math.sin(0.4), -Math.sin(0.4), Math.cos(0.4), 5, 7];
    const back = invertAffine(rotated);
    const [x, y] = applyAffine(back, ...applyAffine(rotated, 12, -3));
    expect(x).toBeCloseTo(12, 12);
    expect(y).toBeCloseTo(-3, 12);
    expect(() => invertAffine([1, 2, 2, 4, 0, 0])).toThrow();
  });

  it('measures signed distances to rectangles and polygons', () => {
    const rect = deviceRect(
      { x: 10, y: 10, width: 20, height: 10 },
      { position: { x: 0, y: 0 }, zoom: 2 },
      1,
    );
    expect(rect).toEqual({ kind: 'rect', x0: 20, y0: 20, x1: 60, y1: 40 });
    expect(signedDistance(rect, 30, 30)).toBe(-10);
    expect(signedDistance(rect, 22, 30)).toBe(-2);
    expect(signedDistance(rect, 65, 30)).toBe(5);
    expect(signedDistance(rect, 63, 44)).toBe(5);
    // The fixture's mask: a diamond in the unit box of a 200 × 60 frame at (220, 120).
    const diamond = devicePolygon(
      [0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5],
      { x: 220, y: 120, width: 200, height: 60 },
      { position: { x: 0, y: 0 }, zoom: 1 },
      1,
    );
    expect(diamond).toEqual({
      kind: 'polygon',
      points: [
        [320, 120],
        [420, 150],
        [320, 180],
        [220, 150],
      ],
    });
    expect(signedDistance(diamond, 320, 150)).toBeLessThan(-20);
    expect(signedDistance(diamond, 225, 125)).toBeGreaterThan(5);
    expect(Math.abs(signedDistance(diamond, 270, 135))).toBeLessThan(1e-9);
  });

  it('classifies pixels as visible, hidden or edge under a cover rule', () => {
    const within = { kind: 'rect', x0: 0, y0: 0, x1: 10, y1: 10 } as const;
    const occluder = { kind: 'rect', x0: 6, y0: 0, x1: 8, y1: 10 } as const;
    const rule = { within: [within], occluders: [occluder] };
    expect(pixelState(rule, 2.5, 5.5, 1.5)).toBe('visible');
    expect(pixelState(rule, 12.5, 5.5, 1.5)).toBe('hidden');
    expect(pixelState(rule, 10.5, 5.5, 1.5)).toBe('edge');
    expect(pixelState(rule, 7, 5.5, 0.5)).toBe('hidden');
    expect(pixelState(rule, 7, 5.5, 1.5)).toBe('edge');
    expect(pixelState(OPEN_RULE, -100, -100, 1.5)).toBe('visible');
  });
});

describe('M6c-U4 cluster judgement', () => {
  const white: [number, number, number] = [255, 255, 255];
  const blue: [number, number, number] = [153, 204, 255];
  const probeCrop = pixels(4, 6, 3, 1, white, {
    '0,0': gray(255),
    '1,0': gray(128),
    '2,0': gray(64),
  });

  it('passes black text composited over its background and counts strong and solid ink', () => {
    const shown = pixels(4, 6, 3, 1, blue, {
      '0,0': [0, 0, 0],
      '1,0': [
        Math.round(153 * (127 / 255)),
        Math.round(204 * (127 / 255)),
        Math.round(255 * (127 / 255)),
      ],
      '2,0': [
        Math.round(153 * (191 / 255)),
        Math.round(204 * (191 / 255)),
        Math.round(255 * (191 / 255)),
      ],
    });
    const judgement = judgeCluster({
      probe: probeCrop,
      shown,
      background: pixels(4, 6, 3, 1, blue),
      rule: OPEN_RULE,
      opacity: 1,
    });
    expect(judgement).toMatchObject({
      visible: 3,
      hidden: 0,
      strong: 3,
      strongChanged: 3,
      strongOnColour: 3,
      solid: 1,
      tooLight: 0,
      tooDark: 0,
    });
  });

  it('fails text that is missing, lighter than the composite or darker than its opacity', () => {
    const background = pixels(4, 6, 3, 1, white);
    const missing = judgeCluster({
      probe: probeCrop,
      shown: background,
      background,
      rule: OPEN_RULE,
      opacity: 1,
    });
    expect(missing.strongChanged).toBe(0);
    expect(missing.tooLight).toBe(9);
    // At a group opacity of 0.5, solid ink is half way: black is too dark, 128 is right.
    const half = judgeCluster({
      probe: probeCrop,
      shown: pixels(4, 6, 3, 1, white, {
        '0,0': [128, 128, 128],
        '1,0': [192, 192, 192],
        '2,0': [223, 223, 223],
      }),
      background,
      rule: OPEN_RULE,
      opacity: 0.5,
    });
    expect(half).toMatchObject({ tooLight: 0, tooDark: 0, solid: 1, strongOnColour: 0 });
    const opaque = judgeCluster({
      probe: probeCrop,
      shown: pixels(4, 6, 3, 1, white, { '0,0': [0, 0, 0] }),
      background,
      rule: OPEN_RULE,
      opacity: 0.5,
    });
    expect(opaque.tooDark).toBe(3);
    expect(opaque.worstDark).toBeCloseTo(127.5 - 3, 9);
  });

  it('requires hidden pixels to keep the background, and skips edges', () => {
    const rule = {
      within: [],
      occluders: [{ kind: 'rect', x0: 4.9, y0: 0, x1: 100, y1: 100 } as const],
    };
    const background = pixels(4, 6, 3, 1, white);
    // Pixel centres 4.5, 5.5 and 6.5: edge (within 1.5 of x 4.9), edge, hidden.
    const covered = judgeCluster({
      probe: probeCrop,
      shown: background,
      background,
      rule,
      opacity: 1,
    });
    expect(covered).toMatchObject({ visible: 0, edge: 2, hidden: 1, hiddenChanged: 0 });
    const leaked = judgeCluster({
      probe: probeCrop,
      shown: pixels(4, 6, 3, 1, white, { '2,0': [190, 190, 190] }),
      background,
      rule,
      opacity: 1,
    });
    expect(leaked.hiddenChanged).toBe(1);
    expect(() =>
      judgeCluster({
        probe: probeCrop,
        shown: pixels(5, 6, 3, 1, white),
        background,
        rule,
        opacity: 1,
      }),
    ).toThrow();
  });

  it('counts probe ink outside a bitmap rectangle', () => {
    expect(inkOutside(probeCrop, { x: 4, y: 6, width: 3, height: 1 })).toBe(0);
    expect(inkOutside(probeCrop, { x: 5, y: 6, width: 2, height: 1 })).toBe(1);
  });
});

describe('M6c-U4 local ink share', () => {
  /** Ink painted where the local box of a 10 px cluster at (x, 20) lands under `map`. */
  function inked(map: Affine, x: number): Pixels {
    const crop = uniformPixels({ x: 0, y: 0, width: 200, height: 200 }, [255, 255, 255]);
    for (let lx = x; lx < x + 6; lx += 0.25) {
      for (let ly = 12; ly < 20; ly += 0.25) {
        const [dx, dy] = applyAffine(map, lx, ly);
        const col = Math.floor(dx);
        const row = Math.floor(dy);
        if (col < 0 || row < 0 || col >= 200 || row >= 200) continue;
        crop.rgba.set([0, 0, 0], (row * 200 + col) * 4);
      }
    }
    return crop;
  }
  const rotation = 0.4;
  const rotated: Affine = [
    Math.cos(rotation),
    Math.sin(rotation),
    -Math.sin(rotation),
    Math.cos(rotation),
    40,
    30,
  ];
  const unrotated: Affine = [1, 0, 0, 1, 40, 30];
  const cluster = { x: 80, y: 20, advance: 6 };

  it('is near 1 for ink drawn through the leaf map and low for ink drawn unrotated', () => {
    expect(localInkShare(inked(rotated, 80), rotated, cluster, 10)).toBeGreaterThan(0.98);
    expect(localInkShare(inked(unrotated, 80), rotated, cluster, 10)).toBeLessThan(0.2);
    expect(
      localInkShare(
        uniformPixels({ x: 0, y: 0, width: 4, height: 4 }, [255, 255, 255]),
        rotated,
        cluster,
        10,
      ),
    ).toBeNull();
  });
});

describe('M6c-U4 raster keys against the probe (renderer-core K1 to K3)', () => {
  const run = (size: number, texts: readonly string[], x0: number) => ({
    fontList: '"Noto Sans KR"',
    size,
    color: { r: 0, g: 0, b: 0, a: 1 },
    clusters: texts.map((text, index) => ({
      text,
      x: x0 + index * size * 0.6,
      y: size,
      advance: size * 0.6,
    })),
  });
  const leaf = (id: string, size: number) =>
    ({
      id,
      parentId: null,
      transform: [1, 0, 0, 1, 0, 0],
      visible: true,
      opacity: 1,
      kind: 'text',
      generation: 3,
      lang: 'ko',
      runs: [run(size, ['A', ' ', '한', 'g'], 0.37), run(size / 2, ['b'], 9.1)],
    }) as const;
  const cases = [
    ['unrotated at zoom 1', [1, 0, 0, 1, 30.3, 40.7], { position: { x: 0, y: 0 }, zoom: 1 }, 1, 32],
    [
      'zoom 0.5 at DPR 2',
      [1, 0, 0, 1, 30.3, 40.7],
      { position: { x: 3.3, y: -7.15 }, zoom: 0.5 },
      2,
      24,
    ],
    [
      'rotated',
      [Math.cos(0.4), Math.sin(0.4), -Math.sin(0.4), Math.cos(0.4), 40, 240],
      { position: { x: 0, y: 0 }, zoom: 1 },
      1,
      24,
    ],
    ['past the raster cap', [1, 0, 0, 1, 30, 30], { position: { x: 20, y: 15 }, zoom: 8 }, 2, 32],
    ['at zoom 8, DPR 1', [1, 0, 0, 1, 30, 30], { position: { x: 20, y: 15 }, zoom: 8 }, 1, 32],
  ] as const;

  it.each(cases)(
    '%s: mode, bucket, phase and bound equal the probe',
    (_name, world, camera, dpr, size) => {
      const text = leaf('t', size);
      const entry = { world: world as Affine, leaf: text } as unknown as Parameters<
        typeof probe.clusterPlacements
      >[0];
      const expected = probe.clusterPlacements(entry, camera, dpr);
      const keys = clusterKeys(entry, camera, dpr);
      expect(keys.map((value) => value.mode)).toEqual(expected.map((value) => value.mode));
      expect(keys.map((value) => value.key)).toEqual(
        expected.map((value) =>
          JSON.stringify([value.lang, value.fontList, value.text, value.bucket, value.phaseX]),
        ),
      );
      for (const [index, value] of keys.entries()) {
        const bound = expected[index]!.bound;
        expect(value.bound.x0).toBeCloseTo(bound.x0, 9);
        expect(value.bound.y0).toBeCloseTo(bound.y0, 9);
        expect(value.bound.x1).toBeCloseTo(bound.x1, 9);
        expect(value.bound.y1).toBeCloseTo(bound.y1, 9);
      }
    },
  );

  it('collects expected, expected ink and required keys by leaf and cluster culling', () => {
    const camera = { position: { x: 0, y: 0 }, zoom: 1 };
    const target = { width: 100, height: 100 };
    const at = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
    const entry = (world: Affine, shown: boolean, clipped: boolean) => ({
      world,
      shown,
      clipped,
      leaf: leaf('t', 10) as unknown as KeyLeaf['leaf'],
    });
    const sets = rasterKeySets(
      [
        entry(at(10, 10), true, false),
        // Off the target by more than the guard: culled as a leaf.
        entry(at(500.6, 10), true, false),
        // Hidden: nothing.
        entry(at(20.6, 30), false, false),
        // Clipped: expected, not required.
        entry(at(10.3, 60), true, true),
      ],
      camera,
      1,
      target,
    );
    const first = clusterKeys(entry(at(10, 10), true, false), camera, 1);
    const clipped = clusterKeys(entry(at(10.3, 60), true, true), camera, 1);
    const all = [...first, ...clipped].map((value) => value.key);
    expect([...sets.expected].sort()).toEqual([...new Set(all)].sort());
    const ink = [...first, ...clipped]
      .filter((value) => value.text.trim() !== '')
      .map((value) => value.key);
    expect([...sets.expectedInk].sort()).toEqual([...new Set(ink)].sort());
    expect([...sets.required].sort()).toEqual(
      [
        ...new Set(first.filter((value) => value.text.trim() !== '').map((value) => value.key)),
      ].sort(),
    );
  });
});
