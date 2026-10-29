import { readFileSync } from 'node:fs';
import path from 'node:path';
import { serializeDocument, validateDocument } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
} from '../../packages/editor-core/src/index.js';

// MVP M7-U1 interim editor rules (M7 contract, section 16, M7-U1 notes (5) and (6)): until M7-U4
// and M7-U5, no command commits a document that breaks M7-S2 or M7-S3. A symbol is a container
// (section 1.2); deleting a source that still has instances elsewhere fails; nothing moves a
// symbol or instance into a symbol; fragment version 1 carries no symbol or instance. The
// interim hit-test guards (round 2, S3) are lifted by M7-U3, whose behaviour
// `m7-u3-projection.test.ts` tests.

const root = path.resolve(import.meta.dirname, '../..');
const SYMBOLS = readFileSync(path.join(root, 'tests/fixtures/m7-symbols/symbols.v3.json'), 'utf8');
const MARKER = 'vector-studio/fragment\n';
const START = { horizontal: 'start', vertical: 'start' } as const;

function loaded(): Editor {
  return createEditor({ document: JSON.parse(SYMBOLS) as unknown });
}

const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));

/** Runs `command` and checks the editor's document is still a valid v3 document. */
function run(target: Editor, command: Command): CommandResult {
  const result = target.execute(command);
  expect(validateDocument(JSON.parse(text(target))).ok).toBe(true);
  return result;
}

describe('M7-U1 interim: a symbol is a container', () => {
  it('deletes a source child with its subtree, and fails a source whose instance is on another page', () => {
    const target = loaded();
    expect(run(target, { type: 'deleteNodes', ids: ['s1-g'] }).ok).toBe(true);
    const after = target.query({ type: 'document' });
    expect(after.nodes['s1-e']).toBeUndefined();
    expect(after.nodes.s1).toMatchObject({ children: ['s1-r', 's1-f'] });
    // s2 is on page 2 and its only instance, i3, on page 1.
    const both = loaded();
    expect(run(both, { type: 'setActivePage', id: 'page-2' }).ok).toBe(true);
    expect(run(both, { type: 'deleteNodes', ids: ['s2'] })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/ids',
    });
  });

  it('enters a symbol as a scope', () => {
    const target = loaded();
    expect(run(target, { type: 'setScope', id: 's1' })).toEqual({ ok: true, ids: [] });
  });
});

describe('M7-U1 interim: source deletion fails while instances remain elsewhere', () => {
  it.each<[string, (target: Editor) => Command[], string]>([
    ['deleteNodes of the source', () => [{ type: 'deleteNodes', ids: ['s1'] }], '/ids'],
    [
      'deleteNodes of the source with one of its instances',
      () => [{ type: 'deleteNodes', ids: ['s1', 'i1'] }],
      '/ids',
    ],
    ['cut of the source', () => [{ type: 'cut', ids: ['s1'] }], '/ids'],
    ['removePage of the source page', () => [{ type: 'removePage', id: 'page-1' }], '/id'],
    [
      'removePage of a page whose source has an instance on page 1',
      () => [{ type: 'removePage', id: 'page-2' }],
      '/id',
    ],
  ])('%s fails with editor.invalid-command and changes nothing', (_name, commands, at) => {
    const target = loaded();
    const before = text(target);
    for (const command of commands(target)) {
      expect(run(target, command)).toEqual({ ok: false, code: 'editor.invalid-command', path: at });
    }
    expect(text(target)).toBe(before);
    expect(target.query({ type: 'clipboard' })).toBeNull();
  });

  it('deletes instances and a symbol whose instances are all deleted with it', () => {
    const target = loaded();
    expect(run(target, { type: 'deleteNodes', ids: ['i1', 'i3'] }).ok).toBe(true);
    expect(run(target, { type: 'setActivePage', id: 'page-2' }).ok).toBe(true);
    expect(run(target, { type: 'deleteNodes', ids: ['s2'] }).ok).toBe(true);
    expect(run(target, { type: 'deleteNodes', ids: ['g1', 'f2'] }).ok).toBe(true);
    expect(run(target, { type: 'removePage', id: 'page-1' }).ok).toBe(true);
    const after = target.query({ type: 'document' });
    expect(Object.values(after.nodes).filter((node) => node.type === 'instance')).toEqual([]);
    expect(after.nodes.s1).toBeUndefined();
  });
});

describe('M7-U1 interim: nothing moves a symbol or an instance into a symbol', () => {
  it('fails moveNodes of an instance into a source with editor.invalid-parent', () => {
    const target = loaded();
    const before = text(target);
    expect(run(target, { type: 'moveNodes', ids: ['i1'], parent: 's1', index: 0 })).toEqual({
      ok: false,
      code: 'editor.invalid-parent',
      path: '/parent',
    });
    expect(run(target, { type: 'moveNodes', ids: ['i1'], parent: 's1-g', index: 0 })).toEqual({
      ok: false,
      code: 'editor.invalid-parent',
      path: '/parent',
    });
    expect(text(target)).toBe(before);
  });

  it('moves a plain node into a source', () => {
    const target = loaded();
    expect(
      run(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 5, height: 5 } }).ok,
    ).toBe(true);
    const document = target.query({ type: 'document' });
    const created = document.pages[0]!.children.at(-1)!;
    expect(run(target, { type: 'moveNodes', ids: [created], parent: 's1', index: 0 }).ok).toBe(
      true,
    );
    expect(target.query({ type: 'document' }).nodes[created]!.parent).toBe('s1');
  });
});

