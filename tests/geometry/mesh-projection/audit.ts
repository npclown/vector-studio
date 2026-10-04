import { verifyConformingRefinement } from '../conforming-mesh/oracle.js';
import {
  add,
  compare,
  div,
  fromBits,
  mul,
  rational,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';
import {
  type ProjectionInput,
  type ProjectionObservation,
  type ProjectionPoint,
  type ProjectionStage,
} from './model.js';

export type ProjectionAuditStatus =
  'CERTIFIED' | 'TOPOLOGY_REJECTED' | 'POSITION_LIMIT' | 'NUMERIC_UNRESOLVED';

export type ProjectionAudit = Readonly<{
  status: ProjectionAuditStatus;
  positionPass: boolean | null;
  topologyPass: boolean | null;
  maxSquared: Readonly<{ n: string; d: string }> | null;
  worstVertex: number | null;
  reason: string | null;
}>;

type QPoint = readonly [Rational, Rational];
const UNIT64 = 1n << 1074n;
const ZERO = rational(0n);
const ONE = rational(1n);
const TWO = rational(2n);
const LIMIT_SQUARED = rational(1n, 256n);
const f32View = new DataView(new ArrayBuffer(4));
const f64View = new DataView(new ArrayBuffer(8));

class RoundedNonfinite extends Error {}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

function comparePow2(n: bigint, d: bigint, exponent: number): number {
  const left = exponent >= 0 ? n : n << BigInt(-exponent);
  const right = exponent >= 0 ? d << BigInt(exponent) : d;
  return left < right ? -1 : left > right ? 1 : 0;
}

function roundedScaled(n: bigint, d: bigint, shift: number): bigint {
  const numerator = shift >= 0 ? n << BigInt(shift) : n;
  const denominator = shift >= 0 ? d : d << BigInt(-shift);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n !== 0n)) quotient += 1n;
  return quotient;
}

function roundBits(
  value: Rational,
  precision: number,
  minExponent: number,
  maxExponent: number,
): {
  negative: boolean;
  exponentField: bigint;
  fraction: bigint;
  infinity: boolean;
} {
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n;
  if (n === 0n) return { negative: false, exponentField: 0n, fraction: 0n, infinity: false };
  let exponent = bitLength(n) - bitLength(value.d);
  if (comparePow2(n, value.d, exponent) < 0) exponent -= 1;
  const hidden = 1n << BigInt(precision - 1);
  if (exponent < minExponent) {
    const fraction = roundedScaled(n, value.d, precision - 1 - minExponent);
    if (fraction === 0n) return { negative, exponentField: 0n, fraction: 0n, infinity: false };
    if (fraction >= hidden) return { negative, exponentField: 1n, fraction: 0n, infinity: false };
    return { negative, exponentField: 0n, fraction, infinity: false };
  }
  let significand = roundedScaled(n, value.d, precision - 1 - exponent);
  if (significand === hidden * 2n) {
    significand = hidden;
    exponent += 1;
  }
  if (exponent > maxExponent) return { negative, exponentField: 0n, fraction: 0n, infinity: true };
  return {
    negative,
    exponentField: BigInt(exponent - minExponent + 1),
    fraction: significand - hidden,
    infinity: false,
  };
}

export function roundExact32(value: Rational): number {
  const rounded = roundBits(value, 24, -126, 127);
  const bits =
    (rounded.negative ? 0x80000000 : 0) |
    (rounded.infinity
      ? 0x7f800000
      : Number(rounded.exponentField << 23n) | Number(rounded.fraction));
  f32View.setUint32(0, bits >>> 0, false);
  return f32View.getFloat32(0, false);
}

export function roundExact64(value: Rational): number {
  const rounded = roundBits(value, 53, -1022, 1023);
  const bits =
    (rounded.negative ? 0x8000000000000000n : 0n) |
    (rounded.infinity ? 0x7ff0000000000000n : (rounded.exponentField << 52n) | rounded.fraction);
  return fromBits(bits);
}

function q(value: number): Rational {
  f64View.setFloat64(0, value, false);
  const bits = f64View.getBigUint64(0, false);
  const sign = bits >> 63n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  if (exponent === 0x7ff) throw new Error('provenance:nonfinite-rational');
  const fraction = bits & 0x000fffffffffffffn;
  const magnitude =
    exponent === 0 ? fraction : (0x0010000000000000n | fraction) << BigInt(exponent - 1);
  return rational(sign === 1n && magnitude !== 0n ? -magnitude : magnitude, UNIT64);
}

function r64(value: Rational): Rational {
  const rounded = roundExact64(value);
  if (!Number.isFinite(rounded)) throw new RoundedNonfinite();
  return q(rounded);
}

