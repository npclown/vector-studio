import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type TextEditState,
} from '@vector-studio/editor-core';
import {
  serializeDocument,
  validateDocument,
  type DocumentV7,
  type TextNodeV7,
} from '@vector-studio/model';
import {
  AppearancePanel,
  EditorProvider,
  PropertyPanel,
  PropertySections,
} from '@vector-studio/ui';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ARROWS,
  CONSTRAINTS,
  TRANSFORM_FIELDS,
  commonOf,
  commonText,
  constrainedNodes,
  arrowCommand,
  constraintsCommand,
  fieldIdentity,
  nameCommand,
  visibleCommand,
  lineNodes,
  parseFamily,
  parseFontSize,
  parseTransform,
  refusalText,
  runPropertyAction,
  runsIn,
  selectedNodes,
  symbolSection,
  textLength,
  textNodes,
  textPropsCommand,
  textRange,
  textRunStyle,
  textStyleCommand,
  transformCommand,
  transformValue,
} from '../../packages/ui/src/property-model.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';
import { v7Value } from '../support/schema-v7.js';

// MVP M8 contract, unit M8-U5, M8-A11 (section 7.3, M8-R1 to M8-R5): the property panel. The M4
// appearance panel's pure module and component moved to `ui` (the moved M4 tests,
// `m4-u4-next-host.test.ts`, run against the `ui` module; M8-U6 removed next-host's copies and
// the agreement block that compared them). The transform, layer, line,
// constraint, text and symbol models give literal commands for one node, run against a real
// editor (each one undo step), the common or mixed values for several, and refusals; the markup
// (`renderToString`, M8-Q5 (a)) shows one-node fields editable, several-node fields read-only,
// the run fields disabled at a collapsed caret (M8-Q9 (a)) and the section 7.3 buttons without a
// test ID (M8-R5).

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const RED = { r: 1, g: 0, b: 0, a: 1 };
const START = { horizontal: 'start', vertical: 'start' } as const;
const STROKE = {
  color: BLACK,
  width: 1,
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
  dash: null,
} as const;

const base = (id: string, parent: string, frame: Record<string, number>) => ({
  id,
  name: `node ${id}`,
  parent,
  frame: { x: 0, y: 0, width: 10, height: 10, ...frame },
  rotation: 0,
  constraints: START,
  opacity: 1,
  visible: true,
});
const text = (id: string, parent: string, runs: readonly object[]) => ({
  ...base(id, parent, { x: 300, y: 10, width: 120, height: 30 }),
  type: 'text',
  runs,
  sizing: 'fixed',
  align: 'left',
  letterSpacing: 0,
  lineHeight: 1.2,
});
const run = (value: string, extra: object = {}) => ({
  text: value,
  family: 'Inter',
  size: 16,
  color: BLACK,
  ...extra,
});

/**
 * One page: a rectangle `r` (rotated), a second rectangle `q`, a line `l`, a frame `f` with a
 * child `c` (end and scale constraints), a two-run text `t`, a symbol `s` holding the text `st`
 * and the text `su`, and an instance `i` of it with text overrides of `st` and `su`. Written at
 * v6, upgraded to v7 (E41-S1).
 */
const DOCUMENT = v7Value({
  schemaVersion: 6,
  id: 'doc',
  pages: [{ id: 'p1', name: 'Page 1', children: ['r', 'q', 'l', 'f', 't', 's', 'i'] }],
  nodes: {
    r: {
      ...base('r', 'p1', { x: 10, y: 20, width: 100, height: 50 }),
      rotation: Math.PI / 6,
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fill: RED,
      stroke: null,
    },
    q: {
      ...base('q', 'p1', { x: 10, y: 80, width: 100, height: 60 }),
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fill: RED,
      stroke: null,
      visible: false,
    },
    l: {
      ...base('l', 'p1', { x: 10, y: 160, width: 100, height: 0 }),
      type: 'line',
      points: [0, 0, 1, 0],
      stroke: STROKE,
      startArrow: 'none',
      endArrow: 'triangle',
    },
    f: {
      ...base('f', 'p1', { x: 150, y: 10, width: 120, height: 120 }),
      type: 'frame',
      children: ['c'],
      fill: null,
      stroke: null,
    },
    c: {
      ...base('c', 'f', { x: 10, y: 10, width: 40, height: 40 }),
      constraints: { horizontal: 'end', vertical: 'scale' },
      type: 'ellipse',
      fill: RED,
      stroke: null,
    },
    t: text('t', 'p1', [run('Hello '), run('world', { size: 24, color: RED })]),
    s: {
      ...base('s', 'p1', { x: 300, y: 100, width: 120, height: 40 }),
      type: 'symbol',
      children: ['st', 'su'],
      fill: null,
      stroke: null,
    },
    st: {
      ...text('st', 's', [run('Label')]),
      frame: { x: 0, y: 0, width: 120, height: 30 },
    },
    su: {
      ...text('su', 's', [run('Caption')]),
      frame: { x: 0, y: 30, width: 120, height: 10 },
    },
    i: {
      ...base('i', 'p1', { x: 300, y: 200, width: 120, height: 40 }),
      type: 'instance',
      symbol: 's',
      textOverrides: { st: { runs: [run('Changed')] }, su: { runs: [run('Note')] } },
    },
  },
});

