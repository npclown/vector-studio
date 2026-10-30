import type {
  PathStroke,
  RenderChangeSet,
  RenderNodeSnapshot,
  RendererSceneSynchronization,
  SceneApplyResult,
  SceneIdentity,
  SceneRejectionReason,
  ScenePathGeometry,
  ScenePaint,
  ScenePathVerb,
  SceneStroke,
} from '@vector-studio/contracts';
import type {
  DocumentV6,
  Frame,
  LineNodeV6,
  NodeV6,
  Paint,
  PathData,
  Stroke,
} from '@vector-studio/model';
import { ExpansionCache, type Expansion, type ExpansionResult } from './expansion.js';
import { localTransform } from './geometry.js';
import { lineDashes, type LineDash } from './line-dash.js';
import type { DiagnosticEvent } from './types.js';

// The scene projector (P5 plan, section 4.5; MVP M1 contract, section 5): maps the active page of
// the document to `contracts` scene data and keeps an injected renderer synchronized with it.
//
// Every node of the page projects with its parent-local transform under its scene parent: the
// page root (`null`), a group or mask group (its ID) or a frame's content container. A frame is
// one unit of two to four scene nodes with synthetic IDs (the frame ID, U+0000 and a role). After
// a rejected set the projector isolates the units one per set in document pre-order and leaves
// the rejected ones out with their subtrees, until a change touches the subtree again.
//
// A `symbol` projects exactly as a frame. An `instance` (MVP M7 contract, section 4) projects as
// a frame unit with the instance's own placement and the source's fill and stroke, holding its
// expansion from the editor's expansion cache; an expanded node gets the scene ID of the
// instance, U+0000, `@` and its source node ID, so `documentIdOf` maps it to the instance, and
// the instance with its whole expansion is one unit for isolation.

/** Frame-local path geometry for a custom node (its extension's `toScene`), or null. */
export type CustomProjection = (node: NodeV6) => PathData | null;

/** Synthetic scene IDs of a frame (M1 contract, section 5); document IDs never hold U+0000. */
export function frameContentId(frameId: string): string {
  return `${frameId}\u0000content`;
}
export function frameBackgroundId(frameId: string): string {
  return `${frameId}\u0000background`;
}
export function frameBorderId(frameId: string): string {
  return `${frameId}\u0000border`;
}

/**
 * The scene ID of the expanded copy of source node `nodeId` inside instance `instanceId` (M7
 * contract, section 4.1); an expanded frame's roles follow it (`frameContentId` of this ID).
 */
export function expandedId(instanceId: string, nodeId: string): string {
  return `${instanceId}\u0000@${nodeId}`;
}

/**
 * The document ID a scene ID stands for: synthetic frame IDs map back to the frame, and every
 * scene ID of an instance's expansion to the instance.
 */
export function documentIdOf(sceneId: string): string {
  const index = sceneId.indexOf('\u0000');
  return index < 0 ? sceneId : sceneId.slice(0, index);
}

const IDENTITY_TRANSFORM = [1, 0, 0, 1, 0, 0] as const;
const ZERO_RADII = [0, 0, 0, 0] as const;
/**
 * Segments of a fill-mode round cap's half circle (section 5). A line-only polygon, not cubics:
 * the fill kernel rejects cubic caps that share the shaft's end edge (M1-U5 probe), while 16
 * chords stay within 0.25 px up to zoom 104 / w (chord error (w/2)(1 − cos(π/32))).
 */
const ROUND_CAP_SEGMENTS = 16;
/** Above the model's tree depth bound (256), so every walk up a parent chain ends. */
const PARENT_WALK_LIMIT = 300;

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function pathGeometry(path: PathData, sx: number, sy: number): ScenePathGeometry {
  return {
    kind: 'path',
    verbs: [...path.verbs],
    points: path.points.map((value, index) => value * (index % 2 === 0 ? sx : sy) + 0),
    fillRule: path.fillRule,
  };
}

/** Corner radii scaled by `min(1, w/(tl+tr), w/(bl+br), h/(tl+bl), h/(tr+br))` (section 5). */
export function clampedRadii(
  radii: readonly [number, number, number, number],
  width: number,
  height: number,
): [number, number, number, number] {
  const [tl, tr, br, bl] = radii;
  let f = 1;
  for (const [size, sum] of [
    [width, tl + tr],
    [width, bl + br],
    [height, tl + bl],
    [height, tr + br],
  ] as const) {
    if (sum > 0) f = Math.min(f, size / sum);
  }
  return f === 1 ? [tl, tr, br, bl] : [tl * f, tr * f, br * f, bl * f];
}

type Vec = Readonly<{ x: number; y: number }>;

/** `p + s·q`. */
function add(p: Vec, q: Vec, s = 1): Vec {
  return { x: p.x + q.x * s, y: p.y + q.y * s };
}

/** A path built from subpaths; negative zero is removed so equal geometry compares equal. */
class Outline {
  readonly verbs: ScenePathVerb[] = [];
  readonly points: number[] = [];

  private push(verb: ScenePathVerb, points: readonly Vec[]): this {
    this.verbs.push(verb);
    for (const p of points) this.points.push(p.x + 0, p.y + 0);
    return this;
  }

  move(p: Vec): this {
    return this.push('move', [p]);
  }

  line(p: Vec): this {
    return this.push('line', [p]);
  }

  cubic(c1: Vec, c2: Vec, p: Vec): this {
    return this.push('cubic', [c1, c2, p]);
  }

  close(): this {
    return this.push('close', []);
  }

  polygon(vertices: readonly Vec[]): this {
    this.move(vertices[0]!);
    vertices.slice(1).forEach((vertex) => this.line(vertex));
    return this.close();
  }

  /**
   * The closed quad of width `w` along `from → to`: the shaft and line-head rectangle form;
   * `direction`, when given, is the unit direction (a dash piece takes the line's).
   */
  bar(from: Vec, to: Vec, w: number, direction?: Vec): this {
    // E24-K7's line length, as renderer-core measures it.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const m = direction ?? { x: dx / length, y: dy / length };
    const q = { x: -m.y, y: m.x };
    const h = w / 2;
    return this.polygon([add(from, q, -h), add(to, q, -h), add(to, q, h), add(from, q, h)]);
  }

  geometry(): ScenePathGeometry {
    return { kind: 'path', verbs: this.verbs, points: this.points, fillRule: 'nonzero' };
  }
}

type PathContent = Pick<Extract<RenderNodeSnapshot, { kind: 'path' }>, 'geometry' | 'style'>;

/**
 * M4-P1 (MVP M4 contract, section 3): a colour passes through unchanged; a gradient, stored in
 * the unit box of the node's frame, is composed into the box `w × h` of node-local space,
 * `transform = diag(w*, h*) · T` with an axis of size 0 folded as 1 (E23, gradient space).
 */
export function composePaint(paint: Paint, width: number, height: number): ScenePaint {
  if (!('kind' in paint)) return paint;
  const sx = width > 0 ? width : 1;
  const sy = height > 0 ? height : 1;
  const [a, b, c, d, e, f] = paint.transform;
  return {
    kind: paint.kind,
    transform: [sx * a + 0, sy * b + 0, sx * c + 0, sy * d + 0, sx * e + 0, sy * f + 0],
    stops: paint.stops.map((stop) => ({ offset: stop.offset, color: stop.color })),
    spread: paint.spread,
  };
}

function composeFill(fill: Paint | null, width: number, height: number): ScenePaint | null {
  return fill === null ? null : composePaint(fill, width, height);
}

/**
 * M4-P2: a primitive stroke is exactly `{ color, width }`, the only shape the renderer's
 * `copyStroke` accepts, so cap, join, miter limit and dash are left out; its paint is composed
 * in the box `w × h` (M4-P1).
 */
function primitiveStroke(stroke: Stroke | null, width: number, height: number): SceneStroke | null {
  return stroke === null
    ? null
    : { color: composePaint(stroke.color, width, height), width: stroke.width };
}

/**
 * M4-P2: a path stroke carries color, width, cap, join and miter limit, and `dash` only when it
 * is not null (M4-Q14 (a)), so a solid stroke's snapshot is the pre-M4 one (E24-S2); its paint
 * is composed in the box `w × h` (M4-P1).
 */
