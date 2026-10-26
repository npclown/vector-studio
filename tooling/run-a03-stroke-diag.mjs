// A03 stroke rejection diagnostic (docs/evidence/a03-strokes-2026-10-25.md). Manual, never CI.
//
//   pnpm a03:stroke-diag <corpus.json of a `pnpm p3-exit:sweep --corpus` run> [--all]
//
// Writes the failed stroke requests of the sweep record other than `work-limit` (every failed
// request with --all) as `P3STKIN1` input, runs the ignored native stroke dump
// `emit_stroke_dump` (release profile) on it, and summarizes each request's kernel status and
// unmapped error by stratum, named or generated row, and class: the E4 class (ST-U3f,
// `Rounded(TopologyAmbiguous)`), a B2 section 11.2 literal expectation of the row's named
// fixture, the stroke `work-limit` class, or outside the closed list. It also lists every named
// row with a non-ok stroke result, with its source and class, since E11 section 7.2 records
// named known defects row by row (named.tsv). Output goes to .tools/a03-stroke-diag/<stamp>/,
// with the commit and clean flag in provenance.json.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const record = process.argv[2];
if (record === undefined || record.startsWith('--'))
  throw new Error('usage: pnpm a03:stroke-diag <sweep corpus.json> [--all]');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(root, '.tools', 'a03-stroke-diag', stamp);
mkdirSync(dir, { recursive: true });
const base = path.join(dir, 'input');
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.trim();
writeFileSync(
  path.join(dir, 'provenance.json'),
  `${JSON.stringify(
    {
      commit: git('rev-parse', 'HEAD'),
      dirty: git('status', '--porcelain') !== '',
      record: path.resolve(record),
      all: process.argv.includes('--all'),
    },
    null,
    2,
  )}\n`,
);

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
    'vitest.a03-stroke-diag.config.ts',
  ],
  {
    A03_SWEEP_RECORD: path.resolve(record),
    A03_STROKE_INPUT_OUT: base,
    A03_STROKE_ALL: process.argv.includes('--all') ? '1' : '0',
  },
);
const dump = path.join(dir, 'dump.txt');
run(
  'cargo',
  [
    'test',
    '--release',
    '--manifest-path',
    path.join('packages', 'geometry-wasm', 'kernel', 'Cargo.toml'),
    '--lib',
    'emit_stroke_dump',
    '--',
    '--ignored',
    '--exact',
    'stroke_dump_tests::emit_stroke_dump',
  ],
  { P3_STROKE_INPUT: `${base}.txt`, P3_STROKE_DUMP: dump },
);
// `P3STKDUMP1 <n>`, then `<length> <json>` per case (stroke_dump_tests.rs).
const rows = readFileSync(dump, 'utf8')
  .split('\n')
  .slice(1)
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line.slice(line.indexOf(' ') + 1)));
const sidecar = JSON.parse(readFileSync(`${base}.side.json`, 'utf8'));
if (rows.length !== Object.keys(sidecar).length)
  throw new Error(`native rows ${rows.length}, inputs ${Object.keys(sidecar).length}`);

// Named fixtures whose B2 section 11.2 expectation is not `ok`.
const LITERAL = {
  'ST-F24/2^30': 'numeric-range',
  'ST-F7/butt-miter': 'empty',
  'ST-F9/butt-miter': 'empty',
  'ST-F8/butt': 'empty',
};
const named = (id) => !/^g\d+$/.test(id.split('/')[1]);
const classOf = (row, side) => {
  const error = row.failure?.error ?? '-';
  if (LITERAL[side.source] === row.status) return `B2 literal (${side.source})`;
  // The E4 class on the native outcome; a named row also needs an ST-U3f fixture as its source.
  if (
    row.status === 'unsupported-geometry' &&
    error === 'Rounded(TopologyAmbiguous)' &&
    (!named(row.name) || side.source.startsWith('ST-U3f/'))
  )
    return 'E4 class';
  if (row.status === 'work-limit') return 'stroke work-limit';
  return `outside: ${row.status} ${error}`;
};
const table = new Map();
const perRequest = [];
for (const row of rows) {
  const side = sidecar[row.name];
  if (side === undefined) throw new Error(`no sidecar entry for ${row.name}`);
  if (`failed:${row.status}` !== side.outcome)
    throw new Error(`${row.name}: native ${row.status}, sweep ${side.outcome}`);
  const [stratum, name] = row.name.split('/');
  const kind = /^g\d+$/.test(name) ? 'generated' : 'named';
  const cls = classOf(row, side);
  const error = row.failure?.error ?? '-';
  perRequest.push({ id: row.name, status: row.status, error, class: cls, source: side.source });
  const key = [`${stratum}/${kind}`, row.status, error, cls].join('\t');
  const cell = table.get(key) ?? { requests: 0, rows: new Map() };
  cell.requests += 1;
  cell.rows.set(name, side.source);
  table.set(key, cell);
}
writeFileSync(
  path.join(dir, 'requests.jsonl'),
  `${perRequest.map((r) => JSON.stringify(r)).join('\n')}\n`,
);
const lines = ['stratum\tstatus\terror\tclass\trequests [rows]\trows (source)'];
for (const key of [...table.keys()].sort()) {
  const c = table.get(key);
  const names = [...c.rows.entries()].sort(([a], [b]) => a.localeCompare(b));
  lines.push(
    [
      key,
      `${c.requests} [${names.length}]`,
      names.map(([n, s]) => (s.startsWith('generated:') ? n : `${n} (${s})`)).join(' '),
    ].join('\t'),
  );
}
writeFileSync(path.join(dir, 'summary.tsv'), `${lines.join('\n')}\n`);

// Every named row with a non-ok stroke result: its outcomes and its class. A `work-limit`
// outcome is the stroke `work-limit` class (backlog E15) and an `empty` outcome passes only as
// a B2 literal; the diagnosed classes come from the native run above.
const sweep = JSON.parse(readFileSync(record, 'utf8'));
const sources = JSON.parse(readFileSync(`${base}.named.json`, 'utf8'));
const diagnosed = new Map(perRequest.map((r) => [r.id, r.class]));
const byRow = new Map();
for (const { id, outcome } of sweep.strokeRejections) {
  if (!named(id)) continue;
  const row = id.split('/').slice(0, 2).join('/');
  const source = sources[row];
  const cls =
    outcome === 'failed:work-limit'
      ? 'stroke work-limit (E15)'
      : outcome === 'empty'
        ? LITERAL[source] === 'empty'
          ? `B2 literal (${source})`
          : 'outside: empty'
        : (diagnosed.get(id) ?? `undiagnosed: ${outcome}`);
  const cell = byRow.get(row) ?? { source, classes: new Map() };
  cell.classes.set(cls, (cell.classes.get(cls) ?? 0) + 1);
  byRow.set(row, cell);
}
const namedLines = ['row\tsource\tclass: requests'];
for (const row of [...byRow.keys()].sort()) {
  const c = byRow.get(row);
  namedLines.push(
    [row, c.source, [...c.classes.entries()].map(([k, n]) => `${k}: ${n}`).join('; ')].join('\t'),
  );
}
writeFileSync(path.join(dir, 'named.tsv'), `${namedLines.join('\n')}\n`);
process.stdout.write(`${lines.join('\n')}\n\n${namedLines.join('\n')}\n\n${dir}\n`);
