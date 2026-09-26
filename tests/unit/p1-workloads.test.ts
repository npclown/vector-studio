import { describe, expect, it } from 'vitest';
import {
  P1_CONFIGURATION,
  P1_SCENARIOS,
  cameraAt,
  createP1Workload,
  expectedVisible,
  nodeAt,
} from '../../apps/playground/src/p1-workloads.js';
import type { RenderNodeSnapshot } from '@vector-studio/contracts';

function primitive(node: RenderNodeSnapshot) {
  if (node.kind !== 'primitive') throw new Error('P1 workloads contain only primitives.');
  return node;
}

function guardedVisibleCount(
  nodes: readonly RenderNodeSnapshot[],
  camera: ReturnType<typeof cameraAt>,
): number {
  const guard = 2 / camera.zoom;
  const minimumX = camera.position.x;
  const minimumY = camera.position.y;
  const maximumX = minimumX + 1280 / camera.zoom;
  const maximumY = minimumY + 720 / camera.zoom;
  return nodes.filter((node) => {
    const value = primitive(node);
    const stroke = (value.style.stroke?.width ?? 0) / 2;
    const local =
      value.geometry.kind === 'line'
        ? {
            minX: Math.min(value.geometry.start.x, value.geometry.end.x) - stroke,
            minY: Math.min(value.geometry.start.y, value.geometry.end.y) - stroke,
            maxX: Math.max(value.geometry.start.x, value.geometry.end.x) + stroke,
            maxY: Math.max(value.geometry.start.y, value.geometry.end.y) + stroke,
          }
        : {
            minX: -stroke,
            minY: -stroke,
            maxX: value.geometry.width + stroke,
            maxY: value.geometry.height + stroke,
          };
    const corners = (
      [
        [local.minX, local.minY],
        [local.minX, local.maxY],
        [local.maxX, local.minY],
        [local.maxX, local.maxY],
      ] as const
    ).map(([x, y]) => ({
      x: value.transform[0] * x + value.transform[2] * y + value.transform[4],
      y: value.transform[1] * x + value.transform[3] * y + value.transform[5],
    }));
    const bounds = {
      minX: Math.min(...corners.map(({ x }) => x)),
      minY: Math.min(...corners.map(({ y }) => y)),
      maxX: Math.max(...corners.map(({ x }) => x)),
      maxY: Math.max(...corners.map(({ y }) => y)),
    };
    return (
      bounds.maxX + guard >= minimumX &&
      bounds.minX - guard <= maximumX &&
      bounds.maxY + guard >= minimumY &&
      bounds.minY - guard <= maximumY
    );
  }).length;
}

