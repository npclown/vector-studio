// PA-U4c trace investigation (docs/plans/pa-u4-a09-memory-method.md, section 4).
// Streams every raw memory trace (one JSON event per line) and answers the coordinator's
// questions 4a to 4e. Usage:
//   node pa-u4c-investigate.mjs <memory-traces directory> <out.json>
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [directory, out] = process.argv.slice(2);
if (!directory || !out) {
  console.error('usage: node pa-u4c-investigate.mjs <memory-traces directory> <out.json>');
  process.exit(2);
}

const NAME = /GC|Heap|cppgc|Oilpan|BlinkGC|Memory/u;
const ALLOCATOR = /^(v8|blink_gc|partition_alloc|malloc)/u;
const PEAK = /peak|max|committed/iu;
const SIZE_KEY = /used|allocated|committed|before|after/iu;
const CPPGC = /cppgc|Oilpan|BlinkGC|Blink\.GC|CppGC/iu;
const INCREMENTAL = /incremental|marking/iu;

/** Every key path in an args object, with "." between levels; arrays are not walked. */
function keyPaths(value, prefix = '', paths = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return paths;
  for (const [key, child] of Object.entries(value)) {
    const name = prefix === '' ? key : `${prefix}.${key}`;
    paths.push(name);
    keyPaths(child, name, paths);
  }
  return paths;
}

async function* events(file) {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const raw of lines) {
    let line = raw.trim();
    if (!line.startsWith('{') || line.startsWith('{"traceEvents"')) continue;
    if (line.endsWith(',')) line = line.slice(0, -1);
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && typeof event.name === 'string') yield event;
    } catch {
      // The trailing metadata object and any partial line are not events.
    }
  }
}

const names = new Map(); // name -> {count, ph: {ph: count}}
const dumps = { events: 0, files: 0, allocators: new Map() }; // allocator -> Set(attribute)
const sizeArgs = new Map(); // name -> Set(key path), cppgc-like names
const otherSizeArgs = new Map(); // name -> Set(key path), names matching NAME but not cppgc
const stringArgs = new Map(); // "name args.field" -> Set(key)
const peakMalloced = {}; // file -> main-thread maxima from V8.GC_Heap_Stats
const nonXGc = []; // MinorGC or MajorGC events whose ph is not X
const sizes = {};
const pairing = {};

const files = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort();
const pairingRuns = new Set(
  ['chrome-dpr1-v2', 'edge-dpr1-v2'].map((project) => `${project}--e26-simple-stress-10k_v2--r1--memory.json`),
);

for (const file of files) {
  const full = path.join(directory, file);
  sizes[file] = fs.statSync(full).size;
  let mainKey = null;
  const perRun = pairingRuns.has(file) ? [] : null;
  let fileHasDump = false;
  for await (const event of events(full)) {
    if (event.ph === 'M' && event.name === 'thread_name' && event.args?.name === 'CrRendererMain')
      mainKey = `${event.pid}:${event.tid}`;
    if (NAME.test(event.name)) {
      const entry = names.get(event.name) ?? { count: 0, ph: {} };
      entry.count += 1;
      entry.ph[event.ph] = (entry.ph[event.ph] ?? 0) + 1;
      names.set(event.name, entry);
      const keys = keyPaths(event.args ?? {}).filter((key) => SIZE_KEY.test(key.split('.').pop()));
      if (keys.length > 0) {
        const target = CPPGC.test(event.name) ? sizeArgs : otherSizeArgs;
        const set = target.get(event.name) ?? new Set();
        for (const key of keys) set.add(key);
        target.set(event.name, set);
      }
    } else if (CPPGC.test(JSON.stringify(event.args ?? {}).slice(0, 2000))) {
      const keys = keyPaths(event.args ?? {}).filter((key) => SIZE_KEY.test(key.split('.').pop()));
      if (keys.length > 0) {
        const set = sizeArgs.get(event.name) ?? new Set();
        for (const key of keys) set.add(key);
        sizeArgs.set(event.name, set);
      }
    }
    // Size fields serialized as a JSON string inside args (V8.GC_Heap_Stats `stats`,
    // V8.GCTraceGCNVP `value`): their keys, and the main thread's peak_malloced_memory.
    for (const field of ['stats', 'value']) {
      const raw = event.args?.[field];
      if (typeof raw !== 'string' || !raw.startsWith('{')) continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const set = stringArgs.get(`${event.name} args.${field}`) ?? new Set();
      for (const key of Object.keys(parsed)) set.add(key);
      for (const space of Array.isArray(parsed.spaces) ? parsed.spaces : [])
        for (const key of Object.keys(space)) set.add(`spaces[].${key}`);
      stringArgs.set(`${event.name} args.${field}`, set);
      if (event.name === 'V8.GC_Heap_Stats' && `${event.pid}:${event.tid}` === mainKey) {
        const peaks = peakMalloced[file] ?? { max: 0, samples: 0, maxMalloced: 0, maxPhysical: 0 };
        peaks.samples += 1;
        peaks.max = Math.max(peaks.max, parsed.peak_malloced_memory ?? 0);
        peaks.maxMalloced = Math.max(peaks.maxMalloced, parsed.malloced_memory ?? 0);
        peaks.maxPhysical = Math.max(peaks.maxPhysical, parsed.total_physical_size ?? 0);
        peakMalloced[file] = peaks;
      }
    }
    if (event.name === 'MajorGC' || event.name === 'MinorGC') {
      if (event.ph !== 'X') nonXGc.push({ file, name: event.name, ph: event.ph, args: event.args });
    }
    if (event.ph === 'v') {
      dumps.events += 1;
      fileHasDump = true;
      const allocators = event.args?.dumps?.allocators ?? {};
      for (const [name, value] of Object.entries(allocators)) {
        if (!ALLOCATOR.test(name)) continue;
        const set = dumps.allocators.get(name) ?? new Set();
        for (const attribute of Object.keys(value?.attrs ?? {})) set.add(attribute);
        dumps.allocators.set(name, set);
      }
    }
    if (perRun !== null && (event.name === 'MinorGC' || event.name === 'MajorGC' ||
        event.name === 'V8.GC_Heap_Stats' || (INCREMENTAL.test(event.name) && /GC|V8/u.test(event.name))))
      perRun.push({ name: event.name, ph: event.ph, ts: event.ts ?? 0, dur: event.dur ?? null,
        key: `${event.pid}:${event.tid}` });
  }
  if (fileHasDump) dumps.files += 1;
  if (perRun !== null) pairing[file] = analysePairing(perRun, mainKey);
}

