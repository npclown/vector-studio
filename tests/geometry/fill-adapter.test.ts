import type { FillMeshRequest } from '@vector-studio/contracts';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createFillMeshPort,
  createGeometrySession,
} from '../../packages/geometry-wasm/src/index.js';
import {
  createFillMeshPortFromExports,
  FILL_V0_OPERATION_ID,
  FILL_V0_REVISION,
  type FillKernelExports,
} from '../../packages/geometry-wasm/src/fill-adapter.js';

// P3 V2 contract section h: adapter validation, batch-level precedence, the
// kernel self-check rule and every fail-closed trigger through wrapped export
// objects. Functional evidence; precision is UNVERIFIED until B4 has A04 evidence.

let module: WebAssembly.Module;
let wasmBytes: Uint8Array<ArrayBuffer>;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  wasmBytes = new Uint8Array(await readFile(process.env.P2_WASM_PATH));
  module = await WebAssembly.compile(wasmBytes);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function kernel(): Promise<FillKernelExports> {
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as FillKernelExports;
}

function square(requestId = 1, toleranceExponent = -3): FillMeshRequest {
  return {
    requestId,
    verbs: new Uint8Array([0, 1, 1, 1, 3]),
    points: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]),
    fillRule: 'nonzero',
    toleranceExponent,
  };
}

function grammarError(requestId = 2): FillMeshRequest {
  return {
    requestId,
    verbs: new Uint8Array([1]),
    points: new Float64Array([1, 1]),
    fillRule: 'evenodd',
    toleranceExponent: 4,
  };
}

const INTERNAL = { status: 'batch-failed', code: 'internal-error' } as const;
const DISPOSED = { status: 'batch-failed', code: 'disposed' } as const;
const RESOURCE = { status: 'batch-failed', code: 'resource-limit' } as const;

/** Advances the real epoch once with no result: an INVALID_BATCH process. */
function idleProcess(real: FillKernelExports): void {
  expect(real.fill_v0_process(0xffff_ffff)).toBe(1);
}

describe('fill-v0 adapter factory', () => {
  it('instantiates its own instance from a module or bytes', async () => {
    for (const source of [module, wasmBytes]) {
      const adapter = await createFillMeshPort(source);
      expect(adapter.portVersion).toBe(0);
      expect(adapter.operationId).toBe(FILL_V0_OPERATION_ID);
      expect(adapter.operationId).toBe('geometry-wasm/fill-v0+r4');
      expect(adapter.linearMemoryBytes()).toBeGreaterThan(0);
      const result = adapter.buildFillMeshes([square()]);
      expect(result.status).toBe('ok');
      adapter.dispose();
    }
  });

  it('rejects a missing export, a version or a revision mismatch and disposes', async () => {
    for (const override of [
      { fill_v0_process: undefined },
      { fill_v0_version: () => 1 },
      { fill_v0_revision: () => FILL_V0_REVISION + 1 },
      { fill_v0_revision: () => 1 },
    ]) {
      const real = await kernel();
      const dispose = vi.fn(() => real.fill_v0_dispose());
      const before = real.fill_v0_memory_epoch();
      expect(() =>
        createFillMeshPortFromExports({
          ...real,
          fill_v0_dispose: dispose,
          ...override,
        } as unknown as FillKernelExports),
      ).toThrow();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(real.fill_v0_memory_epoch()).toBe(before + 1);
    }
  });

  it('isolates instances from each other and from a P2 session', async () => {
    const first = await createFillMeshPort(module);
    const second = await createFillMeshPort(module);
    const session = await createGeometrySession(module);
    first.dispose();
    expect(first.buildFillMeshes([square()])).toEqual(DISPOSED);
    expect(second.buildFillMeshes([square()]).status).toBe('ok');
    const p2 = session.batch([
      {
        domainId: 'document/page',
        nodeId: 'node',
        requestId: 1,
        sourceEpoch: 1,
        sourceRevision: 1,
        verbs: new Uint8Array([0, 2]),
        points: new Float64Array([0, 0, 1, 0, 2, 0, 3, 0]),
        strokeStyleHash: 'solid',
        fillRule: 'nonzero',
        world: [1, 0, 0, 1],
        zoom: 1,
        devicePixelRatio: 1,
      },
    ]);
    expect(p2.status).toBe('OK');
    second.dispose();
    session.dispose();
  });
});

