// MVP M9-U1 (M9 contract, section 4, M9-A03): the bench flags M9 adds are inert without
// `?bench=1`: `ui=1` (the right column instead of the Appearance aside), `doc=m9-v2` (the v2
// document), the test-font registration with the test family as fallback, the font-load change
// and the typing seam. With `?bench=1&ui=1` the canvas keeps the bench size and the page source
// places it exactly as without `ui=1`. The headless smoke half is the harness's `m9-ui-geometry`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createCounterIdSource, createEditor, starExtension } from '@vector-studio/editor-core';
import { EditorProvider, PanelProvider } from '@vector-studio/ui';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as LayoutModule from '../../apps/next-host/src/m8-layout.js';
import type * as StarModule from '../../apps/next-host/src/m8-star-panel.js';

const root = path.resolve(import.meta.dirname, '../..');
const app = path.join(root, 'apps/next-host');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const PAGE = read('apps/next-host/app/page.tsx');
const ROUTE = read('apps/next-host/app/e26-bench-doc.json/route.ts');
type Query = Readonly<{ doc: string | null; ui: boolean }> & Record<string, unknown>;
type Latency = { inputMs: number; revision: number; doneMs: number | null; failed?: true };
/**
 * The module's surface this test uses, declared apart as e26-u1b does: the host's own types
 * declare `window.__e26Bench`, which the harness declares too.
 */
type BenchModule = {
  pageBench(): unknown;
  benchQuery(search: string): Query | null;
  benchAside(query: Query | null): boolean;
  benchTextFont(search: string): boolean;
  benchTextDomOptions(search: string): { fallbackFamilies?: readonly string[] };
  benchComposition(search: string): { createTextDom?: unknown };
  BENCH_CANVAS: Readonly<{ width: number; height: number }>;
  Bench: new (query: Query) => {
    readonly clock: { request(callback: (timestampMs: number) => void): number };
    wrapRenderer(renderer: never): unknown;
    attach(backend: unknown, canvas: never): void;
    setEditor(editor: never): void;
    setFontPort(
      port: {
        register(family: string): Promise<string>;
        generation(): number;
        subscribe(listener: () => void): () => void;
      } | null,
    ): void;
    hook(): {
      registerTestFont(family: string): Promise<string>;
      fontLoads: readonly {
        family: string;
        startMs: number;
        settledMs: number | null;
        endMs: number | null;
        status: string | null;
        generationBefore: number;
        generationAfter: number | null;
        bumps: number;
        lastBumpMs: number | null;
        revisionBefore: number;
        revisionAfter: number | null;
      }[];
      enterTextEdit(id: string, offset: number): { ok: boolean; code?: string };
      keyLatencies: readonly Latency[];
      noChangeKeys: readonly number[];
    };
    dispose(): void;
  };
};
const bench = (await import(path.join(app, 'src/e26-bench.ts'))) as BenchModule;
const layout = (await import(path.join(app, 'src/m8-layout.tsx'))) as typeof LayoutModule;
const star = (await import(path.join(app, 'src/m8-star-panel.tsx'))) as typeof StarModule;

type Listener = (event: unknown) => void;

/** A window with a location and listeners (capture and bubble kept apart), enough for the bench. */
function stubWindow(search: string) {
  const listeners = new Map<string, Listener[]>();
  const key = (type: string, options?: { capture?: boolean }) =>
    `${type}${options?.capture === true ? ':capture' : ''}`;
  vi.stubGlobal('window', {
    location: { search },
    addEventListener: (type: string, listener: Listener, options?: { capture?: boolean }) =>
      listeners.set(key(type, options), [...(listeners.get(key(type, options)) ?? []), listener]),
    removeEventListener: (type: string, listener: Listener, options?: { capture?: boolean }) =>
      listeners.set(
        key(type, options),
        (listeners.get(key(type, options)) ?? []).filter((entry) => entry !== listener),
      ),
  });
  // `target` runs between the capture and the bubbling listeners, as the page's handler does.
  return (type: string, event: unknown, target: () => void = () => {}) => {
    for (const listener of listeners.get(`${type}:capture`) ?? []) listener(event);
    target();
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  performance.clearMarks();
  performance.clearMeasures();
});

