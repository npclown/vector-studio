// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U4, V32-H3: the fill section's image
// kind (appearance model and panel markup), the layer row's image icon and the Place image
// button.
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type ImagePaint,
  type NodeV8,
} from '@vector-studio/editor-core';
import { AppearancePanel, EditorProvider, EditorToolbar, LayerTree } from '@vector-studio/ui';
import {
  IMAGE_SCALE_MODES,
  IMAGE_SCALE_MODE_LABELS,
  fillOf,
  fillPaintOf,
  imageModeCommand,
  imageThumbnailBlob,
  isGradient,
  isImagePaint,
  leadColor,
  leadImage,
  paintForKind,
  paintKind,
  solidFromHex,
  styleKeys,
  tileScaleCommand,
  tileScaleText,
} from '../../packages/ui/src/appearance-model.js';
import { imageNoticeText, placeImageTitle } from '../../packages/ui/src/editor-toolbar-model.js';
import { layerRows } from '../../packages/ui/src/layer-model.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';
import { entry, makeAsset } from '../support/v32-images.js';

const asset = makeAsset(5, 64, 32);
const RED = { r: 1, g: 0, b: 0, a: 1 };

function editor(): Editor {
  return createEditor({
    ids: createCounterIdSource('n'),
    textLayout: createFakeTextLayout(),
  });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
  return result.ids;
}

/** An editor with an image rectangle `n1` and a red rectangle `n2`, the first selected. */
function scene() {
  const target = editor();
  ok(target, { type: 'setViewportSize', width: 800, height: 600 });
  const [image] = ok(target, { type: 'insertImages', assets: [asset] });
  const [plain] = ok(target, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 10, height: 10 },
    fill: RED,
  });
  ok(target, { type: 'setSelection', ids: [image!] });
  return { target, image: image!, plain: plain! };
}

const node = (target: Editor, id: string): NodeV8 => target.query({ type: 'document' }).nodes[id]!;
const markup = (target: Editor, component: ComponentType) =>
  renderToString(createElement(EditorProvider, { editor: target }, createElement(component)));

