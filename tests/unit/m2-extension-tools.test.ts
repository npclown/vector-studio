import { serializeDocument, type Color, type Frame } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type EditorOptions,
  type Extension,
  type ExtensionTool,
  type InputEvent,
  type KeyBinding,
  type Modifiers,
  type PagePoint,
  type ToolApi,
} from '@vector-studio/editor-core';

// MVP M2-U7, M2-A12 (M2 contract, section 7): an extension tool with `update` and `replace`
// gestures, a binding to the extension's own command, `setTool` to the tool, keys the tool
// consumes, and every registration and conflict failure, through the package entry points only
// (no source import). The A11 rest for extension tools is here too: tool-first consumption and no
// keymap during an extension tool's gesture.

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const mods = (...names: (keyof Modifiers)[]): Modifiers => ({
  ...none,
  ...Object.fromEntries(names.map((name) => [name, true])),
});
const red: Color = { r: 1, g: 0, b: 0, a: 1 };

function box(a: PagePoint, b: PagePoint): Frame {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

type Stamp = {
  extension: Extension;
  /** Every call the tools received, in order. */
  log: string[];
  /** The `ToolApi` each tool last received. */
  apis: Map<string, ToolApi>;
  /** Results of the shift tool's `update` with a relative command. */
  rejected: CommandResult[];
};

/**
 * `ext.stamp`: `ext.stamp.draw` draws a rectangle with `update` (one creation, then absolute
 * `setFrames`) and shows a marquee overlay; `ext.stamp.shift` moves the selection with
 * `replace([nudgeNodes])`; `ext.stamp.fill` fills the selection. The draw tool owns Delete and
 * Mod+C, and Escape during its drag.
 */
function stamp(): Stamp {
  const log: string[] = [];
  const apis = new Map<string, ToolApi>();
  const rejected: CommandResult[] = [];
  let press: PagePoint | null = null;
  let drawn: string | null = null;
  let current: Frame | null = null;
  const draw: ExtensionTool = {
    id: 'ext.stamp.draw',
    input(event, api) {
      apis.set('draw', api);
      log.push(`draw:${event.kind}${'key' in event ? `:${event.key}` : ''}`);
      switch (event.kind) {
        case 'pointerdown':
          if (!api.gesture.begin()) return false;
          press = event.point;
          return true;
        case 'pointermove': {
          if (press === null) return false;
          current = box(press, event.point);
          if (drawn === null) {
            const result = api.gesture.update({ type: 'createRectangle', frame: current });
            if (result.ok) drawn = result.ids[0]!;
          } else {
            api.gesture.update({ type: 'setFrames', frames: [{ id: drawn, frame: current }] });
          }
          return true;
        }
        case 'pointerup':
          if (press === null) return false;
          api.gesture.commit();
          press = null;
          drawn = null;
          current = null;
          return true;
        case 'keydown':
          if (event.key === 'Escape' && api.gesture.active) {
            api.gesture.cancel();
            press = null;
            drawn = null;
            current = null;
            return true;
          }
          if (event.key === 'Delete') return true;
          if (event.key === 'c' && event.modifiers.ctrl) return true;
          return undefined;
        default:
          return false;
      }
    },
    reset() {
      log.push('draw:reset');
      press = null;
      drawn = null;
      current = null;
    },
    overlay: () => (current === null ? null : { kind: 'marquee', frame: current }),
  };
  let start: PagePoint | null = null;
  let moving: readonly string[] = [];
  const shift: ExtensionTool = {
    id: 'ext.stamp.shift',
    input(event, api) {
      apis.set('shift', api);
      log.push(`shift:${event.kind}`);
      if (event.kind === 'pointerdown') {
        moving = api.query({ type: 'selection' });
        if (moving.length === 0 || !api.gesture.begin()) return false;
        start = event.point;
        return true;
      }
      if (start === null) return false;
      if (event.kind === 'pointermove') {
        const nudge = {
          type: 'nudgeNodes',
          ids: moving,
          dx: event.point.x - start.x,
          dy: event.point.y - start.y,
        } as const;
        rejected.push(api.gesture.update(nudge));
        api.gesture.replace([nudge]);
        return true;
      }
      if (event.kind === 'pointerup') {
        api.gesture.commit();
        start = null;
        return true;
      }
      return false;
    },
    reset() {
      log.push('shift:reset');
      start = null;
    },
  };
  const extension: Extension = {
    id: 'ext.stamp',
    tools: [draw, shift],
    commands: [
      {
        id: 'ext.stamp.fill',
        run(args, api) {
          const ids = api.query({ type: 'selection' });
          for (const id of ids) {
            const result = api.execute({
              type: 'setNodeProps',
              id,
              props: { fill: args as Color },
            });
            if (!result.ok) return result;
          }
          return { ok: true, ids };
        },
      },
    ],
    bindings: [
      { chord: 'Shift+S', action: 'setTool', args: { tool: 'ext.stamp.draw' } },
      { chord: 'Alt+F', action: 'ext.stamp.fill', args: red },
    ],
  };
  return { extension, log, apis, rejected };
}

function editor(extensions: readonly Extension[], options: EditorOptions = {}): Editor {
  return createEditor({ ids: createCounterIdSource('n'), extensions, ...options });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function input(target: Editor, event: InputEvent): CommandResult {
  return target.execute({ type: 'input', event });
}

function pointer(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
): CommandResult {
  return input(target, { kind, point: { x, y }, modifiers: none });
}

function press(target: Editor, key: string, modifiers: Modifiers = none): CommandResult {
  return input(target, { kind: 'keydown', key, modifiers });
}

function events(target: Editor): EditorEvent[] {
  const seen: EditorEvent[] = [];
  target.subscribe((event) => seen.push(event));
  return seen;
}

function rect(target: Editor, x: number, y: number): string {
  return ok(target, { type: 'createRectangle', frame: { x, y, width: 10, height: 10 } })[0]!;
}

const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const children = (target: Editor) => target.query({ type: 'document' }).pages[0]!.children;
const consumed: CommandResult = { ok: true, ids: [], consumed: true };
const unconsumed: CommandResult = { ok: true, ids: [], consumed: false };

describe('M2-A12 setTool to an extension tool', () => {
  it('activates a registered tool by ID with one tool event; other IDs are unknown', () => {
    const { extension } = stamp();
    const target = editor([extension]);
    const seen = events(target);
    expect(target.execute({ type: 'setTool', tool: 'ext.stamp.draw' })).toEqual({
      ok: true,
      ids: [],
    });
    expect(target.query({ type: 'tool' })).toBe('ext.stamp.draw');
    expect(target.getSnapshot().tool).toBe('ext.stamp.draw');
    expect(seen).toEqual([{ type: 'session', field: 'tool' }]);
    for (const tool of ['ext.stamp', 'ext.stamp.fill', 'ext.none', 'Select', '', 42, null]) {
      expect(target.execute({ type: 'setTool', tool: tool as never })).toEqual({
        ok: false,
        code: 'editor.unknown-tool',
      });
    }
    expect(target.query({ type: 'tool' })).toBe('ext.stamp.draw');
    ok(target, { type: 'setTool', tool: 'select' });
    expect(target.query({ type: 'tool' })).toBe('select');
  });

  it('the extension binding Shift+S runs setTool to its own tool, consumed', () => {
    const { extension } = stamp();
    const target = editor([extension]);
    expect(press(target, 'S', mods('shift'))).toEqual(consumed);
    expect(target.query({ type: 'tool' })).toBe('ext.stamp.draw');
    expect(target.query({ type: 'keymap' }).find((b) => b.chord === 'Shift+KeyS')).toEqual({
      chord: 'Shift+KeyS',
      action: 'setTool',
      args: { tool: 'ext.stamp.draw' },
    });
  });

  it('a host binding may setTool to any registered tool; an unknown tool is invalid-keymap', () => {
    const { extension } = stamp();
    const target = editor([extension], {
      keymap: [{ chord: 'T', action: 'setTool', args: { tool: 'ext.stamp.shift' } }],
    });
    expect(press(target, 't')).toEqual(consumed);
    expect(target.query({ type: 'tool' })).toBe('ext.stamp.shift');
    expect(
      target.execute({
        type: 'setKeymap',
        bindings: [{ chord: 'T', action: 'setTool', args: { tool: 'ext.stamp.none' } }],
      }),
    ).toEqual({ ok: false, code: 'editor.invalid-keymap', path: '/bindings/0/args' });
    expect(() =>
      editor([extension], {
        keymap: [{ chord: 'T', action: 'setTool', args: { tool: 'ext.other.tool' } }],
      }),
    ).toThrow(/editor\.invalid-keymap at \/keymap\/0\/args/u);
  });

  it('gives the tool a frozen ToolApi: execute, query and gesture without edit', () => {
    const { extension, apis } = stamp();
    const target = editor([extension]);
    ok(target, { type: 'setTool', tool: 'ext.stamp.draw' });
    press(target, 'q');
    const api = apis.get('draw')!;
    expect(Object.keys(api).sort()).toEqual(['execute', 'gesture', 'query']);
    expect(Object.keys(api.gesture).sort()).toEqual([
      'active',
      'begin',
      'cancel',
      'commit',
      'replace',
      'update',
    ]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.gesture)).toBe(true);
    expect('edit' in api.gesture).toBe(false);
    expect(api.query({ type: 'tool' })).toBe('ext.stamp.draw');
  });
});

describe('M2-A12 an extension tool with an update gesture', () => {
  it('draws with update, shows its overlay, commits one undo step and undoes byte-identically', () => {
    const { extension } = stamp();
    const target = editor([extension]);
    ok(target, { type: 'setTool', tool: 'ext.stamp.draw' });
    const before = text(target);
    const seen = events(target);
    expect(pointer(target, 'pointerdown', 10, 20)).toEqual(consumed);
    expect(target.query({ type: 'overlay' })).toBeNull();
    expect(pointer(target, 'pointermove', 40, 25)).toEqual(consumed);
    expect(children(target)).toEqual(['n3']);
    expect(target.query({ type: 'node', id: 'n3' })?.frame).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 5,
    });
    expect(pointer(target, 'pointermove', 0, 60)).toEqual(consumed);
    expect(target.query({ type: 'node', id: 'n3' })?.frame).toEqual({
      x: 0,
      y: 20,
      width: 10,
      height: 40,
    });
    // The extension tool's overlay is surfaced like a built-in tool's.
    const marquee = { kind: 'marquee', frame: { x: 0, y: 20, width: 10, height: 40 } };
    expect(target.query({ type: 'overlay' })).toEqual(marquee);
    expect(target.getSnapshot().overlay).toEqual(marquee);
    expect(Object.isFrozen(target.getSnapshot().overlay)).toBe(true);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(pointer(target, 'pointerup', 0, 60)).toEqual(consumed);
    expect(target.query({ type: 'overlay' })).toBeNull();
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(seen.filter((event) => event.type === 'document')).toEqual([
      { type: 'document', cause: 'gesture-update', revision: 1, touched: ['n3'] },
      { type: 'document', cause: 'gesture-update', revision: 2, touched: ['n3'] },
      { type: 'document', cause: 'gesture-commit', revision: 3, touched: ['n3'] },
    ]);
    expect(seen.filter((event) => event.type === 'session')).toEqual([
      { type: 'session', field: 'overlay' },
      { type: 'session', field: 'overlay' },
      { type: 'session', field: 'overlay' },
    ]);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
  });

  it('Escape during its drag is the tool’s and cancels; idle, Escape reaches the keymap', () => {
    const { extension } = stamp();
    const target = editor([extension]);
    const a = rect(target, 100, 100);
    ok(target, { type: 'setSelection', ids: [a] });
    ok(target, { type: 'setTool', tool: 'ext.stamp.draw' });
    const before = text(target);
    pointer(target, 'pointerdown', 0, 0);
    pointer(target, 'pointermove', 5, 5);
    expect(children(target)).toHaveLength(2);
    expect(press(target, 'Escape')).toEqual(consumed);
    expect(text(target)).toBe(before);
    expect(target.query({ type: 'overlay' })).toBeNull();
    // The selection recorded at begin is restored (M2 contract, section 2).
    expect(target.query({ type: 'selection' })).toEqual([a]);
    expect(target.query({ type: 'history' }).undoDepth).toBe(1);
    // No drag: the tool returns nothing, so the default Escape (exitScope) clears the selection.
    expect(press(target, 'Escape')).toEqual(consumed);
    expect(target.query({ type: 'selection' })).toEqual([]);
  });
});

