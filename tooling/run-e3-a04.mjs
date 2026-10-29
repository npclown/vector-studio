// D9 E3 unit E3-U3: the A04 measurement run (docs/plans/d9-e3-b4-precision-contract.md section 7,
// executable form in section 15.8). Manual, never CI.
//
//   pnpm e3-a04:run --smoke [--wasm <path>]
//   pnpm e3-a04:run [--shards N] [--stride S] [--start-resolution K] [--gpu <chrome.json>,<edge.json>]
//                   [--wasm <path>] [--only i,j,…]
//   pnpm e3-a04:run --merge <run dir>,<run dir>,… [--shards N] [--stride S] [--start-resolution K]
//                   [--gpu …] [--wasm <path>] [--retried <retry dir>,…]
//   pnpm e3-a04:run --retry-cases i,j,… [--shards N] [--stride S] [--start-resolution K] [--heap MB]
//   pnpm e3-a04:run --supersede <record.json> --remeasured <retry dir>,… --identity <retry dir>,…
//                   --e20-commit <sha>
//                   [--shards N] [--stride S] [--start-resolution K] [--gpu …]
//
// Uses the release WASM that `pnpm test:geometry` builds (or --wasm <path>), then:
//
// - with --smoke, measures the smoke cases of section 15.6 (not corpus cases) and runs the
//   controls, into .tools/e3-a04-run/<stamp>/smoke.json;
// - otherwise measures the corpus in N vitest shards (each a separate process), then merges them
//   into record.json and record.md (section 15.7). It refuses to start until the contract holds
//   the freeze note of section 5.5 for this corpus (a "**Freeze record**" line with its
//   corpusSha256): no kernel output on the corpus is read before the freeze. A full run also needs
//   the oracle's freeze check record and refuses an oracle the contract withdraws (section 19.7). A full (stride 1),
//   clean run is copied to docs/evidence/e3-a04/<stamp>-<run id>/, never over an existing one.
//
// Several hosts can share one run (contract section 19): each runs `--only` its shards of the same
// N, on the same commit, WASM and options, and one host merges their run directories with
// `--merge`, which checks that their provenance agrees and that every shard is there exactly once,
// then finalizes. A host that runs only some shards does not finalize.
//
// A case whose worker died (a heap limit) is UNDECIDED. `--retry-cases` re-measures such cases by
// corpus index, with a larger `--heap`, into a retry directory; `--merge … --retried <dirs>` then
// replaces exactly those rows. Run directories may come from an earlier commit when the commits
// differ only in this tool, the run driver or documents (contract section 22).
//
// `--supersede` writes a record that replaces the committed 2026-10-27 record
// (docs/plans/d9-e20-a04-remedies-contract.md, E20-K9 and K10). It runs on the measurement branch
// (7443c2b plus E20's harness, tool and documents) and starts from that record's rows. The
// `--remeasured` retry directories re-measure the rows E20 names; each replaces the old row of the
// same index and id, which it keeps as `former`. The `--identity` directories re-measure the
// stride-25 sample of the decided rows, which must come out identical apart from `ms` and the
// form of `+∞` (E20-A5). The old record's hosts, retries and GPU check are carried forward.
//
// It exits non-zero when a shard fails, the validator finds a problem, or (smoke) a control or
// an expected PASS is not met. The verdict is the measured disposition; A04 acceptance is the
// Primary's after an independent evidence review (section 7.4).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const smoke = args.includes('--smoke');
const shards = Number(value('--shards') ?? Math.max(1, Math.min(12, os.cpus().length - 2)));
const stride = Number(value('--stride') ?? 1);
const gpu = value('--gpu');
// The oracle's starting resolution 2^-K px (default K = 10, r_m of contract section 4.3). It still
// halves while E straddles a threshold, down to the floor 2^-20 (contract section 19).
const startResolution = Number(value('--start-resolution') ?? 10);
const mergeDirs = value('--merge')
  ?.split(',')
  .map((d) => path.resolve(d));
const retryCases = value('--retry-cases')
  ?.split(',')
  .map((v) => Number(v));
const retriedDirs = value('--retried')
  ?.split(',')
  .map((d) => path.resolve(d));
