import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasm = path.join(
  root,
  '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
);
const run = (script, args = [], extraEnv = {}) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Geometry verification failed: ${result.status}`);
};

// Rebuild from the current sources, verify reproducibility and native/Node fixtures
// before the installed-browser runs. Never silently use a stale WASM artifact.
run(path.join(root, 'tooling/test-geometry.mjs'));
const digest = createHash('sha256').update(readFileSync(wasm)).digest('hex');
run(
  path.join(root, 'node_modules/@playwright/test/cli.js'),
  ['test', '--config', 'playwright.geometry.config.ts'],
  { P2_WASM_PATH: wasm, P2_WASM_SHA256: digest },
);
