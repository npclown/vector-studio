import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { segmentTriangleDistanceSquared } from '../coverage-oracle/exterior.js';
import { o02Variants, variantStatus } from '../coverage-oracle/variants.js';
import type { ProjectionInput, ProjectionPoint } from '../mesh-projection/model.js';
import { GAMMA9, q, sqrtUp } from '../position-certificate/certificate.js';
import {
  loadFixtureRows,
  originSequences,
  prospectiveRows,
  termRows,
} from '../position-certificate/corpus.js';
import { originPXTarget, trajectories } from '../position-certificate/r3-window.js';
import {
  add,
  bitsOf,
  compare,
  mul,
  rational,
  sign,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';
import {
  bboxMidpoint,
  c2Q,
  certifyLanesCore,
  delta2Of,
  domainOk,
  GAMMA8,
  LIMIT,
  lanesOk,
  packLanesCore,
  singularCore,
  type C2Term,
  type CoreInput,
  type Q2,
  type Triangle,
} from './core.js';
import { k5Errors, packPairLanes } from './k5.js';
import { PINNED_SOURCES, T01_CONTRACT, T01_CONTRACT_COMMIT } from './sources.js';
import { CLASS_A_STRESS_IDS, syntheticRows, trajectoryRows } from './synthetic.js';
import {
  certifyTiles,
  referencePx,
  simulateLanes,
  tileLocus,
  triangleBoxDistance2,
  triangleMeetsBox,
} from './tile-certificate.js';
import { tileRow, type PxWindow, type TileResult } from './tile.js';

/**
 * P3.1p T01 report assembly (docs/plans/p3-t01-extent-experiment-contract.md, "Metrics",
 * "Records, ownership and validation" and "Implementation details"). Exact values are rational
 * strings; nothing depends on timing or platform.
 */

export const GAMMAS = [4, 64] as const;
export const T_TILES = [256, 1024] as const;
export const T_COARSES = [4096, 65536] as const;
export const CORPORA = ['C', 'L', 'O', 'S'] as const;
export type Corpus = (typeof CORPORA)[number];

const ZERO = rational(0n);
const MARGIN = rational(3n, 2n);
const C2_EDGE_LIMIT = 128;
const FEATURE_UNIT = add(rational(1n, 1n << 24n), rational(1n, 1n << 50n));
const C2_TERMS: readonly C2Term[] = ['vertex', 'edge', 'triangle', 'wedge'];

export const r = (value: Rational | null): string | null =>
  value === null ? null : value.d === 1n ? value.n.toString() : `${value.n}/${value.d}`;

function ratio(value: number): string {
  return r(q(value))!;
}

export type RowSpec = Readonly<{
  corpus: Corpus;
  id: string;
  input: ProjectionInput;
  /** O rows: "acceptance" or "3"; other corpora: "all". */
  dprGroup: string;
  flags: readonly string[];
  /** S rows: the family coordinates for M_max. */
  s?: Readonly<{ shape: string; k: number; zoom: number; dpr: number; linear: string }>;
}>;

/** C, L, O, S in contract order. */
export function corpusRows(corpus: Corpus): RowSpec[] {
  if (corpus === 'C')
    return loadFixtureRows().map((row) => ({
      corpus,
      id: row.id,
      input: row.input,
      dprGroup: 'all',
      flags: (CLASS_A_STRESS_IDS as readonly string[]).includes(row.id) ? ['classA'] : [],
    }));
  if (corpus === 'L')
    return [...prospectiveRows(), ...termRows()].map((row) => ({
      corpus,
      id: row.id,
      input: row.input,
      dprGroup: 'all',
      flags: row.id.startsWith('EXT-') ? ['classA'] : [],
    }));
  if (corpus === 'O')
    return o02Variants().map((variant) => {
      const status = variantStatus(variant.input).status;
      const flags = status === 'EMPTY_CROP' || status === 'INPUT_UNSUPPORTED' ? [status] : [];
      return {
        corpus,
        id: variant.id,
        input: variant.input,
        dprGroup: variant.dpr === 3 ? '3' : 'acceptance',
        flags,
      };
    });
  return syntheticRows().rows.map((row) => ({
    corpus,
    id: row.id,
    input: row.input,
    dprGroup: 'all',
    flags: [],
    s: { shape: row.shape, k: row.k, zoom: row.zoom, dpr: row.dpr, linear: row.linear },
  }));
}

function windowOf(input: ProjectionInput, gamma: number): PxWindow {
  return {
    x0: rational(BigInt(-gamma)),
    y0: rational(BigInt(-gamma)),
    x1: rational(BigInt(input.width + gamma)),
    y1: rational(BigInt(input.height + gamma)),
  };
}

function coreOf(input: ProjectionInput): CoreInput {
  const triangles: Triangle[] = [];
  for (let offset = 0; offset < input.mesh.indices.length; offset += 3)
    triangles.push(input.mesh.indices.slice(offset, offset + 3) as unknown as Triangle);
  return {
    points: input.mesh.vertices.map(([x, y]): Q2 => [q(x), q(y)]),
    triangles,
    affine: input.affine,
    camera: input.camera,
    zoom: input.zoom,
    dpr: input.dpr,
    width: input.width,
    height: input.height,
  };
}

const cross3 = (a: Q2, b: Q2, c: Q2) =>
  sub(mul(sub(b[0], a[0]), sub(c[1], a[1])), mul(sub(b[1], a[1]), sub(c[0], a[0])));

export type Evaluation = Readonly<{
  outcome: string;
  counts: Readonly<{ tiles: number; cells: number; triangles: number; vertices: number }>;
  maxE: string | null;
  delta: string | null;
  inversions: number | null;
  c2Failures: Readonly<Record<C2Term, number>> | null;
  c2Skipped: string | null;
  steiner: unknown;
  seam: unknown;
  features: unknown;
  submesh: unknown;
  evaluated: Readonly<{ position: boolean; c2: boolean }>;
  rnOutcome?: string;
  uTermMax?: string | null;
}>;

const NO_COUNTS = { tiles: 0, cells: 0, triangles: 0, vertices: 0 } as const;

function bare(outcome: string, submesh: unknown = null): Evaluation {
  return {
    outcome,
    counts: NO_COUNTS,
    maxE: null,
    delta: null,
    inversions: null,
    c2Failures: null,
    c2Skipped: null,
    steiner: null,
    seam: null,
    features: null,
    submesh,
    evaluated: { position: false, c2: false },
  };
}

type ErrorPair = Readonly<{ ex: Rational; ey: Rational }>;

/** K4 and K5: the untiled carrier on the in-window submesh. */
function evaluateUntiled(
  input: ProjectionInput,
  origin: ProjectionPoint,
  window: PxWindow,
  mode: 'K4' | 'K5',
  gamma: Rational,
  rn = false,
): Evaluation {
  const vertices = input.mesh.vertices;
  const midpoint = bboxMidpoint(vertices);
  const lanes = packLanesCore(
    vertices,
    input.affine,
    input.camera,
    input.zoom,
    input.dpr,
    midpoint,
    origin,
  );
  const laneRange = bare('NOT_ADMITTED:lane-range', {
    ok: null,
    firstViolation: null,
    reason: 'lane-range',
  });
  if (!lanesOk(lanes)) return laneRange;
  const core = coreOf(input);
  const used = [...new Set(input.mesh.indices)].sort((a, b) => a - b);
  let errors: Map<number, ErrorPair> | 'lane-range';
  let uTermMax: Rational | null = null;
  if (mode === 'K4') errors = certifyLanesCore(core, lanes, used, gamma);
  else {
    const pair = packPairLanes(
      vertices,
      input.affine,
      input.camera,
      input.zoom,
      input.dpr,
      midpoint,
      origin,
    );
    const k5 = k5Errors(core, pair, used, rn);
    if (k5 !== 'lane-range')
      for (const error of k5.values())
        for (const value of error.uTerm)
          if (uTermMax === null || compare(value, uTermMax) > 0) uTermMax = value;
    errors = k5;
  }
  if (errors === 'lane-range') return laneRange;
  const reference = core.points.map((point) => referencePx(input, point));
  const inWindow: number[] = [];
  core.triangles.forEach(([a, b, c], index) => {
    if (triangleMeetsBox([reference[a]!, reference[b]!, reference[c]!], window))
      inWindow.push(index);
  });
  const admission = [...new Set(inWindow.flatMap((index) => [...core.triangles[index]!]))].sort(
    (a, b) => a - b,
  );
  const viewport = {
    x0: ZERO,
    y0: ZERO,
    x1: rational(BigInt(input.width)),
    y1: rational(BigInt(input.height)),
  };
  let submesh: { ok: boolean; firstViolation: { triangle: number } | null; reason: null } = {
    ok: true,
    firstViolation: null,
    reason: null,
  };
  for (let index = 0; index < core.triangles.length; index += 1) {
    if (inWindow.includes(index)) continue;
    const ids = core.triangles[index]!;
    const bound = add(
      ids
        .map((id) => sqrtUp(delta2Of(errors.get(id)!)))
        .reduce((best, value) => (compare(value, best) > 0 ? value : best)),
      MARGIN,
    );
    const triangle = ids.map((id) => reference[id]!) as unknown as [Q2, Q2, Q2];
    if (compare(triangleBoxDistance2(triangle, viewport), mul(bound, bound)) <= 0) {
      submesh = { ok: false, firstViolation: { triangle: index }, reason: null };
      break;
    }
  }
  const counts = { tiles: 0, cells: 0, triangles: inWindow.length, vertices: admission.length };
  if (inWindow.length === 0)
    return {
      ...bare('NO_IN_WINDOW_TRIANGLES', submesh),
      counts,
      inversions: 0,
      ...(mode === 'K5' ? { uTermMax: r(uTermMax) } : {}),
    };
  let max2 = ZERO;
  let positionFailure: number | null = null;
  for (const vertex of admission) {
    const e2 = delta2Of(errors.get(vertex)!);
    if (compare(e2, max2) > 0) max2 = e2;
    if (positionFailure === null && compare(e2, LIMIT) > 0) positionFailure = vertex;
  }
  let inversions: number | null = null;
  if (mode === 'K4') {
    inversions = 0;
    const recovered = simulateLanes(lanes, input).recovered;
    for (const index of inWindow) {
      const ids = core.triangles[index]!;
      const expected = sign(cross3(...(ids.map((id) => reference[id]!) as [Q2, Q2, Q2])));
      const observed = ids.map((id) => {
        const point = recovered[id]!;
        return [q(point[0]), q(point[1])] as Q2;
      }) as [Q2, Q2, Q2];
      const actual = sign(cross3(...observed));
      if (actual === 0 || actual !== expected) inversions += 1;
    }
  }
  const flat = inWindow.flatMap((index) => [...core.triangles[index]!]);
  const edges = new Set<string>();
  for (const index of inWindow) {
    const [a, b, c] = core.triangles[index]!;
    for (const [u, w] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const)
      edges.add(`${Math.min(u, w)},${Math.max(u, w)}`);
  }
  const runC2 = positionFailure === null || edges.size <= C2_EDGE_LIMIT;
  let c2Failures: Record<C2Term, number> | null = null;
  let c2Outcome: string | null = null;
  if (runC2) {
    c2Failures = { vertex: 0, edge: 0, triangle: 0, wedge: 0 };
    try {
      const result = c2Q(core.points, flat, input, max2);
      for (const term of C2_TERMS) if (result.failing[term]) c2Failures[term] = 1;
      if (result.term !== null) c2Outcome = `NOT_ADMITTED:${result.term}:mesh`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('input:')) throw error;
      c2Outcome = `NOT_ADMITTED:${message}:mesh`;
    }
  }
  const outcome =
    positionFailure !== null
      ? `NOT_ADMITTED:position:v${positionFailure}`
      : (c2Outcome ??
        (submesh.ok ? 'ADMITTED' : `NOT_ADMITTED:submesh:t${submesh.firstViolation!.triangle}`));
  return {
    outcome,
    counts,
    maxE: r(sqrtUp(max2)),
    delta: r(sqrtUp(max2)),
    inversions,
    c2Failures,
    c2Skipped: runC2 ? null : 'edges>128',
    steiner: null,
    seam: null,
    features: null,
    submesh,
    evaluated: { position: true, c2: runC2 },
    ...(mode === 'K5' ? { uTermMax: r(uTermMax) } : {}),
  };
}