function r32(value: Rational): Rational {
  const rounded = roundExact32(value);
  if (!Number.isFinite(rounded)) throw new RoundedNonfinite();
  return q(rounded);
}

function js32Binary(left: Rational, right: Rational, operation: 'add' | 'mul' | 'div'): Rational {
  const exact =
    operation === 'add'
      ? add(left, right)
      : operation === 'mul'
        ? mul(left, right)
        : div(left, right);
  return r32(r64(exact));
}

function sameNumber(left: number, right: number): boolean {
  return left === right || (left === 0 && right === 0);
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'number' && typeof expected === 'number')
    return sameNumber(actual, expected);
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index += 1)
      if (
        !Object.hasOwn(actual, index) ||
        !Object.hasOwn(expected, index) ||
        !sameValue(actual[index], expected[index])
      )
        return false;
    return true;
  }
  return actual === expected;
}

function provenance(field: string): never {
  throw new Error(`provenance:${field}`);
}

function unresolved(reason: string): ProjectionAudit {
  return {
    status: 'NUMERIC_UNRESOLVED',
    positionPass: null,
    topologyPass: null,
    maxSquared: null,
    worstVertex: null,
    reason,
  };
}

function validateAuditInput(input: ProjectionInput): void {
  const vertices = input.mesh?.vertices;
  const indices = input.mesh?.indices;
  if (
    typeof input.id !== 'string' ||
    !Array.isArray(vertices) ||
    !Array.isArray(indices) ||
    vertices.length === 0 ||
    vertices.length > 256 ||
    indices.length === 0 ||
    indices.length % 3 !== 0 ||
    indices.length / 3 > 256 ||
    !Array.isArray(input.affine) ||
    input.affine.length !== 6 ||
    !Array.isArray(input.camera) ||
    input.camera.length !== 2 ||
    !Array.isArray(input.origin) ||
    input.origin.length !== 2
  )
    throw new Error('input:projection-shape');
  const scalars = [...input.affine, ...input.camera, ...input.origin, input.zoom, input.dpr];
  if (scalars.some((value) => typeof value !== 'number' || !Number.isFinite(value)))
    throw new Error('input:nonfinite-projection');
  if (input.zoom <= 0 || input.dpr <= 0) throw new Error('input:nonpositive-scale');
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0 ||
    input.width > 16_384 ||
    input.height > 16_384
  )
    throw new Error('input:frame-size');
}

