import { validateDocument, validateNode, type NodeV8, type DocumentV8 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type ExtensionTool,
  type ToolApi,
} from '../../packages/editor-core/src/index.js';

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md), V39-A02 (section 3 commands,
// E3 failure order, one undo step, E1 resync across pages), V39-A03 (E4 detach on edit) and
// V39-A06 (E5 paste). After every command the document passes `validateDocument`.

const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };
const green = { r: 0, g: 1, b: 0, a: 1 };
const none = { shift: false, alt: false, meta: false, ctrl: false };
const gradient = {
  kind: 'linear' as const,
  transform: [1, 0, 0, 1, 0, 0] as const,
  stops: [
    { offset: 0, color: red },
    { offset: 1, color: blue },
  ],
  spread: 'pad' as const,
};

/** The gesture API of the `ext.hold` tool, captured on its first press. */
let held: ToolApi | null = null;
const holdTool: ExtensionTool = {
  id: 'ext.hold',
  input(event, api) {
    if (event.kind !== 'pointerdown') return false;
    held = api;
    return true;
  },
  reset() {},
};

function editor(): Editor {
  const target = createEditor({
    ids: createCounterIdSource('n'),
    extensions: [{ id: 'ext.hold', tools: [holdTool] }],
  });
  ok(target, { type: 'setSnapping', enabled: false });
  return target;
}

function doc(target: Editor): DocumentV8 {
  return target.query({ type: 'document' });
}

