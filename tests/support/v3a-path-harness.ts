import type {
  FillMesh,
  FillMeshBatchResult,
  FillMeshFailureCode,
  FillMeshPort,
  FillMeshRequest,
  FillMeshResult,
  RenderNodeSnapshot,
  SceneAffine,
  SceneFillRule,
} from '@vector-studio/contracts';
import type { PrimitiveTarget } from '../../packages/renderer-core/src/primitive-packet.js';
import {
  PathMeshPipeline,
  type PathFringeBuilder,
  type PathMeshLimits,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

// Test doubles of FillMeshPort named by the P3 V3 contract, section l: a counting double that
// records every batch and serves meshes from a fixed table, a failing double configurable per
// request and per batch, and a range double answering invalid-tolerance outside a range.
// Requests are identified by their tag, the x coordinate of the path's first point.

export type PathNode = Extract<RenderNodeSnapshot, { kind: 'path' }>;
export type RecordedRequest = Readonly<{
  requestId: number;
  tag: number;
  toleranceExponent: number;
  fillRule: SceneFillRule;
}>;

export const target: PrimitiveTarget = Object.freeze({
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 4,
  targetFormat: 'bgra8unorm',
});

export const identity = Object.freeze({ documentId: 'v3a', pageId: 'page' });

/** The square [0, size]^2 as a two-triangle mesh, counter-clockwise. 120 bytes at any size. */
export function squareMesh(size = 10, extraVertices = 0): FillMesh {
  const positions = [0, 0, size, 0, size, size, 0, size];
  for (let index = 0; index < extraVertices; index += 1) positions.push(size / 2, size / 2);
  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    boundaryEdges: Uint32Array.from([0, 1, 1, 2, 2, 3, 3, 0]),
    bounds: { minX: 0, minY: 0, maxX: size, maxY: size },
  };
}

export function meshBytes(mesh: FillMesh): number {
  return mesh.positions.byteLength + mesh.indices.byteLength + mesh.boundaryEdges.byteLength;
}

export type PortScript = {
  /** Per-request answer; the default is an owned square mesh. */
  request?: (request: FillMeshRequest, tag: number) => FillMeshResult;
  /** Batch answer; undefined falls through to per-request answers. */
  batch?: (
    requests: readonly FillMeshRequest[],
    tags: readonly number[],
  ) => FillMeshBatchResult | undefined;
  /** Called at the start of each call, before the port answers. */
  beforeCall?: (tags: readonly number[]) => void;
};

export class ScriptedFillMeshPort implements FillMeshPort {
  portVersion = 0 as const;
  operationId = 'test/v3a-double';
  readonly calls: RecordedRequest[][] = [];
  script: PortScript;

  public constructor(script: PortScript = {}) {
    this.script = script;
  }

  public buildFillMeshes(requests: readonly FillMeshRequest[]): FillMeshBatchResult {
    const tags = requests.map((request) => request.points[0] ?? Number.NaN);
    this.script.beforeCall?.(tags);
    this.calls.push(
      requests.map((request, index) => ({
        requestId: request.requestId,
        tag: tags[index]!,
        toleranceExponent: request.toleranceExponent,
        fillRule: request.fillRule,
      })),
    );
    const batch = this.script.batch?.(requests, tags);
    if (batch !== undefined) return batch;
    return {
      status: 'ok',
      results: requests.map((request, index) =>
        this.script.request === undefined
          ? okResult(request)
          : this.script.request(request, tags[index]!),
      ),
    };
  }

  public get callCount(): number {
    return this.calls.length;
  }

  public setPortVersion(version: number): void {
    (this as { portVersion: number }).portVersion = version;
  }
}

export function okResult(request: FillMeshRequest, mesh: FillMesh = squareMesh()): FillMeshResult {
  return {
    requestId: request.requestId,
    toleranceExponent: request.toleranceExponent,
    status: 'ok',
    mesh,
  };
}

export function failedResult(request: FillMeshRequest, code: FillMeshFailureCode): FillMeshResult {
  return {
    requestId: request.requestId,
    toleranceExponent: request.toleranceExponent,
    status: 'failed',
    code,
  };
}

/** Counting double: records every batch and serves owned square meshes. */
export function createCountingPort(): ScriptedFillMeshPort {
  return new ScriptedFillMeshPort();
}

