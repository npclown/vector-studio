// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U2b, V32-A03: the image commands
// (E1, E2), integrity and pruning (M4), the clipboard (E3), and the nodes the image paint meets
// (M6: a flip and a boolean result).
import {
  MAX_IMAGE_TABLE_BYTES,
  serializeDocument,
  validateDocument,
  type DocumentV8,
  type ImagePaint,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
} from '../../packages/editor-core/src/index.js';
import { Draft } from '../../packages/editor-core/src/draft.js';
import { mirrorContent } from '../../packages/editor-core/src/resize.js';
import { entry, makeAsset, type AssetInput } from '../support/v32-images.js';

const a = makeAsset(1, 64, 32);
const b = makeAsset(2, 10, 20, 'image/jpeg');
const c = makeAsset(3, 8, 8, 'image/webp');
const RED = { r: 1, g: 0, b: 0, a: 1 };

function editor(document?: unknown, adoptIntoFrames = false): Editor {
  return createEditor({
    ids: createCounterIdSource('n'),
    ...(document === undefined ? {} : { document: document as DocumentV8 }),
    ...(adoptIntoFrames ? { adoptIntoFrames: true } : {}),
  });
}

const doc = (target: Editor) => target.query({ type: 'document' });
const node = (target: Editor, id: string) => doc(target).nodes[id]!;
const fillsOf = (target: Editor, id: string) => {
  const found = node(target, id);
  return 'fills' in found ? found.fills : [];
};
const paintOf = (target: Editor, id: string) => fillsOf(target, id).at(-1)?.paint as ImagePaint;
const undoDepth = (target: Editor) => target.query({ type: 'history' }).undoDepth;

function run(target: Editor, command: Command): CommandResult {
  const result = target.execute(command);
  // Every result, a failure included, leaves a document the model accepts.
  expect(validateDocument(JSON.parse(serializeDocument(doc(target)))).ok).toBe(true);
  return result;
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = run(target, command);
  expect(result).toMatchObject({ ok: true });
  return result.ok ? result.ids : [];
}

function failure(target: Editor, command: Command): string {
  const before = serializeDocument(doc(target));
  const depth = undoDepth(target);
  const result = run(target, command);
  expect(result.ok).toBe(false);
  // No change: the document and the history stay as they were.
  expect(serializeDocument(doc(target))).toBe(before);
  expect(undoDepth(target)).toBe(depth);
  return result.ok ? 'ok' : `${result.code}${result.path === undefined ? '' : ` ${result.path}`}`;
}

const at = { x: 100, y: 100 };

