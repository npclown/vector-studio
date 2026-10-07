import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ProjectionInput, ProjectionPoint } from '../mesh-projection/model.js';
import { q } from '../position-certificate/certificate.js';
import { originSequences } from '../position-certificate/corpus.js';
import { trajectories } from '../position-certificate/r3-window.js';
import { compare, div, mul, rational, sign, sub, type Rational } from '../rounded-fill/exact.js';
import type { Q2 } from '../extent-t01/clip.js';
import { domainOk, INPUT_MAX, packLanesCore, singularCore } from '../extent-t01/core.js';
import { corpusRows, r } from '../extent-t01/report.js';
import { PINNED_SOURCES } from '../extent-t01/sources.js';
import { trajectoryRows } from '../extent-t01/synthetic.js';
import { simulateLanes } from '../extent-t01/tile-certificate.js';
import { c2Merged, type Linear } from './clearance.js';
import { trajectoryCells } from './cells.js';
import {
  candidateCells,
  certifyEpochCore,
  epochOf,
  epochPosition,
  epochWindow,
  frameInEpoch,
  GUARD,
  preimageQuad,
  type Epoch,
  type EpochInput,
} from './epoch.js';
import { buildLists, featuresOf, listStats } from './lists.js';
import { buildMergedMesh, sourceContext, type MergedMesh, type SourceContext } from './merged.js';
import { checkMergedPartition } from './partition.js';
import {
  cameraVariants,
  CLASS_A_IDS,
  SLIVER_EXEMPT_IDS,
  variantBaseRows,
  type ClassARow,
} from './variants.js';

/**
 * P3.1p T02 report assembly (docs/plans/p3-r2-tiling-contract.md, "T02 offline exact evidence").
 * Exact values are rational strings; nothing depends on timing or platform.
 */

const f = Math.fround;

export const T02_CORPORA = ['C', 'L', 'O', 'S', 'A'] as const;
export type T02Corpus = (typeof T02_CORPORA)[number];

export type T02Spec = Readonly<{
  corpus: T02Corpus;
  id: string;
  variantOf: string | null;
  input: ProjectionInput;
  dprGroup: string;
  flags: readonly string[];
}>;

export type ReportRow = Readonly<Record<string, unknown>>;

const ratio = (value: number): string => {
  if (Number.isInteger(value)) return String(value);
  const exact = q(value);
  return `${exact.n}/${exact.d}`;
};

/** C, L, O and S from T01; A: the class A rows, each followed by its camera variants. */
export function t02Specs(corpus: T02Corpus): T02Spec[] {
  if (corpus !== 'A')
    return corpusRows(corpus).map((spec) => ({
      corpus,
      id: spec.id,
      variantOf: null,
      input: spec.input,
      dprGroup: spec.dprGroup,
      flags: spec.flags,
    }));
  const specs: T02Spec[] = [];
  for (const row of variantBaseRows()) {
    const classA = (CLASS_A_IDS as readonly string[]).includes(row.id);
    if (classA)
      specs.push({
        corpus,
        id: row.id,
        variantOf: null,
        input: row.input,
        dprGroup: 'all',
        flags: ['classA'],
      });
    for (const variant of cameraVariants(row))
      specs.push({
        corpus,
        id: variant.id,
        variantOf: variant.variantOf,
        input: variant.input,
        dprGroup: 'all',
        flags: variant.inDomain ? ['variant'] : ['variant', 'CAMERA_OUT_OF_DOMAIN'],
      });
  }
  return specs;
}

type C2Counts = Readonly<{ vertex: number; edge: number; triangle: number; wedge: number }>;

function emptyRow(
  spec: T02Spec,
  outcome: string,
  evaluated = { position: false, c2: false, partition: false, lists: false },
) {
  return {
    corpus: spec.corpus,
    id: spec.id,
    variantOf: spec.variantOf,
    dpr: ratio(spec.input.dpr),
    outcome,
    counts: {
      candidates: 0,
      drawnCells: 0,
      fringeCells: 0,
      records: 0,
      carriers: 0,
      regionTriangles: 0,
      fringeTriangles: 0,
    },
    L: null as number | null,
    epoch: null as { zqLo: string | null; zqHi: string | null; g: number } | null,
    Ebar: null as string | null,
    c2Failures: null as C2Counts | null,
    partition: null as string | null,
    lists: null as { max: number; p99: number; total: number } | null,
    reach: null as { rhoL: string | null; lambda: string | null } | null,
    inversions: null as number | null,
    sliver: null as { piece: string; term: string } | null,
    evaluated,
    flags: [...spec.flags],
  };
}

