import { nodeFills } from './fills.js';
import type { DocumentV8, FillPaint, NodeV8, PathNodeV8, PathVerb } from '@vector-studio/model';
import {
  booleanOp,
  type BooleanOp,
  type BPoint,
  type BSegment,
  type BShape,
} from './boolean/index.js';
import { Draft, fail, type Failure } from './draft.js';
import {
  freshId,
  inserted,
  nodeOf,
  PENDING_ID,
  success,
  uniqueIds,
  type CustomRules,
  type EditContext,
  type EditResult,
} from './edit-support.js';
import { apply, fitPoints, localTransform, multiply, type Matrix } from './geometry.js';
import { clampedRadii, ellipseOutline, rectangleOutline } from './projector.js';
import { childrenOf, documentTree } from './tree.js';
import type { DocumentCommand } from './types.js';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), section 2: the boolean command.
// Inputs (2.1) become closed contours in their shared parent's space, the engine (2.4) combines
// them, and one path node (2.3, B1 to B5) replaces them in one transaction.

export const BOOLEAN_OPS: readonly BooleanOp[] = ['union', 'subtract', 'intersect', 'exclude'];

type Finish = (draft: Draft) => DocumentV8 | Failure;
type Outline = Readonly<{ verbs: readonly string[]; points: readonly number[] }>;

/**
 * The node-local outline of a boolean input (section 2.1), or null when the node is not one: a
 * rectangle with clamped radii, an ellipse, a path scaled from its unit box, or a custom node
 * with a path projection. The fill rule is the node's own.
 */
function inputOutline(
  node: NodeV8,
  custom: CustomRules,
): (Outline & { fillRule: 'nonzero' | 'evenodd' }) | null {
  const { width, height } = node.frame;
  switch (node.type) {
    case 'rectangle':
      return rectangleOutline(width, height, clampedRadii(node.cornerRadii, width, height));
    case 'ellipse':
      return ellipseOutline(width, height);
    case 'path':
      return {
        verbs: node.path.verbs,
        points: node.path.points.map((value, i) => value * (i % 2 === 0 ? width : height)),
        fillRule: node.path.fillRule,
      };
    case 'custom': {
      const geometry = custom.geometry?.(node) ?? null;
      return geometry === null ? null : geometry;
    }
    default:
      return null;
  }
}

/**
 * Closed contours of `outline` under `m` (node-local to parent space, applied to every control
 * point). Open subpaths close with a line; exactly degenerate segments are left out.
 */
export function outlineContours(outline: Outline, m: Matrix): BSegment[][] {
  const contours: BSegment[][] = [];
  let contour: BSegment[] = [];
  let start: BPoint | null = null;
  let at: BPoint | null = null;
  let next = 0;
  const point = (): BPoint => {
    const p = apply(m, outline.points[next]!, outline.points[next + 1]!);
    next += 2;
    return p;
  };
  const same = (a: BPoint, b: BPoint) => a.x === b.x && a.y === b.y;
  const end = () => {
    if (start !== null && at !== null && !same(at, start)) {
      contour.push({ kind: 'line', p0: at, p1: start });
    }
    if (contour.length > 0) contours.push(contour);
    contour = [];
    start = null;
    at = null;
  };
  for (const verb of outline.verbs) {
    if (verb === 'move') {
      end();
      start = point();
      at = start;
    } else if (verb === 'line') {
      const p1 = point();
      if (!same(at!, p1)) contour.push({ kind: 'line', p0: at!, p1 });
      at = p1;
    } else if (verb === 'cubic') {
      const c1 = point();
      const c2 = point();
      const p1 = point();
      if (!(same(at!, c1) && same(c1, c2) && same(c2, p1))) {
        contour.push({ kind: 'cubic', p0: at!, c1, c2, p1 });
      }
      at = p1;
    } else {
      end();
    }
  }
  end();
  return contours;
}

/**
 * Engine contours (closed, each ending where it starts) as path verbs and parent-space points.
 * A closing line is left implicit, as the M3 serializer writes it; a closing cubic is written.
 */
export function contoursPath(contours: readonly (readonly BSegment[])[]): {
  verbs: PathVerb[];
  points: number[];
} {
  const verbs: PathVerb[] = [];
  const points: number[] = [];
  for (const contour of contours) {
    const first = contour[0]!;
    verbs.push('move');
    points.push(first.p0.x, first.p0.y);
    contour.forEach((segment, i) => {
      const last = i === contour.length - 1;
      if (segment.kind === 'line') {
        if (last && segment.p1.x === first.p0.x && segment.p1.y === first.p0.y) return;
        verbs.push('line');
        points.push(segment.p1.x, segment.p1.y);
      } else {
        verbs.push('cubic');
        points.push(segment.c1.x, segment.c1.y, segment.c2.x, segment.c2.y);
        points.push(segment.p1.x, segment.p1.y);
      }
    });
    verbs.push('close');
  }
  return { verbs, points };
}

/** A node's unit box to its parent's space: the frame transform after a scale by the size. */
function unitBox(node: Readonly<{ frame: NodeV8['frame']; rotation: number }>): Matrix {
  const { width, height } = node.frame;
  return multiply(localTransform(node.frame, node.rotation), [width, 0, 0, height, 0, 0]);
}

