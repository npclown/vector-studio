// X1 A05/A06 evidence run (docs/plans/d9-e11-p3-c03-c05-closure-contract.md, sections 3.2 and
// 7.1). Manual, never CI.
//
//   pnpm p3-exit:a05-a06 [--label PRE-FREEZE|<snapshot short SHA>] [--wasm <path>]
//                        [--rustup <path>] [--check]
//
// Runs only the tests that tooling/p3-exit-a05-a06-map.json names: the kernel test modules with
// the pinned Rust (cargo test), the unit files with vitest.config.ts and the geometry files with
// vitest.geometry.config.ts against the release WASM that `pnpm test:geometry` builds (or
// --wasm). Writes result.json and summary.md with provenance to
// .tools/p3-exit-a05-a06/<stamp>-<run id>/; the dated record under docs/evidence/ is copied
// from summary.md. Headed entries are listed and must be cited from their PC run.
//
// --check only validates the map. The label defaults to PRE-FREEZE: a run counts for the exit
// only on a commit whose identities equal the E11 exit snapshot record (section 3.2). Exits
// non-zero when a required entry fails.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkMap,
  evaluate,
  parseCargoTests,
  renderMarkdown,
  vitestTests,
} from './p3-exit-a05-a06.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const map = JSON.parse(read('tooling/p3-exit-a05-a06-map.json'));
const problems = checkMap(map, { exists: (p) => existsSync(path.join(root, p)), read });
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
if (args.includes('--check')) {
  console.log('p3-exit-a05-a06 map: OK');
  process.exit(0);
}

const label = value('--label') ?? 'PRE-FREEZE';
if (label !== 'PRE-FREEZE' && !/^[0-9a-f]{7,40}$/u.test(label))
  throw new Error('--label takes PRE-FREEZE or the snapshot short SHA');
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.trim();
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain') !== '';
if (label !== 'PRE-FREEZE') {
  if (dirty) throw new Error('a snapshot-labelled run needs a clean tree (E11 section 3.2)');
  if (
    !read('docs/plans/d9-e11-p3-c03-c05-closure-contract.md').includes('**Exit snapshot record**')
  )
    throw new Error('refusing a snapshot label: E11 has no "**Exit snapshot record**" line yet');
}

const wasm = path.resolve(
  value('--wasm') ??
    path.join(
      root,
      '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
    ),
);
if (!existsSync(wasm))
  throw new Error(`no release WASM at ${wasm}: run pnpm test:geometry first, or pass --wasm`);
const cache = path.join(root, '.tools');
const cargoHome = process.env.CARGO_HOME || path.join(cache, 'rust/cargo');
const rustup =
  value('--rustup') ??
  path.join(cargoHome, process.platform === 'win32' ? 'bin/rustup.exe' : 'bin/rustup');
if (!existsSync(rustup)) throw new Error(`no rustup at ${rustup}: pass --rustup`);
const toolchainEnv = value('--rustup')
  ? {}
  : {
      CARGO_HOME: cargoHome,
      RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(cache, 'rust/rustup'),
    };

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const runId = randomBytes(4).toString('hex');
const out = path.join(cache, 'p3-exit-a05-a06', `${stamp}-${runId}`);
mkdirSync(out, { recursive: true });

const entries = [...map.criteria.A05, ...map.criteria.A06];
const results = {};

const rustc = spawnSync(rustup, ['run', '1.94.1', 'rustc', '--version', '--verbose'], {
  cwd: root,
  env: { ...process.env, ...toolchainEnv },
  encoding: 'utf8',
});
if (rustc.status !== 0) throw new Error(rustc.stderr || 'pinned Rust 1.94.1 is unavailable');
const host = /host: (\S+)/u.exec(rustc.stdout)?.[1] ?? 'unknown';
const filters = entries.filter((e) => e.runner === 'cargo').map((e) => e.filter);
console.log(`> cargo test -- ${filters.join(' ')}`);
const cargo = spawnSync(
  rustup,
  [
    'run',
    '1.94.1',
    'cargo',
    'test',
    '--manifest-path',
    path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml'),
    '--locked',
    '--offline',
    '--lib',
    '--',
    ...filters,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      ...toolchainEnv,
      CARGO_TARGET_DIR: path.join(cache, 'p3-exit-a05-a06-build'),
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);
writeFileSync(path.join(out, 'cargo.log'), `${cargo.stdout}\n${cargo.stderr}`);
results.cargo = { ok: cargo.status === 0, tests: parseCargoTests(cargo.stdout) };

for (const [runner, config] of [
  ['unit', 'vitest.config.ts'],
  ['geometry', 'vitest.geometry.config.ts'],
]) {
  const files = [...new Set(entries.filter((e) => e.runner === runner).map((e) => e.file))];
  const report = path.join(out, `${runner}.json`);
  console.log(`> vitest run --config ${config} ${files.join(' ')}`);
  const run = spawnSync(
    process.execPath,
    [
      path.join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      config,
      '--reporter=json',
      `--outputFile=${report}`,
      ...files,
    ],
    {
      cwd: root,
      env: { ...process.env, P2_WASM_PATH: wasm, P2_NATIVE_RUSTUP: rustup },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  writeFileSync(path.join(out, `${runner}.log`), `${run.stdout}\n${run.stderr}`);
  results[runner] = existsSync(report)
    ? {
        ok: run.status === 0,
        tests: vitestTests(JSON.parse(readFileSync(report, 'utf8')), root),
      }
    : { ok: false, tests: [] };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const operation = (file, name) =>
  new RegExp(`export const ${name} = '([^']+)'`, 'u').exec(read(file))?.[1] ?? 'unknown';
const provenance = {
  label,
  runId,
  identities: {
    'Run commit': commit,
    'Clean tree': dirty ? 'no' : 'yes',
    'Fill operation': operation(
      'packages/geometry-wasm/src/fill-adapter.ts',
      'FILL_V0_OPERATION_ID',
    ),
    'Stroke operation': operation(
      'packages/geometry-wasm/src/stroke-adapter.ts',
      'STROKE_V0_OPERATION_ID',
    ),
    'Release WASM SHA-256': sha256(readFileSync(wasm)),
    'Map SHA-256': sha256(readFileSync(path.join(root, 'tooling/p3-exit-a05-a06-map.json'))),
    'Rust host': host,
    Node: process.version,
    OS: `${os.type()} ${os.release()} ${os.arch()}`,
  },
};
const evaluation = evaluate(map, results);
writeFileSync(
  path.join(out, 'result.json'),
  `${JSON.stringify({ provenance, ...evaluation }, null, 2)}\n`,
);
writeFileSync(path.join(out, 'summary.md'), renderMarkdown(evaluation, provenance));
console.log(renderMarkdown(evaluation, provenance));
console.log(`Wrote ${path.relative(root, out)}`);
const failed = evaluation.rows.some(
  (row) => row.entry.kind === 'required' && row.verdict === 'FAIL',
);
process.exit(failed ? 1 : 0);
