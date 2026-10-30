import { describe, expect, it } from 'vitest';
import type { Command } from '../../packages/editor-core/src/index.js';
import { textHost, type TextHost } from '../support/m6b-text-host.js';

// MVP M6b-U8, M6b-A11, React half (docs/plans/mvp-m6b-text-editing-contract.md, sections 9.2 and
// 9.3; M6b-A08's clipboard events on the textarea): the DOM `paste` carries `pointer`, the last
// hover point over the canvas mapped with the editor's camera at paste time and cleared on
// `pointerleave`; the edit-mode `copy` and `cut` results reach `clipboardCopy`, which prevents
// the DOM event and writes the selected plain text as `text/plain`, or leaves the event to the
// browser for a collapsed caret; a bound clipboard chord in edit mode is not consumed, so its DOM
// event does the write; a paste during a composition force-ends it (M6b-H5). Over the fake DOM of
// tests/support/m6b-text-host.ts: the canvas content box starts at client (11, 21).

const keys = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };

type Written = [string, string][];

/** Fires a DOM clipboard event on `on`; returns whether it was prevented and what was written. */
function clipboardEvent(
  host: TextHost,
  on: 'canvas' | 'textarea',
  type: 'copy' | 'cut' | 'paste',
  data = '',
): { prevented: boolean; written: Written } {
  let prevented = false;
  const written: Written = [];
  host[on].fire(type, {
    clipboardData: {
      getData: (format: string) => (format === 'text/plain' ? data : ''),
      setData: (format: string, value: string) => written.push([format, value]),
    },
    preventDefault: () => {
      prevented = true;
    },
  });
  return { prevented, written };
}

const hover = (host: TextHost, clientX: number, clientY: number) =>
  host.input.pointerMove({ ...keys, clientX, clientY, currentTarget: host.canvas });

const pastes = (commands: readonly Command[]) =>
  commands.filter((command) => command.type === 'paste');

function editing(anchor: number, focus = anchor) {
  const host = textHost();
  host.editor.execute({ type: 'enterTextEdit', id: 't', anchor, focus });
  host.commands.length = 0;
  host.log.length = 0;
  return host;
}

describe('M6b-A11 the paste pointer (section 9.3)', () => {
  it('a DOM paste carries the last hover point in page space', () => {
    const host = textHost();
    hover(host, 111, 221);
    const { prevented } = clipboardEvent(host, 'canvas', 'paste', 'hello');
    expect(prevented).toBe(true);
    expect(pastes(host.commands)).toEqual([
      { type: 'paste', text: 'hello', pointer: { x: 100, y: 200 } },
    ]);
    // The new node's page box is centred on it.
    const node = host.editor.query({ type: 'node', id: host.editor.getSnapshot().selection[0]! })!;
    expect(node.type).toBe('text');
    expect(node.frame.x + node.frame.width / 2).toBeCloseTo(100, 9);
    expect(node.frame.y + node.frame.height / 2).toBeCloseTo(200, 9);
    expect(host.editor.getSnapshot().textEdit).toBeNull();
  });

  it('the hover point is mapped with the camera at paste time', () => {
    const host = textHost();
    hover(host, 111, 221);
    host.editor.execute({ type: 'setViewport', camera: { position: { x: 50, y: -10 }, zoom: 2 } });
    clipboardEvent(host, 'canvas', 'paste', 'x');
    expect(pastes(host.commands)).toEqual([
      { type: 'paste', text: 'x', pointer: { x: 100, y: 90 } },
    ]);
  });

  it('a move during a drag records it too; pointerleave clears it; a later move sets it again', () => {
    const host = textHost();
    host.press(61, 61, 'pointerdown');
    hover(host, 71, 81);
    host.press(71, 81, 'pointerup');
    clipboardEvent(host, 'canvas', 'paste', '');
    host.input.pointerLeave();
    clipboardEvent(host, 'canvas', 'paste', '');
    hover(host, 21, 31);
    clipboardEvent(host, 'canvas', 'paste', '');
    expect(pastes(host.commands)).toEqual([
      { type: 'paste', text: '', pointer: { x: 60, y: 60 } },
      { type: 'paste', text: '' },
      { type: 'paste', text: '', pointer: { x: 10, y: 10 } },
    ]);
  });

  it('without a hover point the paste has no pointer and centres on the viewport', () => {
    const host = textHost();
    clipboardEvent(host, 'canvas', 'paste', 'ab');
    expect(pastes(host.commands)).toEqual([{ type: 'paste', text: 'ab' }]);
    const node = host.editor.query({ type: 'node', id: host.editor.getSnapshot().selection[0]! })!;
    expect(node.frame.x + node.frame.width / 2).toBeCloseTo(300, 9);
    expect(node.frame.y + node.frame.height / 2).toBeCloseTo(200, 9);
  });

  it('in edit mode the pasted text goes in at the caret; pointer is not used', () => {
    const host = editing(1, 4);
    hover(host, 500, 300);
    const { prevented } = clipboardEvent(host, 'textarea', 'paste', 'Z\r\n');
    expect(prevented).toBe(true);
    expect(host.textOf('t')).toBe('aZ\nd');
    expect(host.editor.getSnapshot().textEdit).toMatchObject({ anchor: 3, focus: 3 });
    expect(host.focused()).toBe('textarea');
  });
});

