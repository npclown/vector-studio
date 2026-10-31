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
import { ExpansionCache } from '../../packages/editor-core/src/expansion.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import { TextLayoutCache } from '../../packages/editor-core/src/text.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// MVP M6a-U1 interim editor rules (M6a contract, section 16, M6a-U1 notes): editor-core reads
// and writes schema v4 and holds text nodes it cannot lay out yet. Fragment version 2 is written
// at schema v4 and read at 3 and 4, version 1 at 2, with a text node failing at its type below 4
// and rejected inside a copied or carried symbol (section 8);
// `editor.nested-symbol` covers text (M6a-S7); a text node projects nothing (section 7; since
// M6c, only without a layout port);
// `setNodeProps` takes the common props only (section 6.1). M6a-U3 replaced the interim hit
// rule (tests/unit/m6a-u3-text-editor.test.ts). M7-U7 (section 9) moved the editor to schema v5,
// with fragment version 2 written at v5 and read at 3 to 5, and lifted M6a-S7 (M7-T1): the
// nesting cases below now succeed (tests/unit/m7-u7-text-symbols.test.ts covers the rest).
// M4-U1 (M4 contract, sections 2.1 and 7) moved it to schema v6, with fragment version 2 written
// at v6 and read at 3 to 6.

const root = path.resolve(import.meta.dirname, '../..');
const TEXT = readFileSync(path.join(root, 'tests/fixtures/m6-text/text.v4.json'), 'utf8');
/** Its v6 migration (M6a contract, section 9; M4 contract, section 2.1). */
const TEXT_V6 = readFileSync(
  path.join(root, 'tests/fixtures/m4-appearance/migrated/text.v6.json'),
  'utf8',
);
const MARKER = 'vector-studio/fragment\n';
const none = () => null;

function loaded(): Editor {
  return createEditor({ document: JSON.parse(TEXT) as unknown });
}

const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));

/** Runs `command` and checks the editor's document is still a valid v5 document. */
function run(target: Editor, command: Command): CommandResult {
  const result = target.execute(command);
  expect(validateDocument(JSON.parse(text(target))).ok).toBe(true);
  return result;
}

