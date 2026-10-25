// P3 B0 spike runner: `pnpm benchmark:p3-b0-spike --profile functional|reference
// [--environment-json <observations.json>]`. Mechanics are frozen by
// docs/plans/p3-b0-spike-ladder-contract.md section 5; the B0 modules it imports
// (tests/geometry/p3-b0, tooling/run-p3-b0-benchmark.mjs) are used unchanged.
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
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

// The spike's TypeScript modules import each other with `.js` specifiers, as the type checker
// requires; Node's type stripping loads the `.ts` file only when the `.js` one is absent.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
        const candidate = new URL(specifier.replace(/\.js$/u, '.ts'), context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  },
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, '.tools');
const rustup = path.join(
  tools,
  'rust/cargo/bin',
  process.platform === 'win32' ? 'rustup.exe' : 'rustup',
);
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const temporary = path.join(tools, 'geometry-tmp');
const RUST = {
  release: '1.94.1',
  commit: 'e408947bfd200af42db322daf0fadfe7e26d3bd1',
  host: 'x86_64-pc-windows-msvc',
};
const REPETITION_TIMEOUT_MS = 45 * 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
// Section 5.10: the decision build is B0's, in B0's decision target directory.
const DECISION_TARGET = path.join(tools, 'geometry-build');
const SOURCE_ROOTS = [
  'docs/plans/p3-b0-spike-ladder-contract.md',
  'tooling/run-p3-b0-spike-benchmark.mjs',
  'tooling/run-p3-b0-benchmark.mjs',
  'tests/geometry/p3-b0',
  'tests/geometry/p3-b0-spike',
  'tests/geometry/rounded-fill/exact.ts',
  'packages/geometry-reference/src/triangle-mesh.ts',
  'packages/geometry-wasm/kernel/src',
  'packages/geometry-wasm/kernel/Cargo.toml',
  'packages/geometry-wasm/kernel/Cargo.lock',
];

const { parseArguments, readEnvironmentObservations } = await import(
  pathToFileURL(path.join(root, 'tooling/run-p3-b0-benchmark.mjs')).href
);
const { corpusCells, encodeCorpus } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-b0/corpus.ts')).href
);
const { canonicalJson, configHash } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-b0/analysis.ts')).href
);
const {
  B0_IDENTITY_RECORD,
  CORPUS_SHA256,
  SPIKE_RUNNER_VERSION,
  SPIKE_SCHEMA_VERSION,
  analyze,
  evaluateOracle,
  oracleStatus,
  scenarioConfig,
  validateSpikeRecord,
} = await import(pathToFileURL(path.join(root, 'tests/geometry/p3-b0-spike/analysis.ts')).href);

export { parseArguments };

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

function cargoEnvironment(targetDirectory) {
  const flags = ['--remap-path-prefix', `${root}=.`, '--remap-path-prefix', 'src\\=src/'];
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
    env: cargoEnvironment(DECISION_TARGET).env,
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
    : [...base, `p3_b0_spike_bench::${name}`, '--', '--ignored', '--exact', '--nocapture'];
}

