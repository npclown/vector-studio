import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createCounterIdSource, createEditor } from '../../packages/editor-core/src/index.js';
import { EditorCanvas, EditorProvider } from '../../packages/react/src/index.js';
import { TextField } from '../../packages/ui/src/fields.js';
import { textHost } from '../support/m6b-text-host.js';

// MVP M8 contract, M8-R4 with M6b-H2 (M8-U7 finding): the property panel's text run fields edit
// the text edit selection, so focus moving to one from the canvas must keep edit mode. The canvas,
// its textarea and the run fields carry `data-text-edit-focus`; a canvas blur to such an element
// ends the composition and resets input as before, but does not exit edit mode. Leaving a run
// field for anything outside that set exits it (the field's blur, covered by the headed and smoke
// `tests/m8-next-host` spec, which needs a DOM).

/** A host in edit mode on `t` with `anchor`..`focus` selected, its logs cleared. */
function editing(anchor = 1, focus = 3) {
  const host = textHost();
  expect(host.editor.execute({ type: 'enterTextEdit', id: 't', anchor, focus })).toEqual({
    ok: true,
    ids: [],
  });
  host.log.length = 0;
  host.commands.length = 0;
  return host;
}

describe('M8-R4 a canvas blur to a text run field keeps text edit mode', () => {
  it('keeps edit mode and the selection, sends no command and leaves focus on the field', () => {
    const host = editing();
    const before = host.editor.getSnapshot().textEdit;
    host.textarea.browserBlur(host.runField);
    expect(host.commands).toEqual([]);
    expect(host.editor.getSnapshot().textEdit).toBe(before);
    expect(host.focused()).toBe('run-field');
  });

  it('ends a composition as any element blur does, then keeps edit mode', () => {
    const host = editing(5, 5);
    host.composition('compositionstart');
    host.composition('compositionupdate', '한');
    host.commands.length = 0;
    host.textarea.browserBlur(host.runField);
    expect(host.commands.map((command) => command.type)).toEqual(['endComposition']);
    expect(host.editor.getSnapshot().textEdit?.composition).toBeNull();
    expect(host.focused()).toBe('run-field');
  });

  it('a blur to any other panel control still exits edit mode', () => {
    const host = editing();
    host.textarea.browserBlur(host.panel);
    expect(host.commands.map((command) => command.type)).toEqual(['exitTextEdit']);
    expect(host.editor.getSnapshot().textEdit).toBeNull();
  });
});

describe('M8-R4 the text edit focus target markup', () => {
  it('marks the canvas and its textarea', () => {
    const editor = createEditor({ ids: createCounterIdSource('n') });
    const html = renderToString(
      createElement(
        EditorProvider,
        { editor },
        createElement(EditorCanvas, { width: 200, height: 100 }),
      ),
    );
    const canvas = /<canvas[^>]*>/u.exec(html)?.[0] ?? '';
    const textarea = /<textarea[^>]*>/u.exec(html)?.[0] ?? '';
    expect(canvas).toContain('data-text-edit-focus=""');
    expect(textarea).toContain('data-text-edit-focus=""');
    expect(html.match(/data-text-edit-focus/gu)).toHaveLength(2);
  });

  it('marks a field only when it leaves text edit mode itself (the run fields)', () => {
    const field = (onLeaveTextEdit?: () => void) =>
      renderToString(
        createElement(TextField, {
          label: 'Font size',
          value: '16',
          commit: () => true,
          ...(onLeaveTextEdit === undefined ? {} : { onLeaveTextEdit }),
        }),
      );
    expect(field(() => {})).toContain('data-text-edit-focus=""');
    expect(field()).not.toContain('data-text-edit-focus');
  });
});
