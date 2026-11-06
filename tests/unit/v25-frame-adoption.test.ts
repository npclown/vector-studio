import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type PagePoint,
} from '@vector-studio/editor-core';
import { describe, expect, it } from 'vitest';

// V-25 slice 4 (frame adoption): with `adoptIntoFrames`, a shape drawn inside a frame becomes the
// frame's child, and a move dropped on a frame moves the dragged nodes into it (or out of their
// frame onto the page), each in one undo step with page placement kept. Without the option the
// M2 behaviour holds (M2-Q10).

const none = { shift: false, alt: false, meta: false, ctrl: false };

/** Page p1: frame F (0,0 400×300) holding frame G (50,50 100×100), and frame H (500,0 200×200). */
function editor(adoptIntoFrames?: boolean) {
  const target = createEditor({
    document: {
      schemaVersion: 6,
      id: 'doc',
      pages: [{ id: 'p1', name: 'Page 1', children: [] }],
      nodes: {},
    },
    ids: createCounterIdSource('n'),
    ...(adoptIntoFrames === undefined ? {} : { adoptIntoFrames }),
  });
  ok(target, { type: 'setViewportSize', width: 1200, height: 800 });
  ok(target, { type: 'setSnapping', enabled: false });
  const [f] = ok(target, {
    type: 'createFrame',
    frame: { x: 0, y: 0, width: 400, height: 300 },
    name: 'F',
  });
  const [g] = ok(target, {
    type: 'createFrame',
    frame: { x: 50, y: 50, width: 100, height: 100 },
    name: 'G',
    parent: f!,
  });
  const [h] = ok(target, {
    type: 'createFrame',
    frame: { x: 500, y: 0, width: 200, height: 200 },
    name: 'H',
  });
  ok(target, { type: 'setSelection', ids: [] });
  return { target, f: f!, g: g!, h: h!, base: target.getSnapshot().history.undoDepth };
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
  return result.ids;
}

function pointer(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  point: PagePoint,
) {
  ok(target, { type: 'input', event: { kind, point, modifiers: none } });
}

