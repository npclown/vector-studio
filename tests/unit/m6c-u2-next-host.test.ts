import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GlyphRasterPort } from '@vector-studio/contracts';
import {
  PrimitiveRendererService,
  TEXT_INSTANCE_FLOATS,
  snappedPlacement,
  type PrimitivePacket,
  type PrimitiveReceipt,
  type PrimitiveTarget,
} from '@vector-studio/renderer-core';
import { createCanvasGlyphRaster } from '@vector-studio/renderer-webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';
import {
  parseDocument,
  serializeDocument,
  validateDocument,
  type DocumentV6,
} from '../../packages/model/src/index.js';
import type * as RouteModule from '../../apps/next-host/app/m6c-text-gpu.json/route.js';
import type * as HostModule from '../../apps/next-host/src/m6a-text-host.js';
import type * as ProbeModule from '../../apps/next-host/src/m6c-text-probe.js';
import type * as OptionsModule from '../../apps/next-host/src/renderer-options.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';
import { createCountingPort } from '../support/v3a-path-harness.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';

// MVP M6c-U2 (M6c contract, section 5; the Node half of M6c-A04): next-host's renderer options
// (`text: 'atlas'` with a glyph raster port beside `clips: 'all'`, `paints: 'gradient'` and
// `groups: 'isolated'`), under which the editor's projected text is accepted with no
// diagnostic, closing the M6c-U1 window in which next-host isolated its text as
// `editor.renderer-unsupported`; the committed `?fixture=text-gpu` document and its route; and
// the pure half of the `?test=1` cluster probe (src/m6c-text-probe.ts): the scene recorder, the
// E28-K1 to K3 placements and K9 bounds of `scene()`, the one-cluster scene of `readCluster` and
// its crop. Layouts come from the fake port of M6a section 5. The headed half (A04: ink inside
// each node's cluster bounds, no diagnostic, the GPU draw of `readCluster`) is
// tests/m6c-next-host/.

const root = path.resolve(import.meta.dirname, '../..');
const appDir = path.join(root, 'apps/next-host');
const GPU_TEXT = readFileSync(
  path.join(root, 'tests/fixtures/m6-text/gpu/text-gpu.v6.json'),
  'utf8',
);
const GPU = JSON.parse(GPU_TEXT) as DocumentV6;
const M6A_TEXT = JSON.parse(
  readFileSync(path.join(root, 'tests/fixtures/m6-text/text.v4.json'), 'utf8'),
) as unknown;
const EDIT_TEXT = JSON.parse(
  readFileSync(path.join(root, 'tests/fixtures/m6-text/edit-host.v6.json'), 'utf8'),
) as unknown;
const PAGE_SOURCE = readFileSync(path.join(appDir, 'app/page.tsx'), 'utf8');
const RENDERER_SOURCE = readFileSync(path.join(appDir, 'src/webgpu-renderer.ts'), 'utf8');
/** The Hangul syllables of the committed test font's subset (M6a contract, U5 note 2). */
const SUBSET_HANGUL = '가각국글기나녕니다동라마바벡사세습아안요자집차채천추카타택터파편하한했';

const probe = (await import(path.join(appDir, 'src/m6c-text-probe.ts'))) as typeof ProbeModule;
const options = (await import(
  path.join(appDir, 'src/renderer-options.ts')
)) as typeof OptionsModule;
const host = (await import(path.join(appDir, 'src/m6a-text-host.ts'))) as typeof HostModule;

/** A port that rasterizes nothing: the scene checks need no bitmap. */
const emptyRaster: GlyphRasterPort = Object.freeze({
  portVersion: 0,
  operationId: 'm6c-u2/empty',
  rasterize: () => ({ status: 'empty' as const }),
});
const target = { invalidate() {}, setMode() {} };

