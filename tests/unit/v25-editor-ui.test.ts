import path from 'node:path';
import {
  createCounterIdSource,
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type ExtensionTool,
} from '@vector-studio/editor-core';
import { EditorProvider, EditorToolbar, ZoomMenu } from '@vector-studio/ui';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type * as StudioModule from '../../apps/next-host/src/v25-studio.js';
import {
  actionShortcut,
  actionTitle,
  chordLabel,
  nextMenuIndex,
  shortcutFor,
  toolTitle,
  zoomPercent,
} from '../../packages/ui/src/editor-toolbar-model.js';

// V-25 (editor UI usability, slice 1): the icon toolbar's names and shortcut hints as pure
// functions against a real editor's keymap, the toolbar and zoom menu markup, and next-host's
// studio switch and canvas sizing.

const root = path.resolve(import.meta.dirname, '../..');
const studio = (await import(
  path.join(root, 'apps/next-host/src/v25-studio.tsx')
)) as typeof StudioModule;

const tool = (id: string): ExtensionTool => ({ id, input: () => false, reset: () => {} });

function editor(platform: 'mac' | 'other' = 'other'): Editor {
  return createEditor({
    document: {
      schemaVersion: 6,
      id: 'doc',
      pages: [{ id: 'p1', name: 'Page 1', children: [] }],
      nodes: {},
    },
    ids: createCounterIdSource('n'),
    platform,
    extensions: [starExtension, { id: 'test.ui', tools: [tool('test.ui.draw')] }],
  });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
  return result.ids;
}

const markup = (target: Editor, component: ComponentType) =>
  renderToString(createElement(EditorProvider, { editor: target }, createElement(component)));

describe('V-25 shortcut labels', () => {
  it('reads canonical chords as a person does', () => {
    expect(chordLabel('KeyV')).toBe('V');
    expect(chordLabel('Ctrl+Shift+KeyZ')).toBe('Ctrl+Shift+Z');
    expect(chordLabel('Meta+Alt+KeyM')).toBe('⌘+Alt+M');
    expect(chordLabel('Shift+Digit1')).toBe('Shift+1');
    expect(chordLabel('Shift+!')).toBe('Shift+!');
    expect(chordLabel('Delete')).toBe('Del');
    expect(chordLabel('ArrowLeft')).toBe('←');
    expect(chordLabel('Shift++')).toBe('Shift++');
    expect(chordLabel('+')).toBe('+');
  });

  it("names each tool with its setTool chord from the editor's keymap", () => {
    const keymap = editor().query({ type: 'keymap' });
    expect(toolTitle('select', keymap)).toBe('Select (V)');
    expect(toolTitle('rectangle', keymap)).toBe('Rectangle (R)');
    expect(toolTitle('path', keymap)).toBe('Pen (P)');
    expect(toolTitle('text', keymap)).toBe('Text (T)');
    // An extension tool without a binding shows its ID only.
    expect(toolTitle('test.ui.draw', keymap)).toBe('test.ui.draw');
  });

  it('names each action with the chord of the keymap action it mirrors, per platform', () => {
    const other = editor('other').query({ type: 'keymap' });
    const mac = editor('mac').query({ type: 'keymap' });
    expect(actionTitle('undo', other)).toBe('Undo (Ctrl+Z)');
    expect(actionTitle('undo', mac)).toBe('Undo (⌘+Z)');
    expect(actionTitle('group', other)).toBe('Group selection (Ctrl+G)');
    expect(actionTitle('ungroup', other)).toBe('Ungroup (Ctrl+Shift+G)');
    expect(actionTitle('mask', other)).toBe('Use as mask (Ctrl+Alt+M)');
    expect(actionShortcut('zoom-in', other)).toBe('=');
    expect(actionShortcut('zoom-fit', other)).toBe('Shift+!');
    // No default chord: the name alone (M3-Q11, M7: unbound).
    expect(actionTitle('toggle-closed', other)).toBe('Open or close path');
    expect(actionTitle('create-symbol', other)).toBe('Create symbol');
    expect(shortcutFor(other, 'setTool', { tool: 'nope' })).toBeNull();
  });

  it('follows a host keymap layer', () => {
    const target = editor();
    ok(target, {
      type: 'setKeymap',
      bindings: [{ chord: 'Q', action: 'setTool', args: { tool: 'select' } }],
    });
    expect(toolTitle('select', target.query({ type: 'keymap' }))).toBe('Select (Q)');
  });

  it('shows the zoom as a whole percentage', () => {
    expect(zoomPercent(1)).toBe('100%');
    expect(zoomPercent(0.3333)).toBe('33%');
    expect(zoomPercent(2.005)).toBe('201%');
  });
});

