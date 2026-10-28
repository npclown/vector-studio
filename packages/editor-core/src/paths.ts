import type { DocumentV2, Frame, PathData, PathNodeV2, PathVerb } from '@vector-studio/model';
import { Draft, fail, type Failure } from './draft.js';
import { isPoint, nodeOf, success, type EditContext, type EditResult } from './edit-support.js';
import { apply, invertRigid, localTransform, multiply, rotate } from './geometry.js';
import { documentTree, pageOf, spaceOf } from './tree.js';
import type { DocumentCommand, PagePoint, PathAnchorRef } from './types.js';

// Path editing (MVP M3 contract, sections 2 and 3): the anchor model of stored path data
// (M3-P1), its serializer (M3-P2), the re-normalization of section 3.1 with value provenance,
// and the commands `movePathAnchors` and `setPathHandle`. The commands act on one `path` node of
// the active page at any depth; groups above it refit through the draft (M1 section 4.2), frames
// do not. Failures follow the order of section 3.5.

/**
 * A coordinate of an edit with its provenance (sections 2 and 3.1): `stored` is a unit value
 * copied or left from the stored data, kept bit for bit while the box is unchanged; `local` is a
 * node-local value the edit computed.
 */
export type EditCoordinate = Readonly<{ stored: number }> | Readonly<{ local: number }>;

/** A point of an edit; each axis has its own provenance (a zero `δ` component copies). */
export type EditPoint = Readonly<{ x: EditCoordinate; y: EditCoordinate }>;

export function storedPoint(u: number, v: number): EditPoint {
  return { x: { stored: u }, y: { stored: v } };
}

export function localPoint(x: number, y: number): EditPoint {
  return { x: { local: x }, y: { local: y } };
}

export type ModelSegment =
  Readonly<{ kind: 'line' }> | Readonly<{ kind: 'cubic'; c1: EditPoint; c2: EditPoint }>;

/**
 * Subpath `s` of the anchor model (M3-P1). Segment `k` runs from anchor `k` to anchor
 * `(k + 1) mod n`; an open subpath has `n − 1` segments, a closed one `n` (its closing segment
 * last, a straight line in the implicit form) except a one-anchor subpath without segments.
 */
export type ModelSubpath = {
  closed: boolean;
  /** Closed with a stored closing segment that ends at anchor 0's stored point. */
  explicit: boolean;
  anchors: EditPoint[];
  segments: ModelSegment[];
};

/** Tolerance factor of the mirrored test (section 2). */
const MIRROR_TOLERANCE = 1e-9;

function storedAt(points: readonly number[], index: number): EditPoint {
  return storedPoint(points[2 * index]!, points[2 * index + 1]!);
}

function sameCoordinate(a: EditCoordinate, b: EditCoordinate): boolean {
  return 'stored' in a && 'stored' in b && a.stored === b.stored;
}

/** Whether both points are stored and have equal stored values (the "equals exactly" test). */
function sameStored(a: EditPoint, b: EditPoint): boolean {
  return sameCoordinate(a.x, b.x) && sameCoordinate(a.y, b.y);
}

/** The anchor model of stored path data (M3-P1); `path` is in the path grammar. */
export function readAnchorModel(path: PathData): ModelSubpath[] {
  const subpaths: ModelSubpath[] = [];
  let current: ModelSubpath | null = null;
  let next = 0;
  for (const verb of path.verbs) {
    if (verb === 'move') {
      current = { closed: false, explicit: false, anchors: [], segments: [] };
      subpaths.push(current);
      current.anchors.push(storedAt(path.points, next));
      next += 1;
    } else if (verb === 'line') {
      current!.segments.push({ kind: 'line' });
      current!.anchors.push(storedAt(path.points, next));
      next += 1;
    } else if (verb === 'cubic') {
      current!.segments.push({
        kind: 'cubic',
        c1: storedAt(path.points, next),
        c2: storedAt(path.points, next + 1),
      });
      current!.anchors.push(storedAt(path.points, next + 2));
      next += 3;
    } else {
      const subpath = current!;
      subpath.closed = true;
      if (subpath.segments.length === 0) continue;
      const last = subpath.anchors[subpath.anchors.length - 1]!;
      if (sameStored(last, subpath.anchors[0]!)) {
        // The explicit closing form: the last segment's end point is anchor 0 again.
        subpath.explicit = true;
        subpath.anchors.pop();
      } else {
        subpath.segments.push({ kind: 'line' });
      }
    }
  }
  return subpaths;
}

