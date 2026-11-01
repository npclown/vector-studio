import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createCounterIdSource,
  createEditor,
  extensionCommand as coreExtensionCommand,
  starExtension,
  type Command,
  type Editor,
  type EditorOptions,
  type EditorSnapshot,
  type Query,
  type QueryResult,
} from '@vector-studio/editor-core';
import { serializeDocument } from '@vector-studio/model';
import {
  EditorProvider,
  extensionCommand,
  useActivePage,
  useEditorQuery,
  useEditorSelector,
  useHistory,
  useNode,
  usePages,
  useScope,
  useSelection,
  useSnapping,
  useTool,
  useViewport,
  type StarCreateArgs,
} from '@vector-studio/react';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  STRUCTURAL_QUERIES,
  createQueryStore,
  createSelectorStore,
  createStoreMemo,
  defaultQueryEquality,
  historyEqual,
  nodeSelector,
  snapshotSelectors,
  structuralEqual,
  type EditorStore,
} from '../../packages/react/src/store.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';
import { compileConsumer, computeReach, type ReachedName } from '../support/m8-type-reach.js';

// MVP M8 contract, unit M8-U2: the `react` half of M8-T2 and M8-T3 (M8-A02), the named hooks,
// `useEditorQuery` and the store adapters (M8-H1, H3, H4, M8-A03), the equality option (M8-H2,
// M8-A04) and the client directive (M8-H5, M8-A06). The reach is computed from the built
// declarations, so `pnpm typecheck` (or a build) runs first, as in `pnpm check`. P5-A11 (clean
// Node import, prerender) stays in `tests/unit/p5-react.test.ts`.

const root = path.resolve(import.meta.dirname, '../..');
const REACT = 'packages/react';
const EDITOR_CORE = 'packages/editor-core';
const MODEL = 'packages/model';
const CONTRACTS = 'packages/contracts';
const frame = { x: 10, y: 20, width: 30, height: 40 };

async function runtimeKeys(dir: string): Promise<string[]> {
  const module = (await import(
    pathToFileURL(path.join(root, dir, 'dist/index.js')).href
  )) as object;
  return Object.keys(module).sort();
}

