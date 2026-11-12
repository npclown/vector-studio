// V-37 U4 (docs/plans/viz-v37-variants-overrides-contract.md, sections 6.1 to 6.3): the
// `instanceLayerAt` query and the pure models of the variant and instance panels, run against a
// real editor (V37-A12), the focus store, and the panel markup.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  validateDocument,
  type DocumentV8,
  type InstanceNodeV8,
  type Paint,
} from '@vector-studio/model';
import {
  EditorProvider,
  LayerTree,
  PropertySections,
  clearInstanceFocus,
  focusInstanceAt,
  setInstanceFocus,
} from '@vector-studio/ui';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '../../packages/editor-core/src/index.js';
import { contextMenuItems } from '../../packages/ui/src/context-menu-model.js';
import { effectRows, addEffectCommand } from '../../packages/ui/src/effects-model.js';
import {
  layerInSource,
  resolveFocus,
  targetInstance,
} from '../../packages/ui/src/instance-focus.js';
import { layerRows } from '../../packages/ui/src/layer-model.js';
import { runPropertyAction, type PropertyAction } from '../../packages/ui/src/property-model.js';
import {
  addPropertyCommand,
  addVariantAction,
  combineAction,
  effectOverrideCommand,
  fillOverrideCommand,
  fillText,
  instanceLayers,
  instanceVariantCommand,
  layerControls,
  opacityOverrideCommand,
  removePropertyCommand,
  renamePropertyCommand,
  resetAllAction,
  resetLayerAction,
  selectedSet,
  setProperties,
  strokeOverrideCommand,
  variantDropdowns,
  variantFields,
  variantValueCommand,
  visibleOverrideCommand,
} from '../../packages/ui/src/variant-model.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/v37-variants');
const read = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

function build(text: string): DocumentV8 {
  const result = validateDocument(JSON.parse(text));
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}
const editorOf = (document: DocumentV8): Editor =>
  createEditor({ document, ids: createCounterIdSource('n') });
/** The set fixture: `set1` of `sA` and `sB` (State and Size), `inst1` of `sA`, a plain `sP`. */
const variants = () => editorOf(build(read('variants.v8.json')));
/** The next-host fixture: three loose symbols `sA`, `sB`, `sC` and `inst` of `sA`. */
const loose = () => editorOf(build(read('next-host.v8.json')));
const docOf = (target: Editor): DocumentV8 => target.query({ type: 'document' });
const depth = (target: Editor) => target.query({ type: 'history' }).undoDepth;

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}
/** Runs a model's command and returns the id list it selected, as the panel does. */
function runAction(target: Editor, action: PropertyAction) {
  return runPropertyAction((command) => target.execute(command), action);
}
const instance = (target: Editor, id = 'inst1') => docOf(target).nodes[id] as InstanceNodeV8;
const RED = { r: 1, g: 0, b: 0, a: 1 };
const GREEN = { r: 0, g: 1, b: 0, a: 1 };

