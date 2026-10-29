import { normalizeRotation, type DocumentV3, type Frame } from '@vector-studio/model';
import { boundsOf } from './hit-test.js';
import { ancestors, childrenOf, documentTree, isFrameLike, spaceOf, subtree } from './tree.js';
import type { PagePoint, Segment, SnapOverlay } from './types.js';

// Snapping (MVP M2 contract, section 4.2): the candidate set of a gesture, align, spacing and
// centring offers with their tie chain, rotation-angle targets and the snap overlay. Everything
// runs in page space on the pre-gesture document; tools apply the result through each node's
// parent space. No browser global is read here.

/** The snap threshold in CSS pixels; `SNAP_PX / zoom` page units, per axis. */
export const SNAP_PX = 6;

/** A page-aligned box by its edges. */
export type Box = Readonly<{ left: number; top: number; right: number; bottom: number }>;

/** A moving or candidate value's index on an axis: 0 the low edge, 1 the centre, 2 the high edge. */
export type ValueIndex = 0 | 1 | 2;

export type Axis = 'x' | 'y';

/** A snap candidate: its box in the pre-gesture document, page rotation and candidate order. */
export type Candidate = Readonly<{ id: string; order: number; box: Box; rotation: number }>;

/**
 * The candidates of one gesture, in candidate order (document pre-order of the active page), and
 * presorted for spacing: by `(left, right, order)` for x and `(top, bottom, order)` for y.
 */
export type SnapSet = Readonly<{
  candidates: readonly Candidate[];
  sorted: Readonly<Record<Axis, readonly Candidate[]>>;
}>;

export function boxOfFrame(frame: Frame): Box {
  return {
    left: frame.x,
    top: frame.y,
    right: frame.x + frame.width,
    bottom: frame.y + frame.height,
  };
}

export function translateBox(box: Box, dx: number, dy: number): Box {
  return {
    left: box.left + dx,
    top: box.top + dy,
    right: box.right + dx,
    bottom: box.bottom + dy,
  };
}

/** The low edge, centre and high edge of `box` on `axis`. */
function valuesOf(box: Box, axis: Axis): readonly [number, number, number] {
  return axis === 'x'
    ? [box.left, (box.left + box.right) / 2, box.right]
    : [box.top, (box.top + box.bottom) / 2, box.bottom];
}

/** The closed range of `box` across `axis`. */
function crossOf(box: Box, axis: Axis): readonly [number, number] {
  return axis === 'x' ? [box.top, box.bottom] : [box.left, box.right];
}

function lowHigh(box: Box, axis: Axis): readonly [number, number] {
  return axis === 'x' ? [box.left, box.right] : [box.top, box.bottom];
}

/**
 * The candidate set (section 4.2) for nodes `moving` of `page`, with the scope owner `scope`
 * (null: the active page): the children of the scope owner, the children of every frame that is
 * a child of the page, and every frame ancestor of a moving node. Excluded: the moving nodes,
 * their descendants, their group and mask-group ancestors, mask sources and nodes not visible
 * through their ancestors. Boxes are the page-aligned bounds in `document`, the pre-gesture
 * document. A `symbol` counts as a frame here and an `instance` as a leaf, its frame's edges
 * and centre (MVP M7 contract, sections 1.2 and 4.3): the nodes of an expansion are not
 * document nodes and are never candidates.
 */