/** Runs a command; the document is valid after it, whatever the result. */
function run(target: Editor, command: Command): CommandResult {
  const result = target.execute(command);
  const check = validateDocument(JSON.parse(JSON.stringify(doc(target))));
  expect(check.ok ? null : check, `validateDocument after ${command.type}`).toBeNull();
  return result;
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = run(target, command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function failure(target: Editor, command: Command) {
  const result = run(target, command);
  return result.ok ? null : { code: result.code, ...(result.path ? { path: result.path } : {}) };
}

function node(target: Editor, id: string): NodeV8 {
  return target.query({ type: 'node', id })!;
}

function depth(target: Editor): number {
  return target.query({ type: 'history' }).undoDepth;
}

/** A rectangle with a red fill and a blue stroke of width 2. */
function rect(target: Editor, x = 0): string {
  const [id] = ok(target, {
    type: 'createRectangle',
    frame: { x, y: 0, width: 10, height: 10 },
    fill: red,
  });
  ok(target, { type: 'setStyle', ids: [id!], style: { stroke: { color: blue, width: 2 } } });
  return id!;
}

function text(target: Editor): string {
  return ok(target, {
    type: 'createText',
    frame: { x: 50, y: 0, width: 40, height: 20 },
    runs: [
      { text: 'a', family: 'Inter', size: 12, color: red },
      { text: 'b', family: 'Inter', size: 14, color: red },
    ],
    sizing: 'fixed',
  })[0]!;
}

function style(target: Editor, paint: object = red, name = 'Brand/Red'): string {
  return ok(target, { type: 'createColorStyle', name, paint } as Command)[0]!;
}

function variable(target: Editor, kind: 'color' | 'number', value: unknown, name = 'V'): string {
  return ok(target, { type: 'createVariable', name, kind, value } as Command)[0]!;
}

function bind(target: Editor, ids: string[], key: string, ref: object | null) {
  return run(target, { type: 'bindProperty', ids, key, ref } as Command);
}

describe('V39-A02 colour style commands', () => {
  it('creates, binds, resyncs across pages, renames and removes, one step each', () => {
    const target = editor();
    const a = rect(target);
    const [page2] = ok(target, { type: 'addPage', name: 'Two' });
    ok(target, { type: 'setActivePage', id: page2! });
    const b = rect(target);
    ok(target, { type: 'setActivePage', id: doc(target).pages[0]!.id });

    let before = depth(target);
    const s = style(target, green);
    expect(doc(target).colorStyles).toEqual([{ id: s, name: 'Brand/Red', paint: green }]);
    expect(depth(target)).toBe(before + 1);

    // Bind on page 1; page 2's node is bound from its own page.
    expect(bind(target, [a], 'fill', { style: s })).toMatchObject({ ok: true, ids: [a] });
    expect(node(target, a)).toMatchObject({ fill: green, bindings: { fill: { style: s } } });
    ok(target, { type: 'setActivePage', id: page2! });
    bind(target, [b], 'stroke', { style: s });
    expect(node(target, b)).toMatchObject({ stroke: { color: green, width: 2 } });

    // E1: a repaint rewrites every bound node on every page, as one step.
    before = depth(target);
    ok(target, { type: 'updateColorStyle', id: s, paint: blue });
    expect(depth(target)).toBe(before + 1);
    expect(node(target, a)).toMatchObject({ fill: blue, bindings: { fill: { style: s } } });
    expect(node(target, b)).toMatchObject({
      stroke: { color: blue },
      bindings: { stroke: { style: s } },
    });
    ok(target, { type: 'undo' });
    expect(node(target, a)).toMatchObject({ fill: green });
    expect(node(target, b)).toMatchObject({ stroke: { color: green } });
    ok(target, { type: 'redo' });

    // A gradient style on a fill and a stroke.
    ok(target, { type: 'updateColorStyle', id: s, paint: gradient });
    expect(node(target, a)).toMatchObject({ fill: gradient, bindings: { fill: { style: s } } });

    // A rename changes no node; the same name records no step.
    ok(target, { type: 'updateColorStyle', id: s, name: 'Brand/Main' });
    before = depth(target);
    ok(target, { type: 'updateColorStyle', id: s, name: 'Brand/Main' });
    expect(depth(target)).toBe(before);

    // Remove: the users keep their values, detached; the table goes away with its last style.
    ok(target, { type: 'removeColorStyle', id: s });
    expect(doc(target).colorStyles).toBeUndefined();
    expect(node(target, a)).toMatchObject({ fill: gradient });
    expect(node(target, a).bindings).toBeUndefined();
    expect(node(target, b).bindings).toBeUndefined();
    ok(target, { type: 'undo' });
    expect(node(target, a).bindings).toEqual({ fill: { style: s } });
  });

  it('fails in E3 order', () => {
    const target = editor();
    const a = rect(target);
    const t = text(target);
    const s = style(target);
    const g = style(target, gradient, 'Gradient');
    expect(failure(target, { type: 'createColorStyle', name: '', paint: red })).toEqual({
      code: 'editor.invalid-command',
      path: '/name',
    });
    expect(
      failure(target, { type: 'createColorStyle', name: 'x'.repeat(201), paint: red }),
    ).toMatchObject({ path: '/name' });
    expect(
      failure(target, { type: 'createColorStyle', name: 'X', paint: { r: 2, g: 0, b: 0, a: 1 } }),
    ).toEqual({ code: 'editor.invalid-command', path: '/paint' });
    expect(failure(target, { type: 'updateColorStyle', id: 'zz', name: '' })).toMatchObject({
      path: '/name',
    });
    expect(failure(target, { type: 'updateColorStyle', id: 'zz', name: 'Y' })).toEqual({
      code: 'editor.unknown-style',
    });
    expect(failure(target, { type: 'removeColorStyle', id: 'zz' })).toEqual({
      code: 'editor.unknown-style',
    });
    // A gradient style cannot bind text; a style bound to text cannot become a gradient.
    expect(bind(target, [t], 'text', { style: g })).toMatchObject({ code: 'editor.binding-type' });
    bind(target, [t], 'text', { style: s });
    expect(failure(target, { type: 'updateColorStyle', id: s, paint: gradient })).toEqual({
      code: 'editor.binding-type',
    });
    // A style on a number key.
    expect(bind(target, [a], 'opacity', { style: s })).toMatchObject({
      code: 'editor.binding-type',
    });
  });
});

describe('V39-A02 variable and mode commands', () => {
  it('creates a set with Mode 1, adds and switches modes, recolouring text and opacity', () => {
    const target = editor();
    const a = rect(target);
    const t = text(target);
    const v = variable(target, 'color', red, 'Primary');
    const set = doc(target).variables!;
    expect(set.modes).toHaveLength(1);
    expect(set.modes[0]!.name).toBe('Mode 1');
    const m1 = set.mode;
    expect(set.items).toEqual([{ id: v, name: 'Primary', type: 'color', values: { [m1]: red } }]);

    const [m2] = ok(target, { type: 'addVariableMode', name: 'Dark' });
    expect(doc(target).variables!.items[0]!.values).toEqual({ [m1]: red, [m2!]: red });
    ok(target, { type: 'updateVariable', id: v, values: { [m2!]: blue } });
    const o = variable(target, 'number', 1, 'Opacity');
    ok(target, { type: 'updateVariable', id: o, values: { [m2!]: 0.5 } });

    // The text binding recolours every run; equal runs do not merge (sizes differ).
    expect(bind(target, [t], 'text', { variable: v })).toMatchObject({ ok: true, ids: [t] });
    expect(bind(target, [a], 'fill', { variable: v })).toMatchObject({ ok: true, ids: [a] });
    expect(bind(target, [a], 'opacity', { variable: o })).toMatchObject({ ok: true, ids: [a] });
    expect(node(target, a).bindings).toEqual({ fill: { variable: v }, opacity: { variable: o } });

    const before = depth(target);
    ok(target, { type: 'setVariableMode', id: m2! });
    expect(depth(target)).toBe(before + 1);
    expect(node(target, a)).toMatchObject({ fill: blue, opacity: 0.5 });
    const runs = (node(target, t) as unknown as { runs: { color: unknown }[] }).runs;
    expect(runs.map((run) => run.color)).toEqual([blue, blue]);
    expect(node(target, t).bindings).toEqual({ text: { variable: v } });

    // Removing the active mode moves to the first remaining one and resyncs.
    ok(target, { type: 'removeVariableMode', id: m2! });
    expect(doc(target).variables!.mode).toBe(m1);
    expect(node(target, a)).toMatchObject({ fill: red, opacity: 1 });
    expect(failure(target, { type: 'removeVariableMode', id: m1 })).toEqual({
      code: 'editor.last-mode',
    });
    ok(target, { type: 'undo' });
    expect(doc(target).variables!.mode).toBe(m2);
    expect(node(target, a)).toMatchObject({ fill: blue, opacity: 0.5 });

    ok(target, { type: 'renameVariableMode', id: m1, name: 'Light' });
    expect(doc(target).variables!.modes[0]).toEqual({ id: m1, name: 'Light' });

    // Removing a variable detaches its users; the last one removes the set.
    ok(target, { type: 'removeVariable', id: o });
    expect(node(target, a).bindings).toEqual({ fill: { variable: v } });
    expect(node(target, a).opacity).toBe(0.5);
    ok(target, { type: 'removeVariable', id: v });
    expect(doc(target).variables).toBeUndefined();
    expect(node(target, t).bindings).toBeUndefined();
  });

  it('a binding to text merges runs that become equal', () => {
    const target = editor();
    const [t] = ok(target, {
      type: 'createText',
      frame: { x: 0, y: 0, width: 40, height: 20 },
      runs: [
        { text: 'a', family: 'Inter', size: 12, color: red },
        { text: 'b', family: 'Inter', size: 12, color: green },
      ],
      sizing: 'fixed',
    });
    const v = variable(target, 'color', blue);
    bind(target, [t!], 'text', { variable: v });
    expect((node(target, t!) as unknown as { runs: unknown[] }).runs).toEqual([
      { text: 'ab', family: 'Inter', size: 12, color: blue },
    ]);
  });

  it('fails in E3 order', () => {
    const target = editor();
    const a = rect(target);
    expect(
      failure(target, { type: 'createVariable', name: 'X', kind: 'size', value: 1 } as never),
    ).toEqual({ code: 'editor.invalid-command', path: '/kind' });
    expect(
      failure(target, { type: 'createVariable', name: 'X', kind: 'number', value: red } as never),
    ).toEqual({ code: 'editor.invalid-command', path: '/value' });
    expect(failure(target, { type: 'addVariableMode', name: 'M' })).toEqual({
      code: 'editor.unknown-mode',
    });
    expect(failure(target, { type: 'updateVariable', id: 'zz' })).toEqual({
      code: 'editor.unknown-variable',
    });
    const o = variable(target, 'number', 1);
    expect(failure(target, { type: 'updateVariable', id: o, values: { zz: 1 } })).toEqual({
      code: 'editor.unknown-mode',
    });
    expect(
      failure(target, { type: 'updateVariable', id: o, values: { zz: 'x' } } as never),
    ).toEqual({ code: 'editor.invalid-command', path: '/values/zz' });
    expect(failure(target, { type: 'setVariableMode', id: 'zz' })).toEqual({
      code: 'editor.unknown-mode',
    });
    expect(failure(target, { type: 'renameVariableMode', id: 'zz', name: 'Q' })).toEqual({
      code: 'editor.unknown-mode',
    });
    // Range: in the active mode, then in any mode, at bind and at update.
    const mode = doc(target).variables!.mode;
    bind(target, [a], 'opacity', { variable: o });
    expect(failure(target, { type: 'updateVariable', id: o, values: { [mode]: 2 } })).toEqual({
      code: 'editor.binding-range',
    });
    const [m2] = ok(target, { type: 'addVariableMode', name: 'Two' });
    const w = variable(target, 'number', 0.5, 'W');
    ok(target, { type: 'updateVariable', id: w, values: { [m2!]: 3 } });
    expect(bind(target, [a], 'opacity', { variable: w })).toMatchObject({
      code: 'editor.binding-range',
    });
    // strokeWidth has no upper bound.
    expect(bind(target, [a], 'strokeWidth', { variable: w })).toMatchObject({ ok: true });
    // 16 modes, then the limit.
    for (let i = 2; i < 16; i += 1) ok(target, { type: 'addVariableMode', name: `M${i}` });
    expect(failure(target, { type: 'addVariableMode', name: 'M16' })).toEqual({
      code: 'editor.table-limit',
    });
  });
});

describe('V39-A02 bindProperty', () => {
  it('fails in E3 order and binds only carriers', () => {
    const target = editor();
    const a = rect(target);
    const t = text(target);
    const s = style(target, green);
    const n = variable(target, 'number', 0.5);
    const cases: [object, object][] = [
      [
        { ids: [], key: 'fill', ref: { style: s } },
        { code: 'editor.invalid-command', path: '/ids' },
      ],
      [{ ids: [a, a], key: 'fill', ref: { style: s } }, { path: '/ids' }],
      [{ ids: [a], key: 'shadow', ref: { style: s } }, { path: '/key' }],
      [{ ids: [a], key: 'fill', ref: { style: s, variable: n } }, { path: '/ref' }],
      [{ ids: [a], key: 'fill', ref: {} }, { path: '/ref' }],
      [{ ids: ['zz'], key: 'fill', ref: { style: 'zz' } }, { code: 'editor.unknown-node' }],
      [{ ids: [t], key: 'cornerRadius', ref: { style: 'zz' } }, { path: '/key' }],
      [{ ids: [a], key: 'fill', ref: { style: 'zz' } }, { code: 'editor.unknown-style' }],
      [{ ids: [a], key: 'fill', ref: { variable: 'zz' } }, { code: 'editor.unknown-variable' }],
      [{ ids: [a], key: 'fill', ref: { variable: n } }, { code: 'editor.binding-type' }],
    ];
    for (const [command, expected] of cases) {
      expect(
        run(target, { type: 'bindProperty', ...command } as Command),
        JSON.stringify(command),
      ).toMatchObject({ ok: false, ...expected });
    }
    // A mixed selection binds the nodes that carry the key and skips the others.
    expect(bind(target, [a, t], 'fill', { style: s })).toMatchObject({ ok: true, ids: [a] });
    expect(node(target, t).bindings).toBeUndefined();
    // `null` detaches and keeps the value; detaching nothing records no step.
    expect(bind(target, [a], 'fill', null)).toMatchObject({ ok: true, ids: [a] });
    expect(node(target, a)).toMatchObject({ fill: green });
    expect(node(target, a).bindings).toBeUndefined();
    const before = depth(target);
    expect(bind(target, [a], 'fill', null)).toMatchObject({ ok: true, ids: [] });
    expect(depth(target)).toBe(before);
  });

  it('a stroke binding gives a null stroke the default; strokeWidth needs a stroke', () => {
    const target = editor();
    const [r] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      fill: null,
      stroke: null,
    });
    const s = style(target, green);
    const w = variable(target, 'number', 3);
    expect(bind(target, [r!], 'strokeWidth', { variable: w })).toMatchObject({ path: '/key' });
    bind(target, [r!], 'fill', { style: s });
    bind(target, [r!], 'stroke', { style: s });
    expect(node(target, r!)).toMatchObject({ fill: green, stroke: { color: green } });
    bind(target, [r!], 'strokeWidth', { variable: w });
    bind(target, [r!], 'cornerRadius', { variable: w });
    expect(node(target, r!)).toMatchObject({
      stroke: { width: 3 },
      cornerRadii: [3, 3, 3, 3],
      bindings: {
        fill: { style: s },
        stroke: { style: s },
        strokeWidth: { variable: w },
        cornerRadius: { variable: w },
      },
    });
    // Canonical key order.
    expect(Object.keys(node(target, r!).bindings!)).toEqual([
      'fill',
      'stroke',
      'strokeWidth',
      'cornerRadius',
    ]);
  });

  it('binds nodes of the active page only', () => {
    const target = editor();
    const a = rect(target);
    const s = style(target);
    const [page2] = ok(target, { type: 'addPage' });
    ok(target, { type: 'setActivePage', id: page2! });
    expect(bind(target, [a], 'fill', { style: s })).toMatchObject({
      code: 'editor.unknown-node',
    });
  });
});

