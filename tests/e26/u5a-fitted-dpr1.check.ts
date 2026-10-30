// E26-U5a (E26 contract, section 4.4.1, baseline B3): the M1-A13 page at the fitted view (F) at
// DPR 1 prepares with the real geometry ports, as next-host configures the renderer, and its
// packet is accepted and acknowledged. Before U5a, `expectedRecords` threw "Map maximum size
// exceeded" here, because the fringe lists passed 2^24 per-record entries. The first prepare
// builds every fringe of the page (about a minute in a container), so it needs a large heap and
// is manual, never CI:
//
//   NODE_OPTIONS=--max-old-space-size=12000 pnpm check:e26-u5a
//
// It needs the release kernel that `pnpm test:geometry` builds at .tools/geometry-build.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';
import { contentBounds, fittedCamera, loadScenarioDocument } from './scenarios.js';

const root = path.resolve(import.meta.dirname, '../..');
const wasm = path.join(
  root,
  '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
);

it('E26-U5a: the M1-A13 page prepares at the fitted view at DPR 1 (baseline B3)', async () => {
  const module = await WebAssembly.compile(new Uint8Array(readFileSync(wasm)));
  const fill = await createFillMeshPort(module);
  const stroke = await createStrokeMeshPort(module);
  const service = new PrimitiveRendererService(
    { invalidate: () => undefined, setMode: () => undefined },
    {
      fillMesh: fill,
      fillMeshMemoryBytes: () => fill.linearMemoryBytes(),
      strokeMesh: stroke,
      strokeMeshMemoryBytes: () => stroke.linearMemoryBytes(),
      clips: 'all',
      paints: 'gradient',
      groups: 'isolated',
    },
  );
  const loaded = loadScenarioDocument('m1-a13');
  const nodes = [...loaded.projection.nodes.values()];
  const applied = service.replaceSnapshot({
    identity: { documentId: 'e26-u5a', pageId: loaded.pageId },
    revision: 1,
    nodes,
    rootOrder: loaded.projection.rootOrder,
  });
  expect(applied.status).toBe('applied');
  service.setCamera(fittedCamera(contentBounds(loaded.bounds)));
  const target = {
    generation: 1,
    surfaceRevision: 1,
    width: 1280,
    height: 720,
    devicePixelRatio: 1,
    sampleCount: 4,
    targetFormat: 'bgra8unorm',
  } as const;
  const started = performance.now();
  const packet = service.prepare(target);
  const prepareMs = performance.now() - started;
  expect(packet).not.toBeNull();
  const records = (resourceId: string) =>
    packet!
      .mesh!.writes.filter((write) => write.resourceId === resourceId)
      .reduce((sum, write) => sum + write.records.reduce((n, range) => n + range.count, 0), 0);
  // The list records the per-record protocol could not hold in one Map.
  expect(records('meshFeatureLists')).toBeGreaterThan(2 ** 24);
  service.acknowledge(receiptOf(packet!));
  const quiet = service.prepare(target)!;
  expect(quiet.mesh!.writes.filter((write) => write.resourceId !== 'meshFrame')).toEqual([]);
  console.log(
    JSON.stringify({
      prepareMs: Math.round(prepareMs),
      meshFeatureLists: records('meshFeatureLists'),
      ranges: packet!.mesh!.writes.reduce((sum, write) => sum + write.records.length, 0),
    }),
  );
  service.dispose();
}, 1_800_000);