function pathStroke(stroke: Stroke | null, width: number, height: number): PathStroke | null {
  if (stroke === null) return null;
  const { cap, join, miterLimit, dash } = stroke;
  const color = composePaint(stroke.color, width, height);
  return dash === null
    ? { color, width: stroke.width, cap, join, miterLimit }
    : { color, width: stroke.width, cap, join, miterLimit, dash };
}

/** `4(√2 − 1)/3`, the cubic handle length of a quarter circle of radius 1 (M4-P4). */
export const QUARTER_ARC_HANDLE = 0.5522847498307936;

/**
 * M4-P4: the outline of a `w × h` rectangle with clamped radii `[tl, tr, br, bl]`, from
 * `(tl, 0)` clockwise on screen; a zero radius has no cubic and a zero-length line is omitted.
 */
export function rectangleOutline(
  width: number,
  height: number,
  radii: readonly [number, number, number, number],
): ScenePathGeometry {
  const [tl, tr, br, bl] = radii;
  const k = QUARTER_ARC_HANDLE;
  const w = width;
  const h = height;
  const outline = new Outline().move({ x: tl, y: 0 });
  let at: Vec = { x: tl, y: 0 };
  const line = (p: Vec) => {
    if (p.x !== at.x || p.y !== at.y) outline.line(p);
    at = p;
  };
  const cubic = (c1: Vec, c2: Vec, p: Vec) => {
    outline.cubic(c1, c2, p);
    at = p;
  };
  line({ x: w - tr, y: 0 });
  if (tr > 0) cubic({ x: w - tr + k * tr, y: 0 }, { x: w, y: tr - k * tr }, { x: w, y: tr });
  line({ x: w, y: h - br });
  if (br > 0)
    cubic({ x: w, y: h - br + k * br }, { x: w - br + k * br, y: h }, { x: w - br, y: h });
  line({ x: bl, y: h });
  if (bl > 0) cubic({ x: bl - k * bl, y: h }, { x: 0, y: h - bl + k * bl }, { x: 0, y: h - bl });
  if (tl > 0) {
    line({ x: 0, y: tl });
    cubic({ x: 0, y: tl - k * tl }, { x: tl - k * tl, y: 0 }, { x: tl, y: 0 });
  }
  return outline.close().geometry();
}

/**
 * M4-P4: the outline of a `w × h` ellipse, from `(w, h/2)` through `(w/2, h)`, `(0, h/2)` and
 * `(w/2, 0)` as four cubics, clockwise on screen.
 */
export function ellipseOutline(width: number, height: number): ScenePathGeometry {
  const k = QUARTER_ARC_HANDLE;
  const rx = width / 2;
  const ry = height / 2;
  const kx = k * rx;
  const ky = k * ry;
  return new Outline()
    .move({ x: width, y: ry })
    .cubic({ x: width, y: ry + ky }, { x: rx + kx, y: height }, { x: rx, y: height })
    .cubic({ x: rx - kx, y: height }, { x: 0, y: ry + ky }, { x: 0, y: ry })
    .cubic({ x: 0, y: ry - ky }, { x: rx - kx, y: 0 }, { x: rx, y: 0 })
    .cubic({ x: rx + kx, y: 0 }, { x: width, y: ry - ky }, { x: width, y: ry })
    .close()
    .geometry();
}

/**
 * M4-P3: whether a rectangle-shaped stroke (a rectangle, or a frame, symbol or instance border)
 * stays a P1 primitive: no stroke, a round join with no dash, or an empty box, which draws
 * nothing as a primitive (P1 degenerate rule) and would draw a line as a path.
 */
function rectanglePrimitive(stroke: Stroke | null, width: number, height: number): boolean {
  return (
    stroke === null ||
    (stroke.join === 'round' && stroke.dash === null) ||
    width === 0 ||
    height === 0
  );
}

/** M4-P3: an ellipse stays a primitive with no stroke, no dash or an empty box. */
function ellipsePrimitive(stroke: Stroke | null, width: number, height: number): boolean {
  return stroke === null || stroke.dash === null || width === 0 || height === 0;
}

/**
 * A fill-mode round cap at end `e` with outward direction `u` and cap side `s`: the half disc
 * from `e + (w/2)s` through `e + (w/2)u` to `e − (w/2)s` in 16 chords, both ends exact.
 */
function halfDisc(outline: Outline, e: Vec, u: Vec, s: Vec, h: number): void {
  outline.move(add(e, s, h));
  for (let k = 1; k < ROUND_CAP_SEGMENTS; k += 1) {
    const angle = (k * Math.PI) / ROUND_CAP_SEGMENTS;
    const c = Math.cos(angle);
    const t = Math.sin(angle);
    outline.line(add(e, { x: c * s.x + t * u.x, y: c * s.y + t * u.y }, h));
  }
  outline.line(add(e, s, -h)).close();
}

/**
 * The scene content of a line (section 5, M4-P5): stroke mode (no `triangle` end and no dash,
 * or a dash and no head) keeps the line's stroke; fill mode is one filled outline in the stroke
 * paint, with the literal vertex lists, the shaft dashed in editor-core when the stroke is.
 */
export function lineContent(node: LineNodeV6): PathContent {
  const { width: fw, height: fh } = node.frame;
  const [x0, y0, x1, y1] = node.points;
  const p0 = { x: x0 * fw, y: y0 * fh };
  const p1 = { x: x1 * fw, y: y1 * fh };
  const stroke = node.stroke;
  const w = stroke?.width ?? 0;
  // E24-K7's line length, as renderer-core's `expandDash` measures it, bit for bit.
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const plain = new Outline().move(p0).line(p1);
  const strokeMode = (outline: Outline): PathContent => ({
    geometry: outline.geometry(),
    style: { fill: null, stroke: pathStroke(stroke, fw, fh) },
  });
  if (stroke === null || w === 0 || length === 0) return strokeMode(plain);
  const d = { x: dx / length, y: dy / length };
  const n = { x: -d.y, y: d.x };
  // Each end: tip T, outward direction u, base centre B = T − 4w·u, base corners B ± 2w·n, and
  // the cap side N (n at P0, −n at P1).
  const ends = (
    [
      [node.startArrow, p0, { x: -d.x, y: -d.y }, n],
      [node.endArrow, p1, d, { x: -n.x, y: -n.y }],
    ] as const
  ).map(([arrow, tip, out, side]) => {
    const base = add(tip, out, -4 * w);
    return { arrow, tip, out, side, base, plus: add(base, n, 2 * w), minus: add(base, n, -2 * w) };
  });
  const dash = stroke.dash;
  if (
    dash === null
      ? ends.every((end) => end.arrow !== 'triangle')
      : ends.every((end) => end.arrow === 'none')
  ) {
    // A dashed line here has no head; `line` heads join the stroke only when it is solid.
    for (const end of ends) {
      if (end.arrow === 'line') plain.move(end.plus).line(end.tip).line(end.minus);
    }
    return strokeMode(plain);
  }
  // M4-P5: the dashes of the whole segment; past E24-K8's limit the line goes to stroke mode
  // with the dash and no heads, so the renderer reports `dash-limit` and draws nothing.
  const dashes = dash === null ? null : lineDashes(length, dash);
  if (dash !== null && dashes === null) return strokeMode(plain);
  const outline = new Outline();
  const [start, end] = [ends[0]!, ends[1]!];
  const s0 = start.arrow === 'triangle' ? start.base : start.tip;
  const s1 = end.arrow === 'triangle' ? end.base : end.tip;
  // The shaft and its cap pieces, unless the heads leave no shaft (tested before extension).
  if ((s1.x - s0.x) * d.x + (s1.y - s0.y) * d.y > 0) {
    if (dashes === null) {
      const square = stroke.cap === 'square';
      const a0 = square && start.arrow !== 'triangle' ? add(s0, d, -w / 2) : s0;
      const a1 = square && end.arrow !== 'triangle' ? add(s1, d, w / 2) : s1;
      outline.bar(a0, a1, w);
      if (stroke.cap === 'round') {
        for (const { arrow, tip: e, out: u, side: s } of ends) {
          if (arrow !== 'triangle') halfDisc(outline, e, u, s, w / 2);
        }
      }
    } else {
      dashedShaft(outline, dashes, { p0, p1, d, n, length, w, cap: stroke.cap }, start, end);
    }
  }
  ends.forEach((head, index) => {
    if (head.arrow === 'triangle') {
      outline.polygon(
        index === 0 ? [head.tip, head.minus, head.plus] : [head.tip, head.plus, head.minus],
      );
    } else if (head.arrow === 'line') {
      outline.bar(head.tip, head.plus, w).bar(head.tip, head.minus, w);
    }
  });
  return {
    geometry: outline.geometry(),
    style: { fill: composePaint(stroke.color, fw, fh), stroke: null },
  };
}

