import { serializeDocument } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYMAP,
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type EditorOptions,
  type Extension,
  type KeyBinding,
  type Modifiers,
  type ToolName,
} from '../../packages/editor-core/src/index.js';
import { canonicalChord } from '../../packages/editor-core/src/keymap.js';

// MVP M2-U1, M2-A11 for the actions of existing commands (M2 contract, section 7): canonical
// chords, key matching, the three layers, `setKeymap`, `editor.invalid-keymap`, tool-first
// consumption and no keymap during a gesture, all through `input`.

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const mods = (...names: (keyof Modifiers)[]): Modifiers => ({
  ...none,
  ...Object.fromEntries(names.map((name) => [name, true])),
});

function editor(options: EditorOptions = {}): Editor {
  return createEditor({ ids: createCounterIdSource('n'), ...options });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function events(target: Editor): EditorEvent[] {
  const seen: EditorEvent[] = [];
  target.subscribe((event) => seen.push(event));
  return seen;
}

type Key = { key: string; code?: string; composing?: boolean; repeat?: boolean };

function press(target: Editor, key: Key | string, modifiers: Modifiers = none): CommandResult {
  const event = typeof key === 'string' ? { key } : key;
  return target.execute({ type: 'input', event: { kind: 'keydown', ...event, modifiers } });
}

function rect(target: Editor, x = 0, y = 0): string {
  return ok(target, { type: 'createRectangle', frame: { x, y, width: 10, height: 10 } })[0]!;
}

function children(target: Editor): readonly string[] {
  return target.query({ type: 'document' }).pages[0]!.children;
}

describe('M2-A11 canonical chords', () => {
  it.each([
    ['Mod+Z', 'other', 'Ctrl+KeyZ'],
    ['Mod+Z', 'mac', 'Meta+KeyZ'],
    ['Mod+KeyZ', 'other', 'Ctrl+KeyZ'],
    ['z', 'other', 'KeyZ'],
    ['Shift+Alt+Meta+Ctrl+a', 'other', 'Ctrl+Meta+Alt+Shift+KeyA'],
    ['Alt+Mod+Shift+g', 'mac', 'Meta+Alt+Shift+KeyG'],
    ['1', 'other', 'Digit1'],
    ['Digit1', 'other', 'Digit1'],
    [' ', 'other', 'Space'],
    ['Ctrl+Space', 'other', 'Ctrl+Space'],
    ['ArrowLeft', 'other', 'ArrowLeft'],
    ['Mod+[', 'other', 'Ctrl+['],
    ['Mod+BracketRight', 'other', 'Ctrl+BracketRight'],
    ['Shift++', 'other', 'Shift++'],
    ['+', 'other', '+'],
    ['Mod+Ctrl+X', 'mac', 'Ctrl+Meta+KeyX'],
  ] as const)('%s on %s is %s', (chord, platform, canonical) => {
    expect(canonicalChord(chord, platform)).toBe(canonical);
  });

  it.each([
    '',
    'Hyper+X',
    'ctrl+X',
    'Ctrl+Ctrl+X',
    'Ctrl+',
    'Ctrl++X',
    'Mod+Ctrl+X',
    'Keyz',
    'KEYZ',
    'Mod+keyZ',
    'digit1',
    'DIGIT1',
    'space',
    'Shift+SPACE',
  ])('rejects %j on other', (chord) => {
    expect(canonicalChord(chord, 'other')).toBeNull();
  });
});

describe('M2-A11 default bindings run their actions through input', () => {
  it.each<[string, ToolName]>([
    ['r', 'rectangle'],
    ['o', 'ellipse'],
    ['l', 'line'],
    ['f', 'frame'],
    ['p', 'path'],
  ])('%s selects the %s tool, and V the select tool', (key, tool) => {
    const target = editor();
    expect(press(target, key)).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'tool' })).toBe(tool);
    // Caps lock gives the same token.
    expect(press(target, 'V')).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'tool' })).toBe('select');
    press(target, key);
    expect(press(target, 'v')).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'tool' })).toBe('select');
  });

  it.each(['Delete', 'Backspace'])(
    '%s deletes the selection; on none it is still consumed',
    (key) => {
      const target = editor();
      const a = rect(target);
      const b = rect(target, 20);
      expect(press(target, key)).toEqual({ ok: true, ids: [], consumed: true });
      expect(children(target)).toEqual([a, b]);
      ok(target, { type: 'setSelection', ids: [a] });
      expect(press(target, key)).toEqual({ ok: true, ids: [], consumed: true });
      expect(children(target)).toEqual([b]);
    },
  );

  it('Mod+Z undoes, Mod+Shift+Z and Mod+Y redo; an empty history fails but is consumed', () => {
    const target = editor();
    expect(press(target, 'z', mods('ctrl'))).toEqual({
      ok: false,
      code: 'editor.nothing-to-undo',
      consumed: true,
    });
    const a = rect(target);
    rect(target, 20);
    expect(press(target, 'z', mods('ctrl'))).toEqual({ ok: true, ids: [], consumed: true });
    expect(press(target, 'z', mods('ctrl'))).toEqual({ ok: true, ids: [], consumed: true });
    expect(children(target)).toEqual([]);
    expect(press(target, 'Z', mods('ctrl', 'shift'))).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    expect(children(target)).toEqual([a]);
    expect(press(target, 'y', mods('ctrl'))).toEqual({ ok: true, ids: [], consumed: true });
    expect(children(target)).toHaveLength(2);
    expect(press(target, 'y', mods('ctrl'))).toEqual({
      ok: false,
      code: 'editor.nothing-to-redo',
      consumed: true,
    });
  });

  it('Mod+A selects the page children; on an empty page it is consumed and does nothing', () => {
    const target = editor();
    expect(press(target, 'a', mods('ctrl'))).toEqual({ ok: true, ids: [], consumed: true });
    const a = rect(target);
    const b = rect(target, 20);
    expect(press(target, 'a', mods('ctrl'))).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'selection' })).toEqual([a, b]);
  });

  it('Mod+G groups, Mod+Shift+G ungroups, Mod+Alt+M mask-groups the selection', () => {
    const target = editor();
    expect(press(target, 'g', mods('ctrl'))).toEqual({ ok: true, ids: [], consumed: true });
    const a = rect(target);
    const b = rect(target, 20);
    ok(target, { type: 'setSelection', ids: [a, b] });
    const grouped = press(target, 'g', mods('ctrl'));
    expect(grouped).toEqual({ ok: true, ids: ['n5'], consumed: true });
    expect(target.query({ type: 'node', id: 'n5' })?.type).toBe('group');
    ok(target, { type: 'setSelection', ids: ['n5'] });
    expect(press(target, 'G', mods('ctrl', 'shift'))).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    expect(children(target)).toEqual([a, b]);
    // A path first child is the mask source; a rectangle is not.
    ok(target, { type: 'setSelection', ids: [a, b] });
    expect(press(target, 'm', mods('ctrl', 'alt'))).toEqual({
      ok: false,
      code: 'editor.invalid-mask-source',
      path: '/children/0',
      consumed: true,
    });
    const [path] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 10, 0, 10, 10],
    });
    ok(target, {
      type: 'moveNodes',
      ids: [path!],
      parent: target.query({ type: 'activePage' }),
      index: 0,
    });
    ok(target, { type: 'setSelection', ids: [path!, a] });
    const masked = press(target, 'm', mods('ctrl', 'alt'));
    if (!masked.ok) throw new Error(masked.code);
    expect(masked.consumed).toBe(true);
    expect(target.query({ type: 'node', id: masked.ids[0]! })?.type).toBe('maskGroup');
  });

  it('= and - zoom in and out; Shift+! fits, Shift+@ the selection, Shift+) 100%', () => {
    const target = editor();
    expect(press(target, '=')).toEqual({
      ok: false,
      code: 'editor.no-viewport-size',
      consumed: true,
    });
    ok(target, { type: 'setViewportSize', width: 800, height: 600 });
    expect(press(target, '=')).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'viewport' })).toEqual({ position: { x: 200, y: 150 }, zoom: 2 });
    press(target, '-');
    expect(target.query({ type: 'viewport' })).toEqual({ position: { x: 0, y: 0 }, zoom: 1 });
    const a = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 368, height: 100 },
    })[0]!;
    rect(target, 1000, 0);
    press(target, '!', mods('shift'));
    const fit = Math.min(736 / 1010, 536 / 100);
    expect(target.query({ type: 'viewport' })).toEqual({
      position: { x: 505 - 800 / (2 * fit), y: 50 - 600 / (2 * fit) },
      zoom: fit,
    });
    ok(target, { type: 'setSelection', ids: [a] });
    press(target, '@', mods('shift'));
    expect(target.query({ type: 'viewport' })).toEqual({
      position: { x: 184 - 400 / 2, y: 50 - 300 / 2 },
      zoom: 2,
    });
    press(target, ')', mods('shift'));
    // About the centre (184, 50): 184 − 200 · 2, 50 − 150 · 2.
    expect(target.query({ type: 'viewport' })).toEqual({ position: { x: -216, y: -250 }, zoom: 1 });
  });

  it('exports the defaults frozen; the effective keymap is canonical and sorted', () => {
    expect(Object.isFrozen(DEFAULT_KEYMAP)).toBe(true);
    const keymap = editor().query({ type: 'keymap' });
    expect(Object.isFrozen(keymap)).toBe(true);
    const chords = keymap.map((binding) => binding.chord);
    expect(chords).toEqual([...chords].sort());
    // M2-U4 adds duplicate, nudge and reorder, M2-U5 Enter and Escape (section 7).
    expect(chords).toEqual([
      '-',
      '=',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'Backspace',
      'Ctrl+Alt+KeyM',
      'Ctrl+KeyA',
      'Ctrl+KeyD',
      'Ctrl+KeyG',
      'Ctrl+KeyY',
      'Ctrl+KeyZ',
      'Ctrl+Shift+KeyG',
      'Ctrl+Shift+KeyZ',
      'Ctrl+Shift+{',
      'Ctrl+Shift+}',
      'Ctrl+[',
      'Ctrl+]',
      'Delete',
      'Enter',
      'Escape',
      'KeyF',
      'KeyL',
      'KeyO',
      'KeyP',
      'KeyR',
      'KeyV',
      'Shift+!',
      'Shift+)',
      'Shift+@',
      'Shift+ArrowDown',
      'Shift+ArrowLeft',
      'Shift+ArrowRight',
      'Shift+ArrowUp',
    ]);
    expect(keymap.find((binding) => binding.chord === 'KeyR')).toEqual({
      chord: 'KeyR',
      action: 'setTool',
      args: { tool: 'rectangle' },
    });
  });
});

