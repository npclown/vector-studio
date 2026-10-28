// D9 E3 unit E3-U3: the A04 measurement harness (docs/plans/d9-e3-b4-precision-contract.md,
// sections 3.2 and 7, executable form in section 15). For one canonical case it drives the
// product's own CPU path, the retained scene mirror, PrimitiveSceneSource and PathMeshPipeline
// with the fill and stroke ports and the exact fringe builder, as PrimitiveRendererService wires
// them. From the packed draw it evaluates the V3 mesh shader's position mapping exactly from the
// f32 lanes (p*), bounds the f32 evaluation of every stage that positions a point (β, with the
// NDC round trip), applies the E3-Q11 (a) clipping model and the no-flip certificate, and hands
// M* to the independent oracle. The oracle never sees a kernel intermediate: only the case, the
// mapped triangles and the port mesh's positions for the storage-crack check (E3-K2).
import type {
  FillMeshPort,
  RenderNodeSnapshot,
  SceneAffine,
  ScenePathVerb,
  StrokeMeshPort,
} from '@vector-studio/contracts';
import {
  A04_ORACLE_PARAMETERS,
  a04Measure,
  a04NextDown,
  a04NextUp,
  type A04Case,
  type A04Hooks,
  type A04Mesh,
  type A04Scalar,
} from '../../../packages/geometry-reference/src/a04-region.js';
import { computePathBuckets } from '../../../packages/renderer-core/src/path-buckets.js';
import { buildPathFringe } from '../../../packages/renderer-core/src/path-fringe.js';
import { PathMeshPacker } from '../../../packages/renderer-core/src/path-mesh-packet.js';
import {
  PathMeshPipeline,
  type PathMeshDraw,
  type PathMeshNotice,
} from '../../../packages/renderer-core/src/path-mesh-pipeline.js';
import type { PrimitiveTarget } from '../../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../../packages/renderer-core/src/scene-mirror.js';
import { iterateA04Corpus, unhex } from './corpus.js';

/** The unit roundoff of binary32. */
export const F32_U = 2 ** -24;
/** γ_n = n·u / (1 − n·u) for binary32 (section 15.2). */
export const gamma = (n: number): number => a04NextUp((n * F32_U) / (1 - n * F32_U));
/** An absolute allowance for flushed or subnormal f32 results, in physical px (section 15.2). */
export const BETA_ABSOLUTE = 2 ** -100;
/** f64 slack on every bound the harness evaluates in binary64 (section 15.2). */
const SLACK = 1 + 2 ** -20;

export type HarnessPorts = Readonly<{ fill?: FillMeshPort; stroke?: StrokeMeshPort }>;

/** Test-only mutations: positive controls (E3-PC7, PC8) and seeded defects (E3-D7, D14). */
export type HarnessMutations = Readonly<{
  /** E3-PC7: adds `ulps` binary32 ulps to linear lane `index` (0 to 3) after packing. */
  linearLane?: Readonly<{ index: number; ulps: number }>;
  /** E3-PC8: adds a physical-px offset to the pan lanes O_m − camera, rounded to binary32. */
  panPx?: readonly [number, number];
  /** E3-D7: U and L without β. */
  omitBeta?: boolean;
  /** E3-D14: β without the NDC round trip (the feature path only). */
  omitNdc?: boolean;
  /** Oracle hooks (E3-D9 passes a window hook). */
  hooks?: A04Hooks;
}>;

export type HarnessOptions = Readonly<{
  /** The joint partner's paint (SB-10, SB-11), from the case of the same group and pair. */
  partner?: A04Case;
  mutations?: HarnessMutations;
  /** Oracle work cap; the contract's measurement cap by default. */
  workCap?: number;
  /** Oracle options: separate terms (test-only controls) and the starting resolution (section 19). */
  oracle?: Readonly<{ separateTerms?: boolean; resolution?: number }>;
  /** Test-only: receives the mapped points p* of a drawn mesh. */
  onMapped?: (mapped: Mapped) => void;
}>;

export type CaseStatus = 'pass' | 'fail' | 'undecided' | 'window-empty' | 'rejected';

/** One measured case, as the record keeps it (contract section 7.2). */
export type HarnessRow = Readonly<{
  index: number | null;
  id: string;
  stratum: string | null;
  transform: string | null;
  pair: string;
  paint: 'fill' | 'stroke';
  /** E3-C4 only: the target physical gap `g` in px (null for `g = 0` and other strata). */
  gapTarget: number | null;
  status: CaseStatus;
  /** The rejection code (section 6), or null. */
  code: string | null;
  /** Why a case is UNDECIDED, or null. */
  reason: string | null;
  /** How M was obtained: a drawn mesh, an empty port result, or a culled path (M = ∅). */
  drawn: 'mesh' | 'empty' | 'culled' | null;
  eLo: number | null;
  eHi: number | null;
  betaC: number | null;
  betaVertex: number | null;
  betaClip: number | null;
  u: number | null;
  l: number | null;
  tJunctions: number | null;
  storageCracks: number | null;
  crackBound: number | null;
  /** Mapped vertices outside the viewport, and triangles the clip model covers. */
  guard: Readonly<{ outside: number; crossing: number }> | null;
  noFlip: NoFlipResult | null;
  /** The flip-tolerant bound (section 20), when the no-flip certificate failed. */
  flipTolerant: FlipTolerantResult | null;
  /** The served tolerance exponent e − k, and k. */
  served: Readonly<{ e: number; k: number }> | null;
  /** fringe, region-only or joint-fill. */
  drawKind: string | null;
  notices: readonly string[];
  /** The joint draw's feature-identity check (E3-C9), or null when not a joint case. */
  jointIdentity: boolean | null;
  resolution: number | null;
  work: number | null;
  /** E20: the remedies that ran on this row, absent on a row the 2026-10-27 harness decided. */
  e20?: readonly E20Trace[];
  /**
   * E20-K7: on a FAIL fill row whose drawn mesh has every triangle collapsed (so M* is empty),
   * the device bounding box of the path's control points, which contains R. Absent otherwise.
   */
  collapse?: Readonly<{ triangles: number; regionWidth: number; regionHeight: number }>;
  ms: number;
  /** E20-K9: on a row a superseding record re-measured, the 2026-10-27 row's status and reason. */
  former?: Readonly<{ status: CaseStatus; reason: string | null }>;
}>;

/** One E20 remedy on a row (d9-e20-a04-remedies-contract.md, section 2). */
export type E20Trace = Readonly<{
  /**
   * `flip-tolerant`: K1, K2, K3 and K6 after section 20 failed or could not run (clipped);
   * `refined-offset`: K3 on a row whose bound straddles 0.25 px; `window-empty-guard`: K4.
   */
  rule: 'flip-tolerant' | 'refined-offset' | 'window-empty-guard';
  /** The section-20 result before the remedy (null when it did not run). */
  former?: FlipTolerantResult | null;
  /** The remedy's own result when it did not decide the row, which keeps the old one. */
  attempt?: FlipTolerantResult;
  /** K4: a lower bound of the boundary candidates' distance from Ω, physical px. */
  distance?: number;
}>;

// =============================================================================================
// Exact dyadics (the f32 lanes and their products are dyadic rationals)

export type D = Readonly<{ n: bigint; e: number }>;
const DZERO: D = { n: 0n, e: 0 };
const VIEW = new DataView(new ArrayBuffer(8));

function dy(value: number): D {
  if (!Number.isFinite(value)) throw new Error('non-finite lane');
  if (value === 0) return DZERO;
  VIEW.setFloat64(0, value);
  const bits = VIEW.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const n = exponent === 0 ? fraction : fraction | (1n << 52n);
  const e = exponent === 0 ? -1074 : exponent - 1075;
  return { n: bits >> 63n === 1n ? -n : n, e };
}
const dmul = (a: D, b: D): D => (a.n === 0n || b.n === 0n ? DZERO : { n: a.n * b.n, e: a.e + b.e });
function dadd(a: D, b: D): D {
  if (a.n === 0n) return b;
  if (b.n === 0n) return a;
  if (a.e <= b.e) return { n: a.n + (b.n << BigInt(b.e - a.e)), e: a.e };
  return { n: (a.n << BigInt(a.e - b.e)) + b.n, e: b.e };
}
const dsub = (a: D, b: D): D => dadd(a, { n: -b.n, e: b.e });
const dsign = (a: D): number => (a.n > 0n ? 1 : a.n < 0n ? -1 : 0);
const dcmp = (a: D, b: D): number => dsign(dsub(a, b));

/** The same value with an odd numerator (or zero). */
function dnorm(a: D): D {
  if (a.n === 0n) return DZERO;
  const m = a.n < 0n ? -a.n : a.n;
  const zeros = (m & -m).toString(2).length - 1;
  return zeros === 0 ? a : { n: a.n >> BigInt(zeros), e: a.e + zeros };
}

/** The dyadic as the oracle's exact rational lane, in lowest terms. */
function dq(value: D): A04Scalar {
  const a = dnorm(value);
  if (a.n === 0n) return 0;
  return a.e >= 0 ? { num: a.n << BigInt(a.e), den: 1n } : { num: a.n, den: 1n << BigInt(-a.e) };
}

/** |a| as m·2^k with m < 2^53 truncated, and whether that is exact. */
function split(a: D): { m: number; k: number; exact: boolean } {
  const n = a.n < 0n ? -a.n : a.n;
  const shift = Math.max(0, n.toString(2).length - 53);
  return {
    m: Number(n >> BigInt(shift)),
    k: a.e + shift,
    exact: shift === 0 || (n & ((1n << BigInt(shift)) - 1n)) === 0n,
  };
}
/** m·2^k in binary64; exact for the moderate exponents the harness meets. */
const scaled = (m: number, k: number) => {
  const h = Math.trunc(k / 2);
  return k >= -1000 && k <= 1000 ? m * 2 ** k : m * 2 ** h * 2 ** (k - h);
};
/** An upper bound of |a| in binary64. */
function dAbsUp(a: D): number {
  if (a.n === 0n) return 0;
  const { m, k, exact } = split(a);
  return exact && k >= -1000 && k <= 1000 ? scaled(m, k) : a04NextUp(scaled(m + 1, k));
}
/** A lower bound of |a| in binary64. */
function dAbsDown(a: D): number {
  if (a.n === 0n) return 0;
  const { m, k, exact } = split(a);
  return exact && k >= -1000 && k <= 1000 ? scaled(m, k) : a04NextDown(scaled(m, k));
}
/** The value in binary64: exact when it fits, else within 2^-52 relative. */
export function dNum(a: D): number {
  if (a.n === 0n) return 0;
  const { m, k } = split(a);
  return (a.n < 0n ? -1 : 1) * scaled(m, k);
}

// =============================================================================================
// The case (contract section 13.2) as a scene

