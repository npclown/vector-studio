import { serializeDocument } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type InputEvent,
  type Modifiers,
  type PagePoint,
} from '../../packages/editor-core/src/index.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// MVP M2-U1, M2-A02 (M2 contract, section 3): the viewport commands, wheel zoom and pan, and
// Space-drag and middle-drag pans, all through commands and `input`, compared with the binary64
// evaluation of the section 3 formulas (M2-Q14).

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const ctrl: Modifiers = { ...none, ctrl: true };
const meta: Modifiers = { ...none, meta: true };
const shift: Modifiers = { ...none, shift: true };

function editor(): Editor {
  return createEditor({ ids: createCounterIdSource('n') });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function input(target: Editor, event: InputEvent): CommandResult {
  return target.execute({ type: 'input', event });
}

function events(target: Editor): EditorEvent[] {
  const seen: EditorEvent[] = [];
  target.subscribe((event) => seen.push(event));
  return seen;
}

function camera(target: Editor) {
  return target.query({ type: 'viewport' });
}

function setCamera(target: Editor, x: number, y: number, zoom: number) {
  ok(target, { type: 'setViewport', camera: { position: { x, y }, zoom } });
}

/** The page point under a screen (CSS px) point with the editor's current camera. */
function pageAt(target: Editor, sx: number, sy: number): PagePoint {
  const { position, zoom } = camera(target);
  return { x: position.x + sx / zoom, y: position.y + sy / zoom };
}

/** Section 3: position1 = p − (p − position0) · (z0 / z1). */
function about(p: PagePoint, position: PagePoint, z0: number, z1: number) {
  return { x: p.x - (p.x - position.x) * (z0 / z1), y: p.y - (p.y - position.y) * (z0 / z1) };
}

function sized(width = 800, height = 600): Editor {
  const target = editor();
  ok(target, { type: 'setViewportSize', width, height });
  return target;
}

describe('M2-A02 setViewportSize', () => {
  it('sets the session size with an event; the same size raises none', () => {
    const target = editor();
    expect(target.query({ type: 'viewportSize' })).toBeNull();
    expect(target.getSnapshot().viewportSize).toBeNull();
    const seen = events(target);
    ok(target, { type: 'setViewportSize', width: 800, height: 600 });
    expect(target.query({ type: 'viewportSize' })).toEqual({ width: 800, height: 600 });
    expect(target.getSnapshot().viewportSize).toEqual({ width: 800, height: 600 });
    expect(Object.isFrozen(target.query({ type: 'viewportSize' }))).toBe(true);
    expect(seen).toEqual([{ type: 'session', field: 'viewportSize' }]);
    ok(target, { type: 'setViewportSize', width: 800, height: 600 });
    expect(seen).toHaveLength(1);
  });

  it.each([
    [0, 600, '/width'],
    [-1, 600, '/width'],
    [Number.NaN, 600, '/width'],
    [Number.POSITIVE_INFINITY, 600, '/width'],
    ['800' as never, 600, '/width'],
    [800, 0, '/height'],
    [800, Number.NaN, '/height'],
  ])('rejects width %s, height %s as editor.invalid-command at %s', (width, height, path) => {
    const target = editor();
    const seen = events(target);
    expect(target.execute({ type: 'setViewportSize', width, height })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path,
    });
    expect(target.query({ type: 'viewportSize' })).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe('M2-A02 zoomBy', () => {
  it('zooms about the viewport centre by default', () => {
    const target = sized();
    setCamera(target, 10, 20, 1);
    ok(target, { type: 'zoomBy', factor: 2 });
    // Centre (10 + 800 / 2, 20 + 600 / 2) = (410, 320) stays: 410 − 400 · 0.5, 320 − 300 · 0.5.
    expect(camera(target)).toEqual({ position: { x: 210, y: 170 }, zoom: 2 });
  });

  it('zooms about a given page point without a viewport size', () => {
    const target = editor();
    setCamera(target, 3, -7, 1.5);
    const p = { x: 41.25, y: 13.5 };
    ok(target, { type: 'zoomBy', factor: 3, about: p });
    expect(camera(target)).toEqual({ position: about(p, { x: 3, y: -7 }, 1.5, 4.5), zoom: 4.5 });
  });

  it('clamps at both bounds; at the clamp it changes nothing and sends nothing', () => {
    const target = sized();
    const renderer = new RecordingRenderer();
    target.attachRenderer(renderer);
    ok(target, { type: 'zoomBy', factor: 1000 });
    expect(camera(target).zoom).toBe(ZOOM_MAX);
    expect(ZOOM_MAX).toBe(256);
    const calls = renderer.calls.length;
    const seen = events(target);
    const before = camera(target);
    expect(target.execute({ type: 'zoomBy', factor: 2 })).toEqual({ ok: true, ids: [] });
    expect(camera(target)).toBe(before);
    expect(seen).toEqual([]);
    expect(renderer.calls).toHaveLength(calls);
    ok(target, { type: 'zoomBy', factor: 1e-9 });
    expect(camera(target).zoom).toBe(ZOOM_MIN);
    expect(ZOOM_MIN).toBe(1 / 64);
    const low = camera(target);
    ok(target, { type: 'zoomBy', factor: 0.5 });
    expect(camera(target)).toBe(low);
  });

  it('fails without a size and without about: editor.no-viewport-size, nothing changes', () => {
    const target = editor();
    const seen = events(target);
    expect(target.execute({ type: 'zoomBy', factor: 2 })).toEqual({
      ok: false,
      code: 'editor.no-viewport-size',
    });
    expect(camera(target)).toEqual({ position: { x: 0, y: 0 }, zoom: 1 });
    expect(seen).toEqual([]);
  });

  it.each([
    [{ type: 'zoomBy', factor: 0 }, '/factor'],
    [{ type: 'zoomBy', factor: -2 }, '/factor'],
    [{ type: 'zoomBy', factor: Number.NaN }, '/factor'],
    [{ type: 'zoomBy', factor: Number.POSITIVE_INFINITY }, '/factor'],
    [{ type: 'zoomBy', factor: 2, about: { x: Number.NaN, y: 0 } }, '/about'],
    [{ type: 'zoomBy', factor: 2, about: null as never }, '/about'],
    [{ type: 'zoomTo', target: 'page' as never }, '/target'],
  ] as [Command, string][])(
    'rejects a malformed %j as editor.invalid-command before editor.no-viewport-size',
    (command, path) => {
      const target = editor();
      expect(target.execute(command)).toEqual({ ok: false, code: 'editor.invalid-command', path });
    },
  );

  it('rejects a camera the renderer rejects with editor.invalid-camera, unchanged', () => {
    const target = sized();
    const renderer = new RecordingRenderer();
    target.attachRenderer(renderer);
    renderer.overrides.setCamera = { status: 'invalid-camera', reason: 'invalid-value' };
    expect(target.execute({ type: 'zoomBy', factor: 2 })).toEqual({
      ok: false,
      code: 'editor.invalid-camera',
    });
    expect(camera(target)).toEqual({ position: { x: 0, y: 0 }, zoom: 1 });
  });
});

describe('M2-A02 zoomTo', () => {
  function withRects() {
    const target = sized();
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 100, height: 50 },
    });
    ok(target, { type: 'createRectangle', frame: { x: 200, y: 100, width: 100, height: 50 } });
    // A hidden child does not count for fit.
    const [hidden] = ok(target, {
      type: 'createRectangle',
      frame: { x: 5000, y: 5000, width: 10, height: 10 },
    });
    ok(target, { type: 'setNodeProps', id: hidden!, props: { visible: false } });
    return { target, a: a! };
  }

  it('actual: zoom 1 about the viewport centre', () => {
    const target = sized();
    setCamera(target, 0, 0, 2);
    ok(target, { type: 'zoomTo', target: 'actual' });
    // Centre (200, 150): 200 − 200 · 2, 150 − 150 · 2.
    expect(camera(target)).toEqual({ position: { x: -200, y: -150 }, zoom: 1 });
    const seen = events(target);
    ok(target, { type: 'zoomTo', target: 'actual' });
    expect(seen).toEqual([]);
  });

  it('fit: the visible page children with 32 px padding, centred', () => {
    const { target } = withRects();
    ok(target, { type: 'zoomTo', target: 'fit' });
    // Bounds (0, 0, 300, 150); z = min(736 / 300, 536 / 150).
    const z = Math.min((800 - 64) / 300, (600 - 64) / 150);
    expect(camera(target)).toEqual({
      position: { x: 0 + 300 / 2 - 800 / (2 * z), y: 0 + 150 / 2 - 600 / (2 * z) },
      zoom: z,
    });
  });

  it('selection: the selection bounds; an empty selection changes nothing', () => {
    const { target, a } = withRects();
    const seen = events(target);
    expect(target.execute({ type: 'zoomTo', target: 'selection' })).toEqual({ ok: true, ids: [] });
    expect(seen).toEqual([]);
    ok(target, { type: 'setSelection', ids: [a] });
    ok(target, { type: 'zoomTo', target: 'selection' });
    const z = Math.min(736 / 100, 536 / 50);
    expect(camera(target)).toEqual({
      position: { x: 50 - 800 / (2 * z), y: 25 - 600 / (2 * z) },
      zoom: z,
    });
  });

  it('a size of 64 or less on an axis uses the size itself; the zoom clamps', () => {
    const target = sized(50, 40);
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 100, height: 100 },
    });
    ok(target, { type: 'setSelection', ids: [a!] });
    ok(target, { type: 'zoomTo', target: 'selection' });
    expect(camera(target)).toEqual({
      position: { x: 50 - 50 / (2 * 0.4), y: 50 - 40 / (2 * 0.4) },
      zoom: Math.min(50 / 100, 40 / 100),
    });
    ok(target, { type: 'setNodeProps', id: a!, props: { visible: true } });
    const [tiny] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 0.0001, height: 0.0001 },
    });
    ok(target, { type: 'setSelection', ids: [tiny!] });
    ok(target, { type: 'zoomTo', target: 'selection' });
    expect(camera(target).zoom).toBe(256);
  });

  it('an axis of zero size is skipped; both zero keep the zoom', () => {
    const target = sized();
    const [line] = ok(target, {
      type: 'createLine',
      start: { x: 10, y: 0 },
      end: { x: 10, y: 100 },
    });
    ok(target, { type: 'setSelection', ids: [line!] });
    ok(target, { type: 'zoomTo', target: 'selection' });
    expect(camera(target)).toEqual({
      position: { x: 10 - 800 / (2 * 5.36), y: 50 - 600 / (2 * 5.36) },
      zoom: 536 / 100,
    });
    const [dot] = ok(target, {
      type: 'createRectangle',
      frame: { x: 7, y: 9, width: 0, height: 0 },
    });
    ok(target, { type: 'setSelection', ids: [dot!] });
    ok(target, { type: 'zoomTo', target: 'selection' });
    expect(camera(target)).toEqual({
      position: { x: 7 - 800 / (2 * 5.36), y: 9 - 600 / (2 * 5.36) },
      zoom: 5.36,
    });
  });

  it('fit on an empty page changes nothing', () => {
    const target = sized();
    const seen = events(target);
    expect(target.execute({ type: 'zoomTo', target: 'fit' })).toEqual({ ok: true, ids: [] });
    expect(seen).toEqual([]);
  });

  it.each(['fit', 'selection', 'actual'] as const)(
    '%s before setViewportSize fails with editor.no-viewport-size',
    (zoomTarget) => {
      const target = editor();
      expect(target.execute({ type: 'zoomTo', target: zoomTarget })).toEqual({
        ok: false,
        code: 'editor.no-viewport-size',
      });
    },
  );
});

