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
import { hitsNode } from '../../packages/editor-core/src/hit-test.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';

// MVP M6a-U1 interim editor rules (M6a contract, section 16, M6a-U1 notes): editor-core reads
// and writes schema v4 and holds text nodes it cannot lay out yet. Fragment version 2 is written
// at schema v4 and read at 3 and 4, version 1 at 2, with a text node failing at its type below 4
// and rejected inside a copied or carried symbol (section 8);
// `editor.nested-symbol` covers text (M6a-S7); a text node projects nothing (section 7) and,
// until M6a-U3, is never hit; `setNodeProps` takes the common props only (section 6.1).

const root = path.resolve(import.meta.dirname, '../..');
const TEXT = readFileSync(path.join(root, 'tests/fixtures/m6-text/text.v4.json'), 'utf8');
const MARKER = 'vector-studio/fragment\n';
const none = () => null;

function loaded(): Editor {
  return createEditor({ document: JSON.parse(TEXT) as unknown });
}

const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));

/** Runs `command` and checks the editor's document is still a valid v4 document. */
function run(target: Editor, command: Command): CommandResult {
  const result = target.execute(command);
  expect(validateDocument(JSON.parse(text(target))).ok).toBe(true);
  return result;
}

describe('M6a-U1 interim: editor-core at schema v4', () => {
  it('loads the text fixture unchanged and creates empty documents at v4', () => {
    expect(text(loaded())).toBe(TEXT);
    expect(createEditor().query({ type: 'document' }).schemaVersion).toBe(4);
  });

  it('projects nothing for a text node and reports no diagnostic', () => {
    const document = loaded().query({ type: 'document' });
    const projection = projectPage(document, 'page-1', none);
    for (const id of ['t1', 't2', 't3', 't4', 't5']) expect(projection.nodes.has(id)).toBe(false);
    expect(projection.nodes.has('g1')).toBe(true);
  });

  it('never hits a text node until M6a-U3', () => {
    const node = loaded().query({ type: 'node', id: 't1' })!;
    expect(hitsNode(node, { x: 20, y: 15 }, 1, none)).toBe(false);
  });

  it('takes the common props on a text node, and no fill', () => {
    const target = loaded();
    expect(run(target, { type: 'setNodeProps', id: 't1', props: { opacity: 0.5 } }).ok).toBe(true);
    const before = text(target);
    expect(run(target, { type: 'setNodeProps', id: 't1', props: { fill: null } })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/props/fill',
    });
    expect(text(target)).toBe(before);
  });
});

describe('M6a-U1 interim: editor.nested-symbol covers text (M6a-S7)', () => {
  it('fails moving a text node into a symbol and changes nothing', () => {
    const target = loaded();
    run(target, { type: 'setActivePage', id: 'page-2' });
    const before = text(target);
    expect(run(target, { type: 'moveNodes', ids: ['t6'], parent: 's1', index: 0 })).toEqual({
      ok: false,
      code: 'editor.nested-symbol',
      path: '/nodes/t6/parent',
    });
    expect(text(target)).toBe(before);
  });

  it('fails pasting a text node into a symbol scope and changes nothing', () => {
    const target = loaded();
    run(target, { type: 'setActivePage', id: 'page-2' });
    run(target, { type: 'copy', ids: ['t6'] });
    run(target, { type: 'setScope', id: 's1' });
    const before = text(target);
    expect(run(target, { type: 'paste' })).toMatchObject({
      ok: false,
      code: 'editor.nested-symbol',
    });
    expect(text(target)).toBe(before);
  });

  it('fails making a symbol over a group holding text and changes nothing', () => {
    const target = loaded();
    const before = text(target);
    expect(run(target, { type: 'createSymbol', ids: ['g1'] })).toEqual({
      ok: false,
      code: 'editor.nested-symbol',
      path: '/nodes/t4/parent',
    });
    expect(text(target)).toBe(before);
  });
});

