import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'p3-fill-event-order-v1';
const SEED = 0x50333243;
const LITERAL_COUNT = 16;
const ENDPOINT_COUNT = 256;
const CROSSING_COUNT = 256;
const ROW_COUNT = LITERAL_COUNT + ENDPOINT_COUNT + CROSSING_COUNT;
const SIGN_BIT = 0x8000000000000000n;
const FRACTION_MASK = 0x000fffffffffffffn;
const UNIT = 1n << 1074n;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'tests/fixtures/p3-fill-event-order-v1.txt');
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
  if (exponent === 0x7ff) throw new Error(`nonfinite fixture bits ${hex(bits)}`);
  const magnitude =
    exponent === 0 ? fraction : (0x0010000000000000n | fraction) << BigInt(exponent - 1);
  return negative && magnitude !== 0n ? -magnitude : magnitude;
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

function midpoint(left, right) {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    2n * left.denominator * right.denominator,
  );
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

function orientation(a, b, c) {
  return cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
}

function endpoint(xBits, yBits) {
  return { type: 'P', bits: [xBits, yBits] };
}

function endpointNumbers(x, y) {
  return endpoint(integerBits(x), integerBits(y));
}

function crossingFromBits(bits) {
  if (bits.length !== 8) throw new Error('crossing requires eight coordinate fields');
  return { type: 'X', bits };
}

function crossingNumbers(...values) {
  return crossingFromBits(values.map(integerBits));
}

function exactEvent(event) {
  if (event.type === 'P') {
    return {
      x: rational(exactInteger(event.bits[0])),
      y: rational(exactInteger(event.bits[1])),
    };
  }
  const coordinates = event.bits.map(exactInteger);
  const [ax, ay, bx, by, cx, cy, dx, dy] = coordinates;
  const a = { x: ax, y: ay };
  const b = { x: bx, y: by };
  const c = { x: cx, y: cy };
  const d = { x: dx, y: dy };
  const orientations = [
    orientation(a, b, c),
    orientation(a, b, d),
    orientation(c, d, a),
    orientation(c, d, b),
  ];
  if (
    orientations.some((value) => value === 0n) ||
    orientations[0] * orientations[1] >= 0n ||
    orientations[2] * orientations[3] >= 0n
  ) {
    throw new Error('fixture crossing is not strict proper crossing');
  }
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const qx = cx - ax;
  const qy = cy - ay;
  const denominator = cross(rx, ry, sx, sy);
  const parameterNumerator = cross(qx, qy, sx, sy);
  return {
    x: rational(ax * denominator + parameterNumerator * rx, denominator),
    y: rational(ay * denominator + parameterNumerator * ry, denominator),
  };
}

function compareEvents(left, right) {
  const leftExact = exactEvent(left);
  const rightExact = exactEvent(right);
  const x = compareRational(leftExact.x, rightExact.x);
  return x === 0 ? compareRational(leftExact.y, rightExact.y) : x;
}

const Z = 0x0000000000000000n;
const NZ = 0x8000000000000000n;
const ONE = 0x3ff0000000000000n;
const NEG_ONE = 0xbff0000000000000n;
const MIN = 0x0000000000000001n;
const NEG_MIN = SIGN_BIT | MIN;
const TWO_MIN = 0x0000000000000002n;
const THREE_MIN = 0x0000000000000003n;
const MAX = 0x7fefffffffffffffn;
const NEG_MAX = SIGN_BIT | MAX;
const HALF_MAX = 0x7fdfffffffffffffn;
const NEG_HALF_MAX = SIGN_BIT | HALF_MAX;
const NEG_ONE_MINUS_EPSILON = 0xbff0000000000001n;

const unperturbedThird = crossingFromBits([Z, Z, ONE, ONE, Z, ONE, ONE, NEG_ONE]);
const perturbedThird = crossingFromBits([Z, Z, ONE, ONE, Z, ONE, ONE, NEG_ONE_MINUS_EPSILON]);
const reflectedPerturbedThird = crossingFromBits([
  NZ,
  Z,
  NEG_ONE,
  ONE,
  NZ,
  ONE,
  NEG_ONE,
  NEG_ONE_MINUS_EPSILON,
]);
const reflectedUnperturbedThird = crossingFromBits([
  NZ,
  Z,
  NEG_ONE,
  ONE,
  NZ,
  ONE,
  NEG_ONE,
  NEG_ONE,
]);
const halfSubnormal = crossingFromBits([Z, Z, MIN, MIN, Z, MIN, MIN, Z]);

const literalPairs = [
  [endpoint(NZ, Z), endpoint(Z, NZ)],
  [endpointNumbers(1, 2), endpointNumbers(2, -1)],
  [endpointNumbers(1, 3), endpointNumbers(1, 2)],
  [endpointNumbers(2, 2), crossingNumbers(0, 0, 4, 4, 0, 4, 4, 0)],
  [unperturbedThird, crossingNumbers(0, 1, 1, -1, -1, 1, 1, 0)],
  [perturbedThird, unperturbedThird],
  [endpointNumbers(1, 0), crossingNumbers(1, 0, 1, 1, 0, 0, 3, 1)],
  [endpointNumbers(0, 0), halfSubnormal],
  [halfSubnormal, endpoint(MIN, MIN)],
  [
    crossingFromBits([NEG_MAX, NEG_MAX, MAX, MAX, NEG_MAX, MAX, MAX, NEG_MAX]),
    endpointNumbers(0, 0),
  ],
  [endpoint(NEG_MAX, Z), endpoint(MAX, Z)],
  [crossingNumbers(0, 0, 0, 4, -1, 1, 1, 1), crossingNumbers(0, 0, 0, 4, -1, 2, 1, 2)],
  [endpoint(MIN, Z), endpoint(NEG_MIN, Z)],
  [crossingFromBits([NEG_MAX, MIN, MAX, TWO_MIN, Z, MIN, Z, THREE_MIN]), endpoint(Z, MIN)],
  [reflectedPerturbedThird, reflectedUnperturbedThird],
  [
    crossingFromBits([NEG_MAX, NEG_MAX, MAX, MAX, NEG_MAX, MAX, MAX, Z]),
    crossingFromBits([NEG_MAX, NEG_MAX, MAX, MAX, NEG_MAX, MAX, MAX, NEG_HALF_MAX]),
  ],
];
const literalSigns = [0, -1, 1, 0, 0, -1, -1, -1, -1, 0, -1, -1, 1, 1, 1, 1];

