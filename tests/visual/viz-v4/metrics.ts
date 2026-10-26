// V-4 unit VZ4-U2: per-case A08 metrics (docs/plans/viz-v4-a08-corpus-contract.md, sections 5.1,
// 5.2 and 5.4). One capture of one case and variant is judged against Node's reference: the
// port mesh's `boundaryEdges` mapped to physical pixels by E3's CPU model of the K4 shader
// mapping (tests/geometry/e3-a04/harness.ts: `shaderLanes`, `mapPoint`, `guardBand`, `noFlip`),
// which gives the exact position p* of every vertex and the per-case bound β_c.
//
// Exactness. p* is a dyadic rational per coordinate (E3's `D`). Every p* of the case is scaled
// by one common power of two 2^k (k ≥ 1) to an integer grid, on which pixel centres are integral,
// and every distance, side and inside test is computed in BigInt arithmetic by the O02 primitives
// (`segmentDistanceSquared`, `traverseSegment`, `sectorsOf`, `nearestFeature`, `coverageOf`) or
// by the exact scanline below. β_c is a binary64 upper bound, computed by E3's own rule with every
// rounding directed upward (`a04NextUp`, the harness's f64 slack); it enters the class tests as
// its exact binary64 value (`q64`), so a margin test such as `d − β_c ≥ 2` is the exact rational
// test `d² ≥ (2 + β_c)²`. The only binary64 steps outside β_c are report values: the band
// mean square (`rms`, summed in pixel order, so it is deterministic) and the reported crack-zone
// width, which is printed, never compared; the zone test itself is exact on `0.3953 + 2β_c`.
// The uncertain zone's radius is `β_c` (which includes σ), plus the 4x sample term, tested
// exactly; its canvas-border strip is `betaClip` plus the sample term, also exact.
//
// Contract section 17 (2026-10-25): β_c covers every drawn vertex and triangle (frame corners
// and exterior fringe triangles included) and adds σ; the no-flip certificate is local, per
// drawn triangle, and the edges of every clipped (guard-band crossing) triangle join its zone;
// a sample count above 1 FAILS unconditionally; equal p* are merged before pairing; and E3's
// `beta ≥ 1 px` and `clip bound ≥ 0.25 px`, or a reference winding anomaly, make a case UNDECIDED.
//
// Pixels are judged on the whole canvas: E3-Q11 (a) makes the viewport the guard band and E3's
// Ω is the viewport plus 2 px, so Ω ∩ canvas is the canvas. Distances are taken to the unclipped
// mapped boundary, vertices outside the viewport included.
import type { PathMeshDraw } from '../../../packages/renderer-core/src/path-mesh-pipeline.js';
import {
  DyadicGrid,
  FRINGE_ROLE_EXTERIOR,
  FRINGE_TRIANGLE_WORDS,
  orient,
} from '../../../packages/renderer-core/src/path-fringe.js';
import { a04NextUp } from '../../../packages/geometry-reference/src/a04-region.js';
import type { Crop } from '../../geometry/coverage-oracle/crop.js';
import {
  sectorsOf,
  type DirectedEdge,
  type P,
  type SectorsResult,
} from '../../geometry/coverage-oracle/exterior.js';
import { G1_TOLERANCE, G3_LIMIT_SQUARED } from '../../geometry/coverage-oracle/metrics-o02.js';
import {
  approxNumber,
  ceilDiv,
  exactJson,
  floorDiv,
  q64,
  type ExactJson,
} from '../../geometry/coverage-oracle/numeric.js';
import { traverseSegment } from '../../geometry/coverage-oracle/oracle.js';
import type { CoverageRowGeometry, Q2 } from '../../geometry/coverage-oracle/positions.js';
import {
  coverageOf,
  nearestFeature,
  ruleContext,
  segmentDistanceSquared,
  type RuleContext,
} from '../../geometry/coverage-oracle/rule.js';
import { add, mul, rational, sub, type Rational } from '../../geometry/rounded-fill/exact.js';
import {
  guardBand,
  mapPoint,
  noFlip,
  shaderLanes,
  type Frame,
  type Mapped,
  type MappedPoint,
} from '../../geometry/e3-a04/harness.js';
import { RASTER_SNAP } from '../../geometry/e3-a04/readback.js';

/** The harness's f64 slack on bounds it evaluates in binary64 (E3 section 15.2; not exported). */
const SLACK = 1 + 2 ** -20;
/**
 * σ, E3's rasterizer snapping residual (E3-Q7 (a), `RASTER_SNAP` = √2·2^-5 px, Vulkan's minimum
 * of 4 subpixel bits), rounded upward. β_c adds it (contract section 17).
 */
export const SIGMA = a04NextUp(RASTER_SNAP);
/** E3's case-level UNDECIDED bounds (harness.ts `measureCase`): β_c ≥ 1 px, clip bound ≥ ¼ px. */
export const BETA_LIMIT = 1;
export const CLIP_LIMIT = 0.25;
/** Section 5.2: the 4x crack zone's sample term, `0.3953 + 2β_c` px. */
export const CRACK_SAMPLE_TERM = rational(3953n, 10000n);
/** G1: within 2/255 of the saturated value (O02 `G1_TOLERANCE`). */
export const G1_LIMIT = G1_TOLERANCE;
/** G2: `obs ≥ 128` is classified inside (O02). */
export const G2_THRESHOLD = 128;
/** How many failing or undecided pixels a case lists, per gate. */
const SAMPLE_LIMIT = 8;

// =============================================================================================
// The reference (section 5.1)

/**
 * The reference boundary of one case and variant: the port mesh mapped to p*, on one integer grid
 * of 2^shift units per physical pixel. `geometry` is an O02 row geometry over p* so that O02's
 * distance and rule primitives apply unchanged: its `scaled` are the grid points, `preimage` and
 * `reference` the exact p*, and `boundaryEdges` the port's boundary edges. Its NDC fields are
 * empty, because no O02 primitive that V-4 calls reads them, and an edge's `third` and
 * `triangle` are -1, because the orientation comes from port rule 5 instead (see `directed`).
 */
