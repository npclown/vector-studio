#!/usr/bin/env node
// E26-U1c (E26 contract, sections 3.2, 3.5 and 6): summarizes the harness's run records
// (tests/e26/e26-harness.spec.ts) into one row per scenario, variant and project. Frame rows give
// each repetition's `rafCallbackIntervalMs` p95 and the maximum per-run p95 against the ceiling,
// with no rounding allowance; latency rows give the maximum per-run p95 of `pointerToWorkDoneMs`
// against its exclusive bound and A05's inputs (long tasks over 50 ms outside the isolation
// measure, autosave writes started during the press, the first write after the release).
//
//   node tooling/e26-summarize.mjs <runs directory> [--json <out.json>] [--markdown <out.md>]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [directory, ...rest] = process.argv.slice(2);
if (directory === undefined) {
  console.error('usage: node tooling/e26-summarize.mjs <runs directory> [--json f] [--markdown f]');
  process.exit(2);
}
const option = (name) => {
  const index = rest.indexOf(name);
  return index === -1 ? null : rest[index + 1];
};

const records = readdirSync(directory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({ name, ...JSON.parse(readFileSync(path.join(directory, name), 'utf8')) }));

const groups = new Map();
for (const record of records) {
  const key = `${record.scenario}|${record.variant}|${record.project}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(record);
}

const round = (value) =>
  value === null || value === undefined ? null : Math.round(value * 100) / 100;
const max = (values) => (values.some((value) => value === null) ? null : Math.max(...values));

const rows = [...groups.values()].map((runs) => {
  runs.sort((a, b) => a.repetition - b.repetition);
  const first = runs[0];
  const common = {
    scenario: first.scenario,
    variant: first.variant,
    project: first.project,
    repetitions: runs.length,
    commits: [...new Set(runs.map((run) => run.commit))],
    dirty: runs.some((run) => run.dirty === true),
    configurationHashes: [...new Set(runs.map((run) => run.configurationHash))],
    browser: first.browser,
    adapter: first.environment?.adapter ?? null,
    idleRafMedianMs: runs.map((run) => round(run.environment?.idleRafMedianMs)),
  };
  if (first.variant === 'frame') {
    const p95 = runs.map((run) => run.rafCallbackIntervalMs.p95);
    const worst = max(p95);
    return {
      ...common,
      kind: 'frame',
      ceilingMs: first.ceilingMs,
      perRunMedianMs: runs.map((run) => round(run.rafCallbackIntervalMs.median)),
      perRunP95Ms: p95.map(round),
      perRunP99Ms: runs.map((run) => round(run.rafCallbackIntervalMs.p99)),
      maxPerRunP95Ms: round(worst),
      pass: worst !== null && worst <= first.ceilingMs,
      encodeAndSubmitP95Ms: runs.map((run) => round(run.encodeAndSubmitMs.p95)),
      longTasksOver50: runs.map(
        (run) => run.run.longTasks.filter((task) => task.durationMs > 50).length,
      ),
      frames: runs.map((run) => run.rafCallbackIntervalMs.count),
    };
  }
  const p95 = runs.map((run) => run.pointerToWorkDoneMs.p95);
  const worst = max(p95);
  return {
    ...common,
    kind: 'latency',
    boundMs: first.boundMs,
    perRunMedianMs: runs.map((run) => round(run.pointerToWorkDoneMs.median)),
    perRunP95Ms: p95.map(round),
    maxPerRunP95Ms: round(worst),
    pass: worst !== null && worst < first.boundMs,
    samples: runs.map((run) => run.pointerToWorkDoneMs.count),
    noChange: runs.map((run) => run.noChange),
    movesSent: runs.map((run) => run.moves),
    longTasksOver50OutsideIsolation: runs.map(
      (run) => run.longTasksOver50.filter((task) => !task.isolation).length,
    ),
    worstLongTaskOutsideIsolationMs: runs.map((run) =>
      round(
        Math.max(
          0,
          ...run.longTasksOver50.filter((task) => !task.isolation).map((task) => task.durationMs),
        ),
      ),
    ),
    isolationMs: runs.map((run) => run.isolations.map((measure) => round(measure.durationMs))),
    writesDuringPress: runs.map((run) => run.writesDuringPress.length),
    firstWriteAfterUpMs: runs.map((run) => round(run.firstWriteAfterUpMs)),
  };
});

const order = [
  'e26-mixed-view-edit-10k/v1',
  'e26-mixed-all-edit-10k/v1',
  'e26-mixed-all-pan-10k/v1',
  'e26-simple-stress-10k/v1',
  'e26-pointer-busy-10k/v1',
];
rows.sort(
  (a, b) =>
    order.indexOf(a.scenario) - order.indexOf(b.scenario) ||
    a.variant.localeCompare(b.variant) ||
    a.project.localeCompare(b.project),
);

const json = option('--json');
if (json !== null)
  writeFileSync(json, `${JSON.stringify({ records: records.length, rows }, null, 2)}\n`);

const lines = [
  '| Scenario | Variant | Project | Per-run p95 (ms) | Max p95 | Target | Result |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((row) =>
    [
      '',
      `\`${row.scenario}\``,
      row.variant,
      row.project,
      row.perRunP95Ms.join(', '),
      row.maxPerRunP95Ms,
      row.kind === 'frame' ? `≤ ${row.ceilingMs}` : `< ${row.boundMs}`,
      row.pass ? 'pass' : 'miss',
      '',
    ]
      .join(' | ')
      .trim(),
  ),
];
const markdown = option('--markdown');
if (markdown !== null) writeFileSync(markdown, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