describe('M2-A12 an extension tool with a replace gesture', () => {
  it('replace keeps moves from compounding; update with a relative command fails', () => {
    const { extension, rejected } = stamp();
    const target = editor([extension]);
    const a = rect(target, 100, 100);
    const b = rect(target, 200, 50);
    ok(target, { type: 'setSelection', ids: [a, b] });
    ok(target, { type: 'setTool', tool: 'ext.stamp.shift' });
    const before = text(target);
    expect(pointer(target, 'pointerdown', 0, 0)).toEqual(consumed);
    expect(pointer(target, 'pointermove', 5, 3)).toEqual(consumed);
    expect(target.query({ type: 'node', id: a })?.frame).toMatchObject({ x: 105, y: 103 });
    expect(pointer(target, 'pointermove', 12, -4)).toEqual(consumed);
    expect(target.query({ type: 'node', id: a })?.frame).toEqual({
      x: 112,
      y: 96,
      width: 10,
      height: 10,
    });
    expect(target.query({ type: 'node', id: b })?.frame).toEqual({
      x: 212,
      y: 46,
      width: 10,
      height: 10,
    });
    expect(rejected).toEqual([
      { ok: false, code: 'editor.invalid-command', path: '/type' },
      { ok: false, code: 'editor.invalid-command', path: '/type' },
    ]);
    expect(pointer(target, 'pointerup', 12, -4)).toEqual(consumed);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 3, redoDepth: 0 });
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
  });

  it('pointercancel cancels its gesture and resets the tool, never reaching it', () => {
    const { extension, log } = stamp();
    const target = editor([extension]);
    const a = rect(target, 100, 100);
    ok(target, { type: 'setSelection', ids: [a] });
    ok(target, { type: 'setTool', tool: 'ext.stamp.shift' });
    const before = text(target);
    pointer(target, 'pointerdown', 0, 0);
    pointer(target, 'pointermove', 7, 7);
    log.length = 0;
    expect(input(target, { kind: 'pointercancel', modifiers: none })).toEqual(consumed);
    expect(log).toEqual(['shift:reset']);
    expect(text(target)).toBe(before);
    expect(target.query({ type: 'selection' })).toEqual([a]);
  });
});

