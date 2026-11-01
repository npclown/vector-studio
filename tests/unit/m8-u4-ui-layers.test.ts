import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '@vector-studio/editor-core';
import { EditorProvider, LayerTree, PageList } from '@vector-studio/ui';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  layerRows,
  pageActions,
  pageButtons,
  renameNodeEdit,
  renamePageEdit,
  reorderActions,
  rowClickCommand,
  runPageAction,
  toggleExpanded,
  visibilityCommand,
  type LayerRow,
} from '../../packages/ui/src/layer-model.js';
import { runAction, type ActionButton } from '../../packages/ui/src/toolbar-model.js';

// MVP M8 contract, unit M8-U4: the layer-panel half of M8-A10 (section 7.2, M8-L2 to L4,
// M8-Q7 (a)): the page and row models (front first, depth, expansions excluded) as pure
// functions, the literal command of each action run against a real editor (each document edit
// one undo step), and the `PageList` and `LayerTree` markup with `renderToString`.

const frame = { x: 10, y: 20, width: 30, height: 40 };
const none: ReadonlySet<string> = new Set();

function editor(): Editor {
  return createEditor({
    document: {
      schemaVersion: 6,
      id: 'doc',
      pages: [{ id: 'p1', name: 'Page 1', children: [] }],
      nodes: {},
    },
    ids: createCounterIdSource('n'),
  });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
  return result.ids;
}

const depth = (target: Editor) => target.getSnapshot().history.undoDepth;
const find = (buttons: readonly ActionButton[], testId: string) =>
  buttons.find((button) => button.testId === testId)!;

/**
 * Page `p1`, back to front: a symbol `s` (holding `r0`), a group `g` (holding `r1` back, `e`
 * front) and an instance `i` of `s`. IDs come from the counter source.
 */
function scene() {
  const target = editor();
  const r0 = ok(target, { type: 'createRectangle', frame, name: 'Source rect' })[0]!;
  const s = ok(target, { type: 'createSymbol', ids: [r0] })[0]!;
  const r1 = ok(target, { type: 'createRectangle', frame })[0]!;
  const e = ok(target, { type: 'createEllipse', frame })[0]!;
  const g = ok(target, { type: 'groupNodes', ids: [r1, e], kind: 'group' })[0]!;
  const i = ok(target, { type: 'createInstance', symbol: s })[0]!;
  return { target, r0, s, r1, e, g, i };
}

const rowsOf = (target: Editor, expanded: ReadonlySet<string> = none) => {
  const { document, activePage, selection } = target.getSnapshot();
  return layerRows(document, activePage, expanded, selection);
};
const brief = (row: LayerRow) => [row.id, row.type, row.depth, row.expandable, row.expanded];

