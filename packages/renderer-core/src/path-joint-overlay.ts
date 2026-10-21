import type { FillMesh } from '@vector-studio/contracts';
import {
  DyadicGrid,
  ExactWorkCap,
  FRINGE_ROLE_EXTERIOR,
  FRINGE_ROLE_REGION,
  FRINGE_TRIANGLE_WORDS,
  Unsupported,
  bitLength,
  boxOf,
  boxesWithin,
  buildPathFringeDetailed,
  checkPartitionOver,
  compareAngle,
  countExactTest,
  earClip,
  mergeHoles,
  orient,
  pointInLoop,
  pointTriangleWithin,
  segmentTriangleWithin,
  twiceArea,
  withExactWork,
  type ExactWork,
  type P,
  type PathFringe,
  type Triangle,
} from './path-fringe.js';

// The joint overlay of the P3 B2 ST-U7 addendum (docs/plans/p3-b2-st-u7-joint-coverage-
// addendum.md), unit ST-U7b: the CPU builder of section 4.2 and the composite model of section
// 3.2. The fill draw's triangles (the domain) are re-split along the stroke region's
// boundaryEdges into faces that each lie on one side of the stroke boundary; each overlay
// triangle keeps its parent's fill role and fill list and carries its own stroke role and stroke
// list. Nothing calls it yet: ST-U7c wires it into the path-mesh pipeline and the packet.
//
// D8-interim placement (ST7-Q2 a): this exact TypeScript builder runs beside the fringe builder
// (path-fringe.ts) under the time-bounded exception recorded in
// docs/graphics-engine-architecture.md by ST-U7a. It adds Steiner points, rounded once to
// Float64, and passes an exact partition check; it is removed at the R2/K1 placement decision.
//
// Exactness: every predicate runs on BigInt values. Port positions and the frame corners m + k
// are exact on one dyadic grid; a Steiner point is an exact rational (X / W on that grid) until
// it is rounded, once, to the nearest Float64 per coordinate, except that a point on an
// axis-aligned frame edge keeps the frame's exact coordinate. Faces and stroke roles are decided
// on the unrounded positions; triangulation, the partition check and the stroke lists run on the
// rounded ones. Orientation: node-local, counterclockwise means positive cross, as port rule 5.
//
// Functional evidence only (ST-U7 addendum, evidence label): precision is UNVERIFIED against
// the 0.25 physical-pixel target until B4; the work caps are current-cap estimates (ST7-Q5 a).

/** One paint's served variant: its port mesh and fringe bucket f', or null when region-only. */
export type JointOverlayPaint = Readonly<{ mesh: FillMesh; fringeBucket: number | null }>;

export type JointOverlayInput = Readonly<{ fill: JointOverlayPaint; stroke: JointOverlayPaint }>;

/** ST7-Q5 (a): the current-cap pair of limits per build, re-baselined in ST-U7d. */
export type JointOverlayLimits = Readonly<{ exactTests: number; steinerPoints: number }>;

export const JOINT_OVERLAY_LIMITS: JointOverlayLimits = Object.freeze({
  exactTests: 1_048_576,
  steinerPoints: 4_096,
});

/** Joint triangle record words (addendum section 4.5). */
export const JOINT_TRIANGLE_WORDS = 8;
/** Bit 31 of a joint index: relative to the stroke variant's positions. */
export const JOINT_STROKE_INDEX = 0x8000_0000;
/** Role bits: bit 0 the fill role, bit 1 the stroke role; each 0 region, 1 exterior. */
export const JOINT_ROLE_FILL_EXTERIOR = 1;
export const JOINT_ROLE_STROKE_EXTERIOR = 2;

/** Work counted during one build (ST7-Q5): exact tests after the box prefilter, Steiner points. */
export type JointOverlayWork = Readonly<{ exactTests: number; steinerPoints: number }>;

export type JointOverlay = Readonly<{
  /**
   * K4 offsets u = fround(v - m_F), two binary32 lanes per vertex, from the fill mesh midpoint:
   * the fill variant's vertices (port vertices, then the four frame corners k for a fringed
   * fill), then the Steiner points. A frame-edge Steiner point's exact coordinate packs as k.
   */
  positions: Float32Array;
  /**
   * Joint triangle records, 8 u32 words each: i0, i1, i2 (counterclockwise; bit 31 clear for
   * an index into `positions`, set for a stroke variant vertex index), fillListOffset,
   * fillListCount, strokeListOffset, strokeListCount (relative to `lists`), roles.
   */
  triangles: Uint32Array;
  /**
   * Per triangle its fill list (fill variant feature indices), then its stroke list (stroke
   * variant feature indices), each sorted by (kind, global id).
   */
  lists: Uint32Array;
  /** The first Steiner point's vertex index in `positions`. */
  fillVertices: number;
  steinerPoints: number;
  /** Overlay triangles dropped after the check because their parent was an empty-list exterior. */
  droppedTriangles: number;
  work: JointOverlayWork;
}>;

export type JointOverlayBuildResult =
  | Readonly<{ status: 'built'; overlay: JointOverlay }>
  | Readonly<{ status: 'unsupported'; reason: string; work: JointOverlayWork }>;

/** @internal Test-only seeded defects of ST-A14 (addendum section 5.6). */
export type JointOverlaySeededDefect = 'ST7-D3' | 'ST7-D4' | 'ST7-D5' | 'ST7-D6' | 'ST7-D11';

export type JointOverlayOptions = Readonly<{
  /** Tests may lower the limits; production never does. */
  limits?: Partial<JointOverlayLimits>;
  /** @internal Tests only: a seeded defect of addendum section 5.6. */
  seededDefect?: JointOverlaySeededDefect;
  /**
   * @internal Tests only: false skips the builder's own exact partition check, so a seeded
   * defect reaches the independent oracle. Production always checks.
   */
  selfCheck?: boolean;
}>;

/** @internal What an independent oracle needs to re-check one build (ST-A14). */
export type JointOverlayDetail = Readonly<{
  /** Domain triangles in fill variant indices: region triangles, then every exterior triangle. */
  domain: readonly Triangle[];
  /** Per Steiner point, in vertex order: the domain and stroke edges it lies on, its rounding. */
  steiner: readonly Readonly<{
    domainEdge: readonly [number, number];
    strokeEdge: readonly [number, number];
    /** The rounded Float64 coordinate, or null for the exact frame coordinate. */
    x: number | null;
    y: number | null;
  }>[];
  /** Pre-drop overlay triangles: three joint indices each. */
  triangles: Uint32Array;
  /** Per pre-drop triangle: its domain parent, its face and its role bits. */
  parents: Uint32Array;
  faces: Uint32Array;
  roles: Uint8Array;
  /** Output triangle i is pre-drop triangle kept[i]. */
  kept: Uint32Array;
}>;

class OverlayUnsupported extends Error {}
const fail = (reason: string): never => {
  throw new OverlayUnsupported(reason);
};

