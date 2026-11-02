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
import { PathMeshPipeline } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';
import { contentBounds, fittedCamera, loadScenarioDocument, panZoomCamera } from './scenarios.js';

const root = path.resolve(import.meta.dirname, '../..');
const wasm = path.join(
  root,
  '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
);
const dpr = Number(process.env.E30_DPR ?? 1);
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

it('E30: prepare at the fitted camera of the M1-A13 page', async () => {
  const module = await WebAssembly.compile(new Uint8Array(readFileSync(wasm)));
  const loaded = loadScenarioDocument('m1-a13');
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
  });
  const source = new PrimitiveSceneSource(
    mirror,
    new PathMeshPipeline({
      port: fill,
      memoryBytes: () => fill.linearMemoryBytes(),
      strokePort: stroke,
      strokeMemoryBytes: () => stroke.linearMemoryBytes(),
      fringeBuilder: buildPathFringe,
    }),
  );
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
  const timings: Record<string, number[]> = { first: [], still: [], edit: [], pan: [] };
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
    const started = performance.now();
    const packet = source.prepare(target);
    const elapsed = performance.now() - started;
    // A profiled kind's frames run under the sampler, so they are not timed.
    if (kind === 'first' || (index >= WARM_UP && process.env.E30_PROFILE !== kind)) {
      timings[kind]!.push(elapsed);
    }
    expect(packet).not.toBeNull();
    source.acknowledge(receiptOf(packet!));
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
  process.stdout.write(
    `${JSON.stringify({
      page: 'm1-a13',
      camera: 'fitted',
      devicePixelRatio: dpr,
      profiled: process.env.E30_PROFILE ?? null,
      firstMs: Math.round(timings.first![0]!),
      stillMedianMs: median(timings.still!),
      editMedianMs: median(timings.edit!),
      panMedianMs: median(timings.pan!),
      panP95Ms: rank(timings.pan!, 0.95),
      panMaxMs: rank(timings.pan!, 1),
    })}\n`,
  );
});
