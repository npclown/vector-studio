import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type EditorSnapshot,
  type SelectionHandles,
} from '../../packages/editor-core/src/index.js';
import { validateDocument, type DocumentV6 } from '../../packages/model/src/index.js';
import type * as RouteModule from '../../apps/next-host/app/m6b-text-edit.json/route.js';
import type * as HostModule from '../../apps/next-host/src/m6a-text-host.js';
import type * as EditModule from '../../apps/next-host/src/m6b-text-edit.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// MVP M6b-U9 (M6b contract, sections 4.5, 6 and M6b-A12, A13): the next-host page's text edit
// chrome in Node: the committed `?fixture=text-edit` document and its route, the caret,
// selection and composition underline drawn from the `textEditOverlay` query in CSS pixels,
// the text tool style the fixture sets, `textFixtureQuery` for the new fixture, and the test
// hook's DOM event log. The headed half (A12, A13) is tests/m6b-next-host/.

const root = path.resolve(import.meta.dirname, '../..');
const appDir = path.join(root, 'apps/next-host');
const FIXTURE_TEXT = readFileSync(
  path.join(root, 'tests/fixtures/m6-text/edit-host.v6.json'),
  'utf8',
);
const FIXTURE = JSON.parse(FIXTURE_TEXT) as DocumentV6;
const PAGE_SOURCE = readFileSync(path.join(appDir, 'app/page.tsx'), 'utf8');

const edit = (await import(path.join(appDir, 'src/m6b-text-edit.ts'))) as typeof EditModule;
const host = (await import(path.join(appDir, 'src/m6a-text-host.ts'))) as typeof HostModule;
const { SelectionOverlay } = (await import(path.join(appDir, 'src/overlay.tsx'))) as {
  SelectionOverlay: ComponentType<{
    snapshot: EditorSnapshot;
    handles: SelectionHandles | null;
    width: number;
    height: number;
    textEdit?: EditModule.TextEditMarkers | null;
  }>;
};

const none = { shift: false, alt: false, meta: false, ctrl: false };

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

/** The fixture as the page loads it, on the fake port, at the page's camera. */
function loaded(): Editor {
  const target = createEditor({
    ids: createCounterIdSource('n'),
    textLayout: createFakeTextLayout(),
  });
  ok(target, { type: 'loadDocument', document: FIXTURE });
  ok(target, { type: 'setViewportSize', width: 960, height: 640 });
  ok(target, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 2 } });
  ok(target, { type: 'setTextToolStyle', style: edit.TEXT_EDIT_TOOL_STYLE });
  return target;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M6b-U9 text-edit fixture', () => {
  it('is a valid v6 document of three text nodes in the test font', () => {
    expect(validateDocument(FIXTURE).ok).toBe(true);
    expect(FIXTURE.schemaVersion).toBe(6);
    expect(FIXTURE.pages.map((page) => page.children)).toEqual([['t', 'w', 'r']]);
    const texts = Object.fromEntries(
      Object.values(FIXTURE.nodes).map((node) => [
        node.id,
        node.type === 'text' ? node.runs.map((run) => run.text).join('') : null,
      ]),
    );
    // `t` is the node the synthetic IME traces start in (tests/fixtures/m6-text/ime/).
    expect(texts).toEqual({
      t: 'ab cd',
      w: '가나다 라마바 사아자 차카타\n\nHello world',
      r: 'Rotated 한글',
    });
    for (const node of Object.values(FIXTURE.nodes)) {
      expect(node.type === 'text' && node.runs.every((run) => run.family === 'Noto Sans KR')).toBe(
        true,
      );
    }
    expect(FIXTURE.nodes.r!.rotation).toBe(0.4);
    // Loading keeps it byte for byte.
    expect(loaded().query({ type: 'document' })).toEqual(FIXTURE);
  });

  it('serves the fixture byte for byte at /m6b-text-edit.json', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(appDir);
    const route = (await import(
      `${path.join(appDir, 'app/m6b-text-edit.json/route.ts')}?cwd=app`
    )) as typeof RouteModule;
    const response = await route.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(FIXTURE_TEXT);
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('asks for the test font and sets the text tool style to it', () => {
    expect(host.textFixtureQuery('?test=1&fixture=text-edit')).toBe(true);
    expect(host.textFixtureQuery('?persist=1&fixture=text-edit')).toBe(false);
    expect(host.textFixtureQuery('?fixture=text-edit2')).toBe(false);
    expect(loaded().getSnapshot().textStyle).toEqual({
      family: 'Noto Sans KR',
      size: 20,
      color: { r: 0, g: 0, b: 0, a: 1 },
    });
    // The page lists the fixture, its style and the text tool button.
    expect(PAGE_SOURCE).toMatch(/'text-edit': \{\s+url: '\/m6b-text-edit\.json'/u);
    expect(PAGE_SOURCE).toMatch(/'path',\s+'text',\s+\];/u);
  });
});

