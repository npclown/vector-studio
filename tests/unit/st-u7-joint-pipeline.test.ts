import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { buildPathFringe } from '../../packages/renderer-core/src/path-fringe.js';
import {
  JOINT_STROKE_INDEX,
  buildJointOverlay,
} from '../../packages/renderer-core/src/path-joint-overlay.js';
import {
  PathMeshPacker,
  type MeshPackerSeededDefect,
} from '../../packages/renderer-core/src/path-mesh-packet.js';
import {
  PathMeshPipeline,
  pathMeshNoticeDiagnostic,
  type PathFringeBuilder,
  type PathMeshDraw,
  type PathMeshFailureCode,
  type PathMeshLimits,
  type PathMeshSeededDefect,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type {
  MeshResourceId,
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import {
  ScriptedStrokeMeshPort,
  pathStroke,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';
import {
  createCountingPort,
  identity,
  pathNode,
  rectangleNode,
  target,
  type PathMeshFrame,
} from '../support/v3a-path-harness.js';
import { MeshShadow, receiptOf, recordIndices, words } from '../support/v3b-mesh-harness.js';

// P3 B2 ST-U7 addendum, unit ST-U7c, acceptance rows ST-A15 and ST-A17 (unit form): the joint
// condition, the joint fill draw and its overlay variant in the path-mesh pipeline, the joint
// record words in the packet (word 15 = stroke slot + 1, recomputed every prepare), the removal
// of composition-unsupported, the overlay-unsupported notice, the overlay cache,
// accounting and eviction, fixtures ST7-F11 and ST7-F12 at the overlay work cap, seeded defects
// ST7-D7 to ST7-D9, and device-loss reconstruction of the joint writes from CPU state. Functional
// evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target until B4.

// The packet bytes of scenes that never meet the joint condition, serialized as in
// st-u6-stroke-pipeline.test.ts ("a fill-only scene packs byte-identically"), recorded from the
// pre-ST-U7 code on origin/main 0cb7115 (ST-A15). The fill-only V3 digest GOLDEN_MESH_PART_DIGEST
// stays asserted unchanged in v3b-mesh-packet.test.ts.
const PRE_ST_U7_DIGESTS = {
  regionOnly: '2b79ab9df9bc2036fd7e5e8a7007fe2760ea41ef9c4870e6c822a0af81f1445a',
  fringed: '70621c0f19ac46f4edcda8e24d5148d6691d477dadd1324b4f8fb6582770ef73',
} as const;

function jointHarness(
  options: Readonly<{
    nodes?: readonly RenderNodeSnapshot[];
    limits?: Partial<PathMeshLimits>;
    fringeBuilder?: PathFringeBuilder;
    seededDefect?: PathMeshSeededDefect;
  }> = {},
) {
  const fill = createCountingPort();
  const stroke = new ScriptedStrokeMeshPort();
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: 'supported',
    pathStrokes: 'supported',
  });
  const pipeline = new PathMeshPipeline({
    port: fill,
    strokePort: stroke,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.fringeBuilder === undefined ? {} : { fringeBuilder: options.fringeBuilder }),
    ...(options.seededDefect === undefined ? {} : { seededDefect: options.seededDefect }),
  });
  const source = new PrimitiveSceneSource(mirror, pipeline);
  let served: readonly PathMeshDraw[] = [];
  const pipelinePrepare = pipeline.prepare.bind(pipeline);
  pipeline.prepare = (input) => {
    served = pipelinePrepare(input);
    return served;
  };
  let revision = 0;
  const replace = (nodes: readonly RenderNodeSnapshot[]) => {
    revision += 1;
    const result = mirror.replaceSnapshot({
      identity,
      revision,
      nodes,
      rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
    });
    if (result.status !== 'applied') throw new Error(JSON.stringify(result));
  };
  if (options.nodes !== undefined) replace(options.nodes);
  let lastPacket: PrimitivePacket | null = null;
  const prepare = (nextTarget: PrimitiveTarget = target): PathMeshFrame => {
    const packet = source.prepare(nextTarget);
    if (packet === null) throw new Error('no packet');
    lastPacket = packet;
    return Object.freeze({ draws: served, notices: packet.mesh?.notices ?? [] });
  };
  return {
    ports: { fill, stroke },
    mirror,
    pipeline,
    source,
    replace,
    prepare,
    packet: () => lastPacket!,
    shape: () =>
      prepare().draws.map((draw) => `${draw.nodeId}:${draw.paint ?? 'fill'}${jointTag(draw)}`),
    setZoom: (zoom: number, position = { x: 0, y: 0 }) => mirror.setCamera({ position, zoom }),
  };
}

