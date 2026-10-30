import { MAX_TEXT_LENGTH, type DocumentV6 } from '@vector-studio/model';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type InputEvent,
} from '../../packages/editor-core/src/index.js';
import { EditorCanvas, EditorProvider } from '../../packages/react/src/index.js';
import {
  MIN_INPUT_FONT_PX,
  createMessageScheduler,
  textInputPlacement,
} from '../../packages/react/src/text-input.js';
import { textHost, textHostDocument } from '../support/m6b-text-host.js';

// MVP M6b-U7, M6b-A08 and the host half of M6b-A10 (docs/plans/mvp-m6b-text-editing-contract.md,
// section 6): the hidden textarea's element and placement (M6b-H1), the focus target and the
// blur rules (M6b-H2), the `beforeinput` and composition mapping (M6b-H3), the reset (M6b-H4)
// and the forced end (M6b-H5), through the host exactly as `EditorCanvas` wires it, over the
// fake DOM of tests/support/m6b-text-host.ts. Node `t` "ab cd" is at page (10, 20), size 10:
// on the fake port a to z advance 5, a space 2.5, Hangul 10, and a line is 12 high. The fake
// canvas is at client (10, 20) with a 1 px border, so page (x, y) is client (x + 11, y + 21) at
// zoom 1 with the camera at the origin.

const inputs = (commands: readonly Command[]): InputEvent[] =>
  commands.flatMap((command) => (command.type === 'input' ? [command.event] : []));

/** A host in edit mode on `t` with the caret at `anchor`..`focus`, its logs cleared. */
function editing(anchor = 5, focus = anchor, document?: DocumentV6) {
  const host = textHost(document);
  expect(host.editor.execute({ type: 'enterTextEdit', id: 't', anchor, focus })).toEqual({
    ok: true,
    ids: [],
  });
  host.log.length = 0;
  host.commands.length = 0;
  return host;
}

/** A host composing `data` on `t` at the end. */
function composing(data = '한') {
  const host = editing();
  host.composition('compositionstart');
  host.composition('compositionupdate', data);
  expect(host.editor.getSnapshot().textEdit?.composition).toEqual({
    start: 5,
    end: 5 + data.length,
  });
  host.log.length = 0;
  host.commands.length = 0;
  return host;
}

