import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  add,
  bitsOf,
  compare,
  exactInteger,
  half,
  mul as multiply,
  rational,
  sign,
  sub as subtract,
} from '../tests/geometry/rounded-fill/exact.ts';

const VERSION = 'p3-transverse-pairs-v1';
const ROW_COUNT = 60;
const SIGN_BIT = 0x8000000000000000n;
const EXPONENT_MASK = 0x7ffn;
const QUIET_NAN = 0x7ff8000000000000n;
const POSITIVE_INFINITY = 0x7ff0000000000000n;
const MINIMUM_SUBNORMAL = 0x0000000000000001n;
const MAXIMUM_FINITE = 0x7fefffffffffffffn;
const HALF_MAXIMUM_FINITE = 0x7fdfffffffffffffn;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'tests/fixtures/p3-transverse-pairs-v1.txt');

function hex(bits) {
  return bits.toString(16).padStart(16, '0');
}

function point(x, y) {
  return { x: bitsOf(x), y: bitsOf(y) };
}

function pointBits(x, y) {
  return { x, y };
}

function points(values) {
  return values.map(([x, y]) => point(x, y));
}

function clonePoint(value) {
  return { x: value.x, y: value.y };
}

function cloneLeaf(value) {
  return {
    sourceVerb: value.sourceVerb,
    endNumerator: value.endNumerator,
    depth: value.depth,
    source: value.source.map(clonePoint),
    actual: value.actual.map(clonePoint),
  };
}

function leaf(sourceVerb, source, actual = [source[0], source[3]], endNumerator = 1, depth = 0) {
  return {
    sourceVerb,
    endNumerator,
    depth,
    source: source.map(clonePoint),
    actual: actual.map(clonePoint),
  };
}

function pair(left, right) {
  return [cloneLeaf(left), cloneLeaf(right)];
}

function scale(value, factor) {
  return rational(value.n * factor, value.d);
}

function midpoint(left, right) {
  return half(add(left, right));
}

function exactPoint(value) {
  // exactInteger uses one common implicit scale of 2^-1074 for every finite binary64 value.
  // Homogeneous restriction, cross-sign and separating-projection decisions are scale invariant.
  return {
    x: rational(exactInteger(value.x)),
    y: rational(exactInteger(value.y)),
  };
}

function subtractPoint(left, right) {
  return { x: subtract(left.x, right.x), y: subtract(left.y, right.y) };
}

function midpointPoint(left, right) {
  return { x: midpoint(left.x, right.x), y: midpoint(left.y, right.y) };
}

function scalePoint(value, factor) {
  return { x: scale(value.x, factor), y: scale(value.y, factor) };
}

function cross(left, right) {
  return subtract(multiply(left.x, right.y), multiply(left.y, right.x));
}

function dot(left, right) {
  return add(multiply(left.x, right.x), multiply(left.y, right.y));
}

function orientation(a, b, c) {
  return sign(cross(subtractPoint(b, a), subtractPoint(c, a)));
}

function splitHalf(control) {
  const q01 = midpointPoint(control[0], control[1]);
  const q12 = midpointPoint(control[1], control[2]);
  const q23 = midpointPoint(control[2], control[3]);
  const q012 = midpointPoint(q01, q12);
  const q123 = midpointPoint(q12, q23);
  const q0123 = midpointPoint(q012, q123);
  return [
    [control[0], q01, q012, q0123],
    [q0123, q123, q23, control[3]],
  ];
}

function restrictCell(source, endNumerator, depth) {
  let control = source.map(exactPoint);
  const cellIndex = BigInt(endNumerator - 1);
  for (let level = depth - 1; level >= 0; level -= 1) {
    const halves = splitHalf(control);
    control = halves[Number((cellIndex >> BigInt(level)) & 1n)];
  }
  return control;
}

function properCrossing(first, second) {
  const firstStart = exactPoint(first[0]);
  const firstEnd = exactPoint(first[1]);
  const secondStart = exactPoint(second[0]);
  const secondEnd = exactPoint(second[1]);
  const firstSides = [
    orientation(firstStart, firstEnd, secondStart),
    orientation(firstStart, firstEnd, secondEnd),
  ];
  const secondSides = [
    orientation(secondStart, secondEnd, firstStart),
    orientation(secondStart, secondEnd, firstEnd),
  ];
  return (
    firstSides[0] !== 0 &&
    firstSides[0] === -firstSides[1] &&
    secondSides[0] !== 0 &&
    secondSides[0] === -secondSides[1]
  );
}

