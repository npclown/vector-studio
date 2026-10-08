import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ProjectionInput, ProjectionPoint } from '../mesh-projection/model.js';
import { q, sqrtUp } from '../position-certificate/certificate.js';
import { originSequences } from '../position-certificate/corpus.js';
import { trajectories } from '../position-certificate/r3-window.js';
import {
  add,
  compare,
  div,
  mul,
  rational,
  sign,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';
import type { Q2 } from '../extent-t01/clip.js';
import {
  bboxMidpoint,
  domainOk,
  INPUT_MAX,
  LIMIT,
  packLanesCore,
  singularCore,
} from '../extent-t01/core.js';
import { r } from '../extent-t01/report.js';
import { PINNED_SOURCES } from '../extent-t01/sources.js';
import { simulateLanes } from '../extent-t01/tile-certificate.js';
import type { Linear } from '../extent-t02/clearance.js';
import {
  candidateCells,
  certifyEpochCore,
  epochOf,
  epochPosition,
  epochWindow,
  preimageQuad,
  type Epoch,
  type EpochRecord,
} from '../extent-t02/epoch.js';
import { buildLists, featuresOf, listStats } from '../extent-t02/lists.js';
import { buildMergedMesh, type MergedMesh } from '../extent-t02/merged.js';
import { checkMergedPartition } from '../extent-t02/partition.js';
import {
  evaluateTrajectories as t02Trajectories,
  T01_REPORT,
  T01_REPORT_SHA256,
  T02_CORPORA,
  T02_SOURCES,
  t02Specs,
  trajectoryStarts,
  type T02Corpus,
  type T02Spec,
} from '../extent-t02/report.js';
import { flipMergedExteriors } from './delaunay.js';
import { c2Local, subBand, type C2Local } from './local.js';
import { ownerCentres } from './owner.js';

/**
 * P3.1p T03 report assembly (docs/plans/p3-r2-tiling-rev4-contract.md, "T03 evidence"): T02's
 * harness and corpora with D-A (localized C2), D-B (sub-bands), D-C (fringe flips) and D-D (owner
 * carrier centres). Exact values are rational strings; nothing depends on timing or platform.
 */

export const T03_CORPORA = T02_CORPORA;
export type ReportRow = Readonly<Record<string, unknown>>;
export const SUB_BANDS = 4;

const ratio = (value: number): string => {
  if (Number.isInteger(value)) return String(value);
  const exact = q(value);
  return `${exact.n}/${exact.d}`;
};

const C2_TERMS = ['vertex', 'edge', 'triangle', 'wedge'] as const;

function emptyRow(spec: T02Spec, outcome: string) {
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
    c2Failures: null as Record<(typeof C2_TERMS)[number], number> | null,
    partition: null as string | null,
    lists: null as { max: number; p99: number; total: number } | null,
    reach: null as { rhoL: string | null; lambda: string | null } | null,
    inversions: null as number | null,
    evaluated: { position: false, c2: false, partition: false, lists: false },
    flags: [...spec.flags],
    subBand: null as {
      k: number;
      zqLo: string | null;
      zqHi: string | null;
      sLo: string | null;
      sHi: string | null;
    } | null,
    subBandsAdmitted: null as number | null,
    epochAll: null as boolean | null,
    EmaxLocal: null as string | null,
    k4Epoch: null as string | null,
    afterC2: null as { partition: string; lists: string } | null,
  };
}

