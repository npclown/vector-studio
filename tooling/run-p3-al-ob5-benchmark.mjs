// P3 Alt-A1 AL-OB5 unit OB5-U2, scenario `p3-al-ob5-workload` v1: `pnpm benchmark:p3-al-ob5
// --profile functional|reference [--environment-json <observations.json>]`. Mechanics are
// fixed by docs/plans/p3-al-ob5-workload-scenario-proposal.md sections 3-5. In one runner
// session on one machine:
//
// 1. the release WASM, built by the cargo command `pnpm test:geometry` uses, and its SHA-256;
// 2. the native leg, just before the browsers: one fresh `p3_al_ob5_bench::run_ob5_native`
//    process per repetition, on the production caps, reading the TypeScript-encoded corpus;
// 3. the Vite production page with the WASM and the same corpus bytes as verified assets;
// 4. headed Chrome, then Edge, through Playwright, one worker, a fresh page per repetition;
// 5. the untimed OB5-Q7 (a) observation and the untimed oracle run with its evaluation;
// 6. the record, its analysis and the validator.
//
// The Rust toolchain comes from CARGO_HOME and RUSTUP_HOME when they are set (a worktree uses
// the main checkout's pinned toolchain that way), otherwise from `.tools/rust`.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
const cargoHome = process.env.CARGO_HOME || path.join(tools, 'rust/cargo');
const rustupHome = process.env.RUSTUP_HOME || path.join(tools, 'rust/rustup');
const rustup = path.join(cargoHome, 'bin', process.platform === 'win32' ? 'rustup.exe' : 'rustup');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const temporary = path.join(tools, 'geometry-tmp');
// The WASM and the native harness are built in B0's target directory, as AL-S2's are.
const TARGET = path.join(tools, 'geometry-build');
const WASM_RELATIVE = 'wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm';
const RUST = {
  release: '1.94.1',
  commit: 'e408947bfd200af42db322daf0fadfe7e26d3bd1',
  host: 'x86_64-pc-windows-msvc',
};
const BUILD_TIMEOUT_MS = 30 * 60_000;
const NATIVE_TIMEOUT_MS = 60 * 60_000;
const ORACLE_TIMEOUT_MS = 4 * 60 * 60_000;
const BROWSER_TIMEOUT_MS = 6 * 60 * 60_000;
const SOURCE_ROOTS = [
  'docs/plans/p3-al-ob5-workload-scenario-proposal.md',
  'tooling/run-p3-al-ob5-benchmark.mjs',
  'tooling/run-p3-b0-benchmark.mjs',
  'tooling/run-p2-benchmark.mjs',
  'playwright.p3-al-ob5.config.ts',
  'tests/geometry-benchmark/p3-al-ob5',
  'tests/geometry-benchmark/p3-b0-wasm/workload.ts',
  'tests/geometry/p3-al-ob5',
  'tests/geometry/p3-b0',
  'tests/geometry/p3-b0-wasm',
  'tests/geometry/p3-b0-spike',
  'tests/geometry/p3-fill-ladder',
  'tests/geometry/rounded-fill/exact.ts',
  'packages/contracts/src',
  'packages/geometry-wasm/src',
  'packages/renderer-core/src',
  'packages/geometry-wasm/kernel/src',
  'packages/geometry-wasm/kernel/Cargo.toml',
  'packages/geometry-wasm/kernel/Cargo.lock',
  'package.json',
  'pnpm-lock.yaml',
];

const { parseArguments, readEnvironmentObservations } = await import(
  pathToFileURL(path.join(root, 'tooling/run-p3-b0-benchmark.mjs')).href
);
const { captureP2Build } = await import(
  pathToFileURL(path.join(root, 'tooling/run-p2-benchmark.mjs')).href
);
const { canonicalJson, configHash } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-b0/analysis.ts')).href
);
const { encodeDumpInput } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-fill-ladder/corpus.ts')).href
);
const { parseLadderDump } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-fill-ladder/dump.ts')).href
);
const { encodeOb5DecisionCorpus, encodeOb5ObservationCorpus } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-al-ob5/corpus.ts')).href
);
const {
  BROWSER_PROJECTS,
  OB5_CORPUS_SHA256,
  OB5_OBSERVATION_CORPUS_SHA256,
  OB5_RUNNER_VERSION,
  OB5_SCHEMA_VERSION,
  analyze,
  evaluateOb5Oracle,
  fnvHex,
  kernelSourceSha256,
  oracleInputs,
  oracleNames,
  pageOptions,
  scenarioConfig,
  sha256Hex,
  validateOb5Record,
} = await import(pathToFileURL(path.join(root, 'tests/geometry/p3-al-ob5/analysis.ts')).href);