type Decoded = Readonly<{
  id: string;
  paint: 'fill' | 'stroke';
  verbs: readonly ScenePathVerb[];
  points: readonly number[];
  transform: SceneAffine;
  camera: Readonly<{ x: number; y: number }>;
  zoom: number;
  dpr: number;
  opacity: number;
  servedOffset: number;
  fillRule: 'nonzero' | 'evenodd';
  stroke: Readonly<{ width: number; cap: string; join: string; miterLimit: number }> | null;
}>;

const VERB: Readonly<Record<string, ScenePathVerb>> = {
  M: 'move',
  L: 'line',
  C: 'cubic',
  Z: 'close',
};

function field<T>(value: unknown, key: string): T {
  if (typeof value !== 'object' || value === null || !(key in value))
    throw new Error(`a04 case lacks ${key}`);
  return (value as Record<string, unknown>)[key] as T;
}

export function decodeCase(kase: A04Case): Decoded {
  const path = field<{ verbs: string; points: string[] }>(kase, 'path');
  const world = field<{ l: string[]; t: string[] }>(kase, 'world');
  const camera = field<{ c: string[]; dpr: string; zoom: string }>(kase, 'camera');
  const paint = field<Record<string, string>>(kase, 'paint');
  const [a, b, c, d] = world.l.map(unhex) as [number, number, number, number];
  const [tx, ty] = world.t.map(unhex) as [number, number];
  const opacity = 'opacity' in kase ? unhex(kase.opacity as string) : 1;
  return {
    id: field<string>(kase, 'id'),
    paint: paint.kind === 'fill' ? 'fill' : 'stroke',
    verbs: [...path.verbs].map((v) => {
      const verb = VERB[v];
      if (verb === undefined) throw new Error(`a04 case verb ${v}`);
      return verb;
    }),
    points: path.points.map(unhex),
    // L = [[a, b], [c, d]] maps (x, y) to (a·x + b·y, c·x + d·y); the scene affine maps
    // x' = w0·x + w2·y + w4 and y' = w1·x + w3·y + w5 (packInstanceLanes).
    transform: [a, c, b, d, tx, ty],
    camera: { x: unhex(camera.c[0]!), y: unhex(camera.c[1]!) },
    zoom: unhex(camera.zoom),
    dpr: unhex(camera.dpr),
    opacity,
    servedOffset: 'servedOffset' in kase ? (kase.servedOffset as number) : 0,
    fillRule: paint.kind === 'fill' ? (paint.rule as 'nonzero' | 'evenodd') : 'nonzero',
    stroke:
      paint.kind === 'stroke'
        ? {
            width: unhex(paint.width!),
            cap: paint.cap!,
            join: paint.join!,
            miterLimit: unhex(paint.miterLimit!),
          }
        : null,
  };
}

const NODE_ID = 'a04';
const FILL_COLOR = Object.freeze({ r: 0, g: 0, b: 1, a: 1 });
const STROKE_COLOR = Object.freeze({ r: 1, g: 0, b: 0, a: 1 });

function sceneNode(own: Decoded, partner: Decoded | null, opacity: number): RenderNodeSnapshot {
  const fillCase = own.paint === 'fill' ? own : partner?.paint === 'fill' ? partner : null;
  const strokeCase = own.paint === 'stroke' ? own : partner?.paint === 'stroke' ? partner : null;
  return {
    id: NODE_ID,
    parentId: null,
    transform: own.transform,
    visible: true,
    opacity,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: own.verbs,
      points: own.points,
      fillRule: fillCase?.fillRule ?? 'nonzero',
    },
    style: {
      fill: fillCase === null ? null : FILL_COLOR,
      stroke:
        strokeCase === null
          ? null
          : {
              color: STROKE_COLOR,
              width: strokeCase.stroke!.width,
              cap: strokeCase.stroke!.cap as 'butt' | 'round' | 'square',
              join: strokeCase.stroke!.join as 'miter' | 'round' | 'bevel',
              miterLimit: strokeCase.stroke!.miterLimit,
            },
    },
  };
}

function targetFor(dpr: number, generation: number): PrimitiveTarget {
  return Object.freeze({
    generation,
    surfaceRevision: 1,
    width: 640 * dpr,
    height: 360 * dpr,
    devicePixelRatio: dpr,
    sampleCount: 4,
    targetFormat: 'bgra8unorm',
  });
}

// =============================================================================================
// The product CPU path (contract section 3.2, steps 1 to 4)

export type Frame = Readonly<{
  /** The packed meshFrame lanes as binary32: O_m − camera, zoom, DPR, physical size. */
  originMinusCamera: readonly [number, number];
  zoom: number;
  dpr: number;
  width: number;
  height: number;
}>;

export type DrawOutcome =
  | Readonly<{ kind: 'drawn'; draw: PathMeshDraw; frame: Frame; notices: readonly string[] }>
  | Readonly<{ kind: 'empty' | 'culled'; notices: readonly string[] }>
  | Readonly<{ kind: 'rejected'; code: string; notices: readonly string[] }>;

type Captured = { draws: readonly PathMeshDraw[]; frameLanes: readonly number[] | null };

/** Runs one frame of the product path, capturing the packer's draws and meshFrame lanes. */
function prepareFrame(
  source: PrimitiveSceneSource,
  target: PrimitiveTarget,
): Captured & { notices: readonly PathMeshNotice[] } {
  const captured: Captured = { draws: [], frameLanes: null };
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored in finally; called with its own this
  const original = PathMeshPacker.prototype.prepare;
  PathMeshPacker.prototype.prepare = function (this: PathMeshPacker, input) {
    captured.draws = input.draws;
    captured.frameLanes = input.frameLanes;
    return original.call(this, input);
  };
  try {
    const packet = source.prepare(target);
    if (packet === null) throw new Error('a04 harness: the scene source returned no packet');
    return { ...captured, notices: packet.mesh?.notices ?? [] };
  } finally {
    PathMeshPacker.prototype.prepare = original;
  }
}

/**
 * Steps 1 to 4 of E3-K2 for one case: bucket choice, the port request at e − k, the K4 offsets
 * and lanes, exactly as renderer-core computes them. A served offset k > 0 (E3-C8) is reached by
 * a first frame at zoom z·2^k, whose bucket is e − k, centred on the same world point; the
 * reuse rule then serves that entry at z (V3 section c).
 */
export function drawCase(
  kase: A04Case,
  ports: HarnessPorts,
  options: Readonly<{ partner?: A04Case; opacity?: number; fringe?: 'on' | 'off' }> = {},
): DrawOutcome {
  const own = decodeCase(kase);
  const partner = options.partner === undefined ? null : decodeCase(options.partner);
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: ports.fill === undefined ? 'unsupported' : 'supported',
    pathStrokes: ports.stroke === undefined ? 'unsupported' : 'supported',
  });
  const pipeline = new PathMeshPipeline({
    ...(ports.fill === undefined ? {} : { port: ports.fill }),
    ...(ports.stroke === undefined ? {} : { strokePort: ports.stroke }),
    // V-4's `msaa-4x` variant: no builder, as PrimitiveRendererService's `fringeForTesting: 'off'`.
    ...(options.fringe === 'off' ? {} : { fringeBuilder: buildPathFringe }),
  });
  const source = new PrimitiveSceneSource(mirror, pipeline);
  const applied = mirror.replaceSnapshot({
    identity: { documentId: 'e3-a04', pageId: 'page' },
    revision: 1,
    nodes: [sceneNode(own, partner, options.opacity ?? own.opacity)],
    rootOrder: [NODE_ID],
  });
  if (applied.status !== 'applied') throw new Error(`a04 harness: scene ${applied.status}`);
  const portCalls = () => {
    const s = pipeline.getStatistics();
    return own.paint === 'fill' ? s.portCalls : (s.strokePortCalls ?? 0);
  };
  const notices: string[] = [];
  const noticeCodes = (list: readonly PathMeshNotice[]) => {
    for (const n of list)
      if (n.paint === null || n.paint === own.paint || partner !== null)
        notices.push(`${n.paint ?? 'node'}:${n.failureCode}`);
  };
  let generation = 0;
  const k = own.servedOffset;
  if (k > 0) {
    // The priming frame: the same world point at the viewport centre, zoom z·2^k.
    const zoom = own.zoom * 2 ** k;
    const center = { x: own.camera.x + 320 / own.zoom, y: own.camera.y + 180 / own.zoom };
    mirror.setCamera({ position: { x: center.x - 320 / zoom, y: center.y - 180 / zoom }, zoom });
    generation += 1;
    noticeCodes(prepareFrame(source, targetFor(own.dpr, generation)).notices);
  }
  mirror.setCamera({ position: own.camera, zoom: own.zoom });
  generation += 1;
  const frame = prepareFrame(source, targetFor(own.dpr, generation));
  noticeCodes(frame.notices);
  const paintOf = (draw: PathMeshDraw) => draw.paint ?? 'fill';
  const draw = frame.draws.find((d) => d.nodeId === NODE_ID && paintOf(d) === own.paint);
  if (draw !== undefined) {
    const lanes = frame.frameLanes;
    if (lanes === null) throw new Error('a04 harness: a draw without meshFrame lanes');
    const f32 = lanes.map((lane) => Math.fround(lane));
    return {
      kind: 'drawn',
      draw,
      frame: {
        originMinusCamera: [f32[0]!, f32[1]!],
        zoom: f32[2]!,
        dpr: f32[3]!,
        width: f32[4]!,
        height: f32[5]!,
      },
      notices,
    };
  }
  // A failure of this paint (or of the node, or of the joint partner, which hides the path).
  const failure = [...frame.notices].find(
    (n) => n.nodeId === NODE_ID && (n.paint === own.paint || n.paint === null),
  );
  if (failure !== undefined) return { kind: 'rejected', code: failure.failureCode, notices };
  const partnerFailure = frame.notices.find((n) => n.nodeId === NODE_ID);
  if (partnerFailure !== undefined)
    return { kind: 'rejected', code: `joint-partner-${partnerFailure.failureCode}`, notices };
  return { kind: portCalls() > 0 ? 'empty' : 'culled', notices };
}

// =============================================================================================
// The shader model (contract section 7.1): p* exactly from the f32 lanes, and β

export type MappedPoint = Readonly<{
  x: D;
  y: D;
  /** β(p) of the vertex path (NDC round trip) and of the feature path, physical px. */
  betaVertex: number;
  betaFeature: number;
}>;

export type ShaderLanes = Readonly<{
  linear: readonly [number, number, number, number];
  anchor: readonly [number, number];
  frame: Frame;
}>;

/**
 * Forward error bound of the vertex path along one axis: the NDC step `p·2/W − 1` (division
 * within 2.5 ulp, WGSL), then the fixed-function viewport transform back to pixels, modelled in
 * f32 as `(n·½ + ½)·W` or `n·(W/2) + W/2` (three roundings cover either form).
 */