/** Inversions at the row camera: each record simulated on its owner carrier (T01 simulateLanes). */
function inversionsOf(input: ProjectionInput, epoch: Epoch, mesh: MergedMesh): number {
  const carrierOf = new Map(
    mesh.carriers.map((carrier) => [`${carrier.owner[0]},${carrier.owner[1]}`, carrier]),
  );
  const recovered: (readonly [number, number] | null)[] = mesh.records.map((record) => {
    const carrier = carrierOf.get(`${record.owner[0]},${record.owner[1]}`)!;
    const lanes = packLanesCore(
      [record.v64],
      input.affine,
      input.camera,
      input.zoom,
      input.dpr,
      carrier.m,
      epoch.origin,
    );
    return simulateLanes(lanes, input).recovered[0] ?? null;
  });
  const orient = (a: Q2, b: Q2, c: Q2) =>
    sign(sub(mul(sub(b[0], a[0]), sub(c[1], a[1])), mul(sub(b[1], a[1]), sub(c[0], a[0]))));
  const [la, lb, lc, ld] = input.affine.slice(0, 4).map(q) as [
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  const det = sign(sub(mul(la, ld), mul(lb, lc)));
  let count = 0;
  for (const triangle of mesh.triangles) {
    const reference =
      orient(...(triangle.ids.map((id) => mesh.records[id]!.pos) as [Q2, Q2, Q2])) * det;
    const drawn = triangle.ids.map((id) => recovered[id]);
    if (
      drawn.some((point) => point === null || point === undefined || !point.every(Number.isFinite))
    ) {
      count += 1;
      continue;
    }
    const points = drawn.map((point) => [q(point![0]), q(point![1])] as Q2) as [Q2, Q2, Q2];
    if (orient(...points) !== reference) count += 1;
  }
  return count;
}

/** Closed cells incident to an exact point (1, 2 or 4 cells). */
function incidentCells(point: Q2, L: number): Set<string> {
  const unit = L >= 0 ? rational(1n << BigInt(L)) : rational(1n, 1n << BigInt(-L));
  const indices = (value: Rational): bigint[] => {
    const scaled = div(value, unit);
    const floor = scaled.n / scaled.d - (scaled.n % scaled.d !== 0n && scaled.n < 0n ? 1n : 0n);
    return scaled.n % scaled.d === 0n ? [floor - 1n, floor] : [floor];
  };
  const result = new Set<string>();
  for (const i of indices(point[0])) for (const j of indices(point[1])) result.add(`${i},${j}`);
  return result;
}

function pointInCells(point: Q2, L: number, cells: ReadonlySet<string>): boolean {
  return [...incidentCells(point, L)].some((key) => cells.has(key));
}

export function evaluateSpec(spec: T02Spec): ReportRow {
  const input = spec.input;
  if (spec.flags.includes('INPUT_UNSUPPORTED') || spec.flags.includes('CAMERA_OUT_OF_DOMAIN'))
    return emptyRow(spec, 'OUT_OF_DOMAIN');
  if (!domainOk(input.mesh.vertices, input)) return emptyRow(spec, 'OUT_OF_DOMAIN');
  if (singularCore(input.affine)) return emptyRow(spec, 'NOT_ADMITTED:singular');
  const epoch = epochOf(input);
  if (epoch === null) return emptyRow(spec, 'NOT_ADMITTED:lane-range:level');
  const row = emptyRow(spec, '');
  row.L = epoch.L;
  row.epoch = { zqLo: r(epoch.zqLo), zqHi: r(epoch.zqHi), g: epoch.g };
  const quad = preimageQuad(input.affine, epochWindow(epoch));
  const candidates = candidateCells(quad, epoch.L);
  if (candidates.status !== 'OK') return { ...row, outcome: 'TILE_CAP_EXCEEDED' };
  row.counts.candidates = candidates.cells.length;
  const built = buildMergedMesh(input, {
    L: epoch.L,
    candidates: candidates.cells.map(([i, j]) => ({ i, j })),
    rhoL: epoch.rhoL,
  });
  if (built.status === 'LANE_RANGE')
    return { ...row, outcome: `NOT_ADMITTED:lane-range:${built.locus}` };
  if (built.status === 'PARTITION')
    return {
      ...row,
      outcome: `NOT_ADMITTED:partition:${built.check}`,
      partition: built.check,
      evaluated: { position: false, c2: false, partition: true, lists: false },
    };
  const mesh = built.mesh;
  const region = mesh.triangles.filter((t) => t.role === 'region').length;
  row.counts = {
    candidates: candidates.cells.length,
    drawnCells: mesh.cells.filter((cell) => cell.region || cell.fringe).length,
    fringeCells: mesh.cells.filter((cell) => cell.fringe).length,
    records: mesh.records.length,
    carriers: mesh.carriers.length,
    regionTriangles: region,
    fringeTriangles: mesh.triangles.length - region,
  };
  row.reach = { rhoL: r(epoch.rhoL), lambda: r(epoch.lambdaL) };
  if (mesh.triangles.length === 0)
    return { ...row, outcome: 'NO_IN_WINDOW_TRIANGLES', reach: null };

  // S1: guard 4 on every v64 (lane ranges are checked inside certifyEpochCore).
  const v64Index = mesh.records.findIndex((record) =>
    record.v64.some((value) => compare(q(Math.abs(value)), INPUT_MAX) > 0),
  );
  if (v64Index >= 0)
    return { ...row, outcome: `NOT_ADMITTED:lane-range:r${v64Index}`, reach: null };
  const carrierOf = new Map(
    mesh.carriers.map((carrier) => [`${carrier.owner[0]},${carrier.owner[1]}`, carrier.m]),
  );
  const bound = certifyEpochCore(
    input,
    epoch,
    mesh.records.map((record) => ({
      pos: record.pos,
      v64: record.v64,
      m: carrierOf.get(`${record.owner[0]},${record.owner[1]}`)!,
    })),
  );
  if (bound.status !== 'OK')
    return {
      ...row,
      outcome: `NOT_ADMITTED:lane-range:${bound.record < 0 ? 'fmax' : `r${bound.record}`}`,
      reach: null,
    };

  // S2.
  const position = epochPosition(bound.errors);
  const eBar = position.eBar!;
  row.Ebar = r(eBar);
  // S3 at s_lo, δ = Ē.
  const points = mesh.records.map((record) => record.pos);
  const flat = mesh.triangles.flatMap((triangle) => triangle.ids);
  const linear = input.affine.slice(0, 4).map(q) as unknown as Linear;
  let c2: ReturnType<typeof c2Merged> | null = null;
  let c2Error: string | null = null;
  try {
    c2 = c2Merged(points, flat, linear, epoch.sLo, mul(eBar, eBar), epoch.L);
  } catch (error) {
    const message = (error as Error).message;
    if (!message.startsWith('input:')) throw error;
    c2Error = message.slice('input:'.length);
  }
  row.c2Failures =
    c2 === null
      ? null
      : {
          vertex: c2.failing.vertex ? 1 : 0,
          edge: c2.failing.edge ? 1 : 0,
          triangle: c2.failing.triangle ? 1 : 0,
          wedge: c2.failing.wedge ? 1 : 0,
        };
  row.evaluated = { position: true, c2: true, partition: false, lists: false };
  row.inversions = inversionsOf(input, epoch, mesh);
  if (position.firstFailing !== null)
    return { ...row, outcome: `NOT_ADMITTED:position:r${position.firstFailing}` };
  if (c2Error !== null) return { ...row, outcome: `NOT_ADMITTED:input:${c2Error}` };
  let sliver: { piece: string; term: string } | null = null;
  if (c2!.term !== null) {
    if (SLIVER_EXEMPT_IDS.includes(spec.id) && !c2!.unlocated) {
      const v1 = spec.input.mesh.vertices[1]!;
      const v1Pos: Q2 = [q(v1[0]), q(v1[1])];
      const cells = incidentCells(v1Pos, epoch.L);
      if ([...c2!.failingPoints].every((id) => pointInCells(points[id]!, epoch.L, cells)))
        sliver = { piece: [...cells].sort().join('|'), term: c2!.term };
    }
    if (sliver === null) return { ...row, outcome: `NOT_ADMITTED:${c2!.term}` };
  }
  // S4 (also run for a sliver-exempt row, whose exemption stands only if S4 and S5 pass).
  const c2Outcome = c2!.term === null ? null : `NOT_ADMITTED:${c2!.term}`;
  const partition = checkMergedPartition(mesh);
  row.evaluated = { position: true, c2: true, partition: true, lists: false };
  if (!partition.ok)
    return {
      ...row,
      outcome: `NOT_ADMITTED:partition:${partition.check}`,
      partition: partition.check,
    };
  // S5.
  const features = featuresOf(
    mesh.boundary.edges,
    mesh.boundary.vertices.map((vertex) => vertex.id),
  );
  const lists = buildLists(
    points,
    mesh.triangles.map((triangle) => triangle.ids),
    features,
    epoch.lambdaL,
    linear,
    epoch.sL,
    epoch.L,
  );
  row.lists = listStats(lists.lists);
  row.evaluated = { position: true, c2: true, partition: true, lists: true };
  if (lists.failing !== null) return { ...row, outcome: `NOT_ADMITTED:lists:t${lists.failing}` };
  if (c2Outcome !== null) return { ...row, outcome: c2Outcome, sliver };
  return { ...row, outcome: 'ADMITTED' };
}

export function evaluateCorpus(corpus: T02Corpus): ReportRow[] {
  return t02Specs(corpus).map(evaluateSpec);
}

// ---------------------------------------------------------------------------------------------
// Trajectories (cell sets without clipping; builds are upper bounds).

const G3_BAND_PX = rational(12283n, 10000n);

export function trajectoryStarts(): { id: string; input: ProjectionInput }[] {
  const starts = trajectoryRows();
  for (const row of variantBaseRows().filter((base): base is ClassARow =>
    (CLASS_A_IDS as readonly string[]).includes(base.id),
  )) {
    const variant = cameraVariants(row).find((candidate) => candidate.id === `${row.id}/cam:v1`)!;
    starts.push({ id: variant.id, input: variant.input });
  }
  return starts;
}

function frameCellsOK(
  frame: EpochInput,
  epoch: Epoch,
  candidates: ReadonlySet<string>,
  drawn: ReadonlySet<string>,
  input: ProjectionInput,
  context: SourceContext,
): boolean {
  const s0 = mul(q(frame.zoom), q(frame.dpr));
  const [cx, cy] = frame.camera.map(q) as [Rational, Rational];
  const g = rational(BigInt(GUARD));
  const rect = {
    x0: sub(cx, div(g, s0)),
    y0: sub(cy, div(g, s0)),
    x1: sub(cx, div(sub(rational(0n), rational(BigInt(frame.width + GUARD))), s0)),
    y1: sub(cy, div(sub(rational(0n), rational(BigInt(frame.height + GUARD))), s0)),
  };
  const frameCells = candidateCells(preimageQuad(input.affine, rect), epoch.L);
  if (frameCells.status !== 'OK') return false;
  for (const [i, j] of frameCells.cells) if (!candidates.has(`${i},${j}`)) return false;
  // G3 band: frame cells meeting a boundary edge's box dilated by 1.2283 px (local, at s0) are drawn.
  const reach = div(mul(G3_BAND_PX, epoch.n), s0);
  const unit =
    epoch.L >= 0 ? rational(1n << BigInt(epoch.L)) : rational(1n, 1n << BigInt(-epoch.L));
  const frameSet = new Set(frameCells.cells.map(([i, j]) => `${i},${j}`));
  for (const edge of context.edges) {
    if (!edge.boundary) continue;
    const xs = [edge.a[0], edge.b[0]];
    const ys = [edge.a[1], edge.b[1]];
    const lo = (values: Rational[]) => values.reduce((m, v) => (compare(v, m) < 0 ? v : m));
    const hi = (values: Rational[]) => values.reduce((m, v) => (compare(v, m) > 0 ? v : m));
    // Closed squares: index range [ceil(lo/unit) − 1, floor(hi/unit)].
    const floorIdx = (value: Rational) => {
      const scaled = div(value, unit);
      return scaled.n / scaled.d - (scaled.n % scaled.d !== 0n && scaled.n < 0n ? 1n : 0n);
    };
    const ceilIdx = (value: Rational) => {
      const scaled = div(value, unit);
      return scaled.n / scaled.d + (scaled.n % scaled.d !== 0n && scaled.n > 0n ? 1n : 0n);
    };
    const i0 = ceilIdx(sub(lo(xs), reach)) - 1n;
    const i1 = floorIdx(sub(hi(xs), sub(rational(0n), reach)));
    const j0 = ceilIdx(sub(lo(ys), reach)) - 1n;
    const j1 = floorIdx(sub(hi(ys), sub(rational(0n), reach)));
    for (const key of frameSet) {
      const [i, j] = key.split(',').map(BigInt) as [bigint, bigint];
      if (i >= i0 && i <= i1 && j >= j0 && j <= j1 && !drawn.has(`${epoch.L},${i},${j}`))
        return false;
    }
  }
  return true;
}

export function evaluateTrajectories(): ReportRow[] {
  const result: ReportRow[] = [];
  const paths = trajectories(originSequences());
  for (const start of trajectoryStarts())
    for (const path of paths) {
      const offset = [
        start.input.camera[0] - path.frames[0]!.camera[0],
        start.input.camera[1] - path.frames[0]!.camera[1],
      ];
      const seen = new Set<string>();
      let previous: { origin: ProjectionPoint; g: number } | undefined;
      let epoch: Epoch | null = null;
      let epochKey = '';
      let candidates = new Set<string>();
      let drawn = new Set<string>();
      let epochs = 0;
      let rebases = 0;
      let levelChanges = 0;
      let builds = 0;
      let maxBuilds = 0;
      let maxCells = 0;
      let sumCells = 0;
      let maxCarriers = 0;
      let anchorUploads = 0;
      let capFrames = 0;
      let violations = 0;
      let previousL: number | null = null;
      let capped = false;
      const context = sourceContext(start.input);
      for (const frame of path.frames) {
        const input: ProjectionInput = {
          ...start.input,
          camera: [frame.camera[0] + offset[0]!, frame.camera[1] + offset[1]!],
          zoom: frame.zoom,
          dpr: frame.dpr,
        };
        const frameEpoch = epochOf(input, previous);
        if (frameEpoch === null) {
          capFrames += 1;
          continue;
        }
        previous = { origin: frameEpoch.origin, g: frameEpoch.g };
        const key = `${frameEpoch.origin[0]},${frameEpoch.origin[1]},${frameEpoch.g},${frameEpoch.L},${input.width},${input.height},${f(input.dpr)}`;
        if (key !== epochKey) {
          if (epoch !== null) {
            if (frameEpoch.L !== previousL) levelChanges += 1;
            else rebases += 1;
          }
          epoch = frameEpoch;
          epochKey = key;
          epochs += 1;
          previousL = frameEpoch.L;
          const cells = candidateCells(
            preimageQuad(input.affine, epochWindow(frameEpoch)),
            frameEpoch.L,
          );
          capped = cells.status !== 'OK';
          if (cells.status === 'OK') {
            candidates = new Set(cells.cells.map(([i, j]) => `${i},${j}`));
            drawn = trajectoryCells(
              input,
              frameEpoch.L,
              cells.cells.map(([i, j]) => ({ i, j })),
              frameEpoch.rhoL,
              context,
            );
            let fresh = 0;
            for (const cell of drawn)
              if (!seen.has(cell)) {
                seen.add(cell);
                fresh += 1;
              }
            builds += fresh;
            maxBuilds = Math.max(maxBuilds, fresh);
            maxCells = Math.max(maxCells, drawn.size);
            sumCells += drawn.size;
            // Carriers: every owner cell a record of a drawn cell can reference (its closed corners).
            const owners = new Set<string>();
            for (const cell of drawn) {
              const [, i, j] = cell.split(',').map(BigInt) as [bigint, bigint, bigint];
              for (const [di, dj] of [
                [0n, 0n],
                [1n, 0n],
                [0n, 1n],
                [1n, 1n],
              ] as const)
                owners.add(`${i + di},${j + dj}`);
            }
            maxCarriers = Math.max(maxCarriers, owners.size);
            anchorUploads += owners.size;
          }
        }
        if (capped) {
          capFrames += 1;
          continue;
        }
        if (
          !frameInEpoch(epoch!, input, frameEpoch) ||
          !frameCellsOK(input, epoch!, candidates, drawn, input, context)
        )
          violations += 1;
      }
      result.push({
        row: start.id,
        trajectory: path.id,
        frames: path.frames.length,
        epochs,
        rebases,
        levelChanges,
        builds: { total: builds, maxPerEpochStart: maxBuilds },
        cellsPerEpochStart: {
          max: maxCells,
          mean: epochs === 0 ? null : r(rational(BigInt(sumCells), BigInt(epochs))),
        },
        liveCarriers: { max: maxCarriers },
        anchorUploads,
        capFrames,
        coverageViolations: violations,
      });
    }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Summary, gates and document.

export const T01_REPORT = 'docs/evidence/p3.1p-t01/report.json';
export const T01_REPORT_SHA256 = '5e49c8807a57984bb84f6ce4d72b53fe96893e71fc2a6d274088c46277d47a26';

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const termOf = (outcome: string) => {
  if (outcome === 'ADMITTED') return 'admitted';
  if (outcome.startsWith('NOT_ADMITTED:')) return outcome.split(':')[1]!;
  return outcome;
};

const keyOf = (...parts: unknown[]) => parts.map((part) => String(part)).join('|');

export function summarize(rows: readonly ReportRow[], trajectoryRecords: readonly ReportRow[]) {
  const groups = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const corpus = row.corpus as string;
    const group = corpus === 'O' ? ((row.dpr as string) === '3' ? '3' : 'acceptance') : 'all';
    const key = `${corpus}/${group}`;
    const entry = groups.get(key) ?? {
      corpus,
      dprGroup: group,
      total: 0,
      outcomes: Object.create(null) as Record<string, number>,
    };
    entry.total = (entry.total as number) + 1;
    const outcomes = entry.outcomes as Record<string, number>;
    const term = termOf(row.outcome as string);
    outcomes[term] = (outcomes[term] ?? 0) + 1;
    groups.set(key, entry);
  }
  const classA = rows
    .filter((row) => row.corpus === 'A')
    .map((row) => ({ id: row.id, outcome: row.outcome, sliver: row.sliver }));

  // Gate 3: T01 K1@256, γ = 4, G8 admitted rows on O acceptance.
  const archived = readFileSync(T01_REPORT, 'utf8').replaceAll('\r\n', '\n');
  const archiveHash = sha256(archived);
  const t01 = (JSON.parse(archived) as { rows: ReportRow[] }).rows.filter(
    (row) =>
      row.corpus === 'O' &&
      row.candidate === 'K1' &&
      (row.sweep as { gamma: number; tTile: number }).gamma === 4 &&
      (row.sweep as { tTile: number }).tTile === 256 &&
      row.gammaModel === 'G8' &&
      row.dpr !== '3' &&
      row.outcome === 'ADMITTED',
  );
  const t02 = new Map(
    rows.filter((row) => row.corpus === 'O').map((row) => [keyOf(row.id, row.dpr), row.outcome]),
  );
  const losses = t01
    .map((row) => ({
      id: row.id,
      dpr: row.dpr,
      outcome: t02.get(keyOf(row.id, row.dpr)) ?? 'MISSING',
    }))
    .filter((loss) => loss.outcome !== 'ADMITTED');
  const t01CL = (JSON.parse(archived) as { rows: ReportRow[] }).rows.filter(
    (row) =>
      (row.corpus === 'C' || row.corpus === 'L') &&
      row.candidate === 'K1' &&
      (row.sweep as { gamma: number }).gamma === 4 &&
      (row.sweep as { tTile: number }).tTile === 256 &&
      row.gammaModel === 'G8' &&
      row.outcome === 'ADMITTED',
  );
  const t02CL = new Map(
    rows
      .filter((row) => row.corpus === 'C' || row.corpus === 'L')
      .map((row) => [keyOf(row.corpus, row.id, row.dpr), row.outcome]),
  );
  const lossesCL = t01CL
    .map((row) => ({
      corpus: row.corpus,
      id: row.id,
      outcome: t02CL.get(keyOf(row.corpus, row.id, row.dpr)) ?? 'MISSING',
    }))
    .filter((loss) => loss.outcome !== 'ADMITTED');

  const partitionFailures = rows
    .filter((row) => (row.outcome as string).includes(':partition:'))
    .map((row) => row.id);
  const classAFailures = rows
    .filter((row) => row.corpus === 'A' && row.outcome !== 'ADMITTED' && row.sliver === null)
    .map((row) => ({ id: row.id, outcome: row.outcome }));
  const classAOwn = rows
    .filter((row) => row.corpus === 'A' && row.variantOf === null)
    .every((row) => row.outcome === 'ADMITTED');
  const violations = trajectoryRecords.reduce(
    (sum, record) => sum + (record.coverageViolations as number),
    0,
  );
  return {
    admission: [...groups.values()],
    classA,
    gate3: {
      t01Report: { path: T01_REPORT, sha256: archiveHash, expected: T01_REPORT_SHA256 },
      compared: t01.length,
      losses,
      lossesCL,
    },
    gates: {
      partition: { pass: partitionFailures.length === 0, failures: partitionFailures },
      classA: {
        pass: classAOwn && classAFailures.length === 0,
        ownCamerasAdmitted: classAOwn,
        failures: classAFailures,
      },
      noRegressionO: {
        pass: losses.length === 0 && archiveHash === T01_REPORT_SHA256,
        losses: losses.length,
      },
      frameCoverage: { pass: violations === 0, violations },
    },
  };
}

export const T02_SOURCES = [
  'tests/geometry/extent-t02/cells.ts',
  'tests/geometry/extent-t02/clearance.ts',
  'tests/geometry/extent-t02/epoch.ts',
  'tests/geometry/extent-t02/fringe.ts',
  'tests/geometry/extent-t02/lists.ts',
  'tests/geometry/extent-t02/merged.ts',
  'tests/geometry/extent-t02/partition.ts',
  'tests/geometry/extent-t02/report.ts',
  'tests/geometry/extent-t02/variants.ts',
  'tests/geometry/extent-t02-clearance.test.ts',
  'tests/geometry/extent-t02-epoch.test.ts',
  'tests/geometry/extent-t02-lists.test.ts',
  'tests/geometry/extent-t02-merged.test.ts',
  'tests/geometry/extent-t02-pinned.test.ts',
  'tests/p3-t02/report.test.ts',
  'vitest.p3-t02.config.ts',
] as const;

/** T01 code and pinned files that T02 imports; they stay byte-unchanged. */
export const T02_PINNED = [
  'tests/geometry/extent-t01/clip.ts',
  'tests/geometry/extent-t01/core.ts',
  'tests/geometry/extent-t01/report.ts',
  'tests/geometry/extent-t01/sources.ts',
  'tests/geometry/extent-t01/synthetic.ts',
  'tests/geometry/extent-t01/tile-certificate.ts',
  'tests/geometry/extent-t01/tile.ts',
  'tests/geometry/coverage-oracle/exterior.ts',
  ...Object.keys(PINNED_SOURCES),
] as const;

export const T02_CONTRACT = 'docs/plans/p3-r2-tiling-contract.md';
/** The main commit that integrated the R2 contract FROZEN (PR #119). */
export const T02_CONTRACT_COMMIT = 'e12804914bc459be68287d5e8491061e2cce252c';

export function documentOf(rows: readonly ReportRow[], trajectoryRecords: readonly ReportRow[]) {
  const commit = T02_CONTRACT_COMMIT;
  const note = execFileSync('git', ['show', `${commit}:${T02_CONTRACT}`]);
  const sources: Record<string, string> = {};
  for (const path of [...T02_SOURCES, ...T02_PINNED].sort())
    sources[path] = sha256(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'));
  return {
    contract: { commit, sha256: sha256(note) },
    sources,
    rows,
    summary: summarize(rows, trajectoryRecords),
    trajectories: trajectoryRecords,
  };
}
