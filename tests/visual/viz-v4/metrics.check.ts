// V-4 unit VZ4-U2: the A08 offline metrics run (docs/plans/viz-v4-a08-corpus-contract.md,
// sections 5 and 7). It evaluates a headed run directory against Node's reference on the release
// WASM and writes record.json and record.md, or replays a record (VZ4-A9). Both refuse before the
// E3 freeze record (E3 section 5.5), because they run the kernel on corpus cases. Manual, never CI:
//
//   pnpm coverage:viz-v4 --run <dir> [--wasm <path>] [--out <dir>] [--label <text>]
//   pnpm coverage:viz-v4 --replay <record dir> [--run <dir>] [--wasm <path>]
//
// (tooling/run-viz-v4-metrics.mjs), which passes its flags through the environment.
import path from 'node:path';
import { it } from 'vitest';

import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../../packages/geometry-wasm/src/index.js';
import { replayRecord, runMetrics, type Ports } from './runner.js';
import { a08Subset } from './subset.js';

const root = path.resolve(import.meta.dirname, '../../..');

async function loadPorts(bytes: Uint8Array): Promise<Ports> {
  const module = await WebAssembly.compile(new Uint8Array(bytes));
  return { fill: await createFillMeshPort(module), stroke: await createStrokeMeshPort(module) };
}

const env = (name: string) => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

it('evaluates or replays the A08 metrics', async () => {
  const replay = env('VIZ_V4_REPLAY');
  const run = env('VIZ_V4_RUN');
  const wasm = env('P2_WASM_PATH');
  const expected = env('VIZ_V4_EXPECTED');
  const common = { root, subset: a08Subset(), loadPorts };
  if (replay !== undefined) {
    const result = await replayRecord({
      ...common,
      recordDir: path.resolve(replay),
      ...(run === undefined ? {} : { runDir: path.resolve(run) }),
      ...(wasm === undefined ? {} : { wasmPath: path.resolve(wasm) }),
      ...(expected === undefined ? {} : { expectedPath: path.resolve(expected) }),
    });
    if (!result.identical) throw new Error(`VZ4-A9 replay differs: ${String(result.reason)}`);
    process.stdout.write(`VZ4-A9 replay byte-identical: ${replay}\n`);
    return;
  }
  if (run === undefined) throw new Error('--run <dir> or --replay <record dir> is required');
  if (wasm === undefined) throw new Error('P2_WASM_PATH is required');
  const outDir = env('VIZ_V4_OUT');
  if (outDir === undefined) throw new Error('VIZ_V4_OUT is required');
  const label = env('VIZ_V4_LABEL');
  const { body } = await runMetrics({
    ...common,
    runDir: path.resolve(run),
    wasmPath: path.resolve(wasm),
    expectedPath: path.resolve(
      expected ?? path.join(root, 'tests/visual/viz-v4/a08-expected-status.json'),
    ),
    outDir: path.resolve(outDir),
    ...(label === undefined ? {} : { label }),
  });
  process.stdout.write(`A08 metrics ${body.label}: ${body.result} -> ${outDir}\n`);
});