describe('M6b-H1 the textarea element', () => {
  it('renders beside the canvas with the M6b-H1 attributes and fixed styles', () => {
    const editor = createEditor({ ids: createCounterIdSource('n') });
    const html = renderToString(
      createElement(
        EditorProvider,
        { editor },
        createElement(EditorCanvas, { width: 200, height: 100 }),
      ),
    );
    const textarea = /<textarea[^>]*>/u.exec(html)?.[0] ?? '';
    expect(html.indexOf('<canvas')).toBeLessThan(html.indexOf('<textarea'));
    for (const attribute of [
      'tabindex="-1"',
      'spellcheck="false"',
      'autocomplete="off"',
      'autocorrect="off"',
      'autocapitalize="off"',
      'writingsuggestions="false"',
    ]) {
      // React's server markup keeps the camel-case names; HTML attribute names are
      // case-insensitive, so the names are compared in lower case; the label's value is not.
      expect(textarea.toLowerCase()).toContain(attribute);
    }
    expect(textarea).toContain('aria-label="Text input"');
    for (const style of [
      'position:absolute',
      'width:1px',
      `font-size:${MIN_INPUT_FONT_PX}px`,
      'opacity:0',
      'resize:none',
      'overflow:hidden',
      'pointer-events:none',
    ]) {
      expect(textarea).toContain(style);
    }
  });

  it('is focused only while textEdit is set; on exit focus returns to the canvas', () => {
    const host = textHost();
    expect(host.focused()).toBe('canvas');
    host.editor.execute({ type: 'enterTextEdit', id: 't' });
    expect(host.focused()).toBe('textarea');
    expect(host.textarea.focusCalls).toEqual([{ preventScroll: true }]);
    // Moving between the two is not a blur: no reset, no exit.
    expect(host.commands.map((command) => command.type)).toEqual(['enterTextEdit']);
    host.editor.execute({ type: 'exitTextEdit' });
    expect(host.focused()).toBe('canvas');
    expect(host.commands.map((command) => command.type)).toEqual(['enterTextEdit', 'exitTextEdit']);
  });

  it('on exit, focus stays where it is when the textarea no longer has it', () => {
    const host = editing();
    host.doc.active = host.panel;
    host.editor.execute({ type: 'exitTextEdit' });
    expect(host.focused()).toBe('panel');
  });

  it('focuses on attach during edit mode, and leaves focus alone when attached outside it', () => {
    const host = textHost();
    expect(host.textarea.focusCalls).toEqual([]);
    host.detach();
    host.editor.execute({ type: 'enterTextEdit', id: 't' });
    expect(host.focused()).toBe('canvas');
    host.host.attach(() => undefined);
    expect(host.focused()).toBe('textarea');
  });

  it('sits at inputRect with font-size inputRect.height × zoom, with the event-time viewport', () => {
    const host = editing();
    expect(host.editor.query({ type: 'textEditOverlay' })?.inputRect).toEqual({
      x: 32.5,
      y: 20,
      height: 12,
    });
    // The canvas content box starts at (1, 1) in the wrapper (its border).
    expect(host.textarea.style).toEqual({
      left: '33.5px',
      top: '21px',
      fontSize: '12px',
      height: '12px',
    });
    host.editor.execute({ type: 'setViewport', camera: { position: { x: 10, y: 10 }, zoom: 2 } });
    expect(host.textarea.style).toEqual({
      left: '46px',
      top: '21px',
      fontSize: '24px',
      height: '24px',
    });
    // The caret moves with typing (a document change and a textEdit event).
    host.key('keydown', { key: 'Home', code: 'Home' });
    expect(host.textarea.style.left).toBe('1px');
    host.beforeInput('insertText', 'x');
    expect(host.textarea.style.left).toBe('11px');
  });

  it('is clamped to the canvas box', () => {
    const host = editing();
    host.editor.execute({
      type: 'setViewport',
      camera: { position: { x: 1000, y: 1000 }, zoom: 1 },
    });
    expect(host.textarea.style).toMatchObject({ left: '1px', top: '1px' });
    host.editor.execute({
      type: 'setViewport',
      camera: { position: { x: -1000, y: -1000 }, zoom: 1 },
    });
    // The box is 600 × 400 from (1, 1): the right edge less the 1 px width, the bottom less the
    // font size.
    expect(host.textarea.style).toMatchObject({ left: '600px', top: '389px', fontSize: '12px' });
  });

  it('keeps the font-size floor under rotation (inputRect height 0 at 90°)', () => {
    const host = textHost();
    host.editor.execute({ type: 'enterTextEdit', id: 'rot', anchor: 0, focus: 0 });
    const rect = host.editor.query({ type: 'textEditOverlay' })!.inputRect;
    expect(rect.height).toBeCloseTo(0, 9);
    expect(host.textarea.style.fontSize).toBe(`${MIN_INPUT_FONT_PX}px`);
    expect(host.textarea.style.height).toBe(`${MIN_INPUT_FONT_PX}px`);
    expect(Number.parseFloat(host.textarea.style.left)).toBeCloseTo(1 + rect.x, 9);
    expect(Number.parseFloat(host.textarea.style.top)).toBeCloseTo(1 + rect.y, 9);
  });

  it('textInputPlacement: literal values, the floor and the rest place outside edit mode', () => {
    const box = { left: 2, top: 3, width: 100, height: 50 };
    const viewport = { position: { x: 5, y: 5 }, zoom: 4 };
    const overlay = (x: number, y: number, height: number) => ({
      id: 't',
      caret: null,
      selection: [],
      composition: [],
      inputRect: { x, y, height },
    });
    expect(textInputPlacement(overlay(10, 7, 2), viewport, box)).toEqual({
      left: 22,
      top: 11,
      fontSize: 8,
    });
    expect(textInputPlacement(overlay(10, 7, 0.1), viewport, box).fontSize).toBe(MIN_INPUT_FONT_PX);
    expect(textInputPlacement(overlay(100, 100, 2), viewport, box)).toEqual({
      left: 101,
      top: 45,
      fontSize: 8,
    });
    expect(textInputPlacement(null, viewport, box)).toEqual({
      left: 2,
      top: 3,
      fontSize: MIN_INPUT_FONT_PX,
    });
  });

  it('createMessageScheduler runs posted tasks in order on a MessageChannel message', async () => {
    const scheduler = createMessageScheduler();
    const ran: number[] = [];
    scheduler.post(() => ran.push(1));
    scheduler.post(() => ran.push(2));
    expect(ran).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toEqual([1, 2]);
    scheduler.close();
  });
});

