import type { FillMeshRequest } from '@vector-studio/contracts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFillMeshPortFromExports,
  type FillKernelExports,
} from '../../packages/geometry-wasm/src/fill-adapter.js';
import { checkMeshStructure } from './p3-exit-sweep/structure.js';

// D9 E14-U2 X-U1 (docs/plans/d9-e14-u2-fill-exact-edge-cap-contract.md, section 9): X-A3 and
// X-A6. The release WASM meshes the large-tier fixtures X-F1b, X-F2, X-F3 and X-F5 through the
// adapter, each mesh passing the independent E11 structure checker. X-F7 (exactly EX flat
// edges) stops at the rounded arrangement's event cap, as natively (a listed stop, recorded in
// the X-U1 evidence), and returns work-limit. The test also records the stack peak of the
// batch: the kernel's stack is the first 1 MiB of linear memory (wasm-ld's stack-first layout,
// checked through `__data_end`), painted before the batch and scanned for the lowest
// overwritten byte after it. The fixtures are written by the native test
// `e14u2_wasm_fixture_file_matches_the_literals`. Functional evidence; precision stays
// UNVERIFIED.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STACK_TOP = 1 << 20;
const PAINT_FROM = 1024;
const PAINT = 0xa5;

let module: WebAssembly.Module;
let fixtures: Map<string, Omit<FillMeshRequest, 'requestId'>>;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
  const text = await readFile(
    path.join(root, 'tests/fixtures/e14u2-fill-large-tier-v1.txt'),
    'utf8',
  );
  fixtures = new Map();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const [name, exponent, rule, verbs, scalars] = line.split('\t');
    const bits = new BigUint64Array(scalars!.split(',').map((value) => BigInt(`0x${value}`)));
    fixtures.set(name!, {
      verbs: new Uint8Array(verbs!.split(',').map(Number)),
      points: new Float64Array(bits.buffer),
      fillRule: rule === 'evenodd' ? 'evenodd' : 'nonzero',
      toleranceExponent: Number(exponent),
    });
  }
});

const MESHED = [
  'X-F1b/e0',
  'X-F2/e-2',
  'X-F2/e-3',
  'X-F2/e-4',
  'X-F3/e-2',
  'X-F3/e-3',
  'X-F3/e-4',
  'X-F5/e-3',
];

describe('E14-U2 large tier through the release WASM', () => {
  it('meshes the large-tier fixtures with valid structure and records the stack peak (X-A3, X-A6)', async () => {
    const instance = await WebAssembly.instantiate(module, {});
    const exports = instance.exports as unknown as FillKernelExports & {
      memory: WebAssembly.Memory;
      __data_end: WebAssembly.Global;
    };
    // Stack-first: static data starts above the 1 MiB stack.
    expect(Number(exports.__data_end.value)).toBeGreaterThan(STACK_TOP);
    const adapter = createFillMeshPortFromExports(exports);
    const names = [...MESHED, 'X-F7/e-4'];
    expect(names.every((name) => fixtures.has(name))).toBe(true);
    // Warm the reservation, then paint the idle stack and run the measured batch.
    const requests = names.map((name, index) => ({ requestId: index, ...fixtures.get(name)! }));
    expect(adapter.buildFillMeshes(requests.slice(0, 1)).status).toBe('ok');
    new Uint8Array(exports.memory.buffer, PAINT_FROM, STACK_TOP - PAINT_FROM).fill(PAINT);
    const batch = adapter.buildFillMeshes(requests);
    const stack = new Uint8Array(exports.memory.buffer, 0, STACK_TOP);
    let low = PAINT_FROM;
    while (low < STACK_TOP && stack[low] === PAINT) low += 1;
    const peak = STACK_TOP - low;
    console.log(`E14-U2 X-A6 stack peak: ${peak} B of ${STACK_TOP - PAINT_FROM} B painted`);
    // The painted region was not exhausted, so the measured peak is a true low-water mark.
    expect(low).toBeGreaterThan(PAINT_FROM);
    expect(batch.status).toBe('ok');
    if (batch.status === 'ok') {
      batch.results.forEach((result, index) => {
        const name = names[index]!;
        if (name === 'X-F7/e-4') {
          // E38 (2026-11-07): the large tier still stops on X-F7, and the robust last rung
          // (`fill-v0+r6`) meshes it, with no boundary edges.
          expect(result.status, name).toBe('ok');
          if (result.status === 'ok') expect(result.mesh.boundaryEdges.length, name).toBe(0);
          return;
        }
        expect(result.status, name).toBe('ok');
        if (result.status !== 'ok') return;
        expect(result.mesh.indices.length, name).toBeGreaterThan(0);
        expect(checkMeshStructure(result.mesh).issues, name).toEqual([]);
      });
    }
    adapter.dispose();
  });
});