describe('M6b-U9 edit overlay markers', () => {
  it('maps the caret, selection and composition to CSS px at the camera', () => {
    const target = loaded();
    expect(edit.textEditMarkers(null, target.getSnapshot().viewport)).toBeNull();
    ok(target, { type: 'enterTextEdit', id: 't', anchor: 2, focus: 2 });
    const camera = target.getSnapshot().viewport;
    const overlay = target.query({ type: 'textEditOverlay' })!;
    const markers = edit.textEditMarkers(overlay, camera)!;
    const px = (p: { x: number; y: number }) => [(p.x - 0) * 2, (p.y - 0) * 2];
    expect(markers.id).toBe('t');
    expect(markers.caret).toEqual({
      x1: px(overlay.caret![0])[0],
      y1: px(overlay.caret![0])[1],
      x2: px(overlay.caret![1])[0],
      y2: px(overlay.caret![1])[1],
    });
    expect(markers.selection).toEqual([]);
    // A selection over the rotated node: one quad, rotated, no caret.
    ok(target, { type: 'enterTextEdit', id: 'r', anchor: 0, focus: 4 });
    const rotated = target.query({ type: 'textEditOverlay' })!;
    const selected = edit.textEditMarkers(rotated, target.getSnapshot().viewport)!;
    expect(selected.caret).toBeNull();
    expect(selected.selection).toHaveLength(1);
    expect(selected.selection[0]).toEqual(rotated.selection[0]!.map(px));
    // A composition: one underline segment, mapped.
    ok(target, { type: 'enterTextEdit', id: 't', anchor: 5, focus: 5 });
    ok(target, { type: 'input', event: { kind: 'compositionstart' } });
    ok(target, { type: 'input', event: { kind: 'compositionupdate', data: '한' } });
    const composing = target.query({ type: 'textEditOverlay' })!;
    const underline = edit.textEditMarkers(composing, target.getSnapshot().viewport)!;
    expect(underline.composition).toHaveLength(1);
    const [a, b] = composing.composition[0]!;
    expect(underline.composition[0]).toEqual({
      x1: px(a)[0],
      y1: px(a)[1],
      x2: px(b)[0],
      y2: px(b)[1],
    });
  });

  it('follows the camera', () => {
    const target = loaded();
    ok(target, { type: 'enterTextEdit', id: 't', anchor: 0, focus: 0 });
    ok(target, { type: 'setViewport', camera: { position: { x: 10, y: -5 }, zoom: 0.5 } });
    const overlay = target.query({ type: 'textEditOverlay' })!;
    const markers = edit.textEditMarkers(overlay, target.getSnapshot().viewport)!;
    expect(markers.caret!.x1).toBe((overlay.caret![0].x - 10) * 0.5);
    expect(markers.caret!.y2).toBe((overlay.caret![1].y + 5) * 0.5);
  });

  it('draws the caret, selection quads and underline in the overlay', () => {
    const target = loaded();
    const snapshot = () => target.getSnapshot();
    const html = (markers: EditModule.TextEditMarkers | null) =>
      renderToString(
        createElement(SelectionOverlay, {
          snapshot: snapshot(),
          handles: null,
          width: 960,
          height: 640,
          textEdit: markers,
        }),
      );
    expect(html(null)).not.toContain('text-edit');
    ok(target, { type: 'enterTextEdit', id: 'w', anchor: 0, focus: 0 });
    const caret = edit.textEditMarkers(
      target.query({ type: 'textEditOverlay' }),
      snapshot().viewport,
    )!;
    const drawn = html(caret);
    expect(drawn).toContain('data-testid="text-edit" data-id="w"');
    const line = drawn.match(/<line data-testid="text-caret"[^>]*>/u)![0];
    expect(line).toContain(`data-x1="${caret.caret!.x1}"`);
    expect(line).toContain(`data-y2="${caret.caret!.y2}"`);
    expect(drawn).not.toContain('text-selection');
    // Mod+A over the wrapped node: one quad per line, no caret.
    ok(target, {
      type: 'input',
      event: { kind: 'keydown', key: 'a', code: 'KeyA', modifiers: { ...none, ctrl: true } },
    });
    const all = edit.textEditMarkers(
      target.query({ type: 'textEditOverlay' }),
      snapshot().viewport,
    )!;
    const selection = html(all);
    expect(all.selection.length).toBeGreaterThan(1);
    expect([...selection.matchAll(/data-testid="text-selection"/gu)]).toHaveLength(
      all.selection.length,
    );
    expect(selection).not.toContain('text-caret');
    // An underline while composing.
    ok(target, { type: 'enterTextEdit', id: 't', anchor: 5, focus: 5 });
    ok(target, { type: 'input', event: { kind: 'compositionstart' } });
    ok(target, { type: 'input', event: { kind: 'compositionupdate', data: 'ㅎ' } });
    const composing = html(
      edit.textEditMarkers(target.query({ type: 'textEditOverlay' }), snapshot().viewport),
    );
    expect([...composing.matchAll(/data-testid="text-composition"/gu)]).toHaveLength(1);
  });
});

