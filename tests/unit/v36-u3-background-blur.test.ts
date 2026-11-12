import type {
  RenderNodeSnapshot,
  SceneBlendMode,
  SceneColor,
  SceneEffect,
} from '@vector-studio/contracts';
import { EditorProvider, PropertySections } from '@vector-studio/ui';
import { type AnimationFrameClock } from '@vector-studio/renderer-core';
import {
  WebGpuBackend,
  createBrowserWebGpuPlatform,
  type WebGpuPlatform,
} from '@vector-studio/renderer-webgpu';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '../../packages/editor-core/src/index.js';

import { V35_BLEND_ROOTS_MAX } from '../../packages/renderer-core/src/backdrop-plan.js';
import {
  backdropMargin,
  planEffectBudget,
  type BudgetLayer,
} from '../../packages/renderer-core/src/effect-plan.js';
import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { planBackgroundBlurPasses } from '../../packages/renderer-webgpu/src/effect-pipeline.js';
import {
  BACKGROUND_BLUR_NESTED_NOTE,
  backgroundBlurNested,
  effectRows,
} from '../../packages/ui/src/effects-model.js';
import { GpuRecorder, installRecordedBrowserGpu } from '../support/e10-gpu-recorder.js';
import { nativeFixture, nativeScene, submitted } from '../support/p4-native-fixture.js';

// V-36 contract (docs/plans/viz-v36-inner-shadow-background-blur-contract.md), unit U3, renderer
// half: the backdrop request of a background-blur root (section 5.2: main pass only, margin
// `backdropMargin(σ)`, the larger margin with a blend mode, none below the σ epsilon or on a
// target without snapshots), the 64-blend-root limit it does not count toward (5.4), the
// budget's `D` and `B` (5.5), and the frame on the fake device: the split, the passes between
// the snapshot and the resume, `B` then `R`, and `backgroundBlurSkipped` (5.4, V36-A06). The
// passes' arithmetic is in e41-u5-effect-passes.test.ts; the pixels in tests/gpu.

const red: SceneColor = { r: 1, g: 0, b: 0, a: 0.3 };
const shade: SceneColor = { r: 0, g: 0, b: 0, a: 0.5 };
const identity = { documentId: 'v36-u3', pageId: 'page' } as const;

const backgroundBlur = (sigma: number): SceneEffect => ({ kind: 'backgroundBlur', sigma });
const drop = (sigma: number): SceneEffect => ({
  kind: 'dropShadow',
  color: shade,
  offsetX: 2,
  offsetY: 2,
  sigma,
});

function box(
  id: string,
  parentId: string | null,
  x: number,
  extra: Partial<{
    effects: readonly SceneEffect[];
    opacity: number;
    blendMode: SceneBlendMode;
    y: number;
  }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, extra.y ?? 40],
    visible: true,
    opacity: extra.opacity ?? 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 20, height: 20, cornerRadii: [0, 0, 0, 0] },
    style: { fill: red, stroke: null },
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
    ...(extra.blendMode === undefined ? {} : { blendMode: extra.blendMode }),
  };
}

function group(
  id: string,
  children: readonly string[],
  extra: Partial<{ opacity: number; effects: readonly SceneEffect[] }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: extra.opacity ?? 1,
    kind: 'container',
    clip: null,
    children,
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
  };
}

const base: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 1,
  targetFormat: 'bgra8unorm',
};
const snapshots: PrimitiveTarget = { ...base, backdropSnapshots: true };

function prepare(
  nodes: readonly RenderNodeSnapshot[],
  target: PrimitiveTarget = snapshots,
  blend: 'none' | 'v0' = 'none',
): PrimitivePacket {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'unsupported',
    clips: 'supported',
    groupOpacity: 'supported',
    effects: 'v1',
    ...(blend === 'v0' ? { blend } : {}),
  });
  mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  const result = mirror.replaceSnapshot({
    identity,
    revision: 1,
    nodes,
    rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  });
  expect(result.status).toBe('applied');
  return new PrimitiveSceneSource(mirror).prepare(target) as PrimitivePacket;
}

const layerOf = (packet: PrimitivePacket, id: string) =>
  packet.layers!.layers.find((layer) => layer.nodeId === id)!;

