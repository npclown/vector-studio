// D9 E3 unit E3-U3: the A04 measurement harness
// (docs/plans/d9-e3-b4-precision-contract.md sections 3.2, 6, 7.1 to 7.3 and 15).
//
// Per case it drives the real fill and stroke mesh ports through renderer-core's own scene
// mirror, bucket choice, K4 packing and mesh pipeline, maps the stored points with the exact
// shader model (`shader-model.ts`), and hands `M*` and the Float64 port mesh to the independent
// oracle `a04Measure` (S7). It applies the pass rule of section 7.3 and returns one record row.
//
// Test-only. It must not be run on `a04-corpus/v1` before the corpus freeze (section 5.5); the
// unit tests drive it with synthetic ports and hand-made cases only, and the run command refuses
// without a freeze note.
import type {
  FillMesh,
  FillMeshBatchResult,
  FillMeshPort,
  FillMeshRequest,
  RenderNodeSnapshot,
  SceneAffine,
  StrokeMeshBatchResult,
  StrokeMeshPort,
  StrokeMeshRequest,
} from '@vector-studio/contracts';
import {
  type A04Hooks,
  type A04Mesh,
  a04Measure,
  a04NextDown,
  a04NextUp,
} from '../../../packages/geometry-reference/src/a04-region.js';
import { buildPathFringe } from '../../../packages/renderer-core/src/path-fringe.js';
import {
  PathMeshPipeline,
  type PathFringeBuilder,
  type PathMeshDraw,
  type PathMeshNotice,
} from '../../../packages/renderer-core/src/path-mesh-pipeline.js';
import type { PrimitiveTarget } from '../../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../../packages/renderer-core/src/scene-mirror.js';
import { unhex } from './corpus.js';
import {
  type ModelHooks,
  type ShaderLanes,
  clipBound,
  mapMesh,
  noFlipCertificate,
} from './shader-model.js';

/** The A04 target, physical pixels. */
export const TARGET_PX = 0.25;

// ---------------------------------------------------------------------------------------------
// The case

export type CaseObject = Readonly<Record<string, unknown>>;

type DecodedCase = Readonly<{
  id: string;
  paint:
    | Readonly<{ kind: 'fill'; rule: 'nonzero' | 'evenodd' }>
    | Readonly<{
        kind: 'stroke';
        width: number;
        cap: 'butt' | 'round' | 'square';
        join: 'miter' | 'round' | 'bevel';
        miterLimit: number;
      }>;
  l: readonly [number, number, number, number];
  t: readonly [number, number];
  camera: Readonly<{ x: number; y: number; zoom: number; dpr: number }>;
  verbs: string;
  points: readonly number[];
  opacity: number;
  servedOffset: number;
  viewport: readonly [number, number];
}>;

export function decodeCase(kase: CaseObject): DecodedCase {
  const camera = kase.camera as { c: string[]; dpr: string; zoom: string };
  const world = kase.world as { l: string[]; t: string[] };
  const path = kase.path as { points: string[]; verbs: string };
  const paint = kase.paint as Record<string, string>;
  const viewport = kase.viewport as number[];
  return {
    id: String(kase.id),
    paint:
      paint.kind === 'fill'
        ? { kind: 'fill', rule: paint.rule as 'nonzero' | 'evenodd' }
        : {
            kind: 'stroke',
            width: unhex(paint.width!),
            cap: paint.cap as 'butt' | 'round' | 'square',
            join: paint.join as 'miter' | 'round' | 'bevel',
            miterLimit: unhex(paint.miterLimit!),
          },
    l: world.l.map(unhex) as unknown as DecodedCase['l'],
    t: world.t.map(unhex) as unknown as DecodedCase['t'],
    camera: {
      x: unhex(camera.c[0]!),
      y: unhex(camera.c[1]!),
      zoom: unhex(camera.zoom),
      dpr: unhex(camera.dpr),
    },
    verbs: path.verbs,
    points: path.points.map(unhex),
    opacity: kase.opacity === undefined ? 1 : unhex(kase.opacity as string),
    servedOffset: Number(kase.servedOffset ?? 0),
    viewport: [viewport[0]!, viewport[1]!],
  };
}

// ---------------------------------------------------------------------------------------------
// Ports and the served bucket

export type MeshPorts = Readonly<{ fill: FillMeshPort; stroke: StrokeMeshPort }>;

