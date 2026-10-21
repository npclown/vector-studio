/**
 * P3 Alt-A1 AL-OB5 unit OB5-U2, scenario `p3-al-ob5-workload` v1
 * (`docs/plans/p3-al-ob5-workload-scenario-proposal.md` sections 3.2 and 3.3): the browser-safe
 * parts shared by the benchmark page and the Node analysis. The framed corpus decoder, the set
 * and edit orders, the per-path fold, and the page's options and capture types. The fold is
 * AL-S2's decoded fold (`Fnv1a64.result`, the Rust `fold_decoded` of `p3_al_ob5_bench.rs`),
 * imported unchanged.
 *
 * Erasable TypeScript; its runtime imports (the B0 corpus module and AL-S2's workload module)
 * import nothing at runtime themselves, so the page bundles it and the Node runner loads it.
 */
import type {
  FillMeshBatchResult,
  FillMeshRequest,
  FillMeshResult,
  ScenePathVerb,
} from '@vector-studio/contracts';
import { CORPUS_MAGIC } from '../../geometry/p3-b0/corpus.js';
import { Fnv1a64, shuffled } from '../p3-b0-wasm/workload.js';

export { Fnv1a64, shuffled };

/** Section 3.3: B0's set-order seed, 0x9e3779b9 + r for repetition r (0-based). */
export const ORDER_SEED = 0x9e37_79b9;
/** Section 3.3: the new edit-order seed, 0x0b5e0000 + r. */
export const EDIT_SEED = 0x0b5e_0000;
/** Section 3.3: the untimed one-path calls (paths 0-2) before the timed edits. */
export const EDIT_WARMUP_PATHS = [0, 1, 2] as const;
/** Section 2.1: nonzero at e = -3, request ID = path index. */
export const TOLERANCE_EXPONENT = -3;

export function setOrderSeed(repetition: number): number {
  return (ORDER_SEED + repetition) >>> 0;
}

export function editOrderSeed(repetition: number): number {
  return (EDIT_SEED + repetition) >>> 0;
}

/** The set order of repetition r, as the native `shuffled(&[0, 1, 2], seed)`. */
export function setOrder(ids: readonly string[], repetition: number): string[] {
  return shuffled(ids, setOrderSeed(repetition));
}

/** The edit order of repetition r over paths 0 .. count - 1. */
export function editOrder(count: number, repetition: number): number[] {
  return shuffled(
    Array.from({ length: count }, (_, index) => index),
    editOrderSeed(repetition),
  );
}

/** One decoded set: its port requests, built once outside timing, and its source paths. */
export interface Ob5Set {
  readonly id: string;
  readonly lambda: number;
  readonly requests: readonly FillMeshRequest[];
}