function expectedGraphUnchecked(
  input: ProjectionInput,
  progress: { stage: ProjectionStage },
): ProjectionObservation {
  // This implementation is independent of the candidate arithmetic: every operation is replayed as exact
  // rational arithmetic followed by the declared RNE64/RNE32 conversions.
  const vertices = input.mesh.vertices.map(([x, y]): QPoint => [q(x), q(y)]);
  const xs = input.mesh.vertices.map(([x]) => x);
  const ys = input.mesh.vertices.map(([, y]) => y);
  const half = q(0.5);
  const midpointQ: QPoint = [
    r64(add(r64(mul(q(Math.min(...xs)), half)), r64(mul(q(Math.max(...xs)), half)))),
    r64(add(r64(mul(q(Math.min(...ys)), half)), r64(mul(q(Math.max(...ys)), half)))),
  ];
  const midpoint: ProjectionPoint = [roundExact64(midpointQ[0]), roundExact64(midpointQ[1])];
  if (!midpoint.every(Number.isFinite)) return { ok: false, stage: 'MIDPOINT' };
  progress.stage = 'LOCAL_OFFSET';
  const localQ = vertices.map(([x, y]): QPoint => [
    r32(r64(sub(x, midpointQ[0]))),
    r32(r64(sub(y, midpointQ[1]))),
  ]);
  const localOffsets = localQ.map(([x, y]): ProjectionPoint => [roundExact64(x), roundExact64(y)]);
  if (!localOffsets.every((point) => point.every(Number.isFinite)))
    return { ok: false, stage: 'LOCAL_OFFSET' };
  progress.stage = 'LINEAR';
  const linearQ = input.affine.slice(0, 4).map((value) => r32(q(value)));
  const linear = linearQ.map(roundExact64) as [number, number, number, number];
  if (!linear.every(Number.isFinite)) return { ok: false, stage: 'LINEAR' };
  const [a, b, c, d, e, f] = input.affine.map(q);
  progress.stage = 'ANCHOR';
  const anchor64 = (x0: Rational, x1: Rational, translation: Rational, origin: number) =>
    r64(
      sub(
        r64(add(r64(add(r64(mul(x0, midpointQ[0])), r64(mul(x1, midpointQ[1])))), translation)),
        q(origin),
      ),
    );
  const anchorQ: QPoint = [
    r32(anchor64(a!, c!, e!, input.origin[0])),
    r32(anchor64(b!, d!, f!, input.origin[1])),
  ];
  const anchor: ProjectionPoint = [roundExact64(anchorQ[0]), roundExact64(anchorQ[1])];
  if (!anchor.every(Number.isFinite)) return { ok: false, stage: 'ANCHOR' };
  progress.stage = 'FRAME_OFFSET';
  const offsetQ: QPoint = [
    r32(r64(sub(q(input.origin[0]), q(input.camera[0])))),
    r32(r64(sub(q(input.origin[1]), q(input.camera[1])))),
  ];
  const offset: ProjectionPoint = [roundExact64(offsetQ[0]), roundExact64(offsetQ[1])];
  if (!offset.every(Number.isFinite)) return { ok: false, stage: 'FRAME_OFFSET' };
  progress.stage = 'SCALE';
  const scaleQ = [r32(q(input.zoom)), r32(q(input.dpr))] as const;
  const scale = scaleQ.map(roundExact64) as [number, number];
  if (!scale.every(Number.isFinite) || scale[0] === 0 || scale[1] === 0)
    return { ok: false, stage: 'SCALE' };
  progress.stage = 'SIZE';
  const sizeQ = [r32(q(input.width)), r32(q(input.height))] as const;
  const size = sizeQ.map(roundExact64) as [number, number];
  if (!size.every(Number.isFinite)) return { ok: false, stage: 'SIZE' };

  progress.stage = 'VERTEX_PHYSICAL';
  const physicalQ: QPoint[] = [];
  for (const [x, y] of localQ) {
    const axis = (i0: number, i1: number, packedAnchor: Rational, packedOffset: Rational) => {
      const first = js32Binary(linearQ[i0]!, x, 'mul');
      const second = js32Binary(linearQ[i1]!, y, 'mul');
      const s = js32Binary(js32Binary(first, second, 'add'), packedAnchor, 'add');
      const r = js32Binary(s, packedOffset, 'add');
      return js32Binary(js32Binary(r, scaleQ[0], 'mul'), scaleQ[1], 'mul');
    };
    const point: QPoint = [axis(0, 2, anchorQ[0], offsetQ[0]), axis(1, 3, anchorQ[1], offsetQ[1])];
    if (point.some((value) => !Number.isFinite(roundExact64(value))))
      return { ok: false, stage: 'VERTEX_PHYSICAL' };
    physicalQ.push(point);
  }
  const physical = physicalQ.map(([x, y]): ProjectionPoint => [roundExact64(x), roundExact64(y)]);
  progress.stage = 'VERTEX_NDC';
  const ndcQ: QPoint[] = [];
  for (const [x, y] of physicalQ) {
    const correctedX = r32(r64(sub(js32Binary(js32Binary(x, TWO, 'mul'), sizeQ[0], 'div'), ONE)));
    const yRatio = js32Binary(js32Binary(y, TWO, 'mul'), sizeQ[1], 'div');
    const ny = r32(r64(sub(ONE, yRatio)));
    if (![correctedX, ny].every((value) => Number.isFinite(roundExact64(value))))
      return { ok: false, stage: 'VERTEX_NDC' };
    ndcQ.push([correctedX, ny]);
  }
  const ndc = ndcQ.map(([x, y]): ProjectionPoint => [roundExact64(x), roundExact64(y)]);
  progress.stage = 'VIEWPORT_RECOVERY';
  const recovered: ProjectionPoint[] = [];
  for (const [x, y] of ndcQ) {
    const rx = r64(div(r64(mul(r64(add(x, ONE)), q(input.width))), TWO));
    const ry = r64(div(r64(mul(r64(sub(ONE, y)), q(input.height))), TWO));
    const point: ProjectionPoint = [roundExact64(rx), roundExact64(ry)];
    if (!point.every(Number.isFinite)) return { ok: false, stage: 'VIEWPORT_RECOVERY' };
    recovered.push(point);
  }
  return {
    ok: true,
    midpoint,
    localOffsets,
    linear,
    anchor,
    offset,
    scale,
    size,
    physical,
    ndc,
    recovered,
  };
}

function expectedGraph(input: ProjectionInput): ProjectionObservation {
  const progress: { stage: ProjectionStage } = { stage: 'MIDPOINT' };
  try {
    return expectedGraphUnchecked(input, progress);
  } catch (error) {
    if (error instanceof RoundedNonfinite) return { ok: false, stage: progress.stage };
    throw error;
  }
}

function orient(a: QPoint, b: QPoint, c: QPoint): Rational {
  return sub(mul(sub(b[0], a[0]), sub(c[1], a[1])), mul(sub(b[1], a[1]), sub(c[0], a[0])));
}

