// D9 E3 unit E3-U3: the A04 measurement run (docs/plans/d9-e3-b4-precision-contract.md section 7,
// executable form in section 15.8). Manual, never CI.
//
//   pnpm e3-a04:run --smoke [--wasm <path>]
//   pnpm e3-a04:run [--shards N] [--stride S] [--start-resolution K] [--gpu <chrome.json>,<edge.json>]
//                   [--wasm <path>]
//
// Uses the release WASM that `pnpm test:geometry` builds (or --wasm <path>), then:
//
// - with --smoke, measures the smoke cases of section 15.6 (not corpus cases) and runs the
//   controls, into .tools/e3-a04-run/<stamp>/smoke.json;
// - otherwise measures the corpus in N vitest shards (each a separate process), then merges them
//   into record.json and record.md (section 15.7). It refuses to start until the contract holds
//   the freeze note of section 5.5 for this corpus (a "**Freeze record**" line with its
//   corpusSha256): no kernel output on the corpus is read before the freeze. A full (stride 1),
//   clean run is copied to docs/evidence/e3-a04/<stamp>-<run id>/, never over an existing one.
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
if (!Number.isInteger(startResolution) || startResolution < 0 || startResolution > 20)
  throw new Error('--start-resolution takes an integer K from 0 to 20 (2^-K px)');
if (!Number.isInteger(shards) || shards < 1 || !Number.isInteger(stride) || stride < 1)
  throw new Error('--shards and --stride take positive integers');

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
const oracleCertified = read(contractPath)
  .toString('utf8')
  .split('\n')
  .some((line) => oracleLine.test(line.trimEnd()));
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
const provenance = {
  commit: git('rev-parse', 'HEAD'),
  dirty,
  runId,
  contractSha256: sha256(read(contractPath)),
  corpusSha256: manifest.corpusSha256,
  generatorSha256: manifest.generator.sha256,
  oracleSha256,
  oracleCertified,
  wasmSha256: sha256(readFileSync(wasm)),
  node: process.version,
  os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpus: os.cpus().length,
};
writeFileSync(path.join(out, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
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
          NODE_OPTIONS: '--max-old-space-size=6144',
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
  const codes = await Promise.all(
    Array.from({ length: shards }, (_, i) =>
      runPhase({ E3_A04_RUN_PHASE: 'shard', E3_A04_RUN_SHARD: `${i}/${shards}` }),
    ),
  );
  const finalize = await runPhase({
    E3_A04_RUN_PHASE: 'finalize',
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
        overall: record.aggregates.overall.all,
        wallMilliseconds: Date.now() - started,
      },
      null,
      2,
    ),
  );
  if (stride === 1 && !dirty && codes.every((c) => c === 0) && record.validator.length === 0) {
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