export function ndcAxisError(p: number, featureError: number, size: number): number {
  const absP = Math.abs(p);
  const q = (2 / size) * (featureError + 5 * F32_U * (1 + F32_U) * (absP + featureError));
  const n = Math.abs((2 * p) / size - 1) * SLACK;
  const en = q + F32_U * (n + q);
  const half = size / 2;
  return half * en + gamma(3) * half * (n + en + 1);
}

/** Maps one stored offset u as the WGSL toPhysical does, exactly, with its β bounds. */
export function mapPoint(
  ux: number,
  uy: number,
  lanes: ShaderLanes,
  mutations: HarnessMutations = {},
): MappedPoint {
  const [l0, l1, l2, l3] = lanes.linear.map(dy) as [D, D, D, D];
  const [bx, by] = lanes.anchor.map(dy) as [D, D];
  const [ox, oy] = lanes.frame.originMinusCamera.map(dy) as [D, D];
  const scale = dmul(dy(lanes.frame.zoom), dy(lanes.frame.dpr));
  const u = dy(ux);
  const v = dy(uy);
  const tx = [dmul(l0, u), dmul(l2, v), bx, ox];
  const ty = [dmul(l1, u), dmul(l3, v), by, oy];
  const x = dnorm(dmul(tx.reduce(dadd), scale));
  const y = dnorm(dmul(ty.reduce(dadd), scale));
  // toPhysical: six roundings on the longest chain (two products, three sums, two scalings in
  // any association; a fused multiply-add only removes roundings), so γ_6 times the sum of the
  // absolute terms bounds it (section 15.2).
  const zd = dAbsUp(scale);
  const ex = gamma(6) * tx.reduce((s, t) => s + dAbsUp(t), 0) * zd * SLACK + BETA_ABSOLUTE;
  const ey = gamma(6) * ty.reduce((s, t) => s + dAbsUp(t), 0) * zd * SLACK + BETA_ABSOLUTE;
  const betaFeature = Math.hypot(ex, ey) * SLACK;
  const vx = ndcAxisError(dNum(x), ex, lanes.frame.width) + BETA_ABSOLUTE;
  const vy = ndcAxisError(dNum(y), ey, lanes.frame.height) + BETA_ABSOLUTE;
  const betaVertex = mutations.omitNdc ? betaFeature : Math.hypot(vx, vy) * SLACK;
  return { x, y, betaVertex, betaFeature };
}

/** The packed lanes of a draw, with the test-only lane and pan mutations applied. */
export function shaderLanes(
  draw: PathMeshDraw,
  frame: Frame,
  mutations: HarnessMutations = {},
): ShaderLanes {
  const linear = [...draw.linear] as [number, number, number, number];
  if (mutations.linearLane !== undefined) {
    const { index, ulps } = mutations.linearLane;
    linear[index] = addUlps(linear[index]!, ulps);
  }
  let originMinusCamera = frame.originMinusCamera;
  if (mutations.panPx !== undefined) {
    const s = frame.zoom * frame.dpr;
    originMinusCamera = [
      Math.fround(originMinusCamera[0] + mutations.panPx[0] / s),
      Math.fround(originMinusCamera[1] + mutations.panPx[1] / s),
    ];
  }
  return { linear, anchor: draw.anchor, frame: { ...frame, originMinusCamera } };
}

/** Adds an integer number of binary32 ulps to a finite binary32 value of fixed sign. */
export function addUlps(value: number, ulps: number): number {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, value);
  buffer.setInt32(0, buffer.getInt32(0) + ulps);
  return buffer.getFloat32(0);
}

// =============================================================================================
// Guard band and clipping (E3-Q11 (a)), no-flip certificate (section 7.1)

export type Mapped = Readonly<{
  points: readonly MappedPoint[];
  indices: ArrayLike<number>;
  width: number;
  height: number;
}>;

export type GuardResult = Readonly<{
  outside: number;
  crossing: number;
  /** The clip model's bound for new vertices (0 when nothing is clipped), physical px. */
  betaClip: number;
}>;

/**
 * Viewport `[0, W] × [0, H]` (NDC `[−1, 1]²`) as the guard band. A triangle with a mapped
 * vertex outside it and not wholly beyond one clip plane is clipped by the GPU. Each new vertex
 * is an f32 interpolation, in clip space, along an edge of the polygon clipped so far, followed
 * by the viewport transform. Per plane crossed this adds at most
 * `γ_8·Σ(|x − W/2| + |y − H/2|)` over the triangle's vertices, and the transform of the new
 * vertex adds `γ_3·(W + H)` (section 15.3).
 */
export function guardBand(mapped: Mapped): GuardResult {
  const W = dy(mapped.width);
  const H = dy(mapped.height);
  const sides = mapped.points.map((p) => ({
    left: dsign(p.x) < 0,
    right: dcmp(p.x, W) > 0,
    top: dsign(p.y) < 0,
    bottom: dcmp(p.y, H) > 0,
  }));
  const outsideOf = (s: (typeof sides)[number]) => s.left || s.right || s.top || s.bottom;
  let outside = 0;
  for (const s of sides) if (outsideOf(s)) outside += 1;
  let crossing = 0;
  let betaClip = 0;
  const planes = ['left', 'right', 'top', 'bottom'] as const;
  for (let t = 0; t + 2 < mapped.indices.length; t += 3) {
    const tri = [mapped.indices[t]!, mapped.indices[t + 1]!, mapped.indices[t + 2]!];
    const s = tri.map((i) => sides[i]!);
    if (!s.some(outsideOf)) continue;
    if (planes.some((key) => s.every((x) => x[key]))) continue;
    crossing += 1;
    const crossed = planes.filter((key) => s.some((x) => x[key])).length;
    let sum = 0;
    for (const i of tri)
      sum +=
        Math.abs(dNum(mapped.points[i]!.x) - mapped.width / 2) +
        Math.abs(dNum(mapped.points[i]!.y) - mapped.height / 2);
    const bound = crossed * gamma(8) * sum + gamma(3) * (mapped.width + mapped.height);
    betaClip = Math.max(betaClip, bound * SLACK);
  }
  return { outside, crossing, betaClip };
}

export type NoFlipResult = Readonly<{
  checked: number;
  failed: number;
  zeroArea: number;
  /** Zero-area triangles with two equal mapped vertices, exempt (section 15.4). */
  collapsed: number;
}>;

/**
 * Each mapped triangle whose box meets `Ω ⊕ 2` keeps its orientation under a `β` perturbation
 * of its vertices: with `e1`, `e2` the edges at the vertex shared by the two shortest edges,
 * `|e1 × e2| > 2β(|e1| + |e2|) + 4β²`. A zero-area triangle fails, unless two of its vertices map
 * to the same p*: they then have the same stored offset, so the GPU maps them to the same
 * position bit for bit (section 7.1), and the triangle is the same segment on both sides, with
 * no orientation to flip (`collapsed`, section 15.4).
 */
export function noFlip(mapped: Mapped, beta: number): NoFlipResult {
  let checked = 0;
  let failed = 0;
  let zeroArea = 0;
  let collapsed = 0;
  const x0 = -4;
  const y0 = -4;
  const x1 = mapped.width + 4;
  const y1 = mapped.height + 4;
  for (let t = 0; t + 2 < mapped.indices.length; t += 3) {
    const p = [mapped.indices[t]!, mapped.indices[t + 1]!, mapped.indices[t + 2]!].map(
      (i) => mapped.points[i]!,
    );
    const xs = p.map((q) => dNum(q.x));
    const ys = p.map((q) => dNum(q.y));
    if (
      Math.max(...xs) < x0 ||
      Math.min(...xs) > x1 ||
      Math.max(...ys) < y0 ||
      Math.min(...ys) > y1
    )
      continue;
    checked += 1;
    const edge = (i: number, j: number) => ({
      x: dsub(p[j]!.x, p[i]!.x),
      y: dsub(p[j]!.y, p[i]!.y),
    });
    const length = (e: { x: D; y: D }) => Math.hypot(dAbsUp(e.x), dAbsUp(e.y)) * SLACK;
    const edges = [edge(0, 1), edge(1, 2), edge(2, 0)];
    const lengths = edges.map(length);
    // The vertex opposite the longest edge is shared by the two shortest.
    const longest = lengths.indexOf(Math.max(...lengths));
    const apex = (longest + 2) % 3;
    const e1 = edge(apex, (apex + 1) % 3);
    const e2 = edge(apex, (apex + 2) % 3);
    const cross = dsub(dmul(e1.x, e2.y), dmul(e1.y, e2.x));
    if (cross.n === 0n) {
      zeroArea += 1;
      const same = (i: number, j: number) =>
        dcmp(p[i]!.x, p[j]!.x) === 0 && dcmp(p[i]!.y, p[j]!.y) === 0;
      if (same(0, 1) || same(1, 2) || same(2, 0)) collapsed += 1;
      else failed += 1;
      continue;
    }
    const need = (2 * beta * (length(e1) + length(e2)) + 4 * beta * beta) * SLACK;
    if (!(dAbsDown(cross) > need)) failed += 1;
  }
  return { checked, failed, zeroArea, collapsed };
}

/** The mesh's indices without its collapsed triangles (two vertices with the same p*). */
export function withoutCollapsed(mapped: Mapped): number[] {
  const kept: number[] = [];
  const same = (i: number, j: number) =>
    dcmp(mapped.points[i]!.x, mapped.points[j]!.x) === 0 &&
    dcmp(mapped.points[i]!.y, mapped.points[j]!.y) === 0;
  for (let t = 0; t + 2 < mapped.indices.length; t += 3) {
    const [a, b, c] = [mapped.indices[t]!, mapped.indices[t + 1]!, mapped.indices[t + 2]!];
    if (!same(a, b) && !same(b, c) && !same(c, a)) kept.push(a, b, c);
  }
  return kept;
}

/** The mesh's indices with its triangles of positive area only (section 20). */
export function withPositiveArea(mapped: Mapped): number[] {
  const kept: number[] = [];
  const P = mapped.points;
  for (let t = 0; t + 2 < mapped.indices.length; t += 3) {
    const [a, b, c] = [mapped.indices[t]!, mapped.indices[t + 1]!, mapped.indices[t + 2]!];
    const area = dsub(
      dmul(dsub(P[b]!.x, P[a]!.x), dsub(P[c]!.y, P[a]!.y)),
      dmul(dsub(P[b]!.y, P[a]!.y), dsub(P[c]!.x, P[a]!.x)),
    );
    if (dsign(area) !== 0) kept.push(a, b, c);
  }
  return kept;
}

/**
 * Whether a boundary candidate of M* may meet `Ω ⊕ 1`. A candidate is any edge that is not
 * shared by exactly one triangle on each side (T-junction sub-edges and the edges of zero-area
 * triangles included), so the candidates are a superset of ∂M* (section 15.5).
 */
export type BoundaryCandidate = Readonly<{
  ia: number;
  ib: number;
  a: MappedPoint;
  b: MappedPoint;
  /** Triangles left of `a → b`, right of it, and of zero area. */
  plus: number;
  minus: number;
  other: number;
}>;