export function auditMeshProjection(
  input: ProjectionInput,
  observation: ProjectionObservation,
): ProjectionAudit {
  validateAuditInput(input);
  try {
    const parents = Array.from({ length: input.mesh.indices.length / 3 }, (_, index) => index);
    verifyConformingRefinement(input.mesh, { ...input.mesh, parentTriangle: parents });
  } catch (error) {
    throw new Error(`input:${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const expected = expectedGraph(input);
  if (expected.ok !== observation.ok) provenance(observation.ok ? 'success' : observation.stage);
  if (!expected.ok) {
    if (observation.ok || observation.stage !== expected.stage)
      provenance(observation.ok ? 'success' : observation.stage);
    return unresolved(`candidate:${expected.stage}`);
  }
  if (!observation.ok) provenance(observation.stage);
  for (const field of [
    'midpoint',
    'localOffsets',
    'linear',
    'anchor',
    'offset',
    'scale',
    'size',
    'physical',
    'ndc',
    'recovered',
  ] as const)
    if (!sameValue(observation[field], expected[field])) provenance(field);

  const ndcQ = observation.ndc.map(([x, y]): QPoint => [q(x), q(y)]);
  for (let vertex = 0; vertex < ndcQ.length; vertex += 1) {
    const exact: QPoint = [
      div(mul(add(ndcQ[vertex]![0], ONE), q(input.width)), TWO),
      div(mul(sub(ONE, ndcQ[vertex]![1]), q(input.height)), TWO),
    ];
    for (const axis of [0, 1] as const)
      if (compare(q(observation.recovered[vertex]![axis]), exact[axis]) !== 0)
        return unresolved(`viewport-not-exact:${vertex}:${axis}`);
  }
  const affineQ = input.affine.map(q);
  const determinant = sub(mul(affineQ[0]!, affineQ[3]!), mul(affineQ[1]!, affineQ[2]!));
  if (determinant.n === 0n) return unresolved('singular-affine');

  const referenced = [...new Set(input.mesh.indices)].sort((a, b) => a - b);
  let maxSquared = ZERO;
  let worstVertex = referenced[0]!;
  for (const vertex of referenced) {
    const [x, y] = input.mesh.vertices[vertex]!.map(q) as [Rational, Rational];
    const reference: QPoint = [
      mul(
        mul(
          sub(add(add(mul(affineQ[0]!, x), mul(affineQ[2]!, y)), affineQ[4]!), q(input.camera[0])),
          q(input.zoom),
        ),
        q(input.dpr),
      ),
      mul(
        mul(
          sub(add(add(mul(affineQ[1]!, x), mul(affineQ[3]!, y)), affineQ[5]!), q(input.camera[1])),
          q(input.zoom),
        ),
        q(input.dpr),
      ),
    ];
    const actual: QPoint = [
      q(observation.recovered[vertex]![0]),
      q(observation.recovered[vertex]![1]),
    ];
    const dx = sub(actual[0], reference[0]);
    const dy = sub(actual[1], reference[1]);
    const squared = add(mul(dx, dx), mul(dy, dy));
    if (compare(squared, maxSquared) > 0) {
      maxSquared = squared;
      worstVertex = vertex;
    }
  }
  const positionPass = compare(maxSquared, LIMIT_SQUARED) <= 0;
  let topologyPass = true;
  let topologyReason: string | null = null;
  const recoveredQ = observation.recovered.map(([x, y]): QPoint => [q(x), q(y)]);
  const detPositive = determinant.n > 0n;
  for (let offset = 0; offset < input.mesh.indices.length; offset += 3) {
    const sign = orient(
      recoveredQ[input.mesh.indices[offset]!]!,
      recoveredQ[input.mesh.indices[offset + 1]!]!,
      recoveredQ[input.mesh.indices[offset + 2]!]!,
    ).n;
    if ((detPositive && sign <= 0n) || (!detPositive && sign >= 0n)) {
      topologyPass = false;
      topologyReason = `orientation:${offset / 3}`;
      break;
    }
  }
  if (topologyPass) {
    const normalized: number[] = [];
    for (let offset = 0; offset < input.mesh.indices.length; offset += 3) {
      const [a, b, c] = input.mesh.indices.slice(offset, offset + 3);
      normalized.push(a!, ...(detPositive ? [b!, c!] : [c!, b!]));
    }
    try {
      verifyConformingRefinement(
        { vertices: observation.recovered, indices: normalized },
        {
          vertices: observation.recovered,
          indices: normalized,
          parentTriangle: Array.from({ length: normalized.length / 3 }, (_, index) => index),
        },
      );
    } catch (error) {
      topologyPass = false;
      topologyReason = error instanceof Error ? error.message : String(error);
    }
  }
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
