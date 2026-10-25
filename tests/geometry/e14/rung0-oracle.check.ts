// D9 E14-U1, E14-A3 (docs/plans/d9-e14-fill-rung0-edge-cap-contract.md, section 8): SL-O2
// (tests/geometry/p3-fill-ladder/oracle.ts, independent region and mesh validity, with the
// edges-used-once check and the export-equals-module check) on every rung-0 mesh, and AL-FR9
// (no `MESH_CHECK` fallback over E). The input is E14-F2 to E14-F4 and every path of the stress
// scene `p3-exit-stress/v1`; the hand-off is
// `fill_ladder_dump_tests::emit_fill_ladder_dump_production` (release, production caps).
// SL-O1 is not part of A3 and its exact certificate costs about three times SL-O2 here, so it is
// not run. SL-O3 needs an exact-rung mesh, which no path over E has. The `triangle-mesh` oracle
// throws above 256 vertices or triangles; that one issue is counted, not failed, on meshes over
// its cap, because SL-O2 items 1 to 4 imply each of its checks (evidence, departures). Manual,
// never CI:
//
//   pnpm e14:rung0-oracle
//
// Writes .tools/e14-rung0-oracle/<stamp>/{input.bin,dump.txt,summary-<i>-of-<n>.json}.
// E14_ORACLE_DUMP=<dump.txt> reuses a dump; E14_ORACLE_SHARD=i/n evaluates one shard;
// E14_ORACLE_EDGES=<min>-<max> evaluates only meshes with that many flat edges.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { encodeDumpInput, type DumpInput } from '../p3-fill-ladder/corpus.js';
import { parseLadderDump } from '../p3-fill-ladder/dump.js';
import { fastOutput, verifyBoundaryEdges } from '../p3-fill-ladder/oracle.js';
import { verifyRegionMesh } from '../p3-b0-spike/oracle.js';
import { stressScene } from '../p3-exit-sweep/scene.js';

const E = 256;
const KAPPA = 0.5522847498;
type Cubic = number[];

function quarters(r: number): Cubic[] {
  const k = r * KAPPA;
  return [
    [r, 0, r, k, k, r, 0, r],
    [0, r, -k, r, -r, k, -r, 0],
    [-r, 0, -r, -k, -k, -r, 0, -r],
    [0, -r, k, -r, r, -k, r, 0],
  ];
}

function halves(c: Cubic): [Cubic, Cubic] {
  const mid = (a: number, b: number) => (a + b) * 0.5;
  const p01 = [mid(c[0]!, c[2]!), mid(c[1]!, c[3]!)];
  const p12 = [mid(c[2]!, c[4]!), mid(c[3]!, c[5]!)];
  const p23 = [mid(c[4]!, c[6]!), mid(c[5]!, c[7]!)];
  const p012 = [mid(p01[0]!, p12[0]!), mid(p01[1]!, p12[1]!)];
  const p123 = [mid(p12[0]!, p23[0]!), mid(p12[1]!, p23[1]!)];
  const m = [mid(p012[0]!, p123[0]!), mid(p012[1]!, p123[1]!)];
  return [
    [c[0]!, c[1]!, ...p01, ...p012, ...m],
    [...m, ...p123, ...p23, c[6]!, c[7]!],
  ];
}

function cubicPath(name: string, cubics: Cubic[]): DumpInput {
  return {
    name,
    kind: 'path',
    rule: 0,
    exponent: -3,
    verbs: [0, ...cubics.map(() => 2), 3],
    points: [cubics[0]![0]!, cubics[0]![1]!, ...cubics.flatMap((c) => c.slice(2))],
  };
}

