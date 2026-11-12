import type { Fill, NodeV8, Paint } from '@vector-studio/model';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), section 2: helpers over a node's
// `fills`, which replace v7's single `fill`.

/** V35-S1: the one fill a paint becomes (visible, opacity 1, `normal`). */
export function paintFill(paint: Paint): Fill {
  return { paint, visible: true, opacity: 1, blendMode: 'normal' };
}

/** V35-S5: the fills that `fill: paint | null` stands for. */
export function fillsOf(paint: Paint | null): Fill[] {
  return paint === null ? [] : [paintFill(paint)];
}

/** A node's fills, `[]` for a type without them. */
export function nodeFills(node: NodeV8 | undefined): readonly Fill[] {
  return node !== undefined && 'fills' in node ? node.fills : [];
}

/** V35-R5: whether a fill draws (visible, opacity above 0). */
export function fillDraws(fill: Fill): boolean {
  return fill.visible && fill.opacity > 0;
}

/**
 * Whether the node's fill area takes part in hit testing: any visible fill, as Figma does, at
 * any opacity (a fill at 0 % stays clickable).
 */
export function hasVisibleFill(fills: readonly Fill[]): boolean {
  return fills.some((fill) => fill.visible);
}

/** The default `blendMode` of a new node of `type` (V35-S1). */
export function defaultBlendMode(type: string): 'normal' | 'passThrough' {
  return type === 'group' ||
    type === 'maskGroup' ||
    type === 'frame' ||
    type === 'symbol' ||
    type === 'instance'
    ? 'passThrough'
    : 'normal';
}

/** The fills of `fills` that draw (V35-R5). */
export function drawingFills(fills: readonly Fill[]): number {
  let count = 0;
  for (const fill of fills) if (fillDraws(fill)) count += 1;
  return count;
}

/**
 * Scene nodes of a frame unit (frame, symbol, or an instance with its source's fills and
 * stroke): the outer and content nodes, one background per drawing fill (V35-P3) and the border.
 */
export function frameSceneCount(fills: readonly Fill[], stroke: unknown): number {
  return 2 + drawingFills(fills) + (stroke === null ? 0 : 1);
}

/**
 * Scene nodes a leaf projects as (V35-P1, P2): one, or its container, a leaf per drawing fill
 * and a stroke leaf when it has more than one drawing fill or a non-normal one.
 */
export function leafSceneCount(node: NodeV8): number {
  if (!('fills' in node) || node.type === 'frame' || node.type === 'symbol') return 1;
  let drawing = 0;
  let blended = false;
  for (const fill of node.fills) {
    if (!fillDraws(fill)) continue;
    drawing += 1;
    if (fill.blendMode !== 'normal') blended = true;
  }
  if (drawing <= 1 && !blended) return 1;
  return 1 + drawing + (node.stroke === null ? 0 : 1);
}
