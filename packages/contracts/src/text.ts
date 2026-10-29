// Glyph raster port of the E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md,
// section 2). Plain data only, as for the mesh ports: requests and results carry plain values
// and typed buffers, never a canvas, font or DOM object.

export type GlyphRasterPhase = 0 | 0.25 | 0.5 | 0.75;

export interface GlyphRasterRequest {
  /** One grapheme cluster (E28-S2). */
  readonly text: string;
  readonly fontList: string;
  readonly lang: string;
  /** The size bucket, in device px (E28-K2). */
  readonly pixelSize: number;
  /** The pen origin's offset inside its first pixel (E28-K3). */
  readonly phaseX: GlyphRasterPhase;
}

export type GlyphRasterResult =
  | Readonly<{
      status: 'ok';
      width: number;
      height: number;
      /**
       * Whole numbers: the pen point, before the phase, is the corner between bitmap pixels
       * `left - 1` and `left` horizontally and `top - 1` and `top` vertically.
       */
      left: number;
      top: number;
      /** Row-major coverage, `width * height` bytes. */
      coverage: Uint8Array;
    }>
  | Readonly<{ status: 'empty' }>
  | Readonly<{ status: 'failed'; reason: 'too-large' | 'unavailable' }>;

export interface GlyphRasterPort {
  readonly portVersion: 0;
  /** Names the implementation, for example 'canvas-2d/raster-v0'. */
  readonly operationId: string;
  /** Synchronous; a throw is caught by the renderer and reported (E28-D3). */
  rasterize(request: GlyphRasterRequest): GlyphRasterResult;
}
