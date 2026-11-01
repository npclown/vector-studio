import { readFileSync } from 'node:fs';
import path from 'node:path';
import { snappedPlacement, sizeBucket, textDeviceMap } from '@vector-studio/renderer-core';
import { describe, expect, it } from 'vitest';
import type * as ProbeModule from '../../apps/next-host/src/m6c-text-probe.js';
import type * as ReferenceModule from '../../apps/next-host/src/m6c-text-reference.js';
import {
  ACHROMATIC_LIMIT,
  decodeCrop,
  expectedPlacement,
  layoutTerm,
  lineStarts,
  maxChroma,
  measureInk,
  placementFailures,
  RASTER_BOUNDS,
  rasterFailures,
  rasterTerm,
  type Pixels,
} from '../m6c-next-host/m6c-agreement.js';

// MVP M6c-U3 (docs/plans/mvp-m6c-gpu-text-contract.md, section 6; M6c-A06, A07): the pure parts
// of the DOM and GPU agreement. The headed half (the GPU cluster from `readCluster`, the placed
// DOM cluster from `reference(id, index)`, the flowed DOM block from `reference(id)`, the
// font-load case) is tests/m6c-next-host/m6c-agreement.spec.ts.
// - The ink measures (M6-S0's ink boxes, contract section 2) over a crop in device px: coverage
//   `255 − min(R, G, B)` over white, coverage ≤ 2/255 ignored; coverage-weighted edges and the
//   centroid; the thresholded integer box.
// - The split's terms: the placement term, E28-K1 to K3 recomputed apart from renderer-core and
//   compared exactly; the raster term against section 6.3's bounds; the layout term, recorded.
// - The reference module's placement arithmetic (next-host, src/m6c-text-reference.ts).

const appDir = path.resolve(import.meta.dirname, '../../apps/next-host');
const reference = (await import(
  path.join(appDir, 'src/m6c-text-reference.ts')
)) as typeof ReferenceModule;
const probe = (await import(path.join(appDir, 'src/m6c-text-probe.ts'))) as typeof ProbeModule;