// The shard workers' V8 heap in MB (contract section 22). It is a host resource, not part of the
// measurement.
const heap = Number(value('--heap') ?? 6144);
const only = value('--only')
  ?.split(',')
  .map((v) => Number(v));
if (!Number.isInteger(startResolution) || startResolution < 0 || startResolution > 20)
  throw new Error('--start-resolution takes an integer K from 0 to 20 (2^-K px)');
if (!Number.isInteger(shards) || shards < 1 || !Number.isInteger(stride) || stride < 1)
  throw new Error('--shards and --stride take positive integers');
if (only !== undefined && !only.every((i) => Number.isInteger(i) && i >= 0 && i < shards))
  throw new Error(`--only takes shard indices from 0 to ${shards - 1}`);
if (only !== undefined && (mergeDirs !== undefined || smoke))
  throw new Error('--only cannot be combined with --merge or --smoke');
if (!Number.isInteger(heap) || heap < 1024) throw new Error('--heap takes an integer MB ≥ 1024');
if (
  retryCases !== undefined &&
  (retryCases.length === 0 || !retryCases.every((i) => Number.isInteger(i) && i >= 0))
)
  throw new Error('--retry-cases takes corpus indices');
if (retryCases !== undefined && (only !== undefined || mergeDirs !== undefined || smoke))
  throw new Error('--retry-cases cannot be combined with --only, --merge or --smoke');
if (retriedDirs !== undefined && mergeDirs === undefined)
  throw new Error('--retried needs --merge');
const supersede = value('--supersede');
const remeasuredDirs = value('--remeasured')
  ?.split(',')
  .map((d) => path.resolve(d));
const identityDirs = value('--identity')
  ?.split(',')
  .map((d) => path.resolve(d));
// The E20 commit on main whose harness, tool and documents the measurement branch carries.
const e20Commit = value('--e20-commit');
if (
  supersede !== undefined &&
  (remeasuredDirs === undefined ||
    identityDirs === undefined ||
    e20Commit === undefined ||
    mergeDirs !== undefined ||
    retryCases !== undefined ||
    only !== undefined ||
    smoke)
)
  throw new Error(
    '--supersede needs --remeasured, --identity and --e20-commit, and no --merge, --retry-cases, --only or --smoke',
  );
if (supersede === undefined && (remeasuredDirs !== undefined || identityDirs !== undefined))
  throw new Error('--remeasured and --identity need --supersede');
const here = only === undefined ? Array.from({ length: shards }, (_, i) => i) : [...new Set(only)];
const partial = here.length < shards || retryCases !== undefined;

const contractPath = 'docs/plans/d9-e3-b4-precision-contract.md';
const manifestPath = 'tests/geometry/e3-a04/corpus-v1.manifest.json';
const oraclePath = 'packages/geometry-reference/src/a04-region.ts';
const read = (p) => readFileSync(path.join(root, p));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(read(manifestPath).toString('utf8'));

if (!smoke) {
  // Section 5.5: the freeze note must record this corpus before any kernel runs on it.
  const frozen = read(contractPath)
    .toString('utf8')
    .split('\n')
    .some((line) => line.includes('**Freeze record**') && line.includes(manifest.corpusSha256));
  if (!frozen)
    throw new Error(
      `refusing a corpus run: ${contractPath} has no "**Freeze record**" line with corpusSha256 ` +
        `${manifest.corpusSha256} (section 5.5). Use --smoke for the smoke cases.`,
    );
}

// Section 4.2 and E3-R2: a measurement counts only on an oracle version whose full freeze check
// the contract records, as the oracle line of a freeze record: a line that is exactly
// "- Oracle `packages/geometry-reference/src/a04-region.ts` SHA-256: `<sha>`" plus an optional
// "(commit …)." A strided sample may run on another version; its record names it as uncertified.
const oracleSha256 = sha256(read(oraclePath));
const oracleLine = new RegExp(
  `^- Oracle \`${oraclePath.replaceAll('.', '\\.')}\` SHA-256: \`${oracleSha256}\`( \\(commit \`[0-9a-f]+\`\\))?\\.?$`,
  'u',
);
// A version later found unsound (E3-R2) is withdrawn by a line that starts
// "**Oracle withdrawn**" and names that SHA-256 as its first backticked token.
const contractLines = read(contractPath).toString('utf8').split('\n');
const oracleWithdrawn = contractLines.some(
  (line) =>
    line.startsWith('**Oracle withdrawn**') && /`([0-9a-f]{64})`/u.exec(line)?.[1] === oracleSha256,
);
const oracleCertified =
  !oracleWithdrawn && contractLines.some((line) => oracleLine.test(line.trimEnd()));
