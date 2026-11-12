// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U4, V32-E1: the header parser, the
// hash and the asset builder, on hand-built headers.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_MAX_BYTES,
  base64ToBytes,
  bytesToBase64,
  imageAssetFromBlob,
  readImageHeader,
  sha256Hex,
  withinImageCaps,
} from '../../packages/react/src/image-header.js';

const text = (value: string) => [...value].map((char) => char.charCodeAt(0));
const be32 = (value: number) => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];
const be16 = (value: number) => [(value >> 8) & 255, value & 255];
const le16 = (value: number) => [value & 255, (value >> 8) & 255];
const le24 = (value: number) => [value & 255, (value >> 8) & 255, (value >> 16) & 255];

function pngBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...text('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

function gifBytes(width: number, height: number, version = '89a'): Uint8Array {
  return Uint8Array.from([...text(`GIF${version}`), ...le16(width), ...le16(height), 0, 0, 0]);
}

/** A little or big endian Exif APP1 segment with one Orientation entry. */
function exif(orientation: number, little: boolean): number[] {
  const u16 = (value: number) => (little ? le16(value) : be16(value));
  const u32 = (value: number) =>
    little ? [...le16(value), ...le16(0)] : [...be16(0), ...be16(value)];
  const tiff = [
    ...text(little ? 'II' : 'MM'),
    ...u16(42),
    ...u32(8),
    ...u16(1),
    // Tag 0x0112, type SHORT (3), count 1, the value in the first two bytes of the field.
    ...u16(0x0112),
    ...u16(3),
    ...u32(1).slice(0, 4),
    ...u16(orientation),
    0,
    0,
    ...u32(0),
  ];
  const body = [...text('Exif'), 0, 0, ...tiff];
  return [0xff, 0xe1, ...be16(body.length + 2), ...body];
}

function jpegBytes(
  width: number,
  height: number,
  options: { orientation?: number; little?: boolean; marker?: number; exifAfterSof?: boolean } = {},
): Uint8Array {
  const sof = [
    0xff,
    options.marker ?? 0xc0,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  const app0 = [0xff, 0xe0, ...be16(16), ...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  // A DHT segment before the frame header: marker C4 is not a frame header.
  const dht = [0xff, 0xc4, ...be16(4), 0, 0];
  const orientation =
    options.orientation === undefined ? [] : exif(options.orientation, options.little ?? false);
  return Uint8Array.from([
    0xff,
    0xd8,
    ...app0,
    ...(options.exifAfterSof ? [] : orientation),
    ...dht,
    ...sof,
    ...(options.exifAfterSof ? orientation : []),
    0xff,
    0xda,
    ...be16(12),
    ...new Array<number>(10).fill(0),
  ]);
}

function webpLossy(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...text('RIFF'),
    ...le16(0),
    ...le16(0),
    ...text('WEBP'),
    ...text('VP8 '),
    ...le16(10),
    ...le16(0),
    // Frame tag (3 bytes), start code, 14-bit width and height (the top two bits are scale).
    0x10,
    0x02,
    0x00,
    0x9d,
    0x01,
    0x2a,
    ...le16(width | 0x4000),
    ...le16(height | 0x8000),
  ]);
}

function webpLossless(width: number, height: number): Uint8Array {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return Uint8Array.from([
    ...text('RIFF'),
    ...le16(0),
    ...le16(0),
    ...text('WEBP'),
    ...text('VP8L'),
    ...le16(5),
    ...le16(0),
    0x2f,
    bits & 255,
    (bits >>> 8) & 255,
    (bits >>> 16) & 255,
    (bits >>> 24) & 255,
  ]);
}

function webpExtended(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...text('RIFF'),
    ...le16(0),
    ...le16(0),
    ...text('WEBP'),
    ...text('VP8X'),
    ...le16(10),
    ...le16(0),
    0x10,
    0,
    0,
    0,
    ...le24(width - 1),
    ...le24(height - 1),
  ]);
}

