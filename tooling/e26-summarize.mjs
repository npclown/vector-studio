#!/usr/bin/env node
// E26-U1c (E26 contract, sections 3.2, 3.5 and 6): summarizes the harness's run records
// (tests/e26/e26-harness.spec.ts) into one row per scenario, variant and project. Frame rows give
// each repetition's `rafCallbackIntervalMs` p95 and the maximum per-run p95 against the ceiling,
// with no rounding allowance; latency rows give the maximum per-run p95 of `pointerToWorkDoneMs`
// against its exclusive bound and A05's inputs (long tasks over 50 ms outside the isolation
// measure, autosave writes started during the press, the first write after the release). Isolation
// rows (E26-A06) give each run's R, the one- and 16-rejection times against their per-run bounds,
// the warm-up time and the rejection counts.
//
// M9-U1 (M9 contract, sections 3.2 and 5): the M9 records too. A v2 frame or latency row is read
// as its v1 counterpart and adds the layer rows each run showed (`ui=1`); a v2 latency row adds
// the font-load change's status and the long tasks over 50 ms that overlap it (counted in the
// outside-isolation count, never exempt, M9-Q3). A typing row (`m9-typing-10k/v1`) gives each
// run's `keyToWorkDoneMs` median, p95 and maximum, recorded with no target (M9-Q4). The
// `m9-ui-geometry` record gives whether the canvas origin and size were equal with and without
// `ui=1` (M9-A03).
//
// It trusts each record's p95 fields, and records carry no validity flag: an invalid run is
// failed by the harness after its record is written, so check the Playwright result alongside.
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
  if (index === -1) return null;
  if (rest[index + 1] === undefined) throw new Error(`${name} needs a file`);
  return rest[index + 1];
};

const records = readdirSync(directory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({ name, ...JSON.parse(readFileSync(path.join(directory, name), 'utf8')) }))
  // PA-U4b: memory-variant runs are never timed evidence (A09-A03).
  .filter((record) => record.memoryVariant !== true);

const groups = new Map();
for (const record of records) {
  // E26-U6b: the A06 isolation records carry no variant.
  record.variant ??= 'isolation';
  record.repetition ??= 1;
  const key = `${record.scenario}|${record.variant}|${record.project}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(record);
}

const round = (value) =>
  value === null || value === undefined ? null : Math.round(value * 100) / 100;
const max = (values) => (values.some((value) => value === null) ? null : Math.max(...values));
const min = (values) => (values.some((value) => value === null) ? null : Math.min(...values));

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
  if (first.variant === 'isolation') {
    // E26-A06: one and 16 persistent rejections against min(3R + 50, 500) and min(6R + 100, 1000).
    const passes = runs.map((run) => run.pass);
    return {
      ...common,
      kind: 'isolation',
      rMs: runs.map((run) => round(run.replaceSnapshotMs.median)),
      cleanLoadTailMs: runs.map((run) => round(run.cleanLoadTailMs.median)),
      oneMs: runs.map((run) => round(run.oneMs)),
      oneBoundMs: runs.map((run) => round(run.boundsMs?.one)),
      sixteenMs: runs.map((run) => round(run.sixteenMs)),
      sixteenBoundMs: runs.map((run) => round(run.boundsMs?.sixteen)),
      warmUpMs: runs.map((run) => round(run.run.warmUp.durationMs)),
      rejections: runs.map((run) => [run.run.single.rejections, run.run.scattered.rejections]),
      perRunP95Ms: [],
      maxPerRunP95Ms: null,
      pass: passes.every((entry) => entry !== null && entry.one && entry.sixteen),
    };
  }
  if (first.variant === 'geometry') {
    // M9-A03: the canvas origin and size with and without ui=1.
    const same = (run) =>
      JSON.stringify(run.column.origin) === JSON.stringify(run.aside.origin) &&
      JSON.stringify(run.column.size) === JSON.stringify(run.aside.size);
    return {
      ...common,
      kind: 'geometry',
      perRunP95Ms: [],
      maxPerRunP95Ms: null,
      origin: runs.map((run) => run.aside.origin),
      size: runs.map((run) => run.aside.size),
      pass: runs.every(same),
    };
  }
  if (first.variant === 'typing') {
    // M9-Q4: recorded, no target.
    const p95 = runs.map((run) => run.keyToWorkDoneMs.p95);
    return {
      ...common,
      kind: 'typing',
      perRunMedianMs: runs.map((run) => round(run.keyToWorkDoneMs.median)),
      perRunP95Ms: p95.map(round),
      perRunMaxMs: runs.map((run) => round(run.keyToWorkDoneMs.max)),
      maxPerRunP95Ms: round(max(p95)),
      pass: null,
      samples: runs.map((run) => run.keyToWorkDoneMs.count),
      noChange: runs.map((run) => run.noChange),
      longTasksOver50: runs.map((run) => run.longTasksOver50.length),
      worstLongTaskMs: runs.map((run) =>
        round(Math.max(0, ...run.longTasksOver50.map((task) => task.durationMs))),
      ),
      layerRows: runs.map((run) => run.layers?.rows ?? null),
    };
  }
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
      ...(first.layers === undefined ? {} : { layerRows: runs.map((run) => run.layers.rows) }),
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
    ...(first.fontLoad === undefined
      ? {}
      : {
          layerRows: runs.map((run) => run.layers?.rows ?? null),
          fontLoadStatus: runs.map((run) => run.fontLoad.status),
          longTasksOver50DuringFontLoad: runs.map(
            (run) => run.longTasksOver50.filter((task) => task.fontLoad === true).length,
          ),
        }),
  };
});

const order = [
  'e26-mixed-view-edit-10k/v1',
  'e26-mixed-all-edit-10k/v1',
  'e26-mixed-all-pan-10k/v1',
  'e26-simple-stress-10k/v1',
  'e26-pointer-busy-10k/v1',
  'e26-isolation-m1-a13/v1',
  'e26-mixed-view-edit-10k/v2',
  'e26-mixed-all-edit-10k/v2',
  'e26-mixed-all-pan-10k/v2',
  'e26-simple-stress-10k/v2',
  'e26-pointer-busy-10k/v2',
  'm9-typing-10k/v1',
  'm9-ui-geometry',
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
  '| Scenario | Variant | Project | Per-run p95 (ms; isolation: one / 16 rejections) | Max | Target | Result |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((row) =>
    [
      '',
      `\`${row.scenario}\``,
      row.variant,
      row.project,
      row.kind === 'isolation'
        ? row.oneMs.map((one, i) => `${one} / ${row.sixteenMs[i]}`).join(', ')
        : row.kind === 'geometry'
          ? 'origin and size with and without ui=1'
          : row.perRunP95Ms.join(', '),
      row.kind === 'isolation'
        ? `${max(row.oneMs)} / ${max(row.sixteenMs)}`
        : row.kind === 'geometry'
          ? ''
          : row.maxPerRunP95Ms,
      row.kind === 'frame'
        ? `≤ ${row.ceilingMs}`
        : row.kind === 'latency'
          ? `< ${row.boundMs}`
          : row.kind === 'typing'
            ? 'recorded'
            : row.kind === 'geometry'
              ? 'equal'
              : `≤ ${min(row.oneBoundMs)} / ${min(row.sixteenBoundMs)}`,
      row.pass === null ? 'recorded' : row.pass ? 'pass' : 'miss',
      '',
    ]
      .join(' | ')
      .trim(),
  ),
];
const markdown = option('--markdown');
if (markdown !== null) writeFileSync(markdown, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
