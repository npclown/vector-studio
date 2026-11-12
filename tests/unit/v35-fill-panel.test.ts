// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-C2 and V35-C3: the appearance
// panel's Fill list and Layer blend menu. The pure model (rows, mixed, the commands each control
// sends, the menu's order and its `Pass through` rule) and the rendered panel.
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type NodeV8,
} from '@vector-studio/editor-core';
import { EditorProvider, PropertyPanel } from '@vector-studio/ui';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MAX_FILLS } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RECTANGLE_FILL } from '../../packages/editor-core/src/edits.js';
import {
  addFillCommand,
  BLEND_GROUPS,
  BLEND_MENU,
  blendCommand,
  blendCommon,
  blendLabel,
  fillHolders,
  fillView,
  modelIndex,
  moveFillCommand,
  offersPassThrough,
  PANEL_DEFAULT_FILL,
  PANEL_MAX_FILLS,
  parsePercent,
  percentText,
  removeFillCommand,
  replaceFillsCommand,
  rowPrefix,
  setFillCommand,
  singleFillCommand,
} from '../../packages/ui/src/fill-model.js';

const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };
const green = { r: 0, g: 1, b: 0, a: 1 };

function editor(): Editor {
  return createEditor({ ids: createCounterIdSource('n') });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

const rect = (target: Editor, x = 0): string =>
  ok(target, { type: 'createRectangle', frame: { x, y: 0, width: 20, height: 20 } })[0]!;

const nodesOf = (target: Editor, ids: readonly string[]): NodeV8[] =>
  ids.map((id) => target.getSnapshot().document.nodes[id]!);

function panel(target: Editor): string {
  return renderToString(
    createElement(EditorProvider, { editor: target }, createElement(PropertyPanel)),
  );
}

/** A rectangle with three fills, bottom first: red, green, blue. */
function threeFills(target: Editor): string {
  const id = rect(target);
  ok(target, { type: 'setStyle', ids: [id], style: { fill: red } });
  ok(target, { type: 'addFill', ids: [id] });
  ok(target, { type: 'setFill', ids: [id], index: 1, patch: { paint: green } });
  ok(target, { type: 'addFill', ids: [id] });
  ok(target, { type: 'setFill', ids: [id], index: 2, patch: { paint: blue } });
  ok(target, { type: 'setSelection', ids: [id] });
  return id;
}

describe('V35-C2 fill view', () => {
  it('shares a list when every holder has the same fills, else mixed', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 40);
    const same = fillView(fillHolders(nodesOf(target, [a, b])));
    expect(same.state).toBe('list');
    ok(target, { type: 'addFill', ids: [a] });
    expect(fillView(fillHolders(nodesOf(target, [a, b])))).toEqual({ state: 'mixed' });
    expect(fillView(fillHolders(nodesOf(target, [a])))).toMatchObject({ state: 'list' });
    expect(fillView([])).toEqual({ state: 'list', fills: [] });
  });

  it('is single when fills differ but each holder has at most one', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 40);
    ok(target, { type: 'setStyle', ids: [a], style: { fill: red } });
    ok(target, { type: 'setStyle', ids: [b], style: { fill: blue } });
    expect(fillView(fillHolders(nodesOf(target, [a, b])))).toEqual({ state: 'single' });
    ok(target, { type: 'setStyle', ids: [b], style: { fill: null } });
    expect(fillView(fillHolders(nodesOf(target, [a, b])))).toEqual({ state: 'single' });
  });

  it("a single edit keeps each one fill's opacity and mode, or replaces through setStyle", () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 40);
    ok(target, { type: 'setStyle', ids: [a], style: { fill: red } });
    ok(target, { type: 'setStyle', ids: [b], style: { fill: blue } });
    const patch = { opacity: 0.5, blendMode: 'multiply' } as const;
    ok(target, { type: 'setFill', ids: [a, b], index: 0, patch });
    const holders = () => fillHolders(nodesOf(target, [a, b]));
    const depth = () => target.query({ type: 'history' }).undoDepth;
    const start = depth();
    const edit = singleFillCommand(holders(), green);
    expect(edit).toMatchObject({ type: 'setFill', index: 0, patch: { paint: green } });
    ok(target, edit);
    expect(holders().map((node) => node.fills)).toEqual([
      [{ paint: green, visible: true, ...patch }],
      [{ paint: green, visible: true, ...patch }],
    ]);
    ok(target, { type: 'setStyle', ids: [b], style: { fill: null } });
    const replace = singleFillCommand(holders(), red);
    expect(replace).toEqual({ type: 'setStyle', ids: [a, b], style: { fill: red } });
    ok(target, replace);
    expect(holders().map((node) => node.fills)).toEqual([
      [{ paint: red, visible: true, opacity: 1, blendMode: 'normal' }],
      [{ paint: red, visible: true, opacity: 1, blendMode: 'normal' }],
    ]);
    expect(singleFillCommand(holders(), null)).toMatchObject({
      type: 'setStyle',
      style: { fill: null },
    });
    expect(depth()).toBe(start + 3);
  });

  it('skips nodes that take no fills (a line)', () => {
    const target = editor();
    const a = rect(target);
    const line = ok(target, {
      type: 'createLine',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
    })[0]!;
    expect(fillHolders(nodesOf(target, [a, line])).map((node) => node.id)).toEqual([a]);
  });

  it('lists rows top first: display position 0 is the last model index', () => {
    expect(modelIndex(3, 0)).toBe(2);
    expect(modelIndex(3, 2)).toBe(0);
    expect([0, 1, 2].map(rowPrefix)).toEqual(['Fill', 'Fill 2', 'Fill 3']);
  });
});

