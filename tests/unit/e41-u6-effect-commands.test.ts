import { serializeDocument, type NodeV8 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '../../packages/editor-core/src/index.js';
import {
  DEFAULT_DROP_SHADOW,
  DEFAULT_LAYER_BLUR,
} from '../../packages/editor-core/src/effect-commands.js';
import { visualBounds } from '../../packages/editor-core/src/visual-bounds.js';

// E41-U6 (E41 contract, sections 5.5 and 6): `addEffect`, `setEffect` and `removeEffect`, and
// the visual bounds with effects. E41-A11.

function editor(): Editor {
  return createEditor({ ids: createCounterIdSource('n') });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function rect(target: Editor, x = 0, y = 0): string {
  return ok(target, { type: 'createRectangle', frame: { x, y, width: 100, height: 50 } })[0]!;
}

function node(target: Editor, id: string): NodeV8 {
  return target.query({ type: 'node', id })!;
}

const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const revision = (target: Editor) => target.getSnapshot().revision;

describe('E41-A11 addEffect', () => {
  it('appends the section 6 defaults to each node, one undo step', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 200);
    const before = text(target);
    ok(target, { type: 'addEffect', ids: [a, b], kind: 'dropShadow' });
    expect(DEFAULT_DROP_SHADOW).toEqual({
      kind: 'dropShadow',
      visible: true,
      color: { r: 0, g: 0, b: 0, a: 0.25 },
      offsetX: 0,
      offsetY: 4,
      radius: 8,
    });
    expect(node(target, a).effects).toEqual([DEFAULT_DROP_SHADOW]);
    expect(node(target, b).effects).toEqual([DEFAULT_DROP_SHADOW]);
    ok(target, { type: 'addEffect', ids: [a], kind: 'layerBlur' });
    expect(DEFAULT_LAYER_BLUR).toEqual({ kind: 'layerBlur', visible: true, radius: 4 });
    expect(node(target, a).effects).toEqual([DEFAULT_DROP_SHADOW, DEFAULT_LAYER_BLUR]);
    ok(target, { type: 'undo' });
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
  });

  it('refuses past E41-S3 with editor.effect-limit and no change', () => {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 200);
    ok(target, { type: 'addEffect', ids: [a], kind: 'layerBlur' });
    const before = text(target);
    const r = revision(target);
    // One node already has a blur: nothing is added to either.
    expect(target.execute({ type: 'addEffect', ids: [b, a], kind: 'layerBlur' })).toEqual({
      ok: false,
      code: 'editor.effect-limit',
      path: `/nodes/${a}/effects`,
    });
    for (let k = 0; k < 7; k += 1) ok(target, { type: 'addEffect', ids: [a], kind: 'dropShadow' });
    expect(node(target, a).effects).toHaveLength(8);
    const full = text(target);
    expect(target.execute({ type: 'addEffect', ids: [a], kind: 'dropShadow' })).toMatchObject({
      code: 'editor.effect-limit',
    });
    expect(text(target)).toBe(full);
    expect(before).not.toBe(full);
    expect(r).toBeLessThan(revision(target));
  });

  it('malformed commands', () => {
    const target = editor();
    const a = rect(target);
    expect(target.execute({ type: 'addEffect', ids: [], kind: 'dropShadow' })).toMatchObject({
      code: 'editor.invalid-command',
      path: '/ids',
    });
    expect(
      target.execute({ type: 'addEffect', ids: [a], kind: 'glow' as 'layerBlur' }),
    ).toMatchObject({ code: 'editor.invalid-command', path: '/kind' });
    expect(target.execute({ type: 'addEffect', ids: ['x'], kind: 'dropShadow' })).toMatchObject({
      code: 'editor.unknown-node',
    });
  });
});