function ok(editor: Editor, command: Command): readonly string[] {
  const result = editor.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

/**
 * The host composition in Node: the fake port, a service with `serviceOptions` (by default the
 * host's options with a counting fill mesh double for the mask source path), recorded.
 */
function hosted(
  document: unknown,
  serviceOptions: ConstructorParameters<typeof PrimitiveRendererService>[1] = {
    fillMesh: createCountingPort(),
    ...options.hostRendererOptions(emptyRaster),
  },
  camera = { position: { x: 0, y: 0 }, zoom: 1 },
) {
  const editor = createEditor({
    ids: createCounterIdSource('n'),
    extensions: [starExtension],
    textLayout: createFakeTextLayout(),
  });
  const events: EditorEvent[] = [];
  editor.subscribe((event) => events.push(event));
  const service = new PrimitiveRendererService(target, serviceOptions);
  const recorder = new probe.SceneRecorder();
  editor.attachRenderer(recorder.wrap(service));
  ok(editor, { type: 'setViewportSize', width: 960, height: 640 });
  ok(editor, { type: 'loadDocument', document });
  ok(editor, { type: 'setViewport', camera });
  const diagnostics = () => events.filter((event) => event.type === 'diagnostic');
  return { editor, events, service, recorder, diagnostics };
}

const leafIds = (scene: ProbeModule.TextScene | null) => scene?.leaves.map((leaf) => leaf.id);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("M6c-U2 next-host renderer options (text: 'atlas')", () => {
  it('names the E28 text option and a glyph raster port beside the M1 and M4 options', () => {
    const port = createCanvasGlyphRaster();
    expect(options.hostRendererOptions(port)).toEqual({
      clips: 'all',
      paints: 'gradient',
      groups: 'isolated',
      text: 'atlas',
      glyphRaster: port,
    });
    const service = new PrimitiveRendererService(target, options.hostRendererOptions(port));
    expect(service.requiresTextPipeline).toBe(true);
    expect(service.requiresClipPipeline).toBe(true);
    expect(service.requiresPaintPipeline).toBe(true);
    expect(service.requiresLayerPipeline).toBe(true);
    service.dispose();
    // The host's service and the probe's both take them, with the canvas raster port.
    expect(RENDERER_SOURCE).toMatch(/\.\.\.hostRendererOptions\(glyphRaster\),\n {4}\}\);/u);
    expect(RENDERER_SOURCE).toMatch(
      /new core\.PrimitiveRendererService\(target, hostRendererOptions\(glyphRaster\)\)/u,
    );
    expect(RENDERER_SOURCE).toMatch(/const glyphRaster = webgpu\.createCanvasGlyphRaster\(\);/u);
  });

  it.each([
    ['?fixture=text', M6A_TEXT, ['page-1', 'page-2']],
    ['?fixture=text-edit', EDIT_TEXT, ['page-1']],
    ['?fixture=text-gpu', GPU, ['agreement', 'scene']],
  ] as const)('accepts the projected text of %s with no diagnostic', (_, document, pages) => {
    const { editor, service, recorder, diagnostics } = hosted(document);
    for (const page of pages) {
      ok(editor, { type: 'setActivePage', id: page });
      expect(service.getSynchronizationState().status).toBe('synchronized');
      const scene = recorder.textScene(1);
      expect(scene?.identity.pageId).toBe(page);
      expect(scene!.leaves.length).toBeGreaterThan(0);
    }
    expect(diagnostics()).toEqual([]);
  });

  it("isolates text as editor.renderer-unsupported without text: 'atlas' (the M6c-U1 window)", () => {
    const { diagnostics } = hosted(M6A_TEXT, {
      fillMesh: createCountingPort(),
      clips: 'all',
      paints: 'gradient',
      groups: 'isolated',
    });
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        code: 'editor.renderer-unsupported',
        reason: 'unsupported-feature',
      }),
    ]);
  });
});

