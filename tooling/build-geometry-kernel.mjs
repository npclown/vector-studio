import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// AR-U2 (alpha release plan): builds the geometry kernel WASM with the pinned Rust 1.94.1, the
// same flags and path remaps as tooling/test-geometry.mjs (so the bytes match the identity-checked
// build), and copies it into `packages/geometry-wasm/dist/kernel.wasm` with its SHA-256 beside it.
// `@vector-studio/geometry-wasm/kernel` then gives hosts its URL. `pnpm build` does not run this
// (it needs Rust); `pnpm build:kernel` and the package's `prepack` do.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.tools');
// The same toolchain resolution as tooling/test-geometry.mjs: `CARGO_HOME` (or the
// repository-local install of tooling/install-rust.ps1) names rustup and the toolchains. Without
// either, `rustup` on PATH with its own homes is used (a Linux container, for example).
const cargoHome =
  process.env.CARGO_HOME ??
  (existsSync(path.join(cache, 'rust/cargo')) ? path.join(cache, 'rust/cargo') : undefined);
const rustup =
  cargoHome === undefined
    ? 'rustup'
    : path.join(cargoHome, process.platform === 'win32' ? 'bin/rustup.exe' : 'bin/rustup');
if (cargoHome !== undefined && !existsSync(rustup)) {
  throw new Error(
    'Pinned Rust is missing. Run the separately approved tooling/install-rust.ps1 bootstrap first.',
  );
}
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const target = path.join(cache, 'geometry-build');
const temporary = path.join(cache, 'geometry-tmp');
mkdirSync(temporary, { recursive: true });
const env = {
  ...process.env,
  ...(cargoHome === undefined
    ? {}
    : {
        CARGO_HOME: cargoHome,
        RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(cache, 'rust/rustup'),
      }),
  CARGO_TARGET_DIR: target,
  TEMP: temporary,
  TMP: temporary,
  // Windows writes crate-relative panic paths as `src\…`; the second remap makes the release
  // WASM identical to the Linux build (E11 WASM host identity, d9-rendering-track.md).
  CARGO_ENCODED_RUSTFLAGS: [
    '--remap-path-prefix',
    `${root}=.`,
    '--remap-path-prefix',
    'src\\=src/',
  ].join('\x1f'),
};

// The approved compiler (release and commit; the host may be Windows or Linux, whose release
// WASM bytes are identical under the remaps above).
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
  identity['commit-hash'] !== 'e408947bfd200af42db322daf0fadfe7e26d3bd1'
) {
  throw new Error(`Compiler identity differs from the approved toolchain: ${compiler.stdout}`);
}

const args = [
  'run',
  '1.94.1',
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
console.log(`> ${path.basename(rustup)} ${args.join(' ')}`);
const result = spawnSync(rustup, args, { cwd: root, env, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Kernel build failed (${result.status ?? result.signal})`);

const built = path.join(
  target,
  'wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
);
const dist = path.join(root, 'packages/geometry-wasm/dist');
mkdirSync(dist, { recursive: true });
const output = path.join(dist, 'kernel.wasm');
const bytes = readFileSync(built);
// A failed Windows remap leaves `src\\` panic paths in the module (tooling/test-geometry.mjs).
if (bytes.includes(Buffer.from('src\\'))) {
  throw new Error('The kernel WASM contains unremapped src\\ paths; it is not the identity build.');
}
copyFileSync(built, output);
const sha256 = createHash('sha256').update(readFileSync(output)).digest('hex');
writeFileSync(`${output}.sha256`, `${sha256}  kernel.wasm\n`);
console.log(`Geometry kernel: ${path.relative(root, output)} sha256 ${sha256}`);