/**
 * Builds the joint overlay of one fill variant and one stroke variant (addendum section 4.2).
 * Returns `unsupported` (the renderer state `overlay-unsupported` in ST-U7c) for a failed exact
 * partition check, a triangulator failure, a Steiner point on a sloped outer edge, or a work cap.
 */
export function buildJointOverlay(
  input: JointOverlayInput,
  options: JointOverlayOptions = {},
): JointOverlayBuildResult {
  return buildJointOverlayDetailed(input, options).result;
}

/** @internal The build result with the data an independent oracle re-checks (ST-A14). */
export function buildJointOverlayDetailed(
  input: JointOverlayInput,
  options: JointOverlayOptions = {},
): Readonly<{ result: JointOverlayBuildResult; detail: JointOverlayDetail | null }> {
  const limits = { ...JOINT_OVERLAY_LIMITS, ...options.limits };
  const work: ExactWork = { tests: 0, testLimit: limits.exactTests };
  const builder = new OverlayBuilder(input, limits, options);
  try {
    const built = withExactWork(work, () => builder.run(work));
    return {
      result: {
        status: 'built',
        overlay: Object.freeze({ ...built.overlay, work: builder.work(work) }),
      },
      detail: built.detail,
    };
  } catch (error) {
    let reason: string | null = null;
    if (error instanceof OverlayUnsupported) reason = error.message;
    else if (error instanceof Unsupported) reason = `triangulation:${error.message}`;
    else if (error instanceof ExactWorkCap) reason = 'work-cap:tests';
    if (reason === null) throw error;
    return { result: { status: 'unsupported', reason, work: builder.work(work) }, detail: null };
  }
}

// ---------------------------------------------------------------------------------------------
// The composite model (addendum section 3.2).

/** A premultiplied color (r, g, b, a). */
export type PremultipliedColor = readonly [number, number, number, number];

/** @internal Test-only seeded defects of ST-A13 (addendum section 5.6). */
export type JointCompositeSeededDefect = 'ST7-D1' | 'ST7-D2' | 'ST7-D10';

/**
 * The joint fill draw's output X = o·F'·(1 − S'.a)/(1 − o·S'.a), for the coverage-adjusted
 * premultiplied fill F' = c_F·(f.rgb·f.a, f.a), the coverage-adjusted stroke alpha
 * S'.a = c_S·s.a and the node opacity 0 < o < 1. The stroke draw that follows outputs o·S', so
 * fill-then-stroke source-over gives P + D·(1 − P.a) with P = o·(S' + F'·(1 − S'.a)). The CPU
 * reference model of the shader's formula, in Float64.
 */
export function jointFillComposite(
  fill: PremultipliedColor,
  strokeAlpha: number,
  opacity: number,
  seededDefect?: JointCompositeSeededDefect,
): PremultipliedColor {
  let factor: number;
  if (seededDefect === 'ST7-D1') factor = opacity;
  else if (seededDefect === 'ST7-D2') factor = opacity * (1 - strokeAlpha);
  else if (seededDefect === 'ST7-D10') {
    const swapped = 1 - opacity;
    factor = (swapped * (1 - strokeAlpha)) / (1 - swapped * strokeAlpha);
  } else factor = (opacity * (1 - strokeAlpha)) / (1 - opacity * strokeAlpha);
  return [fill[0] * factor, fill[1] * factor, fill[2] * factor, fill[3] * factor];
}

// ---------------------------------------------------------------------------------------------
// Exact helpers.

/** A homogeneous point (X / W, Y / W) on the build grid, W > 0, in lowest terms. */
type Vertex = {
  X: bigint;
  Y: bigint;
  W: bigint;
  /** Fill variant index (port vertex, or N + corner), or -1. */
  fill: number;
  /** Stroke port vertex index of a stroke boundary vertex, or -1. */
  stroke: number;
  /** Steiner ordinal, or -1. */
  steiner: number;
  /** For a Steiner point on an axis-aligned frame edge: 0 when x is exact, 1 when y is. */
  frameAxis: -1 | 0 | 1;
  /** The k lane of the exact frame coordinate. */
  frameLane: number;
  /** Correctly rounded Float64 coordinates, used only by the conservative spatial prefilter. */
  approx: [number, number];
};

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/**
 * The nearest Float64 to (n / d)·2^exponent, ties to even; d > 0. A result below the normal
 * range is a failure (`steiner-range`) when `strict`, and otherwise ±0, which keeps the
 * approximation monotone for the spatial prefilter.
 */
function roundRational(n: bigint, d: bigint, exponent: number, strict = true): number {
  countExactTest();
  if (n === 0n) return 0;
  const negative = n < 0n;
  const a = negative ? -n : n;
  let k = 54 - (bitLength(a) - bitLength(d));
  const numerator = k >= 0 ? a << BigInt(k) : a;
  const denominator = k >= 0 ? d : d << BigInt(-k);
  let q = numerator / denominator;
  let sticky = numerator % denominator !== 0n;
  while (bitLength(q) > 54) {
    sticky = sticky || (q & 1n) === 1n;
    q >>= 1n;
    k -= 1;
  }
  let mantissa = q >> 1n;
  if ((q & 1n) === 1n && (sticky || (mantissa & 1n) === 1n)) mantissa += 1n;
  let e = exponent + 1 - k;
  if (mantissa === 1n << 53n) {
    mantissa >>= 1n;
    e += 1;
  }
  if (e + 52 > 1023) fail('steiner-range');
  if (e + 52 < -1022) return strict ? fail('steiner-range') : negative ? -0 : 0;
  const half = Math.trunc(e / 2);
  const value = Number(mantissa) * 2 ** half * 2 ** (e - half);
  return negative ? -value : value;
}

function compareFraction(an: bigint, ad: bigint, bn: bigint, bd: bigint): number {
  const left = an * bd;
  const right = bn * ad;
  return left < right ? -1 : left > right ? 1 : 0;
}

type Box64 = readonly [number, number, number, number];

/**
 * A conservative uniform-grid prefilter over Float64 boxes. Every box whose exact extent meets a
 * query's exact extent is visited: cells are monotone in the coordinate, and each query is
 * widened by one cell, which exceeds every rounding of the approximations (the cell is at least
 * 2^-40 of the coordinate magnitude, or there is one cell).
 */
class BoxIndex {
  readonly #origin: readonly [number, number];
  readonly #cell: number;
  readonly #side: number;
  readonly #cells: number[][];
  readonly #stamp: Uint32Array;
  #epoch = 0;

