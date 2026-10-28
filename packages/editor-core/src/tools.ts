import {
  normalizeRotation,
  type DocumentV2,
  type Frame,
  type PathNodeV2,
} from '@vector-studio/model';
import type { Tool, ToolContext } from './editor.js';
import { deepFreeze } from './freeze.js';
import { apply, invertRigid, rotate } from './geometry.js';
import {
  HANDLES,
  activeHandles,
  handleBoxOf,
  handleCentre,
  handlePoint,
  type Handle,
  type HandleBox,
} from './handles.js';
import {
  boundsOf,
  deepestHit,
  hitsAt,
  marqueeHits,
  selectionTarget,
  targetChain,
  type CustomGeometry,
} from './hit-test.js';
import { canonicalRefs, hasRef, pathTargetAt } from './path-edit.js';
import { inSegment, outSegment, readAnchorModel } from './paths.js';
import { resizeInOwnAxes, scaleAbout } from './resize.js';
import {
  SNAP_PX,
  boxOfFrame,
  snapAngle,
  snapBox,
  snapPoint,
  snapSet,
  translateBox,
  type Box,
  type SnapSet,
  type ValueIndex,
} from './snap.js';
import { documentTree, isAncestor, isContainer, spaceOf } from './tree.js';
import type {
  InputEvent,
  Modifiers,
  PagePoint,
  PathAnchor,
  PathAnchorRef,
  PathEditState,
  SelectionHandles,
  SnapOverlay,
  ToolOverlay,
} from './types.js';

export {
  HANDLES,
  activeHandles,
  handleBoxOf,
  handleCentre,
  handlePoint,
  type Handle,
  type HandleBox,
} from './handles.js';

// P5 tools (plan section 4.4) and the M1 tools (M1 contract, section 7). Tools act only through
// commands and the gesture API. They work on the active page; drawing tools create at its root,
// also over a top-level frame. Move drags convert the page delta into each node's parent space;
// resize follows section 4.4: the P5 box resize for page-root selections with rotation 0, the
// node's own axes for any other single node, and the page-space box mapped node by node (as a
// group resize, from the pre-gesture state) for any other multi-selection. In path edit mode
// (MVP M3 contract, section 5) the select tool picks anchors, handles, segments and the fill of
// the edited path instead, and drags them through the path commands in `replace`.

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

/** Whether snapping applies to an event (M2 contract, section 4.2): on, without Ctrl or Meta. */
function snapsOn(context: ToolContext, modifiers: Modifiers): boolean {
  return context.query({ type: 'snapping' }) && !modifiers.ctrl && !modifiers.meta;
}

/** The snap threshold `SNAP_PX / zoom` in page units, at the current zoom. */
function thresholdOf(context: ToolContext): number {
  return SNAP_PX / zoomOf(context);
}

/**
 * A gesture's candidate set (section 4.2) over the document current at the call, which is the
 * pre-gesture document when called at press; computed on first use, so a click costs nothing.
 * The scope owner is `scope`, by default the session scope at the call (section 5), else the
 * active page.
 */
function lazySnapSet(
  context: ToolContext,
  moving: readonly string[],
  scope: string | null = context.query({ type: 'scope' }),
): () => SnapSet {
  const document = context.query({ type: 'document' });
  const page = context.query({ type: 'activePage' });
  let set: SnapSet | null = null;
  return () => (set ??= snapSet(document, page, scope, moving));
}