export function snapSet(
  document: DocumentV3,
  page: string,
  scope: string | null,
  moving: readonly string[],
): SnapSet {
  const tree = documentTree(document);
  const included = new Set<string>(childrenOf(tree, scope ?? page));
  for (const id of childrenOf(tree, page)) {
    const node = tree.node(id);
    if (isFrameLike(node)) node.children.forEach((child) => included.add(child));
  }
  const excluded = new Set<string>();
  for (const id of moving) {
    if (tree.node(id) === undefined) continue;
    subtree(tree, id).forEach((inner) => excluded.add(inner));
    for (const ancestor of ancestors(tree, id)) {
      if (isFrameLike(ancestor)) included.add(ancestor.id);
      else excluded.add(ancestor.id);
    }
  }
  const candidates: Candidate[] = [];
  // Pre-order of the page; a hidden node hides its subtree, so the walk skips it.
  const stack = [...childrenOf(tree, page)].reverse();
  let order = 0;
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = tree.node(id);
    if (node === undefined || !node.visible) continue;
    const parent = tree.node(node.parent);
    const source = parent?.type === 'maskGroup' && parent.children[0] === id;
    if (included.has(id) && !excluded.has(id) && !source) {
      const bounds = boundsOf(document, [id])!;
      const chain = spaceOf(tree, node.parent).rotation;
      candidates.push({
        id,
        order,
        box: boxOfFrame(bounds),
        rotation: normalizeRotation(chain + node.rotation),
      });
      order += 1;
    }
    const children = childrenOf(tree, id);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
  }
  const by = (axis: Axis) =>
    [...candidates].sort((a, b) => {
      const [al, ah] = lowHigh(a.box, axis);
      const [bl, bh] = lowHigh(b.box, axis);
      return al - bl || ah - bh || a.order - b.order;
    });
  return { candidates, sorted: { x: by('x'), y: by('y') } };
}

/** The moving value `value` with its index on the axis. */
export type MovingValue = Readonly<{ index: ValueIndex; value: number }>;

/** The axis offer that won (section 4.2, Choice), with what the overlay needs. */
export type AxisChoice =
  | Readonly<{ kind: 'align'; o: number }>
  | Readonly<{
      kind: 'spacing';
      o: number;
      g: number;
      /** `left`: the offer from the nearest left (or upper) neighbour; `right` likewise. */
      side: 'left' | 'right';
      neighbour: Candidate;
      reference: readonly Candidate[];
    }>
  | Readonly<{
      kind: 'centre';
      o: number;
      before: Candidate;
      after: Candidate;
    }>;

type Ranked = { choice: AxisChoice; key: readonly number[] };

function less(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return false;
}

/**
 * The winning offer on one axis, or null (section 4.2): align offers for every moving value
 * against every candidate value within `threshold`; with `spacing`, the spacing and centring
 * offers of the box `B` against its nearest neighbours. Ties: least `|o|`, align before spacing
 * before centring; align by lesser candidate value, lesser moving index, candidate order;
 * spacing by lesser target value, then lesser gap.
 */
export function chooseAxis(
  set: SnapSet,
  axis: Axis,
  moving: readonly MovingValue[],
  threshold: number,
  spacing: Box | null,
): AxisChoice | null {
  let best: Ranked | null = null;
  const offer = (choice: AxisChoice, key: readonly number[]) => {
    if (!(Math.abs(choice.o) <= threshold)) return;
    if (best === null || less(key, best.key)) best = { choice, key };
  };
  if (moving.length > 0) {
    for (const candidate of set.candidates) {
      const values = valuesOf(candidate.box, axis);
      for (const c of values) {
        for (const { index, value: m } of moving) {
          if (Math.abs(c - m) <= threshold) {
            const o = c - m;
            offer({ kind: 'align', o }, [Math.abs(o), 0, c, index, candidate.order]);
          }
        }
      }
    }
  }
  if (spacing !== null) {
    const B = spacing;
    const [bLow, bHigh] = lowHigh(B, axis);
    const [crossLow, crossHigh] = crossOf(B, axis);
    const reference = set.sorted[axis].filter((candidate) => {
      const [low, high] = crossOf(candidate.box, axis);
      return low <= crossHigh && crossLow <= high;
    });
    const gaps: number[] = [];
    for (let i = 1; i < reference.length; i += 1) {
      const g = lowHigh(reference[i]!.box, axis)[0] - lowHigh(reference[i - 1]!.box, axis)[1];
      if (g > 0) gaps.push(g);
    }
    let before: Candidate | null = null;
    let after: Candidate | null = null;
    for (const candidate of reference) {
      const [low, high] = lowHigh(candidate.box, axis);
      if (high <= bLow) {
        const current = before === null ? null : lowHigh(before.box, axis)[1];
        if (
          before === null ||
          high > current! ||
          (high === current && candidate.order < before.order)
        ) {
          before = candidate;
        }
      }
      if (low >= bHigh) {
        const current = after === null ? null : lowHigh(after.box, axis)[0];
        if (
          after === null ||
          low < current! ||
          (low === current && candidate.order < after.order)
        ) {
          after = candidate;
        }
      }
    }
    if (before !== null) {
      const edge = lowHigh(before.box, axis)[1];
      for (const g of gaps) {
        const o = edge + g - bLow;
        offer({ kind: 'spacing', o, g, side: 'left', neighbour: before, reference }, [
          Math.abs(o),
          1,
          bLow + o,
          g,
        ]);
      }
    }
    if (after !== null) {
      const edge = lowHigh(after.box, axis)[0];
      for (const g of gaps) {
        const o = edge - g - bHigh;
        offer({ kind: 'spacing', o, g, side: 'right', neighbour: after, reference }, [
          Math.abs(o),
          1,
          bHigh + o,
          g,
        ]);
      }
    }
    if (before !== null && after !== null) {
      const o =
        (lowHigh(before.box, axis)[1] + lowHigh(after.box, axis)[0]) / 2 - valuesOf(B, axis)[1];
      offer({ kind: 'centre', o, before, after }, [Math.abs(o), 2]);
    }
  }
  return (best as Ranked | null)?.choice ?? null;
}

