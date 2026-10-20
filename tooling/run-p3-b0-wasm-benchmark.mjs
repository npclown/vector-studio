// P3 Alt-A1 AL-U6, scenario AL-S2 `p3-b0-wasm` v1 (B0-W): `pnpm benchmark:p3-b0-wasm
// --profile functional|reference [--environment-json <observations.json>]`. Mechanics are
// fixed by docs/plans/p3-alt-a1-fill-ladder-contract.md section 5.2; the combined verdict by
// section 5.3. In one runner session on one machine:
//
// 1. the release WASM, built by the cargo command `pnpm test:geometry` uses, and its SHA-256;
// 2. the native leg, just before the browsers: the AL-S1 harness's ratio mode, AL-U5's
//    `runRatioMode`, unchanged;
// 3. the Vite production page with the WASM and the B0 framed corpus as verified assets;
// 4. headed Chrome, then Edge, through Playwright, one worker, a fresh page per repetition;
// 5. the record, its analysis, the AL-S1 link and the validator.
//
// The B0, P2.5 and AL-U5 modules it imports are used unchanged.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
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
const WASM_TARGET = path.join(tools, 'geometry-build');
const WASM_RELATIVE = 'wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm';
const RUST_RELEASE = '1.94.1';
const BUILD_TIMEOUT_MS = 30 * 60_000;
const BROWSER_TIMEOUT_MS = 4 * 60 * 60_000;
const AL_S1_PATTERN = /^docs\/benchmarks\/results\/[^/]+_p3_p3-fill-ladder-v1_[^/]+\.json$/u;
const SOURCE_ROOTS = [
  'docs/plans/p3-alt-a1-fill-ladder-contract.md',
  'tooling/run-p3-b0-wasm-benchmark.mjs',
  'tooling/run-p3-fill-ladder-benchmark.mjs',
  'tooling/run-p3-b0-benchmark.mjs',
  'tooling/run-p2-benchmark.mjs',
  'playwright.p3-b0-wasm.config.ts',
  'tests/geometry-benchmark/p3-b0-wasm',
  'tests/geometry/p3-b0-wasm',
  'tests/geometry/p3-fill-ladder',
  'tests/geometry/p3-b0',
  'tests/geometry/p3-b0-spike',
  'packages/contracts/src',
  'packages/geometry-wasm/src',
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
const { runRatioMode } = await import(
  pathToFileURL(path.join(root, 'tooling/run-p3-fill-ladder-benchmark.mjs')).href
);
const { corpusCells, encodeCorpus } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-b0/corpus.ts')).href
);
const { canonicalJson, configHash } = await import(
  pathToFileURL(path.join(root, 'tests/geometry/p3-b0/analysis.ts')).href
);
const {
  BROWSER_PROJECTS,
  CORPUS_SHA256,
  WASM_RUNNER_VERSION,
  WASM_SCHEMA_VERSION,
  analyze,
  linkAlS1,
  pageOptions,
  scenarioConfig,
  sha256Hex,
  validateWasmRecord,
} = await import(pathToFileURL(path.join(root, 'tests/geometry/p3-b0-wasm/analysis.ts')).href);

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
    files.map((file) => [file, sha256Hex(readFileSync(path.join(root, file)))]),
  );
}

function writeExclusive(file, text) {
  writeFileSync(file, text, { flag: 'wx' });
}

function reserveOutput() {
  const parent = path.join(root, 'artifacts/p3-b0-wasm');
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

/** A process listing shortly before the start, as the spike's; no CPU-load sampling. */
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
      CARGO_HOME: path.join(tools, 'rust/cargo'),
      RUSTUP_HOME: path.join(tools, 'rust/rustup'),
      CARGO_TARGET_DIR: WASM_TARGET,
      CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f'),
      TEMP: temporary,
      TMP: temporary,
    },
  };
}

/** Runs a command with its output in `logPath`; throws on failure or timeout. */
function runLogged(binary, args, env, logPath, timeoutMs, label) {
  const log = openSync(logPath, 'wx');
  try {
    const result = spawnSync(binary, args, {
      cwd: root,
      env,
      stdio: ['ignore', log, log],
      windowsHide: true,
      timeout: timeoutMs,
    });
    if (result.error) throw new Error(`${label}: ${String(result.error)}`);
    if (result.status !== 0)
      throw new Error(
        `${label} failed (${String(result.status ?? result.signal)}); log=${path.relative(root, logPath)}`,
      );
  } finally {
    closeSync(log);
  }
}

