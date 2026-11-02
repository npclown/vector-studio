// PA-U4c: one TSV row per memory record (`*--memory.json`).
// Usage: node pa-u4c-tsv.mjs <records directory> <out.tsv>
import fs from 'node:fs';
import path from 'node:path';

const [directory, out] = process.argv.slice(2);
if (!directory || !out) {
  console.error('usage: node pa-u4c-tsv.mjs <records directory> <out.tsv>');
  process.exit(2);
}
const categories = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];
const gcKeys = ['gcs', 'minor', 'major', 'unpaired', 'usedMismatch', 'usedDeltaMin', 'usedDeltaMax',
  'otherThreads', 'route2WithoutSlack', 'maxTotalAfter'];
const header = [
  'file', 'project', 'scenario', 'repetition', 'verdict', 'exactSumBytes', 'observedSumBytes',
  ...categories.flatMap((name) => [`${name}.bytes`, `${name}.status`]),
  ...gcKeys.map((key) => `gc.${key}`),
  'gpu.unknownFormats', 'gpu.querySets', 'gpu.externalTextures', 'gpu.textures', 'gpu.buffers',
  'gpu.peakBytes', 'canvas.max', 'canvas.reads', 'wasm.memories', 'wasm.bytes', 'idb.puts',
];
const rows = [header];
const files = fs.readdirSync(directory).filter((file) => file.endsWith('--memory.json')).sort();
for (const file of files) {
  const record = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
  const memory = record.memory ?? {};
  const ledger = memory.ledger ?? {};
  const gc = memory.gc ?? {};
  rows.push([
    file, record.project, record.scenario, record.repetition, memory.verdict,
    memory.exactSumBytes, memory.observedSumBytes,
    ...categories.flatMap((name) => [memory.categories?.[name]?.bytes, memory.categories?.[name]?.status]),
    ...gcKeys.map((key) => gc[key]),
    (ledger.gpu?.unknownFormats ?? []).join(',') || '-', ledger.gpu?.querySets,
    ledger.gpu?.externalTextures, ledger.gpu?.textures, ledger.gpu?.buffers, ledger.gpu?.peakBytes,
    `${ledger.canvas?.maxWidth}x${ledger.canvas?.maxHeight}`, ledger.canvas?.reads,
    ledger.wasm?.memories, ledger.wasm?.bytes, ledger.idb?.puts,
  ].map((value) => (value === undefined || value === null ? '' : String(value))));
}
fs.writeFileSync(out, `${rows.map((row) => row.join('\t')).join('\n')}\n`);
console.log(`wrote ${out}: ${files.length} rows`);