describe('M2-A11 Mod and key matching', () => {
  it('Mod is Meta on mac: Meta+Z undoes, Ctrl+Z is unbound', () => {
    const target = editor({ platform: 'mac' });
    rect(target);
    expect(press(target, 'z', mods('ctrl'))).toEqual({ ok: true, ids: [], consumed: false });
    expect(children(target)).toHaveLength(1);
    expect(press(target, 'z', mods('meta'))).toEqual({ ok: true, ids: [], consumed: true });
    expect(children(target)).toEqual([]);
    expect(target.query({ type: 'keymap' }).some((b) => b.chord === 'Meta+KeyZ')).toBe(true);
  });

  it('rejects an unknown platform', () => {
    expect(() => editor({ platform: 'win' as never })).toThrow(/platform/u);
  });

  it('the modifier set must equal the chord: Ctrl+Alt+Z and Shift+R do not match', () => {
    const target = editor();
    rect(target);
    expect(press(target, 'z', mods('ctrl', 'alt')).consumed).toBe(false);
    expect(press(target, 'R', mods('shift')).consumed).toBe(false);
    expect(target.query({ type: 'tool' })).toBe('select');
    expect(children(target)).toHaveLength(1);
  });

  it('matches by key: a remapped layout key wins over its code', () => {
    const target = editor();
    rect(target);
    // Dvorak: the key labelled Z sits at the QWERTY ';' position.
    expect(press(target, { key: ';', code: 'KeyZ' }, mods('ctrl')).consumed).toBe(false);
    expect(children(target)).toHaveLength(1);
    expect(press(target, { key: 'z', code: 'Semicolon' }, mods('ctrl')).consumed).toBe(true);
    expect(children(target)).toEqual([]);
  });

  it.each<[string, Key]>([
    ['Process', { key: 'Process', code: 'KeyZ' }],
    ['Unidentified', { key: 'Unidentified', code: 'KeyZ' }],
    ['a non-ASCII character (Korean layout)', { key: 'ㅋ', code: 'KeyZ' }],
    ['a composing key', { key: 'z', code: 'KeyZ', composing: true }],
  ])('takes the code token for %s', (_label, key) => {
    const target = editor();
    rect(target);
    expect(press(target, key, mods('ctrl'))).toEqual({ ok: true, ids: [], consumed: true });
    expect(children(target)).toEqual([]);
  });

  it('a composing key uses its code even when key differs; without a code it is unbound', () => {
    const target = editor();
    rect(target);
    expect(press(target, { key: 'z', code: 'KeyQ', composing: true }, mods('ctrl')).consumed).toBe(
      false,
    );
    expect(press(target, { key: 'Process' }, mods('ctrl')).consumed).toBe(false);
    expect(children(target)).toHaveLength(1);
    // A non-ASCII letter on Mac Option+M (µ) reaches Mod+Alt+M by its code.
    const mac = editor({ platform: 'mac' });
    const a = rect(mac);
    ok(mac, { type: 'setSelection', ids: [a] });
    expect(press(mac, { key: 'µ', code: 'KeyM' }, mods('meta', 'alt'))).toEqual({
      ok: false,
      code: 'editor.invalid-mask-source',
      path: '/children/0',
      consumed: true,
    });
  });

  it('a non-matching code name stays as written (BracketRight is not ])', () => {
    const target = editor({ keymap: [{ chord: 'Mod+]', action: 'selectAll' }] });
    rect(target);
    expect(press(target, { key: 'Process', code: 'BracketRight' }, mods('ctrl')).consumed).toBe(
      false,
    );
    expect(press(target, { key: ']', code: 'BracketRight' }, mods('ctrl')).consumed).toBe(true);
    expect(target.query({ type: 'selection' })).toHaveLength(1);
  });

  it('an unbound key is not consumed; auto-repeat runs the action each time', () => {
    const target = editor();
    expect(press(target, 'q')).toEqual({ ok: true, ids: [], consumed: false });
    rect(target);
    rect(target, 20);
    press(target, { key: 'z', repeat: true }, mods('ctrl'));
    press(target, { key: 'z', repeat: true }, mods('ctrl'));
    expect(children(target)).toEqual([]);
  });

  it('a key-up never reaches the keymap', () => {
    const target = editor();
    rect(target);
    expect(
      target.execute({
        type: 'input',
        event: { kind: 'keyup', key: 'z', modifiers: mods('ctrl') },
      }),
    ).toEqual({ ok: true, ids: [], consumed: false });
    expect(children(target)).toHaveLength(1);
  });
});