describe('M8-A10 page list model (M8-L2)', () => {
  it('gives one button per page in order, the active one pressed, sending setActivePage', () => {
    const target = editor();
    const p2 = ok(target, { type: 'addPage', name: 'Second' })[0]!;
    const { document, activePage } = target.getSnapshot();
    expect(pageButtons(document.pages, activePage)).toEqual([
      {
        id: 'p1',
        testId: 'page-p1',
        label: 'Page 1',
        pressed: true,
        command: { type: 'setActivePage', id: 'p1' },
      },
      {
        id: p2,
        testId: `page-${p2}`,
        label: 'Second',
        pressed: false,
        command: { type: 'setActivePage', id: p2 },
      },
    ]);
    ok(target, pageButtons(document.pages, activePage)[1]!.command);
    expect(target.getSnapshot().activePage).toBe(p2);
    // A session command: no undo step beyond the add.
    expect(depth(target)).toBe(1);
  });

  it('renames a page in one undo step; blank is invalid and the same name sends nothing', () => {
    const target = editor();
    const page = target.getSnapshot().document.pages[0]!;
    expect(renamePageEdit(page, 'Cover')).toEqual({
      invalid: false,
      command: { type: 'renamePage', id: 'p1', name: 'Cover' },
    });
    expect(renamePageEdit(page, ' Cover ').command).toEqual({
      type: 'renamePage',
      id: 'p1',
      name: ' Cover ',
    });
    expect(renamePageEdit(page, '')).toEqual({ invalid: true, command: null });
    expect(renamePageEdit(page, '  ')).toEqual({ invalid: true, command: null });
    expect(renamePageEdit(page, 'Page 1')).toEqual({ invalid: false, command: null });
    ok(target, renamePageEdit(page, 'Cover').command!);
    expect(target.getSnapshot().document.pages[0]!.name).toBe('Cover');
    expect(depth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(target.getSnapshot().document.pages[0]!.name).toBe('Page 1');
  });

  it('adds a page at the end and activates it, then removes the active page, one step each', () => {
    const target = editor();
    const execute = (command: Command) => target.execute(command);
    const actions = () => {
      const { document, activePage } = target.getSnapshot();
      return pageActions(document.pages, activePage);
    };
    expect(actions()).toEqual([
      {
        testId: 'add-page',
        label: 'add page',
        disabled: false,
        command: { type: 'addPage' },
        selectAfter: null,
      },
      {
        testId: 'remove-page',
        label: 'remove page',
        disabled: true,
        command: null,
        selectAfter: null,
      },
    ]);
    // A disabled button sends nothing.
    expect(runPageAction(execute, find(actions(), 'remove-page'))).toBeNull();
    expect(depth(target)).toBe(0);

    const added = runPageAction(execute, find(actions(), 'add-page'));
    expect(added).toEqual({ ok: true, ids: ['n1'] });
    expect(target.getSnapshot().document.pages.map((page) => [page.id, page.name])).toEqual([
      ['p1', 'Page 1'],
      ['n1', 'Page 2'],
    ]);
    expect(target.getSnapshot().activePage).toBe('n1');
    expect(depth(target)).toBe(1);

    expect(find(actions(), 'remove-page').command).toEqual({ type: 'removePage', id: 'n1' });
    expect(runPageAction(execute, find(actions(), 'remove-page'))).toEqual({ ok: true, ids: [] });
    expect(target.getSnapshot().document.pages.map((page) => page.id)).toEqual(['p1']);
    expect(target.getSnapshot().activePage).toBe('p1');
    expect(depth(target)).toBe(2);
  });

  it('returns a refusal unchanged and activates nothing', () => {
    const target = editor();
    const stale: ActionButton = {
      testId: 'remove-page',
      label: 'remove page',
      disabled: false,
      command: { type: 'removePage', id: 'gone' },
      selectAfter: null,
    };
    const result = runPageAction((command) => target.execute(command), stale);
    expect(result).toMatchObject({ ok: false, code: 'editor.unknown-page' });
    expect(target.getSnapshot().activePage).toBe('p1');
    expect(depth(target)).toBe(0);
  });
});

describe('M8-A10 layer rows (M8-L3)', () => {
  it('lists the active page front first, containers collapsed, the instance a leaf', () => {
    const { target, s, g, i } = scene();
    expect(rowsOf(target)).toEqual([
      {
        id: i,
        testId: `layer-${i}`,
        name: target.getSnapshot().document.nodes[i]!.name,
        type: 'instance',
        depth: 0,
        expandable: false,
        expanded: false,
        selected: false,
        visible: true,
      },
      {
        id: g,
        testId: `layer-${g}`,
        name: target.getSnapshot().document.nodes[g]!.name,
        type: 'group',
        depth: 0,
        expandable: true,
        expanded: false,
        selected: false,
        visible: true,
      },
      {
        id: s,
        testId: `layer-${s}`,
        name: target.getSnapshot().document.nodes[s]!.name,
        type: 'symbol',
        depth: 0,
        expandable: true,
        expanded: false,
        selected: false,
        visible: true,
      },
    ]);
  });

  it('lists an expanded container’s children after it, front first, one level deeper', () => {
    const { target, r0, s, r1, e, g, i } = scene();
    expect(rowsOf(target, new Set([g, s, i])).map(brief)).toEqual([
      // The instance's expansion is no document node: nothing follows it.
      [i, 'instance', 0, false, false],
      [g, 'group', 0, true, true],
      [e, 'ellipse', 1, false, false],
      [r1, 'rectangle', 1, false, false],
      [s, 'symbol', 0, true, true],
      [r0, 'rectangle', 1, false, false],
    ]);
    expect(rowsOf(target, new Set([g, s]))[5]!.name).toBe('Source rect');
    // Nested: group the group again, expand both.
    const outer = ok(target, { type: 'groupNodes', ids: [g], kind: 'group' })[0]!;
    expect(rowsOf(target, new Set([outer, g])).map(brief)).toEqual([
      [i, 'instance', 0, false, false],
      [outer, 'group', 0, true, true],
      [g, 'group', 1, true, true],
      [e, 'ellipse', 2, false, false],
      [r1, 'rectangle', 2, false, false],
      [s, 'symbol', 0, true, false],
    ]);
  });

  it('expands frames and mask groups like groups', () => {
    const target = editor();
    const f = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 200, height: 200 },
    })[0]!;
    // A mask group's first (back) child is its path mask source.
    const a = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [10, 10, 50, 10, 50, 90],
    })[0]!;
    const b = ok(target, { type: 'createEllipse', frame })[0]!;
    const m = ok(target, { type: 'groupNodes', ids: [a, b], kind: 'maskGroup' })[0]!;
    ok(target, { type: 'moveNodes', ids: [m], parent: f, index: 0 });
    expect(rowsOf(target).map(brief)).toEqual([[f, 'frame', 0, true, false]]);
    expect(rowsOf(target, new Set([f, m])).map(brief)).toEqual([
      [f, 'frame', 0, true, true],
      [m, 'maskGroup', 1, true, true],
      [b, 'ellipse', 2, false, false],
      [a, 'path', 2, false, false],
    ]);
  });

  it('lists only the active page and nothing for an unknown page', () => {
    const { target, g } = scene();
    const p2 = ok(target, { type: 'addPage' })[0]!;
    ok(target, { type: 'setActivePage', id: p2 });
    expect(rowsOf(target)).toEqual([]);
    const { document } = target.getSnapshot();
    expect(layerRows(document, 'gone', new Set([g]), [])).toEqual([]);
  });

  it('marks the selected rows and hidden nodes', () => {
    const { target, s, r1, e, g, i } = scene();
    ok(target, { type: 'setSelection', ids: [s, r1] });
    ok(target, { type: 'setNodeProps', id: g, props: { visible: false } });
    expect(rowsOf(target, new Set([g])).map((row) => [row.id, row.selected, row.visible])).toEqual([
      [i, false, true],
      [g, false, false],
      [e, false, true],
      [r1, true, true],
      [s, true, true],
    ]);
  });

  it('toggles expansion as React state, never the document or history', () => {
    const { target, g } = scene();
    const before = target.getSnapshot();
    const open = toggleExpanded(none, g);
    expect([...open]).toEqual([g]);
    expect([...none]).toEqual([]);
    expect([...toggleExpanded(open, g)]).toEqual([]);
    expect(target.getSnapshot()).toBe(before);
  });
});

