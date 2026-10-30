import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type EditorSnapshot,
  type InputEvent,
  type PagePoint,
  type PathAnchorRef,
  type PathEditOverlay,
  type SelectionHandles,
} from '../../packages/editor-core/src/index.js';
import {
  validateAnyDocument,
  validateDocument,
  type DocumentV2,
  type DocumentV6,
} from '../../packages/model/src/index.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// MVP M3-U4 (M3 contract, sections 4, 5.1 and M3-A12): the next-host page's pure path edit
// chrome, in Node: the committed `?fixture=path-edit` document, the anchor and handle markers
// drawn from the `pathOverlay` query in CSS pixels, the toggle-closed button's command against
// the `togglePathClosed` action it stands in for, and the headed spec's step sequence through
// `input` on the fixture with the renderer-core scene mirror (every scene applied, no
// diagnostic, undo and redo byte-identical).

const root = path.resolve(import.meta.dirname, '../..');
const appSource = path.join(root, 'apps/next-host/src');
type Marker = Readonly<{ subpath: number; anchor: number; x: number; y: number }>;
type Markers = Readonly<{
  anchors: readonly (Marker & Readonly<{ selected: boolean; mirrored: boolean }>)[];
  handles: readonly (Marker & Readonly<{ side: 'in' | 'out'; anchorX: number; anchorY: number }>)[];
}>;
const { pathMarkers, toggleClosedCommand } = (await import(
  path.join(appSource, 'm3-path-overlay.ts')
)) as {
  pathMarkers: (overlay: PathEditOverlay | null, camera: EditorSnapshot['viewport']) => Markers;
  toggleClosedCommand: (overlay: PathEditOverlay | null) => Command | null;
};
const { SelectionOverlay } = (await import(path.join(appSource, 'overlay.tsx'))) as {
  SelectionOverlay: ComponentType<{
    snapshot: EditorSnapshot;
    handles: SelectionHandles | null;
    width: number;
    height: number;
    pathOverlay?: PathEditOverlay | null;
  }>;
};

const FIXTURE_TEXT = readFileSync(
  path.join(root, 'tests/fixtures/m3-path-edit/path-edit.json'),
  'utf8',
);
const FIXTURE = JSON.parse(FIXTURE_TEXT) as DocumentV2;
const none = { shift: false, alt: false, meta: false, ctrl: false };

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function loaded(document: unknown = FIXTURE): Editor {
  const target = createEditor({ ids: createCounterIdSource('n') });
  ok(target, { type: 'loadDocument', document });
  ok(target, { type: 'setViewportSize', width: 960, height: 640 });
  return target;
}

function text(target: Editor): string {
  return JSON.stringify(target.query({ type: 'document' }));
}

const ref = (subpath: number, anchor: number): PathAnchorRef => ({ subpath, anchor });

function editing(document: unknown, id: string, anchors: readonly PathAnchorRef[]): Editor {
  const target = loaded(document);
  ok(target, { type: 'enterPathEdit', id });
  if (anchors.length > 0) ok(target, { type: 'setPathSelection', anchors });
  return target;
}

/** A one-page document of `createPath` nodes (page-space points), created through commands. */
function pathsDocument(
  paths: readonly Readonly<{
    verbs: Extract<Command, { type: 'createPath' }>['verbs'];
    points: readonly number[];
  }>[],
): DocumentV6 {
  const target = createEditor({ ids: createCounterIdSource('p') });
  for (const entry of paths) ok(target, { type: 'createPath', ...entry });
  return target.query({ type: 'document' });
}

