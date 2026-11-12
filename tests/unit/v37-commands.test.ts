// V-37 U3 (docs/plans/viz-v37-variants-overrides-contract.md, sections 2.1, 4.1, 4.2, 5 and 6.4):
// the variant and override commands, the set rules of the editor, key and set upkeep, adoption and
// the clipboard of overridden instances (V37-A06, A07, A08, A10).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateDocument, serializeDocument, type DocumentV8 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
} from '../../packages/editor-core/src/index.js';
import { adoptionOwner, dropAdoption } from '../../packages/editor-core/src/adopt.js';
import { distinctVariant, valueFromName } from '../../packages/editor-core/src/variant-names.js';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- fixtures are edited as untyped JSON */
type Json = Record<string, any>;
const GOOD = readFileSync(
  path.resolve(import.meta.dirname, '../fixtures/v37-variants/variants.v8.json'),
  'utf8',
);
const GREEN = { r: 0, g: 1, b: 0, a: 1 };
const RED = { r: 1, g: 0, b: 0, a: 1 };

const rect = (id: string, parent: string, x = 0, y = 0, w = 10, h = 10): Json => ({
  id,
  name: id,
  parent,
  frame: { x, y, width: w, height: h },
  rotation: 0,
  constraints: { horizontal: 'start', vertical: 'start' },
  opacity: 1,
  visible: true,
  type: 'rectangle',
  cornerRadii: [0, 0, 0, 0],
  fill: RED,
  stroke: null,
  effects: [],
});
const symbol = (id: string, parent: string, children: string[], x = 0, y = 0, name = id): Json => ({
  ...rect(id, parent, x, y, 100, 40),
  name,
  type: 'symbol',
  children,
  stroke: null,
  fill: null,
  cornerRadii: undefined,
});

/** The variants fixture after `edit`. */
function build(edit: (value: Json) => void = () => {}): DocumentV8 {
  const value = JSON.parse(GOOD) as Json;
  edit(value);
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}
function editorOf(document: DocumentV8 = build()): Editor {
  return createEditor({ document, ids: createCounterIdSource('n') });
}
const docOf = (target: Editor): DocumentV8 => target.query({ type: 'document' });
const textOf = (target: Editor): string => serializeDocument(docOf(target));
const depth = (target: Editor) => target.query({ type: 'history' }).undoDepth;

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  expect(validateDocument(JSON.parse(textOf(target))).ok).toBe(true);
  return result.ids;
}
/** Expects `failure` and no change to the document or the history. */
function fails(target: Editor, command: Command, code: string, at?: string): void {
  const before = docOf(target);
  const steps = depth(target);
  const result: CommandResult = target.execute(command);
  expect(result).toEqual({ ok: false, code, ...(at === undefined ? {} : { path: at }) });
  expect(docOf(target)).toBe(before);
  expect(depth(target)).toBe(steps);
}
/** Runs `command` as one undo step whose undo restores the document byte for byte. */
function oneStep(target: Editor, command: Command): readonly string[] {
  const before = textOf(target);
  const steps = depth(target);
  const ids = ok(target, command);
  expect(depth(target)).toBe(steps + 1);
  const after = textOf(target);
  ok(target, { type: 'undo' });
  expect(textOf(target)).toBe(before);
  ok(target, { type: 'redo' });
  expect(textOf(target)).toBe(after);
  return ids;
}
const node = (target: Editor, id: string): Json => docOf(target).nodes[id] as unknown as Json;