describe('M2-A02 wheel', () => {
  it.each([
    ['Ctrl', ctrl],
    ['Meta', meta],
  ])('%s+wheel zooms by 2^(−deltaY / 100) keeping the pointer point fixed', (_label, modifiers) => {
    const target = editor();
    setCamera(target, -12.5, 30, 1.25);
    const sx = 317;
    const sy = 211;
    const p = pageAt(target, sx, sy);
    const result = input(target, { kind: 'wheel', point: p, deltaX: 0, deltaY: -100, modifiers });
    expect(result).toEqual({ ok: true, ids: [], consumed: true });
    expect(camera(target)).toEqual({
      position: about(p, { x: -12.5, y: 30 }, 1.25, 2.5),
      zoom: 2.5,
    });
    const after = pageAt(target, sx, sy);
    expect(after.x).toBeCloseTo(p.x, 9);
    expect(after.y).toBeCloseTo(p.y, 9);
  });

  it('a pinch (small Ctrl+wheel deltas) zooms by the same formula', () => {
    const target = editor();
    const p = { x: 100, y: 50 };
    input(target, { kind: 'wheel', point: p, deltaX: 4, deltaY: -3, modifiers: ctrl });
    const z = 1 * 2 ** (3 / 100);
    expect(camera(target)).toEqual({ position: about(p, { x: 0, y: 0 }, 1, z), zoom: z });
  });

  it('clamps at both bounds and raises no event at the clamp, still consumed', () => {
    const target = editor();
    const renderer = new RecordingRenderer();
    target.attachRenderer(renderer);
    setCamera(target, 0, 0, 200);
    const p = { x: 3, y: 4 };
    input(target, { kind: 'wheel', point: p, deltaX: 0, deltaY: -100, modifiers: ctrl });
    expect(camera(target)).toEqual({ position: about(p, { x: 0, y: 0 }, 200, 256), zoom: 256 });
    const seen = events(target);
    const calls = renderer.calls.length;
    expect(
      input(target, { kind: 'wheel', point: p, deltaX: 0, deltaY: -100, modifiers: ctrl }),
    ).toEqual({ ok: true, ids: [], consumed: true });
    expect(seen).toEqual([]);
    expect(renderer.calls).toHaveLength(calls);
    setCamera(target, 0, 0, 1 / 64);
    const low = camera(target);
    input(target, { kind: 'wheel', point: p, deltaX: 0, deltaY: 500, modifiers: ctrl });
    expect(camera(target)).toBe(low);
  });

  it('pans by the deltas over the zoom; Shift with deltaX 0 pans horizontally', () => {
    const target = editor();
    setCamera(target, 1, 2, 2);
    const p = { x: 0, y: 0 };
    input(target, { kind: 'wheel', point: p, deltaX: 30, deltaY: 40, modifiers: none });
    expect(camera(target)).toEqual({ position: { x: 16, y: 22 }, zoom: 2 });
    input(target, { kind: 'wheel', point: p, deltaX: 0, deltaY: 40, modifiers: shift });
    expect(camera(target)).toEqual({ position: { x: 36, y: 22 }, zoom: 2 });
    // A trackpad's horizontal delta with Shift stays as it is.
    input(target, { kind: 'wheel', point: p, deltaX: 6, deltaY: 40, modifiers: shift });
    expect(camera(target)).toEqual({ position: { x: 39, y: 42 }, zoom: 2 });
    const seen = events(target);
    input(target, { kind: 'wheel', point: p, deltaX: 0, deltaY: 0, modifiers: none });
    expect(seen).toEqual([]);
  });

  it('zooms during a tool gesture, which goes on', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'rectangle' });
    input(target, { kind: 'pointerdown', point: { x: 0, y: 0 }, modifiers: none });
    input(target, { kind: 'pointermove', point: { x: 10, y: 10 }, modifiers: none });
    input(target, {
      kind: 'wheel',
      point: { x: 10, y: 10 },
      deltaX: 0,
      deltaY: -100,
      modifiers: ctrl,
    });
    expect(camera(target).zoom).toBe(2);
    input(target, { kind: 'pointerup', point: { x: 20, y: 30 }, modifiers: none });
    const id = target.query({ type: 'selection' })[0]!;
    expect(target.query({ type: 'node', id })?.frame).toEqual({
      x: 0,
      y: 0,
      width: 20,
      height: 30,
    });
  });
});

