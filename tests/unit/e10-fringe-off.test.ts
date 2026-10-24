import type {
  FillMesh,
  RendererInvalidationTarget,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
} from '@vector-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import { buildPathFringe } from '../../packages/renderer-core/src/path-fringe.js';
import type { PrimitivePacket } from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { MESH_STRIDES } from '../../packages/renderer-core/src/path-mesh-packet.js';
import {
  ScriptedFillMeshPort,
  createCountingPort,
  identity,
  okResult,
  pathNode,
  rectangleNode,
  target,
} from '../support/v3a-path-harness.js';
import { ScriptedStrokeMeshPort, strokedNode } from '../support/st-u6-stroke-harness.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';

// E10 contract, unit E10-U1 (docs/plans/d9-e10-renderer-test-hooks-contract.md, section 3.1):
// the renderer-core test hooks for A08. fringeForTesting 'off' draws every path paint
// region-only, and getLastDrawRecordForTesting reports each mesh draw's fringe state and
// triangle split. Criteria E10-A2 and E10-A6. Functional evidence only: precision is UNVERIFIED
// against the 0.25 physical-pixel target.

// E10-A2's spy: the service's builder is this module's export, wrapped to count calls.
vi.mock('../../packages/renderer-core/src/path-fringe.js', async (original) => {
  const actual = await original<typeof import('../../packages/renderer-core/src/path-fringe.js')>();
  return { ...actual, buildPathFringe: vi.fn(actual.buildPathFringe) };
});
const builderSpy = vi.mocked(buildPathFringe);

const noInvalidation: RendererInvalidationTarget = {
  invalidate: () => undefined,
  setMode: () => undefined,
};

/** A convex counterclockwise n-gon fan with its n boundary edges. */
function polygonMesh(n: number, radius = 10): FillMesh {
  const positions: number[] = [];
  for (let index = 0; index < n; index += 1) {
    const angle = (2 * Math.PI * index) / n;
    positions.push(radius * Math.cos(angle), radius * Math.sin(angle));
  }
  const indices: number[] = [];
  for (let index = 1; index + 1 < n; index += 1) indices.push(0, index, index + 1);
  const boundaryEdges: number[] = [];
  for (let index = 0; index < n; index += 1) boundaryEdges.push(index, (index + 1) % n);
  const xs = positions.filter((_, index) => index % 2 === 0);
  const ys = positions.filter((_, index) => index % 2 === 1);
  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    boundaryEdges: Uint32Array.from(boundaryEdges),
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    },
  };
}

function snapshot(nodes: readonly RenderNodeSnapshot[], revision = 1): RenderSceneSnapshot {
  return { identity, revision, nodes, rootOrder: nodes.map((node) => node.id) };
}

/**
 * E10-A1's scene parts: a fill, a stroked path (fill and stroke), a translucent stroked path
 * (a joint fill draw and its stroke, ST-U7) and an analytic rectangle.
 */
function scene(): RenderSceneSnapshot {
  return snapshot([
    pathNode('fill', 0),
    strokedNode('stroked', 40),
    strokedNode('joint', 80, { opacity: 0.5 }),
    rectangleNode('rect', 120),
  ]);
}

function service(fringe?: 'on' | 'off', fillPort = createCountingPort()) {
  const result = new PrimitiveRendererService(noInvalidation, {
    fillMesh: fillPort,
    strokeMesh: new ScriptedStrokeMeshPort(),
    ...(fringe === undefined ? {} : { fringeForTesting: fringe }),
  });
  result.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  return result;
}

function prepare(renderer: PrimitiveRendererService): PrimitivePacket {
  const packet = renderer.prepare(target);
  expect(packet).not.toBeNull();
  renderer.acknowledge(receiptOf(packet!));
  return packet!;
}

/** The u32 words of every meshTriangles record written by a packet. */
function triangleRecords(packet: PrimitivePacket): Uint32Array[] {
  const records: Uint32Array[] = [];
  for (const write of packet.mesh!.writes) {
    if (write.resourceId !== 'meshTriangles') continue;
    const words = new Uint32Array(
      write.bytes.buffer.slice(
        write.bytes.byteOffset,
        write.bytes.byteOffset + write.bytes.byteLength,
      ),
    );
    const stride = MESH_STRIDES.meshTriangles / 4;
    for (let offset = 0; offset < words.length; offset += stride) {
      records.push(words.subarray(offset, offset + stride));
    }
  }
  return records;
}

/** Packet content without symbols, for equality across services. */
function serialize(packet: PrimitivePacket): unknown {
  return JSON.parse(
    JSON.stringify(packet, (_key, value: unknown) => {
      if (typeof value === 'symbol') return 'symbol';
      if (value instanceof Uint8Array) return Array.from(value);
      return value;
    }),
  );
}