describe('M2-A11 tool first, and no keymap during a gesture', () => {
  it('Enter with pending path anchors is consumed by the path tool, not the keymap', () => {
    const target = editor({
      keymap: [{ chord: 'Enter', action: 'setTool', args: { tool: 'select' } }],
    });
    ok(target, { type: 'setTool', tool: 'path' });
    for (const [x, y] of [
      [0, 0],
      [10, 0],
    ]) {
      ok(target, {
        type: 'input',
        event: { kind: 'pointerdown', point: { x: x!, y: y! }, modifiers: none },
      });
      ok(target, {
        type: 'input',
        event: { kind: 'pointerup', point: { x: x!, y: y! }, modifiers: none },
      });
    }
    expect(press(target, 'Enter')).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'tool' })).toBe('path');
    expect(children(target)).toHaveLength(1);
    // No anchors pending: Enter reaches the keymap.
    expect(press(target, 'Enter')).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'tool' })).toBe('select');
  });

  it('Escape during a drag is the tool’s; a bound key during a drag runs nothing', () => {
    const target = editor({ keymap: [{ chord: 'Escape', action: 'selectAll' }] });
    const a = rect(target, 100, 100);
    ok(target, { type: 'setTool', tool: 'rectangle' });
    ok(target, {
      type: 'input',
      event: { kind: 'pointerdown', point: { x: 0, y: 0 }, modifiers: none },
    });
    ok(target, {
      type: 'input',
      event: { kind: 'pointermove', point: { x: 5, y: 5 }, modifiers: none },
    });
    const history = target.query({ type: 'history' });
    expect(press(target, 'z', mods('ctrl'))).toEqual({ ok: true, ids: [], consumed: false });
    expect(press(target, 'o')).toEqual({ ok: true, ids: [], consumed: false });
    expect(target.query({ type: 'tool' })).toBe('rectangle');
    expect(target.query({ type: 'history' })).toEqual(history);
    expect(children(target)).toHaveLength(2);
    expect(press(target, 'Escape')).toEqual({ ok: true, ids: [], consumed: true });
    expect(children(target)).toEqual([a]);
    expect(target.query({ type: 'selection' })).toEqual([]);
    // Without a drag, Escape reaches the host binding.
    expect(press(target, 'Escape')).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'selection' })).toEqual([a]);
  });
});

