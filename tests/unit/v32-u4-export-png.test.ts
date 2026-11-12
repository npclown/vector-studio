// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U4, V32-E4 (PNG half): the Canvas 2D
// export draws image paints after an awaited decode: `extend` and `decal` with `drawImage` under
// the shape clip, `repeat` with `createPattern` and `setTransform`; a failed decode leaves the
// paint out and the export still succeeds. A recording canvas stands in for the browser's; the
// headed pixel probe is in tests/v32-image-flow (V32-A07).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '../../packages/editor-core/src/index.js';
import { axisBands, exportPng } from '../../packages/react/src/export-image.js';
import { makeAsset } from '../support/v32-images.js';

const asset = makeAsset(7, 64, 32);

type Call = readonly [string, ...unknown[]];

/** Every call and property write on a context, in order. */
function recorder(log: Call[]) {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(held, name: string) {
      if (name in held) return held[name];
      return (...args: unknown[]) => {
        log.push([name, ...args]);
        if (name === 'createPattern') {
          return {
            setTransform: (matrix: unknown) => log.push(['pattern.setTransform', matrix]),
          };
        }
        return undefined;
      };
    },
    set(held, name: string, value) {
      held[name] = value;
      log.push([`set ${name}`, value]);
      return true;
    },
  });
}

let log: Call[] = [];
let closed = 0;
let decode: () => Promise<{ width: number; height: number; close(): void }>;

beforeEach(() => {
  log = [];
  closed = 0;
  decode = () =>
    Promise.resolve({
      width: 64,
      height: 32,
      close: () => {
        closed += 1;
      },
    });
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return recorder(log);
      }
      convertToBlob() {
        return Promise.resolve(new Blob(['png'], { type: 'image/png' }));
      }
    },
  );
  vi.stubGlobal(
    'Path2D',
    class {
      moveTo() {}
      lineTo() {}
      bezierCurveTo() {}
      closePath() {}
    },
  );
  vi.stubGlobal(
    'DOMMatrix',
    class {
      constructor(readonly init: readonly number[]) {}
    },
  );
  vi.stubGlobal('createImageBitmap', (_blob: Blob, options: Record<string, unknown>) => {
    log.push(['createImageBitmap', options]);
    return decode();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
  return result.ids;
}

/** A 128 × 100 rectangle (the image is 64 × 32) with the image fill in `mode`. */
function scene(mode: 'fill' | 'fit' | 'stretch' | 'tile', scale = 1): Editor {
  const target = createEditor({ ids: createCounterIdSource('n') });
  ok(target, { type: 'setViewportSize', width: 800, height: 600 });
  const [id] = ok(target, { type: 'insertImages', assets: [asset], at: { x: 100, y: 100 } });
  ok(target, {
    type: 'setFrames',
    frames: [{ id: id!, frame: { x: 0, y: 0, width: 128, height: 100 } }],
  });
  ok(target, { type: 'setImagePaint', ids: [id!], scaleMode: mode, scale });
  return target;
}

const names = (calls: readonly Call[]) => calls.map((call) => call[0]);
const drawn = (calls: readonly Call[]) => calls.filter((call) => call[0] === 'drawImage');

describe('V32-E4 PNG export of image paints', () => {
  it('decodes with the V32-H1 options and draws a stretched image once, under the shape clip', async () => {
    const blob = await exportPng(scene('stretch'));
    expect(blob).toBeInstanceOf(Blob);
    expect(log.find((call) => call[0] === 'createImageBitmap')![1]).toEqual({
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
      imageOrientation: 'from-image',
    });
    const calls = drawn(log);
    expect(calls).toHaveLength(1);
    // The whole 64 × 32 image into the unit square; the clip came before it.
    expect(calls[0]!.slice(2)).toEqual([0, 0, 64, 32, 0, 0, 1, 1]);
    expect(names(log).indexOf('clip')).toBeLessThan(names(log).indexOf('drawImage'));
    expect(names(log)).not.toContain('createPattern');
    // The bitmap is released.
    expect(closed).toBe(1);
  });

  it('draws `fill` (extend on both axes) with the whole image, the shape clipping the overflow', async () => {
    await exportPng(scene('fill'));
    const calls = drawn(log);
    // 128 × 100 filled from 64 × 32: the image overflows the shape on one side, so the shape lies
    // inside the unit square and the whole image is the only band.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(2)).toEqual([0, 0, 64, 32, 0, 0, 1, 1]);
    expect(names(log)).not.toContain('createPattern');
  });

  it('draws `fit` without any row above or below the image (decal on the letterboxed axis)', async () => {
    await exportPng(scene('fit'));
    const calls = drawn(log);
    // 128 × 100 around 64 × 32: the image spans the width and is letterboxed in height.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      // Source rows 0 to 32, destination rows inside the image's own [0, 1].
      expect([call[3], call[5]]).toEqual([0, 32]);
      expect(call[7] as number).toBeGreaterThanOrEqual(0);
      expect((call[7] as number) + (call[9] as number)).toBeLessThanOrEqual(1);
    }
  });

  it('holds the edge texel beyond the image for `extend` and nothing for `decal` (bands)', () => {
    expect(axisBands('decal', 64, -0.5, 1.5)).toEqual([{ u0: 0, u1: 1, s0: 0, s1: 64 }]);
    expect(axisBands('extend', 64, -0.5, 1.5)).toEqual([
      { u0: 0, u1: 1, s0: 0, s1: 64 },
      { u0: -0.5, u1: 0, s0: 0, s1: 1 },
      { u0: 1, u1: 1.5, s0: 63, s1: 64 },
    ]);
    // A shape inside the image needs only the image.
    expect(axisBands('extend', 8, 0.25, 0.75)).toEqual([{ u0: 0, u1: 1, s0: 0, s1: 8 }]);
  });

  it('draws `repeat` as a pattern placed by setTransform, not with drawImage', async () => {
    await exportPng(scene('tile', 0.5));
    expect(names(log)).toContain('createPattern');
    const pattern = log.find((call) => call[0] === 'createPattern')!;
    expect(pattern[2]).toBe('repeat');
    const placed = log.find((call) => call[0] === 'pattern.setTransform')!;
    const matrix = (placed[1] as { init: number[] }).init;
    // Image pixels to node space: 0.5 × 64 = 32 units for 64 pixels, 16 for 32.
    expect(matrix[0]).toBeCloseTo(0.5);
    expect(matrix[3]).toBeCloseTo(0.5);
    expect(drawn(log)).toEqual([]);
    expect(names(log)).toContain('fill');
  });

  it('leaves the paint out when the decode fails, and the export still succeeds', async () => {
    decode = () => Promise.reject(new Error('decode'));
    const blob = await exportPng(scene('stretch'));
    expect(blob).toBeInstanceOf(Blob);
    expect(drawn(log)).toEqual([]);
    expect(names(log)).not.toContain('createPattern');
    expect(closed).toBe(0);
  });

  it('decodes each image once however many paints use it', async () => {
    const target = scene('stretch');
    const [first] = target.query({ type: 'selection' });
    ok(target, { type: 'duplicateNodes', ids: [first!] });
    await exportPng(target);
    expect(log.filter((call) => call[0] === 'createImageBitmap')).toHaveLength(1);
    expect(drawn(log)).toHaveLength(2);
    expect(closed).toBe(1);
  });
});
