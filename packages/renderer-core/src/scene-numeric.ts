import type { RenderNodeSnapshot, SceneAffine } from '@vector-studio/contracts';
import { multiplyAffine } from './camera.js';

export type SceneBounds = Readonly<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}>;

export function composeSceneAffine(left: SceneAffine, right: SceneAffine): SceneAffine | null {
  try {
    return multiplyAffine(left, right);
  } catch {
    return null;
  }
}

export function getPrimitiveLocalStrokeBounds(
  node: RenderNodeSnapshot,
): SceneBounds | null | undefined {
  if (node.kind !== 'primitive') {
    return undefined;
  }

  const halfStroke = (node.style.stroke?.width ?? 0) / 2;
  let minX: number;
  let minY: number;
  let maxX: number;
  let maxY: number;

  if (node.geometry.kind === 'line') {
    minX = Math.min(node.geometry.start.x, node.geometry.end.x) - halfStroke;
    minY = Math.min(node.geometry.start.y, node.geometry.end.y) - halfStroke;
    maxX = Math.max(node.geometry.start.x, node.geometry.end.x) + halfStroke;
    maxY = Math.max(node.geometry.start.y, node.geometry.end.y) + halfStroke;
  } else {
    minX = -halfStroke;
    minY = -halfStroke;
    maxX = node.geometry.width + halfStroke;
    maxY = node.geometry.height + halfStroke;
  }

  return [minX, minY, maxX, maxY].every(Number.isFinite)
    ? Object.freeze({ minX, minY, maxX, maxY })
    : null;
}

export function transformSceneBounds(
  bounds: SceneBounds,
  transform: SceneAffine,
): SceneBounds | null {
  const [a, b, c, d, e, f] = transform;
  const points = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ] as const;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [x, y] of points) {
    const transformedX = a * x + c * y + e;
    const transformedY = b * x + d * y + f;
    if (!Number.isFinite(transformedX) || !Number.isFinite(transformedY)) {
      return null;
    }
    minX = Math.min(minX, transformedX);
    minY = Math.min(minY, transformedY);
    maxX = Math.max(maxX, transformedX);
    maxY = Math.max(maxY, transformedY);
  }

  return Object.freeze({ minX, minY, maxX, maxY });
}

/** Validates world composition and conservative primitive bounds without recursion. */
export function hasFiniteSceneArithmetic(nodes: ReadonlyMap<string, RenderNodeSnapshot>): boolean {
  const worldTransforms = new Map<string, SceneAffine>();
  const failed = new Set<string>();
  const identity = [1, 0, 0, 1, 0, 0] as const;

  for (const startId of [...nodes.keys()].sort(compareOrdinal)) {
    if (worldTransforms.has(startId) || failed.has(startId)) {
      continue;
    }

    const path: RenderNodeSnapshot[] = [];
    const pathIndices = new Map<string, number>();
    let cursor = nodes.get(startId);
    let parentWorld: SceneAffine | null = identity;

    while (cursor !== undefined) {
      const knownWorld = worldTransforms.get(cursor.id);
      if (knownWorld !== undefined) {
        parentWorld = knownWorld;
        break;
      }
      if (failed.has(cursor.id)) {
        parentWorld = null;
        break;
      }
      if (pathIndices.has(cursor.id)) {
        for (const entry of path) {
          failed.add(entry.id);
        }
        parentWorld = null;
        break;
      }

      pathIndices.set(cursor.id, path.length);
      path.push(cursor);
      if (cursor.parentId === null) {
        parentWorld = identity;
        break;
      }
      const parent = nodes.get(cursor.parentId);
      if (parent === undefined) {
        for (const entry of path) {
          failed.add(entry.id);
        }
        parentWorld = null;
        break;
      }
      cursor = parent;
    }

    if (parentWorld === null) {
      continue;
    }

    for (let index = path.length - 1; index >= 0; index -= 1) {
      const node = path[index]!;
      const world = composeSceneAffine(parentWorld, node.transform);
      if (world === null) {
        return false;
      }
      worldTransforms.set(node.id, world);
      parentWorld = world;
      const bounds = getPrimitiveLocalStrokeBounds(node);
      if (
        bounds === null ||
        (bounds !== undefined && transformSceneBounds(bounds, world) === null)
      ) {
        return false;
      }
    }
  }

  return true;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