/** `ε(v) = 1e-9 · max(1, |v|)` (section 4.2, snap overlay). */
function epsilon(v: number): number {
  return 1e-9 * Math.max(1, Math.abs(v));
}

const point = (axis: Axis, along: number, across: number): PagePoint =>
  axis === 'x' ? { x: along, y: across } : { x: across, y: along };

/** The guides of an axis snapped by an align offer, ordered by value. */
function guidesOf(set: SnapSet, axis: Axis, values: readonly number[], snapped: Box): Segment[] {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  const guides: Segment[] = [];
  for (const v of distinct) {
    const e = epsilon(v);
    let [low, high] = crossOf(snapped, axis);
    let matched = false;
    for (const candidate of set.candidates) {
      if (!valuesOf(candidate.box, axis).some((c) => Math.abs(c - v) <= e)) continue;
      matched = true;
      const [cl, ch] = crossOf(candidate.box, axis);
      low = Math.min(low, cl);
      high = Math.max(high, ch);
    }
    if (matched) guides.push({ a: point(axis, v, low), b: point(axis, v, high) });
  }
  return guides;
}

/** A gap from box `first` to box `second` along `axis`, at the middle of their common range. */
function gapOf(axis: Axis, first: Box, second: Box): Segment {
  const [fl, fh] = crossOf(first, axis);
  const [sl, sh] = crossOf(second, axis);
  const middle = (Math.max(fl, sl) + Math.min(fh, sh)) / 2;
  return {
    a: point(axis, lowHigh(first, axis)[1], middle),
    b: point(axis, lowHigh(second, axis)[0], middle),
  };
}

function gapsOf(axis: Axis, choice: AxisChoice, snapped: Box): Segment[] {
  if (choice.kind === 'align') return [];
  if (choice.kind === 'centre') {
    return [gapOf(axis, choice.before.box, snapped), gapOf(axis, snapped, choice.after.box)];
  }
  const gaps: Segment[] = [];
  const e = epsilon(choice.g);
  const { reference } = choice;
  for (let i = 1; i < reference.length; i += 1) {
    const first = reference[i - 1]!.box;
    const second = reference[i]!.box;
    const g = lowHigh(second, axis)[0] - lowHigh(first, axis)[1];
    if (Math.abs(g - choice.g) <= e) gaps.push(gapOf(axis, first, second));
  }
  gaps.push(
    choice.side === 'left'
      ? gapOf(axis, choice.neighbour.box, snapped)
      : gapOf(axis, snapped, choice.neighbour.box),
  );
  return gaps;
}