/** Decodes the framed corpus (`encodeCorpus`'s `P3B0COR1` frame) into every path as requests. */
export function decodeOb5Sets(bytes: Uint8Array): Ob5Set[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  const take = (length: number): Uint8Array => {
    if (offset + length > bytes.byteLength) throw new Error('truncated AL-OB5 corpus');
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  const u32 = (): number => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  if (decoder.decode(take(8)) !== CORPUS_MAGIC) throw new Error('AL-OB5 corpus magic');
  const setCount = u32();
  const sets: Ob5Set[] = [];
  for (let set = 0; set < setCount; set += 1) {
    const id = decoder.decode(take(u32()));
    take(1); // entry
    u32(); // contours
    u32(); // cubics per contour
    const lambda = u32();
    const pathCount = u32();
    const requests: FillMeshRequest[] = [];
    for (let index = 0; index < pathCount; index += 1) {
      const verbs = Uint8Array.from(take(u32()));
      const scalars = u32();
      const pointBytes = take(scalars * 8);
      const points = new Float64Array(scalars);
      const pointView = new DataView(pointBytes.buffer, pointBytes.byteOffset, pointBytes.length);
      for (let scalar = 0; scalar < scalars; scalar += 1)
        points[scalar] = pointView.getFloat64(scalar * 8, true);
      requests.push({
        requestId: index,
        verbs,
        points,
        fillRule: 'nonzero',
        toleranceExponent: TOLERANCE_EXPONENT,
      });
    }
    sets.push({ id, lambda, requests });
  }
  if (offset !== bytes.byteLength) throw new Error('trailing AL-OB5 corpus bytes');
  return sets;
}

const VERB_NAMES: readonly ScenePathVerb[] = ['move', 'line', 'cubic', 'close'];

/** The scene verbs of a request, for the renderer observation's path nodes. */
export function sceneVerbs(verbs: Uint8Array): ScenePathVerb[] {
  return Array.from(verbs, (code) => {
    const name = VERB_NAMES[code];
    if (name === undefined) throw new Error(`unknown verb ${code}`);
    return name;
  });
}

/** The status of one port result: `ok`, `empty` or the failure code. */
export function resultStatus(item: FillMeshResult): string {
  return item.status === 'failed' ? item.code : item.status;
}

/** One path's fold from the FNV offset, as the native `fold_path(output, j, FNV_OFFSET)`. */
export function pathFold(item: FillMeshResult): string {
  const fold = new Fnv1a64();
  fold.result({ status: 'ok', results: [item] });
  return fold.hex();
}

/** The per-path statuses of a batch result, or one `batch-failed:<code>` entry. */
export function batchStatuses(result: FillMeshBatchResult): string[] {
  if (result.status !== 'ok') return [`batch-failed:${result.code}`];
  return result.results.map(resultStatus);
}

// ------------------------------------------------------------------------------------------
// The page's options and capture, written per browser repetition by the Playwright spec.

export interface Ob5PageOptions {
  readonly profile: 'functional' | 'reference';
  /** 0-based, as the native leg's `P3_B0_REPETITION`. */
  readonly repetition: number;
  readonly expectedWasmSha256: string;
  readonly expectedCorpusSha256: string;
  readonly initWarmup: number;
  readonly initTimed: number;
  readonly editPaths: number;
  readonly renderer: {
    readonly camera: {
      readonly position: { readonly x: number; readonly y: number };
      readonly zoom: number;
    };
    readonly target: {
      readonly width: number;
      readonly height: number;
      readonly devicePixelRatio: number;
    };
  };
}

/** The fill instance's storage, read outside timing (read-only exports). */
export interface StorageObservation {
  readonly epoch: number;
  readonly inputCapacity: number;
  readonly outputCapacity: number;
  readonly memoryBytes: number;
}

/** One timed (or untimed) `buildFillMeshes` call on a set's 1,000 requests and its fold. */
export interface Ob5Sample {
  readonly startMs: number;
  readonly endMs: number;
  readonly checksum: string;
  /** Epoch advance across the call; exactly 1 when no reserve or retry ran. */
  readonly epochDelta: number;
  /** Arena capacities and linear memory size unchanged across the call. */
  readonly storageStable: boolean;
  readonly batchFailures: number;
}

/** The timed one-path calls of OB5-SP-edit, in `order`; parallel arrays. */
export interface Ob5Edits {
  readonly order: readonly number[];
  readonly startMs: readonly number[];
  readonly endMs: readonly number[];
  readonly checksums: readonly string[];
  readonly epochDeltas: readonly number[];
  readonly storageStable: readonly boolean[];
  /** Per edit, its status (`ok`, a failure code or `batch-failed:<code>`). */
  readonly statuses: readonly string[];
  /** The edit folds chained in `order`, folded outside the windows. */
  readonly chain: string;
}

/** OB5-SR, report-only: `PathMeshPipeline.prepare` on the set's 1,000 path nodes. */
export interface Ob5Renderer {
  readonly startMs: number;
  readonly endMs: number;
  readonly draws: number;
  readonly regionOnly: number;
  readonly fringed: number;
  readonly toleranceExponents: readonly number[];
  readonly builderCalls: number;
  readonly builderMs: number;
  readonly notices: Readonly<Record<string, number>>;
  readonly portCalls: number;
  readonly epochDelta: number;
  readonly storageStable: boolean;
}

export interface Ob5SetCapture {
  readonly set: string;
  readonly paths: number;
  /** Untimed; the adapter's arenas are provisioned here. */
  readonly preparation: Ob5Sample;
  /** Per path, from the preparation call. */
  readonly statuses: readonly string[];
  readonly vertices: readonly number[];
  readonly triangles: readonly number[];
  readonly boundaryPairs: readonly number[];
  readonly pathChecksums: readonly string[];
  readonly warmup: readonly Ob5Sample[];
  readonly timed: readonly Ob5Sample[];
  readonly editWarmup: { readonly paths: readonly number[]; readonly checksums: readonly string[] };
  readonly edits: Ob5Edits;
  /** OB5-SP-cold: the first call of a fresh adapter (reserve and growth inside the window). */
  readonly cold: Ob5Sample;
  readonly renderer: Ob5Renderer | null;
}

export interface Ob5Capture {
  readonly schema: 'p3-al-ob5-capture/v1';
  readonly options: Ob5PageOptions;
  readonly wasmSha256: string;
  readonly corpusSha256: string;
  readonly adapter: { readonly operationId: string; readonly portVersion: number } | null;
  readonly crossOriginIsolated: boolean;
  readonly clockProbe: {
    readonly attempts: number;
    readonly durationMs: number;
    readonly positiveIncrementsMs: readonly number[];
    readonly minimumQuantumMs: number | null;
  };
  readonly setup: {
    readonly fetchMs: number;
    readonly compileMs: number;
    readonly decodeMs: number;
  };
  readonly order: readonly string[];
  readonly sets: readonly Ob5SetCapture[];
  /** `linearMemoryBytes()` after the run (section 3.4 memory observation). */
  readonly linearMemoryBytes: number | null;
  readonly environment: {
    readonly visibilityStart: string;
    readonly visibilityEnd: string;
    readonly visibilityEvents: readonly { readonly atMs: number; readonly state: string }[];
    readonly viewport: {
      readonly width: number;
      readonly height: number;
      readonly devicePixelRatio: number;
    };
    readonly screen: { readonly width: number; readonly height: number };
    readonly navigator: {
      readonly userAgent: string;
      readonly platform: string;
      readonly hardwareConcurrency: number | null;
    };
  };
  readonly errors: readonly string[];
}