/** A rectangle bound on every key it can carry. */
function boundRect(target: Editor) {
  const a = rect(target);
  const s = style(target, green);
  const v = variable(target, 'number', 0.5);
  const w = variable(target, 'number', 4, 'W');
  bind(target, [a], 'fill', { style: s });
  bind(target, [a], 'stroke', { style: s });
  bind(target, [a], 'strokeWidth', { variable: w });
  bind(target, [a], 'opacity', { variable: v });
  bind(target, [a], 'cornerRadius', { variable: w });
  return { a, s, v, w };
}

const keysOf = (target: Editor, id: string) => Object.keys(node(target, id).bindings ?? {});

describe('V39-A03 detach on edit (E4)', () => {
  it.each([
    ['a fill', { fill: red }, 'fill'],
    ['a stroke colour', { stroke: { color: red } }, 'stroke'],
    ['a stroke width', { stroke: { width: 1 } }, 'strokeWidth'],
    ['opacity', { opacity: 0.3 }, 'opacity'],
    ['corner radii', { cornerRadii: [1, 1, 1, 1] }, 'cornerRadius'],
  ])('setStyle on %s drops that binding only, and undo restores it', (_name, styleProps, key) => {
    const target = editor();
    const { a } = boundRect(target);
    const all = keysOf(target, a);
    ok(target, { type: 'setStyle', ids: [a], style: styleProps } as Command);
    expect(keysOf(target, a)).toEqual(all.filter((k) => k !== key));
    ok(target, { type: 'undo' });
    expect(keysOf(target, a)).toEqual(all);
  });

  it('setting a value equal to the bound one keeps the binding', () => {
    const target = editor();
    const { a } = boundRect(target);
    const all = keysOf(target, a);
    ok(target, { type: 'setNodeProps', id: a, props: { opacity: 0.5, name: 'Box' } });
    expect(keysOf(target, a)).toEqual(all);
  });

  it('setNodeProps opacity and one differing radius detach', () => {
    const target = editor();
    const { a } = boundRect(target);
    ok(target, { type: 'setNodeProps', id: a, props: { opacity: 0.9 } });
    expect(keysOf(target, a)).not.toContain('opacity');
    ok(target, { type: 'setNodeProps', id: a, props: { cornerRadii: [4, 4, 4, 0] } });
    expect(keysOf(target, a)).not.toContain('cornerRadius');
  });

  it('removing a stroke drops stroke and strokeWidth', () => {
    const target = editor();
    const { a } = boundRect(target);
    ok(target, { type: 'setStyle', ids: [a], style: { stroke: null } });
    expect(keysOf(target, a)).toEqual(['fill', 'opacity', 'cornerRadius']);
  });

  it('a gesture update of a bound property detaches it; cancel restores', () => {
    const target = editor();
    const { a } = boundRect(target);
    ok(target, { type: 'setTool', tool: 'ext.hold' });
    ok(target, {
      type: 'input',
      event: { kind: 'pointerdown', point: { x: 500, y: 500 }, modifiers: none },
    });
    const gesture = held!.gesture;
    expect(gesture.begin()).toBe(true);
    expect(gesture.update({ type: 'setStyle', ids: [a], style: { opacity: 0.2 } }).ok).toBe(true);
    expect(keysOf(target, a)).not.toContain('opacity');
    gesture.cancel();
    expect(keysOf(target, a)).toContain('opacity');
    expect(gesture.begin()).toBe(true);
    gesture.update({ type: 'setStyle', ids: [a], style: { stroke: { width: 9 } } });
    gesture.commit();
    expect(keysOf(target, a)).toEqual(['fill', 'stroke', 'opacity', 'cornerRadius']);
    ok(target, { type: 'undo' });
    expect(keysOf(target, a)).toContain('strokeWidth');
  });

  it('setTextStyle on a run colour detaches text; a size change does not', () => {
    const target = editor();
    const t = text(target);
    const s = style(target, green);
    bind(target, [t], 'text', { style: s });
    ok(target, { type: 'setTextStyle', id: t, start: 0, end: 1, style: { size: 20 } });
    expect(keysOf(target, t)).toEqual(['text']);
    ok(target, { type: 'setTextStyle', id: t, start: 0, end: 1, style: { color: red } });
    expect(keysOf(target, t)).toEqual([]);
  });

  it('a flip mirrors a gradient and detaches its style; a solid style stays', () => {
    const target = editor();
    const a = rect(target);
    const g = style(target, gradient, 'G');
    const s = style(target, green, 'S');
    bind(target, [a], 'fill', { style: g });
    bind(target, [a], 'stroke', { style: s });
    ok(target, { type: 'setSelection', ids: [a] });
    const drag = (x: number, kind: 'pointerdown' | 'pointermove' | 'pointerup') =>
      ok(target, { type: 'input', event: { kind, point: { x, y: 5 }, modifiers: none } });
    // The right edge handle (10, 5) past the left edge: a horizontal flip.
    drag(10, 'pointerdown');
    drag(5, 'pointermove');
    drag(-10, 'pointermove');
    drag(-10, 'pointerup');
    expect(node(target, a).frame.x).toBe(-10);
    expect(keysOf(target, a)).toEqual(['stroke']);
  });

  it('duplicate, detach and boolean carry the bindings that still hold', () => {
    const target = editor();
    const { a, s } = boundRect(target);
    const [copy] = ok(target, { type: 'duplicateNodes', ids: [a] });
    expect(node(target, copy!).bindings).toEqual(node(target, a).bindings);

    // Boolean: a path carries fill, stroke, strokeWidth and opacity, not cornerRadius.
    const b = rect(target, 5);
    const [result] = ok(target, { type: 'booleanNodes', ids: [a, b], op: 'union' });
    expect(keysOf(target, result!)).toEqual(['fill', 'stroke', 'opacity', 'strokeWidth']);
    ok(target, { type: 'undo' });

    // Detach: the instance's copy of the source carries the source's bindings.
    const [symbol] = ok(target, { type: 'createSymbol', ids: [copy!] });
    const [instance] = ok(target, { type: 'createInstance', symbol: symbol! });
    // The instance keeps its ID and becomes a frame.
    ok(target, { type: 'detachInstances', ids: [instance!] });
    const detached = doc(target).nodes[instance!]!;
    const child = 'children' in detached ? detached.children[0]! : '';
    expect(node(target, child).bindings).toMatchObject({ fill: { style: s } });
  });
});