/** Three loose symbols `a` (named Hover), `b`, `c` on a page, with two instances of `a`. */
function loose(): DocumentV8 {
  const value: Json = {
    schemaVersion: 8,
    id: 'd',
    pages: [{ id: 'p', name: 'P', children: ['a', 'b', 'c', 'x', 'i'] }],
    nodes: {
      a: symbol('a', 'p', ['ar'], 0, 0, 'Hover'),
      ar: rect('ar', 'a', 0, 0, 20, 20),
      b: symbol('b', 'p', ['br'], 200, 0, 'Hover'),
      br: rect('br', 'b', 0, 0, 20, 20),
      c: symbol('c', 'p', [], 400, 0, 'Pressed\u0007 state'),
      x: rect('x', 'p', 0, 300),
      i: {
        ...rect('i', 'p', 0, 100, 100, 40),
        type: 'instance',
        symbol: 'a',
        textOverrides: {},
        cornerRadii: undefined,
        fill: undefined,
        stroke: undefined,
      },
    },
  };
  for (const key of Object.keys(value.nodes)) {
    for (const field of Object.keys(value.nodes[key])) {
      if (value.nodes[key][field] === undefined) delete value.nodes[key][field];
    }
  }
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

describe('V37-N1 and V37-N2 names', () => {
  it('derives a value from a name', () => {
    expect(valueFromName('Hover')).toBe('Hover');
    expect(valueFromName('Pre\u0007ss\u0085ed')).toBe('Pressed');
    expect(valueFromName('A\ud800B\udc00C')).toBe('ABC');
    expect(valueFromName('\u0001\ud800')).toBe('Variant');
    expect(valueFromName('')).toBe('Variant');
    expect(valueFromName('x'.repeat(100))).toBe('x'.repeat(60));
    // A pair is never split at the cut: 59 units and a pair end at 61, so the pair goes.
    expect(valueFromName(`${'x'.repeat(59)}😀`)).toBe('x'.repeat(59));
    expect(valueFromName(`${'x'.repeat(58)}😀`)).toBe(`${'x'.repeat(58)}😀`);
  });

  it('suffixes a repeated tuple by the smallest number, the value cut first', () => {
    const seen = new Set<string>();
    const names = ['Hover', 'Hover', 'Hover', 'Hover 2'];
    const out = names.map((value) => distinctVariant({ 'Property 1': value }, seen));
    expect(out.map((v) => v['Property 1'])).toEqual(['Hover', 'Hover 2', 'Hover 3', 'Hover 2 2']);
    const long = new Set<string>();
    distinctVariant({ P: 'v'.repeat(64) }, long);
    const cut = distinctVariant({ P: 'v'.repeat(64) }, long);
    expect(cut.P).toBe(`${'v'.repeat(62)} 2`);
    expect(cut.P!.length).toBe(64);
  });
});

describe('V37-A06 combineAsVariants', () => {
  it('wraps the symbols in a set, names the variants and keeps their page placement', () => {
    const target = editorOf(loose());
    const [id] = oneStep(target, { type: 'combineAsVariants', ids: ['a', 'b', 'c'] });
    const document = docOf(target);
    const set = document.nodes[id!] as Json;
    expect(set).toMatchObject({
      type: 'symbolSet',
      name: 'Component set',
      parent: 'p',
      rotation: 0,
      children: ['a', 'b', 'c'],
      fill: null,
      constraints: { horizontal: 'start', vertical: 'start' },
    });
    // The union of the visual bounds (0..500, 0..40) grown by 20.
    expect(set.frame).toEqual({ x: -20, y: -20, width: 540, height: 80 });
    expect(set.stroke).toMatchObject({
      width: 1,
      dash: { pattern: [4, 4], phase: 0 },
      color: { r: 0x97 / 255, g: 0x47 / 255, b: 1, a: 1 },
    });
    expect(document.pages[0]!.children).toEqual([id, 'x', 'i']);
    // Page placement kept: parent-local frame plus the set's origin.
    expect((document.nodes.b as Json).frame).toMatchObject({ x: 220, y: 20 });
    expect((document.nodes.a as Json).variant).toEqual({ 'Property 1': 'Hover' });
    expect((document.nodes.b as Json).variant).toEqual({ 'Property 1': 'Hover 2' });
    expect((document.nodes.c as Json).variant).toEqual({ 'Property 1': 'Pressed state' });
    // Instances stay linked.
    expect((document.nodes.i as Json).symbol).toBe('a');
  });

  it('takes the topmost symbol paint slot and draws one ID', () => {
    const target = editorOf(loose());
    expect(ok(target, { type: 'combineAsVariants', ids: ['c', 'a'] })).toEqual(['n1']);
    const set = node(target, 'n1');
    expect(set.children).toEqual(['a', 'c']);
    expect(docOf(target).pages[0]!.children).toEqual(['b', 'n1', 'x', 'i']);
  });

  it('fails with its codes in order, drawing no ID', () => {
    const target = editorOf(loose());
    const bad = (ids: unknown) => ({ type: 'combineAsVariants', ids }) as unknown as Command;
    fails(target, bad('a'), 'editor.invalid-command', '/ids');
    fails(target, bad(['a']), 'editor.invalid-command', '/ids');
    fails(target, bad(['a', 'a']), 'editor.invalid-command', '/ids');
    fails(target, bad(['a', 5]), 'editor.invalid-command', '/ids');
    fails(target, bad(['a', 'zz']), 'editor.unknown-node');
    fails(target, bad(['a', 'x']), 'editor.not-a-symbol');
    // A symbol in another parent is no sibling.
    ok(target, { type: 'createFrame', frame: { x: 0, y: 600, width: 200, height: 200 } });
    const holder = docOf(target).pages[0]!.children.at(-1)!;
    ok(target, {
      type: 'createRectangle',
      frame: { x: 10, y: 610, width: 5, height: 5 },
      parent: holder,
    });
    const inner = (node(target, holder).children as string[])[0]!;
    ok(target, { type: 'createSymbol', ids: [inner] });
    fails(
      target,
      bad(['a', (node(target, holder).children as string[])[0]!]),
      'editor.not-siblings',
    );
    const [set] = ok(target, { type: 'combineAsVariants', ids: ['a', 'b'] });
    fails(target, bad(['a', 'c']), 'editor.not-siblings');
    fails(target, bad(['a', 'b']), 'editor.invalid-variant');
    expect(set).toBeDefined();
  });

  it('never draws an ID for a failed wrap', () => {
    let drawn = 0;
    const target = createEditor({
      document: loose(),
      ids: () => `d${++drawn}`,
    });
    fails(target, { type: 'combineAsVariants', ids: ['a', 'zz'] }, 'editor.unknown-node');
    expect(drawn).toBe(0);
    ok(target, { type: 'combineAsVariants', ids: ['a', 'b'] });
    expect(drawn).toBe(1);
  });
});

/** The fixture plus a third variant `sC` (Small, Default) with the same layer names as `sA`. */
function richer(edit: (value: Json) => void = () => {}): DocumentV8 {
  return build((value) => {
    const nodes = value.nodes as Json;
    nodes.sC = {
      ...nodes.sA,
      id: 'sC',
      name: 'Small',
      frame: { x: 260, y: 20, width: 60, height: 30 },
      children: ['c1', 'c2'],
      variant: { Size: 'Small', State: 'Default' },
    };
    nodes.c1 = {
      ...nodes.r1,
      id: 'c1',
      parent: 'sC',
      frame: { x: 0, y: 0, width: 25, height: 30 },
    };
    nodes.c2 = {
      ...nodes.t1,
      id: 'c2',
      parent: 'sC',
      frame: { x: 30, y: 5, width: 20, height: 10 },
    };
    nodes.set1.children = ['sA', 'sB', 'sC'];
    edit(value);
  });
}

describe('V37-A06 setVariantProperties', () => {
  it('renames and adds properties across a set in one step', () => {
    const target = editorOf(richer());
    const next = (rest: Json) => ({
      type: 'setVariantProperties' as const,
      updates: [
        { id: 'sA', variant: { Mode: 'Large', State: 'Default', ...rest } },
        { id: 'sB', variant: { Mode: 'Large', State: 'Hover', ...rest } },
        { id: 'sC', variant: { Mode: 'Small', State: 'Default', ...rest } },
      ],
    });
    oneStep(target, next({ Extra: 'On' }));
    expect(node(target, 'sB').variant).toEqual({ Extra: 'On', Mode: 'Large', State: 'Hover' });
    // Serialized keys are in code unit order whatever the call's.
    expect(Object.keys(node(target, 'sA').variant)).toEqual(['Extra', 'Mode', 'State']);
  });

  it('fails with its codes in order, then the model V37-S2 codes', () => {
    const target = editorOf(richer());
    const run = (updates: unknown) =>
      ({ type: 'setVariantProperties', updates }) as unknown as Command;
    fails(target, run('x'), 'editor.invalid-command', '/updates');
    fails(target, run([]), 'editor.invalid-command', '/updates');
    fails(target, run([5]), 'editor.invalid-command', '/updates/0');
    fails(target, run([{ id: 5, variant: {} }]), 'editor.invalid-command', '/updates/0/id');
    fails(
      target,
      run([
        { id: 'sA', variant: { A: '1' } },
        { id: 'sA', variant: { A: '2' } },
      ]),
      'editor.invalid-command',
      '/updates/1/id',
    );
    fails(
      target,
      run([{ id: 'sA', variant: 'x' }]),
      'editor.invalid-command',
      '/updates/0/variant',
    );
    fails(target, run([{ id: 'zz', variant: { A: '1' } }]), 'editor.unknown-node');
    fails(target, run([{ id: 'r1', variant: { A: '1' } }]), 'editor.not-a-symbol');
    fails(target, run([{ id: 'sP', variant: { A: '1' } }]), 'editor.invalid-variant');
    // V37-S2: an empty variant, a bad value, unequal names, a duplicate tuple.
    fails(target, run([{ id: 'sA', variant: {} }]), 'document.invalid-field', '/nodes/sA/variant');
    fails(
      target,
      run([{ id: 'sA', variant: { Size: '', State: 'Default' } }]),
      'document.invalid-field',
      '/nodes/sA/variant/Size',
    );
    fails(
      target,
      run([{ id: 'sA', variant: { Size: 'Large' } }]),
      'document.invalid-variant',
      '/nodes/sB/variant',
    );
    fails(
      target,
      run([{ id: 'sB', variant: { Size: 'Large', State: 'Default' } }]),
      'document.invalid-variant',
      '/nodes/sB/variant',
    );
  });
});

describe('V37-A07 createInstance of a set', () => {
  it('places an instance of the default variant, sized and placed from it', () => {
    const target = editorOf(richer());
    const [id] = oneStep(target, { type: 'createInstance', symbol: 'set1' });
    const created = node(target, id!);
    expect(created).toMatchObject({ type: 'instance', symbol: 'sA' });
    // The default variant sA is 100 x 40 at page (20, 20): beside it, 40 to its right.
    expect(created.frame).toEqual({ x: 160, y: 20, width: 100, height: 40 });
    fails(target, { type: 'createInstance', symbol: 'r1' }, 'editor.not-a-symbol');
  });
});

describe('V37-A07 setInstanceVariant', () => {
  const run = (id: string, values: Json) =>
    ({ type: 'setInstanceVariant', id, values }) as unknown as Command;

  it('swaps the source, takes the target size when unresized, and carries overrides by path', () => {
    const target = editorOf(
      richer((value) => {
        value.nodes.inst1.overrides = {
          r1: { fill: GREEN, opacity: 0.5 },
          sA: { fill: null },
          t1: { opacity: 0.25 },
        };
        // The target's `Box` already has the carried opacity: that field is dropped.
        value.nodes.c1.opacity = 0.5;
      }),
    );
    oneStep(target, run('inst1', { Size: 'Small' }));
    const instance = node(target, 'inst1');
    expect(instance.symbol).toBe('sC');
    expect(instance.frame).toEqual({ x: 0, y: 200, width: 60, height: 30 });
    expect(instance.overrides).toEqual({
      c1: { fill: GREEN },
      c2: { opacity: 0.25 },
      sC: { fill: null },
    });
    // The text override moved to the text node of the same path.
    expect(Object.keys(instance.textOverrides)).toEqual(['c2']);
    // Back again: carried by path the other way.
    oneStep(target, run('inst1', { Size: 'Large' }));
    expect(node(target, 'inst1').symbol).toBe('sA');
    expect(Object.keys(node(target, 'inst1').overrides)).toEqual(['r1', 'sA', 't1']);
  });

  it('keeps a resized instance size and drops overrides with no layer at their path', () => {
    const target = editorOf(
      richer((value) => {
        value.nodes.inst1.frame.width = 150;
        value.nodes.sC.children = ['c1'];
        delete value.nodes.c2;
      }),
    );
    ok(target, run('inst1', { Size: 'Small' }));
    const instance = node(target, 'inst1');
    expect(instance.frame).toMatchObject({ width: 150, height: 40 });
    expect(instance.overrides).toEqual({ c1: expect.any(Object), sC: { fill: null } });
    expect(instance.textOverrides).toEqual({});
  });

  it('records nothing for the current variant and fails with its codes in order', () => {
    const target = editorOf(richer());
    fails(
      target,
      run('inst1', { Size: 'Small', State: 'Hover' }),
      'editor.no-such-variant',
      '/values',
    );
    const steps = depth(target);
    expect(target.execute(run('inst1', { Size: 'Large' }))).toEqual({ ok: true, ids: [] });
    expect(target.execute(run('inst1', { State: 'Default' }))).toEqual({ ok: true, ids: [] });
    expect(depth(target)).toBe(steps);
    fails(
      target,
      { type: 'setInstanceVariant', id: 5, values: {} } as never,
      'editor.invalid-command',
      '/id',
    );
    fails(target, run('inst1', {}), 'editor.invalid-command', '/values');
    fails(target, run('inst1', { Size: 3 }), 'editor.invalid-command', '/values/Size');
    fails(target, run('zz', { Size: 'Small' }), 'editor.unknown-node');
    fails(target, run('r1', { Size: 'Small' }), 'editor.not-an-instance');
    fails(
      target,
      run('inst1', { Mode: 'x', Other: 'y' }),
      'editor.no-such-variant',
      '/values/Mode',
    );
    // An instance of a lone symbol is in no set.
    ok(target, { type: 'createInstance', symbol: 'sP' });
    const lone = docOf(target).pages[0]!.children.at(-1)!;
    fails(target, run(lone, { Size: 'Small' }), 'editor.invalid-variant');
  });

  it('fails a target too deep for the instance with the M7-S5 tree depth', () => {
    const chain = 253;
    const target = editorOf(
      richer((value) => {
        delete value.nodes.c1;
        delete value.nodes.c2;
        // The instance sits three groups deep, so it expands deeper than `sC` stands in its set.
        let holder = 'page-1';
        for (const id of ['h1', 'h2', 'h3']) {
          value.nodes[id] = { ...value.nodes.r1, id, parent: holder, type: 'group', children: [] };
          for (const key of ['cornerRadii', 'fill', 'stroke']) delete value.nodes[id][key];
          if (holder === 'page-1') {
            value.pages[0].children = value.pages[0].children.map((child: string) =>
              child === 'inst1' ? id : child,
            );
          } else value.nodes[holder].children = [id];
          holder = id;
        }
        value.nodes.h3.children = ['inst1'];
        value.nodes.inst1.parent = 'h3';
        let parent = 'sC';
        const kids: string[] = [];
        for (let i = 0; i < chain; i += 1) {
          const id = `g${i}`;
          value.nodes[id] = {
            ...value.nodes.r1,
            id,
            parent,
            type: 'group',
            children: [],
          };
          for (const key of ['cornerRadii', 'fill', 'stroke']) delete value.nodes[id][key];
          if (parent === 'sC') kids.push(id);
          else value.nodes[parent].children = [id];
          parent = id;
        }
        value.nodes.sC.children = kids;
        value.nodes.g252.children = ['leaf'];
        value.nodes.leaf = { ...value.nodes.r1, id: 'leaf', parent: 'g252' };
      }),
    );
    fails(target, run('inst1', { Size: 'Small' }), 'document.invalid-field', '/nodes/inst1/parent');
  });
});

describe('V37-A08 setInstanceOverride and resetInstanceOverrides', () => {
  const set = (node: string, props: Json, id = 'inst1') =>
    ({ type: 'setInstanceOverride', id, node, props }) as unknown as Command;
  const reset = (id: string, node?: string) =>
    ({
      type: 'resetInstanceOverrides',
      id,
      ...(node === undefined ? {} : { node }),
    }) as unknown as Command;

  it('sets a field, removes it by equal value, and removes an empty override', () => {
    const target = editorOf(
      build((value) => (value.nodes.inst1.overrides = { t1: { opacity: 0.5 } })),
    );
    oneStep(target, set('r1', { fill: GREEN }));
    expect(node(target, 'inst1').overrides).toEqual({ r1: { fill: GREEN }, t1: { opacity: 0.5 } });
    oneStep(target, set('r1', { opacity: 0.4, visible: false }));
    expect(node(target, 'inst1').overrides.r1).toEqual({
      fill: GREEN,
      opacity: 0.4,
      visible: false,
    });
    // The source's own fill is red: setting it back removes that field.
    oneStep(target, set('r1', { fill: RED }));
    expect(node(target, 'inst1').overrides.r1).toEqual({ opacity: 0.4, visible: false });
    oneStep(target, set('r1', { opacity: 1, visible: true }));
    expect(Object.keys(node(target, 'inst1').overrides)).toEqual(['t1']);
    // The source key takes fill and stroke; nothing is left as absent, not as `{}`.
    oneStep(target, set('t1', { opacity: 1 }));
    expect(Object.hasOwn(node(target, 'inst1'), 'overrides')).toBe(false);
    ok(target, set('sA', { fill: GREEN }));
    expect(node(target, 'inst1').overrides).toEqual({ sA: { fill: GREEN } });
    // A change of no value records no step.
    const steps = depth(target);
    expect(target.execute(set('sA', { fill: GREEN }))).toEqual({ ok: true, ids: [] });
    expect(depth(target)).toBe(steps);
  });

  it('fails with its codes in order', () => {
    const target = editorOf();
    fails(target, { type: 'setInstanceOverride', id: 5 } as never, 'editor.invalid-command', '/id');
    fails(
      target,
      { type: 'setInstanceOverride', id: 'inst1', node: 5 } as never,
      'editor.invalid-command',
      '/node',
    );
    fails(target, set('r1', {}), 'editor.invalid-command', '/props');
    fails(target, set('r1', { width: 5 }), 'editor.invalid-command', '/props/width');
    fails(target, set('r1', { opacity: undefined }), 'editor.invalid-command', '/props/opacity');
    fails(target, set('r1', { opacity: 1 }, 'zz'), 'editor.unknown-node');
    fails(target, set('r1', { opacity: 1 }, 'r1'), 'editor.not-an-instance');
    fails(target, set('ghost', { opacity: 1 }), 'editor.invalid-override', '/node');
    fails(target, set('r2', { opacity: 1 }), 'editor.invalid-override', '/node');
    fails(target, set('inst1', { opacity: 1 }), 'editor.invalid-override', '/node');
    fails(
      target,
      set('r1', { opacity: 2 }),
      'document.invalid-field',
      '/nodes/inst1/overrides/r1/opacity',
    );
    fails(
      target,
      set('t1', { fill: null }),
      'document.invalid-field',
      '/nodes/inst1/overrides/t1/fill',
    );
    fails(
      target,
      set('sA', { opacity: 0.5 }),
      'document.invalid-field',
      '/nodes/inst1/overrides/sA/opacity',
    );
    fails(
      target,
      set('sA', { effects: [] }),
      'document.invalid-field',
      '/nodes/inst1/overrides/sA/effects',
    );
  });

  it('resets one node (property and text overrides) or every override', () => {
    const target = editorOf();
    expect(Object.keys(node(target, 'inst1').textOverrides)).toEqual(['t1']);
    oneStep(target, reset('inst1', 't1'));
    expect(node(target, 'inst1').textOverrides).toEqual({});
    expect(Object.keys(node(target, 'inst1').overrides)).toEqual(['r1', 'sA']);
    oneStep(target, reset('inst1'));
    expect(Object.hasOwn(node(target, 'inst1'), 'overrides')).toBe(false);
    const steps = depth(target);
    expect(target.execute(reset('inst1'))).toEqual({ ok: true, ids: [] });
    expect(target.execute(reset('inst1', 'r1'))).toEqual({ ok: true, ids: [] });
    expect(depth(target)).toBe(steps);
    fails(
      target,
      { type: 'resetInstanceOverrides', id: 5 } as never,
      'editor.invalid-command',
      '/id',
    );
    fails(
      target,
      { type: 'resetInstanceOverrides', id: 'inst1', node: 5 } as never,
      'editor.invalid-command',
      '/node',
    );
    fails(target, reset('zz'), 'editor.unknown-node');
    fails(target, reset('r1'), 'editor.not-an-instance');
    fails(target, reset('inst1', 'r2'), 'editor.invalid-override', '/node');
  });

  it('keeps overrides valid through delete, cut and move of their nodes (V37-X4)', () => {
    const target = editorOf();
    oneStep(target, { type: 'deleteNodes', ids: ['r1'] });
    expect(Object.keys(node(target, 'inst1').overrides)).toEqual(['sA', 't1']);
    const cutter = editorOf();
    ok(cutter, { type: 'cut', ids: ['t1'] });
    expect(Object.keys(node(cutter, 'inst1').overrides)).toEqual(['r1', 'sA']);
    expect(node(cutter, 'inst1').textOverrides).toEqual({});
    const mover = editorOf();
    oneStep(mover, { type: 'moveNodes', ids: ['r1'], parent: 'page-1', index: 3 });
    expect(Object.keys(node(mover, 'inst1').overrides)).toEqual(['sA', 't1']);
  });
});

describe('V37-N1 and N2 names through combineAsVariants', () => {
  it('names the values from the symbol names, N1 then N2, in child order', () => {
    const target = editorOf(loose());
    const [set] = oneStep(target, { type: 'combineAsVariants', ids: ['a', 'b', 'c'] });
    const children = (node(target, set!).children as string[]).map((id) => node(target, id));
    // `Hover` twice: the second takes the suffix; the control is stripped from the third.
    expect(children.map((child) => child.variant)).toEqual([
      { 'Property 1': 'Hover' },
      { 'Property 1': 'Hover 2' },
      { 'Property 1': 'Pressed state' },
    ]);
  });
});

describe('V37-A06 the set rules of section 2.1', () => {
  const rectangle = (extra: Json = {}) =>
    ({
      type: 'createRectangle',
      frame: { x: 5, y: 5, width: 10, height: 10 },
      ...extra,
    }) as unknown as Command;

  it('resizes a set without touching its variants or its instances', () => {
    const target = editorOf();
    const before = { sA: node(target, 'sA').frame, inst1: node(target, 'inst1').frame };
    oneStep(target, {
      type: 'setFrames',
      frames: [{ id: 'set1', frame: { x: 0, y: 0, width: 600, height: 300 } }],
    } as never);
    expect(node(target, 'set1').frame).toEqual({ x: 0, y: 0, width: 600, height: 300 });
    expect(node(target, 'sA').frame).toEqual(before.sA);
    expect(node(target, 'inst1').frame).toEqual(before.inst1);
  });

  it('refuses every non-symbol creation into a set, in the parent check position', () => {
    const target = editorOf();
    const into = { parent: 'set1' };
    for (const command of [
      rectangle(into),
      { type: 'createEllipse', frame: { x: 0, y: 0, width: 5, height: 5 }, ...into },
      { type: 'createLine', start: { x: 0, y: 0 }, end: { x: 9, y: 9 }, ...into },
      { type: 'createFrame', frame: { x: 0, y: 0, width: 5, height: 5 }, ...into },
      { type: 'createInstance', symbol: 'sP', ...into },
    ]) {
      const result = target.execute(command as unknown as Command);
      expect(result.ok, JSON.stringify(command)).toBe(false);
      if (!result.ok) expect(result.code).toBe('editor.invalid-parent');
    }
    expect(textOf(target)).toBe(textOf(editorOf()));
  });

  it('refuses moveNodes, groupNodes, booleanNodes, duplicateNodes and paste of non-symbols', () => {
    const target = editorOf(
      build((value) => {
        value.nodes.x = {
          ...value.nodes.r1,
          id: 'x',
          parent: 'page-1',
          frame: { x: 500, y: 0, width: 5, height: 5 },
        };
        value.pages[0].children.push('x');
      }),
    );
    fails(
      target,
      { type: 'moveNodes', ids: ['x'], parent: 'set1', index: 0 },
      'editor.invalid-parent',
      '/parent',
    );
    const grouped = target.execute({ type: 'groupNodes', ids: ['sA', 'sB'], kind: 'group' });
    expect(grouped.ok).toBe(false);
    if (!grouped.ok) expect(grouped.code).toBe('editor.invalid-parent');
    const combined = target.execute({ type: 'booleanNodes', ids: ['sA', 'sB'], op: 'union' });
    expect(combined.ok).toBe(false);
    if (!combined.ok) expect(combined.code).toBe('editor.invalid-parent');
    // Pasting an instance with a set as the scope still works: it goes to the set's parent.
    ok(target, { type: 'copy', ids: ['inst1'] });
    ok(target, { type: 'setScope', id: 'set1' });
    const [pasted] = ok(target, { type: 'paste' });
    expect(node(target, pasted!).parent).toBe('page-1');
  });

  it('removes a duplicated variant of a set the same way: the copy is a variant of the set', () => {
    const target = editorOf();
    const [copy] = oneStep(target, { type: 'duplicateNodes', ids: ['sA'] });
    expect(node(target, copy!).parent).toBe('set1');
    expect(node(target, copy!).variant).toEqual({ Size: 'Large 2', State: 'Default' });
    const set = node(target, 'set1').children as string[];
    expect(set).toEqual(['sA', copy, 'sB']);
  });

  it('enters and leaves a set by moveNodes, paste and duplicateNodes', () => {
    const target = editorOf(loose());
    ok(target, { type: 'combineAsVariants', ids: ['a', 'b'] });
    const set = docOf(target).pages[0]!.children.find(
      (id) => node(target, id).type === 'symbolSet',
    )!;
    // Into the set: a lone symbol joins with values by N1 and N2.
    oneStep(target, { type: 'moveNodes', ids: ['c'], parent: set, index: 1 });
    // The set's names with the first child's value, made distinct: Hover and Hover 2 are taken.
    expect(node(target, 'c').variant).toEqual({ 'Property 1': 'Hover 3' });
    expect(node(target, set).children).toEqual(['a', 'c', 'b']);
    // Out of the set: the variant is lost and the symbol stands alone (S1 probe 2).
    oneStep(target, { type: 'moveNodes', ids: ['b'], parent: 'p', index: 0 });
    expect(Object.hasOwn(node(target, 'b'), 'variant')).toBe(false);
    expect(node(target, 'b').parent).toBe('p');
    // A copy of a lone symbol pasted onto the selected set joins it.
    ok(target, { type: 'copy', ids: ['b'] });
    ok(target, { type: 'setSelection', ids: [set] });
    const [pasted] = oneStep(target, { type: 'paste' });
    expect(node(target, pasted!).parent).toBe(set);
    expect(typeof node(target, pasted!).variant).toBe('object');
  });
});

describe('V37-A06 empty sets and the removal rules', () => {
  it('deletes both variants and removes the set in one step (S1 probe 1)', () => {
    const target = editorOf();
    oneStep(target, { type: 'deleteNodes', ids: ['sA', 'sB'] });
    expect(docOf(target).nodes.set1).toBeUndefined();
    expect(docOf(target).pages[0]!.children).not.toContain('set1');
    expect(node(target, 'inst1').type).toBe('frame');
  });

  it('detaches the instances of a deleted used variant, and keeps the set with its other variant', () => {
    const target = editorOf();
    oneStep(target, { type: 'deleteNodes', ids: ['sA'] });
    expect(node(target, 'inst1').type).toBe('frame');
    expect(node(target, 'set1').children).toEqual(['sB']);
  });

  it('cuts a variant: the instances are detached and the set is removed when empty', () => {
    const target = editorOf();
    oneStep(target, { type: 'cut', ids: ['sA', 'sB'] });
    expect(docOf(target).nodes.set1).toBeUndefined();
    expect(node(target, 'inst1').type).toBe('frame');
  });

  it('deletes the set with its variants', () => {
    const target = editorOf();
    oneStep(target, { type: 'deleteNodes', ids: ['set1'] });
    expect(docOf(target).nodes.sA).toBeUndefined();
    expect(node(target, 'inst1').type).toBe('frame');
  });

  it('moves a variant to the page, leaving no stray variant (S1 probe 2)', () => {
    const target = editorOf();
    oneStep(target, { type: 'moveNodes', ids: ['sB'], parent: 'page-1', index: 0 });
    expect(Object.hasOwn(node(target, 'sB'), 'variant')).toBe(false);
    expect(node(target, 'set1').children).toEqual(['sA']);
    // The last variant leaving removes the set.
    oneStep(target, { type: 'moveNodes', ids: ['sA'], parent: 'page-1', index: 0 });
    expect(docOf(target).nodes.set1).toBeUndefined();
    expect(Object.hasOwn(node(target, 'sA'), 'variant')).toBe(false);
  });

  it('removes a selected set from the selection and moves a scope inside it to the parent', () => {
    const target = editorOf();
    ok(target, { type: 'setScope', id: 'set1' });
    ok(target, { type: 'setSelection', ids: ['sA'] });
    ok(target, { type: 'deleteNodes', ids: ['sA', 'sB'] });
    expect(target.query({ type: 'selection' })).toEqual([]);
    expect(target.query({ type: 'scope' })).toBeNull();
  });

  it('pastes an instance into a selected set to the set parent (S1 probe 3)', () => {
    const target = editorOf();
    ok(target, { type: 'copy', ids: ['inst1'] });
    ok(target, { type: 'setSelection', ids: ['set1'] });
    const [pasted] = oneStep(target, { type: 'paste' });
    expect(node(target, pasted!).parent).toBe('page-1');
    expect(node(target, 'set1').children).toEqual(['sA', 'sB']);
  });
});

describe('V37-A06 adoption into and out of a set', () => {
  it('adopts a dragged symbol into the set under the pointer, and nothing else', () => {
    const document = build();
    const into = dropAdoption(document, 'page-1', null, ['sP'], { x: 50, y: 60 });
    expect(into).toEqual({ ids: ['sP'], parent: 'set1' });
    const other = build((value) => {
      value.nodes.x = { ...value.nodes.r1, id: 'x', parent: 'page-1' };
      value.pages[0].children.push('x');
    });
    expect(dropAdoption(other, 'page-1', null, ['x'], { x: 50, y: 60 })).toBeNull();
  });

  it('re-parents a variant dropped outside its set, and a set scope adopts to the parent', () => {
    const document = build();
    const out = dropAdoption(document, 'page-1', null, ['sB'], { x: 700, y: 700 });
    expect(out).toEqual({ ids: ['sB'], parent: 'page-1' });
    // With the set as scope, a point inside it still adopts into the set's parent, not the set.
    expect(adoptionOwner(document, 'page-1', 'set1', { x: 50, y: 60 })).toBe('page-1');
    expect(adoptionOwner(document, 'page-1', 'set1', { x: 700, y: 700 })).toBe('page-1');
  });

  it('draws a rectangle with a set as scope onto the set parent', () => {
    for (const adoptIntoFrames of [false, true]) {
      const target = createEditor({
        document: build(),
        ids: createCounterIdSource('n'),
        adoptIntoFrames,
      });
      ok(target, { type: 'setViewportSize', width: 1200, height: 800 });
      ok(target, { type: 'setSnapping', enabled: false });
      ok(target, { type: 'setScope', id: 'set1' });
      ok(target, { type: 'setTool', tool: 'rectangle' });
      const none = { shift: false, alt: false, meta: false, ctrl: false };
      for (const [kind, x, y] of [
        ['pointerdown', 30, 30],
        ['pointermove', 60, 50],
        ['pointermove', 90, 70],
        ['pointerup', 90, 70],
      ] as const) {
        ok(target, { type: 'input', event: { kind, point: { x, y }, modifiers: none } });
      }
      const drawn = docOf(target).pages[0]!.children.filter(
        (id) => !['set1', 'inst1', 'sP'].includes(id),
      );
      expect(drawn).toHaveLength(1);
      expect(node(target, drawn[0]!).type).toBe('rectangle');
      expect(node(target, drawn[0]!).parent).toBe('page-1');
      expect(node(target, 'set1').children).toEqual(['sA', 'sB']);
    }
  });
});

describe('V37-A06 flip, order and scope of a set', () => {
  it('mirrors the variants placement on a flip and leaves their content alone', () => {
    const target = createEditor({ document: build(), ids: createCounterIdSource('n') });
    ok(target, { type: 'setViewportSize', width: 1200, height: 800 });
    ok(target, { type: 'setSnapping', enabled: false });
    const before = docOf(target);
    ok(target, { type: 'setSelection', ids: ['set1'] });
    const none = { shift: false, alt: false, meta: false, ctrl: false };
    for (const [kind, x, y] of [
      ['pointerdown', 300, 60],
      ['pointermove', 100, 60],
      ['pointermove', -100, 60],
      ['pointerup', -100, 60],
    ] as const) {
      ok(target, { type: 'input', event: { kind, point: { x, y }, modifiers: none } });
    }
    const after = docOf(target);
    expect(after.nodes.set1!.frame.x).toBeLessThan(0);
    expect(after.nodes.sA!.frame.x).not.toBe(before.nodes.sA!.frame.x);
    for (const id of ['r1', 't1', 'r2']) expect(after.nodes[id]).toEqual(before.nodes[id]);
    expect(after.nodes.sA!.frame.width).toBe(before.nodes.sA!.frame.width);
    expect(after.nodes.inst1).toEqual(before.nodes.inst1);
  });

  it('reordering inside a set changes no value; moving the first child changes the default', () => {
    const target = editorOf();
    const values = () =>
      (node(target, 'set1').children as string[]).map((id) => [id, node(target, id).variant]);
    const before = new Map(values() as [string, unknown][]);
    oneStep(target, { type: 'reorderNodes', ids: ['sA'], op: 'front' } as never);
    expect(node(target, 'set1').children).toEqual(['sB', 'sA']);
    for (const [id, variant] of values()) expect(variant).toEqual(before.get(id as string));
    // sB is now the first child: the default variant of the set.
    const [instance] = oneStep(target, { type: 'createInstance', symbol: 'set1' });
    expect(node(target, instance!).symbol).toBe('sB');
  });

  it('falls back to the non-page parent scope when a set inside a frame is removed', () => {
    const target = editorOf();
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: -50, y: -50, width: 900, height: 600 },
    });
    ok(target, { type: 'moveNodes', ids: ['set1'], parent: frame!, index: 0 });
    ok(target, { type: 'setScope', id: 'set1' });
    expect(target.query({ type: 'scope' })).toBe('set1');
    ok(target, { type: 'deleteNodes', ids: ['sA', 'sB'] });
    expect(docOf(target).nodes.set1).toBeUndefined();
    expect(target.query({ type: 'scope' })).toBe(frame);
  });

  it('pastes symbols beside a selected variant into its set', () => {
    const target = editorOf();
    ok(target, { type: 'copy', ids: ['sP'] });
    ok(target, { type: 'setSelection', ids: ['sA'] });
    const [pasted] = oneStep(target, { type: 'paste' });
    expect(node(target, pasted!).parent).toBe('set1');
    expect(typeof node(target, pasted!).variant).toBe('object');
  });
});