describe('M3-U4 path-edit fixture', () => {
  it('is a valid document with a closed cubic path and an open path in a rotated group', () => {
    const result = validateAnyDocument(FIXTURE);
    expect(result.ok).toBe(true);
    expect(FIXTURE.pages.map((page) => page.children)).toEqual([['closed', 'g1']]);
    const closed = FIXTURE.nodes.closed!;
    const group = FIXTURE.nodes.g1!;
    const open = FIXTURE.nodes.open!;
    expect(closed).toMatchObject({ type: 'path', parent: 'page-1', rotation: 0 });
    expect(group).toMatchObject({ type: 'group', parent: 'page-1', children: ['open'] });
    expect(group.rotation).not.toBe(0);
    expect(open).toMatchObject({ type: 'path', parent: 'g1', fill: null });
    // Through the editor's own anchor model: four mirrored anchors on a closed subpath of
    // cubics (the explicit closing form), and four corner anchors on an open polyline.
    const target = loaded();
    ok(target, { type: 'enterPathEdit', id: 'closed' });
    const overlay = target.query({ type: 'pathOverlay' })!;
    expect(overlay.subpaths.map((s) => [s.closed, s.anchors.length])).toEqual([[true, 4]]);
    expect(overlay.subpaths[0]!.anchors.every((anchor) => anchor.mirrored)).toBe(true);
    expect(overlay.subpaths[0]!.anchors.map((anchor) => anchor.point)).toEqual([
      { x: 208, y: 120 },
      { x: 336, y: 248 },
      { x: 208, y: 376 },
      { x: 80, y: 248 },
    ]);
    ok(target, { type: 'enterPathEdit', id: 'open' });
    const nested = target.query({ type: 'pathOverlay' })!;
    expect(nested.subpaths.map((s) => [s.closed, s.anchors.length])).toEqual([[false, 4]]);
    // Loading it in the editor keeps it byte for byte, up to the v6 version and the `dash: null`
    // its path strokes gain (M4-U1, M4-M1).
    const migrated = {
      ...FIXTURE,
      schemaVersion: 6,
      nodes: Object.fromEntries(
        Object.entries(FIXTURE.nodes).map(([id, node]) => [
          id,
          'stroke' in node && node.stroke !== null
            ? { ...node, stroke: { ...node.stroke, dash: null } }
            : node,
        ]),
      ),
    };
    expect(JSON.stringify(target.query({ type: 'document' }))).toBe(JSON.stringify(migrated));
  });
});