describe('M6a-U1 interim: editor-core at schema v4, v6 since M4-U1', () => {
  it('loads the text fixture as its v6 migration and creates empty documents at v6', () => {
    expect(text(loaded())).toBe(TEXT_V6);
    expect(createEditor().query({ type: 'document' }).schemaVersion).toBe(6);
  });

  // M6c (contract section 1.2): replaces the M6a section 7 rule. Without a layout port a text
  // node still projects nothing, now listed for the `editor.text-unavailable` diagnostic
  // (M6c-P3); with one it projects a text leaf (tests/unit/m6c-u1-text-projection.test.ts).
  it('projects nothing for a text node without a layouter, and lists it as left out', () => {
    const document = loaded().query({ type: 'document' });
    const projection = projectPage(document, 'page-1', none);
    for (const id of ['t1', 't2', 't3', 't4', 't5']) expect(projection.nodes.has(id)).toBe(false);
    expect(projection.nodes.has('g1')).toBe(true);
    expect([...projection.textless].sort()).toEqual(['t1', 't2', 't3', 't4', 't5']);
    const cache = new TextLayoutCache(createFakeTextLayout());
    const laidOut = projectPage(
      document,
      'page-1',
      none,
      new Set(),
      undefined,
      new ExpansionCache(),
      undefined,
      (node) => cache.layout(node),
    );
    for (const id of ['t1', 't2', 't3', 't4', 't5']) {
      expect(laidOut.nodes.get(id)?.kind).toBe('text');
    }
    expect(laidOut.textless).toEqual([]);
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

describe('M6a-U1 interim lifted by M7-U7: text may enter a symbol (M7-T1)', () => {
  it('moves a text node into a symbol', () => {
    const target = loaded();
    run(target, { type: 'setActivePage', id: 'page-2' });
    expect(run(target, { type: 'moveNodes', ids: ['t6'], parent: 's1', index: 0 })).toEqual({
      ok: true,
      ids: [],
    });
    expect(target.query({ type: 'node', id: 't6' })!.parent).toBe('s1');
  });

  it('pastes a text node into a symbol scope', () => {
    const target = loaded();
    run(target, { type: 'setActivePage', id: 'page-2' });
    run(target, { type: 'copy', ids: ['t6'] });
    run(target, { type: 'setScope', id: 's1' });
    const pasted = run(target, { type: 'paste' });
    expect(pasted.ok).toBe(true);
    const id = pasted.ok ? pasted.ids[0]! : '';
    expect(target.query({ type: 'node', id })!.parent).toBe('s1');
  });

  it('makes a symbol over a group holding text', () => {
    const target = loaded();
    const made = run(target, { type: 'createSymbol', ids: ['g1'] });
    expect(made.ok).toBe(true);
    expect(target.query({ type: 'node', id: 'g1' })!.parent).toBe(made.ok ? made.ids[0] : '');
  });
});

describe('M6a-U1 interim: fragments at schema v4, v6 since M4-U1 (section 8)', () => {
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

  it('copies a text node as fragment version 2 at schemaVersion 6 and pastes its runs and props', () => {
    const target = loaded();
    run(target, { type: 'copy', ids: ['t2'] });
    const fragment = target.query({ type: 'clipboard' })!;
    expect(fragment.startsWith(`${MARKER}{"fragmentVersion":2,"schemaVersion":6,`)).toBe(true);
    const pasted = run(target, { type: 'paste' });
    expect(pasted.ok).toBe(true);
    const id = pasted.ok ? pasted.ids[0]! : '';
    expect({ ...target.query({ type: 'node', id })!, id: 't2' }).toEqual(
      target.query({ type: 'node', id: 't2' }),
    );
  });

  it('fails a text node below schema v4 at its type, and versions 2 and 7 of fragment version 2', () => {
    const target = loaded();
    const body = copied(target, ['t1']);
    const before = text(target);
    const typeFailure = { ok: false, code: 'document.invalid-field', path: '/nodes/t1/type' };
    expect(run(target, { type: 'paste', text: marked({ ...body, schemaVersion: 3 }) })).toEqual(
      typeFailure,
    );
    expect(run(target, { type: 'paste', text: marked(versionOne(body, 2)) })).toEqual(typeFailure);
    for (const schemaVersion of [2, 7]) {
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
    // Schema v4 still reads a text node.
    expect(run(target, { type: 'paste', text: marked({ ...body, schemaVersion: 4 }) }).ok).toBe(
      true,
    );
  });

  it('still pastes a fragment without text at its older versions', () => {
    const target = loaded();
    run(target, { type: 'setActivePage', id: 'page-2' });
    const body = copied(target, ['s1-r']);
    for (const older of [{ ...body, schemaVersion: 3 }, versionOne(body, 2)]) {
      expect(run(target, { type: 'paste', text: marked(older) }).ok).toBe(true);
    }
  });

  it('accepts a text node inside a copied or a carried symbol since M7-U7 (M7-T1)', () => {
    const target = loaded();
    run(target, { type: 'setActivePage', id: 'page-2' });
    const t6 = copied(target, ['t6']).nodes.t6!;
    const textIn = (parent: string) => ({ ...t6, id: 'st', parent });

    const source = copied(target, ['s1']);
    source.nodes.s1!.children = [...(source.nodes.s1!.children as string[]), 'st'];
    source.nodes.st = textIn('s1');
    expect(run(target, { type: 'paste', text: marked(source) }).ok).toBe(true);

    const carried = copied(target, ['i1']);
    expect(carried.sources).toEqual(['s1']);
    const sourceNodes = carried.sourceNodes!;
    sourceNodes.s1!.children = [...(sourceNodes.s1!.children as string[]), 'st'];
    sourceNodes.st = textIn('s1');
    // The carried source differs from the document's, so the instance pastes detached.
    const pasted = run(target, { type: 'paste', text: marked(carried) });
    expect(pasted.ok).toBe(true);
    const id = pasted.ok ? pasted.ids[0]! : '';
    expect(target.query({ type: 'node', id })!.type).toBe('frame');
  });
});