describe('M2-A11 layers and setKeymap', () => {
  it('Mod+Z and Mod+KeyZ are one chord: the host layer replaces the default', () => {
    const target = editor({ keymap: [{ chord: 'Mod+KeyZ', action: 'selectAll' }] });
    const a = rect(target);
    press(target, 'z', mods('ctrl'));
    expect(children(target)).toEqual([a]);
    expect(target.query({ type: 'selection' })).toEqual([a]);
    expect(target.query({ type: 'keymap' }).filter((b) => b.chord === 'Ctrl+KeyZ')).toEqual([
      { chord: 'Ctrl+KeyZ', action: 'selectAll' },
    ]);
  });

  it('action null unbinds a default chord', () => {
    const target = editor({ keymap: [{ chord: 'Delete', action: null }] });
    const a = rect(target);
    ok(target, { type: 'setSelection', ids: [a] });
    expect(press(target, 'Delete')).toEqual({ ok: true, ids: [], consumed: false });
    expect(children(target)).toEqual([a]);
    expect(target.query({ type: 'keymap' }).some((b) => b.chord === 'Delete')).toBe(false);
  });

  it('setKeymap replaces the host layer at run time, with one keymap event', () => {
    const target = editor({ keymap: [{ chord: 'Delete', action: null }] });
    const seen = events(target);
    ok(target, { type: 'setKeymap', bindings: [{ chord: 'Shift+KeyD', action: 'delete' }] });
    expect(seen).toEqual([{ type: 'session', field: 'keymap' }]);
    expect(target.getSnapshot().keymap).toBe(target.query({ type: 'keymap' }));
    const a = rect(target);
    ok(target, { type: 'setSelection', ids: [a] });
    expect(press(target, 'D', mods('shift')).consumed).toBe(true);
    expect(children(target)).toEqual([]);
    // The default Delete binding is back.
    expect(target.query({ type: 'keymap' }).some((b) => b.chord === 'Delete')).toBe(true);
    // An unchanged effective keymap raises no event.
    seen.length = 0;
    ok(target, { type: 'setKeymap', bindings: [{ chord: 'Shift+d', action: 'delete' }] });
    expect(seen).toEqual([]);
    ok(target, { type: 'setKeymap', bindings: [] });
    expect(seen).toEqual([{ type: 'session', field: 'keymap' }]);
  });

  it.each<[string, unknown, string]>([
    ['a malformed chord', [{ chord: 'Hyper+X', action: 'undo' }], '/bindings/0/chord'],
    ['an empty chord', [{ chord: '', action: 'undo' }], '/bindings/0/chord'],
    ['a chord that is not a string', [{ chord: 1, action: 'undo' }], '/bindings/0/chord'],
    ['a repeated modifier', [{ chord: 'Ctrl+Ctrl+X', action: 'undo' }], '/bindings/0/chord'],
    ['Mod with Ctrl on other', [{ chord: 'Mod+Ctrl+X', action: 'undo' }], '/bindings/0/chord'],
    [
      'a duplicate canonical chord in one layer',
      [
        { chord: 'Mod+Z', action: 'undo' },
        { chord: 'Ctrl+KeyZ', action: 'redo' },
      ],
      '/bindings/1/chord',
    ],
    ['an unknown action', [{ chord: 'X', action: 'explode' }], '/bindings/0/action'],
    [
      'a command type that is not an action',
      [{ chord: 'X', action: 'nudgeNodes' }],
      '/bindings/0/action',
    ],
    ['an unregistered command', [{ chord: 'X', action: 'ext.none' }], '/bindings/0/action'],
    ['a non-string action', [{ chord: 'X', action: 3 }], '/bindings/0/action'],
    ['a missing action', [{ chord: 'X' }], '/bindings/0/action'],
    ['setTool without a tool', [{ chord: 'X', action: 'setTool' }], '/bindings/0/args'],
    [
      'setTool with an unknown tool',
      [{ chord: 'X', action: 'setTool', args: { tool: 'lasso' } }],
      '/bindings/0/args',
    ],
    [
      'args that are not JSON',
      [{ chord: 'X', action: 'undo', args: { at: Number.NaN } }],
      '/bindings/0/args',
    ],
    ['a binding that is not an object', [null], '/bindings/0'],
    ['a miscased KeyX token', [{ chord: 'Mod+Keyz', action: 'undo' }], '/bindings/0/chord'],
    ['a miscased DigitN token', [{ chord: 'digit1', action: 'undo' }], '/bindings/0/chord'],
    ['a miscased Space token', [{ chord: 'space', action: 'undo' }], '/bindings/0/chord'],
    [
      'a Space chord (navigation owns it)',
      [{ chord: 'Space', action: 'delete' }],
      '/bindings/0/chord',
    ],
    ['a literal space chord', [{ chord: ' ', action: 'delete' }], '/bindings/0/chord'],
    [
      'a Space chord with modifiers',
      [
        { chord: 'X', action: 'undo' },
        { chord: 'Shift+Space', action: 'delete' },
      ],
      '/bindings/1/chord',
    ],
  ])(
    'setKeymap rejects %s as editor.invalid-keymap, changing nothing',
    (_label, bindings, path) => {
      const target = editor();
      const before = target.query({ type: 'keymap' });
      const seen = events(target);
      expect(target.execute({ type: 'setKeymap', bindings: bindings as KeyBinding[] })).toEqual({
        ok: false,
        code: 'editor.invalid-keymap',
        path,
      });
      expect(target.query({ type: 'keymap' })).toBe(before);
      expect(seen).toEqual([]);
    },
  );

  it('setKeymap without a bindings array is editor.invalid-command first', () => {
    const target = editor();
    expect(target.execute({ type: 'setKeymap', bindings: 'x' as never })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/bindings',
    });
  });

  it('an invalid host layer at createEditor throws', () => {
    expect(() => editor({ keymap: [{ chord: 'Ctrl+', action: 'undo' }] })).toThrow(
      /editor\.invalid-keymap at \/keymap\/0\/chord/u,
    );
    expect(() => editor({ keymap: 'x' as never })).toThrow(/editor\.invalid-keymap/u);
  });

  const counter = (id: string, log: string[]): Extension => ({
    id,
    commands: [
      {
        id: `${id}.count`,
        run: (args) => {
          log.push(`${id}:${JSON.stringify(args ?? null)}`);
          return { ok: true, ids: [] };
        },
      },
    ],
    bindings: [
      { chord: 'Alt+KeyC', action: `${id}.count`, args: { by: 1 } },
      { chord: 'Mod+Y', action: null },
    ],
  });

  it('extension layers sit between the defaults and the host and run their commands', () => {
    const log: string[] = [];
    const target = editor({
      extensions: [counter('ext.a', log)],
      keymap: [{ chord: 'Ctrl+Y', action: 'ext.a.count' }],
    });
    expect(press(target, 'c', mods('alt'))).toEqual({ ok: true, ids: [], consumed: true });
    // The extension unbound Mod+Y; the host bound it again to the extension's command.
    expect(press(target, 'y', mods('ctrl'))).toEqual({ ok: true, ids: [], consumed: true });
    expect(log).toEqual(['ext.a:{"by":1}', 'ext.a:null']);
    // A failing extension command is the binding's result, still consumed.
    const failing = editor({
      extensions: [
        {
          id: 'ext.f',
          commands: [{ id: 'ext.f', run: () => ({ ok: false, code: 'editor.no-viewport-size' }) }],
          bindings: [{ chord: 'K', action: 'ext.f' }],
        },
      ],
    });
    expect(press(failing, 'k')).toEqual({
      ok: false,
      code: 'editor.no-viewport-size',
      consumed: true,
    });
  });

  it('extension binding failures throw at createEditor', () => {
    const log: string[] = [];
    expect(() => editor({ extensions: [counter('ext.a', log), counter('ext.b', log)] })).toThrow(
      /editor\.invalid-keymap: ext\.b and ext\.a both bind Alt\+KeyC/u,
    );
    expect(() =>
      editor({
        extensions: [
          counter('ext.a', log),
          { id: 'ext.b', bindings: [{ chord: 'Q', action: 'ext.a.count' }] },
        ],
      }),
    ).toThrow(/editor\.invalid-keymap at \/extensions\/1\/bindings\/0\/action/u);
    expect(() =>
      editor({ extensions: [{ id: 'ext.c', bindings: [{ chord: 'Ctrl+', action: 'undo' }] }] }),
    ).toThrow(/editor\.invalid-keymap at \/extensions\/0\/bindings\/0\/chord/u);
    // Built-in actions are allowed in an extension layer.
    expect(() =>
      editor({ extensions: [{ id: 'ext.d', bindings: [{ chord: 'Q', action: 'undo' }] }] }),
    ).not.toThrow();
  });

  it('rejects a Space chord in the host layer and in an extension layer at createEditor', () => {
    expect(() => editor({ keymap: [{ chord: 'Space', action: 'delete' }] })).toThrow(
      /editor\.invalid-keymap at \/keymap\/0\/chord/u,
    );
    expect(() =>
      editor({ extensions: [{ id: 'ext.s', bindings: [{ chord: 'Mod+Space', action: 'undo' }] }] }),
    ).toThrow(/editor\.invalid-keymap at \/extensions\/0\/bindings\/0\/chord/u);
  });

  it('pins the platform dependence of layer validity: Mod+Ctrl+X is valid on mac only', () => {
    const mac = editor({ platform: 'mac' });
    ok(mac, { type: 'setKeymap', bindings: [{ chord: 'Mod+Ctrl+X', action: 'undo' }] });
    expect(mac.query({ type: 'keymap' }).some((b) => b.chord === 'Ctrl+Meta+KeyX')).toBe(true);
    const other = editor();
    expect(
      other.execute({ type: 'setKeymap', bindings: [{ chord: 'Mod+Ctrl+X', action: 'undo' }] }),
    ).toEqual({ ok: false, code: 'editor.invalid-keymap', path: '/bindings/0/chord' });
  });
});

