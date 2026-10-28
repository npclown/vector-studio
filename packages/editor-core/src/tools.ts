import { normalizeRotation, type DocumentV2, type Frame } from '@vector-studio/model';
import type { Tool, ToolContext } from './editor.js';
import { deepFreeze } from './freeze.js';
import { apply, invertRigid, localTransform, multiply, rotate, type Matrix } from './geometry.js';
import {
  boundsOf,
  deepestHit,
  marqueeHits,
  selectionTarget,
  targetChain,
  type CustomGeometry,
} from './hit-test.js';
import { resizeInOwnAxes, scaleAbout } from './resize.js';
import { documentTree, spaceOf } from './tree.js';
import type { InputEvent, PagePoint, PathAnchor, SelectionHandles, ToolOverlay } from './types.js';

// P5 tools (plan section 4.4) and the M1 tools (M1 contract, section 7). Tools act only through
// commands and the gesture API. They work on the active page; drawing tools create at its root,
// also over a top-level frame. Move drags convert the page delta into each node's parent space;
// resize follows section 4.4: the P5 box resize for page-root selections with rotation 0, the
// node's own axes for any other single node, and the page-space box mapped node by node (as a
// group resize, from the pre-gesture state) for any other multi-selection.

type Pointer = Extract<InputEvent, { kind: 'pointerdown' | 'pointermove' | 'pointerup' }>;

function isMoveOrUp(
  event: InputEvent,
): event is Extract<Pointer, { kind: 'pointermove' | 'pointerup' }> {
  return event.kind === 'pointermove' || event.kind === 'pointerup';
}

/** Pick radius for resize handles and the path tool's first anchor, in screen pixels. */
const HANDLE_RADIUS = 6;
/** Reach of the rotate zone around each handle-box corner, in screen pixels (M2 section 4.1). */
const ROTATE_RADIUS = 18;
/** The Shift step of the rotate gesture: 15° (M2 contract, section 4.1). */
const ROTATE_STEP = Math.PI / 12;
const CLOSE_RADIUS = 4;

function distance(a: PagePoint, b: PagePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function zoomOf(context: ToolContext): number {
  return context.query({ type: 'viewport' }).zoom;
}

function boxOf(a: PagePoint, b: PagePoint): Frame {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** The rectangle, ellipse and frame tools: a drag from a to b creates the box between them. */
export function createBoxTool(
  type: 'createRectangle' | 'createEllipse' | 'createFrame' = 'createRectangle',
): Tool {
  let drag: { start: PagePoint; id: string | null } | null = null;
  return {
    input(event, context) {
      if (event.kind === 'keydown') {
        if (event.key === 'Escape' && drag !== null) {
          context.gesture.cancel();
          drag = null;
          return true;
        }
        return false;
      }
      if (event.kind === 'pointerdown') {
        if (drag !== null || !context.gesture.begin()) return false;
        drag = { start: event.point, id: null };
        return true;
      }
      if (!isMoveOrUp(event) || drag === null) return false;
      // The up point is the drag's end point b, so it updates like a move first.
      if (drag.id !== null || distance(event.point, drag.start) > 0) {
        const frame = boxOf(drag.start, event.point);
        if (drag.id === null) {
          const result = context.gesture.update({ type, frame });
          if (result.ok) drag.id = result.ids[0] ?? null;
        } else {
          context.gesture.update({ type: 'setFrames', frames: [{ id: drag.id, frame }] });
        }
      }
      if (event.kind === 'pointerup') {
        // A click without movement made no update, so the commit creates nothing.
        const id = drag.id;
        drag = null;
        context.gesture.commit();
        if (id !== null) context.execute({ type: 'setSelection', ids: [id] });
      }
      return true;
    },
    reset() {
      drag = null;
    },
    overlay: () => null,
  };
}

/** The eight 45° directions, exact on the axes. */
const STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [Math.SQRT1_2, Math.SQRT1_2],
  [0, 1],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0],
  [-Math.SQRT1_2, -Math.SQRT1_2],
  [0, -1],
  [Math.SQRT1_2, -Math.SQRT1_2],
];

