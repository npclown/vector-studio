// PA-U4b (A09 memory method, docs/plans/pa-u4-a09-memory-method.md, sections 3.3 to 3.5): the
// page-side ledgers of the memory variant (`E26_MEMORY=1`). `installMemoryLedger` runs as a
// Playwright init script, before any page code, so it must stay self-contained: no imports, no
// references outside its own body. It wraps the allocation entry points it counts and never
// changes their arguments or results. The unit tests call it on a fake scope.

/** Bytes per texel of every texture format the renderer creates today (contract section 3.3). */
export const MEMORY_TEXEL_BYTES: Readonly<Record<string, number>> = {
  rgba16float: 8,
  rgba8unorm: 4,
  bgra8unorm: 4,
  r8unorm: 1,
  stencil8: 1,
};

export type MemoryLedgerSnapshot = {
  gpu: {
    liveBytes: number;
    peakBytes: number;
    buffers: number;
    textures: number;
    destroyed: number;
    unknownFormats: string[];
    querySets: number;
    externalTextures: number;
  };
  canvas: { maxPixels: number; maxWidth: number; maxHeight: number; reads: number };
  wasm: { memories: number; bytes: number; instances: number };
  idb: { liveBytes: number; peakBytes: number; puts: number; nonString: number };
};

export type MemoryLedger = { snapshot(): MemoryLedgerSnapshot };

/** The scope the ledger patches: `globalThis` in the page, a fake in the unit tests. */
export type MemoryLedgerScope = {
  GPUDevice?: { prototype: Record<string, unknown> };
  GPUCanvasContext?: { prototype: Record<string, unknown> };
  IDBObjectStore?: { prototype: Record<string, unknown> };
  WebAssembly?: Record<string, unknown>;
  __vsMemory?: MemoryLedger;
};

