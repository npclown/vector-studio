import type { TextLayoutPort, TextLayoutRequest } from '@vector-studio/contracts';
import {
  serializeDocument,
  validateDocument,
  type Color,
  type DocumentV6,
  type Frame,
  type TextNode,
  type TextRun,
} from '@vector-studio/model';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type IdSource,
  type Modifiers,
} from '../../packages/editor-core/src/index.js';
// Source imports: the gesture API, hit testing, the projector, snapping and the cache are
// internal.
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import { apply, localTransform } from '../../packages/editor-core/src/geometry.js';
import { hitsNode } from '../../packages/editor-core/src/hit-test.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import { scaleAbout } from '../../packages/editor-core/src/resize.js';
import { snapSet } from '../../packages/editor-core/src/snap.js';
import { TEXT_LAYOUT_CACHE_SIZE, TextLayoutCache } from '../../packages/editor-core/src/text.js';
import { createFakeTextLayout, fakeLayout } from '../support/fake-text-layout.js';

// MVP M6a-U3 (docs/plans/mvp-m6a-text-model-contract.md, sections 5 to 8): the `textLayout`
// option, cache, query and session event; the section 6.1 commands and codes; auto sizing and
// the growth anchor (6.2); every resize and scale row of section 6.3 with `map` handles scaling
// sizes as a group (M6a-Q18 (a)); hit testing (7); fragments (8); the interim nesting rule in
// commands (M6a-S7), lifted by M7-U7 (section 9, M7-T1), which also moved the schema to v5. Every
// layout comes from the fake port of section 5: an `a` advances 0.5 em,
// a Hangul syllable 1 em, a space 0.25 em, and a line is `lineHeight` times its largest size.
// Criteria A03, A06 to A10 and A13.

const root = path.resolve(import.meta.dirname, '../..');
const TEXT_FIXTURE = readFileSync(path.join(root, 'tests/fixtures/m6-text/text.v4.json'), 'utf8');
/** Its v6 migration (M6a section 9, M4 section 2.1), which the editor holds and writes. */
const TEXT_FIXTURE_V6 = readFileSync(
  path.join(root, 'tests/fixtures/m4-appearance/migrated/text.v6.json'),
  'utf8',
);
const START = { horizontal: 'start', vertical: 'start' } as const;
const black: Color = { r: 0, g: 0, b: 0, a: 1 };
const red: Color = { r: 1, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });

function run(text: string, size = 10, color: Color = black, family = 'Test'): TextRun {
  return { text, family, size, color };
}

type Loose = Record<string, unknown> & { id: string };

function base(id: string, parent: string, frame: Frame, rotation = 0) {
  return { id, name: id, parent, frame, rotation, constraints: START, opacity: 1, visible: true };
}

function text(
  id: string,
  parent: string,
  frame: Frame,
  runs: readonly TextRun[],
  props: Partial<Pick<TextNode, 'sizing' | 'align' | 'letterSpacing' | 'lineHeight'>> & {
    rotation?: number;
    constraints?: TextNode['constraints'];
  } = {},
): Loose {
  return {
    ...base(id, parent, frame, props.rotation ?? 0),
    ...(props.constraints === undefined ? {} : { constraints: props.constraints }),
    type: 'text',
    runs,
    sizing: props.sizing ?? 'autoWidth',
    align: props.align ?? 'left',
    letterSpacing: props.letterSpacing ?? 0,
    lineHeight: props.lineHeight ?? 1.2,
  };
}

function rect(id: string, parent: string, frame: Frame): Loose {
  return {
    ...base(id, parent, frame),
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: black,
    stroke: null,
  };
}

function container(
  type: 'group' | 'frame' | 'symbol',
  id: string,
  parent: string,
  frame: Frame,
  children: string[],
): Loose {
  const extra = type === 'group' ? {} : { fill: null, stroke: null };
  return { ...base(id, parent, frame), type, children, ...extra };
}

