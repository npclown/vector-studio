import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as ProbeModule from '../../apps/next-host/src/m6c-text-probe.js';
import type * as OptionsModule from '../../apps/next-host/src/renderer-options.js';
import type { Pixels } from '../m6c-next-host/m6c-agreement.js';
import {
  applyAffine,
  callKey,
  clusterKeys,
  deviceMap,
  devicePolygon,
  deviceRect,
  extraInk,
  inkMask,
  inkOutside,
  invertAffine,
  judgeCluster,
  localInkShare,
  OPEN_RULE,
  othersMask,
  packBits,
  pixelState,
  rasterCallFailures,
  rasterKeySets,
  showableInk,
  signedDistance,
  uniformPixels,
  unionMask,
  type Affine,
  type CoverRule,
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
    expect(leaked.samples.hiddenChanged).toEqual([[6, 6, 64, 190, 190, 190, 255, 255, 255]]);
    // The same leak under another leaf's ink is counted as shared, not judged.
    const othersMask = new Uint8Array(10 * 8);
    othersMask[6 * 10 + 6] = 1;
    const shared = judgeCluster({
      probe: probeCrop,
      shown: pixels(4, 6, 3, 1, white, { '2,0': [190, 190, 190] }),
      background,
      rule,
      opacity: 1,
      others: { mask: othersMask, width: 10 },
    });
    expect(shared).toMatchObject({ hidden: 0, hiddenShared: 1, hiddenChanged: 0 });
    expect(shared.samples.hiddenChanged).toEqual([]);
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

  it('collects the request set: every drawn cluster whose bound meets the target', () => {
    const camera = { position: { x: 0, y: 0 }, zoom: 1 };
    const target = { width: 100, height: 100 };
    const at = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
    const entry = (world: Affine, shown: boolean) => ({
      world,
      shown,
      leaf: leaf('t', 10) as unknown as KeyLeaf['leaf'],
    });
    const sets = rasterKeySets(
      [
        entry(at(10, 10), true),
        // Off the target by more than the guard: nothing.
        entry(at(500.6, 10), true),
        // Hidden: nothing.
        entry(at(20.6, 30), false),
        // Across the right edge: the clusters whose own bound misses are not requested.
        entry(at(95.3, 60), true),
      ],
      camera,
      1,
      target,
    );
    const first = clusterKeys(entry(at(10, 10), true), camera, 1);
    const edge = clusterKeys(entry(at(95.3, 60), true), camera, 1);
    const meets = edge.filter((value) => value.bound.x0 <= 102);
    expect(meets.length).toBeGreaterThan(0);
    expect(meets.length).toBeLessThan(edge.length);
    const all = [...first, ...meets];
    expect([...sets.exact].sort()).toEqual([...new Set(all.map((value) => value.key))].sort());
    expect([...sets.exactInk].sort()).toEqual(
      [
        ...new Set(all.filter((value) => value.text.trim() !== '').map((value) => value.key)),
      ].sort(),
    );
  });
});

describe('M6c-U4 raster call log (review S2)', () => {
  const call = (generation: number | null, text: string, phaseX = 0) => ({
    generation,
    text,
    fontList: 'F',
    lang: 'ko',
    pixelSize: 10,
    phaseX,
  });
  const exact = new Set([callKey(call(0, 'a')), callKey(call(0, ' ')), callKey(call(0, 'b'))]);

  it('passes each requested key once at the final generation', () => {
    expect(rasterCallFailures([call(5, 'a'), call(5, ' '), call(5, 'b')], exact, 4, 5)).toEqual([]);
    // A load's first bump before the final one: a subset, each key once.
    expect(
      rasterCallFailures([call(5, 'a'), call(6, 'b'), call(6, 'a'), call(6, ' ')], exact, 4, 6),
    ).toEqual([]);
  });

  it('fails a missing, repeated, stray or older-generation call', () => {
    expect(rasterCallFailures([call(5, 'a'), call(5, 'b')], exact, 4, 5)).toEqual([
      `generation 5: ${callKey(call(0, ' '))} not rasterized`,
    ]);
    expect(
      rasterCallFailures([call(5, 'a'), call(5, 'a'), call(5, ' '), call(5, 'b')], exact, 4, 5),
    ).toEqual([`generation 5: ${callKey(call(0, 'a'))} rasterized twice`]);
    expect(
      rasterCallFailures([call(5, 'a'), call(5, ' '), call(5, 'b'), call(5, 'c')], exact, 4, 5),
    ).toEqual([`generation 5: ${callKey(call(0, 'c'))} not requested`]);
    const older = rasterCallFailures(
      [call(4, 'a'), call(null, 'a'), call(5, 'a'), call(5, ' '), call(5, 'b')],
      exact,
      4,
      5,
    );
    expect(older).toHaveLength(2);
  });
});

