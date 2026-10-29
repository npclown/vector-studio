import type { DocumentV5, Frame, NodeV5, PathData } from '@vector-studio/model';
import {
  apply,
  boundsOfPoints,
  corners,
  invertRigid,
  localTransform,
  rotate,
  rotatedBounds,
} from './geometry.js';
import { ExpansionCache, type Expansion } from './expansion.js';
import { clampedRadii } from './projector.js';
import {
  ancestors,
  childrenOf,
  documentTree,
  isContainer,
  isFrameLike,
  isGroup,
  spaceOf,
  type TreeView,
} from './tree.js';
import type { PagePoint } from './types.js';

// Hit testing (P5 plan, section 4.4; MVP M1 contract, section 6): fill regions and outlines,
// with outlines flattened by editor-core itself at 0.25 / zoom page units, through rotation and
// containers, inside frame clips and mask regions. Exact geometry-port hit testing is deferred.
// A `symbol` is hit as a frame; an `instance` (MVP M7 contract, section 4.3) is hit as a frame
// on its source's background and border and wherever a node of its expansion, read from the
// editor's expansion cache, would be hit inside its content clip, and the hit names the instance.

/** Frame-local path geometry for a custom node (its extension's `toScene`), or null. */
export type CustomGeometry = (node: NodeV5) => PathData | null;

export type Polyline = { points: PagePoint[]; closed: boolean };

/** Holds the 0.25 / zoom bound for curves up to about 10^5 / zoom page units across. */
const MAX_SEGMENTS_PER_CUBIC = 4096;

export function cubicSegments(
  p0: PagePoint,
  p1: PagePoint,
  p2: PagePoint,
  p3: PagePoint,
  tolerance: number,
) {
  // The control-polygon second difference bounds the deviation of the chords (Wang's formula).
  const ddx = Math.max(Math.abs(p0.x - 2 * p1.x + p2.x), Math.abs(p1.x - 2 * p2.x + p3.x));
  const ddy = Math.max(Math.abs(p0.y - 2 * p1.y + p2.y), Math.abs(p1.y - 2 * p2.y + p3.y));
  const n = Math.ceil(Math.sqrt((3 * Math.hypot(ddx, ddy)) / (4 * tolerance)));
  return Math.min(MAX_SEGMENTS_PER_CUBIC, Math.max(1, Number.isFinite(n) ? n : 1));
}

/** The cubic Bézier point at `t`, in Bernstein form (the chord ends of `flatten`). */
export function cubicAt(
  p0: PagePoint,
  p1: PagePoint,
  p2: PagePoint,
  p3: PagePoint,
  t: number,
): PagePoint {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * Flattens path data into page-space polylines for a frame: `unit` data is in the frame's unit
 * box (path nodes), other data in frame-local page units (custom-node geometry).
 */
export function flatten(
  path: PathData,
  frame: Frame,
  unit: boolean,
  tolerance: number,
): Polyline[] {
  const sx = unit ? frame.width : 1;
  const sy = unit ? frame.height : 1;
  const at = (index: number): PagePoint => ({
    x: frame.x + path.points[index]! * sx,
    y: frame.y + path.points[index + 1]! * sy,
  });
  const lines: Polyline[] = [];
  let current: Polyline | null = null;
  let cursor = 0;
  for (const verb of path.verbs) {
    if (verb === 'move') {
      current = { points: [at(cursor)], closed: false };
      lines.push(current);
      cursor += 2;
    } else if (verb === 'line' && current !== null) {
      current.points.push(at(cursor));
      cursor += 2;
    } else if (verb === 'cubic' && current !== null) {
      const p0 = current.points[current.points.length - 1]!;
      const [p1, p2, p3] = [at(cursor), at(cursor + 2), at(cursor + 4)];
      const n = cubicSegments(p0, p1, p2, p3, tolerance);
      for (let i = 1; i <= n; i += 1) current.points.push(cubicAt(p0, p1, p2, p3, i / n));
      cursor += 6;
    } else if (verb === 'close' && current !== null) {
      current.closed = true;
      current = null;
    }
  }
  return lines;
}

/** The clamped projection parameter of `p` on the chord `a`–`b`, and its distance there. */
export function projectToSegment(
  p: PagePoint,
  a: PagePoint,
  b: PagePoint,
): { t: number; distance: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return { t, distance: Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) };
}

