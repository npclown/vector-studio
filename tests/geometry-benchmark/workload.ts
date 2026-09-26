import { GEOMETRY_VERB, type GeometryRequest } from '../../packages/geometry-wasm/src/index.js';

export const P2_SCENARIO = 'p2-batch/v1' as const;
export const P2_WORKLOAD_SEED = 0x1234_5678;
export const P2_WORKLOAD_PATHS = 1_000 as const;
export const P2_WORKLOAD_CUBICS_PER_PATH = 32 as const;
export const P2_WORKLOAD_CUBIC_COUNT = 32_000 as const;
export const P2_LOCAL_TOLERANCE = 0.25 as const;
export const P2_WORLD = [1, 0, 0, 1] as const;
export const P2_ZOOM = 1 as const;
export const P2_DEVICE_PIXEL_RATIO = 1 as const;

export interface P2Workload {
  readonly seed: number;
  readonly paths: number;
  readonly cubicsPerPath: number;
  readonly requests: readonly GeometryRequest[];
}

function xorshift32(state: number): number {
  let next = state >>> 0;
  next = (next ^ (next << 13)) >>> 0;
  next = (next ^ (next >>> 17)) >>> 0;
  next = (next ^ (next << 5)) >>> 0;
  return next;
}

function createWorkload(seed: number, paths: number, cubicsPerPath: number): P2Workload {
  if (!Number.isSafeInteger(paths) || paths < 0) throw new RangeError('paths must be non-negative');
  if (!Number.isSafeInteger(cubicsPerPath) || cubicsPerPath < 0)
    throw new RangeError('cubicsPerPath must be non-negative');
  let state = seed >>> 0;
  const delta = (): number => {
    state = xorshift32(state);
    return ((state / 0x1_0000_0000) * 2 - 1) * 100;
  };
  const requests: GeometryRequest[] = [];
  for (let path = 0; path < paths; path += 1) {
    const verbs = new Uint8Array(1 + cubicsPerPath);
    const points = new Float64Array(2 + cubicsPerPath * 6);
    verbs[0] = GEOMETRY_VERB.MOVE;
    points[0] = 0;
    points[1] = 0;
    let endpointX = 0;
    let endpointY = 0;
    for (let cubic = 0; cubic < cubicsPerPath; cubic += 1) {
      const pointIndex = 2 + cubic * 6;
      verbs[1 + cubic] = GEOMETRY_VERB.CUBIC;
      const controlOneX = endpointX + delta();
      const controlOneY = endpointY + delta();
      const controlTwoX = endpointX + delta();
      const controlTwoY = endpointY + delta();
      const nextEndpointX = endpointX + delta();
      const nextEndpointY = endpointY + delta();
      points.set(
        [controlOneX, controlOneY, controlTwoX, controlTwoY, nextEndpointX, nextEndpointY],
        pointIndex,
      );
      endpointX = nextEndpointX;
      endpointY = nextEndpointY;
    }
    requests.push({
      domainId: 'p2-benchmark',
      nodeId: `path-${path}`,
      requestId: path + 1,
      sourceEpoch: 1,
      sourceRevision: 1,
      verbs,
      points,
      strokeStyleHash: 'none',
      fillRule: 'nonzero',
      world: P2_WORLD,
      zoom: P2_ZOOM,
      devicePixelRatio: P2_DEVICE_PIXEL_RATIO,
    });
  }
  return { seed: seed >>> 0, paths, cubicsPerPath, requests };
}

/** The production page calls this once and does not parameterize the frozen workload. */
export function createP2Workload(): P2Workload {
  return createWorkload(P2_WORKLOAD_SEED, P2_WORKLOAD_PATHS, P2_WORKLOAD_CUBICS_PER_PATH);
}

/** A lower-count fixture builder for deterministic unit tests only. */
export function createP2WorkloadFixture(paths: number, cubicsPerPath: number): P2Workload {
  return createWorkload(P2_WORKLOAD_SEED, paths, cubicsPerPath);
}