describe('M7-U1 interim: fragment version 1 carries no symbol or instance', () => {
  const symbolNode = {
    id: 's',
    name: 's',
    parent: '',
    frame: { x: 0, y: 0, width: 10, height: 10 },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type: 'symbol',
    children: [],
    fill: null,
    stroke: null,
  };
  const instanceNode = { ...symbolNode, id: 'i', type: 'instance', symbol: 's' } as Record<
    string,
    unknown
  >;
  delete instanceNode.children;
  delete instanceNode.fill;
  delete instanceNode.stroke;

  it.each([2, 3])(
    'rejects a symbol and an instance at schemaVersion %i with document.invalid-field at /type',
    (schemaVersion) => {
      const target = loaded();
      const before = text(target);
      const fragment = (nodes: Record<string, unknown>, roots: string[]) =>
        `${MARKER}${JSON.stringify({ fragmentVersion: 1, schemaVersion, roots, nodes })}`;
      expect(
        run(target, {
          type: 'paste',
          text: fragment({ s: symbolNode, i: instanceNode }, ['s', 'i']),
        }),
      ).toEqual({
        ok: false,
        code: 'document.invalid-field',
        path: '/nodes/s/type',
      });
      expect(run(target, { type: 'paste', text: fragment({ i: instanceNode }, ['i']) })).toEqual({
        ok: false,
        code: 'document.invalid-field',
        path: '/nodes/i/type',
      });
      expect(text(target)).toBe(before);
    },
  );

  it('fails a copy or cut of a symbol or an instance, keeping the clipboard', () => {
    const target = loaded();
    const before = text(target);
    for (const ids of [['s1'], ['i1'], ['s1-r', 'i1']]) {
      for (const type of ['copy', 'cut'] as const) {
        expect(run(target, { type, ids })).toEqual({
          ok: false,
          code: 'editor.invalid-command',
          path: '/ids',
        });
      }
    }
    expect(text(target)).toBe(before);
    expect(target.query({ type: 'clipboard' })).toBeNull();
    // A source child alone copies and pastes.
    expect(run(target, { type: 'copy', ids: ['s1-r'] }).ok).toBe(true);
    expect(run(target, { type: 'paste' }).ok).toBe(true);
  });
});

describe('M7-U1 interim: commands keep the M7-S5 tree depth through an expansion (round 2, S2)', () => {
  const DEEP = readFileSync(
    path.join(root, 'tests/fixtures/m7-symbols/depth/tree-256.json'),
    'utf8',
  );

  it('fails the command that deepens a source past 256 with the model code, changing nothing', () => {
    const target = createEditor({ document: JSON.parse(DEEP) as unknown });
    const frame = run(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 5, height: 5 },
      parent: 'a126',
    });
    expect(frame.ok).toBe(true);
    const id = frame.ok ? frame.ids[0]! : '';
    const before = text(target);
    expect(
      run(target, {
        type: 'createRectangle',
        frame: { x: 0, y: 0, width: 1, height: 1 },
        parent: id,
      }),
    ).toEqual({ ok: false, code: 'document.invalid-field', path: '/nodes/i/parent' });
    expect(text(target)).toBe(before);
    // The same rectangle under a frame that is not in the source is within the bound.
    expect(
      run(target, {
        type: 'createRectangle',
        frame: { x: 0, y: 0, width: 1, height: 1 },
        parent: 'b0',
      }).ok,
    ).toBe(true);
  });
});

describe('M7-U1 interim: a symbol adds a clip level as a frame (round 2, M4)', () => {
  /** A container `top` on the page holding 32 nested frames f0 to f31. */
  function nested(top: 'symbol' | 'group') {
    const nodes: Record<string, unknown> = {
      t: {
        id: 't',
        name: 't',
        parent: 'p',
        frame: { x: 0, y: 0, width: 10, height: 10 },
        rotation: 0,
        constraints: START,
        opacity: 1,
        visible: true,
        type: top,
        children: ['f0'],
        ...(top === 'symbol' ? { fill: null, stroke: null } : {}),
      },
    };
    for (let level = 0; level < 32; level += 1) {
      nodes[`f${level}`] = {
        id: `f${level}`,
        name: `f${level}`,
        parent: level === 0 ? 't' : `f${level - 1}`,
        frame: { x: 0, y: 0, width: 10, height: 10 },
        rotation: 0,
        constraints: START,
        opacity: 1,
        visible: true,
        type: 'frame',
        children: level < 31 ? [`f${level + 1}`] : [],
        fill: null,
        stroke: null,
      };
    }
    return { schemaVersion: 3, id: 'd', pages: [{ id: 'p', name: 'P', children: ['t'] }], nodes };
  }

  it('rejects a frame at clip depth 32 inside a symbol on load, which a group allows', () => {
    const target = createEditor();
    expect(target.execute({ type: 'loadDocument', document: nested('group') }).ok).toBe(true);
    expect(target.execute({ type: 'loadDocument', document: nested('symbol') })).toEqual({
      ok: false,
      code: 'editor.clip-depth',
      path: '/nodes/f31/parent',
    });
  });
});