/**
 * The serializer (M3-P2): verbs and points with provenance. The closing segment is written when
 * it is a cubic or the subpath is in the explicit form, its end a copy of anchor 0. An unedited
 * model gives back its stored verbs and points.
 */
export function writeAnchorModel(subpaths: readonly ModelSubpath[]): {
  verbs: PathVerb[];
  points: EditPoint[];
} {
  const verbs: PathVerb[] = [];
  const points: EditPoint[] = [];
  const segment = (entry: ModelSegment, end: EditPoint) => {
    if (entry.kind === 'line') {
      verbs.push('line');
      points.push(end);
    } else {
      verbs.push('cubic');
      points.push(entry.c1, entry.c2, end);
    }
  };
  for (const subpath of subpaths) {
    const { anchors, segments } = subpath;
    const n = anchors.length;
    verbs.push('move');
    points.push(anchors[0]!);
    for (let k = 0; k + 1 < n; k += 1) segment(segments[k]!, anchors[k + 1]!);
    if (!subpath.closed) continue;
    const closing = segments.length === n ? segments[n - 1]! : null;
    if (closing !== null && (closing.kind === 'cubic' || subpath.explicit)) {
      segment(closing, anchors[0]!);
    }
    verbs.push('close');
  }
  return { verbs, points };
}

/** Index of the segment leaving anchor `a` (its `out` side), or null. */
export function outSegment(subpath: ModelSubpath, a: number): number | null {
  return a < subpath.segments.length ? a : null;
}

/** Index of the segment entering anchor `a` (its `in` side), or null. */
export function inSegment(subpath: ModelSubpath, a: number): number | null {
  const n = subpath.anchors.length;
  if (subpath.closed) return subpath.segments.length === 0 ? null : (a - 1 + n) % n;
  return a >= 1 ? a - 1 : null;
}

/** An anchor's handles in its model (section 2): the cubic controls on each side, or null. */
export function handlesOf(
  subpath: ModelSubpath,
  a: number,
): Readonly<{ in: EditPoint | null; out: EditPoint | null }> {
  const inIndex = inSegment(subpath, a);
  const outIndex = outSegment(subpath, a);
  const entering = inIndex === null ? undefined : subpath.segments[inIndex];
  const leaving = outIndex === null ? undefined : subpath.segments[outIndex];
  return {
    in: entering?.kind === 'cubic' ? entering.c2 : null,
    out: leaving?.kind === 'cubic' ? leaving.c1 : null,
  };
}

/** A coordinate in node-local units: a stored unit value `u` is `u·size`. */
function localValue(coordinate: EditCoordinate, size: number): number {
  return 'stored' in coordinate ? coordinate.stored * size : coordinate.local;
}

/** A point in node-local units: a stored unit point is `(u·W, v·H)`. */
export function localOf(point: EditPoint, width: number, height: number): PagePoint {
  return { x: localValue(point.x, width), y: localValue(point.y, height) };
}

/** The mirrored test of section 2, on node-local points, per axis. */
export function isMirrored(anchor: PagePoint, handleIn: PagePoint, handleOut: PagePoint): boolean {
  const axis = (a: number, i: number, o: number) =>
    Math.abs(i + o - 2 * a) <=
    MIRROR_TOLERANCE * Math.max(1, Math.abs(i), Math.abs(o), Math.abs(a));
  return axis(anchor.x, handleIn.x, handleOut.x) && axis(anchor.y, handleIn.y, handleOut.y);
}

