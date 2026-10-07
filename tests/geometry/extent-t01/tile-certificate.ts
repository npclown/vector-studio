import type { ProjectionInput, ProjectionPoint } from '../mesh-projection/model.js';
import { q, sqrtUp } from '../position-certificate/certificate.js';
import {
  add,
  compare,
  div,
  mul,
  rational,
  sign,
  sub,
  ZERO,
  type Rational,
} from '../rounded-fill/exact.js';
import { cross3, type Q2 } from './clip.js';
import {
  c2Q,
  certifyLanesCore,
  delta2Of,
  domainOk,
  GAMMA8,
  LIMIT,
  lanesOk,
  packLanesCore,
  type C2Term,
  type CoreInput,
  type CoreLanes,
  type VertexError,
} from './core.js';
import { seamConformance, type PxWindow, type TileCell, type TileResult } from './tile.js';

/**
 * P3.1p T01 K1 tile carrier and certificate (docs/plans/p3-t01-extent-experiment-contract.md,
 * K1 "Tile carrier", "Admission", "Seams"; "Metrics"; "Implementation details" 2-4).
 */

const f = Math.fround;
const C2_EDGE_LIMIT = 128;
const MARGIN = rational(3n, 2n);
const C2_TERMS: readonly C2Term[] = ['vertex', 'edge', 'triangle', 'wedge'];

/** Correctly rounded (nearest, ties to even) binary64 value of an exact rational. */
export function roundToBinary64(value: Rational): number {
  if (value.n === 0n) return 0;
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n;
  const d = value.d;
  // e = floor(log2(n / d))
  let e = n.toString(2).length - d.toString(2).length;
  const atLeast = (exponent: number) =>
    exponent >= 0 ? n >= d << BigInt(exponent) : n << BigInt(-exponent) >= d;
  if (!atLeast(e)) e -= 1;
  // quantum exponent: 52 bits below the leading bit, clamped to the subnormal quantum
  const quantum = Math.max(e - 52, -1074);
  const [num, den] = quantum >= 0 ? [n, d << BigInt(quantum)] : [n << BigInt(-quantum), d];
  let mantissa = num / den;
  const remainder2 = 2n * (num - mantissa * den);
  if (remainder2 > den || (remainder2 === den && (mantissa & 1n) === 1n)) mantissa += 1n;
  // mantissa ≤ 2^53, so the conversion is exact; scaling by a power of two is exact when finite
  // 2 ** quantum is exact for quantum ≥ −1074 and the product is exact when representable.
  const magnitude = Number(mantissa) * 2 ** quantum;
  return negative ? -magnitude : magnitude;
}

export type SimulatedLanes = Readonly<{
  physical: readonly (ProjectionPoint | null)[];
  ndc: readonly (ProjectionPoint | null)[];
  recovered: readonly (ProjectionPoint | null)[];
}>;

/**
 * K's binary32 graph in JavaScript RN with an explicit carrier (mesh-projection/model.ts
 * simulateMeshProjection from LOCAL_OFFSET on). `lanes.local` already holds fround(v64 − m);
 * entries that are null (not carried) stay null.
 */
export function simulateLanes(
  lanes: CoreLanes,
  size: Readonly<{ width: number; height: number }>,
): SimulatedLanes {
  const [l0, l1, l2, l3] = lanes.linear;
  const sw = f(size.width);
  const sh = f(size.height);
  const physical = lanes.local.map((point): ProjectionPoint | null => {
    if (point === null) return null;
    const [x, y] = point;
    const sx = f(f(f(l0 * x) + f(l2 * y)) + lanes.anchor[0]);
    const sy = f(f(f(l1 * x) + f(l3 * y)) + lanes.anchor[1]);
    const rx = f(sx + lanes.frame[0]);
    const ry = f(sy + lanes.frame[1]);
    return [f(f(rx * lanes.z) * lanes.dpr), f(f(ry * lanes.z) * lanes.dpr)];
  });
  const ndc = physical.map((point): ProjectionPoint | null =>
    point === null ? null : [f(f(f(point[0] * 2) / sw) - 1), f(1 - f(f(point[1] * 2) / sh))],
  );
  const recovered = ndc.map((point): ProjectionPoint | null =>
    point === null ? null : [((point[0] + 1) * size.width) / 2, ((1 - point[1]) * size.height) / 2],
  );
  return { physical, ndc, recovered };
}