describe('V35-C2 the commands of the controls', () => {
  it('add, set, move, remove and replace are each one undo step', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 40);
    const holders = () => fillHolders(nodesOf(target, [a, b]));
    const depth = () => target.query({ type: 'history' }).undoDepth;
    const start = depth();
    ok(target, addFillCommand(holders()));
    expect(depth()).toBe(start + 1);
    expect(holders().map((node) => node.fills.length)).toEqual([2, 2]);
    ok(target, setFillCommand(holders(), 1, { paint: blue, opacity: 0.5, blendMode: 'multiply' }));
    expect(holders()[1]!.fills[1]).toEqual({
      paint: blue,
      visible: true,
      opacity: 0.5,
      blendMode: 'multiply',
    });
    ok(target, setFillCommand(holders(), 1, { visible: false }));
    expect(holders()[0]!.fills[1]!.visible).toBe(false);
    const before = holders()[0]!.fills.map((fill) => fill.paint);
    // Moving the top row (display position 0) down is model index 1 to 0.
    const down = moveFillCommand(holders(), 2, 0, 'down')!;
    expect(down).toMatchObject({ type: 'moveFill', from: 1, to: 0 });
    ok(target, down);
    expect(holders()[0]!.fills.map((fill) => fill.paint)).toEqual([...before].reverse());
    expect(moveFillCommand(holders(), 2, 0, 'up')).toBeNull();
    expect(moveFillCommand(holders(), 2, 1, 'down')).toBeNull();
    ok(target, removeFillCommand(holders(), 0));
    expect(holders().map((node) => node.fills.length)).toEqual([1, 1]);
    // Each edit was one step.
    expect(depth()).toBe(start + 5);
    ok(target, setFillCommand(holders(), 0, { paint: red }));
    ok(target, replaceFillsCommand(holders()));
    expect(holders().map((node) => node.fills)).toEqual([
      [{ paint: { r: 0.8, g: 0.8, b: 0.8, a: 1 }, visible: true, opacity: 1, blendMode: 'normal' }],
      [{ paint: { r: 0.8, g: 0.8, b: 0.8, a: 1 }, visible: true, opacity: 1, blendMode: 'normal' }],
    ]);
    for (let i = 0; i < 7; i += 1) ok(target, { type: 'undo' });
    expect(depth()).toBe(start);
  });

  it('the mixed `+` replaces different fills by one default fill', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 40);
    ok(target, { type: 'addFill', ids: [a] });
    ok(target, { type: 'setStyle', ids: [b], style: { fill: null } });
    const holders = fillHolders(nodesOf(target, [a, b]));
    expect(fillView(holders)).toEqual({ state: 'mixed' });
    ok(target, replaceFillsCommand(holders));
    const after = fillHolders(nodesOf(target, [a, b]));
    expect(after.map((node) => node.fills.length)).toEqual([1, 1]);
    expect(fillView(after).state).toBe('list');
  });

  it('opacity text is a percent from 0 to 100, with an optional %', () => {
    expect(parsePercent('50')).toBe(0.5);
    expect(parsePercent(' 12.5 % ')).toBe(0.125);
    expect(parsePercent('0')).toBe(0);
    expect(parsePercent('100')).toBe(1);
    expect(parsePercent('101')).toBeNull();
    expect(parsePercent('-1')).toBeNull();
    expect(parsePercent('x')).toBeNull();
    expect(parsePercent('')).toBeNull();
    expect(percentText(0.5)).toBe('50');
    expect(percentText(1)).toBe('100');
    expect(percentText(1 / 3)).toBe('33.3333');
  });
});

