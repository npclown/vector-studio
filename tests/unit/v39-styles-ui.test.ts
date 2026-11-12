import type { NodeV8 } from '@vector-studio/react';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '@vector-studio/editor-core';
import { AppearancePanel, EditorProvider, StylesPanel } from '@vector-studio/ui';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  bindCommand,
  bindingState,
  createStyleCommand,
  nextModeName,
  nextStyleName,
  nextVariableName,
  numberOptions,
  paintCss,
  paintOptions,
  type StyleTables,
} from '../../packages/ui/src/styles-model.js';

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md), V39-A07: the pure side of the
// style menus (U2), the number bind buttons (U3) and the Local styles panel (U4).

const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 0.5 };
const gradient = {
  kind: 'linear' as const,
  transform: [1, 0, 0, 1, 0, 0] as const,
  stops: [
    { offset: 0, color: red },
    { offset: 1, color: blue },
  ],
  spread: 'pad' as const,
};

const tables: StyleTables = {
  colorStyles: [
    { id: 's1', name: 'Color 1', paint: red },
    { id: 's2', name: 'Ramp', paint: gradient },
  ],
  variables: {
    modes: [
      { id: 'm1', name: 'Light' },
      { id: 'm2', name: 'Dark' },
    ],
    mode: 'm2',
    items: [
      { id: 'v1', name: 'Primary', type: 'color', values: { m1: red, m2: blue } },
      { id: 'v2', name: 'Half', type: 'number', values: { m1: 1, m2: 0.5 } },
      { id: 'v3', name: 'Gap', type: 'number', values: { m1: 8, m2: 4 } },
    ],
  },
};

const node = (id: string, bindings?: object) =>
  ({ id, ...(bindings === undefined ? {} : { bindings }) }) as unknown as NodeV8;

describe('V39-A07 the style menus and panel model', () => {
  it('a row is unbound, bound to one reference with its label, or mixed', () => {
    expect(bindingState(tables, [node('a'), node('b')], 'fill')).toEqual({ state: 'none' });
    expect(bindingState(tables, [node('a', { fill: { style: 's1' } })], 'fill')).toEqual({
      state: 'one',
      ref: { style: 's1' },
      label: { name: 'Color 1', swatch: 'rgba(255, 0, 0, 1)', value: '#ff0000' },
    });
    // A variable shows its active mode's value.
    expect(bindingState(tables, [node('a', { opacity: { variable: 'v2' } })], 'opacity')).toEqual({
      state: 'one',
      ref: { variable: 'v2' },
      label: { name: 'Half', swatch: null, value: '0.5' },
    });
    const mixed = [node('a', { fill: { style: 's1' } }), node('b')];
    expect(bindingState(tables, mixed, 'fill')).toEqual({ state: 'mixed' });
    const two = [node('a', { fill: { style: 's1' } }), node('b', { fill: { variable: 'v1' } })];
    expect(bindingState(tables, two, 'fill')).toEqual({ state: 'mixed' });
  });

  it('lists styles and colour variables for paints, gradients not for text', () => {
    const names = (key: 'fill' | 'text') => paintOptions(tables, key).map((o) => o.label.name);
    expect(names('fill')).toEqual(['Color 1', 'Ramp', 'Primary']);
    expect(names('text')).toEqual(['Color 1', 'Primary']);
    expect(paintOptions(tables, 'fill')[1]!.label).toEqual({
      name: 'Ramp',
      swatch: 'linear-gradient(90deg, rgba(255, 0, 0, 1) 0%, rgba(0, 0, 255, 0.5) 100%)',
      value: 'Gradient',
    });
    expect(paintOptions({}, 'fill')).toEqual([]);
  });

  it('lists number variables in range in every mode', () => {
    const names = (key: 'opacity' | 'strokeWidth') =>
      numberOptions(tables, key).map((o) => o.label.name);
    expect(names('opacity')).toEqual(['Half']);
    expect(names('strokeWidth')).toEqual(['Half', 'Gap']);
  });

  it('names new styles, modes and variables and builds commands', () => {
    expect(nextStyleName({})).toBe('Color 1');
    expect(nextStyleName(tables)).toBe('Color 3');
    expect(nextStyleName({ colorStyles: [{ id: 'x', name: 'Color 2', paint: red }] })).toBe(
      'Color 3',
    );
    expect(nextModeName(tables)).toBe('Mode 3');
    expect(nextVariableName(tables, 'color')).toBe('Color 2');
    expect(nextVariableName(tables, 'number')).toBe('Number 3');
    expect(createStyleCommand(tables, red)).toEqual({
      type: 'createColorStyle',
      name: 'Color 3',
      paint: red,
    });
    expect(bindCommand(['a'], 'fill', null)).toEqual({
      type: 'bindProperty',
      ids: ['a'],
      key: 'fill',
      ref: null,
    });
    expect(paintCss({ ...gradient, kind: 'radial' })).toMatch(/^radial-gradient\(circle, /u);
  });
});

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function markup(target: Editor, panel: ComponentType): string {
  return renderToString(createElement(EditorProvider, { editor: target }, createElement(panel)));
}

describe('V39-A07 markup', () => {
  it('the Local styles panel lists styles and variables; mode controls are disabled without a set', () => {
    const target = createEditor({ ids: createCounterIdSource('n') });
    const empty = markup(target, StylesPanel);
    expect(empty).toContain('Local styles');
    expect(empty).toMatch(/aria-label="Active mode"[^>]*disabled/u);
    expect(empty).toMatch(/aria-label="Add mode"[^>]*disabled/u);
    ok(target, { type: 'createColorStyle', name: 'Brand', paint: red });
    ok(target, { type: 'createVariable', name: 'Gap', kind: 'number', value: 4 });
    ok(target, { type: 'addVariableMode', name: 'Mode 1' });
    const html = markup(target, StylesPanel);
    expect(html).toContain('aria-label="Style 1 name"');
    expect(html).toContain('value="Brand"');
    // Repeated mode names still give unique labels.
    expect(html).toContain('aria-label="Variable 1 mode 1 value"');
    expect(html).toContain('aria-label="Variable 1 mode 2 value"');
    expect(html).not.toMatch(/aria-label="Active mode"[^>]*disabled/u);
  });

  it('a bound fill shows its chip in place of the hex field; mixed shows Mixed', () => {
    const target = createEditor({ ids: createCounterIdSource('n') });
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      fill: red,
    });
    const [b] = ok(target, {
      type: 'createRectangle',
      frame: { x: 20, y: 0, width: 10, height: 10 },
      fill: red,
    });
    const [s] = ok(target, { type: 'createColorStyle', name: 'Brand', paint: blue });
    ok(target, { type: 'bindProperty', ids: [a!], key: 'fill', ref: { style: s! } });
    ok(target, { type: 'setSelection', ids: [a!] });
    const one = markup(target, () => createElement(AppearancePanel, { layout: 'section' }));
    expect(one).toMatch(/data-testid="fill-binding" data-state="one"/u);
    expect(one).toContain('Brand');
    expect(one).not.toContain('aria-label="Fill colour"');
    expect(one).toContain('data-testid="fill-bind"');
    ok(target, { type: 'setSelection', ids: [a!, b!] });
    const mixed = markup(target, () => createElement(AppearancePanel, { layout: 'section' }));
    expect(mixed).toMatch(/data-state="mixed"[^>]*>Mixed/u);
    expect(mixed).toContain('aria-label="Fill colour"');
  });
});