/**
 * The boundary candidates of `M*` (section 15.5): every edge not shared by exactly one triangle
 * on each side. That includes T-junction sub-edges and the edges of zero-area triangles, so the
 * candidates are a superset of `∂M*`. Edges of zero length are left out.
 */
export function boundaryCandidates(mapped: Mapped): BoundaryCandidate[] {
  const key = (q: MappedPoint) => `${q.x.n}/${q.x.e},${q.y.n}/${q.y.e}`;
  const sides = new Map<
    string,
    {
      ia: number;
      ib: number;
      a: MappedPoint;
      b: MappedPoint;
      plus: number;
      minus: number;
      other: number;
    }
  >();
  for (let t = 0; t + 2 < mapped.indices.length; t += 3) {
    const tri = [mapped.indices[t]!, mapped.indices[t + 1]!, mapped.indices[t + 2]!];
    for (let k = 0; k < 3; k += 1) {
      let ia = tri[k]!;
      let ib = tri[(k + 1) % 3]!;
      let a = mapped.points[ia]!;
      let b = mapped.points[ib]!;
      const c = mapped.points[tri[(k + 2) % 3]!]!;
      if (key(a) === key(b)) continue;
      if (key(a) > key(b)) [a, b, ia, ib] = [b, a, ib, ia];
      const id = `${key(a)}|${key(b)}`;
      const entry = sides.get(id) ?? { ia, ib, a, b, plus: 0, minus: 0, other: 0 };
      const o = dsign(
        dsub(dmul(dsub(b.x, a.x), dsub(c.y, a.y)), dmul(dsub(b.y, a.y), dsub(c.x, a.x))),
      );
      if (o > 0) entry.plus += 1;
      else if (o < 0) entry.minus += 1;
      else entry.other += 1;
      sides.set(id, entry);
    }
  }
  const candidates: BoundaryCandidate[] = [];
  for (const e of sides.values())
    if (!(e.plus === 1 && e.minus === 1 && e.other === 0)) candidates.push(e);
  return candidates;
}

export function boundaryMayMeetGuard(mapped: Mapped): boolean {
  const x0 = -3;
  const y0 = -3;
  const x1 = mapped.width + 3;
  const y1 = mapped.height + 3;
  for (const e of boundaryCandidates(mapped)) {
    const xs = [dNum(e.a.x), dNum(e.b.x)];
    const ys = [dNum(e.a.y), dNum(e.b.y)];
    if (
      Math.max(...xs) + 1e-9 >= x0 &&
      Math.min(...xs) - 1e-9 <= x1 &&
      Math.max(...ys) + 1e-9 >= y0 &&
      Math.min(...ys) - 1e-9 <= y1
    )
      return true;
  }
  return false;
}

/**
 * E20-K4: a lower bound of the distance from the boundary candidates of `M*` to `Ω`, the viewport
 * plus 2 px. A candidate more than `β_c` from `Ω` cannot be moved into it. Evaluated in binary64
 * on coordinates within `2^-52` of `p*`.
 * Two disjoint convex sets are nearest at a vertex of one of them, so the distance is the
 * smallest of the end points to the box and the box corners to the segment, less `f64Margin`.
 */
export function boundaryDistanceFromWindow(mapped: Mapped): number {
  const x0 = -2;
  const y0 = -2;
  const x1 = mapped.width + 2;
  const y1 = mapped.height + 2;
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ] as const;
  const toBox = (x: number, y: number) =>
    Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
  // Liang-Barsky: whether the segment meets the closed box.
  const meetsBox = (ax: number, ay: number, bx: number, by: number) => {
    let lo = 0;
    let hi = 1;
    for (const [p, q] of [
      [ax - bx, ax - x0],
      [bx - ax, x1 - ax],
      [ay - by, ay - y0],
      [by - ay, y1 - ay],
    ] as const) {
      if (p === 0) {
        if (q < 0) return false;
      } else if (p < 0) lo = Math.max(lo, q / p);
      else hi = Math.min(hi, q / p);
    }
    return lo <= hi;
  };
  let distance = Infinity;
  for (const e of boundaryCandidates(mapped)) {
    const [ax, ay, bx, by] = [dNum(e.a.x), dNum(e.a.y), dNum(e.b.x), dNum(e.b.y)];
    if (meetsBox(ax, ay, bx, by)) return 0;
    const scale = mapped.width + mapped.height + 4 + Math.max(...[ax, ay, bx, by].map(Math.abs));
    distance = Math.min(
      distance,
      Math.min(
        toBox(ax, ay),
        toBox(bx, by),
        ...corners.map(([x, y]) => pointSegment(x, y, ax, ay, bx, by)),
      ) - f64Margin(scale),
    );
  }
  return distance;
}

/**
 * The T-junctions of `M*` as `[v, a, b]` point indices: a boundary-candidate end point `v` that
 * lies strictly inside another candidate edge `ab`, exactly. The GPU readback measures the crack
 * width at each (section 7.1, E3-C12; reported under E3-Q10 (b), never gated).
 */
export function tJunctionTriples(
  mapped: Mapped,
  candidates: readonly BoundaryCandidate[] = boundaryCandidates(mapped),
): [number, number, number][] {
  const ends = new Map<string, number>();
  for (const e of candidates)
    for (const i of [e.ia, e.ib]) {
      const q = mapped.points[i]!;
      ends.set(`${q.x.n}/${q.x.e},${q.y.n}/${q.y.e}`, i);
    }
  const sorted = [...ends.values()]
    .map((i) => ({ i, x: dNum(mapped.points[i]!.x) }))
    .sort((p, q) => p.x - q.x);
  const xs = sorted.map((p) => p.x);
  const lower = (x: number) => {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const triples: [number, number, number][] = [];
  for (const e of candidates) {
    const ax = dNum(e.a.x);
    const bx = dNum(e.b.x);
    const pad = 1e-9 * (1 + Math.abs(ax) + Math.abs(bx));
    for (let k = lower(Math.min(ax, bx) - pad); k < sorted.length; k += 1) {
      if (sorted[k]!.x > Math.max(ax, bx) + pad) break;
      const v = mapped.points[sorted[k]!.i]!;
      const abx = dsub(e.b.x, e.a.x);
      const aby = dsub(e.b.y, e.a.y);
      const avx = dsub(v.x, e.a.x);
      const avy = dsub(v.y, e.a.y);
      if (dsign(dsub(dmul(abx, avy), dmul(aby, avx))) !== 0) continue;
      // Strictly between a and b: 0 < (v − a)·(b − a) < |b − a|².
      const along = dadd(dmul(avx, abx), dmul(avy, aby));
      const length = dadd(dmul(abx, abx), dmul(aby, aby));
      if (dsign(along) > 0 && dsign(dsub(length, along)) > 0)
        triples.push([sorted[k]!.i, e.ia, e.ib]);
    }
  }
  return triples;
}

// =============================================================================================
// The flip-tolerant bound (E3-U6, contract section 20)

export type FlipTolerantResult = Readonly<{
  /** `ρ = max(β, D_hi)`, so that `E_Ω(M_gpu, M*) ≤ ρ`; null when a precondition fails. */
  rho: number | null;
  /** The precondition that failed, or null. */
  reason: string | null;
  /** Boundary edges certified near the window, and the pieces their offsets used. */
  edges: number;
  pieces: number;
  work: number;
  /** E20 only: the T-vertices that chain edges were split at (K6). */
  splitTVertices?: number;
  /** E20 only: edges whose D came from the refined search, and edges tested exactly (K3). */
  refinedEdges?: number;
  exactEdges?: number;
  /** E20-K1 only, set by measureCase: the bound ran on a draw with clipped triangles. */
  clipped?: boolean;
}>;

export type FlipTolerantOptions = Readonly<{
  /** The E20 remedies K2, K3 and K6 (measureCase sets it only where section 20 failed). */
  e20?: boolean;
  /** E20-K3: the refined search on every edge, for a row that straddles 0.25 px. */
  refineAll?: boolean;
  /** Test-only seeded defect (E20-A3): an edge below binary64 reports D without the exact test. */
  defect?: 'no-exact-fallback';
}>;

/** A point with dyadic coordinates. */
type Pt = Readonly<{ x: D; y: D }>;

/** An edge of the chain between two p*, `a` before `b` by key. */
type ChainEdge = {
  ia: number;
  ib: number;
  a: MappedPoint;
  b: MappedPoint;
  /** Edges a → b less edges b → a: the edge is in the chain when this is nonzero. */
  net: number;
  /** Positive-area triangles left of a → b and right of it. */
  plus: number;
  minus: number;
};

/** The largest offset the D certificate tries, physical px (ρ is useless above it). */
export const FLIP_TOLERANT_RHO_MAX = 0.5;
const FLIP_TOLERANT_WORK_CAP = 5e7;
const FLIP_TOLERANT_DEPTH = 12;
/** Offset directions, as angles from the outward normal towards the edge direction. */
const FLIP_TOLERANT_ANGLES = [0, 1, -1, 2, -2, 2.5, -2.5].map((k) => (k * Math.PI) / 6);
/** An offset search: directions, growth factor, split depth and shortest piece (in β). */
type OffsetSearch = Readonly<{
  angles: readonly number[];
  factor: number;
  depth: number;
  minimum: number;
}>;
const OLD_SEARCH: OffsetSearch = {
  angles: FLIP_TOLERANT_ANGLES,
  factor: Math.SQRT2,
  depth: FLIP_TOLERANT_DEPTH,
  minimum: 1 / 4,
};
/** E20-K3: every 15° within ±75°, factor 2^(1/4), depth 16, pieces down to β/8. */
const REFINED_SEARCH: OffsetSearch = {
  angles: [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5].map((k) => (k * Math.PI) / 12),
  factor: 2 ** 0.25,
  depth: 16,
  minimum: 1 / 8,
};
const GRID_CELL = 8;

/**
 * Triangles, edges or points by grid cell over a box. A box off the grid is clamped into its
 * border cells, so a query anywhere finds every item whose box meets the query's box.
 */
class CellGrid {
  readonly cells = new Map<number, number[]>();
  private readonly nx: number;
  private readonly ny: number;
  constructor(
    private readonly x0: number,
    private readonly y0: number,
    x1: number,
    y1: number,
  ) {
    this.nx = Math.ceil((x1 - x0) / GRID_CELL) + 1;
    this.ny = Math.ceil((y1 - y0) / GRID_CELL) + 1;
  }
  /** The cell range of a box, padded by one cell and clamped into the grid. */
  private range(bx0: number, by0: number, bx1: number, by1: number) {
    const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
    const i0 = clamp(Math.floor((bx0 - this.x0) / GRID_CELL) - 1, this.nx);
    const j0 = clamp(Math.floor((by0 - this.y0) / GRID_CELL) - 1, this.ny);
    const i1 = clamp(Math.floor((bx1 - this.x0) / GRID_CELL) + 1, this.nx);
    const j1 = clamp(Math.floor((by1 - this.y0) / GRID_CELL) + 1, this.ny);
    return { i0, j0, i1, j1 };
  }
  /** Inserts `id` under its box; returns the cells written. */
  insert(id: number, bx0: number, by0: number, bx1: number, by1: number): number {
    const r = this.range(bx0, by0, bx1, by1);
    for (let j = r.j0; j <= r.j1; j += 1)
      for (let i = r.i0; i <= r.i1; i += 1) {
        const key = j * this.nx + i;
        const list = this.cells.get(key);
        if (list === undefined) this.cells.set(key, [id]);
        else list.push(id);
      }
    return (r.i1 - r.i0 + 1) * (r.j1 - r.j0 + 1);
  }
  /** The ids whose cells meet a box, each once. */
  query(bx0: number, by0: number, bx1: number, by1: number): number[] {
    const r = this.range(bx0, by0, bx1, by1);
    const found = new Set<number>();
    for (let j = r.j0; j <= r.j1; j += 1)
      for (let i = r.i0; i <= r.i1; i += 1)
        for (const id of this.cells.get(j * this.nx + i) ?? []) found.add(id);
    return [...found];
  }
}

/** The binary64 distance between point `p` and segment `ab`. */
function pointSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy2 = by - ay;
  const l2 = dx * dx + dy2 * dy2;
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy2) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy2));
}