function doc(nodes: Loose[], children: string[]): DocumentV6 {
  return {
    schemaVersion: 6,
    id: 'doc',
    pages: [{ id: 'p1', name: 'Page 1', children }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  } as unknown as DocumentV6;
}

/** An ID source that counts its calls. */
function counted(prefix = 'n'): IdSource & { calls: number } {
  const next = createCounterIdSource(prefix);
  const source = Object.assign(
    () => {
      source.calls += 1;
      return next();
    },
    { calls: 0 },
  );
  return source;
}

function editor(
  document?: DocumentV6,
  port: TextLayoutPort | null = createFakeTextLayout(),
  ids: IdSource = createCounterIdSource('n'),
): Editor {
  return createEditor({
    ...(document === undefined
      ? { document: doc([], []) }
      : { document: JSON.parse(JSON.stringify(document)) as unknown }),
    ids,
    ...(port === null ? {} : { textLayout: port }),
  });
}

const serialized = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const nodeOf = (target: Editor, id: string) => target.query({ type: 'node', id }) as TextNode;

/** Runs `command`; the editor's document stays a valid v4 document either way. */
function run_(target: Editor, command: Command): CommandResult {
  const result = target.execute(command);
  expect(validateDocument(JSON.parse(serialized(target))).ok).toBe(true);
  return result;
}

/** A failing command changes nothing: no document, history or revision change. */
function fails(target: Editor, command: Command, expected: CommandResult): void {
  const before = serialized(target);
  const revision = target.query({ type: 'revision' });
  const history = target.query({ type: 'history' });
  expect(run_(target, command)).toEqual(expected);
  expect(serialized(target)).toBe(before);
  expect(target.query({ type: 'revision' })).toBe(revision);
  expect(target.query({ type: 'history' })).toEqual(history);
}

/** The command succeeds as one step whose undo and redo are byte-identical. */
function step(target: Editor, command: Command): CommandResult {
  const before = serialized(target);
  const depth = target.query({ type: 'history' }).undoDepth;
  const result = run_(target, command);
  expect(result.ok).toBe(true);
  const after = serialized(target);
  expect(target.query({ type: 'history' }).undoDepth).toBe(depth + 1);
  run_(target, { type: 'undo' });
  expect(serialized(target)).toBe(before);
  run_(target, { type: 'redo' });
  expect(serialized(target)).toBe(after);
  return result;
}

const create = (
  extra: Partial<Extract<Command, { type: 'createText' }>> = {},
): Extract<Command, { type: 'createText' }> => ({
  type: 'createText',
  frame: f(100, 50, 0, 0),
  runs: [run('ab')],
  ...extra,
});

/** One page with an `ab` text node `t1` (10 by 12 at its size 10) and a rectangle `r1`. */
function simple(props: Parameters<typeof text>[4] = {}, frame = f(100, 50, 10, 12)) {
  return doc(
    [text('t1', 'p1', frame, [run('ab')], props), rect('r1', 'p1', f(0, 0, 5, 5))],
    ['t1', 'r1'],
  );
}

describe('M6a-A06: createText', () => {
  it('creates the literal node with the defaults, laid out from the given frame', () => {
    const target = editor();
    expect(step(target, create())).toEqual({ ok: true, ids: ['n1'] });
    expect(nodeOf(target, 'n1')).toEqual({
      id: 'n1',
      name: 'Text',
      parent: 'p1',
      frame: f(100, 50, 10, 12),
      rotation: 0,
      constraints: START,
      opacity: 1,
      visible: true,
      type: 'text',
      runs: [run('ab')],
      sizing: 'autoWidth',
      align: 'left',
      letterSpacing: 0,
      lineHeight: 1.2,
    });
  });

  it('keeps the anchor (x + a·width, y) of the given frame for each align', () => {
    const at = (align: TextNode['align']) => {
      const target = editor();
      run_(target, create({ align }));
      return nodeOf(target, 'n1').frame;
    };
    expect(at('left')).toEqual(f(100, 50, 10, 12));
    expect(at('center')).toEqual(f(95, 50, 10, 12));
    expect(at('right')).toEqual(f(90, 50, 10, 12));
  });

  it('wraps autoHeight at the given width and keeps a fixed frame', () => {
    const target = editor();
    run_(target, create({ runs: [run('ab cd')], sizing: 'autoHeight', frame: f(0, 0, 15, 1) }));
    expect(nodeOf(target, 'n1').frame).toEqual(f(0, 0, 15, 24));
    run_(target, create({ sizing: 'fixed', frame: f(0, 0, 3, 4) }));
    expect(nodeOf(target, 'n2').frame).toEqual(f(0, 0, 3, 4));
  });

  it('places into a parent space and takes letter spacing and line height', () => {
    const target = editor(doc([container('frame', 'f1', 'p1', f(10, 20, 100, 100), [])], ['f1']));
    run_(target, create({ parent: 'f1', letterSpacing: 0.5, lineHeight: 2 }));
    // Two clusters of 5 + 5 units; one line of 2 × 10.
    expect(nodeOf(target, 'n1')).toMatchObject({ parent: 'f1', frame: f(90, 30, 20, 20) });
  });
});

describe('M6a-A06: setText, setTextStyle, setTextProps', () => {
  it('setText inserts in the style of the character before start and refits', () => {
    const target = editor(
      doc([text('t1', 'p1', f(100, 50, 30, 24), [run('ab'), run('cd', 20)])], ['t1']),
    );
    step(target, { type: 'setText', id: 't1', start: 2, end: 2, text: 'X' });
    expect(nodeOf(target, 't1')).toMatchObject({
      runs: [run('abX'), run('cd', 20)],
      frame: f(100, 50, 35, 24),
    });
    step(target, { type: 'setText', id: 't1', start: 0, end: 0, text: '가' });
    expect(nodeOf(target, 't1').runs).toEqual([run('가abX'), run('cd', 20)]);
    // Replacing across the run boundary keeps the style before `start`.
    step(target, { type: 'setText', id: 't1', start: 3, end: 5, text: 'Y' });
    expect(nodeOf(target, 't1').runs).toEqual([run('가abY'), run('d', 20)]);
  });

  it('deleting everything leaves one empty run in that style', () => {
    const target = editor(
      doc([text('t1', 'p1', f(100, 50, 30, 24), [run('ab', 10, red), run('cd', 20)])], ['t1']),
    );
    step(target, { type: 'setText', id: 't1', start: 0, end: 4, text: '' });
    // An empty node has one line of `lineHeight × size` and width 0.
    expect(nodeOf(target, 't1')).toMatchObject({
      runs: [run('', 10, red)],
      frame: f(100, 50, 0, 12),
    });
  });

  it('setTextStyle splits and merges runs and refits', () => {
    const target = editor(doc([text('t1', 'p1', f(100, 50, 20, 12), [run('abcd')])], ['t1']));
    step(target, { type: 'setTextStyle', id: 't1', start: 1, end: 3, style: { size: 20 } });
    expect(nodeOf(target, 't1')).toMatchObject({
      runs: [run('a'), run('bc', 20), run('d')],
      frame: f(100, 50, 30, 24),
    });
    step(target, { type: 'setTextStyle', id: 't1', start: 0, end: 4, style: { size: 10 } });
    expect(nodeOf(target, 't1')).toMatchObject({ runs: [run('abcd')], frame: f(100, 50, 20, 12) });
    step(target, {
      type: 'setTextStyle',
      id: 't1',
      start: 2,
      end: 4,
      style: { color: red, family: 'Other' },
    });
    expect(nodeOf(target, 't1').runs).toEqual([run('ab'), run('cd', 10, red, 'Other')]);
  });

  it('setTextStyle restyles an empty node at 0, 0', () => {
    const target = editor(doc([text('t1', 'p1', f(0, 0, 0, 12), [run('')])], ['t1']));
    step(target, { type: 'setTextStyle', id: 't1', start: 0, end: 0, style: { size: 20 } });
    expect(nodeOf(target, 't1')).toMatchObject({ runs: [run('', 20)], frame: f(0, 0, 0, 24) });
  });

  it('setTextProps refits; autoWidth drops the stored width; fixed keeps the frame', () => {
    const target = editor(simple({ sizing: 'autoHeight' }, f(100, 50, 40, 12)));
    step(target, { type: 'setTextProps', id: 't1', letterSpacing: 0.5 });
    // Width 40 kept; the line of 20 fits.
    expect(nodeOf(target, 't1')).toMatchObject({ letterSpacing: 0.5, frame: f(100, 50, 40, 12) });
    step(target, { type: 'setTextProps', id: 't1', sizing: 'autoWidth', align: 'right' });
    // The right edge stays: x + 1 · (40 − 20).
    expect(nodeOf(target, 't1')).toMatchObject({
      sizing: 'autoWidth',
      align: 'right',
      frame: f(120, 50, 20, 12),
    });
    step(target, { type: 'setTextProps', id: 't1', lineHeight: 3, sizing: 'fixed' });
    expect(nodeOf(target, 't1')).toMatchObject({ sizing: 'fixed', frame: f(120, 50, 20, 12) });
  });

  it('setNodeProps takes the common props only', () => {
    const target = editor(simple());
    step(target, { type: 'setNodeProps', id: 't1', props: { name: 'Title', opacity: 0.5 } });
    fails(
      target,
      { type: 'setNodeProps', id: 't1', props: { fill: null } },
      { ok: false, code: 'editor.invalid-command', path: '/props/fill' },
    );
  });
});

describe('M6a-A06: refitText', () => {
  it('refits stale auto frames as one step and records none when nothing changes', () => {
    const target = editor(
      doc(
        [
          text('t1', 'p1', f(100, 50, 0, 0), [run('ab')], { align: 'right' }),
          text('t2', 'p1', f(0, 0, 3, 3), [run('ab')], { sizing: 'fixed' }),
          text('t3', 'p1', f(0, 100, 10, 12), [run('ab')]),
        ],
        ['t1', 't2', 't3'],
      ),
    );
    const result = step(target, { type: 'refitText' });
    expect(result).toEqual({ ok: true, ids: [] });
    expect(nodeOf(target, 't1').frame).toEqual(f(90, 50, 10, 12));
    expect(nodeOf(target, 't2').frame).toEqual(f(0, 0, 3, 3));
    const depth = target.query({ type: 'history' }).undoDepth;
    const revision = target.query({ type: 'revision' });
    expect(run_(target, { type: 'refitText' })).toEqual({ ok: true, ids: [] });
    expect(run_(target, { type: 'refitText', ids: ['t3', 't2'] })).toEqual({ ok: true, ids: [] });
    expect(target.query({ type: 'history' }).undoDepth).toBe(depth);
    expect(target.query({ type: 'revision' })).toBe(revision);
  });

  it('refits a text node inside a group, and the group refits with it', () => {
    const target = editor(
      doc(
        [
          container('group', 'g1', 'p1', f(0, 0, 100, 12), ['t1', 'r1']),
          text('t1', 'g1', f(0, 0, 100, 12), [run('ab')]),
          rect('r1', 'g1', f(0, 0, 5, 5)),
        ],
        ['g1'],
      ),
    );
    step(target, { type: 'refitText', ids: ['t1'] });
    expect(nodeOf(target, 't1').frame).toEqual(f(0, 0, 10, 12));
    expect(target.query({ type: 'node', id: 'g1' })!.frame).toEqual(f(0, 0, 10, 12));
  });
});

describe('M6a-A06: failure codes in the section 6.1 order', () => {
  const fail = (code: string, at?: string): CommandResult =>
    (at === undefined ? { ok: false, code } : { ok: false, code, path: at }) as CommandResult;

  it('createText: shape, unknown node, model rules, size floor, no port, parent, IDs', () => {
    const ids = counted();
    const document = doc(
      [
        rect('r1', 'p1', f(0, 0, 5, 5)),
        container('symbol', 's1', 'p1', f(0, 0, 50, 50), ['s1-r']),
        rect('s1-r', 's1', f(0, 0, 5, 5)),
      ],
      ['r1', 's1'],
    );
    const target = editor(document, createFakeTextLayout(), ids);
    const noPort = editor(document, null);
    const cases: [Editor, Command, CommandResult][] = [
      [
        target,
        create({ parent: 5 as unknown as string }),
        fail('editor.invalid-command', '/parent'),
      ],
      [target, create({ parent: 'missing' }), fail('editor.unknown-node')],
      [target, create({ runs: [] }), fail('document.invalid-field', '/runs')],
      [target, create({ runs: [run('a\rb')] }), fail('document.invalid-field', '/runs/0/text')],
      [target, create({ runs: [run('a'), run('b')] }), fail('document.invalid-field', '/runs/1')],
      [target, create({ frame: f(0, 0, -1, 0) }), fail('document.invalid-field', '/frame/width')],
      [target, create({ sizing: 'wide' as 'fixed' }), fail('document.invalid-field', '/sizing')],
      [target, create({ runs: [run('a', 5000)] }), fail('document.invalid-field', '/runs/0/size')],
      // The authored floor follows the model's rules and precedes the port check.
      [
        noPort,
        create({ runs: [run('a'), run('b', 0.25)] }),
        fail('editor.invalid-command', '/runs/1/size'),
      ],
      [noPort, create(), fail('editor.no-text-layout')],
      [noPort, create({ parent: 's1' }), fail('editor.no-text-layout')],
      [target, create({ parent: 'r1' }), fail('editor.invalid-parent', '/parent')],
    ];
    for (const [editorCase, command, expected] of cases) fails(editorCase, command, expected);
    expect(ids.calls).toBe(0);
    // The ID is drawn last: an ID source that only repeats existing IDs fails the command.
    fails(
      editor(document, createFakeTextLayout(), () => 'r1'),
      create(),
      fail('editor.duplicate-id'),
    );
  });

  it('setText: shape, unknown node, not text, range, model rules, no port', () => {
    const document = doc(
      [text('t1', 'p1', f(0, 0, 15, 12), [run('a😀b')]), rect('r1', 'p1', f(0, 0, 5, 5))],
      ['t1', 'r1'],
    );
    const target = editor(document);
    const set = (extra: Record<string, unknown>) =>
      ({ type: 'setText', id: 't1', start: 0, end: 0, text: 'x', ...extra }) as Command;
    const cases: [Command, CommandResult][] = [
      [set({ id: 5 }), fail('editor.invalid-command', '/id')],
      [set({ start: '0' }), fail('editor.invalid-command', '/start')],
      [set({ end: null }), fail('editor.invalid-command', '/end')],
      [set({ text: 1 }), fail('editor.invalid-command', '/text')],
      [set({ id: 'missing', start: -1 }), fail('editor.unknown-node')],
      [set({ id: 'r1', start: -1 }), fail('editor.not-a-text-node', '/id')],
      [set({ start: 0.5 }), fail('editor.invalid-text-range', '/start')],
      [set({ start: -1 }), fail('editor.invalid-text-range', '/start')],
      // Offset 2 lies between the halves of the surrogate pair at 1..3.
      [set({ start: 2, end: 3 }), fail('editor.invalid-text-range', '/start')],
      [set({ start: 1, end: 2 }), fail('editor.invalid-text-range', '/end')],
      [set({ start: 3, end: 1 }), fail('editor.invalid-text-range', '/end')],
      [set({ start: 0, end: 5 }), fail('editor.invalid-text-range', '/end')],
      [set({ text: '\t' }), fail('document.invalid-field', '/nodes/t1/runs/0/text')],
      [set({ text: 'x'.repeat(16_381) }), fail('document.invalid-field', '/nodes/t1/runs')],
    ];
    for (const [command, expected] of cases) fails(target, command, expected);
    fails(editor(document, null), set({}), fail('editor.no-text-layout'));
    // A fixed node needs no port.
    const fixed = editor(
      doc([text('t1', 'p1', f(0, 0, 3, 3), [run('ab')], { sizing: 'fixed' })], ['t1']),
      null,
    );
    step(fixed, { type: 'setText', id: 't1', start: 2, end: 2, text: 'c' });
    expect(nodeOf(fixed, 't1')).toMatchObject({ runs: [run('abc')], frame: f(0, 0, 3, 3) });
  });

  it('setTextStyle: shape, range, model rules, size floor, no port', () => {
    const document = doc([text('t1', 'p1', f(0, 0, 20, 12), [run('abcd')])], ['t1']);
    const target = editor(document);
    const style = (extra: Record<string, unknown>) =>
      ({
        type: 'setTextStyle',
        id: 't1',
        start: 1,
        end: 3,
        style: { size: 20 },
        ...extra,
      }) as Command;
    const cases: [Command, CommandResult][] = [
      [style({ style: null }), fail('editor.invalid-command', '/style')],
      [style({ style: {} }), fail('editor.invalid-command', '/style')],
      [
        style({ style: { size: 20, weight: 700 } }),
        fail('editor.invalid-command', '/style/weight'),
      ],
      [style({ id: 'missing' }), fail('editor.unknown-node')],
      [style({ start: 2, end: 2 }), fail('editor.invalid-text-range', '/end')],
      [style({ start: 0, end: 9 }), fail('editor.invalid-text-range', '/end')],
      [style({ style: { size: 4096.5 } }), fail('document.invalid-field', '/nodes/t1/runs/1/size')],
      [style({ style: { family: '' } }), fail('document.invalid-field', '/nodes/t1/runs/1/family')],
      [
        style({ style: { color: { r: 2, g: 0, b: 0, a: 1 } } }),
        fail('document.invalid-field', '/nodes/t1/runs/1/color/r'),
      ],
      [style({ style: { size: 0.25 } }), fail('editor.invalid-command', '/style/size')],
    ];
    for (const [command, expected] of cases) fails(target, command, expected);
    fails(editor(document, null), style({}), fail('editor.no-text-layout'));
    // A size of 0.5 is the floor itself.
    step(target, { type: 'setTextStyle', id: 't1', start: 1, end: 3, style: { size: 0.5 } });
  });

  it('setTextProps and refitText: shape, unknown node, not text, model rules, no port', () => {
    const document = simple();
    const target = editor(document);
    const cases: [Command, CommandResult][] = [
      [{ type: 'setTextProps', id: 't1' }, fail('editor.invalid-command')],
      [{ type: 'setTextProps', id: 'r1', align: 'center' }, fail('editor.not-a-text-node', '/id')],
      [
        { type: 'setTextProps', id: 't1', lineHeight: 11 },
        fail('document.invalid-field', '/nodes/t1/lineHeight'),
      ],
      [
        { type: 'setTextProps', id: 't1', letterSpacing: -2 },
        fail('document.invalid-field', '/nodes/t1/letterSpacing'),
      ],
      [{ type: 'refitText', ids: ['t1', 't1'] }, fail('editor.invalid-command', '/ids')],
      [{ type: 'refitText', ids: ['r1', 'missing'] }, fail('editor.unknown-node')],
      [{ type: 'refitText', ids: ['t1', 'r1'] }, fail('editor.not-a-text-node', '/ids/1')],
    ];
    for (const [command, expected] of cases) fails(target, command, expected);
    const noPort = editor(document, null);
    fails(
      noPort,
      { type: 'setTextProps', id: 't1', align: 'center' },
      fail('editor.no-text-layout'),
    );
    fails(noPort, { type: 'refitText' }, fail('editor.no-text-layout'));
    // Switching to fixed needs no layout.
    step(noPort, { type: 'setTextProps', id: 't1', sizing: 'fixed' });
  });
});

describe('M6a-A07: the growth anchor (section 6.2)', () => {
  it('keeps the top anchor of a rotated node on the page', () => {
    const rotation = Math.PI / 6;
    const at = (align: TextNode['align']) => {
      const target = editor(
        doc([text('t1', 'p1', f(100, 50, 10, 12), [run('ab')], { rotation, align })], ['t1']),
      );
      run_(target, { type: 'setText', id: 't1', start: 2, end: 2, text: 'cd' });
      return nodeOf(target, 't1').frame;
    };
    expect(at('left')).toEqual(f(99.33012701892218, 52.5, 20, 12));
    expect(at('center')).toEqual(f(95, 50, 20, 12));
    expect(at('right')).toEqual(f(90.66987298107782, 47.5, 20, 12));
  });
});

describe('M6a-A07: setFrames (section 6.3, first row)', () => {
  it('a width change makes autoWidth autoHeight and refits the height', () => {
    const target = editor(simple());
    step(target, { type: 'setFrames', frames: [{ id: 't1', frame: f(100, 50, 6, 12) }] });
    // `ab` breaks inside the word at width 6: two lines.
    expect(nodeOf(target, 't1')).toMatchObject({ sizing: 'autoHeight', frame: f(100, 50, 6, 24) });
    step(target, { type: 'setFrames', frames: [{ id: 't1', frame: f(90, 50, 30, 24) }] });
    expect(nodeOf(target, 't1')).toMatchObject({ sizing: 'autoHeight', frame: f(90, 50, 30, 12) });
  });

  it('a height change makes an auto mode fixed; position and rotation alone keep it', () => {
    const target = editor(simple());
    step(target, {
      type: 'setFrames',
      frames: [{ id: 't1', frame: f(0, 0, 10, 12), rotation: 1 }],
    });
    expect(nodeOf(target, 't1')).toMatchObject({ sizing: 'autoWidth', frame: f(0, 0, 10, 12) });
    step(target, { type: 'setFrames', frames: [{ id: 't1', frame: f(0, 0, 40, 40) }] });
    expect(nodeOf(target, 't1')).toMatchObject({
      sizing: 'fixed',
      frame: f(0, 0, 40, 40),
      runs: [run('ab')],
    });
  });

  it('gesture updates compare with the pre-gesture node and refit on every update', () => {
    const target = editor(simple());
    const { gesture } = internalsOf(target);
    expect(gesture.begin()).toBe(true);
    gesture.update({ type: 'setFrames', frames: [{ id: 't1', frame: f(100, 50, 6, 12) }] });
    expect(nodeOf(target, 't1')).toMatchObject({ sizing: 'autoHeight', frame: f(100, 50, 6, 24) });
    gesture.update({ type: 'setFrames', frames: [{ id: 't1', frame: f(100, 50, 30, 12) }] });
    expect(nodeOf(target, 't1')).toMatchObject({ sizing: 'autoHeight', frame: f(100, 50, 30, 12) });
    gesture.commit();
    expect(target.query({ type: 'history' }).undoDepth).toBe(1);
  });

  it('the single handle mode resizes through setFrames without changing sizes', () => {
    const target = editor(simple());
    run_(target, { type: 'setSelection', ids: ['t1'] });
    // Drag the right edge handle (110, 56) to x = 130.
    const pointer = (kind: 'pointerdown' | 'pointermove' | 'pointerup', x: number) =>
      run_(target, { type: 'input', event: { kind, point: { x, y: 56 }, modifiers: none } });
    pointer('pointerdown', 110);
    pointer('pointermove', 120);
    pointer('pointermove', 130);
    pointer('pointerup', 130);
    expect(nodeOf(target, 't1')).toMatchObject({
      sizing: 'autoHeight',
      runs: [run('ab')],
      frame: f(100, 50, 30, 12),
    });
  });
});

describe('M6a-A07: group resize (section 6.3)', () => {
  const grouped = (sizing: TextNode['sizing'] = 'autoWidth', size = 10) =>
    doc(
      [
        container('group', 'g1', 'p1', f(0, 0, 10 * (size / 10), 12 * (size / 10)), ['t1']),
        text('t1', 'g1', f(0, 0, size, 1.2 * size), [run('ab', size)], { sizing }),
      ],
      ['g1'],
    );

  it('a uniform scale multiplies sizes and refits auto dimensions', () => {
    const target = editor(grouped());
    step(target, { type: 'setFrames', frames: [{ id: 'g1', frame: f(0, 0, 20, 24) }] });
    expect(nodeOf(target, 't1')).toMatchObject({
      sizing: 'autoWidth',
      runs: [run('ab', 20)],
      frame: f(0, 0, 20, 24),
    });
  });

  it('a non-uniform scale makes auto modes fixed with the mapped frame, sizes × √(kx·ky)', () => {
    const target = editor(grouped());
    step(target, { type: 'setFrames', frames: [{ id: 'g1', frame: f(0, 0, 40, 12) }] });
    expect(nodeOf(target, 't1')).toMatchObject({
      sizing: 'fixed',
      runs: [run('ab', 20)],
      frame: f(0, 0, 40, 12),
    });
  });

  it('a fixed node scales its sizes without a refit, and without a port', () => {
    const target = editor(grouped('fixed'), null);
    step(target, { type: 'setFrames', frames: [{ id: 'g1', frame: f(0, 0, 30, 36) }] });
    expect(nodeOf(target, 't1')).toMatchObject({ sizing: 'fixed', runs: [run('ab', 30)] });
  });

  it('accepts a derived size below 0.5 and fails above 4096 and at k = 0', () => {
    const target = editor(grouped());
    step(target, { type: 'setFrames', frames: [{ id: 'g1', frame: f(0, 0, 0.25, 0.3) }] });
    expect(nodeOf(target, 't1').runs).toEqual([run('ab', 0.25)]);
    const large = editor(grouped('autoWidth', 3000));
    fails(
      large,
      { type: 'setFrames', frames: [{ id: 'g1', frame: f(0, 0, 6000, 7200) }] },
      { ok: false, code: 'document.invalid-field', path: '/nodes/t1/runs/0/size' },
    );
    const flat = editor(grouped());
    fails(
      flat,
      { type: 'setFrames', frames: [{ id: 'g1', frame: f(0, 0, 0, 12) }] },
      { ok: false, code: 'document.invalid-field', path: '/nodes/t1/runs/0/size' },
    );
  });
});

describe('M6a-A07: frame children (section 6.3)', () => {
  const framed = (constraints: TextNode['constraints']) =>
    doc(
      [
        container('frame', 'f1', 'p1', f(0, 0, 100, 100), ['t1']),
        text('t1', 'f1', f(10, 10, 10, 12), [run('ab')], { constraints }),
      ],
      ['f1'],
    );
  const resize = (target: Editor, width: number, height: number) =>
    step(target, { type: 'setFrames', frames: [{ id: 'f1', frame: f(0, 0, width, height) }] });

  it('scale on both axes with equal factors is uniform', () => {
    const target = editor(framed({ horizontal: 'scale', vertical: 'scale' }));
    resize(target, 200, 200);
    expect(nodeOf(target, 't1')).toMatchObject({
      sizing: 'autoWidth',
      runs: [run('ab', 20)],
      frame: f(20, 20, 20, 24),
    });
  });

  it('scale on one axis scales sizes from that axis only and makes auto modes fixed', () => {
    const target = editor(framed({ horizontal: 'scale', vertical: 'start' }));
    resize(target, 400, 100);
    expect(nodeOf(target, 't1')).toMatchObject({
      sizing: 'fixed',
      runs: [run('ab', 20)],
      frame: f(40, 10, 40, 12),
    });
  });

  it('start, end and center keep the node; a startEnd stretch to width 0 keeps sizes', () => {
    const kept = editor(framed({ horizontal: 'end', vertical: 'center' }));
    resize(kept, 120, 140);
    expect(nodeOf(kept, 't1')).toMatchObject({
      sizing: 'autoWidth',
      runs: [run('ab')],
      frame: f(30, 30, 10, 12),
    });
    const stretched = editor(framed({ horizontal: 'startEnd', vertical: 'start' }));
    resize(stretched, 90, 100);
    // One cluster per line at width 0.
    expect(nodeOf(stretched, 't1')).toMatchObject({
      sizing: 'autoHeight',
      runs: [run('ab')],
      frame: f(10, 10, 0, 24),
    });
    const tall = editor(framed({ horizontal: 'start', vertical: 'startEnd' }));
    resize(tall, 100, 110);
    expect(nodeOf(tall, 't1')).toMatchObject({ sizing: 'fixed', frame: f(10, 10, 10, 22) });
  });
});

describe('M6a-A07: map handles (section 6.3, M6a-Q18 (a))', () => {
  const pair = () =>
    doc(
      [
        text('t1', 'p1', f(0, 0, 10, 12), [run('ab')]),
        text('t2', 'p1', f(20, 0, 10, 12), [run('ab')], { sizing: 'autoHeight' }),
      ],
      ['t1', 't2'],
    );

  it('a uniform map scales sizes as a group and refits on each update', () => {
    const target = editor(pair());
    const { gesture } = internalsOf(target);
    gesture.begin();
    expect(gesture.edit({ kind: 'map', ids: ['t1', 't2'], map: scaleAbout(2, 2) }).ok).toBe(true);
    expect(nodeOf(target, 't1')).toMatchObject({ runs: [run('ab', 20)], frame: f(0, 0, 20, 24) });
    expect(nodeOf(target, 't2')).toMatchObject({
      sizing: 'autoHeight',
      runs: [run('ab', 20)],
      frame: f(40, 0, 20, 24),
    });
    gesture.edit({ kind: 'map', ids: ['t1', 't2'], map: scaleAbout(3, 1) });
    expect(nodeOf(target, 't1')).toMatchObject({
      sizing: 'fixed',
      runs: [run('ab', 10 * Math.sqrt(3))],
      frame: f(0, 0, 30, 12),
    });
    gesture.commit();
    expect(target.query({ type: 'history' }).undoDepth).toBe(1);
  });

  it('frames mode (page-root, rotation 0) runs the setFrames rule; map mode scales', () => {
    // The bottom-right handle of the box (0, 0, 30, 12) dragged to (60, 24).
    const drag = (target: Editor) => {
      run_(target, { type: 'setSnapping', enabled: false });
      run_(target, { type: 'setSelection', ids: ['t1', 't2'] });
      const pointer = (kind: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) =>
        run_(target, { type: 'input', event: { kind, point: { x, y }, modifiers: none } });
      pointer('pointerdown', 30, 12);
      pointer('pointermove', 45, 18);
      pointer('pointermove', 60, 24);
      pointer('pointerup', 60, 24);
    };
    const frames = editor(pair());
    drag(frames);
    expect(nodeOf(frames, 't1')).toMatchObject({
      sizing: 'fixed',
      runs: [run('ab')],
      frame: f(0, 0, 20, 24),
    });
    // A node below the page root puts the selection in map mode.
    const nested = doc(
      [
        text('t1', 'p1', f(0, 0, 10, 12), [run('ab')]),
        container('group', 'g1', 'p1', f(20, 0, 10, 12), ['t2']),
        text('t2', 'g1', f(0, 0, 10, 12), [run('ab')], { sizing: 'autoHeight' }),
      ],
      ['t1', 'g1'],
    );
    const mapped = editor(nested);
    drag(mapped);
    expect(nodeOf(mapped, 't1')).toMatchObject({
      sizing: 'autoWidth',
      runs: [run('ab', 20)],
      frame: f(0, 0, 20, 24),
    });
    expect(nodeOf(mapped, 't2')).toMatchObject({
      sizing: 'autoHeight',
      runs: [run('ab', 20)],
      frame: f(0, 0, 20, 24),
    });
    expect(mapped.query({ type: 'node', id: 'g1' })!.frame).toEqual(f(40, 0, 20, 24));
  });

  it('fails without a port when an auto node needs the uniform refit', () => {
    const target = editor(pair(), null);
    const { gesture } = internalsOf(target);
    gesture.begin();
    expect(gesture.edit({ kind: 'map', ids: ['t1'], map: scaleAbout(2, 2) })).toEqual({
      ok: false,
      code: 'editor.no-text-layout',
    });
    expect(gesture.edit({ kind: 'map', ids: ['t1'], map: scaleAbout(2, 1) }).ok).toBe(true);
    gesture.cancel();
  });
});

describe('M6a-A08: without a port', () => {
  it('loads, round-trips and accepts the commands that need no layout', () => {
    const target = createEditor({ document: JSON.parse(TEXT_FIXTURE) as unknown });
    expect(serialized(target)).toBe(TEXT_FIXTURE_V6);
    expect(target.query({ type: 'textLayout', id: 't1' })).toBeNull();
    step(target, { type: 'nudgeNodes', ids: ['t1', 't2'], dx: 1, dy: 2 });
    step(target, {
      type: 'setFrames',
      frames: [{ id: 't1', frame: f(5, 5, 40, 30), rotation: 0.5 }],
    });
    step(target, { type: 'groupNodes', ids: ['t1', 't2'], kind: 'group' });
    step(target, { type: 'duplicateNodes', ids: ['t3'] });
    run_(target, { type: 'copy', ids: ['t3'] });
    step(target, { type: 'paste' });
    step(target, { type: 'deleteNodes', ids: ['t3'] });
    step(target, { type: 'createText', frame: f(0, 0, 9, 9), runs: [run('x')], sizing: 'fixed' });
    fails(
      target,
      { type: 'createText', frame: f(0, 0, 0, 0), runs: [run('x')] },
      {
        ok: false,
        code: 'editor.no-text-layout',
      },
    );
    fails(target, { type: 'refitText' }, { ok: false, code: 'editor.no-text-layout' });
  });
});

describe('M6a-A09: the cache, the query and the generation', () => {
  it('equal requests share one layout; the query returns the result of its generation', () => {
    const port = createFakeTextLayout({ generation: 7 });
    const target = editor(
      doc(
        [
          text('t1', 'p1', f(0, 0, 10, 12), [run('ab')]),
          text('t2', 'p1', f(50, 50, 10, 12), [run('ab')], { rotation: 1 }),
          rect('r1', 'p1', f(0, 0, 5, 5)),
        ],
        ['t1', 't2', 'r1'],
      ),
      port,
    );
    const request: TextLayoutRequest = {
      runs: [{ text: 'ab', family: 'Test', size: 10 }],
      width: null,
      align: 'left',
      letterSpacing: 0,
      lineHeight: 1.2,
    };
    const first = target.query({ type: 'textLayout', id: 't1' });
    expect(first).toEqual(fakeLayout(request, 7));
    expect(target.query({ type: 'textLayout', id: 't2' })).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(port.layoutCalls).toBe(1);
    expect(target.query({ type: 'textLayout', id: 'r1' })).toBeNull();
    expect(target.query({ type: 'textLayout', id: 'missing' })).toBeNull();
  });

  it('a bump drops the cache and raises one textLayout event and no document event', () => {
    const port = createFakeTextLayout();
    const target = editor(simple(), port);
    target.query({ type: 'textLayout', id: 't1' });
    const before = serialized(target);
    const revision = target.query({ type: 'revision' });
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    port.bump();
    expect(events).toEqual([{ type: 'session', field: 'textLayout' }]);
    expect(serialized(target)).toBe(before);
    expect(target.query({ type: 'revision' })).toBe(revision);
    expect(target.query({ type: 'history' }).undoDepth).toBe(0);
    expect(target.query({ type: 'textLayout', id: 't1' })!.generation).toBe(1);
    expect(port.layoutCalls).toBe(2);
    // The fake's layouts do not change with the generation: refitText records no step.
    expect(run_(target, { type: 'refitText' })).toEqual({ ok: true, ids: [] });
    expect(target.query({ type: 'history' }).undoDepth).toBe(0);
  });

  it('refitText after a generation whose layouts changed refits as one step', () => {
    const fake = createFakeTextLayout();
    let factor = 1;
    // A port whose fonts "load" on a bump: every advance doubles.
    const port: TextLayoutPort = {
      portVersion: 0,
      get generation() {
        return fake.generation;
      },
      layout: (request) => {
        const result = fake.layout({
          ...request,
          runs: request.runs.map((entry) => ({ ...entry, text: entry.text.repeat(factor) })),
        });
        return result;
      },
      subscribe: (listener) => fake.subscribe(listener),
    };
    const target = editor(simple(), port);
    factor = 2;
    fake.bump();
    expect(nodeOf(target, 't1').frame).toEqual(f(100, 50, 10, 12));
    step(target, { type: 'refitText' });
    expect(nodeOf(target, 't1').frame).toEqual(f(100, 50, 20, 12));
  });

  it('keeps at most TEXT_LAYOUT_CACHE_SIZE results, the least recently used dropped first', () => {
    const port = createFakeTextLayout();
    const cache = new TextLayoutCache(port);
    const node = (k: number) =>
      text(`t${k}`, 'p1', f(0, 0, 0, 0), [run(`${k}`)]) as unknown as TextNode;
    const first = node(0);
    cache.layout(first);
    for (let k = 1; k < TEXT_LAYOUT_CACHE_SIZE; k += 1) cache.layout(node(k));
    // Touch the first, then one more: the second is dropped.
    cache.layout(first);
    cache.layout(node(TEXT_LAYOUT_CACHE_SIZE));
    expect(cache.size).toBe(TEXT_LAYOUT_CACHE_SIZE);
    const calls = port.layoutCalls;
    cache.layout(first);
    expect(port.layoutCalls).toBe(calls);
    cache.layout(node(1));
    expect(port.layoutCalls).toBe(calls + 1);
  });

  it('rejects a port of another version or shape', () => {
    const port = createFakeTextLayout();
    expect(() =>
      createEditor({ textLayout: { ...port, portVersion: 1 } as unknown as TextLayoutPort }),
    ).toThrow('createEditor: textLayout portVersion 1');
    expect(() => createEditor({ textLayout: {} as TextLayoutPort })).toThrow(
      'createEditor: invalid textLayout',
    );
  });
});

describe('M6a-A10: projection and hit testing', () => {
  const rotated = () =>
    doc([text('t1', 'p1', f(0, 0, 40, 10), [run('ab')], { rotation: Math.PI / 2 })], ['t1']);

  it('projects nothing for text and reports nothing, port or not', () => {
    for (const port of [createFakeTextLayout(), null]) {
      const target = editor(simple(), port);
      const projection = projectPage(target.query({ type: 'document' }), 'p1', () => null);
      expect(projection.nodes.has('t1')).toBe(false);
      expect(projection.nodes.has('r1')).toBe(true);
    }
  });

  it('hits a text node in its rotated frame box or within the tolerance of its edge', () => {
    const node = editor(rotated(), null).query({ type: 'node', id: 't1' })!;
    // The box turned about its centre (20, 5) covers x in [15, 25], y in [−15, 25].
    expect(hitsNode(node, { x: 20, y: 20 }, 1, () => null)).toBe(true);
    expect(hitsNode(node, { x: 28.5, y: 0 }, 1, () => null)).toBe(true);
    expect(hitsNode(node, { x: 30, y: 0 }, 1, () => null)).toBe(false);
    expect(hitsNode(node, { x: 35, y: 5 }, 1, () => null)).toBe(false);
    expect(hitsNode(node, { x: 28.5, y: 0 }, 2, () => null)).toBe(false);
  });

  it('a click selects it and the marquee takes it as a leaf, with no port', () => {
    const target = editor(rotated(), null);
    const pointer = (kind: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) =>
      run_(target, { type: 'input', event: { kind, point: { x, y }, modifiers: none } });
    pointer('pointerdown', 20, 20);
    pointer('pointerup', 20, 20);
    expect(target.query({ type: 'selection' })).toEqual(['t1']);
    run_(target, { type: 'setSelection', ids: [] });
    pointer('pointerdown', 40, 40);
    pointer('pointermove', 30, 30);
    pointer('pointermove', 24, 24);
    pointer('pointerup', 24, 24);
    expect(target.query({ type: 'selection' })).toEqual(['t1']);
  });

  it('is a snap candidate by its frame', () => {
    const document = editor(simple(), null).query({ type: 'document' });
    const set = snapSet(document, 'p1', null, ['r1']);
    expect(set.candidates).toEqual([
      { id: 't1', order: 0, box: { left: 100, top: 50, right: 110, bottom: 62 }, rotation: 0 },
    ]);
  });
});

describe('M6a-A13: the interim nesting rule in commands (M6a-S7), lifted by M7-U7 (M7-T1)', () => {
  const withSymbol = () =>
    doc(
      [
        container('symbol', 's1', 'p1', f(0, 0, 50, 50), ['s1-r']),
        rect('s1-r', 's1', f(0, 0, 5, 5)),
        text('t1', 'p1', f(100, 50, 10, 12), [run('ab')]),
      ],
      ['s1', 't1'],
    );

  it('creates text into, moves text into and makes a symbol over text', () => {
    const target = editor(withSymbol());
    const created = target.execute(create({ parent: 's1' }));
    expect(created.ok).toBe(true);
    const id = created.ok ? created.ids[0]! : '';
    expect(target.query({ type: 'node', id })!.parent).toBe('s1');
    expect(target.execute({ type: 'moveNodes', ids: ['t1'], parent: 's1', index: 0 }).ok).toBe(
      true,
    );
    expect(target.query({ type: 'node', id: 't1' })!.parent).toBe('s1');
    const other = editor(withSymbol());
    expect(other.execute({ type: 'createSymbol', ids: ['t1'] }).ok).toBe(true);
  });
});

describe('M6a-A03: fragments with text (section 8)', () => {
  const MARKER = 'vector-studio/fragment\n';

  it('copies the literal fragment and pastes and duplicates runs and props, not refit', () => {
    const target = editor(
      doc(
        [text('t1', 'p1', f(1, 2, 0, 0), [run('ab'), run('가', 20, red)], { align: 'center' })],
        ['t1'],
      ),
    );
    run_(target, { type: 'copy', ids: ['t1'] });
    expect(target.query({ type: 'clipboard' })).toBe(
      MARKER +
        '{"fragmentVersion":2,"schemaVersion":6,"roots":["t1"],"nodes":{"t1":{"id":"t1","name":"t1","parent":"","frame":{"x":1,"y":2,"width":0,"height":0},"rotation":0,"constraints":{"horizontal":"start","vertical":"start"},"opacity":1,"visible":true,"type":"text","runs":[{"text":"ab","family":"Test","size":10,"color":{"r":0,"g":0,"b":0,"a":1}},{"text":"가","family":"Test","size":20,"color":{"r":1,"g":0,"b":0,"a":1}}],"sizing":"autoWidth","align":"center","letterSpacing":0,"lineHeight":1.2}},"sources":[],"sourceNodes":{}}',
    );
    const pasted = step(target, { type: 'paste' });
    const id = pasted.ok ? pasted.ids[0]! : '';
    // A pasted node keeps its stored frame (it is not refit).
    expect({ ...nodeOf(target, id), id: 't1' }).toEqual(nodeOf(target, 't1'));
    const duplicated = step(target, { type: 'duplicateNodes', ids: ['t1'] });
    const copy = duplicated.ok ? duplicated.ids[0]! : '';
    expect({ ...nodeOf(target, copy), id: 't1' }).toEqual(nodeOf(target, 't1'));
  });

  it('fails a text node in an older fragment at its type and pastes older pairs without text', () => {
    const target = editor(simple());
    run_(target, { type: 'copy', ids: ['t1'] });
    const body = JSON.parse(target.query({ type: 'clipboard' })!.slice(MARKER.length)) as Record<
      string,
      unknown
    >;
    fails(
      target,
      { type: 'paste', text: MARKER + JSON.stringify({ ...body, schemaVersion: 3 }) },
      { ok: false, code: 'document.invalid-field', path: '/nodes/t1/type' },
    );
    run_(target, { type: 'copy', ids: ['r1'] });
    const rectBody = JSON.parse(
      target.query({ type: 'clipboard' })!.slice(MARKER.length),
    ) as Record<string, unknown>;
    step(target, {
      type: 'paste',
      text: MARKER + JSON.stringify({ ...rectBody, schemaVersion: 3 }),
    });
    const { roots, nodes } = rectBody;
    step(target, {
      type: 'paste',
      text: MARKER + JSON.stringify({ fragmentVersion: 1, schemaVersion: 2, roots, nodes }),
    });
  });
});

// The U3 review follow-ups (2026-10-29): S1 the generation event, S2 the uniform tolerance, S4
// text in a group that is a frame child, S5 the frozen copy, S6 more anchors, ports and probes.

describe('M6a-A09 (review S1, S5): the generation event and the cached results', () => {
  it('raises the event when an earlier port listener lays out on the bump', () => {
    const port = createFakeTextLayout();
    let target: Editor | null = null;
    // Registered before the editor's own listener, so it runs first on each bump.
    port.subscribe(() => {
      target?.query({ type: 'textLayout', id: 't1' });
    });
    target = editor(simple(), port);
    target.query({ type: 'textLayout', id: 't1' });
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    port.bump();
    expect(events).toEqual([{ type: 'session', field: 'textLayout' }]);
    expect(target.query({ type: 'textLayout', id: 't1' })!.generation).toBe(1);
  });

  it('does not keep a result of a port that bumps inside layout', () => {
    const fake = createFakeTextLayout();
    let bumps = 1;
    const port: TextLayoutPort = {
      portVersion: 0,
      get generation() {
        return fake.generation;
      },
      layout: (request) => {
        const result = fake.layout(request);
        if (bumps > 0) {
          bumps -= 1;
          fake.bump();
        }
        return result;
      },
      subscribe: (listener) => fake.subscribe(listener),
    };
    const target = editor(simple(), port);
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    expect(target.query({ type: 'textLayout', id: 't1' })!.generation).toBe(0);
    expect(events).toEqual([{ type: 'session', field: 'textLayout' }]);
    // The generation-0 result was not stored: the next query lays out again, at generation 1.
    expect(target.query({ type: 'textLayout', id: 't1' })!.generation).toBe(1);
    expect(fake.layoutCalls).toBe(2);
  });

  it('freezes a copy and leaves the result of the port alone', () => {
    const fake = createFakeTextLayout();
    let last: object | null = null;
    const port: TextLayoutPort = {
      portVersion: 0,
      get generation() {
        return fake.generation;
      },
      layout: (request) => {
        const result = fake.layout(request);
        last = result;
        return result;
      },
      subscribe: (listener) => fake.subscribe(listener),
    };
    const result = editor(simple(), port).query({ type: 'textLayout', id: 't1' })!;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.lines[0])).toBe(true);
    expect(result).not.toBe(last);
    expect(result).toEqual(last);
    expect(Object.isFrozen(last)).toBe(false);
  });
});