describe('M2-A12 keys and events an extension tool receives', () => {
  it('a key the tool consumes never reaches the keymap; an unconsumed one does', () => {
    const { extension, log } = stamp();
    const target = editor([extension], { keymap: [{ chord: 'Mod+C', action: 'copy' }] });
    const a = rect(target, 0, 0);
    ok(target, { type: 'setSelection', ids: [a] });
    ok(target, { type: 'setTool', tool: 'ext.stamp.draw' });
    // Delete is bound by default and Mod+C by the host; the tool consumes both first.
    expect(press(target, 'Delete')).toEqual(consumed);
    expect(press(target, 'c', mods('ctrl'))).toEqual(consumed);
    expect(children(target)).toEqual([a]);
    expect(target.query({ type: 'clipboard' })).toBeNull();
    // `undefined` from input is not consumed: R reaches the default binding, and switching
    // resets the extension tool.
    log.length = 0;
    expect(press(target, 'r')).toEqual(consumed);
    expect(log).toEqual(['draw:keydown:r', 'draw:reset']);
    expect(target.query({ type: 'tool' })).toBe('rectangle');
    // An unbound key the tool does not consume is not consumed.
    ok(target, { type: 'setTool', tool: 'ext.stamp.draw' });
    expect(press(target, 'q')).toEqual(unconsumed);
  });

  it('no keymap during its gesture: a bound key the tool does not consume runs nothing', () => {
    const { extension } = stamp();
    const target = editor([extension]);
    rect(target, 100, 100);
    ok(target, { type: 'setTool', tool: 'ext.stamp.draw' });
    pointer(target, 'pointerdown', 0, 0);
    pointer(target, 'pointermove', 5, 5);
    const history = target.query({ type: 'history' });
    expect(press(target, 'z', mods('ctrl'))).toEqual(unconsumed);
    expect(press(target, 'o')).toEqual(unconsumed);
    expect(press(target, 'S', mods('shift'))).toEqual(unconsumed);
    expect(target.query({ type: 'tool' })).toBe('ext.stamp.draw');
    expect(target.query({ type: 'history' })).toEqual(history);
    expect(children(target)).toHaveLength(2);
    pointer(target, 'pointerup', 5, 5);
    expect(target.query({ type: 'history' }).undoDepth).toBe(2);
  });

  it('gets key-ups and double-clicks; wheel and Space stay navigation’s', () => {
    const { extension, log } = stamp();
    const target = editor([extension]);
    ok(target, { type: 'setTool', tool: 'ext.stamp.draw' });
    log.length = 0;
    expect(input(target, { kind: 'keyup', key: 'q', modifiers: none })).toEqual(unconsumed);
    expect(input(target, { kind: 'doubleclick', point: { x: 1, y: 1 }, modifiers: none })).toEqual(
      unconsumed,
    );
    input(target, { kind: 'wheel', point: { x: 0, y: 0 }, deltaX: 0, deltaY: 10, modifiers: none });
    expect(press(target, ' ')).toEqual(consumed);
    input(target, { kind: 'keyup', key: ' ', modifiers: none });
    expect(log).toEqual(['draw:keyup:q', 'draw:doubleclick']);
  });
});