/** The binary64 distance between segments `pq` and `ab` (0 when they cross). */
function segmentSegment(s: readonly number[], c: readonly number[]): number {
  const [px, py, qx, qy] = s as [number, number, number, number];
  const [ax, ay, bx, by] = c as [number, number, number, number];
  const o = (x0: number, y0: number, x1: number, y1: number, x: number, y: number) =>
    Math.sign((x1 - x0) * (y - y0) - (y1 - y0) * (x - x0));
  if (
    o(px, py, qx, qy, ax, ay) * o(px, py, qx, qy, bx, by) < 0 &&
    o(ax, ay, bx, by, px, py) * o(ax, ay, bx, by, qx, qy) < 0
  )
    return 0;
  return Math.min(
    pointSegment(px, py, ax, ay, bx, by),
    pointSegment(qx, qy, ax, ay, bx, by),
    pointSegment(ax, ay, px, py, qx, qy),
    pointSegment(bx, by, px, py, qx, qy),
  );
}

/**
 * An absolute allowance for the binary64 evaluation of a distance or an offset point whose
 * coordinates are at most `k` in magnitude: each is a handful of roundings, each within
 * `2^-53·4k`, far below `2^-30·(1 + k)`.
 */
const f64Margin = (k: number) => 2 ** -30 * (1 + k);

/** Exact `a/b < c/d` for `b, d > 0`. */
const fracLess = (a: D, b: D, c: D, d: D) => dcmp(dmul(a, d), dmul(c, b)) < 0;

/**
 * Whether the open segment `pq` meets the open triangle `abc` of orientation `sign`, exactly.
 * Along `x(s) = p + s(q − p)` each edge's interior side is `h_k(p) + s·(h_k(q) − h_k(p)) > 0`;
 * the three open intervals meet `(0, 1)` when their largest lower end is below the smallest
 * upper end.
 */
function segmentMeetsTriangle(
  p: MappedPoint,
  q: MappedPoint,
  tri: readonly MappedPoint[],
  sign: number,
): boolean {
  const one: D = { n: 1n, e: 0 };
  let lo: [D, D] = [DZERO, one];
  let hi: [D, D] = [one, one];
  for (let k = 0; k < 3; k += 1) {
    const a = tri[k]!;
    const b = tri[(k + 1) % 3]!;
    const h = (x: MappedPoint) => {
      const v = dsub(dmul(dsub(b.x, a.x), dsub(x.y, a.y)), dmul(dsub(b.y, a.y), dsub(x.x, a.x)));
      return sign > 0 ? v : { n: -v.n, e: v.e };
    };
    const hp = h(p);
    const delta = dsub(h(q), hp);
    const s = dsign(delta);
    if (s === 0) {
      if (dsign(hp) <= 0) return false;
    } else if (s > 0) {
      // s > −h(p)/δ
      const num = { n: -hp.n, e: hp.e };
      if (fracLess(lo[0], lo[1], num, delta)) lo = [num, delta];
    } else {
      // s < h(p)/(−δ)
      const den = { n: -delta.n, e: delta.e };
      if (fracLess(hp, den, hi[0], hi[1])) hi = [hp, den];
    }
  }
  return fracLess(lo[0], lo[1], hi[0], hi[1]);
}

/**
 * The flip-tolerant bound of section 20. It replaces the no-flip certificate when that fails
 * and these hold, all exactly:
 *
 * 1. the triangles of `M*` of positive area all have one orientation, and each zero-area triangle
 *    near the window lies on their edges;
 * 2. near the window (`Ω ⊕ 3`), every edge of the chain (directed edges, `a → b` cancelling
 *    `b → a`) is boundary of `M*`: collinear edges of positive-area triangles on one side of it
 *    cover it, and no open triangle meets it.
 *
 * Then the winding number of the moving mesh is constant off `C* ⊕ β` (`C*` the chain), so
 * `M_gpu △ M* ⊂ C* ⊕ β` and `∂M_gpu ⊂ C* ⊕ β`, and by 2 these are `∂M* ⊕ β` in the window. A
 * point `p ∈ ∂M* ∩ Ω` is within `β` of `M_gpu` (its own triangle's image) and within `D(p)` of a
 * point `x ∉ M*` more than `β` from `C*`, which is off `M_gpu`. So `E_Ω(M_gpu, M*) ≤ max(β, D_hi)`.
 * `D_hi` is certified by translating pieces of each chain edge outward: a translate more than `β`
 * from the chain lies wholly inside or outside `M*`, and one exact point test decides.
 *
 * With `e20` (E20 contract, section 2) three remedies also apply. K6 splits every chain edge
 * near the window at each `p*` exactly inside it, as E3-Q10 (b)'s crack-closed region places a
 * T-vertex on its mapped edge at `λ`. K2 admits a zero-area triangle whose segment lies in `M*`
 * (exact membership on its pieces between meetings with the positive-area chain). K3 retries an
 * edge whose offset search fails with a finer search, and tests an edge below binary64 exactly.
 */
