import type { ProjectionInput } from '../mesh-projection/model.js';
import { q } from '../position-certificate/certificate.js';
import { loadFixtureRows, prospectiveRows, termRows } from '../position-certificate/corpus.js';
import { add, compare, div, mul, rational, sub, type Rational } from '../rounded-fill/exact.js';
import type { Q2 } from '../extent-t01/clip.js';
import { INPUT_MAX } from '../extent-t01/core.js';
import { CLASS_A_STRESS_IDS, S_LINEARS, S_SHAPES, syntheticRow } from '../extent-t01/synthetic.js';
import { roundToBinary64 } from '../extent-t01/tile-certificate.js';
import { levelFor, pow2 } from '../extent-t01/tile.js';
import { T_TILE } from './epoch.js';

/**
 * P3.1p T02 class A rows and camera variants (docs/plans/p3-r2-tiling-contract.md, "T02 offline
 * exact evidence", Corpus).
 */

export const CLASS_A_IDS = [...CLASS_A_STRESS_IDS, 'EXT-65536'] as const;
export const VARIANT_KS = [16, 20, 24, 32, 40] as const;

export type ClassARow = Readonly<{ id: string; input: ProjectionInput; s: boolean }>;
export type CameraVariant = Readonly<{
  id: string;
  variantOf: string;
  input: ProjectionInput;
  /** False when the camera exceeds the 2^60 input bound (OUT_OF_DOMAIN). */
  inDomain: boolean;
}>;

/** The three class A rows, then S at zoom 1, DPR 1, both shapes and linear parts, k ∈ VARIANT_KS. */
export function variantBaseRows(): ClassARow[] {
  const fixtures = loadFixtureRows();
  const literals = [...prospectiveRows(), ...termRows()];
  const rows: ClassARow[] = [];
  for (const id of CLASS_A_IDS) {
    const source =
      fixtures.find((row) => row.id === id)?.input ?? literals.find((row) => row.id === id)?.input;
    if (source === undefined) throw new Error(`missing-class-a-row:${id}`);
    rows.push({ id, input: source, s: false });
  }
  for (const shape of S_SHAPES)
    for (const k of VARIANT_KS)
      for (const linear of S_LINEARS) {
        const row = syntheticRow(shape, k, 1, 1, linear);
        if (row === null) continue;
        rows.push({ id: row.id, input: row.input, s: true });
      }
  return rows;
}

/** Boundary edges of the region mesh, directed with the region on the left, sorted by (a, b). */
export function boundaryEdges(input: ProjectionInput): [number, number][] {
  const count = new Map<string, number>();
  const directed: [number, number][] = [];
  const indices = input.mesh.indices;
  for (let offset = 0; offset < indices.length; offset += 3)
    for (let k = 0; k < 3; k += 1) {
      const a = indices[offset + k]!;
      const b = indices[offset + ((k + 1) % 3)]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
      directed.push([a, b]);
    }
  return directed
    .filter(([a, b]) => count.get(a < b ? `${a},${b}` : `${b},${a}`) === 1)
    .sort((p, r) => p[0] - r[0] || p[1] - r[1]);
}

/** camera = RN64(A0·p + e0 − (W/2, H/2)/s0), p exact local. */
export function cameraAt(input: ProjectionInput, p: Q2): [number, number] {
  const [a, b, c, d, e, f] = input.affine.map(q) as [
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  const s0 = mul(q(input.zoom), q(input.dpr));
  const half = (size: number) => div(rational(BigInt(size), 2n), s0);
  const x = sub(add(add(mul(a, p[0]), mul(c, p[1])), e), half(input.width));
  const y = sub(add(add(mul(b, p[0]), mul(d, p[1])), f), half(input.height));
  return [roundToBinary64(x), roundToBinary64(y)];
}

/** Variant ids and cameras for one base row, in contract order: v, e, then g (S only). */
export function cameraVariants(row: ClassARow): CameraVariant[] {
  const input = row.input;
  const points = input.mesh.vertices.map(([x, y]): Q2 => [q(x), q(y)]);
  const make = (suffix: string, p: Q2): CameraVariant => {
    const camera = cameraAt(input, p);
    const inDomain = camera.every(
      (value) => Number.isFinite(value) && compare(q(Math.abs(value)), INPUT_MAX) <= 0,
    );
    return {
      id: `${row.id}/cam:${suffix}`,
      variantOf: row.id,
      input: { ...input, id: `${row.id}/cam:${suffix}`, camera },
      inDomain,
    };
  };
  const variants: CameraVariant[] = [];
  for (const vertex of [...new Set(input.mesh.indices)].sort((p, r) => p - r))
    variants.push(make(`v${vertex}`, points[vertex]!));
  boundaryEdges(input).forEach(([a, b], index) => {
    const pa = points[a]!;
    const pb = points[b]!;
    variants.push(
      make(`e${index}`, [
        div(add(pa[0], pb[0]), rational(2n)),
        div(add(pa[1], pb[1]), rational(2n)),
      ]),
    );
  });
  if (row.s) {
    const L = levelFor(input, T_TILE);
    if (L === null) throw new Error(`no-level:${row.id}`);
    const x0 = points[0]![0];
    const unit = pow2(L);
    const scaled = div(x0, unit);
    let i = scaled.n / scaled.d;
    if (compare(mul(rational(i), unit), x0) <= 0) i += 1n;
    while (compare(mul(rational(i - 1n), unit), x0) > 0) i -= 1n;
    variants.push(make('g', [mul(rational(i), unit), points[0]![1]]));
  }
  return variants;
}

/** The pre-stated sliver exempt ids (contract "Pre-stated hazard"). */
export const SLIVER_EXEMPT_IDS: readonly string[] = [20, 24, 32, 40].flatMap((k) =>
  ['I', 'R15'].map((linear) => `S/TRI/k${k}/z1/d1/${linear}/cam:v1`),
);