describe('M6b-A08 key routing, React half (M6b-H2, section 5)', () => {
  it('attaches blur, clipboard, beforeinput and composition listeners to the textarea', () => {
    const host = textHost();
    expect(host.textarea.types().sort()).toEqual(
      [
        'beforeinput',
        'blur',
        'compositionend',
        'compositionstart',
        'compositionupdate',
        'copy',
        'cut',
        'paste',
      ].sort(),
    );
    host.detach();
    expect(host.textarea.types()).toEqual([]);
    expect(host.canvas.types()).toEqual([]);
  });

  it('sets ime from keyCode 229 only', () => {
    const host = editing();
    host.key('keydown', { key: 'Process', code: 'KeyG', keyCode: 229 });
    host.key('keydown', { key: 'a', code: 'KeyA', keyCode: 65 });
    expect(inputs(host.commands)).toEqual([
      {
        kind: 'keydown',
        key: 'Process',
        code: 'KeyG',
        repeat: false,
        composing: false,
        ime: true,
        modifiers: { shift: false, alt: false, meta: false, ctrl: false },
      },
      {
        kind: 'keydown',
        key: 'a',
        code: 'KeyA',
        repeat: false,
        composing: false,
        modifiers: { shift: false, alt: false, meta: false, ctrl: false },
      },
    ]);
  });

  it('prevents a keydown exactly when consumed; passThrough keys are left alone', () => {
    const host = editing();
    const cases: [string, Parameters<typeof host.key>[1], boolean][] = [
      ['rule 1 Process', { key: 'Process', code: 'KeyR', keyCode: 229 }, false],
      ['rule 1 keyCode 229 Enter', { key: 'Enter', code: 'Enter', keyCode: 229 }, false],
      ['rule 2 letter', { key: 'r', code: 'KeyR' }, false],
      ['rule 2 Space', { key: ' ', code: 'Space' }, false],
      ['rule 3 Backspace', { key: 'Backspace', code: 'Backspace' }, true],
      ['rule 4 ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft' }, true],
      ['rule 5 Tab', { key: 'Tab', code: 'Tab' }, true],
      ['rule 6 bound Mod+D', { key: 'd', code: 'KeyD', ctrlKey: true }, true],
      ['rule 6 unbound F5', { key: 'F5', code: 'F5' }, false],
      ['rule 6 Mod+C', { key: 'c', code: 'KeyC', ctrlKey: true }, false],
    ];
    for (const [label, init, prevented] of cases) {
      expect([label, host.key('keydown', init)]).toEqual([label, prevented]);
    }
    // Nothing reached the tool or the keymap: the tool, the node and the selection are as they
    // were, and Backspace deleted one character.
    expect(host.editor.getSnapshot().tool).toBe('select');
    expect(host.textOf('t')).toBe('ab c');
    expect(host.editor.getSnapshot().selection).toEqual(['t']);
  });

  it('a passed-through key runs no host clipboard write', () => {
    let writes = 0;
    const host = textHost(undefined, {
      writeText: () => {
        writes += 1;
        return Promise.resolve();
      },
    });
    host.editor.execute({ type: 'enterTextEdit', id: 't' });
    host.editor.execute({
      type: 'setKeymap',
      bindings: [{ chord: 'Ctrl+Alt+Q', action: 'copy' }],
    });
    // Ctrl+Alt is AltGr on `other`: a character key passes through by rule 2.
    expect(host.key('keydown', { key: '@', code: 'KeyQ', ctrlKey: true, altKey: true })).toBe(
      false,
    );
    expect(writes).toBe(0);
  });

  it('keyup on the textarea reaches the editor and is not prevented', () => {
    const host = editing();
    expect(host.key('keyup', { key: 'a', code: 'KeyA' })).toBe(false);
    expect(inputs(host.commands)).toEqual([
      {
        kind: 'keyup',
        key: 'a',
        code: 'KeyA',
        modifiers: { shift: false, alt: false, meta: false, ctrl: false },
      },
    ]);
  });

  it('copy, cut and paste on the textarea reach the editor and act on the text', () => {
    // "ab cd" with "b c" selected (M6b section 9.2; m6b-u8-clipboard-host.test.ts has the rest).
    const host = editing(1, 4);
    const written: [string, string][] = [];
    const clipboard = {
      getData: () => 'z',
      setData: (format: string, data: string) => written.push([format, data]),
    };
    const prevented: string[] = [];
    const fire = (type: string) =>
      host.textarea.fire(type, {
        clipboardData: clipboard,
        preventDefault: () => prevented.push(type),
      });
    fire('copy');
    expect(prevented).toEqual(['copy']);
    expect(written).toEqual([['text/plain', 'b c']]);
    expect(host.textOf('t')).toBe('ab cd');
    fire('cut');
    expect(prevented).toEqual(['copy', 'cut']);
    expect(written).toEqual([
      ['text/plain', 'b c'],
      ['text/plain', 'b c'],
    ]);
    expect(host.textOf('t')).toBe('ad');
    // A collapsed caret now: copy and cut are left to the browser.
    fire('copy');
    fire('cut');
    expect(prevented).toEqual(['copy', 'cut']);
    fire('paste');
    expect(prevented).toEqual(['copy', 'cut', 'paste']);
    expect(host.textOf('t')).toBe('azd');
    expect(host.commands).toEqual([
      { type: 'copy' },
      { type: 'cut' },
      { type: 'copy' },
      { type: 'cut' },
      { type: 'paste', text: 'z' },
    ]);
    expect(host.focused()).toBe('textarea');
  });

  it('a press inside the edited box is prevented and keeps focus on the textarea', () => {
    const host = editing();
    expect(host.press(26, 46, 'pointerdown')).toBe(true);
    host.press(26, 46, 'pointerup');
    expect(host.focused()).toBe('textarea');
    expect(host.log).not.toContain('focus:canvas');
    // Page x 15 is node x 5: offset 1.
    expect(host.editor.getSnapshot().textEdit).toMatchObject({ anchor: 1, focus: 1 });
  });

  it('a canvas mousedown is prevented while text edit mode is set, and only then', () => {
    const host = textHost();
    const mousedown = () => {
      let prevented = false;
      host.input.mouseDown({
        preventDefault: () => {
          prevented = true;
        },
      });
      return prevented;
    };
    expect(mousedown()).toBe(false);
    host.editor.execute({ type: 'enterTextEdit', id: 't' });
    expect(mousedown()).toBe(true);
    host.editor.execute({ type: 'exitTextEdit' });
    expect(mousedown()).toBe(false);
  });

  it('a press outside exits, is not prevented, and focus moves to the canvas', () => {
    const host = editing();
    expect(host.press(261, 171, 'pointerdown')).toBe(false);
    expect(host.editor.getSnapshot().textEdit).toBeNull();
    expect(host.focused()).toBe('canvas');
  });

  it('a text tool press that enters edit mode is prevented and focuses the textarea', () => {
    const host = textHost();
    host.editor.execute({ type: 'setTool', tool: 'text' });
    // On `t` (page (15, 25)): the press enters edit mode on it.
    expect(host.press(26, 46, 'pointerdown')).toBe(true);
    expect(host.editor.getSnapshot().textEdit?.id).toBe('t');
    expect(host.focused()).toBe('textarea');
  });
});