describe('M2-A11 group and ungroup actions leave the toolbar selection', () => {
  it('Mod+G selects the new group; Mod+Shift+G selects the released children and round-trips', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 20, 5);
    const c = rect(target, 50, 50);
    const before = serializeDocument(target.query({ type: 'document' }));
    ok(target, { type: 'setSelection', ids: [a, b] });
    const grouped = press(target, 'g', mods('ctrl'));
    if (!grouped.ok) throw new Error(grouped.code);
    expect(grouped.consumed).toBe(true);
    expect(target.query({ type: 'selection' })).toEqual(grouped.ids);
    expect(children(target)).toEqual([grouped.ids[0], c]);
    expect(press(target, 'G', mods('ctrl', 'shift'))).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    expect(target.query({ type: 'selection' })).toEqual([a, b]);
    expect(serializeDocument(target.query({ type: 'document' }))).toBe(before);
    expect(target.query({ type: 'history' }).undoDepth).toBe(5);
  });

  it('ungroup with a selection that is not one group does nothing, still consumed', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 20);
    const before = serializeDocument(target.query({ type: 'document' }));
    for (const ids of [[a], [a, b]]) {
      ok(target, { type: 'setSelection', ids });
      expect(press(target, 'G', mods('ctrl', 'shift'))).toEqual({
        ok: true,
        ids: [],
        consumed: true,
      });
      expect(target.query({ type: 'selection' })).toEqual(ids);
    }
    expect(serializeDocument(target.query({ type: 'document' }))).toBe(before);
  });
});

