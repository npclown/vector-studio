import type {
  GlyphRasterPort,
  GlyphRasterRequest,
  GlyphRasterResult,
} from '@vector-studio/contracts';

// E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md), section 2, Raster port: the
// main-thread canvas implementation. One `OffscreenCanvas` 2D context rasterizes each cluster
// with white `fillText` on a transparent surface; coverage is the alpha channel. Main-thread
// rasterization sees every face registered in `document.fonts` (M6-F2, ADR 0003).

export const CANVAS_GLYPH_RASTER_OPERATION_ID = 'canvas-2d/raster-v0';
/** A bitmap wider or taller than this is `too-large` (E28-K4). */
export const CANVAS_GLYPH_RASTER_MAX_EXTENT = 1024;
/** The transparent border around the measured box, at least 2 px on each side. */
const PAD = 2;
/** Set before each font, so a list that does not parse leaves it in place. */
const SENTINEL_FONT = '7px "vector-studio sentinel"';

type RasterContext = OffscreenCanvasRenderingContext2D & { lang?: string };

/** The canvas factory; tests pass their own. */
export type CanvasGlyphRasterOptions = Readonly<{
  createCanvas?: (width: number, height: number) => OffscreenCanvas;
}>;

const FAILED_UNAVAILABLE: GlyphRasterResult = Object.freeze({
  status: 'failed',
  reason: 'unavailable',
});
const FAILED_TOO_LARGE: GlyphRasterResult = Object.freeze({
  status: 'failed',
  reason: 'too-large',
});
const EMPTY: GlyphRasterResult = Object.freeze({ status: 'empty' });

/**
 * The canvas raster port. The context is created on the first request; a page without
 * `OffscreenCanvas` or a 2D context answers `failed: 'unavailable'`.
 */
export function createCanvasGlyphRaster(options: CanvasGlyphRasterOptions = {}): GlyphRasterPort {
  const createCanvas =
    options.createCanvas ?? ((width: number, height: number) => new OffscreenCanvas(width, height));
  let canvas: OffscreenCanvas | null = null;
  let context: RasterContext | null = null;

  const setFont = (request: GlyphRasterRequest): boolean => {
    const ctx = context!;
    ctx.font = SENTINEL_FONT;
    const sentinel = ctx.font;
    ctx.font = `${request.pixelSize}px ${request.fontList}`;
    if (ctx.font === sentinel) return false;
    if ('lang' in ctx) ctx.lang = request.lang;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    return true;
  };

  const rasterize = (request: GlyphRasterRequest): GlyphRasterResult => {
    if (request.text.trim().length === 0) return EMPTY;
    if (context === null) {
      try {
        canvas = createCanvas(64, 64);
        context = canvas.getContext('2d', { willReadFrequently: true });
      } catch {
        context = null;
      }
      if (context === null) {
        canvas = null;
        return FAILED_UNAVAILABLE;
      }
    }
    if (!setFont(request)) return FAILED_UNAVAILABLE;
    const metrics = context.measureText(request.text);
    const boxLeft = metrics.actualBoundingBoxLeft;
    const boxRight = metrics.actualBoundingBoxRight;
    const ascent = metrics.actualBoundingBoxAscent;
    const descent = metrics.actualBoundingBoxDescent;
    if (![boxLeft, boxRight, ascent, descent].every(Number.isFinite)) return FAILED_UNAVAILABLE;
    const left = PAD + Math.ceil(boxLeft);
    const top = PAD + Math.ceil(ascent);
    const width = left + Math.ceil(boxRight + request.phaseX) + PAD;
    const height = top + Math.ceil(descent) + PAD;
    if (width > CANVAS_GLYPH_RASTER_MAX_EXTENT || height > CANVAS_GLYPH_RASTER_MAX_EXTENT) {
      return FAILED_TOO_LARGE;
    }
    // A box whose sides cancel (ink entirely left of the pen, say) still has its border.
    if (!(width >= 1 && height >= 1)) return EMPTY;
    const surface = canvas!;
    if (surface.width < width || surface.height < height) {
      // Resizing resets the context's state, so the font is set again.
      surface.width = Math.max(surface.width, width);
      surface.height = Math.max(surface.height, height);
      if (!setFont(request)) return FAILED_UNAVAILABLE;
    }
    context.clearRect(0, 0, width, height);
    context.fillText(request.text, left + request.phaseX, top);
    const pixels = context.getImageData(0, 0, width, height).data;
    const coverage = new Uint8Array(width * height);
    for (let index = 0; index < coverage.length; index += 1) {
      coverage[index] = pixels[index * 4 + 3]!;
    }
    return Object.freeze({ status: 'ok', width, height, left, top, coverage });
  };

  return Object.freeze({
    portVersion: 0,
    operationId: CANVAS_GLYPH_RASTER_OPERATION_ID,
    rasterize,
  });
}
