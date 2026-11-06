import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SelectionOverlay } from '../../apps/next-host/src/overlay.js';
import { textEditBox } from '../../apps/next-host/src/v25-text-box.js';
import { textHost } from '../support/m6b-text-host.js';

// V-25 slice 6 (text box outline): in the studio layout, text edit mode outlines the edited
// text's box (the `handles` query is null in edit mode, M6b-S1), following the node as typing
// grows it, and a pending node's frame before its first character.

const none = { shift: false, alt: false, meta: false, ctrl: false };

describe('V-25 text box outline in text edit mode', () => {
  it('is null outside text edit mode', () => {
    const host = textHost();
    host.editor.execute({ type: 'setSelection', ids: ['t'] });
    expect(textEditBox(host.editor.getSnapshot())).toBeNull();
  });

  it("outlines the edited node's box in CSS px and grows with typing", () => {
    const host = textHost();
    host.editor.execute({ type: 'setViewport', camera: { position: { x: 0, y: 10 }, zoom: 2 } });
    host.editor.execute({ type: 'enterTextEdit', id: 't', anchor: 5, focus: 5 });
    expect(textEditBox(host.editor.getSnapshot())).toEqual([
      [20, 20],
      [65, 20],
      [65, 44],
      [20, 44],
    ]);
    expect(host.editor.query({ type: 'handles' })).toBeNull();
    host.editor.execute({ type: 'input', event: { kind: 'textinput', text: 'e' } });
    // "ab cde": one more 5-wide letter on the fake port, at zoom 2.
    expect(textEditBox(host.editor.getSnapshot())?.[1]).toEqual([75, 20]);
  });

  it('follows a rotated node', () => {
    const host = textHost();
    host.editor.execute({ type: 'enterTextEdit', id: 'rot', anchor: 0, focus: 0 });
    const [topLeft, , bottomRight] = textEditBox(host.editor.getSnapshot())!;
    // A quarter turn about the centre of (200, 300, 10, 12): the top-left goes to (211, 301).
    expect(topLeft![0]).toBeCloseTo(211);
    expect(topLeft![1]).toBeCloseTo(301);
    expect(bottomRight![0]).toBeCloseTo(199);
    expect(bottomRight![1]).toBeCloseTo(311);
  });

  it("outlines a pending node's frame before its first character", () => {
    const host = textHost();
    host.editor.execute({ type: 'setTool', tool: 'text' });
    const point = { x: 100, y: 150 };
    host.editor.execute({ type: 'input', event: { kind: 'pointerdown', point, modifiers: none } });
    host.editor.execute({ type: 'input', event: { kind: 'pointerup', point, modifiers: none } });
    const snapshot = host.editor.getSnapshot();
    expect(snapshot.textEdit?.pending).not.toBeNull();
    const box = textEditBox(snapshot)!;
    expect(box[0]).toEqual([100, 150]);
    expect(box[3]![0]).toBe(100);
    expect(box[3]![1]).toBeGreaterThan(150);
  });

  it('draws the outline only when the page passes it', () => {
    const host = textHost();
    host.editor.execute({ type: 'enterTextEdit', id: 't', anchor: 0, focus: 0 });
    const snapshot = host.editor.getSnapshot();
    const props = { snapshot, handles: null, width: 600, height: 400 };
    const without = renderToString(createElement(SelectionOverlay, props));
    expect(without).not.toContain('text-edit-box');
    const html = renderToString(
      createElement(SelectionOverlay, { ...props, textBox: textEditBox(snapshot) }),
    );
    expect(html).toContain('data-testid="text-edit-box" points="10,20 32.5,20 32.5,32 10,32"');
  });
});
