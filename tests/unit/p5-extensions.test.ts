import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, serializeDocument } from '@vector-studio/model';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type EditorEvent,
  type Extension,
  type ExtensionApi,
} from '../../packages/editor-core/src/index.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// P5-U5 (P5 editor-slice plan, section 5): the extension registry and `ext.star` (P5-A10), and
// the two custom-node codes of P5-A07.

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = path.join(root, 'tests/fixtures/p5-model');
const none = { shift: false, alt: false, meta: false, ctrl: false };
const frame = { x: 100, y: 100, width: 100, height: 100 };

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtures, `${name}.json`), 'utf8')) as unknown;
}

function editor(extensions: readonly Extension[] = [starExtension], document?: unknown): Editor {
  return createEditor({ ids: createCounterIdSource('n'), extensions, document });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function star(target: Editor, args: Record<string, number> = {}) {
  return ok(target, { type: 'runCommand', id: 'ext.star.create', args: { frame, ...args } })[0]!;
}

function text(target: Editor) {
  return serializeDocument(target.query({ type: 'document' }));
}

function click(target: Editor, x: number, y: number) {
  for (const kind of ['pointerdown', 'pointerup'] as const) {
    ok(target, { type: 'input', event: { kind, point: { x, y }, modifiers: none } });
  }
}

describe('P5-A10 ext.star through the public API', () => {
  it('registers, creates, edits, round-trips and undoes', () => {
    const target = editor();
    const empty = text(target);
    const id = star(target, { points: 6 });
    expect(target.query({ type: 'node', id })).toMatchObject({
      type: 'custom',
      customType: 'ext.star',
      name: 'Star',
      frame,
      data: { points: 6, innerRatio: 0.5 },
    });
    ok(target, { type: 'setNodeProps', id, props: { data: { points: 8, innerRatio: 0.3 } } });
    expect(target.query({ type: 'node', id })).toMatchObject({
      data: { points: 8, innerRatio: 0.3 },
    });
    const edited = text(target);

    const copy = editor();
    ok(copy, { type: 'loadDocument', document: JSON.parse(edited) });
    expect(text(copy)).toBe(edited);
    const parsed = parseDocument(edited);
    expect(parsed.ok && parsed.document).toEqual(target.query({ type: 'document' }));

    ok(target, { type: 'undo' });
    expect(target.query({ type: 'node', id })).toMatchObject({ data: { points: 6 } });
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(empty);
    ok(target, { type: 'redo' });
    ok(target, { type: 'redo' });
    expect(text(target)).toBe(edited);
  });

  it('rejects invalid star data on create and edit, changing nothing', () => {
    const target = editor();
    const id = star(target);
    const before = text(target);
    const history = target.query({ type: 'history' });
    for (const data of [
      { points: 2, innerRatio: 0.5 },
      { points: 33, innerRatio: 0.5 },
      { points: 5.5, innerRatio: 0.5 },
      { points: 5, innerRatio: 1 },
      { points: 5, innerRatio: 0 },
      { points: 5, innerRatio: 0.5, extra: 1 },
      [5, 0.5],
      null,
    ]) {
      expect(target.execute({ type: 'setNodeProps', id, props: { data } })).toEqual({
        ok: false,
        code: 'document.invalid-custom-data',
        path: `/nodes/${id}/data`,
      });
    }
    expect(
      target.execute({ type: 'runCommand', id: 'ext.star.create', args: { frame, points: 40 } }),
    ).toEqual({ ok: false, code: 'document.invalid-custom-data', path: '/data' });
    expect(text(target)).toBe(before);
    expect(target.query({ type: 'history' })).toEqual(history);
  });

  it('createCustomNode uses the defaults, and rejects an unknown type', () => {
    const target = editor();
    const [id] = ok(target, { type: 'createCustomNode', customType: 'ext.star', frame });
    expect(target.query({ type: 'node', id: id! })).toMatchObject({
      name: 'ext.star',
      data: { points: 5, innerRatio: 0.5 },
      fill: null,
      stroke: { width: 1 },
    });
    expect(target.execute({ type: 'createCustomNode', customType: 'ext.moon', frame })).toEqual({
      ok: false,
      code: 'document.unknown-custom-type',
      path: '/customType',
    });
    expect(target.execute({ type: 'runCommand', id: 'ext.moon.create' })).toEqual({
      ok: false,
      code: 'editor.unknown-command',
    });
  });

  it('gives a command only execute and query', () => {
    expectTypeOf<keyof ExtensionApi>().toEqualTypeOf<'execute' | 'query'>();
    let seen: ExtensionApi | null = null;
    const spy: Extension = {
      id: 'ext.spy',
      commands: [
        {
          id: 'ext.spy.look',
          run: (_args, api) => {
            seen = api;
            return { ok: true, ids: [] };
          },
        },
      ],
    };
    const target = editor([starExtension, spy]);
    ok(target, { type: 'runCommand', id: 'ext.spy.look' });
    expect(seen).not.toBeNull();
    expect(Object.keys(seen!).sort()).toEqual(['execute', 'query']);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(seen).not.toBe(target);
    expect(seen!.query({ type: 'tool' })).toBe('select');
  });

  it('holds events until an extension command returns', () => {
    const order: string[] = [];
    const twice: Extension = {
      id: 'ext.twice',
      commands: [
        {
          id: 'ext.twice.make',
          run: (_args, api) => {
            api.execute({ type: 'createRectangle', frame });
            order.push('between');
            return api.execute({ type: 'createRectangle', frame });
          },
        },
      ],
    };
    const target = editor([twice]);
    target.subscribe((event: EditorEvent) => order.push(event.type));
    ok(target, { type: 'runCommand', id: 'ext.twice.make' });
    expect(order).toEqual(['between', 'document', 'document']);
    // Each composed command is its own step.
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 2, redoDepth: 0 });
  });

  it('rejects malformed or conflicting registrations at construction', () => {
    const type = starExtension.nodeTypes![0]!;
    const cases: Extension[][] = [
      [{ id: '' }],
      [starExtension, starExtension],
      [{ id: 'ext.other', nodeTypes: [type] }],
      [{ id: 'ext', nodeTypes: [type, type] }],
      [{ id: 'ext.x', commands: [{ id: 'ext.y.run', run: () => ({ ok: true, ids: [] }) }] }],
    ];
    for (const extensions of cases) expect(() => editor(extensions)).toThrow(/createEditor/u);
    // An extension ID may own types and commands below it.
    expect(() => editor([{ id: 'ext', nodeTypes: [type] }])).not.toThrow();
  });
});