function derivativeGenerators(control, actual) {
  return [
    scalePoint(subtractPoint(control[1], control[0]), 3n),
    scalePoint(subtractPoint(control[2], control[1]), 3n),
    scalePoint(subtractPoint(control[3], control[2]), 3n),
    subtractPoint(exactPoint(actual[1]), exactPoint(actual[0])),
  ];
}

function commonGeneratorOrientation(first, second) {
  let common = 0;
  for (const left of first) {
    for (const right of second) {
      const current = sign(cross(left, right));
      if (current === 0 || (common !== 0 && current !== common)) return 0;
      common = current;
    }
  }
  return common;
}

function projectionRange(values, axis) {
  let minimum = dot(values[0], axis);
  let maximum = minimum;
  for (let index = 1; index < values.length; index += 1) {
    const projection = dot(values[index], axis);
    if (compare(projection, minimum) < 0) minimum = projection;
    if (compare(projection, maximum) > 0) maximum = projection;
  }
  return { minimum, maximum };
}

function nonzeroVector(value) {
  return sign(value.x) !== 0 || sign(value.y) !== 0;
}

function addAxisPair(axes, difference) {
  if (!nonzeroVector(difference)) return;
  axes.push(difference, { x: rational(-difference.y.n, difference.y.d), y: difference.x });
}

function closedSetsAreDisjointByProjection(sweep, opposing) {
  const axes = [
    { x: rational(1n), y: rational(0n) },
    { x: rational(0n), y: rational(1n) },
  ];
  for (let left = 0; left < opposing.length; left += 1) {
    for (let right = left + 1; right < opposing.length; right += 1) {
      addAxisPair(axes, subtractPoint(opposing[right], opposing[left]));
    }
  }
  addAxisPair(axes, subtractPoint(sweep[1], sweep[0]));

  for (const axis of axes) {
    const sweepRange = projectionRange(sweep, axis);
    const opposingRange = projectionRange(opposing, axis);
    if (
      compare(sweepRange.maximum, opposingRange.minimum) < 0 ||
      compare(opposingRange.maximum, sweepRange.minimum) < 0
    ) {
      return true;
    }
  }
  return false;
}

function endpointSweepsAreSeparated(firstControl, firstActual, secondControl, secondActual) {
  const firstActualExact = firstActual.map(exactPoint);
  const secondActualExact = secondActual.map(exactPoint);
  const firstExpanded = [...firstControl, ...firstActualExact];
  const secondExpanded = [...secondControl, ...secondActualExact];
  const sweeps = [
    [[firstControl[0], firstActualExact[0]], secondExpanded],
    [[firstControl[3], firstActualExact[1]], secondExpanded],
    [[secondControl[0], secondActualExact[0]], firstExpanded],
    [[secondControl[3], secondActualExact[1]], firstExpanded],
  ];
  return sweeps.every(([sweep, opposing]) => closedSetsAreDisjointByProjection(sweep, opposing));
}

function finitePoint(value) {
  return [value.x, value.y].every((bits) => Number((bits >> 52n) & EXPONENT_MASK) !== 0x7ff);
}

function validProvenance(value) {
  if (!Number.isInteger(value.depth) || value.depth < 0 || value.depth > 20) return false;
  const maximum = 2 ** value.depth;
  return (
    Number.isInteger(value.endNumerator) && value.endNumerator >= 1 && value.endNumerator <= maximum
  );
}

function sameSourceBits(left, right) {
  return left.source.every(
    (value, index) => value.x === right.source[index].x && value.y === right.source[index].y,
  );
}

