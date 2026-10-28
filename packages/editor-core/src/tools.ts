import type { Frame } from '@vector-studio/model';
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
import type { InputEvent, PagePoint, PathAnchor, ToolOverlay } from './types.js';

// P5 tools (plan section 4.4) and the M1 tools (M1 contract, section 7). Tools act only through
// commands and the gesture API. They work on the active page; drawing tools create at its root,
// also over a top-level frame. Move drags convert the page delta into each node's parent space;
// resize follows section 4.4: the P5 box resize for page-root selections with rotation 0, the
// node's own axes for any other single node, and the page-space box mapped node by node (as a
// group resize, from the pre-gesture state) for any other multi-selection.

type Pointer = Extract<InputEvent, { point: PagePoint }>;

/** Pick radius for resize handles and the path tool's first anchor, in screen pixels. */
const HANDLE_RADIUS = 6;
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
        }
        return;
      }
      if (event.kind === 'pointerdown') {
        if (drag === null && context.gesture.begin()) drag = { start: event.point, id: null };
        return;
      }
      if (drag === null) return;
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
        }
        return;
      }
      if (event.kind === 'pointerdown') {
        if (drag === null && context.gesture.begin()) drag = { start: event.point, id: null };
        return;
      }
      if (drag === null) return;
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
        if (event.key === 'Escape') {
          anchors = [];
          pressed = null;
        } else if (event.key === 'Enter' && anchors.length >= 2) {
          finish(context, false);
        }
        return;
      }
      if (event.kind === 'pointerdown') {
        if (pressed !== null) return;
        const radius = CLOSE_RADIUS / zoomOf(context);
        if (anchors.length >= 2 && distance(event.point, anchors[0]!.point) <= radius) {
          finish(context, true);
          return;
        }
        // A second press on the last anchor (a double click) adds no anchor.
        const last = anchors[anchors.length - 1];
        if (last !== undefined && distance(event.point, last.point) === 0) return;
        pressed = { point: event.point, in: null, out: null };
        anchors.push(pressed);
      } else if (event.kind === 'pointermove' && pressed !== null) {
        // Press-and-drag makes a cubic anchor with symmetric handles.
        const { point } = pressed;
        const moved = distance(event.point, point) > 0;
        pressed.out = moved ? event.point : null;
        pressed.in = moved
          ? { x: 2 * point.x - event.point.x, y: 2 * point.y - event.point.y }
          : null;
      } else if (event.kind === 'pointerup') {
        pressed = null;
      }
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
const HANDLES = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [0, 0.5],
] as const;

type Handle = (typeof HANDLES)[number];

/**
 * The box the handles sit on. `p5`: the page-aligned bounds of a page-root selection with
 * rotation 0, resized as in P5. `single`: one other node, its own rotated box (`matrix` maps
 * its local space to the page). `map`: the page-aligned bounds of any other multi-selection.
 */
type HandleBox =
  | { mode: 'p5' | 'map'; box: Frame }
  | { mode: 'single'; box: Frame; id: string; matrix: Matrix; turn: number };

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
    const document = context.query({ type: 'document' });
    const page = context.query({ type: 'activePage' });
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

  function handlePoint(handles: HandleBox, handle: Handle): PagePoint {
    const { box } = handles;
    if (handles.mode !== 'single') {
      return { x: box.x + handle[0] * box.width, y: box.y + handle[1] * box.height };
    }
    return apply(handles.matrix, handle[0] * box.width, handle[1] * box.height);
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

  /** The nearest handle within reach that can scale at least one axis of the box. */
  function handleAt(handles: HandleBox, point: PagePoint, zoom: number): Handle | null {
    const { box } = handles;
    let best: Handle | null = null;
    let bestDistance = HANDLE_RADIUS / zoom;
    for (const handle of HANDLES) {
      const scalesX = handle[0] !== 0.5 && box.width > 0;
      const scalesY = handle[1] !== 0.5 && box.height > 0;
      if (!scalesX && !scalesY) continue;
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
    const { turns } = state;
    const frames = [...state.frames].map(([id, frame]) => {
      const delta = rotate(-turns.get(id)!, dx, dy);
      return { id, frame: { ...frame, x: frame.x + delta.x, y: frame.y + delta.y } };
    });
    context.gesture.update({ type: 'setFrames', frames });
  }

  function pointerUp(event: Pointer, context: ToolContext): void {
    // The up point ends the drag, so it updates like a move first.
    if (state.kind === 'move' || state.kind === 'resize') pointerMove(event, context);
    const current = state;
    state = { kind: 'idle' };
    if (current.kind === 'move' || current.kind === 'resize') {
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
        }
        return;
      }
      if (event.kind === 'pointerdown') pointerDown(event, context);
      else if (event.kind === 'pointermove') pointerMove(event, context);
      else pointerUp(event, context);
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
