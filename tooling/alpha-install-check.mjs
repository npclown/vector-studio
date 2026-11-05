/* global fetch */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { ALPHA_PACKAGES, ALPHA_VERSION } from './alpha-packages.mjs';
import { drive } from './alpha-install-check/drive.mjs';

// AR-U4 (alpha release plan): the install check. It packs every alpha package (`pnpm pack`, so
// geometry-wasm's `prepack` builds the kernel with the pinned Rust), installs the tarballs with npm
// into two fresh apps outside the workspace (Vite + React, and Next.js with a Server Component
// page), type-checks and builds each, serves the production build on localhost, and runs
// alpha-install-check/drive.mjs: render, one edit, the document, history and layer tree, and on a
// real GPU the presented pixels.
//
//   node tooling/alpha-install-check.mjs [--out <dir>] [--tgz <dir>] [--channel chrome|msedge]
//
// `--tgz` reuses packed tarballs. `--channel` drives that installed browser headed on the machine's
// GPU and requires the pixels; without it the bundled Chromium (or AR4_CHROMIUM) runs headless on
// SwiftShader and the pixels are reported as not checked (SwiftShader's device is lost at once in
// a container). The results are written to `<out>/results.json`; the exit code is 1 on a failure.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templates = path.join(root, 'tooling/alpha-install-check/templates');
const windows = process.platform === 'win32';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = path.resolve(
  argument('--out') ?? path.join(tmpdir(), `vector-studio-alpha-${Date.now()}`),
);
const channel = argument('--channel');
const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
if (inside(out, root)) throw new Error('--out must be outside the workspace');

// The host dependencies, pinned to the versions of the first passing run.
const HOSTS = {
  vite: {
    dependencies: ['react@19.2.9', 'react-dom@19.2.9'],
    devDependencies: [
      'vite@8.3.6',
      '@vitejs/plugin-react@6.2.1',
      'typescript@5.9.3',
      '@types/react@19.3.0',
      '@types/react-dom@19.3.0',
    ],
    editor: 'src/editor.tsx',
    check: ['npx', 'tsc', '-p', 'tsconfig.json'],
    build: ['npx', 'vite', 'build'],
    serve: (port) => [
      'npx',
      'vite',
      'preview',
      '--port',
      String(port),
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    port: 4191,
  },
  next: {
    dependencies: ['react@19.2.9', 'react-dom@19.2.9', 'next@16.4.3'],
    devDependencies: [
      'typescript@5.9.3',
      '@types/react@19.3.0',
      '@types/react-dom@19.3.0',
      '@types/node@24.19.2',
    ],
    editor: 'app/editor.tsx',
    check: null,
    build: ['npx', 'next', 'build'],
    serve: (port) => ['npx', 'next', 'start', '-p', String(port), '-H', '127.0.0.1'],
    port: 4192,
  },
};

// On Windows the commands run through the shell (npm, npx and pnpm are .cmd files), which joins
// the arguments unquoted, so arguments with spaces (a %TEMP% under a user name with a space) are
// quoted here.
const shellArguments = (command) =>
  windows ? command.map((part) => (/[\s&()^]/.test(part) ? `"${part}"` : part)) : command;

function run(command, cwd) {
  console.log(`$ ${command.join(' ')}  (${cwd})`);
  const [file, ...rest] = shellArguments(command);
  const result = spawnSync(file, rest, { cwd, stdio: 'inherit', shell: windows });
  if (result.status !== 0)
    throw new Error(`${command.join(' ')} exited with ${String(result.status)}`);
}

function pack(destination) {
  mkdirSync(destination, { recursive: true });
  for (const directory of ALPHA_PACKAGES) {
    run(['pnpm', 'pack', '--pack-destination', destination], path.join(root, directory));
  }
  return destination;
}

async function answers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return true;
  } catch {
    return false;
  }
}

async function serve(command, cwd, port) {
  // A server left on the port (an interrupted run) would otherwise be checked instead of this build.
  if (await answers(port))
    throw new Error(`port ${port} is already in use; stop that server first`);
  const [file, ...rest] = shellArguments(command);
  let exited = false;
  const child = spawn(file, rest, {
    cwd,
    shell: windows,
    detached: !windows,
    stdio: 'ignore',
  });
  child.on('exit', () => {
    exited = true;
  });
  const stop = () => {
    if (exited) return;
    if (windows)
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  };
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (exited) throw new Error(`${command.join(' ')} exited before serving port ${port}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return stop;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  stop();
  throw new Error(`${command.join(' ')} did not serve port ${port}`);
}

mkdirSync(out, { recursive: true });
let tgz = argument('--tgz');
if (tgz === undefined) {
  run(['pnpm', 'build'], root);
  tgz = pack(path.join(out, 'tgz'));
} else {
  tgz = path.resolve(tgz);
}
// Exactly one tarball per alpha package, at the alpha version (stale tarballs fail here).
const tarballs = ALPHA_PACKAGES.map((directory) => {
  const name = `vector-studio-${path.basename(directory)}-${ALPHA_VERSION}.tgz`;
  if (!existsSync(path.join(tgz, name))) throw new Error(`${tgz} has no ${name}`);
  return path.join(tgz, name);
});
const extra = readdirSync(tgz).filter(
  (name) => name.endsWith('.tgz') && !tarballs.includes(path.join(tgz, name)),
);
if (extra.length > 0) throw new Error(`${tgz} holds other tarballs: ${extra.join(', ')}`);

const browser = await chromium.launch(
  channel === undefined
    ? {
        executablePath: process.env.AR4_CHROMIUM,
        args: [
          '--enable-unsafe-webgpu',
          '--enable-unsafe-swiftshader',
          '--use-webgpu-adapter=swiftshader',
        ],
      }
    : { channel, headless: false, args: ['--enable-unsafe-webgpu'] },
);
const results = { channel: channel ?? 'swiftshader', out, hosts: {} };
try {
  for (const [name, host] of Object.entries(HOSTS)) {
    const app = path.join(out, `${name}-host`);
    rmSync(app, { recursive: true, force: true });
    cpSync(path.join(templates, name), app, { recursive: true });
    cpSync(path.join(templates, 'shared/editor.tsx'), path.join(app, host.editor));
    writeFileSync(
      path.join(app, 'package.json'),
      `${JSON.stringify({ name: `alpha-install-${name}`, private: true, type: 'module' }, null, 2)}\n`,
    );
    run(['npm', 'install', '--no-audit', '--no-fund', ...tarballs, ...host.dependencies], app);
    run(['npm', 'install', '--no-audit', '--no-fund', '--save-dev', ...host.devDependencies], app);
    if (host.check !== null) run(host.check, app);
    run(host.build, app);
    const stop = await serve(host.serve(host.port), app, host.port);
    try {
      results.hosts[name] = await drive(browser, `http://127.0.0.1:${host.port}/?capture=1`, {
        pixels: channel !== undefined,
        screenshot: path.join(out, name),
      });
    } finally {
      stop();
    }
  }
} finally {
  await browser.close();
}

writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
let failed = false;
for (const [name, result] of Object.entries(results.hosts)) {
  const verdict = result.failures.length === 0 ? 'PASS' : 'FAIL';
  failed ||= verdict === 'FAIL';
  console.log(`${name}: ${verdict}, renderer ${result.renderer}, pixels ${result.pixels}`);
  for (const failure of result.failures) console.log(`  - ${failure}`);
}
console.log(`results: ${path.join(out, 'results.json')}`);
if (!existsSync(path.join(out, 'results.json')) || failed) process.exitCode = 1;
