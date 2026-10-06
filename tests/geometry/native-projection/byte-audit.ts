import { roundExact32, roundExact64 } from '../mesh-projection/audit.js';
import type { ProjectionInput } from '../mesh-projection/model.js';
import {
  add,
  bitsOf,
  compare,
  exactInteger,
  fromBits,
  mul,
  rational,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';

/**
 * P3.1l L01 independent byte auditor. It never imports the packer: every float lane is replayed
 * from the original binary64 input bits as exact rational arithmetic followed by the declared
 * RNE64-then-RNE32 conversions, then compared with the little-endian packed words and with the
 * archived K CPU lanes bit-for-bit.
 */

export type ArchivedCandidate = Readonly<{
  localOffsets: readonly (readonly [string, string])[];
  linear: readonly string[];
  anchor: readonly string[];
  offset: readonly string[];
  scale: readonly string[];
  size: readonly string[];
}>;

export type ArchivedInput = Readonly<{
  id: string;
  mesh: Readonly<{ vertices: readonly (readonly [string, string])[]; indices: readonly number[] }>;
  affine: readonly string[];
  camera: readonly string[];
  origin: readonly string[];
  zoom: string;
  dpr: string;
  width: number;
  height: number;
}>;

export type ArchivedInputFixture = Readonly<{ id: string; input: ProjectionInput }>;

const UNIFORM_BYTES = 64;
const VERTEX_SLOT_BYTES = 16;
const VERTEX_SLOTS = 256;
const VERTEX_BYTES = VERTEX_SLOT_BYTES * VERTEX_SLOTS;
const POISON_LOCAL = 0x7fc00000;
const POISON_INTEGER = 0xfffffffe;
const HALF = rational(1n, 2n);
const f32View = new DataView(new ArrayBuffer(4));

class Unresolved extends Error {}

function fail(field: string): never {
  throw new Error(`provenance:pack:${field}`);
}

function q64(value: number): Rational {
  return rational(exactInteger(bitsOf(value)), 1n << 1074n);
}

function word32(word: number): Rational | null {
  const exponent = (word >>> 23) & 0xff;
  if (exponent === 0xff) return null;
  const fraction = BigInt(word & 0x7fffff);
  const magnitude = exponent === 0 ? fraction : (fraction | 0x800000n) << BigInt(exponent - 1);
  return rational(word >>> 31 === 1 ? -magnitude : magnitude, 1n << 149n);
}

function r64(value: Rational): Rational {
  const rounded = roundExact64(value);
  if (!Number.isFinite(rounded)) throw new Unresolved();
  return q64(rounded);
}

function r32(value: Rational): Rational {
  const rounded = roundExact32(value);
  if (!Number.isFinite(rounded)) throw new Unresolved();
  return q64(rounded);
}

function hex64(value: number): string {
  return bitsOf(value).toString(16).padStart(16, '0');
}

/** f32 word of an archived binary64 lane, which must be finite and exactly f32-representable. */
function archivedWord(hex: unknown, field: string): number {
  if (typeof hex !== 'string' || !/^[0-9a-f]{16}$/.test(hex)) fail(field);
  const value = fromBits(BigInt(`0x${hex}`));
  if (!Number.isFinite(value)) fail(field);
  f32View.setFloat32(0, value, true);
  if (!Object.is(f32View.getFloat32(0, true), value)) fail(field);
  return f32View.getUint32(0, true);
}

function validInput(input: ProjectionInput): boolean {
  const { vertices, indices } = input.mesh;
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
  return (
    Array.isArray(vertices) &&
    vertices.length >= 1 &&
    vertices.length <= VERTEX_SLOTS &&
    vertices.every(
      (point, index) =>
        Object.hasOwn(vertices, index) &&
        Array.isArray(point) &&
        point.length === 2 &&
        point.every(finite),
    ) &&
    Array.isArray(indices) &&
    indices.length > 0 &&
    indices.length % 3 === 0 &&
    indices.length / 3 <= 256 &&
    indices.every(
      (value, index) =>
        Object.hasOwn(indices, index) &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value < vertices.length,
    ) &&
    Array.isArray(input.affine) &&
    input.affine.length === 6 &&
    input.affine.every(finite) &&
    [input.camera, input.origin].every(
      (pair) => Array.isArray(pair) && pair.length === 2 && pair.every(finite),
    ) &&
    finite(input.zoom) &&
    finite(input.dpr) &&
    input.zoom > 0 &&
    input.dpr > 0 &&
    [input.width, input.height].every(
      (size) => Number.isSafeInteger(size) && size >= 1 && size <= 16_384,
    )
  );
}

type ExpectedLanes = Readonly<{
  local: readonly (readonly [Rational, Rational])[];
  linear: readonly Rational[];
  anchor: readonly Rational[];
  frameOffset: readonly Rational[];
  scale: readonly Rational[];
  size: readonly Rational[];
}>;

function stage<T>(name: string, evaluate: () => T): T {
  try {
    return evaluate();
  } catch (error) {
    if (error instanceof Unresolved) fail(name);
    throw error;
  }
}

function expectedLanes(input: ProjectionInput): ExpectedLanes {
  if (!validInput(input)) fail('INPUT');
  const vertices = input.mesh.vertices.map(([x, y]) => [q64(x), q64(y)] as const);
  const extreme = (axis: 0 | 1, side: 1 | -1) =>
    vertices
      .map((point) => point[axis])
      .reduce((best, value) => (compare(value, best) * side > 0 ? value : best));
  const midpoint = stage('MIDPOINT', () =>
    ([0, 1] as const).map((axis) =>
      r64(add(r64(mul(extreme(axis, -1), HALF)), r64(mul(extreme(axis, 1), HALF)))),
    ),
  );
  const local = stage('LOCAL_OFFSET', () =>
    vertices.map(
      ([x, y]) => [r32(r64(sub(x, midpoint[0]!))), r32(r64(sub(y, midpoint[1]!)))] as const,
    ),
  );
  const affine = input.affine.map(q64);
  const linear = stage('LINEAR', () => affine.slice(0, 4).map(r32));
  const [ox, oy] = input.origin.map(q64) as [Rational, Rational];
  const [cx, cy] = input.camera.map(q64) as [Rational, Rational];
  const anchorAxis = (x0: Rational, x1: Rational, translation: Rational, origin: Rational) =>
    r32(
      r64(
        sub(
          r64(add(r64(add(r64(mul(x0, midpoint[0]!)), r64(mul(x1, midpoint[1]!)))), translation)),
          origin,
        ),
      ),
    );
  const anchor = stage('ANCHOR', () => [
    anchorAxis(affine[0]!, affine[2]!, affine[4]!, ox),
    anchorAxis(affine[1]!, affine[3]!, affine[5]!, oy),
  ]);
  const frameOffset = stage('FRAME_OFFSET', () => [r32(r64(sub(ox, cx))), r32(r64(sub(oy, cy)))]);
  const scale = stage('SCALE', () => [r32(q64(input.zoom)), r32(q64(input.dpr))]);
  if (scale.some((value) => value.n === 0n)) fail('SCALE');
  const size = stage('SIZE', () => [
    r32(rational(BigInt(input.width))),
    r32(rational(BigInt(input.height))),
  ]);
  return { local, linear, anchor, frameOffset, scale, size };
}

function checkLane(
  view: DataView,
  offset: number,
  expected: Rational,
  archivedHex: unknown,
  field: string,
): void {
  const word = view.getUint32(offset, true);
  const actual = word32(word);
  if (actual === null || compare(actual, expected) !== 0) fail(field);
  if (word !== archivedWord(archivedHex, field)) fail(field);
}

function checkedOffset(slot: number, fieldOffset: number): number {
  const offset = VERTEX_SLOT_BYTES * slot + fieldOffset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > VERTEX_BYTES)
    throw new RangeError(`vertex offset out of range: ${slot}:${fieldOffset}`);
  return offset;
}