describe('V32-E1 header parser', () => {
  it('reads the PNG IHDR', () => {
    expect(readImageHeader(pngBytes(640, 480))).toEqual({
      mimeType: 'image/png',
      width: 640,
      height: 480,
    });
    // Sides past 16 bits.
    expect(readImageHeader(pngBytes(70000, 3))).toMatchObject({ width: 70000, height: 3 });
  });

  it('rejects a PNG whose first chunk is not a 13-byte IHDR or is cut short', () => {
    const wrong = pngBytes(2, 2);
    wrong.set(text('IDAT'), 12);
    expect(readImageHeader(wrong)).toBeNull();
    expect(readImageHeader(pngBytes(2, 2).subarray(0, 23))).toBeNull();
    const length = pngBytes(2, 2);
    length[11] = 12;
    expect(readImageHeader(length)).toBeNull();
  });

  it('reads the JPEG SOF, skipping other segments and the DHT marker', () => {
    expect(readImageHeader(jpegBytes(300, 200))).toEqual({
      mimeType: 'image/jpeg',
      width: 300,
      height: 200,
    });
    // Progressive (SOF2) and an extended sequential (SOF1) frame.
    expect(readImageHeader(jpegBytes(7, 9, { marker: 0xc2 }))).toMatchObject({
      width: 7,
      height: 9,
    });
    expect(readImageHeader(jpegBytes(7, 9, { marker: 0xc1 }))).toMatchObject({
      width: 7,
      height: 9,
    });
  });

  it('turns the JPEG size with the EXIF orientation 5 to 8, either endianness', () => {
    for (const little of [true, false]) {
      for (const orientation of [1, 2, 3, 4]) {
        expect(readImageHeader(jpegBytes(300, 200, { orientation, little }))).toMatchObject({
          width: 300,
          height: 200,
        });
      }
      for (const orientation of [5, 6, 7, 8]) {
        expect(readImageHeader(jpegBytes(300, 200, { orientation, little }))).toMatchObject({
          width: 200,
          height: 300,
        });
      }
    }
    // An Exif block after the frame header counts too; an out-of-range value is ignored.
    expect(
      readImageHeader(jpegBytes(300, 200, { orientation: 6, exifAfterSof: true })),
    ).toMatchObject({ width: 200, height: 300 });
    expect(readImageHeader(jpegBytes(300, 200, { orientation: 9 }))).toMatchObject({
      width: 300,
      height: 200,
    });
  });

  it('rejects a JPEG without a frame header', () => {
    expect(readImageHeader(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    const noFrame = jpegBytes(5, 5).subarray(0, 24);
    expect(readImageHeader(noFrame)).toBeNull();
  });

  it('reads the GIF screen descriptor', () => {
    expect(readImageHeader(gifBytes(500, 300))).toEqual({
      mimeType: 'image/gif',
      width: 500,
      height: 300,
    });
    expect(readImageHeader(gifBytes(1, 65535, '87a'))).toMatchObject({ width: 1, height: 65535 });
    expect(readImageHeader(gifBytes(5, 5, '90a'))).toBeNull();
  });

  it('reads WebP VP8, VP8L and VP8X', () => {
    expect(readImageHeader(webpLossy(320, 240))).toEqual({
      mimeType: 'image/webp',
      width: 320,
      height: 240,
    });
    expect(readImageHeader(webpLossless(1024, 17))).toMatchObject({ width: 1024, height: 17 });
    expect(readImageHeader(webpLossless(16384, 16384))).toMatchObject({
      width: 16384,
      height: 16384,
    });
    expect(readImageHeader(webpExtended(30000, 12345))).toMatchObject({
      width: 30000,
      height: 12345,
    });
    const badStart = webpLossy(10, 10);
    badStart[23] = 0;
    expect(readImageHeader(badStart)).toBeNull();
    const badSignature = webpLossless(10, 10);
    badSignature[20] = 0;
    expect(readImageHeader(badSignature)).toBeNull();
    const unknown = webpLossy(10, 10);
    unknown.set(text('ABCD'), 12);
    expect(readImageHeader(unknown)).toBeNull();
  });

  it('answers null for other data and for data that is too short', () => {
    expect(readImageHeader(new Uint8Array())).toBeNull();
    expect(
      readImageHeader(Uint8Array.from(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))),
    ).toBeNull();
    expect(readImageHeader(Uint8Array.from(text('GIF89a')))).toBeNull();
    expect(readImageHeader(Uint8Array.from(text('RIFF....WEBP')))).toBeNull();
  });

  it('checks the V32-M1 caps', () => {
    expect(withinImageCaps(1, 1)).toBe(true);
    expect(withinImageCaps(32768, 2048)).toBe(true);
    expect(withinImageCaps(32768, 2049)).toBe(false);
    expect(withinImageCaps(8192, 8192)).toBe(true);
    expect(withinImageCaps(8193, 8192)).toBe(false);
    expect(withinImageCaps(32769, 1)).toBe(false);
    expect(withinImageCaps(0, 5)).toBe(false);
    expect(withinImageCaps(1.5, 5)).toBe(false);
  });
});

describe('V32-E1 hash and asset input', () => {
  it('hashes with SHA-256 as lowercase hex', async () => {
    const bytes = pngBytes(3, 4);
    expect(await sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('round trips base64 over a size that needs several chunks', () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => index % 251);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect(base64ToBytes(encoded)).toEqual(bytes);
  });

  it('builds an ImageAssetInput from a blob: size from the header, key from the bytes', async () => {
    const bytes = jpegBytes(300, 200, { orientation: 8 });
    const input = await imageAssetFromBlob(new Blob([bytes as BlobPart]));
    expect(input).toEqual({
      key: createHash('sha256').update(bytes).digest('hex'),
      mimeType: 'image/jpeg',
      width: 200,
      height: 300,
      data: Buffer.from(bytes).toString('base64'),
    });
  });

  it('answers null for an unknown format, a size past the caps and an oversized or empty blob', async () => {
    expect(await imageAssetFromBlob(new Blob(['hello']))).toBeNull();
    expect(await imageAssetFromBlob(new Blob([pngBytes(40000, 10) as BlobPart]))).toBeNull();
    expect(await imageAssetFromBlob(new Blob([pngBytes(9000, 9000) as BlobPart]))).toBeNull();
    expect(await imageAssetFromBlob(new Blob([]))).toBeNull();
    // Over 32 MiB by size alone: the bytes are never read.
    const huge = {
      size: IMAGE_MAX_BYTES + 1,
      arrayBuffer: () => Promise.reject(new Error('read')),
    };
    expect(await imageAssetFromBlob(huge)).toBeNull();
  });
});