describe('M6b-H2 blur rules', () => {
  it('an element blur resets input, then exits edit mode', () => {
    const host = editing();
    host.key('keydown', { key: 'a', code: 'KeyA' });
    host.commands.length = 0;
    host.textarea.browserBlur(null);
    expect(host.commands).toEqual([
      { type: 'input', event: { kind: 'pointercancel', modifiers: expect.anything() as object } },
      {
        type: 'input',
        event: { kind: 'keyup', key: ' ', code: 'Space', modifiers: expect.anything() as object },
      },
      { type: 'exitTextEdit' },
    ]);
    expect(host.editor.getSnapshot().textEdit).toBeNull();
    // Focus left for the body: the exit does not pull it back to the canvas.
    expect(host.focused()).toBe('null');
  });

  it('a blur to the canvas is not a blur of the target', () => {
    const host = editing();
    host.key('keydown', { key: 'a', code: 'KeyA' });
    host.commands.length = 0;
    host.canvas.focus();
    expect(host.commands).toEqual([]);
    expect(host.editor.getSnapshot().textEdit).not.toBeNull();
  });

  it('a window blur (document not focused) resets but keeps edit mode', () => {
    const host = editing();
    host.key('keydown', { key: 'a', code: 'KeyA' });
    host.commands.length = 0;
    host.doc.hasFocus = false;
    host.textarea.browserBlur(null);
    host.view.fire('blur', {});
    expect(host.commands.map((command) => command.type)).toEqual(['input', 'input']);
    expect(host.editor.getSnapshot().textEdit).not.toBeNull();
  });

  it('an element blur to a panel during a composition: endComposition, exit, focus on the panel', () => {
    const host = composing();
    host.textarea.browserBlur(host.panel);
    expect(host.commands.map((command) => command.type)).toEqual([
      'endComposition',
      'exitTextEdit',
    ]);
    expect(host.textOf('t')).toBe('ab cd한');
    expect(host.editor.getSnapshot().textEdit).toBeNull();
    // The host-caused end runs no M6b-H5 blur, empty or refocus.
    expect(host.focused()).toBe('panel');
    expect(
      host.log.filter((entry) => entry.startsWith('focus:') || entry.startsWith('blur:')),
    ).toEqual([]);
    // The browser's late end is dropped: the text goes in once.
    host.composition('compositionend', '한');
    expect(host.commands).toHaveLength(2);
    expect(host.textOf('t')).toBe('ab cd한');
  });

  it('a window blur during a composition: endComposition, edit mode stays, the late end dropped', () => {
    const host = composing();
    host.doc.hasFocus = false;
    host.textarea.browserBlur(null);
    host.view.fire('blur', {});
    host.composition('compositionend', '한');
    expect(host.commands.map((command) => command.type)).toEqual(['endComposition']);
    expect(host.textOf('t')).toBe('ab cd한');
    expect(host.editor.getSnapshot().textEdit).toMatchObject({ anchor: 6, composition: null });
  });

  it('a blur while the textarea holds focus outside edit mode only resets', () => {
    const host = textHost();
    host.key('keydown', { key: 'a', code: 'KeyA' });
    host.commands.length = 0;
    host.canvas.browserBlur(null);
    expect(host.commands.map((command) => command.type)).toEqual(['input', 'input']);
  });
});

