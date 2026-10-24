// V-4 unit VZ4-U2: runs the A08 offline metrics (tests/visual/viz-v4/metrics.check.ts) on a
// headed run directory, on the release WASM that `pnpm test:geometry` builds or on --wasm <path>,
// and writes record.json and record.md to --out (default .tools/viz-v4-metrics/<stamp>/), or
// replays a record with --replay <record dir> (VZ4-A9). Manual, never CI. The check itself
// refuses before the E3 corpus freeze record.
//
//   pnpm coverage:viz-v4 --run <dir> [--wasm <path>] [--out <dir>] [--label <text>] [--expected <path>]
//   pnpm coverage:viz-v4 --replay <record dir> [--run <dir>] [--wasm <path>] [--expected <path>]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = new Set(['--run', '--wasm', '--out', '--replay', '--label', '--expected']);
const values = {};
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  if (flag === '--') continue;
  if (!flags.has(flag)) throw new Error(`unknown flag ${flag}`);
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  values[flag] = value;
  index += 1;
}
const replay = values['--replay'];
if (replay === undefined && values['--run'] === undefined)
  throw new Error('pass --run <dir> or --replay <record dir>');
const wasm =
  values['--wasm'] === undefined
    ? replay === undefined
      ? path.join(
          root,
          '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
        )
      : undefined
    : path.resolve(values['--wasm']);
if (wasm !== undefined && !existsSync(wasm))
  throw new Error(`no release WASM at ${wasm}: run pnpm test:geometry first, or pass --wasm`);
const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
const out = path.resolve(values['--out'] ?? path.join(root, '.tools/viz-v4-metrics', stamp));
const env = {
  ...process.env,
  VIZ_V4_RUN: values['--run'] === undefined ? '' : path.resolve(values['--run']),
  VIZ_V4_REPLAY: replay === undefined ? '' : path.resolve(replay),
  VIZ_V4_OUT: replay === undefined ? out : '',
  VIZ_V4_LABEL: values['--label'] ?? '',
  VIZ_V4_EXPECTED: values['--expected'] === undefined ? '' : path.resolve(values['--expected']),
  P2_WASM_PATH: wasm ?? '',
};
const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--config', 'vitest.viz-v4-metrics.config.ts'],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env },
);
process.exit(result.status ?? 1);