describe('E41-A11 setEffect and removeEffect', () => {
  function scene() {
    const target = editor();
    const a = rect(target);
    const b = rect(target, 200);
    const c = rect(target, 400);
    ok(target, { type: 'addEffect', ids: [a, b], kind: 'dropShadow' });
    ok(target, { type: 'addEffect', ids: [b], kind: 'layerBlur' });
    ok(target, { type: 'addEffect', ids: [c], kind: 'layerBlur' });
    return { target, a, b, c };
  }

  it('patches the same index of each node that has it, one step', () => {
    const { target, a, b, c } = scene();
    const before = text(target);
    ok(target, { type: 'setEffect', ids: [a, b, c], index: 1, patch: { radius: 12 } });
    const once = text(target);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
    ok(target, { type: 'redo' });
    expect(text(target)).toBe(once);
    // `a` has no index 1; `b` and `c` have a blur there.
    expect(node(target, a).effects).toEqual([DEFAULT_DROP_SHADOW]);
    expect(node(target, b).effects[1]).toEqual({ ...DEFAULT_LAYER_BLUR, radius: 12 });
    // Index 0: a shadow on `a` and `b`, a blur on `c`; `offsetY` applies to the shadows only.
    ok(target, { type: 'setEffect', ids: [a, b, c], index: 0, patch: { offsetY: -2, radius: 1 } });
    expect(node(target, a).effects[0]).toEqual({ ...DEFAULT_DROP_SHADOW, offsetY: -2, radius: 1 });
    expect(node(target, c).effects[0]).toEqual({ ...DEFAULT_LAYER_BLUR, radius: 1 });
  });

  it('a visible toggle is a `visible` patch; an unchanged value records no step', () => {
    const { target, a } = scene();
    ok(target, { type: 'setEffect', ids: [a], index: 0, patch: { visible: false } });
    expect(node(target, a).effects[0]!.visible).toBe(false);
    const r = revision(target);
    ok(target, { type: 'setEffect', ids: [a], index: 0, patch: { visible: false } });
    expect(revision(target)).toBe(r);
    // The same colour with its keys in another order is no change either (review S1).
    ok(target, {
      type: 'setEffect',
      ids: [a],
      index: 0,
      patch: { color: { a: 0.25, b: 0, g: 0, r: 0 } },
    });
    expect(revision(target)).toBe(r);
    // The undo goes back past the toggle, not a no-op step.
    ok(target, { type: 'undo' });
    expect(node(target, a).effects[0]!.visible).toBe(true);
  });

  it('refusals', () => {
    const { target, a, c } = scene();
    const before = text(target);
    const refused = (command: Command, code: string, path?: string) =>
      expect(target.execute(command)).toEqual({ ok: false, code, ...(path ? { path } : {}) });
    refused(
      { type: 'setEffect', ids: [a], index: 5, patch: { radius: 1 } },
      'editor.invalid-command',
      '/index',
    );
    refused(
      { type: 'setEffect', ids: [a], index: -1, patch: { radius: 1 } },
      'editor.invalid-command',
      '/index',
    );
    refused(
      { type: 'setEffect', ids: [a], index: 0, patch: {} },
      'editor.invalid-command',
      '/patch',
    );
    // A blur has no colour.
    refused(
      { type: 'setEffect', ids: [c], index: 0, patch: { color: { r: 1, g: 0, b: 0, a: 1 } } },
      'editor.invalid-command',
      '/patch/color',
    );
    // Out of S3's range: the model's check at the node's effect.
    const big = target.execute({ type: 'setEffect', ids: [a], index: 0, patch: { radius: 1001 } });
    expect(big).toMatchObject({ ok: false, code: 'document.invalid-field' });
    expect(big.ok ? '' : big.path).toMatch(new RegExp(`^/nodes/${a}/effects/0`));
    // One node out of range: no node changes.
    expect(
      target.execute({ type: 'setEffect', ids: [c, a], index: 0, patch: { radius: -1 } }),
    ).toMatchObject({ ok: false, code: 'document.invalid-field' });
    refused({ type: 'removeEffect', ids: [a], index: 3 }, 'editor.invalid-command', '/index');
    expect(text(target)).toBe(before);
  });

  it('removes the index from each node that has it, one undo step', () => {
    const { target, a, b, c } = scene();
    const before = text(target);
    ok(target, { type: 'removeEffect', ids: [a, b, c], index: 0 });
    expect(node(target, a).effects).toEqual([]);
    expect(node(target, b).effects).toEqual([DEFAULT_LAYER_BLUR]);
    expect(node(target, c).effects).toEqual([]);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
  });
});