describe('M8-A02 react re-exports the editor-core types and one value (M8-T2, T3)', () => {
  const reach = computeReach(REACT);
  const reachedTypes = reach.names.filter((name) => name.viaType || (name.root && name.isType));
  const exported = new Map(reach.exports.map((entry) => [entry.name, entry]));
  const coreTypes = reach
    .entryExports(EDITOR_CORE)
    .filter((entry) => entry.isType && !entry.isValue);

  it('builds the program from the built declarations without diagnostics', () => {
    expect(reach.diagnostics).toEqual([]);
    const owners = new Set(reachedTypes.map((name) => name.owner));
    expect([...owners].sort()).toEqual([CONTRACTS, EDITOR_CORE, MODEL, REACT]);
    // The two public names M8-U1 added beyond the contract's list (U1 notes) are in the reach.
    const names = reachedTypes.map((name) => name.name);
    for (const name of ['ExtensionSummary', 'ExtensionCommandBuilder', 'StarCreateArgs']) {
      expect(names).toContain(name);
    }
  });

  it('re-exports every type export of editor-core, type only, with its name unchanged', () => {
    const reExported = reach.exports.filter((entry) => entry.owner !== REACT && !entry.isValue);
    expect(reExported.map((entry) => entry.name)).toEqual(coreTypes.map((entry) => entry.name));
    for (const entry of reExported) {
      const core = coreTypes.find((other) => other.name === entry.name)!;
      expect(entry, entry.name).toMatchObject({
        declaredName: core.declaredName,
        owner: core.owner,
        typeOnly: true,
        isType: true,
        isValue: false,
      });
    }
  });

  it('declares every reached name in the entry of its owner package (owner-export check)', () => {
    // A reached declaration its own package does not export (an internal type leaking through a
    // public signature) fails here with its owner and name, before the consumer fixture does.
    const internal = (name: ReachedName) => {
      const entry = reach.entryExports(name.owner).find((other) => other.name === name.name);
      return entry === undefined || entry.declaredName !== name.name || entry.owner !== name.owner;
    };
    expect(
      reachedTypes.filter(internal).map((name) => `${name.owner}: ${name.name} is not exported`),
    ).toEqual([]);
  });

  it('lets a consumer of react alone name every reached type', () => {
    const names = reachedTypes.map((name) => name.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(exported.get(name), name).toBeDefined();
    // Generic types are named without arguments, so the fixture imports and re-exports them;
    // a name the entry does not export fails the import with TS2305.
    const source = [
      `import type { ${names.join(', ')} } from '@vector-studio/react';`,
      `export type { ${names.join(', ')} };`,
    ].join('\n');
    expect(compileConsumer(source)).toEqual([]);
  });

  it('re-exports no editor-core value other than extensionCommand, not even as a type', () => {
    for (const value of [
      'createEditor',
      'starExtension',
      'DEFAULT_KEYMAP',
      'DOCUMENT_ERROR_CODES',
    ]) {
      const errors = compileConsumer(
        [
          `import type { ${value} } from '@vector-studio/react';`,
          `export type Value = typeof ${value};`,
        ].join('\n'),
      );
      expect(errors, value).toHaveLength(1);
      // TS2305, or TS2724 when the compiler suggests a similar name.
      expect(errors[0], value).toMatch(
        new RegExp(`^TS(2305|2724): .*has no exported member (named )?'${value}'`, 'u'),
      );
    }
  });

  it('has the P5 runtime exports plus the section 3 hooks and extensionCommand', async () => {
    expect(await runtimeKeys(REACT)).toEqual([
      'EditorCanvas',
      'EditorProvider',
      'extensionCommand',
      'useActivePage',
      'useEditor',
      'useEditorCommands',
      'useEditorQuery',
      'useEditorSelector',
      'useHistory',
      'useNode',
      'usePages',
      'useScope',
      'useSelection',
      'useSnapping',
      'useTool',
      'useViewport',
    ]);
    const values = reach.exports.filter((entry) => entry.isValue);
    expect(values.filter((entry) => entry.owner !== REACT).map((entry) => entry.name)).toEqual([
      'extensionCommand',
    ]);
    // The one value re-export is editor-core's builder itself.
    expect(extensionCommand).toBe(coreExtensionCommand);
    expect(extensionCommand<StarCreateArgs>('ext.star.create').command({ frame })).toStrictEqual({
      type: 'runCommand',
      id: 'ext.star.create',
      args: { frame },
    });
  });
});

describe('M8-A06 the react entry is a client module (M8-H5)', () => {
  it('begins the source and the built dist/index.js with the use client directive', async () => {
    for (const file of ['src/index.ts', 'dist/index.js']) {
      const text = await readFile(path.join(root, REACT, file), 'utf8');
      expect(text.split('\n')[0], file).toBe("'use client';");
    }
  });
});

/** An editor over one empty page `p1`, so the first node created is `n1`. */
function editor(options: Partial<EditorOptions> = {}): Editor {
  return createEditor({
    document: {
      schemaVersion: 6,
      id: 'doc',
      pages: [{ id: 'p1', name: 'Page 1', children: [] }],
      nodes: {},
    },
    ids: createCounterIdSource('n'),
    ...options,
  });
}

function run(target: Editor, command: Command): void {
  const result = target.execute(command);
  expect(result.ok, `${command.type}: ${JSON.stringify(result)}`).toBe(true);
}

/** A store whose `onChange` calls are counted, subscribed until the test ends. */
function subscribed<T>(store: EditorStore<T>): { store: EditorStore<T>; changes: () => number } {
  let count = 0;
  store.subscribe(() => {
    count += 1;
  });
  return { store, changes: () => count };
}

type NamedField = keyof typeof snapshotSelectors;
const fields = Object.keys(snapshotSelectors) as NamedField[];
const field = (snapshot: EditorSnapshot, name: NamedField): unknown =>
  name === 'pages' ? snapshot.document.pages : snapshot[name];
/** The store a named hook builds: its selector, and `historyEqual` for `useHistory`. */
const hookStore = (target: Editor, name: NamedField) =>
  createSelectorStore<unknown>(
    target,
    snapshotSelectors[name],
    name === 'history' ? (historyEqual as (a: unknown, b: unknown) => boolean) : undefined,
  );

describe('M8-A03 the named hooks over their store adapters (M8-H1, H4)', () => {
  it('names one selector per hook of section 3, each the literal snapshot field', () => {
    expect(fields).toEqual([
      'selection',
      'activePage',
      'pages',
      'tool',
      'history',
      'snapping',
      'viewport',
      'scope',
    ]);
    expect(Object.isFrozen(snapshotSelectors)).toBe(true);
  });

  it('returns the literal field after commands, undo, page switch and load', () => {
    const target = editor();
    const stores = fields.map((name) => [name, hookStore(target, name)] as const);
    const node = createSelectorStore(target, nodeSelector('n1'));
    const expectFields = () => {
      const snapshot = target.getSnapshot();
      for (const [name, store] of stores) {
        // The history object is rebuilt with every snapshot: its value is the literal field.
        if (name === 'history') expect(store.getSnapshot(), name).toEqual(snapshot.history);
        else expect(store.getSnapshot(), name).toBe(field(snapshot, name));
      }
      expect(node.getSnapshot()).toBe(snapshot.document.nodes['n1'] ?? null);
    };
    expectFields();
    expect(node.getSnapshot()).toBeNull();
    const steps: Command[] = [
      { type: 'createRectangle', frame },
      { type: 'createEllipse', frame },
      { type: 'setSelection', ids: ['n1', 'n2'] },
      { type: 'groupNodes', ids: ['n1', 'n2'], kind: 'group' },
      { type: 'setScope', id: 'n3' },
      { type: 'setTool', tool: 'rectangle' },
      { type: 'setSnapping', enabled: false },
      { type: 'setViewport', camera: { position: { x: 5, y: 6 }, zoom: 2 } },
      { type: 'undo' },
      { type: 'redo' },
      { type: 'setNodeProps', id: 'n1', props: { name: 'Renamed' } },
      { type: 'addPage', name: 'Second' },
    ];
    for (const command of steps) {
      run(target, command);
      expectFields();
    }
    const snapshot = target.getSnapshot();
    expect(stores.map(([name, store]) => [name, store.getSnapshot()])).toEqual([
      ['selection', snapshot.selection],
      ['activePage', 'p1'],
      ['pages', snapshot.document.pages],
      ['tool', 'rectangle'],
      ['history', { undoDepth: 5, redoDepth: 0 }],
      ['snapping', false],
      ['viewport', { position: { x: 5, y: 6 }, zoom: 2 }],
      ['scope', snapshot.scope],
    ]);
    expect((node.getSnapshot() as { name: string }).name).toBe('Renamed');
    const second = snapshot.document.pages[1]!.id;
    run(target, { type: 'setActivePage', id: second });
    expectFields();
    expect(stores[1]![1].getSnapshot()).toBe(second);
    expect(stores[7]![1].getSnapshot()).toBeNull();
    run(target, { type: 'undo' });
    expectFields();
    expect(stores[2]![1].getSnapshot()).toHaveLength(1);
    const saved = serializeDocument(target.query({ type: 'document' }));
    run(target, { type: 'deleteNodes', ids: ['n3'] });
    expectFields();
    expect(node.getSnapshot()).toBeNull();
    run(target, { type: 'loadDocument', document: JSON.parse(saved) as unknown });
    expectFields();
    expect(stores[4]![1].getSnapshot()).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect((node.getSnapshot() as { name: string }).name).toBe('Renamed');
  });

  it('keeps each reference between unrelated events', () => {
    const target = editor();
    run(target, { type: 'createRectangle', frame });
    const stores = fields.map((name) => subscribed(hookStore(target, name)));
    const node = createSelectorStore(target, nodeSelector('n1'));
    const before = stores.map(({ store }) => store.getSnapshot());
    const nodeBefore = node.getSnapshot();
    // A tool change replaces the snapshot and changes only `tool`.
    run(target, { type: 'setTool', tool: 'ellipse' });
    expect(stores[0]!.changes()).toBe(1);
    const after = stores.map(({ store }) => store.getSnapshot());
    fields.forEach((name, index) => {
      if (name === 'tool') expect(after[index]).toBe('ellipse');
      else expect(after[index], name).toBe(before[index]);
    });
    expect(node.getSnapshot()).toBe(nodeBefore);
    // A document change elsewhere keeps the node's reference too.
    run(target, { type: 'createEllipse', frame });
    expect(node.getSnapshot()).toBe(nodeBefore);
    expect(stores[0]!.store.getSnapshot()).toBe(before[0]);
    // The history hook follows a change of depth with a new value.
    const history = stores[fields.indexOf('history')]!.store.getSnapshot();
    expect(history).not.toBe(before[fields.indexOf('history')]);
    expect(history).toStrictEqual({ undoDepth: 2, redoDepth: 0 });
  });

  it('reads only own node keys', () => {
    const target = editor();
    for (const id of ['constructor', '__proto__', 'toString', 'missing']) {
      expect(createSelectorStore(target, nodeSelector(id)).getSnapshot(), id).toBeNull();
    }
  });

  it('shares one subscribe per editor and unsubscribes', () => {
    const target = editor();
    const a = createSelectorStore(target, snapshotSelectors.tool);
    const b = createQueryStore(target, { type: 'handles' });
    expect(a.subscribe).toBe(b.subscribe);
    expect(createSelectorStore(editor(), snapshotSelectors.tool).subscribe).not.toBe(a.subscribe);
    let calls = 0;
    const stop = a.subscribe(() => {
      calls += 1;
    });
    run(target, { type: 'setTool', tool: 'ellipse' });
    stop();
    run(target, { type: 'setTool', tool: 'select' });
    expect(calls).toBe(1);
  });

  it('renders each hook with renderToString', () => {
    const target = editor();
    run(target, { type: 'createRectangle', frame, name: 'Box' });
    run(target, { type: 'setSelection', ids: ['n1'] });
    run(target, { type: 'setTool', tool: 'ellipse' });
    function Probe() {
      const node = useNode('n1');
      const values = {
        selection: useSelection(),
        activePage: useActivePage(),
        pages: usePages().map((page) => page.name),
        tool: useTool(),
        history: useHistory(),
        snapping: useSnapping(),
        viewport: useViewport(),
        scope: useScope(),
        node: node === null ? null : node.name,
        missing: useNode('n9'),
        handles: useEditorQuery({ type: 'handles' })?.corners ?? null,
        extensions: useEditorQuery({ type: 'extensions' }).map((summary) => summary.id),
      };
      return createElement('pre', null, JSON.stringify(values));
    }
    const html = renderToString(
      createElement(EditorProvider, { editor: target }, createElement(Probe)),
    );
    expect(JSON.parse(html.replace(/^<pre>|<\/pre>$/gu, '').replaceAll('&quot;', '"'))).toEqual({
      selection: ['n1'],
      activePage: 'p1',
      pages: ['Page 1'],
      tool: 'ellipse',
      history: { undoDepth: 1, redoDepth: 0 },
      snapping: true,
      viewport: { position: { x: 0, y: 0 }, zoom: 1 },
      scope: null,
      node: 'Box',
      missing: null,
      handles: target.query({ type: 'handles' })!.corners,
      extensions: [],
    });
  });
});

describe('M8-A03 useEditorQuery over its store adapter (M8-H3, H4)', () => {
  it('uses structural equality for the five listed queries and Object.is for the rest', () => {
    expect([...STRUCTURAL_QUERIES].sort()).toEqual([
      'extensions',
      'handles',
      'pathOverlay',
      'snap',
      'textEditOverlay',
    ]);
    const all: Query[] = [
      { type: 'document' },
      { type: 'committedDocument' },
      { type: 'node', id: 'n1' },
      { type: 'selection' },
      { type: 'tool' },
      { type: 'viewport' },
      { type: 'history' },
      { type: 'revision' },
      { type: 'overlay' },
      { type: 'activePage' },
      { type: 'pages' },
      { type: 'handles' },
      { type: 'viewportSize' },
      { type: 'keymap' },
      { type: 'snap' },
      { type: 'snapping' },
      { type: 'scope' },
      { type: 'clipboard' },
      { type: 'pathEdit' },
      { type: 'pathOverlay' },
      { type: 'textLayout', id: 't1' },
      { type: 'textEdit' },
      { type: 'textEditOverlay' },
      { type: 'extensions' },
    ];
    for (const query of all) {
      expect(defaultQueryEquality(query), query.type).toBe(
        STRUCTURAL_QUERIES.has(query.type) ? structuralEqual : Object.is,
      );
    }
  });

  it('compares JSON-like values structurally', () => {
    expect(structuralEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(structuralEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(structuralEqual(0, -0)).toBe(false);
    expect(structuralEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(structuralEqual([1], { 0: 1 })).toBe(false);
    expect(structuralEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(structuralEqual({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false);
    expect(structuralEqual(null, {})).toBe(false);
    expect(structuralEqual('a', 'a')).toBe(true);
  });

  it('keeps a rebuilt handles result between unrelated events and follows a change', () => {
    const target = editor();
    run(target, { type: 'createRectangle', frame });
    run(target, { type: 'setSelection', ids: ['n1'] });
    // The query builds a new box on every read.
    expect(target.query({ type: 'handles' })).not.toBe(target.query({ type: 'handles' }));
    const { store, changes } = subscribed(createQueryStore(target, { type: 'handles' }));
    const first = store.getSnapshot();
    expect(first).toEqual(target.query({ type: 'handles' }));
    run(target, { type: 'setTool', tool: 'ellipse' });
    run(target, { type: 'setSnapping', enabled: false });
    expect(changes()).toBe(2);
    expect(store.getSnapshot()).toBe(first);
    run(target, { type: 'nudgeNodes', ids: ['n1'], dx: 5, dy: 0 });
    const moved = store.getSnapshot();
    expect(moved).not.toBe(first);
    expect(moved).toEqual(target.query({ type: 'handles' }));
    expect(moved!.corners[0].x).toBe(first!.corners[0].x + 5);
    run(target, { type: 'setSelection', ids: [] });
    expect(store.getSnapshot()).toBeNull();
  });

  it('keeps a rebuilt path overlay between unrelated events', () => {
    const target = editor();
    run(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line'],
      points: [0, 0, 10, 0, 10, 10],
    });
    run(target, { type: 'enterPathEdit', id: 'n1' });
    expect(target.query({ type: 'pathOverlay' })).not.toBe(target.query({ type: 'pathOverlay' }));
    const store = createQueryStore(target, { type: 'pathOverlay' });
    const first = store.getSnapshot();
    expect(first).toEqual(target.query({ type: 'pathOverlay' }));
    run(target, { type: 'setSnapping', enabled: false });
    expect(store.getSnapshot()).toBe(first);
    run(target, { type: 'exitPathEdit' });
    expect(store.getSnapshot()).toBeNull();
  });

  it('uses Object.is for a query outside the list', () => {
    const target = editor();
    run(target, { type: 'createRectangle', frame });
    const store = createQueryStore(target, { type: 'document' });
    const first = store.getSnapshot();
    expect(first).toBe(target.query({ type: 'document' }));
    run(target, { type: 'setTool', tool: 'ellipse' });
    expect(store.getSnapshot()).toBe(first);
    // A load of the same document gives an equal document under a new reference.
    run(target, {
      type: 'loadDocument',
      document: JSON.parse(serializeDocument(first)) as unknown,
    });
    const loaded = store.getSnapshot();
    expect(loaded).toEqual(first);
    expect(loaded).not.toBe(first);
    expect(loaded).toBe(target.query({ type: 'document' }));
    // A structural isEqual passed explicitly keeps the previous reference instead.
    const kept = createQueryStore(target, { type: 'document' }, structuralEqual);
    const before = kept.getSnapshot();
    run(target, {
      type: 'loadDocument',
      document: JSON.parse(serializeDocument(before)) as unknown,
    });
    expect(kept.getSnapshot()).toBe(before);
  });

  it('re-reads after a textLayout session event, which keeps the snapshot', () => {
    const port = createFakeTextLayout();
    const target = editor({ textLayout: port });
    run(target, {
      type: 'createText',
      frame: { x: 0, y: 0, width: 0, height: 0 },
      runs: [{ text: 'ab', family: 'Test', size: 10, color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    const layout = createQueryStore(target, { type: 'textLayout', id: 'n1' });
    const snapshot = createSelectorStore(target, (value) => value);
    const first = layout.getSnapshot();
    const snapshotBefore = snapshot.getSnapshot();
    expect(first).toBe(target.query({ type: 'textLayout', id: 'n1' }));
    expect(first!.generation).toBe(0);
    expect(layout.getSnapshot()).toBe(first);
    // Read before any component subscribes: the store still sees the event.
    port.bump();
    expect(snapshot.getSnapshot()).toBe(snapshotBefore);
    const second = layout.getSnapshot();
    expect(second).not.toBe(first);
    expect(second!.generation).toBe(1);
    expect(second).toBe(target.query({ type: 'textLayout', id: 'n1' }));
    // And while subscribed, from inside the change notification.
    const seen: unknown[] = [];
    layout.subscribe(() => seen.push(layout.getSnapshot()));
    port.bump();
    expect(seen).toHaveLength(1);
    expect((seen[0] as QueryResult<{ type: 'textLayout'; id: string }>)!.generation).toBe(2);
    expect(layout.getSnapshot()).toBe(seen[0]);
  });

  it('reads a store first created after a listener was already subscribed', () => {
    const target = editor();
    const early = createSelectorStore(target, snapshotSelectors.tool);
    const seen: unknown[] = [];
    let late: EditorStore<QueryResult<{ type: 'tool' }>> | null = null;
    early.subscribe(() => {
      late ??= createQueryStore(target, { type: 'tool' });
      seen.push(late.getSnapshot());
    });
    run(target, { type: 'setTool', tool: 'ellipse' });
    run(target, { type: 'setTool', tool: 'line' });
    expect(seen).toEqual(['ellipse', 'line']);
  });

  it('returns the constant extensions list', () => {
    const target = editor({ extensions: [starExtension] });
    const store = createQueryStore(target, { type: 'extensions' });
    expect(store.getSnapshot()).toBe(target.query({ type: 'extensions' }));
    expect(store.getSnapshot().map((summary) => summary.id)).toEqual(['ext.star']);
  });
});

describe('M8-A04 the equality option of useEditorSelector (M8-H2)', () => {
  const nodeTypes = (snapshot: EditorSnapshot) =>
    Object.values(snapshot.document.nodes).map((node) => node.type);
  const sameTypes = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  it('keeps one reference for a fresh array while equal and a new one after a change', () => {
    const target = editor();
    run(target, { type: 'createRectangle', frame });
    const store = createSelectorStore(target, nodeTypes, sameTypes);
    const first = store.getSnapshot();
    expect(first).toEqual(['rectangle']);
    expect(store.getSnapshot()).toBe(first);
    for (const command of [
      { type: 'setTool', tool: 'ellipse' },
      { type: 'nudgeNodes', ids: ['n1'], dx: 1, dy: 0 },
      { type: 'setSelection', ids: ['n1'] },
    ] satisfies Command[]) {
      run(target, command);
      expect(store.getSnapshot(), command.type).toBe(first);
    }
    run(target, { type: 'createEllipse', frame });
    const second = store.getSnapshot();
    expect(second).toEqual(['rectangle', 'ellipse']);
    expect(second).not.toBe(first);
    run(target, { type: 'setTool', tool: 'select' });
    expect(store.getSnapshot()).toBe(second);
    // Undo returns to an equal list under a new reference, kept while equal.
    run(target, { type: 'undo' });
    const third = store.getSnapshot();
    expect(third).toEqual(['rectangle']);
    expect(third).not.toBe(second);
  });

  it('without isEqual, follows Object.is as before: a part of the snapshot is stable', () => {
    const target = editor();
    run(target, { type: 'createRectangle', frame });
    const part = createSelectorStore(target, (snapshot) => snapshot.document.nodes);
    const fresh = createSelectorStore(target, nodeTypes);
    const nodes = part.getSnapshot();
    const types = fresh.getSnapshot();
    // Within one snapshot the selector runs once, so repeated reads agree.
    expect(fresh.getSnapshot()).toBe(types);
    run(target, { type: 'setTool', tool: 'ellipse' });
    expect(part.getSnapshot()).toBe(nodes);
    // A fresh array from a new snapshot is a new reference under Object.is.
    const next = fresh.getSnapshot();
    expect(next).toEqual(types);
    expect(next).not.toBe(types);
  });

  it('runs the selector only when the snapshot object changes', () => {
    const target = editor();
    let calls = 0;
    const store = createSelectorStore(target, (snapshot) => {
      calls += 1;
      return snapshot.revision;
    });
    store.getSnapshot();
    store.getSnapshot();
    expect(calls).toBe(1);
    run(target, { type: 'setTool', tool: 'ellipse' });
    store.getSnapshot();
    store.getSnapshot();
    expect(calls).toBe(2);
  });

  it('judges equality against the memo shared by a rebuilt store', () => {
    const target = editor();
    run(target, { type: 'createRectangle', frame });
    const memo = createStoreMemo<readonly string[]>();
    const first = createSelectorStore(target, nodeTypes, sameTypes, memo).getSnapshot();
    // A new inline selector on the next render builds a new store over the same memo.
    const rebuilt = createSelectorStore(target, (snapshot) => nodeTypes(snapshot), sameTypes, memo);
    expect(rebuilt.getSnapshot()).toBe(first);
  });

  it('renders a fresh-array selector with isEqual through the hook', () => {
    const target = editor();
    run(target, { type: 'createRectangle', frame });
    run(target, { type: 'createEllipse', frame });
    function Types(): ReactNode {
      const types = useEditorSelector(nodeTypes, sameTypes);
      return createElement('span', null, types.join(','));
    }
    const html = renderToString(
      createElement(EditorProvider, { editor: target }, createElement(Types)),
    );
    expect(html).toBe('<span>rectangle,ellipse</span>');
  });
});
