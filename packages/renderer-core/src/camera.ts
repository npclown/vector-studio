export type AffineMatrix = readonly [number, number, number, number, number, number];

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface CameraTransformOptions {
  readonly position: Point;
  readonly zoom: number;
  readonly devicePixelRatio: number;
}

export interface CameraTransform {
  readonly documentToCss: AffineMatrix;
  readonly cssToDocument: AffineMatrix;
  readonly cssToPhysical: AffineMatrix;
  readonly physicalToCss: AffineMatrix;
  readonly documentToPhysical: AffineMatrix;
  readonly physicalToDocument: AffineMatrix;
}

function assertFiniteNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${field} must be finite.`);
  }
}

function assertFinitePoint(point: Point, field: string): void {
  if (typeof point !== 'object' || point === null) {
    throw new TypeError(`${field} must be a point.`);
  }

  assertFiniteNumber(point.x, `${field}.x`);
  assertFiniteNumber(point.y, `${field}.y`);
}

function freezeMatrix(
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
): AffineMatrix {
  for (const [index, value] of [a, b, c, d, e, f].entries()) {
    assertFiniteNumber(value, `matrix[${index}]`);
  }

  return Object.freeze(
    [a, b, c, d, e, f].map((value) => (value === 0 ? 0 : value)),
  ) as AffineMatrix;
}

function assertMatrix(matrix: AffineMatrix): void {
  if (!Array.isArray(matrix) || matrix.length !== 6) {
    throw new TypeError('Affine matrix must be a six-value tuple.');
  }

  for (const [index, value] of matrix.entries()) {
    assertFiniteNumber(value, `matrix[${index}]`);
  }
}

interface ScaledNumber {
  readonly significand: number;
  readonly exponent: number;
}

function decompose(value: number): ScaledNumber {
  if (value === 0) {
    return { significand: 0, exponent: 0 };
  }

  let exponent = Math.floor(Math.log2(Math.abs(value)));
  let power = 2 ** exponent;
  if (!Number.isFinite(power) || Math.abs(value) < power) {
    exponent -= 1;
    power = 2 ** exponent;
  }

  return { significand: value / power, exponent };
}

function differenceOfProducts(a: number, b: number, c: number, d: number): ScaledNumber {
  const leftA = decompose(a);
  const leftB = decompose(b);
  const rightA = decompose(c);
  const rightB = decompose(d);
  const leftExponent = leftA.exponent + leftB.exponent;
  const rightExponent = rightA.exponent + rightB.exponent;
  const hasLeft = a !== 0 && b !== 0;
  const hasRight = c !== 0 && d !== 0;
  const exponent = hasLeft
    ? hasRight
      ? Math.max(leftExponent, rightExponent)
      : leftExponent
    : rightExponent;
  const left = hasLeft ? leftA.significand * leftB.significand * 2 ** (leftExponent - exponent) : 0;
  const right = hasRight
    ? rightA.significand * rightB.significand * 2 ** (rightExponent - exponent)
    : 0;

  return { significand: left - right, exponent };
}

function scaleByPowerOfTwo(value: number, exponent: number): number {
  if (value === 0) {
    return 0;
  }

  const decomposed = decompose(value);
  const combinedExponent = decomposed.exponent + exponent;
  if (combinedExponent < -1075 || combinedExponent > 1023) {
    return combinedExponent < 0 ? 0 : Number.POSITIVE_INFINITY;
  }

  if (combinedExponent === -1075) {
    return decomposed.significand * 0.5 * Number.MIN_VALUE;
  }

  return decomposed.significand * 2 ** combinedExponent;
}

function divideByScaled(numerator: number, denominator: ScaledNumber): number {
  if (numerator === 0) {
    return 0;
  }

  const decomposed = decompose(numerator);
  const quotient = scaleByPowerOfTwo(
    decomposed.significand / denominator.significand,
    decomposed.exponent - denominator.exponent,
  );
  if (quotient === 0 || !Number.isFinite(quotient)) {
    throw new RangeError('Affine matrix inverse is not representable.');
  }

  return quotient;
}

/** Multiplies column-vector affine matrices, applying `right` before `left`. */
export function multiplyAffine(left: AffineMatrix, right: AffineMatrix): AffineMatrix {
  assertMatrix(left);
  assertMatrix(right);

  const [la, lb, lc, ld, le, lf] = left;
  const [ra, rb, rc, rd, re, rf] = right;
  return freezeMatrix(
    la * ra + lc * rb,
    lb * ra + ld * rb,
    la * rc + lc * rd,
    lb * rc + ld * rd,
    la * re + lc * rf + le,
    lb * re + ld * rf + lf,
  );
}

export function transformPoint(matrix: AffineMatrix, point: Point): Point {
  assertMatrix(matrix);
  assertFinitePoint(point, 'point');

  const [a, b, c, d, e, f] = matrix;
  const x = a * point.x + c * point.y + e;
  const y = b * point.x + d * point.y + f;
  assertFiniteNumber(x, 'transformed x');
  assertFiniteNumber(y, 'transformed y');
  return Object.freeze({ x, y });
}

export function invertAffine(matrix: AffineMatrix): AffineMatrix {
  assertMatrix(matrix);
  const [a, b, c, d, e, f] = matrix;

  // Keep the two determinant products on their own binary scales. Scaling a
  // whole row or column can erase a representable coefficient before division.
  const determinant = differenceOfProducts(a, d, b, c);
  if (determinant.significand === 0) {
    throw new RangeError('Affine matrix is singular.');
  }

  const inverseA = divideByScaled(d, determinant);
  const inverseB = divideByScaled(-b, determinant);
  const inverseC = divideByScaled(-c, determinant);
  const inverseD = divideByScaled(a, determinant);
  return freezeMatrix(
    inverseA,
    inverseB,
    inverseC,
    inverseD,
    -(inverseA * e + inverseC * f),
    -(inverseB * e + inverseD * f),
  );
}

export function createCameraTransform(options: CameraTransformOptions): CameraTransform {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Camera options must be an object.');
  }

  assertFinitePoint(options.position, 'position');
  assertFiniteNumber(options.zoom, 'zoom');
  assertFiniteNumber(options.devicePixelRatio, 'devicePixelRatio');
  if (options.zoom <= 0 || options.devicePixelRatio <= 0) {
    throw new RangeError('zoom and devicePixelRatio must be strictly positive.');
  }

  const documentToCss = freezeMatrix(
    options.zoom,
    0,
    0,
    options.zoom,
    -options.zoom * options.position.x,
    -options.zoom * options.position.y,
  );
  const cssToDocument = invertAffine(documentToCss);
  const cssToPhysical = freezeMatrix(
    options.devicePixelRatio,
    0,
    0,
    options.devicePixelRatio,
    0,
    0,
  );
  const physicalToCss = invertAffine(cssToPhysical);
  const documentToPhysical = multiplyAffine(cssToPhysical, documentToCss);
  const physicalToDocument = invertAffine(documentToPhysical);

  return Object.freeze({
    documentToCss,
    cssToDocument,
    cssToPhysical,
    physicalToCss,
    documentToPhysical,
    physicalToDocument,
  });
}
