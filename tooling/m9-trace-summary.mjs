#!/usr/bin/env node
// M9-U3a diagnostic (not evidence): summarizes the Chrome traces that `E26_TRACE` records
// (tests/e26/e26-harness.spec.ts). For each trace it finds the page's main thread
// (CrRendererMain with the most events) and, between the `e26-window-start` and `e26-window-end`
// marks when present (otherwise over the whole trace), sums the inclusive time of the timeline
// events that matter for a frame: scripting, style, layout, paint and GC. It also gives the top
// JS functions by self time from the V8 CPU samples on that thread. Times are in ms.
//
//   node tooling/m9-trace-summary.mjs <trace.json>... [--json <out.json>] [--top 25]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
};
const jsonOut = option('--json', null);
const top = Number(option('--top', '25'));
if (args.length === 0) {
  console.error('usage: node tooling/m9-trace-summary.mjs <trace.json>... [--json f] [--top n]');
  process.exit(2);
}

const NAMES = [
  'RunTask',
  'FireAnimationFrame',
  'FunctionCall',
  'EventDispatch',
  'TimerFire',
  'RunMicrotasks',
  'v8.run',
  'UpdateLayoutTree',
  'Layout',
  'PrePaint',
  'Paint',
  'Layerize',
  'UpdateLayer',
  'Commit',
  'HitTest',
  'MajorGC',
  'MinorGC',
  'V8.GC_SCAVENGER',
  'V8.GC_MARK_COMPACTOR',
];

function summarize(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const events = Array.isArray(raw) ? raw : raw.traceEvents;
  const threadNames = new Map();
  const counts = new Map();
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`;
    if (event.ph === 'M' && event.name === 'thread_name') threadNames.set(key, event.args.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let main = null;
  for (const [key, name] of threadNames) {
    if (name !== 'CrRendererMain') continue;
    if (main === null || counts.get(key) > counts.get(main)) main = key;
  }
  if (main === null) throw new Error(`${file}: no CrRendererMain thread`);
  const onMain = (event) => `${event.pid}:${event.tid}` === main;
  const markTime = (name) =>
    events.find(
      (event) =>
        event.name === name &&
        (event.ph === 'R' ||
          event.ph === 'I' ||
          event.ph === 'n' ||
          event.ph === 'b' ||
          event.ph === 'X'),
    )?.ts ?? null;
  const startMark = markTime('e26-window-start');
  const endMark = markTime('e26-window-end');
  const mainEvents = events.filter(onMain);
  const times = mainEvents.filter((event) => typeof event.ts === 'number').map((event) => event.ts);
  const start = startMark ?? Math.min(...times);
  const end = endMark ?? Math.max(...times);
  const inside = (event) => event.ts >= start && event.ts < end;

  const totals = Object.fromEntries(NAMES.map((name) => [name, 0]));
  const counted = Object.fromEntries(NAMES.map((name) => [name, 0]));
  for (const event of mainEvents) {
    if (event.ph !== 'X' || !inside(event) || !(event.name in totals)) continue;
    totals[event.name] += (event.dur ?? 0) / 1000;
    counted[event.name] += 1;
  }

  // V8 CPU samples: the main thread's Profile event names a profile id and its start time; the
  // ProfileChunk events of that id (written from the profiler thread of the same process) carry
  // nodes, samples and time deltas, cumulative from the start time.
  const mainPid = main.split(':')[0];
  const clocks = new Map();
  for (const event of events) {
    if (event.name === 'Profile' && onMain(event))
      clocks.set(event.id, event.args?.data?.startTime ?? event.ts);
  }
  const nodes = new Map();
  const self = new Map();
  let sampled = 0;
  for (const event of events) {
    if (event.name !== 'ProfileChunk' || String(event.pid) !== mainPid || !clocks.has(event.id))
      continue;
    const data = event.args?.data;
    const profile = data?.cpuProfile;
    if (profile === undefined) continue;
    for (const node of profile.nodes ?? []) nodes.set(`${event.id}:${node.id}`, node);
    const deltas = data.timeDeltas ?? [];
    let time = clocks.get(event.id);
    (profile.samples ?? []).forEach((id, index) => {
      time += deltas[index] ?? 0;
      const next = deltas[index + 1] ?? 0;
      if (time < start || time >= end) return;
      const node = nodes.get(`${event.id}:${id}`);
      if (node === undefined) return;
      const frame = node.callFrame ?? {};
      const where = frame.url
        ? `${path.basename(frame.url)}:${frame.lineNumber}:${frame.columnNumber}`
        : '';
      const label = `${frame.functionName || '(anonymous)'} ${where}`.trim();
      self.set(label, (self.get(label) ?? 0) + next / 1000);
      sampled += 1;
    });
    clocks.set(event.id, time);
  }
  const topSelf = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([label, ms]) => ({ label, ms: Math.round(ms * 10) / 10 }));
  const windowMs = (end - start) / 1000;
  return {
    file: path.basename(file),
    windowMs: Math.round(windowMs),
    marked: startMark !== null && endMark !== null,
    totals: Object.fromEntries(
      Object.entries(totals).map(([name, ms]) => [
        name,
        { ms: Math.round(ms), count: counted[name] },
      ]),
    ),
    samples: sampled,
    topSelf,
  };
}

const results = args.map(summarize);
for (const result of results) {
  console.log(
    `\n## ${result.file} (window ${result.windowMs} ms${result.marked ? ', marked' : ', whole trace'})`,
  );
  for (const [name, { ms, count }] of Object.entries(result.totals)) {
    if (count > 0) console.log(`  ${name.padEnd(22)} ${String(ms).padStart(7)} ms  (${count})`);
  }
  console.log(`  top self time (${result.samples} samples):`);
  for (const { label, ms } of result.topSelf)
    console.log(`    ${String(ms).padStart(8)} ms  ${label}`);
}
if (jsonOut !== null) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
