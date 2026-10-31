// E26-U4 (E26 contract, section 4.3, E26-A09): a change projects only the units it touched,
// the instances whose expansion it changes and its ancestors' child lists, and sends the same
// change set, keeps the same exclusion and invalid-expansion state and reports the same
// diagnostics as the whole-page path. Every unit test also runs each scoped change against the
// whole-page path (`tests/setup/e26-scoped-projection-check.ts`); here two editors, one scoped
// and one held to the whole page, run the same seeded commands side by side, with symbols,
// instances, sources on another page and injected rejections, and the projector-level cases the
// editor cannot reach (an invalid expansion, a `touched` without the former parent). Since M6c-U1
// (MVP M6c contract, M6c-A03) text projects: each side has its own fake layout port, the seeded
// run adds text commands, instance text overrides, typing in edit mode, composition updates,
// commits and cancels, undo and redo weighted right after text steps (merged steps included),
// text inside the sources and layout generation changes on both ports, and after every step and
// bump checks each held text leaf against a fresh projection with no memo.
import type { RenderChangeSet } from '@vector-studio/contracts';
import { validateDocument, type DocumentV6 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  type Command,
  type Editor,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import {
  SceneProjector,
  projectPage,
  projectorStateForTesting,
  useWholePageProjectionForTesting,
} from '../../packages/editor-core/src/projector.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ExpansionCache } from '../../packages/editor-core/src/expansion.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';
import { createFakeTextLayout, type FakeTextLayout } from '../support/fake-text-layout.js';
import { TextLayoutCache } from '../../packages/editor-core/src/text.js';

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
  port: FakeTextLayout;
};

