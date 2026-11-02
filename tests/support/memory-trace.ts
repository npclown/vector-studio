// PA-U4b (A09 memory method, docs/plans/pa-u4-a09-memory-method.md, sections 3.1 and 3.2): reads
// the V8 GC events of a memory-variant trace. `MinorGC` and `MajorGC` (complete events) carry
// `usedHeapSizeBefore` and `usedHeapSizeAfter`; `V8.GC_Heap_Stats` (an instant event after each
// GC) carries a JSON `stats` string with `isolate`, `total_heap_size`, `used_heap_size` and
// `external_memory`. A cloud probe on headless Chromium 153 showed each GC's stats event follows
// it on the same thread with `used_heap_size` equal to its `usedHeapSizeAfter`; the pairing below
// checks that equality and counts the GCs it could not pair.

export const MEMORY_TRACE_CATEGORIES = [
  'devtools.timeline',
  'v8',
  'disabled-by-default-v8.gc',
] as const;

type TraceEvent = {
  name?: string;
  ph?: string;
  pid?: number;
  tid?: number;
  ts?: number;
  args?: Record<string, unknown>;
};

export type GcSample = {
  kind: 'MinorGC' | 'MajorGC';
  ts: number;
  usedBefore: number;
  usedAfter: number;
  /** From the paired `V8.GC_Heap_Stats`; null when unpaired. */
  totalAfter: number | null;
  externalAfter: number | null;
};

export type MemoryTraceSummary = {
  /** The thread whose GCs are read: the one with the most GC events (the page's main thread). */
  thread: { pid: number; tid: number } | null;
  /** Other threads with GC events (workers, other pages); never summed in. */
  otherThreads: number;
  gcs: number;
  minor: number;
  major: number;
  unpaired: number;
  maxUsedBefore: number | null;
  maxTotalAfter: number | null;
  maxExternalAfter: number | null;
  /**
   * Contract 3.1 route 2 without its slack terms: the largest
   * `total_heap_size(k-1) + usedHeapSizeBefore(k) - usedHeapSizeAfter(k-1)` over paired
   * consecutive GCs. A candidate only: the page, buffer and large-object slack and the in-GC
   * bound are PA-U4c's to confirm.
   */
  route2WithoutSlack: number | null;
  samples: GcSample[];
};

const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function heapStats(event: TraceEvent): { used: number; total: number; external: number } | null {
  const raw = event.args?.stats;
  if (typeof raw !== 'string') return null;
  try {
    const stats = JSON.parse(raw) as Record<string, unknown>;
    const used = number(stats.used_heap_size);
    const total = number(stats.total_heap_size);
    const external = number(stats.external_memory);
    return used === null || total === null || external === null ? null : { used, total, external };
  } catch {
    return null;
  }
}

