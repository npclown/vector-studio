import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '@vector-studio/editor-core';
import { CanvasContextMenu, EditorProvider, selectForContextMenu } from '@vector-studio/ui';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  contextClickSelects,
  contextMenuItems,
  insideSelectionBox,
  type ContextMenuItem,
} from '../../packages/ui/src/context-menu-model.js';

// V-25 slice 10: the canvas context menu's items, enable rules, shortcuts and commands against
// a real editor, the right click selection rule, and the component's markup.

function editor(platform: 'mac' | 'other' = 'other'): Editor {
  const target = createEditor({ ids: createCounterIdSource('n'), platform });
  ok(target, { type: 'setSnapping', enabled: false });
  return target;
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function rect(target: Editor, x: number, y: number, size = 20): string {
  return ok(target, { type: 'createRectangle', frame: { x, y, width: size, height: size } })[0]!;
}

const at = { x: 500, y: 500 };

function menu(target: Editor, point = at): Map<string, ContextMenuItem> {
  const items = contextMenuItems({ snapshot: target.getSnapshot(), point }).flat();
  return new Map(items.map((entry) => [entry.testId, entry]));
}

function run(target: Editor, id: string, point = at) {
  const entry = menu(target, point).get(`context-${id}`);
  if (entry === undefined) throw new Error(`no item ${id}`);
  const execute = (command: Command) => target.execute(command);
  return entry.run === null ? null : entry.run(execute);
}

const selection = (target: Editor) => target.query({ type: 'selection' });
const pageChildren = (target: Editor) => {
  const snapshot = target.getSnapshot();
  return snapshot.document.pages.find((page) => page.id === snapshot.activePage)!.children;
};

describe('V-25 slice 10: the context menu items', () => {
  it('offers paste, select all and zoom on empty canvas', () => {
    const target = editor();
    const groups = contextMenuItems({ snapshot: target.getSnapshot(), point: at });
    expect(groups.map((group) => group.map((entry) => entry.testId))).toEqual([
      ['context-paste'],
      ['context-select-all'],
      ['context-zoom-fit', 'context-zoom-actual'],
    ]);
    // Nothing on the page yet: select all is disabled.
    expect(menu(target).get('context-select-all')!.disabled).toBe(true);
    const a = rect(target, 0, 0);
    const b = rect(target, 40, 0);
    ok(target, { type: 'setSelection', ids: [] });
    run(target, 'select-all');
    expect(selection(target)).toEqual([a, b]);
  });

  it('offers the selection items with the enable rules of the toolbar', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    ok(target, { type: 'setSelection', ids: [a] });
    const one = menu(target);
    expect([...one.keys()]).toEqual([
      'context-copy',
      'context-cut',
      'context-paste',
      'context-duplicate',
      'context-delete',
      'context-front',
      'context-forward',
      'context-backward',
      'context-back',
      'context-group',
      'context-ungroup',
      'context-mask',
      'context-visibility',
      'context-create-symbol',
      'context-create-instance',
      'context-detach',
      'context-zoom-selection',
    ]);
    const disabled = [...one.values()].filter((entry) => entry.disabled).map((e) => e.testId);
    // A single rectangle: no ungroup, no mask, no instance of a non-symbol, no detach.
    expect(disabled).toEqual([
      'context-ungroup',
      'context-mask',
      'context-create-instance',
      'context-detach',
    ]);
    const b = rect(target, 40, 0);
    ok(target, { type: 'setSelection', ids: [a, b] });
    expect(menu(target).get('context-mask')!.disabled).toBe(false);
  });

  it("shows each item's shortcut from the editor's keymap, and the browser's clipboard chords", () => {
    for (const [platform, mod] of [
      ['other', 'Ctrl'],
      ['mac', '⌘'],
    ] as const) {
      const target = editor(platform);
      ok(target, { type: 'setSelection', ids: [rect(target, 0, 0)] });
      const items = menu(target);
      expect(items.get('context-copy')!.shortcut).toBe(`${mod}+C`);
      expect(items.get('context-cut')!.shortcut).toBe(`${mod}+X`);
      expect(items.get('context-paste')!.shortcut).toBe(`${mod}+V`);
      expect(items.get('context-duplicate')!.shortcut).toBe(`${mod}+D`);
      expect(items.get('context-group')!.shortcut).toBe(`${mod}+G`);
      expect(items.get('context-forward')!.shortcut).toBe(`${mod}+]`);
      expect(items.get('context-front')!.shortcut).toBe(`${mod}+Shift+}`);
      // The first delete chord in the keymap's order, as the toolbar's tooltip shows it.
      expect(items.get('context-delete')!.shortcut).toBe('⌫');
      expect(items.get('context-visibility')!.shortcut).toBeNull();
    }
  });

  it('runs duplicate, group and ungroup with the selection the toolbar gives', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 40, 0);
    ok(target, { type: 'setSelection', ids: [a, b] });
    expect(run(target, 'group')?.ok).toBe(true);
    const [group] = selection(target);
    expect(target.query({ type: 'node', id: group! })!.type).toBe('group');
    expect(run(target, 'ungroup')?.ok).toBe(true);
    expect(selection(target)).toEqual([a, b]);
    expect(run(target, 'duplicate')?.ok).toBe(true);
    expect(selection(target)).toHaveLength(2);
    expect(selection(target)).not.toContain(a);
    expect(pageChildren(target)).toHaveLength(4);
  });

  it('reorders, hides and shows, and deletes the selection', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 40, 0);
    ok(target, { type: 'setSelection', ids: [a] });
    run(target, 'front');
    expect(pageChildren(target)).toEqual([b, a]);
    run(target, 'back');
    expect(pageChildren(target)).toEqual([a, b]);
    expect(menu(target).get('context-visibility')!.label).toBe('Hide');
    run(target, 'visibility');
    expect(target.query({ type: 'node', id: a })!.visible).toBe(false);
    expect(menu(target).get('context-visibility')!.label).toBe('Show');
    run(target, 'visibility');
    expect(target.query({ type: 'node', id: a })!.visible).toBe(true);
    run(target, 'delete');
    expect(pageChildren(target)).toEqual([b]);
  });

  it('copies and pastes the copy centred on the press', () => {
    const target = editor();
    const a = rect(target, 0, 0, 20);
    ok(target, { type: 'setSelection', ids: [a] });
    expect(run(target, 'copy')?.ok).toBe(true);
    expect(target.query({ type: 'clipboard' })).not.toBeNull();
    const result = run(target, 'paste', { x: 200, y: 100 });
    expect(result?.ok).toBe(true);
    const [copy] = selection(target);
    expect(copy).not.toBe(a);
    expect(target.query({ type: 'node', id: copy! })!.frame).toMatchObject({
      x: 190,
      y: 90,
      width: 20,
      height: 20,
    });
    run(target, 'cut');
    expect(pageChildren(target)).toEqual([a]);
  });
});

