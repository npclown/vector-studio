// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U4, V32-H1: the host wiring. The
// webgpu-host editor options take the image source and set `paints: 'image'`; next-host's editor
// projects images (`projectImages`), so an image fill reaches a renderer on those options with no
// diagnostic.
import path from 'node:path';
import type { GlyphRasterPort } from '@vector-studio/contracts';
import { PrimitiveRendererService } from '@vector-studio/renderer-core';
import { editorRendererOptions } from '@vector-studio/webgpu-host';
import { describe, expect, it } from 'vitest';
import type { EditorEvent } from '../../packages/editor-core/src/index.js';
import { createImageSource } from '../../packages/react/src/image-source.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';
import { createCountingPort } from '../support/v3a-path-harness.js';
import { makeAsset } from '../support/v32-images.js';
import type * as HostModule from '../../apps/next-host/src/m6a-text-host.js';
import type * as OptionsModule from '../../apps/next-host/src/renderer-options.js';

const root = path.resolve(import.meta.dirname, '../..');
const appDir = path.join(root, 'apps/next-host');
const host = (await import(path.join(appDir, 'src/m6a-text-host.ts'))) as typeof HostModule;
const options = (await import(
  path.join(appDir, 'src/renderer-options.ts')
)) as typeof OptionsModule;

const raster: GlyphRasterPort = Object.freeze({
  portVersion: 0,
  operationId: 'v32-u4/empty',
  rasterize: () => ({ status: 'empty' as const }),
});
const target = { invalidate() {}, setMode() {} };
const asset = makeAsset(9, 64, 32);

function composition() {
  const port = createFakeTextLayout();
  const textDom = {
    portVersion: 0,
    get generation() {
      return port.generation;
    },
    layout: (request: Parameters<typeof port.layout>[0]) => port.layout(request),
    subscribe: (listener: Parameters<typeof port.subscribe>[0]) => port.subscribe(listener),
    registerFont: () => Promise.resolve('loaded' as const),
    dispose() {},
    fallbacks: 0,
  };
  return host.composeHost({
    document: { nodeType: 9 } as unknown as Document,
    platform: 'other',
    createTextDom: () => textDom as never,
  });
}

describe('V32-H1 webgpu-host editor options', () => {
  it("are the gradient options without an image source, and 'image' with one", () => {
    expect(editorRendererOptions(raster)).toEqual({
      clips: 'all',
      paints: 'gradient',
      groups: 'isolated',
      text: 'atlas',
      effects: 'v1',
      blend: 'v0',
      glyphRaster: raster,
    });
    const source = createImageSource(() => ({}));
    const withImages = editorRendererOptions(raster, source);
    expect(withImages).toMatchObject({ paints: 'image', imageSource: source, glyphRaster: raster });
    expect(options.hostRendererOptions(raster, source)).toEqual(withImages);
    // The service takes them (`paints: 'image'` without a source is a construction error).
    const service = new PrimitiveRendererService(target, {
      fillMesh: createCountingPort(),
      ...withImages,
    });
    expect(service.imageSource).toBe(source);
    expect(service.requiresPaintPipeline).toBe(true);
    service.dispose();
  });
});

describe('V32-H1 next-host editor', () => {
  it('projects images, so an image fill reaches an image renderer with no diagnostic', () => {
    const { editor } = composition();
    const source = createImageSource(() => editor.getSnapshot().document);
    const events: EditorEvent[] = [];
    editor.subscribe((event) => events.push(event));
    const service = new PrimitiveRendererService(target, {
      fillMesh: createCountingPort(),
      ...options.hostRendererOptions(raster, source),
    });
    editor.attachRenderer(service);
    editor.execute({ type: 'setViewportSize', width: 800, height: 600 });
    const result = editor.execute({ type: 'insertImages', assets: [asset] });
    expect(result).toMatchObject({ ok: true });
    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([]);
    service.dispose();
  });
});