describe('M6a-A07 (review S2): proportional resizes stay uniform', () => {
  const grouped = () =>
    doc(
      [
        container('group', 'g1', 'p1', f(0, 0, 10, 12), ['t1']),
        text('t1', 'g1', f(0, 0, 10, 12), [run('ab')]),
      ],
      ['g1'],
    );

  for (const [width, height] of [
    [11, 13.2],
    [10.7, 12.84],
    [33, 39.6],
  ] as const) {
    it(`a group taken to ${width} by ${height} keeps autoWidth`, () => {
      const target = editor(grouped());
      step(target, { type: 'setFrames', frames: [{ id: 'g1', frame: f(0, 0, width, height) }] });
      const node = nodeOf(target, 't1');
      expect(node.sizing).toBe('autoWidth');
      expect(node.runs[0]!.size).toBeCloseTo(width, 9);
      // Refit: `ab` at size s is s wide and 1.2 s tall.
      expect(node.frame.width).toBe(node.runs[0]!.size);
      expect(node.frame.height).toBe(1.2 * node.runs[0]!.size);
    });
  }

  it('the map and both-scale frame-child paths take the same tolerance', () => {
    const mapped = editor(doc([text('t1', 'p1', f(0, 0, 10, 12), [run('ab')])], ['t1']));
    const { gesture } = internalsOf(mapped);
    gesture.begin();
    gesture.edit({ kind: 'map', ids: ['t1'], map: scaleAbout(1.1, 13.2 / 12) });
    expect(nodeOf(mapped, 't1').sizing).toBe('autoWidth');
    gesture.cancel();
    const framed = editor(
      doc(
        [
          container('frame', 'f1', 'p1', f(0, 0, 10, 12), ['t1']),
          text('t1', 'f1', f(0, 0, 10, 12), [run('ab')], {
            constraints: { horizontal: 'scale', vertical: 'scale' },
          }),
        ],
        ['f1'],
      ),
    );
    step(framed, { type: 'setFrames', frames: [{ id: 'f1', frame: f(0, 0, 11, 13.2) }] });
    expect(nodeOf(framed, 't1').sizing).toBe('autoWidth');
  });
});