describe('V39-A06 paste (E5)', () => {
  it('keeps bindings within a document and drops them in one without the tables', () => {
    const from = editor();
    const { a } = boundRect(from);
    ok(from, { type: 'copy', ids: [a] });
    const [pasted] = ok(from, { type: 'paste' });
    expect(node(from, pasted!).bindings).toEqual(node(from, a).bindings);

    const text = from.query({ type: 'clipboard' })!;
    const into = editor();
    const [other] = ok(into, { type: 'paste', text });
    expect(node(into, other!).bindings).toBeUndefined();
    expect(node(into, other!)).toMatchObject({ fill: green, opacity: 0.5 });
    expect(doc(into).colorStyles).toBeUndefined();
  });

  it('keeps a binding whose ID exists in the target only if the value holds', () => {
    const from = editor();
    const { a } = boundRect(from);
    ok(from, { type: 'copy', ids: [a] });
    const text = from.query({ type: 'clipboard' })!;
    // Same ID source, so the target's first style has the same ID, with another paint.
    const into = editor();
    rect(into);
    const s = style(into, blue);
    expect(node(from, a).bindings!.fill).toEqual({ style: s });
    const [other] = ok(into, { type: 'paste', text });
    expect(node(into, other!).bindings?.fill).toBeUndefined();
  });
});