describe('M6b-H3 beforeinput and composition mapping', () => {
  it('insertText sends textinput and is prevented', () => {
    const host = editing();
    expect(host.beforeInput('insertText', 'x')).toBe(true);
    expect(host.beforeInput('insertText', null)).toBe(true);
    expect(inputs(host.commands)).toEqual([
      { kind: 'textinput', text: 'x' },
      { kind: 'textinput', text: '' },
    ]);
    expect(host.textOf('t')).toBe('ab cdx');
  });

  it('insertCompositionText and deleteCompositionText send nothing and are not prevented', () => {
    const host = editing();
    expect(host.beforeInput('insertCompositionText', 'ㅎ', false)).toBe(false);
    expect(host.beforeInput('deleteCompositionText', null, false)).toBe(false);
    expect(host.commands).toEqual([]);
  });

  it.each([
    'insertLineBreak',
    'insertParagraph',
    'deleteContentBackward',
    'deleteContentForward',
    'deleteWordBackward',
    'historyUndo',
    'historyRedo',
    'insertFromPaste',
    'insertFromDrop',
    'insertReplacementText',
    'formatBold',
  ])('every other cancelable inputType is prevented and sends nothing: %s', (inputType) => {
    const host = editing();
    expect(host.beforeInput(inputType, null, true)).toBe(true);
    expect(host.beforeInput(inputType, null, false)).toBe(false);
    expect(host.commands).toEqual([]);
    expect(host.textOf('t')).toBe('ab cd');
  });

  it('insertLineBreak right after a passed-through Enter keydown is the Enter edit action, once', () => {
    const host = editing();
    expect(host.key('keydown', { key: 'Process', code: 'Enter', keyCode: 229 })).toBe(false);
    expect(host.beforeInput('insertLineBreak')).toBe(true);
    expect(host.textOf('t')).toBe('ab cd\n');
    expect(host.beforeInput('insertLineBreak')).toBe(true);
    expect(host.textOf('t')).toBe('ab cd\n');
    // insertParagraph and Shift are mapped alike.
    host.key('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, shiftKey: true });
    host.beforeInput('insertParagraph');
    expect(host.textOf('t')).toBe('ab cd\n\n');
    expect(inputs(host.commands).at(-1)).toEqual({
      kind: 'keydown',
      key: 'Enter',
      code: 'Enter',
      repeat: false,
      composing: false,
      modifiers: { shift: true, alt: false, meta: false, ctrl: false },
    });
  });

  it('insertLineBreak after a rule-3 Enter, after another keydown, or with none is not mapped', () => {
    const host = editing();
    host.key('keydown', { key: 'Process', code: 'Enter', keyCode: 229 });
    expect(host.key('keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })).toBe(true);
    host.beforeInput('insertLineBreak');
    expect(host.textOf('t')).toBe('ab cd\n');
    host.key('keydown', { key: 'Process', code: 'Enter', keyCode: 229 });
    host.key('keydown', { key: 'Process', code: 'KeyA', keyCode: 229 });
    host.beforeInput('insertLineBreak');
    host.beforeInput('insertParagraph');
    expect(host.textOf('t')).toBe('ab cd\n');
  });

  it('composition events send the input kinds with their data', () => {
    const host = editing();
    host.composition('compositionstart');
    host.composition('compositionupdate', 'ㅎ');
    host.composition('compositionupdate', '한');
    host.composition('compositionend', '한');
    expect(inputs(host.commands)).toEqual([
      { kind: 'compositionstart' },
      { kind: 'compositionupdate', data: 'ㅎ' },
      { kind: 'compositionupdate', data: '한' },
      { kind: 'compositionend', data: '한' },
    ]);
    expect(host.textOf('t')).toBe('ab cd한');
    expect(host.focused()).toBe('textarea');
  });
});

describe('M6b-H4 the textarea holds only the active composition', () => {
  it('empties after a compositionend when the posted message runs', () => {
    const host = composing();
    host.textarea.value = '한';
    host.textarea.selection = [1, 1];
    host.composition('compositionend', '한');
    expect(host.textarea.value).toBe('한');
    host.flush();
    expect(host.textarea.value).toBe('');
    expect(host.textarea.selection).toEqual([0, 0]);
  });

  it('a compositionstart before the message keeps the textarea', () => {
    const host = composing('각');
    host.textarea.value = '가';
    host.composition('compositionend', '가');
    host.composition('compositionstart');
    host.textarea.value = '가가';
    host.composition('compositionupdate', '가');
    host.flush();
    expect(host.textarea.value).toBe('가가');
    host.composition('compositionend', '가');
    host.flush();
    expect(host.textarea.value).toBe('');
    expect(host.textOf('t')).toBe('ab cd가가');
  });
});

describe('M6b-H5 forced end', () => {
  it('an editor-caused end: flag, blur, empty, refocus, in this order; the sync end is dropped', () => {
    const host = composing();
    host.textarea.value = '한';
    host.textarea.duringBlur = [['compositionend', '한']];
    host.editor.execute({ type: 'setNodeProps', id: 'r', props: { opacity: 0.5 } });
    expect(host.log).toEqual([
      'command:setNodeProps',
      'blur:textarea',
      'compositionend:during-blur',
      'focus:textarea',
    ]);
    expect(host.textarea.value).toBe('');
    // Neither the dropped end nor the host's own blur reached the editor (no reset, no exit).
    expect(host.commands).toEqual([{ type: 'setNodeProps', id: 'r', props: { opacity: 0.5 } }]);
    expect(host.textOf('t')).toBe('ab cd한');
    expect(host.editor.getSnapshot().textEdit).toMatchObject({ anchor: 6, composition: null });
    expect(host.focused()).toBe('textarea');
  });

  it('drops late updates and the late end; the flag clears at the next compositionstart', () => {
    const host = composing();
    host.editor.execute({ type: 'setNodeProps', id: 'r', props: { opacity: 0.5 } });
    host.commands.length = 0;
    host.composition('compositionupdate', '한');
    host.composition('compositionend', '한');
    expect(host.commands).toEqual([]);
    host.composition('compositionstart');
    host.composition('compositionupdate', 'ㄱ');
    host.composition('compositionend', 'ㄱ');
    expect(inputs(host.commands).map((event) => event.kind)).toEqual([
      'compositionstart',
      'compositionupdate',
      'compositionend',
    ]);
    expect(host.textOf('t')).toBe('ab cd한ㄱ');
  });

  it('a compositionstart clears a flag whose end never came', () => {
    const host = composing();
    host.editor.execute({ type: 'setNodeProps', id: 'r', props: { opacity: 0.5 } });
    host.commands.length = 0;
    host.composition('compositionstart');
    host.composition('compositionupdate', 'ㄴ');
    expect(host.editor.getSnapshot().textEdit?.composition).toEqual({ start: 6, end: 7 });
  });

  it('a forced end that leaves edit mode focuses the canvas', () => {
    const host = composing();
    host.editor.execute({ type: 'setTool', tool: 'rectangle' });
    expect(host.editor.getSnapshot().textEdit).toBeNull();
    expect(host.focused()).toBe('canvas');
    expect(host.textOf('t')).toBe('ab cd한');
  });

  it('a press during a composition: the forced end, then the caret at the point (section 7.2)', () => {
    const host = composing();
    host.textarea.duringBlur = [['compositionend', '한']];
    expect(host.press(26, 46, 'pointerdown')).toBe(true);
    expect(host.textOf('t')).toBe('ab cd한');
    expect(host.editor.getSnapshot().textEdit).toMatchObject({ anchor: 1, composition: null });
    expect(host.focused()).toBe('textarea');
    expect(inputs(host.commands).map((event) => event.kind)).toEqual(['pointerdown']);
  });

  it('a refused compositionstart (another gesture active) runs the forced end', () => {
    const host = editing();
    expect(internalsOf(host.editor).gesture.begin()).toBe(true);
    host.composition('compositionstart');
    expect(host.log).toEqual(['input:compositionstart', 'blur:textarea', 'focus:textarea']);
    // The rest of that composition is dropped.
    host.composition('compositionupdate', 'ㄱ');
    host.composition('compositionend', 'ㄱ');
    expect(inputs(host.commands)).toEqual([{ kind: 'compositionstart' }]);
    internalsOf(host.editor).gesture.cancel();
  });

  it('an update or end without a text gesture fails and runs the forced end', () => {
    const host = editing();
    host.composition('compositionupdate', 'ㄱ');
    expect(host.log).toEqual(['input:compositionupdate', 'blur:textarea', 'focus:textarea']);
    host.log.length = 0;
    host.composition('compositionstart');
    host.composition('compositionend', '');
    host.composition('compositionend', 'x');
    expect(host.log.slice(-3)).toEqual(['input:compositionend', 'blur:textarea', 'focus:textarea']);
    expect(host.textOf('t')).toBe('ab cd');
  });

  it('an update over the bound commits the last accepted state and runs the forced end once', () => {
    const document = textHostDocument();
    const node = document.nodes.t as unknown as { runs: { text: string }[] };
    node.runs[0]!.text = 'a'.repeat(MAX_TEXT_LENGTH - 1);
    const host = textHost(document);
    host.editor.execute({ type: 'enterTextEdit', id: 't', anchor: 0, focus: 0 });
    host.composition('compositionstart');
    host.composition('compositionupdate', 'ㄱ');
    host.log.length = 0;
    host.composition('compositionupdate', '가가');
    expect(host.log).toEqual(['input:compositionupdate', 'blur:textarea', 'focus:textarea']);
    expect(host.textOf('t')).toBe(`ㄱ${'a'.repeat(MAX_TEXT_LENGTH - 1)}`);
    host.composition('compositionend', '가가');
    expect(host.log).toHaveLength(3);
  });
});
