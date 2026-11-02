#!/usr/bin/env node
// M9-U2 (M9 contract, section 5): writes one result file pair (.json and .md) per scenario and
// browser to docs/benchmarks/results/, from a sitting's run records and its summary.json (the
// output of tooling/e26-summarize.mjs). The machine token is `reference`, and the run-ID suffix
// keeps every sitting's files distinct. Each JSON holds the summary rows of that scenario and
// browser (both DPRs), the record files with their SHA-256, and, for frame rows, the second line
// of M9-Q2: per run, the share of frame intervals over 1.5 refresh intervals (from each record's
// own idle rAF median). Writers refuse to replace an existing file (benchmarks README).
//
//   node tooling/m9-u2-results.mjs <sitting directory> --date YYYY-MM-DD --run-id <id>
//     [--out docs/benchmarks/results] [--record <link to the U2 record, relative to --out>]
//
// The sitting directory holds runs/ (records and files.txt) and summary.json.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [directory, ...rest] = process.argv.slice(2);
const option = (name, fallback) => {
  const index = rest.indexOf(name);
  if (index === -1) return fallback;
  if (rest[index + 1] === undefined) throw new Error(`${name} needs a value`);
  return rest[index + 1];
};
const date = option('--date', null);
const runId = option('--run-id', null);
const out = option('--out', 'docs/benchmarks/results');
const recordLink = option('--record', null);
if (directory === undefined || date === null || runId === null) {
  console.error(
    'usage: node tooling/m9-u2-results.mjs <sitting dir> --date YYYY-MM-DD --run-id <id> [--out d] [--record link]',
  );
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date ${date} is not YYYY-MM-DD`);
if (!/^[A-Za-z0-9-]+$/.test(runId))
  throw new Error(`--run-id ${runId} must be letters, digits and dashes`);

const runsDirectory = path.join(directory, 'runs');
const summary = JSON.parse(readFileSync(path.join(directory, 'summary.json'), 'utf8'));
const recordFiles = readdirSync(runsDirectory)
  .filter((name) => name.endsWith('.json'))
  .sort();
const records = recordFiles.map((name) => {
  const bytes = readFileSync(path.join(runsDirectory, name));
  return {
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    record: JSON.parse(bytes),
  };
});

const browserOf = (project) => {
  const name = project.split('-')[0];
  if (name !== 'chrome' && name !== 'edge') throw new Error(`unknown project ${project}`);
  return name;
};
const slug = (scenario) => scenario.replace('/', '-');

// M9-Q2's second line: intervals over 1.5 refresh intervals, the refresh interval read from the
// record's own idle rAF median, as a share of the run's intervals.
const overOneAndHalf = (record) => {
  const intervals = record.run?.measurements?.frameIntervalsMs;
  const refresh = record.environment?.idleRafMedianMs;
  if (!Array.isArray(intervals) || intervals.length === 0 || typeof refresh !== 'number')
    return null;
  const over = intervals.filter((value) => value > 1.5 * refresh).length;
  return {
    over,
    intervals: intervals.length,
    share: Math.round((over / intervals.length) * 10000) / 10000,
  };
};

const groups = new Map();
for (const row of summary.rows) {
  const key = `${row.scenario}|${browserOf(row.project)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const formatList = (values) =>
  values.map((value) => (value === null ? 'n/a' : String(value))).join(', ');
const written = [];
for (const [key, rows] of groups) {
  const [scenario, browser] = key.split('|');
  const projects = new Set(rows.map((row) => row.project));
  const mine = records.filter(
    (entry) => entry.record.scenario === scenario && projects.has(entry.record.project),
  );
  const frameShares =
    rows[0].kind === 'frame'
      ? Object.fromEntries(
          rows.map((row) => [
            row.project,
            mine
              .filter(
                (entry) =>
                  entry.record.project === row.project && entry.record.variant === row.variant,
              )
              .sort((a, b) => a.record.repetition - b.record.repetition)
              .map((entry) => overOneAndHalf(entry.record)),
          ]),
        )
      : null;
  const base = `${date}_m9_${slug(scenario)}_${browser}_reference_${runId}`;
  const json = {
    schema: 'm9-u2-result/1',
    scenario,
    browser,
    machine: 'reference',
    runId,
    commits: [...new Set(rows.flatMap((row) => row.commits ?? []))],
    rows,
    intervalsOverOneAndHalfRefresh: frameShares,
    records: mine.map((entry) => ({
      file: path.posix.join(directory.split(path.sep).join('/'), 'runs', entry.name),
      sha256: entry.sha256,
    })),
  };
  const lines = [
    `# M9-U2 ${scenario}, ${browser}, reference, ${runId}`,
    '',
    'Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.',
    recordLink === null
      ? ''
      : `The sitting's record, with the verdicts and findings, is [here](${recordLink}).`,
    '',
    '| Project | Variant | Per-run p95 (ms) | Max | Target | Result |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => {
      const target =
        row.ceilingMs != null
          ? `≤ ${row.ceilingMs}`
          : row.boundMs != null
            ? `< ${row.boundMs}`
            : 'recorded';
      const result =
        row.kind === 'typing'
          ? 'recorded'
          : row.pass === true
            ? 'pass'
            : row.pass === false
              ? 'miss'
              : 'n/a';
      const p95 =
        row.kind === 'isolation'
          ? row.oneMs.map((one, index) => `${one} / ${row.sixteenMs[index]}`).join(', ')
          : formatList(row.perRunP95Ms ?? []);
      return `| ${row.project} | ${row.variant} | ${p95} | ${row.maxPerRunP95Ms ?? 'n/a'} | ${target} | ${result} |`;
    }),
    '',
  ];
  if (frameShares !== null) {
    lines.push(
      'Share of frame intervals over 1.5 refresh intervals, per run (M9-Q2 second line):',
      '',
    );
    for (const [project, shares] of Object.entries(frameShares)) {
      lines.push(
        `- ${project}: ${shares.map((entry) => (entry === null ? 'n/a' : `${(entry.share * 100).toFixed(1)} % (${entry.over} of ${entry.intervals})`)).join(', ')}`,
      );
    }
    lines.push('');
  }
  lines.push(
    `Raw records: ${mine.length} files, listed with their SHA-256 in the [.json beside this file](${base}.json).`,
    '',
  );
  writeFileSync(path.join(out, `${base}.json`), `${JSON.stringify(json, null, 2)}\n`, {
    flag: 'wx',
  });
  writeFileSync(
    path.join(out, `${base}.md`),
    lines.filter((line, index) => !(line === '' && lines[index - 1] === '')).join('\n'),
    { flag: 'wx' },
  );
  written.push(base);
}
console.log(`wrote ${written.length} result pairs`);
for (const base of written) console.log(base);