describe('V-39 review r1 follow-ups', () => {
  it('new node IDs skip style, variable and mode IDs (S3), also when the counter restarts', () => {
    const first = editor();
    const a = rect(first);
    style(first);
    variable(first, 'number', 1);
    const saved = doc(first);
    const ids = new Set([
      ...saved.colorStyles!.map((entry) => entry.id),
      ...saved.variables!.items.map((entry) => entry.id),
      ...saved.variables!.modes.map((entry) => entry.id),
    ]);
    // A new session: the same counter, so duplicate, paste and detach meet the table IDs.
    const target = createEditor({ ids: createCounterIdSource('n'), document: saved });
    for (let i = 0; i < 4; i += 1) ok(target, { type: 'duplicateNodes', ids: [a] });
    ok(target, { type: 'copy', ids: [a] });
    ok(target, { type: 'paste' });
    const [symbol] = ok(target, { type: 'createSymbol', ids: [a] });
    const [instance] = ok(target, { type: 'createInstance', symbol: symbol! });
    ok(target, { type: 'detachInstances', ids: [instance!] });
    for (const id of Object.keys(doc(target).nodes)) expect(ids.has(id), id).toBe(false);
  });

  it('a detached frame carries the bindings that still hold', () => {
    const target = editor();
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 20, height: 20 },
    });
    const s = style(target, green);
    const v = variable(target, 'number', 1);
    bind(target, [frame!], 'fill', { style: s });
    const [symbol] = ok(target, { type: 'createSymbol', ids: [frame!] });
    const [instance] = ok(target, { type: 'createInstance', symbol: symbol! });
    bind(target, [instance!], 'opacity', { variable: v });
    ok(target, { type: 'detachInstances', ids: [instance!] });
    expect(node(target, instance!).bindings).toEqual({
      fill: { style: s },
      opacity: { variable: v },
    });
  });

  it('createVariable draws distinct mode and variable IDs', () => {
    const queue = ['a', 'a', 'a', 'b'];
    const target = createEditor({
      ids: () => queue.shift() ?? `z${queue.length}`,
      document: {
        schemaVersion: 8,
        id: 'd',
        pages: [{ id: 'p', name: 'Page 1', children: [] }],
        nodes: {},
      },
    });
    const [id] = ok(target, { type: 'createVariable', name: 'X', kind: 'number', value: 1 });
    expect(id).toBe('b');
    expect(doc(target).variables!.mode).toBe('a');
  });

  it('checks every value before mode keys, and reference IDs by the ID rule', () => {
    const target = editor();
    const a = rect(target);
    const o = variable(target, 'number', 1);
    expect(
      failure(target, { type: 'updateVariable', id: o, values: { aa: 2, zz: 'bad' } } as never),
    ).toEqual({ code: 'editor.invalid-command', path: '/values/zz' });
    expect(bind(target, [a], 'fill', { style: '' })).toMatchObject({ path: '/ref' });
    const bad = { ...node(target, a), bindings: { fill: { style: 'a\u0000' } } };
    expect(validateNode(bad)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/bindings/fill',
    });
  });
});

describe('V-39 review r2 follow-up', () => {
  it('an instance pasted as a frame carries its source paint bindings', () => {
    const from = editor();
    const s = style(from, green);
    const [frame] = ok(from, { type: 'createFrame', frame: { x: 0, y: 0, width: 20, height: 20 } });
    bind(from, [frame!], 'fill', { style: s });
    const [symbol] = ok(from, { type: 'createSymbol', ids: [frame!] });
    const [instance] = ok(from, { type: 'createInstance', symbol: symbol! });
    ok(from, { type: 'copy', ids: [instance!] });
    const text = from.query({ type: 'clipboard' })!;
    // The target has the same style ID and paint, and not the symbol.
    const into = editor();
    expect(style(into, green)).toBe(s);
    const [pasted] = ok(into, { type: 'paste', text });
    expect(node(into, pasted!)).toMatchObject({ type: 'frame', bindings: { fill: { style: s } } });
  });
});