export function distanceToSegment(p: PagePoint, a: PagePoint, b: PagePoint): number {
  return projectToSegment(p, a, b).distance;
}

function nearOutline(p: PagePoint, lines: readonly Polyline[], radius: number): boolean {
  for (const { points, closed } of lines) {
    if (points.length === 1 && Math.hypot(p.x - points[0]!.x, p.y - points[0]!.y) <= radius) {
      return true;
    }
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i += 1) {
      if (distanceToSegment(p, points[i]!, points[(i + 1) % points.length]!) <= radius) return true;
    }
  }
  return false;
}

/** Winding number over every subpath, each closed implicitly, as a fill does. */
export function insideFill(p: PagePoint, lines: readonly Polyline[], evenOdd: boolean): boolean {
  let winding = 0;
  for (const { points } of lines) {
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      if (a.y <= p.y) {
        if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) winding += 1;
      } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) {
        winding -= 1;
      }
    }
  }
  return evenOdd ? winding % 2 !== 0 : winding !== 0;
}

function rectangleOutline(frame: Frame): Polyline {
  const { x, y, width, height } = frame;
  return {
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    closed: true,
  };
}

/** Segments for an arc of `radius` over `sweep` radians within `tolerance` of the curve. */
function arcSegments(radius: number, sweep: number, tolerance: number): number {
  // The sagitta of a chord over angle a is about r·a²/8.
  const n = Math.ceil(sweep * Math.sqrt(radius / (8 * tolerance)));
  return Math.min(MAX_SEGMENTS_PER_CUBIC, Math.max(1, Number.isFinite(n) ? n : 1));
}

/** Appends the arc about `(cx, cy)` from angle `from` over `sweep` (clockwise on screen). */
function pushArc(
  points: PagePoint[],
  cx: number,
  cy: number,
  radius: number,
  from: number,
  sweep: number,
  tolerance: number,
): void {
  const n = arcSegments(radius, Math.abs(sweep), tolerance);
  for (let i = 0; i <= n; i += 1) {
    const angle = from + (sweep * i) / n;
    points.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  }
}

/** The outline of a rectangle with clamped corner radii (section 5), flattened. */
function roundedOutline(frame: Frame, radii: readonly number[], tolerance: number): Polyline {
  const { x, y, width: w, height: h } = frame;
  const [tl, tr, br, bl] = radii as [number, number, number, number];
  const points: PagePoint[] = [];
  const half = Math.PI / 2;
  if (tl > 0) pushArc(points, x + tl, y + tl, tl, Math.PI, half, tolerance);
  else points.push({ x, y });
  if (tr > 0) pushArc(points, x + w - tr, y + tr, tr, -half, half, tolerance);
  else points.push({ x: x + w, y });
  if (br > 0) pushArc(points, x + w - br, y + h - br, br, 0, half, tolerance);
  else points.push({ x: x + w, y: y + h });
  if (bl > 0) pushArc(points, x + bl, y + h - bl, bl, half, half, tolerance);
  else points.push({ x, y: y + h });
  return { points, closed: true };
}

/** Whether `p` is inside the rectangle with clamped corner radii. */
function insideRounded(p: PagePoint, frame: Frame, radii: readonly number[]): boolean {
  const { x, y, width: w, height: h } = frame;
  if (p.x < x || p.x > x + w || p.y < y || p.y > y + h) return false;
  const [tl, tr, br, bl] = radii as [number, number, number, number];
  const corner = (cx: number, cy: number, r: number, inX: boolean, inY: boolean) =>
    !(inX && inY) || Math.hypot(p.x - cx, p.y - cy) <= r;
  return (
    corner(x + tl, y + tl, tl, p.x < x + tl, p.y < y + tl) &&
    corner(x + w - tr, y + tr, tr, p.x > x + w - tr, p.y < y + tr) &&
    corner(x + w - br, y + h - br, br, p.x > x + w - br, p.y > y + h - br) &&
    corner(x + bl, y + h - bl, bl, p.x < x + bl, p.y > y + h - bl)
  );
}