describe('V37-U4 the instanceLayerAt query', () => {
  it('returns the deepest visible source node under the page point', () => {
    const target = variants();
    // inst1 is at (0, 200, 100 x 40): `t1` (the label) is at x 55 to 95, `r1` at x 0 to 50.
    expect(target.query({ type: 'instanceLayerAt', id: 'inst1', point: { x: 75, y: 220 } })).toBe(
      't1',
    );
    // `r1` is hidden by an override and the source's fill override is none: nothing there.
    expect(
      target.query({ type: 'instanceLayerAt', id: 'inst1', point: { x: 25, y: 220 } }),
    ).toBeNull();
    // Resetting the source's fill override gives its background back: the source's ID.
    ok(target, { type: 'resetInstanceOverrides', id: 'inst1', node: 'sA' });
    expect(target.query({ type: 'instanceLayerAt', id: 'inst1', point: { x: 25, y: 220 } })).toBe(
      'sA',
    );
    // Showing `r1` again makes it the deepest layer there.
    ok(target, {
      type: 'setInstanceOverride',
      id: 'inst1',
      node: 'r1',
      props: { visible: true },
    });
    expect(target.query({ type: 'instanceLayerAt', id: 'inst1', point: { x: 25, y: 220 } })).toBe(
      'r1',
    );
  });

  it('is null outside the instance, for a node that is no instance and for bad input', () => {
    const target = variants();
    const at = (id: unknown, x: number, y: number) =>
      target.query({ type: 'instanceLayerAt', id: id as string, point: { x, y } });
    expect(at('inst1', 75, 100)).toBeNull();
    expect(at('inst1', 500, 220)).toBeNull();
    expect(at('sA', 25, 20)).toBeNull();
    expect(at('missing', 25, 220)).toBeNull();
    expect(at('constructor', 25, 220)).toBeNull();
    expect(at(7, 25, 220)).toBeNull();
    expect(target.query({ type: 'instanceLayerAt', id: 'inst1', point: null as never })).toBeNull();
  });

  it('follows the instance past other nodes drawn over it and through a variant switch', () => {
    const target = variants();
    ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 200, width: 100, height: 40 },
      fill: RED,
      stroke: null,
    });
    expect(target.query({ type: 'instanceLayerAt', id: 'inst1', point: { x: 75, y: 220 } })).toBe(
      't1',
    );
    ok(target, { type: 'setInstanceVariant', id: 'inst1', values: { State: 'Hover' } });
    // The Hover variant `sB` holds `r2` (a rectangle with no fill, 50 x 40) and no label.
    expect(
      target.query({ type: 'instanceLayerAt', id: 'inst1', point: { x: 75, y: 220 } }),
    ).toBeNull();
  });
});