/** The drag end, constrained to the nearest 45° step from the start with Shift (same length). */
function lineEnd(start: PagePoint, point: PagePoint, shift: boolean): PagePoint {
  if (!shift) return point;
  const dx = point.x - start.x;
  const dy = point.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return point;
  const step = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
  const [ux, uy] = STEPS[step]!;
  return { x: start.x + length * ux, y: start.y + length * uy };
}

/** The line tool: a drag from start to end creates the line; Shift constrains it to 45° steps. */
export function createLineTool(): Tool {
  let drag: { start: PagePoint; id: string | null } | null = null;
  return {
    input(event, context) {
      if (event.kind === 'keydown') {
        if (event.key === 'Escape' && drag !== null) {
          context.gesture.cancel();
          drag = null;
          return true;
        }
        return false;
      }
      if (event.kind === 'pointerdown') {
        if (drag !== null || !context.gesture.begin()) return false;
        drag = { start: event.point, id: null };
        return true;
      }
      if (!isMoveOrUp(event) || drag === null) return false;
      // The up point is the drag's end, so it updates like a move first.
      const end = lineEnd(drag.start, event.point, event.modifiers.shift);
      if (drag.id !== null || distance(end, drag.start) > 0) {
        if (drag.id === null) {
          const result = context.gesture.update({ type: 'createLine', start: drag.start, end });
          if (result.ok) drag.id = result.ids[0] ?? null;
        } else {
          context.gesture.edit({ kind: 'line', id: drag.id, start: drag.start, end });
        }
      }
      if (event.kind === 'pointerup') {
        // A click without movement made no update, so the commit creates nothing.
        const id = drag.id;
        drag = null;
        context.gesture.commit();
        if (id !== null) context.execute({ type: 'setSelection', ids: [id] });
      }
      return true;
    },
    reset() {
      drag = null;
    },
    overlay: () => null,
  };
}

type Anchor = { point: PagePoint; in: PagePoint | null; out: PagePoint | null };

export function createPathTool(): Tool {
  let anchors: Anchor[] = [];
  let pressed: Anchor | null = null;

  function finish(context: ToolContext, closed: boolean): void {
    const verbs: ('move' | 'line' | 'cubic' | 'close')[] = ['move'];
    const points = [anchors[0]!.point.x, anchors[0]!.point.y];
    const segment = (from: Anchor, to: Anchor) => {
      if (from.out === null && to.in === null) {
        verbs.push('line');
        points.push(to.point.x, to.point.y);
      } else {
        const c1 = from.out ?? from.point;
        const c2 = to.in ?? to.point;
        verbs.push('cubic');
        points.push(c1.x, c1.y, c2.x, c2.y, to.point.x, to.point.y);
      }
    };
    for (let i = 1; i < anchors.length; i += 1) segment(anchors[i - 1]!, anchors[i]!);
    if (closed) {
      segment(anchors[anchors.length - 1]!, anchors[0]!);
      verbs.push('close');
    }
    // The whole creation is one transaction, sent only now (plan section 4.4); a failed create
    // keeps the anchors.
    const result = context.execute({ type: 'createPath', verbs, points });
    if (!result.ok) return;
    anchors = [];
    pressed = null;
    context.execute({ type: 'setSelection', ids: result.ids });
  }

  return {
    input(event, context) {
      if (event.kind === 'keydown') {
        // Escape and Enter act on pending anchors only, so they are consumed only then (M2-I2).
        if (anchors.length === 0) return false;
        if (event.key === 'Escape') {
          anchors = [];
          pressed = null;
          return true;
        }
        if (event.key === 'Enter') {
          if (anchors.length >= 2) finish(context, false);
          return true;
        }
        return false;
      }
      if (event.kind === 'pointerdown') {
        if (pressed !== null) return false;
        const radius = CLOSE_RADIUS / zoomOf(context);
        if (anchors.length >= 2 && distance(event.point, anchors[0]!.point) <= radius) {
          finish(context, true);
          return true;
        }
        // A second press on the last anchor (a double click) adds no anchor.
        const last = anchors[anchors.length - 1];
        if (last !== undefined && distance(event.point, last.point) === 0) return false;
        pressed = { point: event.point, in: null, out: null };
        anchors.push(pressed);
        return true;
      }
      if (event.kind === 'pointermove' && pressed !== null) {
        // Press-and-drag makes a cubic anchor with symmetric handles.
        const { point } = pressed;
        const moved = distance(event.point, point) > 0;
        pressed.out = moved ? event.point : null;
        pressed.in = moved
          ? { x: 2 * point.x - event.point.x, y: 2 * point.y - event.point.y }
          : null;
        return true;
      }
      if (event.kind === 'pointerup' && pressed !== null) {
        pressed = null;
        return true;
      }
      return false;
    },
    reset() {
      anchors = [];
      pressed = null;
    },
    overlay(): ToolOverlay | null {
      if (anchors.length === 0) return null;
      const copy = (anchor: Anchor): PathAnchor => ({ ...anchor });
      return deepFreeze({ kind: 'path', anchors: anchors.map(copy) });
    },
  };
}

