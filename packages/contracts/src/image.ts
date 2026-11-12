// Image source port of the V-32 contract (docs/plans/viz-v32-image-contract.md, V32-P1). Plain
// data only, as the glyph raster port: results carry numbers and a typed buffer, never an
// ImageBitmap, canvas or DOM object, so `contracts` compiles without the DOM library.

export type ImageSourceResult =
  | Readonly<{
      status: 'ready';
      /** At most SCENE_IMAGE_MAX_SIDE each. */
      width: number;
      height: number;
      /** RGBA8, straight alpha, rows top first; exactly `4 · width · height` bytes. */
      pixels: Uint8Array;
    }>
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'failed'; reason: 'unknown-image' | 'decode-failed' | 'too-large' }>;

export interface ImageSourcePort {
  readonly portVersion: 0;
  /** Names the implementation, for example 'create-image-bitmap/v0'. */
  readonly operationId: string;
  /** Synchronous; a throw counts as 'failed' with reason 'decode-failed'. */
  request(image: string): ImageSourceResult;
  /**
   * The listener runs after images became ready or failed (never inside `request`), with their
   * keys. Returns the unsubscribe function.
   */
  subscribe(listener: (images: readonly string[]) => void): () => void;
}