describe('P5-A07 custom-node codes', () => {
  it.each([
    ['unknown-custom-type', 'document.unknown-custom-type', '/nodes/n2/customType'],
    ['invalid-custom-data', 'document.invalid-custom-data', '/nodes/n2/data'],
  ])('returns its code for the %s fixture, with no partial document', async (name, code, at) => {
    const target = editor();
    const id = star(target);
    const before = text(target);
    const document = await fixture(`malformed-custom/${name}`);
    expect(target.execute({ type: 'loadDocument', document })).toEqual({
      ok: false,
      code,
      path: at,
    });
    expect(text(target)).toBe(before);
    expect(target.query({ type: 'node', id })).not.toBeNull();
    expect(() => editor([starExtension], document)).toThrow(code);
  });

  it('needs the extension to load a custom node', async () => {
    const document = await fixture('ext-star');
    expect(() => editor([], document)).toThrow('document.unknown-custom-type');
    expect(text(editor([starExtension], document))).toBe(
      await readFile(path.join(fixtures, 'ext-star.json'), 'utf8'),
    );
  });

  it('a throwing validate counts as invalid data', () => {
    const type = {
      ...starExtension.nodeTypes![0]!,
      validate: () => {
        throw new Error('boom');
      },
    };
    const target = editor([{ id: 'ext.star', nodeTypes: [type] }]);
    expect(target.execute({ type: 'createCustomNode', customType: 'ext.star', frame })).toEqual({
      ok: false,
      code: 'document.invalid-custom-data',
      path: '/data',
    });
  });
});

describe('P5-U5 custom geometry', () => {
  it('projects a star as a path node through toScene', () => {
    const target = editor();
    const id = star(target, { points: 5, innerRatio: 0.5 });
    const renderer = new RecordingRenderer();
    target.attachRenderer(renderer);
    const node = renderer.mirror.readRetainedScene()!.getNode(id)!;
    expect(node.transform).toEqual([1, 0, 0, 1, 100, 100]);
    if (node.kind !== 'path') throw new Error('expected a path node');
    expect(node.geometry.verbs).toHaveLength(11);
    expect(node.geometry.points).toHaveLength(20);
    // The first vertex is the top of the frame, frame-local.
    expect(node.geometry.points.slice(0, 2)).toEqual([50, 0]);
    expect(node.style.stroke?.width).toBe(1);
  });

  it('hit tests a star through its geometry', () => {
    const target = editor();
    const id = star(target);
    ok(target, { type: 'setNodeProps', id, props: { fill: { r: 1, g: 0.8, b: 0, a: 1 } } });
    click(target, 150, 150);
    expect(target.query({ type: 'selection' })).toEqual([id]);
    click(target, 105, 180);
    expect(target.query({ type: 'selection' })).toEqual([]);
  });

  it('a throwing or malformed toScene leaves the node out of the scene and hit testing', () => {
    for (const toScene of [
      () => {
        throw new Error('boom');
      },
      () => ({ verbs: ['move', 'line'], points: [0, 0], fillRule: 'nonzero' }) as never,
      () => ({ verbs: ['move'], points: [Number.NaN, 0], fillRule: 'nonzero' }) as never,
    ]) {
      const type = { ...starExtension.nodeTypes![0]!, toScene };
      const target = editor([{ id: 'ext.star', nodeTypes: [type] }]);
      const [id] = ok(target, { type: 'createCustomNode', customType: 'ext.star', frame });
      const renderer = new RecordingRenderer();
      target.attachRenderer(renderer);
      expect(renderer.mirror.readRetainedScene()!.getNode(id!)).toBeUndefined();
      click(target, 150, 150);
      expect(target.query({ type: 'selection' })).toEqual([]);
    }
  });
});
