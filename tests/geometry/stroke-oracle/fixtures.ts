/**
 * P3 B2 unit ST-U3: the line fixtures of `docs/plans/p3-b2-stroke-contract.md` section 11.2 as
 * dump cases, and exact mesh measurements (BigInt, binary64 values as integer multiples of
 * 2^-1074) for their literal expectations.
 */
import type { FillMesh } from '@vector-studio/contracts';
import type { StrokeCap, StrokeCase, StrokeJoin } from './dump.js';

const MOVE = 0;
const LINE = 1;
const CLOSE = 3;

export const CAPS: readonly StrokeCap[] = ['butt', 'round', 'square'];
export const JOINS: readonly StrokeJoin[] = ['miter', 'round', 'bevel'];

export const SIXTEEN_GON = 3.0614674589207183;
export const HALF_SIXTEEN_GON = 1.5307337294603591;
export const QUARTER_SIXTEEN_GON = 0.7653668647301796;

/** A path as `M`, `L` and `Z` commands. */
export type Command = readonly ['M' | 'L', number, number] | readonly ['Z'];

export function path(commands: readonly Command[]): { verbs: number[]; points: number[] } {
  const verbs: number[] = [];
  const points: number[] = [];
  for (const command of commands) {
    if (command[0] === 'Z') {
      verbs.push(CLOSE);
    } else {
      verbs.push(command[0] === 'M' ? MOVE : LINE);
      points.push(command[1], command[2]);
    }
  }
  return { verbs, points };
}

export function strokeCase(
  name: string,
  commands: readonly Command[],
  width: number,
  cap: StrokeCap,
  join: StrokeJoin,
  miterLimit: number,
  exponent = -3,
): StrokeCase {
  return { name, ...path(commands), width, cap, join, miterLimit, exponent };
}

export const F1: Command[] = [
  ['M', 0, 0],
  ['L', 4, 0],
];
export const F4: Command[] = [
  ['M', 0, 0],
  ['L', 4, 0],
  ['L', 4, 4],
];
export const F5: Command[] = [
  ['M', 0, 0],
  ['L', 25, 0],
  ['L', 32, 24],
];
export const F6: Command[] = [
  ['M', 0, 0],
  ['L', 4, 0],
  ['L', 0, 0],
];
export const F10: Command[] = [
  ['M', 0, 0],
  ['L', 4, 0],
  ['L', 4, 0],
  ['L', 4, 4],
];
export const F11: Command[] = [['M', 0, 0], ['L', 4, 0], ['L', 4, 4], ['L', 0, 4], ['Z']];
export const F12: Command[] = [
  ['M', 0, 0],
  ['L', 8, 0],
  ['L', 0, 8],
];
export const F13: Command[] = [
  ['M', 0, 0],
  ['L', 3, 1],
  ['L', 12, 4],
];
export const F14A: Command[] = [
  ['M', 0, 2],
  ['L', 4, 2],
  ['M', 2, 0],
  ['L', 2, 4],
];
export const F14B: Command[] = [
  ['M', 0, 2],
  ['L', 4, 2],
  ['L', 4, 4],
  ['L', 2, 4],
  ['L', 2, 0],
];
export const F24: Command[] = [
  ['M', 0, 0],
  ['L', 1, 0],
  ['L', 0, 2 ** -20],
];

/** ST-F25's turns with their exact miter ratios. */
export const F25_TURNS: readonly (readonly [string, Command[], number])[] = [
  ['sqrt2', F4, Math.SQRT2],
  [
    '5/3',
    [
      ['M', 0, 0],
      ['L', 25, 0],
      ['L', 18, 24],
    ],
    5 / 3,
  ],
  [
    'sqrt50',
    [
      ['M', 0, 0],
      ['L', 25, 0],
      ['L', 1, 7],
    ],
    Math.sqrt(50),
  ],
];
export const F25_LIMITS = [1, Math.SQRT2, 4, 100] as const;