describe('fill-v0 adapter batch rules', () => {
  it('copies input after every reserve and needs no retry in steady state', async () => {
    const real = await kernel();
    let reserves = 0;
    let processes = 0;
    const adapter = createFillMeshPortFromExports({
      ...real,
      fill_v0_reserve: (input, output) => {
        reserves += 1;
        return real.fill_v0_reserve(input, output);
      },
      fill_v0_process: (length) => {
        processes += 1;
        return real.fill_v0_process(length);
      },
    });
    const first = adapter.buildFillMeshes([square(), grammarError()]);
    expect(first.status).toBe('ok');
    expect([reserves, processes]).toEqual([2, 2]);
    expect(adapter.buildFillMeshes([square(), grammarError()])).toEqual(first);
    expect([reserves, processes]).toEqual([2, 3]);
    expect(adapter.linearMemoryBytes()).toBe(real.memory.buffer.byteLength);
    adapter.dispose();
  });

  it('returns disposed, invalid-request and empty results without a kernel call', async () => {
    const real = await kernel();
    const calls = vi.fn();
    const counted = Object.fromEntries(
      Object.entries(real).map(([name, value]) => [
        name,
        typeof value === 'function'
          ? (...args: number[]) => {
              calls(name);
              return (value as (...values: number[]) => number)(...args);
            }
          : value,
      ]),
    ) as unknown as FillKernelExports;
    const adapter = createFillMeshPortFromExports(counted);
    calls.mockClear();
    expect(adapter.buildFillMeshes([])).toEqual({ status: 'ok', results: [] });
    const throwing = Object.defineProperty({ ...square() }, 'verbs', {
      get(): Uint8Array {
        throw new Error('caller getter');
      },
    });
    expect(adapter.buildFillMeshes([throwing])).toEqual({
      status: 'batch-failed',
      code: 'invalid-request',
    });
    // invalid-request precedes resource-limit.
    const huge = { ...square(3), points: new Float64Array(8 * 1024 * 1024 + 8) };
    expect(adapter.buildFillMeshes([huge, { ...square(), requestId: -1 }])).toEqual({
      status: 'batch-failed',
      code: 'invalid-request',
    });
    expect(adapter.buildFillMeshes([huge])).toEqual(RESOURCE);
    expect(calls).not.toHaveBeenCalled();
    adapter.dispose();
    calls.mockClear();
    expect(adapter.buildFillMeshes([square()])).toEqual(DISPOSED);
    adapter.dispose();
    expect(calls).not.toHaveBeenCalled();
  });

  it('encodes an exponent outside i32 as -2^31 and echoes the caller value', async () => {
    const adapter = await createFillMeshPort(module);
    const result = adapter.buildFillMeshes([square(1, 2 ** 40), square(2, -(2 ** 40))]);
    expect(result).toEqual({
      status: 'ok',
      results: [
        { requestId: 1, toleranceExponent: 2 ** 40, status: 'failed', code: 'invalid-tolerance' },
        {
          requestId: 2,
          toleranceExponent: -(2 ** 40),
          status: 'failed',
          code: 'invalid-tolerance',
        },
      ],
    });
    adapter.dispose();
  });

  it('maps kernel RESOURCE_LIMIT, ALLOCATION_FAILED and host RangeError to resource-limit', async () => {
    for (const status of [3, 5]) {
      const real = await kernel();
      let fake = true;
      const adapter = createFillMeshPortFromExports({
        ...real,
        fill_v0_process: (length) => {
          if (!fake) return real.fill_v0_process(length);
          fake = false;
          idleProcess(real);
          return status;
        },
      });
      expect(adapter.buildFillMeshes([square()])).toEqual(RESOURCE);
      expect(adapter.buildFillMeshes([square()]).status).toBe('ok');
      adapter.dispose();
    }
    for (const status of [3, 5]) {
      const real = await kernel();
      let fake = true;
      const adapter = createFillMeshPortFromExports({
        ...real,
        fill_v0_reserve: (input, output) => {
          if (!fake) return real.fill_v0_reserve(input, output);
          fake = false;
          real.fill_v0_reserve(0, 0);
          return status;
        },
      });
      expect(adapter.buildFillMeshes([square()])).toEqual(RESOURCE);
      expect(adapter.buildFillMeshes([square()]).status).toBe('ok');
      adapter.dispose();
    }
    const adapter = await createFillMeshPort(module);
    vi.spyOn(Float64Array.prototype, 'slice').mockImplementationOnce(() => {
      throw new RangeError('host allocation failed');
    });
    expect(adapter.buildFillMeshes([square()])).toEqual(RESOURCE);
    expect(adapter.buildFillMeshes([square()]).status).toBe('ok');
    adapter.dispose();
  });

  it('reports a kernel INTERNAL_ERROR from process without disposing', async () => {
    const real = await kernel();
    let fail = true;
    let disposes = 0;
    const adapter = createFillMeshPortFromExports({
      ...real,
      fill_v0_process: (length) => {
        if (!fail) return real.fill_v0_process(length);
        fail = false;
        idleProcess(real);
        return 6;
      },
      fill_v0_dispose: () => {
        disposes += 1;
        return real.fill_v0_dispose();
      },
    });
    expect(adapter.buildFillMeshes([square()])).toEqual(INTERNAL);
    expect(disposes).toBe(0);
    expect(adapter.buildFillMeshes([square()]).status).toBe('ok');
    adapter.dispose();
    expect(disposes).toBe(1);
  });
});