describe('M6c-U4 extra ink (review S3)', () => {
  it('masks probe coverage grown by a pixel and finds changes outside it', () => {
    const crop = pixels(2, 1, 2, 1, [255, 255, 255], { '0,0': gray(1) });
    const mask = inkMask(6, 4, [crop]);
    // Pixel (2, 1) and its 8 neighbours, clamped to the frame.
    const expected = new Uint8Array(24);
    for (const [x, y] of [
      [1, 0],
      [2, 0],
      [3, 0],
      [1, 1],
      [2, 1],
      [3, 1],
      [1, 2],
      [2, 2],
      [3, 2],
    ] as const)
      expected[y * 6 + x] = 1;
    expect(mask).toEqual(expected);
    const flags = new Uint8Array(24);
    flags[1 * 6 + 3] = 1;
    flags[3 * 6 + 5] = 1;
    flags[0] = 1;
    const bits = packBits(flags);
    expect(bits).toHaveLength(3);
    expect(extraInk(bits, mask, 6)).toEqual({
      count: 2,
      sample: [
        [0, 0],
        [5, 3],
      ],
    });
  });
});

describe('M6c-U4 host raster log (src/renderer-options.ts, review S2)', () => {
  it('logs each call with the generation read at the call, and delegates', async () => {
    const options = (await import(
      path.join(appDir, 'src/renderer-options.ts')
    )) as typeof OptionsModule;
    const requests: string[] = [];
    const inner = Object.freeze({
      portVersion: 0 as const,
      operationId: 'test/inner',
      rasterize: (request: Parameters<OptionsModule.HostGlyphRaster['rasterize']>[0]) => {
        requests.push(request.text);
        return { status: 'empty' as const };
      },
    });
    let clock = 0;
    const log = options.createGlyphRasterLog(inner, 2, () => (clock += 1.5));
    expect(log.port.operationId).toBe('test/inner');
    const request = { text: 'a', fontList: 'F', lang: 'ko', pixelSize: 10, phaseX: 0.25 } as const;
    expect(log.port.rasterize(request)).toEqual({ status: 'empty' });
    let generation: number | null = 7;
    log.setGeneration(() => generation);
    log.port.rasterize({ ...request, text: 'b' });
    generation = 8;
    log.port.rasterize({ ...request, text: 'c' });
    expect(requests).toEqual(['a', 'b', 'c']);
    // Capped at 2: the oldest is dropped.
    expect(log.entries).toEqual([
      { ...request, generation: 7, text: 'b', startMs: 4.5, durationMs: 1.5 },
      { ...request, generation: 8, text: 'c', startMs: 7.5, durationMs: 1.5 },
    ]);
    log.clear();
    expect(log.entries).toEqual([]);
  });

  it("reads the newest accepted text generation from the probe's recorder", () => {
    const recorder = new probe.SceneRecorder();
    expect(recorder.newestTextGeneration()).toBeNull();
    const text = (id: string, generation: number) => ({
      id,
      parentId: null,
      transform: [1, 0, 0, 1, 0, 0] as const,
      visible: true,
      opacity: 1,
      kind: 'text' as const,
      generation,
      lang: 'ko',
      runs: [],
    });
    recorder.recordSnapshot({
      identity: { documentId: 'd', pageId: 'p' },
      revision: 1,
      nodes: [text('a', 3), text('b', 5)],
      rootOrder: ['a', 'b'],
    });
    expect(recorder.newestTextGeneration()).toBe(5);
  });

  it('gives the logged port to the host service only under ?test=1, never to the probe', () => {
    const source = readFileSync(path.join(appDir, 'src/webgpu-renderer.ts'), 'utf8');
    // AR-U1: @vector-studio/webgpu-host creates the service with the wrapped port; next-host
    // wraps it only under `?test=1`, and the probe's service keeps the unwrapped one.
    const host = readFileSync(path.join(appDir, '../../packages/webgpu-host/src/index.ts'), 'utf8');
    expect(host).toMatch(
      /const servicePort = options\.wrapGlyphRaster\?\.\(glyphRaster\) \?\? glyphRaster;/u,
    );
    expect(host).toMatch(/\.\.\.editorRendererOptions\(servicePort, options\.imageSource\)/u);
    expect(source).toMatch(
      /if \(!testing\) return port;\s+rasterLog = createGlyphRasterLog\(port\);\s+return rasterLog\.port;/u,
    );
    expect(source).toMatch(
      /new core\.PrimitiveRendererService\(target, hostRendererOptions\(glyphRaster\)\)/u,
    );
    expect(source).toMatch(/log\.setGeneration\(\(\) => recorder\.newestTextGeneration\(\)\)/u);
  });
});

