import type { ImageAssetInput } from '@vector-studio/editor-core';

// V-32 contract (docs/plans/viz-v32-image-contract.md), V32-E1: the host reads an image's size
// from its file header, never by a full decode, and hashes its bytes with `crypto.subtle.digest`,
// so the editor's image commands stay synchronous. The contract names no package for this
// parser, so it lives here, beside the image source (V32-H1) and the input (V32-H2) that use it.

/** What a header says: the type and the size after EXIF orientation (V32-M1). */
export type ImageHeader = Readonly<{
  mimeType: ImageAssetInput['mimeType'];
  width: number;
  height: number;
}>;

/** V32-M1: the largest side of an asset, in pixels. */
export const IMAGE_MAX_SIDE = 32768;
/** V32-M1: the most pixels of an asset. */
export const IMAGE_MAX_PIXELS = 2 ** 26;
/** V32-M2: the most decoded bytes of an asset. */
export const IMAGE_MAX_BYTES = 32 * 1024 * 1024;

/** Whether `width × height` is within the V32-M1 caps (whole numbers, sides and pixel count). */
export function withinImageCaps(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= IMAGE_MAX_SIDE &&
    height <= IMAGE_MAX_SIDE &&
    width * height <= IMAGE_MAX_PIXELS
  );
}

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => {
  if (at < 0 || at + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[at + index] !== text.charCodeAt(index)) return false;
  }
  return true;
};

