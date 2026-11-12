import type { ImageSourcePort } from '@vector-studio/contracts';
import type { ImageAsset } from '@vector-studio/editor-core';
import { base64ToBytes, readImageHeader, withinImageCaps } from './image-header.js';

// V-32 contract (docs/plans/viz-v32-image-contract.md), V32-H1 and V32-P1, P2: the image source
// port over `createImageBitmap`. It decodes `images[key]` of the current document on the first
// request and answers `pending` until then; a decoded image is read back as RGBA through an
// `OffscreenCanvas` and kept, least recently requested dropped first, up to 512 MiB of pixels.
// The header's size is checked before the decode, so a crafted document cannot make the port
// allocate past the caps. Listeners run on a task after the change, never inside `request`.

/** V32-P2: the largest side of a ready result (`SCENE_IMAGE_MAX_SIDE` in `contracts`). */
const MAX_SIDE = 4096;
/** V32-H1: the pixels the port keeps, in bytes. */
export const IMAGE_SOURCE_CACHE_BYTES = 512 * 1024 * 1024;

/** The slice of a document the port reads: its image table. */
export type ImageDocumentLike = Readonly<{ images?: Readonly<Record<string, ImageAsset>> }>;

/** What the port needs from the browser; tests inject fakes. Defaults read the globals. */
export type ImageSourceHost = Readonly<{
  createImageBitmap(
    blob: Blob,
    options: Readonly<Record<string, unknown>>,
  ): Promise<{ width: number; height: number; close?(): void }>;
  /** The RGBA8 (straight alpha, rows top first) of `bitmap` drawn at its own size. */
  readPixels(bitmap: { width: number; height: number }): Uint8Array;
  /** Schedules `run` on a task (not a microtask); returns a cancel function. */
  schedule(run: () => void): () => void;
}>;

/** Options of `createImageSource`. */
export type ImageSourceOptions = Readonly<{
  /** The pixel budget in bytes; default 512 MiB (V32-H1). */
  cacheBytes?: number;
  host?: ImageSourceHost;
}>;

/**
 * What `request` answers: `ImageSourceResult` of `@vector-studio/contracts` (V32-P1), written out
 * here so that this package's public types name nothing outside `editor-core`'s.
 */
export type ImageSourceReply =
  | Readonly<{ status: 'ready'; width: number; height: number; pixels: Uint8Array }>
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'failed'; reason: 'unknown-image' | 'decode-failed' | 'too-large' }>;

/**
 * The image source port (V32-P1, `ImageSourcePort` of `@vector-studio/contracts`, to which it is
 * assignable) with the release of its timers and cached pixels.
 */
export type ImageSource = Readonly<{
  portVersion: 0;
  /** `'create-image-bitmap/v0'`. */
  operationId: string;
  request(image: string): ImageSourceReply;
  subscribe(listener: (images: readonly string[]) => void): () => void;
  /** Drops every cached image and pending notification; later requests answer `failed`. */
  dispose(): void;
}>;

function browserHost(): ImageSourceHost {
  return {
    createImageBitmap: (blob, options) => createImageBitmap(blob, options as ImageBitmapOptions),
    readPixels(bitmap) {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('image source: no 2d context');
      context.drawImage(bitmap as ImageBitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    },
    schedule(run) {
      const timer = setTimeout(run, 0);
      return () => clearTimeout(timer);
    },
  };
}

type Entry =
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'ready'; width: number; height: number; pixels: Uint8Array }>
  | Readonly<{ status: 'failed'; reason: 'decode-failed' | 'too-large' }>;

/** The size a header's image is decoded at: downscaled to `MAX_SIDE` per side, keeping the aspect. */
export function decodeSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  if (scale === 1) return { width, height };
  return {
    width: Math.min(MAX_SIDE, Math.max(1, Math.round(width * scale))),
    height: Math.min(MAX_SIDE, Math.max(1, Math.round(height * scale))),
  };
}

/**
 * V32-H1: an `ImageSourcePort` over the images of `getDocument()`. A key the document does not
 * hold is `failed` `unknown-image`. The first request of a key starts its decode and answers
 * `pending`; when it ends the port notifies the key on a task. A header above the V32-M1 caps is
 * `too-large`; one that disagrees with the asset's declared size, or any decode failure, is
 * `decode-failed`. A key dropped from the cache answers `pending` again and is decoded again.
 */
