// D9 E11 unit E11-U2: the A01 structure sweep (docs/plans/d9-e11-p3-c03-c05-closure-contract.md,
// sections 7 and 8). Manual, never CI.
//
//   pnpm p3-exit:sweep [--scene] [--corpus] [--batch N] [--wasm <path>]
//
// Uses the release WASM that `pnpm test:geometry` builds (or --wasm <path>). --scene (the
// default) sweeps the seeded stress scene; --corpus sweeps every distinct request of
// a04-corpus/v1 and refuses to start until the E3 contract holds the corpus freeze record (E3
// section 5.5: no kernel output on the corpus is read before the freeze). Each phase writes
// <phase>.json to .tools/p3-exit-sweep/<stamp>-<run id>/ with provenance.json.
//
// It exits non-zero when a mesh breaks a structure rule, an echo is wrong, an outcome depends on
// its batch, or a seeded control is not caught. Rejected requests are listed, not failed: they
// are classified against E11 section 7.2 by the evidence review.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const phases = [
  ...(args.includes('--scene') || !args.includes('--corpus') ? ['scene'] : []),
  ...(args.includes('--corpus') ? ['corpus'] : []),
];
const batch = Number(value('--batch') ?? 32);
if (!Number.isInteger(batch) || batch < 1) throw new Error('--batch takes a positive integer');

const read = (p) => readFileSync(path.join(root, p));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(read('tests/geometry/e3-a04/corpus-v1.manifest.json').toString('utf8'));
if (phases.includes('corpus')) {
  const frozen = read('docs/plans/d9-e3-b4-precision-contract.md')
    .toString('utf8')
    .split('\n')
    .some((line) => line.includes('**Freeze record**') && line.includes(manifest.corpusSha256));
  if (!frozen)
    throw new Error(
      `refusing --corpus: the E3 contract has no "**Freeze record**" line with corpusSha256 ` +
        `${manifest.corpusSha256} (E3 section 5.5). Use --scene.`,
    );
}

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
const out = path.join(root, '.tools', 'p3-exit-sweep', `${stamp}-${runId}`);
if (existsSync(out)) throw new Error(`output ${out} already exists`);
mkdirSync(out, { recursive: true });
writeFileSync(
  path.join(out, 'provenance.json'),
  `${JSON.stringify(
    {
      commit: git('rev-parse', 'HEAD'),
      dirty: git('status', '--porcelain') !== '',
      runId,
      wasmSha256: sha256(readFileSync(wasm)),
      corpusSha256: manifest.corpusSha256,
      sceneSha256: sha256(read('tests/geometry/p3-exit-sweep/scene.ts')),
      checkerSha256: sha256(read('tests/geometry/p3-exit-sweep/structure.ts')),
      batch,
      node: process.version,
      os: `${os.type()} ${os.release()} ${os.arch()}`,
    },
    null,
    2,
  )}\n`,
);

const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
let failed = false;
for (const phase of phases) {
  const run = spawnSync(
    process.execPath,
    [vitest, 'run', '--config', 'vitest.p3-exit-sweep.config.ts', '--reporter=dot'],
    {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=6144',
        P2_WASM_PATH: wasm,
        P3_EXIT_SWEEP_OUT: out,
        P3_EXIT_SWEEP_PHASE: phase,
        P3_EXIT_SWEEP_BATCH: String(batch),
      },
    },
  );
  const file = path.join(out, `${phase}.json`);
  if (run.status !== 0 || !existsSync(file)) {
    console.error(`phase ${phase} failed (exit ${run.status})`);
    failed = true;
    continue;
  }
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const missed = Object.values(r.controls).flatMap((c) =>
    c.results.filter((x) => !x.caught).map((x) => x.id),
  );
  const bad =
    r.structureFailures.length > 0 ||
    r.echoFailures.length > 0 ||
    r.isolationFailures.length > 0 ||
    missed.length > 0 ||
    Object.keys(r.controls).length < 2;
  failed ||= bad;
  console.log(
    JSON.stringify(
      {
        phase,
        requests: r.requests,
        fill: r.fill.outcomes,
        stroke: r.stroke.outcomes,
        structureFailures: r.structureFailures.length,
        echoFailures: r.echoFailures.length,
        isolationFailures: r.isolationFailures.length,
        controlsMissed: missed,
        controlKinds: Object.keys(r.controls),
        outcomeDigest: r.outcomeDigest,
      },
      null,
      2,
    ),
  );
}
console.log(`output: ${out}`);
process.exitCode = failed ? 1 : 0;
