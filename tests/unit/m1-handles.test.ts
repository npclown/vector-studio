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
// Source import: the placement matrices are package-internal.
import { apply, localTransform, multiply } from '../../packages/editor-core/src/geometry.js';

// MVP M1-U5: the `handles` query gives hosts the select tool's handle box in page space, so the
// next-host overlay draws nested and rotated selections where the tool picks their handles.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };

async function fixture(): Promise<Editor> {
  const text = await readFile(path.join(root, 'tests/fixtures/m1-model/containers.json'), 'utf8');
  const editor = createEditor({ extensions: [starExtension] });
  expect(editor.execute({ type: 'loadDocument', document: JSON.parse(text) }).ok).toBe(true);
  return editor;
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
    expect(select(editor, ['e1'])).toEqual({
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
    const box = (m: typeof frame, w: number, h: number) => [
      apply(m, 0, 0),
      apply(m, w, 0),
      apply(m, w, h),
      apply(m, 0, h),
    ];
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
});