describe('M2-A12 switching away from an extension tool', () => {
  it('resets the tool, cancels its gesture and leaves its ToolApi inert', () => {
    const { extension, log, apis } = stamp();
    const target = editor([extension]);
    ok(target, { type: 'setTool', tool: 'ext.stamp.draw' });
    const before = text(target);
    pointer(target, 'pointerdown', 0, 0);
    pointer(target, 'pointermove', 5, 5);
    log.length = 0;
    const seen = events(target);
    ok(target, { type: 'setTool', tool: 'select' });
    expect(log).toEqual(['draw:reset']);
    expect(text(target)).toBe(before);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(seen).toEqual([
      { type: 'document', cause: 'gesture-cancel', revision: 2, touched: ['n3'] },
      { type: 'session', field: 'tool' },
      { type: 'session', field: 'overlay' },
    ]);
    expect(target.query({ type: 'overlay' })).toBeNull();
    // A stale ToolApi cannot start, change or end a gesture while its tool is not active.
    const api = apis.get('draw')!;
    expect(api.gesture.active).toBe(false);
    expect(api.gesture.begin()).toBe(false);
    expect(
      api.gesture.update({ type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } }),
    ).toEqual({ ok: false, code: 'editor.invalid-command' });
    expect(api.gesture.replace([])).toEqual({ ok: false, code: 'editor.invalid-command' });
    // A select-tool drag is not the extension's to commit or cancel.
    const a = rect(target, 100, 100);
    pointer(target, 'pointerdown', 105, 105);
    pointer(target, 'pointermove', 115, 105);
    expect(api.gesture.active).toBe(true);
    api.gesture.cancel();
    api.gesture.commit();
    expect(api.gesture.active).toBe(true);
    pointer(target, 'pointerup', 115, 105);
    expect(target.query({ type: 'node', id: a })?.frame).toMatchObject({ x: 110, y: 100 });
  });

  it('switching to the same extension tool resets it; switching between tools resets the old', () => {
    const { extension, log } = stamp();
    const target = editor([extension]);
    ok(target, { type: 'setTool', tool: 'ext.stamp.draw' });
    log.length = 0;
    ok(target, { type: 'setTool', tool: 'ext.stamp.draw' });
    ok(target, { type: 'setTool', tool: 'ext.stamp.shift' });
    ok(target, { type: 'setTool', tool: 'rectangle' });
    expect(log).toEqual(['draw:reset', 'draw:reset', 'shift:reset']);
  });
});