describe('V-25 zoom menu keys', () => {
  it('moves between enabled items, wrapping, and ignores other keys', () => {
    // fit, selection (disabled), 100%: as zoomActions with nothing selected, minus in and out.
    const enabled = [true, true, true, false, true];
    expect(nextMenuIndex(enabled, -1, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(enabled, 2, 'ArrowDown')).toBe(4);
    expect(nextMenuIndex(enabled, 4, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(enabled, 4, 'ArrowUp')).toBe(2);
    expect(nextMenuIndex(enabled, 0, 'ArrowUp')).toBe(4);
    expect(nextMenuIndex(enabled, 2, 'Home')).toBe(0);
    expect(nextMenuIndex(enabled, 0, 'End')).toBe(4);
    expect(nextMenuIndex(enabled, 0, 'a')).toBeNull();
    expect(nextMenuIndex([false, false], -1, 'ArrowDown')).toBeNull();
  });
});

describe('V-25 EditorToolbar and ZoomMenu markup', () => {
  it('renders named icon buttons with the M8 test IDs and enable rules', () => {
    const target = editor();
    const html = markup(target, EditorToolbar);
    expect(html).toMatch(/^<div role="toolbar" aria-label="tools" class="vs-toolbar"/u);
    for (const id of ['select', 'rectangle', 'ellipse', 'line', 'frame', 'path', 'text']) {
      expect(html).toContain(`data-testid="tool-${id}"`);
    }
    expect(html).toContain(
      'data-testid="tool-select" aria-label="Select (V)" title="Select (V)" aria-pressed="true"',
    );
    expect(html).toContain('data-testid="tool-test.ui.draw" aria-label="test.ui.draw"');
    // Nothing selected and no history: the actions are disabled.
    for (const id of ['undo', 'redo', 'group', 'ungroup', 'mask', 'delete', 'create-symbol']) {
      expect(html).toMatch(new RegExp(`data-testid="${id}"[^>]*disabled=""`, 'u'));
    }
    expect(html).toContain('<svg aria-hidden="true"');
    for (const group of ['tool', 'history', 'grouping', 'symbols', 'edit']) {
      expect(html).toContain(`role="group" aria-label="${group}"`);
    }
  });

  it('enables the selection actions once something is selected', () => {
    const target = editor();
    const [id] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    ok(target, { type: 'setSelection', ids: [id!] });
    const html = markup(target, EditorToolbar);
    for (const action of ['undo', 'group', 'ungroup', 'delete', 'create-symbol']) {
      expect(html).not.toMatch(new RegExp(`data-testid="${action}"[^>]*disabled=""`, 'u'));
    }
    expect(html).toMatch(/data-testid="mask"[^>]*disabled=""/u);
  });

  it('renders the zoom button closed, with the exact zoom in data-zoom', () => {
    const target = editor();
    ok(target, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 2 } });
    const html = markup(target, ZoomMenu);
    expect(html).toContain('data-testid="zoom" data-zoom="2" aria-haspopup="menu"');
    expect(html).toContain('>200%<span aria-hidden="true" class="vs-caret">▾</span>');
    expect(html).not.toContain('role="menu"');
  });
});

describe('V-25 next-host studio layout', () => {
  it('is the default, and specs, benches and ?layout=legacy keep the M8 layout', () => {
    expect(studio.studioLayout('')).toBe(true);
    expect(studio.studioLayout('?fixture=containers')).toBe(true);
    expect(studio.studioLayout('?persist=1')).toBe(true);
    expect(studio.studioLayout('?test=1')).toBe(false);
    expect(studio.studioLayout('?test=1&fixture=text')).toBe(false);
    expect(studio.studioLayout('?bench=1&doc=m9-v2')).toBe(false);
    expect(studio.studioLayout('?layout=legacy')).toBe(false);
  });

  it('sizes the canvas in whole pixels, never below its minimum', () => {
    expect(studio.canvasSizeFor(1023.7, 640.2)).toEqual({ width: 1023, height: 640 });
    expect(studio.canvasSizeFor(0, 10)).toEqual({ width: 64, height: 64 });
  });
});