function parsed(): DocumentV7 {
  const result = validateDocument(DOCUMENT);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function editor(): Editor {
  return createEditor({
    document: DOCUMENT,
    ids: createCounterIdSource('n'),
    textLayout: createFakeTextLayout(),
  });
}

const serialized = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const node = (target: Editor, id: string) => target.query({ type: 'document' }).nodes[id]!;

/** Runs `command` as one undo step: it succeeds, adds one step, and undo restores the document. */
function oneStep(target: Editor, command: Command): void {
  const before = serialized(target);
  const depth = target.getSnapshot().history.undoDepth;
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  expect(target.getSnapshot().history.undoDepth).toBe(depth + 1);
  expect(serialized(target)).not.toBe(before);
  target.execute({ type: 'undo' });
  expect(serialized(target)).toBe(before);
  target.execute({ type: 'redo' });
}

function markup(target: Editor, component: ComponentType): string {
  return renderToString(
    createElement(EditorProvider, { editor: target }, createElement(component)),
  );
}

/** The opening tag of the control labelled `label`. */
function control(html: string, label: string): string {
  const match = new RegExp(`<(input|select)[^>]*aria-label="${label}"[^>]*>`, 'u').exec(html);
  if (match === null) throw new Error(`no control ${label}`);
  return match[0];
}

// M8-U6 removed next-host's copies of the appearance module and panel, and with them the
// agreement block that pinned `ui`'s copies to next-host's until then (M8-U5 notes).
describe('M8-R1: the moved M4 appearance panel', () => {
  it("the section layout differs from the aside only in the box's style (M8-N3, M8-N5)", () => {
    const target = editor();
    target.execute({ type: 'setSelection', ids: ['r'] });
    const aside = markup(target, AppearancePanel);
    const section = markup(target, () => createElement(AppearancePanel, { layout: 'section' }));
    expect(aside).toContain('style="width:300px;max-height:640px;overflow-y:auto;font-size:13px"');
    expect(section).toContain(
      '<aside aria-label="Appearance" data-testid="appearance-panel" style="font-size:13px">',
    );
    expect(section.replace('style="font-size:13px"', '')).toBe(
      aside.replace('style="width:300px;max-height:640px;overflow-y:auto;font-size:13px"', ''),
    );
  });
});

describe('M8-R2: transform fields in the stored parent-local frame (M8-Q8 (a))', () => {
  it('reads X, Y, W, H and the rotation in degrees, common or mixed', () => {
    const document = parsed();
    expect(TRANSFORM_FIELDS.map((field) => field.label)).toEqual(['X', 'Y', 'W', 'H', 'Rotation']);
    const [r, q, c] = selectedNodes(document, ['r', 'q', 'c', 'gone']);
    expect(selectedNodes(document, ['r', 'q', 'c', 'gone']).map((entry) => entry.id)).toEqual([
      'r',
      'q',
      'c',
    ]);
    expect(
      TRANSFORM_FIELDS.map(({ key }) => commonText(commonOf([r!], (n) => transformValue(n, key)))),
    ).toEqual(['10', '20', '100', '50', '30']);
    // The child's frame is parent-local.
    expect(transformValue(c!, 'x')).toBe(10);
    expect(
      TRANSFORM_FIELDS.map(({ key }) => commonOf([r!, q!], (n) => transformValue(n, key))),
    ).toEqual([
      { state: 'one', value: 10 },
      { state: 'mixed' },
      { state: 'one', value: 100 },
      { state: 'mixed' },
      { state: 'mixed' },
    ]);
    expect(commonOf([], () => 1)).toEqual({ state: 'none' });
  });

  it('one edit is one setFrames of one node, literal and one undo step', () => {
    const target = editor();
    const r = node(target, 'r');
    expect(transformCommand(r, 'x', 42)).toEqual({
      type: 'setFrames',
      frames: [{ id: 'r', frame: { x: 42, y: 20, width: 100, height: 50 } }],
    });
    expect(transformCommand(r, 'height', 7)).toEqual({
      type: 'setFrames',
      frames: [{ id: 'r', frame: { x: 10, y: 20, width: 100, height: 7 } }],
    });
    expect(transformCommand(r, 'rotation', 90)).toEqual({
      type: 'setFrames',
      frames: [{ id: 'r', frame: { x: 10, y: 20, width: 100, height: 50 }, rotation: Math.PI / 2 }],
    });
    oneStep(target, transformCommand(r, 'width', 64));
    expect(node(target, 'r')).toMatchObject({
      frame: { x: 10, y: 20, width: 64, height: 50 },
      rotation: Math.PI / 6,
    });
    oneStep(target, transformCommand(node(target, 'r'), 'rotation', 90));
    expect(node(target, 'r').rotation).toBe(Math.PI / 2);
    expect(transformValue(node(target, 'r'), 'rotation')).toBe(90);
    // A child of a frame keeps its parent-local frame.
    oneStep(target, transformCommand(node(target, 'c'), 'x', 5));
    expect(node(target, 'c').frame).toEqual({ x: 5, y: 10, width: 40, height: 40 });
  });

  it('refuses text that cannot be a value (nothing sent), W and H below 0', () => {
    expect(parseTransform('x', ' -12.5 ')).toBe(-12.5);
    expect(parseTransform('rotation', '-450')).toBe(-450);
    expect(parseTransform('width', '0')).toBe(0);
    for (const [key, bad] of [
      ['x', ''],
      ['y', 'abc'],
      ['width', '-1'],
      ['height', '-0.5'],
      ['rotation', '1e999'],
    ] as const)
      expect(parseTransform(key, bad)).toBeNull();
  });
});

describe('M8-R3: layer, line and constraint fields', () => {
  it('reads name and visibility, common or mixed', () => {
    const document = parsed();
    const nodes = selectedNodes(document, ['r', 'q']);
    expect(commonOf(nodes, (n) => n.name)).toEqual({ state: 'mixed' });
    expect(commonOf(nodes, (n) => n.visible)).toEqual({ state: 'mixed' });
    expect(commonOf(nodes.slice(0, 1), (n) => n.visible)).toEqual({ state: 'one', value: true });
  });

  it('lines and arrows: the selected lines, their common arrows, one setNodeProps', () => {
    const document = parsed();
    expect(ARROWS).toEqual(['none', 'line', 'triangle']);
    expect(lineNodes(selectedNodes(document, ['r', 'l'])).map((n) => n.id)).toEqual(['l']);
    const target = editor();
    const document2 = target.query({ type: 'document' });
    const [l, r, q] = ['l', 'r', 'q'].map((id) => document2.nodes[id]!);
    expect(arrowCommand(l!, 'startArrow', 'line')).toEqual({
      type: 'setNodeProps',
      id: 'l',
      props: { startArrow: 'line' },
    });
    expect(arrowCommand(l!, 'endArrow', 'none')).toEqual({
      type: 'setNodeProps',
      id: 'l',
      props: { endArrow: 'none' },
    });
    expect(nameCommand(r!, 'Box')).toEqual({
      type: 'setNodeProps',
      id: 'r',
      props: { name: 'Box' },
    });
    // The checkbox toggles: a hidden node is shown, a shown one hidden.
    expect(visibleCommand(q!)).toEqual({ type: 'setNodeProps', id: 'q', props: { visible: true } });
    expect(visibleCommand(r!)).toEqual({
      type: 'setNodeProps',
      id: 'r',
      props: { visible: false },
    });
    oneStep(target, arrowCommand(l!, 'startArrow', 'line'));
    expect(node(target, 'l')).toMatchObject({ startArrow: 'line', endArrow: 'triangle' });
    oneStep(target, nameCommand(r!, 'Box'));
    oneStep(target, visibleCommand(q!));
    expect([node(target, 'r').name, node(target, 'q').visible]).toEqual(['Box', true]);
    expect(fieldIdentity([r!, q!])).toBe('["r","q"]');
  });

  it('constraints: children of a frame or a symbol only, one axis changed per edit', () => {
    const document = parsed();
    expect(CONSTRAINTS).toEqual(['start', 'end', 'startEnd', 'center', 'scale']);
    expect(
      constrainedNodes(document, selectedNodes(document, ['r', 'c', 'st', 'f'])).map((n) => n.id),
    ).toEqual(['c', 'st']);
    const c = document.nodes.c!;
    expect(constraintsCommand(c, 'horizontal', 'center')).toEqual({
      type: 'setNodeProps',
      id: 'c',
      props: { constraints: { horizontal: 'center', vertical: 'scale' } },
    });
    const target = editor();
    oneStep(target, constraintsCommand(c, 'vertical', 'startEnd'));
    expect(node(target, 'c').constraints).toEqual({ horizontal: 'end', vertical: 'startEnd' });
  });
});

describe('M8-R4: text fields (M8-Q9 (a))', () => {
  const editing = (anchor: number, focus: number, id = 't'): TextEditState => ({
    id,
    pending: null,
    anchor,
    focus,
    affinity: 'downstream',
    composition: null,
  });

  it('the run fields edit the non-collapsed selection, else the whole text; a caret disables them', () => {
    const t = parsed().nodes.t as TextNodeV7;
    expect(textLength(t)).toBe(11);
    expect(textRange(t, null)).toEqual({ start: 0, end: 11 });
    expect(textRange(t, editing(8, 2))).toEqual({ start: 2, end: 8 });
    expect(textRange(t, editing(4, 4))).toBeNull();
    expect(textRange(t, editing(4, 4, 'st'))).toEqual({ start: 0, end: 11 });
    expect(runsIn(t, 0, 6).map((entry) => entry.text)).toEqual(['Hello ']);
    expect(runsIn(t, 5, 7).map((entry) => entry.text)).toEqual(['Hello ', 'world']);
    expect(runsIn(t, 6, 6).map((entry) => entry.text)).toEqual(['Hello ']);
    expect(textRunStyle([t], null)).toEqual({
      family: { state: 'one', value: 'Inter' },
      size: { state: 'mixed' },
      color: { state: 'mixed' },
    });
    expect(textRunStyle([t], editing(7, 9))).toEqual({
      family: { state: 'one', value: 'Inter' },
      size: { state: 'one', value: 24 },
      color: { state: 'one', value: RED },
    });
    // A collapsed caret shows its run, read-only.
    expect(textRunStyle([t], editing(9, 9)).size).toEqual({ state: 'one', value: 24 });
  });

  it('setTextStyle over the range and setTextProps, literal, each one undo step', () => {
    const target = editor();
    const t = node(target, 't') as TextNodeV7;
    expect(textStyleCommand(t, { start: 2, end: 8 }, { size: 20 })).toEqual({
      type: 'setTextStyle',
      id: 't',
      start: 2,
      end: 8,
      style: { size: 20 },
    });
    expect(textPropsCommand(t, { align: 'center' })).toEqual({
      type: 'setTextProps',
      id: 't',
      align: 'center',
    });
    oneStep(target, textStyleCommand(t, { start: 0, end: 11 }, { family: 'Serif' }));
    expect((node(target, 't') as TextNodeV7).runs.map((entry) => entry.family)).toEqual([
      'Serif',
      'Serif',
    ]);
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 0, focus: 5 });
    const range = textRange(node(target, 't') as TextNodeV7, target.getSnapshot().textEdit)!;
    expect(range).toEqual({ start: 0, end: 5 });
    oneStep(target, textStyleCommand(t, range, { color: RED }));
    expect(
      (node(target, 't') as TextNodeV7).runs.map((entry) => [entry.text, entry.color]),
    ).toEqual([
      ['Hello', RED],
      [' ', BLACK],
      ['world', RED],
    ]);
    target.execute({ type: 'exitTextEdit' });
    for (const props of [
      { sizing: 'autoHeight' },
      { align: 'right' },
      { letterSpacing: 0.5 },
      { lineHeight: 2 },
    ] as const)
      oneStep(target, textPropsCommand(t, props));
    expect(node(target, 't')).toMatchObject({
      sizing: 'autoHeight',
      align: 'right',
      letterSpacing: 0.5,
      lineHeight: 2,
    });
    expect(textNodes(selectedNodes(target.query({ type: 'document' }), ['r', 't'])).length).toBe(1);
  });

  it('parses size and family; the editor refuses a family the model rejects, with its code', () => {
    expect(parseFontSize(' 12 ')).toBe(12);
    for (const bad of ['0', '-1', '4097', 'x', '']) expect(parseFontSize(bad)).toBeNull();
    expect(parseFamily('  Inter ')).toBe('Inter');
    expect(parseFamily('   ')).toBeNull();
    const target = editor();
    const before = serialized(target);
    const t = node(target, 't') as TextNodeV7;
    const result = target.execute(
      textStyleCommand(t, { start: 0, end: 11 }, { family: 'a\u0001' }),
    );
    expect(result.ok).toBe(false);
    expect(refusalText(result)).toBe('document.invalid-field /nodes/t/runs/0/family');
    expect(serialized(target)).toBe(before);
    expect(refusalText({ ok: true, ids: [] })).toBe('');
  });
});