describe('M2-A12 a binding to the extension’s own command', () => {
  it('Alt+F runs ext.stamp.fill with its args on the selection, consumed', () => {
    const { extension } = stamp();
    const target = editor([extension]);
    const a = rect(target, 0, 0);
    expect(press(target, 'f', mods('alt'))).toEqual(consumed);
    ok(target, { type: 'setSelection', ids: [a] });
    expect(press(target, 'f', mods('alt'))).toEqual({ ok: true, ids: [a], consumed: true });
    expect(target.query({ type: 'node', id: a })).toMatchObject({ fill: red });
    expect(target.query({ type: 'keymap' }).find((b) => b.chord === 'Alt+KeyF')).toEqual({
      chord: 'Alt+KeyF',
      action: 'ext.stamp.fill',
      args: red,
    });
    // The extension tool active does not change the binding (the tool does not consume Alt+F).
    ok(target, { type: 'setTool', tool: 'ext.stamp.draw' });
    expect(press(target, 'f', mods('alt'))).toEqual({ ok: true, ids: [a], consumed: true });
  });

  it('the host layer overrides an extension binding, and null unbinds it', () => {
    const { extension } = stamp();
    const target = editor([extension], { keymap: [{ chord: 'Alt+KeyF', action: null }] });
    expect(target.query({ type: 'keymap' }).some((b) => b.chord === 'Alt+KeyF')).toBe(false);
    expect(press(target, 'f', mods('alt'))).toEqual(unconsumed);
  });
});

describe('M2-A12 overlay and input safety', () => {
  it('a malformed or throwing overlay is no overlay; a tool without one has none', () => {
    let value: unknown = { kind: 'marquee', frame: { x: 0, y: 0, width: Number.NaN, height: 1 } };
    const tool = (id: string, overlay?: () => unknown): ExtensionTool => ({
      id,
      input: () => true,
      reset: () => undefined,
      ...(overlay === undefined ? {} : { overlay: overlay as () => null }),
    });
    const target = editor([
      {
        id: 'ext.o',
        tools: [
          tool('ext.o.bad', () => value),
          tool('ext.o.throw', () => {
            throw new Error('overlay');
          }),
          tool('ext.o.none'),
        ],
      },
    ]);
    for (const id of ['ext.o.bad', 'ext.o.throw', 'ext.o.none']) {
      ok(target, { type: 'setTool', tool: id });
      expect(target.query({ type: 'overlay' })).toBeNull();
      expect(target.getSnapshot().overlay).toBeNull();
    }
    ok(target, { type: 'setTool', tool: 'ext.o.bad' });
    for (const bad of [
      null,
      { kind: 'lasso' },
      { kind: 'path', anchors: [{ point: { x: 0, y: 0 }, in: { x: 1 }, out: null }] },
      { kind: 'path', anchors: 'x' },
    ]) {
      value = bad;
      expect(target.query({ type: 'overlay' })).toBeNull();
    }
    // A well-formed path overlay is copied: later changes to the tool's object do not show.
    const anchors = [{ point: { x: 1, y: 2 }, in: null, out: { x: 3, y: 4 } }];
    value = { kind: 'path', anchors };
    press(target, 'q');
    const overlay = target.getSnapshot().overlay;
    expect(overlay).toEqual({ kind: 'path', anchors });
    anchors[0]!.point.x = 99;
    expect(target.getSnapshot().overlay).toBe(overlay);
    expect(overlay).toEqual({
      kind: 'path',
      anchors: [{ point: { x: 1, y: 2 }, in: null, out: { x: 3, y: 4 } }],
    });
  });

  it('a throwing input or reset is contained: not consumed, rethrown asynchronously', async () => {
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);
    process.on('unhandledRejection', onError);
    try {
      const target = editor([
        {
          id: 'ext.t',
          tools: [
            {
              id: 'ext.t.boom',
              input: () => {
                throw new Error('input');
              },
              reset: () => {
                throw new Error('reset');
              },
            },
          ],
        },
      ]);
      ok(target, { type: 'setTool', tool: 'ext.t.boom' });
      const a = rect(target, 0, 0);
      expect(pointer(target, 'pointerdown', 5, 5)).toEqual(unconsumed);
      // Not consumed, so R reaches the keymap; switching away calls the throwing reset.
      expect(press(target, 'r')).toEqual(consumed);
      expect(target.query({ type: 'tool' })).toBe('rectangle');
      expect(children(target)).toEqual([a]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Each throw from input is followed by the editor's reset of the tool; the switch to the
      // rectangle tool resets it once more.
      expect(errors.map((error) => (error as Error).message)).toEqual([
        'input',
        'reset',
        'input',
        'reset',
        'reset',
      ]);
    } finally {
      process.off('unhandledRejection', onError);
    }
  });
});

