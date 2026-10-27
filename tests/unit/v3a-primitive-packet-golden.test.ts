import { createHash } from 'node:crypto';
import type { RenderNodeSnapshot, RendererInvalidationTarget } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import type {
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';

// V3-A16 (P3 V3 contract, section l): primitive-only packets stay byte- and
// shape-identical to main before V3. The digest below was recorded by running
// this exact corpus against main 4e6e40d, before any V3a source change.
const PRE_V3_DIGEST = '818841068e24323889ad2cf3e6b2169ecd05e655558dd94f5dceb91a66997282';

const identity = { documentId: 'v3a-golden', pageId: 'page' };
const noInvalidation: RendererInvalidationTarget = {
  invalidate: () => undefined,
  setMode: () => undefined,
};

function target(generation: number, devicePixelRatio = 1, width = 640): PrimitiveTarget {
  return {
    generation,
    surfaceRevision: 1,
    width,
    height: 360,
    devicePixelRatio,
    sampleCount: 4,
    targetFormat: 'bgra8unorm',
  };
}

function rectangle(id: string, parentId: string | null, x: number, y: number): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, y],
    visible: true,
    opacity: 0.75,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 40, height: 20, cornerRadii: [2, 4, 0, 1] },
    style: {
      fill: { r: 0.2, g: 0.4, b: 0.6, a: 1 },
      stroke: { color: { r: 1, g: 0, b: 0, a: 0.5 }, width: 3 },
    },
  };
}

const corpus: readonly RenderNodeSnapshot[] = [
  {
    id: 'group',
    parentId: null,
    transform: [Math.cos(0.3), Math.sin(0.3), -Math.sin(0.3), Math.cos(0.3), 100, 50],
    visible: true,
    opacity: 1,
    kind: 'container',
    clip: null,
    children: ['r1', 'e1', 'hidden'],
  },
  rectangle('r1', 'group', 10, 10),
  {
    id: 'e1',
    parentId: 'group',
    transform: [2, 0, 0, 0.5, 60, 30],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'ellipse', width: 30, height: 30 },
    style: { fill: { r: 0, g: 1, b: 0, a: 0.5 }, stroke: null },
  },
  { ...rectangle('hidden', 'group', 0, 0), visible: false },
  {
    id: 'l1',
    parentId: null,
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'line', start: { x: 5, y: 5 }, end: { x: 300, y: 200 } },
    style: { fill: null, stroke: { color: { r: 0, g: 0, b: 1, a: 1 }, width: 2 } },
  },
  rectangle('far', null, 1e6, 1e6),
];

function receipt(packet: PrimitivePacket): PrimitiveReceipt {
  return {
    scene: packet.scene,
    sceneEpoch: packet.sceneEpoch,
    cameraRevision: packet.cameraRevision,
    surfaceRevision: packet.surfaceRevision,
    originRevision: packet.originRevision,
    generation: packet.generation,
    packetId: packet.packetId,
    submissionSerial: 1,
    resources: packet.resources.map((resource) => ({
      resourceId: resource.id,
      incarnation: resource.incarnation,
      records: packet.writes
        .filter((write) => write.resourceId === resource.id)
        .flatMap((write) => write.records),
    })),
  };
}

/** Serializes every packet field, its key order and its bytes; symbols become first-seen ordinals. */
function serialize(value: unknown, symbols: Map<symbol, number>): unknown {
  if (typeof value === 'symbol') {
    if (!symbols.has(value)) symbols.set(value, symbols.size);
    return `symbol#${symbols.get(value)}`;
  }
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map((entry) => serialize(entry, symbols));
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value).map((key) => [
      key,
      serialize((value as Record<string, unknown>)[key], symbols),
    ]);
  }
  return value;
}

function runCorpus(): string {
  const service = new PrimitiveRendererService(noInvalidation);
  const symbols = new Map<symbol, number>();
  const frames: unknown[] = [];
  const record = (next: PrimitiveTarget, acknowledge = true) => {
    const packet = service.prepare(next);
    frames.push(serialize(packet, symbols));
    if (packet !== null && acknowledge) service.acknowledge(receipt(packet));
  };

  record(target(1));
  expect(
    service.replaceSnapshot({
      identity,
      revision: 1,
      nodes: corpus,
      rootOrder: ['group', 'l1', 'far'],
    }).status,
  ).toBe('applied');
  record(target(1));
  record(target(1));
  service.setCamera({ position: { x: 30.5, y: -12.25 }, zoom: 1 });
  record(target(1));
  service.setCamera({ position: { x: 900, y: 700 }, zoom: 2.5 });
  record(target(1), false);
  record(target(1));
  expect(
    service.applyChanges({
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [rectangle('r2', null, 950, 720)],
      updated: [{ ...rectangle('r1', 'group', 12, 10), opacity: 0.5 }],
      removed: ['far'],
      orders: [{ parentId: null, children: ['r2', 'group', 'l1'] }],
    }).status,
  ).toBe('applied');
  record(target(1));
  record(target(2, 1.5));
  record(target(2, 1.5, 1280));
  service.setCamera({ position: { x: -400, y: -300 }, zoom: 0.25 });
  record(target(2, 2));
  service.dispose();
  record(target(2));
  return createHash('sha256').update(JSON.stringify(frames)).digest('hex');
}

describe('V3a primitive-only packet golden', () => {
  it('V3-A16: primitive-only packets are byte- and shape-identical to main before V3', () => {
    const digest = runCorpus();
    expect(digest).toBe(PRE_V3_DIGEST);
  });
});
