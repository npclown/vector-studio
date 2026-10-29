import { DIAGNOSTIC_CODES, type DiagnosticInput } from '@vector-studio/contracts';
import type { ClipChain } from './clip-resolution.js';
import type { SceneBounds } from './scene-numeric.js';

/**
 * E25 contract (docs/plans/d9-e25-isolated-opacity-contract.md), unit U2: isolated layers. A
 * visible container with 0 < opacity < 1 draws its subtree into a layer that is composited once
 * with its opacity (E25-K1). This module holds the pure parts of the plan: layer scopes from the
 * traversal, layer bounds (E25-K5), the per-tree budget (section 4) and its notices. Pure CPU
 * data; the GPU passes belong to U3.
 */

/** Section 4, Budget (E25-Q3 (a)): layer textures and the layer tile set of a frame. */
export const E25_LAYER_BYTES_MAX = 96 * 1024 * 1024;

/** Section 4: the layer tile edge, E22's mask tile size. */
export const E25_LAYER_TILE_SIZE = 1024;

/**
 * One isolated container of the traversal. `start` is the paint sequence of its first leaf and
 * `end` the sequence after its last one, so a leaf with `start <= sequence < end` is inside it;
 * `chain` is the container's own clip chain, its clip included (the chain of its children).
 */
export type LayerScope = {
  readonly nodeId: string;
  readonly opacity: number;
  readonly parent: LayerScope | null;
  /** Number of enclosing layers. */
  readonly depth: number;
  readonly chain: ClipChain | null;
  readonly start: number;
  end: number;
};

/** A device rectangle in whole target pixels. */
export type DeviceRect = Readonly<{ x: number; y: number; width: number; height: number }>;

export type LayerCamera = Readonly<{ x: number; y: number; zoom: number }>;
export type LayerTarget = Readonly<{
  width: number;
  height: number;
  devicePixelRatio: number;
  sampleCount: 1 | 4;
}>;

/**
 * E25-K5: the layer's device rectangle. The union of the drawn content's world bounds (mapped to
 * device space) and the nested layers' rectangles, widened by 1 px, intersected with the
 * container's clip chain bound (each level widened by 1 px for its coverage ramp), rounded out,
 * with x and y moved down to even values and the size rounded up to even, then clamped to the
 * target and to the parent layer's rectangle. Null when empty.
 */
export function layerBound(
  content: readonly SceneBounds[],
  nested: readonly DeviceRect[],
  chain: ClipChain | null,
  camera: LayerCamera,
  target: LayerTarget,
  parent: DeviceRect | null,
): DeviceRect | null {
  if (chain?.empty === true) return null;
  const scale = camera.zoom * target.devicePixelRatio;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const bounds of content) {
    minX = Math.min(minX, (bounds.minX - camera.x) * scale);
    minY = Math.min(minY, (bounds.minY - camera.y) * scale);
    maxX = Math.max(maxX, (bounds.maxX - camera.x) * scale);
    maxY = Math.max(maxY, (bounds.maxY - camera.y) * scale);
  }
  for (const rect of nested) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  if (!(minX <= maxX && minY <= maxY)) return null;
  minX -= 1;
  minY -= 1;
  maxX += 1;
  maxY += 1;
  for (const clip of chain?.bounds ?? []) {
    minX = Math.max(minX, (clip.minX - camera.x) * scale - 1);
    minY = Math.max(minY, (clip.minY - camera.y) * scale - 1);
    maxX = Math.min(maxX, (clip.maxX - camera.x) * scale + 1);
    maxY = Math.min(maxY, (clip.maxY - camera.y) * scale + 1);
  }
  const x = 2 * Math.floor(Math.floor(minX) / 2);
  const y = 2 * Math.floor(Math.floor(minY) / 2);
  let right = x + 2 * Math.ceil((Math.ceil(maxX) - x) / 2);
  let bottom = y + 2 * Math.ceil((Math.ceil(maxY) - y) / 2);
  let left = Math.max(x, 0);
  let top = Math.max(y, 0);
  right = Math.min(right, target.width);
  bottom = Math.min(bottom, target.height);
  if (parent !== null) {
    left = Math.max(left, parent.x);
    top = Math.max(top, parent.y);
    right = Math.min(right, parent.x + parent.width);
    bottom = Math.min(bottom, parent.y + parent.height);
  }
  if (!(left < right && top < bottom)) return null;
  return Object.freeze({ x: left, y: top, width: right - left, height: bottom - top });
}

export type LayerResourceNotice = Readonly<{ nodeId: string; bytes: number; limit: number }>;

/** A layer tree: a layer with no enclosing layer and the layers nested in it. */
export type LayerTree = Readonly<{
  rootId: string;
  layers: readonly Readonly<{ width: number; height: number }>[];
}>;

/**
 * Section 4, Budget: the layer tile set's bytes over layers at most `maxWidth × maxHeight`:
 * colour 16, resolve 4 and stencil 4 bytes per pixel at 4x; colour 4 and stencil 1 at 1x.
 */
export function layerTileBytes(maxWidth: number, maxHeight: number, sampleCount: 1 | 4): number {
  const width = Math.min(E25_LAYER_TILE_SIZE, maxWidth);
  const height = Math.min(E25_LAYER_TILE_SIZE, maxHeight);
  return width * height * (sampleCount === 4 ? 24 : 5);
}

/**
 * Section 4, Budget: trees are admitted whole, in paint order, while the admitted trees' layer
 * textures (4 bytes per pixel) plus the tile set over them fit `limit`. A tree that does not fit
 * is not drawn and gives one notice on its root; later trees are still planned.
 */
export function planLayerBudget(
  trees: readonly LayerTree[],
  sampleCount: 1 | 4,
  limit = E25_LAYER_BYTES_MAX,
): Readonly<{ admitted: ReadonlySet<string>; notices: readonly LayerResourceNotice[] }> {
  const admitted = new Set<string>();
  const notices: LayerResourceNotice[] = [];
  let resident = 0;
  let maxWidth = 0;
  let maxHeight = 0;
  for (const tree of trees) {
    let treeResident = 0;
    let treeWidth = maxWidth;
    let treeHeight = maxHeight;
    for (const layer of tree.layers) {
      treeResident += layer.width * layer.height * 4;
      treeWidth = Math.max(treeWidth, layer.width);
      treeHeight = Math.max(treeHeight, layer.height);
    }
    const bytes = resident + treeResident + layerTileBytes(treeWidth, treeHeight, sampleCount);
    if (bytes > limit) {
      notices.push(Object.freeze({ nodeId: tree.rootId, bytes, limit }));
      continue;
    }
    admitted.add(tree.rootId);
    resident += treeResident;
    maxWidth = treeWidth;
    maxHeight = treeHeight;
  }
  return Object.freeze({ admitted, notices: Object.freeze(notices) });
}

/** Section 5: the `render.layer-resource-limit` diagnostic of a budget notice. */
export function layerResourceLimitDiagnostic(
  notice: LayerResourceNotice,
  generation: number,
): DiagnosticInput {
  return Object.freeze({
    code: DIAGNOSTIC_CODES.LAYER_RESOURCE_LIMIT,
    severity: 'warning',
    message: `Isolated container ${notice.nodeId} is not drawn: its layers need ${notice.bytes} bytes over the ${notice.limit}-byte budget.`,
    generation,
    context: Object.freeze({ nodeId: notice.nodeId, bytes: notice.bytes, limit: notice.limit }),
  });
}