export function summarizeMemoryTrace(trace: unknown): MemoryTraceSummary {
  const events: TraceEvent[] = Array.isArray(trace)
    ? (trace as TraceEvent[])
    : ((trace as { traceEvents?: TraceEvent[] } | null)?.traceEvents ?? []);
  const byThread = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const relevant =
      ((event.name === 'MinorGC' || event.name === 'MajorGC') && event.ph === 'X') ||
      event.name === 'V8.GC_Heap_Stats';
    if (!relevant || event.pid === undefined || event.tid === undefined) continue;
    const key = `${event.pid}:${event.tid}`;
    const list = byThread.get(key) ?? [];
    list.push(event);
    byThread.set(key, list);
  }
  let chosen: { key: string; gcs: number } | null = null;
  for (const [key, list] of byThread) {
    const gcs = list.filter((event) => event.name !== 'V8.GC_Heap_Stats').length;
    if (gcs > 0 && (chosen === null || gcs > chosen.gcs)) chosen = { key, gcs };
  }
  const otherThreads =
    [...byThread.values()].filter((list) => list.some((event) => event.name !== 'V8.GC_Heap_Stats'))
      .length - (chosen === null ? 0 : 1);
  const empty: MemoryTraceSummary = {
    thread: null,
    otherThreads,
    gcs: 0,
    minor: 0,
    major: 0,
    unpaired: 0,
    maxUsedBefore: null,
    maxTotalAfter: null,
    maxExternalAfter: null,
    route2WithoutSlack: null,
    samples: [],
  };
  if (chosen === null) return empty;
  const list = [...byThread.get(chosen.key)!].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const samples: GcSample[] = [];
  let unpaired = 0;
  for (let index = 0; index < list.length; index += 1) {
    const event = list[index]!;
    if (event.name === 'V8.GC_Heap_Stats') continue;
    const usedBefore = number(event.args?.usedHeapSizeBefore);
    const usedAfter = number(event.args?.usedHeapSizeAfter);
    if (usedBefore === null || usedAfter === null) {
      unpaired += 1;
      continue;
    }
    // The stats event of this GC: the next stats event before the next GC, with equal used size.
    let stats: ReturnType<typeof heapStats> = null;
    for (let next = index + 1; next < list.length; next += 1) {
      const candidate = list[next]!;
      if (candidate.name !== 'V8.GC_Heap_Stats') break;
      const parsed = heapStats(candidate);
      if (parsed !== null && parsed.used === usedAfter) {
        stats = parsed;
        break;
      }
    }
    if (stats === null) unpaired += 1;
    samples.push({
      kind: event.name as GcSample['kind'],
      ts: event.ts ?? 0,
      usedBefore,
      usedAfter,
      totalAfter: stats?.total ?? null,
      externalAfter: stats?.external ?? null,
    });
  }
  const max = (values: (number | null)[]) => {
    const present = values.filter((value): value is number => value !== null);
    return present.length === 0 ? null : Math.max(...present);
  };
  const route2: (number | null)[] = samples.map((sample, index) => {
    const previous = samples[index - 1];
    if (previous === undefined || previous.totalAfter === null) return null;
    return previous.totalAfter + sample.usedBefore - previous.usedAfter;
  });
  const [pid, tid] = chosen.key.split(':').map(Number) as [number, number];
  return {
    thread: { pid, tid },
    otherThreads,
    gcs: samples.length,
    minor: samples.filter((sample) => sample.kind === 'MinorGC').length,
    major: samples.filter((sample) => sample.kind === 'MajorGC').length,
    unpaired,
    maxUsedBefore: max(samples.map((sample) => sample.usedBefore)),
    maxTotalAfter: max(samples.map((sample) => sample.totalAfter)),
    maxExternalAfter: max(samples.map((sample) => sample.externalAfter)),
    route2WithoutSlack: max(route2),
    samples,
  };
}

/** The per-run `memory` block: each category's value, its source and its status. */
export type MemoryCategory = {
  bytes: number | null;
  status: 'exact' | 'stated-bound' | 'candidate' | 'unverified';
  source: string;
  note?: string;
};

/** Contract 3.4: the glyph raster canvas never exceeds 1,024 x 1,024 x 4 bytes. */
export const GLYPH_RASTER_BOUND_BYTES = 1024 * 1024 * 4;
/** Contract 3.4, A09-Q2 (a): the configured texture plus two swap-chain copies. */
export const SWAP_CHAIN_TEXTURES = 3;

/** PA-A05's bound (pre-alpha plan, PA-Q2 (a)). */
export const MEMORY_BOUND_BYTES = 256_000_000;

export type HeapUsage = {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize?: number;
  backingStorageSize?: number;
};

export type MemoryLedgerReading = {
  gpu: { peakBytes: number; unknownFormats: string[]; querySets: number; externalTextures: number };
  canvas: { maxPixels: number; reads: number };
  wasm: { bytes: number };
  idb: { peakBytes: number; nonString: number };
};

export type MemoryBlock = {
  categories: Record<'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7', MemoryCategory>;
  /** The categories counted as exact (ledgers and stated bounds). */
  exactSumBytes: number;
  /** Every category with a value, exact or not: an observation, never a verdict. */
  observedSumBytes: number;
  verdict: 'PASS' | 'FAIL' | 'UNVERIFIED';
  unverified: string[];
};

