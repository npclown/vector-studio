/**
 * P3.1l L02 capture decoder. It reads the 8192-byte readback (XY texture at offset 0, ZW texture
 * at offset 4096, bytesPerRow 256) and applies the frozen per-slot precedence literally. Clip x/y
 * words are returned unaltered as unsigned 32-bit integers.
 */

export const READBACK_BYTES = 8192;
export const XY_TEXTURE_OFFSET = 0;
export const ZW_TEXTURE_OFFSET = 4096;
export const READBACK_BYTES_PER_ROW = 256;
export const TEXEL_BYTES = 16;
export const TEXTURE_COLUMNS = 16;
export const CAPTURE_SLOTS = 256;
export const SENTINEL_WORD = 0xffffff00;
export const POISON_IDENTITY_WORD = 0xfffffffe;
export const CLIP_Z_WORD = 0x00000000;
export const CLIP_W_WORD = 0x3f800000;

export type CaptureExpectation = Readonly<{
  rowIndex: number;
  expectedCount: number;
  captureTag: number;
}>;

export type ClipWords = readonly (readonly [number, number])[];

export type CaptureDecoding =
  | Readonly<{ status: 'CAPTURED'; clipWords: ClipWords }>
  | Readonly<{ status: 'CAPTURE_INVALID'; reason: string }>;

type Texel = readonly [number, number, number, number];

function isWord(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
}

export function texelOffset(textureOffset: number, slot: number): number {
  const column = slot % TEXTURE_COLUMNS;
  const line = Math.floor(slot / TEXTURE_COLUMNS);
  const offset = textureOffset + READBACK_BYTES_PER_ROW * line + TEXEL_BYTES * column;
  if (
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    slot >= CAPTURE_SLOTS ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset + TEXEL_BYTES > READBACK_BYTES
  )
    throw new RangeError(`texel offset out of range: ${textureOffset}:${slot}`);
  return offset;
}

function readTexel(view: DataView, textureOffset: number, slot: number): Texel {
  const offset = texelOffset(textureOffset, slot);
  return [
    view.getUint32(offset, true),
    view.getUint32(offset + 4, true),
    view.getUint32(offset + 8, true),
    view.getUint32(offset + 12, true),
  ];
}

function invalid(reason: string): CaptureDecoding {
  return { status: 'CAPTURE_INVALID', reason };
}

export function decodeCapture(readback: Uint8Array, expected: CaptureExpectation): CaptureDecoding {
  const { rowIndex, expectedCount, captureTag } = expected;
  if (
    !isWord(rowIndex) ||
    !isWord(captureTag) ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    expectedCount > CAPTURE_SLOTS
  )
    throw new RangeError('invalid capture expectation');
  if (readback.byteLength !== READBACK_BYTES)
    return invalid(`capture:length:${readback.byteLength}`);
  const view = new DataView(readback.buffer, readback.byteOffset, readback.byteLength);
  const clipWords: (readonly [number, number])[] = [];
  for (let slot = 0; slot < CAPTURE_SLOTS; slot += 1) {
    const xy = readTexel(view, XY_TEXTURE_OFFSET, slot);
    const zw = readTexel(view, ZW_TEXTURE_OFFSET, slot);
    if (slot >= expectedCount) {
      if ([...xy, ...zw].some((word) => word !== SENTINEL_WORD))
        return invalid(`capture:extra:${slot}`);
      continue;
    }
    if (xy.every((word) => word === SENTINEL_WORD) || zw.every((word) => word === SENTINEL_WORD))
      return invalid(`capture:missing:${slot}`);
    if (xy.every((word) => word === 0) || zw.every((word) => word === 0))
      return invalid(`capture:zero:${slot}`);
    if (xy[2] === POISON_IDENTITY_WORD || zw[2] === POISON_IDENTITY_WORD)
      return invalid(`capture:poison:${slot}`);
    if (xy[3] !== captureTag || zw[2] !== rowIndex || zw[3] !== rowIndex)
      return invalid(`capture:stale:${slot}`);
    if (xy[2] !== slot)
      return invalid(`capture:${xy[2] < expectedCount ? 'swapped' : 'identity'}:${slot}`);
    if (zw[0] !== CLIP_Z_WORD || zw[1] !== CLIP_W_WORD) return invalid(`capture:clip-zw:${slot}`);
    clipWords.push([xy[0], xy[1]]);
  }
  return { status: 'CAPTURED', clipWords };
}