/** A white crop at `(x, y)` with the given coverage values (0 to 255) painted black. */
function crop(
  x: number,
  y: number,
  width: number,
  height: number,
  ink: Readonly<Record<string, number>>,
  channel?: (coverage: number) => readonly [number, number, number],
): Pixels {
  const rgba = new Uint8Array(width * height * 4).fill(255);
  for (const [key, coverage] of Object.entries(ink)) {
    const [col, row] = key.split(',').map(Number) as [number, number];
    const i = (row * width + col) * 4;
    const [r, g, b] = channel?.(coverage) ?? [255 - coverage, 255 - coverage, 255 - coverage];
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
  }
  return { x, y, width, height, rgba };
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('M6c-U3 ink measures (M6-S0 ink boxes)', () => {
  it('decodes a probe crop to device pixels at its offset', () => {
    const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    const pixels = decodeCrop({ x: 7, y: 9, width: 2, height: 1, rgbaBase64: base64(rgba) });
    expect(pixels).toEqual({ x: 7, y: 9, width: 2, height: 1, rgba });
    expect(() =>
      decodeCrop({ x: 0, y: 0, width: 3, height: 1, rgbaBase64: base64(rgba) }),
    ).toThrow();
  });

  it('is null over white and ignores coverage at or below 2', () => {
    expect(measureInk(crop(0, 0, 4, 4, {}))).toBeNull();
    expect(measureInk(crop(0, 0, 4, 4, { '1,1': 2, '2,2': 1 }))).toBeNull();
  });

  it('places coverage-weighted edges and the centroid in absolute device px', () => {
    // A full column at x 11 (crop column 1), rows 21 and 22, and a half-covered column at x 12.
    const ink = measureInk(crop(10, 20, 4, 4, { '1,1': 255, '1,2': 255, '2,1': 128, '2,2': 128 }))!;
    expect(ink.left).toBeCloseTo(11, 9);
    // The half column ends half way into pixel 12.
    expect(ink.right).toBeCloseTo(12 + 128 / 255, 9);
    expect(ink.top).toBe(21);
    expect(ink.bottom).toBe(23);
    // Centroid: mass 1 at x 11.5 per row, about 0.5 at 12.5.
    expect(ink.cx).toBeCloseTo((11.5 + 12.5 * (128 / 255)) / (1 + 128 / 255), 9);
    expect(ink.cy).toBeCloseTo(22, 9);
    expect(ink.box).toEqual({ x0: 11, y0: 21, x1: 13, y1: 23 });
  });

  it('puts a partly covered edge column at its far side minus the coverage', () => {
    const ink = measureInk(crop(0, 0, 5, 3, { '1,1': 51, '2,1': 255, '3,1': 204 }))!;
    expect(ink.left).toBeCloseTo(2 - 51 / 255, 9);
    expect(ink.right).toBeCloseTo(3 + 204 / 255, 9);
    // The thresholded box (coverage > 16) holds all three columns.
    expect(ink.box).toEqual({ x0: 1, y0: 1, x1: 4, y1: 2 });
  });

  it('takes the darkest channel, so LCD-coloured edges count as covered', () => {
    const lcd = (coverage: number) => [255, 255 - coverage, 255] as const;
    const ink = measureInk(crop(0, 0, 3, 3, { '1,1': 255 }, lcd))!;
    expect(ink.left).toBe(1);
    expect(ink.mass).toBe(1);
  });
});

describe('M6c-U3 achromatic gated read (review r1 S4)', () => {
  it('gives the largest |R − G| or |G − B| of a crop, 0 for gray', () => {
    const pixels = (rgba: number[]): Pixels => ({
      x: 0,
      y: 0,
      width: rgba.length / 4,
      height: 1,
      rgba: Uint8Array.from(rgba),
    });
    expect(maxChroma(pixels([255, 255, 255, 255, 40, 40, 40, 255]))).toBe(0);
    expect(maxChroma(pixels([250, 252, 251, 255]))).toBe(2);
    expect(maxChroma(pixels([200, 180, 230, 255]))).toBe(50);
    expect(ACHROMATIC_LIMIT).toBe(2);
  });
});

describe('M6c-U3 raster term (section 6.3)', () => {
  const ink = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    cx: left + width / 2,
    cy: top + height / 2,
    mass: width * height,
    box: null,
  });

  it('gives GPU minus DOM in CSS px, horizontal and vertical apart', () => {
    const term = rasterTerm(ink(10.5, 20, 8, 12), ink(10, 20.25, 7.5, 12.5), 2);
    expect(term.dLeft).toBeCloseTo(0.25, 12);
    expect(term.dTop).toBeCloseTo(-0.125, 12);
    expect(term.subOffsetX).toBeCloseTo(0.25, 12);
    expect(term.subOffsetY).toBeCloseTo(-0.125, 12);
    expect(term.dWidth).toBeCloseTo(0.25, 12);
    expect(term.dHeight).toBeCloseTo(-0.25, 12);
    expect(term.subSizeDiff).toBeCloseTo(0.25, 12);
    expect(term.centroidX).toBeCloseTo((14.5 - 13.75) / 2, 12);
    expect(term.centroidY).toBeCloseTo((26 - 26.5) / 2, 12);
    expect(term.massRatio).toBeCloseTo(96 / 93.75, 12);
    expect(rasterFailures(term)).toEqual([]);
  });

  it('fails above 0.5 horizontal, outside ±0.25 vertical and above 1 in size, at the bounds inclusive', () => {
    expect(RASTER_BOUNDS).toEqual({ horizontal: 0.5, vertical: 0.25, size: 1 });
    expect(Object.isFrozen(RASTER_BOUNDS)).toBe(true);
    const at = rasterTerm(ink(10.5, 20.25, 9, 12), ink(10, 20, 8, 12), 1);
    expect(rasterFailures(at)).toEqual([]);
    const over = rasterTerm(ink(10.51, 19.7, 9.1, 12), ink(10, 20, 8, 12), 1);
    expect(rasterFailures(over).map((failure) => failure.split(' ')[0])).toEqual([
      'horizontal',
      'vertical',
      'size',
    ]);
    // A named limit (section 6.3) replaces a bound for its fixture only.
    expect(rasterFailures(over, { horizontal: 0.6, vertical: 0.31, size: 1.2 })).toEqual([]);
  });
});

