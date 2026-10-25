// D9 E3 unit E3-U2: the oracle-only freeze check of the A04 corpus
// (docs/plans/d9-e3-b4-precision-contract.md section 5.5). Manual, never CI.
//
//   pnpm e3-a04:freeze [--shards N] [--stride S] [--ids FILE] [--only i,j,…]
//   pnpm e3-a04:freeze --merge <dir>,<dir>,… [--shards N] [--stride S] [--ids FILE]
//
// Starts N vitest shards of tests/geometry/e3-a04/freeze.check.ts (each a separate process),
// optionally checking only every S-th case, or only the case ids listed in FILE, one per line
// (a partial run, such as a rerun of a previous run's failures), then merges the shard results into
// summary.json under .tools/e3-a04-freeze/<UTC timestamp>/. It exits non-zero when any checked
// case is ORACLE-WORK, ORACLE-UNSUPPORTED, ORACLE-INCONSISTENT or ORACLE-ERROR, which fails the
// freeze (E3-Q6 (a)). No kernel runs.
//
// Several hosts can share one check (contract section 19): each runs `--only` its shards of the
// same N on the same oracle, and one host merges their directories with `--merge`, which checks
// that the oracle and options agree and that every shard is there exactly once. A shard whose
// worker dies (a heap limit) is restarted after the case it was checking, which is ORACLE-ERROR.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const idsArg = idsAt >= 0 ? args[idsAt + 1] : null;
if (idsArg === undefined || (idsArg !== null && idsArg.startsWith('--')))
  throw new Error('--ids takes a file');
const idsFile = idsArg === null ? null : path.resolve(idsArg);
if (idsFile !== null && !existsSync(idsFile)) throw new Error(`--ids file ${idsFile} not found`);
if (idsFile !== null && args.includes('--stride'))
  throw new Error('--stride and --ids cannot be combined');
if (!Number.isInteger(shards) || shards < 1 || !Number.isInteger(stride) || stride < 1)
  throw new Error('--shards and --stride take positive integers');
const listArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]?.split(',') : undefined;
};
const mergeDirs = listArg('--merge')?.map((d) => path.resolve(d));
const only = listArg('--only')?.map(Number);
if (only !== undefined && !only.every((i) => Number.isInteger(i) && i >= 0 && i < shards))
  throw new Error(`--only takes shard indices from 0 to ${shards - 1}`);
if (only !== undefined && mergeDirs !== undefined)
  throw new Error('--only and --merge cannot be combined');
const here = only === undefined ? Array.from({ length: shards }, (_, i) => i) : [...new Set(only)];
const partial = here.length < shards;
const oraclePath = 'packages/geometry-reference/src/a04-region.ts';
// What every host of one check must share; `--merge` compares these field by field.
const common = {
  oracleSha256: createHash('sha256')
    .update(readFileSync(path.join(root, oraclePath)))
    .digest('hex'),
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  shards,
  stride,
  ids: idsFile === null ? null : createHash('sha256').update(readFileSync(idsFile)).digest('hex'),
};

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const out = path.join(root, '.tools', 'e3-a04-freeze', stamp);
if (existsSync(out)) throw new Error(`output ${out} already exists`);
mkdirSync(out, { recursive: true });
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const started = Date.now();

const MAX_RESTARTS = 64;
const runOnce = (shard, resume) =>
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
          ...(resume === undefined ? {} : { E3_A04_FREEZE_RESUME: resume }),
        },
      },
    );
    child.on('exit', (code) => resolve(code ?? 1));
  });
const restarts = Array.from({ length: shards }, () => []);
const runShard = async (shard) => {
  const current = path.join(out, `shard-${shard}.current`);
  let resume;
  for (;;) {
    const code = await runOnce(shard, resume);
    if (code === 0 || !existsSync(current) || restarts[shard].length >= MAX_RESTARTS) return code;
    const at = Number(readFileSync(current, 'utf8').trim());
    if (resume !== undefined && Number(resume.split(':')[0]) >= at) return code;
    restarts[shard].push(at);
    resume = `${at}:worker exited (code ${code}) while checking`;
  }
};

/** Copies the shard files of every host's directory into `out`, after checking they agree. */
function mergeHosts(dirs) {
  const seen = new Map();
  const hosts = dirs.map((dir) => {
    const h = JSON.parse(readFileSync(path.join(dir, 'host.json'), 'utf8'));
    for (const [k, v] of Object.entries(common))
      if (JSON.stringify(h[k]) !== JSON.stringify(v))
        throw new Error(
          `refusing the merge: ${dir} has ${k} ${JSON.stringify(h[k])}, here ${JSON.stringify(v)}`,
        );
    for (const i of h.shardsHere) {
      if (seen.has(i))
        throw new Error(`refusing the merge: shard ${i} is in ${seen.get(i)} and ${dir}`);
      seen.set(i, dir);
      copyFileSync(path.join(dir, `shard-${i}.ndjson`), path.join(out, `shard-${i}.ndjson`));
    }
    return h;
  });
  const missing = Array.from({ length: shards }, (_, i) => i).filter((i) => !seen.has(i));
  if (missing.length > 0)
    throw new Error(`refusing the merge: shards ${missing.join(', ')} are missing`);
  return hosts;
}

const hostInfo = {
  node: process.version,
  os: `${os.type()} ${os.release()}`,
  cpus: os.cpus().length,
};
const hosts = mergeDirs === undefined ? null : mergeHosts(mergeDirs);
const codes =
  hosts === null
    ? await Promise.all(here.map((i) => runShard(i)))
    : hosts.flatMap((h) => h.exitCodes);
if (partial) {
  const h = {
    ...common,
    ...hostInfo,
    shardsHere: here,
    exitCodes: codes,
    restarts: here.map((i) => restarts[i]),
    wallMilliseconds: Date.now() - started,
  };
  writeFileSync(path.join(out, 'host.json'), `${JSON.stringify(h, null, 2)}\n`);
  console.log(
    JSON.stringify({
      shardsHere: here,
      shardExitCodes: codes,
      wallMilliseconds: Date.now() - started,
    }),
  );
  console.log(`partial check: ${out} (merge with --merge on every host's directory)`);
  process.exit(codes.some((c) => c !== 0) ? 1 : 0);
}
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
  oracleSha256: common.oracleSha256,
  commit: common.commit,
  stride,
  ids: idsFile,
  shards,
  shardExitCodes: codes,
  shardRestarts: hosts === null ? restarts : hosts.flatMap((h) => h.restarts),
  checked: rows.length,
  byStatus,
  byStratum,
  failures: failures.map((r) => ({ index: r.index, id: r.id, status: r.status, detail: r.detail })),
  caseMilliseconds: ms,
  wallMilliseconds:
    hosts === null ? Date.now() - started : Math.max(...hosts.map((h) => h.wallMilliseconds)),
  maxWork,
  ...(hosts === null
    ? hostInfo
    : {
        hosts: hosts.map((h) => ({
          node: h.node,
          os: h.os,
          cpus: h.cpus,
          shards: h.shardsHere,
          wallMilliseconds: h.wallMilliseconds,
        })),
      }),
};
writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, failures: failures.slice(0, 20) }, null, 2));
console.log(`summary: ${path.join(out, 'summary.json')}`);
process.exitCode = failures.length > 0 || codes.some((c) => c !== 0) ? 1 : 0;
