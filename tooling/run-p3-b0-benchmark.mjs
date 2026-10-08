// P3 B0 feasibility runner: `pnpm benchmark:p3-b0 --profile functional|reference
// [--environment-json <observations.json>]`. Mechanics are frozen by
// docs/plans/p3-b0-feasibility-benchmark-contract.md sections 3, 4 and 7.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, '.tools');
const rustup = path.join(
  tools,
  'rust/cargo/bin',
  process.platform === 'win32' ? 'rustup.exe' : 'rustup',
);
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const temporary = path.join(tools, 'geometry-tmp');
const RUNNER_VERSION = 'p3-b0-runner/1';
const RUST = {
  release: '1.94.1',
  commit: 'e408947bfd200af42db322daf0fadfe7e26d3bd1',
  host: 'x86_64-pc-windows-msvc',
};
const REPETITION_TIMEOUT_MS = 45 * 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const DECISION_TARGET = path.join(tools, 'geometry-build');
const DIAGNOSTIC_TARGET = path.join(tools, 'geometry-build-p3-b0-diag');
const SOURCE_ROOTS = [
  'docs/plans/p3-b0-feasibility-benchmark-contract.md',
  'tooling/run-p3-b0-benchmark.mjs',
  'tests/geometry/p3-b0',
  'packages/geometry-wasm/kernel/src',
  'packages/geometry-wasm/kernel/Cargo.toml',
  'packages/geometry-wasm/kernel/Cargo.lock',
];

const { corpusCells, encodeCorpus, scenarioConfig } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-b0/corpus.ts')).href
);
const { analyze, canonicalJson, configHash, validateRecord } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-b0/analysis.ts')).href
);

export function parseArguments(args) {
  const parsed = { profile: null, environmentJson: null };
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    if (flag === '--profile') {
      if (parsed.profile !== null) throw new Error('Duplicate --profile.');
      if (value !== 'functional' && value !== 'reference')
        throw new Error('--profile must be functional or reference.');
      parsed.profile = value;
    } else if (flag === '--environment-json') {
      if (parsed.environmentJson !== null) throw new Error('Duplicate --environment-json.');
      parsed.environmentJson = value;
    } else throw new Error(`Unknown argument ${flag}.`);
  }
  if (parsed.profile === null) throw new Error('--profile is required.');
  if (parsed.profile === 'reference' && parsed.environmentJson === null)
    throw new Error('The reference profile requires --environment-json.');
  return parsed;
}

function observation(value, name) {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.value !== 'string' ||
    value.value.trim() === '' ||
    typeof value.source !== 'string' ||
    value.source.trim() === ''
  )
    throw new Error(`Environment ${name} needs a nonempty {value, source} observation.`);
  return { value: value.value, source: value.source };
}

export function readEnvironmentObservations(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed.observedAt !== 'string' || Number.isNaN(Date.parse(parsed.observedAt)))
    throw new Error('Environment observedAt must be an ISO timestamp.');
  return {
    observedAt: parsed.observedAt,
    power: observation(parsed.power, 'power'),
    backgroundLoad: observation(parsed.backgroundLoad, 'backgroundLoad'),
  };
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function listFiles(relative) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isDirectory())
    return readdirSync(absolute).flatMap((name) => listFiles(path.join(relative, name)));
  return [relative.split(path.sep).join('/')];
}

export function sourceManifest() {
  const files = SOURCE_ROOTS.flatMap(listFiles).sort();
  return Object.fromEntries(
    files.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(path.join(root, file)))
        .digest('hex'),
    ]),
  );
}

function cargoEnvironment(targetDirectory, diagnostic) {
  const flags = ['--remap-path-prefix', `${root}=.`];
  if (diagnostic) flags.push('--cfg', 'p3_b0_diag');
  return {
    flags,
    env: {
      ...process.env,
      CARGO_HOME: path.join(tools, 'rust/cargo'),
      RUSTUP_HOME: path.join(tools, 'rust/rustup'),
      CARGO_TARGET_DIR: targetDirectory,
      CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f'),
      TEMP: temporary,
      TMP: temporary,
    },
  };
}

