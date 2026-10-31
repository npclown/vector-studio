import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type EditorOptions,
  type InputEvent,
  type Modifiers,
} from '../../packages/editor-core/src/index.js';
// Source imports: the gesture API and the canvas input mapping are package-internal.
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import {
  CanvasInput,
  WHEEL_LINE_PX,
  attachCanvasListeners,
  syncViewportSize,
  type KeyLike,
  type ListenerTarget,
} from '../../packages/react/src/canvas-input.js';

// MVP M2-U1, M2-A01 (M2 contract, section 2): the M2-I1 input kinds, the M2-I2 dispatch order,
// the M2-I3 `consumed` flag, cancel restoring the selection, and the M2-I4 EditorCanvas input
// mapping (driven through CanvasInput with structural events, as the component forwards them).

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const ctrl: Modifiers = { ...none, ctrl: true };

function editor(options: EditorOptions = {}): Editor {
  return createEditor({ ids: createCounterIdSource('n'), ...options });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function input(target: Editor, event: InputEvent): CommandResult {
  return target.execute({ type: 'input', event });
}

const at = (x: number, y: number) => ({ x, y });

function children(target: Editor): readonly string[] {
  return target.query({ type: 'document' }).pages[0]!.children;
}

describe('M2-A01 input kinds validate', () => {
  it.each<[string, InputEvent]>([
    [
      'keydown with code, repeat and composing',
      { kind: 'keydown', key: 'a', code: 'KeyA', repeat: true, composing: false, modifiers: none },
    ],
    ['keyup', { kind: 'keyup', key: 'a', modifiers: none }],
    ['keyup with code', { kind: 'keyup', key: 'a', code: 'KeyA', modifiers: none }],
    ['wheel', { kind: 'wheel', point: at(1, 2), deltaX: 0, deltaY: 0, modifiers: none }],
    ['doubleclick', { kind: 'doubleclick', point: at(1, 2), modifiers: none }],
    ['pointercancel', { kind: 'pointercancel', modifiers: none }],
    ['pointerdown button 2', { kind: 'pointerdown', point: at(1, 2), button: 2, modifiers: none }],
  ])('accepts %s', (_label, event) => {
    const result = input(editor(), event);
    expect(result.ok).toBe(true);
    expect(typeof result.consumed).toBe('boolean');
  });

  it.each<[string, unknown]>([
    ['an unknown kind', { kind: 'tap', point: at(0, 0), modifiers: none }],
    ['keyup without a key', { kind: 'keyup', modifiers: none }],
    ['keydown with a numeric code', { kind: 'keydown', key: 'a', code: 5, modifiers: none }],
    ['keydown with a string repeat', { kind: 'keydown', key: 'a', repeat: 'yes', modifiers: none }],
    [
      'keydown with a numeric composing',
      { kind: 'keydown', key: 'a', composing: 1, modifiers: none },
    ],
    ['keyup with a null code', { kind: 'keyup', key: 'a', code: null, modifiers: none }],
    [
      'wheel with a NaN delta',
      { kind: 'wheel', point: at(0, 0), deltaX: Number.NaN, deltaY: 0, modifiers: none },
    ],
    ['wheel without deltaY', { kind: 'wheel', point: at(0, 0), deltaX: 0, modifiers: none }],
    ['wheel without a point', { kind: 'wheel', deltaX: 0, deltaY: 0, modifiers: none }],
    ['doubleclick without a point', { kind: 'doubleclick', modifiers: none }],
    [
      'pointerdown with a fractional button',
      { kind: 'pointerdown', point: at(0, 0), button: 1.5, modifiers: none },
    ],
    [
      'pointerdown with a string button',
      { kind: 'pointerdown', point: at(0, 0), button: '1', modifiers: none },
    ],
    ['pointercancel without modifiers', { kind: 'pointercancel' }],
  ])('rejects %s as editor.invalid-command at /event, with no consumed', (_label, event) => {
    const result = editor().execute({ type: 'input', event: event as InputEvent });
    expect(result).toEqual({ ok: false, code: 'editor.invalid-command', path: '/event' });
    expect('consumed' in result).toBe(false);
  });
});

describe('M2-A01 dispatch order and consumed', () => {
  it('pointer events report consumed when the tool acted on them', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'rectangle' });
    // A move without a press is hover: nothing acted.
    expect(input(target, { kind: 'pointermove', point: at(1, 1), modifiers: none })).toEqual({
      ok: true,
      ids: [],
      consumed: false,
    });
    expect(input(target, { kind: 'pointerdown', point: at(0, 0), modifiers: none }).consumed).toBe(
      true,
    );
    expect(input(target, { kind: 'pointermove', point: at(5, 5), modifiers: none }).consumed).toBe(
      true,
    );
    expect(input(target, { kind: 'pointerup', point: at(5, 5), modifiers: none }).consumed).toBe(
      true,
    );
    expect(input(target, { kind: 'pointerup', point: at(5, 5), modifiers: none }).consumed).toBe(
      false,
    );
    // The select tool acts on every press (selection, drag or marquee).
    ok(target, { type: 'setTool', tool: 'select' });
    expect(
      input(target, { kind: 'pointerdown', point: at(50, 50), modifiers: none }).consumed,
    ).toBe(true);
    expect(input(target, { kind: 'pointerup', point: at(50, 50), modifiers: none }).consumed).toBe(
      true,
    );
  });

  it('a button other than 0 or 1 is ignored and not consumed', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'rectangle' });
    expect(
      input(target, { kind: 'pointerdown', point: at(0, 0), button: 2, modifiers: none }),
    ).toEqual({ ok: true, ids: [], consumed: false });
    input(target, { kind: 'pointermove', point: at(5, 5), modifiers: none });
    input(target, { kind: 'pointerup', point: at(5, 5), modifiers: none });
    expect(children(target)).toEqual([]);
  });

  it('a double-click goes to the tool; M2-U1 tools do not act on it', () => {
    const target = editor();
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(input(target, { kind: 'doubleclick', point: at(5, 5), modifiers: none })).toEqual({
      ok: true,
      ids: [],
      consumed: false,
    });
    expect(children(target)).toEqual([a]);
    expect(target.query({ type: 'selection' })).toEqual([]);
  });

  it('a wheel event is navigation, also during a gesture; the tool does not see it', () => {
    const target = editor();
    const received: string[] = [];
    internalsOf(target).tools.set('select', {
      input: (event) => received.push(event.kind) < 0,
      reset: () => received.push('reset'),
      overlay: () => null,
    });
    expect(
      input(target, { kind: 'wheel', point: at(0, 0), deltaX: 0, deltaY: 10, modifiers: none }),
    ).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    internalsOf(target).gesture.begin();
    input(target, { kind: 'wheel', point: at(0, 0), deltaX: 0, deltaY: -100, modifiers: ctrl });
    expect(target.query({ type: 'viewport' }).zoom).toBe(2);
    expect(received).toEqual([]);
    input(target, { kind: 'keyup', key: 'x', modifiers: none });
    input(target, { kind: 'doubleclick', point: at(0, 0), modifiers: none });
    expect(received).toEqual(['keyup', 'doubleclick']);
  });

  it('Space never reaches the tool or the keymap', () => {
    const target = editor();
    ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 10, height: 10 } });
    const received: string[] = [];
    internalsOf(target).tools.set('select', {
      input: (event) => received.push(event.kind) < 0,
      reset: () => undefined,
      overlay: () => null,
    });
    expect(input(target, { kind: 'keydown', key: ' ', code: 'Space', modifiers: none })).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    expect(
      input(target, { kind: 'keyup', key: ' ', code: 'Space', modifiers: none }).consumed,
    ).toBe(true);
    expect(received).toEqual([]);
  });

  it.each<[string, { key: string; code: string; composing?: boolean }]>([
    ['a composing Space', { key: 'Process', code: 'Space', composing: true }],
    ['a Process Space', { key: 'Process', code: 'Space' }],
    ['an Unidentified Space', { key: 'Unidentified', code: 'Space' }],
  ])('%s under an IME is Space: it holds for a pan and never reaches the keymap', (_label, key) => {
    const target = editor();
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    ok(target, { type: 'setSelection', ids: [a!] });
    const received: string[] = [];
    const tools = internalsOf(target).tools;
    const select = tools.get('select')!;
    tools.set('select', {
      input: (event, context) => {
        received.push(event.kind);
        return select.input(event, context);
      },
      reset: () => select.reset(),
      overlay: () => select.overlay(),
    });
    expect(input(target, { kind: 'keydown', ...key, modifiers: none })).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    expect(children(target)).toEqual([a]);
    expect(received).toEqual([]);
    input(target, { kind: 'pointerdown', point: at(50, 50), modifiers: none });
    input(target, { kind: 'pointermove', point: at(40, 50), modifiers: none });
    expect(target.query({ type: 'viewport' }).position).toEqual({ x: 10, y: 0 });
    input(target, { kind: 'pointerup', point: at(50, 50), modifiers: none });
    // The IME key-up of Space releases the hold.
    expect(
      input(target, { kind: 'keyup', key: 'Process', code: 'Space', modifiers: none }).consumed,
    ).toBe(true);
    input(target, { kind: 'pointerdown', point: at(50, 50), modifiers: none });
    expect(received).toEqual(['pointerdown']);
  });
});