const u16be = (bytes: Uint8Array, at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;
const u16le = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
const u32be = (bytes: Uint8Array, at: number): number =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

function png(bytes: Uint8Array): ImageHeader | null {
  // Signature, then the IHDR chunk: length 13, 'IHDR', width and height as 32-bit big endian.
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  if (u32be(bytes, 8) !== 13 || !ascii(bytes, 12, 'IHDR')) return null;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  // The eXIf chunk (before the first IDAT) orients the image, as Chromium applies it.
  let orientation = 1;
  let at = 33;
  while (at + 12 <= bytes.length) {
    const length = u32be(bytes, at);
    if (ascii(bytes, at + 4, 'IDAT')) break;
    if (ascii(bytes, at + 4, 'eXIf')) {
      orientation = tiffOrientation(bytes, at + 8, Math.min(at + 8 + length, bytes.length));
      break;
    }
    at += 12 + length;
  }
  return orientation >= 5
    ? { mimeType: 'image/png', width: height, height: width }
    : { mimeType: 'image/png', width, height };
}

function gif(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 13 || !(ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'))) return null;
  // The logical screen descriptor: width and height as 16-bit little endian. Chromium grows the
  // image to the first frame's bounds, so the size is the union of the screen and that frame.
  const screenWidth = u16le(bytes, 6);
  const screenHeight = u16le(bytes, 8);
  const flags = bytes[10]!;
  let at = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  while (at < bytes.length) {
    const block = bytes[at]!;
    if (block === 0x3b) break;
    if (block === 0x2c) {
      if (at + 10 > bytes.length) return null;
      return {
        mimeType: 'image/gif',
        width: Math.max(screenWidth, u16le(bytes, at + 1) + u16le(bytes, at + 5)),
        height: Math.max(screenHeight, u16le(bytes, at + 3) + u16le(bytes, at + 7)),
      };
    }
    if (block !== 0x21) return null;
    // An extension: a label, then data sub-blocks up to a zero-length one.
    at += 2;
    while (at < bytes.length && bytes[at] !== 0) at += bytes[at]! + 1;
    at += 1;
  }
  // No frame before the end: nothing a decoder grows the screen with.
  return at <= bytes.length
    ? { mimeType: 'image/gif', width: screenWidth, height: screenHeight }
    : null;
}

function webp(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 25 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return null;
  const mimeType = 'image/webp';
  if (ascii(bytes, 12, 'VP8 ')) {
    // Lossy: a 3-byte frame tag, the start code 9D 01 2A, then 14-bit width and height.
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return null;
    return {
      mimeType,
      width: u16le(bytes, 26) & 0x3fff,
      height: u16le(bytes, 28) & 0x3fff,
    };
  }
  if (ascii(bytes, 12, 'VP8L')) {
    // Lossless: signature 0x2F, then 14 bits of width − 1 and 14 bits of height − 1.
    if (bytes[20] !== 0x2f) return null;
    const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0;
    return { mimeType, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (bytes.length >= 30 && ascii(bytes, 12, 'VP8X')) {
    // Extended: flags, then the canvas size − 1 as 24-bit little endian.
    const side = (at: number) => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)) + 1;
    return { mimeType, width: side(24), height: side(27) };
  }
  return null;
}

/** The orientation (1 to 8) of an Exif APP1 payload starting at `start` (`Exif\0\0`), or 1. */
function exifOrientation(bytes: Uint8Array, start: number, end: number): number {
  if (!ascii(bytes, start, 'Exif\0\0') || end - start < 14) return 1;
  return tiffOrientation(bytes, start + 6, end);
}

/** The orientation (1 to 8) of the TIFF structure at `tiff` ending at `end`, or 1. */
function tiffOrientation(bytes: Uint8Array, tiff: number, end: number): number {
  if (end - tiff < 8) return 1;
  const little = ascii(bytes, tiff, 'II');
  if (!little && !ascii(bytes, tiff, 'MM')) return 1;
  const u16 = (at: number) => (little ? u16le(bytes, at) : u16be(bytes, at));
  const u32 = (at: number) =>
    little
      ? (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
      : u32be(bytes, at);
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return 1;
    // Tag 0x0112 (Orientation), type SHORT, count 1: the value sits in the first two bytes.
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpeg(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  let at = 2;
  let orientation = 1;
  let exifSeen = false;
  let size: { width: number; height: number } | null = null;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1]!;
    // Fill bytes, standalone markers (no length) and the start of a segment.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // The scan or the end of the image: the frame header and the Exif block are before it.
    if (marker === 0xd9 || marker === 0xda) break;
    const length = u16be(bytes, at + 2);
    if (length < 2) return null;
    const end = at + 2 + length;
    const body = at + 4;
    // SOF0 to SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (body + 5 > bytes.length) return null;
      size = { height: u16be(bytes, body + 1), width: u16be(bytes, body + 3) };
    } else if (marker === 0xe1 && !exifSeen && ascii(bytes, body, 'Exif\0\0')) {
      // Only the first Exif APP1 counts, as in Chromium; an XMP APP1 after it does not reset it.
      exifSeen = true;
      orientation = exifOrientation(bytes, body, Math.min(end, bytes.length));
    }
    at = end;
  }
  if (size === null) return null;
  // Orientations 5 to 8 turn the image by a quarter: the decoded size swaps its sides.
  return orientation >= 5
    ? { mimeType: 'image/jpeg', width: size.height, height: size.width }
    : { mimeType: 'image/jpeg', width: size.width, height: size.height };
}

/**
 * V32-E1: the type and size of an image from its file header: PNG IHDR, JPEG SOF with the EXIF
 * orientation applied, PNG with its eXIf orientation applied, GIF (the screen grown to the first frame), WebP VP8, VP8L and VP8X. Null when `bytes`
 * is not one of those or its header is cut short. The sizes are as the header states them and
 * may be 0 or beyond the V32-M1 caps; `withinImageCaps` checks those.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes);
}

const HEX = '0123456789abcdef';

/** The lowercase hex SHA-256 of `bytes` (`crypto.subtle.digest`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  let out = '';
  for (const byte of digest) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

/** Standard base64 with padding. Chunked, so a 32 MiB image does not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

/** The bytes of standard base64 `data`. */
export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A file as the asset builder reads it: the DOM `File` and `Blob` fit. */
export type ImageBlobLike = Readonly<{
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * V32-E1: the `ImageAssetInput` of an image file, or null when it cannot be one: over 32 MiB,
 * not a PNG, JPEG, GIF or WebP by its header, or a size outside the V32-M1 caps. The size comes
 * from the header (no decode); the key is the SHA-256 of the bytes.
 */
export async function imageAssetFromBlob(blob: ImageBlobLike): Promise<ImageAssetInput | null> {
  if (blob.size > IMAGE_MAX_BYTES || blob.size === 0) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > IMAGE_MAX_BYTES) return null;
  const header = readImageHeader(bytes);
  if (header === null || !withinImageCaps(header.width, header.height)) return null;
  return {
    key: await sha256Hex(bytes),
    mimeType: header.mimeType,
    width: header.width,
    height: header.height,
    data: bytesToBase64(bytes),
  };
}
