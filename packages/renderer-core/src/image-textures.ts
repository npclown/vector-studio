import { SCENE_IMAGE_MAX_SIDE } from '@vector-studio/contracts';

// V-32 contract (docs/plans/viz-v32-image-contract.md), section 4: the CPU half of image paint
// textures. `buildImageMips` premultiplies a ready image (V32-K4) and builds its mip chain;
// `ImageResidency` decides which textures stay resident under the V32-K5 budget. Plain values
// only, so both run in Node; renderer-webgpu owns the GPU textures.

/** One mip level: RGBA8, premultiplied, rows top first, `4 · width · height` bytes. */
export type ImageMipLevel = Readonly<{ width: number; height: number; pixels: Uint8Array }>;

/** V32-K5: the image texture budget, all mip levels counted. */
export const IMAGE_TEXTURE_BUDGET_BYTES = 256 * 1024 * 1024;

/**
 * V32-K4: level 0 is `pixels` (straight alpha) premultiplied in binary64 and rounded to 8 bits;
 * each next level is the 2 × 2 box average of the previous one's premultiplied values (an odd
 * last row or column is clamped, so its texels repeat), down to 1 × 1. Null when the size or the
 * buffer length is wrong (V32-P1).
 */
export function buildImageMips(
  width: number,
  height: number,
  pixels: Uint8Array,
): readonly ImageMipLevel[] | null {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > SCENE_IMAGE_MAX_SIDE ||
    height > SCENE_IMAGE_MAX_SIDE ||
    !(pixels instanceof Uint8Array) ||
    pixels.length !== width * height * 4
  ) {
    return null;
  }
  const base = new Uint8Array(pixels.length);
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3]!;
    base[index] = Math.round((pixels[index]! * alpha) / 255);
    base[index + 1] = Math.round((pixels[index + 1]! * alpha) / 255);
    base[index + 2] = Math.round((pixels[index + 2]! * alpha) / 255);
    base[index + 3] = alpha;
  }
  const levels: ImageMipLevel[] = [Object.freeze({ width, height, pixels: base })];
  let previous = levels[0]!;
  while (previous.width > 1 || previous.height > 1) {
    const nextWidth = Math.max(1, previous.width >> 1);
    const nextHeight = Math.max(1, previous.height >> 1);
    const next = new Uint8Array(nextWidth * nextHeight * 4);
    const source = previous.pixels;
    const sourceWidth = previous.width;
    for (let y = 0; y < nextHeight; y += 1) {
      const y0 = Math.min(2 * y, previous.height - 1);
      const y1 = Math.min(2 * y + 1, previous.height - 1);
      for (let x = 0; x < nextWidth; x += 1) {
        const x0 = Math.min(2 * x, sourceWidth - 1);
        const x1 = Math.min(2 * x + 1, sourceWidth - 1);
        const a = (y0 * sourceWidth + x0) * 4;
        const b = (y0 * sourceWidth + x1) * 4;
        const c = (y1 * sourceWidth + x0) * 4;
        const d = (y1 * sourceWidth + x1) * 4;
        const out = (y * nextWidth + x) * 4;
        for (let lane = 0; lane < 4; lane += 1) {
          next[out + lane] = Math.round(
            (source[a + lane]! + source[b + lane]! + source[c + lane]! + source[d + lane]!) / 4,
          );
        }
      }
    }
    previous = Object.freeze({ width: nextWidth, height: nextHeight, pixels: next });
    levels.push(previous);
  }
  return Object.freeze(levels);
}

/** The bytes of a mip chain: the sum of its levels. */
export function imageMipBytes(levels: readonly ImageMipLevel[]): number {
  let bytes = 0;
  for (const level of levels) bytes += level.pixels.length;
  return bytes;
}

/**
 * V32-K5: the resident image textures, least recently drawn first. `use` marks a resident key
 * drawn in `frame`; `admit` decides whether a new texture of `bytes` fits, and names the resident
 * keys to release first (least recently drawn, never one drawn in the current frame). A texture
 * that does not fit even after those releases is refused: nothing is released for it.
 */
export class ImageResidency {
  readonly #budget: number;
  readonly #entries = new Map<string, { bytes: number; frame: number }>();
  #bytes = 0;

  public constructor(budgetBytes: number = IMAGE_TEXTURE_BUDGET_BYTES) {
    this.#budget = budgetBytes;
  }

  public get bytes(): number {
    return this.#bytes;
  }

  public has(key: string): boolean {
    return this.#entries.has(key);
  }

  public use(key: string, frame: number): void {
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      // Map order is the eviction order: re-insert as most recently drawn.
      this.#entries.delete(key);
      entry.frame = frame;
      this.#entries.set(key, entry);
    }
  }

  /**
   * Whether `bytes` fit, and the keys to release first. On success the key is resident, drawn
   * in `frame`; the caller releases the named textures.
   */
  public admit(
    key: string,
    bytes: number,
    frame: number,
  ): Readonly<{ admitted: boolean; release: readonly string[] }> {
    if (this.#entries.has(key)) this.remove(key);
    if (bytes > this.#budget) return { admitted: false, release: [] };
    const release: string[] = [];
    let freed = 0;
    for (const [candidate, entry] of this.#entries) {
      if (this.#bytes - freed + bytes <= this.#budget) break;
      if (entry.frame === frame) continue;
      release.push(candidate);
      freed += entry.bytes;
    }
    if (this.#bytes - freed + bytes > this.#budget) return { admitted: false, release: [] };
    for (const candidate of release) this.remove(candidate);
    this.#entries.set(key, { bytes, frame });
    this.#bytes += bytes;
    return { admitted: true, release };
  }

  public remove(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }

  public clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  public keys(): readonly string[] {
    return [...this.#entries.keys()];
  }
}