type LineEnd = Readonly<{ arrow: string; base: Vec }>;
type Shaft = Readonly<{
  p0: Vec;
  p1: Vec;
  d: Vec;
  n: Vec;
  length: number;
  w: number;
  cap: Stroke['cap'];
}>;

/**
 * M4-P5: the dashes of the segment clipped to the shaft (from a triangle base, or the tip, to
 * the other), each a bar of width `w` with the stroke's cap at its ends, no cap at an end on a
 * triangle base; a zero-length dash is a disc, a local-axis-aligned `w × w` square (E24-K5) or
 * nothing for `butt`. Every piece winds as the solid shaft does, so the nonzero union holds.
 */
function dashedShaft(
  outline: Outline,
  dashes: readonly LineDash[],
  shaft: Shaft,
  start: LineEnd,
  end: LineEnd,
): void {
  const { p0, p1, d, n, length, w, cap } = shaft;
  const h = w / 2;
  const startCut = start.arrow === 'triangle';
  const endCut = end.arrow === 'triangle';
  const from = startCut ? 4 * w : 0;
  const to = endCut ? length - 4 * w : length;
  const minusD = { x: -d.x, y: -d.y };
  const minusN = { x: -n.x, y: -n.y };
  const at = (s: number): Vec => {
    if (startCut && s === from) return start.base;
    if (endCut && s === to) return end.base;
    if (s === 0) return p0;
    if (s === length) return p1;
    return add(p0, d, s);
  };
  for (const piece of dashes) {
    if (piece.s1 < from || piece.s0 > to) continue;
    const c0 = piece.s0 < from ? from : piece.s0;
    const c1 = piece.s1 > to ? to : piece.s1;
    const cut0 = startCut && c0 === from;
    const cut1 = endCut && c1 === to;
    const e0 = at(c0);
    if (c0 === c1) {
      if (cut0 || cut1) continue;
      if (cap === 'round') {
        // The full disc: the end cap's half disc and its continuation, both axis points exact.
        outline.move(add(e0, minusN, h));
        for (let k = 1; k < 2 * ROUND_CAP_SEGMENTS; k += 1) {
          if (k === ROUND_CAP_SEGMENTS) {
            outline.line(add(e0, minusN, -h));
            continue;
          }
          const angle = (k * Math.PI) / ROUND_CAP_SEGMENTS;
          const c = Math.cos(angle);
          const t = Math.sin(angle);
          outline.line(add(e0, { x: c * minusN.x + t * d.x, y: c * minusN.y + t * d.y }, h));
        }
        outline.close();
      } else if (cap === 'square') {
        outline.polygon([
          { x: e0.x - h, y: e0.y - h },
          { x: e0.x + h, y: e0.y - h },
          { x: e0.x + h, y: e0.y + h },
          { x: e0.x - h, y: e0.y + h },
        ]);
      }
      continue;
    }
    const e1 = at(c1);
    const square = cap === 'square';
    outline.bar(square && !cut0 ? add(e0, d, -h) : e0, square && !cut1 ? add(e1, d, h) : e1, w, d);
    if (cap === 'round') {
      if (!cut0) halfDisc(outline, e0, minusD, n, h);
      if (!cut1) halfDisc(outline, e1, d, minusN, h);
    }
  }
}

/**
 * One leaf node's scene snapshot under the scene parent `parentId`, or null when it cannot be
 * projected (an unowned custom type, or a container: containers project through `projectPage`).
 */
export function projectNode(
  node: NodeV6,
  custom: CustomProjection,
  parentId: string | null = null,
): RenderNodeSnapshot | null {
  const base = {
    id: node.id,
    parentId,
    // Exactly the translation to the frame origin for θ = 0 (P5), else section 5's rotation.
    transform: localTransform(node.frame, node.rotation),
    visible: node.visible,
    opacity: node.opacity,
  };
  const { width, height } = node.frame;
  switch (node.type) {
    case 'rectangle': {
      const radii = clampedRadii(node.cornerRadii, width, height);
      const fill = composeFill(node.fill, width, height);
      // M4-P3: a stroke with a miter or bevel join or a dash draws as the M4-P4 outline.
      if (!rectanglePrimitive(node.stroke, width, height)) {
        return {
          ...base,
          kind: 'path',
          geometry: rectangleOutline(width, height, radii),
          style: { fill, stroke: pathStroke(node.stroke, width, height) },
        };
      }
      return {
        ...base,
        kind: 'primitive',
        geometry: { kind: 'rectangle', width, height, cornerRadii: radii },
        style: { fill, stroke: primitiveStroke(node.stroke, width, height) },
      };
    }
    case 'ellipse': {
      const fill = composeFill(node.fill, width, height);
      if (!ellipsePrimitive(node.stroke, width, height)) {
        return {
          ...base,
          kind: 'path',
          geometry: ellipseOutline(width, height),
          style: { fill, stroke: pathStroke(node.stroke, width, height) },
        };
      }
      return {
        ...base,
        kind: 'primitive',
        geometry: { kind: 'ellipse', width, height },
        style: { fill, stroke: primitiveStroke(node.stroke, width, height) },
      };
    }
    case 'line':
      return { ...base, kind: 'path', ...lineContent(node) };
    case 'path':
      // Unit-box points scale by the frame; stroke width stays in page units.
      return {
        ...base,
        kind: 'path',
        geometry: pathGeometry(node.path, width, height),
        style: {
          fill: composeFill(node.fill, width, height),
          stroke: pathStroke(node.stroke, width, height),
        },
      };
    case 'custom': {
      const geometry = custom(node);
      if (geometry === null) return null;
      return {
        ...base,
        kind: 'path',
        geometry: pathGeometry(geometry, 1, 1),
        style: {
          fill: composeFill(node.fill, width, height),
          stroke: pathStroke(node.stroke, width, height),
        },
      };
    }
    default:
      return null;
  }
}

type ContainerSnapshot = Extract<RenderNodeSnapshot, { kind: 'container' }>;

/**
 * What a frame unit draws: a frame's or symbol's own fields, or an instance's placement with its
 * source's fill and stroke (M7 contract, section 4.1). `id` is the unit's scene ID.
 */
type FrameUnit = Readonly<{
  id: string;
  frame: Frame;
  rotation: number;
  visible: boolean;
  opacity: number;
  fill: Paint | null;
  stroke: Stroke | null;
}>;

/**
 * The scene nodes of a frame (section 5), outer first: the outer container, its content
 * container (rect clip) holding the background and `children`, and the border. The paints are
 * composed in the unit's own box (M4-P1): an instance's in the instance's frame, not the source's.
 */
function frameSnapshots(
  node: FrameUnit,
  parentId: string | null,
  children: readonly string[],
): RenderNodeSnapshot[] {
  const { width, height } = node.frame;
  const content = frameContentId(node.id);
  const inner = { transform: IDENTITY_TRANSFORM, visible: true, opacity: 1 };
  const rectangle = { kind: 'rectangle' as const, width, height, cornerRadii: ZERO_RADII };
  const background: RenderNodeSnapshot | null =
    node.fill === null
      ? null
      : {
          id: frameBackgroundId(node.id),
          parentId: content,
          ...inner,
          kind: 'primitive',
          geometry: rectangle,
          style: { fill: composePaint(node.fill, width, height), stroke: null },
        };
  // M4-P3: the border is a primitive as a rectangle is, else the M4-P4 outline with no fill.
  const border: RenderNodeSnapshot | null =
    node.stroke === null
      ? null
      : rectanglePrimitive(node.stroke, width, height)
        ? {
            id: frameBorderId(node.id),
            parentId: node.id,
            ...inner,
            kind: 'primitive',
            geometry: rectangle,
            style: { fill: null, stroke: primitiveStroke(node.stroke, width, height) },
          }
        : {
            id: frameBorderId(node.id),
            parentId: node.id,
            ...inner,
            kind: 'path',
            geometry: rectangleOutline(width, height, ZERO_RADII),
            style: { fill: null, stroke: pathStroke(node.stroke, width, height) },
          };
  const snapshots: RenderNodeSnapshot[] = [
    {
      id: node.id,
      parentId,
      transform: localTransform(node.frame, node.rotation),
      visible: node.visible,
      opacity: node.opacity,
      kind: 'container',
      children: border === null ? [content] : [content, border.id],
      clip: null,
    },
    {
      id: content,
      parentId: node.id,
      ...inner,
      kind: 'container',
      children: background === null ? [...children] : [background.id, ...children],
      clip: { kind: 'rect', x: 0, y: 0, width, height },
    },
  ];
  if (background !== null) snapshots.push(background);
  if (border !== null) snapshots.push(border);
  return snapshots;
}

