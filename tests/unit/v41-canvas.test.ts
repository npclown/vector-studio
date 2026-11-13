import type {
  RendererInvalidationTarget,
  RendererSceneSynchronization,
  SceneColor,
} from '@vector-studio/contracts';
import {
  DEFAULT_PAGE_BACKGROUND,
  DEFAULT_PAGE_GRID,
  parseDocument,
  serializeDocument,
  validateAnyDocument,
  validateDocument,
} from '@vector-studio/model';
import { PrimitiveRendererService, RetainedSceneMirror } from '@vector-studio/renderer-core';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '../../packages/editor-core/src/index.js';
import {
  PAGE_BACKGROUND_DEFAULT,
  PAGE_GRID_DEFAULT,
  backgroundCommand,
  canvasFields,
  gridColorCommand,
  gridOpacityCommand,
  gridSizeCommand,
} from '../../packages/ui/src/canvas-model.js';
import {
  CANVAS_GRID_MIN_PX,
  canvasGridPath,
  canvasGridStep,
} from '../../apps/next-host/src/v38-rulers-model.js';
import { backdropColor, caretColour } from '../../apps/next-host/src/v25-text-colour-default.js';

// V-41 contract (docs/plans/viz-v41-canvas-background-grid-contract.md), section 5: the page
// background and grid fields (S1 to S3), `setPageCanvas` (C1), the projector's clear colour
// (R2), the renderer service (R3), the canvas grid geometry (H1), the backdrop (H3) and the
// Canvas section's commands (U1).

const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const GRID = { size: 24, color: { r: 1, g: 0, b: 0, a: 0.5 } };

const document = (page: Record<string, unknown> = {}, schemaVersion = 8) => ({
  schemaVersion,
  id: 'doc',
  pages: [
    { id: 'p1', name: 'p1', children: [], ...page },
    { id: 'p2', name: 'p2', children: [] },
  ],
  nodes: {},
});

const editor = (page: Record<string, unknown> = {}): Editor =>
  createEditor({ ids: createCounterIdSource('n'), document: document(page) });
const pick = (result: ReturnType<Editor['execute']>) =>
  result.ok ? 'ok' : `${result.code} ${result.path ?? ''}`.trim();
const run = (target: Editor, command: Command) => pick(target.execute(command));
const page1 = (target: Editor) => target.query({ type: 'document' }).pages[0]!;
const depth = (target: Editor) => target.query({ type: 'history' }).undoDepth;
const failure = (input: unknown) => {
  const result = validateDocument(input);
  return result.ok ? 'ok' : `${result.code} ${result.path}`;
};

describe('V41-A1 page fields (S1 to S3)', () => {
  it('reads both fields at v8, defaults absent, and writes them after the guides', () => {
    const input = document({ guides: [{ axis: 'x', value: 5 }], background: WHITE, grid: GRID });
    const result = validateDocument(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.pages[0]).toMatchObject({ background: WHITE, grid: GRID });
    expect(result.document.pages[1]!.background).toBeUndefined();
    const text = serializeDocument(result.document);
    expect(text.indexOf('"guides"')).toBeLessThan(text.indexOf('"background"'));
    expect(text.indexOf('"background"')).toBeLessThan(text.indexOf('"grid"'));
    const again = parseDocument(text);
    expect(again.ok && serializeDocument(again.document)).toBe(text);
    // An absent field is not written.
    expect(serializeDocument(validateDocumentOk(document()))).not.toContain('background');
  });

  it('refuses invalid values at their paths', () => {
    expect(failure(document({ background: { r: 2, g: 0, b: 0, a: 1 } }))).toBe(
      'document.invalid-field /pages/0/background/r',
    );
    expect(failure(document({ background: { r: 1, g: 1, b: 1, a: 0.5 } }))).toBe(
      'document.invalid-field /pages/0/background/a',
    );
    expect(failure(document({ grid: { size: 0, color: WHITE } }))).toBe(
      'document.invalid-field /pages/0/grid/size',
    );
    expect(failure(document({ grid: { size: 1e5, color: WHITE } }))).toBe(
      'document.invalid-field /pages/0/grid/size',
    );
    expect(failure(document({ grid: { size: 5, color: WHITE, extra: 1 } }))).toMatch(
      /^document\.invalid-field \/pages\/0\/grid/,
    );
  });

  it('a v7 input with either key fails; an older input reads without them', () => {
    expect(validateAnyDocument(document({ background: WHITE }, 7)).ok).toBe(false);
    expect(validateAnyDocument(document({ grid: GRID }, 7)).ok).toBe(false);
    const older = validateAnyDocument(document({}, 7));
    expect(older.ok).toBe(true);
    if (older.ok) expect(older.document.pages[0]!.background).toBeUndefined();
  });

  it('the UI defaults equal the model defaults', () => {
    expect(PAGE_BACKGROUND_DEFAULT).toEqual(DEFAULT_PAGE_BACKGROUND);
    expect(PAGE_GRID_DEFAULT).toEqual(DEFAULT_PAGE_GRID);
  });
});