/** A renderer whose revision the test sets. */
function renderer() {
  let revision = 1;
  return {
    set: (value: number) => {
      revision = value;
    },
    getSynchronizationState: () => ({
      current: { identity: { documentId: 'd', pageId: 'p' }, revision },
    }),
  };
}

describe('M9-A03: the M9 bench flags are inert without ?bench=1', () => {
  it('installs the V20-U1 render probe only with ?bench=1', () => {
    const probe = () => (globalThis as { __vsRenderProbe?: unknown }).__vsRenderProbe;
    expect(probe()).toBeUndefined();
    stubWindow('?ui=1&doc=m9-v2');
    expect(bench.pageBench()).toBeNull();
    expect(probe()).toBeUndefined();
    stubWindow('?bench=1&ui=1');
    expect(bench.pageBench()).not.toBeNull();
    expect(typeof probe()).toBe('function');
    delete (globalThis as { __vsRenderProbe?: unknown }).__vsRenderProbe;
  });

  it('parses ui=1 and doc=m9-v2 only with ?bench=1', () => {
    for (const search of ['?ui=1', '?doc=m9-v2', '?ui=1&doc=m9-v2&persist=1', '?bench=0&ui=1']) {
      expect(bench.benchQuery(search), search).toBeNull();
      expect(bench.benchTextFont(search), search).toBe(false);
      expect(bench.benchTextDomOptions(search), search).toEqual({});
      expect(bench.benchComposition(search), search).toEqual({});
    }
    expect(bench.benchQuery('?bench=1&ui=1&doc=m9-v2')).toEqual({
      doc: 'm9-v2',
      persist: false,
      reject: null,
      rejectMode: 'once',
      isolation: false,
      ui: true,
    });
    expect(bench.benchQuery('?bench=1')).toMatchObject({ ui: false, doc: null });
    expect(bench.benchQuery('?bench=1&ui=0')).toMatchObject({ ui: false });
    expect(bench.benchQuery('?bench=1&doc=m9-v3')).toMatchObject({ doc: null });
    // The route serves the v2 document by name and nothing else new.
    expect(ROUTE).toContain("const DOCUMENTS = new Set(['m1-a13', 'stress', 'm9-v2']);");
  });

  it('registers the test font and lists it as the fallback only for ?bench=1&doc=m9-v2', () => {
    expect(bench.benchTextFont('?bench=1&doc=m9-v2')).toBe(true);
    expect(bench.benchTextFont('?bench=1&doc=m1-a13')).toBe(false);
    expect(bench.benchTextFont('?bench=1&ui=1')).toBe(false);
    expect(bench.benchTextDomOptions('?bench=1&doc=m9-v2')).toEqual({
      fallbackFamilies: ['Noto Sans KR'],
    });
    expect(bench.benchTextDomOptions('?bench=1&doc=stress')).toEqual({});
    expect(typeof bench.benchComposition('?bench=1&doc=m9-v2').createTextDom).toBe('function');
    // The page: the registration is the fixture's or the bench's; the factory only when asked.
    expect(PAGE).toMatch(
      /textFixture:\s+textFixtureQuery\(window\.location\.search\) \|\| benchTextFont\(window\.location\.search\),/u,
    );
    expect(PAGE).toContain('...benchComposition(window.location.search),');
    // The bench load waits for the font only for the v2 document, and fails unless it loaded.
    expect(PAGE).toContain("const font = testFont === null ? 'none' : await testFont;");
    expect(PAGE).toContain(
      "if (font !== 'loaded') throw new Error(`m9-v2: the test font did not load (${font})`);",
    );
  });

  it('mounts the Appearance aside under ?bench=1 and the right column under ?bench=1&ui=1', () => {
    expect(bench.benchAside(null)).toBe(false);
    expect(bench.benchAside(bench.benchQuery('?bench=1'))).toBe(true);
    expect(bench.benchAside(bench.benchQuery('?bench=1&ui=1'))).toBe(false);
    expect(bench.benchAside(bench.benchQuery('?ui=1'))).toBe(false);
    const markup = (search: string) => {
      const target = createEditor({ ids: createCounterIdSource('n'), extensions: [starExtension] });
      const query = bench.benchQuery(search);
      const contributions = layout.hostContributions(search, bench.benchAside(query));
      return renderToString(
        createElement(EditorProvider, {
          editor: target,
          children: createElement(PanelProvider, {
            contributions,
            children: createElement(layout.CanvasSide, {
              bench: bench.benchAside(query),
              height: bench.BENCH_CANVAS.height,
            }),
          }),
        }),
      );
    };
    const aside = markup('?bench=1');
    expect(aside).toMatch(/^<aside aria-label="Appearance" data-testid="appearance-panel"/u);
    expect(aside).not.toContain('right-column');
    const column = markup('?bench=1&ui=1');
    expect(column).toMatch(
      /^<div data-testid="right-column" style="width:300px;flex-shrink:1;min-width:0;height:720px;overflow-y:auto;box-sizing:border-box">/u,
    );
    for (const part of ['data-testid="layers"', 'data-testid="property-panel"']) {
      expect(column).toContain(part);
    }
    // ui=1 mounts the column as next-host ships it, the ext.star panel included.
    expect(layout.hostContributions('?bench=1&ui=1', false)).toEqual([star.starUiExtension]);
    expect(layout.hostContributions('?bench=1', true)).toEqual([]);
    // The page: the side follows benchAside; the canvas size and the row before it follow
    // `?bench=1` alone, so ui=1 changes neither the canvas size nor its origin.
    expect(PAGE).toContain(
      '<CanvasSide bench={benchAside(bench?.query ?? null)} height={height} />',
    );
    expect(PAGE).toContain('const width = bench === null ? WIDTH : BENCH_CANVAS.width;');
    expect(PAGE).toContain('const height = bench === null ? HEIGHT : BENCH_CANVAS.height;');
    expect(PAGE).toContain(
      '() => hostContributions(window.location.search, benchAside(pageBench()?.query ?? null)),',
    );
    // The canvas is the row's first child, so the side column cannot move it.
    const row = PAGE.slice(PAGE.indexOf('data-testid="canvas-host"') - 200);
    expect(row.indexOf('data-testid="canvas-host"')).toBeLessThan(row.indexOf('<CanvasSide'));
    expect(bench.BENCH_CANVAS).toEqual({ width: 1280, height: 720 });
  });
});