describe('M2-A12 registration failures throw at createEditor', () => {
  const tool = (id: unknown, extra: Record<string, unknown> = {}) =>
    ({ id, input: () => true, reset: () => undefined, ...extra }) as unknown as ExtensionTool;

  it.each<[string, Extension[], RegExp]>([
    [
      'a tool ID outside the extension namespace',
      [{ id: 'ext.a', tools: [tool('ext.b.t')] }],
      /createEditor: ext\.a cannot register tool ext\.b\.t/u,
    ],
    [
      'a tool ID that only shares a prefix',
      [{ id: 'ext.a', tools: [tool('ext.ab')] }],
      /cannot register tool ext\.ab/u,
    ],
    [
      'the same tool ID twice',
      [{ id: 'ext.a', tools: [tool('ext.a.t'), tool('ext.a.t')] }],
      /cannot register tool ext\.a\.t/u,
    ],
    [
      'a tool ID that is a built-in tool name',
      [{ id: 'select', tools: [tool('select')] }],
      /select cannot register tool select/u,
    ],
    ['a tool ID that is not a string', [{ id: 'ext.a', tools: [tool(7)] }], /register tool 7/u],
    [
      'a tool without input',
      [{ id: 'ext.a', tools: [tool('ext.a.t', { input: undefined })] }],
      /cannot register tool ext\.a\.t/u,
    ],
    [
      'a tool without reset',
      [{ id: 'ext.a', tools: [tool('ext.a.t', { reset: 'no' })] }],
      /cannot register tool ext\.a\.t/u,
    ],
    [
      'an overlay that is not a function',
      [{ id: 'ext.a', tools: [tool('ext.a.t', { overlay: {} })] }],
      /cannot register tool ext\.a\.t/u,
    ],
    [
      'a tool that is not an object',
      [{ id: 'ext.a', tools: [null as never] }],
      /cannot register tool undefined/u,
    ],
    [
      'tools that are not an array',
      [{ id: 'ext.a', tools: tool('ext.a.t') as never }],
      /ext\.a has malformed nodeTypes, commands or tools/u,
    ],
  ])('rejects %s', (_label, extensions, message) => {
    expect(() => editor(extensions)).toThrow(message);
  });

  it('one extension may own several tools, and an extension may own one tool named as itself', () => {
    const target = editor([
      { id: 'ext.a', tools: [tool('ext.a'), tool('ext.a.two')] },
      { id: 'ext.b', tools: [tool('ext.b.one')] },
    ]);
    for (const id of ['ext.a', 'ext.a.two', 'ext.b.one']) {
      ok(target, { type: 'setTool', tool: id });
      expect(target.query({ type: 'tool' })).toBe(id);
    }
  });

  it('keeps its own copy: later changes to the host’s tool object have no effect', () => {
    const calls: string[] = [];
    const host = {
      id: 'ext.c.t',
      input(this: { name: string }) {
        calls.push(this.name);
        return true;
      },
      reset: () => undefined,
      name: 'mine',
    };
    const tools = [host as unknown as ExtensionTool];
    const target = editor([{ id: 'ext.c', tools }]);
    host.input = () => {
      calls.push('replaced');
      return true;
    };
    tools.pop();
    ok(target, { type: 'setTool', tool: 'ext.c.t' });
    expect(press(target, 'q')).toEqual(consumed);
    // Methods stay bound to the host's object, as for custom node types.
    expect(calls).toEqual(['mine']);
  });
});