describe('M6b-U9 test hook log', () => {
  /** A fake element with the reads `focusName` makes. */
  function element(tag: string, attributes: Record<string, string> = {}, panel = false) {
    return {
      tagName: tag.toUpperCase(),
      getAttribute: (name: string) => attributes[name] ?? null,
      closest: (selector: string) =>
        panel && selector === '[data-testid="appearance-panel"]' ? {} : null,
    };
  }
  const textarea = element('textarea', { 'aria-label': 'Text input' });
  const canvas = element('canvas');

  it('names the textarea, the canvas, the panel and the rest', () => {
    expect(edit.focusName(textarea)).toBe('textarea');
    expect(edit.focusName(element('textarea'))).toBe('other');
    expect(edit.focusName(canvas)).toBe('canvas');
    expect(edit.focusName(element('body'))).toBe('body');
    expect(edit.focusName(element('input', {}, true))).toBe('panel');
    expect(edit.focusName(element('button'))).toBe('other');
    expect(edit.focusName(null)).toBe('other');
  });

  it('logs each listed event after the page handled it, and clears', () => {
    const listeners = new Map<string, (event: Event) => void>();
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) =>
        listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    let active: unknown = textarea;
    const { hook, dispose } = edit.createTextEditLog(target, () => active);
    expect([...listeners.keys()]).toEqual([...edit.LOGGED_EVENTS]);
    const fire = (fields: Record<string, unknown>) =>
      listeners.get(fields.type as string)!(fields as unknown as Event);
    fire({ type: 'pointerdown', target: canvas, defaultPrevented: true });
    fire({
      type: 'keydown',
      target: textarea,
      defaultPrevented: false,
      key: 'Process',
      code: 'KeyG',
      keyCode: 229,
    });
    fire({
      type: 'beforeinput',
      target: textarea,
      defaultPrevented: true,
      inputType: 'insertText',
      data: 'a',
    });
    fire({ type: 'compositionend', target: textarea, data: '' });
    fire({
      type: 'paste',
      target: textarea,
      defaultPrevented: true,
      clipboardData: { types: ['text/plain', 'text/html'] },
    });
    active = canvas;
    fire({ type: 'focusout', target: textarea, relatedTarget: canvas });
    fire({ type: 'focusin', target: canvas, relatedTarget: null });
    expect(hook.log).toEqual([
      { type: 'pointerdown', target: 'canvas', prevented: true, focused: 'textarea' },
      {
        type: 'keydown',
        target: 'textarea',
        prevented: false,
        focused: 'textarea',
        key: 'Process',
        code: 'KeyG',
        keyCode: 229,
      },
      {
        type: 'beforeinput',
        target: 'textarea',
        prevented: true,
        focused: 'textarea',
        inputType: 'insertText',
        data: 'a',
      },
      {
        type: 'compositionend',
        target: 'textarea',
        prevented: false,
        focused: 'textarea',
        data: '',
      },
      {
        type: 'paste',
        target: 'textarea',
        prevented: true,
        focused: 'textarea',
        types: ['text/plain', 'text/html'],
      },
      {
        type: 'focusout',
        target: 'textarea',
        prevented: false,
        focused: 'canvas',
        related: 'canvas',
      },
      { type: 'focusin', target: 'canvas', prevented: false, focused: 'canvas', related: null },
    ]);
    expect(hook.focused()).toBe('canvas');
    hook.clearLog();
    expect(hook.log).toEqual([]);
    dispose();
    expect(listeners.size).toBe(0);
  });
});
