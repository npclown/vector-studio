import type {
  FillMesh,
  FillMeshPort,
  PathStroke,
  RenderNodeSnapshot,
  StrokeMeshBatchResult,
  StrokeMeshFailureCode,
  StrokeMeshPort,
  StrokeMeshRequest,
  StrokeMeshResult,
} from '@vector-studio/contracts';
import type { PrimitiveTarget } from '../../packages/renderer-core/src/primitive-packet.js';
import {
  PathMeshPipeline,
  type PathFringeBuilder,
  type PathMeshDraw,
  type PathMeshLimits,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import type { ClipSupport } from '../../packages/renderer-core/src/scene-validation.js';
import {
  identity,
  pathNode,
  target,
  type PathMeshFrame,
  type PathNode,
} from './v3a-path-harness.js';

// Test doubles and a harness for unit ST-U6 of the B2 stroke contract (section 9): a scripted
// StrokeMeshPort that records every batch, in the style of V3's counting and failing fill
// doubles, and a harness that wires a mirror, a PathMeshPipeline with either port or both, and
// a PrimitiveSceneSource. Requests are identified by their tag, the path's first x coordinate.
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target.

export type RecordedStrokeRequest = Readonly<{
  requestId: number;
  tag: number;
  toleranceExponent: number;
  width: number;
  cap: StrokeMeshRequest['cap'];
  join: StrokeMeshRequest['join'];
  miterLimit: number;
}>;

export type StrokeScript = {
  request?: (request: StrokeMeshRequest, tag: number) => StrokeMeshResult;
  batch?: (
    requests: readonly StrokeMeshRequest[],
    tags: readonly number[],
  ) => StrokeMeshBatchResult | undefined;
};

/** The stroke region of a fill square [0, 10]^2 at width 2 with miter joins, as a 16-cell ring. */
export function strokeRingMesh(offset = 0): FillMesh {
  const outer = [
    [-1, -1],
    [11, -1],
    [11, 11],
    [-1, 11],
  ];
  const inner = [
    [1, 1],
    [9, 1],
    [9, 9],
    [1, 9],
  ];
  const positions = [...outer, ...inner].flatMap(([x, y]) => [x! + offset, y!]);
  // Four trapezoids between the outer and inner loops, two counter-clockwise triangles each.
  const indices = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  const boundaryEdges = [0, 1, 1, 2, 2, 3, 3, 0, 5, 4, 6, 5, 7, 6, 4, 7];
  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    boundaryEdges: Uint32Array.from(boundaryEdges),
    bounds: { minX: -1 + offset, minY: -1, maxX: 11 + offset, maxY: 11 },
  };
}

export class ScriptedStrokeMeshPort implements StrokeMeshPort {
  portVersion = 0 as const;
  operationId = 'test/st-u6-stroke-double';
  readonly calls: RecordedStrokeRequest[][] = [];
  script: StrokeScript;

  public constructor(script: StrokeScript = {}) {
    this.script = script;
  }