/** Inversions at the row camera: each record on its D-D owner carrier (T01 simulateLanes). */
function inversionsOf(
  input: ProjectionInput,
  epoch: Epoch,
  mesh: MergedMesh,
  centres: ReadonlyMap<string, readonly [number, number]>,
): number {
  const recovered = mesh.records.map((record) => {
    const m = centres.get(`${record.owner[0]},${record.owner[1]}`)!;
    const lanes = packLanesCore(
      [record.v64],
      input.affine,
      input.camera,
      input.zoom,
      input.dpr,
      m,
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
    if (drawn.some((p) => p === null || p === undefined || !p.every(Number.isFinite))) {
      count += 1;
      continue;
    }
    const points = drawn.map((p) => [q(p![0]), q(p![1])] as Q2) as [Q2, Q2, Q2];
    if (orient(...points) !== reference) count += 1;
  }
  return count;
}

type SubBandCertificate = Readonly<{
  status: 'lane-range' | 'position' | 'input' | 'c2' | 'ok';
  locus: string;
  eBar: Rational | null;
  eMax: Rational | null;
  c2: C2Local | null;
}>;

/** S2 then D-A S3 on one sub-band. */
function certifySubBand(
  input: ProjectionInput,
  band: Epoch,
  records: readonly EpochRecord[],
  points: readonly Q2[],
  flat: readonly number[],
  L: number,
): SubBandCertificate {
  const bound = certifyEpochCore(input, band, records);
  if (bound.status !== 'OK')
    return {
      status: 'lane-range',
      locus: bound.record < 0 ? 'fmax' : `r${bound.record}`,
      eBar: null,
      eMax: null,
      c2: null,
    };
  const position = epochPosition(bound.errors);
  const e2 = bound.errors.map((e) => add(mul(e.ex, e.ex), mul(e.ey, e.ey)));
  const bounds = e2.map(sqrtUp);
  const used = [...new Set(flat)];
  const eMax = used
    .map((id) => bounds[id]!)
    .reduce((m, v) => (compare(v, m) > 0 ? v : m), rational(0n));
  if (position.firstFailing !== null)
    return {
      status: 'position',
      locus: `r${position.firstFailing}`,
      eBar: position.eBar,
      eMax,
      c2: null,
    };
  const linear = input.affine.slice(0, 4).map(q) as unknown as Linear;
  let c2: C2Local;
  try {
    c2 = c2Local(points, flat, linear, band.sLo, bounds, L);
  } catch (error) {
    const message = (error as Error).message;
    if (!message.startsWith('input:')) throw error;
    return {
      status: 'input',
      locus: message.slice('input:'.length),
      eBar: position.eBar,
      eMax,
      c2: null,
    };
  }
  return {
    status: c2.term === null ? 'ok' : 'c2',
    locus: c2.term ?? '',
    eBar: position.eBar,
    eMax,
    c2,
  };
}

function exponentCovering(points: readonly Q2[]): number {
  let span = rational(1n);
  for (const point of points)
    for (const value of point) {
      const magnitude = value.n < 0n ? rational(-value.n, value.d) : value;
      if (compare(magnitude, span) > 0) span = magnitude;
    }
  let k = 0;
  while (compare(rational(1n << BigInt(k)), span) < 0) k += 1;
  return k + 1;
}

/** k4Epoch: the untiled region mesh, one bbox-midpoint carrier, the row's sub-band. */
function k4EpochOf(input: ProjectionInput, band: Epoch): string {
  const vertices = input.mesh.vertices;
  const m = bboxMidpoint(vertices);
  const points = vertices.map((v) => [q(v[0]), q(v[1])] as Q2);
  const used = new Set(input.mesh.indices);
  const bound = certifyEpochCore(
    input,
    band,
    vertices.map((v, index) => ({ pos: points[index]!, v64: v, m })),
  );
  if (bound.status !== 'OK') return 'NOT_ADMITTED:lane-range';
  const e2 = bound.errors.map((e) => add(mul(e.ex, e.ex), mul(e.ey, e.ey)));
  if (e2.some((value, index) => used.has(index) && compare(value, LIMIT) > 0))
    return 'NOT_ADMITTED:position';
  const linear = input.affine.slice(0, 4).map(q) as unknown as Linear;
  try {
    const c2 = c2Local(
      points,
      input.mesh.indices,
      linear,
      band.sLo,
      e2.map(sqrtUp),
      exponentCovering(points),
    );
    return c2.term === null ? 'ADMITTED' : `NOT_ADMITTED:${c2.term}`;
  } catch (error) {
    const message = (error as Error).message;
    if (!message.startsWith('input:')) throw error;
    return `NOT_ADMITTED:input:${message.slice('input:'.length)}`;
  }
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
  if (compare(epoch.zq, epoch.zqLo) <= 0 || compare(epoch.zq, epoch.zqHi) > 0)
    return { ...row, outcome: 'NOT_ADMITTED:lane-range:sub-band' };
  const band = subBand(epoch, SUB_BANDS, epoch.zq);
  row.subBand = {
    k: band.band,
    zqLo: r(band.zqLo),
    zqHi: r(band.zqHi),
    sLo: r(band.sLo),
    sHi: r(band.sHi),
  };
  row.k4Epoch = k4EpochOf(input, band);
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
  // D-C: flips before records, lists, S4 and S5.
  let mesh: MergedMesh;
  try {
    mesh = flipMergedExteriors(input, built.mesh);
  } catch (error) {
    const message = (error as Error).message;
    if (message !== 'partition:delaunay' && message !== 'delaunay:opposite-use') throw error;
    return {
      ...row,
      outcome: `NOT_ADMITTED:partition:delaunay`,
      partition: message === 'partition:delaunay' ? 'delaunay:guard' : 'delaunay:opposite-use',
      evaluated: { position: false, c2: false, partition: true, lists: false },
    };
  }
  const regionCount = mesh.triangles.filter((t) => t.role === 'region').length;
  row.counts = {
    candidates: candidates.cells.length,
    drawnCells: mesh.cells.filter((cell) => cell.region || cell.fringe).length,
    fringeCells: mesh.cells.filter((cell) => cell.fringe).length,
    records: mesh.records.length,
    carriers: mesh.carriers.length,
    regionTriangles: regionCount,
    fringeTriangles: mesh.triangles.length - regionCount,
  };
  row.reach = { rhoL: r(epoch.rhoL), lambda: r(epoch.lambdaL) };
  if (mesh.triangles.length === 0)
    return { ...row, outcome: 'NO_IN_WINDOW_TRIANGLES', reach: null };
  const v64Index = mesh.records.findIndex((record) =>
    record.v64.some((value) => compare(q(Math.abs(value)), INPUT_MAX) > 0),
  );
  if (v64Index >= 0)
    return { ...row, outcome: `NOT_ADMITTED:lane-range:r${v64Index}`, reach: null };
  // D-D carriers.
  let centres: Map<string, [number, number]>;
  try {
    centres = ownerCentres(input, mesh);
  } catch (error) {
    const message = (error as Error).message;
    if (!message.startsWith('owner:corner-inexact:')) throw error;
    return {
      ...row,
      outcome: `NOT_ADMITTED:lane-range:${message.slice('owner:corner-inexact:'.length)}`,
      reach: null,
    };
  }
  const records: EpochRecord[] = mesh.records.map((record) => ({
    pos: record.pos,
    v64: record.v64,
    m: centres.get(`${record.owner[0]},${record.owner[1]}`)!,
  }));
  const points = mesh.records.map((record) => record.pos);
  const flat = mesh.triangles.flatMap((triangle) => triangle.ids);
  // Every sub-band of the epoch (subBandsAdmitted, epochAll); the row's own sub-band decides.
  let admittedBands = 0;
  let own: SubBandCertificate | null = null;
  for (let k = 0; k < SUB_BANDS; k += 1) {
    const width = div(sub(epoch.zqHi, epoch.zqLo), rational(BigInt(SUB_BANDS)));
    const probe = add(epoch.zqLo, mul(rational(BigInt(k + 1)), width));
    const certificate = certifySubBand(
      input,
      subBand(epoch, SUB_BANDS, probe),
      records,
      points,
      flat,
      epoch.L,
    );
    if (certificate.status === 'ok') admittedBands += 1;
    if (k === band.band) own = certificate;
  }
  row.subBandsAdmitted = admittedBands;
  row.epochAll = admittedBands === SUB_BANDS;
  const certificate = own!;
  if (certificate.status === 'lane-range')
    return { ...row, outcome: `NOT_ADMITTED:lane-range:${certificate.locus}`, reach: null };
  row.Ebar = r(certificate.eBar);
  row.EmaxLocal = r(certificate.eMax);
  row.evaluated = { position: true, c2: certificate.c2 !== null, partition: false, lists: false };
  row.inversions = inversionsOf(input, epoch, mesh, centres);
  if (certificate.c2 !== null)
    row.c2Failures = Object.fromEntries(
      C2_TERMS.map((term) => [term, certificate.c2!.failing[term] ? 1 : 0]),
    ) as Record<(typeof C2_TERMS)[number], number>;
  if (certificate.status === 'position')
    return { ...row, outcome: `NOT_ADMITTED:position:${certificate.locus}` };
  if (certificate.status === 'input')
    return { ...row, outcome: `NOT_ADMITTED:input:${certificate.locus}` };
  // S4 and S5 (also after a C2 failure, recorded in afterC2).
  const partition = checkMergedPartition(mesh);
  const features = featuresOf(
    mesh.boundary.edges,
    mesh.boundary.vertices.map((vertex) => vertex.id),
  );
  const linear = input.affine.slice(0, 4).map(q) as unknown as Linear;
  const lists = partition.ok
    ? buildLists(
        points,
        mesh.triangles.map((triangle) => triangle.ids),
        features,
        epoch.lambdaL,
        linear,
        epoch.sL,
        epoch.L,
      )
    : null;
  const afterChecks = {
    partition: partition.ok ? 'ok' : partition.check,
    lists: lists === null ? 'not-run' : lists.failing === null ? 'ok' : `t${lists.failing}`,
  };
  if (certificate.status === 'c2') {
    row.afterC2 = afterChecks;
    return { ...row, outcome: `NOT_ADMITTED:${certificate.locus}` };
  }
  row.evaluated = { position: true, c2: true, partition: true, lists: lists !== null };
  if (!partition.ok)
    return {
      ...row,
      outcome: `NOT_ADMITTED:partition:${partition.check}`,
      partition: partition.check,
    };
  row.lists = listStats(lists!.lists);
  if (lists!.failing !== null) return { ...row, outcome: `NOT_ADMITTED:lists:t${lists!.failing}` };
  return { ...row, outcome: 'ADMITTED' };
}

export function evaluateCorpus(corpus: T02Corpus): ReportRow[] {
  return t02Specs(corpus).map(evaluateSpec);
}

// ---------------------------------------------------------------------------------------------
// Trajectories: T02's records plus independent sub-band assignment (contract "Trajectories").

export function evaluateTrajectories(): ReportRow[] {
  const base = t02Trajectories();
  const paths = trajectories(originSequences());
  const extra: { subBandFrames: number[]; subBandChanges: number; subBandViolations: number }[] =
    [];
  for (const start of trajectoryStarts())
    for (const path of paths) {
      const offset = [
        start.input.camera[0] - path.frames[0]!.camera[0],
        start.input.camera[1] - path.frames[0]!.camera[1],
      ];
      let previous: { origin: ProjectionPoint; g: number } | undefined;
      let epochKey = '';
      let capped = false;
      let previousK: number | null = null;
      const frames = [0, 0, 0, 0];
      let changes = 0;
      let violations = 0;
      for (const frame of path.frames) {
        const input: ProjectionInput = {
          ...start.input,
          camera: [frame.camera[0] + offset[0]!, frame.camera[1] + offset[1]!],
          zoom: frame.zoom,
          dpr: frame.dpr,
        };
        const epoch = epochOf(input, previous);
        if (epoch === null) {
          previousK = null;
          continue;
        }
        previous = { origin: epoch.origin, g: epoch.g };
        const key = `${epoch.origin[0]},${epoch.origin[1]},${epoch.g},${epoch.L},${input.width},${input.height},${Math.fround(input.dpr)}`;
        if (key !== epochKey) {
          epochKey = key;
          previousK = null;
          capped =
            candidateCells(preimageQuad(input.affine, epochWindow(epoch)), epoch.L).status !== 'OK';
        }
        if (capped) {
          previousK = null;
          continue;
        }
        // Independent assignment: count k with lo_k < zq_f ≤ hi_k from exact bounds.
        const zq = mul(q(Math.fround(frame.zoom)), q(Math.fround(frame.dpr)));
        const width = div(sub(epoch.zqHi, epoch.zqLo), rational(BigInt(SUB_BANDS)));
        const hits: number[] = [];
        for (let k = 0; k < SUB_BANDS; k += 1) {
          const lo = add(epoch.zqLo, mul(rational(BigInt(k)), width));
          const hi = add(epoch.zqLo, mul(rational(BigInt(k + 1)), width));
          if (compare(zq, lo) > 0 && compare(zq, hi) <= 0) hits.push(k);
        }
        if (hits.length !== 1) {
          previousK = null;
          violations += 1;
          continue;
        }
        const k = hits[0]!;
        frames[k] = frames[k]! + 1;
        if (previousK !== null && previousK !== k) changes += 1;
        previousK = k;
      }
      extra.push({ subBandFrames: frames, subBandChanges: changes, subBandViolations: violations });
    }
  if (extra.length !== base.length) throw new Error('trajectory-count-mismatch');
  return base.map((record, index) => ({ ...record, ...extra[index]! }));
}

// ---------------------------------------------------------------------------------------------
// Summary, gates, prediction and document.

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const keyOf = (...parts: unknown[]) => parts.map((part) => String(part)).join('|');

/** Pre-registered prediction set R (contract "Pre-registered prediction"). */
export const PREDICTION: readonly Readonly<{
  corpus: string;
  id: string;
  dpr: string;
  outcome: string;
}>[] = [
  ...['star:nonzero', 'star:evenodd', 'zero-closure:nonzero', 'zero-closure:evenodd'].map(
    (fill) => ({
      corpus: 'O',
      id: `carrier/Z/depth-positive/${fill}/S5`,
      dpr: '1',
      outcome: 'NOT_ADMITTED:triangle',
    }),
  ),
  ...(['TRI', 'RECT'] as const).flatMap((shape) =>
    [24, 32, 40].flatMap((k) =>
      ['I', 'R15'].map((linear) => ({
        corpus: 'A',
        id: `S/${shape}/k${k}/z1/d1/${linear}/cam:${shape === 'TRI' ? 'v1' : 'v2'}`,
        dpr: '1',
        outcome: 'NOT_ADMITTED:vertex',
      })),
    ),
  ),
];

const termOf = (outcome: string) => {
  if (outcome === 'ADMITTED') return 'admitted';
  if (outcome.startsWith('NOT_ADMITTED:')) return outcome.split(':')[1]!;
  return outcome;
};

export function summarize(rows: readonly ReportRow[], trajectoryRecords: readonly ReportRow[]) {
  const groups = new Map<
    string,
    { corpus: string; dprGroup: string; total: number; outcomes: Record<string, number> }
  >();
  for (const row of rows) {
    const corpus = row.corpus as string;
    const group = corpus === 'O' ? ((row.dpr as string) === '3' ? '3' : 'acceptance') : 'all';
    const key = `${corpus}/${group}`;
    const entry = groups.get(key) ?? { corpus, dprGroup: group, total: 0, outcomes: {} };
    entry.total += 1;
    const term = termOf(row.outcome as string);
    entry.outcomes[term] = (entry.outcomes[term] ?? 0) + 1;
    groups.set(key, entry);
  }
  const archived = readFileSync(T01_REPORT, 'utf8').replaceAll('\r\n', '\n');
  const archiveHash = sha256(archived);
  const t01Rows = (JSON.parse(archived) as { rows: ReportRow[] }).rows.filter(
    (row) =>
      row.candidate === 'K1' &&
      (row.sweep as { gamma: number }).gamma === 4 &&
      (row.sweep as { tTile: number }).tTile === 256 &&
      row.gammaModel === 'G8' &&
      row.outcome === 'ADMITTED',
  );
  const byKey = new Map(rows.map((row) => [keyOf(row.corpus, row.id, row.dpr), row]));
  const gate3Rows = t01Rows.filter((row) => row.corpus === 'O' && row.dpr !== '3');
  const losses = gate3Rows
    .map((row) => {
      const current = byKey.get(keyOf('O', row.id, row.dpr));
      return {
        corpus: 'O',
        id: row.id as string,
        dpr: row.dpr as string,
        outcome: (current?.outcome as string) ?? 'MISSING',
      };
    })
    .filter((loss) => loss.outcome !== 'ADMITTED');
  const lossesCL = t01Rows
    .filter((row) => row.corpus === 'C' || row.corpus === 'L')
    .map((row) => {
      const current = byKey.get(keyOf(row.corpus, row.id, row.dpr));
      return {
        corpus: row.corpus as string,
        id: row.id as string,
        outcome: (current?.outcome as string) ?? 'MISSING',
      };
    })
    .filter((loss) => loss.outcome !== 'ADMITTED');
  const partitionFailures = rows
    .filter((row) => (row.outcome as string).includes(':partition:'))
    .map((row) => row.id);
  const classAOwn = rows
    .filter((row) => row.corpus === 'A' && row.variantOf === null)
    .every((row) => row.outcome === 'ADMITTED');
  const classAFailures = rows
    .filter((row) => row.corpus === 'A' && row.outcome !== 'ADMITTED')
    .map((row) => ({
      corpus: 'A',
      id: row.id as string,
      dpr: row.dpr as string,
      outcome: row.outcome as string,
    }));
  const coverage = trajectoryRecords.reduce(
    (sum, record) =>
      sum + (record.coverageViolations as number) + (record.subBandViolations as number),
    0,
  );
  const gates = {
    partition: { pass: partitionFailures.length === 0, failures: partitionFailures },
    classA: {
      pass: classAOwn && classAFailures.length === 0,
      ownCamerasAdmitted: classAOwn,
      failures: classAFailures,
    },
    noRegressionO: { pass: losses.length === 0 && archiveHash === T01_REPORT_SHA256, losses },
    frameCoverage: { pass: coverage === 0, violations: coverage },
  };
  // Verdict (PASS / FAIL-AS-PREDICTED / FAIL).
  const predicted = new Map(
    PREDICTION.map((entry) => [keyOf(entry.corpus, entry.id, entry.dpr), entry.outcome]),
  );
  const gateFailures = [...classAFailures, ...losses];
  const unpredicted = gateFailures.filter(
    (failure) => predicted.get(keyOf(failure.corpus, failure.id, failure.dpr)) !== failure.outcome,
  );
  const predictionRows = PREDICTION.map((entry) => {
    const row = byKey.get(keyOf(entry.corpus, entry.id, entry.dpr));
    return {
      ...entry,
      actual: (row?.outcome as string) ?? 'MISSING',
      afterC2: (row?.afterC2 as { partition: string; lists: string } | null) ?? null,
    };
  });
  const residualChecksPass = predictionRows
    .filter((entry) => entry.actual !== 'ADMITTED')
    .every(
      (entry) =>
        entry.afterC2 !== null && entry.afterC2.partition === 'ok' && entry.afterC2.lists === 'ok',
    );
  const allPass = Object.values(gates).every((gate) => gate.pass);
  const verdict = allPass
    ? 'PASS'
    : gates.partition.pass &&
        gates.frameCoverage.pass &&
        archiveHash === T01_REPORT_SHA256 &&
        unpredicted.length === 0 &&
        residualChecksPass
      ? 'FAIL-AS-PREDICTED'
      : 'FAIL';
  return {
    admission: [...groups.values()],
    gate3: {
      t01Report: { path: T01_REPORT, sha256: archiveHash, expected: T01_REPORT_SHA256 },
      compared: gate3Rows.length,
      lossesCL,
    },
    gates,
    prediction: { rows: predictionRows, unpredicted, residualChecksPass },
    verdict,
  };
}

export const T03_SOURCES = [
  'tests/geometry/extent-t03/delaunay.ts',
  'tests/geometry/extent-t03/local.ts',
  'tests/geometry/extent-t03/owner.ts',
  'tests/geometry/extent-t03/report.ts',
  'tests/geometry/extent-t03-cdc.test.ts',
  'tests/geometry/extent-t03-local.test.ts',
  'tests/geometry/extent-t03-pinned.test.ts',
  'tests/geometry/extent-t03-summary.test.ts',
  'tests/p3-t03/report.test.ts',
  'vitest.p3-t03.config.ts',
] as const;

/** T02 and T01 files T03 imports or hashes; they stay byte-unchanged. */
export const T03_PINNED = [
  ...T02_SOURCES,
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

export const CONTRACTS = [
  {
    path: 'docs/plans/p3-r2-tiling-contract.md',
    commit: 'e12804914bc459be68287d5e8491061e2cce252c',
  },
  {
    path: 'docs/plans/p3-r2-tiling-rev4-contract.md',
    /** The main commit that integrated revision 4 FROZEN (PR #121). */
    commit: 'd777ca58871d1d5442ba248753c574a90df66582',
  },
] as const;

export function documentOf(rows: readonly ReportRow[], trajectoryRecords: readonly ReportRow[]) {
  const contract = CONTRACTS.map((entry) => ({
    path: entry.path,
    commit: entry.commit,
    sha256: sha256(execFileSync('git', ['show', `${entry.commit}:${entry.path}`])),
  }));
  const sources: Record<string, string> = {};
  for (const path of [...T03_SOURCES, ...T03_PINNED].sort())
    sources[path] = sha256(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'));
  return {
    contract,
    sources,
    rows,
    summary: summarize(rows, trajectoryRecords),
    trajectories: trajectoryRecords,
  };
}