/** A dragged point (box corner, line end) after snapping, and the overlay to show. */
function snappedPoint(
  context: ToolContext,
  point: PagePoint,
  modifiers: Modifiers,
  candidates: () => SnapSet,
): { point: PagePoint; overlay: SnapOverlay | null } {
  if (!snapsOn(context, modifiers)) return { point, overlay: null };
  const result = snapPoint(candidates(), point, thresholdOf(context));
  if (result.overlay === null) return { point, overlay: null };
  return { point: { x: point.x + result.ox, y: point.y + result.oy }, overlay: result.overlay };
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
  let drag: { start: PagePoint; id: string | null; candidates: () => SnapSet } | null = null;
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
        drag = { start: event.point, id: null, candidates: lazySnapSet(context, []) };
        return true;
      }
      if (!isMoveOrUp(event) || drag === null) return false;
      // The up point is the drag's end point b, so it updates like a move first. The dragged
      // corner snaps (section 4.2).
      const end = snappedPoint(context, event.point, event.modifiers, drag.candidates);
      if (drag.id !== null || distance(end.point, drag.start) > 0) {
        const frame = boxOf(drag.start, end.point);
        if (drag.id === null) {
          const result = context.gesture.update({ type, frame });
          if (result.ok) drag.id = result.ids[0] ?? null;
        } else {
          context.gesture.update({ type: 'setFrames', frames: [{ id: drag.id, frame }] });
        }
        context.snap(end.overlay);
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
  let drag: { start: PagePoint; id: string | null; candidates: () => SnapSet } | null = null;
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
        drag = { start: event.point, id: null, candidates: lazySnapSet(context, []) };
        return true;
      }
      if (!isMoveOrUp(event) || drag === null) return false;
      // The up point is the drag's end, so it updates like a move first. Without Shift the end
      // snaps (section 4.2); the Shift constraint keeps the 45° step instead.
      const snapped = event.modifiers.shift
        ? { point: lineEnd(drag.start, event.point, true), overlay: null }
        : snappedPoint(context, event.point, event.modifiers, drag.candidates);
      const end = snapped.point;
      if (drag.id !== null || distance(end, drag.start) > 0) {
        if (drag.id === null) {
          const result = context.gesture.update({ type: 'createLine', start: drag.start, end });
          if (result.ok) drag.id = result.ids[0] ?? null;
        } else {
          context.gesture.edit({ kind: 'line', id: drag.id, start: drag.start, end });
        }
        context.snap(snapped.overlay);
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

/** The four corners of the handle box: top-left, top-right, bottom-right, bottom-left. */
const CORNERS: readonly Handle[] = [HANDLES[0], HANDLES[2], HANDLES[4], HANDLES[6]];

/**
 * A node's page rotation `turn` (its parent chain's rotation `chain` plus its own, not
 * normalized), its stored frame and rotation, as the rotate gesture records them at press.
 */
function singleOf(document: DocumentV2, id: string) {
  const node = document.nodes[id]!;
  const chain = spaceOf(documentTree(document), node.parent).rotation;
  return { turn: chain + node.rotation, chain, frame: node.frame, rotation: node.rotation };
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
      /** The moving nodes' page-aligned bounds before the gesture, and the snap candidates. */
      bounds: Box | null;
      candidates: () => SnapSet;
    }
  | {
      kind: 'resize';
      start: PagePoint;
      frames: Map<string, Frame>;
      handles: HandleBox;
      handle: Handle;
      moved: boolean;
      /** The pre-gesture page-aligned bounds when the handle box is page-aligned, else null. */
      bounds: Box | null;
      candidates: () => SnapSet;
    }
  | {
      kind: 'rotate';
      start: PagePoint;
      ids: readonly string[];
      /** The handle-box centre at press. */
      pivot: PagePoint;
      /**
       * For one node: its page rotation at press (the Shift step's base), its parent chain's
       * rotation and its frame; else null.
       */
      single: { turn: number; chain: number; frame: Frame; rotation: number } | null;
      moved: boolean;
      candidates: () => SnapSet;
    }
  | {
      /**
       * An Alt-drag (M2 contract, section 4.3): the press changed nothing; the first movement
       * duplicates `moveSet` and moves the copies, which become the selection.
       */
      kind: 'duplicate';
      start: PagePoint;
      moveSet: readonly string[];
      moved: boolean;
      bounds: Box | null;
      /**
       * The scope the press resolved to (section 5): the session scope when the hit is inside
       * it, else null; `leaves` when the press left the session scope, applied at release, since
       * an Alt press changes nothing.
       */
      scope: string | null;
      leaves: boolean;
      /** The selection before the press, where overlap cycling starts. */
      selection: readonly string[];
      /**
       * The copies' duplicated frames, parent-chain rotations and snap candidates; null before
       * the first movement.
       */
      copies: {
        frames: Map<string, Frame>;
        turns: Map<string, number>;
        candidates: () => SnapSet;
      } | null;
    }
  | { kind: 'marquee'; start: PagePoint; current: PagePoint; additive: boolean }
  // Path edit mode (M3 contract, section 5).
  | {
      /** An anchor or segment drag: `movePathAnchors` on `anchors`, the anchor selection. */
      kind: 'anchors';
      start: PagePoint;
      moved: boolean;
      id: string;
      anchors: readonly PathAnchorRef[];
      /** The pressed anchor's page point, which snaps; null for a segment drag. */
      snapFrom: PagePoint | null;
      /** The anchor selection a click without movement leaves. */
      click: readonly PathAnchorRef[];
      candidates: () => SnapSet;
    }
  | {
      /** A handle drag from the handle's page point `from`; `mirror` as inferred at press. */
      kind: 'handle';
      start: PagePoint;
      moved: boolean;
      id: string;
      ref: PathAnchorRef;
      side: 'in' | 'out';
      from: PagePoint;
      mirror: boolean;
    }
  | {
      /** An Alt-drag on an anchor pulling new mirrored handles; an Alt-click retracts them. */
      kind: 'pull';
      start: PagePoint;
      moved: boolean;
      id: string;
      ref: PathAnchorRef;
      side: 'in' | 'out';
      anchor: PagePoint;
    }
  /** A press that starts no drag (a Shift press on an anchor): later moves are ignored. */
  | { kind: 'held' }
  | {
      /**
       * An anchor marquee from the fill (`canvas` false) or empty canvas; `leaves` when the press
       * was on the page's empty canvas outside the session scope.
       */
      kind: 'anchorMarquee';
      start: PagePoint;
      current: PagePoint;
      additive: boolean;
      canvas: boolean;
      leaves: boolean;
    };

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

  /**
   * The deepest node hit at `point` and the scope a press there resolves to (section 5):
   * `deepest` is null on empty canvas and on the scope node itself (empty canvas inside the
   * scope); `scope` is the session scope when the hit is inside its subtree, else null; `leaves`
   * says the press leaves a session scope (a hit outside it, or the page's empty canvas).
   */
  function resolveHit(
    context: ToolContext,
    point: PagePoint,
  ): { deepest: string | null; scope: string | null; leaves: boolean } {
    const document = context.query({ type: 'document' });
    const session = context.query({ type: 'scope' });
    const deepest = deepestHit(
      document,
      context.query({ type: 'activePage' }),
      point,
      zoomOf(context),
      custom,
    );
    if (session === null) return { deepest, scope: null, leaves: false };
    if (deepest === session) return { deepest: null, scope: session, leaves: false };
    if (deepest !== null && isAncestor(documentTree(document), session, deepest)) {
      return { deepest, scope: session, leaves: false };
    }
    return { deepest, scope: null, leaves: true };
  }

  /**
   * Overlap cycling (section 5): the stack is the selection targets of every node hit at the
   * press point, in reverse paint order without repeats, under the scope the press resolved to
   * (inside a scope only its subtree's nodes, the scope node itself excluded); with the
   * pre-press selection one node at index `i`, the selection becomes item `(i + 1) mod n`,
   * else item 0.
   */
  function cycle(current: Extract<SelectState, { kind: 'duplicate' }>, context: ToolContext): void {
    const document = context.query({ type: 'document' });
    const tree = documentTree(document);
    const { scope } = current;
    const hits = hitsAt(
      document,
      context.query({ type: 'activePage' }),
      current.start,
      zoomOf(context),
      custom,
    ).filter((id) => scope === null || isAncestor(tree, scope, id));
    const stack = [...new Set(hits.map((id) => selectionTarget(document, id, scope)))];
    if (stack.length === 0) return;
    const before = current.selection;
    const index = before.length === 1 ? stack.indexOf(before[0]!) : -1;
    const next = stack[(index + 1) % stack.length]!;
    context.execute({ type: 'setSelection', ids: [next] });
  }

  /**
   * Frame entry (section 5): a double-click enters the hit target when it is a group, mask
   * group or frame; the selection becomes the target's child on the hit chain, or empty for a
   * hit on the frame's own background or border. A leaf target, the scope node itself and
   * empty canvas do nothing.
   */
  function doubleClick(point: PagePoint, context: ToolContext): boolean {
    const { deepest, scope } = resolveHit(context, point);
    if (deepest === null) return false;
    const document = context.query({ type: 'document' });
    const chain = targetChain(document, deepest, scope);
    const target = chain[chain.length - 1]!;
    // A path target enters path edit mode (M3 contract, section 4).
    if (document.nodes[target]?.type === 'path') {
      context.execute({ type: 'enterPathEdit', id: target });
      return true;
    }
    if (!isContainer(document.nodes[target])) return false;
    context.execute({ type: 'setScope', id: target });
    const next = chain.length >= 2 ? [chain[chain.length - 2]!] : [];
    context.execute({ type: 'setSelection', ids: next });
    return true;
  }

  /**
   * A press in path edit mode (M3 contract, section 5): an anchor, a visible handle, a segment
   * or the fill of the edited path; else a press on another node ends edit mode and runs the M2
   * rules, and empty canvas (the scope node's included) starts an anchor marquee.
   */
  function editDown(event: Pointer, context: ToolContext, edit: PathEditState): void {
    const document = context.query({ type: 'document' });
    const zoom = zoomOf(context);
    const { point, modifiers } = event;
    const { id } = edit;
    const target = pathTargetAt(document, edit, point, zoom, HANDLE_RADIUS / zoom);
    const marquee = (canvas: boolean, leaves: boolean) => {
      state = {
        kind: 'anchorMarquee',
        start: point,
        current: point,
        additive: modifiers.shift,
        canvas,
        leaves,
      };
    };
    if (target === null) {
      const { deepest, leaves } = resolveHit(context, point);
      if (deepest !== null && deepest !== id) {
        // Resize, rotate and their handles stay off for this press: it hit the node.
        context.execute({ type: 'exitPathEdit' });
        pointerDown(event, context, true);
        return;
      }
      // The edited path hit only by the M2 rules acts as its fill.
      marquee(deepest === null, deepest === null && leaves);
      return;
    }
    if (target.kind === 'fill') {
      marquee(false, false);
      return;
    }
    const overlay = context.query({ type: 'pathOverlay' })!;
    if (target.kind === 'handle') {
      const { ref, side } = target;
      if (!context.gesture.begin()) return;
      state = {
        kind: 'handle',
        start: point,
        moved: false,
        id,
        ref,
        side,
        from: target.point,
        mirror: overlay.subpaths[ref.subpath]!.anchors[ref.anchor]!.mirrored,
      };
      return;
    }
    // An anchor, or both ends of a segment (one for a one-anchor loop).
    let refs: PathAnchorRef[];
    if (target.kind === 'anchor') {
      refs = [target.ref];
    } else {
      const n = overlay.subpaths[target.subpath]!.anchors.length;
      refs = canonicalRefs([
        { subpath: target.subpath, anchor: target.segment },
        { subpath: target.subpath, anchor: (target.segment + 1) % n },
      ]);
    }
    const all = refs.every((ref) => hasRef(edit.anchors, ref));
    if (target.kind === 'anchor' && modifiers.shift) {
      // Shift toggles an anchor and starts no drag.
      const anchors = all
        ? edit.anchors.filter((ref) => !hasRef(refs, ref))
        : canonicalRefs([...edit.anchors, ...refs]);
      context.execute({ type: 'setPathSelection', anchors });
      state = { kind: 'held' };
      return;
    }
    // Shift on a segment adds both ends, then drags the selection like any segment press.
    const selected =
      target.kind === 'segment' && modifiers.shift
        ? canonicalRefs([...edit.anchors, ...refs])
        : refs;
    if (!all) context.execute({ type: 'setPathSelection', anchors: selected });
    if (target.kind === 'anchor' && modifiers.alt) {
      // Alt pulls mirrored handles on the `out` side, or `in` at the end of an open subpath;
      // an anchor without segments does nothing.
      const { ref } = target;
      const model = readAnchorModel((document.nodes[id] as PathNodeV2).path)[ref.subpath]!;
      const side =
        outSegment(model, ref.anchor) !== null
          ? 'out'
          : inSegment(model, ref.anchor) !== null
            ? 'in'
            : null;
      if (side === null) {
        state = { kind: 'held' };
        return;
      }
      if (!context.gesture.begin()) return;
      state = {
        kind: 'pull',
        start: point,
        moved: false,
        id,
        ref,
        side,
        anchor: overlay.subpaths[ref.subpath]!.anchors[ref.anchor]!.point,
      };
      return;
    }
    if (!context.gesture.begin()) return;
    state = {
      kind: 'anchors',
      start: point,
      moved: false,
      id,
      anchors: context.query({ type: 'pathEdit' })?.anchors ?? refs,
      snapFrom:
        target.kind === 'anchor'
          ? overlay.subpaths[target.ref.subpath]!.anchors[target.ref.anchor]!.point
          : null,
      click: selected,
      // The edited path is the moving node (section 5).
      candidates: lazySnapSet(context, [id]),
    };
  }

  /** `handlesOff`: a press that just ended path edit mode on another node gets no handles. */
  function pointerDown(event: Pointer, context: ToolContext, handlesOff = false): void {
    if (state.kind !== 'idle') return;
    const document = context.query({ type: 'document' });
    const selection = context.query({ type: 'selection' });
    const zoom = zoomOf(context);
    const handles = handlesOff ? null : handlesOf(context, selection);
    // The node hit and its selection target (section 6), with the scope in place of the page
    // (M2 contract, section 5): a hit on the scope node itself is empty canvas inside the scope,
    // and a hit outside the scope's subtree, or none, leaves the scope for the page rule. A
    // press on an already selected node between them (one selected below the target, for
    // example from a layers panel) keeps the selection and acts on that node.
    const pressed = resolveHit(context, event.point);
    const { deepest, scope, leaves } = pressed;
    const target = deepest === null ? null : selectionTarget(document, deepest, scope);
    const hit =
      deepest === null
        ? null
        : (targetChain(document, deepest, scope).find((id) => selection.includes(id)) ?? target);
    // On a box too small for its handles to stay apart, a press on a selected node inside it
    // moves; otherwise a handle wins over the node under it.
    const reach = (4 * HANDLE_RADIUS) / zoom;
    const small = handles !== null && (handles.box.width < reach || handles.box.height < reach);
    const movesSmall =
      small && hit !== null && selection.includes(hit) && insideHandles(handles, event.point);
    const handle = handles === null || movesSmall ? null : handleAt(handles, event.point, zoom);
    if (handles !== null && handle !== null) {
      if (context.gesture.begin()) {
        // Resize snaps when the handle box is page-aligned (section 4.2): modes `p5` and `map`,
        // and a `single` box whose page rotation normalizes to 0.
        const aligned = handles.mode !== 'single' || normalizeRotation(handles.turn) === 0;
        const bounds = aligned ? boundsOf(document, selection) : null;
        state = {
          kind: 'resize',
          start: event.point,
          frames: framesOf(context, selection),
          handles,
          handle,
          moved: false,
          bounds: bounds === null ? null : boxOfFrame(bounds),
          candidates: lazySnapSet(context, selection),
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
          single: selection.length === 1 ? singleOf(document, selection[0]!) : null,
          moved: false,
          candidates: lazySnapSet(context, selection),
        };
      }
      return;
    }
    if (hit === null || target === null) {
      // Empty canvas: the page's (leaving any scope), or the scope's own (keeping it).
      if (leaves) context.execute({ type: 'setScope', id: null });
      state = {
        kind: 'marquee',
        start: event.point,
        current: event.point,
        additive: event.modifiers.shift,
      };
      return;
    }
    if (event.modifiers.alt) {
      // Alt-drag: the selection and scope changes wait for the first movement or the release
      // (sections 4.3 and 5).
      if (context.gesture.begin()) {
        const moveSet = selection.includes(hit) ? selection : [hit];
        const bounds = boundsOf(document, moveSet);
        state = {
          kind: 'duplicate',
          start: event.point,
          moveSet,
          moved: false,
          bounds: bounds === null ? null : boxOfFrame(bounds),
          scope,
          leaves,
          selection,
          copies: null,
        };
      }
      return;
    }
    if (leaves) context.execute({ type: 'setScope', id: null });
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
      const current = context.query({ type: 'document' });
      const tree = documentTree(current);
      const bounds = boundsOf(current, ids);
      state = {
        kind: 'move',
        start: event.point,
        frames: framesOf(context, ids),
        turns: new Map(ids.map((id) => [id, spaceOf(tree, tree.node(id)!.parent).rotation])),
        moved: false,
        hit: target,
        bounds: bounds === null ? null : boxOfFrame(bounds),
        candidates: lazySnapSet(context, ids),
      };
    }
  }

  /**
   * Snaps a page-aligned resize (section 4.2): only the edges the handle moves are offered, and
   * the snapped box `B′` is the pre-gesture box with those edges moved.
   */
  function snapResize(
    current: Extract<SelectState, { kind: 'resize' }>,
    dx: number,
    dy: number,
    modifiers: Modifiers,
    context: ToolContext,
  ): { dx: number; dy: number; overlay: SnapOverlay | null } {
    const { bounds, handle, handles } = current;
    if (bounds === null || !snapsOn(context, modifiers)) return { dx, dy, overlay: null };
    const edges = (fraction: number, size: number): ValueIndex[] =>
      fraction === 0.5 || size === 0 ? [] : [fraction === 0 ? 0 : 2];
    const x = edges(handle[0], handles.box.width);
    const y = edges(handle[1], handles.box.height);
    const moved = (low: number, high: number, index: readonly ValueIndex[], delta: number) => {
      const a = index[0] === 0 ? low + delta : low;
      const b = index[0] === 2 ? high + delta : high;
      return [Math.min(a, b), Math.max(a, b)] as const;
    };
    const result = snapBox(
      current.candidates(),
      {
        box: translateBox(bounds, dx, dy),
        x,
        y,
        spacing: false,
        snapped: (ox, oy) => {
          const [left, right] = moved(bounds.left, bounds.right, x, dx + ox);
          const [top, bottom] = moved(bounds.top, bounds.bottom, y, dy + oy);
          return { left, top, right, bottom };
        },
      },
      thresholdOf(context),
    );
    return { dx: dx + result.ox, dy: dy + result.oy, overlay: result.overlay };
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
    const { pivot, start, single, ids } = current;
    const q = event.point;
    let angle = normalizeRotation(
      Math.atan2(q.y - pivot.y, q.x - pivot.x) - Math.atan2(start.y - pivot.y, start.x - pivot.x),
    );
    if (single === null) {
      if (event.modifiers.shift) {
        angle = normalizeRotation(Math.round(angle / ROTATE_STEP) * ROTATE_STEP);
      }
      context.gesture.replace([{ type: 'rotateNodes', ids, angle, pivot }]);
      // The overlay shows the stepped angle of a several-node Shift rotation (section 4.2).
      context.snap(event.modifiers.shift ? { guides: [], gaps: [], angle } : null);
      return;
    }
    // One node: the pivot is its own centre, so it is omitted and the node keeps its stored x
    // and y (section 4.1, one-node rule); the default pivot equals the one fixed at press.
    const result = normalizeRotation(single.turn + angle);
    let target: number | null;
    if (event.modifiers.shift) {
      // Shift: the resulting page rotation steps to `normalize(k · π/12)`.
      target = normalizeRotation(Math.round(result / ROTATE_STEP) * ROTATE_STEP);
    } else if (snapsOn(context, event.modifiers)) {
      // Rotation-angle snapping (section 4.2): within the 6 px arc at the pointer.
      const r = distance(q, pivot);
      target = snapAngle(current.candidates(), result, r, thresholdOf(context));
    } else {
      target = null;
    }
    if (target === null) {
      context.gesture.replace([{ type: 'rotateNodes', ids, angle }]);
      context.snap(null);
      return;
    }
    // The adjustment `wrap(target − turn)` reaches the target only up to binary64 rounding, so
    // an absolute set after it stores exactly `normalize(target − chain)` (exactly the target
    // for a page-root node).
    const rotation = normalizeRotation(target - single.chain);
    // Back at the stored rotation: the pre-gesture document, so no step at commit.
    if (rotation === single.rotation) {
      context.gesture.replace([]);
    } else {
      context.gesture.replace([
        { type: 'rotateNodes', ids, angle: normalizeRotation(target - single.turn) },
        {
          type: 'setFrames',
          frames: [{ id: ids[0]!, frame: single.frame, rotation }],
        },
      ]);
    }
    context.snap({ guides: [], gaps: [], angle: target });
  }

  function pointerMove(event: Pointer, context: ToolContext): void {
    if (state.kind === 'marquee' || state.kind === 'anchorMarquee') {
      state.current = event.point;
      return;
    }
    if (state.kind === 'idle' || state.kind === 'held') return;
    const dx = event.point.x - state.start.x;
    const dy = event.point.y - state.start.y;
    if (!state.moved && dx === 0 && dy === 0) return;
    state.moved = true;
    if (state.kind === 'anchors') {
      // The raw page delta plus the pressed anchor's snap offset; a delta of exactly (0, 0)
      // gives back the pre-gesture document (M3 contract, section 5).
      let mx = dx;
      let my = dy;
      let overlay: SnapOverlay | null = null;
      const from = state.snapFrom;
      if (from !== null && snapsOn(context, event.modifiers)) {
        const result = snapPoint(
          state.candidates(),
          { x: from.x + dx, y: from.y + dy },
          thresholdOf(context),
        );
        mx = dx + result.ox;
        my = dy + result.oy;
        overlay = result.overlay;
      }
      const { id, anchors } = state;
      context.gesture.replace([{ type: 'movePathAnchors', id, anchors, dx: mx, dy: my }]);
      context.snap(overlay);
      return;
    }
    if (state.kind === 'handle') {
      // Back at the press point the handle is where it was: the pre-gesture document.
      const { id, ref, side, from } = state;
      const mirror = state.mirror && !event.modifiers.alt;
      context.gesture.replace(
        dx === 0 && dy === 0
          ? []
          : [
              {
                type: 'setPathHandle',
                id,
                anchor: ref,
                side,
                to: { x: from.x + dx, y: from.y + dy },
                mirror,
              },
            ],
      );
      return;
    }
    if (state.kind === 'pull') {
      const { id, ref, side, anchor } = state;
      const q = event.point;
      const to = side === 'out' ? q : { x: 2 * anchor.x - q.x, y: 2 * anchor.y - q.y };
      context.gesture.replace([{ type: 'setPathHandle', id, anchor: ref, side, to, mirror: true }]);
      return;
    }
    if (state.kind === 'resize') {
      const snapped = snapResize(state, dx, dy, event.modifiers, context);
      resize(state, snapped.dx, snapped.dy, context);
      context.snap(snapped.overlay);
      return;
    }
    if (state.kind === 'rotate') {
      rotateTo(state, event, context);
      return;
    }
    if (state.kind === 'duplicate') {
      if (state.copies === null) {
        // The first movement duplicates the move set once (a creating command draws IDs on
        // every application, S1) and selects the copies; later moves set their frames.
        const result = context.gesture.update({ type: 'duplicateNodes', ids: state.moveSet });
        const ids = result.ok ? result.ids : [];
        if (ids.length > 0) context.execute({ type: 'setSelection', ids });
        const live = context.query({ type: 'document' });
        const tree = documentTree(live);
        state.copies = {
          frames: new Map(ids.map((id) => [id, live.nodes[id]!.frame])),
          turns: new Map(ids.map((id) => [id, spaceOf(tree, live.nodes[id]!.parent).rotation])),
          // The copies move; the originals stay and are candidates. Every other box is as in
          // the pre-gesture document, since the copies are the only change. The scope owner is
          // the one the press resolved to.
          candidates: lazySnapSet(context, ids, state.scope),
        };
      }
      const { frames, turns, candidates } = state.copies;
      if (frames.size > 0) moveBy(frames, turns, state.bounds, candidates, dx, dy, event, context);
      return;
    }
    moveBy(state.frames, state.turns, state.bounds, state.candidates, dx, dy, event, context);
  }

  /**
   * A move (section 4.2): the moving nodes' joint box `bounds` snaps, then each node moves from
   * its frame in `from` by the snapped page delta turned into its parent space.
   */
  function moveBy(
    from: Map<string, Frame>,
    turns: Map<string, number>,
    bounds: Box | null,
    candidates: () => SnapSet,
    dx: number,
    dy: number,
    event: Pointer,
    context: ToolContext,
  ): void {
    let mx = dx;
    let my = dy;
    let overlay: SnapOverlay | null = null;
    if (bounds !== null && snapsOn(context, event.modifiers)) {
      const result = snapBox(
        candidates(),
        { box: translateBox(bounds, dx, dy), x: [0, 1, 2], y: [0, 1, 2], spacing: true },
        thresholdOf(context),
      );
      mx = dx + result.ox;
      my = dy + result.oy;
      overlay = result.overlay;
    }
    const frames = [...from].map(([id, frame]) => {
      const delta = rotate(-turns.get(id)!, mx, my);
      return { id, frame: { ...frame, x: frame.x + delta.x, y: frame.y + delta.y } };
    });
    context.gesture.update({ type: 'setFrames', frames });
    context.snap(overlay);
  }

  function pointerUp(event: Pointer, context: ToolContext): void {
    // The up point ends the drag, so it updates like a move first.
    const gesture = (kind: SelectState['kind']) =>
      kind === 'move' ||
      kind === 'resize' ||
      kind === 'rotate' ||
      kind === 'duplicate' ||
      kind === 'anchors' ||
      kind === 'handle' ||
      kind === 'pull';
    if (gesture(state.kind)) pointerMove(event, context);
    const current = state;
    state = { kind: 'idle' };
    if (gesture(current.kind)) {
      // An Alt-drag commits the duplicate and the move as one step.
      context.gesture.commit();
      // A click without movement selects the target hit, even inside a larger selection.
      if (current.kind === 'move' && !current.moved) {
        context.execute({ type: 'setSelection', ids: [current.hit] });
      }
      if (current.kind === 'duplicate') {
        // The Alt press's deferred scope change, then an Alt-click cycles (section 5).
        if (current.leaves) context.execute({ type: 'setScope', id: null });
        if (!current.moved) cycle(current, context);
      }
      // A click on an anchor or segment selects only it (M3 contract, section 5).
      if (current.kind === 'anchors' && !current.moved) {
        context.execute({ type: 'setPathSelection', anchors: current.click });
      }
      // An Alt-click retracts both handles, so the anchor becomes a corner.
      if (current.kind === 'pull' && !current.moved) {
        const { id, ref, side } = current;
        context.execute({ type: 'setPathHandle', id, anchor: ref, side, to: null, mirror: true });
      }
    } else if (current.kind === 'anchorMarquee') {
      editMarquee(current, event.point, context);
    } else if (current.kind === 'marquee') {
      current.current = event.point;
      if (distance(current.start, current.current) === 0) {
        // A click on empty canvas clears the selection; shift keeps it.
        if (!current.additive) context.execute({ type: 'setSelection', ids: [] });
        return;
      }
      // The scope's children inside a scope, else the page's (section 5).
      const hits = marqueeHits(
        context.query({ type: 'document' }),
        context.query({ type: 'activePage' }),
        boxOf(current.start, current.current),
        context.query({ type: 'scope' }),
      );
      const ids = current.additive
        ? [...new Set([...context.query({ type: 'selection' }), ...hits])]
        : hits;
      context.execute({ type: 'setSelection', ids });
    }
  }

  /**
   * The release of an anchor marquee (M3 contract, section 5): the anchors whose page point lies
   * in the closed box become the anchor selection, Shift adds. A click without movement on the
   * fill clears the anchor selection; on empty canvas it ends edit mode, as the M2 click there
   * does (the selection clears, Shift keeps it, and a press outside the scope leaves it).
   */
  function editMarquee(
    current: Extract<SelectState, { kind: 'anchorMarquee' }>,
    end: PagePoint,
    context: ToolContext,
  ): void {
    current.current = end;
    if (distance(current.start, end) === 0) {
      if (current.canvas) {
        if (current.additive) context.execute({ type: 'exitPathEdit' });
        else context.execute({ type: 'setSelection', ids: [] });
        if (current.leaves) context.execute({ type: 'setScope', id: null });
      } else if (!current.additive) {
        context.execute({ type: 'setPathSelection', anchors: [] });
      }
      return;
    }
    const overlay = context.query({ type: 'pathOverlay' });
    if (overlay === null) return;
    const box = boxOf(current.start, end);
    const inside = ({ x, y }: PagePoint) =>
      x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
    const hits = overlay.subpaths.flatMap((subpath, s) =>
      subpath.anchors.flatMap((anchor, a) =>
        inside(anchor.point) ? [{ subpath: s, anchor: a }] : [],
      ),
    );
    const before = current.additive ? (context.query({ type: 'pathEdit' })?.anchors ?? []) : [];
    context.execute({ type: 'setPathSelection', anchors: canonicalRefs([...before, ...hits]) });
  }

  /** States with no gesture of their own. */
  const passive = (kind: SelectState['kind']) =>
    kind === 'marquee' || kind === 'anchorMarquee' || kind === 'held';

  return {
    input(event, context) {
      if (event.kind === 'keydown') {
        if (event.key === 'Escape' && state.kind !== 'idle') {
          if (!passive(state.kind)) context.gesture.cancel();
          state = { kind: 'idle' };
          return true;
        }
        return false;
      }
      if (event.kind === 'pointerdown') {
        if (state.kind !== 'idle') return false;
        const edit = context.query({ type: 'pathEdit' });
        if (edit === null) pointerDown(event, context);
        else editDown(event, context, edit);
        return true;
      }
      if (event.kind === 'doubleclick') {
        if (state.kind !== 'idle') return false;
        const edit = context.query({ type: 'pathEdit' });
        if (edit !== null) {
          // On an anchor, a handle, a segment or the fill a double-click is consumed and does
          // nothing; insertion on a segment is M3-U3's.
          const zoom = zoomOf(context);
          const document = context.query({ type: 'document' });
          if (pathTargetAt(document, edit, event.point, zoom, HANDLE_RADIUS / zoom) !== null) {
            return true;
          }
        }
        return doubleClick(event.point, context);
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
      return state.kind === 'marquee' || state.kind === 'anchorMarquee'
        ? deepFreeze({ kind: 'marquee', frame: boxOf(state.start, state.current) })
        : null;
    },
  };
}
