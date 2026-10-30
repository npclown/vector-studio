// E26-U5c (E26 contract, section 4.4.1): the container profile of prepare on the M1-A13 page and
// the stress page at the typical view at DPR 2, with the real geometry ports and every packet
// acknowledged, and the twin-source differential on the same pages. Each page runs on a source
// with U5c's kept state and on a twin on the pre-U5c path (`useFullDerivationForTesting`); both
// get the same frames (no change, one-leaf edits, pans) and must produce identical packets. The
// timings of both are printed as one JSON line per page. Manual, never CI:
//
//   NODE_OPTIONS=--max-old-space-size=8000 pnpm check:e26-u5c
//
// It needs the release kernel that `pnpm test:geometry` builds at .tools/geometry-build.
import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import { buildPathFringe } from '../../packages/renderer-core/src/path-fringe.js';
import { PathMeshPipeline } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type { PrimitivePacket } from '../../packages/renderer-core/src/primitive-packet.js';
import {
  PrimitiveSceneSource,
  derivationCountsForTesting,
  useFullDerivationForTesting,
} from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';
import { loadScenarioDocument, typicalCamera } from './scenarios.js';

const root = path.resolve(import.meta.dirname, '../..');
const wasm = path.join(
  root,
  '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
);
const target = {
  generation: 1,
  surfaceRevision: 1,
  width: 2560,
  height: 1440,
  devicePixelRatio: 2,
  sampleCount: 4,
  targetFormat: 'bgra8unorm',
} as const;
/** Frames of each kind; the first two of each kind are warm-up and not timed. */
const FRAMES = 12;

/** A packet as plain data: symbols numbered by first appearance in this source's packets. */
function normalizer() {
  const symbols = new Map<symbol, number>();
  const walk = (value: unknown): unknown => {
    if (typeof value === 'symbol') {
      if (!symbols.has(value)) symbols.set(value, symbols.size);
      return `#${symbols.get(value)}`;
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return `${value.constructor.name}:${Buffer.from(bytes).toString('hex')}`;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
    }
    return value;
  };
  return (packet: PrimitivePacket | null) => JSON.stringify(walk(packet));
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]! * 100) / 100;
};

it('E26-U5c: profile and twin differential on the M1-A13 and stress pages', async () => {
  const module = await WebAssembly.compile(new Uint8Array(readFileSync(wasm)));
  for (const page of ['m1-a13', 'stress'] as const) {
    const loaded = loadScenarioDocument(page);
    const nodes = [...loaded.projection.nodes.values()];
    const identity = { documentId: `e26-u5c-${page}`, pageId: loaded.pageId };
    const twins: {
      mirror: RetainedSceneMirror;
      source: PrimitiveSceneSource;
      normalize: (packet: PrimitivePacket | null) => string;
    }[] = [];
    for (const full of [false, true]) {
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
      if (full) useFullDerivationForTesting(source);
      expect(
        mirror.replaceSnapshot({
          identity,
          revision: 1,
          nodes,
          rootOrder: loaded.projection.rootOrder,
        }).status,
      ).toBe('applied');
      twins.push({ mirror, source, normalize: normalizer() });
    }
    const camera = typicalCamera(loaded.bounds);
    const leaves = nodes.filter(
      (node): node is Exclude<RenderNodeSnapshot, { kind: 'container' }> =>
        node.kind === 'primitive' || node.kind === 'path',
    );
    let revision = 1;
    const timings: Record<string, number[]> = { first: [], still: [], edit: [], pan: [] };
    const oracle: Record<string, number[]> = { first: [], still: [], edit: [], pan: [] };
    const frame = (kind: keyof typeof timings, index: number) => {
      if (kind === 'edit') {
        const leaf = leaves[(index * 7919) % leaves.length]!;
        const [a, b, c, d, e, f] = leaf.transform;
        const moved: RenderNodeSnapshot = { ...leaf, transform: [a, b, c, d, e + 1, f] };
        revision += 1;
        for (const { mirror } of twins) {
          const result = mirror.applyChanges({
            identity,
            revision,
            baseRevision: revision - 1,
            inserted: [],
            updated: [moved],
            removed: [],
            orders: [],
          });
          expect(result.status).toBe('applied');
        }
      }
      const pan = kind === 'pan' ? (index * 4) / camera.zoom : 0;
      const packets = twins.map(({ mirror, source }, twin) => {
        mirror.setCamera({
          position: { x: camera.position.x + pan, y: camera.position.y },
          zoom: camera.zoom,
        });
        const started = performance.now();
        const packet = source.prepare(target);
        if (kind === 'first' || index >= 2) {
          (twin === 0 ? timings : oracle)[kind]!.push(performance.now() - started);
        }
        return packet;
      });
      expect(twins[0]!.normalize(packets[0]!)).toBe(twins[1]!.normalize(packets[1]!));
      twins.forEach(({ source }, twin) => source.acknowledge(receiptOf(packets[twin]!)));
    };
    frame('first', 0);
    for (const kind of ['still', 'edit', 'pan'] as const) {
      for (let index = 0; index < FRAMES; index += 1) frame(kind, index);
    }
    process.stdout.write(
      `${JSON.stringify({
        page,
        firstMs: Math.round(timings.first![0]!),
        noChangeMedianMs: median(timings.still!),
        oneLeafEditMedianMs: median(timings.edit!),
        panMedianMs: median(timings.pan!),
        preU5cMedianMs: {
          noChange: median(oracle.still!),
          oneLeafEdit: median(oracle.edit!),
          pan: median(oracle.pan!),
        },
        noChangeMs: timings.still!.map((value) => Math.round(value * 10) / 10),
        oneLeafEditMs: timings.edit!.map((value) => Math.round(value * 10) / 10),
        panMs: timings.pan!.map((value) => Math.round(value * 10) / 10),
        derivation: derivationCountsForTesting(twins[0]!.source),
      })}\n`,
    );
  }
});