/** The projection of one page. */
export type PageProjection = Readonly<{
  /** Scene ID to snapshot, in document pre-order (a frame's own nodes before its children). */
  nodes: ReadonlyMap<string, RenderNodeSnapshot>;
  rootOrder: readonly string[];
  /** Projected document IDs in pre-order. */
  units: readonly string[];
  /**
   * The scene IDs of each unit: the node, a frame's two to four nodes, or an instance's frame
   * nodes followed by its whole expansion in the source's pre-order.
   */
  unitIds: ReadonlyMap<string, readonly string[]>;
  /** Instances left out because their expansion is invalid (M7-X3), in pre-order. */
  invalid: readonly string[];
}>;

/** A node's last snapshots, reused while the node, its scene parent and its children hold. */
type MemoEntry = Readonly<{
  node: NodeV6;
  parentId: string | null;
  children: readonly string[] | null;
  snapshots: readonly RenderNodeSnapshot[];
  /**
   * For an instance: the expansion result and source node the snapshots were built from, and
   * the entries of its expanded nodes keyed by source node ID.
   */
  instance?: Readonly<{
    result: ExpansionResult;
    source: NodeV6;
    expanded: ReadonlyMap<string, MemoEntry>;
  }>;
}>;

export type ProjectionMemo = Map<string, MemoEntry>;

/**
 * A change-scoped walk (E26 contract, section 4.3): the units on `path` are projected again;
 * any other unit whose memo entry still holds (same node object and scene parent) and that the
 * renderer holds is kept whole, without a walk of its subtree.
 */
export type ProjectionScope = Readonly<{
  /** The changed units and every document ancestor of one. */
  path: ReadonlySet<string>;
  /** Whether the renderer holds unit `id` as its memo entry has it. */
  held: (id: string) => boolean;
  /** Receives, for each unit the walk sets in the memo, its entry before the walk. */
  replaced: Map<string, MemoEntry | undefined>;
  /** Receives the units kept whole. */
  kept: Set<string>;
}>;

/** The snapshots of `entry` when its node, scene parent and projected children still hold. */
function reusedFrom(
  entry: MemoEntry | undefined,
  node: NodeV6,
  parentId: string | null,
  children: readonly string[] | null,
): readonly RenderNodeSnapshot[] | null {
  if (entry === undefined || entry.node !== node || entry.parentId !== parentId) return null;
  if (entry.children === null || children === null) {
    return entry.children === children ? entry.snapshots : null;
  }
  return sameStrings(entry.children, children) ? entry.snapshots : null;
}

/** The container snapshot of a group or mask group under the scene ID `id`. */
function groupSnapshot(
  id: string,
  node: NodeV6,
  parentId: string | null,
  children: readonly string[],
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: localTransform(node.frame, node.rotation),
    visible: node.visible,
    opacity: node.opacity,
    kind: 'container',
    children,
    clip: node.type === 'maskGroup' ? { kind: 'mask' } : null,
  };
}

/**
 * The scene nodes of the expansion of instance `instance` (M7 contract, section 4.1), appended
 * to `out` in the source's pre-order, a container's own nodes before its children; returns the
 * scene IDs of the projected roots. Every expanded node is projected as the document walk would
 * project it, under its expanded scene ID. A node whose source node object, scene parent and
 * projected children are unchanged keeps its previous snapshots (`previous`), and a rebuilt one
 * equal by value to its previous one keeps the previous object; `next` receives the entries.
 * The expansion's node map is shared by the cache's callers and is only read here.
 */
function projectExpanded(
  instance: string,
  expansion: Expansion,
  custom: CustomProjection,
  previous: ReadonlyMap<string, MemoEntry> | undefined,
  next: Map<string, MemoEntry>,
  out: RenderNodeSnapshot[],
): string[] {
  const walk = (ids: readonly string[], parentId: string): string[] => {
    const projected: string[] = [];
    for (const id of ids) {
      const node = expansion.nodes.get(id);
      if (node === undefined) continue;
      const scene = expandedId(instance, id);
      const old = previous?.get(id);
      const at = out.length;
      let children: string[] | null = null;
      let snapshots: readonly RenderNodeSnapshot[];
      if (node.type === 'group' || node.type === 'maskGroup' || node.type === 'frame') {
        if (node.type === 'maskGroup') {
          const source = node.children[0];
          if (source === undefined || !expansion.nodes.has(source)) continue;
        }
        children = walk(node.children, node.type === 'frame' ? frameContentId(scene) : scene);
        const sceneChildren = children.map((child) => expandedId(instance, child));
        snapshots =
          reusedFrom(old, node, parentId, children) ??
          keepEqual(
            node.type === 'frame'
              ? frameSnapshots({ ...node, id: scene }, parentId, sceneChildren)
              : [groupSnapshot(scene, node, parentId, sceneChildren)],
            old?.snapshots,
          );
      } else {
        const reuse = reusedFrom(old, node, parentId, null);
        if (reuse !== null) {
          snapshots = reuse;
        } else {
          const snapshot = projectNode(node, custom, parentId);
          if (snapshot === null) continue;
          snapshots = keepEqual([{ ...snapshot, id: scene }], old?.snapshots);
        }
      }
      next.set(id, { node, parentId, children, snapshots });
      out.splice(at, 0, ...snapshots);
      projected.push(id);
    }
    return projected;
  };
  return walk(expansion.children, frameContentId(instance)).map((id) => expandedId(instance, id));
}

/**
 * Projects page `pageId` of `document`, leaving out the subtrees rooted at `omit` and a mask
 * group whose source is omitted. With `memo`, a node that did not change keeps the same
 * snapshot objects, so a changed snapshot is always a new object. Instances take their content
 * from `expansions` (M7-X4), the editor's cache shared with the checks and hit testing; one
 * whose expansion is invalid is left out and listed in `invalid` (M7-X3). With `scope` (and a
 * memo), only the units it names are walked: the result lists those units and the invalid
 * instances among their children, with the full `rootOrder` (E26 contract, section 4.3).
 */