function writeExclusive(file, text) {
  writeFileSync(file, text, { flag: 'wx' });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function reserveOutput() {
  const parent = path.join(root, 'artifacts/p3-b0-spike');
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

/**
 * Section 5.11: a process listing shortly before the start, kept as an artifact; the record
 * holds its time, count, hash and path. No CPU-load sampling.
 */
function captureProcessListing(output) {
  const capturedAt = new Date().toISOString();
  const command =
    process.platform === 'win32'
      ? ['tasklist.exe', ['/fo', 'csv', '/nh']]
      : ['ps', ['-eo', 'comm']];
  const result = spawnSync(command[0], command[1], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) return null;
  const file = path.join(output, 'process-listing.txt');
  writeExclusive(file, result.stdout);
  return {
    capturedAt,
    command: [command[0], ...command[1]].join(' '),
    processes: result.stdout.split(/\r?\n/u).filter((line) => line.trim() !== '').length,
    sha256: sha256(result.stdout),
    file: path.relative(root, file).split(path.sep).join('/'),
  };
}

const fixed = (value, digits) =>
  value === null || value === undefined ? '-' : value.toFixed(digits);

function summaryMarkdown(record) {
  const { analysis } = record;
  const lines = [
    `# P3 B0 spike run ${record.run.runId}`,
    '',
    `Profile: ${record.scenario.profile}. Verdict: **${analysis.verdict}**${analysis.verdict === 'INVALID' ? ` (no verdict: ${analysis.invalidReasons.join(', ')})` : ''}. Scenario ${record.scenario.id} v${record.scenario.version}, config ${record.scenario.configHash}.`,
    '',
    '| Oracle gate | Checked | Failures | Pass |',
    '| --- | --- | --- | --- |',
    ...analysis.oracle.gates.map(
      (gate) => `| ${gate.id} | ${gate.checked} | ${gate.failures} | ${gate.pass ? 'yes' : 'NO'} |`,
    ),
    '',
    `Harness: S1 accessor ${analysis.oracle.harness.s1Accessor ? 'PASS' : 'FAIL'}; ladder allocation-free (oracle run) ${analysis.oracle.harness.allocationFree ? 'PASS' : 'FAIL'}; allocation-free timed batches ${analysis.allocationFreeBatches ? 'yes' : 'NO'}; allocation-free admission ${analysis.allocationFreeAdmission ? 'yes' : 'NO'}.`,
    '',
    '| Check | Pass | Detail |',
    '| --- | --- | --- |',
    ...analysis.checks.map(
      (item) => `| ${item.id} | ${item.pass ? 'yes' : 'NO'} | ${item.detail} |`,
    ),
    '',
    `Timed decision paths on the fast rung: ${fixed(analysis.timedFastShare === null ? null : 100 * analysis.timedFastShare, 1)}%. Fallback rate at the largest cell: ${analysis.seriesFallback.map((item) => `${item.series} ${fixed(item.fallbackRate, 3)}`).join(', ')}.`,
    '',
  ];
  if (analysis.estimates) {
    const e = analysis.estimates;
    lines.push(
      `Estimates (k = ${record.scenario.config.decision.wasmFactor}): initial ${e.initialMs.toFixed(1)} ms, edit proxy ${e.editMs.toFixed(3)} ms, mesh ${(e.meshBytes / 2 ** 20).toFixed(2)} MiB, per path ${(e.perPathNs / 1e6).toFixed(3)} ms; budget ratios ${analysis.ratios.initial.toFixed(3)}, ${analysis.ratios.edit.toFixed(3)}, ${analysis.ratios.mesh.toFixed(3)}.`,
      '',
    );
  }
  if (record.oracle) {
    lines.push('| O1 cell | Fast | Fallbacks | Conservative | Exact OK | Record OK |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const item of record.oracle.o1)
      lines.push(
        `| ${item.cell} | ${item.fast} | ${Object.entries(item.fallbacks)
          .map(([reason, count]) => `${reason} ${count}`)
          .join(', ')} | ${item.conservative} | ${item.exactOk} | ${item.referenceExactOk} |`,
      );
    lines.push('');
    lines.push(
      `O2: ${record.oracle.o2.map((item) => `${item.cell} ${item.asExpected ? 'as expected' : 'NOT as expected'}`).join(', ')}.`,
      '',
    );
    // SL-O6 (section 4.6), with the contracted-contour note of the SL-U1 plan entry.
    const shares = record.oracle.geometricError.filter((item) => item.fastPaths > 0);
    const largest = (key) => {
      let value = null;
      for (const item of shares)
        if (item[key] !== null && (value === null || item[key] > value)) value = item[key];
      return value === null ? 'none' : value;
    };
    lines.push(
      `SL-O6 on fast-rung paths: curve share max certified deviation ${largest('maxCertifiedDeviation')} and exact max |d_m| ${largest('maxExactDeviation')} (δ = 0.125); topology share ${shares.every((item) => item.topologyShare === 0) ? '0 (SL-O2)' : 'not shown zero'}; storage share not applicable (no Float32 packing). On ${shares.reduce((sum, item) => sum + item.contractedContours, 0)} contracted contours (SL-L5) the certificate bounds P′; the triangulated P differs from the source by up to δ̄(e′) + |k − m|, with max |k − m| = ${largest('maxContractedKnotGap')}.`,
      '',
    );
  }
  if (analysis.diagnostic) {
    lines.push(
      '| Diagnostic cell | Prefix ns | Certificate ns | Classification ns | Triangulation ns | Fast ns | Exact ns |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const item of analysis.diagnostic)
      lines.push(
        `| ${item.cell} | ${item.stagesNs.prefix} | ${item.stagesNs.certificate} | ${item.stagesNs.classification} | ${item.stagesNs.triangulation} | ${item.stagesNs.fastTotal} | ${item.stagesNs.exactAlone} |`,
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

  const config = scenarioConfig(options.profile);
  const corpus = encodeCorpus(corpusCells());
  const corpusSha = sha256(corpus);
  if (corpusSha !== CORPUS_SHA256)
    throw new Error(`Corpus SHA-256 ${corpusSha} differs from the pinned ${CORPUS_SHA256}.`);
  const identityRecord = JSON.parse(readFileSync(path.join(root, B0_IDENTITY_RECORD), 'utf8'));

  const { runId, output } = reserveOutput();
  console.log(`P3 B0 spike ${options.profile} output: ${path.relative(root, output)}`);
  const processListing = captureProcessListing(output);
  const started = new Date();
  const corpusPath = path.join(output, 'corpus.bin');
  writeFileSync(corpusPath, corpus, { flag: 'wx' });
  const run = {
    runId,
    runner: SPIKE_RUNNER_VERSION,
    command: ['pnpm', 'benchmark:p3-b0-spike', ...args].join(' '),
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
  const cargo = cargoEnvironment(DECISION_TARGET);
  await runLogged(
    cargoTestArgs('run_spike_decision', true),
    cargo.env,
    path.join(output, 'build-decision.log'),
    BUILD_TIMEOUT_MS,
    'Decision build',
  );
  // A failed or timed-out process is retained as a failure; the run continues and the record
  // fails check 7 or its oracle gates rather than being lost (section 5.12).
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
      console.error(`P3 B0 spike ${stage}: FAILED; retained in the record`);
      return false;
    }
  };
  const repetitions = [];
  for (let repetition = 0; repetition < sampling.repetitions; repetition += 1) {
    const file = path.join(output, `repetition-${repetition}.json`);
    const log = path.join(output, `repetition-${repetition}.log`);
    const ok = await attemptStage(`repetition-${repetition}`, log, async () => {
      await runLogged(
        cargoTestArgs('run_spike_decision'),
        {
          ...cargo.env,
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
    if (ok) console.log(`P3 B0 spike repetition ${repetition}: complete`);
  }

  // Section 5.8: one separate diagnostic process on the decision build (reference only).
  let diagnostic = null;
  if (sampling.diagnostic) {
    const file = path.join(output, 'diagnostic.json');
    const log = path.join(output, 'diagnostic.log');
    const ran = await attemptStage('diagnostic-run', log, async () => {
      await runLogged(
        cargoTestArgs('run_spike_diagnostic'),
        {
          ...cargo.env,
          P3_B0_INPUT: corpusPath,
          P3_B0_OUTPUT: file,
          P3_B0_DIAG_WARMUP: String(sampling.diagnostic.warmup),
          P3_B0_DIAG_TIMED: String(sampling.diagnostic.timed),
        },
        log,
        REPETITION_TIMEOUT_MS,
        'Diagnostic run',
      );
      diagnostic = JSON.parse(readFileSync(file, 'utf8'));
    });
    if (ran) console.log('P3 B0 spike diagnostic run: complete');
  }

  // Section 5.9: one separate, untimed oracle process after the repetitions, then SL-O1 to
  // SL-O7 in TypeScript on its dump.
  let oracle = null;
  {
    const file = path.join(output, 'oracle.json');
    const dumpFile = path.join(output, 'oracle-dump.json');
    const log = path.join(output, 'oracle.log');
    const ran = await attemptStage('oracle-run', log, async () => {
      await runLogged(
        cargoTestArgs('run_spike_oracle'),
        { ...cargo.env, P3_B0_INPUT: corpusPath, P3_B0_OUTPUT: file, P3_B0_SPIKE_DUMP: dumpFile },
        log,
        REPETITION_TIMEOUT_MS,
        'Oracle run',
      );
      const harness = JSON.parse(readFileSync(file, 'utf8'));
      const dumpBytes = readFileSync(dumpFile);
      console.log('P3 B0 spike oracle run: complete; evaluating SL-O1 to SL-O7');
      oracle = evaluateOracle(
        JSON.parse(dumpBytes.toString('utf8')),
        harness,
        { sha256: sha256(dumpBytes), bytes: dumpBytes.length },
        identityRecord,
      );
    });
    if (ran) console.log('P3 B0 spike oracles: evaluated');
  }

  const cpus = os.cpus();
  const record = {
    schemaVersion: SPIKE_SCHEMA_VERSION,
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
      processListing,
      cpuLoadSampling: { applicable: false, reason: "not sampled, per the user's instruction" },
      browser: { applicable: false, reason: 'native Rust benchmark; no browser' },
      gpu: { applicable: false, reason: 'native CPU benchmark; no GPU work' },
      display: { applicable: false, reason: 'no viewport or DPR in a native run' },
    },
    builds: {
      toolchain: rust,
      decision: {
        command: cargoTestArgs('run_spike_decision').join(' '),
        diagnosticCommand: cargoTestArgs('run_spike_diagnostic').join(' '),
        oracleCommand: cargoTestArgs('run_spike_oracle').join(' '),
        targetDirectory: path.relative(root, DECISION_TARGET),
        rustflags: cargo.flags,
        target: RUST.host,
        artifact: 'libtest harness, release profile (opt-level 3, LTO, one codegen unit), unwind',
        knownOverhead: [
          'panic=unwind in the test harness',
          'cfg(test) tracking global allocator compiled in, inactive while timing',
          'cfg(test) fill_filter::record decided/fallback counters compiled in',
        ],
      },
    },
    corpus: { sha256: corpusSha, bytes: corpus.length },
    repetitions,
    diagnostic,
    oracle,
    failures,
  };
  // The raw record is written first, so that the samples survive an analysis failure or a
  // source change; a changed source still invalidates the run.
  writeExclusive(path.join(output, 'raw-record.json'), `${JSON.stringify(record)}\n`);
  if (canonicalJson(sourceManifest()) !== canonicalJson(manifestBefore))
    throw new Error('Source files changed during the run; it is invalid. See raw-record.json.');
  const complete = { ...record, analysis: analyze(record) };
  validateSpikeRecord(JSON.parse(JSON.stringify(complete)));
  writeExclusive(path.join(output, 'record.json'), `${JSON.stringify(complete)}\n`);
  writeExclusive(path.join(output, 'summary.md'), summaryMarkdown(complete));
  const gates = oracleStatus(complete.oracle);
  console.log(
    `P3 B0 spike ${options.profile}: verdict ${complete.analysis.verdict}; oracle gates ${gates.gates
      .map((gate) => `${gate.id} ${gate.pass ? 'PASS' : 'FAIL'}`)
      .join(', ')}; ${path.relative(root, output)}`,
  );
  // An oracle-gate failure invalidates the run (section 4); the record is retained.
  if (!gates.valid || !gates.harness.s1Accessor || !gates.harness.allocationFree)
    throw new Error(
      `Oracle or harness check failed; the run is invalid and retained in ${output}.`,
    );
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
