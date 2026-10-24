import { createHash } from 'node:crypto';

// E10 contract, criterion E10-A1 (docs/plans/d9-e10-renderer-test-hooks-contract.md): a fake
// WebGPU device whose every call is logged in order with its arguments, so the default render
// path's GPU work can be compared against a golden log. Objects the fake returns are named by a
// creation counter; byte payloads and long strings (shader sources) are logged as SHA-256.

export type GpuLogEntry = readonly [string, ...unknown[]];

const LONG_STRING = 160;

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Returns { value } to replace a call's result (the call is still logged), or undefined. */
export type GpuIntercept = (
  call: Readonly<{ owner: string; method: string; args: readonly unknown[] }>,
) => Readonly<{ value: unknown }> | undefined;

export class GpuRecorder {
  readonly log: GpuLogEntry[] = [];
  readonly #names = new WeakMap<object, string>();
  readonly #sizes = new Map<string, number>();
  #next = 0;
  intercept: GpuIntercept | undefined;

  /** The size a recorded buffer was created with. */
  public sizeOf(name: string): number | undefined {
    return this.#sizes.get(name);
  }

  /** The recorded name of an object this recorder created. */
  public nameOf(value: object): string | undefined {
    return this.#names.get(value);
  }

  /** A recorded object: each method call is logged and returns a new recorded object. */
  public object(kind: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const name = `${kind}#${(this.#next += 1)}`;
    const target: Record<string, unknown> = { ...overrides };
    const proxy = new Proxy(target, {
      get: (object, key) => {
        if (typeof key === 'symbol') return undefined;
        if (key in object) return object[key];
        if (key === 'then' || key === 'toJSON') return undefined;
        return (...args: unknown[]) => this.#call(name, key, args);
      },
      set: (object, key, value) => {
        // A recovery's fresh lost promise is fixture state, not GPU work.
        if (typeof key === 'string' && key !== 'lost') {
          this.log.push([`${name}.${key}=`, this.serialize(value)]);
        }
        object[key as string] = value;
        return true;
      },
    });
    this.#names.set(proxy, name);
    return proxy;
  }

  #call(owner: string, method: string, args: unknown[]): unknown {
    this.log.push([`${owner}.${method}`, ...args.map((arg) => this.serialize(arg))]);
    const replaced = this.intercept?.({ owner, method, args });
    if (replaced !== undefined) return replaced.value;
    if (method === 'getMappedRange') return new ArrayBuffer(this.#sizes.get(owner) ?? 0);
    const result = this.object(method.replace(/^create/, '').replace(/Async$/, ''));
    if (method === 'createBuffer') {
      const size = (args[0] as { size?: number } | undefined)?.size ?? 0;
      this.#sizes.set(this.#names.get(result)!, size);
    }
    if (method.endsWith('Async') || method === 'mapAsync' || method === 'onSubmittedWorkDone') {
      return Promise.resolve(method === 'createRenderPipelineAsync' ? result : undefined);
    }
    return result;
  }

  public serialize(value: unknown): unknown {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'string')
      return value.length > LONG_STRING ? `sha256:${sha256(value)}` : value;
    if (typeof value !== 'object') return value;
    const name = this.#names.get(value);
    if (name !== undefined) return name;
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return `bytes:${bytes.byteLength}:${sha256(bytes)}`;
    }
    if (Array.isArray(value)) return value.map((item) => this.serialize(item));
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = this.serialize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
}

export const RECORDER_LIMITS = Object.freeze({
  maxTextureDimension2D: 8192,
  maxBufferSize: 256 * 1024 * 1024,
  minStorageBufferOffsetAlignment: 256,
  minUniformBufferOffsetAlignment: 256,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxUniformBufferBindingSize: 65536,
  maxStorageBuffersPerShaderStage: 8,
  maxUniformBuffersPerShaderStage: 12,
  maxBindingsPerBindGroup: 1000,
  maxBindGroups: 4,
});

/**
 * Installs navigator.gpu and isSecureContext over a recorder for the browser platform, and
 * returns a fake canvas whose context is recorded. Restore with the returned function.
 */
export function installRecordedBrowserGpu(
  recorder: GpuRecorder,
  format = 'bgra8unorm',
  options: Readonly<{ limits?: Readonly<Record<string, number>> }> = {},
) {
  let loseDevice: (reason: string) => void = () => undefined;
  const newLost = () =>
    new Promise<{ message: string; reason: string }>((resolve) => {
      loseDevice = (reason) => resolve({ message: 'test loss', reason });
    });
  const device = recorder.object('device', {
    features: new Set<string>(),
    limits: options.limits ?? RECORDER_LIMITS,
    lost: newLost(),
    queue: recorder.object('queue'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  const adapter = recorder.object('adapter', {
    info: { architecture: 'fake', description: 'recorder', vendor: 'e10' },
    // A recovery requests a device again; it gets the same fake with a fresh lost promise.
    requestDevice: () => {
      (device as { lost: unknown }).lost = newLost();
      return Promise.resolve(device);
    },
  });
  const gpu = {
    requestAdapter: () => Promise.resolve(adapter),
    getPreferredCanvasFormat: () => format,
  };
  const context = recorder.object('context');
  const canvas = recorder.object('canvas', {
    width: 300,
    height: 150,
    getContext: (kind: string) => (kind === 'webgpu' ? context : null),
  });
  const host = globalThis as unknown as Record<string, unknown>;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousSecure = host.isSecureContext;
  Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
  host.isSecureContext = true;
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    context,
    /** Resolves the current device's lost promise. */
    loseDevice: (reason = 'unknown') => loseDevice(reason),
    restore() {
      if (previousNavigator === undefined) delete host.navigator;
      else Object.defineProperty(globalThis, 'navigator', previousNavigator);
      host.isSecureContext = previousSecure;
    },
  };
}