export function projectPage(
  document: DocumentV6,
  pageId: string,
  custom: CustomProjection,
  omit: ReadonlySet<string> = new Set(),
  memo?: ProjectionMemo,
  expansions: ExpansionCache = new ExpansionCache(),
  scope?: ProjectionScope,
): PageProjection {
  const built = new Map<string, RenderNodeSnapshot>();
  const order: string[] = [];
  const units: string[] = [];
  const unitIds = new Map<string, readonly string[]>();
  const invalid: string[] = [];

  /** The snapshots of instance `node` and its expansion, or null when it is invalid. */
  const instanceUnit = (
    node: Extract<NodeV6, { type: 'instance' }>,
    parentId: string | null,
  ): MemoEntry | null => {
    const result = expansions.expand(document, node.id);
    const source = Object.hasOwn(document.nodes, node.symbol)
      ? document.nodes[node.symbol]
      : undefined;
    if (result === null || !result.ok || source?.type !== 'symbol') return null;
    const entry = memo?.get(node.id);
    const held = entry?.instance;
    if (
      held !== undefined &&
      entry!.node === node &&
      entry!.parentId === parentId &&
      held.result === result &&
      held.source === source
    ) {
      return entry!;
    }
    const content: RenderNodeSnapshot[] = [];
    const expanded = new Map<string, MemoEntry>();
    const roots = projectExpanded(
      node.id,
      result.expansion,
      custom,
      held?.expanded,
      expanded,
      content,
    );
    // The instance's own frame nodes: its placement, the source's fill and stroke.
    const own = keepEqual(
      frameSnapshots(
        {
          id: node.id,
          frame: node.frame,
          rotation: node.rotation,
          visible: node.visible,
          // The effective opacity, instance × source (MVP M4 contract, M4-P6, M4-Q15 (a)).
          opacity: node.opacity * source.opacity,
          fill: source.fill,
          stroke: source.stroke,
        },
        parentId,
        roots,
      ),
      entry?.snapshots.slice(0, 4),
    );
    return {
      node,
      parentId,
      children: null,
      snapshots: [...own, ...content],
      instance: { result, source, expanded },
    };
  };

  /** Projects `ids` under the scene parent `parentId`; returns the projected document IDs. */
  const walk = (ids: readonly string[], parentId: string | null): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      if (omit.has(id) || !Object.hasOwn(document.nodes, id)) continue;
      const node = document.nodes[id]!;
      if (scope !== undefined && !scope.path.has(id)) {
        const held = memo?.get(id);
        if (held?.node === node && held.parentId === parentId && scope.held(id)) {
          scope.kept.add(id);
          out.push(id);
          continue;
        }
      }
      const at = order.length;
      let entry: MemoEntry;
      if (
        node.type === 'group' ||
        node.type === 'maskGroup' ||
        node.type === 'frame' ||
        node.type === 'symbol'
      ) {
        if (node.type === 'maskGroup') {
          const source = node.children[0];
          if (source === undefined || omit.has(source)) continue;
        }
        units.push(id);
        const frameLike = node.type === 'frame' || node.type === 'symbol';
        const children = walk(node.children, frameLike ? frameContentId(id) : id);
        const snapshots =
          reusedFrom(memo?.get(id), node, parentId, children) ??
          (frameLike
            ? keepEqual(frameSnapshots(node, parentId, children), memo?.get(id)?.snapshots)
            : [groupSnapshot(id, node, parentId, children)]);
        entry = { node, parentId, children, snapshots };
      } else if (node.type === 'instance') {
        const unit = instanceUnit(node, parentId);
        if (unit === null) {
          invalid.push(id);
          continue;
        }
        units.push(id);
        entry = unit;
      } else {
        const snapshot =
          reusedFrom(memo?.get(id), node, parentId, null)?.[0] ??
          projectNode(node, custom, parentId);
        if (snapshot === null) continue;
        units.push(id);
        entry = { node, parentId, children: null, snapshots: [snapshot] };
      }
      if (scope !== undefined && !scope.replaced.has(id)) scope.replaced.set(id, memo?.get(id));
      memo?.set(id, entry);
      const sceneIds = entry.snapshots.map((snapshot) => snapshot.id);
      entry.snapshots.forEach((snapshot) => built.set(snapshot.id, snapshot));
      // A container's own nodes go before its children, which the walk above already listed;
      // an instance's unit lists its expansion after its own nodes.
      // An instance unit can hold up to the page cap of scene IDs, too many for a spread into
      // `splice`; only a container's two to four own nodes go before already listed children.
      if (at === order.length) for (const sceneId of sceneIds) order.push(sceneId);
      else order.splice(at, 0, ...sceneIds);
      unitIds.set(id, sceneIds);
      out.push(id);
    }
    return out;
  };

  const page = document.pages.find((entry) => entry.id === pageId);
  const rootOrder = walk(page?.children ?? [], null);
  // A scoped walk drops the entries of the units it removes (SceneProjector).
  if (memo !== undefined && scope === undefined) {
    for (const id of memo.keys()) if (!Object.hasOwn(document.nodes, id)) memo.delete(id);
  }
  const nodes = new Map<string, RenderNodeSnapshot>();
  for (const id of order) nodes.set(id, built.get(id)!);
  return { nodes, rootOrder, units, unitIds, invalid };
}

/**
 * Keeps the previous object of each synthetic frame node whose value did not change, so that a
 * frame change sends only the frame nodes it changes (leaves compare by identity). An expanded
 * node rebuilt equal by value keeps its previous object the same way (M7 contract, section 4.2).
 */
function keepEqual(
  snapshots: RenderNodeSnapshot[],
  previous: readonly RenderNodeSnapshot[] | undefined,
): RenderNodeSnapshot[] {
  if (previous === undefined) return snapshots;
  return snapshots.map((snapshot) => {
    const old = previous.find((entry) => entry.id === snapshot.id);
    return old !== undefined && JSON.stringify(old) === JSON.stringify(snapshot) ? old : snapshot;
  });
}

function sameClip(a: ContainerSnapshot['clip'], b: ContainerSnapshot['clip']): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'mask' || b.kind === 'mask') return a.kind === b.kind;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Whether the renderer holds `held` as `next`: leaves by identity, containers by value. */
function sameSnapshot(held: RenderNodeSnapshot, next: RenderNodeSnapshot): boolean {
  if (held === next) return true;
  if (held.kind !== 'container' || next.kind !== 'container') return false;
  return (
    held.id === next.id &&
    held.parentId === next.parentId &&
    held.visible === next.visible &&
    held.opacity === next.opacity &&
    held.transform.every((value, index) => value === next.transform[index]) &&
    sameStrings(held.children, next.children) &&
    sameClip(held.clip, next.clip)
  );
}

/** A container's children limited to the scene nodes `held` accepts; other nodes unchanged. */
function limited(snapshot: RenderNodeSnapshot, held: (id: string) => boolean): RenderNodeSnapshot {
  if (snapshot.kind !== 'container' || snapshot.children.every(held)) return snapshot;
  return { ...snapshot, children: snapshot.children.filter(held) };
}

type Changes = Pick<RenderChangeSet, 'inserted' | 'updated' | 'removed' | 'orders'>;
type Rejection = Extract<SceneApplyResult, { status: 'invalid-scene' }>;

export class SceneProjector {
  private readonly renderer: RendererSceneSynchronization;
  private readonly custom: CustomProjection;
  private readonly report: (event: DiagnosticEvent) => void;
  /** The projector's own revision; every scene it sends carries a larger one. */
  private sceneRevision = 0;
  /** The renderer's revision from the last result, the base of the next change set. */
  private base: number | null = null;
  private identity: SceneIdentity | null = null;
  /** What the renderer holds, as far as the projector knows. */
  private sent = new Map<string, RenderNodeSnapshot>();
  private sentOrder: readonly string[] = [];
  /** Roots of subtrees left out after a rejection, until a change touches the subtree. */
  private readonly excluded = new Set<string>();
  /** Snapshots of the last projection, reused for nodes that did not change. */
  private readonly memo: ProjectionMemo = new Map();
  /** The expansion cache the projection reads instances from (M7-X4). */
  private readonly expansions: ExpansionCache;
  /** Instances of the last projection left out for an invalid expansion, already reported. */
  private invalid: ReadonlySet<string> = new Set();
  /** The invalid instances the last projection met (`invalid` also keeps omitted ones). */
  private met: ReadonlySet<string> = new Set();
  /**
   * Whether the renderer holds the last projection through `memo` under the current
   * exclusions, so that the next change can project only what it touched (E26 contract,
   * section 4.3). Isolation, retries, exclusions and failures clear it.
   */
  private scoped = false;
  /** Test seam: every change projects the whole page (the oracle of the scoped path). */
  private wholePage = false;
  private disposed = false;
  private resyncing = false;
  /** The page the projection shows (M1 contract, section 3). */
  private page = '';

  /**
   * `expansions` is the editor's one expansion cache, shared with its checks and hit testing
   * (M7 contract, M7-X4); by default the projector has its own.
   */
  constructor(
    renderer: RendererSceneSynchronization,
    custom: CustomProjection,
    report: (event: DiagnosticEvent) => void,
    expansions: ExpansionCache = new ExpansionCache(),
  ) {
    this.renderer = renderer;
    this.custom = custom;
    this.report = report;
    this.expansions = expansions;
  }

  get active(): boolean {
    return !this.disposed;
  }

