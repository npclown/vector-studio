import { createHash } from 'node:crypto';

/**
 * P3.1o O01 crop run-length encoding (docs/plans/p3-o01-coverage-experiment-contract.md, page API).
 * `rleBase64` is the base64 of a little-endian Uint32 sequence [value0, count0, value1, count1, ...]
 * over the crop samples in row-major order. Values are unorm8 bytes (0..255) for `main` and raw
 * binary16 words (0..65535) for `diagMax` / `diagAdd`. Every count is positive and the counts sum
 * to w * h. `sha256` is over the decoded samples as bytes: one byte per u8 sample, two
 * little-endian bytes per u16 sample.
 */

export type SampleKind = 'u8' | 'u16';

export function encodeRle(samples: Uint8Array | Uint16Array): Uint32Array {
  const pairs: number[] = [];
  for (let index = 0; index < samples.length;) {
    const value = samples[index]!;
    let end = index + 1;
    while (end < samples.length && samples[end] === value) end += 1;
    pairs.push(value, end - index);
    index = end;
  }
  return Uint32Array.from(pairs);
}

export function rleToBase64(rle: Uint32Array): string {
  const bytes = new Uint8Array(rle.length * 4);
  const view = new DataView(bytes.buffer);
  rle.forEach((value, index) => view.setUint32(index * 4, value, true));
  return Buffer.from(bytes).toString('base64');
}

export function encodeRleBase64(samples: Uint8Array | Uint16Array): string {
  return rleToBase64(encodeRle(samples));
}

export function decodeRleBase64(base64: string, expectedLength: number, kind: 'u8'): Uint8Array;
export function decodeRleBase64(base64: string, expectedLength: number, kind: 'u16'): Uint16Array;
export function decodeRleBase64(
  base64: string,
  expectedLength: number,
  kind: SampleKind,
): Uint8Array | Uint16Array;
export function decodeRleBase64(
  base64: string,
  expectedLength: number,
  kind: SampleKind,
): Uint8Array | Uint16Array {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) throw new Error('rle:base64');
  if (bytes.length % 8 !== 0) throw new Error('rle:length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = kind === 'u8' ? new Uint8Array(expectedLength) : new Uint16Array(expectedLength);
  const maxValue = kind === 'u8' ? 0xff : 0xffff;
  let cursor = 0;
  for (let offset = 0; offset < bytes.length; offset += 8) {
    const value = view.getUint32(offset, true);
    const count = view.getUint32(offset + 4, true);
    if (value > maxValue) throw new Error('rle:value');
    if (count === 0 || cursor + count > expectedLength) throw new Error('rle:count');
    out.fill(value, cursor, cursor + count);
    cursor += count;
  }
  if (cursor !== expectedLength) throw new Error('rle:total');
  return out;
}

export function sampleBytes(samples: Uint8Array | Uint16Array): Uint8Array {
  if (samples instanceof Uint8Array) return samples;
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((value, index) => view.setUint16(index * 2, value, true));
  return bytes;
}

export function sampleSha256(samples: Uint8Array | Uint16Array): string {
  return createHash('sha256').update(sampleBytes(samples)).digest('hex');
}
