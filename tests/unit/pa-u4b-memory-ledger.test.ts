import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  MEMORY_TEXEL_BYTES,
  installMemoryLedger,
  type MemoryLedgerScope,
} from '../support/memory-ledger.js';
import {
  GLYPH_RASTER_BOUND_BYTES,
  MEMORY_BOUND_BYTES,
  memoryBlock,
  summarizeMemoryTrace,
  type MemoryLedgerReading,
} from '../support/memory-trace.js';

// PA-U4b, criterion A09-A02 of docs/plans/pa-u4-a09-memory-method.md: the ledgers' arithmetic
// (every texture format, mips, samples, destroy and double destroy, query sets and external
// textures, the canvas maximum, the WASM sum over both `instantiate` shapes, IDB complete, error,
// abort and non-string), the GC trace pairing and the per-run verdict.

class FakeResource {
  destroyed = 0;
  destroy() {
    this.destroyed += 1;
  }
}

class FakeTransaction extends EventTarget {}

function fakeScope() {
  class Memory {
    buffer: { byteLength: number };
    constructor(pages: number) {
      this.buffer = { byteLength: pages * 65536 };
    }
  }
  class Instance {
    exports: Record<string, unknown>;
    constructor(_module: unknown, imports?: { env?: { memory?: Memory } }) {
      this.exports = { memory: imports?.env?.memory ?? new Memory(2), run: () => 0 };
    }
  }
  const WebAssembly: Record<string, unknown> = {
    Memory,
    Instance,
    instantiate: (source: unknown, imports?: object) => {
      if (source === 'bad') return Promise.reject(new TypeError('bad source'));
      const instance = new Instance(source, imports);
      // Bytes resolve to {instance, module}; a module to the Instance itself.
      return Promise.resolve(source === 'module' ? instance : { instance, module: {} });
    },
  };
  const stores: { transaction: FakeTransaction }[] = [];
  const scope = {
    GPUDevice: {
      prototype: {
        createBuffer: () => new FakeResource(),
        createTexture: () => new FakeResource(),
        createQuerySet: () => ({}),
        importExternalTexture: () => ({}),
      },
    },
    GPUCanvasContext: {
      prototype: {
        size: [800, 600],
        getCurrentTexture(this: { size: number[] }) {
          return { width: this.size[0], height: this.size[1] };
        },
      },
    },
    IDBObjectStore: { prototype: { put: () => ({}) } },
    WebAssembly,
  } as unknown as MemoryLedgerScope & Record<string, unknown>;
  installMemoryLedger(scope);
  const ledger = scope.__vsMemory!;
  const device = scope.GPUDevice!.prototype as Record<string, (...args: unknown[]) => unknown>;
  const store = (transaction: FakeTransaction) => {
    const object = { transaction };
    stores.push(object);
    return (value: unknown) =>
      (scope.IDBObjectStore!.prototype.put as (v: unknown) => unknown).call(object, value);
  };
  return { scope, ledger, device, store };
}

