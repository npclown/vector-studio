import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'p3-rounded-fill-v1';
const SEED = 0x50333245;
const ROW_COUNT = 202;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'tests/fixtures/p3-rounded-fill-v1.txt');
const view = new DataView(new ArrayBuffer(8));

function bitsOf(value) {
  if (!Number.isFinite(value)) throw new Error(`nonfinite fixture coordinate ${value}`);
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

function fromBits(bits) {
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

function hex(value) {
  return bitsOf(value).toString(16).padStart(16, '0');
}

function rectangle(left, bottom, right, top) {
  return [
    [left, bottom],
    [right, bottom],
    [right, top],
    [left, top],
  ];
}

function reverse(contour) {
  return [...contour].reverse();
}

const outer = rectangle(0, 0, 10, 10);
const inner = rectangle(3, 3, 7, 7);
const squareA = rectangle(0, 0, 4, 4);
const overlapB = rectangle(2, 0, 6, 4);
const sharedB = rectangle(2, 4, 6, 8);
const bowtie = [
  [0, 0],
  [4, 4],
  [0, 4],
  [4, 0],
];

const sources = [
  ['F01', [outer]],
  ['F02', [outer, inner]],
  ['F03', [outer, reverse(inner)]],
  ['F04', [outer, outer]],
  ['F05', [outer, reverse(outer)]],
  ['F06', [bowtie]],
  ['F07', [rectangle(0, 0, 2, 2), rectangle(2, 0, 4, 2)]],
  [
    'F08',
    [
      [
        [0, 0],
        [8, 0],
        [0, 8],
      ],
    ],
  ],
  [
    'F09-repeat',
    [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [10, 10],
        [0, 10],
      ],
    ],
  ],
  ['F09-permuted', [inner, outer]],
  ['F10', [squareA, overlapB]],
  ['F10-reversed', [squareA, reverse(overlapB)]],
  ['F11', [squareA, sharedB]],
  ['F03-global-reversed', [reverse(outer), inner]],
  ['F06-global-reversed', [reverse(bowtie)]],
  ['F10-global-reversed', [reverse(squareA), reverse(overlapB)]],
].map(([id, contours]) => ({ id, contours, tau: Number.MIN_VALUE, expectation: 'OK' }));

const nextOne = fromBits(bitsOf(1) + 1n);
const epsilon = 2 ** -52;
sources.push(
  {
    id: 'R01',
    contours: [
      [
        [0, 0],
        [1, 1],
        [0, 1],
        [1, -1],
      ],
    ],
    tau: 2 ** -48,
    expectation: 'OK',
  },
  {
    id: 'R02',
    contours: [
      [
        [0, 0],
        [3, 1],
        [3, 0],
      ],
      [
        [1, 0],
        [1, 1],
      ],
    ],
    tau: 2 ** -48,
    expectation: 'OK',
  },
  { id: 'R03', contours: [rectangle(1, 0, nextOne, 1)], tau: Number.MIN_VALUE, expectation: 'OK' },
  {
    id: 'R04',
    contours: [1, 2, 3].map((j) => [
      [0, 0],
      [2, 0],
      [0, 1],
      [2, -1 + j * epsilon],
    ]),
    tau: 2 ** -49,
    expectation: 'OK',
  },
  { id: 'R05', contours: [rectangle(-0, -0, 1, 1)], tau: Number.MIN_VALUE, expectation: 'OK' },
  {
    id: 'R06',
    contours: [rectangle(0, 0, 8 * Number.MIN_VALUE, 8 * Number.MIN_VALUE)],
    tau: Number.MIN_VALUE,
    expectation: 'OK',
  },
  {
    id: 'R07',
    contours: [rectangle(-Number.MAX_VALUE, 0, Number.MAX_VALUE, 1)],
    tau: Number.MIN_VALUE,
    expectation: 'OK',
  },
);

let state = SEED >>> 0;
function word() {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state >>>= 0;
  state ^= state << 5;
  state >>>= 0;
  return state;
}

function rotate(contour, amount) {
  const offset = amount % contour.length;
  return [...contour.slice(offset), ...contour.slice(0, offset)];
}

function seededSource(family, index) {
  const words = Array.from({ length: 8 }, word);
  const tx = (words[0] % 33) - 16;
  const ty = (words[1] % 33) - 16;
  const width = 8 + 4 * (words[2] % 7);
  const height = 8 + 4 * (words[3] % 7);
  let contours;
  if (family === 'S') {
    contours = [
      [
        [0, 0],
        [width, 0],
        [width, height],
        [(3 * width) / 4, height],
        [(3 * width) / 4, height / 2],
        [width / 4, height / 2],
        [width / 4, height],
        [0, height],
      ],
    ];
  } else if (family === 'X') {
    const base = [
      [-width, 0],
      [-width / 2, -height],
      [width / 2, -height],
      [width, 0],
      [width / 2, height],
      [-width / 2, height],
    ];
    contours = [[0, 2, 4, 1, 3, 5].map((position) => base[position])];
  } else if (family === 'H') {
    contours = [rectangle(0, 0, width, height), rectangle(2, 2, width - 2, height - 2)];
  } else {
    contours = [
      rectangle(0, 0, width, height),
      rectangle(width / 2, -height / 4, (3 * width) / 2, (3 * height) / 4),
    ];
  }
  if ((family === 'H' || family === 'O') && (words[6] & 1) !== 0)
    contours[1] = reverse(contours[1]);
  if ((family === 'H' || family === 'O') && (words[7] & 1) !== 0) contours.reverse();
  contours = contours.map((contour) => rotate(contour, words[4] % contour.length));
  if ((words[5] & 1) !== 0) contours = contours.map(reverse);
  contours = contours.map((contour) => contour.map(([x, y]) => [x + y / 4 + tx, y + ty]));
  return {
    id: `${family}${index.toString().padStart(2, '0')}`,
    contours,
    tau: 2 ** -40,
    expectation: 'OK',
  };
}

const seeded = [];
for (const family of ['S', 'X', 'H', 'O']) {
  for (let index = 0; index < 16; index += 1) seeded.push(seededSource(family, index));
}
sources.push(...seeded);

for (const id of ['S00', 'X00', 'H00', 'O00']) {
  const source = seeded.find((candidate) => candidate.id === id);
  const transforms = [
    ['translate', (x, y) => [x + 2 ** 20, y - 2 ** 20]],
    ['reflect', (x, y) => [-x, y]],
    ['scale', (x, y) => [x / 1024, y / 1024]],
  ];
  for (const [name, transform] of transforms) {
    sources.push({
      id: `M-${id}-${name}`,
      contours: source.contours.map((contour) => contour.map(([x, y]) => transform(x, y))),
      tau: 2 ** -20,
      expectation: 'OK',
    });
  }
}

sources.push(
  {
    id: 'A01',
    contours: [
      [
        [1, 0],
        [nextOne, 0],
        [1, 1],
        [nextOne, -1],
      ],
    ],
    tau: 1,
    expectation: 'TOPOLOGY_AMBIGUOUS',
  },
  {
    id: 'A02',
    contours: [
      [
        [0, 1],
        [2, nextOne],
      ],
      [
        [1, 1],
        [1, nextOne],
      ],
    ],
    tau: 1,
    expectation: 'TOPOLOGY_AMBIGUOUS',
  },
);

const rules = ['nonzero', 'evenodd'];
const profiles = ['I', 'R16', 'D32', 'S192'];
const rows = sources.flatMap((source) => rules.map((rule) => ({ ...source, rule })));
if (rows.length !== ROW_COUNT) throw new Error(`expected ${ROW_COUNT} rows, built ${rows.length}`);

const lines = [
  `# ${VERSION}`,
  `# seed ${SEED.toString(16).padStart(8, '0')}`,
  `# rows ${ROW_COUNT}`,
  ...rows.map((row, index) => {
    const fields = [
      row.id,
      row.rule,
      hex(row.tau),
      row.expectation,
      profiles[index % profiles.length],
    ];
    const contours = row.contours.map((contour) =>
      contour.map(([x, y]) => `${hex(x)},${hex(y)}`).join(' '),
    );
    return `${fields.join(' ')} | ${contours.join(' | ')}`;
  }),
];
const contents = `${lines.join('\n')}\n`;

const option = process.argv[2] ?? '--check';
if (process.argv.length > 3 || !['--check', '--write'].includes(option)) {
  throw new Error('usage: node tooling/generate-p3-rounded-fill-fixtures.mjs [--check|--write]');
}
if (option === '--write') {
  mkdirSync(path.dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, contents, 'utf8');
  console.log(`wrote ${path.relative(root, fixturePath)} (${ROW_COUNT} rows)`);
} else {
  let actual;
  try {
    actual = readFileSync(fixturePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT')
      throw new Error(`${path.relative(root, fixturePath)} is missing; run with --write`, {
        cause: error,
      });
    throw error;
  }
  if (actual !== contents)
    throw new Error(`${path.relative(root, fixturePath)} is stale; run with --write`);
  console.log(`checked ${path.relative(root, fixturePath)} (${ROW_COUNT} rows)`);
}