describe('M6c-U3 placement term (section 6.1, exact)', () => {
  const world = [1, 0, 0, 1, 20.3, 140] as const;
  const camera = { position: { x: -0.37, y: 0.11 }, zoom: 1.5 };

  it('recomputes E28-K1 to K3 as renderer-core does, from the leaf and camera alone', () => {
    for (const dpr of [1, 2, 1.25]) {
      for (const cluster of [
        { x: 0, y: 25.6 },
        { x: 13.37, y: 25.6 },
        { x: 101.126, y: 49.99 },
      ]) {
        const expected = expectedPlacement(world, camera, dpr, cluster, 24);
        const map = textDeviceMap(world, camera, dpr);
        const ox = map[0] * cluster.x + map[2] * cluster.y + map[4];
        const oy = map[1] * cluster.x + map[3] * cluster.y + map[5];
        expect(expected.origin).toEqual([ox, oy]);
        const snap = snappedPlacement(ox, oy);
        expect(expected.corner).toEqual([snap.px, snap.py]);
        expect(expected.phaseX).toBe(snap.phaseX);
        expect(expected.bucket).toBe(sizeBucket(24 * 1.5 * dpr));
      }
    }
  });

  it('accepts the probe placement and names each field that differs', () => {
    const editorWorld = [1, 0, 0, 1, 20, 140] as const;
    const leaf = {
      id: 'n',
      parentId: null,
      transform: editorWorld,
      visible: true,
      opacity: 1,
      kind: 'text' as const,
      generation: 1,
      lang: 'ko',
      runs: [
        {
          fontList: '"A"',
          size: 24,
          color: { r: 0, g: 0, b: 0, a: 1 },
          clusters: [
            { text: 'A', x: 0, y: 25.6, advance: 14.2 },
            { text: 'b', x: 14.2, y: 25.6, advance: 12.9 },
          ],
        },
      ],
    };
    for (const dpr of [1, 2]) {
      const placements = probe.clusterPlacements({ world: editorWorld, leaf }, camera, dpr);
      for (const placement of placements) {
        const cluster = leaf.runs[0]!.clusters[placement.cluster]!;
        const expected = expectedPlacement(editorWorld, camera, dpr, cluster, 24);
        expect(placementFailures(placement, expected)).toEqual([]);
        // A wrong phase is named; it also moves the quantized pen past 1/8 device px.
        expect(
          placementFailures({ ...placement, phaseX: (placement.phaseX + 0.25) % 1 }, expected)[0],
        ).toMatch(/^phaseX /u);
        expect(
          placementFailures(
            { ...placement, corner: [placement.corner![0], placement.corner![1] + 1] },
            expected,
          ),
        ).toEqual([expect.stringMatching(/^corner /u), expect.stringMatching(/^snapY /u)]);
        expect(placementFailures({ ...placement, mode: 'general' }, expected)).toEqual([
          'mode general',
        ]);
      }
    }
  });
});

describe('M6c-U3 layout term (recorded) and structure', () => {
  it('gives the flowed DOM block against the port per cluster in CSS and device px', () => {
    const term = layoutTerm(
      {
        id: 'n',
        scale: 1,
        lines: 1,
        portLines: 1,
        clusters: [
          {
            index: 0,
            start: 0,
            end: 1,
            text: 'A',
            run: 0,
            line: 0,
            portLine: 0,
            x: 0,
            baseline: 26,
            portX: 0,
            portBaseline: 25.6,
          },
          {
            index: 1,
            start: 1,
            end: 2,
            text: 'b',
            run: 0,
            line: 0,
            portLine: 0,
            x: 14.25,
            baseline: 26,
            portX: 14.2,
            portBaseline: 25.6,
          },
        ],
      },
      2,
    );
    expect(term.clusters.map((row) => row.dx)).toEqual([0, expect.closeTo(0.05, 9)]);
    expect(term.clusters.map((row) => row.dBaseline)).toEqual([
      expect.closeTo(0.4, 9),
      expect.closeTo(0.4, 9),
    ]);
    expect(term.clusters[1]!.dxDevice).toBeCloseTo(0.1, 9);
    expect(term.maxAbsDx).toBeCloseTo(0.05, 9);
    expect(term.maxAbsDBaseline).toBeCloseTo(0.4, 9);
    expect(term.lineMismatches).toBe(0);
    expect(term.sameLines).toBe(true);
  });

  it('gives the start offset of each line', () => {
    expect(
      lineStarts({
        lines: [
          { start: 0, end: 4, top: 0, height: 1, baseline: 1, left: 0, width: 1 },
          { start: 4, end: 9, top: 1, height: 1, baseline: 2, left: 0, width: 1 },
        ],
      }),
    ).toEqual([0, 4]);
  });
});