describe('V32-E2 insertImages', () => {
  it('adds a rectangle at the natural size, centred on `at`, selected, one undo step', () => {
    const target = editor();
    const [id] = ok(target, { type: 'insertImages', assets: [a], at });
    const inserted = node(target, id!);
    expect(inserted).toMatchObject({
      type: 'rectangle',
      name: 'Image',
      frame: { x: 68, y: 84, width: 64, height: 32 },
      rotation: 0,
      stroke: null,
      cornerRadii: [0, 0, 0, 0],
    });
    expect(fillsOf(target, id!)).toEqual([
      {
        paint: { kind: 'image', image: a.key, scaleMode: 'fill', scale: 1 },
        visible: true,
        opacity: 1,
        blendMode: 'normal',
      },
    ]);
    expect(doc(target).images).toEqual({ [a.key]: entry(a) });
    expect(target.query({ type: 'selection' })).toEqual([id]);
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(doc(target).images).toBeUndefined();
    expect(Object.keys(doc(target).nodes)).toEqual([]);
    expect(target.query({ type: 'selection' })).toEqual([]);
    ok(target, { type: 'redo' });
    expect(doc(target).images).toEqual({ [a.key]: entry(a) });
  });

  it('offsets later rectangles by (20, 20) each, names them, and selects all', () => {
    const target = editor();
    const ids = ok(target, {
      type: 'insertImages',
      assets: [a, b, a],
      at,
      names: ['one', 'two', 'three'],
    });
    expect(ids).toHaveLength(3);
    expect(ids.map((id) => node(target, id).name)).toEqual(['one', 'two', 'three']);
    expect(ids.map((id) => node(target, id).frame)).toEqual([
      { x: 68, y: 84, width: 64, height: 32 },
      { x: 115, y: 110, width: 10, height: 20 },
      { x: 108, y: 124, width: 64, height: 32 },
    ]);
    // The same asset twice is one table entry.
    expect(Object.keys(doc(target).images!).sort()).toEqual([a.key, b.key].sort());
    expect(target.query({ type: 'selection' })).toEqual(ids);
    expect(doc(target).pages[0]!.children).toEqual(ids);
  });

  it('takes 1 to 32 assets and names of the same length', () => {
    const target = editor();
    expect(failure(target, { type: 'insertImages', assets: [], at })).toBe(
      'editor.image-invalid /assets',
    );
    const many = Array.from({ length: 33 }, (_, i) => makeAsset(i, 4, 4));
    expect(failure(target, { type: 'insertImages', assets: many, at })).toBe(
      'editor.image-invalid /assets',
    );
    expect(ok(target, { type: 'insertImages', assets: many.slice(0, 32), at })).toHaveLength(32);
    const fresh = editor();
    expect(failure(fresh, { type: 'insertImages', assets: [a, b], at, names: ['only'] })).toBe(
      'editor.image-invalid /names',
    );
    expect(failure(fresh, { type: 'insertImages', assets: [a], at, names: [] })).toBe(
      'editor.image-invalid /names',
    );
  });

  it('refuses an invalid asset with no change', () => {
    const target = editor();
    const bad = (asset: unknown) =>
      failure(target, { type: 'insertImages', assets: [asset as AssetInput], at });
    expect(bad({ ...a, key: 'ABC' })).toBe('editor.image-invalid /assets/0');
    expect(bad({ ...a, key: 'A'.repeat(64) })).toBe('editor.image-invalid /assets/0');
    expect(bad({ ...a, mimeType: 'image/jpeg' })).toBe('editor.image-invalid /assets/0');
    expect(bad({ ...a, width: 0 })).toBe('editor.image-invalid /assets/0');
    expect(bad({ ...a, width: 32769 })).toBe('editor.image-invalid /assets/0');
    expect(bad({ ...a, width: 8192, height: 8193 })).toBe('editor.image-invalid /assets/0');
    expect(bad({ ...a, data: '!!!!' })).toBe('editor.image-invalid /assets/0');
    expect(bad(null)).toBe('editor.image-invalid /assets/0');
    // The key is not re-hashed (V32-M2): any 64-character lowercase hex key is accepted.
    ok(target, { type: 'insertImages', assets: [{ ...a, key: 'f'.repeat(64) }], at });
  });

  it('refuses a key held with other data, and a table over its limit', () => {
    const target = editor();
    ok(target, { type: 'insertImages', assets: [a], at });
    const other = { ...b, key: a.key };
    expect(failure(target, { type: 'insertImages', assets: [other], at })).toBe(
      'editor.image-invalid /assets/0',
    );
    // The same key in one command with two contents.
    expect(failure(editor(), { type: 'insertImages', assets: [a, other], at })).toBe(
      'editor.image-invalid /assets/1',
    );
    // Nine assets of nearly 32 MiB pass 256 MiB at the ninth: the table, not one asset.
    const head = a.data.slice(0, 12);
    const limit = Math.floor((32 * 1024 * 1024) / 3) * 3;
    const big = head + 'A'.repeat((limit / 3) * 4 - head.length);
    const keys = Array.from({ length: 9 }, (_, i) => i.toString(16).padStart(64, '0'));
    expect(9 * limit).toBeGreaterThan(MAX_IMAGE_TABLE_BYTES);
    const asset = (key: string): AssetInput => ({ ...a, key, data: big });
    const full = editor();
    expect(full.execute({ type: 'insertImages', assets: keys.slice(0, 8).map(asset), at }).ok).toBe(
      true,
    );
    const refused = full.execute({ type: 'insertImages', assets: [asset(keys[8]!)], at });
    expect(refused).toEqual({ ok: false, code: 'editor.image-too-large', path: '/images' });
    expect(Object.keys(doc(full).images!)).toHaveLength(8);
    expect(undoDepth(full)).toBe(1);
  }, 60_000);

  it('without `at` uses the viewport centre, and needs a viewport size', () => {
    const target = editor();
    expect(failure(target, { type: 'insertImages', assets: [a] })).toBe('editor.no-viewport-size');
    ok(target, { type: 'setViewportSize', width: 400, height: 200 });
    const [id] = ok(target, { type: 'insertImages', assets: [a] });
    expect(node(target, id!).frame).toEqual({ x: 168, y: 84, width: 64, height: 32 });
  });

  it("places into the frame under `at` with adoptIntoFrames, in the frame's space", () => {
    const target = editor(undefined, true);
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 50, y: 50, width: 300, height: 300 },
    });
    const [id] = ok(target, { type: 'insertImages', assets: [a], at });
    expect(node(target, id!).parent).toBe(frame);
    expect(node(target, id!).frame).toEqual({ x: 18, y: 34, width: 64, height: 32 });
    const plain = editor();
    const [other] = ok(plain, {
      type: 'createFrame',
      frame: { x: 50, y: 50, width: 300, height: 300 },
    });
    const [on] = ok(plain, { type: 'insertImages', assets: [a], at });
    expect(node(plain, on!).parent).not.toBe(other);
  });
});

