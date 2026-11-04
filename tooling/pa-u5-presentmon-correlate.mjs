// PA-U5 (pre-alpha gate plan, PA-A06; P1 A10): correlates one `E26_PRESENTMON` run record of
// `e26-pointer-busy-10k/v2` (tests/e26/presentmon.ts) with its PresentMon CSV.
//
// Usage: node tooling/pa-u5-presentmon-correlate.mjs <run record .json> [<csv>]
//
// Method and limits (printed into the output too):
// - page time -> QPC by the clock pairs' offset (mean of the before and after offsets); its
//   uncertainty is the larger pair uncertainty plus half the before/after drift.
// - only moves whose input and work-done times both fall inside the captured display span count;
//   the others are reported as outside the capture.
// - `lowerBoundMs` per move: the first display of the captured GPU process at or after the
//   move's earliest possible input time (input minus the clock uncertainty u), minus the latest
//   possible input time (input plus u), floored at 0. It is expected to sit between 0 and one
//   refresh interval and says little by itself. No change can be shown
//   before its input, so this is a true lower bound of pointer-to-present, but a weak one: the
//   frame it finds may not hold the change.
// - `afterWorkDoneMs` per move: the first display at or after the move's work-done time, minus
//   the input time. A heuristic, not a bound: work-done is read on the page's main thread when
//   `onSubmittedWorkDone` resolves, which a busy thread can delay past the display of the
//   change (too high), and the compositor may show the change later still (too low).
// No frame or content identity joins a CSV row to a move (P1.0m method assessment, J2): neither
// number is a validated pointer-to-present measurement, and A10 stays UNVERIFIED on them.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [recordPath, csvArgument] = process.argv.slice(2);
if (recordPath === undefined) throw new Error('Usage: pa-u5-presentmon-correlate.mjs <record>');
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const capture = record.presentmon;
if (capture === undefined) throw new Error('The record has no presentmon block.');
const csvPath = csvArgument ?? path.join(capture.directory, `${capture.channel}.csv`);
const lines = readFileSync(csvPath, 'utf8')
  .replace(/^\uFEFF/u, '')
  .split(/\r?\n/u);
const header = lines[0].split(',');
const column = (name) => header.findIndex((entry) => entry.trim() === name);
const rows = lines
  .slice(1)
  .filter((line) => line.trim() !== '')
  .map((line) => line.split(','));

const pidColumn = column('ProcessID');
const target = rows.filter((row) => pidColumn >= 0 && Number(row[pidColumn]) === capture.gpuPid);
const frequency = capture.syncBefore.frequency;
const qpcMs = (value) => (Number(value) / frequency) * 1000;
const number = (value) => (value === undefined || value === 'NA' ? Number.NaN : Number(value));

let schema = 'unresolved';
let displayed = [];
if (column('TimeInQPC') >= 0 && column('MsUntilDisplayed') >= 0) {
  // Default schema: Present call time plus the time until it was displayed.
  schema = 'TimeInQPC + MsUntilDisplayed';
  displayed = target.map(
    (row) => qpcMs(row[column('TimeInQPC')]) + number(row[column('MsUntilDisplayed')]),
  );
} else {
  const start = column('CPUStartQPC');
  const latency = ['DisplayLatency', 'MsDisplayLatency'].map(column).find((index) => index >= 0);
  if (start >= 0 && latency !== undefined) {
    // v2 schema: CPU frame start plus the display latency measured from it.
    schema = `CPUStartQPC + ${header[latency]}`;
    displayed = target.map((row) => qpcMs(row[start]) + number(row[latency]));
  }
}
displayed = displayed.filter(Number.isFinite).sort((a, b) => a - b);

const before = capture.syncBefore;
const after = capture.syncAfter;
const offsetMs = (before.offsetMs + after.offsetMs) / 2;
const driftMs = Math.abs(after.offsetMs - before.offsetMs);
const uncertaintyMs = Math.max(before.uncertaintyMs, after.uncertaintyMs) + driftMs / 2;

const nearestRank = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};
const ended = record.state.latencies.filter((entry) => Number.isFinite(entry.doneMs));
const firstDisplay = displayed[0] ?? null;
const lastDisplay = displayed[displayed.length - 1] ?? null;
if (schema === 'unresolved' || firstDisplay === null) {
  process.stderr.write(
    `No usable display rows (schema ${schema}, ${target.length} rows for GPU PID ${capture.gpuPid}); header: ${header.join(',')}\n`,
  );
  process.exit(1);
}
const inside = ended.filter(
  (entry) => entry.inputMs + offsetMs >= firstDisplay && entry.doneMs + offsetMs <= lastDisplay,
);
const lowerBounds = [];
const afterDone = [];
for (const entry of inside) {
  const inputQ = entry.inputMs + offsetMs;
  const doneQ = entry.doneMs + offsetMs;
  const shownAfterInput = displayed.find((time) => time >= inputQ - uncertaintyMs);
  const shownAfterDone = displayed.find((time) => time >= doneQ);
  if (shownAfterInput !== undefined)
    lowerBounds.push(Math.max(0, shownAfterInput - inputQ - uncertaintyMs));
  if (shownAfterDone !== undefined) afterDone.push(shownAfterDone - inputQ);
}
if (inside.length === 0)
  process.stderr.write('Warning: no move falls inside the captured display span.\n');
const work = inside.map((entry) => entry.doneMs - entry.inputMs);
const stats = (values) => ({
  count: values.length,
  p50: nearestRank(values, 0.5),
  p95: nearestRank(values, 0.95),
  max: values.length === 0 ? null : Math.max(...values),
});
const result = {
  record: recordPath,
  csv: csvPath,
  schema,
  header,
  gpuPid: capture.gpuPid,
  rows: rows.length,
  targetRows: target.length,
  displayedRows: displayed.length,
  clock: { frequency, offsetMs, driftMs, uncertaintyMs },
  window: {
    firstDisplayQpcMs: firstDisplay,
    lastDisplayQpcMs: lastDisplay,
    firstInputQpcMs: ended.length === 0 ? null : ended[0].inputMs + offsetMs,
    lastDoneQpcMs: ended.length === 0 ? null : ended[ended.length - 1].doneMs + offsetMs,
  },
  moves: ended.length,
  movesInsideCapture: inside.length,
  movesOutsideCapture: ended.length - inside.length,
  pointerToWorkDoneMs: stats(work),
  lowerBoundMs: stats(lowerBounds),
  afterWorkDoneMs: stats(afterDone),
  limits: [
    'lowerBoundMs is a true but weak lower bound; afterWorkDoneMs is a heuristic. No frame or content identity joins a CSV row to a move (P1.0m J2).',
    'Page-to-QPC offset from bracketed clock pairs; each bound carries the clock uncertainty.',
    'One run, one browser, synthetic CDP input; the UAC prompt preceded the run.',
  ],
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