export type Reference = Readonly<{
  width: number;
  height: number;
  shift: number;
  scale: bigint;
  points: readonly P[];
  geometry: CoverageRowGeometry;
  /**
   * The boundary edges with the region on their left in physical pixels: port rule 5 orients
   * them so in node-local space, and the K4 map keeps that orientation exactly when the
   * determinant of its f32 linear lanes is positive (zoom and DPR are positive).
   */
  directed: readonly DirectedEdge[];
  /** O02's sector pairing on the mapped boundary edges (section 5.1, corners and sectors). */
  sectors: SectorsResult;
  /**
   * Before pairing, port vertices with equal p* are merged into the lowest index and boundary
   * edges that become zero-length are dropped (contract section 17, as E3 exempts collapsed
   * triangles): equal p* means equal stored offsets, so the GPU maps them bit-identically.
   */
  merge: Readonly<{ vertices: number; droppedEdges: number }>;
  /** Port-mesh edges with a mesh vertex in their interior (vertex pairs, a < b). */
  tJunctionEdges: readonly (readonly [number, number])[];
  /**
   * β_c, physical px: E3's composition (the max over every drawn vertex, frame corners included,
   * of β on the vertex and feature paths, plus the clip bound of every drawn triangle) plus σ,
   * each sum rounded upward.
   */
  betaC: number;
  betaVertex: number;
  betaClip: number;
  /** σ as added to β_c. */
  betaSnap: number;
  /**
   * E3's no-flip certificate at β_c, run per drawn triangle: the region triangles and, on a
   * fringe draw, the exterior triangles. `collapsed` triangles are exempt, as in E3.
   */
  noFlip: Readonly<{
    checked: number;
    failed: number;
    collapsed: number;
    exteriorChecked: number;
    exteriorFailed: number;
  }>;
  /**
   * The drawn vertices on the grid of `points`: the port vertices, then on a fringe draw the four
   * mapped frame corners (variant vertices N to N + 3).
   */
  drawnPoints: readonly P[];
  /** The triangles that fail the certificate, as indices into `drawnPoints`. */
  flipped: readonly (readonly [number, number, number])[];
  /**
   * The drawn triangles that cross the guard band (E3's `guardBand` on the one triangle): the GPU
   * clips each with its own new vertices, so their edges are known only within the clip bound
   * and a shared clipped edge may open a hairline crack (E3-Q11 (a), readback.ts `clipCheck`).
   */
  clipped: readonly (readonly [number, number, number])[];
  /** Sign of the determinant of the f32 linear lanes. */
  orientation: 1 | -1;
}>;

function scaledPoints(points: readonly MappedPoint[]): { shift: number; scaled: P[] } {
  let low = -1;
  for (const p of points) for (const c of [p.x, p.y]) if (c.n !== 0n && c.e < low) low = c.e;
  const scaled = points.map((p): P => [
    p.x.n === 0n ? 0n : p.x.n << BigInt(p.x.e - low),
    p.y.n === 0n ? 0n : p.y.n << BigInt(p.y.e - low),
  ]);
  return { shift: -low, scaled };
}