function drag(target: Editor, from: PagePoint, to: PagePoint): void {
  pointer(target, 'pointerdown', from);
  pointer(target, 'pointermove', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
  pointer(target, 'pointermove', to);
  pointer(target, 'pointerup', to);
}

const node = (target: Editor, id: string) => target.getSnapshot().document.nodes[id]!;
const pageChildren = (target: Editor) => target.getSnapshot().document.pages[0]!.children;

describe('V-25 drawing into frames', () => {
  it('a rectangle drawn inside a nested frame becomes its child, in local coordinates', () => {
    const { target, g, base } = editor(true);
    ok(target, { type: 'setTool', tool: 'rectangle' });
    drag(target, { x: 60, y: 70 }, { x: 90, y: 110 });
    const [id] = target.getSnapshot().selection;
    expect(node(target, id!)).toMatchObject({
      parent: g,
      frame: { x: 10, y: 20, width: 30, height: 40 },
      rotation: 0,
    });
    expect(target.getSnapshot().history.undoDepth).toBe(base + 1);
    ok(target, { type: 'undo' });
    expect(target.getSnapshot().document.nodes[id!]).toBeUndefined();
  });

  it('outside every frame it goes on the page; inside a frame but not a nested one, the frame', () => {
    const { target, f } = editor(true);
    ok(target, { type: 'setTool', tool: 'ellipse' });
    drag(target, { x: 200, y: 200 }, { x: 250, y: 250 });
    const inF = target.getSnapshot().selection[0]!;
    expect(node(target, inF).parent).toBe(f);
    ok(target, { type: 'setTool', tool: 'ellipse' });
    drag(target, { x: 450, y: 400 }, { x: 480, y: 450 });
    const onPage = target.getSnapshot().selection[0]!;
    expect(node(target, onPage).parent).toBe('p1');
    expect(node(target, onPage).frame).toEqual({ x: 450, y: 400, width: 30, height: 50 });
  });

  it('a line and a path take the frame under their start', () => {
    const { target, h } = editor(true);
    ok(target, { type: 'setTool', tool: 'line' });
    drag(target, { x: 510, y: 10 }, { x: 590, y: 10 });
    expect(node(target, target.getSnapshot().selection[0]!).parent).toBe(h);
    ok(target, { type: 'setTool', tool: 'path' });
    for (const point of [
      { x: 520, y: 20 },
      { x: 580, y: 20 },
    ]) {
      pointer(target, 'pointerdown', point);
      pointer(target, 'pointerup', point);
    }
    ok(target, { type: 'input', event: { kind: 'keydown', key: 'Enter', modifiers: none } });
    expect(node(target, target.getSnapshot().selection[0]!).parent).toBe(h);
  });

  it('without the option a shape drawn inside a frame stays on the page (M2)', () => {
    const { target } = editor();
    ok(target, { type: 'setTool', tool: 'rectangle' });
    drag(target, { x: 60, y: 70 }, { x: 90, y: 110 });
    expect(node(target, target.getSnapshot().selection[0]!).parent).toBe('p1');
  });
});

describe('V-25 dropping into and out of frames', () => {
  function withRectangle(adopt?: boolean) {
    const scene = editor(adopt);
    const [rect] = ok(scene.target, {
      type: 'createRectangle',
      frame: { x: 800, y: 400, width: 20, height: 20 },
    });
    ok(scene.target, { type: 'setSelection', ids: [] });
    return { ...scene, rect: rect!, base: scene.target.getSnapshot().history.undoDepth };
  }

  it('a rectangle dragged onto a frame moves into it at the same page place, one step', () => {
    const { target, h, rect, base } = withRectangle(true);
    drag(target, { x: 810, y: 410 }, { x: 610, y: 110 });
    expect(node(target, rect)).toMatchObject({
      parent: h,
      frame: { x: 100, y: 100, width: 20, height: 20 },
    });
    expect(target.getSnapshot().history.undoDepth).toBe(base + 1);
    ok(target, { type: 'undo' });
    expect(node(target, rect)).toMatchObject({
      parent: 'p1',
      frame: { x: 800, y: 400, width: 20, height: 20 },
    });
  });

  it('dragged out of its frame onto empty canvas it moves to the page', () => {
    const { target, h, rect } = withRectangle(true);
    drag(target, { x: 810, y: 410 }, { x: 610, y: 110 });
    expect(node(target, rect).parent).toBe(h);
    drag(target, { x: 610, y: 110 }, { x: 610, y: 510 });
    expect(node(target, rect)).toMatchObject({
      parent: 'p1',
      frame: { x: 600, y: 500, width: 20, height: 20 },
    });
    expect(pageChildren(target).at(-1)).toBe(rect);
  });

  it('a top-level frame partly over another frame stays an artboard; wholly inside, it nests', () => {
    const { target, f, h } = withRectangle(true);
    drag(target, { x: 690, y: 190 }, { x: 300, y: 350 });
    // H moved by (-390, +160): it hangs below F's bottom edge, so it stays on the page.
    expect(node(target, h)).toMatchObject({ parent: 'p1', frame: { x: 110, y: 160 } });
    drag(target, { x: 300, y: 350 }, { x: 300, y: 250 });
    // Now H (110,60 200×200) lies inside F (0,0 400×300): it becomes F's child, in place.
    expect(node(target, h)).toMatchObject({ parent: f, frame: { x: 110, y: 60 } });
  });

  it('without the option a drop changes no parent (M2-Q10)', () => {
    const { target, rect } = withRectangle();
    drag(target, { x: 810, y: 410 }, { x: 610, y: 110 });
    expect(node(target, rect)).toMatchObject({
      parent: 'p1',
      frame: { x: 600, y: 100, width: 20, height: 20 },
    });
  });
});

describe('V-25 adoption: rotation, scope, duplicates and groups', () => {
  it('draws in a rotated frame in its axes', () => {
    const { target, h } = editor(true);
    ok(target, {
      type: 'setFrames',
      frames: [{ id: h, frame: { x: 500, y: 0, width: 200, height: 200 }, rotation: Math.PI / 2 }],
    });
    ok(target, { type: 'setTool', tool: 'rectangle' });
    // H turned 90° about its centre (600, 100): page (600, 100) is local (100, 100) and page
    // (580, 140) local (140, 120).
    drag(target, { x: 600, y: 100 }, { x: 580, y: 140 });
    const id = target.getSnapshot().selection[0]!;
    const made = node(target, id);
    expect(made.parent).toBe(h);
    expect(made.rotation).toBe(0);
    expect(made.frame.x).toBeCloseTo(100);
    expect(made.frame.y).toBeCloseTo(100);
    expect(made.frame.width).toBeCloseTo(40);
    expect(made.frame.height).toBeCloseTo(20);
  });

  it('in a frame scope, a point outside the scope never reaches a child frame it clips', () => {
    const { target, f } = editor(true);
    // K overflows F's right edge; with F as the scope, a press in K's clipped part is the page's.
    const [k] = ok(target, {
      type: 'createFrame',
      frame: { x: 350, y: 0, width: 300, height: 100 },
      parent: f,
    });
    ok(target, { type: 'setScope', id: f });
    ok(target, { type: 'setTool', tool: 'rectangle' });
    drag(target, { x: 450, y: 400 }, { x: 470, y: 420 });
    expect(node(target, target.getSnapshot().selection[0]!).parent).toBe('p1');
    ok(target, { type: 'setScope', id: f });
    ok(target, { type: 'setTool', tool: 'rectangle' });
    drag(target, { x: 450, y: 20 }, { x: 470, y: 40 });
    expect(node(target, target.getSnapshot().selection[0]!).parent).not.toBe(k);
    ok(target, { type: 'setScope', id: f });
    ok(target, { type: 'setTool', tool: 'rectangle' });
    drag(target, { x: 360, y: 20 }, { x: 380, y: 40 });
    expect(node(target, target.getSnapshot().selection[0]!).parent).toBe(k);
  });

  it('a node dropped out of the scope frame ends the scope', () => {
    const { target, f } = editor(true);
    const [r] = ok(target, {
      type: 'createRectangle',
      frame: { x: 200, y: 200, width: 20, height: 20 },
      parent: f,
    });
    ok(target, { type: 'setScope', id: f });
    ok(target, { type: 'setSelection', ids: [r!] });
    drag(target, { x: 210, y: 210 }, { x: 210, y: 510 });
    expect(node(target, r!).parent).toBe('p1');
    expect(target.getSnapshot().scope).toBeNull();
    expect(target.getSnapshot().selection).toEqual([r]);
  });

  it('an Alt-drag drops the copy into the frame and leaves the original, one step', () => {
    const { target, h } = editor(true);
    const [r] = ok(target, {
      type: 'createRectangle',
      frame: { x: 800, y: 400, width: 20, height: 20 },
    });
    const base = target.getSnapshot().history.undoDepth;
    const alt = { ...none, alt: true };
    for (const [kind, point] of [
      ['pointerdown', { x: 810, y: 410 }],
      ['pointermove', { x: 700, y: 300 }],
      ['pointermove', { x: 610, y: 110 }],
      ['pointerup', { x: 610, y: 110 }],
    ] as const) {
      ok(target, { type: 'input', event: { kind, point, modifiers: alt } });
    }
    const [copy] = target.getSnapshot().selection;
    expect(copy).not.toBe(r);
    expect(node(target, copy!).parent).toBe(h);
    expect(node(target, r!).parent).toBe('p1');
    expect(target.getSnapshot().history.undoDepth).toBe(base + 1);
  });

  it("a group's child dropped on a frame stays in its group; the group itself moves in", () => {
    const { target, h } = editor(true);
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 800, y: 400, width: 20, height: 20 },
    });
    const [b] = ok(target, {
      type: 'createRectangle',
      frame: { x: 850, y: 400, width: 20, height: 20 },
    });
    const [group] = ok(target, { type: 'groupNodes', ids: [a!, b!], kind: 'group' });
    ok(target, { type: 'setScope', id: group! });
    ok(target, { type: 'setSelection', ids: [a!] });
    drag(target, { x: 810, y: 410 }, { x: 610, y: 110 });
    expect(node(target, a!).parent).toBe(group);
    ok(target, { type: 'setScope', id: null });
    ok(target, { type: 'setSelection', ids: [] });
    drag(target, { x: 860, y: 410 }, { x: 610, y: 110 });
    expect(node(target, group!).parent).toBe(h);
  });
});
