import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  createCounterIdSource,
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type Extension,
} from '@vector-studio/editor-core';
import { EditorProvider, PanelProvider, resolvePanels, type UiExtension } from '@vector-studio/ui';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  evaluatePublicImports,
  importSpecifiers,
  publicImportPolicies,
  // @ts-expect-error The repository's executable boundary policy is JavaScript tooling.
} from '../../tooling/boundary-policy.mjs';
import type * as HostModule from '../../apps/next-host/src/m6a-text-host.js';
import type * as LayoutModule from '../../apps/next-host/src/m8-layout.js';
import type * as StarModule from '../../apps/next-host/src/m8-star-panel.js';
import type * as FaultModule from '../../apps/next-host/src/m8-test-panels.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';
import * as budget from '../support/m8-n3-budget.js';

// MVP M8 contract, unit M8-U6, M8-A12 (section 8, M8-N1 to M8-N6): next-host composed from
// `@vector-studio/ui`. Source checks pin what the page defines and imports, the star panel's
// imports (the M8-B3 check), the `star` button's frame, each config's viewport, the M8-N3 budget
// call in every next-host spec and the `?bench=1` composition; the star panel's model runs
// against a real editor; the right column and the bench aside are checked as markup
// (`renderToString`, M8-Q5 (a)). The headed half is M8-A14 (tests/m8-next-host/, M8-U7).

const root = path.resolve(import.meta.dirname, '../..');
const app = path.join(root, 'apps/next-host');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const run = promisify(execFile);
const PAGE = read('apps/next-host/app/page.tsx');
const LAYOUT = read('apps/next-host/src/m8-layout.tsx');
const STAR_FILE = 'apps/next-host/src/m8-star-panel.tsx';

const star = (await import(path.join(app, 'src/m8-star-panel.tsx'))) as typeof StarModule;
const faults = (await import(path.join(app, 'src/m8-test-panels.tsx'))) as typeof FaultModule;
const layout = (await import(path.join(app, 'src/m8-layout.tsx'))) as typeof LayoutModule;
const host = (await import(path.join(app, 'src/m6a-text-host.ts'))) as typeof HostModule;

const evaluatePublic = evaluatePublicImports as (input: {
  sources: { path: string; text: string }[];
  sourceRoot: string;
  specifiers: string[];
  relative?: boolean | undefined;
}) => string[];
const specifiersOf = importSpecifiers as (text: string) => string[];
const policies = publicImportPolicies as {
  directory: string;
  files?: string[];
  specifiers: string[];
  relative?: boolean;
}[];

/** Every TypeScript source of next-host. */
function hostSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/u.test(entry.name)) out.push({ file, text: read(file) });
    }
  };
  walk('apps/next-host/app');
  walk('apps/next-host/src');
  return out;
}