export function flipTolerantBound(
  mapped: Mapped,
  beta: number,
  options: FlipTolerantOptions = {},
): FlipTolerantResult {
  const W = mapped.width;
  const H = mapped.height;
  const P = mapped.points;
  const e20 = options.e20 === true;
  let work = 0;
  let edges = 0;
  let pieces = 0;
  let refinedEdges = 0;
  let exactEdges = 0;
  const splitAt = new Set<string>();
  const result = (rho: number | null, reason: string | null): FlipTolerantResult =>
    e20
      ? {
          rho,
          reason,
          edges,
          pieces,
          work,
          splitTVertices: splitAt.size,
          refinedEdges,
          exactEdges,
        }
      : { rho, reason, edges, pieces, work };
  const no = (reason: string): FlipTolerantResult => result(null, reason);
  const cross = (a: Pt, b: Pt, c: Pt) =>
    dsub(dmul(dsub(b.x, a.x), dsub(c.y, a.y)), dmul(dsub(b.y, a.y), dsub(c.x, a.x)));

  // 1. The triangles of positive area all of one orientation. Zero-area ones stay in the chain.
  const indices = withoutCollapsed(mapped);
  const tris: [number, number, number][] = [];
  const all: [number, number, number][] = [];
  let sign = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const tri: [number, number, number] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    all.push(tri);
    const o = dsign(cross(P[tri[0]]!, P[tri[1]]!, P[tri[2]]!));
    if (o === 0) continue;
    if (sign === 0) sign = o;
    else if (o !== sign) return no('mixed orientation');
    tris.push(tri);
  }
  if (tris.length === 0) return no('no triangle');
  const key = (q: MappedPoint) => `${q.x.n}/${q.x.e},${q.y.n}/${q.y.e}`;
  const xs = P.map((p) => dNum(p.x));
  const ys = P.map((p) => dNum(p.y));
  const grid = () => new CellGrid(-10, -10, W + 10, H + 10);
  const meets = (b: readonly number[], pad: number) =>
    b[2]! + 1e-9 >= -2 - pad &&
    b[0]! - 1e-9 <= W + 2 + pad &&
    b[3]! + 1e-9 >= -2 - pad &&
    b[1]! - 1e-9 <= H + 2 + pad;
  const boxOf = (ia: number, ib: number) =>
    [
      Math.min(xs[ia]!, xs[ib]!),
      Math.min(ys[ia]!, ys[ib]!),
      Math.max(xs[ia]!, xs[ib]!),
      Math.max(ys[ia]!, ys[ib]!),
    ] as const;
  // E20-K6: the p* exactly inside a directed edge whose box meets Ω ⊕ 4, in order from its start.
  // An edge and its reverse have one box, so both are split alike and their pieces cancel.
  let between: (ia: number, ib: number) => number[] = () => [];
  if (e20) {
    const pointGrid = grid();
    const seen = new Set<string>();
    for (const tri of all)
      for (const i of tri) {
        const k = key(P[i]!);
        if (seen.has(k)) continue;
        seen.add(k);
        work += pointGrid.insert(i, xs[i]!, ys[i]!, xs[i]!, ys[i]!);
      }
    between = (ia, ib) => {
      const b = boxOf(ia, ib);
      if (!meets(b, 4)) return [];
      const a = P[ia]!;
      const abx = dsub(P[ib]!.x, a.x);
      const aby = dsub(P[ib]!.y, a.y);
      const length = dadd(dmul(abx, abx), dmul(aby, aby));
      const found: { i: number; along: D }[] = [];
      for (const i of pointGrid.query(...b)) {
        work += 1;
        if (work > FLIP_TOLERANT_WORK_CAP) return [];
        const avx = dsub(P[i]!.x, a.x);
        const avy = dsub(P[i]!.y, a.y);
        if (dsign(dsub(dmul(abx, avy), dmul(aby, avx))) !== 0) continue;
        const along = dadd(dmul(avx, abx), dmul(avy, aby));
        if (dsign(along) > 0 && dcmp(along, length) < 0) found.push({ i, along });
      }
      found.sort((p, q) => dcmp(p.along, q.along));
      for (const f of found) splitAt.add(key(P[f.i]!));
      return found.map((f) => f.i);
    };
  }
  // The chain: every directed edge, with a → b and b → a between the same two p* cancelling.
  const addEdge = (chain: Map<string, ChainEdge>, from: number, to: number, o: number) => {
    let ia = from;
    let ib = to;
    let forward = 1;
    if (key(P[ia]!) > key(P[ib]!)) [ia, ib, forward] = [ib, ia, -1];
    const id = `${key(P[ia]!)}|${key(P[ib]!)}`;
    const e = chain.get(id) ?? { ia, ib, a: P[ia]!, b: P[ib]!, net: 0, plus: 0, minus: 0 };
    e.net += forward;
    // A positive-area triangle lies left of a → b when its orientation and direction agree.
    if (o !== 0) {
      if (o * forward > 0) e.plus += 1;
      else e.minus += 1;
    }
    chain.set(id, e);
  };
  const chain = new Map<string, ChainEdge>();
  for (const tri of all) {
    const o = dsign(cross(P[tri[0]]!, P[tri[1]]!, P[tri[2]]!));
    for (let k = 0; k < 3; k += 1) {
      const path = [tri[k]!, ...between(tri[k]!, tri[(k + 1) % 3]!), tri[(k + 1) % 3]!];
      for (let j = 0; j + 1 < path.length; j += 1) addEdge(chain, path[j]!, path[j + 1]!, o);
    }
    // A split cut short by the cap leaves the chain incomplete, so stop here.
    if (work > FLIP_TOLERANT_WORK_CAP) return no('work cap');
  }
  const candidates = [...chain.values()].filter((e) => e.net !== 0);

  const triGrid = grid();
  const edgeGrid = grid();
  tris.forEach((tri, k) => {
    const tx = tri.map((i) => xs[i]!);
    const ty = tri.map((i) => ys[i]!);
    work += triGrid.insert(k, Math.min(...tx), Math.min(...ty), Math.max(...tx), Math.max(...ty));
  });
  const box = (e: ChainEdge) => boxOf(e.ia, e.ib);
  candidates.forEach((e, k) => {
    work += edgeGrid.insert(k, ...box(e));
  });
  if (work > FLIP_TOLERANT_WORK_CAP) return no('work cap');
  // How the collinear edges of positive-area triangles cover the segment ab: whether they cover
  // all of it, the side of their triangles (2 for both), and whether an open triangle meets it.
  const coverage = (a: MappedPoint, b: MappedPoint) => {
    const lengthSquared = dadd(
      dmul(dsub(b.x, a.x), dsub(b.x, a.x)),
      dmul(dsub(b.y, a.y), dsub(b.y, a.y)),
    );
    const along = (v: MappedPoint) =>
      dadd(dmul(dsub(v.x, a.x), dsub(b.x, a.x)), dmul(dsub(v.y, a.y), dsub(b.y, a.y)));
    let side = 0;
    let across = false;
    const cover: [D, D][] = [];
    const ax = dNum(a.x);
    const ay = dNum(a.y);
    const bx = dNum(b.x);
    const by = dNum(b.y);
    for (const k of triGrid.query(
      Math.min(ax, bx),
      Math.min(ay, by),
      Math.max(ax, bx),
      Math.max(ay, by),
    )) {
      work += 1;
      const tri = tris[k]!.map((i) => P[i]!);
      if (segmentMeetsTriangle(a, b, tri, sign)) across = true;
      for (let j = 0; j < 3; j += 1) {
        const c = tri[j]!;
        const d = tri[(j + 1) % 3]!;
        if (dsign(cross(a, b, c)) !== 0 || dsign(cross(a, b, d)) !== 0) continue;
        const [tc, td] = [along(c), along(d)];
        const [lo, hi] = dcmp(tc, td) < 0 ? [tc, td] : [td, tc];
        if (!(dcmp(lo, lengthSquared) < 0 && dsign(hi) > 0)) continue;
        const o = dsign(cross(a, b, tri[(j + 2) % 3]!));
        side = side === 0 || side === o ? o : 2;
        cover.push([lo, hi]);
      }
    }
    cover.sort((p, q) => dcmp(p[0], q[0]));
    let reached: D = DZERO;
    for (const [lo, hi] of cover) {
      if (dcmp(lo, reached) > 0) break;
      if (dcmp(hi, reached) > 0) reached = hi;
    }
    return { covered: dcmp(reached, lengthSquared) >= 0, side, across };
  };
  // E20-K2: whether the segment uv lies in the closed M*, exactly. `C+` is the chain of the
  // positive-area triangles alone, so ∂M* ⊂ C+ (w_0 changes only across it). An open piece of uv
  // between consecutive meetings with C+ (proper crossings, C+ vertices on uv, which also bound
  // every collinear overlap) misses ∂M* unless it lies along an edge of C+, and an edge of C+ is
  // a positive-area triangle's edge, in M*. Either way one exact test at an inner point of the
  // piece decides it. The point u + τ(v − u) is rational: its orientation against ab is affine in
  // τ, so the test needs only the two end points' orientations.
  let plusEdges: ChainEdge[] = [];
  let plusGrid: CellGrid | null = null;
  const segmentInside = (u: MappedPoint, v: MappedPoint): boolean => {
    if (plusGrid === null) {
      const plus = new Map<string, ChainEdge>();
      for (const tri of tris)
        for (let k = 0; k < 3; k += 1) addEdge(plus, tri[k]!, tri[(k + 1) % 3]!, sign);
      plusEdges = [...plus.values()].filter((e) => e.net !== 0);
      const g = grid();
      plusEdges.forEach((e, k) => {
        work += g.insert(k, ...box(e));
      });
      plusGrid = g;
    }
    const one: D = { n: 1n, e: 0 };
    const two: D = { n: 2n, e: 0 };
    const neg = (a: D): D => ({ n: -a.n, e: a.e });
    const vx = dsub(v.x, u.x);
    const vy = dsub(v.y, u.y);
    const length = dadd(dmul(vx, vx), dmul(vy, vy));
    const params: [D, D][] = [
      [DZERO, one],
      [one, one],
    ];
    const onSegment = (q: MappedPoint) => {
      const along = dadd(dmul(dsub(q.x, u.x), vx), dmul(dsub(q.y, u.y), vy));
      if (dsign(along) > 0 && dcmp(along, length) < 0) params.push([along, length]);
    };
    const [ux, uy, wx, wy] = [dNum(u.x), dNum(u.y), dNum(v.x), dNum(v.y)];
    for (const k of plusGrid.query(
      Math.min(ux, wx),
      Math.min(uy, wy),
      Math.max(ux, wx),
      Math.max(uy, wy),
    )) {
      work += 1;
      const e = plusEdges[k]!;
      const sa = dsign(cross(u, v, e.a));
      const sb = dsign(cross(u, v, e.b));
      if (sa === 0) onSegment(e.a);
      if (sb === 0) onSegment(e.b);
      if (sa * sb < 0) {
        const cu = cross(e.a, e.b, u);
        const cv = cross(e.a, e.b, v);
        if (dsign(cu) * dsign(cv) < 0) {
          // (1 − τ)·cu + τ·cv = 0.
          const den = dsub(cu, cv);
          params.push(dsign(den) > 0 ? [cu, den] : [neg(cu), neg(den)]);
        }
      }
    }
    params.sort((p, q) =>
      fracLess(p[0], p[1], q[0], q[1]) ? -1 : fracLess(q[0], q[1], p[0], p[1]) ? 1 : 0,
    );
    for (let j = 0; j + 1 < params.length; j += 1) {
      const [p, q] = params[j]!;
      const [r, s] = params[j + 1]!;
      if (!fracLess(p, q, r, s)) continue;
      // τ = N/M, the middle of the piece, with M > 0.
      const N = dadd(dmul(p, s), dmul(r, q));
      const M = dmul(two, dmul(q, s));
      const side = (a: MappedPoint, b: MappedPoint) =>
        dsign(dadd(dmul(dsub(M, N), cross(a, b, u)), dmul(N, cross(a, b, v))));
      const t = dNum(N) / dNum(M);
      const x = ux + t * (wx - ux);
      const y = uy + t * (wy - uy);
      let covered = false;
      for (const k of triGrid.query(x, y, x, y)) {
        work += 1;
        const [a, b, c] = tris[k]!.map((i) => P[i]!) as [MappedPoint, MappedPoint, MappedPoint];
        if (side(a, b) * sign >= 0 && side(b, c) * sign >= 0 && side(c, a) * sign >= 0) {
          covered = true;
          break;
        }
      }
      if (!covered) return false;
    }
    return true;
  };
  // A zero-area triangle near the window lies on edges of positive-area triangles, so that its
  // image on the GPU stays within β of M*.
  for (const tri of all) {
    const tx = tri.map((i) => xs[i]!);
    const ty = tri.map((i) => ys[i]!);
    if (!meets([Math.min(...tx), Math.min(...ty), Math.max(...tx), Math.max(...ty)], 3)) continue;
    if (dsign(cross(P[tri[0]]!, P[tri[1]]!, P[tri[2]]!)) !== 0) continue;
    // Its segment: the two vertices farthest apart.
    const q = tri.map((i) => P[i]!);
    const d2 = (u: MappedPoint, v: MappedPoint) =>
      dadd(dmul(dsub(u.x, v.x), dsub(u.x, v.x)), dmul(dsub(u.y, v.y), dsub(u.y, v.y)));
    let [u, v] = [q[0]!, q[1]!];
    for (const [s0, s1] of [
      [q[1]!, q[2]!],
      [q[2]!, q[0]!],
    ] as const)
      if (dcmp(d2(s0, s1), d2(u, v)) > 0) [u, v] = [s0, s1];
    if (!coverage(u, v).covered && !(e20 && segmentInside(u, v)))
      return no('zero-area triangle off M*');
  }

  // A dyadic point in the closed M*.
  const insideExact = (q: Pt) => {
    const x = dNum(q.x);
    const y = dNum(q.y);
    for (const k of triGrid.query(x, y, x, y)) {
      work += 1;
      const [a, b, c] = tris[k]!.map((i) => P[i]!) as [MappedPoint, MappedPoint, MappedPoint];
      if (
        dsign(cross(a, b, q)) * sign >= 0 &&
        dsign(cross(b, c, q)) * sign >= 0 &&
        dsign(cross(c, a, q)) * sign >= 0
      )
        return true;
    }
    return false;
  };
  // A point (binary64, so exact) in the closed M*.
  const inside = (x: number, y: number) => insideExact({ x: dy(x), y: dy(y) });
  // A translate `S` more than β from every candidate and outside M*.
  const clear = (s: readonly number[]) => {
    const r = beta + f64Margin(W + H + 20);
    const near = edgeGrid.query(
      Math.min(s[0]!, s[2]!) - r,
      Math.min(s[1]!, s[3]!) - r,
      Math.max(s[0]!, s[2]!) + r,
      Math.max(s[1]!, s[3]!) + r,
    );
    for (const k of near) {
      work += 1;
      const e = candidates[k]!;
      const c = [xs[e.ia]!, ys[e.ia]!, xs[e.ib]!, ys[e.ib]!];
      const scale = Math.max(...s.map(Math.abs), ...c.map(Math.abs));
      if (!(segmentSegment(s, c) > beta + f64Margin(scale))) return false;
    }
    return !inside((s[0]! + s[2]!) / 2, (s[1]! + s[3]!) / 2);
  };

  // E20-K3: the exact test for an edge below binary64. The translate is the edge moved by a
  // binary64 vector w, so its end points stay dyadic, and it is accepted when it is more than β
  // from every candidate (exact squared distances) and its midpoint is outside M*. D ≤ |w|.
  const r2 = dmul(dy(beta), dy(beta));
  const half: D = { n: 1n, e: -1 };
  const squared = (p: Pt, q: Pt) => {
    const dx = dsub(p.x, q.x);
    const dyy = dsub(p.y, q.y);
    return dadd(dmul(dx, dx), dmul(dyy, dyy));
  };
  /** Whether point p is more than β from segment cd. */
  const fartherThanBeta = (p: Pt, c: Pt, d: Pt) => {
    const cdx = dsub(d.x, c.x);
    const cdy = dsub(d.y, c.y);
    const length = dadd(dmul(cdx, cdx), dmul(cdy, cdy));
    const along = dadd(dmul(dsub(p.x, c.x), cdx), dmul(dsub(p.y, c.y), cdy));
    if (dsign(along) <= 0) return dcmp(squared(p, c), r2) > 0;
    if (dcmp(along, length) >= 0) return dcmp(squared(p, d), r2) > 0;
    const k = cross(c, d, p);
    return dcmp(dmul(k, k), dmul(r2, length)) > 0;
  };
  /** Whether segments pq and cd are more than β apart: disjoint, and then nearest at an end. */
  const segmentsApart = (p: Pt, q: Pt, c: Pt, d: Pt) => {
    const o = [cross(p, q, c), cross(p, q, d), cross(c, d, p), cross(c, d, q)].map(dsign);
    const collinear = o.every((s) => s === 0);
    if (!collinear && o[0]! * o[1]! <= 0 && o[2]! * o[3]! <= 0) return false;
    return (
      fartherThanBeta(p, c, d) &&
      fartherThanBeta(q, c, d) &&
      fartherThanBeta(c, p, q) &&
      fartherThanBeta(d, p, q)
    );
  };
  const clearExact = (p: Pt, q: Pt) => {
    const s = [dNum(p.x), dNum(p.y), dNum(q.x), dNum(q.y)];
    const r = beta + f64Margin(W + H + 20 + Math.max(...s.map(Math.abs)));
    for (const k of edgeGrid.query(
      Math.min(s[0]!, s[2]!) - r,
      Math.min(s[1]!, s[3]!) - r,
      Math.max(s[0]!, s[2]!) + r,
      Math.max(s[1]!, s[3]!) + r,
    )) {
      work += 1;
      const e = candidates[k]!;
      if (!segmentsApart(p, q, e.a, e.b)) return false;
    }
    return !insideExact({ x: dmul(dadd(p.x, q.x), half), y: dmul(dadd(p.y, q.y), half) });
  };
  const exactOffset = (e: ChainEdge, out: number, s0: number): number | null => {
    const ex = dNum(dsub(e.b.x, e.a.x));
    const ey = dNum(dsub(e.b.y, e.a.y));
    const length = Math.hypot(ex, ey);
    if (!(length > 0 && length < Infinity)) return null;
    const tx = ex / length;
    const ty = ey / length;
    const nx = out * ty;
    const ny = -out * tx;
    for (let s = s0; s <= FLIP_TOLERANT_RHO_MAX; s *= REFINED_SEARCH.factor)
      for (const angle of REFINED_SEARCH.angles) {
        const wx = s * (Math.cos(angle) * nx + Math.sin(angle) * tx);
        const wy = s * (Math.cos(angle) * ny + Math.sin(angle) * ty);
        const bound = a04NextUp(Math.hypot(wx, wy) * SLACK);
        // Seeded defect (E20-A3): D without the exact test.
        if (options.defect === 'no-exact-fallback') return bound;
        const shift = (q: Pt): Pt => ({ x: dadd(q.x, dy(wx)), y: dadd(q.y, dy(wy)) });
        if (clearExact(shift(e.a), shift(e.b))) {
          pieces += 1;
          return bound;
        }
        if (work > FLIP_TOLERANT_WORK_CAP) return null;
      }
    return null;
  };

  let dHi = 0;
  for (const e of candidates) {
    const b = box(e);
    if (!meets(b, 3)) continue;
    edges += 1;
    // 2. Boundary of M*: the open edge is covered by collinear edges of positive-area triangles
    // that all lie on one side of it, and no open triangle meets it.
    const { covered, side, across } = coverage(e.a, e.b);
    if (across) return no('triangle across a boundary edge');
    if (side === 2) return no('edge with triangles on both sides');
    if (side === 0 || !covered) return no('boundary edge off M*');
    if (work > FLIP_TOLERANT_WORK_CAP) return no('work cap');
    if (!meets(b, 2)) continue;

    // D: translates of pieces of the edge, outward, more than β from every candidate.
    const ax = xs[e.ia]!;
    const ay = ys[e.ia]!;
    const dx = xs[e.ib]! - ax;
    const dyy = ys[e.ib]! - ay;
    const length = Math.hypot(dx, dyy);
    // The triangles lie left of a → b when side > 0; outward is then the right normal.
    const out = side > 0 ? 1 : -1;
    const margin = f64Margin(W + H + 20 + Math.max(...b.map(Math.abs)));
    const s0 = beta * (1 + 2 ** -4) + 2 * margin;
    if (!(length > 0)) {
      if (!e20) return no('edge below binary64');
      const d = exactOffset(e, out, s0);
      if (d === null) return no(work > FLIP_TOLERANT_WORK_CAP ? 'work cap' : 'edge below binary64');
      exactEdges += 1;
      dHi = Math.max(dHi, d);
      continue;
    }
    const tx = dx / length;
    const ty = dyy / length;
    const nx = out * ty;
    const ny = -out * tx;
    const piece = (l0: number, l1: number, depth: number, search: OffsetSearch): number | null => {
      const p0x = ax + l0 * dx;
      const p0y = ay + l0 * dyy;
      const p1x = ax + l1 * dx;
      const p1y = ay + l1 * dyy;
      for (let s = s0; s <= FLIP_TOLERANT_RHO_MAX; s *= search.factor)
        for (const angle of search.angles) {
          const wx = s * (Math.cos(angle) * nx + Math.sin(angle) * tx);
          const wy = s * (Math.cos(angle) * ny + Math.sin(angle) * ty);
          if (clear([p0x + wx, p0y + wy, p1x + wx, p1y + wy])) {
            pieces += 1;
            return s + 2 * margin;
          }
          if (work > FLIP_TOLERANT_WORK_CAP) return null;
        }
      if (depth >= search.depth || (l1 - l0) * length < beta * search.minimum) return null;
      const mid = (l0 + l1) / 2;
      const left = piece(l0, mid, depth + 1, search);
      if (left === null) return null;
      const right = piece(mid, l1, depth + 1, search);
      return right === null ? null : Math.max(left, right);
    };
    let d = piece(0, 1, 0, OLD_SEARCH);
    // E20-K3: the refined search where the old one fails, or on every edge for a row that
    // straddles 0.25 px; the edge keeps the smaller D.
    if (e20 && (d === null || options.refineAll === true) && !(work > FLIP_TOLERANT_WORK_CAP)) {
      const refined = piece(0, 1, 0, REFINED_SEARCH);
      if (refined !== null && (d === null || refined < d)) {
        d = refined;
        refinedEdges += 1;
      }
    }
    if (d === null) return no(work > FLIP_TOLERANT_WORK_CAP ? 'work cap' : 'boundary offset');
    dHi = Math.max(dHi, d);
  }
  return result(a04NextUp(Math.max(beta, dHi) * SLACK), null);
}