describe('V32-E2 setImageFill and setImagePaint', () => {
  function seeded() {
    const target = editor();
    const [rectangle] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 40, height: 40 },
      fill: RED,
    });
    const [ellipse] = ok(target, {
      type: 'createEllipse',
      frame: { x: 50, y: 0, width: 40, height: 40 },
      fills: [],
    });
    const [line] = ok(target, {
      type: 'createLine',
      start: { x: 0, y: 60 },
      end: { x: 40, y: 60 },
    });
    const [one, two] = ok(target, {
      type: 'insertImages',
      assets: [c, c],
      at: { x: 500, y: 500 },
    });
    const [group] = ok(target, { type: 'groupNodes', ids: [one!, two!], kind: 'group' });
    ok(target, { type: 'setSelection', ids: [] });
    return { target, rectangle: rectangle!, ellipse: ellipse!, line: line!, group: group! };
  }

  it("replaces the topmost fill's paint, keeping its opacity, and adds a fill when none", () => {
    const { target, rectangle, ellipse } = seeded();
    ok(target, { type: 'addFill', ids: [rectangle] });
    ok(target, { type: 'setFill', ids: [rectangle], index: 1, patch: { opacity: 0.5 } });
    ok(target, { type: 'setImageFill', ids: [rectangle, ellipse], asset: a, scaleMode: 'fit' });
    const image = { kind: 'image', image: a.key, scaleMode: 'fit', scale: 1 };
    expect(fillsOf(target, rectangle).map((fill) => fill.paint)).toEqual([RED, image]);
    expect(fillsOf(target, rectangle)[1]!.opacity).toBe(0.5);
    expect(fillsOf(target, ellipse).map((fill) => fill.paint)).toEqual([image]);
    expect(doc(target).images![a.key]).toEqual(entry(a));
    // The default mode is `fill`.
    ok(target, { type: 'setImageFill', ids: [ellipse], asset: b });
    expect(paintOf(target, ellipse)).toEqual({
      kind: 'image',
      image: b.key,
      scaleMode: 'fill',
      scale: 1,
    });
  });

  it('skips nodes without fills and fails with no target', () => {
    const { target, line, group, rectangle } = seeded();
    ok(target, { type: 'setImageFill', ids: [rectangle, line, group], asset: a });
    expect(paintOf(target, rectangle).image).toBe(a.key);
    expect(node(target, line)).not.toHaveProperty('fills');
    expect(failure(target, { type: 'setImageFill', ids: [line], asset: a })).toBe(
      'editor.image-no-target /ids',
    );
    expect(failure(target, { type: 'setImageFill', ids: [group], asset: a })).toBe(
      'editor.image-no-target /ids',
    );
    expect(
      failure(target, { type: 'setImageFill', ids: [rectangle], asset: { ...a, data: 'x' } }),
    ).toBe('editor.image-invalid /asset');
    expect(failure(target, { type: 'setImageFill', ids: ['nope'], asset: a })).toBe(
      'editor.unknown-node',
    );
    expect(
      failure(target, {
        type: 'setImageFill',
        ids: [rectangle],
        asset: a,
        scaleMode: 'cover' as never,
      }),
    ).toBe('editor.invalid-command /scaleMode');
  });

  it('setImagePaint changes the mode or scale of an image topmost fill only', () => {
    const { target, rectangle, ellipse } = seeded();
    ok(target, { type: 'setImageFill', ids: [rectangle], asset: a });
    ok(target, { type: 'setImagePaint', ids: [rectangle], scaleMode: 'tile', scale: 0.5 });
    expect(paintOf(target, rectangle)).toEqual({
      kind: 'image',
      image: a.key,
      scaleMode: 'tile',
      scale: 0.5,
    });
    ok(target, { type: 'setImagePaint', ids: [rectangle, ellipse], scale: 2 });
    expect(paintOf(target, rectangle)).toMatchObject({ scaleMode: 'tile', scale: 2 });
    expect(failure(target, { type: 'setImagePaint', ids: [ellipse], scaleMode: 'fit' })).toBe(
      'editor.image-no-target /ids',
    );
    expect(failure(target, { type: 'setImagePaint', ids: [rectangle], scale: 101 })).toBe(
      `document.invalid-field /nodes/${rectangle}/fills/0/paint/scale`,
    );
    expect(failure(target, { type: 'setImagePaint', ids: [rectangle] })).toBe(
      'editor.invalid-command /scaleMode',
    );
    // An unchanged value records no step.
    const depth = undoDepth(target);
    ok(target, { type: 'setImagePaint', ids: [rectangle], scale: 2 });
    expect(undoDepth(target)).toBe(depth);
  });
});