/**
 * Re-normalization (section 3.1): the frame and unit points of a path whose edited points are
 * `points`, from a node with `frame` and `rotation`. Box unchanged: the frame is kept, stored
 * points keep their values and computed ones become `L / W`. Box changed: every point becomes
 * `(L − min) / w′` and the frame is refit about its own axes. Negative zero becomes 0.
 */
export function renormalize(
  points: readonly EditPoint[],
  frame: Frame,
  rotation: number,
): { frame: Frame; unit: number[] } {
  const { width, height } = frame;
  const local = points.map((point) => localOf(point, width, height));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of local) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const unit: number[] = [];
  const push = (u: number, v: number) => unit.push(u === 0 ? 0 : u, v === 0 ? 0 : v);
  if (minX === 0 && minY === 0 && w === width && h === height) {
    const kept = (coordinate: EditCoordinate, size: number) =>
      'stored' in coordinate ? coordinate.stored : size === 0 ? 0 : coordinate.local / size;
    for (const point of points) push(kept(point.x, width), kept(point.y, height));
    return { frame, unit };
  }
  for (const { x, y } of local) push(w === 0 ? 0 : (x - minX) / w, h === 0 ? 0 : (y - minY) / h);
  let x: number;
  let y: number;
  if (rotation === 0) {
    x = frame.x + minX;
    y = frame.y + minY;
  } else {
    const c = apply(localTransform(frame, rotation), minX + w / 2, minY + h / 2);
    x = c.x - w / 2;
    y = c.y - h / 2;
  }
  return { frame: { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y, width: w, height: h }, unit };
}

type Finish = (draft: Draft) => DocumentV2 | Failure;
type PathTarget = Readonly<{
  node: PathNodeV2;
  model: ModelSubpath[];
  /** Page point to node-local point, and page vector to node-local vector (section 3). */
  toLocal(point: PagePoint): PagePoint;
  toLocalVector(dx: number, dy: number): PagePoint;
}>;

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The shape of a ref (`editor.invalid-command`): an object with finite `subpath` and `anchor`. */
function refShape(value: unknown, path: string): Failure | null {
  if (typeof value !== 'object' || value === null) return fail('editor.invalid-command', path);
  const ref = value as Record<string, unknown>;
  if (!isNumber(ref.subpath)) return fail('editor.invalid-command', `${path}/subpath`);
  if (!isNumber(ref.anchor)) return fail('editor.invalid-command', `${path}/anchor`);
  return null;
}

/** Whether a well-shaped ref names an anchor of the model (`editor.invalid-path-ref`). */
function inRange(model: readonly ModelSubpath[], ref: PathAnchorRef): boolean {
  const { subpath, anchor } = ref;
  return (
    Number.isInteger(subpath) &&
    subpath >= 0 &&
    subpath < model.length &&
    Number.isInteger(anchor) &&
    anchor >= 0 &&
    anchor < model[subpath]!.anchors.length
  );
}

/**
 * The node checks shared by the path commands after their shape checks: `editor.unknown-node`
 * (a node of the active page), then `editor.not-a-path`.
 */
function pathTarget(
  document: DocumentV2,
  id: string,
  context: Pick<EditContext, 'activePage'>,
): PathTarget | Failure {
  const node = nodeOf(document, id);
  const tree = documentTree(document);
  if (node === undefined || pageOf(tree, id) !== context.activePage) {
    return fail('editor.unknown-node');
  }
  if (node.type !== 'path') return fail('editor.not-a-path');
  const space = spaceOf(tree, node.parent);
  const pageRoot = tree.page(node.parent) !== undefined && node.rotation === 0;
  const inverse = invertRigid(multiply(space.matrix, localTransform(node.frame, node.rotation)));
  const phi = space.rotation + node.rotation;
  return {
    node,
    model: readAnchorModel(node.path),
    toLocal: (p) =>
      pageRoot ? { x: p.x - node.frame.x, y: p.y - node.frame.y } : apply(inverse, p.x, p.y),
    toLocalVector: (dx, dy) => rotate(-phi, dx, dy),
  };
}