/** The joint partner key (SB-10, SB-11): the other role of the same group, transform and camera. */
export function jointKey(kase: A04Case, role: string): string {
  const joint = kase.joint as Readonly<{ group: string }>;
  return JSON.stringify([
    joint.group,
    role,
    kase.transform,
    kase.camera,
    kase.placement,
    kase.servedOffset,
  ]);
}

/** Every joint case of the corpus by its own key, so a case finds its partner by the other role. */
export function jointPartners(cases: Iterable<A04Case> = iterateA04Corpus()): Map<string, A04Case> {
  const partners = new Map<string, A04Case>();
  for (const kase of cases) {
    const joint = kase.joint as Readonly<{ role: string }> | null;
    if (joint != null) partners.set(jointKey(kase, joint.role), kase);
  }
  return partners;
}

/** The partner of a joint case, or undefined for a case without one. */
export function partnerOf(
  kase: A04Case,
  partners: ReadonlyMap<string, A04Case>,
): A04Case | undefined {
  const joint = kase.joint as Readonly<{ role: string }> | null;
  return joint == null
    ? undefined
    : partners.get(jointKey(kase, joint.role === 'fill' ? 'stroke' : 'fill'));
}

// =============================================================================================
// The per-case measurement (contract sections 7.2 and 7.3)

const TARGET = A04_ORACLE_PARAMETERS.target;

export function caseMeta(
  kase: A04Case,
): Pick<HarnessRow, 'index' | 'id' | 'stratum' | 'transform' | 'pair' | 'paint' | 'gapTarget'> {
  const d = decodeCase(kase);
  const zoom = d.zoom === 0.01 ? '0.01' : String(d.zoom);
  const gap = kase.gap as Readonly<{ target?: unknown }> | null | undefined;
  return {
    index: typeof kase.index === 'number' ? kase.index : null,
    id: d.id,
    stratum: typeof kase.stratum === 'string' ? kase.stratum : null,
    transform: typeof kase.transform === 'string' ? kase.transform : null,
    pair: `z${zoom}-d${String(d.dpr)}`,
    paint: d.paint,
    gapTarget: typeof gap?.target === 'string' ? unhex(gap.target) : null,
  };
}

const EMPTY_ROW = {
  code: null,
  reason: null,
  drawn: null,
  eLo: null,
  eHi: null,
  betaC: null,
  betaVertex: null,
  betaClip: null,
  u: null,
  l: null,
  tJunctions: null,
  storageCracks: null,
  crackBound: null,
  guard: null,
  noFlip: null,
  flipTolerant: null,
  served: null,
  drawKind: null,
  notices: [] as readonly string[],
  jointIdentity: null,
  resolution: null,
  work: null,
} as const;

/** Section 7.3: PASS when U ≤ 0.25, FAIL when L > 0.25, UNDECIDED otherwise. */
export function caseStatus(u: number, l: number): 'pass' | 'fail' | 'undecided' {
  if (u <= TARGET) return 'pass';
  if (l > TARGET) return 'fail';
  return 'undecided';
}

/** Byte equality of two typed arrays (the joint feature-identity check). */
function sameBytes(a: ArrayBufferView | null | undefined, b: ArrayBufferView | null | undefined) {
  if (a == null || b == null) return a == b;
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return x.every((v, i) => v === y[i]);
}

