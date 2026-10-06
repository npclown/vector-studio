import { roundExact64 } from '../mesh-projection/audit.js';
import type { ProjectionInput } from '../mesh-projection/model.js';
import { verifyConformingRefinement } from '../conforming-mesh/oracle.js';
import {
  add,
  bitsOf,
  compare,
  div,
  exactInteger,
  mul,
  rational,
  sign,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';

/**
 * P3.1l L03 classifier: a pure function of the original input and captured clip x/y words.
 * Every float is decoded from its bits into an unscaled exact rational; the K candidate graph and
 * K audit are never consulted.
 */

export type NativeProjectionStatus =
  'CERTIFIED' | 'TOPOLOGY_REJECTED' | 'POSITION_LIMIT' | 'NUMERIC_UNRESOLVED';

export type NativeProjectionClassification = Readonly<{
  status: NativeProjectionStatus;
  positionPass: boolean | null;
  topologyPass: boolean | null;
  maxSquared: Readonly<{ n: string; d: string }> | null;
  worstVertex: number | null;
  reason: string | null;
}>;

type QPoint = readonly [Rational, Rational];

const ONE = rational(1n);
const TWO = rational(2n);
const LIMIT_SQUARED = rational(1n, 256n);
const MAX_SIZE = 16_384;

/** Unscaled exact value of a finite binary64 number. */
function q64(value: number): Rational {
  return rational(exactInteger(bitsOf(value)), 1n << 1074n);
}

/** Unscaled exact value of a finite binary32 word; null for exponent 0xFF. */
function q32(word: number): Rational | null {
  const exponent = (word >>> 23) & 0xff;
  if (exponent === 0xff) return null;
  const fraction = BigInt(word & 0x7fffff);
  const magnitude = exponent === 0 ? fraction : (fraction | 0x800000n) << BigInt(exponent - 1);
  return rational(word >>> 31 === 1 ? -magnitude : magnitude, 1n << 149n);
}

function inputFailure(reason: string): never {
  throw new Error(`input:${reason}`);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateInput(input: ProjectionInput): void {
  const vertices: unknown = input.mesh?.vertices;
  const indices: unknown = input.mesh?.indices;
  if (!Array.isArray(vertices) || vertices.length < 1 || vertices.length > 256)
    inputFailure('vertex-count');
  for (let index = 0; index < vertices.length; index += 1) {
    const point: unknown = vertices[index];
    if (
      !Object.hasOwn(vertices, index) ||
      !Array.isArray(point) ||
      point.length !== 2 ||
      !finiteNumber(point[0]) ||
      !finiteNumber(point[1])
    )
      inputFailure(`vertex:${index}`);
  }
  if (
    !Array.isArray(indices) ||
    indices.length === 0 ||
    indices.length % 3 !== 0 ||
    indices.length / 3 > 256
  )
    inputFailure('index-count');
  for (let index = 0; index < indices.length; index += 1) {
    const value: unknown = indices[index];
    if (
      !Object.hasOwn(indices, index) ||
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value >= vertices.length
    )
      inputFailure(`index:${index}`);
  }
  const affine: unknown = input.affine;
  if (!Array.isArray(affine) || affine.length !== 6 || !affine.every(finiteNumber))
    inputFailure('affine');
  for (const [name, pair] of [
    ['camera', input.camera],
    ['origin', input.origin],
  ] as const)
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(finiteNumber)) inputFailure(name);
  if (!finiteNumber(input.zoom) || input.zoom <= 0) inputFailure('zoom');
  if (!finiteNumber(input.dpr) || input.dpr <= 0) inputFailure('dpr');
  for (const [name, size] of [
    ['width', input.width],
    ['height', input.height],
  ] as const)
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SIZE) inputFailure(name);
  try {
    verifyConformingRefinement(input.mesh, {
      ...input.mesh,
      parentTriangle: Array.from({ length: indices.length / 3 }, (_, index) => index),
    });
  } catch (error) {
    throw new Error(`input:${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function unresolved(reason: string): NativeProjectionClassification {
  return {
    status: 'NUMERIC_UNRESOLVED',
    positionPass: null,
    topologyPass: null,
    maxSquared: null,
    worstVertex: null,
    reason,
  };
}

function orient(a: QPoint, b: QPoint, c: QPoint): Rational {
  return sub(mul(sub(b[0], a[0]), sub(c[1], a[1])), mul(sub(b[1], a[1]), sub(c[0], a[0])));
}

export function classifyNativeProjection(
  input: ProjectionInput,
  clipWords: readonly (readonly [number, number])[],
): NativeProjectionClassification {
  validateInput(input);
  const vertexCount = input.mesh.vertices.length;
  const supplied: unknown = clipWords;
  if (
    !Array.isArray(supplied) ||
    supplied.length !== vertexCount ||
    !supplied.every(
      (pair: unknown) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((word) => Number.isSafeInteger(word) && word >= 0 && word <= 0xffffffff),
    )
  )
    throw new Error('capture:clip-words');

  const ndc: QPoint[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const decoded = [q32(clipWords[vertex]![0]), q32(clipWords[vertex]![1])] as const;
    for (const axis of [0, 1] as const)
      if (decoded[axis] === null) return unresolved(`nonfinite-clip:${vertex}:${axis}`);
    ndc.push(decoded as QPoint);
  }

  const width = rational(BigInt(input.width));
  const height = rational(BigInt(input.height));
  const recovered: QPoint[] = [];
  const recovered64: (readonly [number, number])[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const [nx, ny] = ndc[vertex]!;
    const point: QPoint = [div(mul(add(nx, ONE), width), TWO), div(mul(sub(ONE, ny), height), TWO)];
    const point64: number[] = [];
    for (const axis of [0, 1] as const) {
      const rounded = roundExact64(point[axis]);
      if (!Number.isFinite(rounded) || compare(q64(rounded), point[axis]) !== 0)
        return unresolved(`viewport-not-exact:${vertex}:${axis}`);
      point64.push(rounded);
    }
    recovered.push(point);
    recovered64.push([point64[0]!, point64[1]!]);
  }

  const [a, b, c, d, e, f] = input.affine.map(q64) as [
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  const determinant = sign(sub(mul(a, d), mul(b, c)));
  if (determinant === 0) return unresolved('singular-affine');

  const camera = input.camera.map(q64) as [Rational, Rational];
  const scale = mul(q64(input.zoom), q64(input.dpr));
  const referenced = [...new Set(input.mesh.indices)].sort((left, right) => left - right);
  let maxSquared = rational(0n);
  let worstVertex = referenced[0]!;
  for (const vertex of referenced) {
    const [x, y] = input.mesh.vertices[vertex]!.map(q64) as [Rational, Rational];
    const reference: QPoint = [
      mul(sub(add(add(mul(a, x), mul(c, y)), e), camera[0]), scale),
      mul(sub(add(add(mul(b, x), mul(d, y)), f), camera[1]), scale),
    ];
    const dx = sub(recovered[vertex]![0], reference[0]);
    const dy = sub(recovered[vertex]![1], reference[1]);
    const squared = add(mul(dx, dx), mul(dy, dy));
    if (compare(squared, maxSquared) > 0) {
      maxSquared = squared;
      worstVertex = vertex;
    }
  }
  const positionPass = compare(maxSquared, LIMIT_SQUARED) <= 0;

  const indices = input.mesh.indices;
  let topologyReason: string | null = null;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const orientation = sign(
      orient(
        recovered[indices[offset]!]!,
        recovered[indices[offset + 1]!]!,
        recovered[indices[offset + 2]!]!,
      ),
    );
    if (orientation !== determinant) {
      topologyReason = `orientation:${offset / 3}`;
      break;
    }
  }
  if (topologyReason === null) {
    const normalized: number[] = [];
    for (let offset = 0; offset < indices.length; offset += 3) {
      const [i, j, k] = [indices[offset]!, indices[offset + 1]!, indices[offset + 2]!];
      normalized.push(...(determinant > 0 ? [i, j, k] : [i, k, j]));
    }
    try {
      verifyConformingRefinement(
        { vertices: recovered64, indices: normalized },
        {
          vertices: recovered64,
          indices: normalized,
          parentTriangle: Array.from({ length: normalized.length / 3 }, (_, index) => index),
        },
      );
    } catch (error) {
      topologyReason = error instanceof Error ? error.message : String(error);
    }
  }
  const topologyPass = topologyReason === null;
  const proof = {
    positionPass,
    topologyPass,
    maxSquared: { n: maxSquared.n.toString(), d: maxSquared.d.toString() },
    worstVertex,
  };
  if (!topologyPass)
    return { status: 'TOPOLOGY_REJECTED', ...proof, reason: `topology:${topologyReason}` };
  if (!positionPass) return { status: 'POSITION_LIMIT', ...proof, reason: 'position-limit' };
  return { status: 'CERTIFIED', ...proof, reason: null };
}