describe('M6a-A07 (review S4): text in a group that is a frame child', () => {
  it('follows the group-resize row whatever the group constraint; width 0 fails', () => {
    const document = doc(
      [
        container('frame', 'f1', 'p1', f(0, 0, 100, 100), ['g1']),
        {
          ...container('group', 'g1', 'f1', f(10, 10, 10, 12), ['t1']),
          constraints: { horizontal: 'startEnd', vertical: 'start' },
        },
        text('t1', 'g1', f(0, 0, 10, 12), [run('ab')]),
      ],
      ['f1'],
    );
    // Stretched by `startEnd`, the group scales its text (x 2, non-uniform: fixed).
    const wide = editor(document);
    step(wide, { type: 'setFrames', frames: [{ id: 'f1', frame: f(0, 0, 110, 100) }] });
    expect(nodeOf(wide, 't1')).toMatchObject({
      sizing: 'fixed',
      runs: [run('ab', 10 * Math.SQRT2)],
    });
    // Shrunk to width 0, its text's derived size is 0.
    fails(
      editor(document),
      { type: 'setFrames', frames: [{ id: 'f1', frame: f(0, 0, 90, 100) }] },
      { ok: false, code: 'document.invalid-field', path: '/nodes/t1/runs/0/size' },
    );
  });
});