describe('M2-A12 extension binding conflicts throw editor.invalid-keymap at createEditor', () => {
  const command = (id: string) => ({ id, run: () => ({ ok: true, ids: [] }) as CommandResult });
  const own = (id: string, bindings: KeyBinding[], extra: Partial<Extension> = {}): Extension => ({
    id,
    commands: [command(`${id}.go`)],
    tools: [{ id: `${id}.tool`, input: () => true, reset: () => undefined }],
    bindings,
    ...extra,
  });

  it.each<[string, Extension[], RegExp]>([
    [
      'a malformed chord',
      [own('ext.a', [{ chord: 'Hyper+X', action: 'ext.a.go' }])],
      /editor\.invalid-keymap at \/extensions\/0\/bindings\/0\/chord/u,
    ],
    [
      'a binding that is not an object',
      [own('ext.a', [null as never])],
      /editor\.invalid-keymap at \/extensions\/0\/bindings\/0$/u,
    ],
    [
      'bindings that are not an array',
      [own('ext.a', 'x' as never)],
      /editor\.invalid-keymap at \/extensions\/0\/bindings$/u,
    ],
    [
      'args that are not JSON',
      [own('ext.a', [{ chord: 'X', action: 'ext.a.go', args: { n: Number.NaN } }])],
      /editor\.invalid-keymap at \/extensions\/0\/bindings\/0\/args/u,
    ],
    [
      'one canonical chord twice in a layer (Mod+S and Ctrl+KeyS)',
      [
        own('ext.a', [
          { chord: 'Mod+S', action: 'ext.a.go' },
          { chord: 'Ctrl+KeyS', action: 'undo' },
        ]),
      ],
      /editor\.invalid-keymap at \/extensions\/0\/bindings\/1\/chord/u,
    ],
    [
      'two extensions binding one canonical chord',
      [
        own('ext.a', [{ chord: 'Alt+Q', action: 'ext.a.go' }]),
        own('ext.b', [{ chord: 'Alt+KeyQ', action: 'undo' }]),
      ],
      /editor\.invalid-keymap: ext\.b and ext\.a both bind Alt\+KeyQ/u,
    ],
    [
      'two extensions unbinding one canonical chord',
      [
        own('ext.a', [{ chord: 'Mod+Y', action: null }]),
        own('ext.b', [{ chord: 'Ctrl+y', action: null }]),
      ],
      /editor\.invalid-keymap: ext\.b and ext\.a both bind Ctrl\+KeyY/u,
    ],
    [
      'a binding that names another extension’s command',
      [own('ext.a', []), own('ext.b', [{ chord: 'Q', action: 'ext.a.go' }])],
      /editor\.invalid-keymap at \/extensions\/1\/bindings\/0\/action/u,
    ],
    [
      'a binding that names a later extension’s command',
      [own('ext.a', [{ chord: 'Q', action: 'ext.b.go' }]), own('ext.b', [])],
      /editor\.invalid-keymap at \/extensions\/0\/bindings\/0\/action/u,
    ],
    [
      'a binding that names an unregistered command in its own namespace',
      [own('ext.a', [{ chord: 'Q', action: 'ext.a.none' }])],
      /editor\.invalid-keymap at \/extensions\/0\/bindings\/0\/action/u,
    ],
    [
      'a binding that names another extension’s tool',
      [
        own('ext.a', []),
        own('ext.b', [{ chord: 'Q', action: 'setTool', args: { tool: 'ext.a.tool' } }]),
      ],
      /editor\.invalid-keymap at \/extensions\/1\/bindings\/0\/args/u,
    ],
    [
      'an unknown action',
      [own('ext.a', [{ chord: 'Q', action: 'explode' }])],
      /editor\.invalid-keymap at \/extensions\/0\/bindings\/0\/action/u,
    ],
  ])('rejects %s', (_label, extensions, message) => {
    expect(() => editor(extensions)).toThrow(message);
  });

  it('allows built-in actions, its own commands and tools, and bindings in registration order', () => {
    const log: string[] = [];
    const target = editor(
      [
        own('ext.a', [
          { chord: 'Alt+Q', action: 'ext.a.go' },
          { chord: 'Alt+W', action: 'setTool', args: { tool: 'ext.a.tool' } },
          { chord: 'Alt+E', action: 'setTool', args: { tool: 'ellipse' } },
          // An extension layer rebinds a default chord.
          { chord: 'Mod+D', action: 'selectAll' },
        ]),
        own('ext.b', [{ chord: 'Alt+R', action: 'ext.b.go' }], {
          commands: [
            {
              id: 'ext.b.go',
              run: () => {
                log.push('ext.b.go');
                return { ok: true, ids: [] };
              },
            },
          ],
        }),
      ],
      // The host layer wins over the extension layer.
      { keymap: [{ chord: 'Alt+KeyE', action: 'setTool', args: { tool: 'line' } }] },
    );
    expect(press(target, 'w', mods('alt'))).toEqual(consumed);
    expect(target.query({ type: 'tool' })).toBe('ext.a.tool');
    ok(target, { type: 'setTool', tool: 'select' });
    expect(press(target, 'e', mods('alt'))).toEqual(consumed);
    expect(target.query({ type: 'tool' })).toBe('line');
    expect(press(target, 'r', mods('alt'))).toEqual(consumed);
    expect(log).toEqual(['ext.b.go']);
    const a = rect(target, 0, 0);
    expect(press(target, 'd', mods('ctrl'))).toEqual(consumed);
    expect(target.query({ type: 'selection' })).toEqual([a]);
    expect(children(target)).toEqual([a]);
  });
});

/**
 * `ext.p.tool`: a drag opens a gesture and creates one rectangle through `update`; its `reset`
 * tries every `ToolApi` call and records the results (a reset must issue no command).
 */
function probe() {
  const state = { resets: 0, attempts: [] as unknown[], api: null as ToolApi | null };
  let created = false;
  const tool: ExtensionTool = {
    id: 'ext.p.tool',
    input(event, api) {
      state.api = api;
      if (event.kind === 'pointerdown') return api.gesture.begin();
      if (event.kind === 'pointermove' && api.gesture.active && !created) {
        created = true;
        api.gesture.update({
          type: 'createRectangle',
          frame: { x: 0, y: 0, width: 5, height: 5 },
        });
        return true;
      }
      return false;
    },
    reset() {
      state.resets += 1;
      created = false;
      const api = state.api;
      if (api === null) return;
      const frame = { x: 50, y: 50, width: 5, height: 5 };
      state.attempts.push(
        api.gesture.begin(),
        api.gesture.update({ type: 'createRectangle', frame }),
        api.gesture.replace([]),
        api.execute({ type: 'createRectangle', frame }),
        api.gesture.active,
      );
      api.gesture.commit();
      api.gesture.cancel();
    },
  };
  return { extension: { id: 'ext.p', tools: [tool] } as Extension, state };
}

const inert = [
  false,
  { ok: false, code: 'editor.invalid-command' },
  { ok: false, code: 'editor.invalid-command' },
  { ok: false, code: 'editor.invalid-command' },
  false,
];

function dragOpen(target: Editor) {
  ok(target, { type: 'setTool', tool: 'ext.p.tool' });
  pointer(target, 'pointerdown', 0, 0);
  pointer(target, 'pointermove', 5, 5);
}