if (!smoke && stride === 1 && !oracleCertified)
  throw new Error(
    `refusing a full corpus run: oracle SHA-256 ${oracleSha256} has no freeze check record in ` +
      `${contractPath} (section 4.2, E3-R2). Run pnpm e3-a04:freeze on it first, or use --stride.`,
  );

const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.trim();
const wasm = path.resolve(
  value('--wasm') ??
    path.join(
      root,
      '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
    ),
);
if (!existsSync(wasm))
  throw new Error(`no release WASM at ${wasm}: run pnpm test:geometry first, or pass --wasm`);

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const runId = randomBytes(4).toString('hex');
const out = path.join(root, '.tools', 'e3-a04-run', `${stamp}-${runId}`);
if (existsSync(out)) throw new Error(`output ${out} already exists`);
mkdirSync(out, { recursive: true });
const dirty = git('status', '--porcelain') !== '';
// What every host of one run must share; `--merge` compares these field by field.
const common = {
  commit: git('rev-parse', 'HEAD'),
  dirty,
  contractSha256: sha256(read(contractPath)),
  corpusSha256: manifest.corpusSha256,
  generatorSha256: manifest.generator.sha256,
  oracleSha256,
  oracleCertified,
  wasmSha256: sha256(readFileSync(wasm)),
  shards,
  stride,
  startResolution,
};
const host = {
  runId,
  node: process.version,
  os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpus: os.cpus().length,
  heap,
};
/** Paths a run commit may differ in from this checkout (contract section 22). */
const SAME_MEASUREMENT = (file) =>
  file === 'tooling/run-e3-a04.mjs' ||
  file === 'tests/geometry/e3-a04/run.check.ts' ||
  file.startsWith('docs/');

/**
 * Checks a run directory's provenance against this checkout: every `common` field must agree,
 * except that the commit (with the contract SHA) may be an ancestor of HEAD that differs from
 * it only in SAME_MEASUREMENT paths, renames counted as a delete and an add. Returns the paths
 * that differ, which the merged provenance records.
 */
function checkProvenance(dir, p) {
  if (p.commit === common.commit) {
    checkCommon(dir, p, true);
    return { changedFromHead: [] };
  }
  if (
    spawnSync('git', ['merge-base', '--is-ancestor', p.commit, 'HEAD'], { cwd: root }).status !== 0
  )
    throw new Error(`refusing the merge: ${dir} commit ${p.commit} is not an ancestor of HEAD`);
  const changed = git('diff', '--name-only', '--no-renames', p.commit, 'HEAD')
    .split('\n')
    .filter(Boolean);
  const other = changed.filter((f) => !SAME_MEASUREMENT(f));
  if (other.length > 0)
    throw new Error(
      `refusing the merge: ${dir} commit ${p.commit} differs from HEAD in ${other.join(', ')}`,
    );
  checkCommon(dir, p, false);
  // Recorded for the evidence review: run.check.ts also sets the measurement options.
  return { changedFromHead: changed };
}

function checkCommon(dir, p, sameCommit) {
  for (const [k, v] of Object.entries(common)) {
    if (!sameCommit && (k === 'commit' || k === 'contractSha256')) continue;
    if (JSON.stringify(p[k]) !== JSON.stringify(v))
      throw new Error(
        `refusing the merge: ${dir} has ${k} ${JSON.stringify(p[k])}, here ${JSON.stringify(v)}`,
      );
  }
}

