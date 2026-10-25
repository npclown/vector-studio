// V-4 unit VZ4-U3: runs the A08 headed corpus spec (tests/gpu/viz-v4-a08-corpus.spec.ts) in
// headed Chrome and Edge with one run id, so both browsers write under one
// artifacts/viz-v4-a08/<run>/ for `pnpm coverage:viz-v4 --run`. Before it starts, it checks that
// the built geometry-wasm package (the page imports its dist) carries the same fill and stroke
// revisions as its source, since `pnpm test:geometry` rebuilds the WASM but not dist. Extra
// arguments go to Playwright. Manual, never CI; the spec refuses before the E3 freeze record.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function revision(file, name) {
  if (!existsSync(file)) return null;
  const match = new RegExp(`${name} = (\\d+)`, 'u').exec(readFileSync(file, 'utf8'));
  return match === null ? null : Number(match[1]);
}

for (const [adapter, name] of [
  ['fill-adapter', 'FILL_V0_REVISION'],
  ['stroke-adapter', 'STROKE_V0_REVISION'],
]) {
  const source = revision(path.join(root, `packages/geometry-wasm/src/${adapter}.ts`), name);
  const built = revision(path.join(root, `packages/geometry-wasm/dist/${adapter}.js`), name);
  if (source === null) throw new Error(`no ${name} in packages/geometry-wasm/src/${adapter}.ts`);
  if (built !== source)
    throw new Error(
      `packages/geometry-wasm/dist/${adapter}.js has ${name} ${String(built)}, source has ${String(source)}: run pnpm build first`,
    );
}

const runId =
  process.env.VIZ_V4_RUN_ID ??
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`;
console.log(`viz-v4 run id: ${runId}`);
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'playwright',
    'test',
    '--config',
    'playwright.gpu.config.ts',
    'tests/gpu/viz-v4-a08-corpus.spec.ts',
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, VIZ_V4_RUN_ID: runId },
  },
);
process.exit(result.status ?? 1);