describe('M6c-U2 ?fixture=text-gpu', () => {
  const nodes = GPU.nodes;
  const text = (id: string) => {
    const node = nodes[id]!;
    if (node.type !== 'text') throw new Error(`${id} is not text`);
    return node;
  };

  it('is a valid v6 document of the agreement fixtures and the A05 scene', () => {
    expect(validateDocument(GPU).ok).toBe(true);
    expect(GPU.schemaVersion).toBe(6);
    // Written as the serializer writes it, so a load and save keep it byte for byte.
    const parsed = parseDocument(GPU_TEXT);
    expect(parsed.ok && serializeDocument(parsed.document)).toBe(GPU_TEXT);
    expect(GPU.pages.map((page) => [page.id, page.children])).toEqual([
      [
        'agreement',
        [
          'agreement-backdrop',
          'kerning',
          'hangul',
          'mixed-sizes',
          'hangul-in-latin',
          'two-families',
          'spacing-tight',
          'spacing-wide',
          'small-12',
          'small-9',
          'wrapped',
          'align-center',
          'align-right',
          'font-load',
        ],
      ],
      [
        'scene',
        [
          'scene-backdrop',
          'order-under',
          'order-text',
          'order-over',
          'clip-frame',
          'mask-group',
          'fade-group',
          'rotated-text',
          'symbol',
          'instance-override',
          'instance-source',
        ],
      ],
    ]);
    // Section 6.2: every agreement fixture is unrotated at a uniform scale (page children).
    const agreement = GPU.pages[0]!.children.slice(1).map(text);
    for (const node of agreement) expect([node.rotation, node.parent]).toEqual([0, 'agreement']);
    expect(text('kerning').runs.map((run) => run.text)).toEqual(['AVATAR Wa To Ty.']);
    expect(text('mixed-sizes').runs.map((run) => [run.text, run.size])).toEqual([
      ['Ab', 24],
      ['한글', 40],
      ['xy', 16],
    ]);
    expect(text('hangul-in-latin').runs.map((run) => run.family)).toEqual(['Arial']);
    expect(new Set(text('two-families').runs.map((run) => run.family)).size).toBe(2);
    expect(text('wrapped').sizing).toBe('autoHeight');
    expect([text('align-center').align, text('align-right').align]).toEqual(['center', 'right']);
    expect([text('spacing-tight').letterSpacing, text('spacing-wide').letterSpacing]).toEqual([
      -0.2, 0.3,
    ]);
    expect([text('small-12').runs[0]!.size, text('small-9').runs[0]!.size]).toEqual([12, 9]);
    // The font-load case (section 7) names a family the page does not register at load.
    expect(text('font-load').runs[0]!.family).toBe('M6c Font Load');
    // The A05 scene: text between overlapping shapes, under a frame clip, a mask (never the mask
    // source), a translucent group, rotated, and in a symbol with and without an override.
    const scene = GPU.pages[1]!.children;
    expect(scene.indexOf('order-under')).toBeLessThan(scene.indexOf('order-text'));
    expect(scene.indexOf('order-text')).toBeLessThan(scene.indexOf('order-over'));
    expect(nodes['clip-frame']).toMatchObject({ type: 'frame', children: ['clip-text'] });
    expect(nodes['mask-group']).toMatchObject({
      type: 'maskGroup',
      children: ['mask-shape', 'mask-text'],
    });
    expect(nodes['mask-shape']!.type).not.toBe('text');
    expect(nodes['fade-group']).toMatchObject({ type: 'group', opacity: 0.5 });
    expect(text('rotated-text').rotation).not.toBe(0);
    const override = nodes['instance-override']!;
    expect(override.type === 'instance' && override.symbol).toBe('symbol');
    expect(override.type === 'instance' && Object.keys(override.textOverrides)).toEqual([
      'symbol-text',
    ]);
    expect(nodes['instance-source']).toMatchObject({ symbol: 'symbol', textOverrides: {} });
    // Both pages draw over an opaque white backdrop, since the host canvas clears to black.
    for (const id of ['agreement-backdrop', 'scene-backdrop']) {
      expect(nodes[id]).toMatchObject({
        type: 'rectangle',
        frame: { x: 0, y: 0, width: 960, height: 640 },
        fill: { r: 1, g: 1, b: 1, a: 1 },
      });
    }
    // Hangul in the test font is in its subset; elsewhere it falls back (main PC: Malgun Gothic).
    for (const node of Object.values(nodes)) {
      if (node.type !== 'text') continue;
      for (const run of node.runs) {
        if (run.family !== 'Noto Sans KR') continue;
        for (const char of run.text.match(/\p{Script=Hangul}/gu) ?? []) {
          expect(SUBSET_HANGUL).toContain(char);
        }
      }
    }
  });

  it('serves the fixture byte for byte at /m6c-text-gpu.json', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(appDir);
    const route = (await import(
      `${path.join(appDir, 'app/m6c-text-gpu.json/route.ts')}?cwd=app`
    )) as typeof RouteModule;
    const response = await route.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(GPU_TEXT);
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('asks for the test font and loads at zoom 1', () => {
    expect(host.textFixtureQuery('?test=1&fixture=text-gpu')).toBe(true);
    expect(host.textFixtureQuery('?persist=1&fixture=text-gpu')).toBe(false);
    expect(host.textFixtureQuery('?fixture=text-gpu2')).toBe(false);
    expect(PAGE_SOURCE).toMatch(
      /'text-gpu': \{\s+url: '\/m6c-text-gpu\.json',\s+camera: \{ position: \{ x: 0, y: 0 \}, zoom: 1 \},\s+font: true,/u,
    );
  });

  it('projects every text unit of both pages, expanded instance text included', () => {
    const { editor, recorder } = hosted(GPU);
    expect(leafIds(recorder.textScene(1))).toEqual([
      'kerning',
      'hangul',
      'mixed-sizes',
      'hangul-in-latin',
      'two-families',
      'spacing-tight',
      'spacing-wide',
      'small-12',
      'small-9',
      'wrapped',
      'align-center',
      'align-right',
      'font-load',
    ]);
    ok(editor, { type: 'setActivePage', id: 'scene' });
    const leaves = recorder.textScene(1)!.leaves;
    expect(leaves.filter((leaf) => !leaf.id.includes('\u0000@')).map((leaf) => leaf.id)).toEqual([
      'order-text',
      'clip-text',
      'mask-text',
      'fade-text',
      'rotated-text',
      'symbol-text',
    ]);
    // One expanded text leaf per instance, the override's text in one, the source's in the other.
    const expanded = leaves.filter((leaf) => leaf.id.includes('\u0000@'));
    const texts = (leaf: ProbeModule.TextSceneLeaf) =>
      leaf.leaf.runs.flatMap((run) => run.clusters.map((cluster) => cluster.text)).join('');
    expect(expanded.map(texts)).toEqual(['Override 한글', 'Source 한글']);
    expect(leaves.every((leaf) => leaf.shown)).toBe(true);
  });
});

describe('M6c-U2 cluster probe: scene recorder', () => {
  it('records accepted snapshots, change sets and cameras, not rejected ones', () => {
    const { editor, recorder, service } = hosted(GPU, undefined, {
      position: { x: -20, y: -10 },
      zoom: 2,
    });
    const scene = recorder.textScene(2)!;
    expect(scene.camera).toEqual({ position: { x: -20, y: -10 }, zoom: 2 });
    expect(scene.devicePixelRatio).toBe(2);
    expect(scene.revision).toBe(service.getSynchronizationState().current!.revision);
    // A change set: a style edit updates the leaf, a delete removes it, hiding marks it.
    const before = scene.leaves.find((leaf) => leaf.id === 'kerning')!;
    ok(editor, {
      type: 'setTextStyle',
      id: 'kerning',
      start: 0,
      end: 16,
      style: { color: { r: 1, g: 0, b: 0, a: 1 } },
    });
    const styled = recorder.textScene(2)!.leaves.find((leaf) => leaf.id === 'kerning')!;
    expect(styled.leaf.runs[0]!.color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(styled.leaf.runs[0]!.clusters).toEqual(before.leaf.runs[0]!.clusters);
    ok(editor, { type: 'deleteNodes', ids: ['hangul'] });
    expect(leafIds(recorder.textScene(2))).not.toContain('hangul');
    ok(editor, { type: 'setNodeProps', id: 'small-9', props: { visible: false } });
    expect(recorder.textScene(2)!.leaves.find((leaf) => leaf.id === 'small-9')!.shown).toBe(false);
    expect(recorder.textScene(2)!.revision).toBe(
      service.getSynchronizationState().current!.revision,
    );
    // A rejected snapshot and camera leave the record as it was.
    const wrapped = recorder.wrap(service);
    const kept = recorder.textScene(2);
    expect(
      wrapped.replaceSnapshot({ ...kept!, nodes: [], rootOrder: ['missing'], revision: 1 }).status,
    ).not.toBe('applied');
    expect(wrapped.setCamera({ position: { x: 0, y: 0 }, zoom: -1 }).status).toBe('invalid-camera');
    expect(recorder.textScene(2)).toEqual(kept);
  });

  it('gives a nested leaf its world transform: a frame child, a group child, expanded text', () => {
    const { editor, recorder } = hosted(GPU);
    ok(editor, { type: 'setActivePage', id: 'scene' });
    const leaves = recorder.textScene(1)!.leaves;
    const world = (id: string) => leaves.find((leaf) => leaf.id === id)!.world;
    // `clip-text` at (10, 5) in `clip-frame` at (20, 120).
    expect(world('clip-text')).toEqual([1, 0, 0, 1, 30, 125]);
    expect(world('fade-text')).toEqual([1, 0, 0, 1, 460, 130]);
    // `rotated-text` rotates about its frame centre (M1 local transform).
    const [a, b, c, d] = world('rotated-text');
    expect([a, b, c, d].map((v) => Number(v.toFixed(12)))).toEqual(
      [Math.cos(0.4), Math.sin(0.4), -Math.sin(0.4), Math.cos(0.4)].map((v) =>
        Number(v.toFixed(12)),
      ),
    );
    // The instances' text at (10, 10) in instances at (300, 320) and (300, 400).
    const expanded = leaves.filter((leaf) => leaf.id.includes('\u0000@')).map((leaf) => leaf.world);
    expect(expanded).toEqual([
      [1, 0, 0, 1, 310, 330],
      [1, 0, 0, 1, 310, 410],
    ]);
  });
});

describe('M6c-U2 cluster probe: placements and bounds', () => {
  it.each([1, 2])(
    'snaps every agreement cluster at DPR %d: phase step 1/4, vertical snap within 0.5',
    (dpr) => {
      const { recorder } = hosted(GPU);
      const scene = recorder.textScene(dpr)!;
      let clusters = 0;
      for (const leaf of scene.leaves) {
        const placements = probe.clusterPlacements(leaf, scene.camera!, dpr);
        expect(placements.map((p) => p.index)).toEqual(placements.map((_, i) => i));
        for (const p of placements) {
          clusters += 1;
          expect(p.mode).toBe('snapped');
          expect(p.map).toEqual([dpr, 0, 0, dpr, dpr * leaf.world[4], dpr * leaf.world[5]]);
          const snap = snappedPlacement(p.origin[0], p.origin[1]);
          expect([p.phaseX, p.corner]).toEqual([snap.phaseX, [snap.px, snap.py]]);
          // The placement term's bounds (section 6.1): 1/8 device px across, 0.5 down.
          expect(Math.abs(p.corner![0] + p.phaseX - p.origin[0])).toBeLessThanOrEqual(1 / 8);
          expect(Math.abs(p.corner![1] - p.origin[1])).toBeLessThanOrEqual(0.5);
          expect(p.deviceSize).toBe(p.size * dpr);
          // The pen origin is inside the cluster's K9 bound, and that inside the leaf's.
          expect(p.bound.x0).toBeLessThan(p.origin[0]);
          expect(p.bound.x1).toBeGreaterThan(p.origin[0]);
          expect(p.bound.y0).toBeLessThan(p.origin[1]);
          expect(p.bound.y1).toBeGreaterThan(p.origin[1]);
          expect(leaf.bounds!.x0).toBeLessThanOrEqual(p.bound.x0);
          expect(leaf.bounds!.y1).toBeGreaterThanOrEqual(p.bound.y1);
        }
      }
      expect(clusters).toBeGreaterThan(100);
    },
  );

  it('places a rotated leaf in the general mode and omits clusters below 0.5 device px', () => {
    const { editor, recorder } = hosted(GPU);
    ok(editor, { type: 'setActivePage', id: 'scene' });
    const scene = recorder.textScene(1)!;
    const rotated = scene.leaves.find((leaf) => leaf.id === 'rotated-text')!;
    const general = probe.clusterPlacements(rotated, scene.camera!, 1);
    expect(new Set(general.map((p) => p.mode))).toEqual(new Set(['general']));
    expect(general.every((p) => p.corner === null && p.phaseX === 0)).toBe(true);
    // At zoom 1/64 a 24 px run is 0.375 device px: omitted, and the leaf has no bound.
    const tiny = probe.clusterPlacements(rotated, { position: { x: 0, y: 0 }, zoom: 1 / 64 }, 1);
    expect(new Set(tiny.map((p) => p.mode))).toEqual(new Set(['omitted']));
  });

  it('bounds a cluster by E28-K9 through the device map, negative advances included', () => {
    expect(probe.clusterDeviceBound([2, 0, 0, 2, 10, 20], { x: 5, y: 8, advance: 6 }, 4)).toEqual({
      x0: 2 * (5 - 4) + 10,
      y0: 2 * (8 - 8) + 20,
      x1: 2 * (5 + 6 + 4) + 10,
      y1: 2 * (8 + 4) + 20,
    });
    expect(probe.clusterDeviceBound([1, 0, 0, 1, 0, 0], { x: 5, y: 0, advance: -3 }, 1)).toEqual({
      x0: 1,
      y0: -2,
      x1: 6,
      y1: 1,
    });
    // A quarter turn: the box of the turned corners.
    const turned = probe.clusterDeviceBound([0, 1, -1, 0, 0, 0], { x: 0, y: 0, advance: 2 }, 1);
    expect(turned).toEqual({ x0: -1, y0: -1, x1: 2, y1: 3 });
  });

  it('keeps white space out of inkBounds', () => {
    const { recorder } = hosted(GPU);
    const leaf = recorder.textScene(1)!.leaves.find((value) => value.id === 'hangul')!;
    // "한글 편집기 벡터": the last cluster has ink; a trailing space would not widen inkBounds.
    expect(leaf.inkBounds).not.toBeNull();
    expect(leaf.inkBounds!.x1).toBeLessThanOrEqual(leaf.bounds!.x1);
  });
});

describe('M6c-U2 cluster probe: the one-cluster scene and its crop', () => {
  it('builds a scene the probe service accepts, black on white, from the projected leaf', () => {
    const { editor, recorder } = hosted(GPU);
    const camera = { position: { x: -3.25, y: 7.5 }, zoom: 1.5 };
    ok(editor, { type: 'setViewport', camera });
    const check = () => {
      const scene = recorder.textScene(2)!;
      expect(scene.camera).toEqual(camera);
      for (const leaf of scene.leaves) {
        const placements = probe.clusterPlacements(leaf, camera, 2);
        for (const placement of [placements[0]!, placements.at(-1)!]) {
          const snapshot = probe.clusterScene(
            leaf,
            placement,
            camera,
            { width: 960, height: 640 },
            1,
          );
          const service = new PrimitiveRendererService(
            target,
            options.hostRendererOptions(emptyRaster),
          );
          expect(service.replaceSnapshot(snapshot).status).toBe('applied');
          service.dispose();
          const [backdrop, node] = snapshot.nodes;
          expect(backdrop).toMatchObject({
            id: probe.PROBE_BACKDROP_ID,
            transform: [1, 0, 0, 1, -3.25, 7.5],
            geometry: { kind: 'rectangle', width: 640, height: 640 / 1.5 },
            style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
          });
          const run = leaf.leaf.runs[placement.run]!;
          expect(node).toEqual({
            id: probe.PROBE_CLUSTER_ID,
            parentId: null,
            transform: leaf.world,
            visible: true,
            opacity: 1,
            kind: 'text',
            generation: leaf.leaf.generation,
            lang: leaf.leaf.lang,
            runs: [
              {
                fontList: run.fontList,
                size: run.size,
                color: { r: 0, g: 0, b: 0, a: 1 },
                clusters: [run.clusters[placement.cluster]],
              },
            ],
          });
          // The one-cluster scene places its cluster exactly as the projected leaf does.
          const alone = probe.clusterPlacements(
            { world: node!.transform, leaf: node as ProbeModule.TextLeaf },
            camera,
            2,
          )[0]!;
          expect([alone.origin, alone.phaseX, alone.corner, alone.bucket]).toEqual([
            placement.origin,
            placement.phaseX,
            placement.corner,
            placement.bucket,
          ]);
        }
      }
    };
    check();
    ok(editor, { type: 'setActivePage', id: 'scene' });
    check();
  });

  it('crops whole device pixels around a box, clamped to the frame', () => {
    const frame = { width: 4, height: 3 };
    expect(probe.cropRect({ x0: 1.5, y0: 0.25, x1: 2.5, y1: 1 }, 0, frame)).toEqual({
      x: 1,
      y: 0,
      width: 2,
      height: 1,
    });
    expect(probe.cropRect({ x0: -5, y0: -5, x1: 9, y1: 9 }, 2, frame)).toEqual({
      x: 0,
      y: 0,
      width: 4,
      height: 3,
    });
    expect(probe.cropRect({ x0: 10, y0: 10, x1: 12, y1: 12 }, 0, frame)).toMatchObject({
      width: 0,
      height: 0,
    });
    const rgba = Uint8Array.from({ length: 4 * 3 * 4 }, (_, i) => i);
    const crop = probe.cropFrame({ ...frame, rgba }, { x: 1, y: 1, width: 2, height: 2 });
    expect(crop).toMatchObject({ x: 1, y: 1, width: 2, height: 2 });
    expect([...Buffer.from(crop.rgbaBase64, 'base64')]).toEqual([
      ...rgba.subarray(20, 28),
      ...rgba.subarray(36, 44),
    ]);
  });

  it('has no host before a renderer registers, and none after it is released', async () => {
    expect(probe.textScene()).toBeNull();
    await expect(probe.readCluster('kerning', 0)).rejects.toThrow('no host renderer');
    const { recorder } = hosted(GPU);
    const release = probe.attachTextProbe({
      recorder,
      size: { width: 960, height: 640, devicePixelRatio: 1 },
      glyphRaster: emptyRaster,
      createBackend: () => {
        throw new Error('not in Node');
      },
      createService: () => {
        throw new Error('not in Node');
      },
    });
    expect(leafIds(probe.textScene())).toContain('kerning');
    await expect(probe.readCluster('missing', 0)).rejects.toThrow('No projected text leaf missing');
    await expect(probe.readCluster('kerning', 999)).rejects.toThrow('has no cluster 999');
    release();
    expect(probe.textScene()).toBeNull();
  });

  it('exposes scene and readCluster on the page hook and the counters on the renderer hook', () => {
    // M6c-U3 adds the DOM reference's members beside the probe's.
    expect(PAGE_SOURCE).toMatch(
      /text: \{ \.\.\.textTestHook\(state\), \.\.\.textProbeHook, \.\.\.textReferenceHook\(editor\) \}/u,
    );
    expect(PAGE_SOURCE).toMatch(/import\('\.\.\/src\/m6c-text-probe'\)\)\.textScene\(\)/u);
    expect(PAGE_SOURCE).toMatch(
      /import\('\.\.\/src\/m6c-text-probe'\)\)\.readCluster\(id, index\)/u,
    );
    expect(RENDERER_SOURCE).toMatch(
      /get glyphRasterCalls\(\) \{\s+return service\.getGlyphRasterCallsForTesting\(\);/u,
    );
    expect(RENDERER_SOURCE).toMatch(
      /get glyphUploads\(\) \{\s+return service\.getGlyphUploadsForTesting\(\);/u,
    );
    // The probe module is loaded only under `?test=1`, by dynamic import.
    expect(PAGE_SOURCE).not.toMatch(/^import [^t].*m6c-text-probe/mu);
    expect(RENDERER_SOURCE).toMatch(
      /if \(testing\) \{[\s\S]*await import\('\.\/m6c-text-probe'\)/u,
    );
  });
});

// Review S1: the probe's placement is checked against the renderer itself, not against its own
// arithmetic. A recording port behind the host's options draws each page through `prepare` and
// `acknowledge` until the raster budget converges; every raster request (text, bucket, phase)
// must be one `clusterPlacements` predicts for a drawn, non-space cluster of a leaf on the target
// (E28-K9 culls per leaf, then per cluster, each with a 2 device px guard), and every such
// prediction outside a clip or
// mask must be requested. The converged packet's
// snapped instance records must be exactly the probe's `bitmapRect`s of those clusters.
describe('M6c-U2 cluster probe against the renderer (review S1)', () => {
  /** A deterministic bitmap per request, so the record's rectangle tells the clusters apart. */
  function recordingPort() {
    const requests: { text: string; pixelSize: number; phaseX: number }[] = [];
    const port: GlyphRasterPort = Object.freeze({
      portVersion: 0,
      operationId: 'm6c-u2/recording',
      rasterize: (request: Parameters<GlyphRasterPort['rasterize']>[0]) => {
        requests.push({
          text: request.text,
          pixelSize: request.pixelSize,
          phaseX: request.phaseX,
        });
        if (request.text.trim().length === 0) return { status: 'empty' as const };
        const width = 2 + [...request.text].length + Math.round(request.pixelSize);
        const height = 3 + Math.round(request.pixelSize);
        return {
          status: 'ok' as const,
          width,
          height,
          left: 1 + request.phaseX * 4,
          top: height - 2,
          coverage: new Uint8Array(width * height).fill(255),
        };
      },
    });
    return { port, requests };
  }

  /** Prepares and acknowledges frames until a frame makes no raster call (budget converged). */
  function converge(
    service: PrimitiveRendererService,
    target: PrimitiveTarget,
    calls: () => number,
  ) {
    const pages: symbol[] = [];
    for (let frame = 0; frame < 64; frame += 1) {
      const before = calls();
      const prepared = service.prepare(target);
      if (prepared === null) throw new Error('prepare returned no packet');
      const packet: PrimitivePacket = prepared;
      const part = packet.text;
      const base = receiptOf(packet);
      let receipt: PrimitiveReceipt = base;
      if (part !== undefined) {
        while (pages.length < part.pageCount) pages.push(Symbol('page'));
        pages.length = part.pageCount;
        receipt = {
          ...base,
          text: { pages: [...pages], clears: part.clears.length, uploads: part.uploads.length },
        };
      }
      service.acknowledge(receipt);
      if (frame > 0 && calls() === before) return packet;
    }
    throw new Error('The raster budget did not converge in 64 frames.');
  }

  const cases = [
    ['agreement', 1, 1, { x: 0, y: 0 }],
    ['agreement', 2, 1, { x: 0, y: 0 }],
    ['agreement', 1, 1.37, { x: 3.3, y: -7.15 }],
    ['agreement', 2, 1.37, { x: 3.3, y: -7.15 }],
    ['scene', 1, 1, { x: 0, y: 0 }],
    ['scene', 2, 0.5, { x: 3.3, y: -7.15 }],
    ['scene', 1, 1.37, { x: -12.6, y: 4.05 }],
  ] as const;

  it.each(cases)(
    '%s at DPR %d, zoom %d: requests and records match the probe',
    (pageId, dpr, zoom, position) => {
      const { port, requests } = recordingPort();
      const { editor, recorder, service } = hosted(GPU, {
        fillMesh: createCountingPort(),
        ...options.hostRendererOptions(port),
      });
      ok(editor, { type: 'setActivePage', id: pageId });
      ok(editor, { type: 'setViewport', camera: { position, zoom } });
      const target: PrimitiveTarget = {
        generation: 1,
        surfaceRevision: 1,
        width: 960 * dpr,
        height: 640 * dpr,
        devicePixelRatio: dpr,
        sampleCount: 1,
        targetFormat: 'bgra8unorm',
      };
      const packet = converge(service, target, () => requests.length);
      const scene = recorder.textScene(dpr)!;
      expect(scene.camera).toEqual({ position, zoom });
      // Leaves under a clip or mask may have clusters culled by the clip chain, not the target.
      const clipped = new Set(['clip-text', 'mask-text']);
      const expected = new Set<string>();
      const required = new Set<string>();
      const rects = new Set<string>();
      const key = (text: string, size: number, phase: number) => `${text}|${size}|${phase}`;
      for (const leaf of scene.leaves) {
        // E28-K9 culls per leaf by its node bound, then per cluster by the cluster's own bound,
        // each against the target with a 2 device px guard.
        const meets = (b: { x0: number; y0: number; x1: number; y1: number }) =>
          !(b.x1 < -2 || b.y1 < -2 || b.x0 > target.width + 2 || b.y0 > target.height + 2);
        const b = leaf.bounds;
        if (!leaf.shown || b === null || !meets(b)) continue;
        for (const p of probe.clusterPlacements(leaf, scene.camera!, dpr)) {
          if (p.mode === 'omitted' || p.text.trim().length === 0) continue;
          expected.add(key(p.text, p.bucket, p.phaseX));
          if (!clipped.has(leaf.id) && meets(p.bound))
            required.add(key(p.text, p.bucket, p.phaseX));
          const rect = probe.bitmapRect(p, port);
          if (rect !== null && !clipped.has(leaf.id)) {
            rects.add([rect.x, rect.y, rect.width, rect.height].join(','));
          }
        }
      }
      const got = new Set(
        requests
          .filter((request) => request.text.trim().length > 0)
          .map((request) => key(request.text, request.pixelSize, request.phaseX)),
      );
      expect(required.size).toBeGreaterThan(10);
      // Every renderer request is a predicted cluster, and every unclipped prediction is requested.
      expect([...got].filter((value) => !expected.has(value))).toEqual([]);
      expect([...required].filter((value) => !got.has(value))).toEqual([]);
      // The converged packet's snapped records are the probe's bitmap rectangles.
      const instances = packet.text!.instances;
      const records = new Set<string>();
      let general = 0;
      for (let i = 0; i < instances.length; i += TEXT_INSTANCE_FLOATS) {
        const r = instances.subarray(i, i + TEXT_INSTANCE_FLOATS);
        if (r[11] !== 0) {
          general += 1;
          continue;
        }
        expect([r[3], r[4]]).toEqual([0, 0]);
        records.add([r[0], r[1], r[2], r[5]].join(','));
      }
      expect([...rects].filter((value) => !records.has(value))).toEqual([]);
      if (pageId === 'agreement') {
        expect(general).toBe(0);
        expect(records).toEqual(rects);
      } else {
        // The rotated node draws in the general mode.
        expect(general).toBeGreaterThan(0);
      }
    },
  );
});

describe('M6c-U2 cluster probe: empty clip chains (review F4)', () => {
  const base = {
    parentId: null,
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: 1,
  } as const;
  const leaf = (parentId: string) => ({
    ...base,
    id: `${parentId}-text`,
    parentId,
    kind: 'text' as const,
    generation: 0,
    lang: 'ko',
    runs: [
      {
        fontList: FONT_LIST,
        size: 10,
        color: { r: 0, g: 0, b: 0, a: 1 },
        clusters: [{ text: 'a', x: 0, y: 8, advance: 5 }],
      },
    ],
  });
  const FONT_LIST = '"Test", sans-serif';
  it('hides a leaf under a zero-size rect clip, a singular container or an empty mask', () => {
    const recorder = new probe.SceneRecorder();
    const rect = (id: string, width: number, transform: readonly number[] = base.transform) => ({
      ...base,
      id,
      transform,
      kind: 'container' as const,
      children: [`${id}-text`],
      clip: { kind: 'rect' as const, x: 0, y: 0, width, height: 10 },
    });
    const mask = (id: string, source: Record<string, unknown>) => ({
      ...base,
      id,
      kind: 'container' as const,
      children: [`${id}-source`, `${id}-text`],
      clip: { kind: 'mask' as const },
      source: { ...base, id: `${id}-source`, parentId: id, ...source },
    });
    const filled = mask('m-ok', {
      kind: 'primitive',
      geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
      style: { fill: { r: 0, g: 0, b: 0, a: 1 }, stroke: null },
    });
    const line = mask('m-line', {
      kind: 'primitive',
      geometry: { kind: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
      style: { fill: null, stroke: { color: { r: 0, g: 0, b: 0, a: 1 }, width: 1 } },
    });
    const containers = [
      rect('r-ok', 10),
      rect('r-zero', 0),
      rect('r-singular', 10, [0, 0, 0, 1, 0, 0]),
    ];
    const masks = [filled, line];
    recorder.recordSnapshot({
      identity: { documentId: 'd', pageId: 'p' },
      revision: 1,
      nodes: [
        ...containers.flatMap((c) => [c, leaf(c.id)]),
        ...masks.flatMap(({ source, ...c }) => [c, source, leaf(c.id)]),
      ] as never,
      rootOrder: [...containers, ...masks].map((c) => c.id),
    });
    const shown = Object.fromEntries(
      recorder.textScene(1)!.leaves.map((value) => [value.id, value.shown]),
    );
    expect(shown).toEqual({
      'r-ok-text': true,
      'r-zero-text': false,
      'r-singular-text': false,
      'm-ok-text': true,
      'm-line-text': false,
    });
  });
});