describe('V32-M4 integrity and pruning', () => {
  function withImage() {
    const target = editor();
    const [id] = ok(target, { type: 'insertImages', assets: [a], at });
    return { target, id: id! };
  }
  const paint = (key: string): ImagePaint => ({
    kind: 'image',
    image: key,
    scaleMode: 'fill',
    scale: 1,
  });

  it('a fill command with a dangling key fails; with a held key it succeeds', () => {
    const { target, id } = withImage();
    expect(
      failure(target, { type: 'setFill', ids: [id], index: 0, patch: { paint: paint(b.key) } }),
    ).toBe(`editor.image-invalid /nodes/${id}/fills/0/paint/image`);
    const [plain] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 5, height: 5 },
    });
    expect(
      failure(target, { type: 'setStyle', ids: [plain!], style: { fill: paint(c.key) } }),
    ).toBe(`editor.image-invalid /nodes/${plain}/fills/0/paint/image`);
    expect(
      failure(target, {
        type: 'createRectangle',
        frame: { x: 0, y: 0, width: 5, height: 5 },
        fill: paint(c.key),
      }),
    ).toMatch(/^editor\.image-invalid \/nodes\/n-?\w+\/fills\/0\/paint\/image$/u);
    // A held key is accepted by the existing commands (style paste, V-35).
    ok(target, { type: 'setStyle', ids: [plain!], style: { fill: paint(a.key) } });
    expect(paintOf(target, plain!).image).toBe(a.key);
    ok(target, { type: 'addFill', ids: [plain!] });
    ok(target, { type: 'setFill', ids: [plain!], index: 1, patch: { paint: paint(a.key) } });
    expect(fillsOf(target, plain!)).toHaveLength(2);
  });

  it('drops an entry nothing names, and undo brings it back', () => {
    const { target, id } = withImage();
    ok(target, { type: 'setImageFill', ids: [id], asset: b });
    expect(Object.keys(doc(target).images!)).toEqual([b.key]);
    ok(target, { type: 'setFill', ids: [id], index: 0, patch: { paint: RED } });
    expect(doc(target).images).toBeUndefined();
    ok(target, { type: 'undo' });
    expect(doc(target).images).toEqual({ [b.key]: entry(b) });
    ok(target, { type: 'undo' });
    expect(doc(target).images).toEqual({ [a.key]: entry(a) });
    ok(target, { type: 'redo' });
    ok(target, { type: 'redo' });
    expect(doc(target).images).toBeUndefined();
  });

  it('keeps an entry another node still names, and drops it with the last node', () => {
    const target = editor();
    const [one, two] = ok(target, { type: 'insertImages', assets: [a, a], at });
    ok(target, { type: 'deleteNodes', ids: [one!] });
    expect(doc(target).images).toEqual({ [a.key]: entry(a) });
    ok(target, { type: 'deleteNodes', ids: [two!] });
    expect(doc(target).images).toBeUndefined();
    ok(target, { type: 'undo' });
    expect(doc(target).images).toEqual({ [a.key]: entry(a) });
  });

  it('does not scan or drop on a change that touches no image paint', () => {
    // An unreferenced entry in a loaded document survives commands on other nodes.
    const loaded = {
      schemaVersion: 8,
      id: 'd',
      pages: [{ id: 'page', name: 'P', children: [] }],
      nodes: {},
      images: { [a.key]: entry(a) },
    };
    const target = editor(loaded);
    ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 5, height: 5 } });
    expect(doc(target).images).toEqual({ [a.key]: entry(a) });
  });

  it('measures the table limit after pruning', () => {
    const head = a.data.slice(0, 12);
    const limit = Math.floor((32 * 1024 * 1024) / 3) * 3;
    const big = head + 'A'.repeat((limit / 3) * 4 - head.length);
    const keys = Array.from({ length: 9 }, (_, i) => i.toString(16).padStart(64, '0'));
    const asset = (key: string): AssetInput => ({ ...a, key, data: big });
    const target = editor();
    const inserted = target.execute({
      type: 'insertImages',
      assets: keys.slice(0, 8).map(asset),
      at,
    });
    expect(inserted.ok).toBe(true);
    const first = inserted.ok ? inserted.ids[0]! : '';
    expect(target.execute({ type: 'deleteNodes', ids: [first] }).ok).toBe(true);
    // One entry was dropped with its node, so a ninth fits.
    expect(Object.keys(doc(target).images!)).toHaveLength(7);
    expect(target.execute({ type: 'insertImages', assets: [asset(keys[8]!)], at }).ok).toBe(true);
    expect(Object.keys(doc(target).images!)).toHaveLength(8);
  }, 60_000);
});