/** What a gesture offers: its raw box `B` and the moving values of each axis. */
export type SnapInput = Readonly<{
  /** `B`: the moving nodes' pre-gesture box translated by the raw delta (or the raw point). */
  box: Box;
  x: readonly ValueIndex[];
  y: readonly ValueIndex[];
  /** Spacing and centring offers: a move only. */
  spacing: boolean;
  /** The snapped box `B′` for offsets `(ox, oy)`; by default `B` translated by them. */
  snapped?: (ox: number, oy: number) => Box;
}>;

export type SnapResult = Readonly<{ ox: number; oy: number; overlay: SnapOverlay | null }>;

/**
 * Snaps a gesture's moving values (section 4.2): per axis the winning offer `o`, so the delta
 * becomes raw + `o`, and the snap overlay of guides and gaps (null when nothing snapped).
 */
export function snapBox(set: SnapSet, input: SnapInput, threshold: number): SnapResult {
  const moving = (axis: Axis, indices: readonly ValueIndex[]) => {
    const values = valuesOf(input.box, axis);
    return indices.map((index) => ({ index, value: values[index] }));
  };
  const spacing = input.spacing ? input.box : null;
  const x = chooseAxis(set, 'x', moving('x', input.x), threshold, spacing);
  const y = chooseAxis(set, 'y', moving('y', input.y), threshold, spacing);
  const ox = x?.o ?? 0;
  const oy = y?.o ?? 0;
  if (x === null && y === null) return { ox, oy, overlay: null };
  const snapped = input.snapped?.(ox, oy) ?? translateBox(input.box, ox, oy);
  const offered = (axis: Axis, indices: readonly ValueIndex[], o: number) => {
    const values = valuesOf(input.box, axis);
    return indices.map((index) => values[index] + o);
  };
  const guides = [
    ...(x?.kind === 'align' ? guidesOf(set, 'x', offered('x', input.x, ox), snapped) : []),
    ...(y?.kind === 'align' ? guidesOf(set, 'y', offered('y', input.y, oy), snapped) : []),
  ];
  const gaps = [
    ...(x === null ? [] : gapsOf('x', x, snapped)),
    ...(y === null ? [] : gapsOf('y', y, snapped)),
  ];
  return { ox, oy, overlay: { guides, gaps, angle: null } };
}

/** Snaps a single page point (a box corner, a line end): it offers only itself. */
export function snapPoint(set: SnapSet, at: PagePoint, threshold: number): SnapResult {
  return snapBox(
    set,
    { box: { left: at.x, top: at.y, right: at.x, bottom: at.y }, x: [0], y: [0], spacing: false },
    threshold,
  );
}

/** The multiples of π/2, normalized into (−π, π], the first rotation targets. */
const QUARTERS: readonly number[] = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/**
 * The rotation-angle target (section 4.2) for a one-node rotation whose resulting page rotation
 * is `theta`, with the pointer at distance `r` from the pivot: the nearest of the multiples of
 * π/2 and the candidates' page rotations within `threshold / r` (wrapped), or null; none when
 * `r = 0`. Ties: a multiple of π/2, then the lesser normalized target, then candidate order.
 */
export function snapAngle(
  set: SnapSet,
  theta: number,
  r: number,
  threshold: number,
): number | null {
  if (!(r > 0)) return null;
  const reach = threshold / r;
  let best: { target: number; key: readonly number[] } | null = null;
  const consider = (target: number, rank: number, order: number) => {
    const d = Math.abs(normalizeRotation(target - theta));
    if (!(d <= reach)) return;
    const key = [d, rank, target, order];
    if (best === null || less(key, best.key)) best = { target, key };
  };
  QUARTERS.forEach((target, index) => consider(target, 0, index));
  for (const candidate of set.candidates) consider(candidate.rotation, 1, candidate.order);
  return (best as { target: number } | null)?.target ?? null;
}