const jointTag = (draw: PathMeshDraw) => (draw.composite === 'joint-fill' ? ':joint' : '');

/** The meshInstances record of a slot in a packet's writes, or undefined when not written. */
function instanceRecord(packet: PrimitivePacket, slot: number): number[] | undefined {
  for (const write of packet.mesh?.writes ?? []) {
    if (write.resourceId !== 'meshInstances') continue;
    const first = write.byteOffset / 64;
    const index = slot - first;
    if (index < 0 || index >= write.bytes.byteLength / 64) continue;
    return words(write.bytes.subarray(64 * index, 64 * index + 64), 'u32');
  }
  return undefined;
}

function serialize(packet: PrimitivePacket): string {
  return JSON.stringify({
    resources: packet.mesh!.resources.map((resource) => [resource.id, resource.capacityBytes]),
    writes: packet.mesh!.writes.map((write) => [
      write.resourceId,
      write.byteOffset,
      Buffer.from(write.bytes).toString('hex'),
      recordIndices(write.records),
    ]),
    draws: packet.mesh!.draws,
    analytic: packet.draws,
    notices: packet.mesh!.notices,
  });
}

/**
 * A run of scenes that never meet the joint condition: both paints at opacity 1 and 0, single
 * paints at 0.5, a width-0 stroke, a primitive, zoom and pan changes, a generation change.
 */
function neverJointDigest(fringeBuilder: PathFringeBuilder | undefined): string {
  const nodes = (opacity: number): RenderNodeSnapshot[] => [
    strokedNode('a', 0, { opacity }),
    strokedNode('b', 20, { fill: null, opacity: 0.5 }),
    pathNode('c', 40, { opacity: 0.5 }),
    strokedNode('d', 60, { opacity: 0 }),
    strokedNode('e', 80, { opacity: 0.5, stroke: pathStroke({ width: 0 }) }),
    rectangleNode('r', 100),
  ];
  const h = jointHarness({
    nodes: nodes(1),
    ...(fringeBuilder === undefined ? {} : { fringeBuilder }),
  });
  const hash = createHash('sha256');
  const step = (nextTarget: PrimitiveTarget = target) => {
    h.prepare(nextTarget);
    const packet = h.packet();
    hash.update(serialize(packet));
    h.source.acknowledge(receiptOf(packet));
  };
  step();
  h.setZoom(2, { x: -1.5, y: 2.25 });
  step();
  h.replace(nodes(0));
  step();
  h.setZoom(0.5, { x: 3, y: -1 });
  step();
  step({ ...target, generation: 2 });
  h.replace(nodes(1));
  step({ ...target, generation: 2 });
  return hash.digest('hex');
}

