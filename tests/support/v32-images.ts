// V-32 test helpers: image assets whose bytes are a valid magic number plus filler, keyed by
// their SHA-256, as a host computes `ImageAssetInput.key`.
import { createHash } from 'node:crypto';
import type { ImageAsset } from '@vector-studio/model';

const MAGIC: Readonly<Record<ImageAsset['mimeType'], readonly number[]>> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/gif': [...Buffer.from('GIF89a')],
  'image/webp': [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')],
};

export type AssetInput = ImageAsset & Readonly<{ key: string }>;

/** An asset of `width × height` whose bytes are the format's magic and `seed` filler bytes. */
export function makeAsset(
  seed: number,
  width = 64,
  height = 32,
  mimeType: ImageAsset['mimeType'] = 'image/png',
): AssetInput {
  const bytes = Buffer.from([...MAGIC[mimeType], seed, seed, seed, seed, seed, seed, seed, seed]);
  const key = createHash('sha256').update(bytes).digest('hex');
  return { key, mimeType, width, height, data: bytes.toString('base64') };
}

/** The table entry of an input (no key). */
export function entry({ mimeType, width, height, data }: AssetInput): ImageAsset {
  return { mimeType, width, height, data };
}
