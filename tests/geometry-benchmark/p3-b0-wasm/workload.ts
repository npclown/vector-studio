/**
 * P3 Alt-A1 AL-U6, scenario AL-S2 `p3-b0-wasm` v1
 * (`docs/plans/p3-alt-a1-fill-ladder-contract.md` section 5.2): the browser-safe parts shared
 * by the benchmark page and the Node analysis. The B0 corpus decoder, B0's per-repetition
 * shuffle, and the decoded checksum fold of the ratio mode (`ratioModeConfig().fold`, the Rust
 * `fold_decoded` in `p3_fill_ladder_bench.rs`).
 *
 * Erasable TypeScript with no runtime import except the B0 corpus module (which has none), so
 * that the page bundles it and the Node runner loads it directly.
 */
import { CORPUS_MAGIC, Xorshift32 } from '../../geometry/p3-b0/corpus.js';
import type { FillMeshBatchResult, FillMeshRequest } from '@vector-studio/contracts';

/** B0 section 3: xorshift32 seeded with 0x9e3779b9 + r for repetition r (0-based). */
export const ORDER_SEED = 0x9e37_79b9;
export const DECISION_PATHS = 10;
/** Section 5.2: the requests are built from the corpus as nonzero at e = -3. */
export const TOLERANCE_EXPONENT = -3;

/** One decision cell of the B0 corpus as port requests, built once outside timing. */
export interface WasmCell {
  readonly id: string;
  readonly requests: readonly FillMeshRequest[];
}

/** B0's Fisher-Yates from the last index down, j = floor(u (i + 1)), as `p3_b0_bench::shuffled`. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const output = [...items];
  const random = new Xorshift32(seed >>> 0);
  for (let index = output.length - 1; index >= 1; index -= 1) {
    const pick = Math.floor(random.next() * (index + 1));
    const value = output[index]!;
    output[index] = output[pick]!;
    output[pick] = value;
  }
  return output;
}

/** The order seed of repetition r, as Rust's `ORDER_SEED.wrapping_add(r)`. */
export function orderSeed(repetition: number): number {
  return (ORDER_SEED + repetition) >>> 0;
}

/** True for the 34 decision cells (`Cell::is_decision`): not O1 and not X. */
export function isDecisionCell(id: string): boolean {
  return !id.startsWith('O1/') && !id.startsWith('X/');
}

/**
 * Decodes the framed B0 corpus (`encodeCorpus`, `p3_b0_bench::read_corpus`) into the decision
 * cells' first ten paths as port requests: request id = the path's index, nonzero, e = -3.
 */
export function decodeDecisionCells(bytes: Uint8Array): WasmCell[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  const take = (length: number): Uint8Array => {
    if (offset + length > bytes.byteLength) throw new Error('truncated B0 corpus');
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  const u32 = (): number => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  if (decoder.decode(take(8)) !== CORPUS_MAGIC) throw new Error('B0 corpus magic');
  const cellCount = u32();
  const cells: WasmCell[] = [];
  for (let cell = 0; cell < cellCount; cell += 1) {
    const id = decoder.decode(take(u32()));
    take(1); // entry
    u32(); // contours
    u32(); // cubics per contour
    u32(); // lambda
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
      if (index < DECISION_PATHS)
        requests.push({
          requestId: index,
          verbs,
          points,
          fillRule: 'nonzero',
          toleranceExponent: TOLERANCE_EXPONENT,
        });
    }
    if (isDecisionCell(id)) {
      if (requests.length !== DECISION_PATHS) throw new Error(`${id} has fewer than 10 paths`);
      cells.push({ id, requests });
    }
  }
  if (offset !== bytes.byteLength) throw new Error('trailing B0 corpus bytes');
  return cells;
}

/** The fill-v0 path status codes (V2 section g) that the native fold writes. */
const STATUS_CODE: Readonly<Record<string, number>> = Object.freeze({
  ok: 0,
  empty: 1,
  'invalid-path': 2,
  'invalid-tolerance': 3,
  'numeric-range': 4,
  'work-limit': 5,
  'unsupported-geometry': 6,
});
/** Folded for a batch-failed call; no path status has this value, so it never matches native. */
export const BATCH_FAILED_WORD = 0xffff_ffff;

/**
 * FNV-1a 64 over bytes, on two u32 halves so that a fold allocates nothing. The prime is
 * 2^40 + 0x1b3: the low word becomes (lo · 0x1b3) mod 2^32, the high word
 * (hi · 0x1b3 + carry + (lo << 8)) mod 2^32. Every intermediate is an integer below 2^53.
 */
export class Fnv1a64 {
  private hi = 0xcbf2_9ce4;
  private lo = 0x8422_2325;

