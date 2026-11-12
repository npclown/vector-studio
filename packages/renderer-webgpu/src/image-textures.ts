import type { ImageSourcePort, ImageSourceResult } from '@vector-studio/contracts';
import {
  IMAGE_TEXTURE_BUDGET_BYTES,
  ImageResidency,
  buildImageMips,
} from '@vector-studio/renderer-core';
import type { ImageTextureSize } from './paint-pipeline.js';
import type { WebGpuResourceTracker } from './webgpu-platform.js';

// V-32 contract (docs/plans/viz-v32-image-contract.md), section 4: the image paint textures of
// one renderer generation. A frame asks for the texture of each drawn image key; a key without a
// resident texture is requested from the port, and a ready result is premultiplied, mipmapped
// (renderer-core, V32-K4) and uploaded with `writeTexture` when it fits the V32-K5 budget.
// Pending, failed and refused keys bind the transparent texture, so the paint contributes
// nothing (V32-K3). Device loss drops the whole store with its generation; the next generation
// requests the drawn images again.

const TEXTURE_BINDING_USAGE = 0x04;
const TEXTURE_COPY_DESTINATION_USAGE = 0x02;

/** A bound texture: the view and the size its records carry. */
export type ImageBinding = Readonly<{ key: string; view: GPUTextureView; size: ImageTextureSize }>;

/** V32-K3 and K5: what the backend reports after a frame. */
export type ImageNotice = Readonly<{
  key: string;
  kind: 'unavailable' | 'resource-limit';
  reason?: Extract<ImageSourceResult, { status: 'failed' }>['reason'];
}>;

type Resident = { texture: GPUTexture; view: GPUTextureView; size: ImageTextureSize; id: string };