function inspectToolchain() {
  if (!existsSync(rustup)) throw new Error('Pinned Rust toolchain is missing.');
  const result = spawnSync(rustup, ['run', RUST.release, 'rustc', '--version', '--verbose'], {
    cwd: root,
    env: cargoEnvironment(DECISION_TARGET, false).env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) throw new Error('Pinned rustc inspection failed.');
  const field = (name) =>
    result.stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2);
  const identity = { release: field('release'), commit: field('commit-hash'), host: field('host') };
  if (
    identity.release !== RUST.release ||
    identity.commit !== RUST.commit ||
    identity.host !== RUST.host
  )
    throw new Error(`Pinned Rust identity mismatch: ${JSON.stringify(identity)}`);
  return { ...identity, verbose: result.stdout.trim() };
}

async function runLogged(args, env, logPath, timeoutMs, label) {
  const log = openSync(logPath, 'wx');
  const child = spawn(rustup, ['run', RUST.release, 'cargo', ...args], {
    cwd: root,
    env,
    stdio: ['ignore', log, log],
    windowsHide: true,
    // Outside Windows a detached group lets a timeout stop cargo and the test binary too.
    detached: process.platform !== 'win32',
  });
  const outcome = await new Promise((resolve) => {
    let error = null;
    const timer = setTimeout(() => {
      error = new Error(`${label} exceeded ${timeoutMs} ms`);
      if (child.pid && process.platform === 'win32') {
        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (failure) {
          error = new Error(`${error.message}; cleanup: ${String(failure)}`);
        }
      } else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (failure) {
          error = new Error(`${error.message}; cleanup: ${String(failure)}`);
        }
      }
    }, timeoutMs);
    child.on('error', (failure) => {
      error = failure;
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, error });
    });
  });
  closeSync(log);
  if (outcome.error) throw outcome.error;
  if (outcome.status !== 0 || outcome.signal)
    throw new Error(
      `${label} failed (${String(outcome.status ?? outcome.signal)}); log=${path.relative(root, logPath)}`,
    );
}

function cargoTestArgs(name, noRun = false) {
  const base = ['test', '--manifest-path', manifest, '--release', '--lib', '--locked', '--offline'];
  return noRun
    ? [...base, '--no-run']
    : [...base, `p3_b0_bench::${name}`, '--', '--ignored', '--exact', '--nocapture'];
}

function writeExclusive(file, text) {
  writeFileSync(file, text, { flag: 'wx' });
}