export { parseArguments };

/**
 * B0's observations (`observedAt`, `power`, `backgroundLoad`), plus the quiet-machine
 * statement (proposal section 3.5) as an optional `quietMachine` {value, source}, which the
 * reference profile's metadata item OB5-V14 requires.
 */
export function readObservations(file) {
  const base = readEnvironmentObservations(file);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const quiet = parsed.quietMachine;
  if (quiet === undefined) return { ...base, quietMachine: null };
  if (
    quiet === null ||
    typeof quiet !== 'object' ||
    typeof quiet.value !== 'string' ||
    quiet.value.trim() === '' ||
    typeof quiet.source !== 'string' ||
    quiet.source.trim() === ''
  )
    throw new Error('Environment quietMachine needs a nonempty {value, source} observation.');
  return { ...base, quietMachine: { value: quiet.value, source: quiet.source } };
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
    files.map((file) => [file, sha256Hex(readFileSync(path.join(root, file)))]),
  );
}

/**
 * OB5-V13's commit check: every source-manifest file's blob at `commit` equals the blob of the
 * file on disk (`git hash-object`, with the repository's filters). Returns the checked count
 * and the files that differ or are untracked.
 */
export function commitCheck(commit, files) {
  const committed = new Map();
  const listing = execFileSync('git', ['ls-tree', '-r', commit, '--', ...files], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const line of listing.split(/\r?\n/u)) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/u.exec(line);
    if (match) committed.set(match[2], match[1]);
  }
  const hashes = execFileSync('git', ['hash-object', '--stdin-paths'], {
    cwd: root,
    encoding: 'utf8',
    input: `${files.join('\n')}\n`,
    maxBuffer: 64 * 1024 * 1024,
  })
    .trim()
    .split(/\r?\n/u);
  const mismatches = files.filter((file, index) => committed.get(file) !== hashes[index]);
  return { commit, checked: files.length, mismatches };
}

function writeExclusive(file, text) {
  writeFileSync(file, text, { flag: 'wx' });
}

function reserveOutput() {
  const parent = path.join(root, 'artifacts/p3-al-ob5');
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

/** A process listing just before the start, as AL-S2's; no CPU-load sampling. */
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
    sha256: sha256Hex(result.stdout),
    file: path.relative(root, file).split(path.sep).join('/'),
  };
}

function cargoEnvironment() {
  const flags = ['--remap-path-prefix', `${root}=.`];
  return {
    flags,
    env: {
      ...process.env,
      CARGO_HOME: cargoHome,
      RUSTUP_HOME: rustupHome,
      CARGO_TARGET_DIR: TARGET,
      CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f'),
      TEMP: temporary,
      TMP: temporary,
    },
  };
}