describe('M2-A02 drag pans', () => {
  /** Drives a pan as EditorCanvas does: each screen point mapped with the current camera. */
  function pan(target: Editor, button: number, points: readonly [number, number][]) {
    const [first, ...rest] = points;
    const grab = pageAt(target, first![0], first![1]);
    expect(input(target, { kind: 'pointerdown', point: grab, button, modifiers: none })).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    rest.forEach(([sx, sy], index) => {
      const kind = index === rest.length - 1 ? 'pointerup' : 'pointermove';
      expect(input(target, { kind, point: pageAt(target, sx, sy), modifiers: none }).consumed).toBe(
        true,
      );
      // The grabbed point stays under the pointer.
      const under = pageAt(target, sx, sy);
      expect(under.x).toBeCloseTo(grab.x, 9);
      expect(under.y).toBeCloseTo(grab.y, 9);
    });
  }

  it('a middle-button drag pans by g − q and creates no history', () => {
    const target = editor();
    setCamera(target, 0, 0, 2);
    const before = serializeDocument(target.query({ type: 'document' }));
    pan(target, 1, [
      [100, 100],
      [110, 100],
      [130, 90],
      [131, 89],
    ]);
    // Exact at zoom 2: the screen moved by (31, −11), so the camera by (−15.5, 5.5).
    expect(camera(target)).toEqual({ position: { x: -15.5, y: 5.5 }, zoom: 2 });
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(serializeDocument(target.query({ type: 'document' }))).toBe(before);
    // The pan ended at pointerup: a move is no pan, and the select tool is idle.
    const after = camera(target);
    expect(
      input(target, { kind: 'pointermove', point: { x: 0, y: 0 }, modifiers: none }).consumed,
    ).toBe(false);
    expect(camera(target)).toBe(after);
  });

  it('a primary drag with Space held pans; Space events are consumed by navigation', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'rectangle' });
    expect(input(target, { kind: 'keydown', key: ' ', code: 'Space', modifiers: none })).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    // Auto-repeat keeps it held.
    input(target, { kind: 'keydown', key: ' ', code: 'Space', repeat: true, modifiers: none });
    pan(target, 0, [
      [50, 50],
      [40, 45],
    ]);
    expect(camera(target)).toEqual({ position: { x: 10, y: 5 }, zoom: 1 });
    expect(target.query({ type: 'document' }).pages[0]!.children).toEqual([]);
    expect(input(target, { kind: 'keyup', key: ' ', code: 'Space', modifiers: none })).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    // Released: a primary drag draws again.
    input(target, { kind: 'pointerdown', point: { x: 0, y: 0 }, modifiers: none });
    input(target, { kind: 'pointerup', point: { x: 5, y: 5 }, modifiers: none });
    expect(target.query({ type: 'document' }).pages[0]!.children).toHaveLength(1);
    expect(camera(target)).toEqual({ position: { x: 10, y: 5 }, zoom: 1 });
  });

  it('Space pressed during a tool gesture starts no pan until the gesture ends', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'rectangle' });
    input(target, { kind: 'pointerdown', point: { x: 0, y: 0 }, modifiers: none });
    expect(input(target, { kind: 'keydown', key: ' ', modifiers: none }).consumed).toBe(true);
    input(target, { kind: 'pointermove', point: { x: 10, y: 10 }, modifiers: none });
    input(target, { kind: 'pointerup', point: { x: 10, y: 20 }, modifiers: none });
    const [id] = target.query({ type: 'document' }).pages[0]!.children;
    expect(target.query({ type: 'node', id: id! })?.frame).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 20,
    });
    expect(camera(target)).toEqual({ position: { x: 0, y: 0 }, zoom: 1 });
    // The gesture ended, Space is still held: the next press pans.
    input(target, { kind: 'pointerdown', point: { x: 0, y: 0 }, modifiers: none });
    input(target, { kind: 'pointerup', point: { x: -4, y: 0 }, modifiers: none });
    expect(camera(target)).toEqual({ position: { x: 4, y: 0 }, zoom: 1 });
  });

  it('a middle press during a gesture is ignored', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'rectangle' });
    input(target, { kind: 'pointerdown', point: { x: 0, y: 0 }, modifiers: none });
    expect(
      input(target, { kind: 'pointerdown', point: { x: 5, y: 5 }, button: 1, modifiers: none }),
    ).toEqual({ ok: true, ids: [], consumed: false });
    input(target, { kind: 'pointerup', point: { x: 10, y: 10 }, modifiers: none });
    expect(target.query({ type: 'document' }).pages[0]!.children).toHaveLength(1);
  });

  it('Space held across a blur (pointercancel) is released', () => {
    const target = editor();
    input(target, { kind: 'keydown', key: ' ', modifiers: none });
    input(target, { kind: 'pointerdown', point: { x: 0, y: 0 }, modifiers: none });
    input(target, { kind: 'pointermove', point: { x: -5, y: 0 }, modifiers: none });
    expect(camera(target)).toEqual({ position: { x: 5, y: 0 }, zoom: 1 });
    // EditorCanvas's blur reset: pointercancel, then a Space key-up.
    expect(input(target, { kind: 'pointercancel', modifiers: none })).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    input(target, { kind: 'keyup', key: ' ', code: 'Space', modifiers: none });
    // The pan ended and Space is no longer held: the press starts the select tool's marquee.
    expect(
      input(target, { kind: 'pointermove', point: { x: -50, y: 0 }, modifiers: none }).consumed,
    ).toBe(false);
    expect(camera(target)).toEqual({ position: { x: 5, y: 0 }, zoom: 1 });
    input(target, { kind: 'pointerdown', point: { x: 0, y: 0 }, modifiers: none });
    input(target, { kind: 'pointermove', point: { x: 10, y: 10 }, modifiers: none });
    expect(target.query({ type: 'overlay' })).toEqual({
      kind: 'marquee',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    // pointercancel alone also releases Space.
    input(target, { kind: 'pointercancel', modifiers: none });
    input(target, { kind: 'keydown', key: ' ', modifiers: none });
    input(target, { kind: 'pointercancel', modifiers: none });
    input(target, { kind: 'pointerdown', point: { x: 0, y: 0 }, modifiers: none });
    input(target, { kind: 'pointermove', point: { x: 3, y: 3 }, modifiers: none });
    expect(target.query({ type: 'overlay' })?.kind).toBe('marquee');
    expect(camera(target)).toEqual({ position: { x: 5, y: 0 }, zoom: 1 });
  });

  it('no viewport change enters history or the serialized document', () => {
    const target = sized();
    ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 10, height: 10 } });
    const text = serializeDocument(target.query({ type: 'document' }));
    const history = target.query({ type: 'history' });
    const revision = target.query({ type: 'revision' });
    ok(target, { type: 'zoomBy', factor: 2 });
    ok(target, { type: 'zoomTo', target: 'fit' });
    ok(target, { type: 'zoomTo', target: 'actual' });
    input(target, { kind: 'wheel', point: { x: 0, y: 0 }, deltaX: 3, deltaY: 4, modifiers: none });
    input(target, { kind: 'wheel', point: { x: 0, y: 0 }, deltaX: 0, deltaY: 50, modifiers: ctrl });
    input(target, { kind: 'pointerdown', point: { x: 0, y: 0 }, button: 1, modifiers: none });
    input(target, { kind: 'pointerup', point: { x: 9, y: 9 }, modifiers: none });
    expect(serializeDocument(target.query({ type: 'document' }))).toBe(text);
    expect(target.query({ type: 'history' })).toEqual(history);
    expect(target.query({ type: 'revision' })).toBe(revision);
    expect(text).not.toContain('zoom');
  });
});