describe('M2-A01 pointercancel', () => {
  it('cancels a drag and resets the tool, consumed; never reaches the keymap', () => {
    const target = editor({ keymap: [{ chord: 'Escape', action: 'selectAll' }] });
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 50, y: 50, width: 10, height: 10 },
    });
    ok(target, { type: 'setTool', tool: 'rectangle' });
    input(target, { kind: 'pointerdown', point: at(0, 0), modifiers: none });
    input(target, { kind: 'pointermove', point: at(20, 20), modifiers: none });
    expect(children(target)).toHaveLength(2);
    const history = target.query({ type: 'history' });
    expect(input(target, { kind: 'pointercancel', modifiers: none })).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    expect(children(target)).toEqual([a]);
    expect(target.query({ type: 'history' })).toEqual(history);
    expect(internalsOf(target).gesture.active).toBe(false);
    // No Escape was synthesized: the host's Escape binding did not run.
    expect(target.query({ type: 'selection' })).toEqual([]);
    // The tool is reset: the release that follows creates nothing.
    expect(input(target, { kind: 'pointerup', point: at(30, 30), modifiers: none }).consumed).toBe(
      false,
    );
    expect(children(target)).toEqual([a]);
    // Nothing to cancel: not consumed.
    expect(input(target, { kind: 'pointercancel', modifiers: none })).toEqual({
      ok: true,
      ids: [],
      consumed: false,
    });
  });

  it('drops pending path anchors and a marquee', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'path' });
    input(target, { kind: 'pointerdown', point: at(0, 0), modifiers: none });
    input(target, { kind: 'pointerup', point: at(0, 0), modifiers: none });
    expect(target.query({ type: 'overlay' })?.kind).toBe('path');
    expect(input(target, { kind: 'pointercancel', modifiers: none }).consumed).toBe(true);
    expect(target.query({ type: 'overlay' })).toBeNull();
    ok(target, { type: 'setTool', tool: 'select' });
    input(target, { kind: 'pointerdown', point: at(0, 0), modifiers: none });
    input(target, { kind: 'pointermove', point: at(9, 9), modifiers: none });
    expect(target.query({ type: 'overlay' })?.kind).toBe('marquee');
    expect(input(target, { kind: 'pointercancel', modifiers: none }).consumed).toBe(true);
    expect(target.getSnapshot().overlay).toBeNull();
  });

  it('cancel restores the selection recorded when the gesture began', () => {
    const target = editor();
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    const [b] = ok(target, {
      type: 'createRectangle',
      frame: { x: 20, y: 0, width: 10, height: 10 },
    });
    ok(target, { type: 'setSelection', ids: [a!] });
    const { gesture } = internalsOf(target);
    gesture.begin();
    gesture.update({
      type: 'setFrames',
      frames: [{ id: b!, frame: { x: 40, y: 0, width: 10, height: 10 } }],
    });
    ok(target, { type: 'setSelection', ids: [b!] });
    input(target, { kind: 'pointercancel', modifiers: none });
    expect(target.query({ type: 'selection' })).toEqual([a]);
    expect(target.query({ type: 'node', id: b! })?.frame.x).toBe(20);
    // A recorded node that no longer exists is dropped.
    ok(target, { type: 'setSelection', ids: [a!, b!] });
    gesture.begin();
    ok(target, { type: 'setSelection', ids: [] });
    ok(target, { type: 'deleteNodes', ids: [a!] });
    expect(target.query({ type: 'selection' })).toEqual([b]);
  });
});