function validateDocumentOk(input: unknown) {
  const result = validateDocument(input);
  if (!result.ok) throw new Error(result.code);
  return result.document;
}

describe('V41-A2 setPageCanvas (C1)', () => {
  it('sets, keeps an absent key, removes with null; one undo step each', () => {
    const target = editor();
    expect(run(target, { type: 'setPageCanvas', page: 'p1', background: WHITE })).toBe('ok');
    expect(page1(target).background).toEqual(WHITE);
    expect(run(target, { type: 'setPageCanvas', page: 'p1', grid: GRID })).toBe('ok');
    expect(page1(target)).toMatchObject({ background: WHITE, grid: GRID });
    expect(depth(target)).toBe(2);
    expect(run(target, { type: 'setPageCanvas', page: 'p1', background: null })).toBe('ok');
    expect(page1(target).background).toBeUndefined();
    expect(page1(target).grid).toEqual(GRID);
    expect(run(target, { type: 'undo' })).toBe('ok');
    expect(page1(target).background).toEqual(WHITE);
  });

  it('records no step when nothing changes', () => {
    const target = editor({ background: WHITE, grid: GRID });
    expect(run(target, { type: 'setPageCanvas', page: 'p1' })).toBe('ok');
    expect(run(target, { type: 'setPageCanvas', page: 'p1', background: { ...WHITE } })).toBe('ok');
    expect(run(target, { type: 'setPageCanvas', page: 'p1', grid: structuredClone(GRID) })).toBe(
      'ok',
    );
    expect(run(target, { type: 'setPageCanvas', page: 'p2', background: null })).toBe('ok');
    expect(depth(target)).toBe(0);
  });

  it('refuses in order: page type, unknown page, background, grid', () => {
    const target = editor();
    const bad = { r: 0, g: 0, b: 0, a: 0.5 };
    expect(run(target, { type: 'setPageCanvas', page: 3 as never, background: bad })).toBe(
      'editor.invalid-command /page',
    );
    expect(run(target, { type: 'setPageCanvas', page: 'x', background: bad })).toBe(
      'editor.unknown-page',
    );
    expect(
      run(target, {
        type: 'setPageCanvas',
        page: 'p1',
        background: bad,
        grid: { size: -1, color: WHITE },
      }),
    ).toBe('document.invalid-field /background/a');
    expect(
      run(target, { type: 'setPageCanvas', page: 'p1', grid: { size: -1, color: WHITE } }),
    ).toBe('document.invalid-field /grid/size');
    expect(depth(target)).toBe(0);
  });
});

/** A renderer that records `setClearColor` calls over a real retained mirror. */
function recordingRenderer(withMethod = true) {
  const mirror = new RetainedSceneMirror();
  const colors: SceneColor[] = [];
  const renderer: RendererSceneSynchronization = {
    replaceSnapshot: (snapshot) => mirror.replaceSnapshot(snapshot),
    applyChanges: (changes) => mirror.applyChanges(changes),
    getSynchronizationState: () => mirror.getSynchronizationState(),
    setCamera: (camera) => mirror.setCamera(camera),
    getCameraState: () => mirror.getCameraState(),
    dispose: () => mirror.dispose(),
    ...(withMethod ? { setClearColor: (color: SceneColor) => void colors.push(color) } : {}),
  };
  return { renderer, colors };
}