/** E20-K10: the committed 2026-10-27 record, the hosts' commit and the paths E20 may change. */
const SUPERSEDED_SHA256 = '5df0c5a633de733ae964a560cbedd9838d5c2929360dfa98705dce88dd0e6b2e';
const MEASUREMENT_BASE = '7443c2b3a763d3b21bde1e601fea794076f1ab67';
const E20_PATHS = (file) =>
  file.startsWith('tests/geometry/e3-a04/') ||
  file === 'tooling/run-e3-a04.mjs' ||
  file.startsWith('docs/');
/** Old-record identity fields that must equal this checkout's (E20-K10). */
const SUPERSEDE_IDENTITY = [
  'corpusSha256',
  'generatorSha256',
  'oracleSha256',
  'oracleCertified',
  'wasmSha256',
  'shards',
  'stride',
  'startResolution',
];
const BOUND_FIELDS = ['eLo', 'eHi', 'u', 'l'];
const nonFinite = (_, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v);

const merged = mergeDirs === undefined ? null : mergeHosts(mergeDirs);
const retried = merged === null || retriedDirs === undefined ? [] : applyRetries(retriedDirs);
const superseded = supersede === undefined ? null : supersedeRecord(path.resolve(supersede));
const provenance =
  superseded !== null
    ? { ...common, runId, ...superseded }
    : merged === null
      ? {
          ...common,
          ...host,
          ...(retryCases !== undefined ? { retryCases } : partial ? { shardsHere: here } : {}),
        }
      : { ...common, runId, hosts: merged, ...(retried.length > 0 ? { retried } : {}) };