describe('V35-C3 blend menu', () => {
  it('orders Pass through, Normal, then the 15 modes in Figma groups', () => {
    expect(BLEND_MENU).toEqual([
      'passThrough',
      'normal',
      'darken',
      'multiply',
      'colorBurn',
      'lighten',
      'screen',
      'colorDodge',
      'overlay',
      'softLight',
      'hardLight',
      'difference',
      'exclusion',
      'hue',
      'saturation',
      'color',
      'luminosity',
    ]);
    expect(BLEND_GROUPS.map((group) => group.label)).toEqual([
      'Normal',
      'Darken',
      'Lighten',
      'Contrast',
      'Inversion',
      'Component',
    ]);
    expect(BLEND_MENU.filter((mode) => mode !== 'passThrough' && mode !== 'normal')).toHaveLength(
      15,
    );
    expect(BLEND_MENU.map(blendLabel).slice(0, 5)).toEqual([
      'Pass through',
      'Normal',
      'Darken',
      'Multiply',
      'Color burn',
    ]);
  });

  it('offers Pass through only when every selected node is a container', () => {
    const target = editor();
    const a = rect(target);
    const group = ok(target, { type: 'groupNodes', ids: [a], kind: 'group' })[0]!;
    const b = rect(target, 60);
    expect(offersPassThrough(nodesOf(target, [group]))).toBe(true);
    expect(offersPassThrough(nodesOf(target, [b]))).toBe(false);
    expect(offersPassThrough(nodesOf(target, [group, b]))).toBe(false);
    expect(offersPassThrough([])).toBe(false);
  });

  it('shows the common mode or mixed, and sends one setStyle', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 40);
    expect(blendCommon(nodesOf(target, [a, b]))).toEqual({ state: 'one', value: 'normal' });
    ok(target, blendCommand(nodesOf(target, [a]), 'multiply'));
    expect(blendCommon(nodesOf(target, [a, b]))).toEqual({ state: 'mixed' });
    expect(nodesOf(target, [a])[0]!.blendMode).toBe('multiply');
    ok(target, blendCommand(nodesOf(target, [a, b]), 'screen'));
    expect(blendCommon(nodesOf(target, [a, b]))).toEqual({ state: 'one', value: 'screen' });
    expect(blendCommon([])).toEqual({ state: 'none' });
    ok(target, { type: 'undo' });
    expect(nodesOf(target, [a])[0]!.blendMode).toBe('multiply');
  });
});

