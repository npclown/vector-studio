import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { posixPath } from '../support/m8-type-reach.js';

// MVP M8 contract, unit M8-U6, M8-A13 (section 9): the host API guide `docs/host-api.md` with the
// section 9 topics and local links that resolve, its AGENTS.md ownership row, and one
// compiler-API check that every export M8 added to `editor-core`, `react` and `ui` carries a
// TSDoc comment. "Added" is measured against the own exports of each built entry at 17a2b0a,
// listed below; an export re-exported from another package (M8-T1, M8-T2) keeps its owner's
// declaration and is covered by the reach tests, except `react`'s one value re-export,
// `extensionCommand`, whose re-export carries its own comment. The built declarations are read,
// so `pnpm typecheck` (or a build) runs first, as in `pnpm check`.

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/** The own exports (declared in the package's `dist`) of each built entry at 17a2b0a. */
const AT_17A2B0A: Readonly<Record<'editor-core' | 'react' | 'ui', readonly string[]>> = {
  'editor-core': [
    'AlignEdge',
    'Command',
    'CommandResult',
    'CustomNodeType',
    'DEFAULT_FRAME_FILL',
    'DEFAULT_KEYMAP',
    'DEFAULT_PATH_STROKE',
    'DEFAULT_RECTANGLE_FILL',
    'DEFAULT_SHAPE_STROKE',
    'DiagnosticEvent',
    'DistributeAxis',
    'DocumentChangeCause',
    'DocumentCommand',
    'Editor',
    'EditorErrorCode',
    'EditorEvent',
    'EditorOptions',
    'EditorSnapshot',
    'Extension',
    'ExtensionApi',
    'ExtensionCommand',
    'ExtensionTool',
    'HistoryState',
    'IdSource',
    'InputEvent',
    'KeyBinding',
    'Modifiers',
    'NodeProps',
    'PagePoint',
    'PathAnchor',
    'PathAnchorRef',
    'PathEditAnchor',
    'PathEditOverlay',
    'PathEditState',
    'Placement',
    'Platform',
    'Quad',
    'Query',
    'QueryResult',
    'ReorderOp',
    'Segment',
    'SelectionHandles',
    'SessionCommand',
    'SnapOverlay',
    'StrokePatch',
    'StyleProps',
    'TextAffinity',
    'TextCaret',
    'TextEditOverlay',
    'TextEditPending',
    'TextEditState',
    'TextStyle',
    'ToolApi',
    'ToolGesture',
    'ToolId',
    'ToolName',
    'ToolOverlay',
    'ViewportSize',
    'ZOOM_MAX',
    'ZOOM_MIN',
    'createCounterIdSource',
    'createEditor',
    'eventChord',
    'starExtension',
  ],
  react: [
    'CanvasSize',
    'EditorCanvas',
    'EditorCanvasProps',
    'EditorProvider',
    'EditorProviderProps',
    'RendererFactory',
    'RendererHandle',
    'useEditor',
    'useEditorCommands',
    'useEditorSelector',
  ],
  // The package is new in M8 (M8-U3).
  ui: [],
};

/** The re-exports M8 added that carry a comment of their own at the re-export. */
const REEXPORTS: Readonly<Record<keyof typeof AT_17A2B0A, readonly string[]>> = {
  'editor-core': [],
  react: ['extensionCommand'],
  ui: [],
};

/** The exports M8 added that the check covers, per package. */
const ADDED: Readonly<Record<keyof typeof AT_17A2B0A, readonly string[]>> = {
  'editor-core': [
    // V-30 (export) adds the export scene types of the `exportScene` query.
    'ExportNode',
    'ExportScene',
    'ExtensionCommandBuilder',
    'ExtensionSummary',
    // V-38 (rulers, guides and layout grids) adds the layout-grid geometry.
    'LayoutGridBand',
    'LayoutGridGeometry',
    'LayoutGridLine',
    'MAX_GRID_LINES',
    'StarCreateArgs',
    'extensionCommand',
    'layoutGridLines',
  ],
  react: [
    // V-30 (export) adds the PNG export.
    'ExportPngOptions',
    'exportPng',
    'extensionCommand',
    'useActivePage',
    'useEditorQuery',
    'useHistory',
    'useNode',
    'usePages',
    'useScope',
    'useSelection',
    'useSnapping',
    'useTool',
    'useViewport',
  ],
  ui: [
    'AppearancePanel',
    'AppearancePanelProps',
    // V-25 slice 10 adds the canvas context menu.
    'CanvasContextMenu',
    'CanvasContextMenuAt',
    'CanvasContextMenuProps',
    'EditorPanels',
    // V-25 (editor UI usability) adds the icon toolbar, the zoom menu and the tree's props.
    'EditorToolbar',
    'EditorToolbarProps',
    // V-30 (export).
    'ExportPanel',
    'LayerTree',
    'LayerTreeProps',
    'PageList',
    'PanelBoundary',
    'PanelBoundaryProps',
    'PanelBoundaryState',
    'PanelContribution',
    'PanelError',
    'PanelErrorCode',
    'PanelProvider',
    'PanelProviderProps',
    'PanelResolution',
    'PropertyPanel',
    'PropertySections',
    'ResolvedPanel',
    'ToolbarPrimaryRow',
    'ToolbarRowProps',
    'ToolbarSecondaryRow',
    'UiExtension',
    'ZoomMenu',
    'resolvePanels',
    'selectForContextMenu',
    'usePanelErrors',
  ],
};