describe('M6a-U1 interim: fragments at schema v4 (section 8)', () => {
  type Body = {
    fragmentVersion: number;
    schemaVersion: number;
    roots: string[];
    nodes: Record<string, Record<string, unknown>>;
    sources?: string[];
    sourceNodes?: Record<string, Record<string, unknown>>;
  };
  const bodyOf = (fragment: string) => JSON.parse(fragment.slice(MARKER.length)) as Body;
  const marked = (body: Body) => MARKER + JSON.stringify(body);
  /** The same nodes as fragment version 1, which has no `sources` or `sourceNodes`. */
  const versionOne = (body: Body, schemaVersion: number): Body => ({
    fragmentVersion: 1,
    schemaVersion,
    roots: body.roots,
    nodes: body.nodes,
  });

  function copied(target: Editor, ids: string[]): Body {
    expect(run(target, { type: 'copy', ids }).ok).toBe(true);
    return bodyOf(target.query({ type: 'clipboard' })!);
  }

  it('copies a text node as fragment version 2 at schemaVersion 4 and pastes its runs and props', () => {
    const target = loaded();
    run(target, { type: 'copy', ids: ['t2'] });
    const fragment = target.query({ type: 'clipboard' })!;
    expect(fragment.startsWith(`${MARKER}{"fragmentVersion":2,"schemaVersion":4,`)).toBe(true);
    const pasted = run(target, { type: 'paste' });
    expect(pasted.ok).toBe(true);
    const id = pasted.ok ? pasted.ids[0]! : '';
    expect({ ...target.query({ type: 'node', id })!, id: 't2' }).toEqual(
      target.query({ type: 'node', id: 't2' }),
    );
  });

  it('fails a text node below schema v4 at its type, and versions 2 and 5 of fragment version 2', () => {
    const target = loaded();
    const body = copied(target, ['t1']);
    const before = text(target);
    const typeFailure = { ok: false, code: 'document.invalid-field', path: '/nodes/t1/type' };
    expect(run(target, { type: 'paste', text: marked({ ...body, schemaVersion: 3 }) })).toEqual(
      typeFailure,
    );
    expect(run(target, { type: 'paste', text: marked(versionOne(body, 2)) })).toEqual(typeFailure);
    for (const schemaVersion of [2, 5]) {
      expect(run(target, { type: 'paste', text: marked({ ...body, schemaVersion }) })).toEqual({
        ok: false,
        code: 'document.unsupported-version',
        path: '/schemaVersion',
      });
    }
    // Fragment version 1 stays at schema v2 only.
    expect(run(target, { type: 'paste', text: marked(versionOne(body, 4)) })).toEqual({
      ok: false,
      code: 'document.unsupported-version',
      path: '/schemaVersion',
    });
    expect(text(target)).toBe(before);
  });

  it('still pastes a fragment without text at its older versions', () => {
    const target = loaded();
    run(target, { type: 'setActivePage', id: 'page-2' });
    const body = copied(target, ['s1-r']);
    for (const older of [{ ...body, schemaVersion: 3 }, versionOne(body, 2)]) {
      expect(run(target, { type: 'paste', text: marked(older) }).ok).toBe(true);
    }
  });

  it('rejects a text node inside a copied or a carried symbol (M6a-S7)', () => {
    const target = loaded();
    run(target, { type: 'setActivePage', id: 'page-2' });
    const t6 = copied(target, ['t6']).nodes.t6!;
    const before = text(target);
    const textIn = (parent: string) => ({ ...t6, id: 'st', parent });

    const source = copied(target, ['s1']);
    source.nodes.s1!.children = [...(source.nodes.s1!.children as string[]), 'st'];
    source.nodes.st = textIn('s1');
    expect(run(target, { type: 'paste', text: marked(source) })).toEqual({
      ok: false,
      code: 'document.invalid-symbol',
      path: '/nodes/st/parent',
    });

    const carried = copied(target, ['i1']);
    expect(carried.sources).toEqual(['s1']);
    const sourceNodes = carried.sourceNodes!;
    sourceNodes.s1!.children = [...(sourceNodes.s1!.children as string[]), 'st'];
    sourceNodes.st = textIn('s1');
    expect(run(target, { type: 'paste', text: marked(carried) })).toEqual({
      ok: false,
      code: 'document.invalid-symbol',
      path: '/sourceNodes/st/parent',
    });
    expect(text(target)).toBe(before);
  });
});