/** A fake canvas at client (10, 20) with a 1 px border, and its recorded calls. */
function fakeCanvas() {
  const calls: string[] = [];
  const canvas = {
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    clientLeft: 1,
    clientTop: 1,
    setPointerCapture: (id: number) => calls.push(`capture:${id}`),
    focus: (options?: { preventScroll?: boolean }) =>
      calls.push(options?.preventScroll === true ? 'focus:preventScroll' : 'focus'),
  };
  return { canvas, calls };
}

const keys = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };

function host(options: EditorOptions = {}) {
  const target = editor(options);
  const { canvas, calls } = fakeCanvas();
  const sent: InputEvent[] = [];
  const execute = target.execute.bind(target);
  target.execute = (command) => {
    if (command.type === 'input') sent.push(command.event);
    return execute(command);
  };
  const canvasInput = new CanvasInput(
    target,
    () => 600,
    () => canvas,
  );
  const pointer = (button: number, clientX: number, clientY: number) => {
    let prevented = false;
    return {
      event: {
        ...keys,
        button,
        clientX,
        clientY,
        pointerId: 7,
        currentTarget: canvas,
        preventDefault: () => {
          prevented = true;
        },
      },
      prevented: () => prevented,
    };
  };
  const mouse = (clientX: number, clientY: number) => ({
    ...keys,
    clientX,
    clientY,
    currentTarget: canvas,
  });
  const key = (k: Partial<KeyLike> & { key: string }) => {
    let prevented = false;
    const event: KeyLike = {
      ...keys,
      code: '',
      repeat: false,
      isComposing: false,
      preventDefault: () => {
        prevented = true;
      },
      ...k,
    };
    return { event, prevented: () => prevented };
  };
  return { target, canvasInput, sent, calls, pointer, mouse, key };
}

