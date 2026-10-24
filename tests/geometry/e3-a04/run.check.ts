// D9 E3 unit E3-U3: the A04 measurement run (docs/plans/d9-e3-b4-precision-contract.md section 7,
// executable form in section 15.8). One process runs one phase, set by E3_A04_RUN_PHASE:
//
//   shard     measures every case with index % stride = 0 whose rank lands on this shard,
//             through the release WASM ports, into shard-<i>.ndjson;
//   finalize  runs the controls, merges the shard rows, builds and validates the record and
//             writes record.json and record.md;
//   smoke     measures the smoke cases of section 15.6 and runs the controls, into smoke.json.
//
// Run it through `pnpm e3-a04:run` (tooling/run-e3-a04.mjs), never in CI. The tool refuses the
// shard and finalize phases until the freeze note of section 5.5 records this corpus.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';

import type { A04Case } from '../../../packages/geometry-reference/src/a04-region.js';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../../packages/geometry-wasm/src/index.js';
import { MESH_FILL_SHADER } from '../../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import { runHarnessControls } from './controls.js';
import { iterateA04Corpus } from './corpus.js';
import { measureCase, type HarnessPorts, type HarnessRow } from './harness.js';
import { buildRecord, renderRecordMarkdown, validateRecord, type GpuCheck } from './record.js';
import { SMOKE_CASES } from './smoke.js';

const phase = process.env.E3_A04_RUN_PHASE ?? 'smoke';
const out = process.env.E3_A04_RUN_OUT;
const [shard, shards] = (process.env.E3_A04_RUN_SHARD ?? '0/1').split('/').map(Number) as [
  number,
  number,
];
const stride = Number(process.env.E3_A04_RUN_STRIDE ?? '1');

/** JSON with non-finite numbers kept as strings ("Infinity"), since JSON has none. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v),
    2,
  )}\n`;
}

async function loadPorts() {
  const wasm = process.env.P2_WASM_PATH;
  if (wasm === undefined) throw new Error('P2_WASM_PATH is required');
  const module = await WebAssembly.compile(new Uint8Array(readFileSync(wasm)));
  return { fill: await createFillMeshPort(module), stroke: await createStrokeMeshPort(module) };
}

/** The joint partner (SB-10, SB-11): the other role of the same group, transform and camera. */
function jointKey(kase: A04Case, role: string): string {
  const k = kase;
  const joint = k.joint as Readonly<{ group: string }>;
  return JSON.stringify([joint.group, role, k.transform, k.camera, k.placement, k.servedOffset]);
}

function jointPartners(): Map<string, A04Case> {
  const partners = new Map<string, A04Case>();
  for (const kase of iterateA04Corpus()) {
    const joint = kase.joint as Readonly<{ role: string }> | null;
    if (joint != null) partners.set(jointKey(kase, joint.role), kase);
  }
  return partners;
}

function measureLogged(kase: A04Case, ports: HarnessPorts, partner?: A04Case): HarnessRow {
  try {
    return measureCase(kase, ports, partner === undefined ? {} : { partner });
  } catch (error) {
    // A harness exception is never a measurement: the case stays UNDECIDED (section 7.3).
    return {
      index: typeof kase.index === 'number' ? kase.index : null,
      id: String(kase.id),
      stratum: typeof kase.stratum === 'string' ? kase.stratum : null,
      transform: typeof kase.transform === 'string' ? kase.transform : null,
      pair: '-',
      paint: 'fill',
      status: 'undecided',
      reason: `harness-error: ${String(error)}`,
    } as HarnessRow;
  }
}

it(`runs the A04 ${phase} phase`, async () => {
  if (out === undefined) throw new Error('E3_A04_RUN_OUT is required');
  mkdirSync(out, { recursive: true });

  if (phase === 'smoke') {
    const ports = await loadPorts();
    const rows = SMOKE_CASES.map((s) => ({ expect: s.expect, row: measureLogged(s.kase, ports) }));
    const controls = runHarnessControls();
    writeFileSync(path.join(out, 'smoke.json'), toJson({ rows, controls }));
    return;
  }

  if (phase === 'shard') {
    const ports = await loadPorts();
    const partners = jointPartners();
    const file = path.join(out, `shard-${shard}.ndjson`);
    let index = 0;
    for (const kase of iterateA04Corpus()) {
      const i = index;
      index += 1;
      if (i % stride !== 0 || (i / stride) % shards !== shard) continue;
      const joint = kase.joint as Readonly<{ role: string }> | null;
      const partner =
        joint == null
          ? undefined
          : partners.get(jointKey(kase, joint.role === 'fill' ? 'stroke' : 'fill'));
      appendFileSync(file, `${JSON.stringify(measureLogged(kase, ports, partner))}\n`);
    }
    return;
  }

  if (phase !== 'finalize') throw new Error(`unknown phase ${phase}`);
  const corpusIds: string[] = [];
  for (const kase of iterateA04Corpus()) corpusIds.push(String(kase.id));
  const rows: HarnessRow[] = [];
  for (let i = 0; i < shards; i += 1) {
    const file = path.join(out, `shard-${i}.ndjson`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n'))
      if (line) rows.push(JSON.parse(line) as HarnessRow);
  }
  const base = JSON.parse(readFileSync(path.join(out, 'provenance.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const gpuPath = process.env.E3_A04_RUN_GPU;
  const gpu =
    gpuPath === undefined || gpuPath === ''
      ? null
      : (JSON.parse(readFileSync(gpuPath, 'utf8')) as GpuCheck);
  const ports = await loadPorts();
  const record = buildRecord({
    provenance: {
      ...(base as { commit: string; dirty: boolean; corpusSha256: string }),
      operationIds: [ports.fill.operationId, ports.stroke.operationId],
      shaderSha256: createHash('sha256').update(MESH_FILL_SHADER, 'utf8').digest('hex'),
      carrier: 'K4',
      builderPlacement: 'renderer-core buildPathFringe via PathMeshPipeline ports',
    },
    selection: { stride, shards, corpusCases: corpusIds.length },
    gpu,
    controls: runHarnessControls(),
    rows,
  });
  const problems = validateRecord(record, corpusIds);
  writeFileSync(path.join(out, 'record.json'), toJson({ ...record, validator: problems }));
  writeFileSync(path.join(out, 'record.md'), renderRecordMarkdown(record, problems));
});