function insideBox(p: PagePoint, frame: Frame): boolean {
  return (
    p.x >= frame.x &&
    p.x <= frame.x + frame.width &&
    p.y >= frame.y &&
    p.y <= frame.y + frame.height
  );
}

/** The ellipse inscribed in a frame, flattened within `tolerance`. */
function ellipseOutline(frame: Frame, tolerance: number): Polyline {
  const rx = frame.width / 2;
  const ry = frame.height / 2;
  const cx = frame.x + rx;
  const cy = frame.y + ry;
  const n = Math.max(8, arcSegments(Math.max(rx, ry), 2 * Math.PI, tolerance));
  const points: PagePoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const angle = (2 * Math.PI * i) / n;
    points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  return { points, closed: true };
}

function insideEllipse(p: PagePoint, frame: Frame): boolean {
  const rx = frame.width / 2;
  const ry = frame.height / 2;
  if (rx <= 0 || ry <= 0) return false;
  const u = (p.x - frame.x - rx) / rx;
  const v = (p.y - frame.y - ry) / ry;
  return u * u + v * v <= 1;
}

/**
 * The outline pieces of a line in its unrotated frame (section 5 geometry): the segment, then
 * each arrowhead as an open polyline (`line`) or a closed triangle (`triangle`). A line without
 * a stroke, of stroke width 0 or of zero length has no arrowheads.
 */
function lineOutline(node: Extract<NodeV5, { type: 'line' }>): {
  lines: Polyline[];
  triangles: Polyline[];
} {
  const { x, y, width, height } = node.frame;
  const p0 = { x: x + node.points[0] * width, y: y + node.points[1] * height };
  const p1 = { x: x + node.points[2] * width, y: y + node.points[3] * height };
  const lines: Polyline[] = [{ points: [p0, p1], closed: false }];
  const triangles: Polyline[] = [];
  const w = node.stroke?.width ?? 0;
  const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (w === 0 || length === 0) return { lines, triangles };
  const d = { x: (p1.x - p0.x) / length, y: (p1.y - p0.y) / length };
  const n = { x: -d.y, y: d.x };
  const head = (arrow: string, tip: PagePoint, u: PagePoint) => {
    if (arrow === 'none') return;
    const base = { x: tip.x - 4 * w * u.x, y: tip.y - 4 * w * u.y };
    const left = { x: base.x + 2 * w * n.x, y: base.y + 2 * w * n.y };
    const right = { x: base.x - 2 * w * n.x, y: base.y - 2 * w * n.y };
    const outline = { points: [left, tip, right], closed: arrow === 'triangle' };
    (arrow === 'triangle' ? triangles : lines).push(outline);
  };
  head(node.startArrow, p0, { x: -d.x, y: -d.y });
  head(node.endArrow, p1, d);
  return { lines, triangles };
}

/** A point in a node's parent space, turned into its unrotated frame (a rigid map). */
function intoFrame(node: NodeV5, parentPoint: PagePoint): PagePoint {
  if (node.rotation === 0) return parentPoint;
  const cx = node.frame.x + node.frame.width / 2;
  const cy = node.frame.y + node.frame.height / 2;
  const turned = rotate(-node.rotation, parentPoint.x - cx, parentPoint.y - cy);
  return { x: cx + turned.x, y: cy + turned.y };
}

/**
 * Whether `point`, in the node's parent space, hits the leaf `node` at `zoom` (P5 plan, section
 * 4.4; M1 contract, section 6). Containers never hit here; `visible` of the node itself counts.
 */
