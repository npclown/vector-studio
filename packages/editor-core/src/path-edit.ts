import type { DocumentV2, PathData, PathNodeV2 } from '@vector-studio/model';
import { deepFreeze } from './freeze.js';
import { apply, invertRigid, localTransform, multiply, type Matrix } from './geometry.js';
import {
  cubicAt,
  cubicSegments,
  distanceToSegment,
  flatten,
  insideFill,
  projectToSegment,
} from './hit-test.js';
import {
  handlesOf,
  inSegment,
  isMirrored,
  localOf,
  outSegment,
  readAnchorModel,
  type EditPoint,
  type ModelSubpath,
} from './paths.js';
import { documentTree, pageOf, spaceOf } from './tree.js';
import type {
  PagePoint,
  PathAnchorRef,
  PathEditAnchor,
  PathEditOverlay,
  PathEditState,
} from './types.js';

// Path edit mode geometry (MVP M3 contract, sections 4, 5 and 5.1): the edited path's anchor
// model in page space, the `pathOverlay` query, the edit-mode targets at a point (anchors, then
// visible handles, then segments, then the fill) and the structure that anchor retention
// compares. Targets read the same page points as the overlay, so a host's markers and the
// tool's picks agree. No ancestor clip, mask or mask-source rule applies here (section 5).

/** A segment of a subpath in page space: a line, or a cubic with its two page controls. */
export type PageSegment =
  Readonly<{ kind: 'line' }> | Readonly<{ kind: 'cubic'; c1: PagePoint; c2: PagePoint }>;

export type PageSubpath = Readonly<{
  closed: boolean;
  model: ModelSubpath;
  /** Anchor page points, by anchor index. */
  anchors: readonly PagePoint[];
  segments: readonly PageSegment[];
}>;

/** The edited path in page space, with its node-to-page placement. */
export type PathGeometry = Readonly<{
  node: PathNodeV2;
  subpaths: readonly PageSubpath[];
  /** Node-local point to page point (section 5.1). */
  toPage(point: PagePoint): PagePoint;
  /** Page point to node-local point. */
  toLocal(point: PagePoint): PagePoint;
}>;

/** An edit-mode target at a point (section 5, targets 1 to 4). */
export type PathTarget =
  | Readonly<{ kind: 'anchor'; ref: PathAnchorRef }>
  | Readonly<{ kind: 'handle'; ref: PathAnchorRef; side: 'in' | 'out'; point: PagePoint }>
  | Readonly<{ kind: 'segment'; subpath: number; segment: number }>
  | Readonly<{ kind: 'fill' }>;

/** The `path` node `id` of `page`, or undefined. */
export function editablePath(
  document: DocumentV2,
  page: string,
  id: string,
): PathNodeV2 | undefined {
  const node = Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined;
  if (node?.type !== 'path') return undefined;
  return pageOf(documentTree(document), id) === page ? node : undefined;
}

/**
 * The page-space anchor model of `node` (section 5.1): a node-local point `L` maps by
 * `apply(C, L.x, L.y)` with `C = spaceOf(parent).matrix · localTransform(frame, θ)`, and exactly
 * to `(x + u·W, y + v·H)` for a page-root node with `θ = 0`, as `flatten` does.
 */
export function pathGeometry(document: DocumentV2, node: PathNodeV2): PathGeometry {
  const tree = documentTree(document);
  const { frame, rotation } = node;
  const pageRoot = tree.page(node.parent) !== undefined && rotation === 0;
  const matrix: Matrix = multiply(
    spaceOf(tree, node.parent).matrix,
    localTransform(frame, rotation),
  );
  const inverse = invertRigid(matrix);
  const toPage = (l: PagePoint): PagePoint =>
    pageRoot ? { x: frame.x + l.x, y: frame.y + l.y } : apply(matrix, l.x, l.y);
  const toLocal = (p: PagePoint): PagePoint =>
    pageRoot ? { x: p.x - frame.x, y: p.y - frame.y } : apply(inverse, p.x, p.y);
  const page = (point: EditPoint) => toPage(localOf(point, frame.width, frame.height));
  const subpaths = readAnchorModel(node.path).map((model): PageSubpath => ({
    closed: model.closed,
    model,
    anchors: model.anchors.map(page),
    segments: model.segments.map((segment): PageSegment =>
      segment.kind === 'line'
        ? segment
        : { kind: 'cubic', c1: page(segment.c1), c2: page(segment.c2) },
    ),
  }));
  return { node, subpaths, toPage, toLocal };
}

const refKey = (ref: PathAnchorRef) => `${ref.subpath},${ref.anchor}`;

