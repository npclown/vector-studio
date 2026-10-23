// D9 E3 unit E3-U3: the A04 measurement run
// (docs/plans/d9-e3-b4-precision-contract.md sections 5.5, 7.1 and 7.4). Manual, never CI.
//
//   pnpm e3-a04:run [--stride S | --sample S] [--shards N] [--wasm FILE] [--run-id ID]
//                   [--record-root DIR] [--allow-dirty]
//
// It REFUSES to run unless the corpus freeze note exists and still describes the generator, the
// oracle and the corpus on disk (tooling/e3-a04-freeze-gate.mjs): the kernel must not run on
// `a04-corpus/v1` before the freeze (section 5.5). Then, in order:
//   1. the harness controls (E3-A5) run first; a control other than E3-PC12 (the GPU model check,
//      E3-U4) that is not met stops the run, because no corpus result may count before them;
//   2. N shards measure the corpus (every S-th case with --stride/--sample S) through the release
//      WASM ports, in separate vitest processes;
//   3. one process merges the shards, regenerates the corpus and checks its SHA-256 against the
//      freeze note (E3-Q4), builds the evidence record, validates it (E3-A7) and writes it under
//      docs/evidence/e3-a04/<UTC timestamp>-<run id>/ (never replacing an existing record).
// A stride above 1 is a sample run: it gives no A04 verdict (SAMPLE). A dirty tree is refused
// unless --allow-dirty, which writes under .tools/e3-a04-run and cannot be committed as evidence.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkFreeze } from './e3-a04-freeze-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (names, fallback) => {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
  }
  return fallback;
};

const gate = checkFreeze(root);
if (!gate.frozen) {
  console.error('e3-a04:run refuses to run: a04-corpus/v1 is not frozen.');
  for (const problem of gate.problems) console.error(`  - ${problem}`);
  console.error(
    'The kernel must not run on the corpus before the freeze note exists (contract section 5.5).',
  );
  process.exit(2);
}

const stride = Number(option(['--stride', '--sample'], '1'));
const shards = Number(
  option(['--shards'], String(Math.max(1, Math.min(12, os.cpus().length - 2)))),
);
if (!Number.isInteger(stride) || stride < 1 || !Number.isInteger(shards) || shards < 1) {
  console.error('--stride/--sample and --shards take positive integers');
  process.exit(2);
}

const wasm = path.resolve(
  option(
    ['--wasm'],
    process.env.P2_WASM_PATH ??
      path.join(
        root,
        '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
      ),
  ),
);
if (!existsSync(wasm)) {
  console.error(
    `release WASM not found: ${wasm}\nBuild it with pnpm test:geometry, or pass --wasm.`,
  );
  process.exit(2);
}

const git = (...a) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('exit', (code) => (code === 0 ? resolve(text.trim()) : reject(new Error(`git ${a}`))));
  });
const dirty = (await git('status', '--porcelain')).length > 0;
const allowDirty = flag('--allow-dirty');
if (dirty && !allowDirty) {
  console.error(
    'the working tree is dirty; a dirty run is not accepted as evidence (section 7.4).',
  );
  console.error(
    'Commit first, or pass --allow-dirty for a development run under .tools/e3-a04-run.',
  );
  process.exit(2);
}

const started = new Date();
const stamp = started.toISOString().replace(/[:.]/gu, '-');
const out = path.join(root, '.tools', 'e3-a04-run', stamp);
mkdirSync(out, { recursive: true });
const recordRoot = path.resolve(
  option(
    ['--record-root'],
    allowDirty ? path.join(out, 'records') : path.join(root, 'docs/evidence/e3-a04'),
  ),
);
const runId = option(['--run-id'], `r${stamp.replace(/-/gu, '').slice(0, 15)}`);
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const sha = createHash('sha256').update(readFileSync(wasm)).digest('hex');
console.log(`WASM ${wasm}\nWASM SHA-256 ${sha}\nstride ${stride}, shards ${shards}, output ${out}`);

const run = (mode, extra = {}) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [vitest, 'run', '--config', 'vitest.e3-a04-run.config.ts', '--reporter=dot'],
      {
        cwd: root,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          NODE_OPTIONS: '--max-old-space-size=6144',
          P2_WASM_PATH: wasm,
          E3_A04_RUN_MODE: mode,
          E3_A04_RUN_OUT: out,
          E3_A04_RUN_STRIDE: String(stride),
          E3_A04_RUN_SHARDS: String(shards),
          E3_A04_RUN_STARTED: started.toISOString(),
          E3_A04_RUN_ID: runId,
          E3_A04_RECORD_ROOT: recordRoot,
          E3_A04_ALLOW_DIRTY: allowDirty ? '1' : '0',
          ...extra,
        },
      },
    );
    child.on('exit', (code) => resolve(code ?? 1));
  });

// 1. The controls (E3-A5), before any corpus result.
if ((await run('controls')) !== 0) process.exit(1);
const controls = JSON.parse(readFileSync(path.join(out, 'controls.json'), 'utf8'));
const unmet = controls.filter((c) => !c.ok && c.id !== 'E3-PC12');
for (const c of controls)
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id} ${c.observed} ${c.detail}`);
if (unmet.length > 0) {
  console.error(`controls not met: ${unmet.map((c) => c.id).join(', ')}; no corpus case is run.`);
  process.exit(1);
}

// 2. The shards.
const codes = await Promise.all(
  Array.from({ length: shards }, (_, i) => run('shard', { E3_A04_RUN_SHARD: `${i}/${shards}` })),
);
if (codes.some((c) => c !== 0)) {
  console.error(`a shard failed (exit codes ${codes.join(', ')}); no record is written.`);
  process.exit(1);
}

// 3. The record.
if ((await run('finalize')) !== 0) process.exit(1);
console.log(readFileSync(path.join(out, 'record-path.txt'), 'utf8').trim());