describe('M6b-A11 the edit-mode clipboardCopy result (section 9.2)', () => {
  it('copy of a selection is prevented and writes the selected plain text', () => {
    for (const on of ['textarea', 'canvas'] as const) {
      const host = editing(1, 4);
      const copy = clipboardEvent(host, on, 'copy');
      expect(copy).toEqual({ prevented: true, written: [['text/plain', 'b c']] });
      expect(host.editor.query({ type: 'clipboard' })).toBe('b c');
      expect(host.textOf('t')).toBe('ab cd');
    }
  });

  it('cut is prevented, writes the text and deletes it as one step', () => {
    const host = editing(0, 3);
    expect(clipboardEvent(host, 'textarea', 'cut')).toEqual({
      prevented: true,
      written: [['text/plain', 'ab ']],
    });
    expect(host.textOf('t')).toBe('cd');
    expect(host.editor.getSnapshot().history.undoDepth).toBe(1);
  });

  it('with a collapsed caret copy and cut are left to the browser and write nothing', () => {
    const host = editing(2);
    for (const type of ['copy', 'cut'] as const) {
      expect(clipboardEvent(host, 'textarea', type)).toEqual({ prevented: false, written: [] });
    }
    expect(host.editor.query({ type: 'clipboard' })).toBeNull();
    expect(host.textOf('t')).toBe('ab cd');
  });

  it('a bound copy chord in edit mode is not consumed and does not write; its DOM copy does', () => {
    const writes: string[] = [];
    const host = textHost(undefined, {
      writeText: (text: string) => {
        writes.push(text);
        return Promise.resolve();
      },
    });
    host.editor.execute({ type: 'setKeymap', bindings: [{ chord: 'Ctrl+C', action: 'copy' }] });
    // Outside edit mode the bound chord copies the node and writes the system clipboard (M2).
    host.editor.execute({ type: 'setSelection', ids: ['r'] });
    expect(host.key('keydown', { key: 'c', code: 'KeyC', ctrlKey: true })).toBe(true);
    expect(writes).toHaveLength(1);
    host.editor.execute({ type: 'enterTextEdit', id: 't', anchor: 3, focus: 5 });
    // Rule 6: the chord is left alone, so the browser raises the DOM copy event.
    expect(host.key('keydown', { key: 'c', code: 'KeyC', ctrlKey: true })).toBe(false);
    expect(writes).toHaveLength(1);
    expect(host.editor.query({ type: 'clipboard' })).not.toBe('cd');
    expect(clipboardEvent(host, 'textarea', 'copy')).toEqual({
      prevented: true,
      written: [['text/plain', 'cd']],
    });
    expect(host.editor.query({ type: 'clipboard' })).toBe('cd');
    // The DOM event carries the text; `navigator.clipboard` is for the bound keydown only.
    expect(writes).toHaveLength(1);
  });
});

describe('M6b-A11 a paste during a composition (section 7.3, M6b-H5)', () => {
  it('commits the composition, pastes after it, and drops the late compositionend', () => {
    const host = editing(5);
    host.composition('compositionstart');
    host.composition('compositionupdate', '한');
    host.log.length = 0;
    clipboardEvent(host, 'textarea', 'paste', 'P');
    expect(host.textOf('t')).toBe('ab cd한P');
    // M6b-H5: the host blurs the textarea and focuses it again; no exit.
    expect(host.log).toContain('blur:textarea');
    expect(host.focused()).toBe('textarea');
    expect(host.editor.getSnapshot().textEdit).toMatchObject({ anchor: 7, composition: null });
    host.composition('compositionend', '한');
    expect(host.textOf('t')).toBe('ab cd한P');
    expect(host.editor.getSnapshot().history.undoDepth).toBe(2);
  });
});
