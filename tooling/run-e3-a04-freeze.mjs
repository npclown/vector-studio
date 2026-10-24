// D9 E3 unit E3-U2: the oracle-only freeze check of the A04 corpus
// (docs/plans/d9-e3-b4-precision-contract.md section 5.5). Manual, never CI.
//
//   pnpm e3-a04:freeze [--shards N] [--stride S] [--ids FILE]
//
// Starts N vitest shards of tests/geometry/e3-a04/freeze.check.ts (each a separate process),
// optionally checking only every S-th case, or only the case ids listed in FILE, one per line
// (a partial run, such as a rerun of a previous run's failures), then merges the shard results into
// summary.json under .tools/e3-a04-freeze/<UTC timestamp>/. It exits non-zero when any checked
// case is ORACLE-WORK, ORACLE-UNSUPPORTED, ORACLE-INCONSISTENT or ORACLE-ERROR, which fails the
// freeze (E3-Q6 (a)). No kernel runs.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const shards = option('--shards', Math.max(1, Math.min(12, os.cpus().length - 2)));
const stride = option('--stride', 1);
const idsAt = args.indexOf('--ids');
const idsFile = idsAt >= 0 ? path.resolve(args[idsAt + 1] ?? '') : null;
if (idsFile !== null && !existsSync(idsFile)) throw new Error(`--ids file ${idsFile} not found`);
if (!Number.isInteger(shards) || shards < 1 || !Number.isInteger(stride) || stride < 1)
  throw new Error('--shards and --stride take positive integers');

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const out = path.join(root, '.tools', 'e3-a04-freeze', stamp);
if (existsSync(out)) throw new Error(`output ${out} already exists`);
mkdirSync(out, { recursive: true });
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const started = Date.now();

const runShard = (shard) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [vitest, 'run', '--config', 'vitest.e3-a04-freeze.config.ts', '--reporter=dot'],
      {
        cwd: root,
        stdio: ['ignore', 'ignore', 'inherit'],
        env: {
          ...process.env,
          NODE_OPTIONS: '--max-old-space-size=6144',
          E3_A04_FREEZE_SHARD: `${shard}/${shards}`,
          E3_A04_FREEZE_STRIDE: String(stride),
          E3_A04_FREEZE_OUT: out,
          ...(idsFile === null ? {} : { E3_A04_FREEZE_IDS: idsFile }),
        },
      },
    );
    child.on('exit', (code) => resolve(code ?? 1));
  });

const codes = await Promise.all(Array.from({ length: shards }, (_, i) => runShard(i)));
const rows = [];
for (let i = 0; i < shards; i += 1) {
  const file = path.join(out, `shard-${i}.ndjson`);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) if (line) rows.push(JSON.parse(line));
}
rows.sort((a, b) => a.index - b.index);
const byStatus = {};
const byStratum = {};
let ms = 0;
let maxWork = 0;
for (const r of rows) {
  byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const s = (byStratum[r.stratum] ??= { cases: 0, ms: 0, statuses: {} });
  s.cases += 1;
  s.ms += r.ms;
  s.statuses[r.status] = (s.statuses[r.status] ?? 0) + 1;
  ms += r.ms;
  maxWork = Math.max(maxWork, r.work ?? 0);
}
const failures = rows.filter((r) => String(r.status).startsWith('ORACLE-'));
const summary = {
  corpus: 'a04-corpus/v1',
  stride,
  ids: idsFile,
  shards,
  shardExitCodes: codes,
  checked: rows.length,
  byStatus,
  byStratum,
  failures: failures.map((r) => ({ index: r.index, id: r.id, status: r.status, detail: r.detail })),
  caseMilliseconds: ms,
  wallMilliseconds: Date.now() - started,
  maxWork,
  node: process.version,
  os: `${os.type()} ${os.release()}`,
  cpus: os.cpus().length,
};
writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, failures: failures.slice(0, 20) }, null, 2));
console.log(`summary: ${path.join(out, 'summary.json')}`);
process.exitCode = failures.length > 0 || codes.some((c) => c !== 0) ? 1 : 0;