describe('V37-A12 section 6.1: symbols and sets', () => {
  it('"Combine as variants" for two or more symbols none of which is in a set', () => {
    const target = loose();
    expect(combineAction(docOf(target), ['sA'])).toBeNull();
    expect(combineAction(docOf(target), ['sA', 'inst'])).toBeNull();
    const action = combineAction(docOf(target), ['sA', 'sB', 'sC'])!;
    expect(action).toEqual({
      label: 'Combine as variants',
      command: { type: 'combineAsVariants', ids: ['sA', 'sB', 'sC'] },
      selectResult: true,
    });
    const steps = depth(target);
    const result = runAction(target, action);
    expect(result.ok).toBe(true);
    expect(depth(target)).toBe(steps + 1);
    const set = target.getSnapshot().selection[0]!;
    expect(docOf(target).nodes[set]!.type).toBe('symbolSet');
    expect(
      ['sA', 'sB', 'sC'].map((id) => (docOf(target).nodes[id] as { variant: unknown }).variant),
    ).toEqual([
      { 'Property 1': 'Default' },
      { 'Property 1': 'Hover' },
      { 'Property 1': 'Pressed' },
    ]);
    // None of the symbols may be in a set already.
    expect(combineAction(docOf(target), ['sA', 'sB'])).toBeNull();
    // Another selection that is not siblings still shows the button; the editor refuses it.
    expect(combineAction(docOf(variants()), ['sP', 'sP'])).not.toBeNull();
  });

  it('the context menu has the item with the same rule', () => {
    const target = loose();
    const item = (ids: readonly string[]) => {
      ok(target, { type: 'setSelection', ids });
      const groups = contextMenuItems({
        snapshot: target.getSnapshot(),
        point: { x: 0, y: 0 },
      });
      return groups.flat().find((entry) => entry.testId === 'context-combine-variants')!;
    };
    expect(item(['sA']).disabled).toBe(true);
    expect(item(['sA', 'inst']).disabled).toBe(true);
    const enabled = item(['sA', 'sB']);
    expect(enabled.label).toBe('Combine as variants');
    expect(enabled.disabled).toBe(false);
    const steps = depth(target);
    expect(enabled.run!((command) => target.execute(command))!.ok).toBe(true);
    expect(depth(target)).toBe(steps + 1);
    // The new set is selected, as after the panel button.
    expect(docOf(target).nodes[target.getSnapshot().selection[0]!]!.type).toBe('symbolSet');
  });

  it('a set lists its properties with values in first-appearance order', () => {
    const target = variants();
    const set = selectedSet(docOf(target), ['set1'])!;
    expect(setProperties(docOf(target), set)).toEqual([
      { name: 'Size', values: ['Large'] },
      { name: 'State', values: ['Default', 'Hover'] },
    ]);
    expect(selectedSet(docOf(target), ['sA'])).toBeNull();
    expect(selectedSet(docOf(target), ['set1', 'sA'])).toBeNull();
  });

  it('renames a property across the set, refusing blank, equal and taken names', () => {
    const target = variants();
    const set = selectedSet(docOf(target), ['set1'])!;
    expect(renamePropertyCommand(docOf(target), set, 'State', '')).toBeNull();
    expect(renamePropertyCommand(docOf(target), set, 'State', 'State')).toBeNull();
    expect(renamePropertyCommand(docOf(target), set, 'State', 'Size')).toBeNull();
    expect(renamePropertyCommand(docOf(target), set, 'Nope', 'X')).toBeNull();
    const command = renamePropertyCommand(docOf(target), set, 'State', 'Mode')!;
    const steps = depth(target);
    ok(target, command);
    expect(depth(target)).toBe(steps + 1);
    expect((docOf(target).nodes.sA as { variant: unknown }).variant).toEqual({
      Mode: 'Default',
      Size: 'Large',
    });
    expect((docOf(target).nodes.sB as { variant: unknown }).variant).toEqual({
      Mode: 'Hover',
      Size: 'Large',
    });
    // The model refuses a name with `=`: the command goes through and the code comes back.
    const bad = renamePropertyCommand(
      docOf(target),
      selectedSet(docOf(target), ['set1'])!,
      'Mode',
      'a=b',
    )!;
    expect(target.execute(bad)).toMatchObject({ ok: false, code: 'document.invalid-field' });
  });

  it('removes a property while two or more remain', () => {
    const target = variants();
    const set = selectedSet(docOf(target), ['set1'])!;
    const command = removePropertyCommand(docOf(target), set, 'Size')!;
    // Removing Size leaves State, whose values stay distinct.
    ok(target, command);
    expect((docOf(target).nodes.sA as { variant: unknown }).variant).toEqual({ State: 'Default' });
    expect(
      removePropertyCommand(docOf(target), selectedSet(docOf(target), ['set1'])!, 'State'),
    ).toBeNull();
  });

  it('removing a property that leaves equal variants is refused by the model with a code', () => {
    const target = variants();
    const set = selectedSet(docOf(target), ['set1'])!;
    const command = removePropertyCommand(docOf(target), set, 'State')!;
    expect(target.execute(command)).toMatchObject({ ok: false, code: 'document.invalid-variant' });
  });

  it('adds a property named Property N with Default on every variant', () => {
    const target = variants();
    const set = selectedSet(docOf(target), ['set1'])!;
    const command = addPropertyCommand(docOf(target), set);
    expect(command).toMatchObject({
      type: 'setVariantProperties',
      updates: [
        { id: 'sA', variant: { 'Property 3': 'Default' } },
        { id: 'sB', variant: { 'Property 3': 'Default' } },
      ],
    });
    ok(target, command);
    // The next one skips a taken name.
    const again = addPropertyCommand(docOf(target), selectedSet(docOf(target), ['set1'])!);
    expect(JSON.stringify(again)).toContain('Property 4');
    ok(target, again);
    expect(setProperties(docOf(target), selectedSet(docOf(target), ['set1'])!)).toHaveLength(4);
  });

  it('skips a taken Property N name', () => {
    const target = variants();
    const set = selectedSet(docOf(target), ['set1'])!;
    ok(target, renamePropertyCommand(docOf(target), set, 'Size', 'Property 3')!);
    const command = addPropertyCommand(docOf(target), selectedSet(docOf(target), ['set1'])!);
    expect(JSON.stringify(command)).toContain('Property 4');
  });

  it('"Add variant" duplicates the selected or the first variant, with the N2 suffix', () => {
    const target = variants();
    const set = selectedSet(docOf(target), ['set1'])!;
    const first = addVariantAction(docOf(target), set)!;
    expect(first.command).toEqual({ type: 'duplicateNodes', ids: ['sA'] });
    const second = addVariantAction(docOf(target), set, 'sB')!;
    expect(second.command).toEqual({ type: 'duplicateNodes', ids: ['sB'] });
    // A node that is not a variant of the set falls back to the first.
    expect(addVariantAction(docOf(target), set, 'sP')!.command).toEqual(first.command);
    const steps = depth(target);
    expect(runAction(target, second).ok).toBe(true);
    expect(depth(target)).toBe(steps + 1);
    const copy = target.getSnapshot().selection[0]!;
    expect((docOf(target).nodes[copy] as { variant: unknown }).variant).toEqual({
      Size: 'Large 2',
      State: 'Hover',
    });
  });

  it('a symbol in a set shows one field per property and writes through setVariantProperties', () => {
    const target = variants();
    expect(variantFields(docOf(target), ['sP'])).toBeNull();
    expect(variantFields(docOf(target), ['sA', 'sB'])).toBeNull();
    expect(variantFields(docOf(target), ['set1'])).toBeNull();
    const section = variantFields(docOf(target), ['sB'])!;
    expect(section).toEqual({
      id: 'sB',
      fields: [
        { name: 'Size', value: 'Large' },
        { name: 'State', value: 'Hover' },
      ],
    });
    const command = variantValueCommand(docOf(target), 'sB', 'State', 'Pressed')!;
    expect(command).toEqual({
      type: 'setVariantProperties',
      updates: [{ id: 'sB', variant: { Size: 'Large', State: 'Pressed' } }],
    });
    ok(target, command);
    expect((docOf(target).nodes.sB as { variant: unknown }).variant).toEqual({
      Size: 'Large',
      State: 'Pressed',
    });
    // A value equal to another variant's is refused with the model's code and changes nothing.
    const before = docOf(target);
    const clash = variantValueCommand(docOf(target), 'sB', 'State', 'Default')!;
    expect(target.execute(clash)).toMatchObject({ ok: false, code: 'document.invalid-variant' });
    expect(docOf(target)).toBe(before);
  });
});