type Wrap = (real: FillKernelExports) => Partial<FillKernelExports>;

/** Runs one batch through wrapped exports and expects a fail-closed outcome. */
async function expectFailClosed(name: string, reason: string, wrap: Wrap): Promise<void> {
  const real = await kernel();
  let disposes = 0;
  const reasons: string[] = [];
  const adapter = createFillMeshPortFromExports(
    {
      ...real,
      ...wrap(real),
      fill_v0_dispose: () => {
        disposes += 1;
        return real.fill_v0_dispose();
      },
    },
    { onFailClosed: (breach) => reasons.push(breach) },
  );
  expect(adapter.buildFillMeshes([square(), grammarError()]), name).toEqual(INTERNAL);
  expect(reasons, name).toHaveLength(1);
  expect(reasons[0], name).toContain(reason);
  expect(disposes, name).toBe(1);
  expect(adapter.buildFillMeshes([square()]), name).toEqual(DISPOSED);
  expect(adapter.buildFillMeshes([]), name).toEqual(DISPOSED);
  expect(disposes, name).toBe(1);
}

/** Corrupts the published output of the successful process. */
function corrupt(edit: (view: DataView) => void): Wrap {
  return (real) => ({
    fill_v0_process: (length) => {
      const status = real.fill_v0_process(length);
      if (status === 0) edit(new DataView(real.memory.buffer, real.fill_v0_output_ptr()));
      return status;
    },
  });
}

/** Returns a fake process status after an idle real call, once. */
function fakeProcess(status: number, extra: Wrap = () => ({})): Wrap {
  return (real) => {
    let fake = true;
    return {
      ...extra(real),
      fill_v0_process: (length) => {
        if (!fake) return real.fill_v0_process(length);
        fake = false;
        idleProcess(real);
        return status;
      },
    };
  };
}

