import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Editor, EditorEvent } from '@vector-studio/editor-core';
import type { TextDom, TextDomFont, TextDomOptions } from '@vector-studio/text-dom';
import { createTextDom } from '@vector-studio/text-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FontRouteModule from '../../apps/next-host/app/m6a-test-font.otf/route.js';
import type * as TextRouteModule from '../../apps/next-host/app/m6a-text.json/route.js';
import type * as HostModule from '../../apps/next-host/src/m6a-text-host.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// MVP M6a-U5 (M6a contract, section 5, M6a-Q13 (a)): the next-host text composition in Node. The
// editor and its text-dom port are created together and disposed together (the client effect's
// body, run as strict mode runs it: effect, cleanup, effect); `?fixture=text` registers the
// committed test font from its route and the fixture route serves the committed text fixture;
// the test hook's `text` member. The committed font is checked against the provenance in the
// contract's U5 notes (hash, size, version, coverage of the fixture's text). The headed half
// (A11, A12) is M6a-U6's.

const root = path.resolve(import.meta.dirname, '../..');
const appDir = path.join(root, 'apps/next-host');
const fontsDir = path.join(root, 'tests/fixtures/m6-text/fonts');
const FIXTURE_TEXT = readFileSync(path.join(root, 'tests/fixtures/m6-text/text.v4.json'), 'utf8');
const FONT_SHA256 = '3d21bfdb71ca17f2e83373faa52918e8942ec8d99185b2325d92963fc90c4324';
const LICENSE_SHA256 = '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2';
/** The Hangul syllables of the subset (contract section 16, M6a-U5 note 2). */
const SUBSET_HANGUL = '가각국글기나녕니다동라마바벡사세습아안요자집차채천추카타택터파편하한했';

type FontStatus = 'loaded' | 'error';
// Typed against the source modules, so a change of their API fails typecheck here.
const host = (await import(path.join(appDir, 'src/m6a-text-host.ts'))) as typeof HostModule;
type Composition = HostModule.HostComposition;
type CompositionState = HostModule.HostCompositionState;
type Route = typeof TextRouteModule;
const textRoute = (await import(path.join(appDir, 'app/m6a-text.json/route.ts'))) as Route;
const fontRoute = (await import(
  path.join(appDir, 'app/m6a-test-font.otf/route.ts')
)) as typeof FontRouteModule;

/** A fake `TextDom`: the fake port, with recorded registrations and disposals. */
function fakeTextDom(portVersion = 0) {
  const port = createFakeTextLayout();
  const registrations: { font: TextDomFont; settle(status: FontStatus): void }[] = [];
  let disposals = 0;
  const textDom = {
    portVersion,
    get generation() {
      return port.generation;
    },
    layout: (request) => port.layout(request),
    subscribe: (listener) => port.subscribe(listener),
    registerFont(font: TextDomFont) {
      return new Promise<FontStatus>((resolve) => registrations.push({ font, settle: resolve }));
    },
    dispose() {
      disposals += 1;
    },
    fallbacks: 0,
  } as TextDom;
  return {
    textDom,
    port,
    registrations,
    get disposals() {
      return disposals;
    },
  };
}
type FakeDom = ReturnType<typeof fakeTextDom>;

/** A factory handing out fake instances, recording each and the options it was given. */
function factory(portVersion = 0) {
  const made: FakeDom[] = [];
  const options: TextDomOptions[] = [];
  return {
    made,
    options,
    create: (value: TextDomOptions): TextDom => {
      options.push(value);
      const fake = fakeTextDom(portVersion);
      made.push(fake);
      return fake.textDom;
    },
  };
}