test('E14-A3: SL-O2 and AL-FR9 on rung 0', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const rustup = process.env.P2_NATIVE_RUSTUP;
  expect(rustup, 'P2_NATIVE_RUSTUP selects the pinned toolchain').toBeTruthy();
  const dir = path.join(
    root,
    '.tools',
    'e14-rung0-oracle',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  mkdirSync(dir, { recursive: true });
  let f4 = quarters(1_048_576);
  for (let level = 0; level < 4; level += 1) f4 = f4.flatMap(halves);
  const inputs: DumpInput[] = [
    cubicPath('E14-F2', quarters(2_048)),
    cubicPath('E14-F3', quarters(32_768)),
    cubicPath('E14-F4', f4),
    ...stressScene().map((item): DumpInput => ({
      name: `scene/${item.index}`,
      kind: 'path',
      rule: item.fillRule === 'evenodd' ? 1 : 0,
      exponent: item.toleranceExponent,
      verbs: Array.from(item.verbs),
      points: Array.from(item.points),
    })),
  ];
  const reuse = process.env.E14_ORACLE_DUMP;
  const output = reuse ?? path.join(dir, 'dump.txt');
  if (reuse === undefined) {
    const input = path.join(dir, 'input.bin');
    writeFileSync(input, encodeDumpInput(inputs));
    const result = spawnSync(
      rustup!,
      [
        'run',
        '1.94.1',
        'cargo',
        'test',
        '--manifest-path',
        path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml'),
        '--release',
        '--lib',
        'fill_ladder_dump_tests::emit_fill_ladder_dump_production',
        '--',
        '--ignored',
        '--exact',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, P3_FILL_LADDER_INPUT: input, P3_FILL_LADDER_DUMP: output },
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  const dump = parseLadderDump(readFileSync(output, 'utf8'));
  expect(dump.entries).toHaveLength(inputs.length);
  const [shard, shards] = (process.env.E14_ORACLE_SHARD ?? '0/1').split('/').map(Number);
  const summary = {
    entries: dump.entries.length,
    edges: process.env.E14_ORACLE_EDGES ?? 'all',
    fast: 0,
    fastOverE: 0,
    shard: `${shard}/${shards}`,
    fallbackOverE: {} as Record<string, number>,
    checkedSlO2: 0,
    overInspectorCap: 0,
    maxEdges: 0,
    maxTriangles: 0,
    failures: [] as string[],
  };
  // E14_ORACLE_SHARD=i/n evaluates every n-th mesh, ordered by edge count.
  const edgesOf = (entry: (typeof dump.entries)[number]) =>
    entry.view?.owners.length ?? Number.POSITIVE_INFINITY;
  const [low, high] = (process.env.E14_ORACLE_EDGES ?? '0-Infinity').split('-').map(Number);
  const selected = dump.entries
    .filter((entry) => entry.rung === 'fast' && edgesOf(entry) >= low! && edgesOf(entry) <= high!)
    .sort((a, b) => edgesOf(a) - edgesOf(b))
    .filter((_, index) => index % shards! === shard);
  for (const entry of dump.entries)
    if (entry.rung !== 'fast' && edgesOf(entry) > E) {
      const reason = entry.reason ?? 'none';
      summary.fallbackOverE[reason] = (summary.fallbackOverE[reason] ?? 0) + 1;
    }
  const INSPECTOR_CAP = 256;
  const CAP_ISSUES = [
    'inspectTriangleMesh: threw too many vertices',
    'inspectTriangleMesh: threw too many triangles',
  ];
  for (const entry of selected) {
    const started = Date.now();
    const output = fastOutput(entry, dump.revision);
    summary.fast += 1;
    if (edgesOf(entry) > E) summary.fastOverE += 1;
    summary.maxEdges = Math.max(summary.maxEdges, edgesOf(entry));
    if (entry.view === null || output === null) {
      summary.failures.push(
        `${entry.name}: SL-O2: fast entry without a view or a published output`,
      );
      continue;
    }
    const { mesh } = output;
    summary.maxTriangles = Math.max(summary.maxTriangles, mesh.triangles.length);
    const overCap = mesh.vertices.length > INSPECTOR_CAP || mesh.triangles.length > INSPECTOR_CAP;
    const region = verifyRegionMesh(entry.view, entry.rule, mesh);
    summary.checkedSlO2 += 1;
    let capped = false;
    for (const issue of region.issues) {
      if (overCap && CAP_ISSUES.includes(issue)) capped = true;
      else summary.failures.push(`${entry.name}: SL-O2: ${issue}`);
    }
    if (capped) summary.overInspectorCap += 1;
    for (const issue of verifyBoundaryEdges(mesh.triangles, output.boundaryEdges))
      summary.failures.push(`${entry.name}: SL-O2: ${issue}`);
    if (
      JSON.stringify([mesh, output.boundaryEdges]) !==
      JSON.stringify([entry.fastMesh, entry.boundaryEdges])
    )
      summary.failures.push(`${entry.name}: SL-O2: the export output differs from the module mesh`);
    appendFileSync(
      path.join(dir, `progress-${shard}-of-${shards}.txt`),
      `${entry.name}: ${edgesOf(entry)} edges, ${mesh.triangles.length} triangles, ` +
        `${region.issues.length} issues, ${Date.now() - started} ms\n`,
    );
  }
  writeFileSync(
    path.join(dir, `summary-${shard}-of-${shards}.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary, null, 2), `\n${dir}`);
  expect(summary.failures).toEqual([]);
  expect(summary.fallbackOverE.MESH_CHECK ?? 0).toBe(0);
  expect(summary.fast).toBeGreaterThan(0);
});