describe('M8-R5: symbol buttons', () => {
  it('a source gets "Create instance", which selects the new instance; one undo step', () => {
    const target = editor();
    const document = target.query({ type: 'document' });
    const section = symbolSection(document, ['s']);
    expect(section).toEqual({
      kind: 'source',
      create: {
        label: 'Create instance',
        command: { type: 'createInstance', symbol: 's' },
        selectResult: true,
      },
    });
    const depth = target.getSnapshot().history.undoDepth;
    if (section?.kind !== 'source') throw new Error('not a source section');
    const result = runPropertyAction((command) => target.execute(command), section.create);
    expect(result.ok).toBe(true);
    const ids = result.ok ? result.ids : [];
    expect(target.getSnapshot().selection).toEqual(ids);
    expect(node(target, ids[0]!).type).toBe('instance');
    expect(target.getSnapshot().history.undoDepth).toBe(depth + 1);
  });

  it('an instance gets "Detach instance" and one "Reset text" per override', () => {
    const target = editor();
    const section = symbolSection(target.query({ type: 'document' }), ['i']);
    expect(section).toEqual({
      kind: 'instance',
      detach: {
        label: 'Detach instance',
        command: { type: 'detachInstances', ids: ['i'] },
        selectResult: false,
      },
      resets: [
        {
          label: 'Reset text',
          command: { type: 'clearInstanceText', id: 'i', node: 'st' },
          selectResult: false,
          node: 'st',
          name: 'node st',
        },
        {
          label: 'Reset text',
          command: { type: 'clearInstanceText', id: 'i', node: 'su' },
          selectResult: false,
          node: 'su',
          name: 'node su',
        },
      ],
    });
    if (section?.kind !== 'instance') throw new Error('not an instance section');
    oneStep(target, section.resets[0]!.command);
    target.execute({ type: 'undo' });
    expect(Object.keys((node(target, 'i') as { textOverrides: object }).textOverrides)).toEqual([
      'st',
      'su',
    ]);
    oneStep(target, section.detach.command);
    expect(node(target, 'i').type).toBe('frame');
  });

  it('shows nothing for several, no, or other nodes', () => {
    const document = parsed();
    for (const selection of [[], ['s', 'i'], ['r'], ['gone']])
      expect(symbolSection(document, selection)).toBeNull();
  });
});