/**
 * Writes the edited model back into the node (M3-P2, section 3.1); a success returns `[id]`
 * (section 3). A result equal to the stored node returns the document itself with nothing
 * touched (no step, no event, no IDs).
 */
function written(
  document: DocumentV2,
  node: PathNodeV2,
  model: readonly ModelSubpath[],
  finish: Finish,
): EditResult {
  const { verbs, points } = writeAnchorModel(model);
  const { frame, unit } = renormalize(points, node.frame, node.rotation);
  const same =
    frame.x === node.frame.x &&
    frame.y === node.frame.y &&
    frame.width === node.frame.width &&
    frame.height === node.frame.height &&
    verbs.length === node.path.verbs.length &&
    verbs.every((verb, i) => verb === node.path.verbs[i]) &&
    unit.length === node.path.points.length &&
    unit.every((value, i) => value === node.path.points[i]);
  if (same) return { ok: true, document, touched: [], created: [] };
  const draft = new Draft(document);
  draft.set({ ...node, frame, path: { ...node.path, verbs, points: unit } });
  const result = success(finish(draft), draft, []);
  return result.ok ? { ...result, ids: [node.id] } : result;
}

/**
 * A point moved by the node-local vector `d`; an axis whose component is exactly zero (±0) keeps
 * its coordinate as is, copied (section 2, value provenance).
 */
function plus(point: EditPoint, d: PagePoint, width: number, height: number): EditPoint {
  const axis = (coordinate: EditCoordinate, delta: number, size: number): EditCoordinate =>
    delta === 0 ? coordinate : { local: localValue(coordinate, size) + delta };
  return { x: axis(point.x, d.x, width), y: axis(point.y, d.y, height) };
}

/**
 * `movePathAnchors` (section 3.2): each listed anchor and the handles it has move by the page
 * vector `(dx, dy)` turned into the node's local axes. A relative command (S1).
 */
