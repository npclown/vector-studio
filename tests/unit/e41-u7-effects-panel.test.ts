import { readFileSync } from 'node:fs';
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
import {
  addEffectCommand,
  effectColorCommand,
  effectNotice,
  effectNumberCommand,
  effectOpacityCommand,
  effectRows,
  isMaskSource,
  opacityText,
  removeEffectCommand,
  toggleEffectCommand,
} from '../../packages/ui/src/effects-model.js';
import { refusalText } from '../../packages/ui/src/property-model.js';

// E41-U7 (E41 contract, section 6): the property panel's Effects section (rows, "mixed", the
// commands each control sends, a mask source's note, the limit notice) and the host wiring
// (E41-S6: next-host projects effects, the editor renderer runs on `effects: 'v0'`).

function editor(): Editor {
  return createEditor({ ids: createCounterIdSource('n') });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function rect(target: Editor, x = 0): string {
  return ok(target, { type: 'createRectangle', frame: { x, y: 0, width: 20, height: 20 } })[0]!;
}

const nodesOf = (target: Editor, ids: readonly string[]): NodeV8[] =>
  ids.map((id) => target.getSnapshot().document.nodes[id]!);

function panel(target: Editor): string {
  return renderToString(
    createElement(EditorProvider, { editor: target }, createElement(PropertySections)),
  );
}

describe('E41-U7 effect rows', () => {
  it('one row per index; mixed where holders differ; shadow fields only with a shadow', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 40);
    ok(target, { type: 'addEffect', ids: [a, b], kind: 'dropShadow' });
    ok(target, { type: 'addEffect', ids: [a], kind: 'layerBlur' });
    let rows = effectRows(nodesOf(target, [a, b]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      index: 0,
      kind: 'dropShadow',
      shadow: true,
      visible: { state: 'one', value: true },
      color: { state: 'one', value: { r: 0, g: 0, b: 0, a: 0.25 } },
      offsetX: { state: 'one', value: 0 },
      offsetY: { state: 'one', value: 4 },
      radius: { state: 'one', value: 8 },
    });
    // Index 1 is held by `a` only: its blur, no shadow fields.
    expect(rows[1]).toMatchObject({
      kind: 'layerBlur',
      shadow: false,
      color: { state: 'none' },
      radius: { state: 'one', value: 4 },
    });
    ok(target, { type: 'setEffect', ids: [b], index: 0, patch: { offsetY: 10 } });
    rows = effectRows(nodesOf(target, [a, b]));
    expect(rows[0]!.offsetY).toEqual({ state: 'mixed' });
    expect(rows[0]!.offsetX).toEqual({ state: 'one', value: 0 });
    // Kinds that differ at one index: 'mixed', with the shadow fields for the shadow.
    const c = rect(target, 80);
    ok(target, { type: 'addEffect', ids: [c], kind: 'layerBlur' });
    rows = effectRows(nodesOf(target, [a, c]));
    expect(rows[0]).toMatchObject({ kind: 'mixed', shadow: true, radius: { state: 'mixed' } });
    expect(effectRows(nodesOf(target, [rect(target, 120)]))).toEqual([]);
  });
});