function editor(extensions: readonly Extension[] = [starExtension]): Editor {
  return createEditor({ ids: createCounterIdSource('n'), extensions });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function markup(
  target: Editor,
  body: ReactNode,
  contributions: readonly UiExtension[] = [star.starUiExtension],
): string {
  return renderToString(
    createElement(EditorProvider, {
      editor: target,
      children: createElement(PanelProvider, { contributions, children: body }),
    }),
  );
}

describe('M8-N1: next-host composes the UI package', () => {
  it('defines none of the removed components or helpers and imports them from ui', () => {
    for (const { file, text } of hostSources()) {
      for (const name of [
        'Toolbar',
        'ZoomControls',
        'SymbolControls',
        'Pages',
        'AppearancePanel',
      ]) {
        expect(text, `${file} defines ${name}`).not.toMatch(
          new RegExp(`function ${name}\\b|const ${name}\\b|class ${name}\\b`, 'u'),
        );
      }
      expect(text, file).not.toMatch(/function (zoomLabel|toggleClosedCommand)\b/u);
      expect(text, file).not.toMatch(/from '[^']*m4-appearance/u);
    }
    expect(existsSync(path.join(app, 'src/m4-appearance.ts'))).toBe(false);
    expect(existsSync(path.join(app, 'src/m4-appearance-panel.tsx'))).toBe(false);
    expect(PAGE).toMatch(
      /^import \{\s+PageList,\s+PanelProvider,\s+ToolbarPrimaryRow,\s+ToolbarSecondaryRow,\s+usePanelErrors,\s+\} from '@vector-studio\/ui';/mu,
    );
    expect(LAYOUT).toMatch(
      /^import \{\s+AppearancePanel,\s+EditorPanels,\s+LayerTree,\s+PropertyPanel,\s+type UiExtension,\s+\} from '@vector-studio\/ui';/mu,
    );
    // Row 1 holds the host's star button and file controls; row 2 starts with the page list.
    expect(PAGE).toMatch(
      /<ToolbarPrimaryRow>\s+<StarButton \/>\s+<FileControls onFileStatus=\{setFile\} \/>\s+<RowHeightStrut \/>\s+<\/ToolbarPrimaryRow>\s+<div style=\{\{ display: 'flex', gap: 8 \}\}>\s+<PageList \/>\s+<ToolbarSecondaryRow \/>\s+<\/div>/u,
    );
    const manifest = JSON.parse(read('apps/next-host/package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['@vector-studio/ui']).toBe('workspace:*');
  });

  it("keeps the host star button's test ID and frame (P5 spec)", () => {
    expect(PAGE).toMatch(
      /data-testid="star"\s+onClick=\{\(\) =>\s+execute\(\{\s+type: 'runCommand',\s+id: 'ext\.star\.create',\s+args: \{ frame: \{ x: 360, y: 220, width: 160, height: 160 \} \},/u,
    );
  });

  it('keeps the strut that holds row 1 at its 17a2b0a height hidden, nameless and inert', () => {
    // A span with a wrapped button's line metrics, not a control (review follow-up 4).
    expect(PAGE).toMatch(
      /<span\s+aria-hidden\s+data-testid="row-1-strut"\s+style=\{\{\s+display: 'inline-block',\s+visibility: 'hidden',\s+width: 0,\s+overflow: 'hidden',\s+font: '-webkit-small-control',\s+lineHeight: 'normal',\s+paddingBlock: 1,\s+borderBlock: '2px solid transparent',\s+boxSizing: 'border-box',\s+\}\}\s+>\s+&nbsp;\s+<br \/>\s+&nbsp;\s+<\/span>/u,
    );
    const strut = PAGE.slice(
      PAGE.indexOf('function RowHeightStrut()'),
      PAGE.indexOf('function FileControls('),
    );
    expect(strut).not.toMatch(/<button|tabIndex|onClick/u);
  });
});

describe('M8-N2: the ext.star sample panel', () => {
  it('imports @vector-studio/ui and react only, by the M8-B3 policy check:boundaries runs', () => {
    const text = read(STAR_FILE);
    expect(specifiersOf(text)).toEqual(['@vector-studio/ui', 'react']);
    const policy = policies.find((entry) => entry.directory === 'apps/next-host/src')!;
    expect(policy).toEqual({
      directory: 'apps/next-host/src',
      files: ['m8-star-panel.tsx'],
      specifiers: ['react', 'react/jsx-runtime', '@vector-studio/ui'],
      relative: false,
    });
    const sourceRoot = path.join(root, policy.directory);
    const check = (body: string) =>
      evaluatePublic({
        sources: [{ path: path.join(root, STAR_FILE), text: body }],
        sourceRoot,
        specifiers: policy.specifiers,
        relative: policy.relative,
      });
    expect(check(text)).toEqual([]);
    // Negative fixtures: each fails with its asserted error.
    const shown = path.join(root, STAR_FILE);
    expect(check(`import { useEditor } from '@vector-studio/react';\n${text}`)).toEqual([
      `${shown}: import @vector-studio/react is not a public import`,
    ]);
    expect(check(`import { createEditor } from '@vector-studio/editor-core';\n${text}`)).toEqual([
      `${shown}: import @vector-studio/editor-core is not a public import`,
    ]);
    expect(check(`import { CanvasSide } from './m8-layout';\n${text}`)).toEqual([
      `${shown}: relative import ./m8-layout is not allowed`,
    ]);
    expect(check(`import x from '@vector-studio/ui/dist/index.js';\n${text}`)).toEqual([
      `${shown}: import @vector-studio/ui/dist/index.js is not a public import`,
    ]);
  });

  it('builds ext.star.create through the typed builder, equal to the hand-written command', () => {
    expect(star.CREATE_STAR.id).toBe('ext.star.create');
    const frame = { ...star.PANEL_STAR_FRAME };
    expect(star.CREATE_STAR.command({ frame })).toEqual({
      type: 'runCommand',
      id: 'ext.star.create',
      args: { frame: { x: 120, y: 120, width: 120, height: 120 } },
    });
    const target = editor();
    const [id] = ok(target, star.CREATE_STAR.command({ frame }));
    expect(star.starData(target.query({ type: 'node', id: id! }))).toEqual({
      points: 5,
      innerRatio: 0.5,
    });
    expect(target.getSnapshot().history).toEqual({ undoDepth: 1, redoDepth: 0 });
  });

  it('edits points and inner ratio with one setNodeProps data, one undo step each', () => {
    const target = editor();
    const [id] = ok(target, star.CREATE_STAR.command({ frame: { ...star.PANEL_STAR_FRAME } }));
    const data = star.starData(target.query({ type: 'node', id: id! }))!;
    const points = star.starFieldEdit(id!, data, 'points', ' 7 ');
    expect(points).toEqual({
      invalid: false,
      command: { type: 'setNodeProps', id, props: { data: { points: 7, innerRatio: 0.5 } } },
    });
    ok(target, points.command!);
    const after = star.starData(target.query({ type: 'node', id: id! }))!;
    expect(after).toEqual({ points: 7, innerRatio: 0.5 });
    const ratio = star.starFieldEdit(id!, after, 'innerRatio', '0.25');
    expect(ratio.command).toEqual({
      type: 'setNodeProps',
      id,
      props: { data: { points: 7, innerRatio: 0.25 } },
    });
    ok(target, ratio.command!);
    expect(target.getSnapshot().history).toEqual({ undoDepth: 3, redoDepth: 0 });
    ok(target, { type: 'undo' });
    expect(star.starData(target.query({ type: 'node', id: id! }))).toEqual(after);
    // Unchanged text sends nothing; text the extension would refuse is invalid.
    expect(star.starFieldEdit(id!, after, 'points', '7')).toEqual({
      invalid: false,
      command: null,
    });
    for (const text of ['2', '33', '3.5', '', 'five']) {
      expect(star.starFieldEdit(id!, after, 'points', text), text).toEqual({
        invalid: true,
        command: null,
      });
    }
    for (const text of ['0', '1', '-0.1', 'NaN']) {
      expect(star.starFieldEdit(id!, after, 'innerRatio', text), text).toEqual({
        invalid: true,
        command: null,
      });
    }
    // The bounds the panel accepts are the extension's: 3 and 32 points pass.
    for (const text of ['3', '32']) {
      ok(target, star.starFieldEdit(id!, after, 'points', text).command!);
    }
    expect(star.starData(target.query({ type: 'node', id: 'n1' }))).toBeNull();
    expect(star.starData(null)).toBeNull();
  });

  it('shows the fields for exactly one selected star (markup)', () => {
    const target = editor();
    const Panel = star.StarPanel as ComponentType;
    const none = markup(target, createElement(Panel));
    expect(none).toContain('>Create star</button>');
    expect(none).toContain('select one star');
    expect(none).not.toContain('aria-label="Points"');
    const [a] = ok(target, star.CREATE_STAR.command({ frame: { ...star.PANEL_STAR_FRAME } }));
    const [b] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    ok(target, { type: 'setSelection', ids: [a!] });
    const one = markup(target, createElement(Panel));
    expect(one).toMatch(
      /<input type="text" aria-label="Points" aria-invalid="false" size="6" value="5"\/>/u,
    );
    expect(one).toMatch(
      /<input type="text" aria-label="Inner ratio" aria-invalid="false" size="6" value="0.5"\/>/u,
    );
    ok(target, { type: 'setSelection', ids: [a!, b!] });
    expect(markup(target, createElement(Panel))).toContain('select one star');
    ok(target, { type: 'setSelection', ids: [b!] });
    expect(markup(target, createElement(Panel))).toContain('select one star');
  });
});

describe('M8-N2: the ?test=1&faults=1 fault panels', () => {
  it('registers them only with ?test=1&faults=1; plain ?test=1 keeps the star panel alone', () => {
    expect(faults.faultPanelsQuery('?test=1&faults=1')).toBe(true);
    expect(faults.faultPanelsQuery('?faults=1&test=1&fixture=text')).toBe(true);
    for (const search of ['?test=1', '?faults=1', '?test=1&faults=0', '', '?bench=1&faults=1']) {
      expect(faults.faultPanelsQuery(search), search).toBe(false);
    }
    expect(layout.hostContributions('?test=1', false)).toEqual([star.starUiExtension]);
    expect(layout.hostContributions('?test=1&faults=1', false)).toEqual([
      star.starUiExtension,
      faults.testUiPanels,
    ]);
    expect(layout.hostContributions('?test=1&faults=1', true)).toEqual([]);
    // The page registers the `test.ui` editor extension under the same query only.
    expect(PAGE).toMatch(
      /extraExtensions: faultPanelsQuery\(window\.location\.search\) \? \[testUiExtension\] : \[\],/u,
    );
    expect(PAGE).toMatch(
      /const contributions = useMemo\(\s+\(\) => hostContributions\(window\.location\.search, pageBench\(\) !== null\),\s+\[\],\s+\);/u,
    );
  });

  it('composes the editor with test.ui after ext.star only when asked', () => {
    const fake = () => {
      const port = createFakeTextLayout();
      return {
        portVersion: 0,
        get generation() {
          return port.generation;
        },
        layout: (request: Parameters<typeof port.layout>[0]) => port.layout(request),
        subscribe: (listener: Parameters<typeof port.subscribe>[0]) => port.subscribe(listener),
        registerFont: () => Promise.resolve('loaded' as const),
        dispose: () => {},
        fallbacks: 0,
      } as unknown as ReturnType<
        NonNullable<Parameters<typeof host.composeHost>[0]['createTextDom']>
      >;
    };
    const document = { nodeType: 9 } as unknown as Document;
    const ids = (extraExtensions?: readonly Extension[]) =>
      host
        .composeHost({
          document,
          platform: 'other',
          createTextDom: fake,
          ...(extraExtensions === undefined ? {} : { extraExtensions }),
        })
        .editor.query({ type: 'extensions' })
        .map((entry) => entry.id);
    expect(ids()).toEqual(['ext.star']);
    expect(ids([])).toEqual(['ext.star']);
    expect(ids([faults.testUiExtension])).toEqual(['ext.star', 'test.ui']);
  });

  it('accepts the throwing panel and rejects the unowned one with ui.unowned-panel', () => {
    const contributions = layout.hostContributions('?test=1&faults=1', false);
    const withTest = editor([starExtension, faults.testUiExtension]).query({ type: 'extensions' });
    const resolution = resolvePanels(contributions, withTest);
    expect(resolution.panels.map((entry) => entry.panel.id)).toEqual([
      'ext.star',
      'test.ui.throws',
    ]);
    expect(resolution.errors).toEqual([{ code: 'ui.unowned-panel', panel: 'other.unowned' }]);
    // Plain `?test=1`: no panel error at all.
    const plain = resolvePanels(
      layout.hostContributions('?test=1', false),
      editor().query({ type: 'extensions' }),
    );
    expect(plain.errors).toEqual([]);
    expect(renderToString(createElement(faults.ThrowingPanel))).toBe(
      '<button type="button">Throw</button>',
    );
  });

  it('shows panel errors in the status under panel-error, never error', () => {
    expect(PAGE).toMatch(/const panelErrors = usePanelErrors\(\);/u);
    expect(PAGE).toMatch(
      /\{panelErrors\.map\(\(error\) => \(\s+<span\s+key=\{`\$\{error\.code\} \$\{error\.panel\}`\}\s+data-testid="panel-error"\s+data-code=\{error\.code\}\s+data-panel=\{error\.panel\}/u,
    );
    // `error` stays the host's own errors only.
    expect(PAGE.match(/data-testid="error"/gu)).toHaveLength(1);
    expect(PAGE).toMatch(
      /\{errors\.map\(\(error\) => \(\s+<span key=\{error\} data-testid="error"/u,
    );
  });
});

describe('M8-N3 and M8-N5: the right column and the bench aside', () => {
  it('builds the right column: LayerTree, Appearance, the other sections, then extension panels', () => {
    const target = editor();
    const [id] = ok(target, star.CREATE_STAR.command({ frame: { ...star.PANEL_STAR_FRAME } }));
    ok(target, { type: 'setSelection', ids: [id!] });
    const html = markup(target, createElement(layout.CanvasSide, { bench: false, height: 640 }));
    expect(html).toMatch(
      /^<div data-testid="right-column" style="width:300px;flex-shrink:1;min-width:0;height:640px;overflow-y:auto;box-sizing:border-box">/u,
    );
    const at = (needle: string) => {
      const index = html.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const order = [
      at('data-testid="layers"'),
      at('<aside aria-label="Appearance" data-testid="appearance-panel" style="font-size:13px">'),
      at('aria-label="X"'),
      at('data-panel="ext.star"'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The layer tree keeps its fixed 240 px; the Appearance section has no size or scroller.
    expect(html).toContain(
      'data-testid="layers" style="display:flex;flex-direction:column;height:240px',
    );
    expect(html).not.toContain('max-height:640px');
    expect(layout.ASIDE_BASIS).toBe(300);
  });

  it('with ?bench=1 keeps the 17a2b0a aside and mounts none of the M8 sections or panels', () => {
    const target = editor();
    const [id] = ok(target, star.CREATE_STAR.command({ frame: { ...star.PANEL_STAR_FRAME } }));
    ok(target, { type: 'setSelection', ids: [id!] });
    const html = markup(target, createElement(layout.CanvasSide, { bench: true, height: 720 }), []);
    expect(html).toMatch(
      /^<aside aria-label="Appearance" data-testid="appearance-panel" style="width:300px;max-height:640px;overflow-y:auto;font-size:13px">/u,
    );
    for (const absent of [
      'right-column',
      'data-testid="layers"',
      'data-testid="property-panel"',
      'aria-label="X"',
      'data-panel=',
    ]) {
      expect(html, absent).not.toContain(absent);
    }
    expect(LAYOUT).toMatch(/if \(bench\) return <AppearancePanel \/>;/u);
    expect(PAGE).toMatch(/<CanvasSide bench=\{bench !== null\} height=\{height\} \/>/u);
  });
});

describe('M8-N3: every next-host config states its viewport and every spec checks the budget', () => {
  it('gives each project the viewport it states', async () => {
    const { stdout } = await run(process.execPath, ['tooling/m8-n3-configs.mjs', '--root', root], {
      cwd: root,
    });
    const rows = JSON.parse(stdout) as {
      config: string;
      project: string;
      viewport: { width: number; height: number };
    }[];
    // M8-U7: the M8 config runs each browser at both viewports, named by height.
    const m8Projects = [
      'chrome-720',
      'chrome-900',
      'edge-720',
      'edge-900',
      'smoke-720',
      'smoke-900',
    ];
    const expected = (config: string, project: string) =>
      config === 'playwright.e26.config.ts'
        ? { width: 1400, height: 1000 }
        : config === 'playwright.m8-next-host.config.ts'
          ? { width: 1280, height: project.endsWith('-720') ? 720 : 900 }
          : /p5-next-host|m1-next-host/u.test(config)
            ? { width: 1280, height: 720 }
            : { width: 1280, height: 900 };
    const configs = new Set(rows.map((row) => row.config));
    expect([...configs]).toEqual([
      'playwright.e26.config.ts',
      'playwright.m1-next-host.config.ts',
      'playwright.m2-next-host.config.ts',
      'playwright.m3-next-host.config.ts',
      'playwright.m4-next-host.config.ts',
      'playwright.m5-next-host.config.ts',
      'playwright.m6a-next-host.config.ts',
      'playwright.m6b-next-host.config.ts',
      'playwright.m6c-next-host.config.ts',
      'playwright.m6c-observe.config.ts',
      'playwright.m6c-u0-zoom.config.ts',
      'playwright.m7-next-host.config.ts',
      'playwright.m8-next-host.config.ts',
      'playwright.p5-next-host.config.ts',
    ]);
    for (const row of rows)
      expect(row.viewport, `${row.config} ${row.project}`).toEqual(
        expected(row.config, row.project),
      );
    expect(
      rows
        .filter((row) => row.config === 'playwright.m8-next-host.config.ts')
        .map((row) => row.project),
    ).toEqual(m8Projects);
    // Each M8 project states its viewport.
    const m8 = read('playwright.m8-next-host.config.ts');
    expect(m8.match(/^\s+viewport: small,$/gmu)).toHaveLength(3);
    expect(m8.match(/^\s+viewport: large,$/gmu)).toHaveLength(3);
    // P5 and M1 state the 1280 × 720 the device presets gave them, in each project.
    for (const file of ['playwright.p5-next-host.config.ts', 'playwright.m1-next-host.config.ts']) {
      const text = read(file);
      expect(text).toContain('const viewport = { width: 1280, height: 720 };');
      expect(text.match(/^\s+viewport,$/gmu)).toHaveLength(3);
      expect(text).not.toMatch(/viewport: \{ width: 1100/u);
    }
  });

  it('calls expectLayoutBudget in the open function of every next-host spec', () => {
    const directories = [
      'p5-next-host',
      'm1-next-host',
      'm2-next-host',
      'm3-next-host',
      'm4-next-host',
      'm5-next-host',
      'm6a-next-host',
      'm6b-next-host',
      'm6c-next-host',
      'm7-next-host',
      'm8-next-host',
      'm6c-u0-zoom',
      'e26',
    ];
    let specs = 0;
    for (const directory of directories) {
      for (const name of readdirSync(path.join(root, 'tests', directory))) {
        if (!name.endsWith('.spec.ts')) continue;
        const text = read(`tests/${directory}/${name}`);
        if (!text.includes('page.goto(')) continue;
        specs += 1;
        expect(text, name).toContain(
          "import { expectLayoutBudget } from '../support/m8-n3-budget.js';",
        );
        const open = text.slice(text.indexOf('async function open('));
        const body = open.slice(0, open.indexOf('\n}\n'));
        expect(body, name).toMatch(
          directory === 'e26'
            ? /await expectLayoutBudget\(page, \{ bench: true \}\);/u
            : /await expectLayoutBudget\(page\);/u,
        );
      }
    }
    expect(specs).toBe(17);
    // The helper checks the origin, the document size, both rows, row 2's height, the right
    // column's width, height and fit, and the horizontal scroll.
    const helper = read('tests/support/m8-n3-budget.ts');
    for (const label of [
      'canvas origin',
      'scrollWidth',
      'scrollHeight',
      'horizontal scroll',
      'row 1 width',
      'row 2 width',
      'the page list on the left of row 2',
      'row 2 height',
      'canvas row height',
      'right column width',
      'right column height',
      'right column scrolls',
      'column fits',
      'row 2 height while renaming',
      'aside width',
    ]) {
      expect(helper, label).toContain(`: ${label}\``);
    }
  });
});

describe('M8-N3: the 17a2b0a baselines, per project, channel and mode', () => {
  type Row = Parameters<typeof budget.selectBaseline>[0][number];
  const fixture = JSON.parse(read('tests/fixtures/m8-n3/17a2b0a-headless.json')) as {
    commit: string;
    results: Row[];
  };
  const reader = (row: Partial<Parameters<typeof budget.selectBaseline>[1]>) => ({
    config: 'playwright.m2-next-host.config.ts',
    project: 'chromium-smoke',
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    channel: null,
    headless: true,
    ...row,
  });
  const headed = (channel: string, config: string, project: string, height: number): Row => ({
    ...fixture.results.find((row) => row.config === config)!,
    config,
    project,
    channel,
    headless: false,
    viewport: { width: 1280, height },
  });

  it('commits one headless row per headless project, measured headless in the bundled Chromium', async () => {
    const { stdout } = await run(process.execPath, ['tooling/m8-n3-configs.mjs', '--root', root], {
      cwd: root,
    });
    const projects = (
      JSON.parse(stdout) as { config: string; project: string; headless: boolean }[]
    )
      // A config new since 17a2b0a has no row of its own: it reads its BASELINE_SOURCES rows.
      .filter((row) => row.headless && !Object.hasOwn(budget.BASELINE_SOURCES, row.config))
      .map((row) => `${row.config} ${row.project}`);
    expect(fixture.commit).toBe('17a2b0a');
    expect(fixture.results.map((row) => `${row.config} ${row.project}`)).toEqual(projects);
    for (const row of fixture.results) {
      expect([row.channel, row.headless], row.project).toEqual([null, true]);
      // One measure for the aside and the column: the border box (review follow-up 3).
      expect(row.aside, row.config).toBe(row.config === 'playwright.e26.config.ts' ? 112 : 300);
    }
  });

  it("takes a row only in the reading project's channel and mode, and fails loudly otherwise", () => {
    const rows = [
      ...fixture.results,
      headed('chrome', 'playwright.m2-next-host.config.ts', 'chrome', 900),
      headed('msedge', 'playwright.m2-next-host.config.ts', 'edge', 900),
      headed('chrome', 'playwright.m1-next-host.config.ts', 'chrome', 720),
    ];
    expect(budget.selectBaseline(rows, reader({}), 'f').project).toBe('chromium-smoke');
    expect(
      budget.selectBaseline(
        rows,
        reader({ project: 'edge', channel: 'msedge', headless: false }),
        'f',
      ).channel,
    ).toBe('msedge');
    // An Edge project never reads a Chrome row, nor a headed project a headless one.
    const chromeOnly = rows.filter((row) => row.channel !== 'msedge');
    const edgeAsChrome = chromeOnly.map((row) =>
      row.project === 'chrome' && row.config === 'playwright.m2-next-host.config.ts'
        ? { ...row, project: 'edge' }
        : row,
    );
    expect(() =>
      budget.selectBaseline(
        edgeAsChrome,
        reader({ project: 'edge', channel: 'msedge', headless: false }),
        'f',
      ),
    ).toThrow(
      'M8-N3: f measured playwright.m2-next-host.config.ts edge in chrome headed, not in msedge headed',
    );
    expect(() =>
      budget.selectBaseline(
        chromeOnly,
        reader({ project: 'edge', channel: 'msedge', headless: false }),
        'f',
      ),
    ).toThrow('M8-N3: f has no row for playwright.m2-next-host.config.ts edge');
    expect(() => budget.selectBaseline(rows, reader({ headless: false }), 'f')).toThrow(
      'not in chromium headed',
    );
  });

  it('maps the new M8 config to the 17a2b0a rows of M1 (1280 × 720) and M2 (1280 × 900)', () => {
    expect(budget.BASELINE_SOURCES).toEqual({
      'playwright.m8-next-host.config.ts': {
        '1280x720': 'playwright.m1-next-host.config.ts',
        '1280x900': 'playwright.m2-next-host.config.ts',
      },
    });
    const rows = [
      ...fixture.results,
      headed('chrome', 'playwright.m2-next-host.config.ts', 'chrome', 900),
      headed('msedge', 'playwright.m2-next-host.config.ts', 'edge', 900),
      headed('chrome', 'playwright.m1-next-host.config.ts', 'chrome', 720),
      headed('msedge', 'playwright.m1-next-host.config.ts', 'edge', 720),
    ];
    const m8 = (row: Partial<Parameters<typeof budget.selectBaseline>[1]>) =>
      budget.selectBaseline(
        rows,
        reader({ config: 'playwright.m8-next-host.config.ts', ...row }),
        'f',
      );
    const pick = (row: Row) => [row.config, row.project];
    expect(pick(m8({ project: 'chrome-900', channel: 'chrome', headless: false }))).toEqual([
      'playwright.m2-next-host.config.ts',
      'chrome',
    ]);
    expect(
      pick(
        m8({
          project: 'edge-720',
          channel: 'msedge',
          headless: false,
          viewport: { width: 1280, height: 720 },
        }),
      ),
    ).toEqual(['playwright.m1-next-host.config.ts', 'edge']);
    expect(pick(m8({ project: 'smoke-720', viewport: { width: 1280, height: 720 } }))).toEqual([
      'playwright.m1-next-host.config.ts',
      'chromium-swiftshader',
    ]);
    expect(() => m8({ viewport: { width: 1400, height: 1000 } })).toThrow(
      'M8-N3: no 17a2b0a config stands in for playwright.m8-next-host.config.ts chromium-smoke at 1400x1000',
    );
    expect(() => m8({ deviceScaleFactor: 2 })).toThrow(
      'has 0 rows of playwright.m2-next-host.config.ts',
    );
  });
});

describe('M8-N6: the source checks M8-U6 updated', () => {
  it('drops next-host/src/m4-appearance.ts from the root project', () => {
    expect(read('tsconfig.json')).not.toContain('m4-appearance');
    expect(read('apps/next-host/tsconfig.json')).toContain('"path": "../../packages/ui"');
  });
});