describe('V37-A12 section 6.2: instances', () => {
  it('Variant dropdowns list the set values and disable one with no matching variant', () => {
    const target = variants();
    expect(variantDropdowns(docOf(target), 'sP')).toBeNull();
    expect(variantDropdowns(docOf(target), 'nope')).toBeNull();
    expect(variantDropdowns(docOf(target), 'inst1')).toEqual([
      { name: 'Size', value: 'Large', options: [{ value: 'Large', disabled: false }] },
      {
        name: 'State',
        value: 'Default',
        options: [
          { value: 'Default', disabled: false },
          { value: 'Hover', disabled: false },
        ],
      },
    ]);
    // A third variant with another size: Hover exists for Large only, so with Size = Small the
    // State dropdown lists Hover as disabled.
    const set = selectedSet(docOf(target), ['set1'])!;
    const [added] = ok(target, addVariantAction(docOf(target), set, 'sA')!.command);
    ok(target, {
      type: 'setVariantProperties',
      updates: [{ id: added!, variant: { Size: 'Small', State: 'Default' } }],
    });
    ok(target, instanceVariantCommand('inst1', 'Size', 'Small'));
    const dropdowns = variantDropdowns(docOf(target), 'inst1')!;
    expect(dropdowns.find((entry) => entry.name === 'Size')!.value).toBe('Small');
    expect(dropdowns.find((entry) => entry.name === 'State')!.options).toEqual([
      { value: 'Default', disabled: false },
      { value: 'Hover', disabled: true },
    ]);
  });

  it('picking a value calls setInstanceVariant, one undo step', () => {
    const target = variants();
    const command = instanceVariantCommand('inst1', 'State', 'Hover');
    expect(command).toEqual({
      type: 'setInstanceVariant',
      id: 'inst1',
      values: { State: 'Hover' },
    });
    const steps = depth(target);
    ok(target, command);
    expect(depth(target)).toBe(steps + 1);
    expect(instance(target).symbol).toBe('sB');
    expect(variantDropdowns(docOf(target), 'inst1')!.find((d) => d.name === 'State')!.value).toBe(
      'Hover',
    );
  });

  it('the Layers list is the source subtree, indented, with overridden rows marked', () => {
    const target = variants();
    expect(instanceLayers(docOf(target), 'inst1')).toEqual([
      { id: 'sA', name: 'Default', type: 'symbol', depth: 0, overridden: true },
      { id: 'r1', name: 'Box', type: 'rectangle', depth: 1, overridden: true },
      { id: 't1', name: 'Label', type: 'text', depth: 1, overridden: true },
    ]);
    ok(target, { type: 'resetInstanceOverrides', id: 'inst1' });
    expect(instanceLayers(docOf(target), 'inst1').map((row) => row.overridden)).toEqual([
      false,
      false,
      false,
    ]);
    // A text override alone marks its row too.
    const runs = [{ text: 'X', family: 'Inter', size: 14, color: { r: 0, g: 0, b: 0, a: 1 } }];
    ok(target, { type: 'setInstanceText', id: 'inst1', node: 't1', runs });
    expect(instanceLayers(docOf(target), 'inst1').map((row) => row.overridden)).toEqual([
      false,
      false,
      true,
    ]);
    expect(instanceLayers(docOf(target), 'sA')).toEqual([]);
  });

  it('focused layer controls write through setInstanceOverride and reset', () => {
    const target = loose();
    const rect = 'rA';
    const controls = layerControls(docOf(target), 'inst', rect)!;
    expect(controls).toMatchObject({ isSource: false, fill: true, stroke: true, inner: true });
    expect(layerControls(docOf(target), 'inst', 'sA')).toMatchObject({
      isSource: true,
      fill: true,
      inner: false,
    });
    expect(layerControls(docOf(target), 'inst', 'rB')).toBeNull();
    expect(layerControls(docOf(target), 'rA', rect)).toBeNull();

    const steps = depth(target);
    // Fill colour: a hex, keeping the shown alpha.
    const fill = fillOverrideCommand(
      'inst',
      rect,
      controls.node.type === 'rectangle' ? controls.node.fill : null,
      '#00ff00',
    )!;
    expect(fill).toEqual({
      type: 'setInstanceOverride',
      id: 'inst',
      node: rect,
      props: { fill: GREEN },
    });
    ok(target, fill);
    expect(instance(target, 'inst').overrides).toEqual({ rA: { fill: GREEN } });
    expect(fillOverrideCommand('inst', rect, null, 'green')).toBeNull();
    expect(fillOverrideCommand('inst', rect, null, '')).toMatchObject({ props: { fill: null } });
    const shown = layerControls(docOf(target), 'inst', rect)!.node as unknown as { fill: Paint };
    expect(fillText(shown.fill)).toBe('#00ff00');

    // Stroke colour with no stroke starts from a 1-unit black stroke.
    const stroke = strokeOverrideCommand('inst', rect, null, '#ff0000')!;
    expect(stroke).toMatchObject({ props: { stroke: { color: RED, width: 1 } } });
    ok(target, stroke);
    expect(strokeOverrideCommand('inst', rect, null, 'x')).toBeNull();
    expect(strokeOverrideCommand('inst', rect, null, '')).toMatchObject({
      props: { stroke: null },
    });

    // Opacity in percent, and the visibility toggle.
    expect(opacityOverrideCommand('inst', rect, '50%')).toMatchObject({ props: { opacity: 0.5 } });
    expect(opacityOverrideCommand('inst', rect, '101')).toBeNull();
    expect(opacityOverrideCommand('inst', rect, 'a')).toBeNull();
    ok(target, opacityOverrideCommand('inst', rect, '50')!);
    ok(target, visibleOverrideCommand('inst', rect, true));
    expect(instance(target, 'inst').overrides!.rA).toMatchObject({ opacity: 0.5, visible: false });
    const after = layerControls(docOf(target), 'inst', rect)!.node;
    expect(after).toMatchObject({ opacity: 0.5, visible: false });
    expect(depth(target)).toBe(steps + 4);

    // Reset: the layer's overrides go in one step.
    const reset = resetLayerAction('inst', rect);
    expect(reset).toEqual({
      label: 'Reset',
      command: { type: 'resetInstanceOverrides', id: 'inst', node: rect },
      selectResult: false,
    });
    expect(runAction(target, reset).ok).toBe(true);
    expect(instance(target, 'inst').overrides).toBeUndefined();
  });

  it('the Effects list of a layer writes the effect list as one override', () => {
    const target = loose();
    const rect = 'rA';
    const effects = () => layerControls(docOf(target), 'inst', rect)!.node.effects;
    // The E41 row model builds node-level commands over the shown node; they become overrides.
    const add = addEffectCommand([layerControls(docOf(target), 'inst', rect)!.node], 'dropShadow');
    const command = effectOverrideCommand('inst', rect, effects(), add)!;
    expect(command).toMatchObject({
      type: 'setInstanceOverride',
      id: 'inst',
      node: rect,
      props: { effects: [{ kind: 'dropShadow', visible: true }] },
    });
    ok(target, command);
    expect(effects()).toHaveLength(1);
    // The source's own effects list is untouched.
    expect(docOf(target).nodes.rA!.effects).toEqual([]);
    const row = effectRows([layerControls(docOf(target), 'inst', rect)!.node])[0]!;
    expect(row.kind).toBe('dropShadow');
    const setBlur = effectOverrideCommand('inst', rect, effects(), {
      type: 'setEffect',
      ids: [rect],
      index: 0,
      patch: { radius: 12, bogus: 1 } as never,
    })!;
    ok(target, setBlur);
    expect(effects()[0]).toMatchObject({ kind: 'dropShadow', radius: 12 });
    ok(
      target,
      effectOverrideCommand('inst', rect, effects(), {
        type: 'removeEffect',
        ids: [rect],
        index: 0,
      })!,
    );
    // Removing the last effect equals the source's own list, so the override is gone.
    expect(instance(target, 'inst').overrides).toBeUndefined();
    expect(effectOverrideCommand('inst', rect, [], { type: 'undo' })).toBeNull();
  });

  it('"Reset all overrides" runs resetInstanceOverrides without a node', () => {
    const target = variants();
    const action = resetAllAction('inst1');
    expect(action).toEqual({
      label: 'Reset all overrides',
      command: { type: 'resetInstanceOverrides', id: 'inst1' },
      selectResult: false,
    });
    const steps = depth(target);
    expect(runAction(target, action).ok).toBe(true);
    expect(depth(target)).toBe(steps + 1);
    expect(instance(target).overrides).toBeUndefined();
    expect(Object.keys(instance(target).textOverrides)).toEqual([]);
  });

  it('the layers panel shows a set with its icon, its variants as children', () => {
    const target = variants();
    const rows = layerRows(docOf(target), target.getSnapshot().activePage, new Set(['set1']), []);
    const set = rows.find((row) => row.id === 'set1')!;
    expect(set).toMatchObject({ type: 'symbolSet', expandable: true, expanded: true });
    expect(rows.filter((row) => row.depth === 1).map((row) => row.id)).toEqual(['sB', 'sA']);
  });
});