  public constructor(boxes: readonly Box64[], margin: number) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const box of boxes) {
      x0 = Math.min(x0, box[0]);
      y0 = Math.min(y0, box[1]);
      x1 = Math.max(x1, box[2]);
      y1 = Math.max(y1, box[3]);
    }
    const span = Math.max(x1 - x0, y1 - y0);
    const magnitude = Math.max(Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1), margin);
    let side = Math.min(64, Math.max(1, Math.ceil(Math.sqrt(boxes.length))));
    let cell = span / side;
    if (!(cell > magnitude * 2 ** -40) || !Number.isFinite(cell)) {
      side = 1;
      cell = 1;
    }
    this.#origin = [Number.isFinite(x0) ? x0 : 0, Number.isFinite(y0) ? y0 : 0];
    this.#cell = cell;
    this.#side = side;
    this.#cells = Array.from({ length: side * side }, () => []);
    this.#stamp = new Uint32Array(boxes.length);
    boxes.forEach((box, item) => {
      const [i0, j0, i1, j1] = this.#range(box, 0);
      for (let j = j0; j <= j1; j += 1)
        for (let i = i0; i <= i1; i += 1) this.#cells[j * side + i]!.push(item);
    });
  }

  #coordinate(value: number, axis: 0 | 1): number {
    if (this.#side === 1) return 0;
    const index = Math.floor((value - this.#origin[axis]) / this.#cell);
    return Math.min(this.#side - 1, Math.max(0, index));
  }

  #range(box: Box64, widen: number): [number, number, number, number] {
    const clamp = (value: number) => Math.min(this.#side - 1, Math.max(0, value));
    return [
      clamp(this.#coordinate(box[0], 0) - widen),
      clamp(this.#coordinate(box[1], 1) - widen),
      clamp(this.#coordinate(box[2], 0) + widen),
      clamp(this.#coordinate(box[3], 1) + widen),
    ];
  }

  /** Visits every item once whose box may lie within `margin` of `box`, in ascending order. */
  public query(box: Box64, margin: number): number[] {
    this.#epoch += 1;
    if (this.#epoch === 0xffff_ffff) {
      this.#stamp.fill(0);
      this.#epoch = 1;
    }
    const widened: Box64 = [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
    const [i0, j0, i1, j1] = this.#range(widened, 1);
    const found: number[] = [];
    for (let j = j0; j <= j1; j += 1)
      for (let i = i0; i <= i1; i += 1)
        for (const item of this.#cells[j * this.#side + i]!) {
          if (this.#stamp[item] === this.#epoch) continue;
          this.#stamp[item] = this.#epoch;
          found.push(item);
        }
    return found.sort((a, b) => a - b);
  }
}

type DomainTriangle = Readonly<{
  /** Fill variant indices, counterclockwise. */
  v: Triangle;
  role: number;
  list: readonly number[];
}>;

type DomainEdge = {
  readonly a: number;
  readonly b: number;
  /** Interior insertion points, ordered from a to b. */
  points: number[];
  readonly outer: boolean;
  /** For a frame side: 0 for a vertical side (x exact), 1 for a horizontal one. */
  readonly frameAxis: -1 | 0 | 1;
  readonly frameLane: number;
  users: number;
};

type Face = {
  readonly parent: number;
  readonly outer: readonly number[];
  readonly holes: readonly (readonly number[])[];
  role: number;
  readonly split: boolean;
  /** The unrounded triangulation, reused when the face has no Steiner point. */
  readonly unrounded: readonly Triangle[] | null;
};

type StrokeEdge = Readonly<{ from: number; to: number; a: number; b: number }>;

class OverlayBuilder {
  readonly #input: JointOverlayInput;
  readonly #limits: JointOverlayLimits;
  readonly #defect: JointOverlaySeededDefect | undefined;
  readonly #selfCheck: boolean;
  readonly #vertices: Vertex[] = [];
  readonly #byKey = new Map<string, number>();
  readonly #steinerSources: Array<
    Readonly<{ domainEdge: readonly [number, number]; strokeEdge: readonly [number, number] }>
  > = [];
  #steinerCount = 0;
  #exponent = 0;

  public constructor(
    input: JointOverlayInput,
    limits: JointOverlayLimits,
    options: JointOverlayOptions,
  ) {
    this.#input = input;
    this.#limits = limits;
    this.#defect = options.seededDefect;
    this.#selfCheck = options.selfCheck ?? true;
  }

  public work(work: ExactWork): JointOverlayWork {
    return Object.freeze({ exactTests: work.tests, steinerPoints: this.#steinerCount });
  }

  public run(
    work: ExactWork,
  ): Readonly<{ overlay: Omit<JointOverlay, 'work'>; detail: JointOverlayDetail }> {
    const fillMesh = this.#input.fill.mesh;
    const strokeMesh = this.#input.stroke.mesh;
    const portVertices = fillMesh.positions.length / 2;
    const midpoint = {
      x: fillMesh.bounds.minX / 2 + fillMesh.bounds.maxX / 2,
      y: fillMesh.bounds.minY / 2 + fillMesh.bounds.maxY / 2,
    };

    // 1. The domain: region triangles plus every exterior triangle of the pre-drop frame
    // partition, re-run once per build (S-c), or the region triangles of a region-only fill.
    let fringe: PathFringe | null = null;
    let exterior: readonly Triangle[] = [];
    if (this.#input.fill.fringeBucket !== null) {
      const detailed = buildPathFringeDetailed(fillMesh, this.#input.fill.fringeBucket, work);
      if (detailed.result.status !== 'built' || detailed.exterior === null)
        fail(`fill-fringe:${detailed.result.status}`);
      fringe = (detailed.result as Readonly<{ fringe: PathFringe }>).fringe;
      exterior = detailed.exterior!;
    }
    const domain = this.#domainTriangles(fillMesh, fringe, exterior);
    const fillVariantVertices = portVertices + (fringe === null ? 0 : 4);

    // 2. One exact grid for both meshes, the midpoint, the corners and both reaches.
    const kx0 = fringe?.corners[0] ?? 0;
    const ky0 = fringe?.corners[1] ?? 0;
    const kx1 = fringe?.corners[2] ?? 0;
    const ky1 = fringe?.corners[5] ?? 0;
    const rhoFill = this.#input.fill.fringeBucket === null ? 1 : 2 ** this.#input.fill.fringeBucket;
    const rhoStroke =
      this.#input.stroke.fringeBucket === null ? 1 : 2 ** this.#input.stroke.fringeBucket;
    const baseValues = [
      ...fillMesh.positions,
      ...strokeMesh.positions,
      midpoint.x,
      midpoint.y,
      kx0,
      ky0,
      kx1,
      ky1,
      rhoFill,
      rhoStroke,
    ];
    const grid0 = new DyadicGrid(baseValues);
    this.#exponent = grid0.exponent;
    const fillIds: number[] = [];
    for (let vertex = 0; vertex < portVertices; vertex += 1) {
      const id = this.#addVertex(
        grid0.scale(fillMesh.positions[2 * vertex]!),
        grid0.scale(fillMesh.positions[2 * vertex + 1]!),
        1n,
      );
      this.#vertices[id]!.fill = vertex;
      fillIds.push(id);
    }
    if (fringe !== null) {
      const mx = grid0.scale(midpoint.x);
      const my = grid0.scale(midpoint.y);
      const x0 = mx + grid0.scale(kx0);
      const y0 = my + grid0.scale(ky0);
      const x1 = mx + grid0.scale(kx1);
      const y1 = my + grid0.scale(ky1);
      const corners: [bigint, bigint][] = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
      corners.forEach(([x, y], corner) => {
        const id = this.#addVertex(x, y, 1n);
        this.#vertices[id]!.fill = portVertices + corner;
        fillIds.push(id);
      });
    }
    // Stroke boundary vertices; one that coincides with a fill vertex shares its vertex.
    const strokeVertices = [...new Set(strokeMesh.boundaryEdges)].sort((a, b) => a - b);
    const strokeIds = new Map<number, number>();
    for (const s of strokeVertices) {
      const X = grid0.scale(strokeMesh.positions[2 * s]!);
      const Y = grid0.scale(strokeMesh.positions[2 * s + 1]!);
      const existing = this.#byKey.get(`${X}:${Y}`);
      if (existing !== undefined) {
        const vertex = this.#vertices[existing]!;
        if (vertex.stroke >= 0) fail(`stroke-duplicate:${vertex.stroke}:${s}`);
        vertex.stroke = s;
        strokeIds.set(s, existing);
      } else {
        const id = this.#addVertex(X, Y, 1n);
        this.#vertices[id]!.stroke = s;
        strokeIds.set(s, id);
      }
    }
    const strokeEdges: StrokeEdge[] = [];
    for (let slot = 0; slot < strokeMesh.boundaryEdges.length; slot += 2) {
      const from = strokeMesh.boundaryEdges[slot]!;
      const to = strokeMesh.boundaryEdges[slot + 1]!;
      strokeEdges.push({ from, to, a: strokeIds.get(from)!, b: strokeIds.get(to)! });
    }
    const point0 = (id: number): P => {
      const v = this.#vertices[id]!;
      return [v.X, v.Y];
    };
    const strokeBoxes0 = strokeEdges.map((edge) => boxOf([point0(edge.a), point0(edge.b)]));
    const strokeIndex = new BoxIndex(
      strokeEdges.map((edge) => this.#approxBox([edge.a, edge.b])),
      0,
    );
    const strokeBands = new BoxIndex(
      strokeEdges.map((edge) => {
        const box = this.#approxBox([edge.a, edge.b]);
        return [0, box[1], 0, box[3]] as const;
      }),
      0,
    );

    // 3. Domain edges and their insertion points, computed once per edge.
    const edges = new Map<string, DomainEdge>();
    const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
    const outerKeys = new Map<string, -1 | 0 | 1>();
    const outerLanes = new Map<string, number>();
    const outerPairs: [number, number][] = [];
    if (fringe !== null) {
      for (let corner = 0; corner < 4; corner += 1) {
        const a = fillIds[portVertices + corner]!;
        const b = fillIds[portVertices + ((corner + 1) % 4)]!;
        outerPairs.push([a, b]);
        // Sides (x0,y0)-(x1,y0) and (x1,y1)-(x0,y1) are horizontal; the others vertical.
        const axis = corner % 2 === 0 ? 1 : 0;
        outerKeys.set(edgeKey(a, b), axis);
        outerLanes.set(edgeKey(a, b), [ky0, kx1, ky1, kx0][corner]!);
      }
    } else {
      for (let slot = 0; slot < fillMesh.boundaryEdges.length; slot += 2) {
        const a = fillIds[fillMesh.boundaryEdges[slot]!]!;
        const b = fillIds[fillMesh.boundaryEdges[slot + 1]!]!;
        outerPairs.push([a, b]);
        outerKeys.set(edgeKey(a, b), -1);
      }
    }
    for (const triangle of domain)
      for (let side = 0; side < 3; side += 1) {
        const a = fillIds[triangle.v[side]!]!;
        const b = fillIds[triangle.v[(side + 1) % 3]!]!;
        const key = edgeKey(a, b);
        if (edges.has(key)) continue;
        const axis = outerKeys.get(key);
        edges.set(key, {
          a: Math.min(a, b),
          b: Math.max(a, b),
          points: [],
          outer: axis !== undefined,
          frameAxis: axis ?? -1,
          frameLane: outerLanes.get(key) ?? 0,
          users: 0,
        });
      }
    for (const edge of edges.values())
      this.#insertionPoints(edge, strokeEdges, strokeBoxes0, strokeIndex);

    // 4. Faces of every domain triangle, with exact stroke roles from unrounded positions.
    const faces: Face[] = [];
    domain.forEach((triangle, parent) => {
      const ids = [0, 1, 2].map((corner) => fillIds[triangle.v[corner]!]!) as unknown as Triangle;
      faces.push(
        ...this.#faces(
          parent,
          ids,
          edges,
          edgeKey,
          strokeEdges,
          strokeBoxes0,
          strokeIndex,
          strokeBands,
        ),
      );
    });
    if (this.#defect === 'ST7-D4') {
      const target = faces.find((face) => face.split);
      if (target !== undefined) target.role ^= 1;
    }

    // 5. Round each Steiner point once, then one final grid for every drawn position.
    const steinerValues: number[] = [];
    for (const vertex of this.#vertices) {
      if (vertex.steiner < 0) continue;
      const x = vertex.frameAxis === 0 ? null : roundRational(vertex.X, vertex.W, this.#exponent);
      const y = vertex.frameAxis === 1 ? null : roundRational(vertex.Y, vertex.W, this.#exponent);
      if (x !== null) steinerValues.push(x);
      if (y !== null) steinerValues.push(y);
      vertex.approx = [
        x ?? roundRational(vertex.X, vertex.W, this.#exponent, false),
        y ?? roundRational(vertex.Y, vertex.W, this.#exponent, false),
      ];
    }
    const grid1 = new DyadicGrid([...baseValues, ...steinerValues]);
    const shift = BigInt(grid0.exponent - grid1.exponent);
    const points1: P[] = this.#vertices.map((vertex) => {
      if (vertex.steiner < 0) return [vertex.X << shift, vertex.Y << shift];
      // A frame-edge point keeps the frame's exact coordinate X / W = the corner's grid integer.
      const x =
        vertex.frameAxis === 0 ? (vertex.X / vertex.W) << shift : grid1.scale(vertex.approx[0]);
      const y =
        vertex.frameAxis === 1 ? (vertex.Y / vertex.W) << shift : grid1.scale(vertex.approx[1]);
      return [x, y];
    });

    // 6. Triangulate each face on the rounded positions.
    const preDrop: Array<{ ids: Triangle; parent: number; face: number; roles: number }> = [];
    faces.forEach((face, faceIndex) => {
      const hasSteiner =
        face.outer.some((id) => this.#vertices[id]!.steiner >= 0) ||
        face.holes.some((hole) => hole.some((id) => this.#vertices[id]!.steiner >= 0));
      let triangles: readonly Triangle[];
      if (!face.split) triangles = [face.outer as unknown as Triangle];
      else if (!hasSteiner && face.unrounded !== null) triangles = face.unrounded;
      else triangles = earClip(points1, mergeHoles(points1, face.outer, face.holes));
      const fillRole =
        domain[face.parent]!.role === FRINGE_ROLE_EXTERIOR ? JOINT_ROLE_FILL_EXTERIOR : 0;
      const roles = fillRole | (face.role === 1 ? JOINT_ROLE_STROKE_EXTERIOR : 0);
      for (const ids of triangles)
        preDrop.push({ ids, parent: face.parent, face: faceIndex, roles });
    });
    if (this.#defect === 'ST7-D3') {
      const victim = preDrop.findIndex((triangle) => faces[triangle.face]!.split);
      if (victim >= 0) preDrop.splice(victim, 1);
    }

    // 7. O02's exact partition check over the domain boundary multiset, subdivided.
    if (this.#selfCheck) {
      for (const { ids } of preDrop)
        if (orient(points1[ids[0]]!, points1[ids[1]]!, points1[ids[2]]!) <= 0n)
          fail('partition:orientation');
      const boundary: [number, number][] = [];
      for (const [a, b] of outerPairs) {
        const edge = edges.get(edgeKey(a, b));
        if (edge === undefined) fail('partition:boundary-edge');
        const chain = [edge!.a, ...edge!.points, edge!.b];
        for (let i = 0; i + 1 < chain.length; i += 1) boundary.push([chain[i]!, chain[i + 1]!]);
      }
      let area = 0n;
      if (fringe !== null) area = twiceArea(points1, fillIds.slice(portVertices, portVertices + 4));
      else
        for (const [a, b] of outerPairs) {
          const p = points1[a]!;
          const q = points1[b]!;
          area += p[0] * q[1] - p[1] * q[0];
        }
      const failed = checkPartitionOver(
        points1,
        preDrop.map((triangle) => triangle.ids),
        boundary,
        area,
        'boundary-edge',
      );
      if (failed !== null) fail(`partition:${failed}`);
    }

    // 8. Drop the pieces of empty-list exterior parents, then lists and records.
    const kept: number[] = [];
    preDrop.forEach((triangle, index) => {
      const parent = domain[triangle.parent]!;
      if (parent.role === FRINGE_ROLE_EXTERIOR && parent.list.length === 0) return;
      kept.push(index);
    });
    const strokeList = this.#strokeLister(strokeEdges, strokeIds, points1, grid1);
    const outputIndex = (id: number): number => {
      const vertex = this.#vertices[id]!;
      if (vertex.stroke >= 0) return (JOINT_STROKE_INDEX | vertex.stroke) >>> 0;
      if (vertex.fill >= 0) return vertex.fill;
      return fillVariantVertices + vertex.steiner;
    };
    const triangles = new Uint32Array(kept.length * JOINT_TRIANGLE_WORDS);
    const listParts: number[][] = [];
    let listOffset = 0;
    kept.forEach((index, slot) => {
      const triangle = preDrop[index]!;
      const fillList = domain[triangle.parent]!.list;
      const strokeListOf = strokeList(triangle.ids);
      const at = slot * JOINT_TRIANGLE_WORDS;
      triangles[at] = outputIndex(triangle.ids[0]);
      triangles[at + 1] = outputIndex(triangle.ids[1]);
      triangles[at + 2] = outputIndex(triangle.ids[2]);
      triangles[at + 3] = listOffset;
      triangles[at + 4] = fillList.length;
      triangles[at + 5] = listOffset + fillList.length;
      triangles[at + 6] = strokeListOf.length;
      triangles[at + 7] = triangle.roles;
      listParts.push([...fillList], strokeListOf);
      listOffset += fillList.length + strokeListOf.length;
    });
    const lists = new Uint32Array(listOffset);
    let cursor = 0;
    for (const part of listParts) {
      lists.set(part, cursor);
      cursor += part.length;
    }

    // Positions: the fill variant's vertices, then the Steiner points, as K4 offsets.
    const positions = new Float32Array(2 * (fillVariantVertices + this.#steinerCount));
    for (let vertex = 0; vertex < portVertices; vertex += 1) {
      positions[2 * vertex] = fillMesh.positions[2 * vertex]! - midpoint.x;
      positions[2 * vertex + 1] = fillMesh.positions[2 * vertex + 1]! - midpoint.y;
    }
    if (fringe !== null) positions.set(fringe.corners, 2 * portVertices);
    const steinerDetail: Array<JointOverlayDetail['steiner'][number]> = [];
    for (const vertex of this.#vertices) {
      if (vertex.steiner < 0) continue;
      const at = 2 * (fillVariantVertices + vertex.steiner);
      positions[at] = vertex.frameAxis === 0 ? vertex.frameLane : vertex.approx[0] - midpoint.x;
      positions[at + 1] = vertex.frameAxis === 1 ? vertex.frameLane : vertex.approx[1] - midpoint.y;
      const source = this.#steinerSources[vertex.steiner]!;
      steinerDetail[vertex.steiner] = Object.freeze({
        domainEdge: source.domainEdge,
        strokeEdge: source.strokeEdge,
        x: vertex.frameAxis === 0 ? null : vertex.approx[0],
        y: vertex.frameAxis === 1 ? null : vertex.approx[1],
      });
    }
    if (!positions.every(Number.isFinite)) fail('packing-range');

    const detailTriangles = new Uint32Array(preDrop.length * 3);
    preDrop.forEach((triangle, index) => {
      detailTriangles[3 * index] = outputIndex(triangle.ids[0]);
      detailTriangles[3 * index + 1] = outputIndex(triangle.ids[1]);
      detailTriangles[3 * index + 2] = outputIndex(triangle.ids[2]);
    });
    const overlay: Omit<JointOverlay, 'work'> = Object.freeze({
      positions,
      triangles,
      lists,
      fillVertices: fillVariantVertices,
      steinerPoints: this.#steinerCount,
      droppedTriangles: preDrop.length - kept.length,
    });
    const detail: JointOverlayDetail = Object.freeze({
      domain: domain.map((triangle) => triangle.v),
      steiner: steinerDetail,
      triangles: detailTriangles,
      parents: Uint32Array.from(preDrop, (triangle) => triangle.parent),
      faces: Uint32Array.from(preDrop, (triangle) => triangle.face),
      roles: Uint8Array.from(preDrop, (triangle) => triangle.roles),
      kept: Uint32Array.from(kept),
    });
    return { overlay, detail };
  }

  #domainTriangles(
    mesh: FillMesh,
    fringe: PathFringe | null,
    exterior: readonly Triangle[],
  ): DomainTriangle[] {
    const domain: DomainTriangle[] = [];
    const listAt = (record: number): number[] => {
      if (fringe === null) return [];
      const at = record * FRINGE_TRIANGLE_WORDS;
      const offset = fringe.triangles[at + 3]!;
      return Array.from(fringe.lists.subarray(offset, offset + fringe.triangles[at + 4]!));
    };
    const regionCount = mesh.indices.length / 3;
    for (let t = 0; t < regionCount; t += 1)
      domain.push({
        v: [mesh.indices[3 * t]!, mesh.indices[3 * t + 1]!, mesh.indices[3 * t + 2]!],
        role: FRINGE_ROLE_REGION,
        list: listAt(t),
      });
    // Kept exterior records follow the region records in exterior order; the rest were dropped.
    let record = regionCount;
    const records = fringe === null ? 0 : fringe.triangles.length / FRINGE_TRIANGLE_WORDS;
    for (const triangle of exterior) {
      let list: number[] = [];
      if (record < records) {
        const at = record * FRINGE_TRIANGLE_WORDS;
        const t = fringe!.triangles;
        if (t[at] === triangle[0] && t[at + 1] === triangle[1] && t[at + 2] === triangle[2]) {
          list = listAt(record);
          record += 1;
        }
      }
      domain.push({ v: triangle, role: FRINGE_ROLE_EXTERIOR, list });
    }
    if (fringe !== null && record !== records) fail('fill-fringe:records');
    return domain;
  }

  #addVertex(X: bigint, Y: bigint, W: bigint): number {
    const id = this.#vertices.length;
    this.#vertices.push({
      X,
      Y,
      W,
      fill: -1,
      stroke: -1,
      steiner: -1,
      frameAxis: -1,
      frameLane: 0,
      approx: [
        roundRational(X, W, this.#exponent, false),
        roundRational(Y, W, this.#exponent, false),
      ],
    });
    const key = W === 1n ? `${X}:${Y}` : `${X}:${Y}/${W}`;
    if (!this.#byKey.has(key)) this.#byKey.set(key, id);
    return id;
  }

  #lookup(X: bigint, Y: bigint, W: bigint): number | undefined {
    const g = gcd(gcd(X, Y), W);
    const x = X / g;
    const y = Y / g;
    const w = W / g;
    return this.#byKey.get(w === 1n ? `${x}:${y}` : `${x}:${y}/${w}`);
  }

  #approxBox(ids: readonly number[]): Box64 {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of ids) {
      const [x, y] = this.#vertices[id]!.approx;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return [x0, y0, x1, y1];
  }

  /**
   * Section 4.2 step 1: every point where a stroke boundary edge meets the domain edge. A proper
   * crossing is a Steiner point; a stroke vertex on the edge's interior (also as the endpoint of
   * a collinear stroke edge) is that vertex; a meeting at an endpoint of the edge adds nothing.
   */
  #insertionPoints(
    edge: DomainEdge,
    strokeEdges: readonly StrokeEdge[],
    strokeBoxes: readonly (readonly [bigint, bigint, bigint, bigint])[],
    index: BoxIndex,
  ): void {
    const vertex = (id: number): P => [this.#vertices[id]!.X, this.#vertices[id]!.Y];
    const a = vertex(edge.a);
    const b = vertex(edge.b);
    const box = boxOf([a, b]);
    const found = new Set<number>();
    const strictlyInside = (p: P) =>
      !(p[0] === a[0] && p[1] === a[1]) &&
      !(p[0] === b[0] && p[1] === b[1]) &&
      p[0] >= (a[0] < b[0] ? a[0] : b[0]) &&
      p[0] <= (a[0] < b[0] ? b[0] : a[0]) &&
      p[1] >= (a[1] < b[1] ? a[1] : b[1]) &&
      p[1] <= (a[1] < b[1] ? b[1] : a[1]);
    for (const s of index.query(this.#approxBox([edge.a, edge.b]), 0)) {
      if (!boxesWithin(strokeBoxes[s]!, box, 0n)) continue;
      countExactTest();
      const stroke = strokeEdges[s]!;
      const c = vertex(stroke.a);
      const d = vertex(stroke.b);
      const o1 = orient(a, b, c);
      const o2 = orient(a, b, d);
      if (o1 === 0n && strictlyInside(c)) found.add(stroke.a);
      if (o2 === 0n && strictlyInside(d)) found.add(stroke.b);
      if (o1 === 0n || o2 === 0n || o1 > 0n === o2 > 0n) continue;
      const o3 = orient(c, d, a);
      const o4 = orient(c, d, b);
      if (o3 === 0n || o4 === 0n || o3 > 0n === o4 > 0n) continue;
      // A proper crossing: p = a + (b - a)·o3 / (o3 - o4).
      let W = o3 - o4;
      let tn = o3;
      if (W < 0n) {
        W = -W;
        tn = -tn;
      }
      let X = a[0] * W + (b[0] - a[0]) * tn;
      let Y = a[1] * W + (b[1] - a[1]) * tn;
      const g = gcd(gcd(X, Y), W);
      X /= g;
      Y /= g;
      W /= g;
      const existing = this.#lookup(X, Y, W);
      if (existing !== undefined) {
        found.add(existing);
        continue;
      }
      // Section 4.2 step 6 (ST7-Q8 a): a sloped outer edge cannot keep a rounded point exactly.
      if (edge.outer && edge.frameAxis < 0 && a[0] !== b[0] && a[1] !== b[1])
        fail('sloped-outer-edge');
      found.add(this.#addSteiner(X, Y, W, edge, stroke));
    }
    const axis =
      (a[0] > b[0] ? a[0] - b[0] : b[0] - a[0]) >= (a[1] > b[1] ? a[1] - b[1] : b[1] - a[1])
        ? 0
        : 1;
    const ascending = b[axis] > a[axis];
    edge.points = [...found].sort((left, right) => {
      countExactTest();
      const p = this.#vertices[left]!;
      const q = this.#vertices[right]!;
      const order = compareFraction(axis === 0 ? p.X : p.Y, p.W, axis === 0 ? q.X : q.Y, q.W);
      return ascending ? order : -order;
    });
  }

  #addSteiner(X: bigint, Y: bigint, W: bigint, edge: DomainEdge, stroke: StrokeEdge): number {
    if (this.#steinerCount >= this.#limits.steinerPoints) fail('work-cap:steiner');
    const id = this.#addVertex(X, Y, W);
    const vertex = this.#vertices[id]!;
    vertex.steiner = this.#steinerCount;
    vertex.frameAxis = edge.frameAxis;
    vertex.frameLane = edge.frameLane;
    this.#steinerSources.push(
      Object.freeze({
        domainEdge: [this.#vertices[edge.a]!.fill, this.#vertices[edge.b]!.fill] as const,
        strokeEdge: [stroke.from, stroke.to] as const,
      }),
    );
    this.#steinerCount += 1;
    return id;
  }

  /** ST7-D6 only: a second, separately rounded copy of a Steiner point. */
  #cloneSteiner(id: number): number {
    if (this.#steinerCount >= this.#limits.steinerPoints) fail('work-cap:steiner');
    const original = this.#vertices[id]!;
    const clone = this.#vertices.length;
    this.#vertices.push({ ...original, approx: [...original.approx], steiner: this.#steinerCount });
    this.#steinerSources.push(this.#steinerSources[original.steiner]!);
    this.#steinerCount += 1;
    return clone;
  }

  /**
   * Section 4.2 steps 2, 3 and the stroke role: one face with its parent's data, or the faces of
   * the exact arrangement of the triangle's subdivided edges with the clipped stroke edges.
   */
  #faces(
    parent: number,
    ids: Triangle,
    edges: Map<string, DomainEdge>,
    edgeKey: (a: number, b: number) => string,
    strokeEdges: readonly StrokeEdge[],
    strokeBoxes: readonly (readonly [bigint, bigint, bigint, bigint])[],
    index: BoxIndex,
    bands: BoxIndex,
  ): Face[] {
    const vertex = (id: number): P => [this.#vertices[id]!.X, this.#vertices[id]!.Y];
    const corners = [vertex(ids[0]), vertex(ids[1]), vertex(ids[2])] as const;
    const box = boxOf(corners);
    // Clipped stroke pieces: the part of each stroke edge inside the closed triangle.
    const pieces: [number, number][] = [];
    for (const s of index.query(this.#approxBox(ids), 0)) {
      if (!boxesWithin(strokeBoxes[s]!, box, 0n)) continue;
      countExactTest();
      const stroke = strokeEdges[s]!;
      const piece = this.#clip(vertex(stroke.a), vertex(stroke.b), corners);
      if (piece !== null) pieces.push(piece);
    }
    // The triangle's edges subdivided at their insertion points, counterclockwise.
    const alias = new Map<number, number>();
    const pieceEnds = new Set(pieces.flat());
    const chain: number[] = [];
    let inserted = false;
    for (let side = 0; side < 3; side += 1) {
      const from = ids[side]!;
      const to = ids[(side + 1) % 3]!;
      const edge = edges.get(edgeKey(from, to))!;
      edge.users += 1;
      let points = from === edge.a ? edge.points : [...edge.points].reverse();
      // ST7-D11: a point goes only to the triangles that the stroke edge enters.
      if (this.#defect === 'ST7-D11') points = points.filter((id) => pieceEnds.has(id));
      if (edge.users === 2 && this.#defect === 'ST7-D6')
        for (const id of points)
          if (this.#vertices[id]!.steiner >= 0) alias.set(id, this.#cloneSteiner(id));
      chain.push(from, ...points);
      if (points.length > 0) inserted = true;
    }
    if (!inserted && pieces.length === 0) {
      // One face with its parent's data; its stroke role from the exact centroid.
      const X = corners[0][0] + corners[1][0] + corners[2][0];
      const Y = corners[0][1] + corners[1][1] + corners[2][1];
      const role = this.#strokeRole(X, Y, 3n, strokeEdges, bands);
      return [{ parent, outer: ids, holes: [], role, split: false, unrounded: null }];
    }
    const mapped = (id: number) => alias.get(id) ?? id;
    const local = [...new Set([...chain.map(mapped), ...pieces.flat().map(mapped)])];
    const localOf = new Map(local.map((id, i) => [id, i]));
    // One exact integer grid for this triangle's unrounded points: the lcm of their W.
    let lcm = 1n;
    for (const id of local) {
      const W = this.#vertices[id]!.W;
      lcm = (lcm / gcd(lcm, W)) * W;
    }
    const points: P[] = local.map((id) => {
      const v = this.#vertices[id]!;
      const scale = lcm / v.W;
      return [v.X * scale, v.Y * scale];
    });
    const undirected = new Map<string, [number, number]>();
    const addEdge = (p: number, q: number) => {
      if (p === q) fail('arrangement:zero-edge');
      const key = p < q ? `${p}:${q}` : `${q}:${p}`;
      if (!undirected.has(key)) undirected.set(key, [p, q]);
    };
    for (let i = 0; i < chain.length; i += 1)
      addEdge(
        localOf.get(mapped(chain[i]!))!,
        localOf.get(mapped(chain[(i + 1) % chain.length]!))!,
      );
    for (const [p, q] of pieces) addEdge(localOf.get(mapped(p))!, localOf.get(mapped(q))!);
    const cycles = this.#cycles(points, [...undirected.values()]);
    // The cycle that runs the triangle's boundary clockwise is the outside; other negative
    // cycles are holes, positive cycles are faces.
    const first = localOf.get(mapped(chain[0]!))!;
    const second = localOf.get(mapped(chain[1]!))!;
    const outsideIndex = cycles.findIndex((cycle) =>
      cycle.some((v, i) => v === second && cycle[(i + 1) % cycle.length] === first),
    );
    if (outsideIndex < 0) fail('arrangement:outside');
    const areas = cycles.map((cycle) => twiceArea(points, cycle));
    if (areas[outsideIndex]! >= 0n) fail('arrangement:outside-orientation');
    const positive: number[] = [];
    const holes: number[] = [];
    cycles.forEach((_, i) => {
      if (i === outsideIndex) return;
      if (areas[i] === 0n) fail('arrangement:zero-area');
      (areas[i]! > 0n ? positive : holes).push(i);
    });
    const holesOf = new Map<number, number[]>(positive.map((i) => [i, []]));
    for (const h of holes) {
      const v = points[cycles[h]![0]!]!;
      const probe: P = [2n * v[0], 2n * v[1]];
      let best = -1;
      for (const f of positive) {
        for (let edge = 0; edge < cycles[f]!.length; edge += 1) countExactTest();
        if (pointInLoop(points, cycles[f]!, probe) !== 1) continue;
        if (best < 0 || areas[f]! < areas[best]!) best = f;
      }
      if (best < 0) fail('arrangement:hole');
      holesOf.get(best)!.push(h);
    }
    const toGlobal = (cycle: readonly number[]) => cycle.map((i) => local[i]!);
    const faces: Face[] = [];
    for (const f of positive) {
      const outer = cycles[f]!;
      const faceHoles = holesOf.get(f)!.map((h) => cycles[h]!);
      // An exact interior point of the unrounded face: the centroid of one of its triangles.
      const unrounded =
        outer.length === 3 && faceHoles.length === 0
          ? [outer as unknown as Triangle]
          : earClip(points, mergeHoles(points, outer, faceHoles));
      const [p, q, r] = unrounded[0]!.map((i) => points[i]!) as unknown as [P, P, P];
      const role = this.#strokeRole(
        p[0] + q[0] + r[0],
        p[1] + q[1] + r[1],
        3n * lcm,
        strokeEdges,
        bands,
      );
      faces.push({
        parent,
        outer: toGlobal(outer),
        holes: faceHoles.map(toGlobal),
        role,
        split: true,
        unrounded: unrounded.map(
          (triangle) => [local[triangle[0]]!, local[triangle[1]]!, local[triangle[2]]!] as const,
        ),
      });
    }
    return faces;
  }

  /**
   * The part of the stroke edge cd inside the closed positive triangle, as the vertex ids of its
   * endpoints, or null when it is empty, a point, or lies on the line of a triangle edge (a
   * collinear edge adds no new edge).
   */
  #clip(c: P, d: P, triangle: readonly [P, P, P]): [number, number] | null {
    let lowN = 0n;
    let lowD = 1n;
    let highN = 1n;
    let highD = 1n;
    for (let side = 0; side < 3; side += 1) {
      const A = triangle[side]!;
      const B = triangle[(side + 1) % 3]!;
      const alpha = orient(A, B, c);
      const beta = orient(A, B, d);
      if (alpha === 0n && beta === 0n) return null;
      if (alpha < 0n && beta < 0n) return null;
      if (alpha < 0n) {
        // Entering: t >= -alpha / (beta - alpha).
        if (compareFraction(-alpha, beta - alpha, lowN, lowD) > 0) {
          lowN = -alpha;
          lowD = beta - alpha;
        }
      } else if (beta < 0n) {
        // Leaving: t <= alpha / (alpha - beta).
        if (compareFraction(alpha, alpha - beta, highN, highD) < 0) {
          highN = alpha;
          highD = alpha - beta;
        }
      }
    }
    if (compareFraction(lowN, lowD, highN, highD) >= 0) return null;
    const at = (n: bigint, den: bigint): number => {
      const X = c[0] * den + n * (d[0] - c[0]);
      const Y = c[1] * den + n * (d[1] - c[1]);
      const id = this.#lookup(X, Y, den);
      if (id === undefined) fail('arrangement:clip-endpoint');
      return id!;
    };
    return [at(lowN, lowD), at(highN, highD)];
  }

  /**
   * Faces of a planar straight-line graph, face on the left: at each vertex, an incoming
   * half-edge continues with the outgoing half-edge immediately clockwise of its reverse.
   */
  #cycles(points: readonly P[], edges: readonly (readonly [number, number])[]): number[][] {
    const tail = (h: number) => (h % 2 === 0 ? edges[h >> 1]![0] : edges[h >> 1]![1]);
    const head = (h: number) => (h % 2 === 0 ? edges[h >> 1]![1] : edges[h >> 1]![0]);
    const outgoing = new Map<number, number[]>();
    for (let h = 0; h < 2 * edges.length; h += 1) {
      const list = outgoing.get(tail(h));
      if (list === undefined) outgoing.set(tail(h), [h]);
      else list.push(h);
    }
    const direction = (h: number): P => {
      const p = points[tail(h)]!;
      const q = points[head(h)]!;
      return [q[0] - p[0], q[1] - p[1]];
    };
    const position = new Map<number, number>();
    for (const list of outgoing.values()) {
      list.sort((a, b) => {
        countExactTest();
        return compareAngle(direction(a), direction(b));
      });
      for (let i = 0; i < list.length; i += 1) {
        if (list.length > 1) {
          countExactTest();
          const next = list[(i + 1) % list.length]!;
          if (compareAngle(direction(list[i]!), direction(next)) === 0) fail('arrangement:overlap');
        }
        position.set(list[i]!, i);
      }
    }
    const next = (h: number): number => {
      const twin = h ^ 1;
      const list = outgoing.get(head(h))!;
      return list[(position.get(twin)! - 1 + list.length) % list.length]!;
    };
    const used = new Uint8Array(2 * edges.length);
    const cycles: number[][] = [];
    for (let start = 0; start < 2 * edges.length; start += 1) {
      if (used[start]) continue;
      const cycle: number[] = [];
      let h = start;
      while (!used[h]) {
        used[h] = 1;
        cycle.push(tail(h));
        h = next(h);
      }
      if (h !== start) fail('arrangement:cycle');
      cycles.push(cycle);
    }
    return cycles;
  }

  /**
   * The stroke role of an exact interior point (X / W, Y / W) of an unrounded face: 0 (region)
   * when the winding number of the stroke boundary loops there is nonzero, else 1 (exterior).
   */
  #strokeRole(
    X: bigint,
    Y: bigint,
    W: bigint,
    strokeEdges: readonly StrokeEdge[],
    bands: BoxIndex,
  ): number {
    const y = roundRational(Y, W, this.#exponent, false);
    let winding = 0;
    for (const s of bands.query([0, y, 0, y], 0)) {
      countExactTest();
      const edge = strokeEdges[s]!;
      const c = this.#vertices[edge.a]!;
      const d = this.#vertices[edge.b]!;
      const cy = c.Y * W;
      const dy = d.Y * W;
      const left = (d.X - c.X) * (Y - cy) - (X - c.X * W) * (d.Y - c.Y);
      if (cy <= Y) {
        if (dy > Y && left > 0n) winding += 1;
      } else if (dy <= Y && left < 0n) winding -= 1;
    }
    return winding !== 0 ? 0 : 1;
  }

  /**
   * Stroke lists (section 4.2): every stroke feature within local distance rho_S' of the closed
   * rounded overlay triangle, decided exactly, in global order (EDGE features by (from, to), then
   * VERTEX features by vertex index). Empty for a region-only stroke.
   */
  #strokeLister(
    strokeEdges: readonly StrokeEdge[],
    strokeIds: ReadonlyMap<number, number>,
    points: readonly P[],
    grid: DyadicGrid,
  ): (ids: Triangle) => number[] {
    const bucket = this.#input.stroke.fringeBucket;
    if (bucket === null) return () => [];
    const ordered = [...strokeEdges].sort((l, r) => l.from - r.from || l.to - r.to);
    const vertices = [...strokeIds.keys()].sort((a, b) => a - b);
    let reach = 2 ** bucket;
    let rho = grid.scale(reach);
    let r2 = rho * rho;
    if (this.#defect === 'ST7-D5') {
      reach /= 2;
      r2 = r2 / 4n;
      rho = rho / 2n;
    }
    const edgeBoxes = ordered.map((edge) => boxOf([points[edge.a]!, points[edge.b]!]));
    const vertexBoxes = vertices.map((s) => boxOf([points[strokeIds.get(s)!]!]));
    const edgeIndex = new BoxIndex(
      ordered.map((edge) => this.#approxBox([edge.a, edge.b])),
      reach,
    );
    const vertexIndex = new BoxIndex(
      vertices.map((s) => this.#approxBox([strokeIds.get(s)!])),
      reach,
    );
    return (ids) => {
      const corners = [points[ids[0]]!, points[ids[1]]!, points[ids[2]]!] as const;
      const box = boxOf(corners);
      const approx = this.#approxBox(ids);
      const near: number[] = [];
      for (const e of edgeIndex.query(approx, reach)) {
        if (!boxesWithin(edgeBoxes[e]!, box, rho)) continue;
        countExactTest();
        const edge = ordered[e]!;
        if (segmentTriangleWithin(points[edge.a]!, points[edge.b]!, corners, r2)) near.push(e);
      }
      for (const v of vertexIndex.query(approx, reach)) {
        if (!boxesWithin(vertexBoxes[v]!, box, rho)) continue;
        countExactTest();
        if (pointTriangleWithin(points[strokeIds.get(vertices[v]!)!]!, corners, r2))
          near.push(ordered.length + v);
      }
      return near;
    };
  }
}