describe('M8-A11 markup: one node editable, several read-only (V-25: transform aside), R5 buttons without test IDs', () => {
  it('one node: every field enabled with its value, sections by node type', () => {
    const target = editor();
    target.execute({ type: 'setSelection', ids: ['c'] });
    const html = markup(target, PropertyPanel);
    expect(html).toContain('<section aria-label="Properties" data-testid="property-panel">');
    // The appearance panel comes first, as a section of the column (M8-N3).
    expect(html.indexOf('aria-label="Appearance"')).toBeLessThan(html.indexOf('aria-label="X"'));
    expect(control(html, 'X')).toContain('value="10"');
    expect(control(html, 'X')).not.toContain('disabled');
    expect(control(html, 'W')).toContain('value="40"');
    expect(control(html, 'Rotation')).toContain('value="0"');
    expect(control(html, 'Name')).toContain('value="node c"');
    expect(control(html, 'Visible')).toContain('checked');
    expect(html).toContain('<legend>Constraints</legend>');
    expect(html).toMatch(
      /aria-label="Horizontal constraint"[^>]*><option value="start">start<\/option><option value="end" selected="">/u,
    );
    expect(html).not.toContain('<legend>Line</legend>');
    expect(html).not.toContain('<legend>Text</legend>');
    expect(html).not.toContain('Create instance');
  });

  it('several nodes: common values or "mixed", read-only but the V-25 transform box', () => {
    const target = editor();
    target.execute({ type: 'setSelection', ids: ['r', 'q', 'l'] });
    const html = markup(target, PropertySections);
    // V-25 slice 9 amends M8-R2: the transform fields show the box around the selection; X, Y
    // and the rotation (mixed here) are editable, W and H only for unrotated page-root nodes.
    const box = target.query({ type: 'handles' })!.corners[0];
    expect(control(html, 'X')).toContain(`value="${Number(box.x.toFixed(2))}"`);
    expect(control(html, 'Rotation')).toContain('placeholder="mixed"');
    expect(control(html, 'Rotation')).toContain('data-mixed="true"');
    for (const label of ['X', 'Y', 'Rotation'])
      expect(control(html, label)).not.toContain('disabled');
    expect(control(html, 'Name')).toContain('placeholder="mixed"');
    expect(control(html, 'Visible')).toContain('disabled');
    expect(control(html, 'Start arrow')).toContain('disabled');
    expect(control(html, 'End arrow')).toContain('disabled');
    for (const label of ['W', 'H', 'Name']) expect(control(html, label)).toContain('disabled');
  });

  it('text: the run fields are disabled at a collapsed caret and enabled over a selection', () => {
    const target = editor();
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 3 });
    let html = markup(target, PropertySections);
    expect(control(html, 'Font size')).toContain('disabled');
    expect(control(html, 'Font size')).toContain('value="16"');
    expect(control(html, 'Text align')).not.toContain('disabled');
    expect(control(html, 'Letter spacing')).toContain('value="0"');
    expect(control(html, 'Line height')).toContain('value="1.2"');
    target.execute({ type: 'setTextSelection', anchor: 3, focus: 9 });
    html = markup(target, PropertySections);
    expect(control(html, 'Font size')).not.toContain('disabled');
    expect(control(html, 'Font size')).toContain('placeholder="mixed"');
    expect(control(html, 'Font family')).toContain('value="Inter"');
    expect(control(html, 'Text colour')).toContain('placeholder="mixed"');
    target.execute({ type: 'exitTextEdit' });
    html = markup(target, PropertySections);
    expect(control(html, 'Text colour')).not.toContain('disabled');
  });

  it('symbol buttons by role name only, with no test ID (M8-R5)', () => {
    const target = editor();
    target.execute({ type: 'setSelection', ids: ['s'] });
    expect(markup(target, PropertySections)).toContain(
      '<button type="button">Create instance</button>',
    );
    target.execute({ type: 'setSelection', ids: ['i'] });
    const html = markup(target, PropertySections);
    expect(html).toContain('<button type="button">Detach instance</button>');
    // Each override's row is a group named by its source text node, so a spec narrows to one
    // "Reset text" button by its group (review follow-up 1).
    for (const name of ['node st', 'node su'])
      expect(html).toContain(
        `<div role="group" aria-label="${name}" style="display:flex;gap:4px;align-items:center;flex-wrap:wrap"><span>${name}</span><button type="button">Reset text</button></div>`,
      );
    const buttons = html.match(/<button[^>]*>/gu) ?? [];
    expect(buttons.length).toBe(3);
    expect(buttons.every((tag) => !tag.includes('data-testid'))).toBe(true);
  });

  it('no selection renders no property sections', () => {
    const target = editor();
    expect(markup(target, PropertySections)).toBe('');
  });
});