  public buildStrokeMeshes(requests: readonly StrokeMeshRequest[]): StrokeMeshBatchResult {
    const tags = requests.map((request) => request.points[0] ?? Number.NaN);
    this.calls.push(
      requests.map((request, index) => ({
        requestId: request.requestId,
        tag: tags[index]!,
        toleranceExponent: request.toleranceExponent,
        width: request.width,
        cap: request.cap,
        join: request.join,
        miterLimit: request.miterLimit,
      })),
    );
    const batch = this.script.batch?.(requests, tags);
    if (batch !== undefined) return batch;
    return {
      status: 'ok',
      results: requests.map((request, index) =>
        this.script.request === undefined
          ? strokeOk(request, tags[index])
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

export function strokeOk(
  request: StrokeMeshRequest,
  tag = 0,
  mesh: FillMesh = strokeRingMesh(tag),
): StrokeMeshResult {
  return {
    requestId: request.requestId,
    toleranceExponent: request.toleranceExponent,
    status: 'ok',
    mesh,
  };
}

export function strokeFailed(
  request: StrokeMeshRequest,
  code: StrokeMeshFailureCode,
): StrokeMeshResult {
  return {
    requestId: request.requestId,
    toleranceExponent: request.toleranceExponent,
    status: 'failed',
    code,
  };
}

/** Failing stroke double: per-request codes and per-batch codes triggered by marked tags. */
export function createFailingStrokePort(
  options: Readonly<{
    pathFailures?: ReadonlyMap<number, StrokeMeshFailureCode>;
    batchFailures?: ReadonlyMap<
      number,
      'invalid-request' | 'disposed' | 'resource-limit' | 'internal-error'
    >;
  }>,
): ScriptedStrokeMeshPort {
  return new ScriptedStrokeMeshPort({
    request: (request, tag) => {
      const code = options.pathFailures?.get(tag);
      return code === undefined ? strokeOk(request, tag) : strokeFailed(request, code);
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

export const BLUE = Object.freeze({ r: 0, g: 0, b: 1, a: 1 });
export const RED = Object.freeze({ r: 1, g: 0, b: 0, a: 1 });

export function pathStroke(overrides: Partial<PathStroke> = {}): PathStroke {
  return {
    color: overrides.color ?? BLUE,
    width: overrides.width ?? 2,
    cap: overrides.cap ?? 'butt',
    join: overrides.join ?? 'miter',
    miterLimit: overrides.miterLimit ?? 4,
  };
}

/** V3's path node with a stroke; `fill: null` makes a stroke-only path. */
export function strokedNode(
  id: string,
  tag: number,
  overrides: Parameters<typeof pathNode>[2] & Partial<{ stroke: PathStroke | null }> = {},
): PathNode {
  const { stroke, ...rest } = overrides;
  const node = pathNode(id, tag, rest);
  return {
    ...node,
    style: { fill: node.style.fill, stroke: stroke === undefined ? pathStroke() : stroke },
  };
}

export function createStrokeHarness(
  options: Readonly<{
    fillPort?: FillMeshPort;
    strokePort?: StrokeMeshPort;
    nodes?: readonly RenderNodeSnapshot[];
    limits?: Partial<PathMeshLimits>;
    fringeBuilder?: PathFringeBuilder;
    memoryBytes?: () => number;
    strokeMemoryBytes?: () => number;
    /** P4 contract, U3: the mirror's clip support; default none. */
    clips?: ClipSupport;
    /** E23 contract, U3: the mirror's paint support; default solid. */
    paints?: 'solid' | 'gradient';
  }>,
) {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: options.fillPort === undefined ? 'unsupported' : 'supported',
    pathStrokes: options.strokePort === undefined ? 'unsupported' : 'supported',
    ...(options.clips === undefined ? {} : { clips: options.clips }),
    ...(options.paints === undefined ? {} : { paints: options.paints }),
  });
  const pipeline = new PathMeshPipeline({
    ...(options.fillPort === undefined ? {} : { port: options.fillPort }),
    ...(options.strokePort === undefined ? {} : { strokePort: options.strokePort }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.fringeBuilder === undefined ? {} : { fringeBuilder: options.fringeBuilder }),
    ...(options.memoryBytes === undefined ? {} : { memoryBytes: options.memoryBytes }),
    ...(options.strokeMemoryBytes === undefined
      ? {}
      : { strokeMemoryBytes: options.strokeMemoryBytes }),
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
    return mirror.replaceSnapshot({
      identity,
      revision,
      nodes,
      rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
    });
  };
  if (options.nodes !== undefined) {
    const result = replace(options.nodes);
    if (result.status !== 'applied') throw new Error(`setup failed: ${JSON.stringify(result)}`);
  }
  const prepare = (nextTarget: PrimitiveTarget = target): PathMeshFrame => {
    const packet = source.prepare(nextTarget);
    if (packet === null) throw new Error('prepare returned no packet');
    return Object.freeze({ draws: served, notices: packet.mesh?.notices ?? [] });
  };
  /** The served paints in order, as `nodeId:paint`. */
  const drawn = (nextTarget: PrimitiveTarget = target) =>
    prepare(nextTarget).draws.map((draw) => `${draw.nodeId}:${draw.paint ?? 'fill'}`);
  return {
    mirror,
    pipeline,
    source,
    replace,
    prepare,
    drawn,
    statistics: () => pipeline.getStatistics(),
    setZoom: (zoom: number, position = { x: 0, y: 0 }) => mirror.setCamera({ position, zoom }),
  };
}
