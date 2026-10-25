// D9 E3 unit E3-U2: one shard of the oracle-only freeze check of the A04 corpus
// (docs/plans/d9-e3-b4-precision-contract.md section 5.5, E3-Q6 (a)). It runs no kernel, port or
// renderer: it certifies that the oracle can build the ideal boundary of every case within its
// work cap. Run it through `pnpm e3-a04:freeze` (tooling/run-e3-a04-freeze.mjs), never in CI.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';

import { a04FreezeCheck } from '../../../packages/geometry-reference/src/a04-region.js';
import { iterateA04Corpus } from './corpus.js';

const [shard, shards] = (process.env.E3_A04_FREEZE_SHARD ?? '0/1').split('/').map(Number) as [
  number,
  number,
];
const stride = Number(process.env.E3_A04_FREEZE_STRIDE ?? '1');
const out = process.env.E3_A04_FREEZE_OUT;
// A partial run over listed case ids, one per line; the listed cases are dealt to the shards.
const idsFile = process.env.E3_A04_FREEZE_IDS;
const ids =
  idsFile === undefined
    ? null
    : new Set(
        readFileSync(idsFile, 'utf8')
          .split(/\r?\n/u)
          .map((l) => l.trim())
          .filter((l) => l !== ''),
      );

// After the worker died (a heap limit is not an exception), the tool restarts the shard after the
// case it was checking, given as "<corpus position>:<cause>"; that case is ORACLE-ERROR.
const resume = process.env.E3_A04_FREEZE_RESUME;
const resumeAt = resume === undefined ? -1 : Number(resume.slice(0, resume.indexOf(':')));

it(`freeze-checks shard ${shard} of ${shards} (stride ${stride})`, () => {
  if (out === undefined) throw new Error('E3_A04_FREEZE_OUT is required');
  mkdirSync(out, { recursive: true });
  const file = path.join(out, `shard-${shard}.ndjson`);
  let k = 0;
  let listed = 0;
  const found = new Set<string>();
  for (const kase of iterateA04Corpus()) {
    const index = k;
    k += 1;
    if (ids !== null) {
      if (!ids.has(String(kase.id))) continue;
      found.add(String(kase.id));
      listed += 1;
      if ((listed - 1) % shards !== shard) continue;
    } else if (index % stride !== 0 || (index / stride) % shards !== shard) continue;
    if (index < resumeAt) continue;
    if (index === resumeAt) {
      if (!lastRowIs(file, index)) {
        const detail = resume!.slice(resume!.indexOf(':') + 1);
        const line = {
          index,
          id: kase.id,
          stratum: kase.stratum,
          status: 'ORACLE-ERROR',
          detail,
          ms: 0,
        };
        appendFileSync(file, `${JSON.stringify(line)}\n`);
      }
      continue;
    }
    writeFileSync(path.join(out, `shard-${shard}.current`), `${index}\n`);
    const start = performance.now();
    let line: Record<string, unknown>;
    try {
      const r = a04FreezeCheck(kase);
      line = { index, stratum: kase.stratum, ...r, ms: Math.round(performance.now() - start) };
    } catch (error) {
      line = {
        index,
        id: kase.id,
        stratum: kase.stratum,
        status: 'ORACLE-ERROR',
        detail: String(error),
        ms: Math.round(performance.now() - start),
      };
    }
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  }
  // A listed id that is not a corpus case is an error, not a silent skip.
  const missing = ids === null ? [] : [...ids].filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`ids not in the corpus: ${missing.join(', ')}`);
});

/** Whether the shard file's last row is the case at `index` (written before the worker died). */
function lastRowIs(file: string, index: number): boolean {
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  const last = lines[lines.length - 1];
  return (
    last !== undefined && last !== '' && (JSON.parse(last) as { index: number }).index === index
  );
}
