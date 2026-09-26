import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateP1Environment } from './run-p1-benchmark.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePaths = [
  'packages/geometry-wasm',
  'tests/geometry-benchmark',
  'tests/support/p2-benchmark-record.ts',
  'tooling/run-p2-benchmark.mjs',
  'tooling/test-geometry.mjs',
  'tooling/install-rust.ps1',
  'tooling/run-p1-benchmark.mjs',
  'playwright.p2-benchmark.config.ts',
  'vitest.p2-records.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  '.node-version',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parseP2Arguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !['--profile', '--output-dir', '--environment-json'].includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new Error('Expected explicit --profile functional|reference and unique named options.');
    values.set(key, value);
  }
  const profile = values.get('--profile');
  if (profile !== 'functional' && profile !== 'reference') throw new Error('Invalid P2 profile.');
  const environmentFile = values.get('--environment-json');
  if (profile === 'reference' && !environmentFile)
    throw new Error('Reference requires current --environment-json observations.');
  if (profile === 'functional' && environmentFile)
    throw new Error('Functional mode cannot claim reference environment observations.');
  const environment = environmentFile
    ? validateP1Environment(JSON.parse(readFileSync(environmentFile, 'utf8')))
    : null;
  return { profile, outputDirectory: values.get('--output-dir'), environment };
}

export function reserveP2Output(repositoryRoot, requested) {
  const parent = path.join(repositoryRoot, 'artifacts/p2.5');
  const directory = path.resolve(repositoryRoot, requested ?? path.join(parent, randomUUID()));
  const relative = path.relative(parent, directory);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new Error('P2 output must be a fresh immediate child of artifacts/p2.5.');
  }
  mkdirSync(parent, { recursive: true });
  mkdirSync(directory);
  return directory;
}

export function captureP2Source(repositoryRoot = root) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const files = git('ls-files', '--cached', '--others', '--exclude-standard', '--', ...sourcePaths)
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  if (!files.length) throw new Error('P2 source manifest is empty.');
  const manifest = files.map((file) => ({
    path: file.replaceAll('\\', '/'),
    sha256: hash(readFileSync(path.join(repositoryRoot, file))),
  }));
  return {
    head: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain').length > 0,
    files: manifest,
    sha256: hash(JSON.stringify(manifest)),
  };
}

export function captureP2Build(directory) {
  const files = [];
  function walk(relative) {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile())
        files.push({
          path: child.replaceAll('\\', '/'),
          sha256: hash(readFileSync(path.join(directory, child))),
        });
      else throw new Error('Unexpected non-file build entry.');
    }
  }
  walk('');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    !files.some((file) => file.path === 'geometry.wasm') ||
    !files.some((file) => file.path === 'index.html')
  )
    throw new Error('Incomplete production build.');
  return { files, sha256: hash(JSON.stringify(files)) };
}

export function writeP2Json(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

function main() {
  const options = parseP2Arguments(process.argv.slice(2));
  const directory = reserveP2Output(root, options.outputDirectory);
  const buildDirectory = path.join(directory, 'build');
  const command = ['pnpm', 'benchmark:p2', ...process.argv.slice(2)];
  const source = captureP2Source();
  const invocation = {
    schema: 'p2-run/v1',
    command,
    profile: options.profile,
    observedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    environment: options.environment,
    host: {
      os: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? 'unavailable',
      logicalCores: os.cpus().length,
      memoryBytes: os.totalmem(),
      node: process.version,
    },
    source,
  };
  writeP2Json(path.join(directory, 'invocation.json'), invocation);
  const wasm = path.join(
    root,
    '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
  );
  let build;
  let failure;
  const run = (script, args, environment = {}) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Command failed (${result.status ?? result.signal}): ${script}`);
  };
  try {
    run(path.join(root, 'tooling/test-geometry.mjs'), []);
    const wasmSha256 = hash(readFileSync(wasm));
    const environment = {
      P2_WASM_PATH: wasm,
      P2_WASM_SHA256: wasmSha256,
      P2_BUILD_DIR: buildDirectory,
      P2_RUN_DIR: directory,
      P2_PROFILE: options.profile,
    };
    run(
      path.join(root, 'node_modules/vite/bin/vite.js'),
      ['build', '--config', 'tests/geometry-benchmark/vite.config.ts'],
      environment,
    );
    build = captureP2Build(buildDirectory);
    if (build.files.find((file) => file.path === 'geometry.wasm')?.sha256 !== wasmSha256)
      throw new Error('Production WASM differs from validated build.');
    writeP2Json(path.join(directory, 'build.json'), {
      ...build,
      wasmSha256,
      buildMode: 'production',
      compilerObservation: execFileSync(
        path.join(root, '.tools/rust/cargo/bin/rustup.exe'),
        ['run', '1.94.1', 'rustc', '--version', '--verbose'],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            CARGO_HOME: path.join(root, '.tools/rust/cargo'),
            RUSTUP_HOME: path.join(root, '.tools/rust/rustup'),
          },
        },
      ),
      rust: {
        version: '1.94.1',
        commit: 'e408947bfd200af42db322daf0fadfe7e26d3bd1',
        target: 'wasm32-unknown-unknown',
        profile: 'release',
        optLevel: 3,
        lto: true,
        codegenUnits: 1,
        panic: 'abort',
        strip: true,
        remapPathPrefix: '<repository>=.',
      },
    });
    run(
      path.join(root, 'node_modules/@playwright/test/cli.js'),
      ['test', '--config', 'playwright.p2-benchmark.config.ts'],
      environment,
    );
  } catch (error) {
    failure = String(error);
  } finally {
    let sourceEnd;
    let buildEnd;
    try {
      sourceEnd = captureP2Source();
      if (build) buildEnd = captureP2Build(buildDirectory);
    } catch (error) {
      failure = [failure, String(error)].filter(Boolean).join('; ');
    }
    const sourceMatches = sourceEnd?.head === source.head && sourceEnd?.sha256 === source.sha256;
    const buildMatches = !!build && buildEnd?.sha256 === build.sha256;
    if (!sourceMatches || !buildMatches)
      failure = [failure, 'Source/build integrity failed.'].filter(Boolean).join('; ');
    writeP2Json(path.join(directory, 'completion.json'), {
      sourceEnd,
      buildEnd,
      sourceMatches,
      buildMatches,
      failure: failure ?? null,
    });
    // TypeScript validation runs through the already installed Vitest transform.
    // It reads every raw repetition and the final integrity record after browser exit.
    try {
      run(
        path.join(root, 'node_modules/vitest/vitest.mjs'),
        ['run', '--config', 'vitest.p2-records.config.ts'],
        { P2_RUN_DIR: directory },
      );
    } catch (error) {
      failure = [failure, String(error)].filter(Boolean).join('; ');
    }
    console.log(`P2 ${options.profile} records: ${directory}`);
    writeP2Json(path.join(directory, 'runner-status.json'), {
      schema: 'p2-runner-status/v1',
      finishedAt: new Date().toISOString(),
      success: !failure,
      failure: failure ?? null,
    });
  }
  if (failure) throw new Error(failure);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
