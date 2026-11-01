import type { PrimitiveRendererServiceOptions } from '@vector-studio/renderer-core';

// M6c-U2 (MVP M6c contract, section 5): next-host's renderer service options, apart from the
// kernel ports, in one place, so that the host's service (src/webgpu-renderer.ts) and the
// `?test=1` cluster probe's service (src/m6c-text-probe.ts) are created with the same options.
// M1-U5: `clips: 'all'` (P4 rect and mask clips). M4-U4 (M4-P7): `paints: 'gradient'` (E23) and
// `groups: 'isolated'` (E25). M6c-U2: `text: 'atlas'` with the canvas glyph raster port (E28-S3,
// which needs `clips` other than 'none'), so projected text leaves draw instead of being
// isolated as `editor.renderer-unsupported`. This module has no runtime import, so it is unit
// tested in Node with any port.

/** The E28 glyph raster port, as the service options type carries it. */
export type HostGlyphRaster = NonNullable<PrimitiveRendererServiceOptions['glyphRaster']>;

/** The options every next-host service gets, without the fill and stroke mesh ports. */
export type HostRendererOptions = Readonly<
  Required<Pick<PrimitiveRendererServiceOptions, 'clips' | 'paints' | 'groups' | 'text'>> & {
    glyphRaster: HostGlyphRaster;
  }
>;

export function hostRendererOptions(glyphRaster: HostGlyphRaster): HostRendererOptions {
  return { clips: 'all', paints: 'gradient', groups: 'isolated', text: 'atlas', glyphRaster };
}