describe('V-25 slice 10: review follow-ups', () => {
  it('deletes the selected anchors, not the path, in path edit mode', () => {
    const target = editor();
    const path = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'line', 'close'],
      points: [0, 0, 40, 0, 40, 40, 0, 40],
    })[0]!;
    ok(target, { type: 'enterPathEdit', id: path });
    expect(menu(target).get('context-delete')!.disabled).toBe(true);
    ok(target, { type: 'setPathSelection', anchors: [{ subpath: 0, anchor: 1 }] });
    const entry = menu(target).get('context-delete')!;
    expect(entry.label).toBe('Delete points');
    expect(run(target, 'delete')?.ok).toBe(true);
    expect(pageChildren(target)).toEqual([path]);
    expect(target.query({ type: 'pathOverlay' })!.subpaths[0]!.anchors).toHaveLength(3);
  });

  it('shows a bound clipboard chord instead of the browser one', () => {
    const target = editor();
    ok(target, { type: 'setKeymap', bindings: [{ chord: 'Mod+Shift+C', action: 'copy' }] });
    ok(target, { type: 'setSelection', ids: [rect(target, 0, 0)] });
    expect(menu(target).get('context-copy')!.shortcut).toBe('Ctrl+Shift+C');
    expect(menu(target).get('context-cut')!.shortcut).toBe('Ctrl+X');
  });
});

