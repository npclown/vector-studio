import type { ProjectionInput } from '../mesh-projection/model.js';

/**
 * P3.1l L01 candidate packer. It evaluates only K's frozen CPU stages with JavaScript
 * binary64 and Math.fround, then writes the literal RowRecord/VertexRecord bytes.
 * The independent byte auditor owns provenance; this module never checks itself.
 */

export type NativePackStage =
  'INPUT' | 'MIDPOINT' | 'LOCAL_OFFSET' | 'LINEAR' | 'ANCHOR' | 'FRAME_OFFSET' | 'SCALE' | 'SIZE';

export type NativePackResult =
  | Readonly<{ status: 'PACKED'; uniform: Uint8Array; vertices: Uint8Array }>
  | Readonly<{ status: 'PACK_UNRESOLVED'; stage: NativePackStage }>;

export const ROW_RECORD_BYTES = 64;
export const VERTEX_RECORD_BYTES = 16;
export const VERTEX_SLOTS = 256;
export const VERTEX_ARRAY_BYTES = VERTEX_RECORD_BYTES * VERTEX_SLOTS;
export const CORPUS_CAPTURE_TAG_BASE = 0x70000000;
export const CONTROL_CAPTURE_TAG = 0x7f000000;
export const POISON_FLOAT_WORD = 0x7fc00000;
export const POISON_INTEGER_WORD = 0xfffffffe;

const f = Math.fround;

function unresolved(stage: NativePackStage): NativePackResult {
  return { status: 'PACK_UNRESOLVED', stage };
}

function finite(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function checkedOffset(slot: number, fieldOffset: number): number {
  const offset = VERTEX_RECORD_BYTES * slot + fieldOffset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > VERTEX_ARRAY_BYTES) {
    throw new RangeError(`vertex offset out of range: ${slot}:${fieldOffset}`);
  }
  return offset;
}

function validInput(input: ProjectionInput, rowIndex: number, captureTag: number): boolean {
  const { vertices, indices } = input.mesh;
  if (
    !Number.isSafeInteger(rowIndex) ||
    rowIndex < 0 ||
    rowIndex > 0xffffffff ||
    !Number.isSafeInteger(captureTag) ||
    captureTag < 0 ||
    captureTag >= 0xffffff00 ||
    !Array.isArray(vertices) ||
    !Array.isArray(indices) ||
    vertices.length === 0 ||
    vertices.length > VERTEX_SLOTS ||
    indices.length === 0 ||
    indices.length % 3 !== 0 ||
    indices.length / 3 > 256 ||
    !Array.isArray(input.affine) ||
    input.affine.length !== 6 ||
    !Array.isArray(input.camera) ||
    input.camera.length !== 2 ||
    !Array.isArray(input.origin) ||
    input.origin.length !== 2 ||
    !finite([...input.affine, ...input.camera, ...input.origin, input.zoom, input.dpr]) ||
    input.zoom <= 0 ||
    input.dpr <= 0 ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    input.width > 16_384 ||
    input.height > 16_384
  )
    return false;
  for (let index = 0; index < vertices.length; index += 1) {
    const point: unknown = vertices[index];
    if (
      !Object.hasOwn(vertices, index) ||
      !Array.isArray(point) ||
      point.length !== 2 ||
      typeof point[0] !== 'number' ||
      typeof point[1] !== 'number' ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1])
    )
      return false;
  }
  for (let index = 0; index < indices.length; index += 1) {
    const value: unknown = indices[index];
    if (
      !Object.hasOwn(indices, index) ||
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value >= vertices.length
    )
      return false;
  }
  return true;
}

export function packNativeProjectionRow(
  input: ProjectionInput,
  rowIndex: number,
  captureTag: number,
): NativePackResult {
  if (!validInput(input, rowIndex, captureTag)) return unresolved('INPUT');
  const vertices = input.mesh.vertices;
  const xs = vertices.map((point) => point[0]);
  const ys = vertices.map((point) => point[1]);
  const midpoint = [
    Math.min(...xs) / 2 + Math.max(...xs) / 2,
    Math.min(...ys) / 2 + Math.max(...ys) / 2,
  ] as const;
  if (!finite(midpoint)) return unresolved('MIDPOINT');

  const localOffsets = vertices.map(([x, y]) => [f(x - midpoint[0]), f(y - midpoint[1])] as const);
  if (!localOffsets.every(finite)) return unresolved('LOCAL_OFFSET');

  const linear = input.affine.slice(0, 4).map(f);
  if (!finite(linear)) return unresolved('LINEAR');
  const [a, b, c, d, e, g] = input.affine;
  const anchor = [
    f(a * midpoint[0] + c * midpoint[1] + e - input.origin[0]),
    f(b * midpoint[0] + d * midpoint[1] + g - input.origin[1]),
  ];
  if (!finite(anchor)) return unresolved('ANCHOR');
  const offset = [f(input.origin[0] - input.camera[0]), f(input.origin[1] - input.camera[1])];
  if (!finite(offset)) return unresolved('FRAME_OFFSET');
  const scale = [f(input.zoom), f(input.dpr)];
  if (!finite(scale) || scale[0] === 0 || scale[1] === 0) return unresolved('SCALE');
  const size = [f(input.width), f(input.height)];
  if (!finite(size)) return unresolved('SIZE');

  const uniform = new Uint8Array(ROW_RECORD_BYTES);
  const row = new DataView(uniform.buffer);
  [...linear, ...anchor, ...offset, ...scale, ...size].forEach((value, lane) => {
    row.setFloat32(lane * 4, value, true);
  });
  row.setUint32(48, rowIndex, true);
  row.setUint32(52, captureTag, true);
  row.setUint32(56, 0, true);
  row.setUint32(60, 0, true);

  const vertexBytes = new Uint8Array(VERTEX_ARRAY_BYTES);
  const vertexView = new DataView(vertexBytes.buffer);
  for (let slot = 0; slot < VERTEX_SLOTS; slot += 1) {
    const local = localOffsets[slot];
    if (local === undefined) {
      vertexView.setUint32(checkedOffset(slot, 0), POISON_FLOAT_WORD, true);
      vertexView.setUint32(checkedOffset(slot, 4), POISON_FLOAT_WORD, true);
      vertexView.setUint32(checkedOffset(slot, 8), POISON_INTEGER_WORD, true);
      vertexView.setUint32(checkedOffset(slot, 12), POISON_INTEGER_WORD, true);
    } else {
      vertexView.setFloat32(checkedOffset(slot, 0), local[0], true);
      vertexView.setFloat32(checkedOffset(slot, 4), local[1], true);
      vertexView.setUint32(checkedOffset(slot, 8), rowIndex, true);
      vertexView.setUint32(checkedOffset(slot, 12), slot, true);
    }
  }
  return { status: 'PACKED', uniform, vertices: vertexBytes };
}
