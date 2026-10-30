import { serializeDocument, type DocumentV6 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';
import { projectNode } from '../../packages/editor-core/src/projector.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// P5-U4 (P5 editor-slice plan, section 4.5): the scene projector keeps an attached renderer
// equal to the document's projection (P5-A09), through the renderer-core scene mirror.

const black = { r: 0, g: 0, b: 0, a: 1 };
const red = { r: 1, g: 0, b: 0, a: 1 };
const none = { shift: false, alt: false, meta: false, ctrl: false };

function editor(): Editor {
  return createEditor({ ids: createCounterIdSource('n') });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function rect(target: Editor, x: number, y: number, w = 40, h = 30) {
  return ok(target, {
    type: 'createRectangle',
    frame: { x, y, width: w, height: h },
    fill: red,
  })[0]!;
}

function triangle(target: Editor, x: number, y: number) {
  return ok(target, {
    type: 'createPath',
    verbs: ['move', 'line', 'line', 'close'],
    points: [x, y, x + 60, y, x + 30, y + 40],
    stroke: { color: black, width: 3, cap: 'butt', join: 'miter', miterLimit: 4, dash: null },
  })[0]!;
}

function pointer(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
) {
  ok(target, { type: 'input', event: { kind, point: { x, y }, modifiers: none } });
}

function drag(target: Editor, from: [number, number], to: [number, number]) {
  pointer(target, 'pointerdown', from[0], from[1]);
  for (let i = 1; i <= 4; i += 1) {
    pointer(
      target,
      'pointermove',
      from[0] + ((to[0] - from[0]) * i) / 4,
      from[1] + ((to[1] - from[1]) * i) / 4,
    );
  }
  pointer(target, 'pointerup', to[0], to[1]);
}

function documentOf(target: Editor): DocumentV6 {
  return target.query({ type: 'document' });
}

/** The renderer holds exactly the projection of the document's page children. */
function expectSynchronized(target: Editor, renderer: RecordingRenderer) {
  const document = documentOf(target);
  const scene = renderer.mirror.readRetainedScene();
  expect(scene).not.toBeNull();
  const children = document.pages[0]!.children;
  expect(scene!.rootOrder).toEqual(children);
  expect(children.map((id) => scene!.getNode(id))).toEqual(
    children.map((id) => projectNode(document.nodes[id]!, () => null)),
  );
  expect(scene!.nodes.length).toBe(children.length);
}

function attached(paths: 'supported' | 'unsupported' = 'supported') {
  const target = editor();
  const renderer = new RecordingRenderer(paths);
  const events: EditorEvent[] = [];
  target.subscribe((event) => events.push(event));
  const detach = target.attachRenderer(renderer);
  return { target, renderer, events, detach };
}

function diagnostics(events: readonly EditorEvent[]) {
  return events.filter((event) => event.type === 'diagnostic');
}

describe('P5-U4 scene projector', () => {
  it('starts with a full snapshot carrying the document and page identity', () => {
    const target = editor();
    const a = rect(target, 10, 10);
    const renderer = new RecordingRenderer();
    target.attachRenderer(renderer);
    const first = renderer.calls[0]!;
    expect(first.method).toBe('replaceSnapshot');
    if (first.method !== 'replaceSnapshot') return;
    const document = documentOf(target);
    expect(first.input.identity).toEqual({
      documentId: document.id,
      pageId: document.pages[0]!.id,
    });
    expect(first.input.rootOrder).toEqual([a]);
    expect(renderer.calls[1]?.method).toBe('setCamera');
    expectSynchronized(target, renderer);
  });

  it('keeps the renderer equal to the projection through edits, gestures, undo, redo and load', () => {
    const { target, renderer } = attached();
    const a = rect(target, 0, 0);
    const b = triangle(target, 100, 100);
    expectSynchronized(target, renderer);
    ok(target, { type: 'setNodeProps', id: a, props: { opacity: 0.5, visible: false } });
    expectSynchronized(target, renderer);
    // A committed move drag, then a drag cancelled by a tool switch.
    ok(target, { type: 'setSelection', ids: [b] });
    drag(target, [130, 110], [160, 140]);
    expectSynchronized(target, renderer);
    pointer(target, 'pointerdown', 130, 140);
    pointer(target, 'pointermove', 200, 200);
    expectSynchronized(target, renderer);
    ok(target, { type: 'setTool', tool: 'rectangle' });
    expectSynchronized(target, renderer);
    ok(target, { type: 'deleteNodes', ids: [a] });
    expectSynchronized(target, renderer);
    ok(target, { type: 'undo' });
    expectSynchronized(target, renderer);
    ok(target, { type: 'undo' });
    ok(target, { type: 'undo' });
    expectSynchronized(target, renderer);
    ok(target, { type: 'redo' });
    expectSynchronized(target, renderer);
    const other = editor();
    rect(other, 5, 5);
    ok(target, {
      type: 'loadDocument',
      document: JSON.parse(serializeDocument(documentOf(other))),
    });
    expectSynchronized(target, renderer);
    expect(renderer.calls.at(-1)?.method).toBe('replaceSnapshot');
  });

  it('bases each change set on the last result and always raises the revision', () => {
    const { target, renderer } = attached();
    const a = rect(target, 0, 0);
    rect(target, 50, 50);
    ok(target, {
      type: 'setFrames',
      frames: [{ id: a, frame: { x: 1, y: 2, width: 3, height: 4 } }],
    });
    ok(target, { type: 'undo' });
    let last: number | null = null;
    for (const call of renderer.calls) {
      if (call.method === 'setCamera') continue;
      if (call.method === 'applyChanges') {
        expect(call.input.baseRevision).toBe(last);
        expect(call.input.revision).toBeGreaterThan(call.input.baseRevision);
      }
      expect(call.result.status).toBe('applied');
      if (call.result.status === 'applied') last = call.result.current.revision;
    }
    expect(renderer.calls.filter((call) => call.method === 'applyChanges')).toHaveLength(4);
  });

  it('sends an order only when the paint order changes', () => {
    const { target, renderer } = attached();
    const a = rect(target, 0, 0);
    ok(target, { type: 'setNodeProps', id: a, props: { name: 'A' } });
    const changes = renderer.calls.filter((call) => call.method === 'applyChanges');
    expect(changes[0]!.input.orders).toEqual([{ parentId: null, children: [a] }]);
    expect(changes[1]!.input.orders).toEqual([]);
    expect(changes[1]!.input.updated.map((node) => node.id)).toEqual([a]);
  });

  it('is deterministic: the same script gives the same calls, documents and events', () => {
    const run = () => {
      const { target, renderer, events } = attached();
      const a = rect(target, 0, 0);
      triangle(target, 80, 0);
      ok(target, { type: 'setSelection', ids: [a] });
      drag(target, [20, 15], [40, 35]);
      ok(target, { type: 'undo' });
      ok(target, { type: 'redo' });
      return {
        text: serializeDocument(documentOf(target)),
        history: target.query({ type: 'history' }),
        events,
        calls: renderer.calls.map(({ method, input }) => ({ method, input })),
      };
    };
    expect(run()).toEqual(run());
  });

  it('leaves out a rejected node with a diagnostic, and edits continue', () => {
    const { target, renderer, events } = attached();
    const a = rect(target, 0, 0);
    renderer.overrides.applyChanges = {
      status: 'invalid-scene',
      reason: 'invalid-value',
      current: renderer.getSynchronizationState().current,
    };
    ok(target, { type: 'setNodeProps', id: a, props: { opacity: 0.25 } });
    expect(diagnostics(events)).toEqual([
      { type: 'diagnostic', code: 'editor.scene-rejected', reason: 'invalid-value', nodeIds: [a] },
    ]);
    // The diagnostic follows the change event it came from.
    expect(events.at(-1)?.type).toBe('diagnostic');
    expect(events.at(-2)).toMatchObject({ type: 'document', touched: [a] });
    // The stale copy is dropped from the renderer.
    expect(renderer.mirror.readRetainedScene()!.getNode(a)).toBeUndefined();
    expect(documentOf(target).nodes[a]?.opacity).toBe(0.25);
    // The next change to the node sends it again.
    ok(target, { type: 'setNodeProps', id: a, props: { opacity: 0.5 } });
    expectSynchronized(target, renderer);
    const b = rect(target, 60, 60);
    expect(renderer.mirror.readRetainedScene()!.getNode(b)).toBeDefined();
  });

  it('reports unsupported path nodes as a renderer capability fact', () => {
    const { target, renderer, events } = attached('unsupported');
    const a = rect(target, 0, 0);
    const p = triangle(target, 50, 50);
    expect(diagnostics(events)).toEqual([
      {
        type: 'diagnostic',
        code: 'editor.renderer-unsupported',
        reason: 'unsupported-feature',
        nodeIds: [p],
      },
    ]);
    const scene = renderer.mirror.readRetainedScene()!;
    expect(scene.rootOrder).toEqual([a]);
    expect(documentOf(target).pages[0]!.children).toEqual([a, p]);
    rect(target, 100, 0);
    expect(renderer.mirror.readRetainedScene()!.rootOrder).toHaveLength(2);
  });

  it('reports a node rejected in the attach snapshot and keeps it out', () => {
    const target = editor();
    triangle(target, 0, 0);
    const a = rect(target, 100, 0);
    const renderer = new RecordingRenderer('unsupported');
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    target.attachRenderer(renderer);
    expect(diagnostics(events)).toHaveLength(1);
    expect(diagnostics(events)[0]).toMatchObject({ code: 'editor.renderer-unsupported' });
    // The rectangle is kept: only the node rejected on its own is left out.
    expect(renderer.mirror.readRetainedScene()?.rootOrder).toEqual([a]);
    // A later change set still has a base, from the retried snapshot without the rejected node.
    ok(target, { type: 'setNodeProps', id: a, props: { name: 'kept' } });
    expect(renderer.mirror.readRetainedScene()?.getNode(a)).toBeDefined();
  });

  it('isolates a rejected node in a set, so the others still reach the renderer', () => {
    const { target, renderer, events } = attached('unsupported');
    const a = rect(target, 0, 0);
    const p = triangle(target, 50, 50);
    // One change set moves both: the rectangle is applied on its own, the path is left out.
    ok(target, {
      type: 'setFrames',
      frames: [
        { id: a, frame: { x: 5, y: 5, width: 40, height: 30 } },
        { id: p, frame: { x: 70, y: 70, width: 60, height: 40 } },
      ],
    });
    expect(renderer.mirror.readRetainedScene()!.getNode(a)?.transform).toEqual([1, 0, 0, 1, 5, 5]);
    expect(renderer.mirror.readRetainedScene()!.rootOrder).toEqual([a]);
    expect(diagnostics(events).map((event) => event.nodeIds)).toEqual([[p], [p]]);
  });

  it('drops the stale copy of a rejected update and keeps it out of later sets', () => {
    const { target, renderer, events } = attached();
    const a = rect(target, 0, 0);
    const b = rect(target, 50, 0);
    const reject = renderer.applyChanges.bind(renderer);
    // The renderer rejects any change set that sends `b` with the new opacity.
    renderer.applyChanges = (changes) =>
      [...changes.inserted, ...changes.updated].some(
        (node) => node.id === b && node.opacity === 0.5,
      )
        ? {
            status: 'invalid-scene',
            reason: 'invalid-value',
            current: renderer.getSynchronizationState().current,
          }
        : reject(changes);
    ok(target, { type: 'setSelection', ids: [a, b] });
    ok(target, { type: 'setNodeProps', id: b, props: { opacity: 0.5 } });
    ok(target, {
      type: 'setFrames',
      frames: [
        { id: a, frame: { x: 1, y: 1, width: 40, height: 30 } },
        { id: b, frame: { x: 51, y: 1, width: 40, height: 30 } },
      ],
    });
    const scene = renderer.mirror.readRetainedScene()!;
    expect(scene.rootOrder).toEqual([a]);
    expect(scene.getNode(a)?.transform).toEqual([1, 0, 0, 1, 1, 1]);
    expect(diagnostics(events)).toEqual([
      { type: 'diagnostic', code: 'editor.scene-rejected', reason: 'invalid-value', nodeIds: [b] },
      { type: 'diagnostic', code: 'editor.scene-rejected', reason: 'invalid-value', nodeIds: [b] },
    ]);
  });

  it('re-attaching a renderer that already holds the scene keeps it synchronized', () => {
    const { target, renderer, events, detach } = attached();
    for (let i = 0; i < 5; i += 1) rect(target, i * 50, 0);
    detach();
    target.attachRenderer(renderer);
    rect(target, 0, 100);
    expectSynchronized(target, renderer);
    expect(diagnostics(events)).toEqual([]);
  });

  it('a renderer handed to a new editor with the same document ID shows the new document', () => {
    const { target, renderer } = attached();
    rect(target, 0, 0);
    rect(target, 50, 0);
    const next = editor();
    expect(documentOf(next).id).toBe(documentOf(target).id);
    const events: EditorEvent[] = [];
    next.subscribe((event) => events.push(event));
    next.attachRenderer(renderer);
    expectSynchronized(next, renderer);
    expect(diagnostics(events)).toEqual([]);
  });

  it('resyncs when an isolated retry gets resync-required', () => {
    const { target, renderer, events } = attached();
    const a = rect(target, 0, 0);
    const b = rect(target, 50, 0);
    const results = [
      {
        status: 'invalid-scene' as const,
        reason: 'invalid-value' as const,
        current: renderer.getSynchronizationState().current,
      },
      { status: 'resync-required' as const, current: null },
    ];
    const apply = renderer.applyChanges.bind(renderer);
    renderer.applyChanges = (changes) => results.shift() ?? apply(changes);
    ok(target, {
      type: 'setFrames',
      frames: [
        { id: a, frame: { x: 1, y: 1, width: 40, height: 30 } },
        { id: b, frame: { x: 51, y: 1, width: 40, height: 30 } },
      ],
    });
    expect(renderer.calls.at(-1)?.method).toBe('replaceSnapshot');
    expectSynchronized(target, renderer);
    expect(diagnostics(events)).toEqual([]);
  });

  it('reports a node rejected during isolation before a later retry forces a resync', () => {
    const { target, renderer, events } = attached();
    const a = rect(target, 0, 0);
    const b = rect(target, 50, 0);
    const current = () => renderer.getSynchronizationState().current;
    const results = [
      { status: 'invalid-scene' as const, reason: 'invalid-value' as const, current: current() },
      { status: 'invalid-scene' as const, reason: 'invalid-value' as const, current: current() },
      { status: 'resync-required' as const, current: null },
    ];
    const apply = renderer.applyChanges.bind(renderer);
    renderer.applyChanges = (changes) => results.shift() ?? apply(changes);
    ok(target, {
      type: 'setFrames',
      frames: [
        { id: a, frame: { x: 1, y: 1, width: 40, height: 30 } },
        { id: b, frame: { x: 51, y: 1, width: 40, height: 30 } },
      ],
    });
    expect(diagnostics(events)).toEqual([
      { type: 'diagnostic', code: 'editor.scene-rejected', reason: 'invalid-value', nodeIds: [a] },
    ]);
    const scene = renderer.mirror.readRetainedScene()!;
    expect(scene.rootOrder).toEqual([b]);
    expect(scene.getNode(b)?.transform).toEqual([1, 0, 0, 1, 51, 1]);
  });

  it('resyncs after a rejected removal, so the renderer drops the removed node', () => {
    const { target, renderer, events } = attached();
    const a = rect(target, 0, 0);
    rect(target, 50, 0);
    renderer.overrides.applyChanges = {
      status: 'invalid-scene',
      reason: 'unknown-node',
      current: renderer.getSynchronizationState().current,
    };
    ok(target, { type: 'deleteNodes', ids: [a] });
    expectSynchronized(target, renderer);
    expect(diagnostics(events)).toMatchObject([{ code: 'editor.scene-rejected', nodeIds: [a] }]);
  });

  it('follows a drag cancelled with Escape', () => {
    const { target, renderer } = attached();
    const a = rect(target, 0, 0);
    ok(target, { type: 'setSelection', ids: [a] });
    pointer(target, 'pointerdown', 20, 15);
    pointer(target, 'pointermove', 60, 55);
    ok(target, { type: 'input', event: { kind: 'keydown', key: 'Escape', modifiers: none } });
    expect(documentOf(target).nodes[a]?.frame).toMatchObject({ x: 0, y: 0 });
    expectSynchronized(target, renderer);
  });

  it('a renderer that keeps asking for resync is retried at the next change, not in a loop', () => {
    const { target, renderer } = attached();
    rect(target, 0, 0);
    renderer.applyChanges = () => ({ status: 'resync-required', current: null });
    renderer.replaceSnapshot = () => ({ status: 'resync-required', current: null });
    rect(target, 50, 0);
    expect(documentOf(target).pages[0]!.children).toHaveLength(2);
  });

  it('sends a full snapshot after resync-required', () => {
    const { target, renderer } = attached();
    rect(target, 0, 0);
    renderer.overrides.applyChanges = { status: 'resync-required', current: null };
    rect(target, 50, 0);
    const methods = renderer.calls.map((call) => call.method);
    expect(methods.slice(-2)).toEqual(['applyChanges', 'replaceSnapshot']);
    expectSynchronized(target, renderer);
  });

  it('sends the viewport, and an invalid camera leaves it unchanged', () => {
    const { target, renderer } = attached();
    ok(target, { type: 'setViewport', camera: { position: { x: 5, y: 6 }, zoom: 2 } });
    expect(renderer.getCameraState()?.camera).toEqual({ position: { x: 5, y: 6 }, zoom: 2 });
    renderer.overrides.setCamera = { status: 'invalid-camera', reason: 'invalid-value' };
    const result = target.execute({
      type: 'setViewport',
      camera: { position: { x: 9, y: 9 }, zoom: 3 },
    });
    expect(result).toEqual({ ok: false, code: 'editor.invalid-camera' });
    expect(target.query({ type: 'viewport' })).toEqual({ position: { x: 5, y: 6 }, zoom: 2 });
  });

  it('detaches a disposed renderer and on request, and edits continue', () => {
    const { target, renderer } = attached();
    rect(target, 0, 0);
    renderer.dispose();
    rect(target, 50, 0);
    const count = renderer.calls.length;
    rect(target, 90, 0);
    ok(target, { type: 'setViewport', camera: { position: { x: 1, y: 1 }, zoom: 1 } });
    expect(renderer.calls).toHaveLength(count);
    expect(documentOf(target).pages[0]!.children).toHaveLength(3);

    const second = attached();
    second.detach();
    const before = second.renderer.calls.length;
    rect(second.target, 0, 0);
    expect(second.renderer.calls).toHaveLength(before);
  });

  it('a second attach replaces the first renderer', () => {
    const { target, renderer, detach } = attached();
    const next = new RecordingRenderer();
    target.attachRenderer(next);
    const count = renderer.calls.length;
    rect(target, 0, 0);
    expect(renderer.calls).toHaveLength(count);
    expectSynchronized(target, next);
    // The first detach function no longer detaches the current renderer.
    detach();
    rect(target, 50, 0);
    expectSynchronized(target, next);
  });

  it('scales path points by the frame and keeps the stroke width in page units', () => {
    const { target, renderer } = attached();
    const p = triangle(target, 0, 0);
    ok(target, {
      type: 'setFrames',
      frames: [{ id: p, frame: { x: 10, y: 20, width: 120, height: 20 } }],
    });
    const node = renderer.mirror.readRetainedScene()!.getNode(p)!;
    expect(node.transform).toEqual([1, 0, 0, 1, 10, 20]);
    if (node.kind !== 'path') throw new Error('expected a path node');
    expect(node.geometry.points).toEqual([0, 0, 120, 0, 60, 20]);
    expect(node.style.stroke?.width).toBe(3);
  });
});
