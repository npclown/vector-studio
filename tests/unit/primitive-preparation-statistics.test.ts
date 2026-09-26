import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import type {
  PrimitiveFrameSource,
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

const identity = { documentId: 'preparation-statistics', pageId: 'page' };
const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 4,
  targetFormat: 'bgra8unorm',
};
const zero = {
  geometryBuilds: 0,
  recordWrites: { transforms: 0, geometry: 0, styles: 0, order: 0, frame: 0 },
};

function leaf(
  id: string,
  x = 20,
  cornerRadii: readonly [number, number, number, number] = [0, 0, 0, 0],
): Extract<RenderNodeSnapshot, { kind: 'primitive' }> {
  return {
    id,
    parentId: null,
    kind: 'primitive',
    transform: [1, 0, 0, 1, x, 20],
    visible: true,
    opacity: 1,
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii },
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
  };
}

function setup(nodes: readonly RenderNodeSnapshot[] = [leaf('a')]) {
  const mirror = new RetainedSceneMirror();
  expect(
    mirror.replaceSnapshot({
      identity,
      revision: 0,
      nodes,
      rootOrder: nodes.map((node) => node.id),
    }).status,
  ).toBe('applied');
  return { mirror, source: new PrimitiveSceneSource(mirror) };
}

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

function prepareAndAcknowledge(source: PrimitiveFrameSource, nextTarget = target): PrimitivePacket {
  const packet = source.prepare(nextTarget)!;
  source.acknowledge(receipt(packet));
  return packet;
}

function update(
  mirror: RetainedSceneMirror,
  baseRevision: number,
  revision: number,
  updated: readonly RenderNodeSnapshot[],
): void {
  expect(
    mirror.applyChanges({
      identity,
      baseRevision,
      revision,
      inserted: [],
      updated,
      removed: [],
      orders: [],
    }).status,
  ).toBe('applied');
}

function writeRecords(packet: PrimitivePacket) {
  return Object.fromEntries(
    ['transforms', 'geometry', 'styles', 'order', 'frame'].map((resourceId) => [
      resourceId,
      packet.writes
        .filter((write) => write.resourceId === resourceId)
        .reduce((count, write) => count + write.records.length, 0),
    ]),
  );
}

function statisticsDelta(
  before: ReturnType<PrimitiveSceneSource['getPreparationStatistics']>,
  after: ReturnType<PrimitiveSceneSource['getPreparationStatistics']>,
) {
  return {
    geometryBuilds: after.geometryBuilds - before.geometryBuilds,
    recordWrites: {
      transforms: after.recordWrites.transforms - before.recordWrites.transforms,
      geometry: after.recordWrites.geometry - before.recordWrites.geometry,
      styles: after.recordWrites.styles - before.recordWrites.styles,
      order: after.recordWrites.order - before.recordWrites.order,
      frame: after.recordWrites.frame - before.recordWrites.frame,
    },
  };
}

