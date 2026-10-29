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

  it('a validate that mutates or freezes its data cannot change what is stored', () => {
    const type = starExtension.nodeTypes![0]!;
    const mutating = {
      ...type,
      validate: (data: unknown) => {
        try {
          (data as { points: number }).points = Infinity;
        } catch {
          // Frozen, as it should be.
        }
        return type.validate(data as never);
      },
    };
    const target = editor([{ id: 'ext.star', nodeTypes: [mutating] }]);
    const [id] = ok(target, { type: 'createCustomNode', customType: 'ext.star', frame });
    expect(target.query({ type: 'node', id: id! })).toMatchObject({ data: { points: 5 } });

    const loose: Extension = {
      id: 'ext.list',
      nodeTypes: [
        {
          customType: 'ext.list',
          validate: (data) => {
            Object.freeze(data);
            return true;
          },
          defaults: () => ({ list: [1, 2] }),
          toScene: () => ({ verbs: [], points: [], fillRule: 'nonzero' }),
        },
      ],
    };
    const other = editor([loose]);
    const [listId] = ok(other, { type: 'createCustomNode', customType: 'ext.list', frame });
    const node = other.query({ type: 'node', id: listId! });
    expect(Object.isFrozen((node as unknown as { data: { list: number[] } }).data.list)).toBe(true);
  });

  it('createCustomNode treats data null as data, and contains a failing defaults()', () => {
    const target = editor();
    expect(
      target.execute({ type: 'createCustomNode', customType: 'ext.star', frame, data: null }),
    ).toEqual({ ok: false, code: 'document.invalid-custom-data', path: '/data' });
    for (const defaults of [
      () => {
        throw new Error('boom');
      },
      () => undefined as never,
      () =>
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('boom');
            },
          },
        ),
    ]) {
      const type = { ...starExtension.nodeTypes![0]!, defaults };
      const broken = editor([{ id: 'ext.star', nodeTypes: [type] }]);
      expect(broken.execute({ type: 'createCustomNode', customType: 'ext.star', frame })).toEqual({
        ok: false,
        code: 'document.invalid-custom-data',
        path: '/data',
      });
    }
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
      [null as never],
      [{ id: 'ext.x', nodeTypes: [{ ...type, customType: 'ext.x', toScene: undefined as never }] }],
      [{ id: 'ext.x', commands: [{ id: 'ext.x.run' } as never] }],
      // Nested extension IDs would give one ID two owners.
      [starExtension, { id: 'ext' }],
      [{ id: 'ext' }, starExtension],
    ];
    for (const extensions of cases) expect(() => editor(extensions)).toThrow(/createEditor/u);
    // An extension ID may own types and commands below it.
    expect(() => editor([{ id: 'ext', nodeTypes: [type] }])).not.toThrow();
  });

  it('calls registered methods on their own object', () => {
    class Bounded {
      readonly customType = 'ext.star';
      readonly max = 6;
      validate(data: unknown) {
        return (data as { points: number }).points <= this.max;
      }
      defaults() {
        return { points: this.max, innerRatio: 0.5 };
      }
      toScene(data: never, frame: never) {
        return starExtension.nodeTypes![0]!.toScene(data, frame);
      }
    }
    const target = editor([{ id: 'ext.star', nodeTypes: [new Bounded()] }]);
    const [id] = ok(target, { type: 'createCustomNode', customType: 'ext.star', frame });
    expect(target.query({ type: 'node', id: id! })).toMatchObject({ data: { points: 6 } });
  });

  it('keeps its own copy of a registration', () => {
    const type = { ...starExtension.nodeTypes![0]! };
    const target = editor([{ id: 'ext.star', nodeTypes: [type] }]);
    type.validate = () => true;
    expect(
      target.execute({
        type: 'createCustomNode',
        customType: 'ext.star',
        frame,
        data: { points: 99, innerRatio: 0.5 },
      }),
    ).toMatchObject({ ok: false, code: 'document.invalid-custom-data' });
  });

  it('contains a throwing, malformed or runaway extension command', async () => {
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);
    process.on('unhandledRejection', onError);
    try {
      const bad: Extension = {
        id: 'ext.bad',
        commands: [
          {
            id: 'ext.bad.throw',
            run: (_args, api) => {
              api.execute({ type: 'createRectangle', frame });
              throw new Error('boom');
            },
          },
          { id: 'ext.bad.undefined', run: () => undefined as never },
          { id: 'ext.bad.code', run: () => ({ ok: false, code: 'made.up' }) as never },
          { id: 'ext.bad.ids', run: () => ({ ok: true, ids: ['not-a-node'] }) },
          {
            id: 'ext.bad.loop',
            run: (_args, api) => api.execute({ type: 'runCommand', id: 'ext.bad.loop' }),
          },
        ],
      };
      const target = editor([bad]);
      expect(target.execute({ type: 'runCommand', id: 'ext.bad.throw' })).toEqual({
        ok: false,
        code: 'editor.extension-failed',
      });
      // What it composed before the throw stays, and the editor keeps working.
      expect(target.query({ type: 'document' }).pages[0]!.children).toHaveLength(1);
      expect(target.execute({ type: 'runCommand', id: 'ext.bad.undefined' })).toEqual({
        ok: false,
        code: 'editor.extension-failed',
      });
      for (const id of ['ext.bad.code', 'ext.bad.ids']) {
        expect(target.execute({ type: 'runCommand', id })).toEqual({
          ok: false,
          code: 'editor.extension-failed',
        });
      }
      expect(target.execute({ type: 'runCommand', id: 'ext.bad.loop' })).toEqual({
        ok: false,
        code: 'editor.extension-failed',
      });
      ok(target, { type: 'createRectangle', frame });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errors).toHaveLength(1);
    } finally {
      process.off('unhandledRejection', onError);
    }
  });

  it('a custom node moves and resizes like any other, and runCommand ends a drag', () => {
    const target = editor();
    const id = star(target);
    ok(target, { type: 'setNodeProps', id, props: { fill: { r: 1, g: 0.8, b: 0, a: 1 } } });
    ok(target, {
      type: 'setFrames',
      frames: [{ id, frame: { x: 0, y: 0, width: 50, height: 80 } }],
    });
    expect(target.query({ type: 'node', id })?.frame).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 80,
    });
    // A drag through the star's middle moves it.
    for (const [kind, x, y] of [
      ['pointerdown', 25, 40],
      ['pointermove', 35, 50],
      ['pointerup', 45, 60],
    ] as const) {
      ok(target, { type: 'input', event: { kind, point: { x, y }, modifiers: none } });
    }
    expect(target.query({ type: 'node', id })?.frame).toMatchObject({ x: 20, y: 20 });
    // A drag in progress is cancelled by an extension command, which is its own step.
    const depth = target.query({ type: 'history' }).undoDepth;
    ok(target, {
      type: 'input',
      event: { kind: 'pointerdown', point: { x: 45, y: 60 }, modifiers: none },
    });
    ok(target, {
      type: 'input',
      event: { kind: 'pointermove', point: { x: 90, y: 90 }, modifiers: none },
    });
    star(target);
    expect(target.query({ type: 'node', id })?.frame).toMatchObject({ x: 20, y: 20 });
    expect(target.query({ type: 'history' }).undoDepth).toBe(depth + 1);
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
    // The v1 fixture loads migrated to the latest schema (MVP M1 contract, section 2.1), v4
    // since M6a-U1 (M6a contract, section 2.1).
    expect(text(editor([starExtension], document))).toBe(
      await readFile(path.join(root, 'tests/fixtures/m6-text/migrated/ext-star.v4.json'), 'utf8'),
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
      // The renderer's path grammar: a `move` opens every subpath.
      () =>
        ({
          verbs: ['move', 'line', 'line', 'close', 'line'],
          points: [0, 0, 100, 0, 100, 100, 50, 50],
          fillRule: 'nonzero',
        }) as never,
      () =>
        ({
          verbs: ['line', 'line', 'line', 'close'],
          points: [0, 0, 100, 0, 100, 100],
          fillRule: 'nonzero',
        }) as never,
      () => ({ verbs: [], points: [], fillRule: 'nonzero' }) as never,
    ]) {
      const type = { ...starExtension.nodeTypes![0]!, toScene };
      const target = editor([{ id: 'ext.star', nodeTypes: [type] }]);
      const [id] = ok(target, { type: 'createCustomNode', customType: 'ext.star', frame });
      const renderer = new RecordingRenderer();
      const events: EditorEvent[] = [];
      target.subscribe((event) => events.push(event));
      target.attachRenderer(renderer);
      expect(renderer.mirror.readRetainedScene()!.getNode(id!)).toBeUndefined();
      expect(events.filter((event) => event.type === 'diagnostic')).toEqual([]);
      click(target, 150, 150);
      expect(target.query({ type: 'selection' })).toEqual([]);
    }
  });
});