describe('M2-A01 EditorCanvas input (M2-I4)', () => {
  it('maps points with the camera at event time, inside the canvas border', () => {
    const { target, canvasInput, sent, calls, pointer, mouse } = host();
    ok(target, { type: 'setViewport', camera: { position: { x: 100, y: 50 }, zoom: 2 } });
    canvasInput.pointerDown(pointer(0, 31, 41).event);
    expect(sent).toEqual([
      { kind: 'pointerdown', point: { x: 110, y: 60 }, button: 0, modifiers: none },
    ]);
    // The press focuses the canvas without scrolling it, so the press point stays put.
    expect(calls).toEqual(['capture:7', 'focus:preventScroll']);
    // The camera changes between events (no re-render in between); the next move reads it.
    ok(target, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 4 } });
    canvasInput.pointerMove(mouse(31, 41));
    expect(sent[1]).toEqual({ kind: 'pointermove', point: { x: 5, y: 5 }, modifiers: none });
  });

  it('a middle-button pan keeps the grabbed point under the pointer through a stale render', () => {
    const { target, canvasInput, pointer, mouse } = host();
    const down = pointer(1, 111, 121);
    canvasInput.pointerDown(down.event);
    expect(down.prevented()).toBe(true);
    canvasInput.pointerMove(mouse(121, 121));
    expect(target.query({ type: 'viewport' }).position).toEqual({ x: -10, y: 0 });
    canvasInput.pointerMove(mouse(131, 111));
    expect(target.query({ type: 'viewport' }).position).toEqual({ x: -20, y: 10 });
    canvasInput.pointerUp(mouse(131, 111));
    expect(target.query({ type: 'viewport' }).position).toEqual({ x: -20, y: 10 });
  });

  it('forwards buttons 0 and 1 only; moves without a press are hover', () => {
    const { canvasInput, sent, calls, pointer, mouse } = host();
    canvasInput.pointerMove(mouse(50, 50));
    const right = pointer(2, 50, 50);
    canvasInput.pointerDown(right.event);
    canvasInput.pointerUp(mouse(50, 50));
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
    expect(right.prevented()).toBe(false);
    const primary = pointer(0, 50, 50);
    canvasInput.pointerDown(primary.event);
    expect(primary.prevented()).toBe(false);
    canvasInput.pointerUp(mouse(50, 50));
    expect(sent.map((event) => event.kind)).toEqual(['pointerdown', 'pointerup']);
  });

  it('wheel: pixel, line (16 px) and page (canvas height) deltas; preventDefault when consumed', () => {
    const { target, canvasInput, sent } = host();
    let prevented = 0;
    const wheel = (deltaMode: number, deltaY: number, ctrlKey = false) =>
      canvasInput.wheel({
        ...keys,
        ctrlKey,
        clientX: 11,
        clientY: 21,
        deltaX: 1,
        deltaY,
        deltaMode,
        preventDefault: () => {
          prevented += 1;
        },
      });
    wheel(0, 5);
    wheel(1, 3);
    wheel(2, 1);
    expect(
      sent.map((event) => (event.kind === 'wheel' ? [event.deltaX, event.deltaY] : null)),
    ).toEqual([
      [1, 5],
      [WHEEL_LINE_PX, 3 * WHEEL_LINE_PX],
      [600, 600],
    ]);
    expect(prevented).toBe(3);
    ok(target, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 256 } });
    // Ctrl+wheel at the clamp changes nothing but is still consumed, so the page never zooms.
    wheel(0, -100, true);
    expect(prevented).toBe(4);
    expect(sent[3]).toMatchObject({ kind: 'wheel', point: { x: 0, y: 0 }, modifiers: ctrl });
  });

  it('keys: code, repeat and composing are forwarded; preventDefault only when consumed', () => {
    const { canvasInput, sent, key } = host();
    const undo = key({ key: 'z', code: 'KeyZ', ctrlKey: true, repeat: true });
    canvasInput.keyDown(undo.event);
    // A bound action that fails (empty history) is still consumed.
    expect(undo.prevented()).toBe(true);
    expect(sent[0]).toEqual({
      kind: 'keydown',
      key: 'z',
      code: 'KeyZ',
      repeat: true,
      composing: false,
      modifiers: ctrl,
    });
    const tab = key({ key: 'Tab', code: 'Tab' });
    canvasInput.keyDown(tab.event);
    expect(tab.prevented()).toBe(false);
    const composing = key({ key: 'Process', code: 'KeyA', isComposing: true });
    canvasInput.keyDown(composing.event);
    expect(sent[2]).toMatchObject({ kind: 'keydown', composing: true, code: 'KeyA' });
    const up = key({ key: 'z', code: 'KeyZ' });
    canvasInput.keyUp(up.event);
    expect(up.prevented()).toBe(false);
    expect(sent[3]).toEqual({ kind: 'keyup', key: 'z', code: 'KeyZ', modifiers: none });
    const space = key({ key: ' ', code: 'Space' });
    canvasInput.keyUp(space.event);
    expect(space.prevented()).toBe(true);
  });

  it('pointercancel replaces the synthesized Escape', () => {
    const { target, canvasInput, sent, pointer } = host({
      keymap: [{ chord: 'Escape', action: 'selectAll' }],
    });
    ok(target, { type: 'createRectangle', frame: { x: 500, y: 500, width: 10, height: 10 } });
    ok(target, { type: 'setTool', tool: 'rectangle' });
    canvasInput.pointerDown(pointer(0, 11, 21).event);
    canvasInput.pointerCancel(keys);
    expect(sent.map((event) => event.kind)).toEqual(['pointerdown', 'pointercancel']);
    expect(target.query({ type: 'selection' })).toEqual([]);
    // Without a forwarded press there is nothing to cancel.
    canvasInput.pointerCancel(keys);
    expect(sent).toHaveLength(2);
  });

  it('a double-click is forwarded in page space', () => {
    const { canvasInput, sent, mouse } = host();
    canvasInput.doubleClick(mouse(16, 26));
    expect(sent).toEqual([{ kind: 'doubleclick', point: { x: 5, y: 5 }, modifiers: none }]);
  });

  it('the blur reset sends pointercancel and a Space key-up, so Space is not left held', () => {
    const { target, canvasInput, sent, key, pointer, mouse } = host();
    canvasInput.keyDown(key({ key: ' ', code: 'Space' }).event);
    canvasInput.pointerDown(pointer(0, 11, 21).event);
    canvasInput.pointerMove(mouse(21, 21));
    expect(target.query({ type: 'viewport' }).position).toEqual({ x: -10, y: 0 });
    canvasInput.reset();
    expect(sent.slice(-2)).toEqual([
      { kind: 'pointercancel', modifiers: none },
      { kind: 'keyup', key: ' ', code: 'Space', modifiers: none },
    ]);
    // The release after the blur is not ours, and a new press does not pan.
    canvasInput.pointerUp(mouse(31, 21));
    canvasInput.pointerDown(pointer(0, 11, 21).event);
    canvasInput.pointerMove(mouse(41, 41));
    expect(target.query({ type: 'viewport' }).position).toEqual({ x: -10, y: 0 });
    expect(target.query({ type: 'overlay' })?.kind).toBe('marquee');
  });
});