describe('E41-A11 visual bounds (5.5)', () => {
  it('grows by 1.5 × blur + max(1.5 × radius + |offset|), visible effects only', () => {
    const target = editor();
    const a = rect(target, 10, 20);
    const doc = () => target.query({ type: 'document' });
    expect(visualBounds(doc(), node(target, a))).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    ok(target, { type: 'addEffect', ids: [a], kind: 'dropShadow' });
    // 1.5 × 8 + 4 = 16.
    expect(visualBounds(doc(), node(target, a))).toEqual({ x: -6, y: 4, width: 132, height: 82 });
    ok(target, { type: 'addEffect', ids: [a], kind: 'dropShadow' });
    ok(target, { type: 'setEffect', ids: [a], index: 1, patch: { offsetX: -30, radius: 2 } });
    ok(target, { type: 'addEffect', ids: [a], kind: 'layerBlur' });
    // 1.5 × 4 + max(16, 1.5 × 2 + 30 = 33) = 39.
    expect(visualBounds(doc(), node(target, a))).toEqual({
      x: -29,
      y: -19,
      width: 178,
      height: 128,
    });
    ok(target, { type: 'setEffect', ids: [a], index: 1, patch: { visible: false } });
    ok(target, { type: 'setEffect', ids: [a], index: 2, patch: { visible: false } });
    expect(visualBounds(doc(), node(target, a))).toEqual({ x: -6, y: 4, width: 132, height: 82 });
  });

  it('a group bounds its children with their effects', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 200, 0);
    ok(target, { type: 'addEffect', ids: [b], kind: 'dropShadow' });
    const [group] = ok(target, { type: 'groupNodes', ids: [a, b], kind: 'group' });
    const doc = target.query({ type: 'document' });
    expect(visualBounds(doc, node(target, group!))).toEqual({
      x: 0,
      y: -16,
      width: 316,
      height: 82,
    });
  });

  it("rotates with the node; an instance without effects takes its symbol's (S10)", () => {
    const target = editor();
    const a = rect(target, 0, 0);
    ok(target, { type: 'addEffect', ids: [a], kind: 'dropShadow' });
    ok(target, { type: 'rotateNodes', ids: [a], angle: Math.PI / 2 });
    const doc = () => target.query({ type: 'document' });
    // The 132 × 82 grown box turned a quarter about the centre (50, 25).
    const turned = visualBounds(doc(), node(target, a));
    expect(turned.width).toBeCloseTo(82, 9);
    expect(turned.height).toBeCloseTo(132, 9);
    expect(turned.x).toBeCloseTo(50 - 41, 9);
    expect(turned.y).toBeCloseTo(25 - 66, 9);

    const [symbol] = ok(target, { type: 'createSymbol', ids: [rect(target, 300, 0)] });
    ok(target, { type: 'addEffect', ids: [symbol!], kind: 'dropShadow' });
    const [instance] = ok(target, {
      type: 'createInstance',
      symbol: symbol!,
      frame: { x: 600, y: 0, width: 100, height: 50 },
    });
    const own = node(target, instance!);
    expect(own.effects).toEqual([]);
    const bound = visualBounds(doc(), own);
    expect(bound.x).toBe(own.frame.x - 16);
    expect(bound.width).toBe(own.frame.width + 32);
  });

  it('createSymbol wraps a shadowed node by its grown bounds', () => {
    const target = editor();
    const a = rect(target, 10, 20);
    ok(target, { type: 'addEffect', ids: [a], kind: 'dropShadow' });
    const [symbol] = ok(target, { type: 'createSymbol', ids: [a] });
    expect(node(target, symbol!).frame).toEqual({ x: -6, y: 4, width: 132, height: 82 });
  });
});