export function createImageSource(
  getDocument: () => ImageDocumentLike,
  options: ImageSourceOptions = {},
): ImageSource {
  const host = options.host ?? browserHost();
  const budget = options.cacheBytes ?? IMAGE_SOURCE_CACHE_BYTES;
  // Insertion order is request order: a request moves its key to the end.
  const entries = new Map<string, Entry>();
  const listeners = new Set<(images: readonly string[]) => void>();
  const changed = new Set<string>();
  let cancelNotify: (() => void) | null = null;
  let bytes = 0;
  let disposed = false;

  const notifyLater = (key: string) => {
    changed.add(key);
    if (cancelNotify !== null) return;
    cancelNotify = host.schedule(() => {
      cancelNotify = null;
      const keys = [...changed];
      changed.clear();
      for (const listener of [...listeners]) {
        try {
          listener(keys);
        } catch {
          // One listener's throw reaches neither the others nor the port.
        }
      }
    });
  };

  const evict = (keep: string) => {
    for (const [key, entry] of entries) {
      if (bytes <= budget) return;
      if (key === keep || entry.status !== 'ready') continue;
      bytes -= entry.pixels.length;
      entries.delete(key);
    }
  };

  const settle = (key: string, entry: Entry) => {
    if (disposed || entries.get(key)?.status !== 'pending') return;
    entries.set(key, entry);
    if (entry.status === 'ready') {
      bytes += entry.pixels.length;
      evict(key);
    }
    notifyLater(key);
  };

  const decode = async (key: string, asset: ImageAsset) => {
    // Off the caller's stack: `request` returns before any decoding work.
    await Promise.resolve();
    try {
      const data = base64ToBytes(asset.data);
      const header = readImageHeader(data);
      if (header === null || header.mimeType !== asset.mimeType) {
        settle(key, { status: 'failed', reason: 'decode-failed' });
        return;
      }
      if (!withinImageCaps(header.width, header.height)) {
        settle(key, { status: 'failed', reason: 'too-large' });
        return;
      }
      if (header.width !== asset.width || header.height !== asset.height) {
        settle(key, { status: 'failed', reason: 'decode-failed' });
        return;
      }
      const size = decodeSize(header.width, header.height);
      const resized = size.width !== header.width || size.height !== header.height;
      const bitmap = await host.createImageBitmap(
        new Blob([data as BlobPart], { type: asset.mimeType }),
        {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
          imageOrientation: 'from-image',
          ...(resized
            ? { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' }
            : {}),
        },
      );
      try {
        const { width, height } = bitmap;
        if (!(width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE)) {
          settle(key, { status: 'failed', reason: 'too-large' });
          return;
        }
        const pixels = host.readPixels(bitmap);
        if (pixels.length !== 4 * width * height) {
          settle(key, { status: 'failed', reason: 'decode-failed' });
          return;
        }
        settle(key, { status: 'ready', width, height, pixels });
      } finally {
        bitmap.close?.();
      }
    } catch {
      settle(key, { status: 'failed', reason: 'decode-failed' });
    }
  };

  // A port by structure: the check below fails to compile if `ImageSource` drifts from the contract.
  const source: ImageSource & ImageSourcePort = {
    portVersion: 0,
    operationId: 'create-image-bitmap/v0',
    request(key): ImageSourceReply {
      if (disposed) return { status: 'failed', reason: 'unknown-image' };
      const held = entries.get(key);
      if (held !== undefined) {
        // Requested now: the most recently requested.
        entries.delete(key);
        entries.set(key, held);
        return held;
      }
      let asset: ImageAsset | undefined;
      try {
        const table = getDocument().images;
        asset = table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
      } catch {
        asset = undefined;
      }
      if (asset === undefined) return { status: 'failed', reason: 'unknown-image' };
      entries.set(key, { status: 'pending' });
      void decode(key, asset);
      return { status: 'pending' };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      cancelNotify?.();
      cancelNotify = null;
      changed.clear();
      entries.clear();
      listeners.clear();
      bytes = 0;
    },
  };
  return source;
}