describe('M2-A11 rest (M2-U7): every default binding through input, and host-bound actions', () => {
  // Rectangles a (0, 0), b (20, 0) and c (50, 50), 10 by 10, with b selected and a viewport of
  // 800 by 600; each scenario presses its chord once and checks the action's effect.
  type Scene = { target: Editor; a: string; b: string; c: string };
  function scene(): Scene {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 20);
    const c = rect(target, 50, 50);
    ok(target, { type: 'setSelection', ids: [b] });
    ok(target, { type: 'setViewportSize', width: 800, height: 600 });
    return { target, a, b, c };
  }
  const frameOf = (target: Editor, id: string) => target.query({ type: 'node', id })?.frame;
  const zoom = (target: Editor) => target.query({ type: 'viewport' }).zoom;
  const grouped = (s: Scene) => {
    const [group] = ok(s.target, { type: 'groupNodes', ids: [s.a, s.b], kind: 'group' });
    ok(s.target, { type: 'setSelection', ids: [group!] });
    return group!;
  };
  const fiveNodes = (s: Scene) => {
    rect(s.target, 70, 70);
    rect(s.target, 90, 90);
    ok(s.target, { type: 'setSelection', ids: [s.c] });
  };
  const tool = (name: ToolName) => (s: Scene) => {
    expect(s.target.query({ type: 'tool' })).toBe(name);
  };
  const nudged = (dx: number, dy: number) => (s: Scene) => {
    expect(frameOf(s.target, s.b)).toEqual({ x: 20 + dx, y: dy, width: 10, height: 10 });
  };
  const order = (names: ('a' | 'b' | 'c')[]) => (s: Scene) => {
    expect(children(s.target)).toEqual(names.map((name) => s[name]));
  };

  type Case = {
    chord: string;
    key: string;
    modifiers?: Modifiers;
    before?: (s: Scene) => void;
    result?: (s: Scene) => CommandResult;
    check: (s: Scene) => void;
  };
  const cases: Case[] = [
    {
      chord: 'V',
      key: 'v',
      before: (s) => ok(s.target, { type: 'setTool', tool: 'line' }),
      check: tool('select'),
    },
    { chord: 'R', key: 'r', check: tool('rectangle') },
    { chord: 'O', key: 'o', check: tool('ellipse') },
    { chord: 'L', key: 'l', check: tool('line') },
    { chord: 'F', key: 'f', check: tool('frame') },
    { chord: 'P', key: 'p', check: tool('path') },
    { chord: 'Delete', key: 'Delete', check: order(['a', 'c']) },
    { chord: 'Backspace', key: 'Backspace', check: order(['a', 'c']) },
    { chord: 'Mod+Z', key: 'z', modifiers: mods('ctrl'), check: order(['a', 'b']) },
    {
      chord: 'Mod+Shift+Z',
      key: 'Z',
      modifiers: mods('ctrl', 'shift'),
      before: (s) => ok(s.target, { type: 'undo' }),
      check: order(['a', 'b', 'c']),
    },
    {
      chord: 'Mod+Y',
      key: 'y',
      modifiers: mods('ctrl'),
      before: (s) => ok(s.target, { type: 'undo' }),
      check: order(['a', 'b', 'c']),
    },
    {
      chord: 'Mod+A',
      key: 'a',
      modifiers: mods('ctrl'),
      check: (s) => expect(s.target.query({ type: 'selection' })).toEqual([s.a, s.b, s.c]),
    },
    {
      chord: 'Mod+G',
      key: 'g',
      modifiers: mods('ctrl'),
      result: () => ({ ok: true, ids: ['n6'], consumed: true }),
      check: (s) => {
        expect(children(s.target)).toEqual([s.a, 'n6', s.c]);
        expect(s.target.query({ type: 'selection' })).toEqual(['n6']);
      },
    },
    {
      chord: 'Mod+Shift+G',
      key: 'G',
      modifiers: mods('ctrl', 'shift'),
      before: grouped,
      check: (s) => {
        expect(children(s.target)).toEqual([s.a, s.b, s.c]);
        expect(s.target.query({ type: 'selection' })).toEqual([s.a, s.b]);
      },
    },
    {
      chord: 'Mod+Alt+M',
      key: 'm',
      modifiers: mods('ctrl', 'alt'),
      // The action ran: a rectangle cannot be the mask source.
      result: () => ({
        ok: false,
        code: 'editor.invalid-mask-source',
        path: '/children/0',
        consumed: true,
      }),
      check: order(['a', 'b', 'c']),
    },
    {
      chord: 'Mod+D',
      key: 'd',
      modifiers: mods('ctrl'),
      result: () => ({ ok: true, ids: ['n6'], consumed: true }),
      check: (s) => {
        expect(children(s.target)).toEqual([s.a, s.b, 'n6', s.c]);
        expect(frameOf(s.target, 'n6')).toEqual(frameOf(s.target, s.b));
        expect(s.target.query({ type: 'selection' })).toEqual(['n6']);
      },
    },
    { chord: 'ArrowLeft', key: 'ArrowLeft', check: nudged(-1, 0) },
    { chord: 'ArrowRight', key: 'ArrowRight', check: nudged(1, 0) },
    { chord: 'ArrowUp', key: 'ArrowUp', check: nudged(0, -1) },
    { chord: 'ArrowDown', key: 'ArrowDown', check: nudged(0, 1) },
    { chord: 'Shift+ArrowLeft', key: 'ArrowLeft', modifiers: mods('shift'), check: nudged(-10, 0) },
    {
      chord: 'Shift+ArrowRight',
      key: 'ArrowRight',
      modifiers: mods('shift'),
      check: nudged(10, 0),
    },
    { chord: 'Shift+ArrowUp', key: 'ArrowUp', modifiers: mods('shift'), check: nudged(0, -10) },
    { chord: 'Shift+ArrowDown', key: 'ArrowDown', modifiers: mods('shift'), check: nudged(0, 10) },
    // Five nodes [a, b, c, d, e] with c selected, so the four ops give four different orders.
    {
      chord: 'Mod+]',
      key: ']',
      modifiers: mods('ctrl'),
      before: fiveNodes,
      check: (s) => expect(children(s.target)).toEqual([s.a, s.b, 'n6', s.c, 'n7']),
    },
    {
      chord: 'Mod+[',
      key: '[',
      modifiers: mods('ctrl'),
      before: fiveNodes,
      check: (s) => expect(children(s.target)).toEqual([s.a, s.c, s.b, 'n6', 'n7']),
    },
    {
      chord: 'Mod+Shift+}',
      key: '}',
      modifiers: mods('ctrl', 'shift'),
      before: fiveNodes,
      check: (s) => expect(children(s.target)).toEqual([s.a, s.b, 'n6', 'n7', s.c]),
    },
    {
      chord: 'Mod+Shift+{',
      key: '{',
      modifiers: mods('ctrl', 'shift'),
      before: fiveNodes,
      check: (s) => expect(children(s.target)).toEqual([s.c, s.a, s.b, 'n6', 'n7']),
    },
    { chord: '=', key: '=', check: (s) => expect(zoom(s.target)).toBe(2) },
    { chord: '-', key: '-', check: (s) => expect(zoom(s.target)).toBe(0.5) },
    {
      chord: 'Shift+!',
      key: '!',
      modifiers: mods('shift'),
      // Bounds 60 by 60: min((800 − 64) / 60, (600 − 64) / 60).
      check: (s) => expect(zoom(s.target)).toBe(536 / 60),
    },
    {
      chord: 'Shift+@',
      key: '@',
      modifiers: mods('shift'),
      check: (s) => expect(zoom(s.target)).toBe(536 / 10),
    },
    {
      chord: 'Shift+)',
      key: ')',
      modifiers: mods('shift'),
      before: (s) => ok(s.target, { type: 'zoomBy', factor: 4 }),
      check: (s) => expect(zoom(s.target)).toBe(1),
    },
    {
      chord: 'Enter',
      key: 'Enter',
      before: grouped,
      check: (s) => {
        expect(s.target.query({ type: 'scope' })).toBe('n6');
        expect(s.target.query({ type: 'selection' })).toEqual([s.a, s.b]);
      },
    },
    {
      chord: 'Escape',
      key: 'Escape',
      check: (s) => expect(s.target.query({ type: 'selection' })).toEqual([]),
    },
  ];

  it('the cases cover exactly the default bindings', () => {
    expect(cases.map((entry) => entry.chord)).toEqual(DEFAULT_KEYMAP.map((entry) => entry.chord));
  });

  it.each(cases)('$chord runs its action', (entry) => {
    const s = scene();
    entry.before?.(s);
    expect(press(s.target, entry.key, entry.modifiers ?? none)).toEqual(
      entry.result?.(s) ?? { ok: true, ids: [], consumed: true },
    );
    entry.check(s);
  });

  it('host-bound align, distribute, copy, cut and paste run through input', () => {
    const target = editor({
      keymap: [
        { chord: 'Alt+1', action: 'align', args: { edge: 'top' } },
        { chord: 'Alt+2', action: 'distribute', args: { axis: 'horizontal' } },
        { chord: 'Mod+C', action: 'copy' },
        { chord: 'Mod+X', action: 'cut' },
        { chord: 'Mod+V', action: 'paste' },
      ],
    });
    const a = rect(target);
    const b = rect(target, 20, 30);
    const c = rect(target, 100, 50);
    ok(target, { type: 'setSelection', ids: [a, b, c] });
    expect(press(target, '1', mods('alt'))).toEqual({ ok: true, ids: [], consumed: true });
    expect([a, b, c].map((id) => target.query({ type: 'node', id })?.frame.y)).toEqual([0, 0, 0]);
    // Span 0 to 110, sizes 30: gap 40, so b moves to x 50.
    expect(press(target, '2', mods('alt'))).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'node', id: b })?.frame.x).toBe(50);
    ok(target, { type: 'setSelection', ids: [b] });
    expect(press(target, 'c', mods('ctrl'))).toEqual({ ok: true, ids: [b], consumed: true });
    expect(press(target, 'x', mods('ctrl'))).toEqual({ ok: true, ids: [b], consumed: true });
    expect(children(target)).toEqual([a, c]);
    expect(press(target, 'v', mods('ctrl'))).toEqual({ ok: true, ids: ['n6'], consumed: true });
    expect(children(target)).toEqual([a, c, 'n6']);
    expect(target.query({ type: 'node', id: 'n6' })?.frame).toEqual({
      x: 50,
      y: 0,
      width: 10,
      height: 10,
    });
  });
});