describe('PA-U4b GPU ledger (contract 3.3)', () => {
  it('counts buffers and textures of every known format, mips and samples', () => {
    const { ledger, device } = fakeScope();
    device.createBuffer!({ size: 1000 });
    expect(ledger.snapshot().gpu.liveBytes).toBe(1000);
    for (const [format, bytes] of Object.entries(MEMORY_TEXEL_BYTES)) {
      const before = ledger.snapshot().gpu.liveBytes;
      device.createTexture!({ size: [10, 4], format });
      expect(ledger.snapshot().gpu.liveBytes - before, format).toBe(10 * 4 * bytes);
    }
    const before = ledger.snapshot().gpu.liveBytes;
    // 3 mips of 8x8 (64 + 16 + 4 texels), 2 layers, 4 samples, 8 bytes per texel.
    device.createTexture!({
      size: { width: 8, height: 8, depthOrArrayLayers: 2 },
      format: 'rgba16float',
      mipLevelCount: 3,
      sampleCount: 4,
    });
    expect(ledger.snapshot().gpu.liveBytes - before).toBe((64 + 16 + 4) * 2 * 4 * 8);
    // A 3d texture halves its depth per mip as well: 4x4x4 + 2x2x2 texels.
    const volume = ledger.snapshot().gpu.liveBytes;
    device.createTexture!({
      size: [4, 4, 4],
      format: 'r8unorm',
      dimension: '3d',
      mipLevelCount: 2,
    });
    expect(ledger.snapshot().gpu.liveBytes - volume).toBe(64 + 8);
    // A 1d texture has height 1 whatever its size says.
    const line = ledger.snapshot().gpu.liveBytes;
    device.createTexture!({ size: [16, 9], format: 'rgba8unorm', dimension: '1d' });
    expect(ledger.snapshot().gpu.liveBytes - line).toBe(16 * 4);
    // An odd size rounds down per mip, never below 1.
    const odd = ledger.snapshot().gpu.liveBytes;
    device.createTexture!({ size: [5, 1], format: 'r8unorm', mipLevelCount: 3 });
    expect(ledger.snapshot().gpu.liveBytes - odd).toBe(5 + 2 + 1);
    expect(ledger.snapshot().gpu.unknownFormats).toEqual([]);
  });

  it('subtracts once on destroy and keeps the peak', () => {
    const { ledger, device } = fakeScope();
    const a = device.createBuffer!({ size: 300 }) as FakeResource;
    const b = device.createTexture!({ size: [10, 10], format: 'bgra8unorm' }) as FakeResource;
    expect(ledger.snapshot().gpu.peakBytes).toBe(700);
    a.destroy();
    a.destroy();
    expect(a.destroyed, 'the real destroy still runs each time').toBe(2);
    expect(ledger.snapshot().gpu.liveBytes).toBe(400);
    b.destroy();
    const gpu = ledger.snapshot().gpu;
    expect(gpu.liveBytes).toBe(0);
    expect(gpu.peakBytes).toBe(700);
    expect(gpu.destroyed).toBe(2);
  });

  it('names unknown formats, query sets and external textures', () => {
    const { ledger, device } = fakeScope();
    device.createTexture!({ size: [4, 4], format: 'depth24plus' });
    device.createTexture!({ size: [4, 4], format: 'depth24plus' });
    device.createQuerySet!({ type: 'timestamp', count: 2 });
    device.importExternalTexture!({});
    const gpu = ledger.snapshot().gpu;
    expect(gpu.unknownFormats).toEqual(['depth24plus']);
    expect(gpu.querySets).toBe(1);
    expect(gpu.externalTextures).toBe(1);
    expect(gpu.liveBytes).toBe(0);
  });
});

