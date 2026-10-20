import type { PathStroke, RenderNodeSnapshot, SceneAffine } from '@vector-studio/contracts';
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

/**
 * The box of a path's points, which contains every cubic by the convex-hull property.
 * An empty path has no points and so no bounds (P3 V3 contract, section a).
 */
export function getPathLocalPointBounds(points: readonly number[]): SceneBounds | null {
  if (points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < points.length; index += 2) {
    const x = points[index]!;
    const y = points[index + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Object.freeze({ minX, minY, maxX, maxY });
}

/** 2^24: the miter-ratio cap of the stroke culling bound (B2 stroke contract, section 9.7, S3). */
export const STROKE_MITER_BOUND_CAP = 2 ** 24;

/**
 * The stroke bounds box of the B2 stroke contract, section 9.7 with the ST-A0 amendment (S3):
 * the box of the path's points expanded by r·k in local units, r = width / 2 and
 * k = max(1, min(L, 2^24) if join = 'miter', 1.5 if cap = 'square'). Null for an empty path or a
 * stroke that draws nothing (null or width 0). The box may be nonfinite; transformSceneBounds
 * then reports it, which scene validation turns into invalid-value.
 */
export function getPathLocalStrokeBounds(
  points: readonly number[],
  stroke: PathStroke | null,
): SceneBounds | null {
  if (stroke === null || !(stroke.width > 0)) return null;
  const box = getPathLocalPointBounds(points);
  if (box === null) return null;
  const k = Math.max(
    1,
    stroke.join === 'miter' ? Math.min(stroke.miterLimit, STROKE_MITER_BOUND_CAP) : 1,
    stroke.cap === 'square' ? 1.5 : 1,
  );
  const expansion = (stroke.width / 2) * k;
  return Object.freeze({
    minX: box.minX - expansion,
    minY: box.minY - expansion,
    maxX: box.maxX + expansion,
    maxY: box.maxY + expansion,
  });
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
      if (node.kind === 'path') {
        // P1's arithmetic rule on the point box; an empty path is exempt.
        const pathBounds = getPathLocalPointBounds(node.geometry.points);
        if (pathBounds !== null && transformSceneBounds(pathBounds, world) === null) return false;
        // B2 stroke contract, section 5: nonfinite world bounds of the stroke bounds box of a
        // nonempty path with width > 0 are invalid-value too.
        const strokeBounds = getPathLocalStrokeBounds(node.geometry.points, node.style.stroke);
        if (strokeBounds !== null && transformSceneBounds(strokeBounds, world) === null) {
          return false;
        }
        continue;
      }
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
