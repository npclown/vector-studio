import type { Frame } from '@vector-studio/model';
import type { Tool, ToolContext } from './editor.js';
import { boundsOf, marqueeHits, topmostHit, type CustomGeometry } from './hit-test.js';
import type { InputEvent, PagePoint, PathAnchor, ToolOverlay } from './types.js';

// P5 tools (plan section 4.4). Tools act only through commands and the gesture API.

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

export function createRectangleTool(): Tool {
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
      if (
        event.kind === 'pointermove' &&
        (drag.id !== null || distance(event.point, drag.start) > 0)
      ) {
        const frame = boxOf(drag.start, event.point);
        if (drag.id === null) {
          const result = context.gesture.update({ type: 'createRectangle', frame });
          if (result.ok) drag.id = result.ids[0] ?? null;
        } else {
          context.gesture.update({ type: 'setFrames', frames: [{ id: drag.id, frame }] });
        }
      } else if (event.kind === 'pointerup') {
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
    anchors = [];
    pressed = null;
    // The whole creation is one transaction, sent only now (plan section 4.4).
    const result = context.execute({ type: 'createPath', verbs, points });
    if (result.ok) context.execute({ type: 'setSelection', ids: result.ids });
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
      return { kind: 'path', anchors: anchors.map(copy) };
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

type SelectState =
  | { kind: 'idle' }
  | { kind: 'move'; start: PagePoint; frames: Map<string, Frame>; moved: boolean }
  | { kind: 'resize'; start: PagePoint; frames: Map<string, Frame>; box: Frame; handle: Handle }
  | { kind: 'marquee'; start: PagePoint; current: PagePoint; additive: boolean };

/** Scales `value` about `origin` by `scale` along one axis. */
function scaled(origin: number, value: number, scale: number): number {
  return origin + (value - origin) * scale;
}

export function createSelectTool(custom: CustomGeometry): Tool {
  let state: SelectState = { kind: 'idle' };

  function framesOf(context: ToolContext, ids: readonly string[]): Map<string, Frame> {
    const document = context.query({ type: 'document' });
    return new Map(ids.map((id) => [id, document.nodes[id]!.frame]));
  }

  /** The nearest handle within reach that can scale at least one axis of the box. */
  function handleAt(box: Frame, point: PagePoint, zoom: number): Handle | null {
    let best: Handle | null = null;
    let bestDistance = HANDLE_RADIUS / zoom;
    for (const handle of HANDLES) {
      const scalesX = handle[0] !== 0.5 && box.width > 0;
      const scalesY = handle[1] !== 0.5 && box.height > 0;
      if (!scalesX && !scalesY) continue;
      const at = { x: box.x + handle[0] * box.width, y: box.y + handle[1] * box.height };
      const d = distance(point, at);
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
    const box = boundsOf(document, selection);
    const handle = box === null ? null : handleAt(box, event.point, zoom);
    if (box !== null && handle !== null) {
      if (context.gesture.begin()) {
        state = {
          kind: 'resize',
          start: event.point,
          frames: framesOf(context, selection),
          box,
          handle,
        };
      }
      return;
    }
    const hit = topmostHit(document, event.point, zoom, custom);
    if (hit === null) {
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
      state = { kind: 'move', start: event.point, frames: framesOf(context, ids), moved: false };
    }
  }

  function pointerMove(event: Pointer, context: ToolContext): void {
    if (state.kind === 'marquee') {
      state.current = event.point;
      return;
    }
    if (state.kind === 'idle') return;
    const dx = event.point.x - state.start.x;
    const dy = event.point.y - state.start.y;
    if (state.kind === 'move') {
      if (!state.moved && dx === 0 && dy === 0) return;
      state.moved = true;
      const frames = [...state.frames].map(([id, frame]) => ({
        id,
        frame: { ...frame, x: frame.x + dx, y: frame.y + dy },
      }));
      context.gesture.update({ type: 'setFrames', frames });
      return;
    }
    // Resize: the box scales about the opposite handle; an axis of size 0 is not scaled, and
    // scales clamp at 0, so sizes do too.
    const { box, handle } = state;
    const axis = (fraction: number, origin: number, size: number, delta: number) => {
      if (fraction === 0.5 || size === 0) return { origin, scale: 1 };
      const anchor = origin + (1 - fraction) * size;
      const from = origin + fraction * size;
      return { origin: anchor, scale: Math.max(0, (from + delta - anchor) / (from - anchor)) };
    };
    const x = axis(handle[0], box.x, box.width, dx);
    const y = axis(handle[1], box.y, box.height, dy);
    const frames = [...state.frames].map(([id, frame]) => ({
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

  function pointerUp(event: Pointer, context: ToolContext): void {
    const current = state;
    state = { kind: 'idle' };
    if (current.kind === 'move' || current.kind === 'resize') {
      context.gesture.commit();
    } else if (current.kind === 'marquee') {
      current.current = event.point;
      if (distance(current.start, current.current) === 0) {
        // A click on empty canvas clears the selection; shift keeps it.
        if (!current.additive) context.execute({ type: 'setSelection', ids: [] });
        return;
      }
      const hits = marqueeHits(
        context.query({ type: 'document' }),
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
        ? { kind: 'marquee', frame: boxOf(state.start, state.current) }
        : null;
    },
  };
}