/** Measures one case through the product path (sections 3.2 and 7). */
export function measureCase(
  kase: A04Case,
  ports: HarnessPorts,
  options: HarnessOptions = {},
): HarnessRow {
  const start = performance.now();
  const meta = caseMeta(kase);
  const d = decodeCase(kase);
  const done = (row: Partial<HarnessRow> & Pick<HarnessRow, 'status'>): HarnessRow => ({
    ...meta,
    ...EMPTY_ROW,
    ...row,
    ms: Math.round(performance.now() - start),
  });
  // Not drawable (section 6): det L = 0, or a stroke of width 0.
  const [a, c, b, dd] = d.transform;
  if (computePathBuckets([a, c, b, dd], d.zoom, d.dpr).singular)
    return done({ status: 'rejected', code: 'det L = 0' });
  if (d.stroke !== null && d.stroke.width === 0) return done({ status: 'rejected', code: 'w = 0' });

  const outcome = drawCase(kase, ports, {
    ...(options.partner === undefined ? {} : { partner: options.partner }),
  });
  if (outcome.kind === 'rejected')
    return done({ status: 'rejected', code: outcome.code, notices: outcome.notices });
  const mutations = options.mutations ?? {};
  const workCap = options.workCap ?? A04_ORACLE_PARAMETERS.measureWorkCap;
  const hooks = mutations.hooks ?? {};

  if (outcome.kind !== 'drawn') {
    // M = ∅ (an empty port result or a culled path): measured with β_c = 0 (E3-K2).
    const m = a04Measure(
      kase,
      { positions: [], indices: [] },
      { workCap, hooks, ...options.oracle },
    );
    const base = {
      drawn: outcome.kind,
      notices: outcome.notices,
      betaC: 0,
      resolution: m.resolution,
      work: m.work,
    };
    if (m.status === 'window-empty') return done({ ...base, status: 'window-empty' });
    if (m.e === null) return done({ ...base, status: 'undecided', reason: m.reason });
    const status = caseStatus(m.e.hi, m.e.lo);
    return done({
      ...base,
      status,
      reason: status === 'undecided' ? (m.reason ?? 'straddles 0.25 px') : null,
      eLo: m.e.lo,
      eHi: m.e.hi,
      u: m.e.hi,
      l: m.e.lo,
    });
  }

  const { draw, frame } = outcome;
  const served = { e: draw.toleranceExponent, k: d.servedOffset };
  const drawKind = draw.composite ?? (draw.fringe === null ? 'region-only' : 'fringe');
  let jointIdentity: boolean | null = null;
  if (options.partner !== undefined && kase.joint != null) {
    // E3-C9: the joint draw keeps each paint's features (V3 section e, ST-U7 amendment).
    const separate = drawCase(kase, ports, { partner: options.partner, opacity: 1 });
    jointIdentity =
      separate.kind === 'drawn' &&
      sameBytes(separate.draw.offsets, draw.offsets) &&
      sameBytes(separate.draw.fringe?.data.features, draw.fringe?.data.features) &&
      sameBytes(separate.draw.fringe?.data.corners, draw.fringe?.data.corners);
  }
  const lanes = shaderLanes(draw, frame, mutations);
  const points: MappedPoint[] = [];
  for (let i = 0; i < draw.offsets.length; i += 2)
    points.push(mapPoint(draw.offsets[i]!, draw.offsets[i + 1]!, lanes, mutations));
  const mapped: Mapped = {
    points,
    indices: draw.mesh.indices,
    width: frame.width,
    height: frame.height,
  };
  options.onMapped?.(mapped);
  let betaVertex = 0;
  for (const p of points) betaVertex = Math.max(betaVertex, p.betaVertex, p.betaFeature);
  const guard = guardBand(mapped);
  const betaC = a04NextUp((betaVertex + guard.betaClip) * SLACK);
  const flip = noFlip(mapped, betaC);
  const common = {
    drawn: 'mesh' as const,
    betaC,
    betaVertex,
    betaClip: guard.betaClip,
    guard: { outside: guard.outside, crossing: guard.crossing },
    noFlip: flip,
    served,
    drawKind,
    notices: outcome.notices,
    jointIdentity,
  };
  if (jointIdentity === false)
    return done({ ...common, status: 'undecided', reason: 'joint-feature-identity' });
  if (betaC >= 1) return done({ ...common, status: 'undecided', reason: 'beta ≥ 1 px' });
  if (guard.betaClip >= TARGET)
    return done({ ...common, status: 'undecided', reason: 'clip bound ≥ 0.25 px' });
  // Section 20: when the certificate fails, the flip-tolerant bound ρ takes β_c's place in U
  // and L. Clipped triangles are not covered by its argument.
  let rho = betaC;
  let flipTolerant: FlipTolerantResult | null = null;
  // E20: each remedy runs only behind the predicate that ended a row UNDECIDED on 2026-10-27,
  // so a row decided then never reaches it (E20 contract, section 2, gating).
  const remedies: E20Trace[] = [];
  const traced = () => (remedies.length === 0 ? {} : { e20: [...remedies] });
  const clippedIf = (r: FlipTolerantResult) => (guard.crossing > 0 ? { ...r, clipped: true } : r);
  if (flip.failed > 0) {
    if (guard.crossing === 0) flipTolerant = flipTolerantBound(mapped, betaC);
    if (flipTolerant?.rho != null) rho = flipTolerant.rho;
    else {
      // E20-K1 (clipped draws, M* unclipped), K2, K3 and K6. With ρ ≥ 0.25, U > 0.25 already,
      // so K3's refined search runs on every edge before the oracle.
      let remedy = clippedIf(flipTolerantBound(mapped, betaC, { e20: true }));
      if (remedy.rho !== null && remedy.rho >= TARGET) {
        const refined = clippedIf(flipTolerantBound(mapped, betaC, { e20: true, refineAll: true }));
        if (refined.rho !== null && refined.rho < remedy.rho) remedy = refined;
      }
      if (remedy.rho == null) {
        remedies.push({ rule: 'flip-tolerant', former: flipTolerant, attempt: remedy });
        return done({
          ...common,
          flipTolerant,
          ...traced(),
          status: 'undecided',
          reason: 'no-flip certificate',
        });
      }
      remedies.push({ rule: 'flip-tolerant', former: flipTolerant });
      flipTolerant = remedy;
      rho = remedy.rho;
    }
  }

  const beta = mutations.omitBeta ? 0 : rho;
  // The oracle models triangles of positive area only. A collapsed triangle (two vertices with
  // the same p*) has bit-identical GPU positions at those vertices and covers no sample
  // (section 15.4). Any other zero-area triangle lies off the certificate's region when the
  // certificate holds (section 21.4), or on M* under section 20.
  const mesh: A04Mesh = {
    positions: points.flatMap((p) => [dq(p.x), dq(p.y)]),
    indices: withPositiveArea(mapped),
  };
  const m = a04Measure(kase, mesh, {
    passBelow: a04NextDown(TARGET - beta),
    failAbove: a04NextUp(TARGET + beta),
    // β_c, not ρ: it only feeds the reported crack bound (2β_c per T-junction).
    betaC,
    portMesh: { positions: draw.mesh.positions, indices: draw.mesh.indices },
    workCap,
    hooks,
    ...options.oracle,
  });
  const measured = {
    ...common,
    flipTolerant,
    tJunctions: m.tJunctions + (m.storage?.tJunctions ?? 0),
    storageCracks: m.storage?.storageCracks ?? null,
    crackBound: m.crackBound,
    resolution: m.resolution,
    work: m.work,
  };
  if (m.status === 'window-empty') {
    // E3-K3 on M_gpu: ∂M* must also stay off Ω ⊕ 1, so that a β-move cannot bring it into Ω.
    if (boundaryMayMeetGuard(mapped)) {
      // E20-K4: a candidate more than β_c from Ω cannot be moved into it.
      const distance = boundaryDistanceFromWindow(mapped);
      remedies.push({ rule: 'window-empty-guard', distance });
      if (!(distance > betaC))
        return done({
          ...measured,
          ...traced(),
          status: 'undecided',
          reason: 'window-empty within the guard',
        });
    }
    return done({ ...measured, ...traced(), status: 'window-empty' });
  }
  if (m.e === null)
    return done({ ...measured, ...traced(), status: 'undecided', reason: m.reason });
  let u = a04NextUp(m.e.hi + beta);
  let l = Math.max(0, a04NextDown(m.e.lo - beta));
  let status = caseStatus(u, l);
  let rowFlip = flipTolerant;
  if (status === 'undecided' && flipTolerant !== null && !mutations.omitBeta) {
    // E20-K3: U > 0.25 ≥ L on the flip-tolerant bound. A smaller ρ from the refined search
    // tightens U and L from the same oracle interval (it covers Ω ⊕ 1 ⊇ Ω ⊕ ρ).
    const refined = clippedIf(flipTolerantBound(mapped, betaC, { e20: true, refineAll: true }));
    if (refined.rho !== null && refined.rho < rho) {
      remedies.push({ rule: 'refined-offset', former: flipTolerant });
      rowFlip = refined;
      u = a04NextUp(m.e.hi + refined.rho);
      l = Math.max(0, a04NextDown(m.e.lo - refined.rho));
      status = caseStatus(u, l);
    } else remedies.push({ rule: 'refined-offset', former: flipTolerant, attempt: refined });
  }
  return done({
    ...measured,
    flipTolerant: rowFlip,
    ...traced(),
    status,
    reason: status === 'undecided' ? (m.reason ?? 'straddles 0.25 px') : null,
    eLo: m.e.lo,
    eHi: m.e.hi,
    u,
    l,
    ...(status === 'fail' ? collapseOf(d, mapped) : {}),
  });
}

/**
 * E20-K7's row field: on a fill whose drawn mesh collapses entirely, the device bounding box of
 * the path's control points under the case's linear map, zoom and DPR. A cubic lies in the
 * convex hull of its control points, so the box contains R's; it is rounded up.
 */
export function collapseOf(d: Decoded, mapped: Mapped): Pick<HarnessRow, 'collapse'> {
  const triangles = mapped.indices.length / 3;
  if (d.paint !== 'fill' || triangles === 0 || withoutCollapsed(mapped).length > 0) return {};
  const [a, c, b, dd] = d.transform;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < d.points.length; i += 2) {
    const [x, y] = [d.points[i]!, d.points[i + 1]!];
    xs.push(a * x + b * y);
    ys.push(c * x + dd * y);
  }
  const scale = d.zoom * d.dpr;
  const extent = (v: number[]) =>
    a04NextUp((Math.max(...v) - Math.min(...v)) * scale * (1 + 2 ** -40) + 2 ** -60);
  return { collapse: { triangles, regionWidth: extent(xs), regionHeight: extent(ys) } };
}