function analysePairing(list, mainKey) {
  const main = list.filter((event) => event.key === mainKey).sort((a, b) => a.ts - b.ts);
  const byNamePh = {};
  for (const event of main) byNamePh[`${event.name} ph=${event.ph}`] = (byNamePh[`${event.name} ph=${event.ph}`] ?? 0) + 1;
  const gcs = main.filter((event) => (event.name === 'MinorGC' || event.name === 'MajorGC') && event.ph === 'X');
  // Stats events per GC: those after this GC's start and before the next GC's start.
  const statsPerGc = { 0: 0, 1: 0, more: 0 };
  const statsInsideSpan = { inside: 0, after: 0 };
  let statsBeforeFirstGc = 0;
  const statsEvents = main.filter((event) => event.name === 'V8.GC_Heap_Stats');
  for (const stats of statsEvents) if (gcs.length === 0 || stats.ts < gcs[0].ts) statsBeforeFirstGc += 1;
  for (let index = 0; index < gcs.length; index += 1) {
    const gc = gcs[index];
    const next = gcs[index + 1]?.ts ?? Infinity;
    const own = statsEvents.filter((stats) => stats.ts >= gc.ts && stats.ts < next);
    if (own.length === 0) statsPerGc[0] += 1;
    else if (own.length === 1) statsPerGc[1] += 1;
    else statsPerGc.more += 1;
    for (const stats of own) {
      if (gc.dur !== null && stats.ts <= gc.ts + gc.dur) statsInsideSpan.inside += 1;
      else statsInsideSpan.after += 1;
    }
  }
  // Incremental marking: events outside every MajorGC span, before a later MajorGC.
  const majors = gcs.filter((gc) => gc.name === 'MajorGC');
  const incremental = main.filter((event) => INCREMENTAL.test(event.name));
  let insideMajor = 0;
  let outsideMajor = 0;
  const incrementalNames = {};
  for (const event of incremental) {
    incrementalNames[event.name] = (incrementalNames[event.name] ?? 0) + 1;
    const inside = majors.some((gc) => gc.dur !== null && event.ts >= gc.ts && event.ts <= gc.ts + gc.dur);
    if (inside) insideMajor += 1;
    else outsideMajor += 1;
  }
  const otherThreadGcs = list.filter((event) => event.key !== mainKey &&
    (event.name === 'MinorGC' || event.name === 'MajorGC')).length;
  return {
    mainThread: mainKey,
    byNamePh,
    gcs: gcs.length,
    majors: majors.length,
    statsEvents: statsEvents.length,
    statsBeforeFirstGc,
    statsPerGc,
    statsInsideSpan,
    incrementalNames,
    incrementalInsideMajorSpan: insideMajor,
    incrementalOutsideMajorSpan: outsideMajor,
    otherThreadGcs,
  };
}

const sortedNames = Object.fromEntries([...names].sort((a, b) => b[1].count - a[1].count));
const toObject = (map) => Object.fromEntries([...map].sort().map(([key, set]) => [key, [...set].sort()]));
const allocators = toObject(dumps.allocators);
const v8Peak = Object.fromEntries(Object.entries(allocators).filter(([name]) => name.startsWith('v8'))
  .map(([name, attributes]) => [name, attributes.filter((attribute) => PEAK.test(attribute))])
  .filter(([, attributes]) => attributes.length > 0));
const report = {
  files: files.length,
  a_names: sortedNames,
  b_memoryDumps: { events: dumps.events, filesWithDumps: dumps.files, allocators, v8PeakLikeAttributes: v8Peak },
  c_cppgcSizeArgs: toObject(sizeArgs),
  c_otherGcSizeArgs: toObject(otherSizeArgs),
  c_stringifiedSizeArgs: toObject(stringArgs),
  c_mainThreadHeapStatsMaxima: peakMalloced,
  d_nonXGcEvents: nonXGc,
  d_pairing: pairing,
  e_sizes: sizes,
};
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${out}: ${files.length} traces, ${dumps.events} dump events`);
