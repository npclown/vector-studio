// P3 Alt-A1 AL-S1 runner: `pnpm benchmark:p3-fill-ladder --profile functional|reference
// [--environment-json <observations.json>]`. Mechanics are frozen by
// docs/plans/p3-alt-a1-fill-ladder-contract.md section 5.3; the B0 and spike modules it
// imports (tests/geometry/p3-b0, tests/geometry/p3-b0-spike, tooling/run-p3-b0-benchmark.mjs)
// are used unchanged. `runRatioMode` is the AL-S1 harness's ratio mode, which only AL-S2's
// runner calls (section 5.2); it is outside AL-S1's record and verdict.
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

// The TypeScript modules import each other with `.js` specifiers, as the type checker
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
// The decision build is B0's, in B0's decision target directory, as the spike's was.
const DECISION_TARGET = path.join(tools, 'geometry-build');
const SOURCE_ROOTS = [
  'docs/plans/p3-alt-a1-fill-ladder-contract.md',
  'tooling/run-p3-fill-ladder-benchmark.mjs',
  'tooling/run-p3-b0-benchmark.mjs',
  'tests/geometry/p3-b0',
  'tests/geometry/p3-b0-spike',
  'tests/geometry/p3-b0r/corpus.ts',
  'tests/geometry/p3-fill-ladder',
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
const { encodeDumpInput, encodeLadderCorpus } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-fill-ladder/corpus.ts')).href
);
const { parseLadderDump } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-fill-ladder/dump.ts')).href
);
const {
  B0_IDENTITY_RECORD,
  CORPUS_SHA256,
  LADDER_CORPUS_SHA256,
  LADDER_RUNNER_VERSION,
  LADDER_SCHEMA_VERSION,
  analyze,
  analyzeRatioNative,
  evaluateLadderOracle,
  oracleDumpInputs,
  oracleDumpNames,
  oracleStatus,
  ratioModeConfig,
  scenarioConfig,
  validateLadderRecord,
} = await import(pathToFileURL(path.join(root, 'tests/geometry/p3-fill-ladder/analysis.ts')).href);

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
  const flags = ['--remap-path-prefix', `${root}=.`];
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
    : [...base, `p3_fill_ladder_bench::${name}`, '--', '--ignored', '--exact', '--nocapture'];
}