type PortLogEntry = Readonly<{ paint: 'fill' | 'stroke'; status: string; code: string | null }>;

/**
 * Wraps the real ports for one case. The pipeline asks for the exact bucket `e`; the contract's
 * served bucket (section 3.2 step 2) is `e - k`, so the wrapper forwards the request at `e - k`
 * and echoes `e` back, which is what a resident entry at `e - k` looks like to the renderer's
 * validation. Every answer is logged, so an `empty` or a failed result is visible next to the
 * pipeline's own notices.
 */
function servingPorts(ports: MeshPorts, k: number, log: PortLogEntry[]): MeshPorts {
  const fill: FillMeshPort = {
    portVersion: ports.fill.portVersion,
    operationId: ports.fill.operationId,
    buildFillMeshes(requests: readonly FillMeshRequest[]): FillMeshBatchResult {
      const shifted = requests.map((r) => ({ ...r, toleranceExponent: r.toleranceExponent - k }));
      const batch = ports.fill.buildFillMeshes(shifted);
      if (batch.status !== 'ok') return batch;
      return {
        status: 'ok',
        results: batch.results.map((r) => {
          log.push({
            paint: 'fill',
            status: r.status,
            code: r.status === 'failed' ? r.code : null,
          });
          return { ...r, toleranceExponent: r.toleranceExponent + k };
        }),
      };
    },
  };
  const stroke: StrokeMeshPort = {
    portVersion: ports.stroke.portVersion,
    operationId: ports.stroke.operationId,
    buildStrokeMeshes(requests: readonly StrokeMeshRequest[]): StrokeMeshBatchResult {
      const shifted = requests.map((r) => ({ ...r, toleranceExponent: r.toleranceExponent - k }));
      const batch = ports.stroke.buildStrokeMeshes(shifted);
      if (batch.status !== 'ok') return batch;
      return {
        status: 'ok',
        results: batch.results.map((r) => {
          log.push({
            paint: 'stroke',
            status: r.status,
            code: r.status === 'failed' ? r.code : null,
          });
          return { ...r, toleranceExponent: r.toleranceExponent + k };
        }),
      };
    },
  };
  return { fill, stroke };
}

// ---------------------------------------------------------------------------------------------
// The renderer stage

export type RejectionSource = 'port-failed' | 'renderer-state' | 'batch-failed' | 'not-drawable';

export type DrawVariant = 'fringe' | 'fringe-work-cap' | 'fringe-unsupported' | 'region-only';

export type Rendered =
  | Readonly<{ kind: 'rejected'; source: RejectionSource; code: string }>
  | Readonly<{ kind: 'empty'; reason: 'port-empty' | 'not-requested' }>
  | Readonly<{
      kind: 'drawn';
      mesh: FillMesh;
      offsets: Float32Array;
      lanes: ShaderLanes;
      /** The bucket the renderer chose, and the exponent the port was asked for (e - k). */
      bucket: number;
      servedExponent: number;
      variant: DrawVariant;
      notices: readonly string[];
    }>;

const ALPHA_ONE = Object.freeze({ r: 1, g: 0, b: 0, a: 1 });

function nodeOf(c: DecodedCase): RenderNodeSnapshot {
  const verbMap: Record<string, 'move' | 'line' | 'cubic' | 'close'> = {
    M: 'move',
    L: 'line',
    C: 'cubic',
    Z: 'close',
  };
  // The corpus linear map L = [[a, b], [c, d]] (x' = a x + b y); SceneAffine is [a, c, b, d, tx, ty].
  const [a, b, cc, d] = c.l;
  const transform: SceneAffine = [a, cc, b, d, c.t[0], c.t[1]];
  return {
    id: 'a04',
    parentId: null,
    transform,
    visible: true,
    opacity: c.opacity,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: [...c.verbs].map((v) => verbMap[v]!),
      points: c.points,
      fillRule: c.paint.kind === 'fill' ? c.paint.rule : 'nonzero',
    },
    style:
      c.paint.kind === 'fill'
        ? { fill: ALPHA_ONE, stroke: null }
        : {
            fill: null,
            stroke: {
              color: ALPHA_ONE,
              width: c.paint.width,
              cap: c.paint.cap,
              join: c.paint.join,
              miterLimit: c.paint.miterLimit,
            },
          },
  };
}