  reset(): void {
    this.hi = 0xcbf2_9ce4;
    this.lo = 0x8422_2325;
  }

  bytes(bytes: Uint8Array): void {
    let hi = this.hi;
    let lo = this.lo;
    for (let index = 0; index < bytes.length; index += 1) {
      lo = (lo ^ bytes[index]!) >>> 0;
      const low = lo * 0x1b3;
      hi = (hi * 0x1b3 + Math.floor(low / 4_294_967_296) + ((lo << 8) >>> 0)) >>> 0;
      lo = low >>> 0;
    }
    this.hi = hi;
    this.lo = lo;
  }

  u32(value: number): void {
    let hi = this.hi;
    let lo = this.lo;
    for (let shift = 0; shift < 32; shift += 8) {
      lo = (lo ^ ((value >>> shift) & 0xff)) >>> 0;
      const low = lo * 0x1b3;
      hi = (hi * 0x1b3 + Math.floor(low / 4_294_967_296) + ((lo << 8) >>> 0)) >>> 0;
      lo = low >>> 0;
    }
    this.hi = hi;
    this.lo = lo;
  }

  /**
   * The decoded fold of one port result, as `fold_decoded`: per path in request order the
   * status as u32 LE; on `ok` also V, T and the boundary pair count, then the position f64
   * bits, the indices and the boundary pairs, little-endian (the host is little-endian, which
   * the adapter checks). A batch failure folds `BATCH_FAILED_WORD` and returns false.
   */
  result(result: FillMeshBatchResult): boolean {
    if (result.status !== 'ok') {
      this.u32(BATCH_FAILED_WORD);
      return false;
    }
    for (const item of result.results) {
      const code = item.status === 'failed' ? STATUS_CODE[item.code] : STATUS_CODE[item.status];
      this.u32(code ?? BATCH_FAILED_WORD);
      if (item.status !== 'ok') continue;
      const { positions, indices, boundaryEdges } = item.mesh;
      this.u32(positions.length / 2);
      this.u32(indices.length / 3);
      this.u32(boundaryEdges.length / 2);
      this.bytes(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
      this.bytes(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength));
      this.bytes(
        new Uint8Array(boundaryEdges.buffer, boundaryEdges.byteOffset, boundaryEdges.byteLength),
      );
    }
    return true;
  }

  /** Lowercase 16-digit hex, as the native `Json::hexes`. */
  hex(): string {
    return this.hi.toString(16).padStart(8, '0') + this.lo.toString(16).padStart(8, '0');
  }
}

// ------------------------------------------------------------------------------------------
// The page's options and capture, written per browser repetition by the Playwright spec.

/** What the spec passes to the page, from the runner's pinned configuration. */
export interface WasmPageOptions {
  readonly profile: 'functional' | 'reference';
  /** 0-based, as the native leg's `P3_B0_REPETITION`. */
  readonly repetition: number;
  readonly expectedWasmSha256: string;
  readonly expectedCorpusSha256: string;
  readonly warmup: number;
  readonly timed: number;
  readonly calls: number;
  readonly onePathCalls: number;
  readonly onePathCells: readonly string[];
}

/** The fill instance's storage, read outside timing (read-only exports). */
export interface StorageObservation {
  readonly epoch: number;
  readonly inputCapacity: number;
  readonly outputCapacity: number;
  readonly memoryBytes: number;
}

/** One sample of `calls` consecutive `buildFillMeshes` calls. */
export interface WasmSample {
  readonly ms: number;
  readonly checksum: string;
  /** Epoch advance during the sample; exactly `calls` when no reserve or retry ran. */
  readonly epochDelta: number;
  /** Arena capacities and linear memory size unchanged across the sample. */
  readonly storageStable: boolean;
  /** Calls whose batch failed (folded as `BATCH_FAILED_WORD`). */
  readonly batchFailures: number;
}

export interface WasmCellCapture {
  readonly cell: string;
  readonly calls: number;
  readonly paths: number;
  /** Untimed; the adapter's arenas are provisioned here. */
  readonly preparation: WasmSample;
  /** Statuses of the preparation sample's last call, in request order. */
  readonly statuses: readonly string[];
  readonly warmup: readonly WasmSample[];
  readonly timed: readonly WasmSample[];
}

export interface WasmCapture {
  readonly schema: 'p3-b0-wasm-capture/v1';
  readonly options: WasmPageOptions;
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
  readonly onePathOrder: readonly string[];
  readonly cells: readonly WasmCellCapture[];
  readonly onePath: readonly WasmCellCapture[];
  /** `linearMemoryBytes()` after the run (section 5.2 memory observation). */
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