/** Handle positions on the box, as fractions of its width and height. */
export const HANDLES = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [0, 0.5],
] as const;

export type Handle = (typeof HANDLES)[number];

/** The four corners of the handle box: top-left, top-right, bottom-right, bottom-left. */
const CORNERS: readonly Handle[] = [HANDLES[0], HANDLES[2], HANDLES[4], HANDLES[6]];

/** The handles that can scale at least one axis of `box`, in `HANDLES` order. */
export function activeHandles(box: Frame): Handle[] {
  return HANDLES.filter(
    (handle) => (handle[0] !== 0.5 && box.width > 0) || (handle[1] !== 0.5 && box.height > 0),
  );
}

/**
 * The box the handles sit on. `p5`: the page-aligned bounds of a page-root selection with
 * rotation 0, resized as in P5. `single`: one other node, its own rotated box (`matrix` maps
 * its local space to the page). `map`: the page-aligned bounds of any other multi-selection.
 */
export type HandleBox =
  | { mode: 'p5' | 'map'; box: Frame }
  | { mode: 'single'; box: Frame; id: string; matrix: Matrix; turn: number };

/** The handle box of `selection` on `page` (section 4.4), or null for an empty selection. */
export function handleBoxOf(
  document: DocumentV2,
  page: string,
  selection: readonly string[],
): HandleBox | null {
  const box = boundsOf(document, selection);
  if (box === null) return null;
  const p5 = selection.every((id) => {
    const node = document.nodes[id];
    return node !== undefined && node.parent === page && node.rotation === 0;
  });
  if (p5) return { mode: 'p5', box };
  if (selection.length > 1) return { mode: 'map', box };
  // A single node: the handles follow its rotation (section 4.4).
  const id = selection[0]!;
  const node = document.nodes[id]!;
  const space = spaceOf(documentTree(document), node.parent);
  return {
    mode: 'single',
    box: { x: 0, y: 0, width: node.frame.width, height: node.frame.height },
    id,
    matrix: multiply(space.matrix, localTransform(node.frame, node.rotation)),
    turn: space.rotation + node.rotation,
  };
}

/** A handle's page-space point on the handle box. */
export function handlePoint(handles: HandleBox, handle: Handle): PagePoint {
  const { box } = handles;
  if (handles.mode !== 'single') {
    return { x: box.x + handle[0] * box.width, y: box.y + handle[1] * box.height };
  }
  return apply(handles.matrix, handle[0] * box.width, handle[1] * box.height);
}

/** The page-space centre of the handle box: the rotate gesture's pivot (M2 section 4.1). */
export function handleCentre(handles: HandleBox): PagePoint {
  const { box } = handles;
  if (handles.mode !== 'single') return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return apply(handles.matrix, box.width / 2, box.height / 2);
}

/** The page rotation of a node: its parent chain's rotation plus its own, not normalized. */
export function pageRotation(document: DocumentV2, id: string): number {
  const node = document.nodes[id]!;
  return spaceOf(documentTree(document), node.parent).rotation + node.rotation;
}

/**
 * The `handles` query (M1-U5): the select tool's handle box in page space, so a host draws the
 * handles where the tool picks them, also for nested and rotated nodes.
 */
export function selectionHandles(
  document: DocumentV2,
  page: string,
  selection: readonly string[],
): SelectionHandles | null {
  const box = handleBoxOf(document, page, selection);
  if (box === null) return null;
  // The corner handles: top-left, top-right, bottom-right and bottom-left.
  const [tl, , tr, , br, , bl] = HANDLES;
  return deepFreeze({
    corners: [
      handlePoint(box, tl),
      handlePoint(box, tr),
      handlePoint(box, br),
      handlePoint(box, bl),
    ],
    rotation: box.mode === 'single' ? normalizeRotation(box.turn) : 0,
    handles: activeHandles(box.box).map((handle) => handlePoint(box, handle)),
  });
}