/** Exact reference map R: (A·x + t − camera)·zoom·dpr, original binary64 inputs as rationals. */
export function referencePx(input: ProjectionInput, point: Q2): Q2 {
  const [a, b, c, d, e, g] = input.affine.map(q) as unknown as readonly [
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  const scale = mul(q(input.zoom), q(input.dpr));
  return [
    mul(sub(add(add(mul(a, point[0]), mul(c, point[1])), e), q(input.camera[0])), scale),
    mul(sub(add(add(mul(b, point[0]), mul(d, point[1])), g), q(input.camera[1])), scale),
  ];
}

type Box = Readonly<{ x0: Rational; y0: Rational; x1: Rational; y1: Rational }>;

const minR = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const maxR = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);

function boxCorners(box: Box): Q2[] {
  return [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ];
}

/** Closed triangle meets closed axis-aligned box (separating axis test, exact). */
export function triangleMeetsBox(triangle: readonly [Q2, Q2, Q2], box: Box): boolean {
  for (const axis of [0, 1] as const) {
    const values = triangle.map((point) => point[axis]);
    const lo = values.reduce(minR);
    const hi = values.reduce(maxR);
    const [b0, b1] = axis === 0 ? [box.x0, box.x1] : [box.y0, box.y1];
    if (compare(hi, b0) < 0 || compare(lo, b1) > 0) return false;
  }
  const orientation = sign(cross3(...triangle));
  if (orientation === 0) return true;
  const corners = boxCorners(box);
  for (let side = 0; side < 3; side += 1) {
    const a = triangle[side]!;
    const b = triangle[(side + 1) % 3]!;
    if (corners.every((corner) => sign(cross3(a, b, corner)) === -orientation)) return false;
  }
  return true;
}

function pointSegment2(p: Q2, a: Q2, b: Q2): Rational {
  const ab: Q2 = [sub(b[0], a[0]), sub(b[1], a[1])];
  const ap: Q2 = [sub(p[0], a[0]), sub(p[1], a[1])];
  const length2 = add(mul(ab[0], ab[0]), mul(ab[1], ab[1]));
  let t = length2.n === 0n ? ZERO : div(add(mul(ap[0], ab[0]), mul(ap[1], ab[1])), length2);
  if (sign(t) < 0) t = ZERO;
  if (compare(t, rational(1n)) > 0) t = rational(1n);
  const dx = sub(p[0], add(a[0], mul(t, ab[0])));
  const dy = sub(p[1], add(a[1], mul(t, ab[1])));
  return add(mul(dx, dx), mul(dy, dy));
}

function pointBox2(p: Q2, box: Box): Rational {
  const gap = (value: Rational, lo: Rational, hi: Rational) =>
    compare(value, lo) < 0 ? sub(lo, value) : compare(value, hi) > 0 ? sub(value, hi) : ZERO;
  const dx = gap(p[0], box.x0, box.x1);
  const dy = gap(p[1], box.y0, box.y1);
  return add(mul(dx, dx), mul(dy, dy));
}

/** Exact squared distance between a closed triangle and a closed axis-aligned box. */
export function triangleBoxDistance2(triangle: readonly [Q2, Q2, Q2], box: Box): Rational {
  if (triangleMeetsBox(triangle, box)) return ZERO;
  let best: Rational | null = null;
  const consider = (value: Rational) => {
    if (best === null || compare(value, best) < 0) best = value;
  };
  for (const point of triangle) consider(pointBox2(point, box));
  for (const corner of boxCorners(box))
    for (let side = 0; side < 3; side += 1)
      consider(pointSegment2(corner, triangle[side]!, triangle[(side + 1) % 3]!));
  return best!;
}

export function tileLocus(cell: Pick<TileCell, 'L' | 'i' | 'j'>): string {
  return `tile(${cell.L},${cell.i},${cell.j})`;
}

export type TileLanes = Readonly<{
  cell: TileCell;
  stored: readonly ProjectionPoint[];
  lanes: CoreLanes;
  core: CoreInput;
}>;

/** Tile carrier: m = cell centre; v64 = original binary64 or RN64(v) for Steiner points. */
export function tileLanes(
  input: ProjectionInput,
  cell: TileCell,
  origin: ProjectionPoint,
): TileLanes {
  const stored = cell.points.map((point, index): ProjectionPoint => {
    const source = cell.sourceIndex[index];
    if (source !== null && source !== undefined) {
      const original = input.mesh.vertices[source]!;
      return [original[0], original[1]];
    }
    return [roundToBinary64(point[0]), roundToBinary64(point[1])];
  });
  const lanes = packLanesCore(
    stored,
    input.affine,
    input.camera,
    input.zoom,
    input.dpr,
    cell.m,
    origin,
  );
  const core: CoreInput = {
    points: cell.points,
    triangles: cell.indices,
    affine: input.affine,
    camera: input.camera,
    zoom: input.zoom,
    dpr: input.dpr,
    width: input.width,
    height: input.height,
  };
  return { cell, stored, lanes, core };
}