const shimDocument = { nodeType: 9 } as unknown as Document;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function load(editor: Editor): void {
  const result = editor.execute({ type: 'loadDocument', document: JSON.parse(FIXTURE_TEXT) });
  if (!result.ok) throw new Error(`loadDocument: ${result.code} ${result.path ?? ''}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M6a-U5 host composition (section 5)', () => {
  it('creates the text-dom instance on the given document and feeds it to the editor', () => {
    const made = factory();
    const composition = host.composeHost({
      document: shimDocument,
      platform: 'other',
      createTextDom: made.create,
    });
    expect(made.options).toEqual([{ document: shimDocument }]);
    expect(composition.textDom).toBe(made.made[0]!.textDom);
    load(composition.editor);
    // The editor lays out through the injected port (the fake's widths: 5 Latin at 0.5 em).
    const result = composition.editor.query({ type: 'textLayout', id: 't1' });
    expect(result?.width).toBe(40);
    expect(made.made[0]!.port.layoutCalls).toBe(1);
    // The star extension stays registered, as before the composition moved.
    expect(
      composition.editor.execute({
        type: 'runCommand',
        id: 'ext.star.create',
        args: { frame: { x: 0, y: 0, width: 10, height: 10 } },
      }).ok,
    ).toBe(true);
  });

  it('disposes the text-dom instance once, however often dispose is called', () => {
    const made = factory();
    const composition = host.composeHost({
      document: shimDocument,
      platform: 'mac',
      createTextDom: made.create,
    });
    expect(made.made[0]!.disposals).toBe(0);
    composition.dispose();
    composition.dispose();
    expect(made.made[0]!.disposals).toBe(1);
  });

  it('disposes the text-dom instance when the editor rejects it', () => {
    const made = factory(1);
    expect(() =>
      host.composeHost({ document: shimDocument, platform: 'other', createTextDom: made.create }),
    ).toThrow('createEditor: textLayout portVersion 1');
    expect(made.made[0]!.disposals).toBe(1);
  });

  it('under strict mode keeps the second pair and disposes the first', async () => {
    const made = factory();
    const published: CompositionState[] = [];
    const statuses: string[] = [];
    const effect = () =>
      host.startHostComposition({
        document: shimDocument,
        platform: 'other',
        createTextDom: made.create,
        textFixture: true,
        publish: (state) => published.push(state),
        onFontStatus: (status) => statuses.push(status),
      });
    // React's strict mode: mount, unmount, mount again.
    const cleanupFirst = effect();
    cleanupFirst();
    const cleanupSecond = effect();
    expect(made.made).toHaveLength(2);
    expect(made.made.map((fake) => fake.disposals)).toEqual([1, 0]);
    expect(published.map((state) => state.composition.textDom)).toEqual(
      made.made.map((fake) => fake.textDom),
    );
    expect(published[0]!.composition.editor).not.toBe(published[1]!.composition.editor);
    // The first registration settling after its cleanup reports nothing; the second reports.
    made.made[0]!.registrations[0]!.settle('error');
    await flush();
    expect(statuses).toEqual(['loading', 'loading']);
    made.made[1]!.registrations[0]!.settle('loaded');
    await expect(published[1]!.testFont).resolves.toBe('loaded');
    await flush();
    expect(statuses).toEqual(['loading', 'loading', 'loaded']);
    cleanupSecond();
    expect(made.made.map((fake) => fake.disposals)).toEqual([1, 1]);
  });

  it('registers the committed test font with ?fixture=text only', async () => {
    const made = factory();
    const states: CompositionState[] = [];
    const statuses: string[] = [];
    const cleanup = host.startHostComposition({
      document: shimDocument,
      platform: 'other',
      createTextDom: made.create,
      textFixture: false,
      publish: (state) => states.push(state),
      onFontStatus: (status) => statuses.push(status),
    });
    expect(made.made[0]!.registrations).toHaveLength(0);
    expect(states[0]!.testFont).toBeNull();
    expect(statuses).toEqual([]);
    cleanup();

    const withFont = host.startHostComposition({
      document: shimDocument,
      platform: 'other',
      createTextDom: made.create,
      textFixture: true,
      publish: (state) => states.push(state),
      onFontStatus: (status) => statuses.push(status),
    });
    expect(made.made[1]!.registrations.map((entry) => entry.font)).toEqual([
      { family: 'Noto Sans KR', source: { url: '/m6a-test-font.otf' } },
    ]);
    made.made[1]!.registrations[0]!.settle('error');
    await expect(states[1]!.testFont).resolves.toBe('error');
    await flush();
    expect(statuses).toEqual(['loading', 'error']);
    withFont();
  });

  it('reads ?fixture=text, and ignores it under ?persist=1', () => {
    expect(host.textFixtureQuery('?fixture=text')).toBe(true);
    expect(host.textFixtureQuery('?test=1&fixture=text')).toBe(true);
    expect(host.textFixtureQuery('')).toBe(false);
    expect(host.textFixtureQuery('?fixture=symbols')).toBe(false);
    expect(host.textFixtureQuery('?fixture=Text')).toBe(false);
    expect(host.textFixtureQuery('?persist=1&fixture=text')).toBe(false);
  });
});

describe('M6a-U5 page effect failures', () => {
  it('hands a throwing createTextDom or a rejected port to onError, with a no-op cleanup', () => {
    const errors: string[] = [];
    const published: CompositionState[] = [];
    const cleanup = host.runHostEffect(
      {
        document: shimDocument,
        platform: 'other',
        createTextDom: () => {
          throw new TypeError('text-dom: no document');
        },
        textFixture: true,
        publish: (state) => published.push(state),
      },
      (message) => errors.push(message),
    );
    expect(() => cleanup()).not.toThrow();
    const rejected = factory(1);
    host.runHostEffect(
      {
        document: shimDocument,
        platform: 'other',
        createTextDom: rejected.create,
        textFixture: false,
        publish: (state) => published.push(state),
      },
      (message) => errors.push(message),
    );
    expect(errors).toEqual([
      'TypeError: text-dom: no document',
      'Error: createEditor: textLayout portVersion 1',
    ]);
    expect(published).toEqual([]);
    expect(rejected.made[0]!.disposals).toBe(1);
  });

  it('runs a successful composition as startHostComposition does, with distinct ids', () => {
    const made = factory();
    const errors: string[] = [];
    const published: CompositionState[] = [];
    const options = {
      document: shimDocument,
      platform: 'other' as const,
      createTextDom: made.create,
      textFixture: false,
      publish: (state: CompositionState) => published.push(state),
    };
    const first = host.runHostEffect(options, (message) => errors.push(message));
    const second = host.runHostEffect(options, (message) => errors.push(message));
    expect(errors).toEqual([]);
    expect(published).toHaveLength(2);
    expect(published[1]!.id).toBeGreaterThan(published[0]!.id);
    first();
    second();
    expect(made.made.map((fake) => fake.disposals)).toEqual([1, 1]);
  });
});

describe('M6a-U5 test hook', () => {
  it('exposes the port, the fixture registration and the test font under another family', () => {
    const made = factory();
    let state: CompositionState | undefined;
    const cleanup = host.startHostComposition({
      document: shimDocument,
      platform: 'other',
      createTextDom: made.create,
      textFixture: true,
      publish: (value) => (state = value),
    });
    const hook = host.textTestHook(state!);
    expect(hook.port).toBe(made.made[0]!.textDom);
    expect(hook.port).toBe(state!.composition.textDom);
    expect(hook.family).toBe(host.TEST_FONT_FAMILY);
    expect(hook.fontUrl).toBe(host.TEST_FONT_URL);
    expect(hook.testFont).toBe(state!.testFont);
    void hook.registerTestFont('VS Probe');
    void hook.registerTestFont();
    expect(made.made[0]!.registrations.map((entry) => entry.font)).toEqual([
      { family: 'Noto Sans KR', source: { url: '/m6a-test-font.otf' } },
      { family: 'VS Probe', source: { url: '/m6a-test-font.otf' } },
      { family: 'Noto Sans KR', source: { url: '/m6a-test-font.otf' } },
    ]);
    cleanup();
  });
});

/** A minimal document for the real text-dom: font-set events and a resolution query only. */
function domShim() {
  const fonts = Object.assign(new EventTarget(), {
    faces: new Set<unknown>(),
    add(face: unknown) {
      this.faces.add(face);
    },
    delete(face: unknown) {
      this.faces.delete(face);
    },
  });
  const view = {
    devicePixelRatio: 1,
    matchMedia: () => new EventTarget(),
  };
  const document = { nodeType: 9, defaultView: view, fonts } as unknown as Document;
  return { document, fonts };
}

describe('M6a-U5 composition with the real text-dom', () => {
  it("stops the discarded editor's text events once its instance is disposed", () => {
    const { document, fonts } = domShim();
    const first = host.composeHost({ document, platform: 'other', createTextDom });
    const second = host.composeHost({ document, platform: 'other', createTextDom });
    const events = (composition: Composition) => {
      const list: EditorEvent[] = [];
      composition.editor.subscribe((event) => list.push(event));
      return list;
    };
    const firstEvents = events(first);
    const secondEvents = events(second);
    fonts.dispatchEvent(new Event('loadingdone'));
    expect(firstEvents.map((event) => event.type)).toEqual(['session']);
    expect(secondEvents.map((event) => event.type)).toEqual(['session']);
    const generation = first.textDom.generation;
    first.dispose();
    fonts.dispatchEvent(new Event('loadingdone'));
    expect(firstEvents).toHaveLength(1);
    expect(first.textDom.generation).toBe(generation);
    expect(secondEvents).toHaveLength(2);
    expect(second.textDom.generation).toBeGreaterThan(generation);
    second.dispose();
  });
});

describe('M6a-U5 routes', () => {
  it('serves the committed text fixture byte for byte at /m6a-text.json', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(appDir);
    const fresh = (await import(
      `${path.join(appDir, 'app/m6a-text.json/route.ts')}?cwd=app`
    )) as Route;
    const response = await fresh.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(FIXTURE_TEXT);
    expect(fresh.dynamic).toBe('force-dynamic');
  });

  it('serves the committed test font byte for byte at /m6a-test-font.otf', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(appDir);
    const fresh = (await import(
      `${path.join(appDir, 'app/m6a-test-font.otf/route.ts')}?cwd=app`
    )) as Route;
    const response = await fresh.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('font/otf');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FONT_SHA256);
    expect(fresh.dynamic).toBe('force-dynamic');
  });

  it('answers 404 when the files are not where the app expects them', async () => {
    // From an empty directory two levels down, the routes resolve to a directory with no fixture.
    const empty = mkdtempSync(path.join(tmpdir(), 'm6a-u5-'));
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(path.join(empty, 'a', 'b'));
      const text = (await import(
        `${path.join(appDir, 'app/m6a-text.json/route.ts')}?cwd=empty`
      )) as Route;
      const font = (await import(
        `${path.join(appDir, 'app/m6a-test-font.otf/route.ts')}?cwd=empty`
      )) as typeof FontRouteModule;
      expect((await text.GET()).status).toBe(404);
      expect((await font.GET()).status).toBe(404);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    // The statically imported modules are the same routes.
    expect(typeof textRoute.GET).toBe('function');
    expect(typeof fontRoute.GET).toBe('function');
  });
});

/** Reads the sfnt table directory and the cmap's format 4 and 12 subtables. */
function readFont(bytes: Buffer) {
  const tables = new Map<string, { offset: number; length: number }>();
  const count = bytes.readUInt16BE(4);
  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16;
    tables.set(bytes.toString('latin1', at, at + 4), {
      offset: bytes.readUInt32BE(at + 8),
      length: bytes.readUInt32BE(at + 12),
    });
  }
  const cmap = tables.get('cmap')!.offset;
  const codePoints = new Set<number>();
  for (let index = 0; index < bytes.readUInt16BE(cmap + 2); index += 1) {
    const sub = cmap + bytes.readUInt32BE(cmap + 4 + index * 8 + 4);
    const format = bytes.readUInt16BE(sub);
    if (format === 4) {
      const segments = bytes.readUInt16BE(sub + 6) / 2;
      const ends = sub + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const ranges = deltas + segments * 2;
      for (let s = 0; s < segments; s += 1) {
        const start = bytes.readUInt16BE(starts + s * 2);
        const end = bytes.readUInt16BE(ends + s * 2);
        const delta = bytes.readUInt16BE(deltas + s * 2);
        const rangeOffset = bytes.readUInt16BE(ranges + s * 2);
        for (let code = start; code <= end && code !== 0xffff; code += 1) {
          let glyph: number;
          if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
          else {
            const at = ranges + s * 2 + rangeOffset + (code - start) * 2;
            glyph = bytes.readUInt16BE(at);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) codePoints.add(code);
        }
      }
    } else if (format === 12) {
      const groups = bytes.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g += 1) {
        const at = sub + 16 + g * 12;
        for (let code = bytes.readUInt32BE(at); code <= bytes.readUInt32BE(at + 4); code += 1) {
          codePoints.add(code);
        }
      }
    }
  }
  const head = tables.get('head')!.offset;
  return {
    tables: [...tables.keys()],
    codePoints,
    // head.fontRevision is a 16.16 fixed number.
    revision: bytes.readInt32BE(head + 4) / 65536,
  };
}

describe('M6a-U5 test font asset (M6a-Q13 (a))', () => {
  const bytes = readFileSync(path.join(fontsDir, 'NotoSansKR-Regular-subset.otf'));
  const font = readFont(bytes);

  it('is the recorded subset, small, with the upstream license beside it', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FONT_SHA256);
    expect(bytes.length).toBe(71_420);
    expect(bytes.length).toBeLessThan(200 * 1024);
    // An OpenType font with CFF outlines, version 2.004 (fontRevision 2.004 as 16.16).
    expect(bytes.toString('latin1', 0, 4)).toBe('OTTO');
    expect(font.tables).toContain('CFF ');
    expect(font.revision).toBeCloseTo(2.004, 3);
    const license = readFileSync(path.join(fontsDir, 'OFL.txt'));
    expect(createHash('sha256').update(license).digest('hex')).toBe(LICENSE_SHA256);
    expect(license.toString('utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('maps Basic Latin, the subset Hangul and every Hangul of the text fixture', () => {
    for (let code = 0x20; code <= 0x7e; code += 1) expect(font.codePoints.has(code)).toBe(true);
    const hangul = [...SUBSET_HANGUL].map((value) => value.codePointAt(0)!);
    expect(hangul).toHaveLength(35);
    for (const code of hangul) expect(font.codePoints.has(code)).toBe(true);
    const fixtureHangul = [...FIXTURE_TEXT].filter((value) => /\p{Script=Hangul}/u.test(value));
    expect(fixtureHangul.length).toBeGreaterThan(0);
    for (const value of fixtureHangul) expect(SUBSET_HANGUL).toContain(value);
    // Syllables outside the subset fall back (A11's Hangul fallback relies on it).
    expect(font.codePoints.has('힣'.codePointAt(0)!)).toBe(false);
    const syllables = [...font.codePoints].filter((code) => code >= 0xac00 && code <= 0xd7a3);
    expect(syllables).toHaveLength(35);
  });
});
