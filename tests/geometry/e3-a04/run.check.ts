// D9 E3 unit E3-U3: the A04 measurement run, in three modes of one vitest file
// (docs/plans/d9-e3-b4-precision-contract.md sections 7.1 and 7.4). Manual, never CI: start it
// through `pnpm e3-a04:run` (tooling/run-e3-a04.mjs), which owns the freeze gate, the shards and
// the final record. The gate is checked again here, so that this file cannot be run on the corpus
// directly before the freeze note exists (section 5.5).
//
// Modes (E3_A04_RUN_MODE):
//   controls  runs the harness controls (E3-A5) and writes controls.json;
//   shard     measures a slice of the corpus with the release WASM ports (E3-A7 rows);
//   finalize  merges the slices, builds the evidence record, validates and writes it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkFreeze } from '../../../tooling/e3-a04-freeze-gate.mjs';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../../packages/geometry-wasm/src/index.js';
import { runControls } from './controls.js';
import { iterateA04Corpus, summarizeA04Corpus } from './corpus.js';
import { type CaseRow, measureCase } from './harness.js';
import {
  type ControlOutcome,
  type RecordRow,
  buildRecord,
  collectProvenance,
  metaOf,
  utcStamp,
  writeEvidenceRecord,
} from './record.js';
import { shaderIdentitySha256 } from './shader-model.js';

const root = process.cwd();
const mode = process.env.E3_A04_RUN_MODE ?? '';
const out = process.env.E3_A04_RUN_OUT ?? '';
const stride = Number(process.env.E3_A04_RUN_STRIDE ?? '1');

function gate() {
  const result = checkFreeze(root);
  if (!result.frozen)
    throw new Error(`refusing to run on a04-corpus/v1: ${result.problems.join('; ')}`);
  return result;
}

describe.skipIf(mode === '')('A04 run', () => {
  it.skipIf(mode !== 'controls')('runs the harness controls', () => {
    gate();
    mkdirSync(out, { recursive: true });
    const outcomes = runControls();
    writeFileSync(path.join(out, 'controls.json'), `${JSON.stringify(outcomes, null, 2)}\n`);
  });

  it.skipIf(mode !== 'shard')(
    'measures one shard of the corpus',
    async () => {
      gate();
      const [shard, shards] = (process.env.E3_A04_RUN_SHARD ?? '0/1').split('/').map(Number) as [
        number,
        number,
      ];
      const wasm = process.env.P2_WASM_PATH;
      if (wasm === undefined || !existsSync(wasm)) throw new Error('P2_WASM_PATH is required');
      const module = await WebAssembly.compile(new Uint8Array(await readFile(wasm)));
      const ports = {
        fill: await createFillMeshPort(module),
        stroke: await createStrokeMeshPort(module),
      };
      mkdirSync(out, { recursive: true });
      const file = path.join(out, `shard-${shard}.ndjson`);
      let index = -1;
      for (const kase of iterateA04Corpus()) {
        index += 1;
        if (index % stride !== 0 || (index / stride) % shards !== shard) continue;
        const meta = metaOf(kase, index);
        let row: CaseRow;
        try {
          row = measureCase(kase, ports);
        } catch (error) {
          // A harness fault is never dropped: it is an UNDECIDED case with its reason.
          row = faultRow(String(kase.id), error);
        }
        appendFileSync(file, `${JSON.stringify({ ...meta, ...row })}\n`);
      }
    },
    172_800_000,
  );

  it.skipIf(mode !== 'finalize')(
    'merges the shards into the evidence record',
    () => {
      const { freeze, manifest } = gate();
      if (freeze === null || manifest === null) throw new Error('no freeze note');
      const wasm = process.env.P2_WASM_PATH ?? null;
      const shards = Number(process.env.E3_A04_RUN_SHARDS ?? '1');
      const rows: RecordRow[] = [];
      for (let s = 0; s < shards; s += 1) {
        const file = path.join(out, `shard-${s}.ndjson`);
        if (!existsSync(file)) continue;
        for (const line of readFileSync(file, 'utf8').split('\n'))
          if (line.length > 0) rows.push(JSON.parse(line) as RecordRow);
      }
      const controls = JSON.parse(
        readFileSync(path.join(out, 'controls.json'), 'utf8'),
      ) as ControlOutcome[];
      // The corpus is regenerated in this run (E3-Q4) and must be the frozen one.
      const summary = summarizeA04Corpus();
      expect(summary.corpusSha256).toBe(freeze.corpusSha256);
      const provenance = collectProvenance(root, {
        wasmPath: wasm,
        operations: { fill: 'geometry-wasm/fill-v0+r2', stroke: 'geometry-wasm/stroke-v0+r4' },
        corpus: {
          version: manifest.version,
          corpusSha256: summary.corpusSha256,
          cases: summary.cases,
        },
        generatorSha256: freeze.generatorSha256,
        shaderIdentitySha256: shaderIdentitySha256(),
      });
      const finished = new Date();
      const startedUtc = process.env.E3_A04_RUN_STARTED ?? finished.toISOString();
      const record = buildRecord({
        run: {
          id: process.env.E3_A04_RUN_ID ?? `r${utcStamp(finished)}`,
          startedUtc,
          finishedUtc: finished.toISOString(),
          stride,
          shards,
          caseMilliseconds: rows.reduce((sum, r) => sum + r.ms, 0),
          wallMilliseconds: finished.getTime() - new Date(startedUtc).getTime(),
        },
        provenance,
        gpu: null,
        controls,
        rows,
      });
      const recordRoot = process.env.E3_A04_RECORD_ROOT ?? path.join(root, 'docs/evidence/e3-a04');
      const allowDirty = process.env.E3_A04_ALLOW_DIRTY === '1';
      const dir = writeEvidenceRecord(
        recordRoot,
        record,
        { cases: manifest.cases, counts: manifest.counts },
        finished,
        { allowDirty },
      );
      writeFileSync(path.join(out, 'record-path.txt'), `${dir}\n`);
    },
    7_200_000,
  );
});

function faultRow(id: string, error: unknown): CaseRow {
  return {
    id,
    status: 'undecided',
    reason: `harness fault: ${error instanceof Error ? error.message : String(error)}`,
    rejection: null,
    variant: null,
    bucket: null,
    servedExponent: null,
    vertices: 0,
    triangles: 0,
    eLo: null,
    eHi: null,
    betaVertex: 0,
    betaFeature: 0,
    betaC: 0,
    clip: { clipped: false, triangles: 0, crossings: 0, bound: 0 },
    noFlip: { ok: true, uncertain: 0 },
    u: null,
    l: null,
    tJunctions: 0,
    crackBound: null,
    storageCracks: null,
    resolution: null,
    work: null,
    windowPoint: null,
    ms: 0,
  };
}