export function hitsNode(
  node: NodeV5,
  parentPoint: PagePoint,
  zoom: number,
  custom: CustomGeometry,
): boolean {
  if (!node.visible) return false;
  if (isContainer(node)) return false;
  // An instance is hit through its expansion in `visitHits` (M7 contract, section 4.3).
  if (node.type === 'instance') return false;
  // Into the unrotated frame: a rigid map, so distances are unchanged (M1 contract, section 6).
  const point = intoFrame(node, parentPoint);
  // Text is hit in its rotated frame box as a filled rectangle, or within the stroke tolerance
  // of its edge, with no layout (M6a contract, section 7, M6a-Q7).
  if (node.type === 'text') {
    return (
      insideBox(point, node.frame) || nearOutline(point, [rectangleOutline(node.frame)], 4 / zoom)
    );
  }
  const radius = Math.max((node.stroke?.width ?? 0) / 2, 4 / zoom);
  const tolerance = 0.25 / zoom;
  if (node.type === 'rectangle') {
    const radii = clampedRadii(node.cornerRadii, node.frame.width, node.frame.height);
    if (radii.every((r) => r === 0)) {
      if (node.fill !== null && insideBox(point, node.frame)) return true;
      return nearOutline(point, [rectangleOutline(node.frame)], radius);
    }
    if (node.fill !== null && insideRounded(point, node.frame, radii)) return true;
    return nearOutline(point, [roundedOutline(node.frame, radii, tolerance)], radius);
  }
  if (node.type === 'ellipse') {
    if (node.fill !== null && insideEllipse(point, node.frame)) return true;
    return nearOutline(point, [ellipseOutline(node.frame, tolerance)], radius);
  }
  if (node.type === 'line') {
    const { lines, triangles } = lineOutline(node);
    if (triangles.some((triangle) => insideFill(point, [triangle], false))) return true;
    return nearOutline(point, [...lines, ...triangles], radius);
  }
  const geometry = node.type === 'path' ? node.path : custom(node);
  if (geometry === null) return false;
  const lines = flatten(geometry, node.frame, node.type === 'path', tolerance);
  if (node.fill !== null && insideFill(point, lines, geometry.fillRule === 'evenodd')) return true;
  return nearOutline(point, lines, radius);
}

/** Whether `point`, in a mask group's local space, is inside its source's fill region. */
function insideMask(source: NodeV5 | undefined, point: PagePoint, zoom: number): boolean {
  if (source?.type !== 'path') return false;
  // Fill, opacity and visibility of the source are ignored; its fill rule applies.
  const lines = flatten(source.path, source.frame, true, 0.25 / zoom);
  return insideFill(intoFrame(source, point), lines, source.path.fillRule === 'evenodd');
}

/** A lazily evaluated clip: whether the point is inside every clipping ancestor. */
type Clip = () => boolean;

function memo(test: () => boolean): Clip {
  let value: boolean | undefined;
  return () => (value ??= test());
}

/** The nodes of one instance's expansion as a tree, for the walk below. */
function expansionTree(expansion: Expansion): TreeView {
  return { node: (id) => expansion.nodes.get(id), page: () => undefined };
}

/**
 * Visits the nodes of `page` hit at `point` in reverse paint order, at any depth (M1 contract,
 * section 6): leaves, and frames and symbols on their background or border; never a group, a
 * mask group or a mask source. An instance is visited as a frame with its source's fill and
 * stroke, and once for each hit of a node of its expansion (M7 contract, section 4.3); with an
 * invalid expansion (M7-X3) only its background and border are hit. `take` returns true to stop.
 * A frame hit on both its border and its background is visited twice.
 */