writeFileSync(path.join(out, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

/**
 * Checks the partial run directories of one multi-host run and copies their shard files into
 * `out`: each must agree with this checkout on every `common` field, and together they must hold
 * every shard exactly once.
 */
function mergeHosts(dirs) {
  const seen = new Map();
  const hosts = dirs.map((dir) => {
    const p = JSON.parse(readFileSync(path.join(dir, 'provenance.json'), 'utf8'));
    const h = JSON.parse(readFileSync(path.join(dir, 'host.json'), 'utf8'));
    const { changedFromHead } = checkProvenance(dir, p);
    if (h.shardsHere === undefined)
      throw new Error(`refusing the merge: ${dir} is a retry directory`);
    for (const i of h.shardsHere) {
      if (seen.has(i))
        throw new Error(`refusing the merge: shard ${i} is in ${seen.get(i)} and ${dir}`);
      seen.set(i, dir);
      copyFileSync(path.join(dir, `shard-${i}.ndjson`), path.join(out, `shard-${i}.ndjson`));
    }
    return {
      runId: p.runId,
      commit: p.commit,
      changedFromHead,
      node: p.node,
      heap: p.heap ?? 6144,
      os: p.os,
      cpus: p.cpus,
      shards: h.shardsHere,
      exitCodes: h.exitCodes,
      restarts: h.restarts,
    };
  });
  const missing = Array.from({ length: shards }, (_, i) => i).filter((i) => !seen.has(i));
  if (missing.length > 0)
    throw new Error(`refusing the merge: shards ${missing.join(', ')} are missing`);
  return hosts;
}

/**
 * Replaces, in the merged shard files, each row whose worker died by the row a retry directory
 * measured for the same corpus index (contract section 22). A retry row must name such a row,
 * and two retry directories may not measure the same case.
 */
function applyRetries(dirs) {
  const rows = new Map();
  for (const dir of dirs) {
    const p = JSON.parse(readFileSync(path.join(dir, 'provenance.json'), 'utf8'));
    const { changedFromHead } = checkProvenance(dir, p);
    if (p.retryCases === undefined) throw new Error(`refusing the merge: ${dir} is not a retry`);
    const h = JSON.parse(readFileSync(path.join(dir, 'host.json'), 'utf8'));
    for (const line of readFileSync(path.join(dir, 'retry.ndjson'), 'utf8').split('\n')) {
      if (line === '') continue;
      const row = JSON.parse(line);
      if (rows.has(row.index))
        throw new Error(`refusing the merge: case ${row.index} is retried twice`);
      if (String(row.reason ?? '').startsWith('harness-error'))
        throw new Error(`refusing the merge: the retry of case ${row.index} failed again`);
      rows.set(row.index, {
        row,
        line,
        dir,
        runId: p.runId,
        commit: p.commit,
        changedFromHead,
        heap: p.heap,
        exitCodes: h.exitCodes,
      });
    }
  }
  const done = [];
  for (let i = 0; i < shards; i += 1) {
    const file = path.join(out, `shard-${i}.ndjson`);
    const lines = readFileSync(file, 'utf8').split('\n');
    let changed = false;
    for (let k = 0; k < lines.length; k += 1) {
      if (lines[k] === '') continue;
      const row = JSON.parse(lines[k]);
      const retry = rows.get(row.index);
      if (retry === undefined) continue;
      if (retry.row.id !== row.id || !String(row.reason ?? '').startsWith('harness-error: worker'))
        throw new Error(`refusing the merge: retried case ${row.index} is not a dead-worker row`);
      done.push({
        index: row.index,
        id: row.id,
        before: row.reason,
        runId: retry.runId,
        commit: retry.commit,
        changedFromHead: retry.changedFromHead,
        heap: retry.heap,
        exitCodes: retry.exitCodes,
      });
      lines[k] = retry.line;
      rows.delete(row.index);
      changed = true;
    }
    if (changed) writeFileSync(file, lines.join('\n'));
  }
  if (rows.size > 0)
    throw new Error(
      `refusing the merge: retried cases ${[...rows.keys()].join(', ')} not in the run`,
    );
  return done.sort((a, b) => a.index - b.index);
}

/** A row as E20-A5 compares it: without `ms`, and with both forms of `+∞` (E20-K8) as null. */
function identityForm(row) {
  const out = { ...row };
  delete out.ms;
  for (const k of BOUND_FIELDS) if (out[k] === 'Infinity') out[k] = null;
  return JSON.stringify(out);
}

/**
 * The rows of retry directories, by corpus index, each with its directory's provenance. A row
 * whose worker failed (`harness-error`) is left out and its index added to `failed`: another
 * directory must measure it, with a larger --heap. A directory whose run was stopped before it
 * wrote host.json (a container restart) counts as `interrupted`: its complete rows stand, a cut
 * last line is dropped, and the case it was measuring (`retry.current`) must come from another
 * directory, which the completeness check enforces.
 */
function retryRows(dirs, kind, rows, failed) {
  const runs = [];
  for (const dir of dirs) {
    const p = JSON.parse(readFileSync(path.join(dir, 'provenance.json'), 'utf8'));
    const { changedFromHead } = checkProvenance(dir, p);
    if (p.retryCases === undefined) throw new Error(`refusing the merge: ${dir} is not a retry`);
    const hostFile = path.join(dir, 'host.json');
    const interrupted = !existsSync(hostFile);
    const h = interrupted ? null : JSON.parse(readFileSync(hostFile, 'utf8'));
    const current = path.join(dir, 'retry.current');
    const cases = new Set(p.retryCases);
    let count = 0;
    const failedHere = [];
    const lines = readFileSync(path.join(dir, 'retry.ndjson'), 'utf8').split('\n');
    for (const [k, line] of lines.entries()) {
      if (line === '') continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        if (interrupted && lines.slice(k + 1).every((l) => l === '')) break;
        throw error;
      }
      if (!cases.has(row.index))
        throw new Error(`refusing the merge: ${dir} holds case ${row.index}, not one it ran`);
      if (String(row.reason ?? '').startsWith('harness-error')) {
        failed.add(row.index);
        failedHere.push(row.index);
        continue;
      }
      if (rows.has(row.index))
        throw new Error(`refusing the merge: case ${row.index} is measured twice`);
      rows.set(row.index, { row, kind });
      count += 1;
    }
    runs.push({
      runId: p.runId,
      commit: p.commit,
      changedFromHead,
      node: p.node,
      heap: p.heap,
      os: p.os,
      cpus: p.cpus,
      planned: p.retryCases.length,
      cases: count,
      failedCases: failedHere,
      ...(interrupted
        ? { interrupted: true, interruptedAt: existsSync(current) ? readCurrent(current) : null }
        : { exitCodes: h.exitCodes, restarts: h.restarts }),
    });
  }
  return { rows, runs };
}

/**
 * E20-K9 and K10: checks the 2026-10-27 record and this checkout, replaces the re-measured rows,
 * checks the identity sample, and writes every row into `shard-0.ndjson` for the finalize phase.
 * Returns the provenance it adds.
 */
function supersedeRecord(file) {
  const bytes = readFileSync(file);
  if (sha256(bytes) !== SUPERSEDED_SHA256)
    throw new Error(`refusing to supersede: ${file} is not the record of E20-K10`);
  const old = JSON.parse(bytes.toString('utf8'));
  for (const k of SUPERSEDE_IDENTITY)
    if (JSON.stringify(old.provenance[k]) !== JSON.stringify(common[k]))
      throw new Error(
        `refusing to supersede: the old record has ${k} ${JSON.stringify(old.provenance[k])}, ` +
          `here ${JSON.stringify(common[k])}`,
      );
  if (
    spawnSync('git', ['merge-base', '--is-ancestor', MEASUREMENT_BASE, 'HEAD'], { cwd: root })
      .status !== 0
  )
    throw new Error(`refusing to supersede: ${MEASUREMENT_BASE} is not an ancestor of HEAD`);
  const changed = git('diff', '--name-only', '--no-renames', MEASUREMENT_BASE, 'HEAD')
    .split('\n')
    .filter(Boolean);
  const other = changed.filter((f) => !E20_PATHS(f));
  if (other.length > 0)
    throw new Error(`refusing to supersede: HEAD differs from ${MEASUREMENT_BASE} in ${other}`);
  const e20 = git('rev-parse', '--verify', `${e20Commit}^{commit}`);
  if (!/^[0-9a-f]{40}$/u.test(e20))
    throw new Error(`refusing to supersede: no commit ${e20Commit}`);
  const fromE20 = git(
    'diff',
    '--name-only',
    '--no-renames',
    e20,
    'HEAD',
    '--',
    'tests/geometry/e3-a04',
    'tooling/run-e3-a04.mjs',
    'docs',
  );
  if (fromE20 !== '')
    throw new Error(`refusing to supersede: HEAD differs from E20 commit ${e20} in ${fromE20}`);

  const measured = new Map();
  const failed = new Set();
  const { runs: remeasured } = retryRows(remeasuredDirs, 'remeasured', measured, failed);
  const { runs: identity } = retryRows(identityDirs, 'identity', measured, failed);
  const unmeasured = [...failed].filter((i) => !measured.has(i));
  if (unmeasured.length > 0)
    throw new Error(`refusing to supersede: the workers of cases ${unmeasured} failed`);
  // The rows E20-R3 names: every UNDECIDED row but the work-cap rows outside section 21's classes,
  // and every FAIL row outside them. The sample of E20-A5: every 25th corpus index among the
  // decided rows.
  const disclosed = new Set(Object.values(old.disclosed).flat());
  const remeasure = (r) =>
    (r.status === 'undecided' &&
      !(String(r.reason ?? '').startsWith('work cap:') && !disclosed.has(r.id))) ||
    (r.status === 'fail' && !disclosed.has(r.id));
  const sampled = (r) => r.status !== 'undecided' && r.index % 25 === 0;
  const rows = old.rows.map((r) => {
    const m = measured.get(r.index);
    const kind = remeasure(r) ? 'remeasured' : sampled(r) ? 'identity' : null;
    if (kind === null) {
      if (m !== undefined)
        throw new Error(`refusing to supersede: case ${r.index} is not one E20 re-measures`);
      return r;
    }
    if (m === undefined) throw new Error(`refusing to supersede: case ${r.index} is missing`);
    if (m.kind !== kind || m.row.id !== r.id)
      throw new Error(`refusing to supersede: case ${r.index} is not the ${kind} row ${r.id}`);
    measured.delete(r.index);
    if (kind === 'identity') {
      if (identityForm(m.row) !== identityForm(r))
        throw new Error(`refusing to supersede: identity case ${r.index} (${r.id}) differs`);
      return r;
    }
    return { ...m.row, former: { status: r.status, reason: r.reason } };
  });
  if (measured.size > 0)
    throw new Error(`refusing to supersede: cases ${[...measured.keys()]} are not in the record`);
  writeFileSync(
    path.join(out, 'shard-0.ndjson'),
    rows.map((r) => `${JSON.stringify(r, nonFinite)}\n`).join(''),
  );
  // E20 changes no shader, WASM or product path, so the old GPU check stands (contract section 1).
  writeFileSync(
    path.join(out, 'gpu-carried.json'),
    `${JSON.stringify({ shaderSha256: old.provenance.shaderSha256, gpu: old.gpu }, null, 2)}\n`,
  );
  return {
    supersedes: {
      runId: old.provenance.runId,
      sha256: SUPERSEDED_SHA256,
      commit: old.provenance.commit,
    },
    measurementBase: MEASUREMENT_BASE,
    e20Commit: e20,
    changedFromBase: changed,
    hosts: old.provenance.hosts,
    retried: old.provenance.retried,
    remeasured,
    identity,
  };
}

/** The corpus position in a shard's `.current` file, or null when it is not one. */
function readCurrent(file) {
  const at = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(at) && at >= 0 && readFileSync(file, 'utf8').trim() !== '' ? at : null;
}

const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const MAX_RESTARTS = 64;
const runPhase = (env) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [vitest, 'run', '--config', 'vitest.e3-a04-run.config.ts', '--reporter=dot'],
      {
        cwd: root,
        stdio: ['ignore', 'ignore', 'inherit'],
        env: {
          ...process.env,
          NODE_OPTIONS: `--max-old-space-size=${heap}`,
          P2_WASM_PATH: wasm,
          E3_A04_RUN_OUT: out,
          E3_A04_RUN_SHARD: `0/${shards}`,
          E3_A04_RUN_STRIDE: String(stride),
          E3_A04_RUN_START_RESOLUTION: String(startResolution),
          ...env,
        },
      },
    );
    child.on('exit', (code) => resolve(code ?? 1));
  });