export function auditPackedRow(
  input: ProjectionInput,
  rowIndex: number,
  captureTag: number,
  uniform: Uint8Array,
  vertices: Uint8Array,
  archivedCandidate: unknown,
): void {
  const expected = expectedLanes(input);
  if (!(uniform instanceof Uint8Array) || uniform.byteLength !== UNIFORM_BYTES)
    fail('uniform-length');
  if (!(vertices instanceof Uint8Array) || vertices.byteLength !== VERTEX_BYTES)
    fail('vertices-length');
  const vertexCount = input.mesh.vertices.length;
  const archivedField = (name: keyof ArchivedCandidate, field: string): unknown => {
    if (typeof archivedCandidate !== 'object' || archivedCandidate === null) fail(field);
    return (archivedCandidate as Readonly<Record<string, unknown>>)[name];
  };
  const archivedLocal = archivedField('localOffsets', 'local');
  if (!Array.isArray(archivedLocal) || archivedLocal.length !== vertexCount) fail('local');

  const row = new DataView(uniform.buffer, uniform.byteOffset, uniform.byteLength);
  const lanes: readonly (readonly [string, readonly Rational[], unknown])[] = [
    ['linear', expected.linear, archivedField('linear', 'linear')],
    ['anchor', expected.anchor, archivedField('anchor', 'anchor')],
    ['frameOffset', expected.frameOffset, archivedField('offset', 'frameOffset')],
    ['scale', expected.scale, archivedField('scale', 'scale')],
    ['size', expected.size, archivedField('size', 'size')],
  ];
  let offset = 0;
  for (const [field, values, archived] of lanes) {
    if (!Array.isArray(archived) || archived.length !== values.length) fail(field);
    values.forEach((value, lane) =>
      checkLane(row, offset + 4 * lane, value, archived[lane], field),
    );
    offset += 4 * values.length;
  }
  const integers = [
    ['rowIndex', rowIndex],
    ['captureTag', captureTag],
    ['reserved0', 0],
    ['reserved1', 0],
  ] as const;
  integers.forEach(([field, value], index) => {
    if (row.getUint32(48 + 4 * index, true) !== value) fail(field);
  });

  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  for (let slot = 0; slot < VERTEX_SLOTS; slot += 1) {
    if (slot < vertexCount) {
      const archived: unknown = archivedLocal[slot];
      if (!Array.isArray(archived) || archived.length !== 2) fail('local');
      for (const axis of [0, 1] as const)
        checkLane(
          view,
          checkedOffset(slot, 4 * axis),
          expected.local[slot]![axis],
          archived[axis],
          'local',
        );
      if (view.getUint32(checkedOffset(slot, 8), true) !== rowIndex) fail('vertexRowIndex');
      if (view.getUint32(checkedOffset(slot, 12), true) !== slot) fail('vertexIndex');
    } else {
      for (const [field, value, fieldOffset] of [
        ['poisonLocal', POISON_LOCAL, 0],
        ['poisonLocal', POISON_LOCAL, 4],
        ['poisonInteger', POISON_INTEGER, 8],
        ['poisonInteger', POISON_INTEGER, 12],
      ] as const)
        if (view.getUint32(checkedOffset(slot, fieldOffset), true) !== value) fail(field);
    }
  }
}

