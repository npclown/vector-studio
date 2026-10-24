// D9 E11 unit E11-U2: one sweep phase per process, set by P3_EXIT_SWEEP_PHASE:
//
//   scene   the seeded stress scene (1,000 paths × 32 cubics), fill and stroke;
//   corpus  every distinct fill and stroke request of a04-corpus/v1, after its freeze only.
//
// Run it through `pnpm p3-exit:sweep` (tooling/run-p3-exit-sweep.mjs), never in CI. The tool
// refuses the corpus phase until the E3 contract holds the corpus freeze record (E3 section
// 5.5 forbids reading kernel output on the corpus before it).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';

import type { A04Case } from '../../../packages/geometry-reference/src/a04-region.js';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../../packages/geometry-wasm/src/index.js';
import {
  computePathBuckets,
  E_MAX,
  E_MIN,
  STROKE_E_MIN,
} from '../../../packages/renderer-core/src/path-buckets.js';
import { iterateA04Corpus } from '../e3-a04/corpus.js';
import { decodeCase } from '../e3-a04/harness.js';
import { fillRequest, STRESS_SCENE_VERSION, stressScene, strokeRequest } from './scene.js';
import { runSeededControls, runSweep, type SweepItem } from './sweep.js';

const phase = process.env.P3_EXIT_SWEEP_PHASE ?? 'scene';
const out = process.env.P3_EXIT_SWEEP_OUT;

function sceneItems(): SweepItem[] {
  const paths = stressScene();
  return [
    ...paths.map((p): SweepItem => {
      const { requestId, ...request } = fillRequest(p, 0);
      void requestId;
      return { id: `${STRESS_SCENE_VERSION}/fill/${p.index}`, kind: 'fill', request };
    }),
    ...paths.map((p): SweepItem => {
      const { requestId, ...request } = strokeRequest(p, 0);
      void requestId;
      return { id: `${STRESS_SCENE_VERSION}/stroke/${p.index}`, kind: 'stroke', request };
    }),
  ];
}

const VERB_CODE = { move: 0, line: 1, cubic: 2, close: 3 } as const;

/** Distinct port requests of the corpus: a case's request depends only on its path, paint and
 *  bucket, so cases differing only in camera or placement share one. */
function corpusItems(): { items: SweepItem[]; cases: number; state: Record<string, number> } {
  // The same freeze gate as the tool, so a direct vitest run cannot bypass it.
  const manifest = JSON.parse(
    readFileSync('tests/geometry/e3-a04/corpus-v1.manifest.json', 'utf8'),
  ) as { corpusSha256: string };
  const frozen = readFileSync('docs/plans/d9-e3-b4-precision-contract.md', 'utf8')
    .split('\n')
    .some((line) => line.includes('**Freeze record**') && line.includes(manifest.corpusSha256));
  if (!frozen) throw new Error('corpus phase refused: no E3 freeze record (E3 section 5.5)');
  const seen = new Set<string>();
  const items: SweepItem[] = [];
  const state: Record<string, number> = {};
  let cases = 0;
  for (const kase of iterateA04Corpus() as Iterable<A04Case>) {
    cases += 1;
    const d = decodeCase(kase);
    const [a, c, b, dd] = d.transform;
    const buckets = computePathBuckets([a, b, c, dd], d.zoom, d.dpr);
    if (buckets.singular) {
      state.singular = (state.singular ?? 0) + 1;
      continue;
    }
    const e = buckets.e - d.servedOffset;
    const min = d.paint === 'fill' ? E_MIN : STROKE_E_MIN;
    if (e < min || e > E_MAX) {
      state['tolerance-range'] = (state['tolerance-range'] ?? 0) + 1;
      continue;
    }
    const verbs = Uint8Array.from(d.verbs.map((v) => VERB_CODE[v]));
    const points = Float64Array.from(d.points);
    const key = JSON.stringify([d.paint, d.verbs, d.points, d.fillRule, d.stroke, e]);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(
      d.paint === 'fill'
        ? {
            id: d.id,
            kind: 'fill',
            request: { verbs, points, fillRule: d.fillRule, toleranceExponent: e },
          }
        : {
            id: d.id,
            kind: 'stroke',
            request: {
              verbs,
              points,
              width: d.stroke!.width,
              cap: d.stroke!.cap as 'butt' | 'round' | 'square',
              join: d.stroke!.join as 'miter' | 'round' | 'bevel',
              miterLimit: d.stroke!.miterLimit,
              toleranceExponent: e,
            },
          },
    );
  }
  // Fill first, then stroke, so batches are long.
  items.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'fill' ? -1 : 1));
  return { items, cases, state };
}

it(
  `p3-exit sweep, phase ${phase}`,
  async () => {
    if (out === undefined) throw new Error('P3_EXIT_SWEEP_OUT is required');
    const wasm = process.env.P2_WASM_PATH;
    if (wasm === undefined) throw new Error('P2_WASM_PATH is required');
    const module = await WebAssembly.compile(new Uint8Array(readFileSync(wasm)));
    const ports = {
      fill: await createFillMeshPort(module),
      stroke: await createStrokeMeshPort(module),
    };
    const source =
      phase === 'corpus'
        ? corpusItems()
        : { items: sceneItems(), cases: null, state: {} as Record<string, number> };
    const result = runSweep(ports, source.items, {
      batchSize: Number(process.env.P3_EXIT_SWEEP_BATCH ?? '32'),
    });

    // Controls on a real mesh of each kind: the first ok mesh with two or more triangles.
    const controls: Record<string, unknown> = {};
    const rejected = new Set(result.rejected.map((r) => r.id));
    for (const item of source.items) {
      if (item.kind in controls || rejected.has(item.id)) continue;
      const built =
        item.kind === 'fill'
          ? ports.fill.buildFillMeshes([{ ...item.request, requestId: 0 }])
          : ports.stroke.buildStrokeMeshes([{ ...item.request, requestId: 0 }]);
      if (built.status !== 'ok' || built.results[0]?.status !== 'ok') continue;
      const mesh = built.results[0].mesh;
      if (mesh.indices.length >= 6)
        controls[item.kind] = { base: item.id, results: runSeededControls(mesh) };
    }
    // Scene only: the largest device-pixel radius of each path (largest distance of any point
    // from the origin × zoom × DPR), so the size table of the evidence can be rebuilt.
    const sceneSizes =
      phase === 'scene'
        ? stressScene().map((p) => {
            let r = 0;
            for (let i = 0; i < p.points.length; i += 2)
              r = Math.max(r, Math.hypot(p.points[i]!, p.points[i + 1]!));
            return {
              index: p.index,
              looping: p.index % 4 === 3,
              devicePixelRadius: r * p.zoom * p.dpr,
            };
          })
        : null;
    const record = {
      schema: 'p3-exit-sweep/v1',
      phase,
      operationIds: { fill: ports.fill.operationId, stroke: ports.stroke.operationId },
      corpusCases: source.cases,
      skippedByState: source.state,
      requests: source.items.length,
      controls,
      sceneSizes,
      ...result,
    };
    writeFileSync(path.join(out, `${phase}.json`), `${JSON.stringify(record, null, 2)}\n`);
  },
  24 * 3600 * 1000,
);