function visitHits(
  document: DocumentV5,
  page: string,
  point: PagePoint,
  zoom: number,
  custom: CustomGeometry,
  take: (id: string) => boolean,
  expansions: ExpansionCache,
): void {
  const tree = documentTree(document);
  // The tree depth is bounded by 256 (M1-S3), and through an expansion by M7-S5, so the
  // recursion is too. Each call returns true when `take` stopped the walk. Inside an expansion
  // `view` is the expansion's tree and `owner` the instance every hit names.
  const visit = (
    view: TreeView,
    owner: string | null,
    id: string,
    parentPoint: PagePoint,
    clip: Clip,
  ): boolean => {
    const node = view.node(id);
    if (node === undefined || !node.visible) return false;
    const hit = () => clip() && take(owner ?? id);
    if (!isContainer(node) && node.type !== 'instance') {
      return hitsNode(node, parentPoint, zoom, custom) && hit();
    }
    const local = apply(
      invertRigid(localTransform(node.frame, node.rotation)),
      parentPoint.x,
      parentPoint.y,
    );
    const box = { x: 0, y: 0, width: node.frame.width, height: node.frame.height };
    const children = (
      inner: Clip,
      ids: readonly string[],
      from: number,
      within: TreeView,
      as: string | null,
    ): boolean => {
      for (let i = ids.length - 1; i >= from; i -= 1) {
        if (visit(within, as, ids[i]!, local, inner)) return true;
      }
      return false;
    };
    if (isGroup(node)) {
      if (node.type === 'group') return children(clip, node.children, 0, view, owner);
      const source = view.node(node.children[0]!);
      return children(
        memo(() => clip() && insideMask(source, local, zoom)),
        node.children,
        1,
        view,
        owner,
      );
    }
    // A frame paints its background, its children inside its rect, then its border; an
    // instance paints its source's background and border around its expansion.
    let fill: boolean;
    let stroke: Extract<NodeV5, { type: 'frame' }>['stroke'];
    let content: readonly string[] = [];
    let within = view;
    let as = owner;
    const inside = insideBox(local, box);
    if (node.type === 'instance') {
      const source = tree.node(node.symbol);
      fill = source?.type === 'symbol' && source.fill !== null;
      stroke = source?.type === 'symbol' ? source.stroke : null;
      // An instance's content is always clipped to its box, so outside it nothing inside hits.
      const result = inside ? expansions.expand(document, node.id) : null;
      if (result !== null && result.ok) {
        content = result.expansion.children;
        within = expansionTree(result.expansion);
        as = owner ?? node.id;
      }
    } else {
      fill = node.fill !== null;
      stroke = node.stroke;
      content = node.children;
    }
    if (stroke !== null) {
      const radius = Math.max(stroke.width / 2, 4 / zoom);
      if (nearOutline(local, [rectangleOutline(box)], radius) && hit()) return true;
    }
    if (
      children(
        memo(() => inside && clip()),
        content,
        0,
        within,
        as,
      )
    ) {
      return true;
    }
    return fill && inside && hit();
  };
  const roots = tree.page(page)?.children ?? [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    if (visit(tree, null, roots[i]!, point, () => true)) return;
  }
}

/**
 * The deepest node of `page` hit at `point` in reverse paint order, at any depth (M1 contract,
 * section 6): a leaf or an instance, or a frame or symbol on its background or border; never a
 * group, a mask group, a mask source or a node of an expansion. Null when nothing is hit.
 * `expansions` is the editor's expansion cache, shared with the projector (M7-X4).
 */
export function deepestHit(
  document: DocumentV5,
  page: string,
  point: PagePoint,
  zoom: number,
  custom: CustomGeometry,
  expansions: ExpansionCache = new ExpansionCache(),
): string | null {
  let found: string | null = null;
  visitHits(
    document,
    page,
    point,
    zoom,
    custom,
    (id) => {
      found = id;
      return true;
    },
    expansions,
  );
  return found;
}

/**
 * Every node of `page` hit at `point`, in reverse paint order without repeats (the overlap
 * stack of M2 contract, section 5, before its selection targets are taken).
 */
export function hitsAt(
  document: DocumentV5,
  page: string,
  point: PagePoint,
  zoom: number,
  custom: CustomGeometry,
  expansions: ExpansionCache = new ExpansionCache(),
): string[] {
  const found = new Set<string>();
  visitHits(
    document,
    page,
    point,
    zoom,
    custom,
    (id) => {
      found.add(id);
      return false;
    },
    expansions,
  );
  return [...found];
}

