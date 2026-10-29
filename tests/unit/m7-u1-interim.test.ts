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

// MVP M7-U1 interim editor rules (M7 contract, section 16, M7-U1 notes (5) and (6)) that still
// hold: a symbol is a container (section 1.2) and adds a clip level as a frame; fragment version
// 1 carries no symbol or instance until M7-U5. The interim hit-test guards (round 2, S3) were
// lifted by M7-U3 (`m7-u3-projection.test.ts`); the interim delete, move and tree-depth guards
// were replaced by M7-U4's source deletion rule and section 5.3 checks
// (`m7-u4-commands.test.ts`).

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
  it('deletes a source child with its subtree', () => {
    const target = loaded();
    expect(run(target, { type: 'deleteNodes', ids: ['s1-g'] }).ok).toBe(true);
    const after = target.query({ type: 'document' });
    expect(after.nodes['s1-e']).toBeUndefined();
    expect(after.nodes.s1).toMatchObject({ children: ['s1-r', 's1-f'] });
    // Deleting a source whose instance is on another page detaches it (M7-U4, section 5.4):
    // `m7-u4-commands.test.ts`.
  });

  it('enters a symbol as a scope', () => {
    const target = loaded();
    expect(run(target, { type: 'setScope', id: 's1' })).toEqual({ ok: true, ids: [] });
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
