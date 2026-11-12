import {
  createCounterIdSource,
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type Extension,
  type ExtensionTool,
  type PathEditOverlay,
} from '@vector-studio/editor-core';
import { EditorProvider, ToolbarPrimaryRow, ToolbarSecondaryRow } from '@vector-studio/ui';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_TOOLS,
  editActions,
  runAction,
  symbolActions,
  toggleClosedCommand,
  toolButtons,
  toolbarTools,
  zoomActions,
  zoomLabel,
  type ActionButton,
} from '../../packages/ui/src/toolbar-model.js';

// MVP M8 contract, unit M8-U3: the toolbar half of M8-A10 (section 7.1, M8-L1, M8-Q10 (a)): the
// two rows' models with their enable rules and the tool list with extension tools, as pure
// functions, the literal command of each button run against a real editor (each document edit
// one undo step), and the rows' markup with `renderToString`.

const frame = { x: 10, y: 20, width: 30, height: 40 };

const tool = (id: string): ExtensionTool => ({ id, input: () => false, reset: () => {} });
/** Two extensions with tools; `ext.star` (no tools) sorts between them. */
const extensions: Extension[] = [
  { id: 'test.ui', tools: [tool('test.ui.draw'), tool('test.ui.alpha')] },
  { id: 'aaa.ext', tools: [tool('aaa.ext')] },
];

function editor(): Editor {
  return createEditor({
    document: {
      schemaVersion: 6,
      id: 'doc',
      pages: [{ id: 'p1', name: 'Page 1', children: [] }],
      nodes: {},
    },
    ids: createCounterIdSource('n'),
    extensions: [starExtension, ...extensions],
  });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
  return result.ids;
}

const summary = (button: ActionButton) => [button.testId, button.label, button.disabled];
const find = (buttons: readonly ActionButton[], testId: string) =>
  buttons.find((button) => button.testId === testId)!;

describe('M8-A10 toolbar row 1: tools (M8-L1)', () => {
  it('lists the built-in tools, then each extension tool by ID, extensions sorted by ID', () => {
    expect(BUILT_IN_TOOLS).toEqual([
      'select',
      'rectangle',
      'ellipse',
      'polygon',
      'line',
      'frame',
      'path',
      'pencil',
      'text',
      'eyedropper',
    ]);
    expect(Object.isFrozen(BUILT_IN_TOOLS)).toBe(true);
    expect(toolbarTools(editor().query({ type: 'extensions' }))).toEqual([
      ...BUILT_IN_TOOLS,
      'aaa.ext',
      'test.ui.alpha',
      'test.ui.draw',
    ]);
    expect(toolbarTools([])).toEqual(BUILT_IN_TOOLS);
  });

  it('presses the active tool and sends setTool, extension tools included', () => {
    const target = editor();
    const buttons = toolButtons(['select', 'test.ui.draw'], 'test.ui.draw');
    expect(buttons).toEqual([
      {
        testId: 'tool-select',
        label: 'select',
        pressed: false,
        command: { type: 'setTool', tool: 'select' },
      },
      {
        testId: 'tool-test.ui.draw',
        label: 'test.ui.draw',
        pressed: true,
        command: { type: 'setTool', tool: 'test.ui.draw' },
      },
    ]);
    ok(target, buttons[1]!.command);
    expect(target.getSnapshot().tool).toBe('test.ui.draw');
    expect(target.getSnapshot().history).toEqual({ undoDepth: 0, redoDepth: 0 });
  });
});