describe('V-25 slice 10: the right click selection rule', () => {
  it('tests a point against a rotated box grown by a margin', () => {
    const handles = {
      corners: [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: -10, y: 10 },
        { x: -10, y: 0 },
      ],
      rotation: Math.PI / 2,
      handles: [],
    } as const;
    expect(insideSelectionBox(handles, { x: -5, y: 5 }, 0)).toBe(true);
    expect(insideSelectionBox(handles, { x: 3, y: 5 }, 0)).toBe(false);
    expect(insideSelectionBox(handles, { x: 3, y: 5 }, 4)).toBe(true);
  });

  it('selects what lies under the press, as a left click there would', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 100, 0);
    ok(target, { type: 'setSelection', ids: [a] });
    expect(selectForContextMenu(target, { x: 110, y: 10 })).toBe(true);
    expect(selection(target)).toEqual([b]);
    // Empty canvas clears the selection.
    expect(selectForContextMenu(target, { x: 300, y: 300 })).toBe(true);
    expect(selection(target)).toEqual([]);
    // The click is no edit: nothing to undo beyond the two rectangles.
    expect(target.query({ type: 'history' }).undoDepth).toBe(2);
  });

  it('keeps a multiple selection when the press lands on or near its box', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 100, 0);
    ok(target, { type: 'setSelection', ids: [a, b] });
    // On one of the selected nodes, in the gap between them, and just outside the box.
    for (const point of [
      { x: 10, y: 10 },
      { x: 60, y: 10 },
      { x: 60, y: 25 },
    ]) {
      expect(selectForContextMenu(target, point)).toBe(false);
      expect(selection(target)).toEqual([a, b]);
    }
    expect(selectForContextMenu(target, { x: 60, y: 40 })).toBe(true);
    expect(selection(target)).toEqual([]);
  });

  it('leaves the selection alone with another tool or in path edit mode', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    ok(target, { type: 'setSelection', ids: [a] });
    ok(target, { type: 'setTool', tool: 'rectangle' });
    const snapshot = target.getSnapshot();
    expect(contextClickSelects(snapshot, null, { x: 300, y: 300 })).toBe(false);
    expect(selectForContextMenu(target, { x: 300, y: 300 })).toBe(false);
    expect(selection(target)).toEqual([a]);
    expect(pageChildren(target)).toEqual([a]);
  });
});

describe('V-25 slice 10: CanvasContextMenu markup', () => {
  const markup = (target: Editor, open: boolean) =>
    renderToString(
      createElement(
        EditorProvider,
        { editor: target },
        createElement(CanvasContextMenu, {
          at: open ? { left: 10, top: 20, point: at } : null,
          onClose: () => {},
        }),
      ),
    );

  it('renders nothing while closed', () => {
    expect(markup(editor(), false)).toBe('');
  });

  it('renders a menu of named items with separators and disabled states', () => {
    const target = editor();
    ok(target, { type: 'setSelection', ids: [rect(target, 0, 0)] });
    const html = markup(target, true);
    expect(html).toContain('role="menu"');
    expect(html).toContain('data-testid="context-menu"');
    expect(html).toContain('data-testid="context-copy"');
    expect(html).toMatch(/data-testid="context-ungroup"[^>]*disabled=""/u);
    expect((html.match(/role="separator"/gu) ?? []).length).toBe(5);
    expect(html).toContain('Bring to front');
    expect(html).toContain('Ctrl+G');
  });
});