function verifyCollisionControl() {
  const centreBits = 0x3fd5555555555555n;
  const centre = rational(exactInteger(centreBits));
  const lower = rational(exactInteger(centreBits - 1n));
  const upper = rational(exactInteger(centreBits + 1n));
  const lowerMidpoint = midpoint(lower, centre);
  const upperMidpoint = midpoint(centre, upper);
  const exactValues = [exactEvent(perturbedThird), exactEvent(unperturbedThird)];
  for (const event of exactValues) {
    for (const coordinate of [event.x, event.y]) {
      if (
        compareRational(coordinate, lowerMidpoint) <= 0 ||
        compareRational(coordinate, upperMidpoint) >= 0
      ) {
        throw new Error('row 6 coordinate escapes the frozen nearest-representative interval');
      }
    }
  }
  const representativeOnly = compareRational(centre, centre) || compareRational(centre, centre);
  if (representativeOnly === literalSigns[5]) {
    throw new Error('representative-only collision control unexpectedly matches exact order');
  }
}

function xorshift32(value) {
  let next = value >>> 0;
  next = (next ^ (next << 13)) >>> 0;
  next = (next ^ (next >>> 17)) >>> 0;
  next = (next ^ (next << 5)) >>> 0;
  return next;
}

function nextWord(state) {
  return xorshift32(state);
}

function randomCoordinate(next) {
  let high = next();
  const low = next();
  if (((high >>> 20) & 0x7ff) === 0x7ff) high = (high & ~(1 << 20)) >>> 0;
  return (BigInt(high) << 32n) | BigInt(low);
}

function constructiveCrossing(words, offset) {
  const tx = (words[offset] % 256) - 128;
  const ty = (words[offset + 1] % 256) - 128;
  const width = 1 + (words[offset + 2] % 64);
  const height = 1 + (words[offset + 3] % 64);
  const drop = 1 + (words[offset + 4] % 64);
  const event = crossingNumbers(
    tx,
    ty,
    tx + width,
    ty + height,
    tx,
    ty + height,
    tx + width,
    ty - drop,
  );
  const exact = exactEvent(event);
  const denominator = BigInt(2 * height + drop);
  const analytic = {
    x: rational((BigInt(tx) * denominator + BigInt(width * height)) * UNIT, denominator),
    y: rational((BigInt(ty) * denominator + BigInt(height * height)) * UNIT, denominator),
  };
  if (compareRational(exact.x, analytic.x) !== 0 || compareRational(exact.y, analytic.y) !== 0) {
    throw new Error('constructive analytic formula disagrees with parametric determinant');
  }
  return event;
}

function generatedPairs() {
  let state = SEED;
  const next = () => {
    state = nextWord(state);
    return state;
  };
  const endpoints = [];
  for (let row = 0; row < ENDPOINT_COUNT; row += 1) {
    endpoints.push([
      endpoint(randomCoordinate(next), randomCoordinate(next)),
      endpoint(randomCoordinate(next), randomCoordinate(next)),
    ]);
  }
  const crossings = [];
  for (let row = 0; row < CROSSING_COUNT; row += 1) {
    const words = Array.from({ length: 10 }, next);
    crossings.push([constructiveCrossing(words, 0), constructiveCrossing(words, 5)]);
  }
  return [...endpoints, ...crossings];
}

function serializeEvent(event) {
  return `${event.type} ${event.bits.map(hex).join(' ')}`;
}

function generate() {
  if (literalPairs.length !== LITERAL_COUNT) throw new Error('literal row count differs');
  for (let index = 0; index < literalPairs.length; index += 1) {
    const actual = compareEvents(literalPairs[index][0], literalPairs[index][1]);
    if (actual !== literalSigns[index]) {
      throw new Error(`literal ${index + 1} sign ${actual} differs from ${literalSigns[index]}`);
    }
  }
  verifyCollisionControl();
  const pairs = [...literalPairs, ...generatedPairs()];
  if (pairs.length !== ROW_COUNT) throw new Error(`generated ${pairs.length} rows`);
  const lines = [
    `# version ${VERSION}`,
    `# seed 0x${SEED.toString(16).padStart(8, '0')}`,
    `# literal-count ${LITERAL_COUNT}`,
    `# endpoint-count ${ENDPOINT_COUNT}`,
    `# crossing-count ${CROSSING_COUNT}`,
    `# row-count ${ROW_COUNT}`,
    ...pairs.map(
      ([left, right]) =>
        `${serializeEvent(left)} | ${serializeEvent(right)} | ${compareEvents(left, right)}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_[0] !== undefined && !['--check', '--write'].includes(arguments_[0]))
) {
  throw new Error('usage: node tooling/generate-p3-fill-event-fixtures.mjs [--check|--write]');
}

const generated = generate();
if (arguments_[0] === '--write') {
  mkdirSync(path.dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, generated, 'utf8');
  console.log(`wrote ${ROW_COUNT} rows to ${path.relative(root, fixturePath)}`);
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