describe('V41-A3 projector clear colour (R2)', () => {
  it('sends on attach, on a change, on undo and on a page switch; never twice in a row', () => {
    const target = editor({ background: WHITE });
    const { renderer, colors } = recordingRenderer();
    target.attachRenderer(renderer);
    expect(colors).toEqual([WHITE]);
    run(target, { type: 'setPageCanvas', page: 'p1', grid: GRID });
    expect(colors).toEqual([WHITE]);
    const red = { r: 1, g: 0, b: 0, a: 1 };
    run(target, { type: 'setPageCanvas', page: 'p1', background: red });
    expect(colors).toEqual([WHITE, red]);
    run(target, { type: 'undo' });
    expect(colors).toEqual([WHITE, red, WHITE]);
    run(target, { type: 'setActivePage', id: 'p2' });
    expect(colors).toEqual([WHITE, red, WHITE, DEFAULT_PAGE_BACKGROUND]);
  });

  it('reaches the method through a forwarding Proxy, and skips a renderer without it', () => {
    const target = editor();
    const { renderer, colors } = recordingRenderer();
    const proxy = new Proxy(renderer, {
      get: (object, key) => {
        const value: unknown = Reflect.get(object, key, object);
        return typeof value === 'function' ? (value as () => unknown).bind(object) : value;
      },
    });
    target.attachRenderer(proxy);
    expect(colors).toEqual([DEFAULT_PAGE_BACKGROUND]);
    const other = editor({ background: WHITE });
    expect(() => other.attachRenderer(recordingRenderer(false).renderer)).not.toThrow();
  });
});

describe('V41-A4 renderer service (R3)', () => {
  it('keeps a valid colour, ignores invalid ones, and invalidates on change only', () => {
    const reasons: string[] = [];
    const target: RendererInvalidationTarget = {
      invalidate: ({ reason }) => void reasons.push(reason),
      setMode: () => {},
    };
    const service = new PrimitiveRendererService(target, {});
    expect(service.clearColor).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    service.setClearColor({ r: 0.2, g: 0.4, b: 0.6, a: 1 });
    expect(service.clearColor).toEqual({ r: 0.2, g: 0.4, b: 0.6, a: 1 });
    expect(reasons).toEqual(['scene']);
    service.setClearColor({ r: 0.2, g: 0.4, b: 0.6, a: 1 });
    service.setClearColor({ r: Number.NaN, g: 0, b: 0, a: 1 });
    service.setClearColor({ r: 0, g: 0, b: 0, a: 2 });
    expect(reasons).toEqual(['scene']);
    expect(service.clearColor).toEqual({ r: 0.2, g: 0.4, b: 0.6, a: 1 });
    service.dispose();
  });
});

describe('V41-A5 canvas grid geometry (H1)', () => {
  it('doubles the step until it is at least 8 CSS px', () => {
    expect(canvasGridStep(10, 1)).toBe(10);
    expect(canvasGridStep(10, 0.5)).toBe(20);
    expect(canvasGridStep(10, 0.1)).toBe(80);
    expect(canvasGridStep(1, 8)).toBe(1);
    for (const zoom of [0.01, 0.37, 1, 3, 256]) {
      expect(canvasGridStep(10, zoom) * zoom).toBeGreaterThanOrEqual(CANVAS_GRID_MIN_PX);
    }
    // Bounded for a tiny size.
    expect(Number.isFinite(canvasGridStep(Number.MIN_VALUE, 1e-3))).toBe(true);
  });

  it('draws the visible multiples on both axes', () => {
    const d = canvasGridPath({ position: { x: -5, y: 0 }, zoom: 1 }, 30, 20, 10);
    // x: page 0, 10, 20 at 5, 15, 25 px; y: page 0, 10, 20 at 0, 10, 20 px.
    expect(d).toBe('M5.5 0V20M15.5 0V20M25.5 0V20M0 0.5H30M0 10.5H30M0 20.5H30');
  });
});

