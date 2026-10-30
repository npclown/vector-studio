// E26-U4 (E26 contract, section 4.3, E26-A09): a change projects only the units it touched,
// the instances whose expansion it changes and its ancestors' child lists, and sends the same
// change set, keeps the same exclusion and invalid-expansion state and reports the same
// diagnostics as the whole-page path. Every unit test also runs each scoped change against the
// whole-page path (`tests/setup/e26-scoped-projection-check.ts`); here two editors, one scoped
// and one held to the whole page, run the same seeded commands side by side, with symbols,
// instances, sources on another page and injected rejections, and the projector-level cases the
// editor cannot reach (an invalid expansion, a `touched` without the former parent).
import type { RenderChangeSet } from '@vector-studio/contracts';
import { validateDocument, type DocumentV6 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  type Command,
  type Editor,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';
import {
  SceneProjector,
  projectorStateForTesting,
  useWholePageProjectionForTesting,
} from '../../packages/editor-core/src/projector.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ExpansionCache } from '../../packages/editor-core/src/expansion.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

/** mulberry32. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Rng = ReturnType<typeof random>;

const ALL_FEATURES = {
  pathFills: 'supported',
  paints: 'gradient',
  dashes: 'supported',
  groupOpacity: 'supported',
  textNodes: 'supported',
} as const;

type Side = {
  editor: Editor;
  renderer: RecordingRenderer;
  events: EditorEvent[];
};

function side(wholePage: boolean): Side {
  const editor = createEditor();
  const renderer = new RecordingRenderer('supported', ALL_FEATURES);
  const events: EditorEvent[] = [];
  editor.subscribe((event) => {
    if (event.type === 'diagnostic') events.push(event);
  });
  editor.attachRenderer(renderer);
  if (wholePage) useWholePageProjectionForTesting(projectorOf(editor));
  return { editor, renderer, events };
}

function projectorOf(editor: Editor): SceneProjector {
  return (editor as unknown as { projector: SceneProjector }).projector;
}

const pick = <T>(rng: Rng, items: readonly T[]): T | undefined =>
  items.length === 0 ? undefined : items[Math.floor(rng() * items.length)];
const frame = (rng: Rng) => ({
  x: Math.round(rng() * 400),
  y: Math.round(rng() * 300),
  width: 10 + Math.round(rng() * 80),
  height: 10 + Math.round(rng() * 60),
});
const color = (rng: Rng) => ({ r: rng(), g: rng(), b: rng(), a: 1 });

/** A random command over the document of `editor` (many fail, which changes nothing). */
function randomCommand(rng: Rng, editor: Editor): Command {
  const document = editor.query({ type: 'document' });
  const active = editor.query({ type: 'activePage' });
  const ids = Object.keys(document.nodes);
  const onPage = (id: string): boolean => {
    let cursor = document.nodes[id]?.parent;
    for (let guard = 0; cursor !== undefined && guard < 64; guard += 1) {
      if (cursor === active) return true;
      cursor = document.nodes[cursor]?.parent;
    }
    return false;
  };
  const here = ids.filter(onPage);
  const containers = here.filter((id) =>
    ['group', 'maskGroup', 'frame', 'symbol'].includes(document.nodes[id]!.type),
  );
  const symbols = ids.filter((id) => document.nodes[id]!.type === 'symbol');
  const instances = here.filter((id) => document.nodes[id]!.type === 'instance');
  const some = (count: number) => {
    const chosen = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const id = pick(rng, here);
      if (id !== undefined) chosen.add(id);
    }
    return [...chosen];
  };
  const parent = () => (rng() < 0.4 ? active : (pick(rng, containers) ?? active));
  const one = pick(rng, here) ?? '';
  const op = Math.floor(rng() * 24);
  switch (op) {
    case 0:
      return { type: 'createRectangle', frame: frame(rng), fill: color(rng), parent: parent() };
    case 1:
      return {
        type: 'createEllipse',
        frame: frame(rng),
        stroke: { ...strokeOf(rng) },
        parent: parent(),
      };
    case 2:
      return { type: 'createFrame', frame: frame(rng), fill: color(rng), parent: parent() };
    case 3:
      return {
        type: 'createLine',
        start: { x: rng() * 300, y: rng() * 300 },
        end: { x: rng() * 300, y: rng() * 300 },
        stroke: strokeOf(rng),
        endArrow: rng() < 0.5 ? 'triangle' : 'none',
        parent: parent(),
      };
    case 4:
      return {
        type: 'setFrames',
        frames: some(1 + Math.floor(rng() * 3)).map((id) => ({ id, frame: frame(rng) })),
      };
    case 5:
      return { type: 'nudgeNodes', ids: some(1 + Math.floor(rng() * 4)), dx: 3, dy: -2 };
    case 6:
      return { type: 'deleteNodes', ids: some(1 + Math.floor(rng() * 2)) };
    case 7:
      return {
        type: 'groupNodes',
        ids: some(2 + Math.floor(rng() * 2)),
        kind: rng() < 0.8 ? 'group' : 'maskGroup',
      };
    case 8:
      return { type: 'ungroupNodes', id: pick(rng, containers) ?? one };
    case 9: {
      const target = parent();
      const children =
        target === active
          ? (document.pages.find((page) => page.id === active)?.children ?? [])
          : ((document.nodes[target] as { children?: readonly string[] }).children ?? []);
      return {
        type: 'moveNodes',
        ids: some(1 + Math.floor(rng() * 2)),
        parent: target,
        index: Math.floor(rng() * (children.length + 1)),
      };
    }
    case 10:
      return {
        type: 'reorderNodes',
        ids: some(1),
        op: pick(rng, ['front', 'back', 'forward', 'backward'] as const)!,
      };
    case 11:
      return { type: 'setNodeProps', id: one, props: { visible: rng() < 0.7 } };
    case 12:
      return { type: 'setNodeProps', id: one, props: { opacity: rng() < 0.5 ? 0.5 : 1 } };
    case 13:
      return { type: 'setStyle', ids: some(2), style: { fill: color(rng) } };
    case 14:
      return { type: 'createSymbol', ids: some(1 + Math.floor(rng() * 2)) };
    case 15:
      return { type: 'createInstance', symbol: pick(rng, symbols) ?? '', parent: parent() };
    case 16:
      return { type: 'detachInstances', ids: instances.slice(0, 1) };
    case 17:
      return {
        type: 'duplicateNodes',
        ids: some(1 + Math.floor(rng() * 2)),
        offset: { x: 8, y: 8 },
      };
    case 18:
      return { type: 'rotateNodes', ids: some(1), angle: 0.3 };
    case 19:
    case 20:
      return { type: 'undo' };
    case 21:
      return { type: 'redo' };
    case 22: {
      // Edit inside a source, often on another page, so its instances re-expand.
      const source = pick(rng, symbols);
      const inside = ids.filter(
        (id) => source !== undefined && document.nodes[id]!.parent === source,
      );
      const target = pick(rng, inside);
      return target === undefined
        ? { type: 'createRectangle', frame: frame(rng), parent: source ?? active }
        : { type: 'setFrames', frames: [{ id: target, frame: frame(rng) }] };
    }
    default: {
      const pages = document.pages.map((page) => page.id);
      return { type: 'setActivePage', id: pick(rng, pages)! };
    }
  }
}