/** Port-mesh edges with a mesh vertex strictly inside them, in exact node-local coordinates. */
export function tJunctionEdges(
  mesh: Readonly<{ positions: Float64Array; indices: Uint32Array }>,
): [number, number][] {
  const grid = new DyadicGrid(Array.from(mesh.positions));
  const count = mesh.positions.length / 2;
  const points: P[] = [];
  for (let v = 0; v < count; v += 1)
    points.push([grid.scale(mesh.positions[2 * v]!), grid.scale(mesh.positions[2 * v + 1]!)]);
  const byX = [...points.keys()].sort((a, b) =>
    points[a]![0] < points[b]![0] ? -1 : points[a]![0] > points[b]![0] ? 1 : a - b,
  );
  const lowerBound = (x: bigint) => {
    let lo = 0;
    let hi = byX.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[byX[mid]!]![0] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const edges = new Set<string>();
  for (let t = 0; t + 2 < mesh.indices.length; t += 3)
    for (let k = 0; k < 3; k += 1) {
      const a = mesh.indices[t + k]!;
      const b = mesh.indices[t + ((k + 1) % 3)]!;
      if (a !== b) edges.add(a < b ? `${a}:${b}` : `${b}:${a}`);
    }
  const out: [number, number][] = [];
  for (const key of [...edges].sort((l, r) => {
    const [la, lb] = l.split(':').map(Number) as [number, number];
    const [ra, rb] = r.split(':').map(Number) as [number, number];
    return la - ra || lb - rb;
  })) {
    const [a, b] = key.split(':').map(Number) as [number, number];
    const pa = points[a]!;
    const pb = points[b]!;
    const [x0, x1] = pa[0] <= pb[0] ? [pa[0], pb[0]] : [pb[0], pa[0]];
    const [y0, y1] = pa[1] <= pb[1] ? [pa[1], pb[1]] : [pb[1], pa[1]];
    for (let s = lowerBound(x0); s < byX.length && points[byX[s]!]![0] <= x1; s += 1) {
      const v = byX[s]!;
      const q = points[v]!;
      if (v === a || v === b || q[1] < y0 || q[1] > y1) continue;
      if ((q[0] === pa[0] && q[1] === pa[1]) || (q[0] === pb[0] && q[1] === pb[1])) continue;
      if (orient(pa, pb, q) === 0n) {
        out.push([a, b]);
        break;
      }
    }
  }
  return out;
}

/** The drawn triangles of a draw: the region mesh, then a fringe draw's exterior triangles. */
function drawnTriangles(
  draw: PathMeshDraw,
  vertices: number,
): { indices: number[]; exterior: number } {
  const indices = Array.from(draw.mesh.indices);
  let exterior = 0;
  if (draw.fringe !== null) {
    const words = draw.fringe.data.triangles;
    for (let r = 0; r + FRINGE_TRIANGLE_WORDS <= words.length; r += FRINGE_TRIANGLE_WORDS) {
      if (words[r + 5] !== FRINGE_ROLE_EXTERIOR) continue;
      const tri = [words[r]!, words[r + 1]!, words[r + 2]!];
      if (tri.some((v) => v >= vertices))
        throw new Error('viz-v4 metrics: fringe triangle index beyond the drawn vertices');
      indices.push(...tri);
      exterior += 1;
    }
  }
  return { indices, exterior };
}

/** Builds the section 5.1 reference from Node's draw of the case (E3's `drawCase`). */
export function buildReference(draw: PathMeshDraw, frame: Frame): Reference {
  const lanes = shaderLanes(draw, frame);
  const mapped: MappedPoint[] = [];
  for (let i = 0; i < draw.offsets.length; i += 2)
    mapped.push(mapPoint(draw.offsets[i]!, draw.offsets[i + 1]!, lanes));
  const portVertices = mapped.length;
  // A fringe draw's frame corners are the variant's vertices N to N + 3, mapped by the same
  // toPhysical as the port offsets (mesh-fill-shader.ts).
  const corners = draw.fringe?.data.corners;
  if (corners !== undefined)
    for (let i = 0; i + 1 < corners.length; i += 2)
      mapped.push(mapPoint(corners[i]!, corners[i + 1]!, lanes));
  const width = frame.width;
  const height = frame.height;
  const drawn = drawnTriangles(draw, mapped.length);
  const model: Mapped = { points: mapped, indices: drawn.indices, width, height };
  // β_c as E3's measureCase composes it, over every drawn vertex and triangle: the max of the
  // vertex-path and feature-path bounds plus the clip model's bound, rounded upward; then σ.
  let betaVertex = 0;
  for (const p of mapped) betaVertex = Math.max(betaVertex, p.betaVertex, p.betaFeature);
  const guard = guardBand(model);
  const betaE3 = a04NextUp((betaVertex + guard.betaClip) * SLACK);
  const betaC = a04NextUp((betaE3 + SIGMA) * SLACK);
  // The certificate per drawn triangle (E3's noFlip on a one-triangle model), so that each
  // failing triangle is known and only its neighbourhood loses the β_c bound.
  let checked = 0;
  let failed = 0;
  let collapsed = 0;
  let exteriorChecked = 0;
  let exteriorFailed = 0;
  const flipped: [number, number, number][] = [];
  const clipped: [number, number, number][] = [];
  const regionCount = draw.mesh.indices.length / 3;
  for (let t = 0; t * 3 + 2 < drawn.indices.length; t += 1) {
    const tri: [number, number, number] = [
      drawn.indices[3 * t]!,
      drawn.indices[3 * t + 1]!,
      drawn.indices[3 * t + 2]!,
    ];
    const one = noFlip({ points: mapped, indices: tri, width, height }, betaC);
    checked += one.checked;
    failed += one.failed;
    collapsed += one.collapsed;
    if (t >= regionCount) {
      exteriorChecked += one.checked;
      exteriorFailed += one.failed;
    }
    if (one.failed > 0) flipped.push(tri);
    if (guardBand({ points: mapped, indices: tri, width, height }).crossing > 0) clipped.push(tri);
  }
  const { shift, scaled: drawnPoints } = scaledPoints(mapped);
  const scaled = drawnPoints.slice(0, portVertices);
  const [l0, l1, l2, l3] = lanes.linear;
  // Each product of two binary32 values is exact in binary64, so the comparison is exact.
  const p = l0 * l3;
  const q = l1 * l2;
  if (p === q) throw new Error('viz-v4 metrics: singular linear lanes');
  const orientation: 1 | -1 = p > q ? 1 : -1;
  // Equal p* are merged into the lowest vertex index; zero-length boundary edges are dropped.
  const representative: number[] = [];
  const first = new Map<string, number>();
  let mergedVertices = 0;
  scaled.forEach(([x, y], v) => {
    const key = `${x},${y}`;
    const seen = first.get(key);
    if (seen === undefined) first.set(key, v);
    else mergedVertices += 1;
    representative.push(seen ?? v);
  });
  const pairs = draw.mesh.boundaryEdges;
  const directed: DirectedEdge[] = [];
  let droppedEdges = 0;
  for (let e = 0; e + 1 < pairs.length; e += 2) {
    const a = representative[pairs[e]!]!;
    const b = representative[pairs[e + 1]!]!;
    if (a === b) {
      droppedEdges += 1;
      continue;
    }
    directed.push(
      orientation > 0 ? { from: a, to: b, edge: e / 2 } : { from: b, to: a, edge: e / 2 },
    );
  }
  const denominator = 1n << BigInt(shift);
  const exact: Q2[] = scaled.map((s) => [rational(s[0], denominator), rational(s[1], denominator)]);
  const triangles: (readonly [number, number, number])[] = [];
  const referenced = new Set<number>();
  for (let t = 0; t + 2 < draw.mesh.indices.length; t += 3) {
    const tri = [draw.mesh.indices[t]!, draw.mesh.indices[t + 1]!, draw.mesh.indices[t + 2]!];
    triangles.push(tri as [number, number, number]);
    for (const v of tri) referenced.add(v);
  }
  const geometry: CoverageRowGeometry = {
    id: draw.nodeId,
    width,
    height,
    triangles,
    referenced: [...referenced].sort((a, b) => a - b),
    reference: exact,
    ndc: [],
    ndcBits: [],
    preimage: exact,
    scaleExponent: shift,
    scaled,
    boundaryEdges: directed.map((d) => ({
      a: Math.min(d.from, d.to),
      b: Math.max(d.from, d.to),
      third: -1,
      triangle: -1,
    })),
    internalEdges: [],
    maxPreimageError: { squared: rational(0n), axis: rational(0n), vertex: -1 },
  };
  return {
    width,
    height,
    shift,
    scale: denominator,
    points: scaled,
    geometry,
    directed,
    sectors: sectorsOf(scaled, directed),
    merge: { vertices: mergedVertices, droppedEdges },
    tJunctionEdges: tJunctionEdges(draw.mesh),
    betaC,
    betaVertex,
    betaClip: guard.betaClip,
    betaSnap: SIGMA,
    noFlip: { checked, failed, collapsed, exteriorChecked, exteriorFailed },
    drawnPoints,
    flipped,
    clipped,
    orientation,
  };
}

// =============================================================================================
// Per-pixel fields: exact distance near the boundary and the exact inside test

type Near = { num: bigint; den: bigint; edges: number[] };

type Field = Readonly<{
  /** Exact squared distance (grid units², num / den) for every pixel within 2 + β_c + ½ px. */
  near: ReadonlyMap<number, Near>;
  /** 1 when the pixel centre is inside the mapped region at p* (winding ≠ 0). */
  inside: Uint8Array;
  /** Pixels whose winding is neither 0 nor the region's ±1 (not a valid region boundary). */
  windingAnomalies: number;
  /** The restricted rule context per pixel needs the full one; null when pairing failed. */
  rule: RuleContext | null;
  vertexSlot: ReadonlyMap<number, number>;
}>;

const fields = new WeakMap<Reference, Field>();

/** Radius in px within which distances are computed exactly: every margin test lies inside. */
function nearRadius(betaC: number): number {
  return Math.max(2, Math.ceil(2 + betaC));
}

function computeField(reference: Reference): Field {
  const cached = fields.get(reference);
  if (cached !== undefined) return cached;
  const { width: W, height: H, scale: S, points } = reference;
  const half = S >> 1n;
  const crop: Crop = { x: 0, y: 0, w: W, h: H };
  const near = new Map<number, Near>();
  const radius = nearRadius(reference.betaC);
  reference.directed.forEach((edge, id) => {
    // One-edge view of the row geometry: segmentDistanceSquared then measures to this segment.
    const single: CoverageRowGeometry = {
      ...reference.geometry,
      boundaryEdges: [reference.geometry.boundaryEdges[id]!],
    };
    traverseSegment(points[edge.from]!, points[edge.to]!, S, crop, radius, (i, j) => {
      const index = j * W + i;
      const [num, den] = segmentDistanceSquared(
        single,
        BigInt(2 * i + 1) * half,
        BigInt(2 * j + 1) * half,
      );
      const entry = near.get(index);
      if (entry === undefined) near.set(index, { num, den, edges: [id] });
      else {
        if (num * entry.den < entry.num * den) {
          entry.num = num;
          entry.den = den;
        }
        entry.edges.push(id);
      }
    });
  });
  // Inside at p*: the winding number of the mapped boundary at each pixel centre, by an exact
  // scanline with the half-open rule min(y) ≤ Y < max(y), as O01's row-span parity.
  const inside = new Uint8Array(W * H);
  let windingAnomalies = 0;
  const rows = new Map<number, number[]>();
  reference.directed.forEach((edge, id) => {
    const ya = points[edge.from]![1];
    const yb = points[edge.to]![1];
    if (ya === yb) return;
    const lo = ya < yb ? ya : yb;
    const hi = ya < yb ? yb : ya;
    const j0 = Math.max(0, Number(floorDiv(lo, S)) - 1);
    const j1 = Math.min(H - 1, Number(floorDiv(hi, S)) + 1);
    for (let j = j0; j <= j1; j += 1) {
      const list = rows.get(j) ?? [];
      list.push(id);
      rows.set(j, list);
    }
  });
  let regionSign = 0;
  const diff = new Int32Array(W);
  for (const [j, ids] of rows) {
    const Y = BigInt(2 * j + 1) * half;
    diff.fill(0);
    let any = false;
    for (const id of ids) {
      const edge = reference.directed[id]!;
      const a = points[edge.from]!;
      const b = points[edge.to]!;
      const lo = a[1] < b[1] ? a[1] : b[1];
      const hi = a[1] < b[1] ? b[1] : a[1];
      if (Y < lo || Y >= hi) continue;
      // Crossing x = num / den; pixel i lies left of it when (2i + 1)·half < x.
      let den = b[1] - a[1];
      let num = a[0] * den + (Y - a[1]) * (b[0] - a[0]);
      if (den < 0n) {
        den = -den;
        num = -num;
      }
      const q = ceilDiv(num, half * den);
      const last = floorDiv(q - 2n, 2n);
      if (last < 0n) continue;
      const slot = last >= BigInt(W - 1) ? W - 1 : Number(last);
      diff[slot]! += b[1] > a[1] ? 1 : -1;
      any = true;
    }
    if (!any) continue;
    let winding = 0;
    for (let i = W - 1; i >= 0; i -= 1) {
      winding += diff[i]!;
      if (winding === 0) continue;
      inside[j * W + i] = 1;
      if (regionSign === 0 && Math.abs(winding) === 1) regionSign = winding;
      if (winding !== regionSign) windingAnomalies += 1;
    }
  }
  let rule: RuleContext | null = null;
  const vertexSlot = new Map<number, number>();
  if (reference.sectors.status === 'OK') {
    rule = ruleContext(reference.geometry, reference.sectors);
    reference.sectors.vertices.forEach((v, slot) => vertexSlot.set(v.vertex, slot));
  }
  const field: Field = { near, inside, windingAnomalies, rule, vertexSlot };
  fields.set(reference, field);
  return field;
}

/**
 * Exact rule coverage (rule.ts) at a pixel whose centre is within 1 px of the boundary. The
 * nearest feature is searched among the edges whose traversal reached the pixel and their
 * endpoints, in their global order: every feature within 1 px is among them (the traversal radius
 * is at least 2 px), so the nearest feature and its tie-break equal the full search's.
 */
function ruleNear(field: Field, reference: Reference, i: number, j: number, entry: Near) {
  const context = field.rule!;
  const ids = [...new Set(entry.edges)].sort((a, b) => a - b);
  const slots = new Set<number>();
  for (const id of ids) {
    const edge = reference.directed[id]!;
    slots.add(field.vertexSlot.get(edge.from)!);
    slots.add(field.vertexSlot.get(edge.to)!);
  }
  const restricted: RuleContext = {
    ...context,
    edges: ids.map((id) => context.edges[id]!),
    vertices: [...slots].sort((a, b) => a - b).map((slot) => context.vertices[slot]!),
  };
  const half = context.scale >> 1n;
  return coverageOf(
    nearestFeature(restricted, BigInt(2 * i + 1) * half, BigInt(2 * j + 1) * half),
    context.scale,
  );
}

// =============================================================================================
// Exact margin thresholds

/** A squared distance threshold in px², or null when the test can never hold. */
type Threshold = Rational | null;

function squared(value: Rational): Rational {
  return mul(value, value);
}

type Thresholds = Readonly<{
  /** d − β ≥ 2 ⇔ d² ≥ (2 + β)². */
  g1Decided: Rational;
  /** d + β ≥ 2 ⇔ d² ≥ (2 − β)², always when β ≥ 2 (null). */
  g1Margin: Threshold;
  /** d + β ≤ 1 ⇔ d² ≤ (1 − β)²; never when β > 1 (null). */
  g2Pass: Threshold;
  /** d − β > 1 ⇔ d² > (1 + β)². */
  g2Fail: Rational;
  /** d − β > 0 ⇔ d² > β². */
  beyondBeta: Rational;
  /** d + β ≤ 0.708 ⇔ d² ≤ (0.708 − β)²; never when β > 0.708 (null). */
  g3Near: Threshold;
}>;

function thresholds(betaC: number): Thresholds {
  const beta = q64(betaC);
  const two = rational(2n);
  const one = rational(1n);
  const limit = rational(708n, 1000n);
  if (squared(limit).n * G3_LIMIT_SQUARED.d !== G3_LIMIT_SQUARED.n * squared(limit).d)
    throw new Error('viz-v4 metrics: G3 limit drifted from O02');
  const nonNegative = (value: Rational): Threshold => (value.n < 0n ? null : squared(value));
  return {
    g1Decided: squared(add(two, beta)),
    g1Margin: nonNegative(sub(two, beta)),
    g2Pass: nonNegative(sub(one, beta)),
    g2Fail: squared(add(one, beta)),
    beyondBeta: squared(beta),
    g3Near: nonNegative(sub(limit, beta)),
  };
}

/** Sign of d² − t with d² = num / (den · S²) px². */
function compareSquared(num: bigint, den: bigint, s2: bigint, t: Rational): number {
  const difference = num * t.d - t.n * den * s2;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

// =============================================================================================
// Report accumulators (section 5.4)

type Fraction = Readonly<{ num: bigint; den: bigint }>;

const less = (a: Fraction, b: Fraction) => a.num * b.den < b.num * a.den;

/** obs − rule statistics of one class: exact extremes, binary64 mean square in pixel order. */
export class DeviationAccumulator {
  count = 0;
  max: Fraction | null = null;
  min: Fraction | null = null;
  sumSquares = 0;

  add(num: bigint, den: bigint, approx: number): void {
    this.count += 1;
    const value = { num, den };
    if (this.max === null || less(this.max, value)) this.max = value;
    if (this.min === null || less(value, this.min)) this.min = value;
    this.sumSquares += approx * approx;
  }

  merge(other: DeviationAccumulator): void {
    if (other.count === 0) return;
    this.count += other.count;
    if (this.max === null || less(this.max, other.max!)) this.max = other.max;
    if (this.min === null || less(other.min!, this.min)) this.min = other.min;
    this.sumSquares += other.sumSquares;
  }

  result(): DeviationReport {
    if (this.count === 0 || this.max === null || this.min === null)
      return { count: 0, max: null, min: null, maxAbs: null, rms: null };
    const negMin = { num: -this.min.num, den: this.min.den };
    const maxAbs = less(this.max, negMin) ? negMin : this.max;
    const json = (f: Fraction) => exactJson(rational(f.num, f.den));
    return {
      count: this.count,
      max: json(this.max),
      min: json(this.min),
      maxAbs: json(maxAbs),
      rms: Math.sqrt(this.sumSquares / this.count).toExponential(5),
    };
  }
}

export type DeviationReport = Readonly<{
  count: number;
  max: ExactJson | null;
  min: ExactJson | null;
  maxAbs: ExactJson | null;
  /** Binary64, approximate (report only). */
  rms: string | null;
}>;

export type RuleAccumulators = Readonly<{
  interior: DeviationAccumulator;
  exterior: DeviationAccumulator;
  band: DeviationAccumulator;
}>;

export function ruleAccumulators(): RuleAccumulators {
  return {
    interior: new DeviationAccumulator(),
    exterior: new DeviationAccumulator(),
    band: new DeviationAccumulator(),
  };
}

// =============================================================================================
// Per-case evaluation (section 5.2)

export type Capture = Readonly<{
  width: number;
  height: number;
  /** The red channel, obs, one byte per pixel. */
  red: Uint8Array;
  /** Integer counts, `samples` per pixel in sample order. */
  counts: Uint16Array;
  samples: number;
}>;

export type Judgment = 'PASS' | 'FAIL' | 'UNDECIDED';
export type PixelRef = Readonly<{ gate: string; i: number; j: number; obs: number }>;

export type CaseMetrics = Readonly<{
  judgment: Judgment;
  /** Why the case is FAIL or UNDECIDED, in a fixed order. */
  reasons: readonly string[];
  betaC: number;
  betaVertex: number;
  betaClip: number;
  betaSnap: number;
  noFlip: Reference['noFlip'];
  /**
   * E3's case-level UNDECIDED reasons (`beta ≥ 1 px`, `clip bound ≥ 0.25 px`) and a mapped
   * boundary winding that is not 0 or ±1 (`reference winding`): no pixel decides, except that a
   * count above 1 still FAILS.
   */
  caseUndecided: readonly string[];
  /**
   * The uncertain zone (contract section 17): pixels whose centre lies within β_c (σ included,
   * plus the 4x sample term 0.3953 px) of an edge of a triangle that fails the certificate or
   * crosses the guard band, and, when any drawn triangle crosses it, within betaClip plus the
   * sample term of the canvas border. Its pixels are not counted by G1, G2, G3's "equal to 1" or
   * VZ4-A5; one that violates any of them is UNDECIDED, by gate. Built whatever the case-level
   * reasons, so that VZ4-A5 never counts its pixels.
   */
  zone: Readonly<{
    radius: number;
    triangles: number;
    clipped: number;
    border: number;
    pixels: number;
    g1: number;
    g2: number;
    g3: number;
  }>;
  boundaryEdges: number;
  merge: Reference['merge'];
  pairing: string;
  windingAnomalies: number;
  tJunctionEdges: number;
  crack: Readonly<{ zoneWidth: number; zonePixels: number; pixels: number }>;
  g1: Readonly<{
    decided: number;
    fail: number;
    undecided: number;
    maxInsideError: number;
    maxOutsideError: number;
  }>;
  g2: Readonly<{ misclassified: number; fail: number; undecided: number }>;
  g3: Readonly<{
    fullPixels: number;
    fullFail: number;
    otherPixels: number;
    otherFail: number;
    /**
     * Pixels with a sample count above 1 anywhere on the canvas, zone, crack and margin pixels
     * included: "at most 1" needs no β and no certificate, so any one FAILS the case (reason
     * `G3-at-most`). `otherFail` is its share outside the "equal to 1" class.
     */
    overCount: number;
    maxCount: number;
  }>;
  /**
   * VZ4-A5's pixel half: pixels inside with d − β_c ≥ 2 whose obs is not 255, crack pixels
   * excluded and counted in `crackExcluded`.
   */
  a5: Readonly<{
    interiorPixels: number;
    violations: number;
    /** Violations that do not decide: the reference winding is not a region boundary. */
    undecided: number;
    crackExcluded: number;
    zoneExcluded: number;
  }>;
  /** The first failing or undecided pixels, per gate. */
  pixels: readonly PixelRef[];
}>;

export type EvaluatedCase = Readonly<{ metrics: CaseMetrics; rule: RuleAccumulators | null }>;

/** The pixels of the crack zone: centres within `width` of a mapped T-junction edge. */
function crackZone(reference: Reference, width: Rational): Set<number> {
  const { width: W, height: H, scale: S, points } = reference;
  const zone = new Set<number>();
  if (reference.tJunctionEdges.length === 0 || width.n === 0n) return zone;
  const half = S >> 1n;
  const s2 = S * S;
  const crop: Crop = { x: 0, y: 0, w: W, h: H };
  const radius = Math.max(1, Math.ceil(approxNumber(width) * SLACK));
  for (const [a, b] of reference.tJunctionEdges) {
    const single: CoverageRowGeometry = {
      ...reference.geometry,
      boundaryEdges: [{ a, b, third: -1, triangle: -1 }],
    };
    traverseSegment(points[a]!, points[b]!, S, crop, radius, (i, j) => {
      const index = j * W + i;
      if (zone.has(index)) return;
      const [num, den] = segmentDistanceSquared(
        single,
        BigInt(2 * i + 1) * half,
        BigInt(2 * j + 1) * half,
      );
      if (compareSquared(num, den, s2, squared(width)) <= 0) zone.add(index);
    });
  }
  return zone;
}

/**
 * The uncertain zone. (1) Pixels whose centre is within `radius` of an edge of a triangle that
 * fails the certificate: a sample farther than every vertex's move from all three edges of an
 * unclipped triangle keeps its containment in it through any motion of the vertices, a flip
 * included, because no edge reaches it on the way; so outside the zone each such triangle covers
 * each sample as at p*. (2) The same for every edge of a clipped triangle, whose edges the GPU
 * rebuilds per triangle (E3's clipCheck leaves those centres out). (3) When any triangle is
 * clipped, the pixels whose centre is within `border` of the canvas border, where the clipped
 * polygon's new frame-edge vertices lie.
 */
function uncertainZone(
  reference: Reference,
  radius: Rational,
  border: Rational,
): { zone: Set<number>; border: number } {
  const { width: W, height: H, scale: S } = reference;
  const zone = new Set<number>();
  const points = reference.drawnPoints;
  const half = S >> 1n;
  const s2 = S * S;
  const crop: Crop = { x: 0, y: 0, w: W, h: H };
  const reach = Math.max(1, Math.ceil(approxNumber(radius) * SLACK));
  const limit = squared(radius);
  const geometry: CoverageRowGeometry = { ...reference.geometry, scaled: points };
  for (const tri of [...reference.flipped, ...reference.clipped])
    for (let k = 0; k < 3; k += 1) {
      // Once every pixel is in the zone (β_c of the canvas size), no edge adds one.
      if (zone.size === W * H) break;
      const a = tri[k]!;
      const b = tri[(k + 1) % 3]!;
      const single: CoverageRowGeometry = {
        ...geometry,
        boundaryEdges: [{ a, b, third: -1, triangle: -1 }],
      };
      traverseSegment(points[a]!, points[b]!, S, crop, reach, (i, j) => {
        const index = j * W + i;
        if (zone.has(index)) return;
        const [num, den] = segmentDistanceSquared(
          single,
          BigInt(2 * i + 1) * half,
          BigInt(2 * j + 1) * half,
        );
        if (compareSquared(num, den, s2, limit) <= 0) zone.add(index);
      });
    }
  let strip = 0;
  if (reference.clipped.length > 0) {
    // Centre i + ½ is within `border` of the border x = 0 when 2i + 1 ≤ 2·border, exactly.
    const within = (k: number) => BigInt(2 * k + 1) * border.d <= 2n * border.n;
    for (let j = 0; j < H; j += 1)
      for (let i = 0; i < W; i += 1)
        if (within(i) || within(W - 1 - i) || within(j) || within(H - 1 - j)) {
          strip += 1;
          zone.add(j * W + i);
        }
  }
  return { zone, border: strip };
}

/**
 * Judges one capture of one case and variant. `sampleCount` is the variant's (1 or 4). With
 * `rule` set, the obs − rule report is accumulated (section 5.4).
 */
export function evaluateCapture(
  reference: Reference,
  capture: Capture,
  sampleCount: 1 | 4,
  options: Readonly<{ rule?: boolean }> = {},
): EvaluatedCase {
  const { width: W, height: H, scale: S, betaC } = reference;
  if (
    capture.width !== W ||
    capture.height !== H ||
    capture.samples !== sampleCount ||
    capture.red.length !== W * H ||
    capture.counts.length !== W * H * sampleCount
  )
    throw new Error(
      `viz-v4 metrics: capture ${capture.width}x${capture.height}x${capture.samples} for a ${W}x${H}x${sampleCount} reference`,
    );
  const field = computeField(reference);
  const t = thresholds(betaC);
  const s2 = S * S;
  const beta = q64(betaC);
  const crackWidth =
    sampleCount === 4 ? add(CRACK_SAMPLE_TERM, mul(rational(2n), beta)) : mul(rational(2n), beta);
  const zone = crackZone(reference, crackWidth);
  const one = rational(1n);
  const rule = options.rule === true ? ruleAccumulators() : null;
  // E3's case-level reasons (harness.ts measureCase), and a boundary that is not a region
  // boundary (E3 section 7.1): no pixel decides, except a count above 1. They decide only the
  // judgment: the zone is built regardless, so VZ4-A5 never counts its pixels.
  const caseUndecided: string[] = [];
  if (betaC >= BETA_LIMIT) caseUndecided.push('beta ≥ 1 px');
  if (reference.betaClip >= CLIP_LIMIT) caseUndecided.push('clip bound ≥ 0.25 px');
  if (field.windingAnomalies > 0) caseUndecided.push('reference winding');
  // The uncertain zone: r = β_c (which includes σ), plus the 4x sample term, since a 4x sample
  // lies up to 0.3953 px from its pixel centre. The border strip has the same width: a clip-plane
  // vertex moves by betaClip and is then snapped by σ, both within β_c.
  const sampleTerm = sampleCount === 4 ? CRACK_SAMPLE_TERM : rational(0n);
  const zoneRadius = add(q64(betaC), sampleTerm);
  const built = uncertainZone(reference, zoneRadius, zoneRadius);
  const noFlipZone = built.zone;
  // With a reference winding anomaly the interior at p* is not known: VZ4-A5 does not decide.
  const a5Open = field.windingAnomalies > 0;

  let crackPixels = 0;
  let g1Decided = 0;
  let g1Fail = 0;
  let g1Undecided = 0;
  let maxInside = 0;
  let maxOutside = 0;
  let misclassified = 0;
  let g2Fail = 0;
  let g2Undecided = 0;
  let fullPixels = 0;
  let fullFail = 0;
  let otherPixels = 0;
  let otherFail = 0;
  let overCount = 0;
  let maxCount = 0;
  let a5Interior = 0;
  let a5CrackExcluded = 0;
  let a5ZoneExcluded = 0;
  let a5Violations = 0;
  let a5Undecided = 0;
  let zoneG1 = 0;
  let zoneG2 = 0;
  let zoneG3 = 0;
  const pixels: PixelRef[] = [];
  const listed = new Map<string, number>();
  const note = (gate: string, i: number, j: number, obs: number) => {
    const seen = listed.get(gate) ?? 0;
    if (seen >= SAMPLE_LIMIT) return;
    listed.set(gate, seen + 1);
    pixels.push({ gate, i, j, obs });
  };

  for (let j = 0; j < H; j += 1)
    for (let i = 0; i < W; i += 1) {
      const index = j * W + i;
      const obs = capture.red[index]!;
      const inside = field.inside[index] === 1;
      const entry = field.near.get(index);
      // Far pixels (not reached by any traversal) have d > 2 + β_c + ½: every "far" test holds.
      const cmp = (threshold: Rational) =>
        entry === undefined ? 1 : compareSquared(entry.num, entry.den, s2, threshold);
      const decided = cmp(t.g1Decided) >= 0;
      const g1Margin = t.g1Margin === null || cmp(t.g1Margin) >= 0;
      const g2Pass = t.g2Pass !== null && entry !== undefined && cmp(t.g2Pass) <= 0;
      const g2FailClass = cmp(t.g2Fail) > 0;
      const beyondBeta = cmp(t.beyondBeta) > 0;
      const g3Near = t.g3Near !== null && entry !== undefined && cmp(t.g3Near) <= 0;

      let allOne = true;
      let anyZero = false;
      let atMostOne = true;
      for (let s = 0; s < sampleCount; s += 1) {
        const count = capture.counts[index * sampleCount + s]!;
        if (count > maxCount) maxCount = count;
        if (count !== 1) allOne = false;
        if (count === 0) anyZero = true;
        if (count > 1) atMostOne = false;
      }
      // G3's "at most 1" at every pixel, with no β and no certificate (contract section 17).
      if (!atMostOne) {
        overCount += 1;
        note('G3-at-most', i, j, obs);
      }
      // A GPU crack (section 5.2, review round 1 S1): in the T-junction zone, inside at p* with
      // d − β_c > 0 (G3's decided-interior "equal to 1" class), and showing a count-0 sample or,
      // where G1 decides (d − β_c ≥ 2), a deficit of more than 2/255. Exterior pixels and the
      // exterior 0.708 px class are never excused.
      const crack =
        zone.has(index) && inside && beyondBeta && (anyZero || (decided && 255 - obs > G1_LIMIT));
      if (crack) crackPixels += 1;

      const error = inside ? 255 - obs : obs;
      const full = !crack && ((inside && beyondBeta) || g3Near);
      if (noFlipZone.has(index)) {
        // In the uncertain zone (near a failing or clipped triangle's edge, or the border strip)
        // the drawn boundary is not known within β_c: a violation of G1, G2 or "equal to 1",
        // reason `no-flip zone`, is UNDECIDED and a compliant pixel is not counted (the margin rule of
        // section 5.2). A crack is still excused as outside the zone.
        if (inside && decided) a5ZoneExcluded += 1;
        if (!crack && (decided || g1Margin) && error > G1_LIMIT) {
          zoneG1 += 1;
          note('G1-zone', i, j, obs);
        }
        if (!crack && obs >= G2_THRESHOLD !== inside && !g2Pass) {
          zoneG2 += 1;
          note('G2-zone', i, j, obs);
        }
        if (full && !allOne) {
          zoneG3 += 1;
          note('G3-zone', i, j, obs);
        }
      } else {
        // VZ4-A5's interior check (reported per variant; the runner applies it to msaa-4x).
        // Crack pixels are excluded as from G1 and G2, since cracks are A01 evidence (section 5.2).
        if (inside && decided) {
          if (crack) a5CrackExcluded += 1;
          else {
            a5Interior += 1;
            if (obs !== 255) {
              if (a5Open) a5Undecided += 1;
              else a5Violations += 1;
            }
          }
        }
        if (!crack) {
          // G1.
          if (decided) {
            g1Decided += 1;
            if (inside) maxInside = Math.max(maxInside, error);
            else maxOutside = Math.max(maxOutside, error);
            if (error > G1_LIMIT) {
              g1Fail += 1;
              note('G1', i, j, obs);
            }
          } else if (g1Margin && error > G1_LIMIT) {
            g1Undecided += 1;
            note('G1-undecided', i, j, obs);
          }
          // G2.
          if (obs >= G2_THRESHOLD !== inside) {
            misclassified += 1;
            if (g2FailClass) {
              g2Fail += 1;
              note('G2', i, j, obs);
            } else if (!g2Pass) {
              g2Undecided += 1;
              note('G2-undecided', i, j, obs);
            }
          }
        }
        // G3: "equal to 1" inside beyond β_c or within 0.708 − β_c; "at most 1" everywhere else,
        // the β_c margins and crack pixels included (counted above for every pixel).
        if (full) {
          fullPixels += 1;
          if (!allOne) {
            fullFail += 1;
            note('G3-equal', i, j, obs);
          }
        } else {
          otherPixels += 1;
          if (!atMostOne) otherFail += 1;
        }
      }
      // obs − rule (report only), classes at p*: band within 1 px, else interior or exterior.
      if (rule !== null) {
        const band = entry !== undefined && compareSquared(entry.num, entry.den, s2, one) <= 0;
        if (band) {
          if (field.rule !== null) {
            const value = ruleNear(field, reference, i, j, entry);
            const num = BigInt(obs) * value.d - 255n * value.n;
            const den = 255n * value.d;
            rule.band.add(num, den, approxNumber(rational(num, den)));
          }
        } else if (inside) rule.interior.add(BigInt(obs - 255), 255n, (obs - 255) / 255);
        else rule.exterior.add(BigInt(obs), 255n, obs / 255);
      }
    }

  const reasons: string[] = [];
  const pairing = reference.sectors.status === 'OK' ? 'OK' : reference.sectors.reason;
  if (pairing !== 'OK') reasons.push(`pairing:${pairing}`);
  if (g1Fail > 0) reasons.push('G1');
  if (g2Fail > 0) reasons.push('G2');
  if (fullFail > 0) reasons.push('G3-equal');
  if (overCount > 0) reasons.push('G3-at-most');
  const failed = reasons.length > 0;
  const uncertified: string[] = [];
  if (g1Undecided > 0) uncertified.push('G1-undecided');
  if (g2Undecided > 0) uncertified.push('G2-undecided');
  if (zoneG1 + zoneG2 + zoneG3 > 0) uncertified.push('no-flip zone');
  // A count above 1 FAILS unconditionally; a case-level reason makes every other gate open; a
  // decided failure outranks a pixel that does not decide.
  const judgment: Judgment =
    overCount > 0
      ? 'FAIL'
      : caseUndecided.length > 0
        ? 'UNDECIDED'
        : failed
          ? 'FAIL'
          : uncertified.length > 0
            ? 'UNDECIDED'
            : 'PASS';
  return {
    metrics: {
      judgment,
      // Under a case-level reason a gate failure other than "at most 1" does not decide: its
      // name is prefixed `open:`.
      reasons: [
        ...(caseUndecided.length > 0
          ? reasons.map((r) => (r === 'G3-at-most' ? r : `open:${r}`))
          : reasons),
        ...caseUndecided,
        ...uncertified,
      ],
      betaC,
      betaVertex: reference.betaVertex,
      betaClip: reference.betaClip,
      betaSnap: reference.betaSnap,
      noFlip: reference.noFlip,
      caseUndecided,
      zone: {
        radius: approxNumber(zoneRadius),
        triangles: reference.flipped.length,
        clipped: reference.clipped.length,
        border: built.border,
        pixels: noFlipZone.size,
        g1: zoneG1,
        g2: zoneG2,
        g3: zoneG3,
      },
      boundaryEdges: reference.directed.length,
      merge: reference.merge,
      pairing,
      windingAnomalies: field.windingAnomalies,
      tJunctionEdges: reference.tJunctionEdges.length,
      crack: { zoneWidth: approxNumber(crackWidth), zonePixels: zone.size, pixels: crackPixels },
      g1: {
        decided: g1Decided,
        fail: g1Fail,
        undecided: g1Undecided,
        maxInsideError: maxInside,
        maxOutsideError: maxOutside,
      },
      g2: { misclassified, fail: g2Fail, undecided: g2Undecided },
      g3: { fullPixels, fullFail, otherPixels, otherFail, overCount, maxCount },
      a5: {
        interiorPixels: a5Interior,
        violations: a5Violations,
        undecided: a5Undecided,
        crackExcluded: a5CrackExcluded,
        zoneExcluded: a5ZoneExcluded,
      },
      pixels,
    },
    rule,
  };
}

// =============================================================================================
// Synthetic captures (VZ4-A8 controls)

/**
 * Test-only: a synthetic capture that renders O02's rule exactly at p*: obs = round(255·c) with
 * c the exact rule coverage within 1 px of the boundary and the saturated inside value elsewhere,
 * and every sample count 1 where the centre is inside or within 1 px of the boundary, else 0.
 */
export function ruleRenderingForTesting(reference: Reference, sampleCount: 1 | 4): Capture {
  const { width: W, height: H, scale: S } = reference;
  const field = computeField(reference);
  if (field.rule === null) throw new Error('viz-v4 metrics: no rule without sector pairing');
  const s2 = S * S;
  const one = rational(1n);
  const red = new Uint8Array(W * H);
  const counts = new Uint16Array(W * H * sampleCount);
  for (let j = 0; j < H; j += 1)
    for (let i = 0; i < W; i += 1) {
      const index = j * W + i;
      const entry = field.near.get(index);
      const inside = field.inside[index] === 1;
      const band = entry !== undefined && compareSquared(entry.num, entry.den, s2, one) <= 0;
      if (band) {
        const c = ruleNear(field, reference, i, j, entry);
        red[index] = Number(floorDiv(2n * 255n * c.n + c.d, 2n * c.d));
      } else red[index] = inside ? 255 : 0;
      if (inside || band) counts.fill(1, index * sampleCount, (index + 1) * sampleCount);
    }
  return { width: W, height: H, red, counts, samples: sampleCount };
}

/** Test-only: the inside flag and the near-boundary flag (d ≤ `px`) of a pixel at p*. */
export function pixelClassForTesting(
  reference: Reference,
  i: number,
  j: number,
  px: number,
): Readonly<{ inside: boolean; within: boolean }> {
  const field = computeField(reference);
  const index = j * reference.width + i;
  const entry = field.near.get(index);
  const s2 = reference.scale * reference.scale;
  return {
    inside: field.inside[index] === 1,
    within: entry !== undefined && compareSquared(entry.num, entry.den, s2, squared(q64(px))) <= 0,
  };
}
