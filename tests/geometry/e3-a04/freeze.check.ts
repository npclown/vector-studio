// D9 E3 unit E3-U2: one shard of the oracle-only freeze check of the A04 corpus
// (docs/plans/d9-e3-b4-precision-contract.md section 5.5, E3-Q6 (a)). It runs no kernel, port or
// renderer: it certifies that the oracle can build the ideal boundary of every case within its
// work cap. Run it through `pnpm e3-a04:freeze` (tooling/run-e3-a04-freeze.mjs), never in CI.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
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

it(`freeze-checks shard ${shard} of ${shards} (stride ${stride})`, () => {
  if (out === undefined) throw new Error('E3_A04_FREEZE_OUT is required');
  mkdirSync(out, { recursive: true });
  const file = path.join(out, `shard-${shard}.ndjson`);
  let k = 0;
  let listed = 0;
  for (const kase of iterateA04Corpus()) {
    const index = k;
    k += 1;
    if (ids !== null) {
      if (!ids.has(String(kase.id))) continue;
      listed += 1;
      if ((listed - 1) % shards !== shard) continue;
    } else if (index % stride !== 0 || (index / stride) % shards !== shard) continue;
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
});