describe('ST-U7 renderer: composition-unsupported is removed (ST-A15)', () => {
  it('the failure code union has overlay-unsupported and no composition-unsupported', () => {
    const added: PathMeshFailureCode = 'overlay-unsupported';
    // @ts-expect-error composition-unsupported is no longer a PathMeshFailureCode.
    const removed: PathMeshFailureCode = 'composition-unsupported';
    expect([added, removed]).toHaveLength(2);
    for (const file of [
      'packages/renderer-core/src/path-mesh-pipeline.ts',
      'packages/renderer-core/src/path-mesh-packet.ts',
      'packages/renderer-core/src/primitive-scene-source.ts',
      'packages/renderer-webgpu/src/native-primitive-scene.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('composition-unsupported');
    }
  });
});

describe('ST-U7 joint condition and draws (addendum section 4.1, ST-A15)', () => {
  const cases: ReadonlyArray<readonly [string, RenderNodeSnapshot, readonly string[]]> = [
    ['both paints at 0.5', strokedNode('a', 0, { opacity: 0.5 }), ['a:fill:joint', 'a:stroke']],
    ['both paints at 0.25', strokedNode('a', 0, { opacity: 0.25 }), ['a:fill:joint', 'a:stroke']],
    ['both paints at 0.999', strokedNode('a', 0, { opacity: 0.999 }), ['a:fill:joint', 'a:stroke']],
    ['both paints at 1', strokedNode('a', 0, { opacity: 1 }), ['a:fill', 'a:stroke']],
    ['both paints at 0', strokedNode('a', 0, { opacity: 0 }), ['a:fill', 'a:stroke']],
    ['fill only at 0.5', pathNode('a', 0, { opacity: 0.5 }), ['a:fill']],
    ['stroke only at 0.5', strokedNode('a', 0, { opacity: 0.5, fill: null }), ['a:stroke']],
    [
      'width-0 stroke at 0.5',
      strokedNode('a', 0, { opacity: 0.5, stroke: pathStroke({ width: 0 }) }),
      ['a:fill'],
    ],
  ];
  for (const [name, node, expected] of cases) {
    it(`ST-A15: ${name}`, () => {
      for (const fringeBuilder of [undefined, buildPathFringe]) {
        const h = jointHarness({
          nodes: [node],
          ...(fringeBuilder === undefined ? {} : { fringeBuilder }),
        });
        expect(h.shape()).toEqual(expected);
        const joint = h.prepare().draws.filter((draw) => draw.composite === 'joint-fill');
        expect(
          h.packet().mesh!.draws.filter((draw) => draw.composite === 'joint-fill'),
        ).toHaveLength(joint.length);
        for (const draw of h.packet().mesh!.draws) {
          if (draw.composite === undefined) expect(Object.keys(draw)).not.toContain('composite');
        }
      }
    });
  }

  it('ST-A15: a culled fill keeps a single-paint stroke draw at 0.5', () => {
    // The fill box [650, 660] misses the viewport; the miter-8 stroke box reaches it.
    const h = jointHarness({
      nodes: [
        strokedNode('a', 650, {
          opacity: 0.5,
          stroke: pathStroke({ width: 2, join: 'miter', miterLimit: 8 }),
        }),
      ],
    });
    expect(h.shape()).toEqual(['a:stroke']);
  });

  it('ST-A15: the joint fill draw sits at the fill position, consecutive before the stroke draw', () => {
    const h = jointHarness({
      nodes: [
        rectangleNode('r0', 0),
        strokedNode('a', 20, { opacity: 0.5 }),
        rectangleNode('r1', 40),
      ],
    });
    h.prepare();
    const draws = h.packet().mesh!.draws;
    expect(draws.map((draw) => [draw.position, draw.composite ?? null])).toEqual([
      [1, 'joint-fill'],
      [1, null],
    ]);
  });

  it('ST7-D8 (seeded): the joint draw after the stroke draw fails the order check', () => {
    const h = jointHarness({
      nodes: [strokedNode('a', 0, { opacity: 0.5 })],
      seededDefect: 'ST7-D8',
    });
    expect(h.shape()).not.toEqual(['a:fill:joint', 'a:stroke']);
    expect(h.shape()).toEqual(['a:stroke', 'a:fill:joint']);
  });

  it('ST-A15: a failing paint still hides the whole path; no overlay is built', () => {
    const h = jointHarness({ nodes: [strokedNode('a', 0, { opacity: 0.5 })] });
    h.ports.stroke.script = {
      request: (request) => ({
        requestId: request.requestId,
        toleranceExponent: request.toleranceExponent,
        status: 'failed',
        code: 'work-limit',
      }),
    };
    const frame = h.prepare();
    expect(frame.draws).toEqual([]);
    expect(frame.notices.map((notice) => notice.failureCode)).toEqual(['work-limit']);
    expect(h.pipeline.getOverlayBuildCount()).toBe(0);
  });
});

describe('ST-U7 byte identity outside the joint condition (ST-A15, ST7-J8)', () => {
  it('ST-A15: scenes that never meet the joint condition pack the pre-ST-U7 bytes', () => {
    expect(neverJointDigest(undefined)).toBe(PRE_ST_U7_DIGESTS.regionOnly);
    expect(neverJointDigest(buildPathFringe)).toBe(PRE_ST_U7_DIGESTS.fringed);
  });

  it('ST-A15: after leaving the joint condition, records return to ST-U6 bytes (overlay ranges excluded)', () => {
    const nodes = (opacity: number) => [strokedNode('a', 0, { opacity }), pathNode('f', 20)];
    const plain = jointHarness({ nodes: nodes(1), fringeBuilder: buildPathFringe });
    const toggled = jointHarness({ nodes: nodes(0.5), fringeBuilder: buildPathFringe });
    toggled.prepare();
    toggled.source.acknowledge(receiptOf(toggled.packet()));
    toggled.replace(nodes(1));
    plain.prepare();
    toggled.prepare();
    const slot = toggled.pipeline.getPathSlots().get('a')!;
    expect(instanceRecord(toggled.packet(), slot)).toEqual(instanceRecord(plain.packet(), slot));
    expect(instanceRecord(toggled.packet(), slot)![15]).toBe(0);
  });
});

describe('ST-U7 joint records and overlay ranges (addendum section 4.5)', () => {
  it('ST-A15: the fill record holds the overlay bases, the fill feature base and stroke slot + 1', () => {
    const h = jointHarness({
      nodes: [strokedNode('a', 0, { opacity: 0.5 })],
      fringeBuilder: buildPathFringe,
    });
    const frame = h.prepare();
    const packet = h.packet();
    const shadow = new MeshShadow();
    shadow.apply(packet);
    const fillSlot = h.pipeline.getPathSlots().get('a')!;
    const strokeSlot = h.pipeline.getStrokeSlots().get('a')!;
    const joint = frame.draws[0]!;
    const overlay = joint.overlay!.data;
    const record = (slot: number) =>
      Array.from({ length: 16 }, (_, word) => shadow.u32('meshInstances', 64 * slot + 4 * word));
    const fill = record(fillSlot);
    const stroke = record(strokeSlot);
    expect(fill[15]).toBe(strokeSlot + 1);
    expect(stroke[15]).toBe(0);
    const draw = packet.mesh!.draws[0]!;
    expect(draw).toMatchObject({ instance: fillSlot, composite: 'joint-fill' });
    expect(draw.triangleCount).toBe(overlay.triangles.length / 8);
    // The overlay's triangle records and positions are written at the draw's range and word 12.
    for (let index = 0; index < draw.triangleCount; index += 1) {
      for (let word = 0; word < 8; word += 1) {
        expect(shadow.u32('meshTriangles', 32 * (draw.firstTriangle + index) + 4 * word)).toBe(
          overlay.triangles[8 * index + word],
        );
      }
    }
    for (let vertex = 0; vertex < overlay.positions.length / 2; vertex += 1) {
      expect(shadow.f32('meshPositions', 8 * (fill[12]! + vertex))).toBe(
        overlay.positions[2 * vertex],
      );
      expect(shadow.f32('meshPositions', 8 * (fill[12]! + vertex) + 4)).toBe(
        overlay.positions[2 * vertex + 1],
      );
    }
    for (let entry = 0; entry < overlay.lists.length; entry += 1) {
      expect(shadow.u32('meshFeatureLists', 4 * (fill[13]! + entry))).toBe(overlay.lists[entry]);
    }
    // Word 14 is the fill variant's feature base; the fill variant itself stays resident.
    const features = joint.fringe!.data.features;
    expect(features.length).toBeGreaterThan(0);
    for (let word = 0; word < features.length; word += 1) {
      expect(shadow.u32('meshFeatures', 64 * fill[14]! + 4 * word)).toBe(features[word]);
    }
    // Bit-31 indices address the stroke variant's own positions through its record's word 12.
    const strokeIndices = Array.from(overlay.triangles).filter(
      (value, index) => index % 8 < 3 && (value & JOINT_STROKE_INDEX) !== 0,
    );
    expect(strokeIndices.length).toBeGreaterThan(0);
    const strokeMesh = frame.draws[1]!.mesh;
    for (const index of strokeIndices) {
      const local = index & 0x7fff_ffff;
      expect(shadow.f32('meshPositions', 8 * (stroke[12]! + local))).toBe(
        Math.fround(
          strokeMesh.positions[2 * local]! -
            (strokeMesh.bounds.minX / 2 + strokeMesh.bounds.maxX / 2),
        ),
      );
    }
  });

  it('ST-A15 (ST7-D9, ST7-D7): word 15 follows a stroke slot change in the same packet', () => {
    const h = jointHarness({ nodes: [strokedNode('a', 0, { opacity: 0.5 })] });
    const frame = h.prepare();
    const fillSlot = h.pipeline.getPathSlots().get('a')!;
    const run = (defect?: MeshPackerSeededDefect) => {
      const packer = new PathMeshPacker(defect === undefined ? {} : { seededDefect: defect });
      const resident = h.pipeline.getResidentIds();
      const slots = h.pipeline.getPathSlots();
      const pack = (strokeSlot: number) => {
        const draws = frame.draws.map((draw) =>
          draw.paint === 'stroke' ? { ...draw, slot: strokeSlot } : draw,
        );
        const output = packer.prepare({
          generation: 1,
          draws,
          slots,
          strokeSlots: new Map([['a', strokeSlot]]),
          resident,
          frameLanes: [0, 0, 1, 1, 640, 360, 0, 0],
        });
        const write = output.writes.find(
          (candidate) =>
            candidate.resourceId === 'meshInstances' &&
            candidate.byteOffset <= 64 * fillSlot &&
            candidate.byteOffset + candidate.bytes.byteLength > 64 * fillSlot,
        );
        packer.acknowledge(
          output.writes.map((candidate) => ({
            resourceId: candidate.resourceId,
            incarnation: candidate.incarnation,
            records: candidate.records,
          })),
        );
        if (write === undefined) return null;
        return words(write.bytes, 'u32')[(64 * fillSlot - write.byteOffset) / 4 + 15];
      };
      return [pack(1), pack(3), pack(3)];
    };
    // Correct: the slot moves from 1 to 3 and the record is rewritten in that packet; the third
    // packet has nothing to rewrite.
    expect(run()).toEqual([2, 4, null]);
    // ST7-D9 keeps the previous frame's word 15; ST7-D7 leaves it 0. Both fail the bytes check.
    expect(run('ST7-D9')).not.toEqual([2, 4, null]);
    expect(run('ST7-D7')).not.toEqual([2, 4, null]);
  });

  it('ST-A15: a released stroke slot ends the joint condition, so word 15 is 0 before reuse', () => {
    const h = jointHarness({ nodes: [strokedNode('a', 0, { opacity: 0.5 })] });
    h.prepare();
    const fillSlot = h.pipeline.getPathSlots().get('a')!;
    const strokeSlot = h.pipeline.getStrokeSlots().get('a')!;
    expect(instanceRecord(h.packet(), fillSlot)![15]).toBe(strokeSlot + 1);
    h.source.acknowledge(receiptOf(h.packet()));
    h.replace([strokedNode('a', 0, { opacity: 0.5, stroke: null }), pathNode('b', 20)]);
    expect(h.shape()).toEqual(['a:fill', 'b:fill']);
    // b reuses the released stroke slot; a's record is rewritten with word 15 = 0 in that packet.
    expect(h.pipeline.getPathSlots().get('b')).toBe(strokeSlot);
    expect(instanceRecord(h.packet(), fillSlot)![15]).toBe(0);
  });
});

describe('ST-U7 overlay cache, accounting and failures (addendum section 4.6)', () => {
  it('ST-A15: one build per variant pair, reused across opacity toggles, zero port calls on opacity changes', () => {
    const nodes = (opacity: number) => [strokedNode('a', 0, { opacity })];
    const h = jointHarness({ nodes: nodes(0.5), fringeBuilder: buildPathFringe });
    h.prepare();
    const calls = [h.ports.fill.callCount, h.ports.stroke.callCount];
    for (const opacity of [1, 0.25, 0, 0.75, 1, 0.5]) {
      h.replace(nodes(opacity));
      h.prepare();
    }
    expect([h.ports.fill.callCount, h.ports.stroke.callCount]).toEqual(calls);
    expect(h.pipeline.getOverlayBuildCount()).toBe(1);
    // A zoom that changes the served fringe variants builds a second overlay; at most two are
    // kept per node, least recently served first.
    h.setZoom(4);
    h.prepare();
    expect(h.pipeline.getOverlayBuildCount()).toBe(2);
    h.setZoom(1);
    h.prepare();
    expect(h.pipeline.getOverlayBuildCount()).toBe(2);
    h.setZoom(0.25);
    h.prepare();
    expect(h.pipeline.getOverlayBuildCount()).toBe(3);
    h.setZoom(4);
    h.prepare();
    expect(h.pipeline.getOverlayBuildCount()).toBe(4);
  });

  it('ST-A15: overlay bytes count in the budget and are evicted with a parent', () => {
    const h = jointHarness({
      nodes: [strokedNode('a', 0, { opacity: 0.5 }), pathNode('b', 20)],
      fringeBuilder: buildPathFringe,
    });
    const frame = h.prepare();
    const overlay = frame.draws[0]!.overlay!;
    const overlayBytes =
      overlay.data.positions.byteLength +
      overlay.data.triangles.byteLength +
      overlay.data.lists.byteLength;
    const joint = h.pipeline.getStatistics().bytes;
    h.replace([strokedNode('a', 0, { opacity: 1 }), pathNode('b', 20)]);
    h.prepare();
    // At opacity 1 the overlay stays cached and counted.
    expect(h.pipeline.getStatistics().bytes).toBe(joint);
    expect(h.pipeline.getResidentIds().has(overlay.id)).toBe(true);
    // Removing the stroke drops its entry, which makes the overlay unreachable.
    h.replace([strokedNode('a', 0, { opacity: 1, stroke: null }), pathNode('b', 20)]);
    h.prepare();
    expect(h.pipeline.getResidentIds().has(overlay.id)).toBe(false);
    const strokeLess = h.pipeline.getStatistics().bytes;
    expect(joint - strokeLess).toBeGreaterThan(overlayBytes);

    // Budget eviction: with a budget that cannot hold a's entries once a is not drawn, the fill
    // entry goes and takes its overlay with it.
    const tight = jointHarness({
      nodes: [strokedNode('a', 0, { opacity: 0.5 }), pathNode('b', 20)],
      fringeBuilder: buildPathFringe,
      limits: { byteBudget: 1 },
    });
    const tightFrame = tight.prepare();
    const tightOverlay = tightFrame.draws[0]!.overlay!.id;
    expect(tight.pipeline.getResidentIds().has(tightOverlay)).toBe(true);
    tight.replace([strokedNode('a', 0, { opacity: 0.5, visible: false }), pathNode('b', 20)]);
    tight.prepare();
    expect(tight.pipeline.getResidentIds().has(tightOverlay)).toBe(false);
    expect(tight.pipeline.getStatistics().evictions).toBeGreaterThan(0);
  });

  it('ST-A15 (ST7-F11, ST7-F12): an overlay at the work cap is built; at the work cap + 1 it is overlay-unsupported once, with paint null', () => {
    const probe = jointHarness({
      nodes: [strokedNode('a', 0, { opacity: 0.5 })],
      fringeBuilder: buildPathFringe,
    });
    const work = probe.prepare().draws[0]!.overlay!.data.work;
    expect(work.exactTests).toBeGreaterThan(0);
    expect(work.steinerPoints).toBeGreaterThan(0);
    const run = (limits: Partial<PathMeshLimits>) =>
      jointHarness({
        nodes: [strokedNode('a', 0, { opacity: 0.5 }), pathNode('f', 20)],
        fringeBuilder: buildPathFringe,
        limits,
      });
    // ST7-F11: the build's own counts as the caps.
    const atCap = run({
      overlayExactTests: work.exactTests,
      overlaySteinerPoints: work.steinerPoints,
    });
    expect(atCap.shape()).toEqual(['a:fill:joint', 'a:stroke', 'f:fill']);
    // ST7-F12: one more test than the cap allows, and one more Steiner point.
    for (const limits of [
      { overlayExactTests: work.exactTests - 1 },
      { overlaySteinerPoints: work.steinerPoints - 1 },
    ]) {
      const over = run(limits);
      const first = over.prepare();
      expect(first.draws.map((draw) => draw.nodeId)).toEqual(['f']);
      expect(first.notices).toEqual([
        {
          nodeId: 'a',
          failureScope: 'renderer',
          failureCode: 'overlay-unsupported',
          toleranceExponent: null,
          paint: null,
        },
      ]);
      // Once per mark: later frames and opacity toggles queue nothing and build nothing more.
      expect(over.prepare().notices).toEqual([]);
      over.replace([strokedNode('a', 0, { opacity: 1 }), pathNode('f', 20)]);
      expect(over.shape()).toEqual(['a:fill', 'a:stroke', 'f:fill']);
      over.replace([strokedNode('a', 0, { opacity: 0.25 }), pathNode('f', 20)]);
      const again = over.prepare();
      expect(again.draws.map((draw) => draw.nodeId)).toEqual(['f']);
      expect(again.notices).toEqual([]);
      expect(over.pipeline.getOverlayBuildCount()).toBe(1);
      // Both cached meshes stay.
      expect(over.pipeline.getStatistics().entries).toBe(3);
      expect([over.ports.fill.callCount, over.ports.stroke.callCount]).toEqual([1, 1]);
    }
    expect(
      pathMeshNoticeDiagnostic(
        {
          nodeId: 'a',
          failureScope: 'renderer',
          failureCode: 'overlay-unsupported',
          toleranceExponent: null,
          paint: null,
        },
        3,
      ).message,
    ).toBe('Path a is not drawn (renderer overlay-unsupported).');
  });

  it('ST-A15: the pipeline overlay equals the builder output for the served variant pair', () => {
    const h = jointHarness({
      nodes: [strokedNode('a', 0, { opacity: 0.5 })],
      fringeBuilder: buildPathFringe,
    });
    const [fill, stroke] = h.prepare().draws;
    const direct = buildJointOverlay({
      fill: { mesh: fill!.mesh, fringeBucket: fill!.fringeBucket },
      stroke: { mesh: stroke!.mesh, fringeBucket: stroke!.fringeBucket },
    });
    expect(direct.status).toBe('built');
    if (direct.status !== 'built') return;
    expect(fill!.overlay!.data.triangles).toEqual(direct.overlay.triangles);
    expect(fill!.overlay!.data.positions).toEqual(direct.overlay.positions);
    expect(fill!.overlay!.data.lists).toEqual(direct.overlay.lists);
  });
});

describe('ST-U7 device loss (ST-A17, unit form)', () => {
  it('ST-A17: a generation change rewrites the joint records and overlay ranges byte for byte with zero port calls and zero overlay builds', () => {
    const h = jointHarness({
      nodes: [
        strokedNode('a', 0, { opacity: 0.5 }),
        rectangleNode('r', 40),
        strokedNode('b', 20, { opacity: 0.25 }),
      ],
      fringeBuilder: buildPathFringe,
    });
    h.setZoom(1.25, { x: -3.5, y: 1.75 });
    const shadow = new MeshShadow();
    h.prepare();
    const first = h.packet();
    shadow.apply(first);
    h.source.acknowledge(receiptOf(first));
    const calls = [h.ports.fill.callCount, h.ports.stroke.callCount];
    const builds = h.pipeline.getOverlayBuildCount();
    expect(builds).toBe(2);
    h.prepare({ ...target, generation: 2 });
    const lost = h.packet();
    expect(lost.mode).toBe('reconstruct');
    expect([h.ports.fill.callCount, h.ports.stroke.callCount]).toEqual(calls);
    expect(h.pipeline.getOverlayBuildCount()).toBe(builds);
    const covered = new Map<MeshResourceId, Set<number>>();
    for (const write of lost.mesh!.writes) {
      const before = shadow.bytes.get(write.resourceId)!;
      expect(write.bytes).toEqual(
        before.subarray(write.byteOffset, write.byteOffset + write.bytes.byteLength),
      );
      const indices = covered.get(write.resourceId) ?? new Set<number>();
      for (const index of recordIndices(write.records)) indices.add(index);
      covered.set(write.resourceId, indices);
    }
    // Every triangle the joint draws read is rewritten.
    for (const draw of lost.mesh!.draws) {
      for (
        let index = draw.firstTriangle;
        index < draw.firstTriangle + draw.triangleCount;
        index += 1
      )
        expect(covered.get('meshTriangles')!.has(index)).toBe(true);
    }
    expect(lost.mesh!.draws).toEqual(first.mesh!.draws);
    expect(lost.mesh!.draws.filter((draw) => draw.composite === 'joint-fill')).toHaveLength(2);
  });
});
