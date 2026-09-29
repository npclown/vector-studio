import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'p3-fill-intersections-v1';
const SEED = 0x50333242;
const LITERAL_COUNT = 4;
const RANDOM_COUNT = 256;
const ROW_COUNT = LITERAL_COUNT + RANDOM_COUNT;
const MAX_FINITE_BITS = 0x7fefffffffffffffn;
const SIGN_BIT = 0x8000000000000000n;
const FRACTION_MASK = 0x000fffffffffffffn;
const UNIT = 1n << 1074n;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'tests/fixtures/p3-fill-intersections-v1.txt');
const view = new DataView(new ArrayBuffer(8));

function bitsOf(value) {
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

function hex(bits) {
  return bits.toString(16).padStart(16, '0');
}

function integerBits(value) {
  if (!Number.isSafeInteger(value)) throw new Error(`unsafe fixture integer ${value}`);
  return bitsOf(value);
}

function exactInteger(bits) {
  const negative = bits >> 63n !== 0n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & FRACTION_MASK;
  if (exponent === 0x7ff) throw new Error(`nonfinite bits ${hex(bits)}`);
  const magnitude =
    exponent === 0 ? fraction : (0x0010000000000000n | fraction) << BigInt(exponent - 1);
  return negative ? -magnitude : magnitude;
}

function rational(numerator, denominator = 1n) {
  if (denominator === 0n) throw new Error('zero rational denominator');
  return denominator < 0n
    ? { numerator: -numerator, denominator: -denominator }
    : { numerator, denominator };
}

function compareRational(left, right) {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function addRational(left, right) {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function absoluteRational(value) {
  return value.numerator < 0n ? rational(-value.numerator, value.denominator) : value;
}

function subtractRational(left, right) {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function representedRational(bits) {
  return rational(exactInteger(bits));
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

function exactCrossing(inputBits) {
  const [ax, ay, bx, by, cx, cy, dx, dy] = inputBits.map(exactInteger);
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const qx = cx - ax;
  const qy = cy - ay;
  const denominator = cross(rx, ry, sx, sy);
  const tNumerator = cross(qx, qy, sx, sy);
  if (denominator === 0n) throw new Error('fixture segments are parallel');
  return {
    x: rational(ax * denominator + rx * tNumerator, denominator),
    y: rational(ay * denominator + ry * tNumerator, denominator),
  };
}

function comparePositiveBitsToRational(bits, value) {
  return exactInteger(bits) * value.denominator < value.numerator
    ? -1
    : exactInteger(bits) * value.denominator > value.numerator
      ? 1
      : 0;
}

function positiveDirectedBounds(value) {
  if (value.numerator < 0n) throw new Error('positive bound search received a negative value');
  let low = 0n;
  let high = MAX_FINITE_BITS;
  let floor = 0n;
  while (low <= high) {
    const middle = (low + high) >> 1n;
    if (comparePositiveBitsToRational(middle, value) <= 0) {
      floor = middle;
      low = middle + 1n;
    } else {
      high = middle - 1n;
    }
  }
  if (comparePositiveBitsToRational(floor, value) === 0) return [floor, floor];
  if (floor === MAX_FINITE_BITS) throw new Error('rational exceeds finite binary64');
  return [floor, floor + 1n];
}

function directedBounds(value) {
  if (value.numerator === 0n) return [0n, 0n];
  if (value.numerator > 0n) return positiveDirectedBounds(value);
  const [magnitudeFloor, magnitudeCeil] = positiveDirectedBounds(
    rational(-value.numerator, value.denominator),
  );
  return [SIGN_BIT | magnitudeCeil, SIGN_BIT | magnitudeFloor];
}

function verifyDirectedBounds(value, [lower, upper]) {
  const lowerValue = representedRational(lower);
  const upperValue = representedRational(upper);
  if (compareRational(lowerValue, value) > 0 || compareRational(value, upperValue) > 0) {
    throw new Error('directed bounds do not bracket exact rational');
  }
  if (lower !== upper) {
    const adjacent =
      value.numerator > 0n
        ? upper === lower + 1n
        : (lower & ~SIGN_BIT) === (upper & ~SIGN_BIT) + 1n;
    if (!adjacent) throw new Error('directed bounds are not adjacent binary64 values');
  }
}

function inputBits(values) {
  return values.map(integerBits);
}

const literalInputs = [
  inputBits([0, 0, 4, 4, 0, 4, 4, 0]),
  inputBits([0, 0, 4, 0, 1, -1, 1, 3]),
  inputBits([0, 0, 1, 1, 0, 1, 1, -1]),
  inputBits([-2, -2, -1, -1, -2, -1, -1, -3]),
];
const literalExpected = [
  { x: rational(2n * UNIT), y: rational(2n * UNIT) },
  { x: rational(UNIT), y: rational(0n) },
  { x: rational(UNIT, 3n), y: rational(UNIT, 3n) },
  { x: rational(-5n * UNIT, 3n), y: rational(-5n * UNIT, 3n) },
];

function xorshift32(value) {
  let next = value >>> 0;
  next = (next ^ (next << 13)) >>> 0;
  next = (next ^ (next >>> 17)) >>> 0;
  next = (next ^ (next << 5)) >>> 0;
  return next;
}

function generatedInputs() {
  let state = SEED;
  const rows = [];
  for (let index = 0; index < RANDOM_COUNT; index += 1) {
    const words = [];
    for (let word = 0; word < 5; word += 1) {
      state = xorshift32(state);
      words.push(state);
    }
    const tx = (words[0] % 256) - 128;
    const ty = (words[1] % 256) - 128;
    const width = 1 + (words[2] % 64);
    const height = 1 + (words[3] % 64);
    const drop = 1 + (words[4] % 64);
    const input = inputBits([
      tx,
      ty,
      tx + width,
      ty + height,
      tx,
      ty + height,
      tx + width,
      ty - drop,
    ]);
    const actual = exactCrossing(input);
    const denominator = BigInt(2 * height + drop);
    const analytic = {
      x: rational((BigInt(tx) * denominator + BigInt(width * height)) * UNIT, denominator),
      y: rational((BigInt(ty) * denominator + BigInt(height * height)) * UNIT, denominator),
    };
    if (
      compareRational(actual.x, analytic.x) !== 0 ||
      compareRational(actual.y, analytic.y) !== 0
    ) {
      throw new Error(`analytic crossing disagrees with determinant at generated row ${index}`);
    }
    rows.push(input);
  }
  return rows;
}

function fixtureRows() {
  for (let index = 0; index < literalInputs.length; index += 1) {
    const actual = exactCrossing(literalInputs[index]);
    const expected = literalExpected[index];
    if (
      compareRational(actual.x, expected.x) !== 0 ||
      compareRational(actual.y, expected.y) !== 0
    ) {
      throw new Error(`literal ${index + 1} exact identity failed`);
    }
  }
  const inputs = [...literalInputs, ...generatedInputs()];
  return inputs.map((input) => {
    const exact = exactCrossing(input);
    const xBounds = directedBounds(exact.x);
    const yBounds = directedBounds(exact.y);
    verifyDirectedBounds(exact.x, xBounds);
    verifyDirectedBounds(exact.y, yBounds);
    return { input, exact, directed: [...xBounds, ...yBounds] };
  });
}

function fixtureBytes(rows) {
  const lines = [
    `# version ${VERSION}`,
    `# seed 0x${SEED.toString(16).padStart(8, '0')}`,
    `# literal-count ${LITERAL_COUNT}`,
    `# random-count ${RANDOM_COUNT}`,
    `# row-count ${ROW_COUNT}`,
    ...rows.map(({ input, directed }) => [...input, ...directed].map(hex).join(' ')),
  ];
  return `${lines.join('\n')}\n`;
}

function parseNativeFrame(source) {
  const lines = source.split(/\r?\n/);
  const starts = lines.flatMap((line, index) =>
    line.trim() === 'P3_INTERSECTIONS_BEGIN' ? [index] : [],
  );
  const ends = lines.flatMap((line, index) =>
    line.trim() === 'P3_INTERSECTIONS_END' ? [index] : [],
  );
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new Error('native output must contain exactly one complete intersections frame');
  }
  const framed = lines.slice(starts[0] + 1, ends[0]);
  if (framed.length !== ROW_COUNT) throw new Error(`native frame has ${framed.length} rows`);
  return framed.map((line, index) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 8 || fields[0] !== String(index)) {
      throw new Error(`native row ${index} has invalid index or field count`);
    }
    const values = fields.slice(1).map((field) => {
      if (!/^[0-9a-f]{16}$/.test(field)) throw new Error(`native row ${index} has invalid hex`);
      const bits = BigInt(`0x${field}`);
      exactInteger(bits);
      return bits;
    });
    return values;
  });
}

function verifyNativeRows(nativeRows, fixture, label) {
  if (nativeRows.length !== fixture.length) throw new Error(`${label}: wrong row count`);
  const zero = rational(0n);
  const tolerance = representedRational(bitsOf(1e-8));
  for (let index = 0; index < fixture.length; index += 1) {
    const [pxBits, pyBits, minXBits, minYBits, maxXBits, maxYBits, errorBits] = nativeRows[index];
    const px = representedRational(pxBits);
    const py = representedRational(pyBits);
    const minX = representedRational(minXBits);
    const minY = representedRational(minYBits);
    const maxX = representedRational(maxXBits);
    const maxY = representedRational(maxYBits);
    const error = representedRational(errorBits);
    const exact = fixture[index].exact;
    if (
      compareRational(minX, exact.x) > 0 ||
      compareRational(exact.x, maxX) > 0 ||
      compareRational(minY, exact.y) > 0 ||
      compareRational(exact.y, maxY) > 0
    ) {
      throw new Error(`${label}: row ${index} enclosure misses exact intersection`);
    }
    if (
      compareRational(px, minX) < 0 ||
      compareRational(px, maxX) > 0 ||
      compareRational(py, minY) < 0 ||
      compareRational(py, maxY) > 0
    ) {
      throw new Error(`${label}: row ${index} point lies outside enclosure`);
    }
    if (compareRational(error, zero) < 0 || compareRational(error, tolerance) > 0) {
      throw new Error(`${label}: row ${index} certificate lies outside [0, 1e-8]`);
    }
    const l1 = addRational(
      absoluteRational(subtractRational(px, exact.x)),
      absoluteRational(subtractRational(py, exact.y)),
    );
    if (compareRational(l1, error) > 0) {
      throw new Error(`${label}: row ${index} certificate understates exact L1 error`);
    }
  }
}

function verifyNative(source, fixture) {
  const nativeRows = parseNativeFrame(source);
  verifyNativeRows(nativeRows, fixture, 'native');

  const wrongBox = nativeRows.map((row) => [...row]);
  const thirdFloorX = fixture[2].directed[0];
  wrongBox[2][2] = thirdFloorX;
  wrongBox[2][4] = thirdFloorX;
  let wrongBoxRejected = false;
  try {
    verifyNativeRows(wrongBox, fixture, 'wrong-box control');
  } catch (error) {
    wrongBoxRejected =
      error instanceof Error &&
      error.message === 'wrong-box control: row 2 enclosure misses exact intersection';
  }
  if (!wrongBoxRejected) throw new Error('wrong-box geometric control was accepted');

  const zeroCertificate = nativeRows.map((row) => [...row]);
  zeroCertificate[2][6] = 0n;
  let zeroCertificateRejected = false;
  try {
    verifyNativeRows(zeroCertificate, fixture, 'zero-certificate control');
  } catch (error) {
    zeroCertificateRejected =
      error instanceof Error &&
      error.message === 'zero-certificate control: row 2 certificate understates exact L1 error';
  }
  if (!zeroCertificateRejected) throw new Error('zero-certificate geometric control was accepted');
  console.log(`verified ${ROW_COUNT} native intersections and two corrupt-output controls`);
}

const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_[0] !== undefined &&
    !['--check', '--write', '--verify-native'].includes(arguments_[0]))
) {
  throw new Error(
    'usage: node tooling/generate-p3-fill-intersection-fixtures.mjs [--check|--write|--verify-native]',
  );
}

const rows = fixtureRows();
if (rows.length !== ROW_COUNT) throw new Error(`generated ${rows.length} rows`);
const generated = fixtureBytes(rows);
if (arguments_[0] === '--write') {
  mkdirSync(path.dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, generated, 'utf8');
  console.log(`wrote ${ROW_COUNT} rows to ${path.relative(root, fixturePath)}`);
} else if (arguments_[0] === '--verify-native') {
  const existing = readFileSync(fixturePath, 'utf8');
  if (existing !== generated) throw new Error('fixture differs before native verification');
  verifyNative(readFileSync(0, 'utf8'), rows);
} else {
  let existing;
  try {
    existing = readFileSync(fixturePath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${path.relative(root, fixturePath)}: ${error.message}`, {
      cause: error,
    });
  }
  if (existing !== generated) {
    throw new Error(`${path.relative(root, fixturePath)} differs from deterministic generation`);
  }
  console.log(`${path.relative(root, fixturePath)} matches ${ROW_COUNT} generated rows`);
}