describe('V-36 U3 the backdrop request (section 5.2, 5.3)', () => {
  it('asks a main-pass background-blur root for a backdrop at backdropMargin(σ)', () => {
    const packet = prepare([box('a', null, 100, { effects: [backgroundBlur(10)] })]);
    const layer = layerOf(packet, 'a');
    expect(layer.parent).toBe(-1);
    expect(layer.blend).toBeUndefined();
    expect(layer.backdrop).toEqual({ margin: backdropMargin(10) });
    // σ 10 has no levels: 30 taps, s (r + 2) = 32.
    expect(backdropMargin(10)).toBe(32);
    // σ 20 downsamples once: r = 30, 2 × 32.
    expect(backdropMargin(20)).toBe(64);
  });

  it('asks nothing for a nested root, below the σ epsilon or on a target without snapshots', () => {
    const nested = prepare([
      group('g', ['a'], { opacity: 0.5 }),
      box('a', 'g', 100, { effects: [backgroundBlur(10)] }),
    ]);
    expect(layerOf(nested, 'a').parent).not.toBe(-1);
    expect(layerOf(nested, 'a').backdrop).toBeUndefined();
    const inEffect = prepare([
      group('g', ['a'], { effects: [drop(1)] }),
      box('a', 'g', 100, { effects: [backgroundBlur(10)] }),
    ]);
    expect(layerOf(inEffect, 'a').backdrop).toBeUndefined();
    const tiny = prepare([box('a', null, 100, { effects: [backgroundBlur(1e-4)] })]);
    expect(layerOf(tiny, 'a').effect!.backgroundBlur).toEqual({ sigmaPx: 1e-4 });
    expect(layerOf(tiny, 'a').backdrop).toBeUndefined();
    const plain = prepare([box('a', null, 100, { effects: [backgroundBlur(10)] })], base);
    expect(layerOf(plain, 'a').backdrop).toBeUndefined();
  });

  it('takes the larger margin for a blend root, and margin 0 for a blend root alone', () => {
    const target = { ...snapshots, blendLayers: true };
    const packet = prepare(
      [
        box('a', null, 100, { effects: [backgroundBlur(10)], blendMode: 'multiply' }),
        box('b', null, 200, { blendMode: 'screen' }),
      ],
      target,
      'v0',
    );
    expect(layerOf(packet, 'a').blend).toBe('multiply');
    expect(layerOf(packet, 'a').backdrop).toEqual({ margin: 32 });
    expect(layerOf(packet, 'b').backdrop).toEqual({ margin: 0 });
  });

  it('does not count background-blur roots toward the 64 blend roots', () => {
    const nodes = [
      box('glass', null, 0, { y: 300, effects: [backgroundBlur(4)] }),
      ...Array.from({ length: V35_BLEND_ROOTS_MAX }, (_, index) =>
        box(`b${index}`, null, (index % 16) * 30, {
          y: Math.floor(index / 16) * 30,
          blendMode: 'multiply',
        }),
      ),
    ];
    const packet = prepare(nodes, { ...snapshots, blendLayers: true }, 'v0');
    expect(packet.layers!.blendNotices).toBeUndefined();
    expect(packet.layers!.layers.filter((layer) => layer.blend !== undefined)).toHaveLength(64);
    expect(layerOf(packet, 'glass').backdrop).toEqual({ margin: backdropMargin(4) });
  });
});

describe('V-36 U3 the budget (section 5.5)', () => {
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  const tree = (layer: Partial<Extract<BudgetLayer, { kind: 'effect' }>>) => ({
    rootId: 'r',
    layers: [{ kind: 'effect' as const, source: rect, output: rect, ...layer }],
    withoutEffects: [],
    effectRoots: ['r'],
  });
  it('counts B at 4 O and D at 4 |D|, and D in the scratch maximum', () => {
    const limit = 4_000_000;
    const bytes = (layer: Partial<Extract<BudgetLayer, { kind: 'effect' }>>) =>
      planEffectBudget([tree(layer)], 1, 8192, 0).rejected.get('r')!;
    const plain = bytes({});
    // 4 × |D| for the snapshot, 4 × 100 for B, and the scratch over |D| instead of |O|.
    const glass = bytes({ snapshot: 10_000, blurred: 100 });
    const scratch = (area: number) => Math.ceil(4 * (2 + 2 / 3) * area);
    expect(glass - plain).toBe(4 * 10_000 + 4 * 100 + scratch(10_000) - scratch(100));
    // A blend root's snapshot alone does not enter the scratch maximum.
    expect(bytes({ snapshot: 10_000 }) - plain).toBe(4 * 10_000);
    // Over the limit, the tree drops its effects (one notice), as E41's roots do.
    const over = planEffectBudget([tree({ snapshot: 400_000, blurred: 100 })], 1, 8192, limit);
    expect(over.withEffects.has('r')).toBe(false);
    expect(over.effectNotices).toHaveLength(1);
  });

  it('plans D and B per root in the tree admission', () => {
    // A 600 × 340 glass card at σ 20 needs O, D (grown by 64, clamped to the target), B and
    // the scratch over D: one root fits the 96 MiB, and the packet keeps its request.
    const packet = prepare([
      {
        ...box('a', null, 20, { y: 10, effects: [backgroundBlur(20)] }),
        geometry: { kind: 'rectangle', width: 600, height: 340, cornerRadii: [0, 0, 0, 0] },
      } as RenderNodeSnapshot,
    ]);
    expect(layerOf(packet, 'a').backdrop).toEqual({ margin: 64 });
    expect(packet.layers!.effectNotices).toBeUndefined();
  });
});