describe('V32-H3 appearance model: the image kind', () => {
  it('keeps an image paint apart from a gradient and from a colour', () => {
    const { target, image, plain } = scene();
    const paint = fillPaintOf(node(target, image))!;
    expect(isImagePaint(paint)).toBe(true);
    expect(isGradient(paint)).toBe(false);
    expect(paintKind(paint)).toBe('image');
    // `fillOf` stays the colour reading: an image fill is no colour.
    expect(fillOf(node(target, image))).toBeNull();
    expect(leadColor(paint)).toBeNull();
    expect(fillPaintOf(node(target, plain))).toEqual(RED);
    expect(isImagePaint(RED)).toBe(false);
    expect(isImagePaint(null)).toBe(false);
    expect(paintKind(RED)).toBe('solid');
    expect(paintKind(null)).toBe('none');
  });

  it('writes no paint for the image kind, and leaves an image for a colour or gradient', () => {
    const { target, image } = scene();
    const paint = fillPaintOf(node(target, image))!;
    expect(paintForKind('image', null)).toBeNull();
    expect(paintForKind('solid', paint)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(paintForKind('linear', paint)).toMatchObject({
      kind: 'linear',
      stops: [{ color: { r: 0, g: 0, b: 0, a: 1 } }, { color: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    expect(solidFromHex('#ff0000', [paint])).toEqual(RED);
  });

  it('keeps the setStyle keys of a rectangle', () => {
    expect(styleKeys('rectangle')).toContain('fills');
  });

  it('finds the lead image and the thumbnail source', () => {
    const { target, image } = scene();
    const paint = fillPaintOf(node(target, image)) as ImagePaint;
    expect(leadImage([null, RED, paint])).toBe(paint);
    expect(leadImage([RED])).toBeNull();
    const table = target.query({ type: 'document' }).images;
    const blob = imageThumbnailBlob(table, paint.image)!;
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(Buffer.from(entry(asset).data, 'base64').length);
    expect(imageThumbnailBlob(table, 'missing')).toBeNull();
    expect(imageThumbnailBlob(undefined, paint.image)).toBeNull();
    expect(imageThumbnailBlob({ k: { ...entry(asset), data: '%%%' } }, 'k')).toBeNull();
  });

  it('builds the scale mode and tile scale commands', () => {
    expect(IMAGE_SCALE_MODES.map((mode) => IMAGE_SCALE_MODE_LABELS[mode])).toEqual([
      'Fill',
      'Fit',
      'Stretch',
      'Tile',
    ]);
    expect(imageModeCommand(['a', 'b'], 'tile')).toEqual({
      type: 'setImagePaint',
      ids: ['a', 'b'],
      scaleMode: 'tile',
    });
    // The field is a percentage of the image's own size.
    expect(tileScaleCommand(['a'], '50')).toEqual({
      type: 'setImagePaint',
      ids: ['a'],
      scale: 0.5,
    });
    expect(tileScaleCommand(['a'], ' 1 ')).toMatchObject({ scale: 0.01 });
    expect(tileScaleCommand(['a'], '10000')).toMatchObject({ scale: 100 });
    for (const text of ['', 'x', '0', '0.5', '10001', '-5', 'Infinity']) {
      expect(tileScaleCommand(['a'], text), text).toBeNull();
    }
    expect(tileScaleText(0.35)).toBe('35');
    expect(tileScaleText(1)).toBe('100');
    expect(tileScaleText(0.01)).toBe('1');
  });

  it('runs the commands against a real editor: mode, scale and undo', () => {
    const { target, image } = scene();
    ok(target, imageModeCommand([image], 'tile'));
    const command = tileScaleCommand([image], '25')!;
    ok(target, command);
    expect(fillPaintOf(node(target, image))).toMatchObject({ scaleMode: 'tile', scale: 0.25 });
    ok(target, { type: 'undo' });
    expect(fillPaintOf(node(target, image))).toMatchObject({ scaleMode: 'tile', scale: 1 });
  });
});

describe('V32-H3 appearance panel markup', () => {
  const select = (html: string, label: string) =>
    new RegExp(`<select[^>]*aria-label="${label}"[^>]*>(.*?)</select>`, 'u').exec(html);

  it('shows the Image type, the thumbnail, Choose image… and the mode for an image fill', () => {
    const { target } = scene();
    const html = markup(target, AppearancePanel);
    const type = select(html, 'Fill type')!;
    expect(type[0]).toContain('value="image"');
    expect(type[1]).toContain('>Image</option>');
    expect(type[1]).toMatch(/<option value="image" selected="">Image<\/option>/u);
    expect(html).toContain('data-testid="fill-image-thumbnail"');
    // The thumbnail's object URL is made in an effect, so the markup has no `data:` string.
    expect(html).not.toContain('base64,');
    expect(html).toContain('Choose image…');
    const mode = select(html, 'Fill scale mode')!;
    expect(mode[1]).toMatch(/<option value="fill" selected="">Fill<\/option>/u);
    for (const label of ['Fit', 'Stretch', 'Tile']) expect(mode[1]).toContain(`>${label}</option>`);
    // No gradient stops, no colour field: the image kind is its own kind.
    expect(html).not.toContain('Fill stop 1 offset');
    expect(html).not.toContain('aria-label="Fill colour"');
    // The scale field is for Tile only.
    expect(html).not.toContain('aria-label="Tile scale"');
  });

  it('shows the Tile scale field in percent for Tile', () => {
    const { target, image } = scene();
    ok(target, { type: 'setImagePaint', ids: [image], scaleMode: 'tile', scale: 0.5 });
    const html = markup(target, AppearancePanel);
    expect(html).toMatch(/<input[^>]*aria-label="Tile scale"[^>]*value="50"/u);
    expect(select(html, 'Fill scale mode')![1]).toMatch(/value="tile" selected=""/u);
  });

  it('offers Image on a colour fill, without the image controls', () => {
    const { target, plain } = scene();
    ok(target, { type: 'setStyle', ids: [plain], style: { stroke: {} } });
    ok(target, { type: 'setSelection', ids: [plain] });
    const html = markup(target, AppearancePanel);
    expect(select(html, 'Fill type')![1]).toContain('>Image</option>');
    expect(html).not.toContain('fill-image-choose');
    expect(html).toContain('aria-label="Fill colour"');
    // The stroke takes no image.
    expect(select(html, 'Stroke type')![1]).not.toContain('Image');
  });

  it('shows mixed over an image and a colour', () => {
    const { target, image, plain } = scene();
    ok(target, { type: 'setSelection', ids: [image, plain] });
    const html = markup(target, AppearancePanel);
    expect(select(html, 'Fill type')![0]).toContain('data-mixed="true"');
    expect(html).not.toContain('fill-image-choose');
  });
});

describe('V32-H3 layer row and toolbar', () => {
  it('marks a row whose topmost fill is an image', () => {
    const { target, image, plain } = scene();
    const document = target.query({ type: 'document' });
    const rows = layerRows(document, target.getSnapshot().activePage, new Set(), []);
    expect(rows.map((row) => [row.id, row.image])).toEqual([
      [plain, false],
      [image, true],
    ]);
    const html = markup(target, LayerTree);
    expect(html).toContain(`data-testid="layer-image-${image}"`);
    expect(html).not.toContain(`data-testid="layer-image-${plain}"`);
  });

  it('puts a Place image button in the toolbar, with its shortcut in the name', () => {
    const { target } = scene();
    const html = markup(target, EditorToolbar);
    expect(html).toMatch(
      /<button[^>]*data-testid="place-image"[^>]*aria-label="Place image \(Ctrl\+Shift\+K\)"/u,
    );
    expect(placeImageTitle(false)).toBe('Place image (Ctrl+Shift+K)');
    expect(placeImageTitle(true)).toBe('Place image (⌘+Shift+K)');
    expect(imageNoticeText(['a.txt', 'b.bmp'])).toBe('Skipped: a.txt, b.bmp');
    expect(imageNoticeText(['a'], 'editor.image-too-large')).toBe(
      'Not placed (editor.image-too-large): a',
    );
  });
});