describe('V37-A12 section 6.3: canvas focus', () => {
  /** The next-host fixture with `inst` grouped with a rectangle, and `inst2` of `sB` after it. */
  function grouped() {
    const target = loose();
    ok(target, { type: 'setSelection', ids: ['inst'] });
    const other = ok(target, {
      type: 'createRectangle',
      frame: { x: 300, y: 300, width: 10, height: 10 },
      fill: RED,
      stroke: null,
    })[0]!;
    const [group] = ok(target, { type: 'groupNodes', ids: ['inst', other], kind: 'group' });
    return { target, group: group! };
  }
  const inBox = { x: 50, y: 120 };

  it('resolves the layer of one selected instance', () => {
    const target = loose();
    const document = docOf(target);
    const layerAt = (id: string) => target.query({ type: 'instanceLayerAt', id, point: inBox });
    expect(resolveFocus(document, ['inst'], layerAt)).toEqual({ instance: 'inst', layer: 'rA' });
    expect(resolveFocus(document, ['inst'], () => null)).toBeNull();
    expect(resolveFocus(document, [], layerAt)).toBeNull();
    expect(resolveFocus(document, ['inst', 'sA'], layerAt)).toBeNull();
    expect(resolveFocus(document, ['sA'], layerAt)).toBeNull();
    expect(resolveFocus(document, ['missing'], layerAt)).toBeNull();
  });

  it('under a selected group, focuses the innermost instance under the point', () => {
    const { target, group } = grouped();
    ok(target, { type: 'setSelection', ids: [group] });
    const document = docOf(target);
    const asked: string[] = [];
    const found = resolveFocus(document, [group], (id) => {
      asked.push(id);
      return target.query({ type: 'instanceLayerAt', id, point: inBox });
    });
    expect(found).toEqual({ instance: 'inst', layer: 'rA' });
    // Only the instance was asked; the rectangle is no candidate.
    expect(asked).toEqual(['inst']);
    // A point outside every instance of the group focuses nothing.
    expect(
      resolveFocus(document, [group], (id) =>
        target.query({ type: 'instanceLayerAt', id, point: { x: 305, y: 305 } }),
      ),
    ).toBeNull();
  });

  it('with two instances in a group the one hit at the point wins, front first', () => {
    const { target, group } = grouped();
    const [two] = ok(target, { type: 'createInstance', symbol: 'sB' });
    ok(target, {
      type: 'setFrames',
      frames: [{ id: two!, frame: { x: 0, y: 100, width: 100, height: 40 } }],
    });
    ok(target, { type: 'moveNodes', ids: [two!], parent: group, index: 2 });
    ok(target, { type: 'setSelection', ids: [group] });
    const document = docOf(target);
    const found = resolveFocus(document, [group], (id) =>
      target.query({ type: 'instanceLayerAt', id, point: inBox }),
    );
    // `two` is last in the group, so it is in front of `inst` and wins at the shared point.
    expect(found).toEqual({ instance: two, layer: 'rB' });
  });

  it('the panel target is the focused instance under a selected group, else the selected one', () => {
    const { target, group } = grouped();
    const document = docOf(target);
    expect(targetInstance(document, [group], null)).toBeNull();
    expect(targetInstance(document, ['inst'], null)).toBe('inst');
    const focus = { instance: 'inst', layer: 'rA', selection: [group] } as const;
    expect(targetInstance(document, [group], focus)).toBe('inst');
    // A focus made under another selection no longer applies.
    expect(targetInstance(document, ['inst'], focus)).toBe('inst');
    expect(targetInstance(document, ['sA'], focus)).toBeNull();
  });

  it('the store focuses on a double-click point and clears on selection change', () => {
    const target = loose();
    const seen: unknown[] = [];
    ok(target, { type: 'setSelection', ids: ['inst'] });
    expect(focusInstanceAt(target, inBox)).toBe(true);
    // The selection and history are untouched.
    expect(target.getSnapshot().selection).toEqual(['inst']);
    const steps = depth(target);
    // A miss clears the focus.
    expect(focusInstanceAt(target, { x: 500, y: 500 })).toBe(false);
    expect(focusInstanceAt(target, inBox)).toBe(true);
    ok(target, { type: 'setSelection', ids: ['sA'] });
    // After the selection changed the focus is gone: a row pick sets it again.
    setInstanceFocus(target, 'inst', 'rA');
    expect(depth(target)).toBe(steps);
    ok(target, { type: 'setSelection', ids: ['inst'] });
    seen.push(target.getSnapshot().selection);
    expect(seen).toHaveLength(1);
  });

  it('is rendered as UI state: focus clears with the selection, Escape and a layer leaving', () => {
    const target = loose();
    ok(target, { type: 'setSelection', ids: ['inst'] });
    const render = () =>
      renderToString(
        createElement(EditorProvider, { editor: target }, createElement(PropertySections)),
      );
    // No focus yet: the controls of a focused layer are absent.
    expect(render()).not.toContain('Layer fill colour');
    focusInstanceAt(target, inBox);
    expect(render()).toContain('Layer fill colour');
    // Selection change clears it.
    ok(target, { type: 'setSelection', ids: ['sA'] });
    ok(target, { type: 'setSelection', ids: ['inst'] });
    expect(render()).not.toContain('Layer fill colour');
    // The layer leaving the source clears it.
    setInstanceFocus(target, 'inst', 'rA');
    expect(render()).toContain('Layer fill colour');
    ok(target, { type: 'setSelection', ids: ['inst'] });
    ok(target, { type: 'deleteNodes', ids: ['rA'] });
    expect(layerInSource(docOf(target), 'inst', 'rA')).toBe(false);
    expect(render()).not.toContain('Layer fill colour');
    // clearInstanceFocus is the explicit clear (Escape's effect).
    setInstanceFocus(target, 'inst', 'sA');
    expect(render()).toContain('Layer fill colour');
    clearInstanceFocus(target);
    expect(render()).not.toContain('Layer fill colour');
  });
});

