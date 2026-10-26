// E17-A4: runs the snap-model check (tests/geometry/e17/snap-model.check.ts)
// on the release WASM that `pnpm test:geometry` builds, or on --wasm <path>. Manual, never CI.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const at = args.indexOf('--wasm');
const wasm = path.resolve(
  at >= 0
    ? args[at + 1]
    : path.join(
        root,
        '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
      ),
);
if (!existsSync(wasm))
  throw new Error(`no release WASM at ${wasm}: run pnpm test:geometry first, or pass --wasm`);
const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--config', 'vitest.e17-snap-model.config.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, P2_WASM_PATH: wasm },
  },
);
process.exit(result.status ?? 1);