function reserveOutput() {
  const parent = path.join(root, 'artifacts/p3-b0');
  mkdirSync(parent, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const runId = `${stamp}-${randomBytes(4).toString('hex')}`;
  const output = path.join(parent, runId);
  mkdirSync(output);
  return { runId, output };
}

function summaryMarkdown(record) {
  const { analysis } = record;
  const lines = [
    `# P3 B0 feasibility run ${record.run.runId}`,
    '',
    `Profile: ${record.scenario.profile}. Verdict: **${analysis.verdict}**. Scenario ${record.scenario.id} v${record.scenario.version}, config ${record.scenario.configHash}.`,
    '',
    '| Check | Pass | Detail |',
    '| --- | --- | --- |',
    ...analysis.checks.map(
      (item) => `| ${item.id} | ${item.pass ? 'yes' : 'NO'} | ${item.detail} |`,
    ),
    '',
  ];
  lines.push(
    `Allocation-free timed batches: ${analysis.allocationFreeBatches ? 'yes' : 'NO'}. Failed processes: ${analysis.failures.length === 0 ? 'none' : analysis.failures.map((item) => item.stage).join(', ')}.`,
    '',
  );
  if (analysis.estimates) {
    const e = analysis.estimates;
    lines.push(
      `Estimates (k = ${record.scenario.config.decision.wasmFactor}): initial ${e.initialMs.toFixed(1)} ms, edit proxy ${e.editMs.toFixed(3)} ms, mesh ${(e.meshBytes / 2 ** 20).toFixed(2)} MiB, per path ${(e.perPathNs / 1e6).toFixed(3)} ms.`,
      '',
    );
  }
  if (analysis.h1) {
    lines.push(
      '| H1 series | Cell | Exact share | Overhead | Verdict |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const item of analysis.h1)
      lines.push(
        `| ${item.series} | ${item.cell ?? '-'} | ${item.exactShare?.toFixed(3) ?? '-'} | ${item.overhead?.toFixed(3) ?? '-'} | ${item.verdict} |`,
      );
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const observations = options.environmentJson
    ? readEnvironmentObservations(path.resolve(options.environmentJson))
    : null;
  const status = git('status', '--porcelain');
  if (options.profile === 'reference' && status !== '')
    throw new Error('The reference profile requires a clean worktree.');
  mkdirSync(temporary, { recursive: true });
  const rust = inspectToolchain();
  const manifestBefore = sourceManifest();
  const { runId, output } = reserveOutput();
  console.log(`P3 B0 ${options.profile} output: ${path.relative(root, output)}`);
  const started = new Date();

  const config = scenarioConfig(options.profile);
  const corpus = encodeCorpus(corpusCells());
  const corpusPath = path.join(output, 'corpus.bin');
  writeFileSync(corpusPath, corpus, { flag: 'wx' });
  const run = {
    runId,
    runner: RUNNER_VERSION,
    command: ['pnpm', 'benchmark:p3-b0', ...args].join(' '),
    utcStart: started.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    commit: git('rev-parse', 'HEAD'),
    dirty: status !== '',
    dirtyFiles: status === '' ? [] : status.split(/\r?\n/u),
    node: process.versions.node,
    sourceManifest: manifestBefore,
  };
  writeExclusive(
    path.join(output, 'invocation.json'),
    `${JSON.stringify({ run, config }, null, 2)}\n`,
  );

  const sampling = config.sampling;
  const decisionCargo = cargoEnvironment(DECISION_TARGET, false);
  await runLogged(
    cargoTestArgs('run_decision', true),
    decisionCargo.env,
    path.join(output, 'build-decision.log'),
    BUILD_TIMEOUT_MS,
    'Decision build',
  );
  // A failed or timed-out process is retained as a failure; the run continues and the
  // record fails check 7 (contract sections 3 and 5) rather than being lost.
  const repetitions = [];
  const failures = [];
  const attemptStage = async (stage, log, action) => {
    try {
      await action();
      return true;
    } catch (error) {
      failures.push({
        stage,
        error: String(error instanceof Error ? error.message : error),
        log: path.relative(root, log),
      });
      console.error(`P3 B0 ${stage}: FAILED; retained in the record`);
      return false;
    }
  };
  for (let repetition = 0; repetition < sampling.repetitions; repetition += 1) {
    const file = path.join(output, `repetition-${repetition}.json`);
    const log = path.join(output, `repetition-${repetition}.log`);
    const ok = await attemptStage(`repetition-${repetition}`, log, async () => {
      await runLogged(
        cargoTestArgs('run_decision'),
        {
          ...decisionCargo.env,
          P3_B0_INPUT: corpusPath,
          P3_B0_OUTPUT: file,
          P3_B0_REPETITION: String(repetition),
          P3_B0_WARMUP: String(sampling.warmup),
          P3_B0_TIMED: String(sampling.timed),
          P3_B0_LIN_WARMUP: String(sampling.linearityWarmup),
          P3_B0_LIN_TIMED: String(sampling.linearityTimed),
        },
        log,
        REPETITION_TIMEOUT_MS,
        `Repetition ${repetition}`,
      );
      repetitions.push(JSON.parse(readFileSync(file, 'utf8')));
    });
    if (ok) console.log(`P3 B0 repetition ${repetition}: complete`);
  }

  let diagnostic = null;
  const diagnosticCargo = cargoEnvironment(DIAGNOSTIC_TARGET, true);
  if (sampling.diagnostic) {
    const buildLog = path.join(output, 'build-diagnostic.log');
    const runLog = path.join(output, 'diagnostic.log');
    const built = await attemptStage('diagnostic-build', buildLog, () =>
      runLogged(
        cargoTestArgs('run_diagnostic', true),
        diagnosticCargo.env,
        buildLog,
        BUILD_TIMEOUT_MS,
        'Diagnostic build',
      ),
    );
    const file = path.join(output, 'diagnostic.json');
    const ran =
      built &&
      (await attemptStage('diagnostic-run', runLog, async () => {
        await runLogged(
          cargoTestArgs('run_diagnostic'),
          {
            ...diagnosticCargo.env,
            P3_B0_INPUT: corpusPath,
            P3_B0_OUTPUT: file,
            P3_B0_DIAG_WARMUP: String(sampling.diagnostic.warmup),
            P3_B0_DIAG_TIMED: String(sampling.diagnostic.timed),
            P3_B0_REPLAY_LOOPS: String(sampling.diagnostic.replayLoops),
            P3_B0_REPLAY_CALLS: String(sampling.diagnostic.replayCalls),
          },
          runLog,
          REPETITION_TIMEOUT_MS,
          'Diagnostic run',
        );
        diagnostic = JSON.parse(readFileSync(file, 'utf8'));
      }));
    if (ran) console.log('P3 B0 diagnostic run: complete');
  }

  const cpus = os.cpus();
  const record = {
    schemaVersion: 1,
    scenario: {
      id: config.scenario.id,
      version: config.scenario.version,
      profile: options.profile,
      config,
      configHash: configHash(config),
    },
    run: { ...run, utcEnd: new Date().toISOString() },
    environment: {
      observedAt: observations?.observedAt ?? null,
      os: { type: os.type(), release: os.release(), version: os.version(), arch: os.arch() },
      cpu: cpus[0]?.model ?? null,
      logicalCores: cpus.length,
      memoryBytes: os.totalmem(),
      timezone: run.timezone,
      power: observations?.power ?? null,
      backgroundLoad: observations?.backgroundLoad ?? null,
      browser: { applicable: false, reason: 'native Rust benchmark; no browser' },
      gpu: { applicable: false, reason: 'native CPU benchmark; no GPU work' },
      display: { applicable: false, reason: 'no viewport or DPR in a native run' },
    },
    builds: {
      toolchain: rust,
      decision: {
        command: cargoTestArgs('run_decision').join(' '),
        targetDirectory: path.relative(root, DECISION_TARGET),
        rustflags: decisionCargo.flags,
        artifact: 'libtest harness, release profile (opt-level 3, LTO, one codegen unit), unwind',
        knownOverhead: [
          'panic=unwind in the test harness',
          'cfg(test) tracking global allocator compiled in, inactive while timing',
        ],
      },
      diagnostic: sampling.diagnostic
        ? {
            command: cargoTestArgs('run_diagnostic').join(' '),
            targetDirectory: path.relative(root, DIAGNOSTIC_TARGET),
            rustflags: diagnosticCargo.flags,
          }
        : null,
    },
    corpus: { sha256: createHash('sha256').update(corpus).digest('hex'), bytes: corpus.length },
    repetitions,
    diagnostic,
    failures,
  };
  // The raw record is written first, so that the samples survive an analysis failure or a
  // source change; a changed source still invalidates the run.
  writeExclusive(path.join(output, 'raw-record.json'), `${JSON.stringify(record)}\n`);
  if (canonicalJson(sourceManifest()) !== canonicalJson(manifestBefore))
    throw new Error('Source files changed during the run; it is invalid. See raw-record.json.');
  const complete = { ...record, analysis: analyze(record) };
  validateRecord(JSON.parse(JSON.stringify(complete)));
  writeExclusive(path.join(output, 'record.json'), `${JSON.stringify(complete)}\n`);
  writeExclusive(path.join(output, 'summary.md'), summaryMarkdown(complete));
  console.log(
    `P3 B0 ${options.profile}: verdict ${complete.analysis.verdict}; ${path.relative(root, output)}`,
  );
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