  /**
   * Sends the whole projection of `page` under the identity `{ documentId, pageId: page }`: on
   * attach, after a load, after a change of active page and after `resync-required`. The
   * excluded subtrees that `touched` reaches (the change that caused it) are projected again.
   */
  replace(
    document: DocumentV6,
    page: string,
    touched: readonly string[] = [],
    retried = false,
  ): void {
    if (this.disposed) return;
    this.page = page;
    this.release(document, touched);
    // A renderer may already hold a scene from an earlier attach; start above its revision.
    this.raiseRevision(this.renderer.getSynchronizationState().current?.revision);
    const projection = this.project(document);
    const identity = { documentId: document.id, pageId: page };
    const result = this.renderer.replaceSnapshot({
      identity,
      revision: this.nextRevision(),
      nodes: [...projection.nodes.values()],
      rootOrder: projection.rootOrder,
    });
    if (this.accepted(result)) {
      this.identity = identity;
      this.sent = new Map(projection.nodes);
      this.sentOrder = projection.rootOrder;
      this.scoped = true;
      return;
    }
    this.identity = null;
    this.base = null;
    this.scoped = false;
    if (result.status !== 'invalid-scene') return;
    if (isBookkeeping(result)) {
      // Revision bookkeeping, not a node rejection: move above the renderer and send once more.
      this.raiseRevision(result.current?.revision);
      if (!retried) this.replace(document, page, [], true);
      return;
    }
    // A projection of one unit was rejected on its own (P5-U4); otherwise isolate.
    const only = projection.units.length === 1 ? projection.units[0]! : null;
    this.isolate(document, projection, only === null ? null : { id: only, result });
  }

  /** Sends one change set for a document change on `page` that touched `touched`. */
  change(document: DocumentV6, page: string, touched: readonly string[]): void {
    if (this.disposed) return;
    const excluded = this.excluded.size;
    const retry = this.release(document, touched);
    if (this.excluded.size !== excluded) this.scoped = false;
    if (this.identity === null || this.base === null || this.page !== page) {
      this.replace(document, page);
      return;
    }
    // Released subtrees are retried after the main set.
    const result =
      this.scoped && !this.wholePage
        ? this.scopedSync(document, touched)
        : this.sync(this.project(document, retry));
    if (result === null || this.accepted(result)) {
      this.retry(document, retry);
      return;
    }
    if (result.status !== 'invalid-scene') {
      this.resync(document);
      return;
    }
    const { inserted, updated, removed } = result.changes;
    const units = new Set([...inserted, ...updated].map((node) => documentIdOf(node.id)));
    if (units.size === 0) {
      // A rejected removal leaves nodes the document no longer has; a snapshot drops them.
      this.exclude(document, result, [...new Set(removed.map(documentIdOf))]);
      this.resync(document);
    } else if (units.size === 1 && removed.length === 0) {
      // One unit rejected on its own (P5-U4): leave it out and drop its stale copy.
      this.exclude(document, result, [...units]);
      const cleanup = this.sync(this.project(document, retry));
      if (cleanup !== null && !this.accepted(cleanup)) this.resync(document);
      else this.retry(document, retry);
    } else {
      this.isolate(document, this.project(document), null);
    }
  }

  /**
   * Isolation (section 5): an empty snapshot, then the units in batched sets. `only` is a
   * rejection already known to be the projection's only unit's own.
   */
  private isolate(
    document: DocumentV6,
    projection: PageProjection,
    only: Readonly<{ id: string; result: Rejection }> | null,
  ): void {
    this.scoped = false;
    const identity = { documentId: document.id, pageId: this.page };
    let empty = this.sendEmpty(identity);
    if (empty.status === 'invalid-scene' && isBookkeeping(empty)) {
      this.raiseRevision(empty.current?.revision);
      empty = this.sendEmpty(identity);
    }
    if (!this.accepted(empty)) {
      if (empty.status !== 'disposed') this.resync(document);
      return;
    }
    this.identity = identity;
    this.sent = new Map();
    this.sentOrder = [];
    if (only !== null) this.exclude(document, only.result, [only.id]);
    else this.addUnits(document, projection, null);
  }

  /** Retries the released subtrees from their roots, in batched sets. */
  private retry(document: DocumentV6, roots: ReadonlySet<string>): void {
    if (roots.size > 0) this.addUnits(document, this.project(document), roots);
  }

  /**
   * Sends the units of `projection` under `roots` (or every unit) in pre-order, by batched
   * isolation (E26 contract, section 4.2): contiguous segments, split in halves on a rejection,
   * reach the result of one set per unit. A rejected one-unit segment is that unit's rejection:
   * the unit is left out with its subtree, and a rejected mask source takes its mask group out.
   * Rejections are reported once per reason; any other failure ends in a full snapshot.
   */
  private addUnits(
    document: DocumentV6,
    projection: PageProjection,
    roots: ReadonlySet<string> | null,
  ): void {
    this.scoped = false;
    const rejected = new Map<SceneRejectionReason, string[]>();
    const inScope = new Set<string>();
    for (const id of projection.units) {
      if (roots !== null && !roots.has(id) && !inScope.has(document.nodes[id]!.parent)) continue;
      inScope.add(id);
    }
    const units = [...inScope];
    const queue: string[][] = oneUnitIsolation.has(this) ? units.map((id) => [id]) : [units];
    const dead = new Set<string>();
    let failed = false;
    while (queue.length > 0) {
      const segment = this.liveUnits(document, projection, queue.shift()!, dead);
      if (segment.length === 0) continue;
      const result = this.addSegment(projection, segment);
      if (result === null) {
        if (this.disposed) return;
        continue;
      }
      if (this.accepted(result)) continue;
      if (result.status !== 'invalid-scene') {
        failed = true;
        break;
      }
      if (segment.length > 1) {
        const half = Math.ceil(segment.length / 2);
        queue.unshift(segment.slice(0, half), segment.slice(half));
        continue;
      }
      const id = segment[0]!;
      rejected.set(result.reason, [...(rejected.get(result.reason) ?? []), id]);
      dead.add(id);
      const root = this.excludedRoot(document, id);
      this.excluded.add(root);
      if (root !== id) {
        // A mask group whose source is rejected is removed with its subtree.
        dead.add(root);
        const removal = this.removeUnit(root);
        if (removal !== null && !this.accepted(removal)) {
          failed = true;
          break;
        }
      }
    }
    for (const [reason, ids] of rejected) this.reportRejection(reason, ids);
    if (failed) this.resync(document);
  }

  /**
   * The units of `segment` that can be sent now, in pre-order: a unit whose parent unit is dead,
   * or whose scene parent is neither held nor sent with it, is dead itself.
   */
  private liveUnits(
    document: DocumentV6,
    projection: PageProjection,
    segment: readonly string[],
    dead: Set<string>,
  ): string[] {
    const live: string[] = [];
    const own = new Set<string>();
    for (const id of segment) {
      if (dead.has(document.nodes[id]!.parent)) {
        dead.add(id);
        continue;
      }
      const ids = projection.unitIds.get(id)!;
      const parentId = projection.nodes.get(ids[0]!)!.parentId;
      if (parentId !== null && !own.has(parentId)) {
        const parent = projection.nodes.get(parentId);
        if (parent?.kind !== 'container' || !this.sent.has(parentId)) {
          dead.add(id);
          continue;
        }
      }
      live.push(id);
      for (const scene of ids) own.add(scene);
    }
    return live;
  }

  /**
   * Inserts the units of a segment in one set: their nodes (a frame with its synthetic nodes),
   * with containers' children limited to nodes held or inserted here, and one order entry per
   * scene parent the set does not hold, in projection order. Null after `disposed`.
   */
  private addSegment(
    projection: PageProjection,
    segment: readonly string[],
  ): SceneApplyResult | null {
    const own = new Set(segment.flatMap((id) => projection.unitIds.get(id)!));
    const held = (scene: string) => this.sent.has(scene) || own.has(scene);
    const snapshots: RenderNodeSnapshot[] = [];
    const parents = new Set<string | null>();
    for (const id of segment) {
      const ids = projection.unitIds.get(id)!;
      for (const scene of ids) snapshots.push(limited(projection.nodes.get(scene)!, held));
      const parentId = projection.nodes.get(ids[0]!)!.parentId;
      if (parentId === null || !own.has(parentId)) parents.add(parentId);
    }
    const orders = [...parents].map((parentId) => {
      const siblings =
        parentId === null
          ? projection.rootOrder
          : (projection.nodes.get(parentId) as Extract<RenderNodeSnapshot, { kind: 'container' }>)
              .children;
      return { parentId, children: siblings.filter(held) };
    });
    const result = this.apply({
      inserted: snapshots.filter((snapshot) => !this.sent.has(snapshot.id)),
      updated: snapshots.filter((snapshot) => this.sent.has(snapshot.id)),
      removed: [],
      orders,
    });
    if (result !== null && this.accepted(result)) {
      snapshots.forEach((snapshot) => this.sent.set(snapshot.id, snapshot));
      for (const { parentId, children } of orders) this.setHeldChildren(parentId, children);
    }
    return result;
  }