describe('M8-A10 toolbar row 1: actions and enable rules (M8-L1)', () => {
  const none = { selection: [], history: { undoDepth: 0, redoDepth: 0 }, first: null };

  it('disables every action on an empty selection with no history and no path edit', () => {
    expect(editActions({ ...none, pathOverlay: null }).map(summary)).toEqual([
      ['group', 'group', true],
      ['mask', 'mask', true],
      ['ungroup', 'ungroup', true],
      ['undo', 'undo', true],
      ['redo', 'redo', true],
      ['delete', 'delete', true],
      ['toggle-closed', 'toggle closed', true],
    ]);
  });

  it('gives the literal command of each enabled action', () => {
    const target = editor();
    const [a, b] = [
      ok(target, { type: 'createRectangle', frame })[0]!,
      ok(target, { type: 'createEllipse', frame })[0]!,
    ];
    const one = editActions({
      selection: [a],
      history: { undoDepth: 2, redoDepth: 1 },
      first: target.query({ type: 'node', id: a }),
      pathOverlay: null,
    });
    expect(one.map((button) => [button.testId, button.command, button.selectAfter])).toEqual([
      ['group', { type: 'groupNodes', ids: [a], kind: 'group' }, 'result'],
      ['mask', null, 'result'],
      // A leaf releases no children.
      ['ungroup', { type: 'ungroupNodes', id: a }, []],
      ['undo', { type: 'undo' }, null],
      ['redo', { type: 'redo' }, null],
      ['delete', { type: 'deleteNodes', ids: [a] }, null],
      ['toggle-closed', null, null],
    ]);
    const two = editActions({ ...none, selection: [a, b], pathOverlay: null });
    expect(find(two, 'mask').command).toEqual({
      type: 'groupNodes',
      ids: [a, b],
      kind: 'maskGroup',
    });
    expect(find(two, 'ungroup').disabled).toBe(true);
  });

  it('groups and selects the group, ungroups and selects the children, one undo step each', () => {
    const target = editor();
    const execute = (command: Command) => target.execute(command);
    const ids = [
      ok(target, { type: 'createRectangle', frame })[0]!,
      ok(target, { type: 'createEllipse', frame })[0]!,
    ];
    ok(target, { type: 'setSelection', ids });
    const actions = () => {
      const snapshot = target.getSnapshot();
      return editActions({
        selection: snapshot.selection,
        history: snapshot.history,
        first: snapshot.document.nodes[snapshot.selection[0] ?? ''] ?? null,
        pathOverlay: target.query({ type: 'pathOverlay' }),
      });
    };
    const grouped = runAction(execute, find(actions(), 'group'));
    expect(grouped).toEqual({ ok: true, ids: ['n3'] });
    expect(target.getSnapshot().selection).toEqual(['n3']);
    expect(target.getSnapshot().history).toEqual({ undoDepth: 3, redoDepth: 0 });
    // The released children are read from the group before the command.
    expect(find(actions(), 'ungroup').selectAfter).toEqual(ids);
    expect(runAction(execute, find(actions(), 'ungroup'))).toEqual({ ok: true, ids: [] });
    expect(target.getSnapshot().selection).toEqual(ids);
    expect(target.getSnapshot().history).toEqual({ undoDepth: 4, redoDepth: 0 });
    expect(runAction(execute, find(actions(), 'undo'))).toEqual({ ok: true, ids: [] });
    expect(target.getSnapshot().history).toEqual({ undoDepth: 3, redoDepth: 1 });
    expect(runAction(execute, find(actions(), 'redo'))?.ok).toBe(true);
    expect(runAction(execute, find(actions(), 'delete'))?.ok).toBe(true);
    expect(target.getSnapshot().document.pages[0]!.children).toEqual([]);
    expect(target.getSnapshot().history).toEqual({ undoDepth: 5, redoDepth: 0 });
  });

  it('sends nothing for a disabled button and returns a refusal unchanged', () => {
    const target = editor();
    let events = 0;
    target.subscribe(() => {
      events += 1;
    });
    const disabled = find(editActions({ ...none, pathOverlay: null }), 'group');
    expect(runAction((command) => target.execute(command), disabled)).toBeNull();
    expect(events).toBe(0);
    // A stale selection: the command is refused and no selection change follows.
    const stale = find(editActions({ ...none, selection: ['gone'], pathOverlay: null }), 'group');
    const refused = runAction((command) => target.execute(command), stale);
    expect(refused).toMatchObject({ ok: false });
    expect(refused).toEqual(target.execute(stale.command!));
    expect(target.getSnapshot().selection).toEqual([]);
  });

  // M8-U6 removed next-host's copy of toggleClosedCommand, which this test compared with; the M3
  // expectations of the command now run against ui's copy in tests/unit/m3-next-host.test.ts.
  it('toggle closed runs toggleClosedCommand', () => {
    expect(toggleClosedCommand(null)).toBeNull();
    const point = { x: 0, y: 0 };
    const open: PathEditOverlay = {
      id: 'p',
      subpaths: [
        {
          closed: false,
          anchors: [{ point, in: null, out: null, mirrored: false, selected: true }],
        },
      ],
    };
    expect(find(editActions({ ...none, pathOverlay: open }), 'toggle-closed').command).toEqual({
      type: 'closePathSubpath',
      id: 'p',
      subpath: 0,
    });
  });
});