describe('V37-A10 the clipboard of variants and overrides', () => {
  const copyOf = (target: Editor, ids: string[]): Json => {
    ok(target, { type: 'copy', ids });
    const text = String(target.query({ type: 'clipboard' }));
    return JSON.parse(text.slice(text.indexOf('\n') + 1)) as Json;
  };

  it('copies an overridden instance linked and detached, then switches the linked copy', () => {
    const target = editorOf(richer());
    ok(target, { type: 'copy', ids: ['inst1'] });
    const [linked] = oneStep(target, { type: 'paste' });
    const copy = node(target, linked!);
    expect(copy.type).toBe('instance');
    expect(copy.symbol).toBe('sA');
    expect(copy.overrides).toEqual(node(target, 'inst1').overrides);
    oneStep(target, {
      type: 'setInstanceVariant',
      id: linked!,
      values: { Size: 'Small' },
    } as never);
    expect(node(target, linked!).symbol).toBe('sC');
    expect(node(target, 'inst1').symbol).toBe('sA');
    // Detached: pasted into a document without the source, the overrides bake into the frame.
    const fragment = copyOf(target, ['inst1']);
    expect(JSON.stringify(fragment)).not.toContain('"variant"');
    const text = String(target.query({ type: 'clipboard' }));
    const empty = editorOf(
      build((value) => {
        for (const key of Object.keys(value.nodes)) delete value.nodes[key];
        value.pages[0].children = [];
      }),
    );
    const [frame] = ok(empty, { type: 'paste', text });
    expect(node(empty, frame!).type).toBe('frame');
  });

  it('copies a lone variant without its variant and a whole set as a new independent set', () => {
    const target = editorOf();
    const lone = copyOf(target, ['sA']);
    expect(JSON.stringify(lone)).not.toContain('"variant"');
    const [pasted] = ok(target, { type: 'paste' });
    expect(node(target, pasted!).type).toBe('symbol');
    expect(
      Object.hasOwn(
        node(target, pasted!).type === 'symbol' ? node(target, pasted!) : {},
        'variant',
      ),
    ).toBe(false);
    ok(target, { type: 'setSelection', ids: [] });
    ok(target, { type: 'copy', ids: ['set1'] });
    const [copy] = oneStep(target, { type: 'paste' });
    expect(node(target, copy!).type).toBe('symbolSet');
    const kids = node(target, copy!).children as string[];
    expect(kids.map((id) => node(target, id).variant)).toEqual([
      { Size: 'Large', State: 'Default' },
      { Size: 'Large', State: 'Hover' },
    ]);
    expect(kids).not.toContain('sA');
  });
  it('rejects a variant on a fragment root or carried root, and a bad override key', () => {
    const target = editorOf(richer());
    const paste = (fragment: Json) =>
      target.execute({
        type: 'paste',
        text: `vector-studio/fragment\n${JSON.stringify(fragment)}`,
      });
    const lone = copyOf(target, ['sA']);
    const root = (lone.roots as string[])[0]!;
    const withVariant = structuredClone(lone);
    withVariant.nodes[root].variant = { 'Property 1': 'A' };
    expect(paste(withVariant)).toEqual({
      ok: false,
      code: 'editor.invalid-clipboard',
      path: `/nodes/${root}/variant`,
    });
    // An instance whose carried source is a variant: the carried root must not hold `variant`.
    const linked = copyOf(target, ['inst1']);
    const carried = (linked.sources as string[])[0]!;
    const carriedVariant = structuredClone(linked);
    carriedVariant.sourceNodes[carried].variant = { 'Property 1': 'A' };
    expect(paste(carriedVariant)).toEqual({
      ok: false,
      code: 'editor.invalid-clipboard',
      path: `/sourceNodes/${carried}/variant`,
    });
    // An override key outside the carried source subtree.
    const stray = structuredClone(linked);
    const [instance] = linked.roots as string[];
    stray.nodes[instance!].overrides = { nowhere: { fill: GREEN } };
    const result = paste(stray);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('editor.invalid-clipboard');
      expect(result.path).toBe(`/nodes/${instance}/overrides/nowhere`);
    }
  });
});