/** Contract section 1: one run's categories, sums and verdict. */
export function memoryBlock(
  ledger: MemoryLedgerReading,
  trace: MemoryTraceSummary,
  end: HeapUsage,
): MemoryBlock {
  const largest = (...values: (number | null | undefined)[]) => {
    const present = values.filter((value): value is number => typeof value === 'number');
    return present.length === 0 ? null : Math.max(...present);
  };
  const gpuOpen =
    ledger.gpu.unknownFormats.length > 0 ||
    ledger.gpu.querySets > 0 ||
    ledger.gpu.externalTextures > 0;
  const categories: MemoryBlock['categories'] = {
    M1: {
      bytes: largest(
        trace.route2WithoutSlack,
        trace.maxTotalAfter,
        trace.maxUsedBefore,
        end.totalSize,
      ),
      status: 'candidate',
      source:
        'GC trace route 2 without slack, the largest total_heap_size after a GC and the end totalSize',
      note: 'exact only once PA-U4c confirms a peak counter or route 2 with its slack and in-GC bound',
    },
    M2: {
      bytes: largest(trace.maxExternalAfter, end.backingStorageSize),
      status: 'unverified',
      source: 'external_memory after each GC and the end backingStorageSize (sampled)',
      note: 'no exact route confirmed (contract 3.2)',
    },
    M3: { bytes: ledger.wasm.bytes, status: 'exact', source: 'WASM memory ledger' },
    M4: gpuOpen
      ? {
          bytes: ledger.gpu.peakBytes,
          status: 'unverified',
          source: 'GPU ledger',
          note: `unknown formats [${ledger.gpu.unknownFormats.join(', ')}], query sets ${ledger.gpu.querySets}, external textures ${ledger.gpu.externalTextures}`,
        }
      : {
          bytes: ledger.gpu.peakBytes,
          status: 'exact',
          source: 'GPU ledger (descriptor capacities)',
        },
    M5:
      ledger.canvas.reads === 0
        ? {
            bytes: null,
            status: 'unverified',
            source: 'getCurrentTexture ledger',
            note: 'no current texture was read',
          }
        : {
            bytes: ledger.canvas.maxPixels * 4 * SWAP_CHAIN_TEXTURES + GLYPH_RASTER_BOUND_BYTES,
            status: 'stated-bound',
            source: `largest current texture x 4 x ${SWAP_CHAIN_TEXTURES} (A09-Q2) + glyph raster 1024^2 x 4`,
          },
    M6:
      ledger.idb.nonString > 0
        ? {
            bytes: ledger.idb.peakBytes,
            status: 'unverified',
            source: 'IDB ledger',
            note: `${ledger.idb.nonString} non-string put values`,
          }
        : { bytes: ledger.idb.peakBytes, status: 'exact', source: 'IDB ledger' },
    M7: {
      bytes: end.embedderHeapUsedSize ?? null,
      status: 'unverified',
      source: 'end embedderHeapUsedSize (one reading)',
      note: 'no exact route confirmed (contract 3.6)',
    },
  };
  const entries = Object.entries(categories) as [keyof MemoryBlock['categories'], MemoryCategory][];
  const exact = entries.filter(
    ([, category]) => category.status === 'exact' || category.status === 'stated-bound',
  );
  const exactSumBytes = exact.reduce((sum, [, category]) => sum + (category.bytes ?? 0), 0);
  const observedSumBytes = entries.reduce((sum, [, category]) => sum + (category.bytes ?? 0), 0);
  const unverified = entries
    .filter(([, category]) => !exact.some(([, e]) => e === category))
    .map(([id]) => id);
  const verdict =
    exactSumBytes > MEMORY_BOUND_BYTES ? 'FAIL' : unverified.length > 0 ? 'UNVERIFIED' : 'PASS';
  return { categories, exactSumBytes, observedSumBytes, verdict, unverified };
}
