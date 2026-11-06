import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EditorProvider, PropertyPanel } from '../../packages/ui/src/index.js';
import { textHost } from '../support/m6b-text-host.js';

// V-25 slice 5 (text colour picker): the text section's run colour has the browser colour picker
// after its hex field (so Tab from Font size still reaches Text colour, as the M8 spec presses)
// and the swatches, both in the text edit focus target (M8-R4) and disabled for a collapsed
// caret, as the other run fields.

function panel(anchor?: number, focus?: number): string {
  const host = textHost();
  if (anchor === undefined) host.editor.execute({ type: 'setSelection', ids: ['t'] });
  else host.editor.execute({ type: 'enterTextEdit', id: 't', anchor, focus: focus ?? anchor });
  return renderToString(
    createElement(EditorProvider, { editor: host.editor }, createElement(PropertyPanel)),
  );
}

describe('V-25 text colour picker and swatches', () => {
  it('shows the run colour in the picker and presses its swatch', () => {
    const html = panel();
    expect(html).toMatch(/aria-label="Text colour picker"[^>]*value="#000000"/u);
    expect(html).toMatch(/aria-label="Text swatch #000000" aria-pressed="true"/u);
    expect(html).toMatch(/aria-label="Text swatch #f24822" aria-pressed="false"/u);
  });

  it('puts the picker after the hex field, in the text edit focus target', () => {
    const html = panel(1, 3);
    const field = html.indexOf('aria-label="Text colour"');
    const picker = html.indexOf('aria-label="Text colour picker"');
    expect(field).toBeGreaterThan(-1);
    expect(picker).toBeGreaterThan(field);
    expect(html).toMatch(/aria-label="Text colour picker"[^>]*data-text-edit-focus=""/u);
    expect(html).not.toMatch(/aria-label="Text swatch #000000"[^>]*disabled/u);
  });

  it('disables the picker and swatches for a collapsed caret', () => {
    const html = panel(2);
    expect(html).toMatch(/aria-label="Text colour picker"[^>]*disabled/u);
    expect(html).toMatch(/aria-label="Text swatch #000000"[^>]*disabled/u);
  });
});
