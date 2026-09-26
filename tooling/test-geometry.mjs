import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.tools');
const cargoHome = path.join(cache, 'rust/cargo');
const rustup = path.join(cargoHome, process.platform === 'win32' ? 'bin/rustup.exe' : 'bin/rustup');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const target = path.join(cache, 'geometry-build');
const temporary = path.join(cache, 'geometry-tmp');
mkdirSync(temporary, { recursive: true });
const env = {
  ...process.env,
  CARGO_HOME: cargoHome,
  RUSTUP_HOME: path.join(cache, 'rust/rustup'),
  CARGO_TARGET_DIR: target,
  TEMP: temporary,
  TMP: temporary,
  CARGO_ENCODED_RUSTFLAGS: ['--remap-path-prefix', `${root}=.`].join('\x1f'),
};

function run(binary, args, overrides = {}) {
  console.log(`> ${path.basename(binary)} ${args.join(' ')}`);
  const result = spawnSync(binary, args, {
    cwd: root,
    env: { ...env, ...overrides },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (${result.status ?? result.signal})`);
}

if (!existsSync(rustup)) {
  throw new Error(
    'Pinned Rust is missing. Run the separately approved tooling/install-rust.ps1 bootstrap first.',
  );
}
const cargo = (...args) => run(rustup, ['run', '1.94.1', 'cargo', ...args]);
const compiler = spawnSync(rustup, ['run', '1.94.1', 'rustc', '--version', '--verbose'], {
  cwd: root,
  env,
  encoding: 'utf8',
});
if (compiler.error) throw compiler.error;
if (compiler.status !== 0)
  throw new Error(compiler.stderr || 'Rust compiler identity unavailable.');
const identity = Object.fromEntries(
  compiler.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes(': '))
    .map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]),
);
if (
  identity.release !== '1.94.1' ||
  identity.host !== 'x86_64-pc-windows-msvc' ||
  identity['commit-hash'] !== 'e408947bfd200af42db322daf0fadfe7e26d3bd1'
) {
  throw new Error(`Compiler identity differs from the approved toolchain: ${compiler.stdout}`);
}
console.log(compiler.stdout.trim());
const metadata = spawnSync(
  rustup,
  [
    'run',
    '1.94.1',
    'cargo',
    'metadata',
    '--manifest-path',
    manifest,
    '--locked',
    '--offline',
    '--no-deps',
    '--format-version',
    '1',
  ],
  { cwd: root, env, encoding: 'utf8' },
);
if (metadata.error) throw metadata.error;
if (metadata.status !== 0) throw new Error(metadata.stderr || 'Cargo metadata failed.');
const packages = JSON.parse(metadata.stdout).packages;
if (
  packages.length !== 1 ||
  packages[0].name !== 'vector-studio-geometry-kernel' ||
  packages[0].dependencies.length !== 0
) {
  throw new Error(
    'P2.2 permits one std-only kernel crate with no external or reference dependency.',
  );
}
cargo('fmt', '--manifest-path', manifest, '--', '--check');
cargo(
  'clippy',
  '--manifest-path',
  manifest,
  '--locked',
  '--offline',
  '--all-targets',
  '--',
  '-D',
  'warnings',
);
cargo('test', '--manifest-path', manifest, '--locked', '--offline');
const build = [
  'build',
  '--manifest-path',
  manifest,
  '--locked',
  '--offline',
  '--release',
  '--target',
  'wasm32-unknown-unknown',
];
cargo(...build);
mkdirSync(cache, { recursive: true });
const independentTarget = mkdtempSync(path.join(cache, 'geometry-repro-'));
run(rustup, ['run', '1.94.1', 'cargo', ...build], { CARGO_TARGET_DIR: independentTarget });
const wasmRelative = 'wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm';
const wasm = path.join(target, wasmRelative);
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const firstHash = hash(wasm);
if (firstHash !== hash(path.join(independentTarget, wasmRelative))) {
  throw new Error('Independent release build differs from the first WASM artifact.');
}
console.log(`WASM independent-build SHA-256: ${firstHash}`);
run(
  process.execPath,
  [
    path.join(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.geometry.config.ts',
  ],
  {
    P2_WASM_PATH: wasm,
    P2_NATIVE_RUSTUP: rustup,
  },
);