function targetOf(c: DecodedCase): PrimitiveTarget {
  const d = c.camera.dpr;
  return {
    generation: 1,
    surfaceRevision: 1,
    width: c.viewport[0] * d,
    height: c.viewport[1] * d,
    devicePixelRatio: d,
    sampleCount: 4,
    targetFormat: 'bgra8unorm',
  };
}

type Pass = Readonly<{
  draws: readonly PathMeshDraw[];
  notices: readonly PathMeshNotice[];
  frame: readonly number[] | null;
  log: readonly PortLogEntry[];
  rejected: string | null;
}>;

function runPass(c: DecodedCase, ports: MeshPorts, builder: PathFringeBuilder | undefined): Pass {
  const log: PortLogEntry[] = [];
  const served = servingPorts(ports, c.servedOffset, log);
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: 'supported',
    pathStrokes: 'supported',
  });
  const pipeline = new PathMeshPipeline({
    port: served.fill,
    strokePort: served.stroke,
    ...(builder === undefined ? {} : { fringeBuilder: builder }),
  });
  const source = new PrimitiveSceneSource(mirror, pipeline);
  let draws: readonly PathMeshDraw[] = [];
  const prepare = pipeline.prepare.bind(pipeline);
  pipeline.prepare = (input) => {
    draws = prepare(input);
    return draws;
  };
  try {
    const applied = mirror.replaceSnapshot({
      identity: { documentId: 'e3-a04', pageId: 'page' },
      revision: 1,
      nodes: [nodeOf(c)],
      rootOrder: ['a04'],
    });
    if (applied.status !== 'applied') {
      return { draws: [], notices: [], frame: null, log, rejected: `scene-${applied.status}` };
    }
    const camera = mirror.setCamera({
      position: { x: c.camera.x, y: c.camera.y },
      zoom: c.camera.zoom,
    });
    if (camera.status !== 'applied' && camera.status !== 'unchanged') {
      return { draws: [], notices: [], frame: null, log, rejected: `camera-${camera.status}` };
    }
    const packet = source.prepare(targetOf(c));
    if (packet === null) return { draws: [], notices: [], frame: null, log, rejected: 'no-packet' };
    let frame: readonly number[] | null = null;
    for (const write of packet.mesh?.writes ?? []) {
      if (write.resourceId !== 'meshFrame') continue;
      const view = new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength);
      frame = Array.from({ length: 8 }, (_, i) => view.getFloat32(4 * i, true));
    }
    return { draws, notices: packet.mesh?.notices ?? [], frame, log, rejected: null };
  } catch (error) {
    return {
      draws: [],
      notices: [],
      frame: null,
      log,
      rejected: `renderer-threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    source.dispose();
    mirror.dispose();
    pipeline.dispose();
  }
}

const NON_BLOCKING = new Set(['fringe-work-cap', 'fringe-unsupported']);

/**
 * Renders one case through the renderer's mesh pipeline and the given ports (contract 3.2).
 * Rejections (section 6) are a port `failed`, a renderer state failure before a draw, and a
 * case that is not drawable. `empty`, `fringe-work-cap` and `fringe-unsupported` are measured.
 */
export function renderCase(kase: CaseObject, ports: MeshPorts): Rendered {
  const c = decodeCase(kase);
  const [a, b, cc, d] = c.l;
  // det L = 0 exactly: the products of two binary64 values are compared exactly.
  if (isSingular(a, b, cc, d))
    return { kind: 'rejected', source: 'not-drawable', code: 'det-l-zero' };
  if (c.paint.kind === 'stroke' && c.paint.width === 0)
    return { kind: 'rejected', source: 'not-drawable', code: 'w-zero' };

  const first = runPass(c, ports, buildPathFringe);
  if (first.rejected !== null)
    return { kind: 'rejected', source: 'renderer-state', code: first.rejected };
  const failures = first.notices.filter((n) => !NON_BLOCKING.has(n.failureCode));
  const blocking = failures[0];
  if (blocking !== undefined) {
    const source: RejectionSource =
      blocking.failureScope === 'path'
        ? 'port-failed'
        : blocking.failureScope === 'batch'
          ? 'batch-failed'
          : 'renderer-state';
    return { kind: 'rejected', source, code: String(blocking.failureCode) };
  }
  const codes = first.notices.map((n) => String(n.failureCode));
  let pass = first;
  let variant: DrawVariant = 'fringe';
  if (codes.includes('fringe-unsupported')) {
    // The pipeline hides a path with an unsupported fringe (V3 contract, section h), but section
    // 6 measures it: its region triangles still draw. Rendering again without a fringe builder
    // is the region-only mode of the same pipeline and the same packing (section 15.1, H3).
    pass = runPass(c, ports, undefined);
    if (pass.rejected !== null)
      return { kind: 'rejected', source: 'renderer-state', code: pass.rejected };
    variant = 'fringe-unsupported';
  } else if (codes.includes('fringe-work-cap')) {
    variant = 'fringe-work-cap';
  }
  const draw = pass.draws.find((x) => (x.paint ?? 'fill') === c.paint.kind);
  if (draw === undefined) {
    // No draw and no failure: the port answered `empty`, or the pipeline never asked for a mesh
    // (the path's bounds miss the viewport by more than its guard). Both draw nothing: M = ∅.
    const empty = pass.log.some((e) => e.status === 'empty');
    return { kind: 'empty', reason: empty ? 'port-empty' : 'not-requested' };
  }
  if (pass.frame === null)
    return { kind: 'rejected', source: 'renderer-state', code: 'mesh-frame-missing' };
  if (variant === 'fringe' && draw.fringe === null) variant = 'region-only';
  const f = pass.frame;
  const lanes: ShaderLanes = {
    linear: draw.linear,
    anchor: draw.anchor,
    originMinusCamera: [f[0]!, f[1]!],
    zoom: f[2]!,
    devicePixelRatio: f[3]!,
    physicalSize: [f[4]!, f[5]!],
  };
  return {
    kind: 'drawn',
    mesh: draw.mesh,
    offsets: draw.offsets,
    lanes,
    bucket: draw.toleranceExponent,
    servedExponent: draw.toleranceExponent - c.servedOffset,
    variant,
    notices: codes,
  };
}

function isSingular(a: number, b: number, c: number, d: number): boolean {
  // a*d == b*c over the rationals: compare the exact dyadic products.
  const mul = (x: number, y: number) => exactProduct(x, y);
  const [p, pe] = mul(a, d);
  const [q, qe] = mul(b, c);
  const e = Math.min(pe, qe);
  return p << BigInt(pe - e) === q << BigInt(qe - e);
}

function exactProduct(x: number, y: number): readonly [bigint, number] {
  const dx = decompose(x);
  const dy = decompose(y);
  return [dx[0] * dy[0], dx[1] + dy[1]];
}

function decompose(value: number): readonly [bigint, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const n = exponent === 0 ? fraction : fraction | (1n << 52n);
  return [bits >> 63n === 1n ? -n : n, exponent === 0 ? -1074 : exponent - 1075];
}

// ---------------------------------------------------------------------------------------------
// The scored row

export type RowStatus = 'pass' | 'fail' | 'undecided' | 'window-empty' | 'rejected';

export type CaseRow = Readonly<{
  id: string;
  status: RowStatus;
  /** For `undecided`: why. For `rejected`: the source. */
  reason: string | null;
  rejection: Readonly<{ source: RejectionSource; code: string }> | null;
  variant: DrawVariant | 'none' | null;
  bucket: number | null;
  servedExponent: number | null;
  vertices: number;
  triangles: number;
  /** The oracle's certified interval on M* (null when the oracle did not run). */
  eLo: number | null;
  eHi: number | null;
  /** Physical px; null = not a finite number (E_hi = +infinity). */
  betaVertex: number;
  betaFeature: number;
  betaC: number;
  clip: Readonly<{ clipped: boolean; triangles: number; crossings: number; bound: number | null }>;
  noFlip: Readonly<{ ok: boolean; uncertain: number }>;
  /** U = E_hi + beta_c; L = max(0, E_lo - beta_c); null when unbounded or not computed. */
  u: number | null;
  l: number | null;
  tJunctions: number;
  crackBound: number | null;
  storageCracks: number | null;
  resolution: number | null;
  work: number | null;
  windowPoint: Readonly<{ r: boolean; m: boolean }> | null;
  /** Diagnostic wall time only (section 7.4). */
  ms: number;
}>;

/** Test-only substitution points for the seeded defects of section 8.2 (never set in a run). */
export type HarnessHooks = Readonly<{
  /** E3-D7: beta omitted from U (and from the thresholds given to the oracle). */
  omitBeta?: boolean;
  /** E3-D14: the NDC step omitted from beta. */
  model?: ModelHooks;
  /** E3-PC7, E3-PC8: perturb the shader lanes after packing. */
  mutateLanes?: (lanes: ShaderLanes) => ShaderLanes;
  /** E3-D9: replaces the case before the oracle sees it (for example a window without its guard). */
  oracleCase?: (kase: CaseObject) => CaseObject;
  /** Oracle hooks, for the seeded defects of E3-U2 re-run through the harness. */
  oracle?: A04Hooks;
}>;

export type ScoreOptions = Readonly<{
  hooks?: HarnessHooks;
  workCap?: number;
  resolution?: number;
  floor?: number;
  /** Refine each term to the resolution on its own, so that E_hi is finite (the controls). */
  separateTerms?: boolean;
}>;

const emptyClip = { clipped: false, triangles: 0, crossings: 0, bound: 0 } as const;

const finiteOrNull = (x: number): number | null => (Number.isFinite(x) ? x : null);

/**
 * Scores a rendered case (contract 7.2, 7.3). `PASS` is `U = E_hi + beta_c <= 0.25`, `FAIL` is
 * `L = E_lo - beta_c > 0.25`, anything else is `UNDECIDED`. A case that is undecidable before the
 * oracle (f32 overflow, `beta_c >= 1`, an uncomputable clip bound, a failed no-flip certificate)
 * is not sent to the oracle at all.
 */
export function scoreRendered(
  kase: CaseObject,
  rendered: Rendered,
  options: ScoreOptions = {},
): CaseRow {
  const started = performance.now();
  const hooks = options.hooks ?? {};
  const id = String(kase.id);
  const base = {
    id,
    reason: null,
    rejection: null,
    variant: null,
    bucket: null,
    servedExponent: null,
    vertices: 0,
    triangles: 0,
    eLo: null,
    eHi: null,
    betaVertex: 0,
    betaFeature: 0,
    betaC: 0,
    clip: emptyClip,
    noFlip: { ok: true, uncertain: 0 },
    u: null,
    l: null,
    tJunctions: 0,
    crackBound: null,
    storageCracks: null,
    resolution: null,
    work: null,
    windowPoint: null,
  } as const;
  const done = (row: Omit<CaseRow, 'ms'>): CaseRow => ({
    ...row,
    ms: Math.round(performance.now() - started),
  });

  if (rendered.kind === 'rejected') {
    return done({
      ...base,
      status: 'rejected',
      rejection: { source: rendered.source, code: rendered.code },
      variant: 'none',
    });
  }

  const oracleCase = hooks.oracleCase === undefined ? kase : hooks.oracleCase(kase);
  const measureOptions = {
    ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
    ...(options.floor === undefined ? {} : { floor: options.floor }),
    ...(options.workCap === undefined ? {} : { workCap: options.workCap }),
    ...(options.separateTerms === true ? { separateTerms: true } : {}),
    ...(hooks.oracle === undefined ? {} : { hooks: hooks.oracle }),
  };

  // A result of `empty` (or no request at all) draws nothing: M = ∅, no stored point, beta = 0.
  if (rendered.kind === 'empty') {
    const m = a04Measure(
      oracleCase,
      { positions: [], indices: [] },
      { ...measureOptions, betaC: 0 },
    );
    return done(finish(base, m, 0, 'none', hooks));
  }

  const lanes =
    hooks.mutateLanes === undefined ? rendered.lanes : hooks.mutateLanes(rendered.lanes);
  const mapped = mapMesh(rendered.offsets, rendered.mesh.indices, lanes, hooks.model ?? {});
  const common = {
    ...base,
    variant: rendered.variant,
    bucket: rendered.bucket,
    servedExponent: rendered.servedExponent,
    vertices: rendered.offsets.length / 2,
    triangles: rendered.mesh.indices.length / 3,
    betaVertex: mapped.betaVertex,
    betaFeature: mapped.betaFeature,
    betaC: mapped.beta,
  };
  const undecided = (reason: string, extra: Partial<CaseRow> = {}): CaseRow =>
    done({ ...common, ...extra, status: 'undecided', reason });

  if (mapped.overflow) return undecided('f32 overflow possible in the vertex stage');
  if (mapped.beta >= 1) return undecided('beta_c >= 1 px');
  const clip = clipBound(mapped, lanes.physicalSize, mapped.beta);
  const clipRow = {
    clipped: clip.clipped,
    triangles: clip.triangles,
    crossings: clip.crossings,
    bound: finiteOrNull(clip.bound),
  };
  if (!Number.isFinite(clip.bound))
    return undecided('clip bound not computable', { clip: clipRow });
  if (clip.bound >= TARGET_PX) return undecided('clip bound >= 0.25 px', { clip: clipRow });
  const beta = hooks.omitBeta === true ? 0 : up(mapped.beta + clip.bound);
  if (beta >= 1) return undecided('beta_c >= 1 px (with the clip bound)', { clip: clipRow });
  const flip = noFlipCertificate(mapped, beta);
  const flipRow = { ok: flip.uncertain === 0, uncertain: flip.uncertain };
  if (flip.uncertain > 0)
    return undecided('no-flip certificate fails', { clip: clipRow, noFlip: flipRow });

  const m = a04Measure(
    oracleCase,
    { positions: mapped.positions, indices: mapped.indices },
    {
      ...measureOptions,
      betaC: beta,
      passBelow: down(TARGET_PX - beta),
      failAbove: up(TARGET_PX + beta),
      portMesh: { positions: rendered.mesh.positions, indices: rendered.mesh.indices },
    },
  );
  return done(
    finish({ ...common, clip: clipRow, noFlip: flipRow }, m, beta, rendered.variant, hooks),
  );
}

const up = (x: number): number => a04NextUp(x);
const down = (x: number): number => a04NextDown(x);

type Measured = ReturnType<typeof a04Measure>;

/** Section 7.3: derives the row's status from the oracle's interval and `beta`. */
function finish(
  base: Omit<CaseRow, 'ms' | 'status'> & { status?: never },
  m: Measured,
  beta: number,
  variant: DrawVariant | 'none',
  hooks: HarnessHooks,
): Omit<CaseRow, 'ms'> {
  const used = hooks.omitBeta === true ? 0 : beta;
  const eLoRaw = m.e === null ? null : m.e.lo;
  const eHiRaw = m.e === null ? null : m.e.hi;
  const u = eHiRaw === null || !Number.isFinite(eHiRaw) ? null : up(eHiRaw + used);
  // L = +infinity (E_lo = +infinity, an empty mesh over a non-empty case) is recorded as the
  // largest binary64 so that the record stays JSON.
  let l = eLoRaw === null ? null : Math.min(Number.MAX_VALUE, Math.max(0, down(eLoRaw - used)));
  if (l === null && m.status === 'fail') l = Number.MAX_VALUE;
  const row = {
    ...base,
    variant,
    eLo: eLoRaw === null ? null : Math.min(Number.MAX_VALUE, eLoRaw),
    eHi: eHiRaw === null ? null : finiteOrNull(eHiRaw),
    u,
    l,
    tJunctions: m.tJunctions,
    crackBound: m.crackBound,
    storageCracks: m.storage === null ? null : m.storage.storageCracks,
    resolution: m.resolution,
    work: m.work,
    windowPoint: m.windowPoint,
  };
  if (m.status === 'window-empty') return { ...row, status: 'window-empty', reason: null };
  if (m.status === 'not-drawable')
    return {
      ...row,
      status: 'rejected',
      rejection: { source: 'not-drawable', code: m.reason ?? 'not-drawable' },
    };
  if (m.status === 'undecided' && m.e === null)
    return { ...row, status: 'undecided', reason: m.reason };
  if (u !== null && u <= TARGET_PX) return { ...row, status: 'pass', reason: null };
  if (l !== null && l > TARGET_PX) return { ...row, status: 'fail', reason: null };
  return { ...row, status: 'undecided', reason: m.reason ?? 'the interval straddles 0.25' };
}

// ---------------------------------------------------------------------------------------------
// One call for a corpus case

/** Renders and scores one case with the given ports. */
export function measureCase(
  kase: CaseObject,
  ports: MeshPorts,
  options: ScoreOptions = {},
): CaseRow {
  return scoreRendered(kase, renderCase(kase, ports), options);
}

/** A mesh in the oracle's form from Float64 port data (for synthetic comparisons). */
export const portMeshOf = (mesh: FillMesh): A04Mesh => ({
  positions: mesh.positions,
  indices: mesh.indices,
});