/** Whether `refs` lists the anchor (`-0` and `0` are one index). */
export function hasRef(refs: readonly PathAnchorRef[], ref: PathAnchorRef): boolean {
  const key = refKey(ref);
  return refs.some((entry) => refKey(entry) === key);
}

/** A canonical copy of refs without repeats: sorted by `(subpath, anchor)`, `-0` as 0. */
export function canonicalRefs(refs: readonly PathAnchorRef[]): PathAnchorRef[] {
  const seen = new Map<string, PathAnchorRef>();
  for (const { subpath, anchor } of refs) {
    const ref = { subpath: subpath + 0, anchor: anchor + 0 };
    seen.set(refKey(ref), ref);
  }
  return [...seen.values()].sort((a, b) => a.subpath - b.subpath || a.anchor - b.anchor);
}

/** Every anchor of the path, canonical (the edit-mode `selectAll`). */
export function allAnchors(path: PathData): PathAnchorRef[] {
  return readAnchorModel(path).flatMap((subpath, s) =>
    subpath.anchors.map((_, anchor) => ({ subpath: s, anchor })),
  );
}

/**
 * The structure anchor retention compares (section 4): the subpath count and each subpath's
 * anchor count and closed flag.
 */
export function sameStructure(a: PathData, b: PathData): boolean {
  if (a === b) return true;
  const x = readAnchorModel(a);
  const y = readAnchorModel(b);
  return (
    x.length === y.length &&
    x.every(
      (subpath, s) =>
        subpath.anchors.length === y[s]!.anchors.length && subpath.closed === y[s]!.closed,
    )
  );
}

/** The anchor at the other end of segment `k` from anchor `a`. */
function otherEnd(subpath: ModelSubpath, k: number, a: number): number {
  const n = subpath.anchors.length;
  return k === a ? (k + 1) % n : k;
}

/**
 * The visible handles of anchor `a` (section 5): a side's handle is visible when its anchor or
 * the other end of that side's segment is selected; null when absent or hidden.
 */
function visibleHandles(
  geometry: PathGeometry,
  s: number,
  a: number,
  selected: (subpath: number, anchor: number) => boolean,
): { in: PagePoint | null; out: PagePoint | null } {
  const subpath = geometry.subpaths[s]!;
  const { model } = subpath;
  const { width, height } = geometry.node.frame;
  const handles = handlesOf(model, a);
  const shown = (k: number | null, handle: EditPoint | null) =>
    k !== null && handle !== null && (selected(s, a) || selected(s, otherEnd(model, k, a)))
      ? geometry.toPage(localOf(handle, width, height))
      : null;
  return {
    in: shown(inSegment(model, a), handles.in),
    out: shown(outSegment(model, a), handles.out),
  };
}

/** Whether anchor `a` is mirrored (section 2): both handles pass the midpoint test. */
function mirroredAt(geometry: PathGeometry, s: number, a: number): boolean {
  const { model } = geometry.subpaths[s]!;
  const { width, height } = geometry.node.frame;
  const handles = handlesOf(model, a);
  if (handles.in === null || handles.out === null) return false;
  return isMirrored(
    localOf(model.anchors[a]!, width, height),
    localOf(handles.in, width, height),
    localOf(handles.out, width, height),
  );
}

function selectedTest(state: PathEditState) {
  const keys = new Set(state.anchors.map(refKey));
  return (subpath: number, anchor: number) => keys.has(refKey({ subpath, anchor }));
}

/** The `pathOverlay` query value (section 5.1): frozen, in page space. */
export function pathEditOverlay(document: DocumentV2, state: PathEditState): PathEditOverlay {
  const node = document.nodes[state.id] as PathNodeV2;
  const geometry = pathGeometry(document, node);
  const selected = selectedTest(state);
  return deepFreeze({
    id: state.id,
    subpaths: geometry.subpaths.map((subpath, s) => ({
      closed: subpath.closed,
      anchors: subpath.anchors.map((point, a): PathEditAnchor => ({
        point,
        ...visibleHandles(geometry, s, a, selected),
        selected: selected(s, a),
        mirrored: mirroredAt(geometry, s, a),
      })),
    })),
  });
}

/** Segment `k` of `subpath` flattened into page-space chord ends (`flatten`'s Wang count). */
export function segmentPolyline(subpath: PageSubpath, k: number, tolerance: number): PagePoint[] {
  const n = subpath.anchors.length;
  const p0 = subpath.anchors[k]!;
  const p3 = subpath.anchors[(k + 1) % n]!;
  const segment = subpath.segments[k]!;
  if (segment.kind === 'line') return [p0, p3];
  const { c1, c2 } = segment;
  const count = cubicSegments(p0, c1, c2, p3, tolerance);
  const points = [p0];
  for (let i = 1; i <= count; i += 1) points.push(cubicAt(p0, c1, c2, p3, i / count));
  return points;
}

