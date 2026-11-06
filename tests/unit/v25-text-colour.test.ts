import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EditorProvider, PropertyPanel } from '../../packages/ui/src/index.js';
import { pickedColorCommand, runColor } from '../../packages/ui/src/property-model.js';
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

describe('V-25 text colour writes (review r1)', () => {
  it('keeps the shown alpha, opaque when mixed or none', () => {
    const shown = { state: 'one', value: { r: 0, g: 0, b: 0, a: 0.5 } } as const;
    expect(runColor('#ff0000', shown)).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(runColor('#ff0000', { state: 'mixed' })).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(runColor('red', shown)).toBeNull();
  });

  it('commits a pick to the range the picker opened on, even after edit mode ended', () => {
    const host = textHost();
    host.editor.execute({ type: 'enterTextEdit', id: 't', anchor: 1, focus: 3 });
    // Opened on "b " (1..3); closing the popup by a click outside then ends edit mode.
    const target = { id: 't', start: 1, end: 3, shown: { state: 'mixed' } } as const;
    host.editor.execute({ type: 'exitTextEdit' });
    const command = pickedColorCommand(target, '#ff0000');
    expect(command).not.toBeNull();
    expect(host.editor.execute(command!)).toMatchObject({ ok: true });
    const node = host.editor.getSnapshot().document.nodes.t as unknown as {
      runs: { text: string; color: { r: number } }[];
    };
    expect(node.runs.map((run) => [run.text, run.color.r])).toEqual([
      ['a', 0],
      ['b ', 1],
      ['cd', 0],
    ]);
  });

  it('marks the text swatches as part of the text edit focus target', () => {
    expect(panel(1, 3)).toMatch(/aria-label="Text swatch #000000"[^>]*data-text-edit-focus=""/u);
  });
});
