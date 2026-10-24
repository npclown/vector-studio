// D9 E14 cause diagnostic (docs/evidence/e14-fill-work-limit-cause-2026-10-24.md). Manual,
// never CI.
//
//   pnpm e14:fill-diag
//
// Writes the E11-U2 stress scene as fill input, runs the ignored native test
// `e14_fill_limit_diag` (release profile) on it, and prints each path's unmapped kernel outcome
// summarized by class (smooth or looping) and device-radius octave. Output goes to
// .tools/e14-fill-diag/<stamp>/. It is a diagnostic: its timings are not performance evidence.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(root, '.tools', 'e14-fill-diag', stamp);
mkdirSync(dir, { recursive: true });
const base = path.join(dir, 'input');

const run = (command, args, env) => {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} exited with ${result.status}`);
  }
  return result.stdout;
};

run(
  process.execPath,
  [
    path.join(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'vitest.e14-fill-diag.config.ts',
  ],
  { E14_FILL_INPUT_OUT: base },
);
const stdout = run(
  'cargo',
  [
    'test',
    '--release',
    '--manifest-path',
    path.join('packages', 'geometry-wasm', 'kernel', 'Cargo.toml'),
    '--lib',
    'e14_fill_limit_diag',
    '--',
    '--ignored',
    '--nocapture',
    '--test-threads=1',
  ],
  { E14_FILL_INPUT: `${base}.tsv` },
);
const rows = stdout
  .split('\n')
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line));
writeFileSync(path.join(dir, 'native.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
const paths = JSON.parse(readFileSync(`${base}.paths.json`, 'utf8'));

const outcome = (row) => {
  if (row.fast === 'MESH') return 'mesh:rung0';
  if (row.legacy === 'OK') return 'mesh:exact';
  if (row.triangleFree === 'OK') return 'mesh:triangle-free';
  return row.triangleFree === '-' ? row.legacy : row.triangleFree;
};
const table = new Map();
const totals = new Map();
for (const row of rows) {
  const info = paths[row.id];
  const octave = Math.floor(Math.log2(Math.max(info.deviceRadius, 2 ** -4)));
  const key = `${info.looping ? 'looping' : 'smooth'}\t2^${octave}`;
  const cell = table.get(key) ?? { counts: new Map(), flat: [] };
  const name = outcome(row);
  cell.counts.set(name, (cell.counts.get(name) ?? 0) + 1);
  cell.flat.push(row.flatVerbs);
  table.set(key, cell);
  totals.set(name, (totals.get(name) ?? 0) + 1);
}
const order = (key) => {
  const [kind, octave] = key.split('\t');
  return (kind === 'looping' ? 1000 : 0) + Number(octave.slice(2));
};
const lines = ['class\tradius px\toutcomes\tflat verbs median/max'];
for (const key of [...table.keys()].sort((a, b) => order(a) - order(b))) {
  const cell = table.get(key);
  const flat = cell.flat.sort((a, b) => a - b);
  const counts = [...cell.counts].map(([name, count]) => `${name} ${count}`).join(', ');
  lines.push(`${key}\t${counts}\t${flat[flat.length >> 1]}/${flat[flat.length - 1]}`);
}
lines.push('', `totals: ${[...totals].map(([name, count]) => `${name} ${count}`).join(', ')}`);
writeFileSync(path.join(dir, 'summary.txt'), `${lines.join('\n')}\n`);
process.stdout.write(`${lines.join('\n')}\n\n${dir}\n`);
