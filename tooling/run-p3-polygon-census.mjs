import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA,
  createInvocation,
  describeJournal,
  sha256,
  writeIncomplete,
  writeJsonExclusive,
} from '../tests/p3-polygon-census/artifact.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, '.tools');
const config = path.join(root, 'vitest.p3-polygon-census.config.ts');
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
const EXPECTED_NODE = '24.15.0';
const REQUIRED_TRACKED = [
  'docs/plans/p3-polygon-relation-census-contract.md',
  'tests/p3-polygon-census/artifact.ts',
  'tests/p3-polygon-census/audit.ts',
  'tests/p3-polygon-census/census.test.ts',
  'tests/p3-polygon-census/classifier.ts',
  'tests/p3-polygon-census/fixtures.ts',
  'tests/p3-polygon-census/mechanics.test.ts',
  'tests/p3-polygon-census/transport.ts',
  'tests/p3-polygon-census/types.ts',
  'tooling/run-p3-polygon-census.mjs',
  'tooling/run-p3-polygon-census.d.mts',
  'vitest.p3-polygon-census.config.ts',
];

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--smoke')
    return { mode: 'SMOKE', nativeDirectory: null, requested: null };
  if (
    args.length === 5 &&
    args[0] === '--full' &&
    args[1] === '--native-dir' &&
    args[2] &&
    args[3] === '--output' &&
    args[4]
  )
    return { mode: 'FULL', nativeDirectory: args[2], requested: args[4] };
  throw new Error(
    'Expected exactly --smoke or --full --native-dir <existing-directory> --output <fresh-directory>.',
  );
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function withinOrEqual(parent, child) {
  return parent === child || within(parent, child);
}

export function resolveOutputTarget(requested) {
  const output = path.resolve(root, requested);
  const realTools = realpathSync(tools);
  const realParent = realpathSync(path.dirname(output));
  if (!withinOrEqual(realTools, realParent))
    throw new Error('FULL output must be a fresh directory below repository .tools.');
  return path.join(realParent, path.basename(output));
}

export function reserveOutput(mode, requested, nativeDirectory = null) {
  mkdirSync(tools, { recursive: true });
  if (mode === 'SMOKE') return mkdtempSync(path.join(tools, 'p3-polygon-census-'));
  const output = resolveOutputTarget(requested);
  if (existsSync(output)) throw new Error('Polygon census output directory already exists.');
  if (
    nativeDirectory !== null &&
    (withinOrEqual(nativeDirectory, output) || withinOrEqual(output, nativeDirectory))
  )
    throw new Error('Output directory must not overlap the native input directory.');
  mkdirSync(output);
  return output;
}

export function resolveNativeDirectory(requested) {
  const directory = realpathSync(path.resolve(root, requested));
  if (!lstatSync(directory).isDirectory()) throw new Error('Native path is not a directory.');
  for (const name of ['input.bin', 'output.bin']) {
    const file = path.join(directory, name);
    if (!existsSync(file) || !lstatSync(file).isFile())
      throw new Error(`Native directory is missing regular ${name}.`);
  }
  return directory;
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

export function assertFullSource() {
  if (git('status', '--porcelain') !== '')
    throw new Error('FULL requires a clean nonignored worktree.');
  for (const file of REQUIRED_TRACKED) git('cat-file', '-e', `HEAD:${file}`);
}

export function validateNodeVersion(version) {
  if (version !== EXPECTED_NODE)
    throw new Error(`Node ${EXPECTED_NODE} is required; received ${String(version)}.`);
}

export function workerOutcome(result, label) {
  if (result.error) throw new Error(`${label}: ${String(result.error)}`);
  if (result.status !== 0 || result.signal)
    throw new Error(`${label} failed (${String(result.status ?? result.signal)}).`);
}

async function runPhase(mode, output, nativeDirectory, phase) {
  const logPath = path.join(output, `${phase.toLowerCase()}.log`);
  const log = openSync(logPath, 'wx');
  const args = ['run', '--config', config];
  if (phase === 'RUN' || phase === 'AUDIT') args.push('tests/p3-polygon-census/census.test.ts');
  const child = spawn(process.execPath, [vitest, ...args], {
    cwd: root,
    env: {
      ...process.env,
      P3_POLYGON_RUN_MODE: mode,
      P3_POLYGON_OUTPUT: output,
      P3_POLYGON_NATIVE_DIR: nativeDirectory ?? '',
      P3_POLYGON_PHASE: phase,
    },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  return await new Promise((resolve) => {
    let error = null;
    const timer = setTimeout(() => {
      error = new Error(`${phase} exceeded frozen 960000 ms child limit`);
      if (child.pid) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (cleanupError) {
          error = new Error(`${error.message}; process cleanup: ${String(cleanupError)}`);
        }
      }
    }, 960_000);
    child.on('error', (failure) => {
      error = failure;
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      closeSync(log);
      resolve({ status, signal, error, logPath });
    });
  });
}

export async function main(args = process.argv.slice(2)) {
  const parsed = parseArguments(args);
  validateNodeVersion(process.versions.node);
  let nativeDirectory = null;
  if (parsed.mode === 'FULL') {
    assertFullSource();
    nativeDirectory = resolveNativeDirectory(parsed.nativeDirectory);
  }
  const output = reserveOutput(parsed.mode, parsed.requested, nativeDirectory);
  if (
    nativeDirectory &&
    (within(nativeDirectory, realpathSync(output)) || within(realpathSync(output), nativeDirectory))
  )
    throw new Error('Output directory must not overlap the native input directory.');
  createInvocation(root, output, parsed.mode);
  console.log(`P3 polygon census ${parsed.mode} output: ${path.relative(root, output)}`);
  const phases = parsed.mode === 'SMOKE' ? ['MECHANICS', 'RUN', 'AUDIT'] : ['RUN', 'AUDIT'];
  for (const currentPhase of phases) {
    const result = await runPhase(parsed.mode, output, nativeDirectory, currentPhase);
    try {
      workerOutcome(result, `Polygon census ${currentPhase}`);
    } catch (error) {
      if (currentPhase === 'AUDIT') {
        const audit = path.join(output, 'audit.json');
        if (!existsSync(audit)) {
          const report = path.join(output, 'report.json');
          const rows = describeJournal(output);
          writeJsonExclusive(audit, {
            schema: SCHEMA,
            status: 'FAIL',
            reportSha256: sha256(readFileSync(report)),
            rowsSha256: rows.sha256,
            rows: rows.count,
            peakCandidateRecords: null,
            failure: { stage: 'AUDIT', message: String(error), index: null },
          });
        }
      } else writeIncomplete(root, output, 'WORKER', String(error));
      throw new Error(`${String(error)}; log=${path.relative(root, result.logPath)}`, {
        cause: error,
      });
    }
    console.log(
      `P3 polygon census ${currentPhase}: PASS; log=${path.relative(root, result.logPath)}`,
    );
  }
  const report = JSON.parse(readFileSync(path.join(output, 'report.json'), 'utf8'));
  const audit = JSON.parse(readFileSync(path.join(output, 'audit.json'), 'utf8'));
  if (report.completion !== 'COMPLETE' || audit.status !== 'PASS')
    throw new Error('Polygon census or independent audit did not complete.');
  console.log(`P3 polygon census ${parsed.mode}: COMPLETE; rows=${report.rows.count}`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