/**
 * The selection target of a hit node (M1 contract, section 6; M2 contract, section 5): its
 * outermost ancestor below the scope. With `scope` null the scope is the page, and a frame whose
 * parent is the page acts as an artboard: a hit inside it targets the frame's child on the chain,
 * and a hit on the frame itself targets the frame. With a scope container, the target is the
 * chain's node whose parent is the scope; inside a scope no frame acts as an artboard. The caller
 * passes a scope only for a hit strictly inside its subtree; otherwise the page rule applies.
 */
export function selectionTarget(
  document: DocumentV5,
  id: string,
  scope: string | null = null,
): string | null {
  const tree = documentTree(document);
  const chain = [id, ...ancestors(tree, id).map((node) => node.id)];
  const index = scope === null ? -1 : chain.indexOf(scope);
  if (index > 0) return chain[index - 1]!;
  const top = tree.node(chain[chain.length - 1]!)!;
  // A top-level frame or symbol acts as an artboard (M7 contract, section 1.2).
  if (isFrameLike(top) && chain.length >= 2) return chain[chain.length - 2]!;
  return top.id;
}

/** The chain from a hit node up to its selection target, innermost first; empty for no target. */
export function targetChain(
  document: DocumentV5,
  id: string,
  scope: string | null = null,
): string[] {
  const target = selectionTarget(document, id, scope);
  if (target === null) return [];
  const tree = documentTree(document);
  const chain = [id];
  for (const node of ancestors(tree, id)) {
    if (chain[chain.length - 1] === target) break;
    chain.push(node.id);
  }
  return chain;
}

function intersects(frame: Frame, box: Frame): boolean {
  return (
    frame.x <= box.x + box.width &&
    box.x <= frame.x + frame.width &&
    frame.y <= box.y + box.height &&
    box.y <= frame.y + frame.height
  );
}

function contains(box: Frame, frame: Frame): boolean {
  return (
    box.x <= frame.x &&
    frame.x + frame.width <= box.x + box.width &&
    box.y <= frame.y &&
    frame.y + frame.height <= box.y + box.height
  );
}

/**
 * The marquee candidates of section 6, in paint order: the visible children of the scope owner
 * (`scope`, or the page when null; M2 contract, section 5) whose rotated frame's page-aligned
 * bounds intersect the rectangle (P5-Q5), except that a frame or symbol child is selected only
 * when the rectangle contains those bounds entirely (M7 contract, section 4.3); an instance is a
 * candidate as a leaf. Children of other containers are not candidates.
 */
export function marqueeHits(
  document: DocumentV5,
  page: string,
  box: Frame,
  scope: string | null = null,
): string[] {
  const tree = documentTree(document);
  return childrenOf(tree, scope ?? page).filter((id) => {
    const node = tree.node(id);
    if (node === undefined || !node.visible) return false;
    // A page child with rotation 0 uses the frame itself, bit-identical with P5; a scope's
    // child is in its parent's space, so it uses its page-space bounds.
    const frame =
      scope === null
        ? node.rotation === 0
          ? node.frame
          : rotatedBounds(node)
        : boundsOf(document, [id])!;
    return isFrameLike(node) ? contains(box, frame) : intersects(frame, box);
  });
}

/**
 * The page-aligned bounds of the rotated frames of `ids` in page space, at any depth (M1
 * contract, section 6), or null when there are none.
 */
export function boundsOf(document: DocumentV5, ids: readonly string[]): Frame | null {
  const tree = documentTree(document);
  const points: PagePoint[] = [];
  for (const id of ids) {
    const node = tree.node(id);
    if (node === undefined) continue;
    const { matrix } = spaceOf(tree, node.parent);
    for (const corner of corners(node.frame, node.rotation)) {
      points.push(apply(matrix, corner.x, corner.y));
    }
  }
  return boundsOfPoints(points);
}