export type VertexLocus = Readonly<{ locus: string; vertex: number }>;

export type C2Failures = Readonly<Record<C2Term, number>>;

export type TileCertificate = Readonly<{
  outcome: string;
  counts: Readonly<{ tiles: number; cells: number; triangles: number; vertices: number }>;
  /** sqrtUp(max E²) over admission vertices; equals δ̄ for K1. */
  maxE: Rational | null;
  delta: Rational | null;
  /** Lowest failing admission vertex (row-major tile order, then tile vertex index). */
  positionFailure: Readonly<{ locus: string; vertex: number }> | null;
  inversions: number | null;
  c2Failures: C2Failures | null;
  c2Skipped: 'edges>128' | null;
  /** In-window Steiner points: max sqrtUp(Pack_x² + Pack_y²) and max sqrtUp(E²), with loci. */
  steiner: Readonly<{
    maxPack: Rational;
    packLocus: VertexLocus;
    maxE: Rational;
    locus: VertexLocus;
  }> | null;
  seam: Readonly<{ count: number; maxSigma: Rational | null; conforming: boolean }> | null;
  submesh: Readonly<{
    ok: boolean | null;
    firstViolation: Readonly<{ locus: string; triangle: number }> | null;
    reason: 'lane-range' | null;
  }>;
  evaluated: Readonly<{ position: boolean; c2: boolean }>;
}>;

const ZERO_COUNTS = { tiles: 0, cells: 0, triangles: 0, vertices: 0 } as const;

function early(
  outcome: string,
  counts: TileCertificate['counts'],
  submesh: TileCertificate['submesh'] = { ok: null, firstViolation: null, reason: null },
): TileCertificate {
  return {
    outcome,
    counts,
    maxE: null,
    delta: null,
    positionFailure: null,
    inversions: null,
    c2Failures: null,
    c2Skipped: null,
    steiner: null,
    seam: null,
    submesh,
    evaluated: { position: false, c2: false },
  };
}

function keyOf(point: Q2): string {
  return `${point[0].n}/${point[0].d},${point[1].n}/${point[1].d}`;
}

type TileState = {
  carrier: TileLanes;
  inWindow: number[];
  admission: number[];
  errors: Map<number, VertexError>;
  errors8: Map<number, VertexError>;
};

/**
 * K1 certificate of one row at one sweep point, on a `tileRow` result. `window` is the U1 window
 * in physical px; V is [0, W] × [0, H]. Evaluation order: guards, position, C2, then submesh.
 * Row-level checks on the original inputs (domain, singular) belong to the caller.
 */