function side(wholePage: boolean): Side {
  const port = createFakeTextLayout();
  const editor = createEditor({ textLayout: port });
  const renderer = new RecordingRenderer('supported', ALL_FEATURES);
  const events: EditorEvent[] = [];
  editor.subscribe((event) => {
    if (event.type === 'diagnostic') events.push(event);
  });
  editor.attachRenderer(renderer);
  if (wholePage) useWholePageProjectionForTesting(projectorOf(editor));
  return { editor, renderer, events, port };
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
const WORDS = ['ab', 'cd ef', '가나', 'x', 'long words wrap here', 'a\nb', ' '];
const textRun = (rng: Rng) => ({
  text: pick(rng, WORDS)!,
  family: 'Test',
  size: 8 + Math.round(rng() * 12),
  color: color(rng),
});
const textLength = (node: { runs?: readonly { text: string }[] }) =>
  (node.runs ?? []).reduce((total, run) => total + run.text.length, 0);

/** A random text command, edit-mode input or composition event (M6c-A03). */
function randomText(
  rng: Rng,
  editor: Editor,
  here: readonly string[],
  parent: () => string,
): Command {
  const document = editor.query({ type: 'document' });
  const texts = here.filter((id) => document.nodes[id]!.type === 'text');
  const target = pick(rng, texts);
  const node = target === undefined ? undefined : document.nodes[target]!;
  const length = node?.type === 'text' ? textLength(node) : 0;
  const offset = () => Math.floor(rng() * (length + 1));
  const range = () => {
    const a = offset();
    const b = offset();
    return { start: Math.min(a, b), end: Math.max(a, b) };
  };
  const input = (event: unknown) => ({ type: 'input', event }) as Command;
  const edit = editor.getSnapshot().textEdit;
  if (edit !== null && edit.composition !== null && rng() < 0.9) {
    // During a composition: mostly updates, then a commit or a cancel (an empty end).
    const roll = rng();
    if (roll < 0.5) {
      return input({ kind: 'compositionupdate', data: pick(rng, ['ㅎ', '하', '한', '가']) });
    }
    return input({ kind: 'compositionend', data: roll < 0.75 ? pick(rng, ['한', '가나'])! : '' });
  }
  // An instance text override on a text node of the instance's source (M7-T3).
  const instances = here.filter((id) => document.nodes[id]!.type === 'instance');
  if (edit === null && instances.length > 0 && rng() < 0.15) {
    const instance = document.nodes[pick(rng, instances)!] as { id: string; symbol: string };
    const inSource = (id: string): boolean => {
      let cursor = document.nodes[id]?.parent;
      for (let guard = 0; cursor !== undefined && guard < 64; guard += 1) {
        if (cursor === instance.symbol) return true;
        cursor = document.nodes[cursor]?.parent;
      }
      return false;
    };
    const sourceText = pick(
      rng,
      Object.keys(document.nodes).filter(
        (id) => document.nodes[id]!.type === 'text' && inSource(id),
      ),
    );
    if (sourceText !== undefined) {
      return rng() < 0.7
        ? { type: 'setInstanceText', id: instance.id, node: sourceText, runs: [textRun(rng)] }
        : {
            type: 'clearInstanceText',
            id: instance.id,
            ...(rng() < 0.5 ? { node: sourceText } : {}),
          };
    }
  }
  // In edit mode, mostly typing, keys and composition starts.
  const editing = edit !== null && rng() < 0.8;
  switch (editing ? 7 + Math.floor(rng() * 3) : Math.floor(rng() * 12)) {
    case 0:
      return {
        type: 'createText',
        frame: frame(rng),
        runs: [textRun(rng)],
        sizing: pick(rng, ['autoWidth', 'autoHeight', 'fixed'] as const)!,
        align: pick(rng, ['left', 'center', 'right'] as const)!,
        parent: parent(),
      };
    case 1:
      return { type: 'setText', id: target ?? '', ...range(), text: pick(rng, WORDS)! };
    case 2:
      return {
        type: 'setTextStyle',
        id: target ?? '',
        ...range(),
        style: rng() < 0.5 ? { color: color(rng) } : { size: 6 + Math.round(rng() * 20) },
      };
    case 3:
      return {
        type: 'setTextProps',
        id: target ?? '',
        ...(rng() < 0.5
          ? { align: pick(rng, ['left', 'center', 'right'] as const)! }
          : { letterSpacing: Math.round(rng() * 4) / 10 - 0.2 }),
      };
    case 4:
      return { type: 'refitText' };
    case 5:
    case 6: {
      const { start, end } = range();
      return { type: 'enterTextEdit', id: target ?? '', anchor: start, focus: end };
    }
    case 7:
      return input({ kind: 'textinput', text: pick(rng, ['a', 'b', ' ', '가']) });
    case 8:
      return input({
        kind: 'keydown',
        key: pick(rng, ['Backspace', 'Delete', 'ArrowLeft', 'Enter'])!,
        modifiers: { shift: false, alt: false, meta: false, ctrl: false },
      });
    case 9:
      return input({ kind: 'compositionstart' });
    case 10:
      return input({ kind: 'compositionupdate', data: pick(rng, ['ㅎ', '하', '한', '가']) });
    default:
      // A commit, or a cancel (an empty end).
      return input({ kind: 'compositionend', data: pick(rng, ['한', '가나', '']) });
  }
}

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
  const paths = here.filter((id) => document.nodes[id]!.type === 'path');
  const edit = editor.getSnapshot().textEdit;
  const bias = edit === null ? 0 : edit.composition === null ? 0.7 : 0.95;
  const op = rng() < bias ? 30 : Math.floor(rng() * 36);
  if (op >= 30) return randomText(rng, editor, here, parent);
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
      if (target !== undefined && document.nodes[target]!.type === 'text' && rng() < 0.6) {
        return { type: 'setText', id: target, start: 0, end: 0, text: pick(rng, WORDS)! };
      }
      if (rng() < 0.3) {
        return {
          type: 'createText',
          frame: frame(rng),
          runs: [textRun(rng)],
          parent: source ?? active,
        };
      }
      return target === undefined
        ? { type: 'createRectangle', frame: frame(rng), parent: source ?? active }
        : { type: 'setFrames', frames: [{ id: target, frame: frame(rng) }] };
    }
    case 23: {
      const x = Math.round(rng() * 300);
      const y = Math.round(rng() * 300);
      return {
        type: 'createPath',
        verbs: ['move', 'line', 'line', 'close'],
        points: [x, y, x + 60, y, x + 30, y + 40],
        fill: color(rng),
        parent: parent(),
      };
    }
    case 24: {
      // A mask group of a path (its source, bottom-most in paint order) and a later sibling.
      const source = pick(rng, paths) ?? one;
      const parentId = document.nodes[source]?.parent ?? active;
      const siblings =
        document.pages.find((page) => page.id === parentId)?.children ??
        (document.nodes[parentId] as { children?: readonly string[] } | undefined)?.children ??
        [];
      const above = siblings.slice(siblings.indexOf(source) + 1);
      return {
        type: 'groupNodes',
        ids: [source, ...[pick(rng, above)].filter((id) => id !== undefined)],
        kind: 'maskGroup',
      };
    }
    case 25:
      return { type: 'copy', ids: some(1 + Math.floor(rng() * 2)) };
    case 26:
      return rng() < 0.7 ? { type: 'paste' } : { type: 'cut', ids: some(1) };
    case 27: {
      const pages = document.pages.map((page) => page.id);
      return rng() < 0.5
        ? { type: 'addPage', name: 'more' }
        : { type: 'removePage', id: pick(rng, pages)! };
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
  it('sends what the whole-page path sends on 3,000 seeded commands with symbols and text', () => {
    let steps = 0;
    let scopedSets = 0;
    let rejections = 0;
    let gestures = 0;
    let masks = 0;
    let textSets = 0;
    let typed = 0;
    let composed = 0;
    let bumps = 0;
    let updates = 0;
    let commits = 0;
    let cancels = 0;
    let redosAfterText = 0;
    let overrides = 0;
    let freshLeaves = 0;
    /**
     * Every text leaf a side's renderer holds is at its port's generation and equals a fresh
     * projection (a new expansion cache, a new layout cache, no memo): the A09 oracle shares the
     * projector's memo, so it cannot see a stale entry (M6c-A03).
     */
    const fresh = (target: Side, label: string) => {
      const scene = target.renderer.mirror.readRetainedScene();
      if (scene === null) return;
      const cache = new TextLayoutCache(target.port);
      const projection = projectPage(
        target.editor.query({ type: 'document' }),
        target.editor.query({ type: 'activePage' }),
        () => null,
        new Set(),
        undefined,
        new ExpansionCache(),
        undefined,
        (node) => cache.layout(node),
      );
      for (const node of scene.nodes) {
        if (node.kind !== 'text') continue;
        freshLeaves += 1;
        expect(node.generation, `${label} generation ${JSON.stringify(node.id)}`).toBe(
          target.port.generation,
        );
        expect(node, `${label} fresh ${JSON.stringify(node.id)}`).toEqual(
          projection.nodes.get(node.id),
        );
      }
    };
    for (let seed = 1; steps < 3_000; seed += 1) {
      const rng = random(seed * 2654435761);
      const scoped = side(false);
      const whole = side(true);
      const both = (command: Command) => {
        const from = {
          calls: scoped.renderer.calls.length,
          events: scoped.events.length,
        };
        const fromWhole = { calls: whole.renderer.calls.length, events: whole.events.length };
        const edit = scoped.editor.getSnapshot().textEdit;
        const editing = edit !== null;
        const composing = edit?.composition != null;
        const a = scoped.editor.execute(command);
        const b = whole.editor.execute(command);
        if (command.type === 'groupNodes' && command.kind === 'maskGroup') {
          if (a.ok) masks += 1;
        }
        expect(JSON.stringify(a), `seed ${seed} ${command.type}`).toBe(JSON.stringify(b));
        expect(record(scoped, from), `seed ${seed} step ${steps} ${JSON.stringify(command)}`).toBe(
          record(whole, fromWhole),
        );
        const sets = scoped.renderer.calls
          .slice(from.calls)
          .filter((call) => call.method === 'applyChanges');
        scopedSets += sets.length;
        textSets += sets.filter(
          (call) =>
            call.method === 'applyChanges' &&
            [...call.input.inserted, ...call.input.updated].some((node) => node.kind === 'text'),
        ).length;
        if (command.type === 'input' && editing && a.ok) {
          const event = command.event as { kind: string; data?: string };
          if (event.kind === 'textinput') typed += 1;
          if (event.kind.startsWith('composition')) composed += 1;
          if (composing && event.kind === 'compositionupdate') updates += 1;
          if (composing && event.kind === 'compositionend') {
            if (event.data === '') cancels += 1;
            else commits += 1;
          }
        }
        if (a.ok && (command.type === 'setInstanceText' || command.type === 'clearInstanceText')) {
          overrides += 1;
        }
        fresh(scoped, `seed ${seed} step ${steps} scoped`);
        fresh(whole, `seed ${seed} step ${steps} whole`);
        return a.ok;
      };
      /** Whether `command` is a text step: a text command, or input or composition in edit mode. */
      const textStep = (command: Command) =>
        command.type === 'input'
          ? scoped.editor.getSnapshot().textEdit !== null
          : ['createText', 'setText', 'setTextStyle', 'setTextProps', 'refitText'].includes(
              command.type,
            ) || command.type.endsWith('InstanceText');
      // A layout generation change on both ports (M6c-P4): the editors re-project their text.
      const bump = () => {
        const from = { calls: scoped.renderer.calls.length, events: scoped.events.length };
        const fromWhole = { calls: whole.renderer.calls.length, events: whole.events.length };
        scoped.port.bump();
        whole.port.bump();
        expect(record(scoped, from), `seed ${seed} bump`).toBe(record(whole, fromWhole));
        fresh(scoped, `seed ${seed} bump scoped`);
        fresh(whole, `seed ${seed} bump whole`);
        bumps += 1;
      };
      // A gesture on both sides: setFrames updates, sometimes back to the start (a node moved
      // away and back is a new object of the same value), a replace, then commit or cancel.
      const gesture = (rng: Rng) => {
        const document = scoped.editor.query({ type: 'document' });
        const page = scoped.editor.query({ type: 'activePage' });
        const ids = Object.keys(document.nodes).filter(
          (id) => document.nodes[id]!.parent === page || rng() < 0.3,
        );
        const moved = [pick(rng, ids), pick(rng, ids)].filter(
          (id, index, all): id is string => id !== undefined && all.indexOf(id) === index,
        );
        const start = moved.map((id) => ({ id, frame: document.nodes[id]!.frame }));
        const away = moved.map((id) => ({ id, frame: frame(rng) }));
        const act = (
          name: string,
          run: (api: ReturnType<typeof internalsOf>['gesture']) => unknown,
        ) => {
          const from = { calls: scoped.renderer.calls.length, events: scoped.events.length };
          const fromWhole = { calls: whole.renderer.calls.length, events: whole.events.length };
          const a = run(internalsOf(scoped.editor).gesture);
          const b = run(internalsOf(whole.editor).gesture);
          expect(JSON.stringify(a), `seed ${seed} gesture ${name}`).toBe(JSON.stringify(b));
          expect(record(scoped, from), `seed ${seed} gesture ${name}`).toBe(
            record(whole, fromWhole),
          );
        };
        act('begin', (api) => api.begin());
        act('away', (api) => api.update({ type: 'setFrames', frames: away }));
        if (rng() < 0.5) act('back', (api) => api.update({ type: 'setFrames', frames: start }));
        if (rng() < 0.3) {
          act('replace', (api) => api.replace([{ type: 'setFrames', frames: away.slice(0, 1) }]));
        }
        if (moved.length > 1) {
          const other = [{ id: moved[1]!, frame: frame(rng) }];
          act('other', (api) => api.update({ type: 'setFrames', frames: other }));
        }
        if (rng() < 0.8) act('commit', (api) => api.commit());
        else act('cancel', (api) => api.cancel());
        gestures += 1;
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
      // Text in the source, so the instances expand it.
      both({
        type: 'createText',
        frame: { x: 4, y: 4, width: 40, height: 12 },
        runs: [textRun(rng)],
        parent: sourceFrame,
      });
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
        if (rng() < 0.03) bump();
        // A gesture would end a composition (the public API is inert while composing).
        const composing = scoped.editor.getSnapshot().textEdit?.composition != null;
        if (!composing && rng() < 0.1) {
          gesture(rng);
        } else {
          const command = randomCommand(rng, scoped.editor);
          const text = textStep(command);
          const depth = scoped.editor.getSnapshot().history.undoDepth;
          const ok = both(command);
          // Undo and redo weighted after a text step that succeeded and left a step (merged
          // steps included).
          if (
            ok &&
            text &&
            scoped.editor.getSnapshot().history.undoDepth >= depth &&
            rng() < 0.25
          ) {
            both({ type: 'undo' });
            if (rng() < 0.7 && both({ type: 'redo' })) redosAfterText += 1;
          }
        }
        steps += 1;
      }
      delete scoped.renderer.overrides.applyChanges;
      delete whole.renderer.overrides.applyChanges;
    }
    expect(scopedSets).toBeGreaterThan(600);
    expect(rejections).toBeGreaterThan(20);
    expect(gestures).toBeGreaterThan(80);
    expect(masks).toBeGreaterThan(5);
    // M6c-A03 (counts at this commit in the U1 notes, contract section 16): sets carrying text
    // leaves, typing and composition events in edit mode, updates, commits and cancels during a
    // composition, redos right after a text step, instance text overrides, generation changes,
    // and the held text leaves checked against a fresh projection.
    // 3,000 steps at this commit: 1,199 sets, 111 typed, 228 composition events, 65 updates,
    // 18 commits, 30 cancels, 113 redos after a text step, 30 overrides, 84 bumps and 17,426
    // fresh leaf checks.
    expect(textSets).toBeGreaterThan(800);
    expect(typed).toBeGreaterThan(60);
    expect(composed).toBeGreaterThan(150);
    expect(updates).toBeGreaterThan(40);
    expect(commits).toBeGreaterThan(15);
    expect(cancels).toBeGreaterThan(20);
    expect(redosAfterText).toBeGreaterThan(80);
    expect(overrides).toBeGreaterThan(15);
    expect(bumps).toBeGreaterThan(50);
    expect(freshLeaves).toBeGreaterThan(10_000);
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

describe('E26-U4 gesture history', () => {
  it('undoes a gesture that moved a node away and back (identity, not value)', () => {
    const scoped = side(false);
    const whole = side(true);
    const run = (target: Side) => {
      const { editor } = target;
      const ok = (command: Command) => {
        const result = editor.execute(command);
        if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
        return result.ids;
      };
      const [r] = ok({ type: 'createRectangle', frame: { x: 0, y: 0, width: 20, height: 20 } });
      const [r2] = ok({ type: 'createRectangle', frame: { x: 40, y: 0, width: 20, height: 20 } });
      const [s] = ok({ type: 'createRectangle', frame: { x: 0, y: 60, width: 20, height: 20 } });
      ok({ type: 'groupNodes', ids: [r!, r2!], kind: 'group' });
      const start = editor.query({ type: 'document' }).nodes[r!]!.frame;
      const { gesture } = internalsOf(editor);
      gesture.begin();
      gesture.update({ type: 'setFrames', frames: [{ id: r!, frame: { ...start, x: 10 } }] });
      gesture.update({ type: 'setFrames', frames: [{ id: r!, frame: start }] });
      gesture.update({
        type: 'setFrames',
        frames: [{ id: s!, frame: { x: 5, y: 60, width: 20, height: 20 } }],
      });
      gesture.commit();
      const from = { calls: target.renderer.calls.length, events: target.events.length };
      // With the oracle of the setup check on, a scoped walk that kept r would throw here.
      ok({ type: 'undo' });
      ok({ type: 'redo' });
      return record(target, from);
    };
    expect(run(scoped)).toBe(run(whole));
  });
});

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

  it('throws E26-A09 when `touched` leaves out a changed node (the setup check is on)', () => {
    const [scoped] = projectors();
    const before = read();
    const after = derive(before, { r2: { visible: false } });
    scoped.projector.replace(before, 'page-2');
    expect(() => scoped.projector.change(after, 'page-2', ['d1'])).toThrow(/E26-A09/);
  });

  it('leaves the scoped path when the renderer throws, so the next change resends it', () => {
    const [scoped, whole] = projectors();
    const before = read();
    const moved = derive(before, { r2: { visible: false } });
    const next = derive(moved, { 'd1-r': { visible: false } });
    for (const { projector, renderer } of [scoped, whole]) {
      projector.replace(before, 'page-2');
      const apply = renderer.applyChanges.bind(renderer);
      renderer.applyChanges = () => {
        renderer.applyChanges = apply;
        throw new Error('renderer fault');
      };
      expect(() => projector.change(moved, 'page-2', ['r2'])).toThrow('renderer fault');
      projector.change(next, 'page-2', ['d1-r']);
    }
    expect(changeSets(scoped.renderer)).toBe(changeSets(whole.renderer));
    expect(lastSet(scoped.renderer).updated.map((node) => node.id)).toEqual(['r2', 'd1-r']);
  });

  it('re-projects the whole page past the memo on a text layout generation change', () => {
    const [scoped] = projectors();
    const before = read();
    scoped.projector.replace(before, 'page-2');
    const calls = scoped.renderer.calls.length;
    // The fixture holds no text: no memo entry is dropped, nothing differs, nothing is sent.
    scoped.projector.relayout(before);
    expect(scoped.renderer.calls.length).toBe(calls);
    const after = derive(before, { r2: { visible: false } });
    scoped.projector.change(after, 'page-2', ['r2']);
    expect(lastSet(scoped.renderer).updated.map((node) => node.id)).toEqual(['r2']);
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
