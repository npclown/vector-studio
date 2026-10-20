// Classifies every case of a `compare-p3-fill-identity` run by how its status changed
// between base and branch. The identity tool's plain mode only reports that digests
// differ; this script re-derives the B1 review manifest from the run's dumps.
//
// Usage: node tooling/classify-p3-fill-identity-statuses.mjs <run-dir>
//
// A dump row is `name \t digest \t … \t status \t extra`. A status is `ok` when the
// cascade reports `path_status=0` or an attempt reports `OK`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tooling/classify-p3-fill-identity-statuses.mjs <run-dir>');
  process.exit(2);
}

const load = (file) =>
  new Map(
    readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const cells = line.split('\t');
        return [cells[0], { digest: cells[1], status: cells[3], extra: cells[4] }];
      }),
  );

const isOk = (status) => status === 'OK' || status === 'path_status=0';

const classify = (base, branch) => {
  if (base.digest === branch.digest) return 'unchanged';
  if (isOk(base.status) && isOk(branch.status)) return 'ok->changed';
  if (isOk(base.status)) return 'ok->failure';
  if (isOk(branch.status)) return 'failure->ok';
  if (base.status === branch.status && base.extra === branch.extra) {
    return 'failure->same-failure';
  }
  return 'failure->different-failure';
};

const compare = (baseFile, branchFile, kindOf) => {
  const base = load(baseFile);
  const branch = load(branchFile);
  const counts = {};
  const transitions = {};
  let missing = 0;
  for (const [name, row] of base) {
    if (name.startsWith('meta/')) continue;
    const other = branch.get(name);
    if (!other) {
      missing += 1;
      continue;
    }
    const kind = kindOf(name);
    const cls = classify(row, other);
    counts[kind] ??= {};
    counts[kind][cls] = (counts[kind][cls] ?? 0) + 1;
    if (cls === 'failure->different-failure' || cls === 'failure->ok' || cls.startsWith('ok->')) {
      const key = `${kind} ${cls} ${row.status}|${row.extra} -> ${other.status}|${other.extra}`;
      transitions[key] = (transitions[key] ?? 0) + 1;
    }
  }
  const extra = [...branch.keys()].filter((name) => !base.has(name)).length;
  return { missing, extra, counts, transitions };
};

const native = compare('native-base.tsv', 'native-branch.tsv', (name) =>
  name.endsWith('/fill_v0_cascade') ? 'cascade' : 'attempt',
);
const wasm = compare('wasm-base.tsv', 'wasm-branch.tsv', () => 'wasm');

console.log(JSON.stringify({ native, wasm }, null, 1));
// Attempt rows hash `allocated_bytes()`, which a cap change alters by design, so only the
// published layers (the native cascade and the WASM output) gate.
const regressed = (c = {}) => (c['ok->changed'] ?? 0) + (c['ok->failure'] ?? 0) > 0;
const regressions = regressed(native.counts.cascade) || regressed(wasm.counts.wasm);
process.exit(regressions ? 1 : 0);
