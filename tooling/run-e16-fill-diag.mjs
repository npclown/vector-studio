// D9 E16 cause diagnostic (docs/evidence/e16-fill-rejection-cause-2026-10-25.md). Manual,
// never CI.
//
//   pnpm e16:fill-diag <corpus.json of a `pnpm p3-exit:sweep --corpus` run>
//
// Writes every failed fill request of the sweep record as input, runs the ignored native test
// `e14_fill_limit_diag` (release profile) on it, and prints each request's unmapped kernel
// outcome, summarized by stratum, named or generated row, sweep class and cause (summary.tsv),
// and counts each stratum's requests by closed-list class (classes.tsv). Output goes to
// .tools/e16-fill-diag/<stamp>/. It is a diagnostic: its timings are not performance evidence.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const record = process.argv[2];
if (record === undefined) throw new Error('usage: pnpm e16:fill-diag <sweep corpus.json>');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(root, '.tools', 'e16-fill-diag', stamp);
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
    'vitest.e16-fill-diag.config.ts',
  ],
  { E16_SWEEP_RECORD: path.resolve(record), E16_FILL_INPUT_OUT: base },
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
const sidecar = JSON.parse(readFileSync(`${base}.side.json`, 'utf8'));
if (rows.length !== Object.keys(sidecar).length)
  throw new Error(`native rows ${rows.length}, inputs ${Object.keys(sidecar).length}`);

/** The kernel step that refused the request at r3, from the cascade at e's unmapped errors. */
const cause = (row) => {
  const last = row.triangleFree === '-' ? row.legacy : row.triangleFree;
  if (row.legacy === 'SourceLimit') return 'source cap';
  if (row.legacy === 'CommandLimit' || row.legacy === 'OwnerLimit') return 'exact-rung edge cap';
  if (row.legacy === 'ZeroLengthLeaf') return 'zero-length leaf';
  if (/^Topology\((Unresolved|KnotMismatch)\)$/.test(last)) return 'topology unresolved';
  if (/^Rounded\(/.test(last)) return 'exact-rung topology cap';
  return `other: ${row.legacy} / ${row.triangleFree}`;
};
/**
 * The request's exact-rung result at fill-v0+r4 (E16-U1): `mesh`, or the error of the cascade
 * at e with the last E16-K2 retry's stop error, which the E11 closed-list class reads.
 */
const r4 = (row) => {
  if (row.fast === 'MESH' || row.exact === 'OK') return 'mesh';
  const stop = row.retryStop === '-' ? '' : ` (retry stop ${row.retryStop})`;
  return `${row.exact}${stop}`;
};
/** The exact rung's segment cap on a line-only path (E16-U1, `B1_LINE_CAPS`): E = 256. */
const EXACT_LINE_SEGMENT_CAP = 256;
const CAP_STOP = /^(CommandLimit|OwnerLimit|Rounded\(.*\)|Topology\(WorkLimit\))$/;

/**
 * The closed-list class (E11 section 7.2, update 2026-10-25, the user decision of E11 section
 * 9.2) of a failed request, as far as the native outcome decides it:
 * - "fill stop in the exact rung's caps": rung 0 did not mesh, the row is not in E14-Q1, and the
 *   exact rung's terminal error, at e or as the stop error of the last E16-K2 retry, is
 *   `CommandLimit`, `OwnerLimit`, `Rounded(_)` or `Topology(WorkLimit)`, or `SourceLimit` on a
 *   line-only path over the exact rung's line segment cap;
 * - "fill `ZeroLengthLeaf`": the exact rung ends in `ZeroLengthLeaf` (E16-K2 does not retry it).
 * The E4 and E8 classes are assigned by the evidence review, so the rest is reported as outside,
 * with its cause.
 */
const closedClass = (row, side) => {
  if (side.e14) return 'E14-Q1';
  const atE = row.triangleFree === '-' ? row.legacy : row.triangleFree;
  // E16-U1 prints the last retry's stop as `depth:error`, or `-` when no retry ran. The class
  // takes either error.
  const terminals = [atE];
  if (row.retryStop !== undefined && row.retryStop !== '-') {
    if (!/^\d+:.+$/.test(row.retryStop))
      throw new Error(`${row.id}: retryStop ${JSON.stringify(row.retryStop)} is not depth:error`);
    terminals.push(row.retryStop.replace(/^\d+:/, ''));
  }
  // `segments` counts LINE and CUBIC verbs, as `decode_sources` counts sources (CLOSE adds none).
  const capStop = (error) =>
    CAP_STOP.test(error) ||
    (error === 'SourceLimit' && side.cubics === 0 && side.segments > EXACT_LINE_SEGMENT_CAP);
  if (row.fast !== 'MESH' && terminals.some(capStop)) return 'exact-rung cap stop';
  if (atE === 'ZeroLengthLeaf') return 'zero-length leaf';
  return `outside: ${cause(row)}`;
};
const classes = new Map();
const table = new Map();
for (const row of rows) {
  const side = sidecar[row.id];
  const [stratum, name] = row.id.split('/');
  const kind = /^g\d+$/.test(name) ? 'generated' : 'named';
  const sweep = side.e14 ? 'E14-Q1' : side.outcome.replace('failed:', '');
  const key = [`${stratum}/${kind}`, sweep, cause(row), `rung0 ${row.fast}`, r4(row)].join('\t');
  const classKey = `${stratum}/${kind}\t${closedClass(row, side)}`;
  classes.set(classKey, (classes.get(classKey) ?? 0) + 1);
  const cell = table.get(key) ?? {
    requests: 0,
    rows: new Set(),
    flat: [],
    contours: 0,
    segments: 0,
  };
  cell.requests += 1;
  cell.rows.add(name);
  cell.flat.push(row.flatVerbs);
  cell.contours = Math.max(cell.contours, side.contours);
  cell.segments = Math.max(cell.segments, side.segments);
  table.set(key, cell);
}
const lines = [
  'stratum\tsweep class\tcause\trung 0\tr4 exact rung\trequests [rows]\tflat verbs min/median/max\tmax contours/segments\trows',
];
for (const key of [...table.keys()].sort()) {
  const c = table.get(key);
  const flat = c.flat.sort((a, b) => a - b);
  const names = [...c.rows].sort();
  lines.push(
    [
      key,
      `${c.requests} [${names.length}]`,
      `${flat[0]}/${flat[flat.length >> 1]}/${flat[flat.length - 1]}`,
      `${c.contours}/${c.segments}`,
      names.length > 12 ? `${names.slice(0, 12).join(' ')} …` : names.join(' '),
    ].join('\t'),
  );
}
writeFileSync(path.join(dir, 'summary.tsv'), `${lines.join('\n')}\n`);
const classLines = [
  'stratum\tclosed-list class\trequests',
  ...[...classes.keys()].sort().map((key) => `${key}\t${classes.get(key)}`),
];
writeFileSync(path.join(dir, 'classes.tsv'), `${classLines.join('\n')}\n`);
process.stdout.write(`${lines.join('\n')}\n\n${classLines.join('\n')}\n\n${dir}\n`);
