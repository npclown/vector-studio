import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Editor,
  type EditorOptions,
  type Modifiers,
  type PagePoint,
} from '@vector-studio/editor-core';

// V-25 slice 8 follow-up 4 (finish a pen path without its first anchor): a double-click or Escape ends the
// pending path open, as Enter does (Figma). A single anchor makes no path and is dropped.

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };

function editor(options: EditorOptions = {}): Editor {
  const target = createEditor({ ids: createCounterIdSource('n'), ...options });
  const result = target.execute({ type: 'setTool', tool: 'path' });
  if (!result.ok) throw new Error(result.code);
  return target;
}

function send(target: Editor, kind: 'pointerdown' | 'pointerup' | 'doubleclick', point: PagePoint) {
  target.execute({ type: 'input', event: { kind, point, modifiers: none } });
}

function click(target: Editor, point: PagePoint) {
  send(target, 'pointerdown', point);
  send(target, 'pointerup', point);
}

/** The browser's order for a double-click: two clicks, then `dblclick` at the second point. */
function doubleClick(target: Editor, first: PagePoint, second: PagePoint = first) {
  click(target, first);
  click(target, second);
  send(target, 'doubleclick', second);
}

function key(target: Editor, name: string) {
  target.execute({
    type: 'input',
    event: { kind: 'keydown', key: name, repeat: false, composing: false, modifiers: none },
  });
}

function paths(target: Editor) {
  return Object.values(target.getSnapshot().document.nodes).filter((node) => node.type === 'path');
}

function verbs(target: Editor) {
  const [node] = paths(target);
  return node?.type === 'path' ? node.path.verbs : undefined;
}

describe('V-25 pen finish by double-click', () => {
  it('ends the path open at the double-clicked anchor', () => {
    const target = editor();
    click(target, { x: 0, y: 0 });
    click(target, { x: 50, y: 0 });
    doubleClick(target, { x: 50, y: 50 });
    expect(paths(target)).toHaveLength(1);
    expect(verbs(target)).toEqual(['move', 'line', 'line']);
    expect(paths(target)[0]!.frame).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    expect(target.query({ type: 'overlay' })).toBeNull();
    expect(target.query({ type: 'selection' })).toEqual([paths(target)[0]!.id]);
  });

  it('adds no anchor for the second press when the hand jitters under 4 CSS px', () => {
    const target = editor();
    click(target, { x: 0, y: 0 });
    doubleClick(target, { x: 50, y: 0 }, { x: 52, y: 1 });
    expect(verbs(target)).toEqual(['move', 'line']);
    expect(paths(target)[0]!.frame).toEqual({ x: 0, y: 0, width: 50, height: 0 });
  });

  it('measures the jitter in CSS px, so at zoom 4 a 2-unit press is a new anchor', () => {
    const target = editor();
    const camera = target.query({ type: 'viewport' });
    target.execute({ type: 'setViewport', camera: { ...camera, zoom: 4 } });
    click(target, { x: 0, y: 0 });
    click(target, { x: 50, y: 0 });
    click(target, { x: 52, y: 0 });
    key(target, 'Enter');
    expect(verbs(target)).toEqual(['move', 'line', 'line']);
  });

  it('drops a single anchor and creates nothing', () => {
    const target = editor();
    doubleClick(target, { x: 10, y: 10 });
    expect(paths(target)).toHaveLength(0);
    expect(target.query({ type: 'overlay' })).toBeNull();
  });

  it('with returnToSelect hands over to select after the double-click', () => {
    const target = editor({ returnToSelect: true });
    click(target, { x: 0, y: 0 });
    doubleClick(target, { x: 40, y: 20 });
    expect(paths(target)).toHaveLength(1);
    expect(target.query({ type: 'tool' })).toBe('select');
    expect(target.query({ type: 'history' }).undoDepth).toBe(1);
  });

  it('keeps a close on the first anchor closed', () => {
    const target = editor();
    click(target, { x: 0, y: 0 });
    click(target, { x: 50, y: 0 });
    click(target, { x: 50, y: 50 });
    doubleClick(target, { x: 0, y: 0 });
    expect(paths(target)).toHaveLength(1);
    expect(verbs(target)).toEqual(['move', 'line', 'line', 'line', 'close']);
    expect(target.query({ type: 'overlay' })).toBeNull();
  });
});

describe('V-25 pen finish by Escape', () => {
  it('ends the path open with the anchors placed so far, in one undo step', () => {
    const target = editor();
    click(target, { x: 0, y: 0 });
    click(target, { x: 50, y: 0 });
    click(target, { x: 50, y: 50 });
    key(target, 'Escape');
    expect(verbs(target)).toEqual(['move', 'line', 'line']);
    expect(target.query({ type: 'overlay' })).toBeNull();
    expect(target.query({ type: 'history' }).undoDepth).toBe(1);
  });

  it('drops a single anchor and creates nothing', () => {
    const target = editor();
    click(target, { x: 0, y: 0 });
    key(target, 'Escape');
    expect(paths(target)).toHaveLength(0);
    expect(target.query({ type: 'overlay' })).toBeNull();
  });

  it('is not consumed without pending anchors, so the keymap clears the selection', () => {
    const target = editor();
    click(target, { x: 0, y: 0 });
    click(target, { x: 50, y: 0 });
    key(target, 'Escape');
    expect(target.query({ type: 'selection' })).toHaveLength(1);
    key(target, 'Escape');
    expect(target.query({ type: 'selection' })).toEqual([]);
  });
});