describe('V-36 U3 the frame (section 5.2, 5.4)', () => {
  const pipelines = {
    clipPipeline: true,
    layerPipeline: true,
    effectPipeline: true,
    blendPipeline: true,
  } as const;
  const outline = (calls: readonly (readonly unknown[])[]) =>
    calls
      .filter(([name]) => name === 'beginRenderPass' || name === 'setPipeline')
      .map((call) => call[1] as string);

  it('splits the main pass, runs the blur passes, then draws B and R in the resumed pass', async () => {
    const fixture = nativeFixture();
    const { scene, target, creation } = await nativeScene(fixture, pipelines);
    const packet = prepare(
      [box('under', null, 90), box('a', null, 100, { effects: [backgroundBlur(10), drop(1)] })],
      { ...target, backdropSnapshots: true },
    );
    const layer = layerOf(packet, 'a');
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(packet));
    const calls = outline(fixture.calls);
    const split = calls.indexOf('vector-studio/backdrop-snapshot');
    expect(split).toBeGreaterThan(0);
    expect(calls.lastIndexOf('vector-studio/primitive-pass', split)).toBeGreaterThan(-1);
    const resume = calls.indexOf('vector-studio/primitive-pass', split);
    const between = calls.slice(split + 2, resume).filter((label) => label.includes('effect-pass'));
    expect(between).toEqual([
      'vector-studio/effect-pass/0/blur',
      'vector-studio/effect-pass/0/blur',
      'vector-studio/effect-pass/0/coverage',
    ]);
    const plan = planBackgroundBlurPasses(
      { x: 0, y: 0, width: 1, height: 1 },
      layer.bound,
      layer.effect!.output,
      layer.effect!,
      false,
    );
    expect(between.map((label) => label.split('/').at(-1))).toEqual(
      plan.passes.map((pass) => pass.kind),
    );
    // In the resumed pass: B through the layer composite, then R, both source-over.
    const after = calls.slice(resume + 1).filter((label) => label.includes('composite'));
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(after[1]);
    expect(after[0]).not.toContain('blend');
    // B is the root's result bound; its texture is transient.
    const glass = fixture.textures.find((texture) => texture.label.endsWith('effect-blurred-0'))!;
    expect([glass.width, glass.height]).toEqual([
      layer.effect!.output.width,
      layer.effect!.output.height,
    ]);
    expect(fixture.destroyed).toContain(glass.label);
    expect(fixture.destroyed.some((label) => label.endsWith('/backdrop-0'))).toBe(true);
    expect(scene.blendSplits).toBe(1);
    expect(scene.effectPasses).toBe(1);
    expect(scene.backgroundBlurSkipped).toBe(0);
    creation.dispose();
  });

  it('counts a nested root, a root without the snapshot pipeline and none below the σ epsilon', async () => {
    const fixture = nativeFixture();
    const { scene, target, creation } = await nativeScene(fixture, pipelines);
    const on = { ...target, backdropSnapshots: true };
    // Nested in a 50 % group: drawn without its blur, counted, no split.
    submitted(
      scene.submitPrimitivePacket(
        prepare(
          [
            group('g', ['a'], { opacity: 0.5 }),
            box('a', 'g', 100, { effects: [backgroundBlur(10)] }),
          ],
          on,
        ),
      ),
    );
    expect([scene.backgroundBlurSkipped, scene.blendSplits]).toEqual([1, 0]);
    // Below the epsilon: no blur to draw, no split, not a skip.
    submitted(
      scene.submitPrimitivePacket(
        prepare([box('a', null, 100, { effects: [backgroundBlur(1e-4)] })], on),
      ),
    );
    expect([scene.backgroundBlurSkipped, scene.blendSplits]).toEqual([1, 0]);
    creation.dispose();
    // Without the snapshot pipeline (no `blendPipeline`): counted, the root still draws.
    const without = nativeFixture();
    const plain = await nativeScene(without, { ...pipelines, blendPipeline: false });
    const packet = prepare([box('a', null, 100, { effects: [backgroundBlur(10)] })], {
      ...plain.target,
      backdropSnapshots: true,
    });
    without.calls.length = 0;
    submitted(plain.scene.submitPrimitivePacket(packet));
    expect(plain.scene.backgroundBlurSkipped).toBe(1);
    expect(plain.scene.effectPasses).toBe(1);
    expect(outline(without.calls)).not.toContain('vector-studio/backdrop-snapshot');
    plain.creation.dispose();
  });

  it('merges B over the snapshot before a blend root’s blend composite', async () => {
    const fixture = nativeFixture();
    const { scene, target, creation } = await nativeScene(fixture, pipelines);
    const packet = prepare(
      [box('a', null, 100, { effects: [backgroundBlur(4)], blendMode: 'multiply' })],
      { ...target, backdropSnapshots: true, blendLayers: true },
      'v0',
    );
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(packet));
    const calls = outline(fixture.calls);
    const split = calls.indexOf('vector-studio/backdrop-snapshot');
    const resume = calls.indexOf('vector-studio/primitive-pass', split);
    expect(calls.slice(split, resume).filter((label) => label.includes('effect-pass'))).toEqual([
      'vector-studio/effect-pass/0/blur',
      'vector-studio/effect-pass/0/blur',
      'vector-studio/effect-pass/0/coverage',
      'vector-studio/effect-pass/0/merge',
    ]);
    // The merge writes the snapshot over O, at its offset in the snapshot.
    const mergeAt = fixture.calls
      .map(
        (call) => call[0] === 'beginRenderPass' && call[1] === 'vector-studio/effect-pass/0/merge',
      )
      .lastIndexOf(true);
    expect(fixture.calls[mergeAt]![2]).toMatch(/backdrop-0$/u);
    const margin = backdropMargin(4);
    expect(fixture.calls[mergeAt + 1]!.slice(0, 3)).toEqual(['setViewport', margin, margin]);
    const after = calls.slice(resume + 1).filter((label) => label.includes('composite'));
    expect(after).toHaveLength(2);
    expect(after[0]).not.toContain('blend');
    expect(after[1]).toContain('blend-composite');
    expect(scene.backgroundBlurSkipped).toBe(0);
    creation.dispose();
  });

  it('keeps a frame without background blur as before (no B, no extra pass)', async () => {
    const fixture = nativeFixture();
    const { scene, target, creation } = await nativeScene(fixture, pipelines);
    submitted(
      scene.submitPrimitivePacket(
        prepare([box('a', null, 100, { effects: [drop(2)] })], {
          ...target,
          backdropSnapshots: true,
        }),
      ),
    );
    expect(outline(fixture.calls)).not.toContain('vector-studio/backdrop-snapshot');
    expect(fixture.textures.some((texture) => texture.label.includes('blurred'))).toBe(false);
    creation.dispose();
  });
});