/** Failing double: per-request failure codes and per-batch codes triggered by marked tags. */
export function createFailingPort(
  options: Readonly<{
    pathFailures?: ReadonlyMap<number, FillMeshFailureCode>;
    batchFailures?: ReadonlyMap<
      number,
      'invalid-request' | 'disposed' | 'resource-limit' | 'internal-error'
    >;
  }>,
): ScriptedFillMeshPort {
  return new ScriptedFillMeshPort({
    request: (request, tag) => {
      const code = options.pathFailures?.get(tag);
      return code === undefined ? okResult(request) : failedResult(request, code);
    },
    batch: (_requests, tags) => {
      for (const tag of tags) {
        const code = options.batchFailures?.get(tag);
        if (code !== undefined) return { status: 'batch-failed', code };
      }
      return undefined;
    },
  });
}

/** Range double: invalid-tolerance outside [minimum, maximum]. */
export function createRangePort(minimum: number, maximum: number): ScriptedFillMeshPort {
  return new ScriptedFillMeshPort({
    request: (request) =>
      request.toleranceExponent < minimum || request.toleranceExponent > maximum
        ? failedResult(request, 'invalid-tolerance')
        : okResult(request),
  });
}

export function pathNode(
  id: string,
  tag: number,
  overrides: Partial<{
    transform: SceneAffine;
    visible: boolean;
    opacity: number;
    parentId: string | null;
    fillRule: SceneFillRule;
    fill: PathNode['style']['fill'];
    verbs: PathNode['geometry']['verbs'];
    points: readonly number[];
  }> = {},
): PathNode {
  return {
    id,
    parentId: overrides.parentId ?? null,
    transform: overrides.transform ?? [1, 0, 0, 1, 0, 0],
    visible: overrides.visible ?? true,
    opacity: overrides.opacity ?? 1,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: overrides.verbs ?? ['move', 'line', 'line', 'close'],
      points: overrides.points ?? [tag, 0, tag + 10, 0, tag + 10, 10],
      fillRule: overrides.fillRule ?? 'nonzero',
    },
    style: { fill: overrides.fill === undefined ? { r: 1, g: 0, b: 0, a: 1 } : overrides.fill },
  };
}

export function rectangleNode(id: string, x: number): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: [1, 0, 0, 1, x, 20],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 0, g: 0, b: 1, a: 1 }, stroke: null },
  };
}

export type PathHarness = ReturnType<typeof createPathHarness>;

export function createPathHarness(
  options: Readonly<{
    port: FillMeshPort;
    nodes?: readonly RenderNodeSnapshot[];
    limits?: Partial<PathMeshLimits>;
    fringeBuilder?: PathFringeBuilder;
    memoryBytes?: () => number;
  }>,
) {
  const mirror = new RetainedSceneMirror(undefined, { pathNodes: 'supported' });
  const pipeline = new PathMeshPipeline({
    port: options.port,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.fringeBuilder === undefined ? {} : { fringeBuilder: options.fringeBuilder }),
    ...(options.memoryBytes === undefined ? {} : { memoryBytes: options.memoryBytes }),
  });
  const source = new PrimitiveSceneSource(mirror, pipeline);
  let revision = 0;
  const replace = (nodes: readonly RenderNodeSnapshot[], rootOrder?: readonly string[]) => {
    revision += 1;
    return mirror.replaceSnapshot({
      identity,
      revision,
      nodes,
      rootOrder: rootOrder ?? nodes.filter((node) => node.parentId === null).map((node) => node.id),
    });
  };
  if (options.nodes !== undefined) {
    const result = replace(options.nodes);
    if (result.status !== 'applied') throw new Error(`setup failed: ${JSON.stringify(result)}`);
  }
  const prepare = (nextTarget: PrimitiveTarget = target) => {
    source.prepare(nextTarget);
    return source.getPathMeshFrame()!;
  };
  const drawnIds = (nextTarget: PrimitiveTarget = target) =>
    prepare(nextTarget).draws.map((draw) => draw.nodeId);
  return {
    mirror,
    pipeline,
    source,
    replace,
    prepare,
    drawnIds,
    statistics: () => pipeline.getStatistics(),
    setZoom: (zoom: number, position = { x: 0, y: 0 }) => mirror.setCamera({ position, zoom }),
  };
}
