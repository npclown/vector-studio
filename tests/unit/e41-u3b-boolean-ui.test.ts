import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  starExtension,
  type Command,
  type Editor,
} from '@vector-studio/editor-core';
import { EditorProvider, PropertySections } from '@vector-studio/ui';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  booleanActions,
  booleanNotice,
  booleanQualifies,
} from '../../packages/ui/src/boolean-model.js';
import {
  contextMenuItems,
  type ContextMenuItem,
} from '../../packages/ui/src/context-menu-model.js';
import { refusalText } from '../../packages/ui/src/property-model.js';

// E41-U3b (E41 contract, section 6): the boolean actions of the context menu and the property
// panel, shown when the selection qualifies (section 2.1), and the notices of the refusals.

function editor(platform: 'mac' | 'other' = 'other'): Editor {
  return createEditor({ ids: createCounterIdSource('n'), platform, extensions: [starExtension] });
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

function menu(target: Editor): Map<string, ContextMenuItem> {
  const items = contextMenuItems({ snapshot: target.getSnapshot(), point: at }).flat();
  return new Map(items.map((entry) => [entry.testId, entry]));
}

const BOOLEAN_ITEMS = [
  'context-boolean-union',
  'context-boolean-subtract',
  'context-boolean-intersect',
  'context-boolean-exclude',
];

function panel(target: Editor): string {
  return renderToString(
    createElement(EditorProvider, { editor: target }, createElement(PropertySections)),
  );
}

describe('E41-U3b which selections qualify (section 2.1)', () => {
  it('two or more visible shapes with one parent', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = ok(target, {
      type: 'createEllipse',
      frame: { x: 10, y: 10, width: 20, height: 20 },
    })[0]!;
    const star = ok(target, {
      type: 'createCustomNode',
      customType: 'ext.star',
      frame: { x: 0, y: 0, width: 20, height: 20 },
    })[0]!;
    const doc = () => target.getSnapshot().document;
    expect(booleanQualifies(doc(), [a])).toBe(false);
    expect(booleanQualifies(doc(), [a, b])).toBe(true);
    expect(booleanQualifies(doc(), [a, b, star])).toBe(true);
    const line = ok(target, {
      type: 'createLine',
      start: { x: 0, y: 0 },
      end: { x: 9, y: 9 },
    })[0]!;
    expect(booleanQualifies(doc(), [a, line])).toBe(false);
    ok(target, { type: 'setNodeProps', id: b, props: { visible: false } });
    expect(booleanQualifies(doc(), [a, b])).toBe(false);
    const c = rect(target, 50, 50);
    const d = rect(target, 60, 60);
    ok(target, { type: 'groupNodes', ids: [c, d], kind: 'group' });
    expect(booleanQualifies(doc(), [a, c])).toBe(false);
    expect(booleanQualifies(doc(), [c, d])).toBe(true);
  });

  it('not with a mask source', () => {
    const target = editor();
    const source = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 100, 0, 0, 100],
    })[0]!;
    const b = rect(target, 10, 10);
    const c = rect(target, 20, 20);
    ok(target, { type: 'groupNodes', ids: [source, b, c], kind: 'maskGroup' });
    const doc = target.getSnapshot().document;
    expect(booleanQualifies(doc, [source, b])).toBe(false);
    expect(booleanQualifies(doc, [b, c])).toBe(true);
  });
});

describe('E41-U3b context menu', () => {
  it('shows the four booleans after the grouping items only when the selection qualifies', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 10, 10);
    ok(target, { type: 'setSelection', ids: [a] });
    expect([...menu(target).keys()].filter((id) => id.startsWith('context-boolean'))).toEqual([]);
    ok(target, { type: 'setSelection', ids: [a, b] });
    const groups = contextMenuItems({ snapshot: target.getSnapshot(), point: at });
    const index = groups.findIndex((group) => group[0]!.testId === 'context-group');
    expect(groups[index + 1]!.map((entry) => entry.testId)).toEqual(BOOLEAN_ITEMS);
    expect(groups[index + 1]!.map((entry) => [entry.label, entry.shortcut])).toEqual([
      ['Union', 'Ctrl+Alt+U'],
      ['Subtract', 'Ctrl+Alt+S'],
      ['Intersect', 'Ctrl+Alt+I'],
      ['Exclude', 'Ctrl+Alt+X'],
    ]);
  });

  it('a boolean item runs the command, which selects the result', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 10, 10);
    ok(target, { type: 'setSelection', ids: [a, b] });
    const item = menu(target).get('context-boolean-union')!;
    const result = item.run!((command) => target.execute(command));
    expect(result).toMatchObject({ ok: true });
    const snapshot = target.getSnapshot();
    const [only] = snapshot.document.pages[0]!.children;
    expect(snapshot.document.nodes[only!]!.type).toBe('path');
    expect(snapshot.selection).toEqual([only]);
  });

  it('shortcuts follow a Mac keymap', () => {
    const target = editor('mac');
    const a = rect(target, 0, 0);
    const b = rect(target, 10, 10);
    ok(target, { type: 'setSelection', ids: [a, b] });
    expect(menu(target).get('context-boolean-union')!.shortcut).toBe('⌘+Alt+U');
  });
});

describe('E41-U3b property panel', () => {
  it('renders the Boolean section only for a qualifying selection', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 10, 10);
    ok(target, { type: 'setSelection', ids: [a] });
    expect(panel(target)).not.toContain('property-boolean-union');
    ok(target, { type: 'setSelection', ids: [a, b] });
    const html = panel(target);
    for (const op of ['union', 'subtract', 'intersect', 'exclude']) {
      expect(html).toContain(`data-testid="property-boolean-${op}"`);
    }
    expect(html).toContain('title="Union (Ctrl+Alt+U)"');
  });

  it('booleanActions carries the command for the selection', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 10, 10);
    const snapshot = target.getSnapshot();
    expect(booleanActions(snapshot.document, [b, a], snapshot.keymap)[1]).toMatchObject({
      op: 'subtract',
      command: { type: 'booleanNodes', ids: [b, a], op: 'subtract' },
    });
  });
});

describe('E41-U3b notices', () => {
  it('a refused boolean reads as a notice; other refusals keep their code', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 100, 100);
    const empty = target.execute({ type: 'booleanNodes', ids: [a, b], op: 'intersect' });
    expect(booleanNotice(empty)).toBe('The boolean result is empty, so nothing changed');
    expect(refusalText(empty)).toBe('The boolean result is empty, so nothing changed');
    const unsupported = target.execute({ type: 'booleanNodes', ids: [a], op: 'union' });
    expect(refusalText(unsupported)).toContain('two or more visible shapes');
    const other = target.execute({ type: 'ungroupNodes', id: a });
    expect(booleanNotice(other)).toBeNull();
    expect(refusalText(other)).toBe('editor.not-a-group');
  });
});
