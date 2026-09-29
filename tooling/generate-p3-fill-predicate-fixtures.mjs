import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'p3-fill-orientation-v1';
const SEED = 0x50333241;
const LITERAL_COUNT = 16;
const RANDOM_COUNT = 4096;
const ROW_COUNT = LITERAL_COUNT + RANDOM_COUNT;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'tests/fixtures/p3-fill-orientation-v1.txt');

const Z = '0000000000000000';
const NZ = '8000000000000000';
const ONE = '3ff0000000000000';
const TWO = '4000000000000000';
const THREE = '4008000000000000';
const MIN = '0000000000000001';
const TWO_MIN = '0000000000000002';
const THREE_MIN = '0000000000000003';
const MAX = '7fefffffffffffff';
const NEG_MAX = 'ffefffffffffffff';
const TWO_52 = '4330000000000000';
const TWO_52_MINUS_ONE = '432ffffffffffffe';
const TWO_52_PLUS_ONE = '4330000000000001';
const TWO_1000 = '7e70000000000000';
const TWO_999 = '7e60000000000000';
const TWO_NEG_1000 = '0170000000000000';
const TWO_NEG_1001 = '0160000000000000';

const literalRows = [
  [Z, Z, ONE, Z, Z, ONE],
  [Z, Z, Z, ONE, ONE, Z],
  [Z, Z, ONE, ONE, TWO, TWO],
  [ONE, TWO, ONE, TWO, THREE, Z],
  [Z, NZ, NZ, Z, Z, Z],
  [Z, Z, MIN, Z, Z, MIN],
  [Z, Z, MAX, Z, Z, MAX],
  [NEG_MAX, NEG_MAX, MAX, NEG_MAX, NEG_MAX, MAX],
  [Z, Z, TWO_52, TWO_52_MINUS_ONE, TWO_52_PLUS_ONE, TWO_52],
  [Z, Z, TWO_52_PLUS_ONE, TWO_52, TWO_52, TWO_52_MINUS_ONE],
  [Z, Z, MAX, MIN, MAX, TWO_MIN],
  [TWO_52, TWO_52, TWO_52_PLUS_ONE, TWO_52, TWO_52, TWO_52_PLUS_ONE],
  [NZ, ONE, Z, ONE, ONE, Z],
  [NEG_MAX, ONE, Z, ONE, MAX, ONE],
  [Z, MIN, Z, TWO_MIN, Z, THREE_MIN],
  [Z, Z, TWO_1000, TWO_NEG_1000, TWO_999, TWO_NEG_1001],
];
const literalSigns = [1, -1, 0, 0, 0, 1, 1, 1, 1, -1, 1, 1, 0, 0, 0, 0];

function exactInteger(hex) {
  const bits = BigInt(`0x${hex}`);
  const negative = bits >> 63n !== 0n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0x000fffffffffffffn;
  if (exponent === 0x7ff) throw new Error(`nonfinite fixture coordinate ${hex}`);
  let magnitude;
  if (exponent === 0) {
    magnitude = fraction;
  } else {
    magnitude = (0x0010000000000000n | fraction) << BigInt(exponent - 1);
  }
  return negative ? -magnitude : magnitude;
}

function orientationSign(row) {
  const [ax, ay, bx, by, cx, cy] = row.map(exactInteger);
  const determinant = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return determinant > 0n ? 1 : determinant < 0n ? -1 : 0;
}

function xorshift32(value) {
  let next = value >>> 0;
  next = (next ^ (next << 13)) >>> 0;
  next = (next ^ (next >>> 17)) >>> 0;
  next = (next ^ (next << 5)) >>> 0;
  return next;
}

function randomRows() {
  let state = SEED;
  const rows = [];
  for (let rowIndex = 0; rowIndex < RANDOM_COUNT; rowIndex += 1) {
    const row = [];
    for (let coordinate = 0; coordinate < 6; coordinate += 1) {
      state = xorshift32(state);
      let high = state;
      state = xorshift32(state);
      const low = state;
      if (((high >>> 20) & 0x7ff) === 0x7ff) high = (high & ~(1 << 20)) >>> 0;
      row.push(`${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`);
    }
    rows.push(row);
  }
  return rows;
}

function generate() {
  for (let index = 0; index < literalRows.length; index += 1) {
    const actual = orientationSign(literalRows[index]);
    if (actual !== literalSigns[index]) {
      throw new Error(
        `literal ${index + 1} sign ${actual} differs from frozen ${literalSigns[index]}`,
      );
    }
  }
  const rows = [...literalRows, ...randomRows()];
  if (rows.length !== ROW_COUNT) throw new Error(`generated ${rows.length} rows`);
  const lines = [
    `# version ${VERSION}`,
    `# seed 0x${SEED.toString(16).padStart(8, '0')}`,
    `# literal-count ${LITERAL_COUNT}`,
    `# random-count ${RANDOM_COUNT}`,
    `# row-count ${ROW_COUNT}`,
    ...rows.map((row) => `${row.join(' ')} ${orientationSign(row)}`),
  ];
  return `${lines.join('\n')}\n`;
}

const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_[0] !== undefined && !['--check', '--write'].includes(arguments_[0]))
) {
  throw new Error('usage: node tooling/generate-p3-fill-predicate-fixtures.mjs [--check|--write]');
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
