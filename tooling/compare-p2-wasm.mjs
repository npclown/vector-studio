// P3 V2 contract section k item 6 (P-C2): P2 output-byte identity evidence.
//
// Builds main's release WASM from `git archive` of the merge base into a
// temporary directory with the pinned toolchain and the flags of
// tooling/test-geometry.mjs, builds this checkout's release WASM the same way,
// and runs the P2 differential corpus through the P2 v1 exports of both.
//
// Usage: node tooling/compare-p2-wasm.mjs [base-ref]   (default: merge-base HEAD main)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.tools');
const cargoHome = process.env.CARGO_HOME || path.join(cache, 'rust/cargo');
const rustup = path.join(cargoHome, process.platform === 'win32' ? 'bin/rustup.exe' : 'bin/rustup');
const temporary = path.join(cache, 'geometry-tmp');
const wasmRelative = 'wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm';
const kernelPath = 'packages/geometry-wasm/kernel';

if (!existsSync(rustup)) {
  throw new Error('Pinned Rust is missing. Run the approved tooling/install-rust.ps1 bootstrap.');
}
mkdirSync(temporary, { recursive: true });

function run(binary, args, options = {}) {
  console.log(`> ${path.basename(binary)} ${args.join(' ')}`);
  const result = spawnSync(binary, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (${result.status ?? result.signal})`);
}

function capture(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${binary} failed`);
  return result.stdout.trim();
}

/** Builds one kernel crate exactly as tooling/test-geometry.mjs does. */
function buildRelease(sourceRoot, targetDirectory) {
  const env = {
    ...process.env,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(cache, 'rust/rustup'),
    CARGO_TARGET_DIR: targetDirectory,
    TEMP: temporary,
    TMP: temporary,
    CARGO_ENCODED_RUSTFLAGS: [
      '--remap-path-prefix',
      `${sourceRoot}=.`,
      '--remap-path-prefix',
      'src\\=src/',
    ].join('\x1f'),
  };
  run(
    rustup,
    [
      'run',
      '1.94.1',
      'cargo',
      'build',
      '--manifest-path',
      path.join(sourceRoot, kernelPath, 'Cargo.toml'),
      '--locked',
      '--offline',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
    ],
    { env },
  );
  return path.join(targetDirectory, wasmRelative);
}

const base = process.argv[2] ?? capture('git', ['merge-base', 'HEAD', 'main']);
const baseCommit = capture('git', ['rev-parse', '--verify', `${base}^{commit}`]);
const workspace = mkdtempSync(path.join(cache, 'p2-identity-'));
try {
  const sourceRoot = path.join(workspace, 'source');
  mkdirSync(sourceRoot);
  run('git', ['archive', '--format=tar', '-o', path.join(workspace, 'base.tar'), baseCommit]);
  // A relative archive path keeps drive letters away from tar.
  run('tar', ['-xf', '../base.tar', kernelPath], { cwd: sourceRoot });
  const mainWasm = buildRelease(sourceRoot, path.join(workspace, 'target'));
  const branchWasm = buildRelease(root, path.join(cache, 'geometry-build'));
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  console.log(`Base commit: ${baseCommit}`);
  console.log(`Main release WASM SHA-256: ${hash(mainWasm)}`);
  console.log(`Branch release WASM SHA-256: ${hash(branchWasm)}`);
  run(
    process.execPath,
    [
      path.join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'vitest.p2-identity.config.ts',
      '--reporter=verbose',
    ],
    { env: { ...process.env, P2_MAIN_WASM_PATH: mainWasm, P2_WASM_PATH: branchWasm } },
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