/** Exact boundary edges of the original region mesh (edges used by exactly one triangle). */
function boundaryEdges(input: ProjectionInput): [number, number][] {
  const count = new Map<string, number>();
  for (let offset = 0; offset < input.mesh.indices.length; offset += 3) {
    const tri = input.mesh.indices.slice(offset, offset + 3);
    for (let k = 0; k < 3; k += 1) {
      const a = tri[k]!;
      const b = tri[(k + 1) % 3]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  return [...count]
    .filter(([, n]) => n === 1)
    .map(([key]) => key.split(',').map(Number) as [number, number]);
}

/** K2c features: exact projected boundary within 1.5 + ε of each in-window drawn triangle. */
function k2cFeatures(
  input: ProjectionInput,
  tiles: TileResult,
  window: PxWindow,
  epsilon: Rational,
) {
  const reach = add(MARGIN, epsilon);
  const reach2 = mul(reach, reach);
  const points = input.mesh.vertices.map(([x, y]): Q2 => referencePx(input, [q(x), q(y)]));
  const edges = boundaryEdges(input).map(([a, b]) => [points[a]!, points[b]!] as const);
  const magnitude = (p: Q2) => add(abs(sub(p[0], window.x0)), abs(sub(p[1], window.y0)));
  let maxCount = 0;
  let maxBound = ZERO;
  for (const cell of tiles.cells) {
    const reference = cell.points.map((point) => referencePx(input, point));
    for (const [a, b, c] of cell.indices) {
      const triangle = [reference[a]!, reference[b]!, reference[c]!] as const;
      if (!triangleMeetsBox(triangle, window)) continue;
      let count = 0;
      for (const [p, s] of edges)
        if (compare(segmentTriangleDistanceSquared(p, s, triangle), reach2) <= 0) {
          count += 1;
          for (const end of [p, s]) {
            const bound = mul(FEATURE_UNIT, magnitude(end));
            if (compare(bound, maxBound) > 0) maxBound = bound;
          }
        }
      if (count > maxCount) maxCount = count;
    }
  }
  return { maxBound: r(maxBound), maxCount };
}

const abs = (value: Rational) => (value.n < 0n ? rational(-value.n, value.d) : value);

function tiled(
  input: ProjectionInput,
  origin: ProjectionPoint,
  window: PxWindow,
  T: number,
  gamma: Rational,
  k2c: boolean,
): Evaluation {
  let tiles: TileResult;
  try {
    tiles = tileRow(input, T, window);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return bare(`NOT_ADMITTED:lane-range`, {
      ok: null,
      firstViolation: null,
      reason: `tile:${message}`,
    });
  }
  let result;
  try {
    result = certifyTiles(input, tiles, origin, window, gamma, { k2c });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('centre')) throw error;
    return bare('NOT_ADMITTED:lane-range', {
      ok: null,
      firstViolation: null,
      reason: 'cell-centre',
    });
  }
  const steiner =
    result.steiner === null
      ? null
      : {
          maxPack: r(result.steiner.maxPack),
          packLocus: `${result.steiner.packLocus.locus}:v${result.steiner.packLocus.vertex}`,
          maxE: r(result.steiner.maxE),
          locus: `${result.steiner.locus.locus}:v${result.steiner.locus.vertex}`,
        };
  const seam =
    result.seam === null
      ? null
      : {
          count: result.seam.count,
          maxSigma: r(result.seam.maxSigma),
          conforming: result.seam.conforming,
        };
  const features =
    k2c && result.delta !== null && tiles.status === 'OK'
      ? k2cFeatures(input, tiles, window, result.delta)
      : null;
  return {
    outcome: result.outcome,
    counts: result.counts,
    maxE: r(result.maxE),
    delta: r(result.delta),
    inversions: result.inversions,
    c2Failures: result.c2Failures,
    c2Skipped: result.c2Skipped,
    steiner,
    seam,
    features,
    submesh: result.submesh,
    evaluated: result.evaluated,
  };
}

export type ReportRow = Readonly<Record<string, unknown>>;

function rowRecord(
  spec: RowSpec,
  candidate: string,
  sweep: { gamma: number; tTile: number | null; tCoarse: number | null },
  gammaModel: 'G8' | 'G9',
  evaluation: Evaluation,
): ReportRow {
  return {
    corpus: spec.corpus,
    id: spec.id,
    dpr: ratio(spec.input.dpr),
    flags: spec.flags,
    candidate,
    sweep,
    gammaModel,
    outcome: evaluation.outcome,
    counts: evaluation.counts,
    maxE: evaluation.maxE,
    delta: evaluation.delta,
    inversions: evaluation.inversions,
    c2Failures: evaluation.c2Failures,
    c2Skipped: evaluation.c2Skipped,
    steiner: evaluation.steiner,
    seam: evaluation.seam,
    features: evaluation.features,
    submesh: evaluation.submesh,
    evaluated: evaluation.evaluated,
    ...(evaluation.rnOutcome === undefined ? {} : { rnOutcome: evaluation.rnOutcome }),
    ...(evaluation.uTermMax === undefined ? {} : { uTermMax: evaluation.uTermMax }),
  };
}

function positionOnly(evaluation: Evaluation): Evaluation {
  const outcome =
    evaluation.outcome.startsWith('NOT_ADMITTED:position') ||
    evaluation.outcome.startsWith('NOT_ADMITTED:lane-range')
      ? evaluation.outcome
      : 'ADMITTED';
  return {
    ...evaluation,
    outcome,
    inversions: null,
    c2Failures: null,
    c2Skipped: null,
    evaluated: { position: true, c2: false },
  };
}

/** Every report row for one corpus row, in candidate then sweep then Γ order. */
export function evaluateSpec(spec: RowSpec): ReportRow[] {
  const input = spec.input;
  const origin = originPXTarget(input.camera, input.zoom, input.dpr, 128).origin;
  const rows: ReportRow[] = [];
  const outOfDomain =
    spec.flags.includes('INPUT_UNSUPPORTED') || !domainOk(input.mesh.vertices, input);
  const isSingular = singularCore(input.affine);
  const push = (
    candidate: string,
    sweep: { gamma: number; tTile: number | null; tCoarse: number | null },
    make: (gamma: Rational) => Evaluation,
    gamma9: boolean,
  ) => {
    if (outOfDomain) {
      rows.push(rowRecord(spec, candidate, sweep, 'G8', bare('OUT_OF_DOMAIN')));
      return;
    }
    if (isSingular) {
      rows.push(rowRecord(spec, candidate, sweep, 'G8', bare('NOT_ADMITTED:singular')));
      return;
    }
    const evaluation = make(GAMMA8);
    rows.push(rowRecord(spec, candidate, sweep, 'G8', evaluation));
    if (gamma9 && evaluation.outcome === 'ADMITTED')
      rows.push(rowRecord(spec, candidate, sweep, 'G9', positionOnly(make(GAMMA9))));
  };
  for (const gamma of GAMMAS)
    push(
      'K4',
      { gamma, tTile: null, tCoarse: null },
      (g) => evaluateUntiled({ ...input, origin }, origin, windowOf(input, gamma), 'K4', g),
      true,
    );
  for (const gamma of GAMMAS)
    for (const tTile of T_TILES)
      push(
        'K1',
        { gamma, tTile, tCoarse: null },
        (g) => tiled({ ...input, origin }, origin, windowOf(input, gamma), tTile, g, false),
        true,
      );
  for (const gamma of GAMMAS)
    for (const tCoarse of T_COARSES)
      push(
        'K2c',
        { gamma, tTile: null, tCoarse },
        (g) => tiled({ ...input, origin }, origin, windowOf(input, gamma), tCoarse, g, true),
        false,
      );
  for (const gamma of GAMMAS)
    push(
      'K5',
      { gamma, tTile: null, tCoarse: null },
      () => {
        const window = windowOf(input, gamma);
        const faithful = evaluateUntiled({ ...input, origin }, origin, window, 'K5', GAMMA8);
        const rn = evaluateUntiled({ ...input, origin }, origin, window, 'K5', GAMMA8, true);
        return { ...faithful, rnOutcome: rn.outcome };
      },
      false,
    );
  return rows;
}

export function evaluateCorpus(corpus: Corpus): ReportRow[] {
  return corpusRows(corpus).flatMap(evaluateSpec);
}

// ---------------------------------------------------------------------------------------------
// Trajectory cost (cell sets only)

export function evaluateTrajectories(): ReportRow[] {
  const result: ReportRow[] = [];
  const paths = trajectories(originSequences());
  for (const row of trajectoryRows())
    for (const path of paths)
      for (const [candidate, sizes] of [
        ['K1', T_TILES],
        ['K2c', T_COARSES],
      ] as const)
        for (const T of sizes)
          for (const gamma of GAMMAS) {
            const seen = new Set<string>();
            let previousOrigin: { origin: ProjectionPoint; g: number } | undefined;
            let previousLevel: number | null | undefined;
            let frame0Tiles = 0;
            let builds = 0;
            let maxBuilds = 0;
            let maxTiles = 0;
            let sumTiles = 0n;
            let anchorUploads = 0;
            let zoomLevelChanges = 0;
            const rebuildsPerChange: number[] = [];
            let capFrames = 0;
            path.frames.forEach((frame, index) => {
              const input = {
                ...row.input,
                camera: frame.camera,
                zoom: frame.zoom,
                dpr: frame.dpr,
              };
              const originState = originPXTarget(
                frame.camera,
                frame.zoom,
                frame.dpr,
                128,
                previousOrigin,
              );
              let tiles: TileResult | null;
              try {
                tiles = singularCore(input.affine)
                  ? null
                  : tileRow(input, T, windowOf(input, gamma));
              } catch {
                tiles = null;
              }
              const live = tiles?.status === 'OK' ? tiles.cells : [];
              if (tiles?.status === 'TILE_CAP_EXCEEDED') capFrames += 1;
              let frameBuilds = 0;
              for (const cell of live) {
                const key = tileLocus(cell);
                if (!seen.has(key)) {
                  seen.add(key);
                  if (index > 0) frameBuilds += 1;
                }
              }
              if (index === 0) frame0Tiles = live.length;
              else {
                builds += frameBuilds;
                maxBuilds = Math.max(maxBuilds, frameBuilds);
                if (
                  previousOrigin !== undefined &&
                  (originState.origin[0] !== previousOrigin.origin[0] ||
                    originState.origin[1] !== previousOrigin.origin[1])
                )
                  anchorUploads += live.length;
                const level = tiles?.L ?? null;
                if (previousLevel !== undefined && level !== previousLevel) {
                  zoomLevelChanges += 1;
                  rebuildsPerChange.push(frameBuilds);
                }
              }
              previousLevel = tiles?.L ?? null;
              previousOrigin = originState;
              maxTiles = Math.max(maxTiles, live.length);
              sumTiles += BigInt(live.length);
            });
            result.push({
              row: row.id,
              trajectory: path.id,
              candidate,
              sweep: {
                gamma,
                tTile: candidate === 'K1' ? T : null,
                tCoarse: candidate === 'K2c' ? T : null,
              },
              frames: path.frames.length,
              frame0Tiles,
              builds: { total: builds, maxPerFrame: maxBuilds },
              tilesPerFrame: {
                max: maxTiles,
                mean: r(rational(sumTiles, BigInt(path.frames.length))),
              },
              anchorUploads,
              zoomLevelChanges,
              rebuildsPerChange,
              capFrames,
            });
          }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Summary and document

const SWEEP_KEY = (sweep: { gamma: number; tTile: number | null; tCoarse: number | null }) =>
  `${sweep.gamma}/${sweep.tTile ?? 'null'}/${sweep.tCoarse ?? 'null'}`;

export function summarize(rows: readonly ReportRow[], skipped: readonly string[]) {
  const groups = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const sweep = row.sweep as { gamma: number; tTile: number | null; tCoarse: number | null };
    const spec = row as {
      corpus: string;
      candidate: string;
      gammaModel: string;
      flags: string[];
      dpr: string;
    };
    const dprGroup = spec.corpus === 'O' ? (spec.dpr === '3' ? '3' : 'acceptance') : 'all';
    const key = `${spec.candidate}|${SWEEP_KEY(sweep)}|${spec.gammaModel}|${spec.corpus}|${dprGroup}`;
    const group = groups.get(key) ?? {
      candidate: spec.candidate,
      sweep,
      gammaModel: spec.gammaModel,
      corpus: spec.corpus,
      dprGroup,
      admitted: 0,
      notAdmitted: 0,
      outOfDomain: 0,
      noInWindow: 0,
      tileCap: 0,
    };
    const outcome = row.outcome as string;
    const field =
      outcome === 'ADMITTED'
        ? 'admitted'
        : outcome === 'OUT_OF_DOMAIN'
          ? 'outOfDomain'
          : outcome === 'NO_IN_WINDOW_TRIANGLES'
            ? 'noInWindow'
            : outcome === 'TILE_CAP_EXCEEDED'
              ? 'tileCap'
              : 'notAdmitted';
    group[field] = (group[field] as number) + 1;
    groups.set(key, group);
  }
  const classA = rows
    .filter((row) => (row.flags as string[]).includes('classA') && row.gammaModel === 'G8')
    .map((row) => ({
      corpus: row.corpus,
      id: row.id,
      candidate: row.candidate,
      sweep: row.sweep,
      outcome: row.outcome,
    }));
  const sRows = corpusRows('S');
  const sById = new Map(sRows.map((spec) => [spec.id, spec.s!]));
  const families = new Map<
    string,
    { record: Record<string, unknown>; byK: Map<number, boolean> }
  >();
  for (const row of rows) {
    if (row.corpus !== 'S' || row.gammaModel !== 'G8') continue;
    const s = sById.get(row.id as string)!;
    const sweep = row.sweep as { gamma: number; tTile: number | null; tCoarse: number | null };
    const key = `${String(row.candidate)}|${SWEEP_KEY(sweep)}|${s.zoom}|${s.dpr}|${s.linear}|${s.shape}`;
    const family = families.get(key) ?? {
      record: {
        candidate: row.candidate,
        sweep,
        zoom: ratio(s.zoom),
        dpr: ratio(s.dpr),
        linear: s.linear,
        shape: s.shape,
      },
      byK: new Map<number, boolean>(),
    };
    family.byK.set(s.k, row.outcome === 'ADMITTED');
    families.set(key, family);
  }
  const mMax = [...families.values()].map(({ record, byK }) => {
    const ks = [...byK.keys()].sort((a, b) => a - b);
    let best: number | null = null;
    for (const k of ks) {
      if (!byK.get(k)) break;
      best = k;
    }
    const value = best === null ? null : best === ks.at(-1) ? `>=${best}` : best;
    return { ...record, mMax: value };
  });
  const c2Skipped = rows.filter((row) => row.c2Skipped !== null).length;
  return { admission: [...groups.values()], classA, mMax, skipped: { sRows: skipped, c2Skipped } };
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export const T01_SOURCES = [
  'tests/geometry/extent-t01/core.ts',
  'tests/geometry/extent-t01/clip.ts',
  'tests/geometry/extent-t01/tile.ts',
  'tests/geometry/extent-t01/tile-certificate.ts',
  'tests/geometry/extent-t01/k5.ts',
  'tests/geometry/extent-t01/synthetic.ts',
  'tests/geometry/extent-t01/report.ts',
  'tests/geometry/extent-t01/sources.ts',
] as const;

export function documentOf(rows: readonly ReportRow[], trajectoryRecords: readonly ReportRow[]) {
  const note = execFileSync('git', ['show', `${T01_CONTRACT_COMMIT}:${T01_CONTRACT}`]);
  const sources: Record<string, string> = {};
  for (const path of [...T01_SOURCES, ...Object.keys(PINNED_SOURCES)].sort())
    sources[path] = sha256(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'));
  return {
    contract: { commit: T01_CONTRACT_COMMIT, path: T01_CONTRACT, sha256: sha256(note) },
    sources,
    sweeps: { gamma: [...GAMMAS], tTile: [...T_TILES], tCoarse: [...T_COARSES] },
    rows,
    summary: summarize(rows, syntheticRows().skipped),
    trajectories: trajectoryRecords,
  };
}

export const bitsHex = (value: number) => bitsOf(value).toString(16).padStart(16, '0');