describe('V41-A6 backdrop and Canvas section (H3, U1)', () => {
  it('the backdrop of the empty canvas is the page background', () => {
    const light = validateDocumentOk(document({ background: WHITE }));
    expect(backdropColor(light, 'p1', { x: 0, y: 0 })).toEqual(WHITE);
    expect(caretColour(light, 'p1', { x: 0, y: 0 })).toBe('#000000');
    expect(backdropColor(light, 'p2', { x: 0, y: 0 })).toEqual(DEFAULT_PAGE_BACKGROUND);
  });

  it('builds one setPageCanvas per field commit', () => {
    const page = validateDocumentOk(document({ grid: GRID })).pages[0]!;
    expect(canvasFields(page)).toEqual({
      background: '#000000',
      gridColor: '#ff0000',
      gridOpacity: '50',
      gridSize: '24',
    });
    expect(backgroundCommand(page, '#ffffff')).toEqual({
      type: 'setPageCanvas',
      page: 'p1',
      background: WHITE,
    });
    expect(backgroundCommand(page, 'nope')).toBeNull();
    expect(gridColorCommand(page, '#00ff00')).toEqual({
      type: 'setPageCanvas',
      page: 'p1',
      grid: { size: 24, color: { r: 0, g: 1, b: 0, a: 0.5 } },
    });
    expect(gridOpacityCommand(page, '25')).toMatchObject({ grid: { color: { a: 0.25 } } });
    expect(gridOpacityCommand(page, '101')).toBeNull();
    expect(gridSizeCommand(page, '8')).toMatchObject({ grid: { size: 8, color: GRID.color } });
    expect(gridSizeCommand(page, '0')).toBeNull();
    const plain = validateDocumentOk(document()).pages[0]!;
    expect(gridSizeCommand(plain, '5')).toMatchObject({
      grid: { size: 5, color: DEFAULT_PAGE_GRID.color },
    });
  });
});

describe('V41-A7 the WebGPU main pass clears to the colour (R3)', () => {
  it('premultiplies the source colour into the main pass clear value', async () => {
    const { GpuRecorder, installRecordedBrowserGpu } =
      await import('../support/e10-gpu-recorder.js');
    const { WebGpuBackend } = await import('@vector-studio/renderer-webgpu');
    const { rectangleNode, identity } = await import('../support/v3a-path-harness.js');
    const recorder = new GpuRecorder();
    const installed = installRecordedBrowserGpu(recorder);
    try {
      const callbacks: ((time: number) => void)[] = [];
      const clock = {
        request: (callback: (time: number) => void) => callbacks.push(callback),
        cancel: () => {},
      };
      const tick = () => callbacks.splice(0).forEach((callback) => callback(16));
      const backend = new WebGpuBackend({ animationFrameClock: clock, now: () => 0 });
      const service = new PrimitiveRendererService(backend, {});
      backend.attachPrimitiveFrameSource(service);
      const result = await backend.initialize({
        canvas: installed.canvas,
        cssSize: { width: 64, height: 32 },
        devicePixelRatio: 1,
      });
      expect(result.supported).toBe(true);
      const node = rectangleNode('rect', 0);
      service.replaceSnapshot({ identity, revision: 1, nodes: [node], rootOrder: ['rect'] });
      service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
      tick();
      service.setClearColor({ r: 1, g: 0.5, b: 0, a: 0.5 });
      tick();
      backend.dispose();
      const clears = recorder.log
        .filter(([name]) => String(name).endsWith('.beginRenderPass'))
        .map(
          ([, descriptor]) =>
            (descriptor as { colorAttachments: { clearValue?: unknown }[] }).colorAttachments[0]
              ?.clearValue,
        );
      expect(clears[0]).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      expect(clears.at(-1)).toEqual({ r: 0.5, g: 0.25, b: 0, a: 0.5 });
    } finally {
      installed.restore();
    }
  });
});