type SelectState =
  | { kind: 'idle' }
  | {
      kind: 'move';
      start: PagePoint;
      frames: Map<string, Frame>;
      /** Each node's parent-chain rotation, to turn the page delta into its parent space. */
      turns: Map<string, number>;
      moved: boolean;
      hit: string;
    }
  | {
      kind: 'resize';
      start: PagePoint;
      frames: Map<string, Frame>;
      handles: HandleBox;
      handle: Handle;
      moved: boolean;
    }
  | {
      kind: 'rotate';
      start: PagePoint;
      ids: readonly string[];
      /** The handle-box centre at press. */
      pivot: PagePoint;
      /** For one node, its page rotation at press (the Shift step's base); else null. */
      turn: number | null;
      moved: boolean;
    }
  | { kind: 'marquee'; start: PagePoint; current: PagePoint; additive: boolean };

/** Scales `value` about `origin` by `scale` along one axis. */
function scaled(origin: number, value: number, scale: number): number {
  return origin + (value - origin) * scale;
}

/**
 * One axis of a box resize: the box scales about the opposite handle; an axis of size 0 or an
 * edge handle's other axis is not scaled, and the scale clamps at 0, so sizes do too.
 */
function axis(fraction: number, origin: number, size: number, delta: number) {
  if (fraction === 0.5 || size === 0) return { origin, scale: 1 };
  const anchor = origin + (1 - fraction) * size;
  const from = origin + fraction * size;
  return { origin: anchor, scale: Math.max(0, (from + delta - anchor) / (from - anchor)) };
}

