// One command for a tier 2 or tier 3 headed sitting (docs/validation.md, "Headed run tiers"):
// `pnpm test:headed --tier 2|3 [--workers N] [-- <playwright args>]`.
//
// It runs, in order: for tier 3 the V-4 A08 corpus (`pnpm test:gpu:viz-v4`), then
// `pnpm test:gpu`, then every next-host suite. A failed stage does not stop the later ones; the
// exit status is non-zero when any stage failed. --workers sets VS_HEADED_WORKERS for every
// stage (default 1; suites marked serial in their config stay at 1). Each stage's per-spec
// timing goes under artifacts/headed-timing/<run id>/, and the stage table is printed and
// written there as stages.tsv. Prerequisites as for the stages themselves: `pnpm build`, the
// geometry WASM (`pnpm test:geometry`), and for tier 3 `pnpm viz-v4:expected`. Manual, never CI.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The next-host suites of tiers 2 and 3, in the order they were built. */
export const NEXT_HOST_SUITES = [
  'p5',
  'm1',
  'm2',
  'm3',
  'm4',
  'm5',
  'm6a',
  'm6b',
  'm6c',
  'm7',
  'm8',
];

const usage = 'Usage: run-headed-tier.mjs --tier 2|3 [--workers N] [-- <playwright args>]';

export function parse(argv) {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const extra = separator === -1 ? [] : argv.slice(separator + 1);
  let tier;
  let workers = '1';
  for (let index = 0; index < own.length; index++) {
    const argument = own[index];
    const value = own[index + 1];
    if (argument === '--tier' && (value === '2' || value === '3')) {
      tier = Number(value);
      index++;
    } else if (argument === '--workers' && value !== undefined && /^[1-9]\d*$/u.test(value)) {
      workers = value;
      index++;
    } else {
      throw new Error(usage);
    }
  }
  if (tier === undefined) throw new Error(usage);
  return { tier, workers, extra };
}

export function stages(tier) {
  return [
    ...(tier === 3 ? [{ name: 'gpu-corpus', script: 'test:gpu:viz-v4' }] : []),
    { name: 'gpu', script: 'test:gpu' },
    ...NEXT_HOST_SUITES.map((suite) => ({
      name: `${suite}-next-host`,
      script: `test:${suite}-next-host`,
    })),
  ];
}

function pnpm(args, env) {
  // As in run-viz-v4-gpu.mjs: under pnpm, npm_execpath is pnpm's entry point; elsewhere pnpm is
  // spawned by name, which Windows cannot do without a shell.
  const execPath = process.env.npm_execpath;
  let command = 'pnpm';
  let commandArgs = args;
  if (execPath !== undefined && execPath !== '' && /pnpm/u.test(path.basename(execPath))) {
    const script = /\.[cm]?js$/u.test(execPath);
    command = script ? process.execPath : execPath;
    commandArgs = script ? [execPath, ...args] : args;
  } else if (process.platform === 'win32') {
    throw new Error('run this launcher through pnpm: pnpm test:headed --tier 2');
  }
  return spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: false, env });
}

function main() {
  // pnpm passes a leading `--` through to the script.
  const argv = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));
  const { tier, workers, extra } = parse(argv);
  const runId = `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-tier${String(tier)}`;
  const timingDirectory = path.join(root, 'artifacts/headed-timing', runId);
  mkdirSync(timingDirectory, { recursive: true });
  console.log(`headed tier ${String(tier)} run ${runId}, workers ${workers}`);
  const rows = [];
  const started = Date.now();
  for (const stage of stages(tier)) {
    const stageStarted = Date.now();
    console.log(`\n=== ${stage.name}: pnpm ${stage.script} ===`);
    const result = pnpm(['run', stage.script, ...(extra.length > 0 ? ['--', ...extra] : [])], {
      ...process.env,
      VS_HEADED_WORKERS: workers,
      VS_HEADED_TIMING_DIR: timingDirectory,
    });
    if (result.error !== undefined) throw result.error;
    rows.push({
      stage: stage.name,
      status: result.status === 0 ? 'passed' : `failed (${String(result.status ?? result.signal)})`,
      minutes: (Date.now() - stageStarted) / 60_000,
    });
  }
  const total = (Date.now() - started) / 60_000;
  const table = [
    'stage\tstatus\tminutes',
    ...rows.map((row) => `${row.stage}\t${row.status}\t${row.minutes.toFixed(1)}`),
    `total\t${rows.every((row) => row.status === 'passed') ? 'passed' : 'failed'}\t${total.toFixed(1)}`,
  ].join('\n');
  writeFileSync(path.join(timingDirectory, 'stages.tsv'), `${table}\n`);
  console.log(`\n${table}\ntiming: ${timingDirectory}`);
  process.exit(rows.every((row) => row.status === 'passed') ? 0 : 1);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