function inverse(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0 || !Number.isFinite(det)) return null;
  const inv: Matrix = [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
  return inv.every(Number.isFinite) ? inv : null;
}

/**
 * E41-B2: `paint` of a node with unit-box map `from`, re-mapped so that it paints the same parent
 * (and page) pixels in the unit box `to`. A colour is unchanged. A gradient whose new transform
 * is not invertible (a zero-size input, which paints no area) keeps its own.
 */
export function remapPaint<P extends FillPaint>(paint: P, from: Matrix, to: Matrix): P {
  // V32-M6: an image paint is kept; its scale mode re-fits the result's box.
  if (!('kind' in paint) || paint.kind === 'image') return paint;
  const back = inverse(to);
  if (back === null) return paint;
  const transform = multiply(back, multiply(from, paint.transform));
  if (inverse(transform) === null) return paint;
  return {
    ...paint,
    transform: transform.map((v) => (v === 0 ? 0 : v)) as unknown as Matrix,
  };
}

/** `booleanNodes` (E41 contract, sections 2.1 to 2.3). */
export function booleanNodes(
  document: DocumentV8,
  command: Extract<DocumentCommand, { type: 'booleanNodes' }>,
  context: EditContext,
  custom: CustomRules,
  finish: Finish,
): EditResult {
  const ids = uniqueIds(command.ids);
  if (ids === null) return fail('editor.invalid-command', '/ids');
  if (!BOOLEAN_OPS.includes(command.op)) return fail('editor.invalid-command', '/op');
  if (ids.some((id) => nodeOf(document, id) === undefined)) return fail('editor.unknown-node');
  if (ids.length < 2) return fail('editor.boolean-unsupported');
  const owner = document.nodes[ids[0]!]!.parent;
  if (ids.some((id) => document.nodes[id]!.parent !== owner)) {
    return fail('editor.boolean-unsupported');
  }
  const parent = nodeOf(document, owner);
  // A path never sits directly in a set (V-37 contract, section 2.1).
  if (parent?.type === 'symbolSet') return fail('editor.invalid-parent', '/parent');
  const siblings = childrenOf(documentTree(document), owner);
  if (parent?.type === 'maskGroup' && ids.includes(siblings[0]!)) {
    return fail('editor.boolean-unsupported');
  }
  // Paint order, bottom first (section 2.2).
  const inputs = siblings.filter((child) => ids.includes(child)).map((id) => document.nodes[id]!);
  const shapes: BShape[] = [];
  for (const node of inputs) {
    const outline = node.visible ? inputOutline(node, custom) : null;
    if (outline === null) return fail('editor.boolean-unsupported');
    shapes.push({
      contours: outlineContours(outline, localTransform(node.frame, node.rotation)),
      fillRule: outline.fillRule,
    });
  }
  const result = booleanOp(command.op, shapes);
  if (!result.ok) {
    return fail(
      result.code === 'empty'
        ? 'editor.boolean-empty'
        : result.code === 'too-large'
          ? 'editor.boolean-too-large'
          : 'editor.boolean-failed',
    );
  }
  const { verbs, points } = contoursPath(result.contours);
  const { frame, unit } = fitPoints(points, 0);
  const base = inputs[0]!;
  const from = unitBox(base);
  const to = unitBox({ frame, rotation: 0 });
  // V35-C4: the result takes A₀'s fills and blend mode (E41-B2's rule over the list).
  const fills = nodeFills(base).map((entry) => ({
    ...entry,
    paint: remapPaint(entry.paint, from, to),
  }));
  const stroke =
    'stroke' in base && base.stroke !== null
      ? { ...base.stroke, color: remapPaint(base.stroke.color, from, to) }
      : null;
  const build = (id: string): EditResult => {
    const node: PathNodeV8 = {
      id,
      parent: owner,
      name: base.name,
      type: 'path',
      frame,
      rotation: 0,
      constraints: base.constraints,
      opacity: base.opacity,
      visible: true,
      effects: base.effects,
      path: { verbs, points: unit, fillRule: 'nonzero' },
      fills,
      stroke,
      blendMode: base.blendMode === 'passThrough' ? 'normal' : base.blendMode,
      // V39-E4: the result carries the base's bindings; the draft drops those that fail.
      ...(base.bindings === undefined ? {} : { bindings: base.bindings }),
    };
    const draft = new Draft(document);
    for (const input of inputs) draft.remove(input.id);
    draft.set(node);
    // The result takes the topmost input's slot (E41-B2).
    const top = siblings.indexOf(inputs[inputs.length - 1]!.id) - (inputs.length - 1);
    draft.setChildren(
      owner,
      inserted(
        siblings.filter((child) => !ids.includes(child)),
        top,
        [id],
      ),
    );
    return success(finish(draft), draft, [id]);
  };
  // As `groupNodes` does: every check runs with a placeholder ID first, so a failed command
  // draws no ID.
  let placeholder = PENDING_ID;
  for (
    let n = 1;
    document.pages.some((page) => page.id === placeholder) ||
    Object.hasOwn(document.nodes, placeholder);
    n += 1
  ) {
    placeholder = `${PENDING_ID}-${n}`;
  }
  const trial = build(placeholder);
  if (!trial.ok) return trial;
  const id = freshId(document, context.ids);
  if (id === null) return fail('editor.duplicate-id');
  return build(id);
}