/** The release WASM, by the command `tooling/test-geometry.mjs` builds it with. */
function buildWasm(output) {
  if (!existsSync(rustup)) throw new Error('Pinned Rust toolchain is missing.');
  const cargo = cargoEnvironment();
  const args = [
    'run',
    RUST_RELEASE,
    'cargo',
    'build',
    '--manifest-path',
    manifest,
    '--locked',
    '--offline',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
  ];
  runLogged(
    rustup,
    args,
    cargo.env,
    path.join(output, 'build-wasm.log'),
    BUILD_TIMEOUT_MS,
    'WASM build',
  );
  const compiler = spawnSync(rustup, ['run', RUST_RELEASE, 'rustc', '--version', '--verbose'], {
    cwd: root,
    env: cargo.env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (compiler.error || compiler.status !== 0) throw new Error('Pinned rustc inspection failed.');
  const file = path.join(WASM_TARGET, WASM_RELATIVE);
  const bytes = readFileSync(file);
  return {
    file,
    record: {
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      path: path.relative(root, file).split(path.sep).join('/'),
      command: ['cargo', ...args.slice(3)].join(' '),
      rustflags: cargo.flags,
      compiler: compiler.stdout.trim(),
      target: 'wasm32-unknown-unknown',
      profile: 'release (opt-level 3, LTO, one codegen unit, panic abort, strip)',
    },
  };
}

/**
 * The committed AL-S1 reference record (section 5.3): exactly one tracked, unmodified
 * `*_p3_p3-fill-ladder-v1_*.json` whose profile is reference. Returns null when there is none;
 * the reference profile requires one.
 */
export function findAlS1Record() {
  const tracked = git('ls-files', '--', 'docs/benchmarks/results')
    .split(/\r?\n/u)
    .filter((file) => AL_S1_PATTERN.test(file));
  const references = tracked.filter((file) => {
    try {
      const record = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
      return record?.scenario?.profile === 'reference';
    } catch {
      return false;
    }
  });
  if (references.length === 0) return null;
  if (references.length > 1)
    throw new Error(`Several AL-S1 reference records: ${references.join(', ')}.`);
  const file = references[0];
  if (git('status', '--porcelain', '--', file) !== '')
    throw new Error(`The AL-S1 record ${file} differs from its committed bytes.`);
  return { file, bytes: readFileSync(path.join(root, file)) };
}

const fixed = (value, digits) =>
  value === null || value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits);

function summaryMarkdown(record) {
  const { analysis } = record;
  const product = analysis.product;
  const lines = [
    `# P3 AL-S2 B0-W run ${record.run.runId}`,
    '',
    `Profile: ${record.scenario.profile}. Scenario ${record.scenario.id} v${record.scenario.version}, config ${record.scenario.configHash}. WASM ${record.builds.wasm.sha256}. Product verdict: **${product.verdict}** (${product.reason}).`,
    '',
    `k̂ = ${fixed(analysis.kHat, 3)} (${analysis.kLabel}); k̂₁ = ${fixed(analysis.kHatOnePath, 3)} (report-only, outside the verdict). Largest primary cells: ${analysis.largestCells.join(', ')}.`,
    '',
    '| Validity | Pass | Detail |',
    '| --- | --- | --- |',
    ...analysis.checks.map(
      (item) => `| ${item.id} | ${item.pass ? 'yes' : 'NO'} | ${item.detail} |`,
    ),
    '',
  ];
  if (product.estimates)
    lines.push(
      `Estimates with k = k̂: initial ${fixed(product.estimates.initialMs, 1)} ms, edit proxy ${fixed(product.estimates.editMs, 3)} ms (one-path context t̂_p95·k̂₁ ${fixed(product.estimates.editOnePathContextMs, 3)} ms), mesh ${fixed(product.estimates.meshBytes / 2 ** 20, 2)} MiB; budget ratios ${fixed(product.ratios.initial, 3)}, ${fixed(product.ratios.edit, 3)}, ${fixed(product.ratios.mesh, 3)}.`,
      '',
    );
  const nativeOf = (table, id) => table?.find((item) => item.cell === id);
  lines.push(
    '| Browser | Cell | Native per-path ns (median of reps) | Browser per-path ns (median of reps) | k_cell |',
    '| --- | --- | --- | --- | --- |',
  );
  const middle = (values) =>
    values.length === 0
      ? null
      : [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
  for (const browser of analysis.browsers) {
    for (const [table, ratios, nativeTable, suffix] of [
      [browser.tenPath, browser.ratios, analysis.native?.tenPath, ''],
      [browser.onePath, browser.onePathRatios, analysis.native?.onePath, ' (one path)'],
    ]) {
      for (const entry of table) {
        const nativeEntry = nativeOf(nativeTable, entry.cell);
        lines.push(
          `| ${browser.project} | ${entry.cell}${suffix} | ${fixed(middle(nativeEntry?.perRepetition.map((item) => item.perPathMedianNs) ?? []), 1)} | ${fixed(middle(entry.perRepetition.map((item) => item.perPathMedianNs)), 1)} | ${fixed(ratios.find((item) => item.cell === entry.cell)?.kCell ?? null, 3)} |`,
        );
      }
    }
  }
  lines.push('');
  lines.push(
    `Memory (not a decision input): ${analysis.memory.map((item) => `${item.project} ${item.linearMemoryBytes ?? '-'} bytes${item.withinCeiling === false ? ' ABOVE the 256 MB ceiling' : ''}`).join(', ')}.`,
    '',
  );
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
  const manifestBefore = sourceManifest();
  const config = scenarioConfig(options.profile);
  const corpus = encodeCorpus(corpusCells());
  const corpusSha = sha256Hex(corpus);
  if (corpusSha !== CORPUS_SHA256)
    throw new Error(`Corpus SHA-256 ${corpusSha} differs from the pinned ${CORPUS_SHA256}.`);
  const alS1 = findAlS1Record();
  if (options.profile === 'reference' && alS1 === null)
    throw new Error('The reference profile requires the committed AL-S1 reference record.');

  const { runId, output } = reserveOutput();
  console.log(`P3 AL-S2 ${options.profile} output: ${path.relative(root, output)}`);
  const processListing = captureProcessListing(output);
  const run = {
    runId,
    runner: WASM_RUNNER_VERSION,
    command: ['pnpm', 'benchmark:p3-b0-wasm', ...args].join(' '),
    utcStart: new Date().toISOString(),
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

  const failures = [];
  const stage = async (name, action) => {
    try {
      return await action();
    } catch (error) {
      failures.push({ stage: name, error: String(error instanceof Error ? error.message : error) });
      console.error(`P3 AL-S2 ${name}: FAILED; retained in the record`);
      return null;
    }
  };

  // 1. The release WASM.
  const wasm = buildWasm(output);
  console.log(`P3 AL-S2 WASM SHA-256: ${wasm.record.sha256}`);

  // 2. The native leg, just before the browsers.
  const nativeResult = await stage('native-leg', () =>
    runRatioMode({ profile: options.profile, output }),
  );
  const native =
    nativeResult === null
      ? null
      : {
          config: nativeResult.config,
          configHash: nativeResult.configHash,
          toolchain: nativeResult.toolchain,
          build: nativeResult.build,
          corpus: nativeResult.corpus,
          repetitions: nativeResult.repetitions,
          failures: nativeResult.failures,
        };
  if (native !== null) console.log('P3 AL-S2 native leg: complete');

  // 3. The production page.
  const corpusPath = path.join(output, 'corpus.bin');
  writeExclusive(corpusPath, corpus);
  const buildDirectory = path.join(output, 'build');
  const pageEnvironment = {
    ...process.env,
    P3_B0_WASM_PATH: wasm.file,
    P3_B0_WASM_CORPUS_PATH: corpusPath,
    P3_B0_WASM_BUILD_DIR: buildDirectory,
    P3_B0_WASM_RUN_DIR: output,
    P3_B0_WASM_PROFILE: options.profile,
  };
  runLogged(
    process.execPath,
    [
      path.join(root, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      'tests/geometry-benchmark/p3-b0-wasm/vite.config.ts',
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
        'playwright.p3-b0-wasm.config.ts',
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

  const cpus = os.cpus();
  const record = {
    schemaVersion: WASM_SCHEMA_VERSION,
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
      gpu: { applicable: false, reason: 'WASM and native CPU benchmark; no GPU work' },
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
      page: {
        ...page,
        command: 'vite build --config tests/geometry-benchmark/p3-b0-wasm/vite.config.ts',
      },
      buildMode: 'production',
    },
    corpus: { sha256: corpusSha, bytes: corpus.length },
    native,
    browsers,
    alS1: alS1 === null ? null : linkAlS1(alS1.file, alS1.bytes),
    failures,
  };
  // The raw record is written first, so that the samples survive an analysis failure or a
  // source change; a changed source still invalidates the run.
  writeExclusive(path.join(output, 'raw-record.json'), `${JSON.stringify(record)}\n`);
  if (canonicalJson(sourceManifest()) !== canonicalJson(manifestBefore))
    throw new Error('Source files changed during the run; it is invalid. See raw-record.json.');
  const complete = { ...record, analysis: analyze(record) };
  validateWasmRecord(JSON.parse(JSON.stringify(complete)), alS1?.bytes ?? null);
  writeExclusive(path.join(output, 'record.json'), `${JSON.stringify(complete)}\n`);
  writeExclusive(path.join(output, 'summary.md'), summaryMarkdown(complete));
  const { analysis } = complete;
  console.log(
    `P3 AL-S2 ${options.profile}: k̂ ${fixed(analysis.kHat, 3)}, k̂₁ ${fixed(analysis.kHatOnePath, 3)}; validity ${analysis.checks
      .map((item) => `${item.id} ${item.pass ? 'PASS' : 'FAIL'}`)
      .join(', ')}; product verdict ${analysis.product.verdict}; ${path.relative(root, output)}`,
  );
  if (!analysis.valid)
    throw new Error(`An AL-S2 validity item failed; the record is retained in ${output}.`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