describe('PA-U4b canvas, WASM and IDB ledgers (contract 3.4, 3.5)', () => {
  it('keeps the largest current texture', () => {
    const { ledger, scope } = fakeScope();
    const context = Object.create(scope.GPUCanvasContext!.prototype) as {
      size: number[];
      getCurrentTexture(): unknown;
    };
    context.size = [800, 600];
    context.getCurrentTexture();
    context.size = [1600, 1200];
    context.getCurrentTexture();
    context.size = [400, 300];
    context.getCurrentTexture();
    expect(ledger.snapshot().canvas).toEqual({
      maxPixels: 1600 * 1200,
      maxWidth: 1600,
      maxHeight: 1200,
      reads: 3,
    });
  });

  it('sums every memory over both instantiate shapes, the Instance and Memory constructors', async () => {
    const { ledger, scope } = fakeScope();
    const wa = scope.WebAssembly as Record<string, unknown>;
    const instantiate = wa.instantiate as (source: unknown, imports?: object) => Promise<unknown>;
    const fromBytes = (await instantiate('bytes', {})) as { instance: object };
    expect(fromBytes.instance).toBeDefined();
    await instantiate('module', {});
    const imported = new (wa.Memory as new (pages: number) => { buffer: { byteLength: number } })(
      5,
    );
    await instantiate('bytes', { env: { memory: imported } });
    new (wa.Instance as new (...args: unknown[]) => object)('module');
    // Two pages each for the three instance-owned memories, five for the imported one.
    expect(ledger.snapshot().wasm).toEqual({
      memories: 4,
      bytes: (2 * 3 + 5) * 65536,
      instances: 4,
    });
    // The wrapped constructors keep `instanceof`, and an Instance can import its memory.
    expect(imported instanceof (wa.Memory as abstract new () => unknown)).toBe(true);
    const shared = new (wa.Memory as new (pages: number) => { buffer: { byteLength: number } })(1);
    const constructed = new (wa.Instance as new (...args: unknown[]) => object)('module', {
      env: { memory: shared },
    });
    expect(constructed instanceof (wa.Instance as abstract new () => unknown)).toBe(true);
    expect(ledger.snapshot().wasm.memories).toBe(5);
    expect(ledger.snapshot().wasm.bytes).toBe((2 * 3 + 5 + 1) * 65536);
    // A rejected instantiate still rejects.
    await expect(instantiate('bad')).rejects.toThrow('bad source');
    // Memory only grows: a later growth is read at the snapshot.
    imported.buffer.byteLength = 7 * 65536;
    expect(ledger.snapshot().wasm.bytes).toBe((2 * 3 + 7 + 1) * 65536);
  });

  it('holds pending string puts until complete or abort, not a request error', () => {
    const { ledger, store } = fakeScope();
    for (const type of ['complete', 'abort']) {
      const transaction = new FakeTransaction();
      const put = store(transaction);
      put('abcd');
      put('ef');
      expect(ledger.snapshot().idb.liveBytes, type).toBe(12);
      // A request error bubbles to the transaction, which may go on: the bytes stay pending.
      transaction.dispatchEvent(new Event('error'));
      expect(ledger.snapshot().idb.liveBytes, type).toBe(12);
      transaction.dispatchEvent(new Event(type));
      transaction.dispatchEvent(new Event(type));
      expect(ledger.snapshot().idb.liveBytes, type).toBe(0);
    }
    const idb = ledger.snapshot().idb;
    expect(idb.peakBytes).toBe(12);
    expect(idb.puts).toBe(4);
    expect(idb.nonString).toBe(0);
    store(new FakeTransaction())({ text: 'x' });
    expect(ledger.snapshot().idb.nonString).toBe(1);
  });

  it('settles interleaved transactions separately', () => {
    const { ledger, store } = fakeScope();
    const first = new FakeTransaction();
    const second = new FakeTransaction();
    store(first)('aa');
    store(second)('bbbb');
    store(first)('c');
    expect(ledger.snapshot().idb.liveBytes).toBe(14);
    second.dispatchEvent(new Event('complete'));
    expect(ledger.snapshot().idb.liveBytes).toBe(6);
    first.dispatchEvent(new Event('abort'));
    expect(ledger.snapshot().idb).toMatchObject({ liveBytes: 0, peakBytes: 14 });
  });

  it('runs from its own source text, as the init script does', () => {
    // Playwright serializes the function: it must not need anything outside its body.
    // A copy, so the ledger patches it and not this worker's own WebAssembly. Vitest's
    // transform is not Playwright's: this guards the source text, it does not prove Playwright's.
    const wasm = {
      Memory: WebAssembly.Memory,
      Instance: WebAssembly.Instance,
      instantiate: WebAssembly.instantiate,
      instantiateStreaming: WebAssembly.instantiateStreaming,
    };
    const context: Record<string, unknown> = {
      WebAssembly: wasm,
      Promise,
      Proxy,
      Reflect,
      Set,
      WeakMap,
    };
    runInNewContext(`(${installMemoryLedger.toString()})(undefined)`, context);
    const ledger = context.__vsMemory as { snapshot(): { wasm: { memories: number } } };
    expect(ledger.snapshot().wasm.memories).toBe(0);
    const memory = new wasm.Memory({ initial: 1 });
    expect(WebAssembly.Memory, 'the real WebAssembly is untouched').not.toBe(wasm.Memory);
    expect(memory instanceof WebAssembly.Memory).toBe(true);
    expect(ledger.snapshot().wasm.memories).toBe(1);
  });

  it('installs once', () => {
    const { scope, ledger } = fakeScope();
    installMemoryLedger(scope);
    expect(scope.__vsMemory).toBe(ledger);
  });
});

const stats = (used: number, total: number, external: number) =>
  JSON.stringify({
    isolate: '0x1',
    used_heap_size: used,
    total_heap_size: total,
    external_memory: external,
  });