/** The added exports of a package's built entry and the TSDoc text of each. */
function addedExports(name: keyof typeof AT_17A2B0A): Map<string, string> {
  const dist = path.join(root, 'packages', name, 'dist');
  const entry = path.join(dist, 'index.d.ts');
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(program.getSourceFile(entry)!)!;
  const docs = new Map<string, string>();
  const doc = (symbol: ts.Symbol) =>
    ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  for (const symbol of checker.getExportsOfModule(module)) {
    const alias = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
    const target = alias ? checker.getAliasedSymbol(symbol) : symbol;
    const file = target.declarations?.[0]?.getSourceFile().fileName ?? '';
    const own = posixPath(file).startsWith(`${posixPath(dist)}/`);
    // An own declaration M8 added, or react's one value re-export (M8-T2); other re-exports keep
    // their owner's declaration and comment.
    if (own ? AT_17A2B0A[name].includes(symbol.name) : !REEXPORTS[name].includes(symbol.name)) {
      continue;
    }
    // A re-export's own comment, else its declaration's.
    docs.set(symbol.name, (alias ? doc(symbol) : '') || doc(target));
  }
  return docs;
}

describe('M8-A13: every export M8 added carries TSDoc (section 9)', () => {
  for (const name of ['editor-core', 'react', 'ui'] as const) {
    it(`checks ${name}'s built entry`, () => {
      const docs = addedExports(name);
      expect([...docs.keys()].sort()).toEqual([...ADDED[name]].sort());
      const undocumented = [...docs].filter(([, text]) => text === '').map(([symbol]) => symbol);
      expect(undocumented).toEqual([]);
    });
  }
});

describe('M8-A13: the host API guide (docs/host-api.md, M8-Q14 (a))', () => {
  const guide = read('docs/host-api.md');

  it('covers the section 9 topics', () => {
    const headings = [...guide.matchAll(/^#{1,3} (.+)$/gmu)].map((match) => match[1]);
    expect(headings).toEqual([
      'Host API guide',
      'Creating an editor',
      'The provider and the canvas',
      'Hooks',
      'Commands and queries',
      'Export',
      'Rulers, guides and layout grids',
      'Events',
      'Extensions',
      'Panels',
      'The UI package',
    ]);
    const extensions = guide.slice(guide.indexOf('## Extensions'), guide.indexOf('## The UI'));
    for (const topic of [
      '**Node types**',
      '**Commands**',
      '**Tools**',
      '**Bindings**',
      '### Panels',
    ]) {
      expect(extensions, topic).toContain(topic);
    }
    for (const name of [
      'createEditor',
      'EditorProvider',
      'useEditorQuery',
      'subscribe',
      'PanelProvider',
    ]) {
      expect(guide, name).toContain(`\`${name}`);
    }
  });

  it('links the type declarations instead of copying them, and every local link resolves', () => {
    // No code block: the declarations are linked, not copied.
    expect(guide).not.toContain('```');
    const links = [...guide.matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1]!);
    const local = links.filter((link) => !/^[a-z]+:/u.test(link));
    expect(local.length).toBeGreaterThan(15);
    for (const link of local) {
      const file = link.split('#')[0]!;
      expect(existsSync(path.join(root, 'docs', file)), link).toBe(true);
    }
    for (const declarations of [
      '../packages/editor-core/src/types.ts',
      '../packages/editor-core/src/editor.ts',
      '../packages/react/src/context.tsx',
      '../packages/react/src/hooks.ts',
      '../packages/ui/src/index.ts',
      '../packages/ui/src/panel-resolve.ts',
    ]) {
      expect(local, declarations).toContain(declarations);
    }
  });

  it('has its row in the AGENTS.md documentation ownership table', () => {
    const agents = read('AGENTS.md');
    const table = agents.slice(
      agents.indexOf('## Documentation ownership'),
      agents.indexOf('## Working rules'),
    );
    expect(table).toMatch(
      /^\| `docs\/host-api\.md` +\| Host embedding: editor, provider, hooks, commands, events, extensions, UI +\| Type declarations; product behavior +\|$/mu,
    );
  });
});
