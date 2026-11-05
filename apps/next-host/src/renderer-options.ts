import {
  editorRendererOptions,
  type EditorGlyphRaster,
  type EditorRendererOptions,
} from '@vector-studio/webgpu-host';

// M6c-U2 (MVP M6c contract, section 5): next-host's renderer service options, apart from the
// kernel ports, in one place, so that the host's service (src/webgpu-renderer.ts) and the
// `?test=1` cluster probe's service (src/m6c-text-probe.ts) are created with the same options.
// M1-U5: `clips: 'all'` (P4 rect and mask clips). M4-U4 (M4-P7): `paints: 'gradient'` (E23) and
// `groups: 'isolated'` (E25). M6c-U2: `text: 'atlas'` with the canvas glyph raster port (E28-S3,
// which needs `clips` other than 'none'), so projected text leaves draw instead of being
// isolated as `editor.renderer-unsupported`. Its only runtime import is `@vector-studio/webgpu-host`,
// whose entry loads the renderer modules lazily, so it is unit tested in Node with any port.

/** The E28 glyph raster port, as the service options type carries it. */
export type HostGlyphRaster = EditorGlyphRaster;

/** The options every next-host service gets, without the fill and stroke mesh ports. */
export type HostRendererOptions = EditorRendererOptions;

/** AR-U1: the editor renderer options now live in `@vector-studio/webgpu-host`. */
export function hostRendererOptions(glyphRaster: HostGlyphRaster): HostRendererOptions {
  return editorRendererOptions(glyphRaster);
}

/** One call the host's service made to its glyph raster port (M6c-U4, `?test=1` only). */
export type GlyphRasterLogEntry = Readonly<{
  /** The newest text leaf generation the host's renderer had accepted at the call; null for none. */
  generation: number | null;
  text: string;
  fontList: string;
  lang: string;
  pixelSize: number;
  phaseX: number;
  /** M6c-U5 (section 9): `performance.now()` when the call started, and how long it took, in ms. */
  startMs: number;
  durationMs: number;
}>;

export type GlyphRasterLog = Readonly<{
  /** The port to give the host's service: `inner` with every call logged. */
  port: HostGlyphRaster;
  /** The calls in order; at most `cap`, the oldest dropped first. */
  entries: readonly GlyphRasterLogEntry[];
  /** Sets how a call reads the accepted generation (the scene recorder, once it exists). */
  setGeneration(read: () => number | null): void;
  clear(): void;
}>;

/**
 * M6c-U4 review S2: wraps the host's glyph raster port so the A05 spec can tell which keys the
 * service rasterized at which layout generation (the port's request carries no generation, so
 * the call takes the newest one the renderer accepted, as the frame it plans draws that scene).
 * Only the host's service gets the wrapped port; the cluster probe keeps the inner one.
 * M6c-U5 (section 9, the typing observation): each entry also holds the call's start and
 * duration on `now` (`performance.now()` by default), so the observation spec can sum the
 * raster time of each keystroke.
 */
export function createGlyphRasterLog(
  inner: HostGlyphRaster,
  cap = 200_000,
  now: () => number = () => performance.now(),
): GlyphRasterLog {
  const entries: GlyphRasterLogEntry[] = [];
  let generation: () => number | null = () => null;
  const port: HostGlyphRaster = Object.freeze({
    portVersion: inner.portVersion,
    operationId: inner.operationId,
    rasterize: (request: Parameters<HostGlyphRaster['rasterize']>[0]) => {
      const read = generation();
      const startMs = now();
      try {
        return inner.rasterize(request);
      } finally {
        if (entries.length >= cap) entries.shift();
        entries.push(
          Object.freeze({
            generation: read,
            text: request.text,
            fontList: request.fontList,
            lang: request.lang,
            pixelSize: request.pixelSize,
            phaseX: request.phaseX,
            startMs,
            durationMs: now() - startMs,
          }),
        );
      }
    },
  });
  return {
    port,
    entries,
    setGeneration(read) {
      generation = read;
    },
    clear() {
      entries.length = 0;
    },
  };
}
