// D9 E8 unit E8-U1: the frozen generator of the E8 corpus `e8-corner/v1`
// (docs/plans/p3-rounded-knot-topology-contract.md, E8 addendum E8.6). Frozen by the SHA-256 of
// this file and of the encoded corpus in `corpus-v1.manifest.json`, before any unit runs on it.
//
// Families, 200 shapes each, every shape at e = -3 and at e = 0, fill rule NONZERO:
// - Lens families: knots P0 = (-100, 0) and P1 = (100, 0); the upper cubic P0 -> P1 has its two
//   controls x-ordered in (-100, 100) with y in [-150, -5]; the lower cubic P1 -> P0 has its
//   controls in reverse x order with y in [5, 150]. The tangent variant puts the controls at
//   x = -100 and x = 100, so both knots have vertical tangents. Every coordinate c becomes
//   (c + o) / s in binary64, with an integer offset o in [-500, 500]^2 and a scale 1/s,
//   s in {1, 10, 3}.
// - The wave family `M 0 0 L 0 -H Q W/4 -(H+A) W/2 -H T W -H L W 0 Z` with W = 4k, k in
//   [25, 100], H in [20, 200] and A in [-150, 150], raised to cubics in binary64 as the V-2 page
//   does: Q to `(p + 2q)/3`, `(e + 2q)/3`, and T reflects the previous control.
// All draws are integers from a 64-bit LCG (Knuth's MMIX constants), state
// s' = s * 6364136223846793005 + 1442695040888963407 mod 2^64, one LCG per family seeded below.
// A draw in [lo, hi] is lo + floor((s' >> 32) * (hi - lo + 1) / 2^32).
//
// The encoding is the `p3-b0r-random/v1` frame (magic `P3BRRND1`, read by the native
// `p3_b0r_identity::read_random`): u32 family count; per family u32 id length, id, u8 entry code
// (0), u32 path count; per path u8 rule, i32 exponent, u32 verb count, verbs, u32 scalar count,
// f64 scalars, all little-endian.

export const E8_CORNER_CORPUS_VERSION = 'e8-corner/v1';
export const E8_CORNER_MAGIC = 'P3BRRND1';
export const E8_CORNER_SHAPES = 200;
export const E8_CORNER_EXPONENTS = Object.freeze([-3, 0] as const);
export const LCG_MULTIPLIER = 6364136223846793005n;
export const LCG_INCREMENT = 1442695040888963407n;
const MASK = (1n << 64n) - 1n;

const MOVE = 0;
const LINE = 1;
const CUBIC = 2;
const CLOSE = 3;

export type E8Shape = 'lens' | 'lens-tangent' | 'wave';

export type E8CornerFamily = Readonly<{
  id: string;
  shape: E8Shape;
  scale: 1 | 10 | 3 | null;
  seed: bigint;
}>;

/** The seven shape families in corpus order, with their LCG seeds. */
export const E8_CORNER_FAMILIES: readonly E8CornerFamily[] = Object.freeze([
  { id: 'lens/1', shape: 'lens', scale: 1, seed: 0xe8c0_0001_0000_0001n },
  { id: 'lens/10', shape: 'lens', scale: 10, seed: 0xe8c0_0001_0000_000an },
  { id: 'lens/3', shape: 'lens', scale: 3, seed: 0xe8c0_0001_0000_0003n },
  { id: 'lens-tangent/1', shape: 'lens-tangent', scale: 1, seed: 0xe8c0_0002_0000_0001n },
  { id: 'lens-tangent/10', shape: 'lens-tangent', scale: 10, seed: 0xe8c0_0002_0000_000an },
  { id: 'lens-tangent/3', shape: 'lens-tangent', scale: 3, seed: 0xe8c0_0002_0000_0003n },
  { id: 'wave', shape: 'wave', scale: null, seed: 0xe8c0_0003_0000_0000n },
]);

export type E8CornerPath = Readonly<{
  rule: 0;
  exponent: number;
  verbs: readonly number[];
  points: readonly number[];
}>;

export class Lcg {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed & MASK;
  }

  /** An integer in [lo, hi] from the high 32 bits of the next state. */
  int(lo: number, hi: number): number {
    this.state = (this.state * LCG_MULTIPLIER + LCG_INCREMENT) & MASK;
    const high = this.state >> 32n;
    return lo + Number((high * BigInt(hi - lo + 1)) >> 32n);
  }
}

type Xy = readonly [number, number];