describe('M6c-U3 placed DOM cluster arithmetic (src/m6c-text-reference.ts)', () => {
  const placement = (origin: readonly [number, number], corner: readonly [number, number]) =>
    ({
      origin,
      corner,
      mode: 'snapped',
      deviceSize: 48,
      size: 24,
      bound: { x0: origin[0] - 24, y0: origin[1] - 96, x1: origin[0] + 72, y1: origin[1] + 48 },
    }) as unknown as ProbeModule.ClusterPlacement;

  it('targets the quantized pen (or o.x) and the baseline on the snapped row P.y, in CSS px', () => {
    const at = (
      origin: readonly [number, number],
      corner: readonly [number, number],
      phaseX: number,
    ) => ({ ...placement(origin, corner), phaseX }) as ProbeModule.ClusterPlacement;
    // DPR 2, P.y odd: the block's baseline on the whole CSS px 26, the layer moved by 1 device px.
    expect(reference.placedTarget(at([101.3, 52.7], [101, 53], 0.25), 2)).toEqual({
      x: 50.625,
      baseline: 26.5,
      layerShift: 0.5,
    });
    expect(reference.placedTarget(at([101.3, 52.7], [101, 53], 0.25), 2, 'origin')).toEqual({
      x: 50.65,
      baseline: 26.5,
      layerShift: 0.5,
    });
    expect(reference.placedTarget(at([100.2, 51.6], [100, 52], 0.25), 2).layerShift).toBe(0);
    expect(reference.placedTarget(at([10.1, 5.2], [10, 5], 0), 1)).toEqual({
      x: 10,
      baseline: 5,
      layerShift: 0,
    });
    expect(() =>
      reference.placedTarget({ ...placement([1, 1], [1, 1]), mode: 'general', corner: null }, 1),
    ).toThrow(/snapped/u);
  });

  it('gives the displayed size in CSS px', () => {
    expect(reference.displayedSize(placement([0, 0], [0, 0]), 2)).toBe(24);
  });

  it('moves the block by the measured residual', () => {
    expect(
      reference.nextPosition(
        { left: 10, top: 20 },
        { pen: 10.5, baseline: 45 },
        {
          x: 11,
          baseline: 44,
        },
      ),
    ).toEqual({ left: 10.5, top: 19 });
  });

  it('clips whole CSS px that cover the K9 bound padded by 2 device px, clamped to the area', () => {
    const area = { width: 960, height: 640 };
    expect(reference.referenceClip({ x0: 101.2, y0: 7.5, x1: 140.1, y1: 60 }, 2, area)).toEqual({
      clip: { x: 49, y: 2, width: 23, height: 29 },
      rect: { x: 98, y: 4, width: 46, height: 58 },
    });
    expect(reference.referenceClip({ x0: -5, y0: -5, x1: 3, y1: 3 }, 1, area)).toEqual({
      clip: { x: 0, y: 0, width: 5, height: 5 },
      rect: { x: 0, y: 0, width: 5, height: 5 },
    });
    expect(reference.referenceClip({ x0: 950, y0: 630, x1: 1000, y1: 700 }, 1, area).clip).toEqual({
      x: 948,
      y: 628,
      width: 12,
      height: 12,
    });
  });

  it('splits run text at LFs into pieces with global offsets, as text-dom builds its spans', () => {
    expect(reference.textPieces([{ text: 'ab\n\nc' }, { text: '한\n' }])).toEqual([
      { run: 0, start: 0, text: 'ab', lf: false },
      { run: 0, start: 2, text: '\n', lf: true },
      { run: 0, start: 3, text: '\n', lf: true },
      { run: 0, start: 4, text: 'c', lf: false },
      { run: 1, start: 5, text: '한', lf: false },
      { run: 1, start: 6, text: '\n', lf: true },
    ]);
  });

  it('finds the piece and local offset of a cluster', () => {
    const pieces = reference.textPieces([{ text: 'ab\nc' }, { text: 'de' }]);
    expect(reference.locatePiece(pieces, 1, 2)).toEqual({ piece: 0, local: 1 });
    expect(reference.locatePiece(pieces, 3, 4)).toEqual({ piece: 2, local: 0 });
    expect(reference.locatePiece(pieces, 5, 6)).toEqual({ piece: 3, local: 1 });
    expect(() => reference.locatePiece(pieces, 1, 4)).toThrow();
  });

  it('gives a cluster in the text of its piece, before and after it (M6c-U3 follow-up)', () => {
    const runs = [{ text: 'Ty.\nab' }, { text: '한.' }];
    expect(reference.clusterContext(runs, 2, 3)).toEqual({ before: 'Ty', text: '.', after: '' });
    expect(reference.clusterContext(runs, 4, 5)).toEqual({ before: '', text: 'a', after: 'b' });
    expect(reference.clusterContext(runs, 7, 8)).toEqual({ before: '한', text: '.', after: '' });
    expect(() => reference.clusterContext(runs, 3, 4)).toThrow();
  });

  it("builds the placed cluster from the node's whole run tree, the cluster split out (review r1 S1)", () => {
    const runs = [{ text: 'Ty.\nab' }, { text: '한.' }];
    expect(reference.referencePieces(runs, 2, 3)).toEqual([
      { run: 0, start: 0, text: 'Ty.', lf: false, cluster: { before: 'Ty', text: '.', after: '' } },
      { run: 0, start: 3, text: '\n', lf: true, cluster: null },
      { run: 0, start: 4, text: 'ab', lf: false, cluster: null },
      { run: 1, start: 6, text: '한.', lf: false, cluster: null },
    ]);
    const last = reference.referencePieces(runs, 7, 8);
    expect(last.map((piece) => piece.cluster)).toEqual([
      null,
      null,
      null,
      { before: '한', text: '.', after: '' },
    ]);
    expect(() => reference.referencePieces(runs, 3, 4)).toThrow();
  });

  it('groups flowed clusters into lines by baseline and LF', () => {
    expect(
      reference.flowedLines([
        { baseline: 20 },
        { baseline: 20 },
        // Mixed sizes share the line's baseline.
        { baseline: 20.25 },
        // The next line, though its rect overlaps the previous one's.
        { baseline: 44 },
        { baseline: 44 },
        // After two LFs (an empty line between).
        { baseline: 92, breaks: 2 },
      ]),
    ).toEqual([0, 0, 0, 1, 1, 3]);
  });
});

describe('M6c-U3 page hook (apps/next-host/app/page.tsx)', () => {
  const page = readFileSync(path.join(appDir, 'app/page.tsx'), 'utf8');

  it('adds the reference members to the text hook, loading the module only on use', () => {
    expect(page).toMatch(/\.\.\.textReferenceHook\(editor\)/u);
    expect(page).toMatch(/const load = \(\) => import\('\.\.\/src\/m6c-text-reference'\);/u);
    for (const member of ['flowedReference', 'placeReference', 'readReference', 'clearReference']) {
      expect(page).toContain(`.${member}(`);
    }
    expect(page).toMatch(/minimumFontSize\(fontList, lang\)/u);
    // Only types are imported statically.
    expect(page).not.toMatch(/^import [^t].*m6c-text-reference/mu);
    expect(page).toMatch(/^import type \{[^}]*\} from '\.\.\/src\/m6c-text-reference';/mu);
  });
});