describe('V32-E3 the clipboard carries images', () => {
  const body = (text: string) =>
    JSON.parse(text.slice(text.indexOf('\n') + 1)) as Record<string, unknown>;

  it('round-trips into a second document, merging entries', () => {
    const source = editor();
    const [r1, r2] = ok(source, { type: 'insertImages', assets: [a, b], at });
    ok(source, { type: 'copy', ids: [r1!, r2!] });
    const text = source.query({ type: 'clipboard' })!;
    const written = body(text);
    expect(Object.keys(written)).toEqual([
      'fragmentVersion',
      'schemaVersion',
      'roots',
      'nodes',
      'sources',
      'sourceNodes',
      'images',
    ]);
    expect(Object.keys(written.images as object)).toEqual([a.key, b.key].sort());

    const target = editor();
    const pasted = ok(target, { type: 'paste', text });
    expect(pasted).toHaveLength(2);
    expect(doc(target).images).toEqual({ [a.key]: entry(a), [b.key]: entry(b) });
    expect(pasted.map((id) => paintOf(target, id).image)).toEqual([a.key, b.key]);
    // Pasting again is a no-op on the table; an identical entry is not a conflict.
    ok(target, { type: 'paste', text });
    expect(Object.keys(doc(target).images!)).toHaveLength(2);
    // Undo removes the pasted nodes and the entries they alone named.
    ok(target, { type: 'undo' });
    ok(target, { type: 'undo' });
    expect(doc(target).images).toBeUndefined();
  });

  it('copies only the entries the copied nodes name, and omits the key without any', () => {
    const source = editor();
    const [r1] = ok(source, { type: 'insertImages', assets: [a, b], at });
    ok(source, { type: 'copy', ids: [r1!] });
    expect(Object.keys(body(source.query({ type: 'clipboard' })!).images as object)).toEqual([
      a.key,
    ]);
    const [plain] = ok(source, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 5, height: 5 },
    });
    ok(source, { type: 'copy', ids: [plain!] });
    expect(body(source.query({ type: 'clipboard' })!)).not.toHaveProperty('images');
    // A fragment without `images` still pastes.
    const target = editor();
    ok(target, { type: 'paste', text: source.query({ type: 'clipboard' })! });
    expect(doc(target).images).toBeUndefined();
  });

  it('carries the images of a symbol source with a copied instance', () => {
    const source = editor();
    const [r1] = ok(source, { type: 'insertImages', assets: [a], at });
    const [symbol] = ok(source, { type: 'createSymbol', ids: [r1!] });
    const [instance] = ok(source, {
      type: 'createInstance',
      symbol: symbol!,
      frame: { x: 300, y: 0, width: 64, height: 32 },
    });
    ok(source, { type: 'copy', ids: [instance!] });
    const text = source.query({ type: 'clipboard' })!;
    const written = body(text);
    expect(written.sources).toEqual([symbol]);
    expect(Object.keys(written.images as object)).toEqual([a.key]);
    // Into a document that does not hold the source: the instance is pasted detached, with the
    // source's fills and its image entry.
    const target = editor();
    const [copy] = ok(target, { type: 'paste', text });
    const frame = node(target, copy!);
    expect(frame.type).toBe('frame');
    const [child] = 'children' in frame ? frame.children : [];
    expect(paintOf(target, child!).image).toBe(a.key);
    expect(doc(target).images).toEqual({ [a.key]: entry(a) });
  });

  it('refuses a conflicting entry, a dangling key and a bad table', () => {
    const source = editor();
    const [r1] = ok(source, { type: 'insertImages', assets: [a], at });
    ok(source, { type: 'copy', ids: [r1!] });
    const text = source.query({ type: 'clipboard' })!;
    const target = editor();
    ok(target, { type: 'insertImages', assets: [a], at });
    // The same key with other data in the target's table.
    const parsed = body(text);
    const clash = `${text.slice(0, text.indexOf('\n') + 1)}${JSON.stringify({
      ...parsed,
      images: { [a.key]: { ...entry(a), height: 33 } },
    })}`;
    const clipboardOnly = (fragment: string) => run(target, { type: 'paste', text: fragment });
    expect(clipboardOnly(clash)).toMatchObject({
      ok: false,
      code: 'editor.image-invalid',
    });
    const fragment = body(text);
    const first = text.slice(0, text.indexOf('\n') + 1);
    const without = { ...fragment };
    delete without.images;
    expect(clipboardOnly(first + JSON.stringify(without))).toMatchObject({
      ok: false,
      code: 'document.invalid-field',
    });
    const bad = { ...fragment, images: { nope: entry(a) } };
    expect(clipboardOnly(first + JSON.stringify(bad))).toMatchObject({ ok: false });
    // A fragment version 1 has no `images` key.
    const v1 = {
      fragmentVersion: 1,
      schemaVersion: 2,
      roots: fragment.roots,
      nodes: fragment.nodes,
      images: fragment.images,
    };
    expect(clipboardOnly(first + JSON.stringify(v1))).toMatchObject({
      ok: false,
      code: 'editor.invalid-clipboard',
      path: '/images',
    });
  });
});