describe('V35-C2/C3 rendered panel', () => {
  it('lists three fills top first with every control per row', () => {
    const target = editor();
    threeFills(target);
    const html = panel(target);
    expect(html).not.toContain('fill-multiple');
    for (const position of [0, 1, 2]) {
      expect(html).toContain(`data-testid="fill-row-${position}"`);
      expect(html).toContain(`data-testid="fill-${position}-visible"`);
      expect(html).toContain(`data-testid="fill-${position}-blend"`);
      expect(html).toContain(`data-testid="fill-${position}-remove"`);
    }
    expect(html).not.toContain('data-testid="fill-row-3"');
    // The top row keeps the plain labels; the next rows are numbered.
    expect(html).toContain('aria-label="Fill colour"');
    expect(html).toContain('aria-label="Fill 2 colour"');
    expect(html).toContain('aria-label="Fill 3 opacity"');
    expect(html).toContain('aria-label="Move fill 3 down"');
    // Top first: blue (the last fill) is the first row's colour.
    expect(html).toMatch(/aria-label="Fill colour"[^>]*value="#0000ff"/u);
    expect(html).toMatch(/aria-label="Fill 3 colour"[^>]*value="#ff0000"/u);
    // The first row cannot move up, the last cannot move down.
    expect(html).toMatch(/aria-label="Move fill up"[^>]*disabled/u);
    expect(html).toMatch(/aria-label="Move fill 3 down"[^>]*disabled/u);
    expect(html).toContain('data-testid="fill-add"');
  });

  it('shows Mixed with the replacing +, for selected nodes whose fills differ', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 40);
    ok(target, { type: 'addFill', ids: [a] });
    ok(target, { type: 'setSelection', ids: [a, b] });
    const html = panel(target);
    expect(html).toContain('data-testid="fill-mixed"');
    expect(html).not.toContain('data-testid="fill-row-0"');
    expect(html).toContain('title="Replace the fills by one fill"');
  });

  it('keeps the single none paint control for a node without a fill', () => {
    const target = editor();
    const a = rect(target);
    ok(target, { type: 'setStyle', ids: [a], style: { fill: null } });
    ok(target, { type: 'setSelection', ids: [a] });
    const html = panel(target);
    expect(html).toContain('aria-label="Fill type"');
    expect(html).toContain('data-testid="fill-add"');
    expect(html).not.toContain('data-testid="fill-row-0"');
  });

  it('disables + at the 16 fill limit', () => {
    const target = editor();
    const a = rect(target);
    for (let i = 1; i < 16; i += 1) ok(target, { type: 'addFill', ids: [a] });
    ok(target, { type: 'setSelection', ids: [a] });
    expect(panel(target)).toMatch(/data-testid="fill-add"[^>]*disabled/u);
  });

  it('shows the Layer blend menu: Pass through for a container only', () => {
    const target = editor();
    const a = rect(target);
    ok(target, { type: 'setSelection', ids: [a] });
    const leaf = panel(target);
    expect(leaf).toContain('aria-label="Blend mode"');
    expect(leaf).not.toContain('Pass through');
    expect(leaf).toMatch(/<optgroup label="Darken"><option value="darken">Darken<\/option>/u);
    const group = ok(target, { type: 'groupNodes', ids: [a], kind: 'group' })[0]!;
    ok(target, { type: 'setSelection', ids: [group] });
    const container = panel(target);
    expect(container).toMatch(
      /aria-label="Blend mode"[^>]*><option value="passThrough" selected="">Pass through<\/option>/u,
    );
  });

  it('shows mixed in the Layer menu when node modes differ', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 40);
    ok(target, { type: 'setStyle', ids: [a], style: { blendMode: 'overlay' } });
    ok(target, { type: 'setSelection', ids: [a, b] });
    expect(panel(target)).toMatch(/aria-label="Blend mode"[^>]*data-mixed="true"/u);
  });
});

describe('V35-C2 panel constants', () => {
  it('equal the editor and model values they mirror', () => {
    expect(PANEL_MAX_FILLS).toBe(MAX_FILLS);
    expect(PANEL_DEFAULT_FILL).toEqual(DEFAULT_RECTANGLE_FILL);
  });
});