describe('M8-A10 layer row actions (M8-L3, L4)', () => {
  it('selects a row alone, or toggles it with Shift or Mod; a session command', () => {
    const { target, s, g, i } = scene();
    const steps = depth(target);
    const click = (id: string, toggle: boolean) => {
      const command = rowClickCommand(target.getSnapshot().selection, id, toggle);
      ok(target, command);
      return command;
    };
    expect(click(g, false)).toEqual({ type: 'setSelection', ids: [g] });
    expect(click(s, true)).toEqual({ type: 'setSelection', ids: [g, s] });
    expect(click(i, true)).toEqual({ type: 'setSelection', ids: [g, s, i] });
    expect(click(s, true)).toEqual({ type: 'setSelection', ids: [g, i] });
    expect(target.getSnapshot().selection).toEqual([g, i]);
    expect(click(i, false)).toEqual({ type: 'setSelection', ids: [i] });
    expect(depth(target)).toBe(steps);
  });

  it('hides and shows a node in one undo step each', () => {
    const { target, g } = scene();
    const steps = depth(target);
    const row = () => rowsOf(target).find((entry) => entry.id === g)!;
    expect(visibilityCommand(row())).toEqual({
      type: 'setNodeProps',
      id: g,
      props: { visible: false },
    });
    ok(target, visibilityCommand(row()));
    expect(row().visible).toBe(false);
    expect(depth(target)).toBe(steps + 1);
    expect(visibilityCommand(row())).toEqual({
      type: 'setNodeProps',
      id: g,
      props: { visible: true },
    });
    ok(target, visibilityCommand(row()));
    expect(row().visible).toBe(true);
    expect(depth(target)).toBe(steps + 2);
    ok(target, { type: 'undo' });
    expect(row().visible).toBe(false);
  });

  it('renames a node in one undo step; blank is invalid and the same name sends nothing', () => {
    const { target, r0, s } = scene();
    const steps = depth(target);
    const row = rowsOf(target, new Set([s])).find((entry) => entry.id === r0)!;
    expect(renameNodeEdit(row, 'Logo')).toEqual({
      invalid: false,
      command: { type: 'setNodeProps', id: r0, props: { name: 'Logo' } },
    });
    expect(renameNodeEdit(row, '')).toEqual({ invalid: true, command: null });
    expect(renameNodeEdit(row, '\t ')).toEqual({ invalid: true, command: null });
    expect(renameNodeEdit(row, 'Source rect')).toEqual({ invalid: false, command: null });
    ok(target, renameNodeEdit(row, 'Logo').command!);
    expect(target.getSnapshot().document.nodes[r0]!.name).toBe('Logo');
    expect(depth(target)).toBe(steps + 1);
  });

  it('reorders the selection forward, backward, front and back, one undo step each', () => {
    const { target, s, g, i } = scene();
    const execute = (command: Command) => target.execute(command);
    const actions = () => reorderActions(target.getSnapshot().selection);
    const order = () => rowsOf(target).map((row) => row.id);
    expect(reorderActions([]).map((button) => [button.testId, button.disabled])).toEqual([
      ['reorder-forward', true],
      ['reorder-backward', true],
      ['reorder-front', true],
      ['reorder-back', true],
    ]);
    expect(runAction(execute, find(reorderActions([]), 'reorder-front'))).toBeNull();
    ok(target, { type: 'setSelection', ids: [s] });
    expect(actions().map((button) => [button.testId, button.label, button.command])).toEqual([
      ['reorder-forward', 'forward', { type: 'reorderNodes', ids: [s], op: 'forward' }],
      ['reorder-backward', 'backward', { type: 'reorderNodes', ids: [s], op: 'backward' }],
      ['reorder-front', 'front', { type: 'reorderNodes', ids: [s], op: 'front' }],
      ['reorder-back', 'back', { type: 'reorderNodes', ids: [s], op: 'back' }],
    ]);
    const steps = depth(target);
    expect(order()).toEqual([i, g, s]);
    expect(runAction(execute, find(actions(), 'reorder-forward'))?.ok).toBe(true);
    expect(order()).toEqual([i, s, g]);
    expect(depth(target)).toBe(steps + 1);
    expect(runAction(execute, find(actions(), 'reorder-front'))?.ok).toBe(true);
    expect(order()).toEqual([s, i, g]);
    expect(depth(target)).toBe(steps + 2);
    // Already in front: no change and no step.
    expect(runAction(execute, find(actions(), 'reorder-forward'))?.ok).toBe(true);
    expect(depth(target)).toBe(steps + 2);
    expect(runAction(execute, find(actions(), 'reorder-backward'))?.ok).toBe(true);
    expect(order()).toEqual([i, s, g]);
    expect(runAction(execute, find(actions(), 'reorder-back'))?.ok).toBe(true);
    expect(order()).toEqual([i, g, s]);
    expect(depth(target)).toBe(steps + 4);
    // The selection is kept.
    expect(target.getSnapshot().selection).toEqual([s]);
  });
});