export function installMemoryLedger(target?: MemoryLedgerScope): void {
  const scope = (target ?? globalThis) as MemoryLedgerScope;
  if (scope.__vsMemory !== undefined) return;
  // Kept in step with MEMORY_TEXEL_BYTES above by a unit test (the script cannot import it).
  const texel: Record<string, number> = {
    rgba16float: 8,
    rgba8unorm: 4,
    bgra8unorm: 4,
    r8unorm: 1,
    stencil8: 1,
  };
  const gpu = {
    liveBytes: 0,
    peakBytes: 0,
    buffers: 0,
    textures: 0,
    destroyed: 0,
    unknownFormats: [] as string[],
    querySets: 0,
    externalTextures: 0,
  };
  const canvas = { maxPixels: 0, maxWidth: 0, maxHeight: 0, reads: 0 };
  const memories = new Set<{ buffer: ArrayBuffer }>();
  const wasm = { instances: 0 };
  const idb = { liveBytes: 0, peakBytes: 0, puts: 0, nonString: 0 };

  type Size = number[] | { width: number; height?: number; depthOrArrayLayers?: number };
  const textureBytes = (descriptor: {
    size: Size;
    format: string;
    mipLevelCount?: number;
    sampleCount?: number;
    dimension?: string;
  }): number | null => {
    const bytes = texel[descriptor.format];
    if (bytes === undefined) return null;
    const size = descriptor.size;
    const width = Array.isArray(size) ? size[0]! : size.width;
    const height = Array.isArray(size) ? (size[1] ?? 1) : (size.height ?? 1);
    const depth = Array.isArray(size) ? (size[2] ?? 1) : (size.depthOrArrayLayers ?? 1);
    const volume = descriptor.dimension === '3d';
    let total = 0;
    for (let level = 0; level < (descriptor.mipLevelCount ?? 1); level += 1) {
      const w = Math.max(1, width >> level);
      const h = descriptor.dimension === '1d' ? 1 : Math.max(1, height >> level);
      const d = volume ? Math.max(1, depth >> level) : depth;
      total += w * h * d * bytes;
    }
    return total * (descriptor.sampleCount ?? 1);
  };
  const add = (bytes: number) => {
    gpu.liveBytes += bytes;
    if (gpu.liveBytes > gpu.peakBytes) gpu.peakBytes = gpu.liveBytes;
  };
  const tracked = (object: { destroy?: (...args: unknown[]) => unknown }, bytes: number) => {
    add(bytes);
    const destroy = object.destroy;
    if (typeof destroy !== 'function') return;
    let live = true;
    object.destroy = function (this: unknown, ...rest: unknown[]) {
      if (live) {
        live = false;
        gpu.liveBytes -= bytes;
        gpu.destroyed += 1;
      }
      return destroy.apply(this, rest);
    };
  };

  const device = scope.GPUDevice?.prototype;
  if (device !== undefined) {
    const createBuffer = device.createBuffer as (descriptor: { size: number }) => object;
    device.createBuffer = function (this: unknown, descriptor: { size: number }) {
      const buffer = createBuffer.call(this, descriptor) as { destroy?: () => unknown };
      gpu.buffers += 1;
      tracked(buffer, descriptor.size);
      return buffer;
    };
    const createTexture = device.createTexture as (descriptor: never) => object;
    device.createTexture = function (
      this: unknown,
      descriptor: Parameters<typeof textureBytes>[0],
    ) {
      const texture = createTexture.call(this, descriptor as never) as { destroy?: () => unknown };
      gpu.textures += 1;
      const bytes = textureBytes(descriptor);
      if (bytes === null) {
        if (!gpu.unknownFormats.includes(descriptor.format))
          gpu.unknownFormats.push(descriptor.format);
        tracked(texture, 0);
      } else tracked(texture, bytes);
      return texture;
    };
    for (const [name, counter] of [
      ['createQuerySet', 'querySets'],
      ['importExternalTexture', 'externalTextures'],
    ] as const) {
      const original = device[name];
      if (typeof original !== 'function') continue;
      device[name] = function (this: unknown, ...rest: unknown[]) {
        gpu[counter] += 1;
        return (original as (...args: unknown[]) => unknown).apply(this, rest);
      };
    }
  }

  const context = scope.GPUCanvasContext?.prototype;
  if (context !== undefined && typeof context.getCurrentTexture === 'function') {
    const getCurrentTexture = context.getCurrentTexture as () => { width: number; height: number };
    context.getCurrentTexture = function (this: unknown) {
      const texture = getCurrentTexture.call(this);
      canvas.reads += 1;
      const pixels = texture.width * texture.height;
      if (pixels > canvas.maxPixels) {
        canvas.maxPixels = pixels;
        canvas.maxWidth = texture.width;
        canvas.maxHeight = texture.height;
      }
      return texture;
    };
  }

  const wa = scope.WebAssembly;
  if (wa !== undefined) {
    const Memory = wa.Memory as (new (...args: unknown[]) => { buffer: ArrayBuffer }) | undefined;
    const Instance = wa.Instance as (new (...args: unknown[]) => object) | undefined;
    const isMemory = (value: unknown): value is { buffer: ArrayBuffer } =>
      Memory !== undefined && value instanceof Memory;
    const noteInstance = (instance: unknown) => {
      if (instance === null || typeof instance !== 'object') return;
      wasm.instances += 1;
      const exports = (instance as { exports?: Record<string, unknown> }).exports ?? {};
      for (const value of Object.values(exports)) if (isMemory(value)) memories.add(value);
    };
    // `instantiate(module)` resolves to an Instance; `instantiate(bytes)` to {instance, module}.
    const noteResult = (result: unknown) => {
      if (Instance !== undefined && result instanceof Instance) noteInstance(result);
      else noteInstance((result as { instance?: unknown } | null)?.instance);
      return result;
    };
    const noteImports = (imports: unknown) => {
      if (imports === null || typeof imports !== 'object') return;
      for (const module of Object.values(imports as Record<string, unknown>)) {
        if (module === null || typeof module !== 'object') continue;
        for (const value of Object.values(module as Record<string, unknown>))
          if (isMemory(value)) memories.add(value);
      }
    };
    for (const name of ['instantiate', 'instantiateStreaming'] as const) {
      const original = wa[name];
      if (typeof original !== 'function') continue;
      wa[name] = function (this: unknown, source: unknown, imports?: unknown, ...rest: unknown[]) {
        noteImports(imports);
        return Promise.resolve(
          (original as (...args: unknown[]) => unknown).call(this, source, imports, ...rest),
        ).then(noteResult);
      };
    }
    if (Instance !== undefined) {
      wa.Instance = new Proxy(Instance, {
        construct(target, args, newTarget) {
          noteImports(args[1]);
          const instance = Reflect.construct(target, args, newTarget) as object;
          noteInstance(instance);
          return instance;
        },
      });
    }
    if (Memory !== undefined) {
      wa.Memory = new Proxy(Memory, {
        construct(target, args, newTarget) {
          const memory = Reflect.construct(target, args, newTarget) as { buffer: ArrayBuffer };
          memories.add(memory);
          return memory;
        },
      });
    }
  }

  const store = scope.IDBObjectStore?.prototype;
  if (store !== undefined && typeof store.put === 'function') {
    const put = store.put as (...args: unknown[]) => unknown;
    const pending = new WeakMap<object, number>();
    store.put = function (
      this: { transaction?: EventTarget & object },
      value: unknown,
      ...rest: unknown[]
    ) {
      idb.puts += 1;
      const request = put.call(this, value, ...rest);
      if (typeof value !== 'string') {
        idb.nonString += 1;
        return request;
      }
      const bytes = 2 * value.length;
      idb.liveBytes += bytes;
      if (idb.liveBytes > idb.peakBytes) idb.peakBytes = idb.liveBytes;
      const transaction = this.transaction;
      if (transaction === undefined) return request;
      const before = pending.get(transaction);
      pending.set(transaction, (before ?? 0) + bytes);
      if (before === undefined) {
        const settle = () => {
          const held = pending.get(transaction);
          if (held === undefined) return;
          pending.delete(transaction);
          idb.liveBytes -= held;
        };
        for (const type of ['complete', 'error', 'abort'])
          transaction.addEventListener(type, settle, { once: true });
      }
      return request;
    };
  }

  scope.__vsMemory = {
    snapshot: () => {
      let bytes = 0;
      for (const memory of memories) bytes += memory.buffer.byteLength;
      return {
        gpu: { ...gpu, unknownFormats: [...gpu.unknownFormats] },
        canvas: { ...canvas },
        wasm: { memories: memories.size, bytes, instances: wasm.instances },
        idb: { ...idb },
      };
    },
  };
}