function lensShape(random: Lcg, tangent: boolean, scale: number): readonly number[] {
  const upperX = tangent
    ? [-100, 100]
    : [random.int(-99, 99), random.int(-99, 99)].sort((a, b) => a - b);
  const upperY = [random.int(-150, -5), random.int(-150, -5)];
  const lowerX = tangent
    ? [100, -100]
    : [random.int(-99, 99), random.int(-99, 99)].sort((a, b) => b - a);
  const lowerY = [random.int(5, 150), random.int(5, 150)];
  const ox = random.int(-500, 500);
  const oy = random.int(-500, 500);
  const map = ([x, y]: Xy): Xy =>
    scale === 1 ? [x + ox, y + oy] : [(x + ox) / scale, (y + oy) / scale];
  const points: Xy[] = [
    [-100, 0],
    [upperX[0]!, upperY[0]!],
    [upperX[1]!, upperY[1]!],
    [100, 0],
    [lowerX[0]!, lowerY[0]!],
    [lowerX[1]!, lowerY[1]!],
    [-100, 0],
  ];
  return points.flatMap((point) => map(point));
}

function waveShape(random: Lcg): readonly number[] {
  const w = 4 * random.int(25, 100);
  const h = random.int(20, 200);
  const a = random.int(-150, 150);
  const p: Xy = [0, -h];
  const q: Xy = [w / 4, -(h + a)];
  const e: Xy = [w / 2, -h];
  const reflected: Xy = [2 * e[0] - q[0], 2 * e[1] - q[1]];
  const end: Xy = [w, -h];
  return [
    0,
    0,
    p[0],
    p[1],
    (p[0] + 2 * q[0]) / 3,
    (p[1] + 2 * q[1]) / 3,
    (e[0] + 2 * q[0]) / 3,
    (e[1] + 2 * q[1]) / 3,
    e[0],
    e[1],
    (e[0] + 2 * reflected[0]) / 3,
    (e[1] + 2 * reflected[1]) / 3,
    (end[0] + 2 * reflected[0]) / 3,
    (end[1] + 2 * reflected[1]) / 3,
    end[0],
    end[1],
    w,
    0,
  ];
}

const LENS_VERBS = Object.freeze([MOVE, CUBIC, CUBIC, CLOSE]);
const WAVE_VERBS = Object.freeze([MOVE, LINE, CUBIC, CUBIC, LINE, CLOSE]);

/** The 200 shapes of one family, in draw order. */
export function generateShapes(family: E8CornerFamily): readonly (readonly number[])[] {
  const random = new Lcg(family.seed);
  const shapes: (readonly number[])[] = [];
  for (let index = 0; index < E8_CORNER_SHAPES; index += 1)
    shapes.push(
      family.shape === 'wave'
        ? waveShape(random)
        : lensShape(random, family.shape === 'lens-tangent', family.scale!),
    );
  return shapes;
}

/** The fourteen frame families: every shape family at e = -3, then at e = 0. */
export function generateE8CornerCorpus(): readonly Readonly<{
  id: string;
  paths: readonly E8CornerPath[];
}>[] {
  return E8_CORNER_FAMILIES.flatMap((family) => {
    const shapes = generateShapes(family);
    const verbs = family.shape === 'wave' ? WAVE_VERBS : LENS_VERBS;
    return E8_CORNER_EXPONENTS.map((exponent) => ({
      id: `${family.id}/e${exponent}`,
      paths: shapes.map((points) => ({ rule: 0 as const, exponent, verbs, points })),
    }));
  });
}

/** The little-endian `P3BRRND1` frame of the corpus. */
export function encodeE8CornerCorpus(corpus = generateE8CornerCorpus()): Uint8Array {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const u32 = (value: number, signed = false) => {
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    if (signed) view.setInt32(0, value, true);
    else view.setUint32(0, value, true);
    return bytes;
  };
  chunks.push(encoder.encode(E8_CORNER_MAGIC), u32(corpus.length));
  for (const { id, paths } of corpus) {
    const name = encoder.encode(id);
    chunks.push(u32(name.length), name, Uint8Array.of(0), u32(paths.length));
    for (const path of paths) {
      chunks.push(Uint8Array.of(path.rule), u32(path.exponent, true));
      chunks.push(u32(path.verbs.length), Uint8Array.from(path.verbs));
      const scalars = new Uint8Array(path.points.length * 8);
      const view = new DataView(scalars.buffer);
      path.points.forEach((value, index) => view.setFloat64(index * 8, value, true));
      chunks.push(u32(path.points.length), scalars);
    }
  }
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