/** The buttons of `html` as `[test ID, disabled, pressed]`, in order. */
function buttons(html: string): [string, boolean, string | null][] {
  return [...html.matchAll(/<button ([^>]*)>/gu)].map(([, attributes]) => [
    /data-testid="([^"]+)"/u.exec(attributes!)![1]!,
    /\bdisabled=""/u.test(attributes!),
    /aria-pressed="(true|false)"/u.exec(attributes!)?.[1] ?? null,
  ]);
}

const markup = (target: Editor, component: ComponentType) =>
  renderToString(createElement(EditorProvider, { editor: target }, createElement(component)));

describe('M8-A10 PageList and LayerTree markup (M8-L2 to L4)', () => {
  it('renders exactly one button per page inside `pages`, add and remove outside it', () => {
    const target = editor();
    ok(target, { type: 'addPage', name: 'Two' });
    const html = markup(target, PageList);
    const nav = /<nav data-testid="pages"[^>]*>(.*?)<\/nav>/u.exec(html)![1]!;
    expect(buttons(nav)).toEqual([
      ['page-p1', false, 'true'],
      ['page-n1', false, 'false'],
    ]);
    expect(nav).toContain('>Page 1</button>');
    expect(nav).toContain('>Two</button>');
    expect(buttons(html)).toEqual([
      ['page-p1', false, 'true'],
      ['page-n1', false, 'false'],
      ['add-page', false, null],
      ['remove-page', false, null],
    ]);
    expect(
      html.startsWith(
        '<div role="group" aria-label="pages" style="display:flex;gap:8px;padding:0 8px">' +
          '<nav data-testid="pages" style="display:flex;gap:8px">',
      ),
    ).toBe(true);
    expect(html).not.toContain('pages-refusal');
    expect(html).not.toContain('<input');
    ok(target, { type: 'removePage', id: 'n1' });
    expect(buttons(markup(target, PageList))).toEqual([
      ['page-p1', false, 'true'],
      ['add-page', false, null],
      ['remove-page', true, null],
    ]);
  });

  it('renders the tree rows front first with depth, type, toggles and the marked selection', () => {
    const { target, s, g, i } = scene();
    ok(target, { type: 'setSelection', ids: [g] });
    ok(target, { type: 'setNodeProps', id: s, props: { visible: false } });
    const html = markup(target, LayerTree);
    expect(html).toContain(
      '<section aria-label="layers" data-testid="layers" style="display:flex;' +
        'flex-direction:column;height:240px;box-sizing:border-box">',
    );
    expect(buttons(html)).toEqual([
      ['reorder-forward', false, null],
      ['reorder-backward', false, null],
      ['reorder-front', false, null],
      ['reorder-back', false, null],
      [`layer-name-${i}`, false, 'false'],
      [`layer-visible-${i}`, false, null],
      [`layer-toggle-${g}`, false, null],
      [`layer-name-${g}`, false, 'true'],
      [`layer-visible-${g}`, false, null],
      [`layer-toggle-${s}`, false, null],
      [`layer-name-${s}`, false, 'false'],
      [`layer-visible-${s}`, false, null],
    ]);
    const rows = [
      ...html.matchAll(
        /<li data-testid="([^"]+)" data-depth="(\d+)" data-selected="(true|false)"/gu,
      ),
    ];
    expect(rows.map((match) => match.slice(1))).toEqual([
      [`layer-${i}`, '0', 'false'],
      [`layer-${g}`, '0', 'true'],
      [`layer-${s}`, '0', 'false'],
    ]);
    expect(html).toContain(`aria-expanded="false" aria-label="expand"`);
    expect(html).toContain('<span>instance</span>');
    expect(html).toContain('<span>group</span>');
    expect(html).toContain('<span>symbol</span>');
    // The hidden symbol is dimmed and offers "show".
    expect(html).toContain(`data-testid="layer-visible-${s}">show</button>`);
    expect(html).toContain(`data-testid="layer-visible-${g}">hide</button>`);
    expect(html).toContain('opacity:0.5');
    expect(html).not.toContain('layers-refusal');
  });

  it('disables the reorder buttons and lists no row on an empty page', () => {
    const html = markup(editor(), LayerTree);
    expect(buttons(html)).toEqual([
      ['reorder-forward', true, null],
      ['reorder-backward', true, null],
      ['reorder-front', true, null],
      ['reorder-back', true, null],
    ]);
    expect(html).toContain('<ul aria-label="layer list"');
    expect(html).not.toContain('<li');
  });
});