/** Every ST-U3 dump case, named `ST-F<n>/<variant>`. */
export function lineCases(): StrokeCase[] {
  const cases: StrokeCase[] = [
    strokeCase('ST-F1', F1, 2, 'butt', 'miter', 4),
    strokeCase('ST-F2', F1, 2, 'square', 'miter', 4),
    strokeCase('ST-F3', F1, 2, 'round', 'miter', 4),
    strokeCase('ST-F4/miter-2', F4, 2, 'butt', 'miter', 2),
    strokeCase('ST-F4/miter-1', F4, 2, 'butt', 'miter', 1),
    strokeCase('ST-F4/bevel', F4, 2, 'butt', 'bevel', 4),
    strokeCase('ST-F4/round', F4, 2, 'butt', 'round', 4),
    strokeCase('ST-F5/1.25', F5, 2, 'butt', 'miter', 1.25),
    strokeCase('ST-F5/below', F5, 2, 'butt', 'miter', 1.2499999999999998),
    strokeCase('ST-F5/above', F5, 2, 'butt', 'miter', 1.2500000000000002),
    strokeCase('ST-F6/miter', F6, 2, 'butt', 'miter', 4),
    strokeCase('ST-F6/bevel', F6, 2, 'butt', 'bevel', 4),
    strokeCase('ST-F6/round', F6, 2, 'butt', 'round', 4),
    strokeCase(
      'ST-F8/butt',
      [
        ['M', 4, 5],
        ['L', 4, 5],
      ],
      2,
      'butt',
      'miter',
      4,
    ),
    strokeCase(
      'ST-F8/round',
      [
        ['M', 4, 5],
        ['L', 4, 5],
      ],
      2,
      'round',
      'miter',
      4,
    ),
    strokeCase(
      'ST-F8/square',
      [
        ['M', 4, 5],
        ['L', 4, 5],
      ],
      2,
      'square',
      'miter',
      4,
    ),
    strokeCase('ST-F10', F10, 2, 'butt', 'miter', 2),
    strokeCase('ST-F12', F12, 2, 'butt', 'bevel', 4),
    strokeCase('ST-F13', F13, 2, 'butt', 'miter', 4),
    strokeCase('ST-F14a', F14A, 2, 'butt', 'miter', 2),
    strokeCase('ST-F14b', F14B, 2, 'butt', 'miter', 2),
    strokeCase('ST-F21', F1, 2 ** -20, 'butt', 'miter', 4),
    strokeCase(
      'ST-F22',
      [
        ['M', 2 ** 40, 2 ** 40],
        ['L', 2 ** 40 + 1, 2 ** 40 + 1],
      ],
      2 ** -41,
      'butt',
      'miter',
      4,
    ),
    strokeCase(
      'ST-F23',
      [
        ['M', 2 ** 60, 0],
        ['L', 2 ** 60 + 2 ** 20, 0],
      ],
      2,
      'butt',
      'miter',
      4,
    ),
    strokeCase('ST-F24/2^30', F24, 2, 'butt', 'miter', 2 ** 30),
    strokeCase('ST-F24/4', F24, 2, 'butt', 'miter', 4),
    strokeCase('ST-F26/disk-256', F1, 400, 'round', 'miter', 4),
    strokeCase('ST-F26/disk-512', F1, 1000, 'round', 'miter', 4),
  ];
  for (const cap of CAPS)
    for (const join of JOINS) {
      cases.push(strokeCase(`ST-F7/${cap}-${join}`, [['M', 4, 5]], 2, cap, join, 4));
      cases.push(
        strokeCase(`ST-F9/${cap}-${join}`, [['M', 4, 5], ['L', 4, 5], ['Z']], 2, cap, join, 4),
      );
    }
  for (const cap of CAPS) {
    cases.push(strokeCase(`ST-F11/miter-${cap}`, F11, 2, cap, 'miter', 2));
    cases.push(strokeCase(`ST-F11/bevel-${cap}`, F11, 2, cap, 'bevel', 2));
    cases.push(strokeCase(`ST-F11/round-${cap}`, F11, 2, cap, 'round', 2));
  }
  for (const [turn, commands] of F25_TURNS)
    for (const limit of F25_LIMITS)
      cases.push(
        strokeCase(`ST-F25/${turn}/${String(limit)}`, commands, 2, 'butt', 'miter', limit),
      );
  return cases;
}

type Exact = Readonly<{ x: bigint; y: bigint }>;
const view = new DataView(new ArrayBuffer(8));

/** The exact binary64 value as an integer multiple of 2^-1074. */
export function exact(value: number): bigint {
  view.setFloat64(0, value, false);
  const high = view.getUint32(0, false);
  const low = view.getUint32(4, false);
  const exponent = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const magnitude = exponent === 0 ? fraction : ((1n << 52n) | fraction) << BigInt(exponent - 1);
  return (high & 0x80000000) === 0 ? magnitude : -magnitude;
}

function vertex(mesh: FillMesh, index: number): Exact {
  return { x: exact(mesh.positions[2 * index]!), y: exact(mesh.positions[2 * index + 1]!) };
}

function orientation(a: Exact, b: Exact, c: Exact): bigint {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Twice the mesh area, exactly, in units of 2^-2148. */
export function twiceArea(mesh: FillMesh): bigint {
  let total = 0n;
  for (let slot = 0; slot < mesh.indices.length; slot += 3)
    total += orientation(
      vertex(mesh, mesh.indices[slot]!),
      vertex(mesh, mesh.indices[slot + 1]!),
      vertex(mesh, mesh.indices[slot + 2]!),
    );
  return total;
}

/** The mesh area as a binary64 value (rounded from the exact sum). */
export function area(mesh: FillMesh): number {
  const twice = twiceArea(mesh);
  const shift = 2000n;
  const negative = twice < 0n;
  const magnitude = negative ? -twice : twice;
  const value = Number(magnitude >> shift) * 2 ** (Number(shift) - 2149);
  return negative ? -value : value;
}

/** ST-O5: the point lies in a closed mesh triangle, decided exactly. */
export function contains(mesh: FillMesh, x: number, y: number): boolean {
  const point = { x: exact(x), y: exact(y) };
  for (let slot = 0; slot < mesh.indices.length; slot += 3) {
    const [a, b, c] = [0, 1, 2].map((offset) => vertex(mesh, mesh.indices[slot + offset]!)) as [
      Exact,
      Exact,
      Exact,
    ];
    if (
      orientation(a, b, point) >= 0n &&
      orientation(b, c, point) >= 0n &&
      orientation(c, a, point) >= 0n
    )
      return true;
  }
  return false;
}

/** Number of closed loops formed by the directed boundary pairs. */
export function boundaryLoops(mesh: FillMesh): number {
  const edges: [number, number][] = [];
  for (let slot = 0; slot < mesh.boundaryEdges.length; slot += 2)
    edges.push([mesh.boundaryEdges[slot]!, mesh.boundaryEdges[slot + 1]!]);
  const used = edges.map(() => false);
  let loops = 0;
  for (let first = 0; first < edges.length; first += 1) {
    if (used[first]) continue;
    used[first] = true;
    const start = edges[first]![0];
    let end = edges[first]![1];
    while (end !== start) {
      const next = edges.findIndex((edge, index) => !used[index] && edge[0] === end);
      if (next < 0) throw new Error('boundary pairs do not close');
      used[next] = true;
      end = edges[next]![1];
    }
    loops += 1;
  }
  return loops;
}