describe('PA-U4b GC trace (contract 3.1, 3.2)', () => {
  const gc = (name: string, ts: number, before: number, after: number, tid = 1) => ({
    name,
    ph: 'X',
    pid: 7,
    tid,
    ts,
    args: { usedHeapSizeBefore: before, usedHeapSizeAfter: after },
  });
  const heap = (ts: number, used: number, total: number, external: number, tid = 1) => ({
    name: 'V8.GC_Heap_Stats',
    ph: 'I',
    pid: 7,
    tid,
    ts,
    args: { stats: stats(used, total, external) },
  });

  it('pairs each GC with its stats and computes route 2 without slack', () => {
    const summary = summarizeMemoryTrace({
      traceEvents: [
        gc('MinorGC', 10, 300, 100),
        heap(11, 100, 1000, 50),
        gc('MajorGC', 20, 900, 400),
        heap(21, 400, 1200, 70),
        gc('MinorGC', 30, 700, 500),
        // An unrelated GC on another thread is never summed in.
        gc('MinorGC', 15, 99_999, 1, 2),
      ],
    });
    expect(summary.thread).toEqual({ pid: 7, tid: 1 });
    expect(summary.otherThreads).toBe(1);
    expect([summary.gcs, summary.minor, summary.major, summary.unpaired]).toEqual([3, 2, 1, 1]);
    expect(summary.maxUsedBefore).toBe(900);
    expect(summary.maxTotalAfter).toBe(1200);
    expect(summary.maxExternalAfter).toBe(70);
    // GC 2: 1000 + 900 - 100 = 1800; GC 3: 1200 + 700 - 400 = 1500.
    expect(summary.route2WithoutSlack).toBe(1800);
  });

  it('reads the renderer main thread and never pairs GCs across a gap', () => {
    const summary = summarizeMemoryTrace([
      { name: 'thread_name', ph: 'M', pid: 7, tid: 3, args: { name: 'CrRendererMain' } },
      // A busier thread that is not the page's main thread.
      gc('MinorGC', 1, 10, 5, 9),
      gc('MinorGC', 2, 10, 5, 9),
      gc('MinorGC', 3, 10, 5, 9),
      gc('MinorGC', 10, 300, 100, 3),
      heap(11, 100, 1000, 0, 3),
      { name: 'MajorGC', ph: 'X', pid: 7, tid: 3, ts: 20, args: {} },
      gc('MinorGC', 30, 700, 500, 3),
      heap(31, 500, 900, 0, 3),
      gc('MinorGC', 40, 800, 600, 3),
    ]);
    expect(summary.thread).toEqual({ pid: 7, tid: 3 });
    expect(summary.otherThreads).toBe(1);
    // Only GC 40 follows a sized GC: 900 + 800 - 500.
    expect(summary.route2WithoutSlack).toBe(1200);
  });

  it('pairs a stats event with a slightly larger used size and counts the difference', () => {
    const summary = summarizeMemoryTrace([gc('MinorGC', 1, 10, 5), heap(2, 6, 100, 0)]);
    expect([summary.unpaired, summary.usedMismatch]).toEqual([0, 1]);
    expect([summary.usedDeltaMin, summary.usedDeltaMax]).toEqual([1, 1]);
    expect(summary.samples[0]!.totalAfter).toBe(100);
    // A GC with no stats event before the next GC is unpaired.
    const gap = summarizeMemoryTrace([
      gc('MinorGC', 1, 10, 5),
      gc('MinorGC', 3, 20, 6),
      heap(4, 6, 50, 0),
    ]);
    expect([gap.unpaired, gap.samples[0]!.totalAfter, gap.samples[1]!.totalAfter]).toEqual([
      1,
      null,
      50,
    ]);
    expect(summarizeMemoryTrace({ traceEvents: [] }).thread).toBeNull();
  });
});

describe('PA-U4b per-run verdict (contract section 1)', () => {
  const ledger = (over: Partial<MemoryLedgerReading> = {}): MemoryLedgerReading => ({
    gpu: { peakBytes: 1000, unknownFormats: [], querySets: 0, externalTextures: 0 },
    canvas: { maxPixels: 100, reads: 1 },
    wasm: { bytes: 65536 },
    idb: { peakBytes: 10, nonString: 0 },
    ...over,
  });
  const trace = summarizeMemoryTrace([]);
  const end = { usedSize: 5, totalSize: 8, embedderHeapUsedSize: 3, backingStorageSize: 4 };

  it('is UNVERIFIED while M1, M2 and M7 have no exact route', () => {
    const block = memoryBlock(ledger(), trace, end);
    expect(block.verdict).toBe('UNVERIFIED');
    expect(block.unverified).toEqual(['M1', 'M2', 'M7']);
    expect(block.categories.M5.bytes).toBe(100 * 4 * 3 + GLYPH_RASTER_BOUND_BYTES);
    expect(block.exactSumBytes).toBe(65536 + 1000 + 1200 + GLYPH_RASTER_BOUND_BYTES + 10);
    expect(block.observedSumBytes).toBe(block.exactSumBytes + 8 + 4 + 3);
  });

  it('is FAIL once the exact categories alone exceed the bound', () => {
    const block = memoryBlock(
      ledger({
        gpu: {
          peakBytes: MEMORY_BOUND_BYTES,
          unknownFormats: [],
          querySets: 0,
          externalTextures: 0,
        },
      }),
      trace,
      end,
    );
    expect(block.verdict).toBe('FAIL');
  });

  it('opens M4, M5 and M6 on unknown formats, no canvas read and non-string puts', () => {
    const block = memoryBlock(
      ledger({
        gpu: { peakBytes: 1, unknownFormats: ['depth24plus'], querySets: 0, externalTextures: 0 },
        canvas: { maxPixels: 0, reads: 0 },
        idb: { peakBytes: 0, nonString: 1 },
      }),
      trace,
      end,
    );
    expect(block.unverified).toEqual(['M1', 'M2', 'M4', 'M5', 'M6', 'M7']);
  });
});