describe('M2-U7 review: the ToolApi is inert while reset runs', () => {
  it('on a tool switch: no gesture opens under select and nothing is created', () => {
    const { extension, state } = probe();
    const target = editor([extension]);
    const before = text(target);
    dragOpen(target);
    expect(children(target)).toHaveLength(1);
    ok(target, { type: 'setTool', tool: 'select' });
    expect(state.resets).toBe(1);
    expect(state.attempts).toEqual(inert);
    expect(text(target)).toBe(before);
    // No gesture is open under select: a command applies and stays.
    const a = rect(target, 100, 100);
    expect(children(target)).toEqual([a]);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
  });

  it('on a page switch: the open gesture is cancelled, the tool reset once, the new page empty', () => {
    const { extension, state } = probe();
    const target = editor([extension]);
    const [page] = ok(target, { type: 'addPage', name: 'Two' });
    const before = text(target);
    dragOpen(target);
    ok(target, { type: 'setActivePage', id: page! });
    expect(state.resets).toBe(1);
    expect(state.attempts).toEqual(inert);
    expect(text(target)).toBe(before);
    expect(target.query({ type: 'document' }).pages[1]!.children).toEqual([]);
    expect(target.query({ type: 'tool' })).toBe('ext.p.tool');
    expect(state.api!.gesture.active).toBe(false);
  });

  it('on a load: the open gesture is cancelled, the tool reset once, and nothing brings back the old document', () => {
    const { extension, state } = probe();
    const target = editor([extension]);
    const loaded = {
      schemaVersion: 2,
      id: 'doc',
      pages: [{ id: 'page', name: 'Loaded', children: [] }],
      nodes: {},
    };
    rect(target, 100, 100);
    dragOpen(target);
    ok(target, { type: 'loadDocument', document: loaded });
    expect(state.resets).toBe(1);
    expect(state.attempts).toEqual(inert);
    expect(state.api!.gesture.active).toBe(false);
    const after = text(target);
    // A later command applies to the loaded document, not to a stale pre-load gesture base.
    const a = rect(target, 0, 0);
    expect(target.query({ type: 'document' }).pages.map((p) => p.id)).toEqual(['page']);
    expect(children(target)).toEqual([a]);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(after);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 0, redoDepth: 1 });
  });
});

describe('M2-U7 review: a throw from input mid-drag', () => {
  it('cancels the gesture and resets the tool; Escape and V work again', async () => {
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);
    process.on('unhandledRejection', onError);
    try {
      let resets = 0;
      let created = false;
      const target = editor([
        {
          id: 'ext.k',
          tools: [
            {
              id: 'ext.k.tool',
              input(event, api) {
                if (event.kind === 'keydown' && event.key === 'k') throw new Error('k');
                if (event.kind === 'pointerdown') return api.gesture.begin();
                if (event.kind === 'pointermove' && !created) {
                  created = true;
                  api.gesture.update({
                    type: 'createRectangle',
                    frame: { x: 0, y: 0, width: 5, height: 5 },
                  });
                }
                // Every other key is swallowed while the drag is open.
                return api.gesture.active;
              },
              reset: () => {
                resets += 1;
              },
            },
          ],
        },
      ]);
      const a = rect(target, 100, 100);
      ok(target, { type: 'setSelection', ids: [a] });
      ok(target, { type: 'setTool', tool: 'ext.k.tool' });
      const before = text(target);
      pointer(target, 'pointerdown', 0, 0);
      pointer(target, 'pointermove', 5, 5);
      expect(children(target)).toHaveLength(2);
      expect(press(target, 'Escape')).toEqual(consumed);
      expect(press(target, 'k')).toEqual(unconsumed);
      expect(resets).toBe(1);
      expect(text(target)).toBe(before);
      expect(target.query({ type: 'selection' })).toEqual([a]);
      expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
      // The keyboard works again: Escape clears the selection, V selects the select tool.
      expect(press(target, 'Escape')).toEqual(consumed);
      expect(target.query({ type: 'selection' })).toEqual([]);
      expect(press(target, 'v')).toEqual(consumed);
      expect(target.query({ type: 'tool' })).toBe('select');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errors.map((error) => (error as Error).message)).toEqual(['k']);
    } finally {
      process.off('unhandledRejection', onError);
    }
  });
});

describe('M2-U7 review: re-entering input', () => {
  it('a tool that re-enters input through execute stops at the depth limit', () => {
    let calls = 0;
    const target = editor([
      {
        id: 'ext.r',
        tools: [
          {
            id: 'ext.r.tool',
            input(event, api) {
              calls += 1;
              const nested = api.execute({ type: 'input', event });
              return nested.ok && nested.consumed === true;
            },
            reset: () => undefined,
          },
        ],
      },
    ]);
    ok(target, { type: 'setTool', tool: 'ext.r.tool' });
    expect(press(target, 'q')).toEqual(unconsumed);
    expect(calls).toBe(16);
    // The editor keeps working.
    calls = 0;
    expect(press(target, 'v')).toEqual(consumed);
    expect(calls).toBe(16);
    expect(target.query({ type: 'tool' })).toBe('select');
  });
});