/**
 * The insertion parameter of a segment double-click (section 5, M3-Q12): with segment `k` of
 * subpath `s` flattened at `0.25 / zoom` into `N` chords (`N = 1` for a line) and the nearest
 * chord `j` (ties to the lower `j`) with clamped projection parameter `σ`, `t = (j + σ) / N`.
 */
export function segmentParameter(
  document: DocumentV2,
  node: PathNodeV2,
  s: number,
  k: number,
  point: PagePoint,
  zoom: number,
): number {
  const points = segmentPolyline(pathGeometry(document, node).subpaths[s]!, k, 0.25 / zoom);
  const count = points.length - 1;
  let best = { j: 0, t: 0, distance: Infinity };
  for (let j = 0; j < count; j += 1) {
    const { t, distance } = projectToSegment(point, points[j]!, points[j + 1]!);
    if (distance < best.distance) best = { j, t, distance };
  }
  return (best.j + best.t) / count;
}

/** Whether `point` is inside the edited path's fill region, through every ancestor. */
function insidePathFill(geometry: PathGeometry, point: PagePoint, tolerance: number): boolean {
  const { node } = geometry;
  if (node.fill === null) return false;
  // In node-local units, as `hitsNode` flattens a path in its own unrotated frame.
  const box = { x: 0, y: 0, width: node.frame.width, height: node.frame.height };
  const lines = flatten(node.path, box, true, tolerance);
  return insideFill(geometry.toLocal(point), lines, node.path.fillRule === 'evenodd');
}

/**
 * The edit-mode target at the page point `point` (section 5): (1) the nearest anchor within
 * `radius`, ties to the lower ref; (2) the nearest visible handle within `radius`, ties to the
 * lower ref then `in` before `out`; (3) the nearest segment within `max(w / 2, 4 / zoom)` of its
 * outline flattened at `0.25 / zoom`, ties to the lower `(subpath, segment)`; (4) the fill when
 * the path has one; else null (the M2 hit rules apply).
 */
export function pathTargetAt(
  document: DocumentV2,
  state: PathEditState,
  point: PagePoint,
  zoom: number,
  radius: number,
): PathTarget | null {
  const node = document.nodes[state.id] as PathNodeV2;
  const geometry = pathGeometry(document, node);
  const distance = (p: PagePoint) => Math.hypot(point.x - p.x, point.y - p.y);
  const { subpaths } = geometry;
  // Each pass visits refs in ascending order and keeps the first of equal distances.
  let target: PathTarget | null = null;
  let best = radius;
  for (const [s, subpath] of subpaths.entries()) {
    for (const [a, p] of subpath.anchors.entries()) {
      const d = distance(p);
      if (d < best || (target === null && d <= best)) {
        target = { kind: 'anchor', ref: { subpath: s, anchor: a } };
        best = d;
      }
    }
  }
  if (target !== null) return target;
  const selected = selectedTest(state);
  best = radius;
  for (const [s, subpath] of subpaths.entries()) {
    for (let a = 0; a < subpath.anchors.length; a += 1) {
      const handles = visibleHandles(geometry, s, a, selected);
      for (const side of ['in', 'out'] as const) {
        const p = handles[side];
        if (p === null) continue;
        const d = distance(p);
        if (d < best || (target === null && d <= best)) {
          target = { kind: 'handle', ref: { subpath: s, anchor: a }, side, point: p };
          best = d;
        }
      }
    }
  }
  if (target !== null) return target;
  const tolerance = 0.25 / zoom;
  best = Math.max((node.stroke?.width ?? 0) / 2, 4 / zoom);
  for (const [s, subpath] of subpaths.entries()) {
    for (let k = 0; k < subpath.segments.length; k += 1) {
      const points = segmentPolyline(subpath, k, tolerance);
      let d = Infinity;
      for (let i = 0; i + 1 < points.length; i += 1) {
        d = Math.min(d, distanceToSegment(point, points[i]!, points[i + 1]!));
      }
      if (d < best || (target === null && d <= best)) {
        target = { kind: 'segment', subpath: s, segment: k };
        best = d;
      }
    }
  }
  if (target !== null) return target;
  return insidePathFill(geometry, point, tolerance) ? { kind: 'fill' } : null;
}