describe('fill-v0 adapter fails closed', () => {
  // Output of [square (ok), grammarError (failed)]: records at 64 and 144,
  // the square's block at 224 (4 vertices, 6 indices, 8 boundary indices).
  const OK_RECORD = 64;
  const FAILED_RECORD = 144;
  const BLOCK = 224;

  // Each trigger names the adapter check it must reach, so a different
  // breach cannot satisfy it.
  const COUNTS = 'an OK record has inconsistent counts or offsets';
  const HEADER = 'output header is inconsistent';
  const NON_OK = 'a non-OK record carries mesh fields';
  const REQUIREMENT = 'OUTPUT_CAPACITY without a larger exact requirement';
  const triggers: readonly [string, string, Wrap][] = [
    [
      'WASM trap',
      'unreachable',
      () => ({
        fill_v0_process: () => {
          throw new WebAssembly.RuntimeError('unreachable');
        },
      }),
    ],
    ['non-u32 status', 'kernel returned a non-u32 status', fakeProcess(-1)],
    ['fractional status', 'kernel returned a non-u32 status', fakeProcess(1.5)],
    ['unknown status', 'process returned status 7', fakeProcess(7)],
    ['INVALID_BATCH', 'process returned status 1', fakeProcess(1)],
    [
      'reserve INTERNAL_ERROR',
      'reserve returned status 6',
      (real) => ({
        fill_v0_reserve: () => {
          real.fill_v0_reserve(0, 0);
          return 6;
        },
      }),
    ],
    [
      'reserve INVALID_BATCH',
      'reserve returned status 1',
      (real) => ({
        fill_v0_reserve: () => {
          real.fill_v0_reserve(0, 0);
          return 1;
        },
      }),
    ],
    [
      'second OUTPUT_CAPACITY',
      'second OUTPUT_CAPACITY after an exact reserve',
      (real) => {
        let converted = false;
        return {
          fill_v0_process: (length) => {
            const status = real.fill_v0_process(length);
            converted = status === 0;
            return converted ? 2 : status;
          },
          fill_v0_result_len: () => (converted ? 0 : real.fill_v0_result_len()),
          fill_v0_required_output_bytes: () =>
            converted ? real.fill_v0_output_capacity() + 8 : real.fill_v0_required_output_bytes(),
        };
      },
    ],
    [
      'OUTPUT_CAPACITY with zero requirement',
      REQUIREMENT,
      fakeProcess(2, () => ({ fill_v0_required_output_bytes: () => 0 })),
    ],
    [
      'OUTPUT_CAPACITY not larger than the capacity',
      REQUIREMENT,
      fakeProcess(2, (real) => ({
        fill_v0_required_output_bytes: () => real.fill_v0_output_capacity(),
      })),
    ],
    [
      'OUTPUT_CAPACITY above the cap',
      REQUIREMENT,
      fakeProcess(2, () => ({ fill_v0_required_output_bytes: () => 256 * 1024 * 1024 + 8 })),
    ],
    [
      'RESOURCE_LIMIT with a requirement',
      'RESOURCE_LIMIT published an output requirement',
      fakeProcess(5, () => ({ fill_v0_required_output_bytes: () => 8 })),
    ],
    [
      'epoch advanced twice',
      'memory epoch did not advance exactly once',
      (real) => ({
        fill_v0_process: (length) => {
          idleProcess(real);
          return real.fill_v0_process(length);
        },
      }),
    ],
    [
      'epoch not advanced',
      'memory epoch did not advance exactly once',
      (real) => {
        let reported: number | null = null;
        return {
          fill_v0_process: (length) => {
            const before = real.fill_v0_memory_epoch();
            const status = real.fill_v0_process(length);
            reported = before;
            return status;
          },
          fill_v0_memory_epoch: () => reported ?? real.fill_v0_memory_epoch(),
        };
      },
    ],
    [
      'storage changed during process',
      'process changed linear-memory storage',
      (real) => ({
        fill_v0_process: (length) => {
          const status = real.fill_v0_process(length);
          real.memory.grow(1);
          return status;
        },
      }),
    ],
    [
      'failure published a result',
      'a failure published a readable result',
      fakeProcess(6, () => ({ fill_v0_result_len: () => 64 })),
    ],
    [
      'result length below the header',
      'OK published an invalid result length',
      (real) => ({
        fill_v0_result_len: () => (real.fill_v0_result_len() === 0 ? 0 : 8),
      }),
    ],
    ['header magic', HEADER, corrupt((view) => view.setUint32(0, 0, true))],
    ['header version', HEADER, corrupt((view) => view.setUint32(4, 1, true))],
    ['header total', HEADER, corrupt((view) => view.setUint32(8, 0, true))],
    ['header path count', HEADER, corrupt((view) => view.setUint32(12, 3, true))],
    ['header results offset', HEADER, corrupt((view) => view.setUint32(16, 72, true))],
    ['header data offset', HEADER, corrupt((view) => view.setUint32(20, BLOCK + 8, true))],
    [
      'header reserved',
      'output header reserved field is set',
      corrupt((view) => view.setUint32(24, 1, true)),
    ],
    [
      'request echo',
      'result echo differs from the request',
      corrupt((view) => view.setUint32(OK_RECORD, 99, true)),
    ],
    [
      'exponent echo',
      'result echo differs from the request',
      corrupt((view) => view.setInt32(OK_RECORD + 8, 5, true)),
    ],
    [
      'unknown path status',
      'unknown path status 9',
      corrupt((view) => view.setUint32(FAILED_RECORD + 4, 9, true)),
    ],
    [
      'record reserved',
      'record reserved field is set',
      corrupt((view) => view.setUint32(OK_RECORD + 12, 1, true)),
    ],
    [
      'record tail reserved',
      'record reserved field is set',
      corrupt((view) => view.setUint32(OK_RECORD + 40, 1, true)),
    ],
    ['OK with zero vertices', COUNTS, corrupt((view) => view.setUint32(OK_RECORD + 20, 0, true))],
    ['OK with zero indices', COUNTS, corrupt((view) => view.setUint32(OK_RECORD + 24, 0, true))],
    [
      'index count not a multiple of 3',
      COUNTS,
      corrupt((view) => view.setUint32(OK_RECORD + 24, 5, true)),
    ],
    ['odd boundary count', COUNTS, corrupt((view) => view.setUint32(OK_RECORD + 28, 7, true))],
    [
      'non-contiguous block',
      COUNTS,
      corrupt((view) => view.setUint32(OK_RECORD + 16, BLOCK + 8, true)),
    ],
    [
      'wrong block bytes',
      'an OK block has an inconsistent size',
      corrupt((view) => view.setUint32(OK_RECORD + 32, 128, true)),
    ],
    ['OK status turned empty', NON_OK, corrupt((view) => view.setUint32(OK_RECORD + 4, 1, true))],
    ['non-OK record count', NON_OK, corrupt((view) => view.setUint32(FAILED_RECORD + 20, 1, true))],
    [
      'non-OK record bounds',
      NON_OK,
      corrupt((view) => view.setFloat64(FAILED_RECORD + 48, 1, true)),
    ],
    [
      'index out of range',
      'an index is outside the vertices',
      corrupt((view) => view.setUint32(BLOCK + 64, 4, true)),
    ],
    [
      'boundary index out of range',
      'a boundary index is outside the vertices',
      corrupt((view) => view.setUint32(BLOCK + 88, 4, true)),
    ],
    [
      'non-finite position',
      'a position is not finite',
      corrupt((view) => view.setFloat64(BLOCK, Number.NaN, true)),
    ],
    [
      'bounds mismatch',
      'bounds differ from the recomputed vertex bounds',
      corrupt((view) => view.setFloat64(OK_RECORD + 48, -1, true)),
    ],
    [
      'total beyond the blocks',
      'output total differs from the blocks',
      (real) => ({
        fill_v0_reserve: (input, output) => real.fill_v0_reserve(input, output + 64),
        fill_v0_process: (length) => {
          const status = real.fill_v0_process(length);
          if (status === 0) {
            const view = new DataView(real.memory.buffer, real.fill_v0_output_ptr());
            view.setUint32(8, view.getUint32(8, true) + 8, true);
          }
          return status;
        },
        fill_v0_result_len: () => {
          const length = real.fill_v0_result_len();
          return length === 0 ? 0 : length + 8;
        },
      }),
    ],
  ];

  for (const [name, reason, wrap] of triggers) {
    it(name, () => expectFailClosed(name, reason, wrap));
  }

  it('fails closed before calling the kernel on an exhausted epoch', async () => {
    const real = await kernel();
    const reasons: string[] = [];
    const adapter = createFillMeshPortFromExports(
      { ...real, fill_v0_memory_epoch: () => 0xffff_ffff },
      { onFailClosed: (breach) => reasons.push(breach) },
    );
    expect(adapter.buildFillMeshes([square()])).toEqual(INTERNAL);
    expect(reasons).toEqual(['fill memory epoch is exhausted']);
    expect(adapter.buildFillMeshes([square()])).toEqual(DISPOSED);
  });
});