describe('P1 deterministic workloads', () => {
  it('builds each frozen population with exact identifiers, root order, geometry, and styles', () => {
    const oneK = createP1Workload('p1-pan-zoom-1k/v1');
    const tenK = createP1Workload('p1-pan-zoom-10k/v1');
    const cull = createP1Workload('p1-cull-10k/v1');
    expect(P1_SCENARIOS).toEqual([
      'p1-pan-zoom-1k/v1',
      'p1-pan-zoom-10k/v1',
      'p1-cull-10k/v1',
      'p1-single-transform-10k/v1',
    ]);
    expect(oneK.snapshot.identity).toEqual({
      documentId: 'p1-benchmark',
      pageId: 'p1-pan-zoom-1k/v1',
    });
    expect(oneK.snapshot.revision).toBe(0);
    expect(oneK.snapshot.nodes).toHaveLength(1000);
    expect(tenK.snapshot.nodes).toHaveLength(10000);
    expect(createP1Workload('p1-pan-zoom-1k/v1').snapshot).not.toBe(oneK.snapshot);
    expect(createP1Workload('p1-pan-zoom-1k/v1').snapshot.nodes[0]).not.toBe(
      oneK.snapshot.nodes[0],
    );
    expect(cull.snapshot.rootOrder).toHaveLength(10000);
    expect(cull.snapshot.rootOrder.slice(0, 3)).toEqual(['p1-00000', 'p1-00001', 'p1-00002']);
    expect(cull.snapshot.rootOrder.at(-1)).toBe('p1-09999');
    expect(cull.snapshot.nodes.slice(0, 4)).toMatchObject([
      {
        id: 'p1-00000',
        transform: [1, 0, 0, 1, 8.5, 9],
        geometry: { kind: 'rectangle', width: 3, height: 2, cornerRadii: [0, 0, 0, 0] },
        opacity: 0.5,
      },
      {
        id: 'p1-00001',
        transform: [1, 0, 0, 1, 28.5, 8.5],
        geometry: { kind: 'rectangle', width: 3, height: 3, cornerRadii: [0.5, 1, 0.5, 1] },
        opacity: 0.75,
      },
      {
        id: 'p1-00002',
        transform: [1, 0, 0, 1, 48.5, 9],
        geometry: { kind: 'ellipse', width: 3, height: 2 },
        opacity: 1,
      },
      {
        id: 'p1-00003',
        transform: [1, 0, 0, 1, 70, 10],
        geometry: { kind: 'line', start: { x: -1.75, y: 0 }, end: { x: 1.75, y: 0 } },
        opacity: 0.5,
      },
    ]);
    expect(primitive(cull.snapshot.nodes[0]!).style).toEqual({
      fill: {
        r: 0.4541176470588235,
        g: 0.40941176470588236,
        b: 0.21176470588235297,
        a: 0.7841176470588236,
      },
      stroke: {
        color: { r: 0.7882352941176471, g: 0.5905882352941177, b: 0.5458823529411765, a: 0.65 },
        width: 0.5,
      },
    });
    expect(primitive(cull.snapshot.nodes[3]!).style.fill).toBeNull();
  });

  it('uses the literal seed arithmetic and preserves the documented pan/zoom trajectory', () => {
    const first = createP1Workload('p1-pan-zoom-1k/v1').snapshot.nodes[0]!;
    expect(first.transform).toEqual([1, 0, 0, 1, 178.3470588235294, 158.69803921568626]);
    expect(cameraAt('p1-pan-zoom-1k/v1', 0)).toEqual({
      position: { x: 20, y: 20 },
      zoom: 1.093301270189222,
    });
    expect(cameraAt('p1-pan-zoom-10k/v1', 2500)).toEqual({
      position: { x: 40, y: 10 },
      zoom: 1.075,
    });
    expect(cameraAt('p1-pan-zoom-1k/v1', 10000)).toEqual(cameraAt('p1-pan-zoom-1k/v1', 0));
    expect(cameraAt('p1-cull-10k/v1', 7623.5)).toEqual({ position: { x: 0, y: 0 }, zoom: 1.5 });
  });

  it('returns exact visibility requirements throughout every phase', () => {
    for (const scenario of P1_SCENARIOS) {
      expect(expectedVisible(scenario)).toBe(
        scenario.includes('pan-zoom') ? (scenario.includes('1k/') ? 1000 : 10000) : 1032,
      );
    }
    const workload = createP1Workload('p1-single-transform-10k/v1');
    for (const elapsedMs of [0, 4999.9, 5000, 10000, 14999.9]) {
      expect(expectedVisible(workload.scenario)).toBe(1032);
      const node = nodeAt(workload, elapsedMs)!;
      expect(node.id).toBe('p1-00000');
      expect(primitive(node).style).toEqual(primitive(workload.snapshot.nodes[0]!).style);
      expect(primitive(node).geometry).toEqual(primitive(workload.snapshot.nodes[0]!).geometry);
    }
  });

  it('independently counts generated guarded primitive bounds throughout the frozen phases', () => {
    const phases = [0, 2500, 5000, 7500, 9999, 14999];
    const oneK = createP1Workload('p1-pan-zoom-1k/v1');
    const tenK = createP1Workload('p1-pan-zoom-10k/v1');
    const cull = createP1Workload('p1-cull-10k/v1');
    const singleTransform = createP1Workload('p1-single-transform-10k/v1');

    for (const elapsedMs of phases) {
      expect(guardedVisibleCount(oneK.snapshot.nodes, cameraAt(oneK.scenario, elapsedMs))).toBe(
        1000,
      );
      expect(guardedVisibleCount(tenK.snapshot.nodes, cameraAt(tenK.scenario, elapsedMs))).toBe(
        10000,
      );
      expect(guardedVisibleCount(cull.snapshot.nodes, cameraAt(cull.scenario, elapsedMs))).toBe(
        1032,
      );
      const replacement = nodeAt(singleTransform, elapsedMs)!;
      const updatedNodes = singleTransform.snapshot.nodes.map((node, index) =>
        index === 0 ? replacement : node,
      );
      expect(guardedVisibleCount(updatedNodes, cameraAt(singleTransform.scenario, elapsedMs))).toBe(
        1032,
      );
    }
  });

  it('moves only the S4 target and returns copied immutable scene values', () => {
    const workload = createP1Workload('p1-single-transform-10k/v1');
    const original = primitive(workload.snapshot.nodes[0]!);
    const start = primitive(nodeAt(workload, 0)!);
    const quarter = primitive(nodeAt(workload, 2500)!);
    const half = primitive(nodeAt(workload, 5000)!);
    expect(start).not.toBe(original);
    expect(start.transform).toEqual(original.transform);
    expect(quarter.transform).toEqual([1, 0, 0, 1, 12.5, 5]);
    expect(half.transform).toEqual([1, 0, 0, 1, 8.5, 1]);
    expect(quarter.style).toEqual({
      fill: {
        r: 0.4541176470588235,
        g: 0.40941176470588236,
        b: 0.21176470588235297,
        a: 0.7841176470588236,
      },
      stroke: {
        color: { r: 0.7882352941176471, g: 0.5905882352941177, b: 0.5458823529411765, a: 0.65 },
        width: 0.5,
      },
    });
    expect(quarter.geometry).toEqual(original.geometry);
    expect(quarter.style).not.toBe(original.style);
    expect(quarter.geometry).not.toBe(original.geometry);
    expect(nodeAt(createP1Workload('p1-cull-10k/v1'), 2500)).toBeNull();
  });

  it('rejects invalid scenarios and invalid elapsed times without mutating its inputs', () => {
    const workload = createP1Workload('p1-single-transform-10k/v1');
    expect(() => createP1Workload('missing' as never)).toThrow(RangeError);
    expect(() => cameraAt('missing' as never, 0)).toThrow(RangeError);
    for (const elapsedMs of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => cameraAt('p1-cull-10k/v1', elapsedMs)).toThrow(RangeError);
      expect(() => nodeAt(workload, elapsedMs)).toThrow(RangeError);
    }
    expect(Object.isFrozen(P1_CONFIGURATION)).toBe(true);
    expect(JSON.parse(JSON.stringify(P1_CONFIGURATION))).toEqual(P1_CONFIGURATION);
  });
});
