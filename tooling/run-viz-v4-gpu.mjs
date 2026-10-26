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
// No shell: arguments reach Playwright as given. Under `pnpm test:gpu:viz-v4`, pnpm sets
// npm_execpath to its own entry point, run here by this Node; elsewhere pnpm is spawned by name,
// which Windows cannot do without a shell (pnpm.cmd), so there the script must run through pnpm.
const pnpmArgs = [
  'exec',
  'playwright',
  'test',
  '--config',
  'playwright.gpu.config.ts',
  'tests/gpu/viz-v4-a08-corpus.spec.ts',
  // pnpm passes a leading `--` through to the script; Playwright would read it as a file filter.
  ...process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--')),
];
const execPath = process.env.npm_execpath;
let command;
let commandArgs;
if (execPath !== undefined && execPath !== '' && /pnpm/u.test(path.basename(execPath))) {
  const script = /\.[cm]?js$/u.test(execPath);
  command = script ? process.execPath : execPath;
  commandArgs = script ? [execPath, ...pnpmArgs] : pnpmArgs;
} else if (process.platform === 'win32') {
  throw new Error('run this launcher through pnpm: pnpm test:gpu:viz-v4 [<playwright args>]');
} else {
  command = 'pnpm';
  commandArgs = pnpmArgs;
}
const result = spawnSync(command, commandArgs, {
  cwd: root,
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, VIZ_V4_RUN_ID: runId },
});
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
