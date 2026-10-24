// V-4 unit VZ4-U1: the Node pre-run of section 5.1 (docs/plans/viz-v4-a08-corpus-contract.md).
// It runs the product CPU path on the release WASM for every A08 case and variant and writes the
// expected statuses (KERNEL-REJECTED, REGION-ONLY, RENDERER-FAILED, EMPTY-CROP or RENDERED), with
// Node's port calls (request SHA-256 and mesh digest), that the headed run is compared against.
// It refuses to run before the E3 freeze record (E3 section 5.5), so no kernel output on the
// corpus is read before the freeze. Manual, never CI:
//
//   pnpm viz-v4:expected [--wasm <path>]
//
// (tooling/run-viz-v4-expected.mjs), which writes tests/visual/viz-v4/a08-expected-status.json.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';

import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../../packages/geometry-wasm/src/index.js';
import { a04FreezeRecorded, expectedEntry, type ExpectedEntry, VIZ_V4_VARIANTS } from './cases.js';
import { a08Subset, summarizeA08Subset } from './subset.js';

const root = path.resolve(import.meta.dirname, '../../..');

it('writes the A08 expected statuses', async () => {
  if (!a04FreezeRecorded(root))
    throw new Error(
      'refusing the A08 pre-run: the E3 contract has no freeze record for a04-corpus/v1',
    );
  const wasm = process.env.P2_WASM_PATH;
  if (wasm === undefined) throw new Error('P2_WASM_PATH is required');
  const bytes = new Uint8Array(readFileSync(wasm));
  const module = await WebAssembly.compile(bytes);
  const ports = {
    fill: await createFillMeshPort(module),
    stroke: await createStrokeMeshPort(module),
  };
  const cases = a08Subset();
  const statuses: Record<string, Record<string, ExpectedEntry>> = {};
  for (const c of cases)
    statuses[c.key] = Object.fromEntries(
      VIZ_V4_VARIANTS.map((variant) => [variant, expectedEntry(c, ports, variant)]),
    );
  const out = {
    version: 'a08-expected-status/v1',
    subsetKeysSha256: summarizeA08Subset(cases).keysSha256,
    wasmSha256: createHash('sha256').update(bytes).digest('hex'),
    statuses,
  };
  writeFileSync(
    path.join(root, 'tests/visual/viz-v4/a08-expected-status.json'),
    `${JSON.stringify(out, null, 2)}\n`,
  );
});