function writeExclusive(file, text) {
  writeFileSync(file, text, { flag: 'wx' });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function reserveOutput() {
  const parent = path.join(root, 'artifacts/p3-fill-ladder');
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
 * The 2026-10-12 provenance protocol: a process listing shortly before the start, kept as an
 * artifact; the record holds its time, count, hash and path. No CPU-load sampling.
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

/** The B0 corpus bytes, regenerated and checked against the pinned SHA-256. */
function checkedCorpus() {
  const corpus = encodeCorpus(corpusCells());
  const corpusSha = sha256(corpus);
  if (corpusSha !== CORPUS_SHA256)
    throw new Error(`Corpus SHA-256 ${corpusSha} differs from the pinned ${CORPUS_SHA256}.`);
  return { corpus, corpusSha };
}

/** A failed or timed-out process is retained as a failure; the run continues. */
function stageRunner(failures, label) {
  return async (stage, log, action) => {
    try {
      await action();
      return true;
    } catch (error) {
      failures.push({
        stage,
        error: String(error instanceof Error ? error.message : error),
        log: path.relative(root, log),
      });
      console.error(`${label} ${stage}: FAILED; retained in the record`);
      return false;
    }
  };
}

const fixed = (value, digits) =>
  value === null || value === undefined ? '-' : value.toFixed(digits);

function counts(entries) {
  return (
    Object.entries(entries)
      .map(([key, count]) => `${key} ${count}`)
      .join(', ') || '-'
  );
}

function summaryMarkdown(record) {
  const { analysis } = record;
  const lines = [
    `# P3 Alt-A1 AL-S1 run ${record.run.runId}`,
    '',
    `Profile: ${record.scenario.profile}. Verdict: **${analysis.verdict}** (${analysis.verdictLabel})${analysis.verdict === 'INVALID' ? `; no verdict: ${analysis.invalidReasons.join(', ')}` : ''}. Scenario ${record.scenario.id} v${record.scenario.version}, config ${record.scenario.configHash}.`,
    '',
    '| Oracle gate | Checked | Failures | Pass |',
    '| --- | --- | --- | --- |',
    ...analysis.oracle.gates.map(
      (gate) => `| ${gate.id} | ${gate.checked} | ${gate.failures} | ${gate.pass ? 'yes' : 'NO'} |`,
    ),
    '',
    `MESH_CHECK count: ${record.oracle?.meshCheck.count ?? 'no oracle run'}. Invalid reasons: ${analysis.invalidReasons.join(', ') || 'none'}. Allocation-free timed samples ${analysis.allocationFreeBatches ? 'yes' : 'NO'}; allocation-free admission ${analysis.allocationFreeAdmission ? 'yes' : 'NO'}; storage stable ${analysis.storageStable ? 'yes' : 'NO'}.`,
    '',
    '| Check | Pass | Detail |',
    '| --- | --- | --- |',
    ...analysis.checks.map(
      (item) => `| ${item.id} | ${item.pass ? 'yes' : 'NO'} | ${item.detail} |`,
    ),
    '',
    `Timed decision paths on the fast rung: ${fixed(analysis.timedFastShare === null ? null : 100 * analysis.timedFastShare, 1)}%. Fallback rate at the largest cell: ${analysis.seriesFallback.map((item) => `${item.series} ${fixed(item.fallbackRate, 3)}`).join(', ')}. E5: FillEngine inline ${analysis.engine?.inlineBytes ?? '-'} bytes, heap_bytes() (workspace, scratch, ladder) ${analysis.engine?.admissionHeapBytes ?? '-'} bytes (prepared cell engines ${analysis.engine?.cellHeapBytes.join(', ') ?? '-'}), largest cell input+output buffers ${analysis.engine?.maxBufferBytes ?? '-'} bytes.`,
    '',
  ];
  if (analysis.estimates) {
    const e = analysis.estimates;
    lines.push(
      `Estimates (k = ${e.wasmFactor}, provisional): initial ${e.initialMs.toFixed(1)} ms, edit proxy ${e.editMs.toFixed(3)} ms, mesh ${(e.meshBytes / 2 ** 20).toFixed(2)} MiB (with boundary pairs ${e.payloadBytes === null ? '-' : (e.payloadBytes / 2 ** 20).toFixed(2)} MiB, reported only); per path ${(e.perPathNs / 1e6).toFixed(4)} ms, p95 ${(e.p95Ns / 1e6).toFixed(4)} ms; budget ratios ${analysis.ratios.initial.toFixed(3)}, ${analysis.ratios.edit.toFixed(3)}, ${analysis.ratios.mesh.toFixed(3)}.`,
      '',
    );
  }
  if (record.oracle) {
    const { oracle } = record;
    lines.push(
      `AL-I3 (observation): ${oracle.alI3.checked} checked, ${oracle.alI3.identical} identical, RANGE ${oracle.alI3.allowed.RANGE}, AL-M5 ${oracle.alI3.allowed['AL-M5']}, differing ${oracle.alI3.differing.length}.`,
      '',
      '| O1 cell | Fast | Fallbacks | Conservative | Published | B0 exact OK |',
      '| --- | --- | --- | --- | --- | --- |',
      ...oracle.o1.map(
        (item) =>
          `| ${item.cell} | ${item.fast} | ${counts(item.fallbacks)} | ${item.conservative} | ${item.published} | ${item.referenceExactOk} |`,
      ),
      '',
      `O2: ${oracle.o2.map((item) => `${item.cell} ${item.crossing}/${item.paths} CROSSING (${counts(item.statuses)})`).join('; ')}.`,
      '',
    );
    const ladder = oracle.mix.find((item) => item.group === 'ladder');
    if (ladder)
      lines.push(
        `Randomized family: ${ladder.fast} of ${ladder.paths} fast; fallbacks ${counts(ladder.fallbacks)}; published ${ladder.published}.`,
        '',
      );
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
  const { corpus, corpusSha } = checkedCorpus();
  const ladderSha = sha256(encodeLadderCorpus());
  if (ladderSha !== LADDER_CORPUS_SHA256)
    throw new Error(`Ladder corpus SHA-256 ${ladderSha} differs from ${LADDER_CORPUS_SHA256}.`);
  const identityRecord = JSON.parse(readFileSync(path.join(root, B0_IDENTITY_RECORD), 'utf8'));

  const { runId, output } = reserveOutput();
  console.log(`P3 fill ladder ${options.profile} output: ${path.relative(root, output)}`);
  const processListing = captureProcessListing(output);
  const started = new Date();
  const corpusPath = path.join(output, 'corpus.bin');
  writeFileSync(corpusPath, corpus, { flag: 'wx' });
  const dumpInput = encodeDumpInput(oracleDumpInputs());
  const dumpInputPath = path.join(output, 'oracle-input.bin');
  writeFileSync(dumpInputPath, dumpInput, { flag: 'wx' });
  const run = {
    runId,
    runner: LADDER_RUNNER_VERSION,
    command: ['pnpm', 'benchmark:p3-fill-ladder', ...args].join(' '),
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
    cargoTestArgs('run_ladder_decision', true),
    cargo.env,
    path.join(output, 'build-decision.log'),
    BUILD_TIMEOUT_MS,
    'Decision build',
  );
  // A failed process is retained; the record then fails check 7 or its oracle gates.
  const failures = [];
  const attemptStage = stageRunner(failures, 'P3 fill ladder');
  const repetitions = [];
  for (let repetition = 0; repetition < sampling.repetitions; repetition += 1) {
    const file = path.join(output, `repetition-${repetition}.json`);
    const log = path.join(output, `repetition-${repetition}.log`);
    const ok = await attemptStage(`repetition-${repetition}`, log, async () => {
      await runLogged(
        cargoTestArgs('run_ladder_decision'),
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
    if (ok) console.log(`P3 fill ladder repetition ${repetition}: complete`);
  }

  // One separate, untimed oracle process after the repetitions, then the oracles in
  // TypeScript on its dump (section 5.3).
  let oracle = null;
  {
    const file = path.join(output, 'oracle.json');
    const dumpFile = path.join(output, 'oracle-dump.txt');
    const log = path.join(output, 'oracle.log');
    const ran = await attemptStage('oracle-run', log, async () => {
      await runLogged(
        cargoTestArgs('run_ladder_oracle'),
        {
          ...cargo.env,
          P3_B0_INPUT: corpusPath,
          P3_B0_OUTPUT: file,
          P3_FILL_LADDER_INPUT: dumpInputPath,
          P3_FILL_LADDER_DUMP: dumpFile,
        },
        log,
        REPETITION_TIMEOUT_MS,
        'Oracle run',
      );
      const harness = JSON.parse(readFileSync(file, 'utf8'));
      const dumpBytes = readFileSync(dumpFile);
      console.log('P3 fill ladder oracle run: complete; evaluating the oracles');
      oracle = evaluateLadderOracle(
        parseLadderDump(dumpBytes.toString('utf8')),
        harness,
        { sha256: sha256(dumpBytes), bytes: dumpBytes.length },
        identityRecord,
        oracleDumpNames(),
      );
    });
    if (ran) console.log('P3 fill ladder oracles: evaluated');
  }

  const cpus = os.cpus();
  const record = {
    schemaVersion: LADDER_SCHEMA_VERSION,
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
        command: cargoTestArgs('run_ladder_decision').join(' '),
        oracleCommand: cargoTestArgs('run_ladder_oracle').join(' '),
        targetDirectory: path.relative(root, DECISION_TARGET),
        rustflags: cargo.flags,
        target: RUST.host,
        artifact: 'libtest harness, release profile (opt-level 3, LTO, one codegen unit), unwind',
        knownOverhead: [
          'panic=unwind in the test harness',
          'cfg(test) tracking global allocator compiled in, inactive while timing',
          'cfg(test) fill_filter::record decided/fallback counters compiled in',
          'cfg(test) ladder fault switches and test hooks compiled in, all off',
        ],
      },
    },
    corpus: { sha256: corpusSha, bytes: corpus.length },
    oracleInput: { sha256: sha256(dumpInput), bytes: dumpInput.length },
    repetitions,
    oracle,
    failures,
  };
  // The raw record is written first, so that the samples survive an analysis failure or a
  // source change; a changed source still invalidates the run.
  writeExclusive(path.join(output, 'raw-record.json'), `${JSON.stringify(record)}\n`);
  if (canonicalJson(sourceManifest()) !== canonicalJson(manifestBefore))
    throw new Error('Source files changed during the run; it is invalid. See raw-record.json.');
  const complete = { ...record, analysis: analyze(record) };
  validateLadderRecord(JSON.parse(JSON.stringify(complete)));
  writeExclusive(path.join(output, 'record.json'), `${JSON.stringify(complete)}\n`);
  writeExclusive(path.join(output, 'summary.md'), summaryMarkdown(complete));
  const gates = oracleStatus(complete.oracle);
  console.log(
    `P3 fill ladder ${options.profile}: verdict ${complete.analysis.verdict}; oracle gates ${gates.gates
      .map((gate) => `${gate.id} ${gate.pass ? 'PASS' : 'FAIL'}`)
      .join(
        ', ',
      )}; MESH_CHECK ${complete.oracle?.meshCheck.count ?? '-'}; ${path.relative(root, output)}`,
  );
  // An oracle failure, MESH_CHECK or a harness failure invalidates the run; the record stays.
  if (complete.analysis.invalidReasons.length > 0)
    throw new Error(
      `The run is invalid (${complete.analysis.invalidReasons.join(', ')}); retained in ${output}.`,
    );
  return output;
}

/**
 * The AL-S1 harness's ratio mode (section 5.2), for AL-S2's native leg only: in `output` (an
 * existing directory of the AL-S2 run), the decision build, then one fresh process per
 * repetition of `run_ladder_ratio`. Returns the configuration, provenance, the raw outputs,
 * the retained failures and `analyzeRatioNative` of them.
 */
export async function runRatioMode({ profile, output }) {
  if (profile !== 'functional' && profile !== 'reference')
    throw new Error('profile must be functional or reference.');
  mkdirSync(temporary, { recursive: true });
  const rust = inspectToolchain();
  const config = ratioModeConfig(profile);
  const { corpus, corpusSha } = checkedCorpus();
  const corpusPath = path.join(output, 'ratio-corpus.bin');
  writeFileSync(corpusPath, corpus, { flag: 'wx' });
  const cargo = cargoEnvironment(DECISION_TARGET);
  await runLogged(
    cargoTestArgs('run_ladder_ratio', true),
    cargo.env,
    path.join(output, 'build-ratio.log'),
    BUILD_TIMEOUT_MS,
    'Ratio build',
  );
  const failures = [];
  const attemptStage = stageRunner(failures, 'P3 fill ladder ratio');
  const repetitions = [];
  for (let repetition = 0; repetition < config.sampling.repetitions; repetition += 1) {
    const file = path.join(output, `ratio-${repetition}.json`);
    const log = path.join(output, `ratio-${repetition}.log`);
    await attemptStage(`ratio-${repetition}`, log, async () => {
      await runLogged(
        cargoTestArgs('run_ladder_ratio'),
        {
          ...cargo.env,
          P3_B0_INPUT: corpusPath,
          P3_B0_OUTPUT: file,
          P3_B0_REPETITION: String(repetition),
          P3_B0_WARMUP: String(config.sampling.warmup),
          P3_B0_TIMED: String(config.sampling.timed),
          P3_FL_RATIO_CALLS: String(config.calls),
          P3_FL_RATIO_ONE_PATH_CALLS: String(config.onePath.calls),
          P3_FL_RATIO_ONE_PATH_CELLS: config.onePath.cells.join(','),
        },
        log,
        REPETITION_TIMEOUT_MS,
        `Ratio repetition ${repetition}`,
      );
      repetitions.push(JSON.parse(readFileSync(file, 'utf8')));
    });
  }
  return {
    config,
    configHash: configHash(config),
    toolchain: rust,
    build: {
      command: cargoTestArgs('run_ladder_ratio').join(' '),
      targetDirectory: path.relative(root, DECISION_TARGET),
      rustflags: cargo.flags,
    },
    corpus: { sha256: corpusSha, bytes: corpus.length },
    repetitions,
    failures,
    analysis: analyzeRatioNative(repetitions, config),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