  /** Removes a held unit with every held scene node below it, in one set. */
  private removeUnit(id: string): SceneApplyResult | null {
    const top = this.sent.get(id);
    if (top === undefined) return null;
    const removed: string[] = [];
    const pending = [id];
    while (pending.length > 0) {
      const scene = pending.pop()!;
      const node = this.sent.get(scene);
      if (node === undefined) continue;
      removed.push(scene);
      if (node.kind === 'container') pending.push(...node.children);
    }
    const parentId = top.parentId;
    const parent = parentId === null ? null : this.sent.get(parentId);
    const siblings =
      parentId === null ? this.sentOrder : parent?.kind === 'container' ? parent.children : [];
    const children = siblings.filter((scene) => scene !== id);
    const result = this.apply({
      inserted: [],
      updated: [],
      removed,
      orders: [{ parentId, children }],
    });
    if (result !== null && this.accepted(result)) {
      removed.forEach((scene) => this.sent.delete(scene));
      this.setHeldChildren(parentId, children);
    }
    return result;
  }

  /** Records the held children of a scene parent after an accepted order entry. */
  private setHeldChildren(parentId: string | null, children: readonly string[]): void {
    if (parentId === null) {
      this.sentOrder = children;
      return;
    }
    const parent = this.sent.get(parentId);
    if (parent?.kind === 'container') this.sent.set(parentId, { ...parent, children });
  }

  /** The root to leave out for a rejected node: its mask group when it is a mask source. */
  private excludedRoot(document: DocumentV6, id: string): string {
    const node = Object.hasOwn(document.nodes, id) ? document.nodes[id]! : undefined;
    const parent =
      node !== undefined && Object.hasOwn(document.nodes, node.parent)
        ? document.nodes[node.parent]
        : undefined;
    return parent?.type === 'maskGroup' && parent.children[0] === id ? parent.id : id;
  }

  /** The document parent chain of `id`, itself first (bounded by the tree depth). */
  private chain(document: DocumentV6, id: string): string[] {
    const ids: string[] = [];
    let cursor: string | undefined = id;
    for (let guard = 0; cursor !== undefined && guard < PARENT_WALK_LIMIT; guard += 1) {
      ids.push(cursor);
      cursor = Object.hasOwn(document.nodes, cursor) ? document.nodes[cursor]!.parent : undefined;
    }
    return ids;
  }

  /**
   * Releases the excluded subtrees that `touched` reaches (a touched node in one, or its root)
   * with every excluded root inside them, and returns the outermost roots the document still
   * has; those are retried whole.
   */
  private release(document: DocumentV6, touched: readonly string[]): Set<string> {
    const roots = new Set<string>();
    if (this.excluded.size === 0) return roots;
    for (const id of [...touched, ...this.instancesOfSources(document, touched)]) {
      const top = this.chain(document, id)
        .reverse()
        .find((entry) => this.excluded.has(entry));
      if (top !== undefined) roots.add(top);
    }
    for (const id of [...this.excluded]) {
      if (this.chain(document, id).some((entry) => roots.has(entry))) this.excluded.delete(id);
    }
    for (const root of [...roots]) if (!Object.hasOwn(document.nodes, root)) roots.delete(root);
    return roots;
  }

  /**
   * The instances of every `symbol` that `touched` reaches (a touched symbol, or a touched node
   * with a symbol ancestor), so that a source change releases its excluded instances (M7
   * contract, section 4.2) and re-expands them in a scoped change (E26 contract, section 4.3; a
   * source holds no instance, M7 section 5.3, so none follows further). The reverse index from
   * symbol to instances is one O(n) scan of the node map, made only when a touched node is in a
   * source.
   */
  private instancesOfSources(document: DocumentV6, touched: readonly string[]): string[] {
    const symbols = new Set<string>();
    for (const id of touched) {
      for (const entry of this.chain(document, id)) {
        const node = Object.hasOwn(document.nodes, entry) ? document.nodes[entry] : undefined;
        if (node?.type === 'symbol') symbols.add(entry);
      }
    }
    if (symbols.size === 0) return [];
    const instances: string[] = [];
    for (const id in document.nodes) {
      if (!Object.hasOwn(document.nodes, id)) continue;
      const node = document.nodes[id]!;
      if (node.type === 'instance' && symbols.has(node.symbol)) instances.push(id);
    }
    return instances;
  }

  /**
   * Forgets the renderer's state and sends a full snapshot, once per call chain: a renderer
   * that keeps failing is retried at the next document change, never in a loop.
   */
  private resync(document: DocumentV6): void {
    this.identity = null;
    this.base = null;
    this.scoped = false;
    if (this.resyncing) return;
    this.resyncing = true;
    try {
      this.replace(document, this.page);
    } finally {
      this.resyncing = false;
    }
  }

  /**
   * Sends the difference between what the renderer holds and `projection`: inserts, updates,
   * removals and a root order entry when the paint order changes; a container's new children
   * travel in its own update, so no container order entry is needed. Returns null when there is
   * nothing to send or after `disposed`; state is updated only on success.
   */
  private sync(projection: PageProjection): (SceneApplyResult & { changes: Changes }) | null {
    const changes = this.differences(projection, this.goneFrom(projection));
    if (changes === null) return null;
    const result = this.apply(changes);
    if (result === null) return null;
    if (this.accepted(result)) {
      this.sent = new Map(projection.nodes);
      this.sentOrder = projection.rootOrder;
      this.scoped = true;
    } else {
      this.scoped = false;
    }
    return { ...result, changes };
  }

  /**
   * The change set from what the renderer holds to `projection`, in the projection's pre-order,
   * removing the held nodes `removed` names, in ordinal order; null when there is nothing to send.
   */
  private differences(projection: PageProjection, removed: string[]): Changes | null {
    const inserted: RenderNodeSnapshot[] = [];
    const updated: RenderNodeSnapshot[] = [];
    for (const [id, snapshot] of projection.nodes) {
      const held = this.sent.get(id);
      if (held === undefined) inserted.push(snapshot);
      else if (!sameSnapshot(held, snapshot)) updated.push(snapshot);
    }
    removed.sort(compareOrdinal);
    const reordered = !sameStrings(projection.rootOrder, this.sentOrder);
    if (inserted.length === 0 && updated.length === 0 && removed.length === 0 && !reordered) {
      return null;
    }
    return {
      inserted,
      updated,
      removed,
      orders: reordered ? [{ parentId: null, children: projection.rootOrder }] : [],
    };
  }

