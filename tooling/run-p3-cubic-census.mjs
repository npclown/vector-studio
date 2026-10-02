import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA,
  createInvocation,
  writeIncomplete,
  writeJsonExclusive,
} from '../tests/p3-census/artifact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, '.tools');
const config = path.join(root, 'vitest.p3-cubic-census.config.ts');
const rustup = path.join(tools, 'rust/cargo/bin/rustup.exe');
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
const temporary = path.join(tools, 'geometry-tmp');
const EXPECTED_NODE = '24.15.0';
const EXPECTED_RUST = '1.94.1';
const EXPECTED_COMMIT = 'e408947bfd200af42db322daf0fadfe7e26d3bd1';
const EXPECTED_HOST = 'x86_64-pc-windows-msvc';
const REQUIRED_TRACKED = [
  'docs/plans/p3-cubic-census-contract.md',
  'tooling/run-p3-cubic-census.mjs',
  'tooling/run-p3-cubic-census.d.mts',
  'vitest.p3-cubic-census.config.ts',
  'tests/p3-census/artifact.mjs',
  'tests/p3-census/artifact.d.mts',
  'tests/p3-census/census.test.ts',
  'tests/p3-census/fixtures.ts',
  'tests/p3-census/mechanics.test.ts',
  'tests/p3-census/schema.ts',
];

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--smoke') return { mode: 'SMOKE', requested: null };
  if (args.length === 3 && args[0] === '--full' && args[1] === '--output' && args[2])
    return { mode: 'FULL', requested: args[2] };
  throw new Error('Expected exactly --smoke or --full --output <fresh-directory>.');
}

export function reserveOutput(mode, requested) {
  mkdirSync(tools, { recursive: true });
  if (mode === 'SMOKE') return mkdtempSync(path.join(tools, 'p3-cubic-census-'));
  const output = path.resolve(root, requested);
  const relative = path.relative(tools, output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('FULL output must be a fresh directory below repository .tools.');
  if (existsSync(output)) throw new Error('Census output directory already exists.');
  // Resolve the existing parent as well: a junction must not escape .tools.
  const parent = realpathSync(path.dirname(output));
  const realTools = realpathSync(tools);
  const parentRelative = path.relative(realTools, parent);
  if (parentRelative.startsWith('..') || path.isAbsolute(parentRelative))
    throw new Error('Census output parent escapes repository .tools.');
  mkdirSync(output);
  return output;
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function assertFullSource() {
  if (git('status', '--porcelain') !== '') throw new Error('FULL requires a clean worktree.');
  for (const file of REQUIRED_TRACKED) git('cat-file', '-e', `HEAD:${file}`);
}

export function assertToolchainPresent(file) {
  if (!existsSync(file)) throw new Error('Pinned Rust toolchain is missing.');
}

export function validateToolchainIdentity({ nodeVersion, release, commit, host }) {
  if (nodeVersion !== EXPECTED_NODE)
    throw new Error(`Node ${EXPECTED_NODE} is required; received ${nodeVersion}.`);
  if (release !== EXPECTED_RUST || commit !== EXPECTED_COMMIT || host !== EXPECTED_HOST)
    throw new Error('Pinned Rust release/commit/host identity mismatch.');
  return { release, commit, host };
}

export function workerOutcome(result, label) {
  if (result.error) throw new Error(`${label}: ${String(result.error)}`);
  if (result.status !== 0 || result.signal)
    throw new Error(`${label} failed (${String(result.status ?? result.signal)}).`);
}

function environment() {
  return {
    ...process.env,
    CARGO_HOME: path.join(tools, 'rust/cargo'),
    RUSTUP_HOME: path.join(tools, 'rust/rustup'),
    CARGO_TARGET_DIR: path.join(tools, 'geometry-build'),
    CARGO_ENCODED_RUSTFLAGS: ['--remap-path-prefix', `${root}=.`].join('\x1f'),
    TEMP: temporary,
    TMP: temporary,
    P2_NATIVE_RUSTUP: rustup,
    P3_CENSUS_MODE: 'bounded-v1',
  };
}

function inspectToolchain() {
  assertToolchainPresent(rustup);
  const result = spawnSync(rustup, ['run', EXPECTED_RUST, 'rustc', '--version', '--verbose'], {
    cwd: root,
    env: environment(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  workerOutcome(result, 'Pinned rustc inspection');
  const field = (name) =>
    result.stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2);
  return validateToolchainIdentity({
    nodeVersion: process.versions.node,
    release: field('release'),
    commit: field('commit-hash'),
    host: field('host'),
  });
}

async function runPhase(mode, output, phase) {
  const logPath = path.join(output, `${phase.toLowerCase()}.log`);
  const log = openSync(logPath, 'wx');
  const child = spawn(process.execPath, [vitest, 'run', '--config', config], {
    cwd: root,
    env: {
      ...environment(),
      P3_CENSUS_RUN_MODE: mode,
      P3_CENSUS_OUTPUT: output,
      P3_CENSUS_PHASE: phase,
    },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  return await new Promise((resolve) => {
    let error = null;
    const timer = setTimeout(() => {
      error = new Error(`${phase} exceeded frozen 900000 ms process limit`);
      // Stop only this owned process and its worker/native descendants before publishing failure.
      if (child.pid) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (terminationError) {
          error = new Error(`${error.message}; process cleanup: ${String(terminationError)}`);
        }
      }
    }, 900_000);
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
  if (parsed.mode === 'FULL') assertFullSource();
  mkdirSync(temporary, { recursive: true });
  const rust = inspectToolchain();
  const output = reserveOutput(parsed.mode, parsed.requested);
  createInvocation(root, output, parsed.mode, rust);
  console.log(`P3 cubic census ${parsed.mode} output: ${path.relative(root, output)}`);
  for (const phase of parsed.mode === 'SMOKE' ? ['MECHANICS', 'RUN', 'AUDIT'] : ['RUN', 'AUDIT']) {
    const result = await runPhase(parsed.mode, output, phase);
    try {
      workerOutcome(result, `Census ${phase}`);
    } catch (error) {
      if (phase === 'AUDIT') {
        const file = path.join(output, 'audit.json');
        if (!existsSync(file))
          writeJsonExclusive(file, {
            schema: SCHEMA,
            mode: parsed.mode,
            status: 'FAIL',
            failure: String(error),
          });
      } else writeIncomplete(root, output, 'WORKER', String(error));
      throw new Error(`${String(error)}; log=${path.relative(root, result.logPath)}`, {
        cause: error,
      });
    }
    console.log(`P3 cubic census ${phase}: PASS; log=${path.relative(root, result.logPath)}`);
  }
  const census = JSON.parse(readFileSync(path.join(output, 'census.json'), 'utf8'));
  const audit = JSON.parse(readFileSync(path.join(output, 'audit.json'), 'utf8'));
  if (census.completion !== 'COMPLETE' || audit.status !== 'PASS')
    throw new Error('Census or independent audit did not complete.');
  console.log(`P3 cubic census ${parsed.mode}: COMPLETE; rows=${census.rows.count}`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