describe('E26-U6a press state (section 5, amended M2-I4)', () => {
  function pressed() {
    const harness = host();
    const seen: string[] = [];
    harness.canvasInput.onPressChange = (value) => {
      // The press starts before the editor sees it and ends after it handled the release.
      seen.push(`${value ? 'press' : 'release'}@${harness.sent.length}`);
    };
    return { ...harness, seen };
  }

  it('reports a press on a forwarded pointerdown and its end on pointerup', () => {
    const { canvasInput, seen, pointer, mouse } = pressed();
    canvasInput.pointerDown(pointer(2, 50, 50).event);
    canvasInput.pointerUp(mouse(50, 50));
    expect(seen).toEqual([]);
    canvasInput.pointerDown(pointer(0, 50, 50).event);
    canvasInput.pointerMove(mouse(60, 60));
    canvasInput.pointerUp(mouse(60, 60));
    canvasInput.pointerUp(mouse(60, 60));
    expect(seen).toEqual(['press@0', 'release@3']);
  });

  it('a second pointerdown during a press does not report a second press', () => {
    const { canvasInput, seen, pointer, mouse } = pressed();
    canvasInput.pointerDown(pointer(0, 50, 50).event);
    canvasInput.pointerDown(pointer(1, 50, 50).event);
    canvasInput.pointerUp(mouse(50, 50));
    expect(seen).toEqual(['press@0', 'release@3']);
  });

  it('pointercancel and a lost pointer capture end the press once', () => {
    const { canvasInput, sent, seen, pointer, mouse } = pressed();
    canvasInput.pointerDown(pointer(0, 50, 50).event);
    canvasInput.pointerCancel(keys);
    canvasInput.lostPointerCapture(keys);
    canvasInput.pointerDown(pointer(0, 50, 50).event);
    canvasInput.lostPointerCapture(keys);
    canvasInput.pointerUp(mouse(50, 50));
    expect(sent.map((event) => event.kind)).toEqual([
      'pointerdown',
      'pointercancel',
      'pointerdown',
      'pointercancel',
    ]);
    expect(seen).toEqual(['press@0', 'release@2', 'press@2', 'release@4']);
  });

  it('a lost capture after pointerup sends nothing and reports nothing', () => {
    const { canvasInput, sent, seen, pointer, mouse } = pressed();
    canvasInput.pointerDown(pointer(0, 50, 50).event);
    canvasInput.pointerUp(mouse(50, 50));
    canvasInput.lostPointerCapture(keys);
    expect(sent.map((event) => event.kind)).toEqual(['pointerdown', 'pointerup']);
    expect(seen).toEqual(['press@0', 'release@2']);
  });

  it('the blur reset ends a press after its sends; without a press it reports nothing', () => {
    const { canvasInput, seen, pointer, key } = pressed();
    canvasInput.keyDown(key({ key: 'x', code: 'KeyX' }).event);
    canvasInput.reset();
    expect(seen).toEqual([]);
    canvasInput.pointerDown(pointer(0, 50, 50).event);
    canvasInput.reset();
    expect(seen).toEqual(['press@3', 'release@6']);
  });

  it('unmount ends a press without an editor event', () => {
    const { canvasInput, sent, seen, pointer } = pressed();
    canvasInput.unmount();
    canvasInput.pointerDown(pointer(0, 50, 50).event);
    canvasInput.unmount();
    canvasInput.unmount();
    expect(sent.map((event) => event.kind)).toEqual(['pointerdown']);
    expect(seen).toEqual(['press@0', 'release@1']);
  });

  it('the press ends even when the editor throws on the release', () => {
    const { target, canvasInput, seen, pointer, mouse } = pressed();
    canvasInput.pointerDown(pointer(0, 50, 50).event);
    target.execute = () => {
      throw new Error('boom');
    };
    expect(() => canvasInput.pointerUp(mouse(50, 50))).toThrow('boom');
    expect(seen).toEqual(['press@0', 'release@1']);
  });
});