export function certifyTiles(
  input: ProjectionInput,
  tiles: TileResult,
  origin: ProjectionPoint,
  window: PxWindow,
  gamma: Rational = GAMMA8,
  options: Readonly<{ k2c?: boolean }> = {},
): TileCertificate {
  // K2c (Primary, contract "K2c"): no 1/16-px position gate; C2 at δ = ε; submesh margin + ε.
  const k2c = options.k2c === true;
  if (k2c && gamma !== GAMMA8) throw new Error('k2c-requires-gamma8');
  if (tiles.status === 'LEVEL_NONE') return early('NOT_ADMITTED:lane-range', ZERO_COUNTS);
  if (tiles.status === 'TILE_CAP_EXCEEDED')
    return early('TILE_CAP_EXCEEDED', { ...ZERO_COUNTS, cells: tiles.materializedCells });

  const viewport: Box = {
    x0: ZERO,
    y0: ZERO,
    x1: rational(BigInt(input.width)),
    y1: rational(BigInt(input.height)),
  };
  const states: TileState[] = [];
  for (const cell of tiles.cells) {
    const carrier = tileLanes(input, cell, origin);
    const counts = { ...ZERO_COUNTS, tiles: tiles.cells.length, cells: tiles.materializedCells };
    // guard check 4 on v64 (original-input domain), then check 1 on the tile's lanes
    if (!domainOk(carrier.stored, input)) return early('OUT_OF_DOMAIN', counts);
    if (!lanesOk(carrier.lanes))
      return early(`NOT_ADMITTED:lane-range:${tileLocus(cell)}`, counts, {
        ok: null,
        firstViolation: null,
        reason: 'lane-range',
      });
    const reference = cell.points.map((point) => referencePx(input, point));
    const inWindow: number[] = [];
    cell.indices.forEach(([a, b, c], index) => {
      if (triangleMeetsBox([reference[a]!, reference[b]!, reference[c]!], window))
        inWindow.push(index);
    });
    const admission = [...new Set(inWindow.flatMap((index) => [...cell.indices[index]!]))].sort(
      (left, right) => left - right,
    );
    const drawn = [...new Set(cell.indices.flat())].sort((left, right) => left - right);
    const errors = certifyLanesCore(carrier.core, carrier.lanes, drawn, gamma);
    const errors8 =
      gamma === GAMMA8 ? errors : certifyLanesCore(carrier.core, carrier.lanes, drawn, GAMMA8);
    if (errors === 'lane-range' || errors8 === 'lane-range')
      return early(`NOT_ADMITTED:lane-range:${tileLocus(cell)}`, counts, {
        ok: null,
        firstViolation: null,
        reason: 'lane-range',
      });
    states.push({ carrier, inWindow, admission, errors, errors8 });
  }

  const counts = {
    tiles: tiles.cells.length,
    cells: tiles.materializedCells,
    triangles: states.reduce((total, state) => total + state.inWindow.length, 0),
    vertices: states.reduce((total, state) => total + state.admission.length, 0),
  };

  // K2c ε = sqrtUp(max E² over admission vertices), added to the submesh margin.
  let epsilon = ZERO;
  if (k2c) {
    let admission2 = ZERO;
    for (const state of states)
      for (const vertex of state.admission) {
        const e2 = delta2Of(state.errors8.get(vertex)!);
        if (compare(e2, admission2) > 0) admission2 = e2;
      }
    epsilon = sqrtUp(admission2);
  }

  // Submesh argument (Γ8, row origin), evaluated for every drawn triangle that is not in-window.
  let submesh: TileCertificate['submesh'] = { ok: true, firstViolation: null, reason: null };
  for (const state of states) {
    if (submesh.ok === false) break;
    const cell = state.carrier.cell;
    const inWindow = new Set(state.inWindow);
    for (let index = 0; index < cell.indices.length; index += 1) {
      if (inWindow.has(index)) continue;
      const ids = cell.indices[index]!;
      const triangle = ids.map((id) => referencePx(input, cell.points[id]!)) as unknown as [
        Q2,
        Q2,
        Q2,
      ];
      const bound = add(
        ids
          .map((id) => sqrtUp(delta2Of(state.errors8.get(id)!)))
          .reduce((best, value) => maxR(best, value)),
        add(MARGIN, epsilon),
      );
      if (compare(triangleBoxDistance2(triangle, viewport), mul(bound, bound)) <= 0) {
        submesh = {
          ok: false,
          firstViolation: { locus: tileLocus(cell), triangle: index },
          reason: null,
        };
        break;
      }
    }
  }

  // Seams: σ(v) over pairs of tiles carrying the exact position v (row Γ).
  const byPosition = new Map<string, VertexError[]>();
  for (const state of states)
    for (const [vertex, error] of state.errors) {
      const key = keyOf(state.carrier.cell.points[vertex]!);
      const list = byPosition.get(key) ?? [];
      list.push(error);
      byPosition.set(key, list);
    }
  let seamCount = 0;
  let maxSigma: Rational | null = null;
  for (const list of byPosition.values()) {
    if (list.length < 2) continue;
    seamCount += 1;
    for (let a = 0; a < list.length; a += 1)
      for (let b = a + 1; b < list.length; b += 1) {
        const sx = add(list[a]!.ex, list[b]!.ex);
        const sy = add(list[a]!.ey, list[b]!.ey);
        const sigma = sqrtUp(add(mul(sx, sx), mul(sy, sy)));
        if (maxSigma === null || compare(sigma, maxSigma) > 0) maxSigma = sigma;
      }
  }
  const seam = { count: seamCount, maxSigma, conforming: seamConformance(tiles).conforming };

  if (counts.triangles === 0)
    return {
      ...early('NO_IN_WINDOW_TRIANGLES', counts, submesh),
      seam,
      inversions: 0,
    };

  // Position on every admission vertex with its own tile carrier.
  let positionFailure: TileCertificate['positionFailure'] = null;
  let max2 = ZERO;
  type Extreme = { value2: Rational; locus: string; vertex: number };
  let steinerE: Extreme | null = null;
  let steinerPack: Extreme | null = null;
  for (const state of states) {
    const cell = state.carrier.cell;
    for (const vertex of state.admission) {
      const error = state.errors.get(vertex)!;
      const e2 = delta2Of(error);
      if (compare(e2, max2) > 0) max2 = e2;
      if (positionFailure === null && compare(e2, LIMIT) > 0)
        positionFailure = { locus: tileLocus(cell), vertex };
      if (cell.steinerKind[vertex] !== 0) {
        const pack2 = add(mul(error.pack[0], error.pack[0]), mul(error.pack[1], error.pack[1]));
        if (steinerPack === null || compare(pack2, steinerPack.value2) > 0)
          steinerPack = { value2: pack2, locus: tileLocus(cell), vertex };
        if (steinerE === null || compare(e2, steinerE.value2) > 0)
          steinerE = { value2: e2, locus: tileLocus(cell), vertex };
      }
    }
  }
  const delta = sqrtUp(max2);

  // Inversions on the recovered viewport coordinates of each tile's own carrier.
  let inversions = 0;
  for (const state of states) {
    const cell = state.carrier.cell;
    const recovered = simulateLanes(state.carrier.lanes, input).recovered;
    for (const index of state.inWindow) {
      const ids = cell.indices[index]!;
      const reference = ids.map((id) => referencePx(input, cell.points[id]!)) as unknown as [
        Q2,
        Q2,
        Q2,
      ];
      const observed = ids.map((id) => {
        const point = recovered[id]!;
        return [q(point[0]), q(point[1])] as const;
      }) as unknown as [Q2, Q2, Q2];
      const expected = sign(cross3(...reference));
      const actual = sign(cross3(...observed));
      if (actual === 0 || actual !== expected) inversions += 1;
    }
  }

  // C2 per tile on its in-window triangles at δ = δ̄ (Implementation details 2 and 4).
  const edges = new Set<string>();
  states.forEach((state, tile) => {
    for (const index of state.inWindow) {
      const [a, b, c] = state.carrier.cell.indices[index]!;
      for (const [u, w] of [
        [a, b],
        [b, c],
        [c, a],
      ] as const)
        edges.add(`${tile}:${Math.min(u, w)},${Math.max(u, w)}`);
    }
  });
  const runC2 = k2c || positionFailure === null || edges.size <= C2_EDGE_LIMIT;
  const failures: Record<C2Term, number> = { vertex: 0, edge: 0, triangle: 0, wedge: 0 };
  let c2Outcome: string | null = null;
  if (runC2) {
    for (const state of states) {
      if (state.inWindow.length === 0) continue;
      const cell = state.carrier.cell;
      const flat = state.inWindow.flatMap((index) => [...cell.indices[index]!]);
      try {
        const result = c2Q(cell.points, flat, input, max2);
        for (const term of C2_TERMS) if (result.failing[term]) failures[term] += 1;
        if (c2Outcome === null && result.term !== null)
          c2Outcome = `NOT_ADMITTED:${result.term}:${tileLocus(cell)}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith('input:')) throw error;
        if (c2Outcome === null) c2Outcome = `NOT_ADMITTED:${message}:${tileLocus(cell)}`;
      }
    }
  }

  const outcome =
    positionFailure !== null && !k2c
      ? `NOT_ADMITTED:position:${positionFailure.locus}`
      : c2Outcome !== null
        ? c2Outcome
        : submesh.ok === false
          ? `NOT_ADMITTED:submesh:${submesh.firstViolation!.locus}`
          : 'ADMITTED';

  return {
    outcome,
    counts,
    maxE: delta,
    delta,
    positionFailure,
    inversions,
    c2Failures: runC2 ? failures : null,
    c2Skipped: runC2 ? null : 'edges>128',
    steiner:
      steinerE === null || steinerPack === null
        ? null
        : {
            maxPack: sqrtUp(steinerPack.value2),
            packLocus: { locus: steinerPack.locus, vertex: steinerPack.vertex },
            maxE: sqrtUp(steinerE.value2),
            locus: { locus: steinerE.locus, vertex: steinerE.vertex },
          },
    seam,
    submesh,
    evaluated: { position: !k2c, c2: runC2 },
  };
}