describe('E10-U1 fringe-off (E10-A2)', () => {
  it("E10-A2: 'off' draws every paint region-only and never calls the builder", () => {
    builderSpy.mockClear();
    const renderer = service('off');
    expect(renderer.replaceSnapshot(scene()).status).toBe('applied');
    const packet = prepare(renderer);
    expect(builderSpy).not.toHaveBeenCalled();
    const record = renderer.getLastDrawRecordForTesting()!;
    expect(record.draws.every((draw) => draw.fringe === 'region-only-off')).toBe(true);
    expect(record.draws.map((draw) => [draw.nodeId, draw.paint, draw.composite])).toEqual([
      ['fill', 'fill', 'plain'],
      ['stroked', 'fill', 'plain'],
      ['stroked', 'stroke', 'plain'],
      ['joint', 'fill', 'joint-fill'],
      ['joint', 'stroke', 'plain'],
    ]);
    const joint = record.draws[3]!;
    expect([joint.regionTriangles, joint.exteriorTriangles]).toEqual([null, null]);
    // Every packed plain record has listOffset, listCount and role 0 (c = 1 in the shader).
    // The joint draw's overlay records are checked by the ST7-F7, F8 and F14 fixtures.
    const jointPlacement = packet.mesh!.draws[3]!;
    const records = triangleRecords(packet).filter(
      (_, index) =>
        index < jointPlacement.firstTriangle ||
        index >= jointPlacement.firstTriangle + jointPlacement.triangleCount,
    );
    expect(records.length).toBeGreaterThan(0);
    for (const words of records) expect(Array.from(words.subarray(3, 6))).toEqual([0, 0, 0]);
  });

  it("E10-A2: 'on' builds fringes and emits packets equal to the default", () => {
    const left = service('on');
    const right = service();
    for (const renderer of [left, right]) renderer.replaceSnapshot(scene());
    builderSpy.mockClear();
    const leftPacket = prepare(left);
    expect(builderSpy).toHaveBeenCalled();
    const rightPacket = prepare(right);
    expect(serialize(leftPacket)).toEqual(serialize(rightPacket));
    const plain = left.getLastDrawRecordForTesting()!.draws.filter((d) => d.composite === 'plain');
    expect(plain.length).toBeGreaterThan(0);
    for (const draw of plain) {
      expect(draw.fringe).toBe('built');
      expect(draw.exteriorTriangles).toBeGreaterThan(0);
    }
    expect(left.getLastDrawRecordForTesting()).toEqual(right.getLastDrawRecordForTesting());
  });

  it("E10-A2: 'off' never queues a fringe notice, even above the builder work cap", () => {
    const port = new ScriptedFillMeshPort({
      request: (request) => okResult(request, polygonMesh(130)),
    });
    const renderer = service('off', port);
    renderer.replaceSnapshot(snapshot([pathNode('big', 0)]));
    for (let frame = 0; frame < 2; frame += 1) {
      const packet = prepare(renderer);
      expect(packet.mesh!.notices.map((notice) => notice.failureCode)).toEqual([]);
      expect(renderer.getLastDrawRecordForTesting()!.draws[0]!.fringe).toBe('region-only-off');
    }
  });

  it('E10-A2: an invalid fringeForTesting value is a host programming error', () => {
    expect(
      () =>
        new PrimitiveRendererService(noInvalidation, {
          fillMesh: createCountingPort(),
          fringeForTesting: 'none' as 'off',
        }),
    ).toThrow(TypeError);
  });
});

describe('E10-U1 draw record (E10-A6)', () => {
  it('E10-A6: region plus exterior equals the triangle count on plain draws; joint draws are null', () => {
    const renderer = service();
    renderer.replaceSnapshot(scene());
    const packet = prepare(renderer);
    const record = renderer.getLastDrawRecordForTesting()!;
    expect(record.draws.map((draw) => draw.triangleCount)).toEqual(
      packet.mesh!.draws.map((draw) => draw.triangleCount),
    );
    for (const [index, draw] of record.draws.entries()) {
      const joint = packet.mesh!.draws[index]!.composite === 'joint-fill';
      expect(draw.composite).toBe(joint ? 'joint-fill' : 'plain');
      if (joint) {
        expect(draw.regionTriangles).toBeNull();
        expect(draw.exteriorTriangles).toBeNull();
      } else {
        expect(draw.regionTriangles! + draw.exteriorTriangles!).toBe(draw.triangleCount);
      }
    }
  });

  it('E10-A6: region-only-cap on the frame that first serves an entry above the cap and on later frames', () => {
    const port = new ScriptedFillMeshPort({
      request: (request) => okResult(request, polygonMesh(130)),
    });
    const renderer = service(undefined, port);
    renderer.replaceSnapshot(snapshot([pathNode('big', 0)]));
    const first = prepare(renderer);
    expect(first.mesh!.notices.map((notice) => notice.failureCode)).toEqual(['fringe-work-cap']);
    expect(renderer.getLastDrawRecordForTesting()!.draws[0]).toMatchObject({
      fringe: 'region-only-cap',
      exteriorTriangles: 0,
    });
    renderer.setCamera({ position: { x: 3, y: 0 }, zoom: 1 });
    const second = prepare(renderer);
    expect(second.mesh!.notices).toEqual([]);
    expect(renderer.getLastDrawRecordForTesting()!.draws[0]!.fringe).toBe('region-only-cap');
  });

  it('E10-A6: prepareSerial advances once per non-null prepare; null before the first and without a port', () => {
    expect(new PrimitiveRendererService(noInvalidation).getLastDrawRecordForTesting()).toBeNull();
    const renderer = service();
    expect(renderer.getLastDrawRecordForTesting()).toBeNull();
    renderer.replaceSnapshot(scene());
    prepare(renderer);
    expect(renderer.getLastDrawRecordForTesting()!.prepareSerial).toBe(1);
    prepare(renderer);
    expect(renderer.getLastDrawRecordForTesting()!.prepareSerial).toBe(2);
  });
});
