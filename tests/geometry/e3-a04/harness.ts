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
  /** Test-only: oracle options for controls that check a value (separate terms, resolution). */
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
  /** The served tolerance exponent e − k, and k. */
  served: Readonly<{ e: number; k: number }> | null;
  /** fringe, region-only or joint-fill. */
  drawKind: string | null;
  notices: readonly string[];
  /** The joint draw's feature-identity check (E3-C9), or null when not a joint case. */
  jointIdentity: boolean | null;
  resolution: number | null;
  work: number | null;
  ms: number;
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
    if (!(e.plus === 1 && e.minus === 1 && e.other === 0))
      candidates.push({ ia: e.ia, ib: e.ib, a: e.a, b: e.b });
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

function caseMeta(
  kase: A04Case,
): Pick<HarnessRow, 'index' | 'id' | 'stratum' | 'transform' | 'pair' | 'paint'> {
  const d = decodeCase(kase);
  const zoom = d.zoom === 0.01 ? '0.01' : String(d.zoom);
  return {
    index: typeof kase.index === 'number' ? kase.index : null,
    id: d.id,
    stratum: typeof kase.stratum === 'string' ? kase.stratum : null,
    transform: typeof kase.transform === 'string' ? kase.transform : null,
    pair: `z${zoom}-d${String(d.dpr)}`,
    paint: d.paint,
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
  if (flip.failed > 0)
    return done({ ...common, status: 'undecided', reason: 'no-flip certificate' });

  const beta = mutations.omitBeta ? 0 : betaC;
  // A collapsed triangle (two vertices with the same p*) has bit-identical GPU positions at
  // those vertices, so it has zero area on the GPU and covers no sample: M* leaves it out
  // (section 15.4), as the oracle's mesh model takes triangles of positive area only.
  const mesh: A04Mesh = {
    positions: points.flatMap((p) => [dq(p.x), dq(p.y)]),
    indices: withoutCollapsed(mapped),
  };
  const m = a04Measure(kase, mesh, {
    passBelow: a04NextDown(TARGET - beta),
    failAbove: a04NextUp(TARGET + beta),
    betaC,
    portMesh: { positions: draw.mesh.positions, indices: draw.mesh.indices },
    workCap,
    hooks,
    ...options.oracle,
  });
  const measured = {
    ...common,
    tJunctions: m.tJunctions + (m.storage?.tJunctions ?? 0),
    storageCracks: m.storage?.storageCracks ?? null,
    crackBound: m.crackBound,
    resolution: m.resolution,
    work: m.work,
  };
  if (m.status === 'window-empty') {
    // E3-K3 on M_gpu: ∂M* must also stay off Ω ⊕ 1, so that a β-move cannot bring it into Ω.
    if (boundaryMayMeetGuard(mapped))
      return done({ ...measured, status: 'undecided', reason: 'window-empty within the guard' });
    return done({ ...measured, status: 'window-empty' });
  }
  if (m.e === null) return done({ ...measured, status: 'undecided', reason: m.reason });
  const u = a04NextUp(m.e.hi + beta);
  const l = Math.max(0, a04NextDown(m.e.lo - beta));
  const status = caseStatus(u, l);
  return done({
    ...measured,
    status,
    reason: status === 'undecided' ? (m.reason ?? 'straddles 0.25 px') : null,
    eLo: m.e.lo,
    eHi: m.e.hi,
    u,
    l,
  });
}