/** A fake element or window that records its listeners and dispatches to them. */
function fakeTarget() {
  const listeners: { type: string; listener: (event: Event) => void; options?: unknown }[] = [];
  const target: ListenerTarget = {
    addEventListener: (type, listener, options) =>
      listeners.push(options === undefined ? { type, listener } : { type, listener, options }),
    removeEventListener: (type, listener) => {
      const index = listeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener,
      );
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  const fire = (type: string, event: object) =>
    listeners
      .filter((entry) => entry.type === type)
      .forEach((entry) => entry.listener(event as Event));
  return { target, listeners, fire };
}

describe('M2-A01 EditorCanvas wiring (M2-I4)', () => {
  function wired() {
    const harness = host();
    const canvas = fakeTarget();
    const view = fakeTarget();
    const self = { canvas: true };
    const cleanup = attachCanvasListeners(
      canvas.target,
      view.target,
      harness.canvasInput,
      (node) => node === self,
    );
    return { ...harness, canvas, view, self, cleanup };
  }

  it('sends setViewportSize on mount and on resize', () => {
    const target = editor();
    const seen: string[] = [];
    target.subscribe((event) => seen.push(event.type === 'session' ? event.field : event.type));
    syncViewportSize(target, 960, 640);
    expect(target.query({ type: 'viewportSize' })).toEqual({ width: 960, height: 640 });
    syncViewportSize(target, 960, 640);
    syncViewportSize(target, 480, 320);
    expect(target.query({ type: 'viewportSize' })).toEqual({ width: 480, height: 320 });
    expect(seen).toEqual(['viewportSize', 'viewportSize']);
  });

  it('registers a non-passive wheel listener, a canvas blur and a window blur listener', () => {
    const { canvas, view, target, sent } = wired();
    expect(canvas.listeners.map(({ type, options }) => [type, options])).toEqual([
      ['wheel', { passive: false }],
      ['blur', undefined],
      ['copy', undefined],
      ['cut', undefined],
      ['paste', undefined],
    ]);
    expect(view.listeners.map(({ type }) => type)).toEqual(['blur']);
    let prevented = false;
    canvas.fire('wheel', {
      ...keys,
      ctrlKey: true,
      clientX: 11,
      clientY: 21,
      deltaX: 0,
      deltaY: -100,
      deltaMode: 0,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(target.query({ type: 'viewport' }).zoom).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it('a canvas blur leaving the focus target resets input; focus within it does not', () => {
    const { canvas, canvasInput, key, sent, self } = wired();
    canvasInput.keyDown(key({ key: ' ', code: 'Space' }).event);
    canvas.fire('blur', { relatedTarget: self });
    expect(sent).toHaveLength(1);
    canvas.fire('blur', { relatedTarget: null });
    expect(sent.slice(1)).toEqual([
      { kind: 'pointercancel', modifiers: none },
      { kind: 'keyup', key: ' ', code: 'Space', modifiers: none },
    ]);
  });

  it('a window blur resets input once, also when the canvas blur fires with it', () => {
    const { canvas, view, canvasInput, key, sent } = wired();
    // Nothing forwarded yet: nothing to release.
    view.fire('blur', {});
    expect(sent).toEqual([]);
    canvasInput.keyDown(key({ key: ' ', code: 'Space' }).event);
    view.fire('blur', {});
    canvas.fire('blur', { relatedTarget: null });
    expect(sent.map((event) => event.kind)).toEqual(['keydown', 'pointercancel', 'keyup']);
  });

  it('cleanup on unmount removes every listener', () => {
    const { canvas, view, cleanup, sent, canvasInput, key } = wired();
    cleanup();
    expect(canvas.listeners).toEqual([]);
    expect(view.listeners).toEqual([]);
    canvasInput.keyDown(key({ key: ' ', code: 'Space' }).event);
    view.fire('blur', {});
    canvas.fire('wheel', { ...keys, clientX: 0, clientY: 0, deltaX: 0, deltaY: 1, deltaMode: 0 });
    expect(sent.map((event) => event.kind)).toEqual(['keydown']);
  });
});