/** The bytes of a full mip chain of `width × height` RGBA8, computed without building it. */
export function mipChainBytes(width: number, height: number): number {
  let bytes = 0;
  let w = width;
  let h = height;
  for (;;) {
    bytes += w * h * 4;
    if (w === 1 && h === 1) return bytes;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
}

export class ImageTextureStore {
  readonly #device: GPUDevice;
  readonly #resources: WebGpuResourceTracker;
  readonly #prefix: string;
  readonly #port: ImageSourcePort | null;
  readonly #residency: ImageResidency;
  readonly #resident = new Map<string, Resident>();
  /**
   * Keys the port answered pending or failed for: not requested again until the port notifies
   * them (V32-A05: one request per state change).
   */
  readonly #waiting = new Set<string>();
  /** Keys reported unavailable in this generation, so each is reported once (V32-K3). */
  readonly #reported = new Set<string>();
  /**
   * Keys refused by the budget, with the bytes they need: requested again only once that many
   * bytes would be admitted, and reported once while they stay refused (V32-K5).
   */
  readonly #refused = new Map<string, number>();
  #unsubscribe: (() => void) | null = null;
  #notices: ImageNotice[] = [];
  #transparentTexture: GPUTexture | null = null;
  #frame = 0;
  #next = 0;
  #base: Readonly<{
    transparent: ImageBinding;
    clampSampler: GPUSampler;
    repeatSampler: GPUSampler;
  }> | null = null;
  /** Textures uploaded, for tests and the A06 counters. */
  uploads = 0;

  public constructor(
    device: GPUDevice,
    resources: WebGpuResourceTracker,
    prefix: string,
    port: ImageSourcePort | null,
    budgetBytes: number = IMAGE_TEXTURE_BUDGET_BYTES,
  ) {
    this.#device = device;
    this.#resources = resources;
    this.#prefix = prefix;
    this.#port = port;
    this.#residency = new ImageResidency(budgetBytes);
  }

  /**
   * The transparent 1 × 1 texture and the two samplers, created on first use, so a generation
   * whose paints never draw creates none.
   */
  #ensureBase() {
    if (this.#base !== null) return this.#base;
    const device = this.#device;
    const prefix = this.#prefix;
    const texture = device.createTexture({
      label: `${prefix}/image-transparent`,
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: TEXTURE_BINDING_USAGE | TEXTURE_COPY_DESTINATION_USAGE,
    });
    this.#resources.track(`${prefix}/image-transparent`, textureDescriptor(1, 1, 1));
    device.queue.writeTexture(
      { texture, origin: { x: 0, y: 0 } },
      new Uint8Array(4),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    const transparent: ImageBinding = Object.freeze({
      key: '',
      view: texture.createView(),
      size: Object.freeze({ width: 1, height: 1, levels: 1 }),
    });
    const sampler = (name: string, mode: GPUAddressMode) => {
      const created = device.createSampler({
        label: `${prefix}/image-${name}-sampler`,
        addressModeU: mode,
        addressModeV: mode,
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
      });
      this.#resources.track(`${prefix}/image-${name}-sampler`, { category: 'sampler' });
      return created;
    };
    this.#transparentTexture = texture;
    this.#base = Object.freeze({
      transparent,
      clampSampler: sampler('clamp', 'clamp-to-edge'),
      repeatSampler: sampler('repeat', 'repeat'),
    });
    return this.#base;
  }

  public get transparent(): ImageBinding {
    return this.#ensureBase().transparent;
  }

  public get clampSampler(): GPUSampler {
    return this.#ensureBase().clampSampler;
  }

  public get repeatSampler(): GPUSampler {
    return this.#ensureBase().repeatSampler;
  }

  /** Starts a frame: textures bound since then count as drawn in it (V32-K5). */
  public beginFrame(): void {
    this.#frame += 1;
  }

  /** The texture to bind for `key`: its own when resident, else the transparent one. */
  public resolve(key: string): ImageBinding {
    if (key === '') return this.transparent;
    const resident = this.#resident.get(key);
    if (resident !== undefined) {
      this.#residency.use(key, this.#frame);
      return { key, view: resident.view, size: resident.size };
    }
    if (this.#port === null || this.#waiting.has(key)) return this.transparent;
    this.#subscribe();
    const needed = this.#refused.get(key);
    if (needed !== undefined && !this.#residency.fits(needed, this.#frame)) {
      return this.transparent;
    }
    let result: ImageSourceResult;
    try {
      result = this.#port.request(key);
    } catch {
      result = { status: 'failed', reason: 'decode-failed' };
    }
    if (result === null || typeof result !== 'object') {
      result = { status: 'failed', reason: 'decode-failed' };
    }
    if (result.status === 'pending') {
      this.#waiting.add(key);
      return this.transparent;
    }
    if (result.status !== 'ready') {
      this.#fail(key, result.status === 'failed' ? result.reason : 'decode-failed');
      return this.transparent;
    }
    const { width, height, pixels } = result;
    const sized =
      Number.isSafeInteger(width) && Number.isSafeInteger(height) && width >= 1 && height >= 1;
    if (!sized || !(pixels instanceof Uint8Array) || pixels.length !== width * height * 4) {
      this.#fail(key, 'decode-failed');
      return this.transparent;
    }
    if (width > this.#maxSide() || height > this.#maxSide()) {
      this.#fail(key, 'too-large');
      return this.transparent;
    }
    const bytes = mipChainBytes(width, height);
    const admission = this.#residency.admit(key, bytes, this.#frame);
    if (!admission.admitted) {
      if (!this.#refused.has(key)) {
        this.#notices.push(Object.freeze({ key, kind: 'resource-limit' }));
      }
      this.#refused.set(key, bytes);
      return this.transparent;
    }
    this.#refused.delete(key);
    for (const released of admission.release) this.#releaseTexture(released);
    const levels = buildImageMips(width, height, pixels);
    if (levels === null) {
      this.#residency.remove(key);
      this.#fail(key, 'decode-failed');
      return this.transparent;
    }
    const id = `${this.#prefix}/image-${this.#next++}`;
    let texture: GPUTexture;
    try {
      texture = this.#device.createTexture({
        label: id,
        size: { width, height },
        mipLevelCount: levels.length,
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING_USAGE | TEXTURE_COPY_DESTINATION_USAGE,
      });
    } catch {
      this.#residency.remove(key);
      this.#fail(key, 'too-large');
      return this.transparent;
    }
    this.#resources.track(id, textureDescriptor(width, height, levels.length));
    levels.forEach((level, mipLevel) => {
      this.#device.queue.writeTexture(
        { texture, mipLevel, origin: { x: 0, y: 0 } },
        level.pixels,
        { bytesPerRow: level.width * 4 },
        { width: level.width, height: level.height },
      );
    });
    this.uploads += 1;
    const size = Object.freeze({ width, height, levels: levels.length });
    const view = texture.createView();
    this.#resident.set(key, { texture, view, size, id });
    return { key, view, size };
  }

  /**
   * The oldest `limit` notices not yet taken (V32-K3, K5); the rest wait for the next call, so a
   * frame with many failed keys still reports each one.
   */
  public takeNotices(limit = Number.POSITIVE_INFINITY): readonly ImageNotice[] {
    const notices = this.#notices.slice(0, limit);
    this.#notices = this.#notices.slice(notices.length);
    return notices;
  }

  /**
   * V32-K3: the port's notification makes its keys requestable again, so a pending key draws once
   * ready and a failed one is retried (reported again only in a new generation).
   */
  #subscribe(): void {
    if (this.#unsubscribe !== null || this.#port === null) return;
    this.#unsubscribe = this.#port.subscribe((keys) => {
      for (const key of keys) this.#waiting.delete(key);
    });
  }

  public get residentBytes(): number {
    return this.#residency.bytes;
  }

  public dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const key of [...this.#resident.keys()]) this.#releaseTexture(key);
    this.#residency.clear();
    if (this.#base === null) return;
    this.#base = null;
    this.#transparentTexture?.destroy();
    this.#transparentTexture = null;
    for (const name of ['image-transparent', 'image-clamp-sampler', 'image-repeat-sampler']) {
      try {
        this.#resources.release(`${this.#prefix}/${name}`);
      } catch {
        // Accounting cleanup is best effort.
      }
    }
  }

  #maxSide(): number {
    const limit = this.#device.limits.maxTextureDimension2D;
    return Math.min(4096, typeof limit === 'number' && limit > 0 ? limit : 4096);
  }

  #fail(key: string, reason: Extract<ImageSourceResult, { status: 'failed' }>['reason']): void {
    this.#waiting.add(key);
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#notices.push(Object.freeze({ key, kind: 'unavailable', reason }));
  }

  #releaseTexture(key: string): void {
    const resident = this.#resident.get(key);
    if (resident === undefined) return;
    this.#resident.delete(key);
    this.#residency.remove(key);
    resident.texture.destroy();
    try {
      this.#resources.release(resident.id);
    } catch {
      // Accounting cleanup is best effort.
    }
  }
}

function textureDescriptor(width: number, height: number, levels: number) {
  return Object.freeze({
    category: 'texture' as const,
    dimension: '2d' as const,
    width,
    height,
    depthOrArrayLayers: 1,
    mipLevelCount: levels,
    sampleCount: 1,
    bytesPerTexel: 4,
  });
}
