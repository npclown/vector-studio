// E30 (d9-e30-renderer-cost-contract.md, section 1.2): the container profile of
// `PrimitiveSceneSource.prepare` at the fitted camera F of the M1-A13 page, with the real geometry
// ports and every packet acknowledged. Three frame kinds after the first frame: no change
// (`still`), a one-leaf move (`edit`) and the E26 pan and zoom path (`pan`, 600 frames, one
// 10 s period at one 60 Hz callback per frame, so its zoom swings both ways). The first three
// frames of each kind are warm-up. Prints one JSON line. Manual, never CI; numbers are container
// observations, not evidence:
//
//   NODE_OPTIONS=--max-old-space-size=8000 pnpm check:e30
//
// E30_PAGE=m1-a13 (default) or m9-v2 picks the page; the v2 page's text runs through the E28
// test raster port (fixed-size fake bitmaps), so its text cost is the atlas plan's, not a font's.
// Each kind (and the first frame) also reports per-frame counters, as [median, max] over its
// timed frames: paths evaluated afresh by the path pipeline's per-path pass and paths served
// from a kept outcome; fill and stroke port calls (tessellation: one call per prepare whose
// cache lookups miss in the usual case, up to 32 when failed ranges split, so 0 means no path
// was tessellated); bucket computations, geometry builds, P1 record writes (the mesh packer's
// and text uploads are not counted), the bytes the packet's P1 and mesh writes carry (text
// uploads not counted; a still frame's must be 0, which shows every packet was acknowledged),
// and the packet's primitive and mesh draws and text glyph instances, the items each pass walks.
// Each packet is acknowledged with a receipt that has the text part the v2 page's packets carry
// (one backend page incarnation per atlas page index, kept while the page exists): without it the
// source refuses every receipt, and each frame re-sends every unacknowledged record.
// E30_DPR (default 1) sets the target's DPR at 1280 x 720 CSS. E30_PROFILE=still|edit|pan with
// E30_OUT=<file> also writes the top 30 self-time functions of that kind's sampled frames (V8
// sampling profiler at 100 us); those frames are then not timed. It needs the release kernel
// that `pnpm test:geometry` builds at .tools/geometry-build and a root `pnpm build`.
import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import { readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import { buildPathFringe } from '../../packages/renderer-core/src/path-fringe.js';
import {
  PathMeshPipeline,
  reusedPathsForTesting,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type {
  PrimitivePacket,
  PrimitiveReceipt,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { FakeRaster } from '../support/e28-text-harness.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';
import { contentBounds, fittedCamera, loadScenarioDocument, panZoomCamera } from './scenarios.js';

const root = path.resolve(import.meta.dirname, '../..');
const wasm = path.join(
  root,
  '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
);
const dpr = Number(process.env.E30_DPR ?? 1);
const page = process.env.E30_PAGE === 'm9-v2' ? 'm9-v2' : 'm1-a13';
const target = {
  generation: 1,
  surfaceRevision: 1,
  width: 1280 * dpr,
  height: 720 * dpr,
  devicePixelRatio: dpr,
  sampleCount: 4,
  targetFormat: 'bgra8unorm',
} as const;
const WARM_UP = 3;
const TIMED = 20;
/** One whole period of the pan and zoom path (E26_DRIVERS.thetaPeriodMs) at 16.7 ms steps. */
const PAN_TIMED = 600;
const KINDS = ['still', 'edit', 'pan'] as const;

/** Nearest rank (the lower middle for the median of an even count); null for an untimed kind. */
const rank = (values: readonly number[], q: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.round(sorted[index]! * 10) / 10;
};
const median = (values: readonly number[]) => rank(values, 0.5);

it('E30: prepare at the fitted camera of the profiled page', async () => {
  const module = await WebAssembly.compile(new Uint8Array(readFileSync(wasm)));
  const loaded = loadScenarioDocument(page);
  const nodes = [...loaded.projection.nodes.values()];
  const identity = { documentId: 'e30-profile', pageId: loaded.pageId };
  const fill = await createFillMeshPort(module);
  const stroke = await createStrokeMeshPort(module);
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: 'supported',
    pathStrokes: 'supported',
    dashes: 'supported',
    clips: 'supported',
    paints: 'gradient',
    groupOpacity: 'supported',
    textNodes: 'supported',
  });
  const pipeline = new PathMeshPipeline({
    port: fill,
    memoryBytes: () => fill.linearMemoryBytes(),
    strokePort: stroke,
    strokeMemoryBytes: () => stroke.linearMemoryBytes(),
    fringeBuilder: buildPathFringe,
  });
  const source = new PrimitiveSceneSource(mirror, pipeline, {
    text: { port: new FakeRaster() },
  });
  expect(
    mirror.replaceSnapshot({ identity, revision: 1, nodes, rootOrder: loaded.projection.rootOrder })
      .status,
  ).toBe('applied');
  const fitted = fittedCamera(contentBounds(loaded.bounds));
  const leaves = nodes.filter(
    (node): node is Exclude<RenderNodeSnapshot, { kind: 'container' }> =>
      node.kind === 'primitive' || node.kind === 'path',
  );
  let revision = 1;
  // The backend's atlas pages: one incarnation per page index, kept while the page exists.
  const pages: symbol[] = [];
  const receipt = (packet: PrimitivePacket): PrimitiveReceipt => {
    const base = receiptOf(packet);
    const part = packet.text;
    if (part === undefined) return base;
    while (pages.length < part.pageCount) pages.push(Symbol('page'));
    pages.length = part.pageCount;
    return {
      ...base,
      text: { pages: [...pages], clears: part.clears.length, uploads: part.uploads.length },
    };
  };
  const timings: Record<string, number[]> = { first: [], still: [], edit: [], pan: [] };
  const COUNTERS = [
    'fillPortCalls',
    'strokePortCalls',
    'bucketComputations',
    'geometryBuilds',
    'recordWrites',
    'writtenBytes',
    'pathsReused',
    'primitiveDraws',
    'meshDraws',
    'textDraws',
  ] as const;
  type Counter = (typeof COUNTERS)[number];
  const counts: Record<string, Record<Counter, number[]>> = {};
  const totals = () => {
    const mesh = source.getPathMeshStatistics();
    const prepared = source.getPreparationStatistics();
    return {
      fillPortCalls: mesh?.portCalls ?? 0,
      strokePortCalls: mesh?.strokePortCalls ?? 0,
      bucketComputations: mesh?.bucketComputations ?? 0,
      geometryBuilds: prepared.geometryBuilds,
      recordWrites: Object.values(prepared.recordWrites).reduce((sum, value) => sum + value, 0),
      pathsReused: reusedPathsForTesting(pipeline),
    };
  };
  const frame = (kind: 'first' | (typeof KINDS)[number], index: number) => {
    if (kind === 'edit') {
      const leaf = leaves[(index * 7919) % leaves.length]!;
      const [a, b, c, d, e, f] = leaf.transform;
      revision += 1;
      const result = mirror.applyChanges({
        identity,
        revision,
        baseRevision: revision - 1,
        inserted: [],
        updated: [{ ...leaf, transform: [a, b, c, d, e + 1, f] }],
        removed: [],
        orders: [],
      });
      expect(result.status).toBe('applied');
    }
    // The pan and zoom path at one 60 Hz callback per frame; the timed frames cover one period.
    mirror.setCamera(
      kind === 'pan' ? panZoomCamera(fitted, (index - WARM_UP) * (10_000 / PAN_TIMED)) : fitted,
    );
    const before = totals();
    const started = performance.now();
    const packet = source.prepare(target);
    const elapsed = performance.now() - started;
    const after = totals();
    // A profiled kind's frames run under the sampler, so they are not timed.
    if (kind === 'first' || (index >= WARM_UP && process.env.E30_PROFILE !== kind)) {
      timings[kind]!.push(elapsed);
    }
    expect(packet).not.toBeNull();
    // Counters are exact, so every timed-position frame counts, profiled or not.
    if (kind === 'first' || index >= WARM_UP) {
      const row = (counts[kind] ??= Object.fromEntries(
        COUNTERS.map((name) => [name, [] as number[]]),
      ) as Record<Counter, number[]>);
      for (const name of Object.keys(before) as (keyof typeof before)[]) {
        row[name].push(after[name] - before[name]);
      }
      row.primitiveDraws.push(packet!.draws.length);
      row.meshDraws.push(packet!.mesh?.draws.length ?? 0);
      row.textDraws.push((packet!.text?.instances.length ?? 0) / 16);
      row.writtenBytes.push(
        [...packet!.writes, ...(packet!.mesh?.writes ?? [])].reduce(
          (sum, write) => sum + write.bytes.byteLength,
          0,
        ),
      );
    }
    source.acknowledge(receipt(packet!));
  };
  frame('first', 0);
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 100 });
  for (const kind of KINDS) {
    for (let index = 0; index < WARM_UP; index += 1) frame(kind, index);
    const profiled = process.env.E30_PROFILE === kind;
    if (profiled) await session.post('Profiler.start');
    const count = kind === 'pan' ? PAN_TIMED : TIMED;
    for (let index = WARM_UP; index < WARM_UP + count; index += 1) frame(kind, index);
    if (!profiled) continue;
    const { profile } = await session.post('Profiler.stop');
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const self = new Map<string, number>();
    for (const id of profile.samples ?? []) {
      const { callFrame } = byId.get(id)!;
      const key = `${callFrame.functionName || '(anonymous)'} ${path.basename(callFrame.url)}`;
      self.set(key, (self.get(key) ?? 0) + 1);
    }
    const total = profile.samples?.length ?? 1;
    const top = [...self]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 30)
      .map(([key, count]) => `${((100 * count) / total).toFixed(1)}% ${key}`);
    if (process.env.E30_OUT !== undefined)
      writeFileSync(process.env.E30_OUT, `${top.join('\n')}\n`);
  }
  session.disconnect();
  // Paths evaluated afresh: the pipeline keeps a frame's outcomes only when every evaluable path
  // was kept, so a still frame reuses all of them; that count less a frame's reused paths is the
  // number its per-path pass evaluated afresh (the path set's size is the same in every kind).
  const evaluable = rank(counts.still!.pathsReused, 1)!;
  const afresh = (kind: string) => counts[kind]!.pathsReused.map((reused) => evaluable - reused);
  // The derivation holds only if every still frame took the whole-frame reuse.
  expect(rank(counts.still!.pathsReused, 0), 'every still frame reuses every path').toBe(evaluable);
  for (const kind of ['first', ...KINDS]) {
    expect(Math.min(...afresh(kind)), `${kind}: afresh paths`).toBeGreaterThanOrEqual(0);
  }
  // Every packet was acknowledged: a still frame writes nothing.
  expect(rank(counts.still!.writtenBytes, 1), 'a still frame writes no record').toBe(0);
  process.stdout.write(
    `${JSON.stringify({
      page,
      camera: 'fitted',
      devicePixelRatio: dpr,
      profiled: process.env.E30_PROFILE ?? null,
      firstMs: Math.round(timings.first![0]!),
      stillMedianMs: median(timings.still!),
      editMedianMs: median(timings.edit!),
      panMedianMs: median(timings.pan!),
      panP95Ms: rank(timings.pan!, 0.95),
      panMaxMs: rank(timings.pan!, 1),
      // Per frame, as [median, max]: text draws are glyph instances.
      counters: Object.fromEntries(
        ['first', ...KINDS].map((kind) => [
          kind,
          Object.fromEntries([
            ...COUNTERS.map((name) => [
              name,
              [rank(counts[kind]![name], 0.5), rank(counts[kind]![name], 1)],
            ]),
            ['pathsAfresh', [rank(afresh(kind), 0.5), rank(afresh(kind), 1)]],
          ]),
        ]),
      ),
    })}\n`,
  );
});
