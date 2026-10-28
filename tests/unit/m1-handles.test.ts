import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  starExtension,
  type Editor,
  type Modifiers,
  type PagePoint,
} from '../../packages/editor-core/src/index.js';
// Source imports: the placement matrices and the select tool's handle helpers are internal.
import { apply, localTransform, multiply } from '../../packages/editor-core/src/geometry.js';
import {
  HANDLES,
  activeHandles,
  handleBoxOf,
  handlePoint,
} from '../../packages/editor-core/src/tools.js';
import { normalizeRotation } from '../../packages/model/src/index.js';

// MVP M1-U5: the `handles` query gives hosts the select tool's handle box in page space, so the
// next-host overlay draws nested and rotated selections where the tool picks their handles.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };

type Loose = { nodes: Record<string, { rotation: number }> };

async function fixture(mutate: (document: Loose) => void = () => {}): Promise<Editor> {
  const text = await readFile(path.join(root, 'tests/fixtures/m1-model/containers.json'), 'utf8');
  const document = JSON.parse(text) as Loose;
  mutate(document);
  const editor = createEditor({ extensions: [starExtension] });
  expect(editor.execute({ type: 'loadDocument', document }).ok).toBe(true);
  return editor;
}

/** The tool's own handle points for the current selection, active handles only. */
function toolHandles(editor: Editor): PagePoint[] {
  const box = handleBoxOf(
    editor.query({ type: 'document' }),
    editor.query({ type: 'activePage' }),
    editor.query({ type: 'selection' }),
  )!;
  return activeHandles(box.box).map((handle) => handlePoint(box, handle));
}

/** The four page-space corners of a node with local-to-page map `m` and size `w` × `h`. */
function box(m: ReturnType<typeof localTransform>, w: number, h: number): PagePoint[] {
  return [apply(m, 0, 0), apply(m, w, 0), apply(m, w, h), apply(m, 0, h)];
}

function select(editor: Editor, ids: string[]) {
  expect(editor.execute({ type: 'setSelection', ids }).ok).toBe(true);
  return editor.query({ type: 'handles' });
}

function close(actual: readonly PagePoint[], expected: readonly PagePoint[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, index) => {
    expect(point.x).toBeCloseTo(expected[index]!.x, 9);
    expect(point.y).toBeCloseTo(expected[index]!.y, 9);
  });
}

function pointer(editor: Editor, kind: 'pointerdown' | 'pointermove' | 'pointerup', p: PagePoint) {
  expect(editor.execute({ type: 'input', event: { kind, point: p, modifiers: none } }).ok).toBe(
    true,
  );
}