function interiorsOverlap(left, right) {
  const leftScale = 1n << BigInt(right.depth);
  const rightScale = 1n << BigInt(left.depth);
  const leftStart = BigInt(left.endNumerator - 1) * leftScale;
  const leftEnd = BigInt(left.endNumerator) * leftScale;
  const rightStart = BigInt(right.endNumerator - 1) * rightScale;
  const rightEnd = BigInt(right.endNumerator) * rightScale;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function oracle(leaves) {
  if (
    leaves.some((value) => !value.source.every(finitePoint) || !value.actual.every(finitePoint))
  ) {
    return { status: 'InvalidInput', orientation: 0 };
  }
  if (leaves.some((value) => !validProvenance(value))) {
    return { status: 'InvalidProvenance', orientation: 0 };
  }

  const [left, right] = leaves;
  if (left.sourceVerb === right.sourceVerb && !sameSourceBits(left, right)) {
    return { status: 'InvalidInput', orientation: 0 };
  }
  if (left.sourceVerb === right.sourceVerb && interiorsOverlap(left, right)) {
    return { status: 'InvalidProvenance', orientation: 0 };
  }

  const leftControl = restrictCell(left.source, left.endNumerator, left.depth);
  const rightControl = restrictCell(right.source, right.endNumerator, right.depth);
  if (!properCrossing(left.actual, right.actual)) {
    return { status: 'Unresolved', orientation: 0 };
  }
  const orientation_ = commonGeneratorOrientation(
    derivativeGenerators(leftControl, left.actual),
    derivativeGenerators(rightControl, right.actual),
  );
  if (orientation_ === 0) return { status: 'Unresolved', orientation: 0 };
  if (!endpointSweepsAreSeparated(leftControl, left.actual, rightControl, right.actual)) {
    return { status: 'Unresolved', orientation: 0 };
  }
  return { status: 'Certified', orientation: orientation_ };
}

function reflectX(leaves) {
  return leaves.map((value) => {
    const reflected = cloneLeaf(value);
    for (const coordinate of [...reflected.source, ...reflected.actual]) {
      coordinate.x ^= SIGN_BIT;
    }
    return reflected;
  });
}

function reverseLeaf(value) {
  const reversed = cloneLeaf(value);
  reversed.source.reverse();
  reversed.actual.reverse();
  reversed.endNumerator = 2 ** reversed.depth - reversed.endNumerator + 1;
  return reversed;
}

function frozenRow(id, status, orientation_, leaves) {
  return { id, expected: { status, orientation: orientation_ }, leaves: leaves.map(cloneLeaf) };
}

const horizontal = points([
  [-3, 0],
  [-1, 0],
  [1, 0],
  [3, 0],
]);
const vertical = points([
  [0, -3],
  [0, -1],
  [0, 1],
  [0, 3],
]);
const curvedHorizontal = points([
  [-3, 0],
  [-1, 1 / 4],
  [1, -1 / 4],
  [3, 0],
]);
const curvedVertical = points([
  [0, -3],
  [1 / 4, -1],
  [-1 / 4, 1],
  [0, 3],
]);
const sharedSource = points([
  [3, -6],
  [-1, 7],
  [-1, -7],
  [3, 6],
]);
const depthNumerator = 2 ** 20;
const minimumHorizontal = [
  pointBits(SIGN_BIT | 3n, 0n),
  pointBits(SIGN_BIT | MINIMUM_SUBNORMAL, 0n),
  pointBits(MINIMUM_SUBNORMAL, 0n),
  pointBits(3n, 0n),
];
const minimumVertical = [
  pointBits(0n, SIGN_BIT | 3n),
  pointBits(0n, SIGN_BIT | MINIMUM_SUBNORMAL),
  pointBits(0n, MINIMUM_SUBNORMAL),
  pointBits(0n, 3n),
];
const maximumHorizontal = [
  pointBits(SIGN_BIT | MAXIMUM_FINITE, 0n),
  pointBits(SIGN_BIT | HALF_MAXIMUM_FINITE, 0n),
  pointBits(HALF_MAXIMUM_FINITE, 0n),
  pointBits(MAXIMUM_FINITE, 0n),
];
const maximumVertical = [
  pointBits(0n, SIGN_BIT | MAXIMUM_FINITE),
  pointBits(0n, SIGN_BIT | HALF_MAXIMUM_FINITE),
  pointBits(0n, HALF_MAXIMUM_FINITE),
  pointBits(0n, MAXIMUM_FINITE),
];

const positiveBases = [
  {
    id: 'S',
    orientations: [1, -1, -1, 1, -1],
    leaves: pair(leaf(1, horizontal), leaf(2, vertical)),
    reverseFirst: true,
  },
  {
    id: 'N',
    orientations: [1, -1, -1, 1, -1],
    leaves: pair(leaf(1, curvedHorizontal), leaf(2, curvedVertical)),
    reverseFirst: true,
  },
  {
    id: 'K',
    orientations: [1, -1, -1, 1, -1],
    leaves: pair(
      leaf(
        1,
        curvedHorizontal,
        points([
          [-3, 1 / 64],
          [3, 1 / 64],
        ]),
      ),
      leaf(
        2,
        curvedVertical,
        points([
          [1 / 64, -3],
          [1 / 64, 3],
        ]),
      ),
    ),
    reverseFirst: true,
  },
  {
    id: 'U',
    orientations: [-1, 1, 1, -1],
    leaves: pair(
      leaf(
        1,
        sharedSource,
        points([
          [27 / 64, -153 / 2048],
          [3 / 16, 21 / 256],
        ]),
        6,
        4,
      ),
      leaf(
        1,
        sharedSource,
        points([
          [3 / 16, -21 / 256],
          [27 / 64, 153 / 2048],
        ]),
        11,
        4,
      ),
    ),
    reverseFirst: false,
  },
  {
    id: 'D0',
    orientations: [1, -1, -1, 1, -1],
    leaves: pair(
      leaf(
        1,
        points([
          [0, 0],
          [depthNumerator, 0],
          [2 * depthNumerator, 0],
          [3 * depthNumerator, 0],
        ]),
        points([
          [0, 0],
          [3, 0],
        ]),
        1,
        20,
      ),
      leaf(
        2,
        points([
          [1, -1],
          [1, depthNumerator - 1],
          [1, 2 * depthNumerator - 1],
          [1, 3 * depthNumerator - 1],
        ]),
        points([
          [1, -1],
          [1, 2],
        ]),
        1,
        20,
      ),
    ),
    reverseFirst: true,
  },
  {
    id: 'D1',
    orientations: [1, -1, -1, 1, -1],
    leaves: pair(
      leaf(
        1,
        points([
          [-3 * (depthNumerator - 1), 0],
          [depthNumerator - 3 * (depthNumerator - 1), 0],
          [2 * depthNumerator - 3 * (depthNumerator - 1), 0],
          [3 * depthNumerator - 3 * (depthNumerator - 1), 0],
        ]),
        points([
          [0, 0],
          [3, 0],
        ]),
        depthNumerator,
        20,
      ),
      leaf(
        2,
        points([
          [1, -1 - 3 * (depthNumerator - 1)],
          [1, depthNumerator - 1 - 3 * (depthNumerator - 1)],
          [1, 2 * depthNumerator - 1 - 3 * (depthNumerator - 1)],
          [1, 3 * depthNumerator - 1 - 3 * (depthNumerator - 1)],
        ]),
        points([
          [1, -1],
          [1, 2],
        ]),
        depthNumerator,
        20,
      ),
    ),
    reverseFirst: true,
  },
  {
    id: 'MIN',
    orientations: [1, -1, -1, 1, -1],
    leaves: pair(leaf(1, minimumHorizontal), leaf(2, minimumVertical)),
    reverseFirst: true,
  },
  {
    id: 'MAX',
    orientations: [1, -1, -1, 1, -1],
    leaves: pair(leaf(1, maximumHorizontal), leaf(2, maximumVertical)),
    reverseFirst: true,
  },
];

function positiveRows() {
  const rows = [];
  for (const base of positiveBases) {
    rows.push(frozenRow(`${base.id}-base`, 'Certified', base.orientations[0], base.leaves));
    rows.push(
      frozenRow(`${base.id}-swap`, 'Certified', base.orientations[1], [
        base.leaves[1],
        base.leaves[0],
      ]),
    );
    rows.push(
      frozenRow(`${base.id}-reflect-x`, 'Certified', base.orientations[2], reflectX(base.leaves)),
    );
    rows.push(
      frozenRow(
        `${base.id}-reverse-both`,
        'Certified',
        base.orientations[3],
        base.leaves.map(reverseLeaf),
      ),
    );
    if (base.reverseFirst) {
      rows.push(
        frozenRow(`${base.id}-reverse-first`, 'Certified', base.orientations[4], [
          reverseLeaf(base.leaves[0]),
          base.leaves[1],
        ]),
      );
    }
  }
  return rows;
}

const sPair = pair(leaf(1, horizontal), leaf(2, vertical));

function unresolvedRows() {
  const g01 = pair(
    leaf(1, horizontal),
    leaf(
      2,
      points([
        [4, -3],
        [4, -1],
        [4, 1],
        [4, 3],
      ]),
    ),
  );
  const g02 = pair(
    leaf(1, horizontal),
    leaf(
      2,
      points([
        [3, -3],
        [3, -1],
        [3, 1],
        [3, 3],
      ]),
    ),
  );
  const g03 = pair(leaf(1, horizontal), leaf(2, horizontal));
  const g04 = pair(
    leaf(
      1,
      horizontal,
      points([
        [0, 0],
        [0, 0],
      ]),
    ),
    leaf(2, vertical),
  );
  const g05 = pair(
    leaf(
      1,
      points([
        [-3, 0],
        [-3, 0],
        [1, 0],
        [3, 0],
      ]),
      [horizontal[0], horizontal[3]],
    ),
    leaf(2, vertical),
  );
  const g06 = pair(
    leaf(
      1,
      points([
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
      ]),
      points([
        [-3, 0],
        [4, 0],
      ]),
    ),
    leaf(2, vertical),
  );
  const g07 = pair(
    leaf(
      1,
      points([
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
      [horizontal[0], horizontal[3]],
    ),
    leaf(2, vertical),
  );
  const g08 = pair(
    leaf(
      1,
      points([
        [1 / 8, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
      points([
        [-1 / 8, 0],
        [3, 0],
      ]),
    ),
    leaf(
      2,
      points([
        [-2, -3],
        [2, -1],
        [-2, 1],
        [2, 3],
      ]),
      points([
        [0, -3],
        [0, 3],
      ]),
    ),
  );
  const g09 = pair(
    leaf(1, horizontal),
    leaf(
      2,
      points([
        [-3, 3],
        [-1, -1],
        [1, -1],
        [3, 3],
      ]),
      points([
        [-3, -1],
        [3, 1],
      ]),
    ),
  );
  const g10 = pair(
    leaf(
      1,
      horizontal,
      points([
        [-3, 0],
        [0, 0],
      ]),
      1,
      1,
    ),
    leaf(
      1,
      horizontal,
      points([
        [0, 0],
        [3, 0],
      ]),
      2,
      1,
    ),
  );
  return [g01, g02, g03, g04, g05, g06, g07, g08, g09, g10].map((leaves, index) =>
    frozenRow(`G${String(index + 1).padStart(2, '0')}`, 'Unresolved', 0, leaves),
  );
}

function invalidRows() {
  const rows = [];

  const i01 = unresolvedRows()[0].leaves.map(cloneLeaf);
  i01[1].source[3].y = QUIET_NAN;
  rows.push(frozenRow('I01', 'InvalidInput', 0, i01));

  const i02 = sPair.map(cloneLeaf);
  i02[0].actual[0].x = POSITIVE_INFINITY;
  rows.push(frozenRow('I02', 'InvalidInput', 0, i02));

  const i03 = sPair.map(cloneLeaf);
  i03[0].depth = 21;
  rows.push(frozenRow('I03', 'InvalidProvenance', 0, i03));

  const i04 = sPair.map(cloneLeaf);
  i04[0].endNumerator = 0;
  rows.push(frozenRow('I04', 'InvalidProvenance', 0, i04));

  const i05 = sPair.map(cloneLeaf);
  i05[0].endNumerator = 2;
  rows.push(frozenRow('I05', 'InvalidProvenance', 0, i05));

  const i06 = pair(
    leaf(
      1,
      horizontal,
      points([
        [-3, 0],
        [3, 0],
      ]),
      1,
      0,
    ),
    leaf(
      1,
      horizontal,
      points([
        [0, -3],
        [0, 3],
      ]),
      1,
      0,
    ),
  );
  rows.push(frozenRow('I06', 'InvalidProvenance', 0, i06));

  const i07 = i06.map(cloneLeaf);
  i07[1].depth = 1;
  rows.push(frozenRow('I07', 'InvalidProvenance', 0, i07));

  const i08 = sPair.map(cloneLeaf);
  i08[1].sourceVerb = 1;
  rows.push(frozenRow('I08', 'InvalidInput', 0, i08));

  const i09 = unresolvedRows()[9].leaves.map(cloneLeaf);
  i09[1].source[0].y = SIGN_BIT;
  rows.push(frozenRow('I09', 'InvalidInput', 0, i09));

  const i10 = sPair.map(cloneLeaf);
  i10[0].depth = 21;
  i10[1].actual[1].y = QUIET_NAN;
  rows.push(frozenRow('I10', 'InvalidInput', 0, i10));

  const i11 = unresolvedRows()[0].leaves.map(cloneLeaf);
  i11[1].endNumerator = 0;
  rows.push(frozenRow('I11', 'InvalidProvenance', 0, i11));

  return rows;
}

const FROZEN_IDS = [
  'S-base',
  'S-swap',
  'S-reflect-x',
  'S-reverse-both',
  'S-reverse-first',
  'N-base',
  'N-swap',
  'N-reflect-x',
  'N-reverse-both',
  'N-reverse-first',
  'K-base',
  'K-swap',
  'K-reflect-x',
  'K-reverse-both',
  'K-reverse-first',
  'U-base',
  'U-swap',
  'U-reflect-x',
  'U-reverse-both',
  'D0-base',
  'D0-swap',
  'D0-reflect-x',
  'D0-reverse-both',
  'D0-reverse-first',
  'D1-base',
  'D1-swap',
  'D1-reflect-x',
  'D1-reverse-both',
  'D1-reverse-first',
  'MIN-base',
  'MIN-swap',
  'MIN-reflect-x',
  'MIN-reverse-both',
  'MIN-reverse-first',
  'MAX-base',
  'MAX-swap',
  'MAX-reflect-x',
  'MAX-reverse-both',
  'MAX-reverse-first',
  'G01',
  'G02',
  'G03',
  'G04',
  'G05',
  'G06',
  'G07',
  'G08',
  'G09',
  'G10',
  'I01',
  'I02',
  'I03',
  'I04',
  'I05',
  'I06',
  'I07',
  'I08',
  'I09',
  'I10',
  'I11',
];

function serializeLeaf(value) {
  const coordinateTokens = [...value.source, ...value.actual].flatMap((coordinate) => [
    hex(coordinate.x),
    hex(coordinate.y),
  ]);
  return [value.sourceVerb, value.endNumerator, value.depth, ...coordinateTokens].join(' ');
}

function serializeRow(value) {
  return [
    value.id,
    value.expected.status,
    value.expected.orientation,
    serializeLeaf(value.leaves[0]),
    serializeLeaf(value.leaves[1]),
  ].join(' ');
}

function validateSerializedRows(rows, lines) {
  if (rows.length !== ROW_COUNT || lines.length !== ROW_COUNT) {
    throw new Error(`frozen corpus has ${rows.length} rows and ${lines.length} lines`);
  }
  const ids = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.id !== FROZEN_IDS[index]) {
      throw new Error(`row ${index + 1} id ${row.id} differs from frozen ${FROZEN_IDS[index]}`);
    }
    if (!/^[A-Za-z0-9-]{1,64}$/.test(row.id) || ids.has(row.id)) {
      throw new Error(`row ${index + 1} has invalid or duplicate id ${row.id}`);
    }
    ids.add(row.id);
    const tokens = lines[index].split(' ');
    if (tokens.length !== 33) throw new Error(`${row.id} has ${tokens.length} tokens`);
    if (!['Certified', 'InvalidInput', 'InvalidProvenance', 'Unresolved'].includes(tokens[1])) {
      throw new Error(`${row.id} has invalid status ${tokens[1]}`);
    }
    if (!['-1', '0', '1'].includes(tokens[2])) {
      throw new Error(`${row.id} has invalid orientation ${tokens[2]}`);
    }
    if ((tokens[1] === 'Certified') !== (tokens[2] !== '0')) {
      throw new Error(`${row.id} has inconsistent status/orientation`);
    }
    for (const offset of [3, 18]) {
      for (const token of tokens.slice(offset, offset + 3)) {
        if (!/^(0|[1-9][0-9]*)$/.test(token) || BigInt(token) > 0xffffffffn) {
          throw new Error(`${row.id} has invalid u32 token ${token}`);
        }
      }
      for (const token of tokens.slice(offset + 3, offset + 15)) {
        if (!/^[0-9a-f]{16}$/.test(token)) {
          throw new Error(`${row.id} has invalid bit token ${token}`);
        }
      }
    }
  }
}

function generate() {
  const rows = [...positiveRows(), ...unresolvedRows(), ...invalidRows()];
  if (FROZEN_IDS.length !== ROW_COUNT) throw new Error('frozen id count differs');
  for (const row of rows) {
    const actual = oracle(row.leaves);
    if (actual.status !== row.expected.status || actual.orientation !== row.expected.orientation) {
      throw new Error(
        `${row.id} oracle ${actual.status}/${actual.orientation} differs from literal ` +
          `${row.expected.status}/${row.expected.orientation}`,
      );
    }
  }
  const lines = rows.map(serializeRow);
  validateSerializedRows(rows, lines);
  return `${VERSION} ${ROW_COUNT}\n${lines.join('\n')}\n`;
}

const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_[0] !== undefined && !['--check', '--write'].includes(arguments_[0]))
) {
  throw new Error('usage: node tooling/generate-p3-transverse-pair-fixtures.mjs [--check|--write]');
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