function strokeOf(rng: Rng) {
  return {
    color: color(rng),
    width: 1 + Math.round(rng() * 4),
    cap: 'butt' as const,
    join: rng() < 0.5 ? ('round' as const) : ('miter' as const),
    miterLimit: 4,
    dash: rng() < 0.3 ? { pattern: [6, 4], phase: 0 } : null,
  };
}

/** What a side has sent and reported since `from`. */
function record(target: Side, from: { calls: number; events: number }) {
  return JSON.stringify({
    calls: target.renderer.calls.slice(from.calls),
    events: target.events.slice(from.events),
    state: projectorStateForTesting(projectorOf(target.editor)),
  });
}

describe('E26-U4 change-scoped projection (E26-A09)', () => {
  it('sends what the whole-page path sends on 1,200 seeded commands with symbols', () => {
    let steps = 0;
    let scopedSets = 0;
    let rejections = 0;
    for (let seed = 1; steps < 1_200; seed += 1) {
      const rng = random(seed * 2654435761);
      const scoped = side(false);
      const whole = side(true);
      const both = (command: Command) => {
        const from = {
          calls: scoped.renderer.calls.length,
          events: scoped.events.length,
        };
        const fromWhole = { calls: whole.renderer.calls.length, events: whole.events.length };
        const a = scoped.editor.execute(command);
        const b = whole.editor.execute(command);
        expect(JSON.stringify(a), `seed ${seed} ${command.type}`).toBe(JSON.stringify(b));
        expect(record(scoped, from), `seed ${seed} step ${steps} ${JSON.stringify(command)}`).toBe(
          record(whole, fromWhole),
        );
        scopedSets += scoped.renderer.calls
          .slice(from.calls)
          .filter((call) => call.method === 'applyChanges').length;
      };
      // A second page holding a source, so that instances on the first page follow a source
      // on another page (M7-S1).
      const first = scoped.editor.query({ type: 'activePage' });
      both({ type: 'addPage', name: 'sources' });
      const second = scoped.editor
        .query({ type: 'document' })
        .pages.map((page) => page.id)
        .find((id) => id !== first)!;
      both({ type: 'setActivePage', id: second });
      both({
        type: 'createRectangle',
        frame: { x: 0, y: 0, width: 40, height: 30 },
        fill: color(rng),
      });
      both({ type: 'createFrame', frame: { x: 60, y: 0, width: 80, height: 60 } });
      const sourceFrame = Object.keys(scoped.editor.query({ type: 'document' }).nodes).at(-1)!;
      both({ type: 'createSymbol', ids: [sourceFrame] });
      both({ type: 'setActivePage', id: first });
      for (let index = 0; index < 3; index += 1) {
        both({ type: 'createInstance', symbol: sourceFrame });
      }
      for (let step = 0; step < 60; step += 1) {
        if (rng() < 0.04) {
          // The next change set is rejected once on both sides (isolation, exclusion, retry).
          const rejection = {
            status: 'invalid-scene',
            reason: 'invalid-value',
            current: scoped.renderer.mirror.getSynchronizationState().current,
          } as never;
          scoped.renderer.overrides.applyChanges = rejection;
          whole.renderer.overrides.applyChanges = rejection;
          rejections += 1;
        }
        both(randomCommand(rng, scoped.editor));
        steps += 1;
      }
      delete scoped.renderer.overrides.applyChanges;
      delete whole.renderer.overrides.applyChanges;
    }
    expect(scopedSets).toBeGreaterThan(600);
    expect(rejections).toBeGreaterThan(20);
  }, 120_000);
});