function inspectToolchain() {
  if (!existsSync(rustup)) throw new Error(`Pinned Rust toolchain is missing (${rustup}).`);
  const result = spawnSync(rustup, ['run', RUST.release, 'rustc', '--version', '--verbose'], {
    cwd: root,
    env: cargoEnvironment().env,
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

/** Runs a command with its output in `logPath`; throws on failure or timeout. */
async function runLogged(binary, args, env, logPath, timeoutMs, label) {
  const log = openSync(logPath, 'wx');
  const child = spawn(binary, args, {
    cwd: root,
    env,
    stdio: ['ignore', log, log],
    windowsHide: true,
    // Outside Windows a detached group lets a timeout stop the whole process tree.
    detached: process.platform !== 'win32',
  });
  const outcome = await new Promise((resolve) => {
    let error = null;
    const timer = setTimeout(() => {
      error = new Error(`${label} exceeded ${timeoutMs} ms`);
      try {
        if (child.pid && process.platform === 'win32')
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        else if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch (failure) {
        error = new Error(`${error.message}; cleanup: ${String(failure)}`);
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

const cargo = (...args) => [RUST.release, 'cargo', ...args];
const cargoRun = (...args) => ['run', ...cargo(...args)];

function cargoTestArgs(name, noRun = false) {
  const base = ['test', '--manifest-path', manifest, '--release', '--lib', '--locked', '--offline'];
  return noRun
    ? [...base, '--no-run']
    : [...base, `p3_al_ob5_bench::${name}`, '--', '--ignored', '--exact', '--nocapture'];
}

/** The release WASM, by the command `tooling/test-geometry.mjs` builds it with. */
async function buildWasm(output, kernelSha256) {
  const environment = cargoEnvironment();
  const args = [
    'build',
    '--manifest-path',
    manifest,
    '--locked',
    '--offline',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
  ];
  await runLogged(
    rustup,
    cargoRun(...args),
    environment.env,
    path.join(output, 'build-wasm.log'),
    BUILD_TIMEOUT_MS,
    'WASM build',
  );
  const file = path.join(TARGET, WASM_RELATIVE);
  const bytes = readFileSync(file);
  return {
    file,
    record: {
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      path: path.relative(root, file).split(path.sep).join('/'),
      command: ['cargo', ...args].join(' '),
      rustflags: environment.flags,
      target: 'wasm32-unknown-unknown',
      profile: 'release (opt-level 3, LTO, one codegen unit, panic abort, strip)',
      kernelSourceSha256: kernelSha256,
    },
  };
}

const fixed = (value, digits) =>
  value === null || value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);

function summaryMarkdown(record) {
  const { analysis } = record;
  const lines = [
    `# P3 AL-OB5 run ${record.run.runId}`,
    '',
    `Profile: ${record.scenario.profile}. Scenario ${record.scenario.id} v${record.scenario.version}, config ${record.scenario.configHash}. WASM ${record.builds.wasm.sha256}. Verdict: **${analysis.verdict}** (${analysis.reason}).`,
    '',
    `T ${fixed(analysis.T, 1)} ms (max init p95 ${fixed(analysis.Tp95, 1)} ms), t_edit ${fixed(analysis.tEdit, 3)} ms, M ${analysis.meshBytes ?? '-'} bytes (with boundary pairs ${analysis.payloadBytes ?? '-'}); budget ratios ${fixed(analysis.ratios.initial, 3)}, ${fixed(analysis.ratios.edit, 3)}, ${fixed(analysis.ratios.mesh, 3)}. Context (AL-U7): T̂ ${analysis.context.initialMs} ms, t̂_edit ${analysis.context.editMs} ms, t̂_p95 · k̂₁ ${analysis.context.editOnePathMs} ms.`,
    '',
    '| Validity | Pass | Detail |',
    '| --- | --- | --- |',
    ...analysis.checks.map(
      (item) =>
        `| ${item.id} | ${item.pass ? 'yes' : 'NO'} | ${item.detail.replaceAll('|', '/')} |`,
    ),
    '',
    '| Set | Init median max (ms) | Init p95 max (ms) | Edit p95 max (ms) | M (bytes) |',
    '| --- | --- | --- | --- | --- |',
    ...analysis.perSet.map(
      (item) =>
        `| ${item.set} | ${fixed(item.initMedianMax, 2)} | ${fixed(item.initP95Max, 2)} | ${fixed(item.editP95Max, 4)} | ${item.meshBytes ?? '-'} |`,
    ),
    '',
    '| Leg | Rep | Set | Init median (ms) | Init p95 (ms) | Edit median (ms) | Edit p95 (ms) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...analysis.legs.map(
      (item) =>
        `| ${item.source} | ${item.repetition} | ${item.set} | ${fixed(item.init?.median, 2)} | ${fixed(item.init?.p95, 2)} | ${fixed(item.edit?.median, 4)} | ${fixed(item.edit?.p95, 4)} |`,
    ),
    '',
    `Browser over native (${analysis.nativeRatioLabel}; report-only): ${analysis.nativeRatio.map((item) => `${item.project} ${item.set} init ${fixed(item.initMedianRatio, 3)}, edit ${fixed(item.editP95Ratio, 3)}`).join('; ')}.`,
    '',
    `OB5-SP-cold (report-only): ${analysis.cold.map((item) => `${item.project} r${item.repetition} ${item.set} ${fixed(item.ms, 1)} ms`).join('; ')}.`,
    '',
    `OB5-SR (report-only): ${analysis.renderer.map((item) => `${item.project} r${item.repetition} ${item.set} ${fixed(item.ms, 1)} ms, ${item.draws} draws, ${item.regionOnly} region-only, ${item.fringed} fringed, builder ${fixed(item.builderMs, 1)} ms, fringe-work-cap ${item.fringeWorkCapNotices}`).join('; ')}.`,
    '',
    `Oracle gates: ${analysis.oracle.gates.map((gate) => `${gate.id} ${gate.pass ? 'PASS' : 'FAIL'} (${gate.checked} checked, ${gate.failures} failures)`).join(', ')}; MESH_CHECK ${record.oracle?.meshCheck.count ?? '-'}.`,
    '',
    `OB5-Q7 (a) observation (outside the verdict): ${
      analysis.observation === null
        ? 'missing'
        : analysis.observation
            .map(
              (item) =>
                `${item.set} batch ${item.batchStatus}, ${Object.entries(item.outcomes)
                  .map(([key, count]) => `${key} ${count}`)
                  .join(', ')}`,
            )
            .join('; ')
    }.`,
    '',
    `Memory (not a decision input): ${analysis.memory.map((item) => `${item.project} ${item.linearMemoryBytes ?? '-'} bytes${item.withinCeiling === false ? ' ABOVE the 256 MB ceiling' : ''}`).join(', ')}.`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const observations = options.environmentJson
    ? readObservations(path.resolve(options.environmentJson))
    : null;
  const status = git('status', '--porcelain');
  if (options.profile === 'reference' && status !== '')
    throw new Error('The reference profile requires a clean worktree.');
  mkdirSync(temporary, { recursive: true });
  const rust = inspectToolchain();
  const manifestBefore = sourceManifest();
  const kernelSha256 = kernelSourceSha256(manifestBefore);
  const config = scenarioConfig(options.profile);
  const corpus = encodeOb5DecisionCorpus();
  const corpusSha = sha256Hex(corpus);
  if (corpusSha !== OB5_CORPUS_SHA256)
    throw new Error(`Corpus SHA-256 ${corpusSha} differs from the pinned ${OB5_CORPUS_SHA256}.`);
  const observationCorpus = encodeOb5ObservationCorpus();
  const observationSha = sha256Hex(observationCorpus);
  if (observationSha !== OB5_OBSERVATION_CORPUS_SHA256)
    throw new Error(`Observation corpus SHA-256 ${observationSha} differs from the pinned one.`);

  const { runId, output } = reserveOutput();
  console.log(`P3 AL-OB5 ${options.profile} output: ${path.relative(root, output)}`);
  const processListing = captureProcessListing(output);
  const commit = git('rev-parse', 'HEAD');
  const run = {
    runId,
    runner: OB5_RUNNER_VERSION,
    command: ['pnpm', 'benchmark:p3-al-ob5', ...args].join(' '),
    utcStart: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    commit,
    dirty: status !== '',
    dirtyFiles: status === '' ? [] : status.split(/\r?\n/u),
    node: process.versions.node,
    sourceManifest: manifestBefore,
    commitCheck: commitCheck(commit, Object.keys(manifestBefore)),
  };
  writeExclusive(
    path.join(output, 'invocation.json'),
    `${JSON.stringify({ run, config }, null, 2)}\n`,
  );
  const corpusPath = path.join(output, 'corpus.bin');
  writeFileSync(corpusPath, corpus, { flag: 'wx' });
  const observationPath = path.join(output, 'observation-corpus.bin');
  writeFileSync(observationPath, observationCorpus, { flag: 'wx' });
  const oracleInput = encodeDumpInput(oracleInputs(options.profile));
  const oracleInputPath = path.join(output, 'oracle-input.bin');
  writeFileSync(oracleInputPath, oracleInput, { flag: 'wx' });

  const failures = [];
  const stage = async (name, action) => {
    try {
      return await action();
    } catch (error) {
      failures.push({ stage: name, error: String(error instanceof Error ? error.message : error) });
      console.error(`P3 AL-OB5 ${name}: FAILED; retained in the record`);
      return null;
    }
  };

  // 1. The release WASM, and the native harness build.
  const wasm = await buildWasm(output, kernelSha256);
  console.log(`P3 AL-OB5 WASM SHA-256: ${wasm.record.sha256}`);
  const environment = cargoEnvironment();
  await runLogged(
    rustup,
    ['run', RUST.release, 'cargo', ...cargoTestArgs('run_ob5_native', true)],
    environment.env,
    path.join(output, 'build-native.log'),
    BUILD_TIMEOUT_MS,
    'Native build',
  );
  const runTest = (name, extra, file, log, timeout, label) =>
    runLogged(
      rustup,
      ['run', RUST.release, 'cargo', ...cargoTestArgs(name)],
      { ...environment.env, P3_B0_OUTPUT: file, ...extra },
      log,
      timeout,
      label,
    );

  // 2. The native leg: one fresh process per repetition, just before the browsers.
  const nativeFailures = [];
  const nativeRepetitions = [];
  for (let repetition = 0; repetition < config.sampling.repetitions; repetition += 1) {
    const file = path.join(output, `native-r${repetition}.json`);
    const log = path.join(output, `native-r${repetition}.log`);
    try {
      await runTest(
        'run_ob5_native',
        {
          P3_B0_INPUT: corpusPath,
          P3_B0_REPETITION: String(repetition),
          P3_OB5_WARMUP: String(config.sampling.init.warmup),
          P3_OB5_TIMED: String(config.sampling.init.timed),
          P3_OB5_EDIT_PATHS: String(config.sampling.edit.paths),
        },
        file,
        log,
        NATIVE_TIMEOUT_MS,
        `Native repetition ${repetition}`,
      );
      nativeRepetitions.push(JSON.parse(readFileSync(file, 'utf8')));
      console.log(`P3 AL-OB5 native repetition ${repetition}: complete`);
    } catch (error) {
      nativeFailures.push({
        stage: `native-r${repetition}`,
        error: String(error instanceof Error ? error.message : error),
      });
      console.error(`P3 AL-OB5 native repetition ${repetition}: FAILED; retained in the record`);
    }
  }

  // 3. The production page.
  const buildDirectory = path.join(output, 'build');
  const pageEnvironment = {
    ...process.env,
    P3_AL_OB5_WASM_PATH: wasm.file,
    P3_AL_OB5_CORPUS_PATH: corpusPath,
    P3_AL_OB5_BUILD_DIR: buildDirectory,
    P3_AL_OB5_RUN_DIR: output,
    P3_AL_OB5_PROFILE: options.profile,
  };
  await runLogged(
    process.execPath,
    [
      path.join(root, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      'tests/geometry-benchmark/p3-al-ob5/vite.config.ts',
    ],
    pageEnvironment,
    path.join(output, 'build-page.log'),
    BUILD_TIMEOUT_MS,
    'Page build',
  );
  const page = captureP2Build(buildDirectory);
  const asset = (name) => page.files.find((file) => file.path === name)?.sha256;
  if (asset('geometry.wasm') !== wasm.record.sha256 || asset('corpus.bin') !== corpusSha)
    throw new Error('The page assets differ from the built WASM or the corpus.');

  // 4. Chrome, then Edge (the configuration's project order), headed.
  writeExclusive(
    path.join(output, 'browser-options.json'),
    `${JSON.stringify({ repetitions: config.sampling.repetitions, options: pageOptions(config, wasm.record.sha256) }, null, 2)}\n`,
  );
  await stage('browsers', () =>
    runLogged(
      process.execPath,
      [
        path.join(root, 'node_modules/@playwright/test/cli.js'),
        'test',
        '--config',
        'playwright.p3-al-ob5.config.ts',
      ],
      pageEnvironment,
      path.join(output, 'browsers.log'),
      BROWSER_TIMEOUT_MS,
      'Browser leg',
    ),
  );
  const browsers = readdirSync(output)
    .filter((name) => /^browser-[a-z]+-r\d+\.json$/u.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(output, name), 'utf8')));
  const pageEnd = captureP2Build(buildDirectory);
  if (pageEnd.sha256 !== page.sha256)
    failures.push({ stage: 'page-integrity', error: 'the page build changed during the run' });

  // 5. The untimed OB5-Q7 (a) observation, then the untimed oracle run and its evaluation.
  const observation = await stage('observation', async () => {
    const file = path.join(output, 'observation.json');
    await runTest(
      'run_ob5_observation',
      { P3_B0_INPUT: observationPath },
      file,
      path.join(output, 'observation.log'),
      NATIVE_TIMEOUT_MS,
      'Observation',
    );
    return JSON.parse(readFileSync(file, 'utf8'));
  });
  const oracle = await stage('oracle', async () => {
    const file = path.join(output, 'oracle.json');
    const dumpFile = path.join(output, 'oracle-dump.txt');
    await runTest(
      'run_ob5_oracle',
      { P3_FILL_LADDER_INPUT: oracleInputPath, P3_FILL_LADDER_DUMP: dumpFile },
      file,
      path.join(output, 'oracle.log'),
      ORACLE_TIMEOUT_MS,
      'Oracle run',
    );
    const harness = JSON.parse(readFileSync(file, 'utf8'));
    const dumpBytes = readFileSync(dumpFile);
    console.log('P3 AL-OB5 oracle run: complete; evaluating the oracles');
    return evaluateOb5Oracle(
      parseLadderDump(dumpBytes.toString('utf8')),
      harness,
      { sha256: sha256Hex(dumpBytes), bytes: dumpBytes.length },
      oracleNames(options.profile),
    );
  });

  const cpus = os.cpus();
  const record = {
    schemaVersion: OB5_SCHEMA_VERSION,
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
      quietMachine: observations?.quietMachine ?? null,
      processListing,
      cpuLoadSampling: { applicable: false, reason: "not sampled, per the user's instruction" },
      gpu: { applicable: false, reason: 'no GPU work is measured' },
      display: {
        applicable: true,
        note: 'viewport, DPR and screen per browser repetition are in each capture',
      },
      browsers: BROWSER_PROJECTS.map((project) => ({
        project,
        versions: [
          ...new Set(
            browsers.filter((item) => item.project === project).map((item) => item.browserVersion),
          ),
        ],
      })),
    },
    builds: {
      wasm: wasm.record,
      native: {
        toolchain: rust,
        command: cargoTestArgs('run_ob5_native').join(' '),
        observationCommand: cargoTestArgs('run_ob5_observation').join(' '),
        oracleCommand: cargoTestArgs('run_ob5_oracle').join(' '),
        targetDirectory: path.relative(root, TARGET),
        rustflags: environment.flags,
        target: RUST.host,
        profile: 'libtest harness, release profile (opt-level 3, LTO, one codegen unit), unwind',
        knownOverhead: [
          'panic=unwind in the test harness',
          'cfg(test) tracking global allocator compiled in, switched on around each timed and warm-up call outside its window',
          'cfg(test) fill_filter::record decided/fallback counters compiled in',
          'cfg(test) ladder fault switches and test hooks compiled in, all off',
        ],
        kernelSourceSha256: kernelSha256,
      },
      page: {
        ...page,
        command: 'vite build --config tests/geometry-benchmark/p3-al-ob5/vite.config.ts',
      },
      buildMode: 'production',
    },
    corpus: { sha256: corpusSha, bytes: corpus.length, fnv: fnvHex(corpus) },
    observationCorpus: {
      sha256: observationSha,
      bytes: observationCorpus.length,
      fnv: fnvHex(observationCorpus),
    },
    oracleInput: { sha256: sha256Hex(oracleInput), bytes: oracleInput.length },
    native: { repetitions: nativeRepetitions, failures: nativeFailures },
    observation,
    oracle,
    browsers,
    failures,
  };
  // The raw record is written first, so that the samples survive an analysis failure or a
  // source change; a changed source still invalidates the run.
  writeExclusive(path.join(output, 'raw-record.json'), `${JSON.stringify(record)}\n`);
  if (canonicalJson(sourceManifest()) !== canonicalJson(manifestBefore))
    throw new Error('Source files changed during the run; it is invalid. See raw-record.json.');
  const complete = { ...record, analysis: analyze(record) };
  validateOb5Record(JSON.parse(JSON.stringify(complete)));
  writeExclusive(path.join(output, 'record.json'), `${JSON.stringify(complete)}\n`);
  writeExclusive(path.join(output, 'summary.md'), summaryMarkdown(complete));
  const { analysis } = complete;
  console.log(
    `P3 AL-OB5 ${options.profile}: T ${fixed(analysis.T, 1)} ms, t_edit ${fixed(analysis.tEdit, 3)} ms, M ${analysis.meshBytes ?? '-'} bytes; validity ${analysis.checks
      .map((item) => `${item.id} ${item.pass ? 'PASS' : 'FAIL'}`)
      .join(', ')}; verdict ${analysis.verdict}; ${path.relative(root, output)}`,
  );
  if (!analysis.valid)
    throw new Error(`An AL-OB5 validity item failed; the record is retained in ${output}.`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