describe('M1-U5 handles query', () => {
  it('is null for an empty selection', async () => {
    const editor = await fixture();
    expect(editor.query({ type: 'handles' })).toBeNull();
  });

  it('gives a page-aligned box for page-root nodes with rotation 0 and for multi-selections', async () => {
    const editor = await fixture();
    expect(select(editor, ['e1'])).toMatchObject({
      corners: [
        { x: 20, y: 200 },
        { x: 100, y: 200 },
        { x: 100, y: 240 },
        { x: 20, y: 240 },
      ],
      rotation: 0,
    });
    const multi = select(editor, ['e1', 'l1'])!;
    expect(multi.rotation).toBe(0);
    expect(multi.corners).toEqual([
      { x: 20, y: 200 },
      { x: 270, y: 200 },
      { x: 270, y: 240 },
      { x: 20, y: 240 },
    ]);
    expect(Object.isFrozen(multi) && Object.isFrozen(multi.corners)).toBe(true);
  });

  it('follows a rotated top-level frame and a node nested inside it, in page space', async () => {
    const editor = await fixture();
    const document = editor.query({ type: 'document' });
    const f1 = document.nodes.f1!;
    const frame = localTransform(f1.frame, f1.rotation);
    const own = select(editor, ['f1'])!;
    expect(own.rotation).toBe(0.25);
    close(own.corners, box(frame, 200, 150));
    // r1 sits at (-20, 20) in f1's local space, partly clipped; its box is not page-aligned.
    const r1 = document.nodes.r1!;
    const nested = select(editor, ['r1'])!;
    expect(nested.rotation).toBe(0.25);
    close(nested.corners, box(multiply(frame, localTransform(r1.frame, r1.rotation)), 80, 40));
  });

  it('puts the corner handles where the select tool picks them', async () => {
    const editor = await fixture();
    expect(editor.execute({ type: 'setTool', tool: 'select' }).ok).toBe(true);
    const { corners } = select(editor, ['f1'])!;
    const corner = corners[2];
    // A drag of the bottom-right handle along the frame's own x axis widens it by 20.
    const along = { x: corner.x + 20 * Math.cos(0.25), y: corner.y + 20 * Math.sin(0.25) };
    pointer(editor, 'pointerdown', corner);
    pointer(editor, 'pointermove', along);
    pointer(editor, 'pointerup', along);
    const f1 = editor.query({ type: 'node', id: 'f1' })!;
    expect(f1.rotation).toBe(0.25);
    expect(f1.frame.width).toBeCloseTo(220, 9);
    expect(f1.frame.height).toBeCloseTo(150, 9);
    // The query follows the resized frame; its top-left corner stays fixed.
    const after = editor.query({ type: 'handles' })!;
    close([after.corners[0]], [corners[0]]);
    close([after.corners[2]], [along]);
  });

  it('gives a rotated multi-selection the page-aligned bounds of its rotated corners', async () => {
    const editor = await fixture();
    const f1 = editor.query({ type: 'node', id: 'f1' })!;
    const points = [
      ...box(localTransform(f1.frame, f1.rotation), 200, 150),
      { x: 20, y: 200 },
      { x: 100, y: 240 },
    ];
    const minX = Math.min(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxX = Math.max(...points.map((p) => p.x));
    const maxY = Math.max(...points.map((p) => p.y));
    const handles = select(editor, ['f1', 'e1'])!;
    expect(handles.rotation).toBe(0);
    expect(handles.corners).toEqual([
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ]);
  });

  it('normalizes a nested turn that leaves (−π, π]', async () => {
    // g1 at −3 and r3 at −0.5 inside it turn r3 by −3.5 on the page.
    const editor = await fixture((document) => {
      document.nodes.g1!.rotation = -3;
      document.nodes.r3!.rotation = -0.5;
    });
    const g1 = editor.query({ type: 'node', id: 'g1' })!;
    const r3 = editor.query({ type: 'node', id: 'r3' })!;
    const handles = select(editor, ['r3'])!;
    expect(handles.rotation).toBe(normalizeRotation(-3.5));
    expect(handles.rotation).toBeCloseTo(2 * Math.PI - 3.5, 12);
    const m = multiply(
      localTransform(g1.frame, g1.rotation),
      localTransform(r3.frame, r3.rotation),
    );
    close(handles.corners, box(m, r3.frame.width, r3.frame.height));
  });

  it('lists all eight handles at the select tool’s own handle points', async () => {
    const editor = await fixture();
    for (const ids of [['e1'], ['f1'], ['r1'], ['r3'], ['e1', 'l1'], ['f1', 'e1']]) {
      const handles = select(editor, ids)!;
      expect(handles.handles, ids.join()).toHaveLength(8);
      expect(handles.handles, ids.join()).toEqual(toolHandles(editor));
      // Clockwise from the top-left corner: the corners and the edge midpoints between them.
      const [tl, tr, br, bl] = handles.corners;
      const mid = (a: PagePoint, b: PagePoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      close(handles.handles, [tl, mid(tl, tr), tr, mid(tr, br), br, mid(br, bl), bl, mid(bl, tl)]);
    }
    expect(HANDLES).toHaveLength(8);
  });

  it('drops the edge handles that scale no axis, as the tool does, for a zero-height line', async () => {
    const editor = await fixture();
    const created = editor.execute({
      type: 'createLine',
      start: { x: 300, y: 260 },
      end: { x: 400, y: 260 },
    });
    if (!created.ok) throw new Error(created.code);
    const handles = select(editor, [...created.ids])!;
    expect(handles.corners).toEqual([
      { x: 300, y: 260 },
      { x: 400, y: 260 },
      { x: 400, y: 260 },
      { x: 300, y: 260 },
    ]);
    // No top or bottom midpoint: they would scale only the zero-size y axis.
    expect(handles.handles).toEqual([
      { x: 300, y: 260 },
      { x: 400, y: 260 },
      { x: 400, y: 260 },
      { x: 400, y: 260 },
      { x: 300, y: 260 },
      { x: 300, y: 260 },
    ]);
    expect(handles.handles).toEqual(toolHandles(editor));
    // A press on the dropped top midpoint starts no resize: it moves the line instead.
    editor.execute({ type: 'setTool', tool: 'select' });
    const before = editor.query({ type: 'node', id: created.ids[0]! })!.frame;
    pointer(editor, 'pointerdown', { x: 350, y: 260 });
    pointer(editor, 'pointermove', { x: 350, y: 270 });
    pointer(editor, 'pointerup', { x: 350, y: 270 });
    expect(editor.query({ type: 'node', id: created.ids[0]! })!.frame).toEqual({
      ...before,
      y: before.y + 10,
    });
  });
});