type Json = {
  pages: { id: string; children: string[] }[];
  nodes: Record<string, Record<string, unknown>>;
};

const SYMBOLS = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../fixtures/m4-appearance/migrated/symbols.v6.json'),
    'utf8',
  ),
) as Json;

/** The symbols fixture after `edit`: page-2 holds g1 [i2, r2], f2 [i4], s2 and d1 [d1-r]. */
function read(edit: (value: Json) => void = () => {}): DocumentV6 {
  const value = structuredClone(SYMBOLS);
  edit(value);
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

/**
 * `document` with the nodes and pages `edit` returns replaced (null deletes), sharing every
 * other node object, as a command's result does.
 */
function derive(
  document: DocumentV6,
  nodes: Record<string, Record<string, unknown> | null>,
  pages: Record<string, string[]> = {},
): DocumentV6 {
  const next: Record<string, unknown> = { ...document.nodes };
  for (const [id, node] of Object.entries(nodes)) {
    if (node === null) delete next[id];
    else next[id] = { ...document.nodes[id], ...node };
  }
  return {
    ...document,
    nodes: next,
    pages: document.pages.map((page) =>
      Object.hasOwn(pages, page.id) ? { ...page, children: pages[page.id]! } : page,
    ),
  } as DocumentV6;
}

/** A projector on a recording renderer and one held to the whole page, fed the same changes. */
function projectors(expansions: () => ExpansionCache = () => new ExpansionCache()) {
  const make = (wholePage: boolean) => {
    const renderer = new RecordingRenderer('supported', ALL_FEATURES);
    const events: unknown[] = [];
    const projector = new SceneProjector(
      renderer,
      () => null,
      (event) => events.push(event),
      expansions(),
    );
    if (wholePage) useWholePageProjectionForTesting(projector);
    return { renderer, events, projector };
  };
  return [make(false), make(true)] as const;
}

/** The last change set `renderer` received. */
function lastSet(renderer: RecordingRenderer): RenderChangeSet {
  const call = renderer.calls.at(-1)!;
  if (call.method !== 'applyChanges') throw new Error(`last call is ${call.method}`);
  return call.input;
}

const changeSets = (renderer: RecordingRenderer) =>
  JSON.stringify(renderer.calls.map((call) => [call.method, call.input]));

describe('E26-U4 projector cases outside the editor', () => {
  it('drops a moved node from its former parent when `touched` names only the node', () => {
    const [scoped, whole] = projectors();
    const before = read();
    const after = derive(
      before,
      { g1: { children: ['i2'] }, r2: { parent: 'page-2' } },
      { 'page-2': ['g1', 'f2', 's2', 'd1', 'r2'] },
    );
    for (const { projector } of [scoped, whole]) {
      projector.replace(before, 'page-2');
      projector.change(after, 'page-2', ['r2']);
    }
    expect(changeSets(scoped.renderer)).toBe(changeSets(whole.renderer));
    expect(lastSet(scoped.renderer).updated.map((node) => node.id)).toEqual(['g1', 'r2']);
  });

  it('walks a former parent below a kept container when `touched` names only the moved node', () => {
    // s1-e leaves s1-g, which lies in the source s1 on page-1: s1 itself is unchanged and is
    // kept, so only the moved node's former parent chain reaches s1-g.
    const [scoped, whole] = projectors();
    const before = read();
    const after = derive(
      before,
      { 's1-g': { children: ['s1-p'] }, 's1-e': { parent: 'page-1' } },
      { 'page-1': ['s1', 'i1', 'i3', 's1-e'] },
    );
    for (const { projector } of [scoped, whole]) {
      projector.replace(before, 'page-1');
      projector.change(after, 'page-1', ['s1-e']);
    }
    expect(changeSets(scoped.renderer)).toBe(changeSets(whole.renderer));
    expect(lastSet(scoped.renderer).updated.map((node) => node.id)).toContain('s1-g');
  });

  it('removes a deleted subtree when `touched` names only its root', () => {
    const [scoped, whole] = projectors();
    const before = read();
    const after = derive(before, { d1: null, 'd1-r': null }, { 'page-2': ['g1', 'f2', 's2'] });
    for (const { projector } of [scoped, whole]) {
      projector.replace(before, 'page-2');
      projector.change(after, 'page-2', ['d1']);
    }
    expect(changeSets(scoped.renderer)).toBe(changeSets(whole.renderer));
    const removed = lastSet(scoped.renderer).removed;
    expect(removed.length).toBeGreaterThan(2);
    expect(removed.every((id) => id.startsWith('d1'))).toBe(true);
    expect(removed).toContain('d1-r');
    expect(lastSet(scoped.renderer).updated).toEqual([]);
  });

  it('keeps an invalid instance outside the walk reported, and forgets it with its parent', () => {
    // An extension check that fails every rebuilt copy: the scaled instances i2 (under g1) and
    // i4 (under the frame f2) of the symbols fixture are invalid (M7-X3).
    const failing = () => ({ code: 'editor.extension-failed' as const, path: '' });
    const [scoped, whole] = projectors(() => new ExpansionCache(failing));
    const start = read();
    // A change beside i2 walks g1 but not f2: i4 stays met.
    const beside = derive(start, { r2: { visible: false } });
    // The frame f2 goes, i4 with it.
    const gone = derive(beside, { f2: null, i4: null }, { 'page-2': ['g1', 's2', 'd1'] });
    const steps: [DocumentV6, string[]][] = [
      [beside, ['r2']],
      [gone, ['f2']],
    ];
    for (const { projector } of [scoped, whole]) projector.replace(start, 'page-2');
    expect(projectorStateForTesting(scoped.projector).invalid).toEqual(['i2', 'i4']);
    for (const [next, touched] of steps) {
      for (const { projector } of [scoped, whole]) projector.change(next, 'page-2', touched);
      expect(projectorStateForTesting(scoped.projector)).toEqual(
        projectorStateForTesting(whole.projector),
      );
      expect(scoped.events).toEqual(whole.events);
      expect(changeSets(scoped.renderer)).toBe(changeSets(whole.renderer));
    }
    expect(projectorStateForTesting(scoped.projector).invalid).toEqual(['i2']);
  });
});