describe('M9-U1 bench seams', () => {
  it('runs the font-load change through the page registrar, marked m9-font-load', async () => {
    stubWindow('?bench=1&doc=m9-v2');
    const state = new bench.Bench(bench.benchQuery('?bench=1&doc=m9-v2')!);
    const hook = state.hook();
    expect(await hook.registerTestFont('M9 Font Load')).toBe('unavailable');
    expect(hook.fontLoads).toEqual([]);
    const families: string[] = [];
    let settle: (status: string) => void = () => {};
    let generation = 4;
    const listeners = new Set<() => void>();
    const bump = (): void => {
      generation += 1;
      for (const listener of listeners) listener();
    };
    state.setFontPort({
      register: (family) => {
        families.push(family);
        return new Promise((resolve) => (settle = resolve));
      },
      generation: () => generation,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const pending = hook.registerTestFont('M9 Font Load');
    expect(families).toEqual(['M9 Font Load']);
    expect(hook.fontLoads).toHaveLength(1);
    expect(hook.fontLoads[0]).toMatchObject({
      family: 'M9 Font Load',
      endMs: null,
      status: null,
      generationBefore: 4,
      generationAfter: null,
      revisionBefore: 0,
    });
    expect(performance.getEntriesByName('m9-font-load', 'mark')).toHaveLength(1);
    // The port bumps after the registration resolves (document.fonts events): the measure waits
    // for the bumps to stop, so it does not end at the registration.
    settle('loaded');
    await new Promise((resolve) => setTimeout(resolve, 0));
    bump();
    await new Promise((resolve) => setTimeout(resolve, 20));
    bump();
    expect(performance.getEntriesByName('m9-font-load', 'measure')).toHaveLength(0);
    expect(await pending).toBe('loaded');
    const load = hook.fontLoads[0]!;
    expect(load.status).toBe('loaded');
    expect(load.bumps).toBe(2);
    expect(load.generationAfter).toBe(6);
    expect(load.revisionAfter).toBe(0);
    expect(load.settledMs).toBeGreaterThanOrEqual(load.startMs);
    expect(load.endMs).toBeGreaterThanOrEqual(load.lastBumpMs!);
    expect(listeners.size).toBe(0);
    expect(performance.getEntriesByName('m9-font-load', 'measure')).toHaveLength(1);
    state.dispose();
  });

  it('enters text edit with anchor and focus at the offset', () => {
    stubWindow('?bench=1');
    const state = new bench.Bench(bench.benchQuery('?bench=1')!);
    const hook = state.hook();
    expect(hook.enterTextEdit('t', 60)).toEqual({ ok: false, code: 'bench.no-editor' });
    const commands: unknown[] = [];
    state.setEditor({
      execute: (command: unknown) => {
        commands.push(command);
        return { ok: true, ids: [] };
      },
    } as never);
    expect(hook.enterTextEdit('t', 60)).toEqual({ ok: true });
    expect(commands).toEqual([{ type: 'enterTextEdit', id: 't', anchor: 60, focus: 60 }]);
    state.dispose();
  });

  it('ends each key at the first submitted work at or after the revision it produced', async () => {
    const dispatch = stubWindow('?bench=1');
    const frames: ((timestampMs: number) => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: (timestampMs: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    const state = new bench.Bench(bench.benchQuery('?bench=1')!);
    const scene = renderer();
    state.wrapRenderer(scene as never);
    let submitted = 0;
    let settle: () => void = () => {};
    state.attach(
      {
        setMode: () => {},
        startFrameMeasurements: () => {},
        stopFrameMeasurements: () => null,
        getFrameMeasurements: () => null,
        getStatistics: () => ({ framesSubmitted: submitted }),
        waitForSubmittedWork: () => new Promise<void>((resolve) => (settle = resolve)),
      },
      {} as never,
    );
    const hook = state.hook();
    // A typed character: applied on beforeinput.
    dispatch('keydown', { timeStamp: 100 });
    dispatch('beforeinput', {}, () => scene.set(2));
    dispatch('input', {});
    dispatch('keyup', {});
    // A key that changes nothing (its keyup after the next keydown), then one applied on keydown.
    dispatch('keydown', { timeStamp: 200 });
    dispatch('keydown', { timeStamp: 300 }, () => scene.set(3));
    dispatch('keyup', {});
    dispatch('keyup', {});
    expect(hook.keyLatencies).toEqual([
      { inputMs: 100, revision: 2, doneMs: null },
      { inputMs: 300, revision: 3, doneMs: null },
    ]);
    expect(hook.noChangeKeys).toEqual([200]);
    state.clock.request(() => {
      submitted += 1;
    });
    frames.shift()!(400);
    expect(hook.keyLatencies.map((entry) => entry.doneMs)).toEqual([Number.NaN, Number.NaN]);
    settle();
    await Promise.resolve();
    await Promise.resolve();
    for (const entry of hook.keyLatencies) expect(entry.doneMs).toBeGreaterThan(0);
    state.dispose();
  });
});
