import path from 'node:path';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '@vector-studio/editor-core';
import { EditorProvider } from '@vector-studio/ui';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type * as ArtboardModule from '../../apps/next-host/src/v25-artboards.js';

// V-25 slice 2 (artboards): top-level frames of the active page as artboards; the list, the
// placement of a preset artboard and its commands run against a real editor (one undo step for
// the document edit), the rename and click rules, and the markup of the labels, list and presets.

const root = path.resolve(import.meta.dirname, '../..');
const boards = (await import(
  path.join(root, 'apps/next-host/src/v25-artboards.tsx')
)) as typeof ArtboardModule;

function editor(): Editor {
  return createEditor({
    document: {
      schemaVersion: 6,
      id: 'doc',
      pages: [
        { id: 'p1', name: 'Page 1', children: [] },
        { id: 'p2', name: 'Page 2', children: [] },
      ],
      nodes: {},
    },
    ids: createCounterIdSource('n'),
  });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
  return result.ids;
}

const markup = (target: Editor, component: ComponentType) =>
  renderToString(createElement(EditorProvider, { editor: target }, createElement(component)));

/** Two artboards and a rectangle on page 1, a frame inside the first artboard. */
function scene() {
  const target = editor();
  const a = ok(target, {
    type: 'createFrame',
    frame: { x: 0, y: 0, width: 400, height: 300 },
    name: 'Home',
  })[0]!;
  ok(target, {
    type: 'createFrame',
    frame: { x: 10, y: 10, width: 50, height: 50 },
    name: 'Card',
    parent: a,
  });
  const rect = ok(target, {
    type: 'createRectangle',
    frame: { x: 500, y: -50, width: 10, height: 10 },
  })[0]!;
  const b = ok(target, {
    type: 'createFrame',
    frame: { x: 600, y: 40, width: 200, height: 500 },
    name: 'About',
  })[0]!;
  return { target, a, b, rect };
}

describe('V-25 artboards: top-level frames of the active page', () => {
  it('lists top-level frames only, front first, per page', () => {
    const { target, a, b } = scene();
    const snapshot = target.getSnapshot();
    expect(boards.artboardsOf(snapshot.document, 'p1').map((board) => board.id)).toEqual([b, a]);
    expect(boards.artboardsOf(snapshot.document, 'p1')[1]).toEqual({
      id: a,
      name: 'Home',
      frame: { x: 0, y: 0, width: 400, height: 300 },
    });
    expect(boards.artboardsOf(snapshot.document, 'p2')).toEqual([]);
    // V-31: a locked artboard is marked, so its canvas label selects nothing.
    ok(target, { type: 'setLayerState', ids: [a], locked: true });
    const locked = boards.artboardsOf(target.getSnapshot().document, 'p1')[1];
    expect(locked).toMatchObject({ id: a, locked: true });
    expect(boards.artboardsOf(snapshot.document, 'missing')).toEqual([]);
  });

  it('places a new artboard right of the others, top-aligned, or centred in the view', () => {
    const { target } = scene();
    const list = boards.artboardsOf(target.getSnapshot().document, 'p1');
    expect(boards.newArtboardFrame(list, 393, 852, null)).toEqual({
      x: 800 + boards.ARTBOARD_GAP,
      y: 0,
      width: 393,
      height: 852,
    });
    const view = { x: 100, y: 50, zoom: 2, width: 800, height: 600 };
    expect(boards.newArtboardFrame([], 100, 80, view)).toEqual({
      x: 250,
      y: 160,
      width: 100,
      height: 80,
    });
    expect(boards.newArtboardFrame([], 100, 80, null)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 80,
    });
  });

  it('creates a preset artboard in one undo step, then selects it and returns to Select', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'frame' });
    ok(target, { type: 'setViewportSize', width: 800, height: 600 });
    const preset = boards.ARTBOARD_PRESETS.find((entry) => entry.name === 'Phone')!;
    const { create, after } = boards.presetCommands(
      preset,
      boards.newArtboardFrame([], preset.width, preset.height, null),
    );
    const [id] = ok(target, create);
    for (const command of after(id!)) ok(target, command);
    const snapshot = target.getSnapshot();
    expect(snapshot.document.nodes[id!]).toMatchObject({
      type: 'frame',
      name: 'Phone',
      frame: { x: 0, y: 0, width: 393, height: 852 },
    });
    expect(snapshot.selection).toEqual([id]);
    expect(snapshot.tool).toBe('select');
    expect(snapshot.history.undoDepth).toBe(1);
    ok(target, { type: 'undo' });
    expect(target.getSnapshot().document.nodes[id!]).toBeUndefined();
  });

  it('toggles with Shift or Mod and renames with a trimmed, changed name', () => {
    expect(boards.artboardClickIds(['x'], 'a', false)).toEqual(['a']);
    expect(boards.artboardClickIds(['x'], 'a', true)).toEqual(['x', 'a']);
    expect(boards.artboardClickIds(['x', 'a'], 'a', true)).toEqual(['x']);
    const board = { id: 'a', name: 'Home', frame: { x: 0, y: 0, width: 1, height: 1 } };
    expect(boards.renameCommand(board, '  Landing ')).toEqual({
      type: 'setNodeProps',
      id: 'a',
      props: { name: 'Landing' },
    });
    expect(boards.renameCommand(board, 'Home')).toBeNull();
    expect(boards.renameCommand(board, '   ')).toBeNull();
  });
});

