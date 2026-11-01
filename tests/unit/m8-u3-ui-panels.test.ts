import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createCounterIdSource,
  createEditor,
  starExtension,
  type Editor,
  type Extension,
} from '@vector-studio/editor-core';
import {
  EditorPanels,
  EditorProvider,
  PanelBoundary,
  PanelProvider,
  resolvePanels,
  useNode,
  usePanelErrors,
  useSelection,
  type PanelContribution,
  type PanelError,
  type UiExtension,
} from '@vector-studio/ui';
import {
  addFailure,
  contributionsEqual,
  initialReporter,
  panelErrorKey,
  pruneReporters,
  reportFailure,
  reportRejections,
  reporterFor,
  type PanelReporter,
} from '../../packages/ui/src/panel-report.js';
import { createElement, type ComponentType, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The repository's executable boundary policy is JavaScript tooling.
import { importSpecifiers } from '../../tooling/boundary-policy.mjs';

// MVP M8 contract, unit M8-U3, M8-A09: panel contributions (section 6, M8-P1 to P4) through the
// built `@vector-studio/ui` entry. `resolvePanels` and the `PanelBoundary` statics are tested as
// functions and the markup with `renderToString` (M8-Q5 (a)); server rendering runs neither
// effects nor error boundaries, so the `onPanelError` effect and a boundary catching a real
// render error are checked in a browser by M8-A14.

const root = path.resolve(import.meta.dirname, '../..');
const specifiersOf = importSpecifiers as (text: string) => string[];

/** `test.ui`: one command, so it registers and appears in the `extensions` query. */
const testExtension: Extension = {
  id: 'test.ui',
  commands: [{ id: 'test.ui.noop', run: () => ({ ok: true, ids: [] }) }],
};

function editor(): Editor {
  return createEditor({
    document: {
      schemaVersion: 6,
      id: 'doc',
      pages: [{ id: 'p1', name: 'Page 1', children: [] }],
      nodes: {},
    },
    ids: createCounterIdSource('n'),
    extensions: [starExtension, testExtension],
  });
}

const Empty: ComponentType = () => null;
const panel = (id: string, title = id, component: ComponentType = Empty): PanelContribution => ({
  id,
  title,
  component,
});

describe('M8-A09 resolvePanels (M8-P2)', () => {
  const extensions = editor().query({ type: 'extensions' });

  it('accepts owned panels of registered extensions, in contribution order', () => {
    const contributions: UiExtension[] = [
      { extension: 'ext.star', panels: [panel('ext.star'), panel('ext.star.points')] },
      { extension: 'test.ui', panels: [panel('test.ui.inspector')] },
    ];
    const result = resolvePanels(contributions, extensions);
    expect(result.errors).toEqual([]);
    expect(result.panels).toEqual([
      { extension: 'ext.star', panel: contributions[0]!.panels[0] },
      { extension: 'ext.star', panel: contributions[0]!.panels[1] },
      { extension: 'test.ui', panel: contributions[1]!.panels[0] },
    ]);
  });

  it('returns one error per rejected panel, each code once, and keeps the rest', () => {
    const contributions: UiExtension[] = [
      {
        extension: 'ext.star',
        panels: [
          panel('ext.star'),
          // Not under the extension: another ID, and a prefix without the dot.
          panel('test.ui.stolen'),
          panel('ext.starry'),
          // An ID already accepted.
          panel('ext.star'),
        ],
      },
      { extension: 'missing', panels: [panel('missing'), panel('missing.more')] },
      // Unknown wins over unowned and duplicate: the owner is checked first.
      { extension: 'test.u', panels: [panel('ext.star')] },
      { extension: 'test.ui', panels: [panel('test.ui'), panel('test.ui')] },
    ];
    const result = resolvePanels(contributions, extensions);
    expect(result.errors).toEqual<PanelError[]>([
      { code: 'ui.unowned-panel', panel: 'test.ui.stolen' },
      { code: 'ui.unowned-panel', panel: 'ext.starry' },
      { code: 'ui.duplicate-panel', panel: 'ext.star' },
      { code: 'ui.unknown-extension', panel: 'missing' },
      { code: 'ui.unknown-extension', panel: 'missing.more' },
      { code: 'ui.unknown-extension', panel: 'ext.star' },
      { code: 'ui.duplicate-panel', panel: 'test.ui' },
    ]);
    expect(result.panels.map(({ extension, panel: { id } }) => [extension, id])).toEqual([
      ['ext.star', 'ext.star'],
      ['test.ui', 'test.ui'],
    ]);
  });

  it('is pure: the same arguments give equal results and are not changed', () => {
    const contributions: UiExtension[] = [
      { extension: 'ext.star', panels: [panel('ext.star'), panel('nope')] },
    ];
    const copy = structuredClone(contributions.map((entry) => entry.panels.map((p) => p.id)));
    expect(resolvePanels(contributions, extensions)).toEqual(
      resolvePanels(contributions, extensions),
    );
    expect(contributions.map((entry) => entry.panels.map((p) => p.id))).toEqual(copy);
    expect(resolvePanels([], extensions)).toEqual({ panels: [], errors: [] });
    expect(resolvePanels(contributions, [])).toEqual({
      panels: [],
      errors: [
        { code: 'ui.unknown-extension', panel: 'ext.star' },
        { code: 'ui.unknown-extension', panel: 'nope' },
      ],
    });
  });
});

/** A fixture panel that reads the editor through the public hooks only (M8-P4). */
function SelectionPanel() {
  const selection = useSelection();
  const first = useNode(selection[0] ?? '');
  return createElement('p', null, `${selection.length} ${first?.type ?? 'none'}`);
}

function ErrorList() {
  const errors = usePanelErrors();
  return createElement(
    'ul',
    null,
    errors.map((error, index) =>
      createElement('li', { key: index }, `${error.code} ${error.panel}`),
    ),
  );
}

function render(target: Editor, contributions: readonly UiExtension[]): string {
  return renderToString(
    createElement(
      EditorProvider,
      { editor: target },
      createElement(
        PanelProvider,
        { contributions },
        createElement(EditorPanels),
        createElement(ErrorList),
      ),
    ),
  );
}

describe('M8-A09 PanelProvider and EditorPanels (M8-P1, M8-P4)', () => {
  it('renders a fixture panel through the public hooks, and the rejected panels as errors', () => {
    const target = editor();
    const created = target.execute({
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(created).toEqual({ ok: true, ids: ['n1'] });
    target.execute({ type: 'setSelection', ids: ['n1'] });
    const html = render(target, [
      {
        extension: 'test.ui',
        panels: [panel('test.ui.selection', 'Selection', SelectionPanel), panel('other')],
      },
      { extension: 'ghost', panels: [panel('ghost')] },
    ]);
    expect(html).toBe(
      [
        '<section aria-label="Selection" data-panel="test.ui.selection">',
        '<h2 style="font-size:inherit;margin:0">',
        '<button type="button" aria-expanded="true">Selection</button></h2>',
        '<div><p>1 rectangle</p></div></section>',
        '<ul><li>ui.unowned-panel other</li><li>ui.unknown-extension ghost</li></ul>',
      ].join(''),
    );
  });

  it('keeps panel state out of the document and history: no command, no event', () => {
    const target = editor();
    let events = 0;
    target.subscribe(() => {
      events += 1;
    });
    const before = target.getSnapshot();
    render(target, [
      { extension: 'ext.star', panels: [panel('ext.star', 'Star', SelectionPanel)] },
      { extension: 'test.ui', panels: [panel('test.ui', 'Test', SelectionPanel)] },
    ]);
    expect(events).toBe(0);
    expect(target.getSnapshot()).toBe(before);
    expect(target.getSnapshot().history).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  it('sends no command from the panel modules: they read the extensions query only', async () => {
    for (const file of ['panels.tsx', 'panel-resolve.ts']) {
      const text = await readFile(path.join(root, 'packages/ui/src', file), 'utf8');
      expect(text, file).not.toMatch(/useEditorCommands|\.execute\(/u);
      expect(
        specifiersOf(text).filter((name) => !name.startsWith('.')),
        file,
      ).toEqual(['@vector-studio/react', 'react']);
    }
  });

  it('throws outside a PanelProvider', () => {
    const target = editor();
    for (const component of [EditorPanels, ErrorList]) {
      expect(() =>
        renderToString(createElement(EditorProvider, { editor: target }, createElement(component))),
      ).toThrow(/no PanelProvider above this component/u);
    }
  });
});

describe('M8-A09 onPanelError bookkeeping (M8-P1, M8-P3): each error once, rejections first', () => {
  const A: PanelError = { code: 'ui.unowned-panel', panel: 'a' };
  const B: PanelError = { code: 'ui.unknown-extension', panel: 'b' };
  const F: PanelError = { code: 'ui.panel-failed', panel: 'f' };
  const G: PanelError = { code: 'ui.panel-failed', panel: 'g' };
  /** Runs steps from a fresh reporter and returns what was delivered, in order. */
  function deliveries(
    ...steps: ((reporter: PanelReporter) => {
      reporter: PanelReporter;
      deliver: readonly PanelError[];
    })[]
  ): PanelError[] {
    let reporter = initialReporter(0);
    const out: PanelError[] = [];
    for (const step of steps) {
      const next = step(reporter);
      reporter = next.reporter;
      out.push(...next.deliver);
    }
    return out;
  }
  const rejections = (list: readonly PanelError[]) => (r: PanelReporter) =>
    reportRejections(r, list);
  const failure = (error: PanelError) => (r: PanelReporter) => reportFailure(r, error);

  it('keys an error by code and panel', () => {
    expect(panelErrorKey(A)).toBe('ui.unowned-panel a');
    expect(initialReporter(3)).toEqual({
      generation: 3,
      reported: new Set(),
      ready: false,
      queue: [],
    });
  });

  it('delivers only the new rejection when [A] becomes [A, B]', () => {
    expect(deliveries(rejections([A]), rejections([A, B]))).toEqual([A, B]);
    // The same list again, or a repeat inside one list, delivers nothing more.
    expect(deliveries(rejections([A, A]), rejections([A]), rejections([B, A]))).toEqual([A, B]);
  });

  it('queues failures caught before the rejections were reported, then rejections first', () => {
    // A boundary's componentDidCatch runs in the commit, before the provider's passive effect.
    expect(deliveries(failure(F), failure(G), rejections([A, B]))).toEqual([A, B, F, G]);
    // After that, a failure is delivered when it occurs.
    expect(deliveries(rejections([A]), failure(F), rejections([A, B]))).toEqual([A, F, B]);
  });

  it('delivers a panel failure once, queued or not', () => {
    expect(deliveries(failure(F), failure(F), rejections([]), failure(F))).toEqual([F]);
    expect(deliveries(rejections([]), failure(F), failure(F))).toEqual([F]);
  });

  it('keeps the committed reporter when a render with a new generation is thrown away', () => {
    const reporters = new Map<number, PanelReporter>();
    // Generation 0 commits and delivers A.
    const first = reportRejections(reporterFor(reporters, 0), [A]);
    reporters.set(0, first.reporter);
    expect(first.deliver).toEqual([A]);
    // A render brings in generation 1 and is abandoned: its reporter exists, nothing commits.
    expect(reporterFor(reporters, 1)).toEqual(initialReporter(1));
    // The next render is generation 0 again: its reporter is the committed one, A is not resent.
    expect(reporterFor(reporters, 0)).toBe(first.reporter);
    expect(reportRejections(reporterFor(reporters, 0), [A]).deliver).toEqual([]);
    pruneReporters(reporters, 0);
    expect([...reporters.keys()]).toEqual([0]);
    // A real generation 1 later starts fresh and reports anew.
    expect(reportRejections(reporterFor(reporters, 1), [A]).deliver).toEqual([A]);
  });

  it('lists each failed panel once for usePanelErrors, keeping the list when unchanged', () => {
    const one = addFailure([], F);
    expect(one).toEqual([F]);
    expect(addFailure(one, F)).toBe(one);
    expect(addFailure(addFailure(one, G), F)).toEqual([F, G]);
  });

  it('compares contributions by extension, panel ID, title and component', () => {
    const base: UiExtension[] = [{ extension: 'x', panels: [panel('x', 'X', SelectionPanel)] }];
    const same: UiExtension[] = [{ extension: 'x', panels: [panel('x', 'X', SelectionPanel)] }];
    expect(contributionsEqual(base, same)).toBe(true);
    expect(contributionsEqual(base, base)).toBe(true);
    for (const other of [
      [],
      [{ extension: 'y', panels: [panel('x', 'X', SelectionPanel)] }],
      [{ extension: 'x', panels: [panel('x.y', 'X', SelectionPanel)] }],
      [{ extension: 'x', panels: [panel('x', 'Y', SelectionPanel)] }],
      [{ extension: 'x', panels: [panel('x', 'X', Empty)] }],
      [{ extension: 'x', panels: [] }],
    ] as UiExtension[][]) {
      expect(contributionsEqual(base, other), JSON.stringify(other)).toBe(false);
    }
  });
});

describe('M8-A09 PanelBoundary (M8-P3)', () => {
  it('sets the failed state from getDerivedStateFromError', () => {
    expect(PanelBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it('renders its panel, then the ui.panel-failed notice once failed, and reports it once', () => {
    const reported: PanelError[] = [];
    const boundary = new PanelBoundary({
      panel: 'test.ui.throws',
      onPanelError: (error) => reported.push(error),
      children: createElement('span', null, 'body'),
    });
    expect(boundary.state).toEqual({ failed: false });
    expect(renderToString(boundary.render() as ReactElement)).toBe('<span>body</span>');
    boundary.state = PanelBoundary.getDerivedStateFromError();
    expect(renderToString(boundary.render() as ReactElement)).toBe(
      '<p role="alert" data-panel-error="ui.panel-failed">ui.panel-failed</p>',
    );
    boundary.componentDidCatch();
    expect(reported).toEqual([{ code: 'ui.panel-failed', panel: 'test.ui.throws' }]);
  });

  it('renders its children unchanged when nothing failed', () => {
    const html = renderToString(
      createElement(PanelBoundary, { panel: 'x' }, createElement('em', null, 'ok')),
    );
    expect(html).toBe('<em>ok</em>');
  });
});