describe('V37-U4 panel markup', () => {
  const render = (target: Editor) =>
    renderToString(
      createElement(EditorProvider, { editor: target }, createElement(PropertySections)),
    );

  it('shows "Combine as variants" for the selected symbols', () => {
    const target = loose();
    ok(target, { type: 'setSelection', ids: ['sA', 'sB'] });
    expect(render(target)).toContain('<button type="button">Combine as variants</button>');
    ok(target, { type: 'setSelection', ids: ['sA'] });
    expect(render(target)).not.toContain('Combine as variants');
  });

  it("shows a set's properties, Add property and Add variant", () => {
    const target = variants();
    ok(target, { type: 'setSelection', ids: ['set1'] });
    const html = render(target);
    expect(html).toContain('Properties');
    expect(html).toContain('aria-label="Property 1 name"');
    expect(html).toContain('aria-label="Property 2 name"');
    expect(html).toContain('Add property');
    expect(html).toContain('Add variant');
    expect(html).toContain('Default, Hover');
    // Two properties: neither remove button is disabled.
    expect(html).toMatch(/aria-label="Remove property Size"(?![^>]*disabled)/u);
  });

  it('disables the remove button with one property left', () => {
    const target = variants();
    ok(target, { type: 'setSelection', ids: ['set1'] });
    ok(
      target,
      removePropertyCommand(docOf(target), selectedSet(docOf(target), ['set1'])!, 'Size')!,
    );
    const html = render(target);
    expect(html).toMatch(/aria-label="Remove property State"[^>]*disabled/u);
  });

  it("shows a variant's property fields", () => {
    const target = variants();
    ok(target, { type: 'setSelection', ids: ['sB'] });
    const html = render(target);
    expect(html).toContain('Variant properties');
    expect(html).toContain('aria-label="Variant State"');
    expect(html).toContain('value="Hover"');
  });

  it('shows an instance\'s Variant dropdowns, Layers and "Reset all overrides"', () => {
    const target = variants();
    ok(target, { type: 'setSelection', ids: ['inst1'] });
    const html = render(target);
    expect(html).toContain('<legend>Variant</legend>');
    expect(html).toContain('aria-label="Variant State"');
    expect(html).toContain('<legend>Layers</legend>');
    expect(html).toContain('data-testid="instance-layer-r1"');
    expect(html).toContain('data-overridden="true"');
    expect(html).toContain('<button type="button">Detach instance</button>');
    expect(html).toContain('<button type="button">Reset all overrides</button>');
  });

  it('shows the focused layer controls with the E41 effects list', () => {
    const target = loose();
    ok(target, { type: 'setSelection', ids: ['inst'] });
    setInstanceFocus(target, 'inst', 'rA');
    const html = render(target);
    for (const label of [
      'Layer fill colour',
      'Layer stroke colour',
      'Layer opacity',
      'Layer visible',
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('<legend>Layer effects</legend>');
    expect(html).toContain('<button type="button">Reset</button>');
    // The source's own row has no opacity, visibility or effects.
    setInstanceFocus(target, 'inst', 'sA');
    const source = render(target);
    expect(source).toContain('aria-label="Layer fill colour"');
    expect(source).not.toContain('aria-label="Layer opacity"');
    expect(source).not.toContain('<legend>Layer effects</legend>');
  });

  it('shows the layer row icon for a set', () => {
    const target = variants();
    const html = renderToString(
      createElement(EditorProvider, { editor: target }, createElement(LayerTree)),
    );
    expect(html).toContain('data-testid="layer-icon-set1"');
    expect(html).toContain('data-icon="symbol-set"');
    // A plain symbol row has none.
    expect(html).not.toContain('data-testid="layer-icon-sP"');
  });
});