describe('V-25 artboard rename guard', () => {
  const board = { id: 'a', name: 'Home', frame: { x: 0, y: 0, width: 1, height: 1 } };
  it('acts on the first close of an opening only', () => {
    const guard = boards.createRenameGuard();
    // Enter, then the unmount blur: one command.
    guard.open('a');
    expect(guard.close(board, 'Landing')).toEqual({
      type: 'setNodeProps',
      id: 'a',
      props: { name: 'Landing' },
    });
    expect(guard.close(board, 'Landing')).toBeNull();
    // Escape, then the unmount blur with the draft: nothing.
    guard.open('a');
    expect(guard.close(board, null)).toBeNull();
    expect(guard.close(board, 'Draft')).toBeNull();
    // A close without an opening, or for another artboard: nothing.
    expect(guard.close(board, 'Other')).toBeNull();
    guard.open('b');
    expect(guard.close(board, 'Other')).toBeNull();
  });
});

describe('V-25 artboard markup', () => {
  it('labels each artboard at its corner in canvas px, the selected one pressed', () => {
    const { target, a, b } = scene();
    ok(target, { type: 'setViewport', camera: { position: { x: -100, y: -50 }, zoom: 2 } });
    ok(target, { type: 'setSelection', ids: [b] });
    const html = markup(target, boards.ArtboardLabels);
    expect(html).toContain(`data-testid="artboard-label-${a}" aria-pressed="false"`);
    expect(html).toContain(`data-testid="artboard-label-${b}" aria-pressed="true"`);
    // Home at (0, 0): ((0 + 100) × 2, (0 + 50) × 2); About at (600, 40): (1400, 180).
    expect(html).toMatch(/left:200px;top:100px;transform:translateY\(-100%\)/u);
    expect(html).toMatch(/left:1400px;top:180px;transform:translateY\(-100%\)/u);
    expect(html).toContain('>Home</button>');
    expect(html).not.toContain('Card');
  });

  it('lists the artboards with their sizes, or a hint when there are none', () => {
    const { target, a } = scene();
    const html = markup(target, boards.ArtboardList);
    expect(html).toContain(`data-testid="artboard-${a}"`);
    expect(html).toContain('400<!-- --> × <!-- -->300');
    expect(markup(editor(), boards.ArtboardList)).toContain('No artboards yet');
  });

  it('shows the presets only while the frame tool is active', () => {
    const target = editor();
    expect(markup(target, boards.ArtboardPresets)).toBe('');
    ok(target, { type: 'setTool', tool: 'frame' });
    const html = markup(target, boards.ArtboardPresets);
    for (const preset of boards.ARTBOARD_PRESETS) {
      expect(html).toContain(`data-testid="artboard-preset-${preset.name}"`);
    }
  });
});