export function movePathAnchors(
  document: DocumentV2,
  command: Extract<DocumentCommand, { type: 'movePathAnchors' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const { id, anchors: refs, dx, dy } = command as Record<string, unknown>;
  if (typeof id !== 'string') return fail('editor.invalid-command', '/id');
  if (!Array.isArray(refs) || refs.length === 0) return fail('editor.invalid-command', '/anchors');
  const seen = new Set<string>();
  for (const [i, ref] of (refs as unknown[]).entries()) {
    const shape = refShape(ref, `/anchors/${i}`);
    if (shape !== null) return shape;
    const { subpath, anchor } = ref as PathAnchorRef;
    const key = `${subpath},${anchor}`;
    if (seen.has(key)) return fail('editor.invalid-command', '/anchors');
    seen.add(key);
  }
  if (!isNumber(dx)) return fail('editor.invalid-command', '/dx');
  if (!isNumber(dy)) return fail('editor.invalid-command', '/dy');
  const target = pathTarget(document, id, context);
  if ('ok' in target) return target;
  const { node, model } = target;
  const list = refs as readonly PathAnchorRef[];
  const bad = list.findIndex((ref) => !inRange(model, ref));
  if (bad >= 0) return fail('editor.invalid-path-ref', `/anchors/${bad}`);
  const { width, height } = node.frame;
  const delta = target.toLocalVector(dx, dy);
  for (const ref of list) {
    const subpath = model[ref.subpath]!;
    const a = ref.anchor;
    // The handles are read from the unmoved model: each control belongs to one anchor.
    const outIndex = outSegment(subpath, a);
    const inIndex = inSegment(subpath, a);
    subpath.anchors[a] = plus(subpath.anchors[a]!, delta, width, height);
    const leaving = outIndex === null ? undefined : subpath.segments[outIndex];
    if (leaving?.kind === 'cubic') {
      subpath.segments[outIndex!] = {
        ...leaving,
        c1: plus(leaving.c1, delta, width, height),
      };
    }
    const entering = inIndex === null ? undefined : subpath.segments[inIndex];
    if (entering?.kind === 'cubic') {
      subpath.segments[inIndex!] = {
        ...entering,
        c2: plus(entering.c2, delta, width, height),
      };
    }
  }
  return written(document, node, model, finish);
}

/**
 * Sets the control on one side of segment `k` of `subpath` (`start`: its `c1`, else its `c2`); a
 * line first becomes a cubic whose controls are copies of its end anchors.
 */
function setControl(subpath: ModelSubpath, k: number, start: boolean, value: EditPoint): void {
  const n = subpath.anchors.length;
  const segment = subpath.segments[k]!;
  const cubic =
    segment.kind === 'cubic'
      ? segment
      : ({
          kind: 'cubic',
          c1: subpath.anchors[k]!,
          c2: subpath.anchors[(k + 1) % n]!,
        } as const);
  subpath.segments[k] = start ? { ...cubic, c1: value } : { ...cubic, c2: value };
}

/**
 * `setPathHandle` (section 3.2): moves one handle of an anchor to a page point, with an optional
 * mirrored opposite handle, or retracts it with `to: null` (a cubic retracted at both ends
 * becomes a line). A relative command (S1).
 */
export function setPathHandle(
  document: DocumentV2,
  command: Extract<DocumentCommand, { type: 'setPathHandle' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const { id, anchor: ref, side, to, mirror } = command as Record<string, unknown>;
  if (typeof id !== 'string') return fail('editor.invalid-command', '/id');
  const shape = refShape(ref, '/anchor');
  if (shape !== null) return shape;
  if (side !== 'in' && side !== 'out') return fail('editor.invalid-command', '/side');
  if (to !== null && !isPoint(to)) return fail('editor.invalid-command', '/to');
  if (mirror !== undefined && typeof mirror !== 'boolean') {
    return fail('editor.invalid-command', '/mirror');
  }
  const target = pathTarget(document, id, context);
  if ('ok' in target) return target;
  const { node, model } = target;
  const anchorRef = ref as PathAnchorRef;
  if (!inRange(model, anchorRef)) return fail('editor.invalid-path-ref', '/anchor');
  const subpath = model[anchorRef.subpath]!;
  const a = anchorRef.anchor;
  const own = side === 'out' ? outSegment(subpath, a) : inSegment(subpath, a);
  if (own === null) return fail('editor.invalid-path-ref', '/side');
  const opposite =
    mirror === true ? (side === 'out' ? inSegment(subpath, a) : outSegment(subpath, a)) : null;
  const anchor = subpath.anchors[a]!;
  // The `out` side is the start (`c1`) of its segment, the `in` side the end (`c2`).
  const ownStart = side === 'out';
  if (to !== null) {
    const { width, height } = node.frame;
    const t = target.toLocal(to);
    setControl(subpath, own, ownStart, localPoint(t.x, t.y));
    if (opposite !== null) {
      const p = localOf(anchor, width, height);
      setControl(subpath, opposite, !ownStart, localPoint(2 * p.x - t.x, 2 * p.y - t.y));
    }
  } else {
    const affected: number[] = [];
    const retract = (k: number, start: boolean) => {
      if (subpath.segments[k]!.kind === 'line') return;
      setControl(subpath, k, start, anchor);
      affected.push(k);
    };
    retract(own, ownStart);
    if (opposite !== null) retract(opposite, !ownStart);
    // A cubic whose controls equal its end anchors' stored values exactly becomes a line.
    const n = subpath.anchors.length;
    for (const k of affected) {
      const segment = subpath.segments[k]!;
      if (
        segment.kind === 'cubic' &&
        sameStored(segment.c1, subpath.anchors[k]!) &&
        sameStored(segment.c2, subpath.anchors[(k + 1) % n]!)
      ) {
        subpath.segments[k] = { kind: 'line' };
      }
    }
  }
  return written(document, node, model, finish);
}
