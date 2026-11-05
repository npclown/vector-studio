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
const localCargoHome = path.join(cache, 'rust/cargo');
const localRustup = path.join(
  localCargoHome,
  process.platform === 'win32' ? 'bin/rustup.exe' : 'bin/rustup',
);
// The repository-local toolchain (tooling/install-rust.ps1) wins; otherwise `rustup` on PATH.
const useLocal = process.env.CARGO_HOME === undefined && existsSync(localRustup);
const rustup = useLocal ? localRustup : 'rustup';
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const target = path.join(cache, 'geometry-build');
const env = {
  ...process.env,
  ...(useLocal ? { CARGO_HOME: localCargoHome, RUSTUP_HOME: path.join(cache, 'rust/rustup') } : {}),
  CARGO_TARGET_DIR: target,
  CARGO_ENCODED_RUSTFLAGS: [
    '--remap-path-prefix',
    `${root}=.`,
    '--remap-path-prefix',
    'src\\=src/',
  ].join('\x1f'),
};

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
copyFileSync(built, output);
const sha256 = createHash('sha256').update(readFileSync(output)).digest('hex');
writeFileSync(`${output}.sha256`, `${sha256}  kernel.wasm\n`);
console.log(`Geometry kernel: ${path.relative(root, output)} sha256 ${sha256}`);