describe('V32-M6 an image paint through a flip and a boolean', () => {
  it('a flip leaves the image paint unchanged and still mirrors a gradient', () => {
    const target = editor();
    const [r1] = ok(target, { type: 'insertImages', assets: [a], at });
    const gradient = {
      kind: 'linear',
      transform: [1, 0, 0, 1, 0, 0],
      stops: [
        { offset: 0, color: RED },
        { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
      spread: 'pad',
    } as const;
    ok(target, { type: 'addFill', ids: [r1!] });
    ok(target, { type: 'setFill', ids: [r1!], index: 1, patch: { paint: gradient } });
    const draft = new Draft(doc(target));
    mirrorContent(draft, r1!, true, true);
    const flipped = draft.node(r1!);
    const fills = flipped !== undefined && 'fills' in flipped ? flipped.fills : [];
    expect(fills[0]!.paint).toEqual({ kind: 'image', image: a.key, scaleMode: 'fill', scale: 1 });
    expect(fills[1]!.paint).toMatchObject({ transform: [-1, -0, -0, -1, 1, 1] });
  });

  it("a boolean result keeps the first input's image paint", () => {
    const target = editor();
    const [r1] = ok(target, { type: 'insertImages', assets: [a], at });
    const [r2] = ok(target, {
      type: 'createRectangle',
      frame: { x: 90, y: 90, width: 40, height: 40 },
    });
    const [result] = ok(target, { type: 'booleanNodes', ids: [r1!, r2!], op: 'union' });
    expect(node(target, result!).type).toBe('path');
    expect(paintOf(target, result!)).toEqual({
      kind: 'image',
      image: a.key,
      scaleMode: 'fill',
      scale: 1,
    });
    expect(doc(target).images).toEqual({ [a.key]: entry(a) });
  });
});

describe('review fixes: a repeated setImageFill, unnamed fragment entries', () => {
  it('a repeated setImageFill with the same asset records no step', () => {
    const target = editor();
    const [id] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    ok(target, { type: 'setImageFill', ids: [id!], asset: a });
    const depth = undoDepth(target);
    ok(target, { type: 'setImageFill', ids: [id!], asset: a });
    expect(undoDepth(target)).toBe(depth);
  });

  it('rejects a fragment entry that no node names, at its entry, and stays fast', () => {
    const source = editor();
    const [r1] = ok(source, { type: 'insertImages', assets: [a], at });
    ok(source, { type: 'copy', ids: [r1!] });
    const text = source.query({ type: 'clipboard' })!;
    const head = text.slice(0, text.indexOf('\n') + 1);
    const parsed = JSON.parse(text.slice(head.length)) as { images: Record<string, unknown> };
    const target = editor();
    const stray = makeAsset(9, 1, 1);
    const withStray = { ...parsed, images: { ...parsed.images, [stray.key]: entry(stray) } };
    const result = run(target, { type: 'paste', text: head + JSON.stringify(withStray) });
    expect(result).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: `/images/${stray.key}`,
    });
    expect(doc(target).images).toBeUndefined();
    // Many unnamed entries fail at the first one without a quadratic merge.
    const many: Record<string, unknown> = { ...parsed.images };
    for (let i = 0; i < 20_000; i += 1) {
      many[i.toString(16).padStart(64, '0')] = entry(stray);
    }
    const started = performance.now();
    const refused = target.execute({
      type: 'paste',
      text: head + JSON.stringify({ ...parsed, images: many }),
    });
    expect(refused.ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