describe('M3-U4 path markers', () => {
  it('maps the overlay anchors and visible handles to CSS pixels', () => {
    const target = editing(FIXTURE, 'closed', [ref(0, 0)]);
    const overlay = target.query({ type: 'pathOverlay' })!;
    const camera = { position: { x: -20, y: -20 }, zoom: 2 };
    const markers = pathMarkers(overlay, camera);
    // css = (page − position) · zoom; anchor 0 at (208, 120) is selected.
    expect(markers.anchors).toEqual([
      { subpath: 0, anchor: 0, x: 456, y: 280, selected: true, mirrored: true },
      { subpath: 0, anchor: 1, x: 712, y: 536, selected: false, mirrored: true },
      { subpath: 0, anchor: 2, x: 456, y: 792, selected: false, mirrored: true },
      { subpath: 0, anchor: 3, x: 200, y: 536, selected: false, mirrored: true },
    ]);
    // Visible: anchor 0's own handles, anchor 1's `in` and anchor 3's `out` (their segment's
    // other end is anchor 0).
    expect(markers.handles).toEqual([
      { subpath: 0, anchor: 0, side: 'in', x: 328, y: 280, anchorX: 456, anchorY: 280 },
      { subpath: 0, anchor: 0, side: 'out', x: 584, y: 280, anchorX: 456, anchorY: 280 },
      { subpath: 0, anchor: 1, side: 'in', x: 712, y: 408, anchorX: 712, anchorY: 536 },
      { subpath: 0, anchor: 3, side: 'out', x: 200, y: 408, anchorX: 200, anchorY: 536 },
    ]);
    expect(pathMarkers(null, camera)).toEqual({ anchors: [], handles: [] });
  });

  it('follows the rotated group path to the page, as the overlay does', () => {
    const target = editing(FIXTURE, 'open', [ref(0, 1)]);
    const overlay = target.query({ type: 'pathOverlay' })!;
    const markers = pathMarkers(overlay, { position: { x: 0, y: 0 }, zoom: 1 });
    expect(markers.anchors.map((m) => ({ x: m.x, y: m.y }))).toEqual(
      overlay.subpaths[0]!.anchors.map((anchor) => anchor.point),
    );
    expect(markers.anchors.map((m) => m.selected)).toEqual([false, true, false, false]);
    // A polyline has no handles.
    expect(markers.handles).toEqual([]);
  });

  it('draws one marker per anchor and visible handle, with their CSS pixel places', () => {
    const target = editing(FIXTURE, 'closed', [ref(0, 0)]);
    const snapshot = target.getSnapshot();
    const overlay = target.query({ type: 'pathOverlay' })!;
    const html = renderToString(
      createElement(SelectionOverlay, {
        snapshot,
        handles: null,
        width: 960,
        height: 640,
        pathOverlay: overlay,
      }),
    );
    const anchors = [...html.matchAll(/data-testid="path-anchor"[^>]*/gu)].map((match) => match[0]);
    expect(anchors).toHaveLength(4);
    expect(anchors[0]).toContain('data-x="208"');
    expect(anchors[0]).toContain('data-y="120"');
    expect(anchors[0]).toContain('data-selected="true"');
    expect(anchors[1]).toContain('data-selected="false"');
    const handles = [...html.matchAll(/data-testid="path-handle"[^>]*/gu)].map((match) => match[0]);
    expect(handles).toHaveLength(4);
    expect(handles[0]).toContain('data-side="in"');
    expect(handles[0]).toContain('data-x="144"');
    expect(html).toContain('data-path="closed"');
    const without = renderToString(
      createElement(SelectionOverlay, { snapshot, handles: null, width: 960, height: 640 }),
    );
    expect(without).not.toContain('path-anchor');
  });
});