/** The archived K input object; key order is significant for inputSha256. */
export function encodeArchivedInput(input: ProjectionInput): ArchivedInput {
  return {
    id: input.id,
    mesh: {
      vertices: input.mesh.vertices.map(([x, y]) => [hex64(x), hex64(y)] as const),
      indices: [...input.mesh.indices],
    },
    affine: input.affine.map(hex64),
    camera: input.camera.map(hex64),
    origin: input.origin.map(hex64),
    zoom: hex64(input.zoom),
    dpr: hex64(input.dpr),
    width: input.width,
    height: input.height,
  };
}

/** Lowercase SHA256 of JSON.stringify(encodeArchivedInput(input)), via Web Crypto. */
export async function inputSha256(input: ProjectionInput): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(encodeArchivedInput(input)));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function checkArchivedInputs(
  fixtures: readonly ArchivedInputFixture[],
  archive: Readonly<{ rows: readonly unknown[] }>,
): void {
  const rows = archive.rows.filter(
    (row): row is Readonly<{ kind: 'mesh'; id: unknown; input: unknown }> =>
      typeof row === 'object' && row !== null && (row as { kind?: unknown }).kind === 'mesh',
  );
  if (fixtures.length !== 158 || rows.length !== 158) throw new Error('provenance:archive:count');
  fixtures.forEach((fixture, index) => {
    const row = rows[index]!;
    if (row.id !== fixture.id || fixture.input.id !== fixture.id)
      throw new Error(`provenance:archive:id:${index}`);
    if (JSON.stringify(row.input) !== JSON.stringify(encodeArchivedInput(fixture.input)))
      throw new Error(`provenance:archive:input:${index}`);
  });
}
