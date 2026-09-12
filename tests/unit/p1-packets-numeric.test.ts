import type { RenderNodeSnapshot, SceneAffine } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import type {
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import {
  assessPrimitivePacking,
  normalizeRectangleRadii,
  PrimitiveNumericPreparationError,
} from '../../packages/renderer-core/src/primitive-packing.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

const identity = { documentId: 'fixture-doc', pageId: 'fixture-page' } as const;
const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 0,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 1,
  targetFormat: 'bgra8unorm',
};

function rect(
  id: string,
  transform: SceneAffine,
  overrides: Partial<RenderNodeSnapshot> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    kind: 'primitive',
    transform,
    visible: true,
    opacity: 1,
    geometry: { kind: 'rectangle', width: 8, height: 8, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
    ...overrides,
  } as RenderNodeSnapshot;
}

function decodeWrite(packet: ReturnType<PrimitiveSceneSource['prepare']>, resourceId: string) {
  const write = packet!.writes.find((entry) => entry.resourceId === resourceId)!;
  return new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength);
}

describe('P1.2 hierarchy, culling, and numeric packet fixtures', () => {
  it('matches N01 hierarchy composition and V01 radius normalization', () => {
    expect(normalizeRectangleRadii(100, 60, [80, 40, 20, 0])).toEqual([60, 30, 15, 0]);
    const group: RenderNodeSnapshot = {
      id: 'g',
      parentId: null,
      kind: 'container',
      transform: [2, 0, 0, 3, 10, 20],
      visible: true,
      opacity: 1,
      children: ['a'],
    };
    const child = rect('a', [1, 0, 0.25, 1, 4, 5], {
      parentId: 'g',
      geometry: { kind: 'rectangle', width: 100, height: 60, cornerRadii: [80, 40, 20, 0] },
    });
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({ identity, revision: 0, nodes: [child, group], rootOrder: ['g'] });
    const source = new PrimitiveSceneSource(mirror);
    const packet = source.prepare(target)!;
    const transform = decodeWrite(packet, 'transforms');
    expect(Array.from({ length: 6 }, (_, index) => transform.getFloat32(index * 4, true))).toEqual([
      2, 0, 0.5, 3, 18, 35,
    ]);
    const geometry = decodeWrite(packet, 'geometry');
    expect(
      Array.from({ length: 4 }, (_, index) => geometry.getFloat32(16 + index * 4, true)),
    ).toEqual([60, 30, 15, 0]);
    const worldPoint = { x: 2 * 2 + 0.5 * 3 + 18, y: 3 * 3 + 35 };
    expect(worldPoint).toEqual({ x: 23.5, y: 44 });
    expect({ x: (worldPoint.x - 10) * 2 * 1.5, y: (worldPoint.y - 20) * 2 * 1.5 }).toEqual({
      x: 40.5,
      y: 72,
    });
  });

  it('matches V03 stable overlap order and independent premultiplied source-over values', () => {
    const red = rect('red', [1, 0, 0, 1, 30, 30], {
      geometry: { kind: 'rectangle', width: 80, height: 80, cornerRadii: [0, 0, 0, 0] },
      style: { fill: { r: 1, g: 0, b: 0, a: 0.5 }, stroke: null },
    });
    const blue = rect('blue', [1, 0, 0, 1, 50, 50], {
      geometry: { kind: 'rectangle', width: 80, height: 80, cornerRadii: [0, 0, 0, 0] },
      style: { fill: { r: 0, g: 0, b: 1, a: 0.5 }, stroke: null },
    });
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({
      identity,
      revision: 0,
      nodes: [blue, red],
      rootOrder: ['red', 'blue'],
    });
    const source = new PrimitiveSceneSource(mirror);
    const first = source.prepare(target)!;
    expect(readOrder(first)).toEqual([0, 1]);
    source.acknowledge(receiptFor(first));
    expect(
      mirror.applyChanges({
        identity,
        baseRevision: 0,
        revision: 1,
        inserted: [],
        updated: [],
        removed: [],
        orders: [{ parentId: null, children: ['blue', 'red'] }],
      }).status,
    ).toBe('applied');
    expect(readOrder(source.prepare(target)!)).toEqual([1, 0]);

    expect(sourceOver([0, 0, 0.5, 0.5], [0.5, 0, 0, 0.5])).toEqual([0.25, 0, 0.5, 0.75]);
    expect(sourceOver([0.5, 0, 0, 0.5], [0, 0, 0.5, 0.5])).toEqual([0.5, 0, 0.25, 0.75]);
  });

  it('implements V03/V06/V07 stable paint order, hidden/degenerate omission, and inclusive guarded culling', () => {
    const hiddenGroup: RenderNodeSnapshot = {
      id: 'g',
      parentId: null,
      kind: 'container',
      transform: [1, 0, 0, 1, 0, 0],
      visible: false,
      opacity: 1,
      children: ['hidden'],
    };
    const nodes = [
      rect('left-touch', [1, 0, 0, 1, -8, 20]),
      rect('right-touch', [1, 0, 0, 1, 640, 20]),
      rect('top-touch', [1, 0, 0, 1, 20, -8]),
      rect('bottom-touch', [1, 0, 0, 1, 20, 360]),
      rect('outside', [1, 0, 0, 1, -10.01, 20]),
      rect('zero', [1, 0, 0, 1, 20, 20], {
        geometry: { kind: 'rectangle', width: 0, height: 8, cornerRadii: [0, 0, 0, 0] },
      }),
      rect('singular', [1, 0, 2, 0, 20, 20]),
      hiddenGroup,
      rect('hidden', [1, 0, 0, 1, 20, 20], { parentId: 'g' }),
    ];
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({
      identity,
      revision: 0,
      nodes,
      rootOrder: [
        'left-touch',
        'right-touch',
        'top-touch',
        'bottom-touch',
        'outside',
        'zero',
        'singular',
        'g',
      ],
    });
    const source = new PrimitiveSceneSource(mirror);
    const packet = source.prepare(target)!;
    expect(packet.draws).toEqual([{ first: 0, count: 4, variant: 'analytic-v1' }]);
    const order = decodeWrite(packet, 'order');
    expect(Array.from({ length: 4 }, (_, index) => order.getUint32(index * 4, true))).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('matches N03 origin hysteresis and transform-only rebase writes', () => {
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({
      identity,
      revision: 0,
      nodes: [rect('a', [1, 0, 0, 1, 0, 0])],
      rootOrder: ['a'],
    });
    const source = new PrimitiveSceneSource(mirror);
    const origins: number[] = [];
    const tokens: symbol[] = [];
    for (const x of [0, 255.75, 256, 511.75, 512, 512.25, 511.75]) {
      mirror.setCamera({ position: { x, y: 0 }, zoom: 1 });
      const packet = source.prepare(target)!;
      origins.push(decodeWrite(packet, 'frame').getFloat32(0, true) + x);
      tokens.push(packet.originRevision);
      if (x === 512.25) {
        expect(
          packet.writes
            .filter(({ resourceId }) => resourceId === 'transforms')
            .map(({ bytes }) => bytes.byteLength),
        ).toEqual([32]);
        expect(
          packet.writes.some(
            ({ resourceId }) => resourceId === 'geometry' || resourceId === 'styles',
          ),
        ).toBe(false);
      }
      const receipt = {
        scene: packet.scene,
        sceneEpoch: packet.sceneEpoch,
        cameraRevision: packet.cameraRevision,
        surfaceRevision: packet.surfaceRevision,
        originRevision: packet.originRevision,
        generation: packet.generation,
        packetId: packet.packetId,
        submissionSerial: origins.length,
        resources: packet.resources.map((resource) => ({
          resourceId: resource.id,
          incarnation: resource.incarnation,
          records: packet.writes
            .filter((write) => write.resourceId === resource.id)
            .flatMap((write) => write.records),
        })),
      };
      source.acknowledge(receipt);
    }
    expect(origins).toEqual([0, 0, 0, 0, 0, 512, 512]);
    expect(tokens[0]).toBe(tokens[4]);
    expect(tokens[5]).not.toBe(tokens[4]);
    expect(tokens[6]).toBe(tokens[5]);
  });

  it('bounds N02 f32 storage and arithmetic over the clipped continuous local domain', () => {
    const origins = [1e9, -1e9];
    const angle = (degrees: number) => (degrees * Math.PI) / 180;
    const variants: SceneAffine[] = [
      [1, 0, 0, 1, 0, 0],
      ...[15, 45, 90].map((degrees): SceneAffine => [
        Math.cos(angle(degrees)),
        Math.sin(angle(degrees)),
        -Math.sin(angle(degrees)),
        Math.cos(angle(degrees)),
        0,
        0,
      ]),
      [-1, 0, 0, 1, 0, 0],
      [2, 0, 0, 0.5, 0, 0],
      [1, 0, 0.25, 1, 0, 0],
    ];
    for (const origin of origins)
      for (const [width, height] of [
        [16, 8],
        [16, 16],
        [4096, 4096],
      ] as const)
        for (const strokeWidth of [0, 4])
          for (const zoom of [0.01, 1, 64])
            for (const dpr of [1, 1.5, 2])
              for (const linear of variants) {
                const centerX = width / 2;
                const centerY = height / 2;
                const world: SceneAffine = [
                  linear[0],
                  linear[1],
                  linear[2],
                  linear[3],
                  origin + 0.25 + centerX - linear[0] * centerX - linear[2] * centerY,
                  -origin + 0.5 + centerY - linear[1] * centerX - linear[3] * centerY,
                ];
                for (const camera of [
                  { x: origin, y: -origin },
                  { x: origin + 0.25 + centerX, y: -origin + 0.5 + centerY },
                ]) {
                  const halfStroke = strokeWidth / 2;
                  const bounds = {
                    minX: -halfStroke,
                    minY: -halfStroke,
                    maxX: width + halfStroke,
                    maxY: height + halfStroke,
                  };
                  const physicalWidth = 640 * dpr;
                  const physicalHeight = 360 * dpr;
                  const domain = oracleLocalDomain(
                    world,
                    bounds,
                    camera,
                    zoom,
                    dpr,
                    physicalWidth,
                    physicalHeight,
                  );
                  if (domain === null) continue;
                  const anchor = {
                    x: 256 * Math.floor(camera.x / 256),
                    y: 256 * Math.floor(camera.y / 256),
                  };
                  const precisionNode = rect('precision', world, {
                    geometry: { kind: 'rectangle', width, height, cornerRadii: [0, 0, 0, 0] },
                    style: {
                      fill: { r: 1, g: 1, b: 1, a: 1 },
                      stroke:
                        strokeWidth === 0
                          ? null
                          : { color: { r: 1, g: 1, b: 1, a: 1 }, width: strokeWidth },
                    },
                  }) as Extract<RenderNodeSnapshot, { kind: 'primitive' }>;
                  const result = assessPrimitivePacking(
                    world,
                    bounds,
                    anchor,
                    camera,
                    zoom,
                    dpr,
                    physicalWidth,
                    physicalHeight,
                    precisionNode,
                  );
                  const label = JSON.stringify({
                    origin,
                    width,
                    height,
                    strokeWidth,
                    zoom,
                    dpr,
                    linear,
                    camera,
                  });
                  expect(Number.isFinite(result.quantizationPhysicalPixels)).toBe(true);
                  expect(Number.isFinite(result.arithmeticPhysicalPixels)).toBe(true);
                  expect(result.quantizationPhysicalPixels, label).toBeLessThanOrEqual(0.125);
                  expect(result.arithmeticPhysicalPixels, label).toBeLessThanOrEqual(0.125);

                  for (const point of sampleDomain(domain)) {
                    const exact = exactPhysical(world, camera, point, zoom, dpr);
                    const packedIdeal = packedIdealPhysical(
                      world,
                      anchor,
                      camera,
                      point,
                      zoom,
                      dpr,
                    );
                    const actual = f32ShaderPhysical(
                      world,
                      anchor,
                      camera,
                      point,
                      zoom,
                      dpr,
                      physicalWidth,
                      physicalHeight,
                    );
                    expect(
                      Math.max(
                        Math.abs(packedIdeal.x - exact.x),
                        Math.abs(packedIdeal.y - exact.y),
                      ),
                      label,
                    ).toBeLessThanOrEqual(0.125);
                    expect(
                      Math.max(
                        Math.abs(actual.x - packedIdeal.x),
                        Math.abs(actual.y - packedIdeal.y),
                      ),
                      label,
                    ).toBeLessThanOrEqual(0.125);
                  }
                }
              }
  });

  it('preserves accepted CPU truth when a finite transform is unsafe for packet v1', () => {
    const mirror = new RetainedSceneMirror();
    const tiny = rect('a', [1e-50, 0, 0, 1, 20, 20]);
    expect(
      mirror.replaceSnapshot({ identity, revision: 0, nodes: [tiny], rootOrder: ['a'] }).status,
    ).toBe('applied');
    const source = new PrimitiveSceneSource(mirror);
    expect(() => source.prepare(target)).toThrow(PrimitiveNumericPreparationError);
    expect(mirror.readRetainedScene()!.getNode('a')!.transform[0]).toBe(1e-50);
    expect(() => source.prepare(target)).toThrow(PrimitiveNumericPreparationError);
  });
});

type Bounds = Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;

function oracleLocalDomain(
  world: SceneAffine,
  bounds: Bounds,
  camera: { x: number; y: number },
  zoom: number,
  dpr: number,
  physicalWidth: number,
  physicalHeight: number,
): Bounds | null {
  const determinant = world[0] * world[3] - world[1] * world[2];
  const guardWorld = 2 / (zoom * dpr);
  const guardX = (guardWorld * (Math.abs(world[3]) + Math.abs(world[2]))) / Math.abs(determinant);
  const guardY = (guardWorld * (Math.abs(world[1]) + Math.abs(world[0]))) / Math.abs(determinant);
  const viewport = [
    [camera.x - guardWorld, camera.y - guardWorld],
    [camera.x + physicalWidth / dpr / zoom + guardWorld, camera.y - guardWorld],
    [
      camera.x + physicalWidth / dpr / zoom + guardWorld,
      camera.y + physicalHeight / dpr / zoom + guardWorld,
    ],
    [camera.x - guardWorld, camera.y + physicalHeight / dpr / zoom + guardWorld],
  ] as const;
  const local = viewport.map(([x, y]) => ({
    x: (world[3] * (x - world[4]) - world[2] * (y - world[5])) / determinant,
    y: (-world[1] * (x - world[4]) + world[0] * (y - world[5])) / determinant,
  }));
  const result = {
    minX: Math.max(bounds.minX - guardX, Math.min(...local.map(({ x }) => x))),
    minY: Math.max(bounds.minY - guardY, Math.min(...local.map(({ y }) => y))),
    maxX: Math.min(bounds.maxX + guardX, Math.max(...local.map(({ x }) => x))),
    maxY: Math.min(bounds.maxY + guardY, Math.max(...local.map(({ y }) => y))),
  };
  return result.minX <= result.maxX && result.minY <= result.maxY ? result : null;
}

function sampleDomain(bounds: Bounds) {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return [bounds.minX, centerX, bounds.maxX].flatMap((x) =>
    [bounds.minY, centerY, bounds.maxY].map((y) => ({ x, y })),
  );
}

function exactPhysical(
  world: SceneAffine,
  camera: { x: number; y: number },
  point: { x: number; y: number },
  zoom: number,
  dpr: number,
) {
  return {
    x: (world[0] * point.x + world[2] * point.y + (world[4] - camera.x)) * zoom * dpr,
    y: (world[1] * point.x + world[3] * point.y + (world[5] - camera.y)) * zoom * dpr,
  };
}

function packedIdealPhysical(
  world: SceneAffine,
  anchor: { x: number; y: number },
  camera: { x: number; y: number },
  point: { x: number; y: number },
  zoom: number,
  dpr: number,
) {
  const values = world.map((value, index) =>
    Math.fround(index === 4 ? value - anchor.x : index === 5 ? value - anchor.y : value),
  );
  const x = Math.fround(point.x);
  const y = Math.fround(point.y);
  return {
    x:
      (values[0]! * x + values[2]! * y + values[4]! + Math.fround(anchor.x - camera.x)) *
      Math.fround(zoom) *
      Math.fround(dpr),
    y:
      (values[1]! * x + values[3]! * y + values[5]! + Math.fround(anchor.y - camera.y)) *
      Math.fround(zoom) *
      Math.fround(dpr),
  };
}

function f32ShaderPhysical(
  world: SceneAffine,
  anchor: { x: number; y: number },
  camera: { x: number; y: number },
  point: { x: number; y: number },
  zoom: number,
  dpr: number,
  physicalWidth: number,
  physicalHeight: number,
) {
  const p = world.map((value, index) =>
    Math.fround(index === 4 ? value - anchor.x : index === 5 ? value - anchor.y : value),
  );
  const x = Math.fround(point.x);
  const y = Math.fround(point.y);
  const relX = Math.fround(Math.fround(Math.fround(p[0]! * x) + Math.fround(p[2]! * y)) + p[4]!);
  const relY = Math.fround(Math.fround(Math.fround(p[1]! * x) + Math.fround(p[3]! * y)) + p[5]!);
  const docX = Math.fround(relX + Math.fround(anchor.x - camera.x));
  const docY = Math.fround(relY + Math.fround(anchor.y - camera.y));
  const physX = Math.fround(Math.fround(docX * Math.fround(zoom)) * Math.fround(dpr));
  const physY = Math.fround(Math.fround(docY * Math.fround(zoom)) * Math.fround(dpr));
  const ndcX = Math.fround(Math.fround(Math.fround(physX * 2) / Math.fround(physicalWidth)) - 1);
  const ndcY = Math.fround(1 - Math.fround(Math.fround(physY * 2) / Math.fround(physicalHeight)));
  return { x: ((ndcX + 1) * physicalWidth) / 2, y: ((1 - ndcY) * physicalHeight) / 2 };
}

function receiptFor(packet: PrimitivePacket): PrimitiveReceipt {
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

function readOrder(packet: PrimitivePacket): number[] {
  const write = packet.writes.find(({ resourceId }) => resourceId === 'order')!;
  const view = new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength);
  return Array.from({ length: write.bytes.byteLength / 4 }, (_, index) =>
    view.getUint32(index * 4, true),
  );
}

function sourceOver(
  source: readonly [number, number, number, number],
  destination: readonly [number, number, number, number],
) {
  return [
    source[0] + destination[0] * (1 - source[3]),
    source[1] + destination[1] * (1 - source[3]),
    source[2] + destination[2] * (1 - source[3]),
    source[3] + destination[3] * (1 - source[3]),
  ];
}