describe('M3-U4 toggle-closed button', () => {
  /** Presses T bound to `togglePathClosed` in one editor and runs the button's command in another. */
  function compare(document: unknown, id: string, anchors: readonly PathAnchorRef[]) {
    const action = editing(document, id, anchors);
    ok(action, { type: 'setKeymap', bindings: [{ chord: 'T', action: 'togglePathClosed' }] });
    const before = text(action);
    const pressed = action.execute({
      type: 'input',
      event: { kind: 'keydown', key: 't', code: 'KeyT', modifiers: none },
    });
    const button = editing(document, id, anchors);
    const command = toggleClosedCommand(button.query({ type: 'pathOverlay' }));
    const label = `${id} ${JSON.stringify(anchors)}`;
    if (command === null) {
      // The action is a consumed no-op, and the button is disabled.
      expect(pressed, label).toEqual({ ok: true, ids: [], consumed: true });
      expect(text(action), label).toBe(before);
      return null;
    }
    const result: CommandResult = button.execute(command);
    const { consumed, ...rest } = pressed as CommandResult & { consumed: boolean };
    expect(consumed, label).toBe(true);
    expect(result, label).toEqual(rest);
    expect(text(button), label).toBe(text(action));
    expect(button.getSnapshot().pathEdit, label).toEqual(action.getSnapshot().pathEdit);
    return command;
  }

  it('runs what the togglePathClosed action runs on the fixture paths', () => {
    expect(compare(FIXTURE, 'closed', [])).toBeNull();
    expect(compare(FIXTURE, 'closed', [ref(0, 0)])).toEqual({
      type: 'openPathSubpath',
      id: 'closed',
      subpath: 0,
    });
    expect(compare(FIXTURE, 'closed', [ref(0, 1), ref(0, 2)])).toMatchObject({ segment: 1 });
    expect(compare(FIXTURE, 'closed', [ref(0, 0), ref(0, 3)])).toMatchObject({ segment: 3 });
    expect(compare(FIXTURE, 'closed', [ref(0, 0), ref(0, 2)])).not.toHaveProperty('segment');
    expect(compare(FIXTURE, 'closed', [ref(0, 0), ref(0, 1), ref(0, 2)])).not.toHaveProperty(
      'segment',
    );
    expect(compare(FIXTURE, 'open', [ref(0, 0)])).toEqual({
      type: 'closePathSubpath',
      id: 'open',
      subpath: 0,
    });
    expect(compare(FIXTURE, 'open', [ref(0, 1), ref(0, 2)])).toMatchObject({
      type: 'closePathSubpath',
    });
  });

  it('agrees on two-anchor, one-anchor and multi-subpath cases', () => {
    const document = pathsDocument([
      // p1: an implicitly closed two-anchor subpath.
      { verbs: ['move', 'line', 'close'], points: [0, 0, 40, 30] },
      // p2: a one-anchor loop, then `move, close`, then a lone `move` and an open line.
      {
        verbs: ['move', 'cubic', 'close', 'move', 'close', 'move', 'move', 'line'],
        points: [100, 100, 140, 80, 140, 140, 100, 100, 200, 200, 220, 220, 260, 240, 300, 260],
      },
    ]);
    const [two, multi] = document.pages[0]!.children as [string, string];
    expect(compare(document, two, [ref(0, 0), ref(0, 1)])).toMatchObject({ segment: 0 });
    expect(compare(document, two, [ref(0, 1)])).not.toHaveProperty('segment');
    expect(compare(document, multi, [ref(0, 0)])).not.toHaveProperty('segment');
    expect(compare(document, multi, [ref(1, 0)])).not.toHaveProperty('segment');
    // A lone `move` cannot close: both fail with editor.too-few-anchors.
    expect(compare(document, multi, [ref(2, 0)])).toMatchObject({ type: 'closePathSubpath' });
    expect(compare(document, multi, [ref(3, 1)])).toMatchObject({ subpath: 3 });
    // Anchors in two subpaths: a no-op.
    expect(compare(document, multi, [ref(0, 0), ref(3, 0)])).toBeNull();
    expect(toggleClosedCommand(null)).toBeNull();
  });
});