describe('V-36 U3 the source flag (section 5.2)', () => {
  it("asks for the backdrop snapshot exactly under effects 'v1'", () => {
    const service = (effects: 'none' | 'v0' | 'v1') =>
      new PrimitiveRendererService({ invalidate: () => undefined } as never, {
        groups: 'isolated',
        clips: 'all',
        effects,
      });
    expect(service('v1').requiresBackdropSnapshot).toBe(true);
    expect(service('v0').requiresBackdropSnapshot).toBe(false);
    expect(service('none').requiresBackdropSnapshot).toBe(false);
  });
});

// V-36 section 5.3 in the panel: the nested rule on the document and its message.
function editor(): Editor {
  return createEditor({ ids: createCounterIdSource('n'), projectEffects: 'v1' });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

const rectangle = (target: Editor, x = 0) =>
  ok(target, { type: 'createRectangle', frame: { x, y: 0, width: 20, height: 20 } })[0]!;

const nested = (target: Editor, ids: readonly string[]) => {
  const document = target.getSnapshot().document;
  const nodes = ids.map((id) => document.nodes[id]!);
  return effectRows(nodes).map((row) => backgroundBlurNested(document, nodes, row));
};

const panel = (target: Editor) =>
  renderToString(
    createElement(EditorProvider, { editor: target }, createElement(PropertySections)),
  );

describe('V-36 U3 the nested background-blur message (section 5.3)', () => {
  it('marks a background blur under a group with opacity or effects, not at the top level', () => {
    const target = editor();
    const a = rectangle(target);
    const b = rectangle(target, 40);
    ok(target, { type: 'addEffect', ids: [a, b], kind: 'dropShadow' });
    ok(target, { type: 'addEffect', ids: [a, b], kind: 'backgroundBlur' });
    expect(nested(target, [a])).toEqual([false, false]);
    const [group] = ok(target, { type: 'groupNodes', ids: [a], kind: 'group' });
    expect(nested(target, [a])).toEqual([false, false]);
    ok(target, { type: 'setStyle', ids: [group!], style: { opacity: 0.5 } });
    // Only the background-blur row; any selected holder makes it nested.
    expect(nested(target, [a])).toEqual([false, true]);
    expect(nested(target, [b, a])).toEqual([false, true]);
    expect(nested(target, [b])).toEqual([false, false]);
    ok(target, { type: 'setStyle', ids: [group!], style: { opacity: 1 } });
    ok(target, { type: 'addEffect', ids: [group!], kind: 'layerBlur' });
    expect(nested(target, [a])).toEqual([false, true]);
    // A hidden effect draws nothing, so it makes no layer.
    ok(target, { type: 'setEffect', ids: [group!], index: 0, patch: { visible: false } });
    expect(nested(target, [a])).toEqual([false, false]);
    // V-35: a group with a blend mode other than pass-through is a layer too.
    ok(target, { type: 'setStyle', ids: [group!], style: { blendMode: 'normal' } });
    expect(nested(target, [a])).toEqual([false, true]);
    ok(target, { type: 'setStyle', ids: [group!], style: { blendMode: 'passThrough' } });
    expect(nested(target, [a])).toEqual([false, false]);
  });

  it("inside a symbol, counts each instance with its own effects, else its symbol's (E41-S10)", () => {
    const target = editor();
    const a = rectangle(target);
    const [symbol] = ok(target, { type: 'createSymbol', ids: [a] });
    ok(target, { type: 'addEffect', ids: [a], kind: 'backgroundBlur' });
    const [instance] = ok(target, {
      type: 'createInstance',
      symbol: symbol!,
      frame: { x: 300, y: 0, width: 20, height: 20 },
    });
    expect(nested(target, [a])).toEqual([false]);
    ok(target, { type: 'addEffect', ids: [instance!], kind: 'dropShadow' });
    expect(nested(target, [a])).toEqual([true]);
    ok(target, { type: 'removeEffect', ids: [instance!], index: 0 });
    expect(nested(target, [a])).toEqual([false]);
    // The symbol's own effects draw on it and on an instance without effects of its own.
    ok(target, { type: 'addEffect', ids: [symbol!], kind: 'layerBlur' });
    expect(nested(target, [a])).toEqual([true]);
    ok(target, { type: 'removeEffect', ids: [symbol!], index: 0 });
    ok(target, { type: 'setStyle', ids: [instance!], style: { opacity: 0.5 } });
    expect(nested(target, [a])).toEqual([true]);
  });

  it('shows the message under the row, with its test id, and offers background blur', () => {
    const target = editor();
    const a = rectangle(target);
    ok(target, { type: 'addEffect', ids: [a], kind: 'backgroundBlur' });
    ok(target, { type: 'setSelection', ids: [a] });
    let html = panel(target);
    expect(html).toContain('data-testid="effects-add-background-blur"');
    expect(html).not.toContain('effect-0-nested-note');
    const [group] = ok(target, { type: 'groupNodes', ids: [a], kind: 'group' });
    ok(target, { type: 'setStyle', ids: [group!], style: { opacity: 0.5 } });
    ok(target, { type: 'setSelection', ids: [a] });
    html = panel(target);
    expect(html).toMatch(
      new RegExp(`data-testid="effect-0-nested-note"[^>]*>${BACKGROUND_BLUR_NESTED_NOTE}<`, 'u'),
    );
    expect(BACKGROUND_BLUR_NESTED_NOTE).toBe(
      'Background blur shows only outside groups with opacity or effects',
    );
  });
});

// The backend half: the canvas usage and the snapshot pipeline under effects 'v1' (the V35-K4
// amendment, section 5.2), on a recorded fake device through the browser platform.
class ManualClock implements AnimationFrameClock {
  #callbacks = new Map<number, (timestampMs: number) => void>();
  #next = 0;
  #now = 0;

  public request(callback: (timestampMs: number) => void): number {
    this.#next += 1;
    this.#callbacks.set(this.#next, callback);
    return this.#next;
  }

  public cancel(handle: number): void {
    this.#callbacks.delete(handle);
  }

  public tick(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    this.#now += 16;
    for (const callback of callbacks) callback(this.#now);
  }
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** A platform whose canvas configure drops `usage`, as a host that does not know it. */
const droppingUsage = (browser: WebGpuPlatform): WebGpuPlatform => ({
  secureContext: browser.secureContext,
  apiAvailable: browser.apiAvailable,
  requestAdapter: () => browser.requestAdapter(),
  getPreferredCanvasFormat: () => browser.getPreferredCanvasFormat(),
  getCanvasContext: (canvas) => {
    const context = browser.getCanvasContext(canvas) as unknown as {
      native: GPUCanvasContext;
      configuredUsage: number | undefined;
      configure: (configuration: object) => void;
      unconfigure: () => void;
    };
    return {
      native: context.native,
      get configuredUsage() {
        return context.configuredUsage;
      },
      configure: (configuration: object) => {
        const rest: Record<string, unknown> = { ...configuration };
        delete rest.usage;
        context.configure(rest);
      },
      unconfigure: () => context.unconfigure(),
    } as never;
  },
});

async function backendWith(
  effects: 'v0' | 'v1',
  platform?: (browser: WebGpuPlatform) => WebGpuPlatform,
) {
  const recorder = new GpuRecorder();
  const installed = installRecordedBrowserGpu(recorder, 'bgra8unorm');
  restore = () => installed.restore();
  const clock = new ManualClock();
  const browser = createBrowserWebGpuPlatform();
  const backend = new WebGpuBackend({
    animationFrameClock: clock,
    now: () => 0,
    platform: platform?.(browser) ?? browser,
    sampleCountForTesting: 1,
  });
  const service = new PrimitiveRendererService(backend, {
    clips: 'rect',
    groups: 'isolated',
    effects,
  });
  backend.attachPrimitiveFrameSource(service);
  const result = await backend.initialize({
    canvas: installed.canvas,
    cssSize: { width: 64, height: 32 },
    devicePixelRatio: 1,
  });
  expect(result.supported).toBe(true);
  const usage = (
    recorder.log.find(([name]) => String(name).endsWith('.configure'))?.[1] as
      { usage?: number } | undefined
  )?.usage;
  const draw = () => {
    const nodes = [
      box('under', null, 0, { y: 0 }),
      box('a', null, 4, { y: 4, effects: [backgroundBlur(2)] }),
    ];
    service.replaceSnapshot({
      identity,
      revision: 1,
      nodes,
      rootOrder: nodes.map((node) => node.id),
    });
    service.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    clock.tick();
  };
  return { backend, usage, draw };
}

describe('V-36 U3 the backend (section 5.2, the V35-K4 usage amendment)', () => {
  it("effects 'v1' adds TEXTURE_BINDING and draws the blur at 1x with one split", async () => {
    const h = await backendWith('v1');
    expect(h.usage).toBe(0x14);
    // Blend modes stay off without blend 'v0'.
    expect(h.backend.blendPipelineAvailable).toBe(false);
    h.draw();
    expect(h.backend.getStatistics().framesSubmitted).toBe(1);
    expect(h.backend.getBlendSplitsForTesting()).toBe(1);
    expect(h.backend.getBackgroundBlurSkippedForTesting()).toBe(0);
  });

  it("effects 'v0' configures the canvas as before", async () => {
    const h = await backendWith('v0');
    expect(h.usage).toBeUndefined();
  });

  it('at 1x without TEXTURE_BINDING on the canvas the root draws without its blur, counted', async () => {
    const h = await backendWith('v1', droppingUsage);
    h.draw();
    expect(h.backend.getStatistics().framesSubmitted).toBe(1);
    expect(h.backend.getBlendSplitsForTesting()).toBe(0);
    expect(h.backend.getBackgroundBlurSkippedForTesting()).toBe(1);
  });
});