  /**
   * The change-scoped `sync` (E26 contract, section 4.3), valid while `scoped` holds: it walks
   * the touched units, the instances whose expansion they change and every ancestor's child list,
   * keeps every other unit whole, and sends the same change set as the whole-page path, whose
   * walk stays the test oracle (`checkScopedProjectionForTesting`).
   */
  private scopedSync(
    document: DocumentV6,
    touched: readonly string[],
  ): (SceneApplyResult & { changes: Changes }) | null {
    const path = new Set<string>();
    const addChain = (id: string) => {
      for (const entry of this.chain(document, id)) {
        if (path.has(entry)) return;
        path.add(entry);
      }
    };
    // Each touched unit's held parent, which may lose it, or the nearest held ancestor the
    // document still has. The editor lists former parents in `touched` too (M7-U3 note 4); this
    // also covers a caller that does not, while the parent is held.
    const formerParents: string[] = [];
    for (const id of touched) {
      let before = this.heldParent(id);
      while (before !== null && !Object.hasOwn(document.nodes, before)) {
        before = this.heldParent(before);
      }
      if (before !== null) formerParents.push(before);
    }
    const changed = [...touched, ...formerParents];
    for (const id of [...changed, ...this.instancesOfSources(document, changed)]) {
      if (Object.hasOwn(document.nodes, id)) addChain(id);
    }

    const oracleMemo = checkScoped ? new Map(this.memo) : null;
    const scope: ProjectionScope = {
      path,
      held: (id) => this.sent.has(id),
      replaced: new Map(),
      kept: new Set(),
    };
    const projection = projectPage(
      document,
      this.page,
      this.custom,
      this.excluded,
      this.memo,
      this.expansions,
      scope,
    );

    // Removals: scene IDs a walked unit no longer has, and the held subtrees of units that left
    // a walked child list without being projected elsewhere. Memo entries of deleted units go
    // too, held or not.
    const present = (unit: string) => projection.unitIds.has(unit) || scope.kept.has(unit);
    const removed = new Set<string>();
    const drop = (unit: string) => {
      if (present(unit)) return;
      const entry = scope.replaced.get(unit) ?? this.memo.get(unit);
      if (entry === undefined) return;
      for (const snapshot of entry.snapshots) {
        if (this.sent.has(snapshot.id)) removed.add(snapshot.id);
      }
      for (const child of entry.children ?? []) drop(child);
      if (!Object.hasOwn(document.nodes, unit)) this.memo.delete(unit);
    };
    for (const [unit, before] of scope.replaced) {
      if (before === undefined || !this.sent.has(unit)) continue;
      const now = this.memo.get(unit)!;
      const ids = new Set(now.snapshots.map((snapshot) => snapshot.id));
      for (const snapshot of before.snapshots) {
        if (!ids.has(snapshot.id) && this.sent.has(snapshot.id)) removed.add(snapshot.id);
      }
      const children = new Set(now.children ?? []);
      for (const child of before.children ?? []) if (!children.has(child)) drop(child);
    }
    const roots = new Set(projection.rootOrder);
    for (const root of this.sentOrder) if (!roots.has(root)) drop(root);

    // The invalid instances met: those of the walk, and those outside it whose parent is kept.
    const met = new Set(projection.invalid);
    for (const id of this.met) {
      if (met.has(id) || path.has(id) || !Object.hasOwn(document.nodes, id)) continue;
      const parent = document.nodes[id]!.parent;
      if (path.has(parent) || !this.sent.has(parent) || removed.has(parent)) continue;
      met.add(id);
    }
    this.noteInvalid(met, this.excluded);

    const changes = this.differences(projection, [...removed]);
    if (oracleMemo !== null) this.checkScoped(document, oracleMemo, changes, met);
    if (changes === null) return null;
    const result = this.apply(changes);
    if (result === null) return null;
    if (this.accepted(result)) {
      for (const id of removed) this.sent.delete(id);
      for (const [id, snapshot] of projection.nodes) this.sent.set(id, snapshot);
      this.sentOrder = projection.rootOrder;
    } else {
      this.scoped = false;
    }
    return { ...result, changes };
  }

  /** The held scene IDs a whole-page projection no longer has. */
  private goneFrom(projection: PageProjection): string[] {
    const gone: string[] = [];
    for (const id of this.sent.keys()) if (!projection.nodes.has(id)) gone.push(id);
    return gone;
  }

  /** The document ID of the scene parent the renderer holds unit `id` under; null at the root. */
  private heldParent(id: string): string | null {
    if (!this.sent.has(id)) return null;
    const parentId = this.memo.get(id)?.parentId ?? null;
    return parentId === null ? null : documentIdOf(parentId);
  }

  /**
   * Test seam (E26-A09): the whole-page path from the same state must give the same change set
   * and the same invalid instances as the scoped one.
   */
  private checkScoped(
    document: DocumentV6,
    memo: ProjectionMemo,
    changes: Changes | null,
    met: ReadonlySet<string>,
  ): void {
    const oracle = projectPage(
      document,
      this.page,
      this.custom,
      this.excluded,
      memo,
      this.expansions,
    );
    const expected = this.differences(oracle, this.goneFrom(oracle));
    const expectedMet = [...oracle.invalid].sort();
    if (
      JSON.stringify(changes) !== JSON.stringify(expected) ||
      JSON.stringify([...met].sort()) !== JSON.stringify(expectedMet)
    ) {
      throw new Error(
        `E26-A09: the scoped projection differs from the whole page: ${JSON.stringify({
          scoped: { changes, met: [...met].sort() },
          wholePage: { changes: expected, met: expectedMet },
        })}`,
      );
    }
  }

  /** Sends one change set on the current base; null when not synchronized or after `disposed`. */
  private apply(changes: Changes): SceneApplyResult | null {
    if (this.disposed || this.identity === null || this.base === null) return null;
    const result = this.renderer.applyChanges({
      identity: this.identity,
      revision: this.nextRevision(),
      baseRevision: this.base,
      ...changes,
    });
    if (result.status === 'disposed') {
      this.disposed = true;
      return null;
    }
    return result;
  }

  private sendEmpty(identity: SceneIdentity): SceneApplyResult {
    return this.renderer.replaceSnapshot({
      identity,
      revision: this.nextRevision(),
      nodes: [],
      rootOrder: [],
    });
  }

  /** Records the renderer's revision on success, and marks the projector dead on `disposed`. */
  private accepted(result: SceneApplyResult): boolean {
    if (result.status === 'disposed') {
      this.disposed = true;
      return false;
    }
    if (result.status !== 'applied' && result.status !== 'replayed') return false;
    this.base = result.current.revision;
    return true;
  }

  /** Reports a rejection of `ids` and leaves their subtrees out until a change touches them. */
  private exclude(document: DocumentV6, result: Rejection, ids: readonly string[]): void {
    this.scoped = false;
    this.reportRejection(result.reason, ids);
    ids.forEach((id) => this.excluded.add(this.excludedRoot(document, id)));
  }

  private reportRejection(reason: SceneRejectionReason, ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.report({
      type: 'diagnostic',
      code:
        reason === 'unsupported-feature' ? 'editor.renderer-unsupported' : 'editor.scene-rejected',
      reason,
      nodeIds: [...ids].sort(),
    });
  }

  /**
   * The projection of the active page minus the exclusions and `skip`. Instances newly left out
   * for an invalid expansion (M7-X3) are reported once, as a rejected scene value, until they
   * project again.
   */
  private project(document: DocumentV6, skip: ReadonlySet<string> = new Set()): PageProjection {
    const omit = skip.size === 0 ? this.excluded : new Set([...this.excluded, ...skip]);
    const projection = projectPage(
      document,
      this.page,
      this.custom,
      omit,
      this.memo,
      this.expansions,
    );
    this.noteInvalid(new Set(projection.invalid), omit);
    return projection;
  }

  /**
   * Records the invalid instances a projection met; reports those not reported yet. An omitted
   * instance was not expanded this time; it stays reported.
   */
  private noteInvalid(met: ReadonlySet<string>, omit: ReadonlySet<string>): void {
    this.met = met;
    const fresh = [...met].filter((id) => !this.invalid.has(id));
    this.invalid = new Set([...met, ...[...this.invalid].filter((id) => omit.has(id))]);
    this.reportRejection('invalid-value', fresh);
  }

  private raiseRevision(revision: number | undefined): void {
    if (revision !== undefined) this.sceneRevision = Math.max(this.sceneRevision, revision);
  }

  private nextRevision(): number {
    this.sceneRevision = Math.max(this.sceneRevision, this.base ?? 0) + 1;
    return this.sceneRevision;
  }
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

let checkScoped = false;
const oneUnitIsolation = new WeakSet<SceneProjector>();

/**
 * Test seam (E26-A09): every scoped change also runs the whole-page path from the same state
 * and throws when the change set or the invalid instances differ. Not exported from the
 * package index.
 */
export function checkScopedProjectionForTesting(enabled: boolean): void {
  checkScoped = enabled;
}

/** Test seam (E26-A09): `projector` always projects the whole page. Not in the package index. */
export function useWholePageProjectionForTesting(projector: SceneProjector): void {
  (projector as unknown as { wholePage: boolean }).wholePage = true;
}

/**
 * Test seam (E26-A06): `projector` isolates one unit per set, the M1 section 5 procedure that
 * batched isolation must match. Not in the package index.
 */
export function useOneUnitIsolationForTesting(projector: SceneProjector): void {
  oneUnitIsolation.add(projector);
}

/** Test seam (E26-A09): the projector's exclusion and invalid-expansion state. */
export function projectorStateForTesting(projector: SceneProjector): {
  excluded: string[];
  invalid: string[];
} {
  const state = projector as unknown as { excluded: Set<string>; invalid: ReadonlySet<string> };
  return { excluded: [...state.excluded].sort(), invalid: [...state.invalid].sort() };
}

function isBookkeeping(result: Rejection): boolean {
  return result.reason === 'stale-snapshot' || result.reason === 'revision-conflict';
}