describe('E41-U7 the commands of the controls', () => {
  it('add, edit each field, toggle and remove, each one undo step', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 40);
    const nodes = () => nodesOf(target, [a, b]);
    const row = () => effectRows(nodes())[0]!;
    ok(target, addEffectCommand(nodes(), 'dropShadow'));
    expect(nodes().map((node) => node.effects.length)).toEqual([1, 1]);
    const steps = [
      effectNumberCommand(nodes(), row(), 'offsetX', '3'),
      effectNumberCommand(nodes(), row(), 'offsetY', '-5'),
      effectNumberCommand(nodes(), row(), 'radius', '12'),
      effectColorCommand(nodes(), row(), '#ff0000'),
    ];
    for (const command of steps) ok(target, command!);
    expect(nodes()[1]!.effects[0]).toEqual({
      kind: 'dropShadow',
      visible: true,
      color: { r: 1, g: 0, b: 0, a: 0.25 },
      offsetX: 3,
      offsetY: -5,
      radius: 12,
    });
    expect(opacityText(row().color)).toBe('25');
    ok(target, effectOpacityCommand(nodes(), row(), '60 %')!);
    expect(nodes()[0]!.effects[0]).toMatchObject({ color: { r: 1, g: 0, b: 0, a: 0.6 } });
    ok(target, toggleEffectCommand(nodes(), row()));
    expect(row().visible).toEqual({ state: 'one', value: false });
    ok(target, toggleEffectCommand(nodes(), row()));
    expect(row().visible).toEqual({ state: 'one', value: true });
    // Hidden on one node: the toggle shows both.
    ok(target, { type: 'setEffect', ids: [a], index: 0, patch: { visible: false } });
    expect(row().visible).toEqual({ state: 'mixed' });
    expect(toggleEffectCommand(nodes(), row())).toMatchObject({ patch: { visible: true } });
    ok(target, removeEffectCommand(nodes(), 0));
    expect(nodes().map((node) => node.effects.length)).toEqual([0, 0]);
    // Each edit was one step: undo walks back through remove, the hide, the toggles, opacity…
    target.execute({ type: 'undo' });
    expect(nodes().map((node) => node.effects.length)).toEqual([1, 1]);
    for (let i = 0; i < 9; i += 1) target.execute({ type: 'undo' });
    expect(nodes().map((node) => node.effects.length)).toEqual([0, 0]);
  });

  it('text that cannot be a value sends nothing', () => {
    const target = editor();
    const a = rect(target);
    ok(target, { type: 'addEffect', ids: [a], kind: 'dropShadow' });
    const nodes = nodesOf(target, [a]);
    const row = effectRows(nodes)[0]!;
    expect(effectNumberCommand(nodes, row, 'radius', '-1')).toBeNull();
    expect(effectNumberCommand(nodes, row, 'radius', '1001')).toBeNull();
    expect(effectNumberCommand(nodes, row, 'offsetX', '20000')).toBeNull();
    expect(effectNumberCommand(nodes, row, 'offsetX', 'x')).toBeNull();
    expect(effectColorCommand(nodes, row, 'red')).toBeNull();
    expect(effectOpacityCommand(nodes, row, '101')).toBeNull();
  });

  it('a refused add shows its notice', () => {
    const target = editor();
    const a = rect(target);
    ok(target, { type: 'addEffect', ids: [a], kind: 'layerBlur' });
    const result = target.execute(addEffectCommand(nodesOf(target, [a]), 'layerBlur'));
    expect(result.ok).toBe(false);
    expect(effectNotice(result)).toBe('A layer takes at most 8 effects and one layer blur');
    expect(refusalText(result)).toBe('A layer takes at most 8 effects and one layer blur');
    expect(effectNotice(target.execute({ type: 'undo' }))).toBeNull();
  });
});

describe('E41-U7 the panel section', () => {
  it('shows add buttons and one row per effect', () => {
    const target = editor();
    const a = rect(target);
    ok(target, { type: 'setSelection', ids: [a] });
    let html = panel(target);
    expect(html).toContain('<legend>Effects</legend>');
    expect(html).toContain('data-testid="effects-add-shadow"');
    expect(html).toContain('data-testid="effects-add-blur"');
    expect(html).not.toContain('data-testid="effect-0"');
    ok(target, { type: 'addEffect', ids: [a], kind: 'dropShadow' });
    ok(target, { type: 'addEffect', ids: [a], kind: 'layerBlur' });
    html = panel(target);
    expect(html).toContain('data-testid="effect-0"');
    expect(html).toContain('data-kind="dropShadow"');
    expect(html).toContain('aria-label="Effect 1 colour"');
    expect(html).toContain('aria-label="Effect 1 X"');
    expect(html).toContain('data-testid="effect-1"');
    expect(html).toContain('data-kind="layerBlur"');
    expect(html).toContain('aria-label="Effect 2 Blur"');
    expect(html).not.toContain('aria-label="Effect 2 X"');
    expect(html).not.toContain('effects-mask-note');
  });

  it("a mask source's effects show disabled with a note", () => {
    const target = editor();
    const mask = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 20, 0, 0, 20],
    })[0]!;
    const content = rect(target, 5);
    ok(target, { type: 'addEffect', ids: [mask], kind: 'dropShadow' });
    ok(target, { type: 'groupNodes', ids: [mask, content], kind: 'maskGroup' });
    const document = target.getSnapshot().document;
    expect(isMaskSource(document, document.nodes[mask]!)).toBe(true);
    expect(isMaskSource(document, document.nodes[content]!)).toBe(false);
    ok(target, { type: 'setSelection', ids: [mask] });
    const html = panel(target);
    expect(html).toContain('data-testid="effects-mask-note"');
    expect(html).toMatch(/data-testid="effects-add-shadow" disabled=""/u);
    expect(html).toMatch(/data-testid="effect-0-remove" disabled=""/u);
  });
});

describe('E41-U7 host wiring (E41-S6)', () => {
  it('next-host projects effects; the editor renderer runs on effects v0', () => {
    const host = readFileSync(
      new URL('../../apps/next-host/src/m6a-text-host.ts', import.meta.url),
      'utf8',
    );
    expect(host).toMatch(/projectEffects: true,/u);
    const webgpu = readFileSync(
      new URL('../../packages/webgpu-host/src/index.ts', import.meta.url),
      'utf8',
    );
    expect(webgpu).toMatch(/effects: 'v0',/u);
  });
});