const started = Date.now();
if (smoke) {
  const code = await runPhase({ E3_A04_RUN_PHASE: 'smoke' });
  const file = path.join(out, 'smoke.json');
  if (code !== 0 || !existsSync(file)) throw new Error(`the smoke phase failed (exit ${code})`);
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const missed = [
    ...result.controls.filter((c) => !c.ok).map((c) => c.id),
    ...result.rows
      .filter((r) => r.expect === 'pass' && r.row.status !== 'pass')
      .map((r) => r.row.id),
  ];
  for (const r of result.rows)
    console.log(
      `${r.row.id}: ${r.row.status} U=${r.row.u} βc=${r.row.betaC} ${r.row.reason ?? ''}`,
    );
  console.log(
    `controls: ${result.controls.filter((c) => c.ok).length}/${result.controls.length} met`,
  );
  console.log(`smoke: ${file} (${Date.now() - started} ms)`);
  process.exitCode = missed.length > 0 ? 1 : 0;
} else {
  // A worker that dies (a heap limit is not an exception the harness can catch) is restarted
  // after the case it was measuring, which is recorded UNDECIDED (contract section 19).
  const restarts = Array.from({ length: shards }, () => []);
  const runShard = async (i) => {
    const current = path.join(
      out,
      retryCases === undefined ? `shard-${i}.current` : 'retry.current',
    );
    let resume;
    for (;;) {
      const code = await runPhase({
        E3_A04_RUN_PHASE: 'shard',
        E3_A04_RUN_SHARD: `${i}/${shards}`,
        ...(retryCases === undefined ? {} : { E3_A04_RUN_CASES: retryCases.join(',') }),
        ...(resume === undefined ? {} : { E3_A04_RUN_RESUME: resume }),
      });
      if (code === 0 || !existsSync(current) || restarts[i].length >= MAX_RESTARTS) return code;
      const at = readCurrent(current);
      if (at === null || (resume !== undefined && Number(resume.split(':')[0]) >= at)) return code;
      restarts[i].push({ at, code });
      resume = `${at}:worker exited (code ${code}) while measuring`;
    }
  };
  const hereCodes =
    mergeDirs !== undefined || superseded !== null
      ? null
      : retryCases !== undefined
        ? [await runShard(0)]
        : await Promise.all(here.map((i) => runShard(i)));
  // Exit codes and restarts indexed by shard, whichever host ran it.
  const shardCodes = Array.from({ length: shards }, () => null);
  const shardRestarts = Array.from({ length: shards }, () => []);
  if (hereCodes !== null)
    here.forEach((i, k) => {
      shardCodes[i] = hereCodes[k];
      shardRestarts[i] = restarts[i];
    });
  else
    for (const h of provenance.hosts)
      h.shards.forEach((i, k) => {
        shardCodes[i] = h.exitCodes[k];
        shardRestarts[i] = h.restarts[k];
      });
  const codes = hereCodes ?? shardCodes;
  const restarted = shardRestarts;
  if (retryCases !== undefined) {
    writeFileSync(
      path.join(out, 'host.json'),
      `${JSON.stringify({ retryCases, exitCodes: codes, restarts: restarts[0] }, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({ retryCases, exitCodes: codes, wallMilliseconds: Date.now() - started }),
    );
    console.log(`retry run: ${out} (pass it to --merge … --retried)`);
    process.exit(codes.some((c) => c !== 0) ? 1 : 0);
  }
  if (partial) {
    writeFileSync(
      path.join(out, 'host.json'),
      `${JSON.stringify({ shardsHere: here, exitCodes: codes, restarts: here.map((i) => restarts[i]) }, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        shardsHere: here,
        shardExitCodes: codes,
        wallMilliseconds: Date.now() - started,
      }),
    );
    console.log(`partial run: ${out} (finalize with --merge on every host's run directory)`);
    process.exit(codes.some((c) => c !== 0) ? 1 : 0);
  }
  // The record carries the shards' exit codes and restarts (contract section 19.5).
  writeFileSync(
    path.join(out, 'provenance.json'),
    `${JSON.stringify({ ...provenance, shardExitCodes: shardCodes, shardRestarts }, null, 2)}\n`,
  );
  const finalize = await runPhase({
    E3_A04_RUN_PHASE: 'finalize',
    ...(superseded === null ? {} : { E3_A04_RUN_GPU_CARRIED: path.join(out, 'gpu-carried.json') }),
    E3_A04_RUN_GPU:
      gpu === undefined
        ? ''
        : gpu
            .split(',')
            .map((p) => path.resolve(p))
            .join(','),
  });
  const recordFile = path.join(out, 'record.json');
  if (finalize !== 0 || !existsSync(recordFile)) throw new Error('the finalize phase failed');
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  console.log(
    JSON.stringify(
      {
        verdict: record.verdict,
        reasons: record.verdictReasons,
        validator: record.validator,
        shardExitCodes: codes,
        shardRestarts: restarted,
        overall: record.aggregates.overall.all,
        wallMilliseconds: Date.now() - started,
      },
      null,
      2,
    ),
  );
  // An interrupted retry run has no exit codes; the supersede merge's row checks (every named row
  // present exactly once) stand in for them.
  const retriesOk = [
    ...retried,
    ...(superseded === null ? [] : [...superseded.remeasured, ...superseded.identity]),
  ].every((r) => (r.exitCodes ?? []).every((c) => c === 0));
  if (
    stride === 1 &&
    !dirty &&
    codes.every((c) => c === 0) &&
    retriesOk &&
    record.validator.length === 0
  ) {
    const evidence = path.join(root, 'docs', 'evidence', 'e3-a04', `${stamp}-${runId}`);
    if (existsSync(evidence)) throw new Error(`refusing to overwrite ${evidence}`);
    mkdirSync(evidence, { recursive: true });
    for (const f of ['record.json', 'record.md'])
      copyFileSync(path.join(out, f), path.join(evidence, f));
    console.log(`evidence: ${evidence}`);
  }
  console.log(`record: ${path.join(out, 'record.md')}`);
  process.exitCode = codes.some((c) => c !== 0) || record.validator.length > 0 ? 1 : 0;
}