describe('M8-A10 toolbar row 2: zoom and symbols (M8-L1)', () => {
  it('gives the zoom commands, selection zoom enabled by a selection', () => {
    expect(zoomActions(0).map((button) => [button.testId, button.label, button.command])).toEqual([
      ['zoom-in', 'zoom in', { type: 'zoomBy', factor: 2 }],
      ['zoom-out', 'zoom out', { type: 'zoomBy', factor: 0.5 }],
      ['zoom-fit', 'fit', { type: 'zoomTo', target: 'fit' }],
      ['zoom-selection', 'selection', null],
      ['zoom-actual', '100%', { type: 'zoomTo', target: 'actual' }],
    ]);
    expect(find(zoomActions(2), 'zoom-selection').command).toEqual({
      type: 'zoomTo',
      target: 'selection',
    });
    expect([1, 2, 0.5, 1 / 3, 0.123456].map(zoomLabel)).toEqual([
      '100%',
      '200%',
      '50%',
      '33.33%',
      '12.35%',
    ]);
  });

  it("keeps next-host's symbol, instance and detach enable rules", () => {
    const rules = (selection: string[], types: string[]) =>
      symbolActions(selection, types).map((button) => button.disabled);
    expect(rules([], [])).toEqual([true, true, true]);
    expect(rules(['a'], ['rectangle'])).toEqual([false, true, true]);
    expect(rules(['a'], ['symbol'])).toEqual([false, false, true]);
    expect(rules(['a', 'b'], ['symbol', 'symbol'])).toEqual([false, true, true]);
    expect(rules(['a'], ['instance'])).toEqual([false, true, false]);
    expect(rules(['a', 'b'], ['instance', 'instance'])).toEqual([false, true, false]);
    expect(rules(['a', 'b'], ['instance', 'frame'])).toEqual([false, true, true]);
    expect(rules(['a'], [''])).toEqual([false, true, true]);
    expect(
      symbolActions(['a'], ['symbol']).map((button) => [
        button.testId,
        button.label,
        button.command,
        button.selectAfter,
      ]),
    ).toEqual([
      ['create-symbol', 'symbol', { type: 'createSymbol', ids: ['a'] }, 'result'],
      ['create-instance', 'instance', { type: 'createInstance', symbol: 'a' }, 'result'],
      ['detach', 'detach', null, null],
    ]);
  });

  it('creates a symbol, an instance and detaches it, one undo step each', () => {
    const target = editor();
    const execute = (command: Command) => target.execute(command);
    const rect = ok(target, { type: 'createRectangle', frame })[0]!;
    ok(target, { type: 'setSelection', ids: [rect] });
    const actions = () => {
      const { selection, document } = target.getSnapshot();
      return symbolActions(
        selection,
        selection.map((id) => document.nodes[id]?.type ?? ''),
      );
    };
    const depth = () => target.getSnapshot().history.undoDepth;
    expect(runAction(execute, find(actions(), 'create-symbol'))?.ok).toBe(true);
    const symbol = target.getSnapshot().selection[0]!;
    expect(target.getSnapshot().document.nodes[symbol]?.type).toBe('symbol');
    expect(depth()).toBe(2);
    expect(runAction(execute, find(actions(), 'create-instance'))?.ok).toBe(true);
    const instance = target.getSnapshot().selection[0]!;
    expect(target.getSnapshot().document.nodes[instance]?.type).toBe('instance');
    expect(depth()).toBe(3);
    expect(runAction(execute, find(actions(), 'detach'))?.ok).toBe(true);
    expect(target.getSnapshot().selection).toEqual([instance]);
    expect(target.getSnapshot().document.nodes[instance]?.type).toBe('frame');
    expect(depth()).toBe(4);
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

function markup(target: Editor, row: ComponentType<{ children?: never }>, extra?: string): string {
  return renderToString(
    createElement(
      EditorProvider,
      { editor: target },
      createElement(row, null, extra === undefined ? undefined : createElement('i', null, extra)),
    ),
  );
}

describe('M8-A10 toolbar rows markup (M8-L1, M8-Q10 (a))', () => {
  it('renders row 1 with the tools, the extension tools and the enable rules', () => {
    const target = editor();
    const id = ok(target, { type: 'createRectangle', frame })[0]!;
    ok(target, { type: 'setSelection', ids: [id] });
    ok(target, { type: 'setTool', tool: 'test.ui.alpha' });
    const html = markup(target, ToolbarPrimaryRow as ComponentType, 'host');
    expect(
      html.startsWith(
        '<div role="toolbar" aria-label="tools" style="display:flex;gap:8px;padding:8px">',
      ),
    ).toBe(true);
    expect(buttons(html)).toEqual([
      ['tool-select', false, 'false'],
      ['tool-rectangle', false, 'false'],
      ['tool-ellipse', false, 'false'],
      ['tool-polygon', false, 'false'],
      ['tool-line', false, 'false'],
      ['tool-frame', false, 'false'],
      ['tool-path', false, 'false'],
      ['tool-pencil', false, 'false'],
      ['tool-text', false, 'false'],
      ['tool-eyedropper', false, 'false'],
      ['tool-aaa.ext', false, 'false'],
      ['tool-test.ui.alpha', false, 'true'],
      ['tool-test.ui.draw', false, 'false'],
      ['group', false, null],
      ['mask', true, null],
      ['ungroup', false, null],
      ['undo', false, null],
      ['redo', true, null],
      ['delete', false, null],
      ['toggle-closed', true, null],
    ]);
    // Host controls follow the row's own; no refusal is shown.
    expect(html.endsWith('toggle closed</button><i>host</i></div>')).toBe(true);
    expect(html).not.toContain('tools-refusal');
  });

  it('renders row 2 with the zoom controls, the zoom and the symbol buttons', () => {
    const target = editor();
    const html = markup(target, ToolbarSecondaryRow as ComponentType);
    expect(buttons(html)).toEqual([
      ['zoom-in', false, null],
      ['zoom-out', false, null],
      ['zoom-fit', false, null],
      ['zoom-selection', true, null],
      ['zoom-actual', false, null],
      ['create-symbol', true, null],
      ['create-instance', true, null],
      ['detach', true, null],
    ]);
    expect(html).toContain(
      '<output data-testid="zoom" data-zoom="1" style="align-self:center">100%</output>',
    );
    expect(html).toContain('<span role="group" aria-label="zoom" style="display:flex;gap:8px">');
    expect(html).toContain('<span role="group" aria-label="symbols" style="display:flex;gap:8px">');
    const id = ok(target, { type: 'createRectangle', frame })[0]!;
    const symbol = ok(target, { type: 'createSymbol', ids: [id] })[0]!;
    ok(target, { type: 'setSelection', ids: [symbol] });
    ok(target, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 2 } });
    const after = markup(target, ToolbarSecondaryRow as ComponentType);
    expect(after).toContain('data-zoom="2"');
    expect(buttons(after).slice(3)).toEqual([
      ['zoom-selection', false, null],
      ['zoom-actual', false, null],
      ['create-symbol', false, null],
      ['create-instance', false, null],
      ['detach', true, null],
    ]);
  });
});