describe('primitive preparation statistics', () => {
  it('separates actual geometry construction from backing writes', () => {
    const { mirror, source } = setup([leaf('a', 20, [5, 5, 0, 0]), leaf('b', 60)]);
    expect(source.getPreparationStatistics()).toEqual(zero);

    const initial = prepareAndAcknowledge(source);
    expect(writeRecords(initial)).toEqual({
      transforms: 2,
      geometry: 2,
      styles: 2,
      order: 2,
      frame: 1,
    });
    expect(source.getPreparationStatistics()).toEqual({
      geometryBuilds: 2,
      recordWrites: { transforms: 2, geometry: 2, styles: 2, order: 2, frame: 1 },
    });

    const beforeSteady = source.getPreparationStatistics();
    expect(prepareAndAcknowledge(source).writes).toEqual([]);
    expect(source.getPreparationStatistics()).toEqual(beforeSteady);

    update(mirror, 0, 1, [leaf('a', 20, [10, 10, 0, 0])]);
    const normalizedEqual = prepareAndAcknowledge(source);
    expect(normalizedEqual.writes).toEqual([]);
    expect(source.getPreparationStatistics()).toEqual({
      geometryBuilds: 3,
      recordWrites: { transforms: 2, geometry: 2, styles: 2, order: 2, frame: 1 },
    });
  });

  it('attributes camera, style, transform, rebase and generation work independently', () => {
    const { mirror, source } = setup();
    prepareAndAcknowledge(source);
    const initialStatistics = source.getPreparationStatistics();
    expect(initialStatistics).toEqual({
      geometryBuilds: 1,
      recordWrites: { transforms: 1, geometry: 1, styles: 1, order: 1, frame: 1 },
    });

    expect(mirror.setCamera({ position: { x: 1, y: 0 }, zoom: 1 }).status).toBe('applied');
    const beforeCamera = source.getPreparationStatistics();
    expect(writeRecords(prepareAndAcknowledge(source))).toEqual({
      transforms: 0,
      geometry: 0,
      styles: 0,
      order: 0,
      frame: 1,
    });
    const afterCamera = source.getPreparationStatistics();
    expect(statisticsDelta(beforeCamera, afterCamera)).toEqual({
      geometryBuilds: 0,
      recordWrites: { transforms: 0, geometry: 0, styles: 0, order: 0, frame: 1 },
    });
    expect(afterCamera).toEqual({
      geometryBuilds: 1,
      recordWrites: { transforms: 1, geometry: 1, styles: 1, order: 1, frame: 2 },
    });
    expect(initialStatistics).toEqual({
      geometryBuilds: 1,
      recordWrites: { transforms: 1, geometry: 1, styles: 1, order: 1, frame: 1 },
    });

    const colored = { ...leaf('a'), style: { fill: { r: 0, g: 1, b: 1, a: 1 }, stroke: null } };
    update(mirror, 0, 1, [colored]);
    const beforeColor = source.getPreparationStatistics();
    expect(writeRecords(prepareAndAcknowledge(source))).toEqual({
      transforms: 0,
      geometry: 0,
      styles: 1,
      order: 0,
      frame: 0,
    });
    const afterColor = source.getPreparationStatistics();
    expect(statisticsDelta(beforeColor, afterColor)).toEqual({
      geometryBuilds: 0,
      recordWrites: { transforms: 0, geometry: 0, styles: 1, order: 0, frame: 0 },
    });
    expect(afterColor).toEqual({
      geometryBuilds: 1,
      recordWrites: { transforms: 1, geometry: 1, styles: 2, order: 1, frame: 2 },
    });

    const translucent = { ...colored, opacity: 0.5 };
    update(mirror, 1, 2, [translucent]);
    const beforeOpacity = source.getPreparationStatistics();
    expect(writeRecords(prepareAndAcknowledge(source))).toEqual({
      transforms: 0,
      geometry: 0,
      styles: 1,
      order: 0,
      frame: 0,
    });
    const afterOpacity = source.getPreparationStatistics();
    expect(statisticsDelta(beforeOpacity, afterOpacity)).toEqual({
      geometryBuilds: 0,
      recordWrites: { transforms: 0, geometry: 0, styles: 1, order: 0, frame: 0 },
    });
    expect(afterOpacity).toEqual({
      geometryBuilds: 1,
      recordWrites: { transforms: 1, geometry: 1, styles: 3, order: 1, frame: 2 },
    });

    const moved = { ...translucent, transform: [1, 0, 0, 1, 21, 20] as const };
    update(mirror, 2, 3, [moved]);
    const beforeTransform = source.getPreparationStatistics();
    expect(writeRecords(prepareAndAcknowledge(source))).toEqual({
      transforms: 1,
      geometry: 0,
      styles: 0,
      order: 0,
      frame: 0,
    });
    const afterTransform = source.getPreparationStatistics();
    expect(statisticsDelta(beforeTransform, afterTransform)).toEqual({
      geometryBuilds: 0,
      recordWrites: { transforms: 1, geometry: 0, styles: 0, order: 0, frame: 0 },
    });
    expect(afterTransform).toEqual({
      geometryBuilds: 1,
      recordWrites: { transforms: 2, geometry: 1, styles: 3, order: 1, frame: 2 },
    });

    expect(mirror.setCamera({ position: { x: -512.25, y: 0 }, zoom: 1 }).status).toBe('applied');
    const beforeRebase = source.getPreparationStatistics();
    const rebased = prepareAndAcknowledge(source);
    expect(
      rebased.writes.map((write) => [write.resourceId, write.byteOffset, write.bytes.length]),
    ).toEqual([
      ['transforms', 0, 32],
      ['frame', 0, 32],
    ]);
    const afterRebase = source.getPreparationStatistics();
    expect(statisticsDelta(beforeRebase, afterRebase)).toEqual({
      geometryBuilds: 0,
      recordWrites: { transforms: 1, geometry: 0, styles: 0, order: 0, frame: 1 },
    });
    expect(afterRebase).toEqual({
      geometryBuilds: 1,
      recordWrites: { transforms: 3, geometry: 1, styles: 3, order: 1, frame: 3 },
    });

    const beforeRecovery = source.getPreparationStatistics();
    const recovered = prepareAndAcknowledge(source, { ...target, generation: 2 });
    expect(recovered.mode).toBe('reconstruct');
    expect(writeRecords(recovered)).toEqual({
      transforms: 1,
      geometry: 1,
      styles: 1,
      order: 1,
      frame: 1,
    });
    expect(source.getPreparationStatistics()).toEqual(beforeRecovery);
    expect(statisticsDelta(beforeRecovery, source.getPreparationStatistics())).toEqual(zero);
    expect(initialStatistics).toEqual({
      geometryBuilds: 1,
      recordWrites: { transforms: 1, geometry: 1, styles: 1, order: 1, frame: 1 },
    });
  });

  it('retains cumulative counts through growth and snapshot replacement', () => {
    const { mirror, source } = setup();
    prepareAndAcknowledge(source);
    const inserted = Array.from({ length: 16 }, (_, index) =>
      leaf(`n${String(index).padStart(2, '0')}`, 40 + index * 12),
    );
    expect(
      mirror.applyChanges({
        identity,
        baseRevision: 0,
        revision: 1,
        inserted,
        updated: [],
        removed: [],
        orders: [{ parentId: null, children: ['a', ...inserted.map((node) => node.id)] }],
      }).status,
    ).toBe('applied');
    const grown = prepareAndAcknowledge(source);
    expect(grown.mode).toBe('reconstruct');
    expect(writeRecords(grown)).toEqual({
      transforms: 17,
      geometry: 17,
      styles: 17,
      order: 17,
      frame: 1,
    });
    expect(source.getPreparationStatistics()).toEqual({
      geometryBuilds: 18,
      recordWrites: { transforms: 18, geometry: 18, styles: 18, order: 18, frame: 2 },
    });

    expect(
      mirror.replaceSnapshot({
        identity,
        revision: 2,
        nodes: [leaf('replacement')],
        rootOrder: ['replacement'],
      }).status,
    ).toBe('applied');
    const replacement = prepareAndAcknowledge(source);
    expect(replacement.mode).toBe('reconstruct');
    expect(source.getPreparationStatistics()).toEqual({
      geometryBuilds: 19,
      recordWrites: { transforms: 19, geometry: 19, styles: 19, order: 19, frame: 3 },
    });
  });

  it('returns detached frozen snapshots and keeps sources independent', () => {
    const first = setup().source;
    const second = setup([leaf('second')]).source;
    prepareAndAcknowledge(first);
    const snapshot = first.getPreparationStatistics();
    const next = first.getPreparationStatistics();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.recordWrites)).toBe(true);
    expect(next).not.toBe(snapshot);
    expect(next.recordWrites).not.toBe(snapshot.recordWrites);
    expect(() => Object.assign(snapshot.recordWrites, { geometry: 99 })).toThrow(TypeError);
    expect(first.getPreparationStatistics()).toEqual(snapshot);
    expect(second.getPreparationStatistics()).toEqual(zero);
  });

  it('counts an attempted geometry build when later numeric packing fails', () => {
    const { mirror, source } = setup();
    prepareAndAcknowledge(source);
    const invalidPacking = {
      ...leaf('a'),
      visible: false,
      geometry: {
        kind: 'rectangle' as const,
        width: 1e300,
        height: 10,
        cornerRadii: [0, 0, 0, 0] as const,
      },
    };
    update(mirror, 0, 1, [invalidPacking]);
    const before = source.getPreparationStatistics();
    expect(() => source.prepare(target)).toThrow('geometry cannot be represented in packet v1');
    expect(source.getPreparationStatistics()).toEqual({
      geometryBuilds: before.geometryBuilds + 1,
      recordWrites: before.recordWrites,
    });
  });

  it('retains its final snapshot and prevents activity after terminal disposal', () => {
    const { source } = setup();
    prepareAndAcknowledge(source);
    const final = source.getPreparationStatistics();
    source.dispose();
    source.dispose();
    expect(source.prepare({ ...target, generation: 2 })).toBeNull();
    expect(source.getPreparationStatistics()).toEqual(final);
    expect(source.getPreparationStatistics()).not.toBe(final);
  });

  it('forwards the same detached observation through the renderer service', () => {
    const invalidate = vi.fn();
    const service = new PrimitiveRendererService({ invalidate, setMode: vi.fn() });
    expect(
      service.replaceSnapshot({ identity, revision: 0, nodes: [leaf('a')], rootOrder: ['a'] })
        .status,
    ).toBe('applied');
    prepareAndAcknowledge(service);
    const statistics = service.getPreparationStatistics();
    expect(statistics).toEqual({
      geometryBuilds: 1,
      recordWrites: { transforms: 1, geometry: 1, styles: 1, order: 1, frame: 1 },
    });
    expect(Object.isFrozen(statistics)).toBe(true);
    expect(Object.isFrozen(statistics.recordWrites)).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ reason: 'scene' });
  });
});
