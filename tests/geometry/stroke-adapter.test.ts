import type { StrokeMeshRequest } from '@vector-studio/contracts';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createFillMeshPort,
  createGeometrySession,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import {
  createStrokeMeshPortFromExports,
  STROKE_V0_OPERATION_ID,
  STROKE_V0_REVISION,
  type StrokeKernelExports,
} from '../../packages/geometry-wasm/src/stroke-adapter.js';

// P3 B2 stroke contract sections 7.5 and 8 (ST-A7): adapter validation, batch-level
// precedence, the kernel self-check rule, instance isolation and every fail-closed trigger
// through wrapped export objects, as V2's fill-adapter test. Functional evidence; precision is
// UNVERIFIED until B4 has A04 evidence.

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

async function kernel(): Promise<StrokeKernelExports> {
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as StrokeKernelExports;
}

/** ST-F1: `M(0,0) L(4,0)`, w = 2, butt, miter 4. */
function line(requestId = 1, toleranceExponent = -3): StrokeMeshRequest {
  return {
    requestId,
    verbs: new Uint8Array([0, 1]),
    points: new Float64Array([0, 0, 4, 0]),
    width: 2,
    cap: 'butt',
    join: 'miter',
    miterLimit: 4,
    toleranceExponent,
  };
}

function grammarError(requestId = 2): StrokeMeshRequest {
  return {
    requestId,
    verbs: new Uint8Array([1]),
    points: new Float64Array([1, 1]),
    width: 2,
    cap: 'round',
    join: 'bevel',
    miterLimit: 4,
    toleranceExponent: 4,
  };
}

const INTERNAL = { status: 'batch-failed', code: 'internal-error' } as const;
const DISPOSED = { status: 'batch-failed', code: 'disposed' } as const;
const RESOURCE = { status: 'batch-failed', code: 'resource-limit' } as const;

/** Advances the real epoch once with no result: an INVALID_BATCH process. */
function idleProcess(real: StrokeKernelExports): void {
  expect(real.stroke_v0_process(0xffff_ffff)).toBe(1);
}

describe('stroke-v0 adapter factory', () => {
  it('instantiates its own instance from a module or bytes', async () => {
    for (const source of [module, wasmBytes]) {
      const adapter = await createStrokeMeshPort(source);
      expect(adapter.portVersion).toBe(0);
      expect(adapter.operationId).toBe(STROKE_V0_OPERATION_ID);
      expect(adapter.operationId).toBe('geometry-wasm/stroke-v0+r2');
      expect(adapter.linearMemoryBytes()).toBeGreaterThan(0);
      const result = adapter.buildStrokeMeshes([line()]);
      expect(result.status).toBe('ok');
      adapter.dispose();
    }
  });

  it('records the linear memory of one adapter after its first reserve', async () => {
    const real = await kernel();
    const before = real.memory.buffer.byteLength;
    expect(real.stroke_v0_reserve(0, 0)).toBe(0);
    const after = real.memory.buffer.byteLength;
    // Section 7.5 heap cap: the whole instance stays far below 48 MiB plus its arenas.
    expect(after).toBeLessThan(48 * 1024 * 1024);
    console.log(
      `stroke-v0 wasm32 linear memory: ${String(before)} B at instantiation, ${String(after)} B after reserve(0, 0)`,
    );
    real.stroke_v0_dispose();
  });

  it('rejects a missing export, a version or a revision mismatch and disposes', async () => {
    for (const override of [
      { stroke_v0_process: undefined },
      { stroke_v0_required_output_bytes: undefined },
      { stroke_v0_version: () => 1 },
      { stroke_v0_revision: () => STROKE_V0_REVISION + 1 },
      { stroke_v0_revision: () => 0 },
    ]) {
      const real = await kernel();
      const dispose = vi.fn(() => real.stroke_v0_dispose());
      const before = real.stroke_v0_memory_epoch();
      expect(() =>
        createStrokeMeshPortFromExports({
          ...real,
          stroke_v0_dispose: dispose,
          ...override,
        } as unknown as StrokeKernelExports),
      ).toThrow();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(real.stroke_v0_memory_epoch()).toBe(before + 1);
    }
  });

  it('isolates instances from each other, from a fill adapter and from a P2 session', async () => {
    const first = await createStrokeMeshPort(module);
    const second = await createStrokeMeshPort(module);
    const fill = await createFillMeshPort(module);
    const session = await createGeometrySession(module);
    first.dispose();
    expect(first.buildStrokeMeshes([line()])).toEqual(DISPOSED);
    expect(second.buildStrokeMeshes([line()]).status).toBe('ok');
    expect(
      fill.buildFillMeshes([
        {
          requestId: 1,
          verbs: new Uint8Array([0, 1, 1, 1, 3]),
          points: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]),
          fillRule: 'nonzero',
          toleranceExponent: -3,
        },
      ]).status,
    ).toBe('ok');
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
    fill.dispose();
    expect(second.buildStrokeMeshes([line()]).status).toBe('ok');
    second.dispose();
    session.dispose();
  });

  it('keeps the stroke engine separate from the fill and P2 engines of one instance', async () => {
    const real = await kernel();
    const raw = real as unknown as Record<string, (...values: number[]) => number>;
    const call = (name: string, ...values: number[]): number => {
      const exported = raw[name];
      if (exported === undefined) throw new Error(`missing export ${name}`);
      return exported(...values);
    };
    expect(real.stroke_v0_memory_epoch()).toBe(0);
    expect(call('fill_v0_reserve', 64, 64)).toBe(0);
    expect(call('reserve', 64, 64)).toBe(0);
    expect(real.stroke_v0_memory_epoch()).toBe(0);
    expect(real.stroke_v0_input_capacity()).toBe(0);
    expect(real.stroke_v0_dispose()).toBe(0);
    expect(call('fill_v0_memory_epoch')).toBe(1);
    expect(call('fill_v0_input_capacity')).toBe(64);
  });
});

