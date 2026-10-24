import type {
  FillMeshBatchResult,
  FillMeshPort,
  FillMeshRequest,
  RenderNodeSnapshot,
  RendererDiagnostic,
} from '@vector-studio/contracts';
import {
  PrimitiveRendererService,
  type PathDrawRecordForTesting,
} from '@vector-studio/renderer-core';
import { WebGpuBackend } from '@vector-studio/renderer-webgpu';

// E10 contract, unit E10-U3 (docs/plans/d9-e10-renderer-test-hooks-contract.md, section 6,
// E10-A7): the headed check page of the renderer test hooks. A test-only page, not a host: it
// sets the hook options from its query string (`samples=1|4`, `fringe=on|off`, `dpr`) and draws
// the scenes the spec hands it through the product renderer with a static fill-mesh double that
// fans each convex path's own points, so the meshes are exact and no WASM is loaded. The spec
// (tests/gpu/e10-test-hooks.spec.ts) checks the controls in Node.

export type E10Polygon = Readonly<{ id: string; points: readonly number[] }>;

export type E10RenderResult = Readonly<{
  width: number;
  height: number;
  sampleCount: number;
  devicePixelRatio: number;
  framesSubmittedDelta: number;
  prepareSerialDelta: number;
  meshTriangles: number;
  record: PathDrawRecordForTesting | null;
  rgbaBase64: string;
  counts: Readonly<{ samples: number; base64: string }>;
}>;

export type E10TestHooksApi = Readonly<{
  ready: Promise<
    Readonly<{ supported: boolean; reason: string | null; adapter: Record<string, unknown> }>
  >;
  /** Physical size of the canvas; documents are drawn with camera (0, 0) and zoom 1. */
  physical: Readonly<{ width: number; height: number }>;
  render(polygons: readonly E10Polygon[]): Promise<E10RenderResult>;
  diagnostics(): readonly RendererDiagnostic[];
}>;

declare global {
  interface Window {
    __vectorStudioE10: E10TestHooksApi;
  }
}

const parameters = new URLSearchParams(window.location.search);
const samples = parameters.get('samples') === '1' ? 1 : 4;
const fringe = parameters.get('fringe') === 'off' ? 'off' : 'on';
const dpr = Number(parameters.get('dpr') ?? '1');
// 96 x 48 physical pixels at every tested DPR (1, 1.5, 2).
const physical = Object.freeze({ width: 96, height: 48 });

/** Fans a convex counterclockwise polygon's own points: exact meshes, no kernel. */
class ConvexFanPort implements FillMeshPort {
  readonly portVersion = 0 as const;
  readonly operationId = 'test/e10-convex-fan-double';

  buildFillMeshes(requests: readonly FillMeshRequest[]): FillMeshBatchResult {
    return {
      status: 'ok',
      results: requests.map((request) => {
        const points = Array.from(request.points);
        const count = points.length / 2;
        const indices: number[] = [];
        for (let index = 1; index + 1 < count; index += 1) indices.push(0, index, index + 1);
        const edges: number[] = [];
        for (let index = 0; index < count; index += 1) edges.push(index, (index + 1) % count);
        const xs = points.filter((_, index) => index % 2 === 0);
        const ys = points.filter((_, index) => index % 2 === 1);
        return {
          requestId: request.requestId,
          toleranceExponent: request.toleranceExponent,
          status: 'ok' as const,
          mesh: {
            positions: Float64Array.from(points),
            indices: Uint32Array.from(indices),
            boundaryEdges: Uint32Array.from(edges),
            bounds: {
              minX: Math.min(...xs),
              minY: Math.min(...ys),
              maxX: Math.max(...xs),
              maxY: Math.max(...ys),
            },
          },
        };
      }),
    };
  }
}

function node(polygon: E10Polygon): RenderNodeSnapshot {
  const count = polygon.points.length / 2;
  return {
    id: polygon.id,
    parentId: null,
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: 1,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: ['move', ...Array.from({ length: count - 1 }, () => 'line' as const), 'close'],
      points: polygon.points,
      fillRule: 'nonzero',
    },
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
  };
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
}

const canvas = document.createElement('canvas');
canvas.style.width = `${physical.width / dpr}px`;
canvas.style.height = `${physical.height / dpr}px`;
document.body.append(canvas);
const diagnostics: RendererDiagnostic[] = [];
const backend = new WebGpuBackend({
  sampleCountForTesting: samples,
  frameCaptureForTesting: true,
  countPassForTesting: true,
});
backend.subscribeDiagnostics((event) => diagnostics.push(event));
const service = new PrimitiveRendererService(backend, {
  fillMesh: new ConvexFanPort(),
  fringeForTesting: fringe,
});
backend.attachPrimitiveFrameSource(service);
let revision = 0;

const ready = backend
  .initialize({
    canvas,
    cssSize: { width: physical.width / dpr, height: physical.height / dpr },
    devicePixelRatio: dpr,
  })
  .then((result) => ({
    supported: result.supported,
    reason: result.supported ? null : result.diagnostic.code,
    adapter: result.supported ? { ...result.capabilities.adapter } : {},
  }));

async function render(polygons: readonly E10Polygon[]): Promise<E10RenderResult> {
  revision += 1;
  const applied = service.replaceSnapshot({
    identity: { documentId: 'e10', pageId: 'page' },
    revision,
    nodes: polygons.map(node),
    rootOrder: polygons.map((polygon) => polygon.id),
  });
  if (applied.status !== 'applied') throw new Error(`scene ${applied.status}`);
  service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  // Let the scene's own frame settle first, so the capture's frame is the only one counted.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const frames = backend.getStatistics().framesSubmitted;
  const serial = service.getLastDrawRecordForTesting()?.prepareSerial ?? 0;
  const capture = await backend.captureFrameForTesting({ counts: true });
  const record = service.getLastDrawRecordForTesting();
  return {
    width: capture.width,
    height: capture.height,
    sampleCount: capture.sampleCount,
    devicePixelRatio: capture.devicePixelRatio,
    framesSubmittedDelta: capture.framesSubmitted - frames,
    prepareSerialDelta: (record?.prepareSerial ?? 0) - serial,
    meshTriangles: capture.meshDraws.reduce((sum, draw) => sum + draw.triangleCount, 0),
    record,
    rgbaBase64: base64(capture.rgba),
    counts: {
      samples: capture.counts!.samples,
      base64: base64(new Uint8Array(capture.counts!.data.buffer)),
    },
  };
}

window.__vectorStudioE10 = Object.freeze({
  ready,
  physical,
  render,
  diagnostics: () => [...diagnostics],
});