export function createSelectTool(custom: CustomGeometry): Tool {
  let state: SelectState = { kind: 'idle' };

  function framesOf(context: ToolContext, ids: readonly string[]): Map<string, Frame> {
    const document = context.query({ type: 'document' });
    return new Map(ids.map((id) => [id, document.nodes[id]!.frame]));
  }

  function handlesOf(context: ToolContext, selection: readonly string[]): HandleBox | null {
    return handleBoxOf(
      context.query({ type: 'document' }),
      context.query({ type: 'activePage' }),
      selection,
    );
  }

  /** Whether `point` is strictly inside the handle box. */
  function insideHandles(handles: HandleBox, point: PagePoint): boolean {
    const local =
      handles.mode === 'single' ? apply(invertRigid(handles.matrix), point.x, point.y) : point;
    const { box } = handles;
    return (
      local.x > box.x &&
      local.x < box.x + box.width &&
      local.y > box.y &&
      local.y < box.y + box.height
    );
  }

  /**
   * Whether `point` is in a rotate zone (M2 contract, section 4.1): strictly outside the handle
   * box in the box's own axes, and within `18 / zoom` page units of one of its four corners.
   */
  function inRotateZone(handles: HandleBox, point: PagePoint, zoom: number): boolean {
    const local =
      handles.mode === 'single' ? apply(invertRigid(handles.matrix), point.x, point.y) : point;
    const { box } = handles;
    const outside =
      local.x < box.x ||
      local.x > box.x + box.width ||
      local.y < box.y ||
      local.y > box.y + box.height;
    if (!outside) return false;
    const reach = ROTATE_RADIUS / zoom;
    return CORNERS.some((corner) => distance(point, handlePoint(handles, corner)) <= reach);
  }

  /** The nearest handle within reach that can scale at least one axis of the box. */
  function handleAt(handles: HandleBox, point: PagePoint, zoom: number): Handle | null {
    const { box } = handles;
    let best: Handle | null = null;
    let bestDistance = HANDLE_RADIUS / zoom;
    for (const handle of activeHandles(box)) {
      const d = distance(point, handlePoint(handles, handle));
      if (d <= bestDistance) {
        best = handle;
        bestDistance = d;
      }
    }
    return best;
  }

  function pointerDown(event: Pointer, context: ToolContext): void {
    if (state.kind !== 'idle') return;
    const document = context.query({ type: 'document' });
    const selection = context.query({ type: 'selection' });
    const zoom = zoomOf(context);
    const page = context.query({ type: 'activePage' });
    const handles = handlesOf(context, selection);
    // The node hit and its selection target (section 6). A press on an already selected node
    // between them (one selected below the target, for example from a layers panel) keeps the
    // selection and acts on that node.
    const deepest = deepestHit(document, page, event.point, zoom, custom);
    const target = deepest === null ? null : selectionTarget(document, deepest);
    const hit =
      deepest === null
        ? null
        : (targetChain(document, deepest).find((id) => selection.includes(id)) ?? target);
    // On a box too small for its handles to stay apart, a press on a selected node inside it
    // moves; otherwise a handle wins over the node under it.
    const reach = (4 * HANDLE_RADIUS) / zoom;
    const small = handles !== null && (handles.box.width < reach || handles.box.height < reach);
    const movesSmall =
      small && hit !== null && selection.includes(hit) && insideHandles(handles, event.point);
    const handle = handles === null || movesSmall ? null : handleAt(handles, event.point, zoom);
    if (handles !== null && handle !== null) {
      if (context.gesture.begin()) {
        state = {
          kind: 'resize',
          start: event.point,
          frames: framesOf(context, selection),
          handles,
          handle,
          moved: false,
        };
      }
      return;
    }
    // Then the rotate zone, outside the box near a corner, over any node under it.
    if (handles !== null && inRotateZone(handles, event.point, zoom)) {
      if (context.gesture.begin()) {
        state = {
          kind: 'rotate',
          start: event.point,
          ids: selection,
          pivot: handleCentre(handles),
          turn: selection.length === 1 ? pageRotation(document, selection[0]!) : null,
          moved: false,
        };
      }
      return;
    }
    if (hit === null || target === null) {
      state = {
        kind: 'marquee',
        start: event.point,
        current: event.point,
        additive: event.modifiers.shift,
      };
      return;
    }
    if (event.modifiers.shift) {
      const ids = selection.includes(hit)
        ? selection.filter((id) => id !== hit)
        : [...selection, hit];
      context.execute({ type: 'setSelection', ids });
      return;
    }
    if (!selection.includes(hit)) context.execute({ type: 'setSelection', ids: [hit] });
    if (context.gesture.begin()) {
      const ids = context.query({ type: 'selection' });
      const tree = documentTree(context.query({ type: 'document' }));
      state = {
        kind: 'move',
        start: event.point,
        frames: framesOf(context, ids),
        turns: new Map(ids.map((id) => [id, spaceOf(tree, tree.node(id)!.parent).rotation])),
        moved: false,
        hit: target,
      };
    }
  }

  function resize(
    current: Extract<SelectState, { kind: 'resize' }>,
    dx: number,
    dy: number,
    context: ToolContext,
  ): void {
    const { handles, handle } = current;
    const { box } = handles;
    if (handles.mode === 'single') {
      // In the node's own axes about the opposite handle (section 4.4, rotated node).
      const delta = rotate(-handles.turn, dx, dy);
      const sx = axis(handle[0], 0, box.width, delta.x).scale;
      const sy = axis(handle[1], 0, box.height, delta.y).scale;
      const node = context.query({ type: 'node', id: handles.id })!;
      const frame = resizeInOwnAxes(
        current.frames.get(handles.id)!,
        node.rotation,
        1 - handle[0],
        1 - handle[1],
        sx,
        sy,
      );
      context.gesture.update({ type: 'setFrames', frames: [{ id: handles.id, frame }] });
      return;
    }
    const x = axis(handle[0], box.x, box.width, dx);
    const y = axis(handle[1], box.y, box.height, dy);
    if (handles.mode === 'map') {
      // Several nodes: each maps by the box scale as in a group resize (section 4.4).
      const map = scaleAbout(x.scale, y.scale, { x: x.origin, y: y.origin });
      context.gesture.edit({ kind: 'map', ids: [...current.frames.keys()], map });
      return;
    }
    const frames = [...current.frames].map(([id, frame]) => ({
      id,
      frame: {
        x: scaled(x.origin, frame.x, x.scale),
        y: scaled(y.origin, frame.y, y.scale),
        width: frame.width * x.scale,
        height: frame.height * y.scale,
      },
    }));
    context.gesture.update({ type: 'setFrames', frames });
  }

  /**
   * One rotate-gesture update (M2 contract, section 4.1): the angle swept about the pivot from
   * the press to `event.point`, wrapped into (−π, π]; with Shift, one node's resulting page
   * rotation, or the angle itself for several nodes, steps to a multiple of 15°. Each update
   * replaces the last, so a drag never compounds.
   */
  function rotateTo(
    current: Extract<SelectState, { kind: 'rotate' }>,
    event: Pointer,
    context: ToolContext,
  ): void {
    const { pivot, start, turn } = current;
    const q = event.point;
    let angle = normalizeRotation(
      Math.atan2(q.y - pivot.y, q.x - pivot.x) - Math.atan2(start.y - pivot.y, start.x - pivot.x),
    );
    if (event.modifiers.shift) {
      if (turn === null) angle = normalizeRotation(Math.round(angle / ROTATE_STEP) * ROTATE_STEP);
      else {
        const result = normalizeRotation(turn + angle);
        // The adjustment to the stepped rotation; `normalize(turn + angle)` reaches it up to
        // binary64 rounding (exactly for 0 on a page-root node).
        const target = normalizeRotation(Math.round(result / ROTATE_STEP) * ROTATE_STEP);
        angle = normalizeRotation(target - turn);
      }
    }
    context.gesture.replace([{ type: 'rotateNodes', ids: current.ids, angle, pivot }]);
  }

  function pointerMove(event: Pointer, context: ToolContext): void {
    if (state.kind === 'marquee') {
      state.current = event.point;
      return;
    }
    if (state.kind === 'idle') return;
    const dx = event.point.x - state.start.x;
    const dy = event.point.y - state.start.y;
    if (!state.moved && dx === 0 && dy === 0) return;
    state.moved = true;
    if (state.kind === 'resize') {
      resize(state, dx, dy, context);
      return;
    }
    if (state.kind === 'rotate') {
      rotateTo(state, event, context);
      return;
    }
    const { turns } = state;
    const frames = [...state.frames].map(([id, frame]) => {
      const delta = rotate(-turns.get(id)!, dx, dy);
      return { id, frame: { ...frame, x: frame.x + delta.x, y: frame.y + delta.y } };
    });
    context.gesture.update({ type: 'setFrames', frames });
  }

  function pointerUp(event: Pointer, context: ToolContext): void {
    // The up point ends the drag, so it updates like a move first.
    if (state.kind === 'move' || state.kind === 'resize' || state.kind === 'rotate') {
      pointerMove(event, context);
    }
    const current = state;
    state = { kind: 'idle' };
    if (current.kind === 'move' || current.kind === 'resize' || current.kind === 'rotate') {
      context.gesture.commit();
      // A click without movement selects the target hit, even inside a larger selection.
      if (current.kind === 'move' && !current.moved) {
        context.execute({ type: 'setSelection', ids: [current.hit] });
      }
    } else if (current.kind === 'marquee') {
      current.current = event.point;
      if (distance(current.start, current.current) === 0) {
        // A click on empty canvas clears the selection; shift keeps it.
        if (!current.additive) context.execute({ type: 'setSelection', ids: [] });
        return;
      }
      const hits = marqueeHits(
        context.query({ type: 'document' }),
        context.query({ type: 'activePage' }),
        boxOf(current.start, current.current),
      );
      const ids = current.additive
        ? [...new Set([...context.query({ type: 'selection' }), ...hits])]
        : hits;
      context.execute({ type: 'setSelection', ids });
    }
  }

  return {
    input(event, context) {
      if (event.kind === 'keydown') {
        if (event.key === 'Escape' && state.kind !== 'idle') {
          if (state.kind !== 'marquee') context.gesture.cancel();
          state = { kind: 'idle' };
          return true;
        }
        return false;
      }
      if (event.kind === 'pointerdown') {
        if (state.kind !== 'idle') return false;
        pointerDown(event, context);
        return true;
      }
      if (!isMoveOrUp(event) || state.kind === 'idle') return false;
      if (event.kind === 'pointermove') pointerMove(event, context);
      else pointerUp(event, context);
      return true;
    },
    reset() {
      state = { kind: 'idle' };
    },
    overlay(): ToolOverlay | null {
      return state.kind === 'marquee'
        ? deepFreeze({ kind: 'marquee', frame: boxOf(state.start, state.current) })
        : null;
    },
  };
}
