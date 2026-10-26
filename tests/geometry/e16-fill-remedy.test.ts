import type { FillMeshRequest } from '@vector-studio/contracts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFillMeshPort } from '../../packages/geometry-wasm/src/index.js';
import { checkMeshStructure } from './p3-exit-sweep/structure.js';

// D9 E16-U1 (docs/plans/d9-e16-fill-rejection-remedy-contract.md, section 7): E16-A7, the
// release WASM meshes E16-F1 (rung 0 over B1's source caps), E16-F2 (the exact rung's line-only
// caps) and E16-F5 (E16-K2's refinement retries) through the adapter, each mesh passing the
// independent E11 structure checker; E16-F8 and E16-F9 keep their failure codes. The fixtures
// are the corpus requests of tests/fixtures/e16-fill-remedy-v1.txt; the native fixture table
// (E16-A2) is `e16_fill_remedy_tests.rs`. Functional evidence; precision stays UNVERIFIED.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let module: WebAssembly.Module;
let fixtures: Map<string, Omit<FillMeshRequest, 'requestId'>>;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
  const text = await readFile(path.join(root, 'tests/fixtures/e16-fill-remedy-v1.txt'), 'utf8');
  fixtures = new Map();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const [name, , exponent, rule, verbs, scalars] = line.split('\t');
    const bits = new BigUint64Array(scalars!.split(',').map((value) => BigInt(`0x${value}`)));
    fixtures.set(name!, {
      verbs: new Uint8Array(verbs!.split(',').map(Number)),
      points: new Float64Array(bits.buffer),
      fillRule: rule === 'evenodd' ? 'evenodd' : 'nonzero',
      toleranceExponent: Number(exponent),
    });
  }
});

const request = (requestId: number, name: string): FillMeshRequest => ({
  requestId,
  ...fixtures.get(name)!,
});

describe('E16-U1 source caps and refinement through the release WASM', () => {
  it('meshes E16-F1, E16-F2 and E16-F5 with valid structure (E16-A7)', async () => {
    const adapter = await createFillMeshPort(module);
    const names = ['E16-F1', 'E16-F2', 'E16-F5'];
    const batch = adapter.buildFillMeshes(names.map((name, index) => request(index, name)));
    expect(batch.status).toBe('ok');
    if (batch.status === 'ok')
      batch.results.forEach((result, index) => {
        const name = names[index];
        expect(result.status, name).toBe('ok');
        if (result.status !== 'ok') return;
        expect(result.mesh.indices.length, name).toBeGreaterThan(0);
        expect(checkMeshStructure(result.mesh).issues, name).toEqual([]);
      });
    adapter.dispose();
  });

  it('keeps E16-F8 unsupported-geometry and E16-F9 work-limit', async () => {
    const adapter = await createFillMeshPort(module);
    const batch = adapter.buildFillMeshes([request(1, 'E16-F8'), request(2, 'E16-F9')]);
    expect(batch.status).toBe('ok');
    if (batch.status === 'ok') {
      expect(batch.results[0]).toMatchObject({ status: 'failed', code: 'unsupported-geometry' });
      expect(batch.results[1]).toMatchObject({ status: 'failed', code: 'work-limit' });
    }
    adapter.dispose();
  });
});