describe('M3-U4 headed step sequence through input', () => {
  /** The M3-A12 steps of tests/m3-next-host on the fixture, through `input` at zoom 1. */
  it('applies every scene, raises no diagnostic and undoes byte for byte', () => {
    const target = loaded();
    const renderer = new RecordingRenderer();
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    target.attachRenderer(renderer);
    ok(target, { type: 'setSnapping', enabled: false });
    const input = (event: InputEvent) => target.execute({ type: 'input', event });
    const press = (point: PagePoint, modifiers = none) => {
      input({ kind: 'pointerdown', point, modifiers });
      input({ kind: 'pointerup', point, modifiers });
    };
    const drag = (from: PagePoint, to: PagePoint, modifiers = none) => {
      input({ kind: 'pointerdown', point: from, modifiers });
      input({ kind: 'pointermove', point: to, modifiers });
      input({ kind: 'pointerup', point: to, modifiers });
    };
    const doubleclick = (point: PagePoint) => {
      press(point);
      press(point);
      input({ kind: 'doubleclick', point, modifiers: none });
    };
    const key = (name: string, code = name) =>
      input({ kind: 'keydown', key: name, code, modifiers: none });
    const anchors = () => target.query({ type: 'pathOverlay' })!.subpaths[0]!.anchors;
    const step = (label: string, run: () => void) => {
      const before = text(target);
      const depth = target.getSnapshot().history.undoDepth;
      run();
      const after = text(target);
      expect(after, label).not.toBe(before);
      expect(target.getSnapshot().history.undoDepth, label).toBe(depth + 1);
      expect(validateDocument(JSON.parse(after)).ok, label).toBe(true);
      ok(target, { type: 'undo' });
      expect(text(target), label).toBe(before);
      ok(target, { type: 'redo' });
      expect(text(target), label).toBe(after);
    };

    // The closed cubic path: double-click its fill to enter edit mode.
    doubleclick({ x: 208, y: 248 });
    expect(target.getSnapshot().pathEdit).toEqual({ id: 'closed', anchors: [] });
    step('anchor drag', () => drag({ x: 208, y: 120 }, { x: 224, y: 104 }));
    ok(target, { type: 'setPathSelection', anchors: [ref(0, 0)] });
    const out = anchors()[0]!.out!;
    step('mirrored handle drag', () => drag(out, { x: out.x, y: out.y + 32 }));
    expect(anchors()[0]).toMatchObject({ in: { x: 160, y: 72 }, out: { x: 288, y: 136 } });
    const handleIn = anchors()[0]!.in!;
    step('Alt handle drag', () =>
      drag(handleIn, { x: handleIn.x - 16, y: handleIn.y }, { ...none, alt: true }),
    );
    expect(anchors()[0]).toMatchObject({
      in: { x: 144, y: 72 },
      out: { x: 288, y: 136 },
      mirrored: false,
    });
    // The middle of segment 1 (a cubic from (336, 248) to (208, 376)).
    step('segment double-click', () => doubleclick({ x: 296, y: 336 }));
    expect(anchors()).toHaveLength(5);
    expect(anchors()[2]!.point).toEqual({ x: 296, y: 336 });
    step('Delete', () => {
      press(anchors()[3]!.point);
      key('Delete');
    });
    expect(anchors()).toHaveLength(4);
    press(anchors()[1]!.point);
    press(anchors()[2]!.point, { ...none, shift: true });
    step('toggle closed (open)', () => {
      ok(target, toggleClosedCommand(target.query({ type: 'pathOverlay' }))!);
    });
    expect(target.query({ type: 'pathOverlay' })!.subpaths[0]!.closed).toBe(false);
    key('Escape');
    expect(target.getSnapshot()).toMatchObject({ pathEdit: null, selection: ['closed'] });

    // The open path inside the rotated group: select the group, Enter twice.
    ok(target, { type: 'enterPathEdit', id: 'open' });
    const start = anchors().map((anchor) => anchor.point);
    ok(target, { type: 'exitPathEdit' });
    ok(target, { type: 'setSelection', ids: [] });
    press(start[1]!);
    expect(target.getSnapshot().selection).toEqual(['g1']);
    key('Enter');
    key('Enter');
    expect(target.getSnapshot()).toMatchObject({
      scope: 'g1',
      pathEdit: { id: 'open', anchors: [] },
    });
    press(start[1]!);
    step('nudge', () => key('ArrowRight'));
    const moved = anchors()[1]!.point;
    expect(moved.x - start[1]!.x).toBeCloseTo(1, 9);
    expect(moved.y - start[1]!.y).toBeCloseTo(0, 9);
    const [, a1, a2] = anchors().map((anchor) => anchor.point);
    const middle = { x: (a1!.x + a2!.x) / 2, y: (a1!.y + a2!.y) / 2 };
    step('line double-click', () => doubleclick(middle));
    expect(anchors()).toHaveLength(5);
    step('remove an end', () => {
      press(anchors()[0]!.point);
      key('Delete');
    });
    expect(anchors()).toHaveLength(4);
    press(anchors()[0]!.point);
    step('toggle closed (close)', () => {
      ok(target, toggleClosedCommand(target.query({ type: 'pathOverlay' }))!);
    });
    expect(target.query({ type: 'pathOverlay' })!.subpaths[0]!.closed).toBe(true);
    press({ x: 880, y: 560 });
    expect(target.getSnapshot()).toMatchObject({ pathEdit: null, selection: [], scope: null });

    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([]);
    const scene = renderer.calls.filter((call) => call.method !== 'setCamera');
    expect(scene.every((call) => call.result.status === 'applied')).toBe(true);
  });
});