describe('M6c-U4 shared hidden pixels (review S1 and S3 of 2dfd5c4)', () => {
  const white: [number, number, number] = [255, 255, 255];
  const W = 10;
  /** A 10 by 1 crop at the origin with ink `coverage` at the listed columns. */
  const row = (coverage: number, columns: readonly number[], rgb = white) =>
    pixels(0, 0, W, 1, rgb, Object.fromEntries(columns.map((x) => [`${x},0`, gray(coverage)])));
  // Inside a far rectangle only: every pixel here is hidden (a clip or mask the text lies outside).
  const hiddenRule: CoverRule = {
    within: [{ kind: 'rect', x0: 100, y0: 100, x1: 200, y1: 200 }],
    occluders: [],
  };
  const blank = row(0, []);

  it('keeps a leaf ink only where its own rule lets it show, and never in its own others', () => {
    const shownLeaf = row(200, [4]);
    const showable = showableInk(W, 1, [
      { id: 'open', rule: OPEN_RULE, crops: [shownLeaf] },
      { id: 'hidden', rule: hiddenRule, crops: [shownLeaf] },
    ]);
    expect([...showable.get('open')!]).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0, 0]);
    expect([...showable.get('hidden')!]).toEqual(new Array<number>(W).fill(0));
    // (c) The open leaf's own ink is not in its others; the hidden leaf's others hold it.
    expect([...othersMask(showable, 'open', W).mask]).toEqual(new Array<number>(W).fill(0));
    expect([...othersMask(showable, 'hidden', W).mask]).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0, 0]);
    expect([...unionMask(showable)]).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0, 0]);
  });

  it('(d) still judges a leak where both leaves are hidden, and extra ink sees it', () => {
    const probe = row(200, [4]);
    const showable = showableInk(W, 1, [
      { id: 'clip', rule: hiddenRule, crops: [probe] },
      { id: 'mask', rule: hiddenRule, crops: [probe] },
    ]);
    for (const id of ['clip', 'mask']) {
      const judgement = judgeCluster({
        probe,
        shown: probe,
        background: blank,
        rule: hiddenRule,
        opacity: 1,
        others: othersMask(showable, id, W),
      });
      expect(judgement).toMatchObject({ hidden: 1, hiddenShared: 0, hiddenChanged: 1 });
    }
    const changed = packBits([0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
    expect(extraInk(changed, unionMask(showable), W).count).toBe(1);
    // The same leak where the other leaf may show is shared.
    const open = showableInk(W, 1, [
      { id: 'clip', rule: hiddenRule, crops: [probe] },
      { id: 'mask', rule: OPEN_RULE, crops: [probe] },
    ]);
    const shared = judgeCluster({
      probe,
      shown: probe,
      background: blank,
      rule: hiddenRule,
      opacity: 1,
      others: othersMask(open, 'clip', W),
    });
    expect(shared).toMatchObject({ hidden: 0, hiddenShared: 1, hiddenChanged: 0 });
  });

  it('(a) judges visible and edge pixels under others as before', () => {
    const probe = row(200, [4]);
    const others = { mask: new Uint8Array(W).fill(1), width: W };
    const visible = judgeCluster({
      probe,
      shown: blank,
      background: blank,
      rule: OPEN_RULE,
      opacity: 1,
      others,
    });
    expect(visible).toMatchObject({ visible: 1, hiddenShared: 0, strong: 1, strongChanged: 0 });
    expect(visible.tooLight).toBe(3);
    const edgeRule: CoverRule = {
      within: [],
      occluders: [{ kind: 'rect', x0: 4.9, y0: -10, x1: 100, y1: 10 }],
    };
    const edge = judgeCluster({
      probe,
      shown: blank,
      background: blank,
      rule: edgeRule,
      opacity: 1,
      others,
    });
    expect(edge).toMatchObject({ edge: 1, hidden: 0, hiddenShared: 0 });
  });

  it('(b) samples too light, too dark and unchanged strong pixels, at most four of each', () => {
    const probe = row(200, [0, 1, 2, 3, 4, 5]);
    const light = judgeCluster({
      probe,
      shown: blank,
      background: blank,
      rule: OPEN_RULE,
      opacity: 1,
    });
    expect(light).toMatchObject({ strong: 6, strongChanged: 0, tooLight: 18, tooDark: 0 });
    expect(light.samples.tooLight).toHaveLength(4);
    expect(light.samples.strongUnchanged).toHaveLength(4);
    expect(light.samples.tooLight[0]).toEqual([0, 0, 200, 255, 255, 255, 255, 255, 255]);
    expect(light.samples.strongUnchanged.map((sample) => sample[0])).toEqual([0, 1, 2, 3]);
    const black = row(0, [], [0, 0, 0]);
    const dark = judgeCluster({
      probe,
      shown: black,
      background: blank,
      rule: OPEN_RULE,
      opacity: 0.5,
    });
    expect(dark).toMatchObject({ tooLight: 0, tooDark: 18 });
    expect(dark.samples.tooDark).toHaveLength(4);
    expect(dark.samples.tooDark[3]).toEqual([3, 0, 200, 0, 0, 0, 255, 255, 255]);
    expect(dark.samples.tooLight).toEqual([]);
    expect(dark.samples.strongUnchanged).toEqual([]);
  });
});
