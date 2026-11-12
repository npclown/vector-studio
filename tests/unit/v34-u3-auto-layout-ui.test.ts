import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type NodeV8,
} from '@vector-studio/editor-core';
import { EditorProvider, PropertySections } from '@vector-studio/ui';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { contextMenuItems } from '../../packages/ui/src/context-menu-model.js';
import {
  autoLayoutSection,
  gapCommand,
  layoutPatchCommand,
  paddingCommand,
  resizingSection,
  sizingCommand,
} from '../../packages/ui/src/layout-model.js';

// V-34 U3 (docs/plans/viz-v34-auto-layout-contract.md, section 6): the panel's "Auto layout"
// section and "Resizing" selects, "mixed" values, Fill disabled where it counts as fixed, one
// `setLayout` per multi-selection edit, and the context menu item. V34-A05.

function editor(): Editor {
  return createEditor({ ids: createCounterIdSource('n') });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function rect(target: Editor, x: number, parent?: string): string {
  return ok(target, {
    type: 'createRectangle',
    frame: { x, y: 0, width: 20, height: 20 },
    ...(parent === undefined ? {} : { parent }),
  })[0]!;
}

function frame(target: Editor, x: number): string {
  return ok(target, { type: 'createFrame', frame: { x, y: 0, width: 200, height: 100 } })[0]!;
}

const nodesOf = (target: Editor, ids: readonly string[]): NodeV8[] =>
  ids.map((id) => target.getSnapshot().document.nodes[id]!);

function panel(target: Editor): string {
  return renderToString(
    createElement(EditorProvider, { editor: target }, createElement(PropertySections)),
  );
}

function menuIds(target: Editor): string[] {
  return contextMenuItems({ snapshot: target.getSnapshot(), point: { x: 0, y: 0 } })
    .flat()
    .map((entry) => entry.testId);
}

describe('V34-A05 auto layout section', () => {
  it('shows "+" for frames without auto layout, the fields with it, mixed where they differ', () => {
    const target = editor();
    const f = frame(target, 0);
    const g = frame(target, 300);
    rect(target, 10, f);
    ok(target, { type: 'setSelection', ids: [f] });
    expect(panel(target)).toContain('data-testid="auto-layout-add"');
    expect(menuIds(target)).toContain('context-auto-layout-add');
    ok(target, { type: 'addAutoLayout', ids: [f, g] });
    ok(target, { type: 'setLayout', ids: [g], autoLayout: { gap: 7, direction: 'horizontal' } });
    const state = autoLayoutSection(nodesOf(target, [f, g]))!;
    expect(state.holders).toHaveLength(2);
    expect(state.direction).toEqual({ state: 'mixed' });
    expect(state.gap).toEqual({ state: 'mixed' });
    expect(state.primaryAlign).toEqual({ state: 'one', value: 'start' });
    ok(target, { type: 'setSelection', ids: [f, g] });
    const html = panel(target);
    expect(html).toContain('data-testid="auto-layout-remove"');
    expect(html).toContain('aria-label="Padding top"');
    expect(html).toMatch(/data-testid="auto-layout-primary"/u);
    expect(menuIds(target)).toContain('context-auto-layout-remove');
    // One command for both frames: one undo step.
    const revision = target.getSnapshot().revision;
    ok(target, gapCommand(state, '12')!);
    expect(
      nodesOf(target, [f, g]).map((n) => (n as { autoLayout?: { gap: number } }).autoLayout!.gap),
    ).toEqual([12, 12]);
    expect(target.getSnapshot().revision).toBe(revision + 1);
    ok(target, { type: 'undo' });
    expect(gapCommand(state, 'x')).toBeNull();
    expect(layoutPatchCommand(state, { counterAlign: 'end' })).toEqual({
      type: 'setLayout',
      ids: [f, g],
      autoLayout: { counterAlign: 'end' },
    });
  });

  it('padding edits keep the other sides; mixed other sides give no command', () => {
    const target = editor();
    const f = frame(target, 0);
    const g = frame(target, 300);
    ok(target, { type: 'addAutoLayout', ids: [f, g] });
    const state = autoLayoutSection(nodesOf(target, [f, g]))!;
    expect(paddingCommand(state, 1, '8')).toEqual({
      type: 'setLayout',
      ids: [f, g],
      autoLayout: { padding: [0, 8, 0, 0] },
    });
    ok(target, { type: 'setLayout', ids: [g], autoLayout: { padding: [1, 0, 0, 0] } });
    expect(paddingCommand(autoLayoutSection(nodesOf(target, [f, g]))!, 1, '8')).toBeNull();
  });
});

describe('V34-A05 resizing selects', () => {
  it('offers Hug for auto-layout frames, Fill for their children, disabled where fixed', () => {
    const target = editor();
    const f = frame(target, 0);
    const a = rect(target, 10, f);
    const b = rect(target, 40, f);
    const loose = rect(target, 500);
    expect(resizingSection(target.getSnapshot().document, nodesOf(target, [loose]))).toBeNull();
    ok(target, { type: 'addAutoLayout', ids: [f] });
    const document = () => target.getSnapshot().document;
    const own = resizingSection(document(), nodesOf(target, [f]))!;
    expect(own.horizontal.choices.map((c) => c.value)).toEqual(['fixed', 'hug']);
    expect(own.horizontal.value).toEqual({ state: 'one', value: 'hug' });
    const kids = resizingSection(document(), nodesOf(target, [a, b]))!;
    expect(kids.horizontal.choices).toEqual([
      { value: 'fixed', enabled: true },
      { value: 'fill', enabled: true },
    ]);
    ok(target, sizingCommand(nodesOf(target, [a, b]), 'horizontal', 'fill'));
    ok(target, { type: 'rotateNodes', ids: [a], angle: 0.5 });
    const rotated = resizingSection(document(), nodesOf(target, [a]))!;
    expect(rotated.horizontal.choices.find((c) => c.value === 'fill')!.enabled).toBe(false);
    ok(target, { type: 'setSelection', ids: [b] });
    const html = panel(target);
    expect(html).toContain('data-testid="resizing-horizontal"');
    // Children of an auto-layout frame: no Constraints section, X and Y read-only.
    expect(html).not.toContain('Horizontal constraint');
    expect(html).toMatch(/aria-label="X"[^>]*disabled=""|disabled=""[^>]*aria-label="X"/u);
  });
});