describe('M6a-A06, A07, A10 (review S6): rotation, rotated groups, counting and throwing ports', () => {
  it('createText with a rotation keeps the top anchor of the given frame for each align', () => {
    const at = (align: TextNode['align']) => {
      const target = editor();
      run_(target, create({ align, rotation: Math.PI / 6 }));
      return nodeOf(target, 'n1').frame;
    };
    expect(at('left')).toEqual(f(96.3301270189222, 51.69615242270663, 10, 12));
    expect(at('center')).toEqual(f(92, 49.19615242270663, 10, 12));
    expect(at('right')).toEqual(f(87.6698729810778, 46.69615242270663, 10, 12));
  });

  it('keeps the anchor on the page for text in a rotated group, after the group refit', () => {
    const target = editor(
      doc(
        [
          { ...container('group', 'g1', 'p1', f(50, 50, 10, 12), ['t1']), rotation: Math.PI / 6 },
          text('t1', 'g1', f(0, 0, 10, 12), [run('ab')], { align: 'right' }),
        ],
        ['g1'],
      ),
    );
    const anchor = () => {
      const group = target.query({ type: 'node', id: 'g1' })!;
      const node = nodeOf(target, 't1');
      return apply(
        localTransform(group.frame, group.rotation),
        node.frame.x + node.frame.width,
        node.frame.y,
      );
    };
    const before = anchor();
    step(target, { type: 'setText', id: 't1', start: 2, end: 2, text: 'cd' });
    expect(nodeOf(target, 't1').frame).toMatchObject({ width: 20, height: 12 });
    const after = anchor();
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('hit testing, clicks and the marquee make no layout call', () => {
    const port = createFakeTextLayout();
    const target = editor(simple(), port);
    const pointer = (kind: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) =>
      run_(target, { type: 'input', event: { kind, point: { x, y }, modifiers: none } });
    pointer('pointerdown', 105, 56);
    pointer('pointerup', 105, 56);
    expect(target.query({ type: 'selection' })).toEqual(['t1']);
    run_(target, { type: 'setSelection', ids: [] });
    pointer('pointerdown', 150, 100);
    pointer('pointermove', 120, 70);
    pointer('pointermove', 108, 60);
    pointer('pointerup', 108, 60);
    expect(target.query({ type: 'selection' })).toEqual(['t1']);
    expect(port.layoutCalls).toBe(0);
  });

  it('a throwing port leaves the editor unchanged and usable', () => {
    const fake = createFakeTextLayout();
    let throwing = true;
    const port: TextLayoutPort = {
      portVersion: 0,
      get generation() {
        return fake.generation;
      },
      layout: (request) => {
        if (throwing) throw new Error('boom');
        return fake.layout(request);
      },
      subscribe: (listener) => fake.subscribe(listener),
    };
    const target = editor(simple(), port);
    const before = serialized(target);
    const revision = target.query({ type: 'revision' });
    expect(() =>
      target.execute({ type: 'setText', id: 't1', start: 2, end: 2, text: 'c' }),
    ).toThrow('boom');
    expect(serialized(target)).toBe(before);
    expect(target.query({ type: 'revision' })).toBe(revision);
    expect(target.query({ type: 'history' }).undoDepth).toBe(0);
    throwing = false;
    step(target, { type: 'setText', id: 't1', start: 2, end: 2, text: 'c' });
    expect(nodeOf(target, 't1').frame).toEqual(f(100, 50, 15, 12));
  });

  it('reports a wrong-type style value at the run path and repeated refitText IDs at /ids', () => {
    const target = editor(doc([text('t1', 'p1', f(0, 0, 20, 12), [run('abcd')])], ['t1']));
    fails(
      target,
      {
        type: 'setTextStyle',
        id: 't1',
        start: 1,
        end: 3,
        style: { size: 'big' as unknown as number },
      },
      { ok: false, code: 'document.invalid-field', path: '/nodes/t1/runs/1/size' },
    );
    fails(
      target,
      { type: 'refitText', ids: ['t1', 't1'] },
      {
        ok: false,
        code: 'editor.invalid-command',
        path: '/ids',
      },
    );
  });
});