describe('stroke-v0 adapter batch rules', () => {
  it('copies input after every reserve and needs no retry in steady state', async () => {
    const real = await kernel();
    let reserves = 0;
    let processes = 0;
    const adapter = createStrokeMeshPortFromExports({
      ...real,
      stroke_v0_reserve: (input, output) => {
        reserves += 1;
        return real.stroke_v0_reserve(input, output);
      },
      stroke_v0_process: (length) => {
        processes += 1;
        return real.stroke_v0_process(length);
      },
    });
    const first = adapter.buildStrokeMeshes([line(), grammarError()]);
    expect(first.status).toBe('ok');
    expect([reserves, processes]).toEqual([2, 2]);
    expect(adapter.buildStrokeMeshes([line(), grammarError()])).toEqual(first);
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
    ) as unknown as StrokeKernelExports;
    const adapter = createStrokeMeshPortFromExports(counted);
    calls.mockClear();
    expect(adapter.buildStrokeMeshes([])).toEqual({ status: 'ok', results: [] });
    const throwing = Object.defineProperty({ ...line() }, 'verbs', {
      get(): Uint8Array {
        throw new Error('caller getter');
      },
    });
    expect(adapter.buildStrokeMeshes([throwing])).toEqual({
      status: 'batch-failed',
      code: 'invalid-request',
    });
    for (const bad of [
      { ...line(), cap: 'flat' },
      { ...line(), join: 'mitre' },
      { ...line(), width: '2' },
      { ...line(), miterLimit: null },
    ]) {
      expect(adapter.buildStrokeMeshes([bad as unknown as StrokeMeshRequest])).toEqual({
        status: 'batch-failed',
        code: 'invalid-request',
      });
    }
    // invalid-request precedes resource-limit.
    const huge = { ...line(3), points: new Float64Array(8 * 1024 * 1024 + 8) };
    expect(adapter.buildStrokeMeshes([huge, { ...line(), requestId: -1 }])).toEqual({
      status: 'batch-failed',
      code: 'invalid-request',
    });
    expect(adapter.buildStrokeMeshes([huge])).toEqual(RESOURCE);
    expect(calls).not.toHaveBeenCalled();
    adapter.dispose();
    calls.mockClear();
    expect(adapter.buildStrokeMeshes([line()])).toEqual(DISPOSED);
    adapter.dispose();
    expect(calls).not.toHaveBeenCalled();
  });

  it('passes numeric but invalid widths and limits through as invalid-stroke', async () => {
    const adapter = await createStrokeMeshPort(module);
    const values: Partial<StrokeMeshRequest>[] = [
      { width: Number.NaN },
      { width: -Infinity },
      { width: -1e-300 },
      { miterLimit: 0.999 },
      { miterLimit: -Infinity },
    ];
    const result = adapter.buildStrokeMeshes(
      values.map((value, index) => ({ ...line(index), ...value })),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    for (const entry of result.results) {
      expect(entry).toEqual({
        requestId: entry.requestId,
        toleranceExponent: -3,
        status: 'failed',
        code: 'invalid-stroke',
      });
    }
    adapter.dispose();
  });

  it('encodes an exponent outside i32 as -2^31 and echoes the caller value', async () => {
    const adapter = await createStrokeMeshPort(module);
    const result = adapter.buildStrokeMeshes([line(1, 2 ** 40), line(2, -(2 ** 40))]);
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

  it('retries once with the exact output requirement', async () => {
    const real = await kernel();
    const reserves: [number, number][] = [];
    const adapter = createStrokeMeshPortFromExports({
      ...real,
      stroke_v0_reserve: (input, output) => {
        reserves.push([input, output]);
        return real.stroke_v0_reserve(input, output);
      },
    });
    const result = adapter.buildStrokeMeshes([line(1), line(2), line(3)]);
    expect(result.status).toBe('ok');
    expect(reserves).toHaveLength(2);
    expect(reserves[0]![1]).toBe(64 + 3 * 80);
    expect(reserves[1]![1]).toBeGreaterThan(64 + 3 * 80);
    expect(real.stroke_v0_result_len()).toBe(reserves[1]![1]);
    adapter.dispose();
  });

  it('maps kernel RESOURCE_LIMIT, ALLOCATION_FAILED and host RangeError to resource-limit', async () => {
    for (const status of [3, 5]) {
      const real = await kernel();
      let fake = true;
      const adapter = createStrokeMeshPortFromExports({
        ...real,
        stroke_v0_process: (length) => {
          if (!fake) return real.stroke_v0_process(length);
          fake = false;
          idleProcess(real);
          return status;
        },
      });
      expect(adapter.buildStrokeMeshes([line()])).toEqual(RESOURCE);
      expect(adapter.buildStrokeMeshes([line()]).status).toBe('ok');
      adapter.dispose();
    }
    for (const status of [3, 5]) {
      const real = await kernel();
      let fake = true;
      const adapter = createStrokeMeshPortFromExports({
        ...real,
        stroke_v0_reserve: (input, output) => {
          if (!fake) return real.stroke_v0_reserve(input, output);
          fake = false;
          real.stroke_v0_reserve(0, 0);
          return status;
        },
      });
      expect(adapter.buildStrokeMeshes([line()])).toEqual(RESOURCE);
      expect(adapter.buildStrokeMeshes([line()]).status).toBe('ok');
      adapter.dispose();
    }
    const adapter = await createStrokeMeshPort(module);
    vi.spyOn(Float64Array.prototype, 'slice').mockImplementationOnce(() => {
      throw new RangeError('host allocation failed');
    });
    expect(adapter.buildStrokeMeshes([line()])).toEqual(RESOURCE);
    expect(adapter.buildStrokeMeshes([line()]).status).toBe('ok');
    adapter.dispose();
  });

  it('reports a kernel INTERNAL_ERROR from process without disposing', async () => {
    const real = await kernel();
    let fail = true;
    let disposes = 0;
    const adapter = createStrokeMeshPortFromExports({
      ...real,
      stroke_v0_process: (length) => {
        if (!fail) return real.stroke_v0_process(length);
        fail = false;
        idleProcess(real);
        return 6;
      },
      stroke_v0_dispose: () => {
        disposes += 1;
        return real.stroke_v0_dispose();
      },
    });
    expect(adapter.buildStrokeMeshes([line()])).toEqual(INTERNAL);
    expect(disposes).toBe(0);
    expect(adapter.buildStrokeMeshes([line()]).status).toBe('ok');
    adapter.dispose();
    expect(disposes).toBe(1);
  });

  it('maps every published path status 2-7 to its code and fails closed on 8', async () => {
    const codes = [
      'invalid-path',
      'invalid-tolerance',
      'numeric-range',
      'work-limit',
      'unsupported-geometry',
      'invalid-stroke',
    ];
    for (const [offset, code] of codes.entries()) {
      const real = await kernel();
      const adapter = createStrokeMeshPortFromExports({
        ...real,
        stroke_v0_process: (length) => {
          const status = real.stroke_v0_process(length);
          if (status === 0) {
            new DataView(real.memory.buffer, real.stroke_v0_output_ptr()).setUint32(
              144 + 4,
              offset + 2,
              true,
            );
          }
          return status;
        },
      });
      const result = adapter.buildStrokeMeshes([line(), grammarError()]);
      expect(result.status === 'ok' && result.results[1]).toEqual({
        requestId: 2,
        toleranceExponent: 4,
        status: 'failed',
        code,
      });
      adapter.dispose();
    }
  });
});

type Wrap = (real: StrokeKernelExports) => Partial<StrokeKernelExports>;

/** Runs one batch through wrapped exports and expects a fail-closed outcome. */
async function expectFailClosed(name: string, reason: string, wrap: Wrap): Promise<void> {
  const real = await kernel();
  let disposes = 0;
  const reasons: string[] = [];
  const adapter = createStrokeMeshPortFromExports(
    {
      ...real,
      ...wrap(real),
      stroke_v0_dispose: () => {
        disposes += 1;
        return real.stroke_v0_dispose();
      },
    },
    { onFailClosed: (breach) => reasons.push(breach) },
  );
  expect(adapter.buildStrokeMeshes([line(), grammarError()]), name).toEqual(INTERNAL);
  expect(reasons, name).toHaveLength(1);
  expect(reasons[0], name).toContain(reason);
  expect(disposes, name).toBe(1);
  expect(adapter.buildStrokeMeshes([line()]), name).toEqual(DISPOSED);
  expect(adapter.buildStrokeMeshes([]), name).toEqual(DISPOSED);
  expect(disposes, name).toBe(1);
}

/** Corrupts the published output of the successful process. */
function corrupt(edit: (view: DataView) => void): Wrap {
  return (real) => ({
    stroke_v0_process: (length) => {
      const status = real.stroke_v0_process(length);
      if (status === 0) edit(new DataView(real.memory.buffer, real.stroke_v0_output_ptr()));
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
      stroke_v0_process: (length) => {
        if (!fake) return real.stroke_v0_process(length);
        fake = false;
        idleProcess(real);
        return status;
      },
    };
  };
}

describe('stroke-v0 adapter fails closed', () => {
  // Output of [line (ok), grammarError (failed)]: records at 64 and 144, the line's block at
  // 224. The block's index and boundary sections follow its vertex count.
  const OK_RECORD = 64;
  const FAILED_RECORD = 144;
  const BLOCK = 224;
  const vertexCount = (view: DataView): number => view.getUint32(OK_RECORD + 20, true);
  const indicesAt = (view: DataView): number => BLOCK + 16 * vertexCount(view);
  const boundaryAt = (view: DataView): number =>
    indicesAt(view) + 4 * view.getUint32(OK_RECORD + 24, true);

  const COUNTS = 'an OK record has inconsistent counts or offsets';
  const HEADER = 'output header is inconsistent';
  const NON_OK = 'a non-OK record carries mesh fields';
  const REQUIREMENT = 'OUTPUT_CAPACITY without a larger exact requirement';
  const triggers: readonly [string, string, Wrap][] = [
    [
      'WASM trap',
      'unreachable',
      () => ({
        stroke_v0_process: () => {
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
        stroke_v0_reserve: () => {
          real.stroke_v0_reserve(0, 0);
          return 6;
        },
      }),
    ],
    [
      'reserve INVALID_BATCH',
      'reserve returned status 1',
      (real) => ({
        stroke_v0_reserve: () => {
          real.stroke_v0_reserve(0, 0);
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
          stroke_v0_process: (length) => {
            const status = real.stroke_v0_process(length);
            converted = status === 0;
            return converted ? 2 : status;
          },
          stroke_v0_result_len: () => (converted ? 0 : real.stroke_v0_result_len()),
          stroke_v0_required_output_bytes: () =>
            converted
              ? real.stroke_v0_output_capacity() + 8
              : real.stroke_v0_required_output_bytes(),
        };
      },
    ],
    [
      'OUTPUT_CAPACITY with zero requirement',
      REQUIREMENT,
      fakeProcess(2, () => ({ stroke_v0_required_output_bytes: () => 0 })),
    ],
    [
      'OUTPUT_CAPACITY not larger than the capacity',
      REQUIREMENT,
      fakeProcess(2, (real) => ({
        stroke_v0_required_output_bytes: () => real.stroke_v0_output_capacity(),
      })),
    ],
    [
      'OUTPUT_CAPACITY above the cap',
      REQUIREMENT,
      fakeProcess(2, () => ({ stroke_v0_required_output_bytes: () => 256 * 1024 * 1024 + 8 })),
    ],
    [
      'RESOURCE_LIMIT with a requirement',
      'RESOURCE_LIMIT published an output requirement',
      fakeProcess(5, () => ({ stroke_v0_required_output_bytes: () => 8 })),
    ],
    [
      'epoch advanced twice',
      'memory epoch did not advance exactly once',
      (real) => ({
        stroke_v0_process: (length) => {
          idleProcess(real);
          return real.stroke_v0_process(length);
        },
      }),
    ],
    [
      'epoch not advanced',
      'memory epoch did not advance exactly once',
      (real) => {
        let reported: number | null = null;
        return {
          stroke_v0_process: (length) => {
            const before = real.stroke_v0_memory_epoch();
            const status = real.stroke_v0_process(length);
            reported = before;
            return status;
          },
          stroke_v0_memory_epoch: () => reported ?? real.stroke_v0_memory_epoch(),
        };
      },
    ],
    [
      'storage changed during process',
      'process changed linear-memory storage',
      (real) => ({
        stroke_v0_process: (length) => {
          const status = real.stroke_v0_process(length);
          real.memory.grow(1);
          return status;
        },
      }),
    ],
    [
      'failure published a result',
      'a failure published a readable result',
      fakeProcess(6, () => ({ stroke_v0_result_len: () => 64 })),
    ],
    [
      'result length below the header',
      'OK published an invalid result length',
      (real) => ({
        stroke_v0_result_len: () => (real.stroke_v0_result_len() === 0 ? 0 : 8),
      }),
    ],
    ['header magic', HEADER, corrupt((view) => view.setUint32(0, 0x304d_4756, true))],
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
      'unknown path status 8',
      corrupt((view) => view.setUint32(FAILED_RECORD + 4, 8, true)),
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
      corrupt((view) => view.setUint32(OK_RECORD + 32, 8, true)),
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
      corrupt((view) => view.setUint32(indicesAt(view), vertexCount(view), true)),
    ],
    [
      'boundary index out of range',
      'a boundary index is outside the vertices',
      corrupt((view) => view.setUint32(boundaryAt(view), vertexCount(view), true)),
    ],
    [
      'non-finite position',
      'a position is not finite',
      corrupt((view) => view.setFloat64(BLOCK, Number.NaN, true)),
    ],
    [
      'bounds mismatch',
      'bounds differ from the recomputed vertex bounds',
      corrupt((view) => view.setFloat64(OK_RECORD + 48, -7, true)),
    ],
    [
      'total beyond the blocks',
      'output total differs from the blocks',
      (real) => ({
        stroke_v0_reserve: (input, output) => real.stroke_v0_reserve(input, output + 64),
        stroke_v0_process: (length) => {
          const status = real.stroke_v0_process(length);
          if (status === 0) {
            const view = new DataView(real.memory.buffer, real.stroke_v0_output_ptr());
            view.setUint32(8, view.getUint32(8, true) + 8, true);
          }
          return status;
        },
        stroke_v0_result_len: () => {
          const length = real.stroke_v0_result_len();
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
    const adapter = createStrokeMeshPortFromExports(
      { ...real, stroke_v0_memory_epoch: () => 0xffff_ffff },
      { onFailClosed: (breach) => reasons.push(breach) },
    );
    expect(adapter.buildStrokeMeshes([line()])).toEqual(INTERNAL);
    expect(reasons).toEqual(['stroke memory epoch is exhausted']);
    expect(adapter.buildStrokeMeshes([line()])).toEqual(DISPOSED);
  });
});
