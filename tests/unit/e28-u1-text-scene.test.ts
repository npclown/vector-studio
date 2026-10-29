import type {
  GlyphRasterPort,
  RenderChangeSet,
  RendererInvalidationTarget,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneTextRun,
} from '@vector-studio/contracts';
import {
  DIAGNOSTIC_CODES,
  SCENE_TEXT_MAX_CLUSTERS,
  SCENE_TEXT_MAX_RUNS,
  SCENE_TEXT_MAX_SIZE,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import type { PrimitivePacket } from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import {
  RetainedSceneMirror,
  type RetainedSceneMirrorOptions,
} from '../../packages/renderer-core/src/scene-mirror.js';
import { target } from '../support/v3a-path-harness.js';

// E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md), E28-A01: the `text` scene kind,
// its E28-S1 and S2 shape and limits, the E28-S3 gate through the mirror and the service options,
// the E28-S4 mask-source rule, equality and change sets, and the reserved diagnostic codes. U1
// accepts text under `text: 'atlas'` but draws nothing; U2 plans it.

const identity = { documentId: 'e28-u1', pageId: 'page' } as const;
const affine = [1, 0, 0, 1, 0, 0] as const;
const ATLAS: RetainedSceneMirrorOptions = { pathNodes: 'unsupported', textNodes: 'supported' };
const NONE: RetainedSceneMirrorOptions = { pathNodes: 'unsupported' };
const invalidation: RendererInvalidationTarget = {
  invalidate: () => undefined,
  setMode: () => undefined,
};
const raster: GlyphRasterPort = {
  portVersion: 0,
  operationId: 'fake/raster-v0',
  rasterize: () => ({ status: 'empty' }),
};

const run = (overrides: Partial<SceneTextRun> = {}): SceneTextRun => ({
  fontList: '"Arial", "Malgun Gothic", sans-serif',
  size: 16,
  color: { r: 0, g: 0, b: 0, a: 1 },
  clusters: [
    { text: 'A', x: 0, y: 12, advance: 10 },
    { text: '한', x: 10, y: 12, advance: 16 },
  ],
  ...overrides,
});

function text(
  id: string,
  parentId: string | null = null,
  overrides: Record<string, unknown> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: affine,
    visible: true,
    opacity: 1,
    kind: 'text',
    generation: 0,
    lang: 'ko',
    runs: [run()],
    ...overrides,
  };
}

function container(
  id: string,
  children: string[],
  clip: 'mask' | null = null,
  parentId: string | null = null,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: affine,
    visible: true,
    opacity: 1,
    kind: 'container',
    children,
    clip: clip === null ? null : { kind: 'mask' },
  };
}

function rect(id: string, parentId: string | null): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: affine,
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 4, height: 4, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
  };
}

function snapshot(nodes: readonly RenderNodeSnapshot[], revision = 1): RenderSceneSnapshot {
  const rootOrder = nodes.filter((node) => node.parentId === null).map((node) => node.id);
  return { identity, revision, nodes, rootOrder };
}

function status(result: ReturnType<RetainedSceneMirror['replaceSnapshot']>): string {
  return result.status === 'invalid-scene' ? result.reason : result.status;
}

const replace = (nodes: readonly RenderNodeSnapshot[], options = ATLAS) =>
  status(new RetainedSceneMirror(undefined, options).replaceSnapshot(snapshot(nodes)));

const withRun = (overrides: Partial<SceneTextRun>) => text('t', null, { runs: [run(overrides)] });
const withCluster = (cluster: Record<string, unknown>) => withRun({ clusters: [cluster as never] });

describe('E28-A01 text scene kind', () => {
  it('accepts a well-formed text node under textNodes: supported', () => {
    expect(replace([text('t')])).toBe('applied');
    expect(replace([text('t', null, { runs: [] })])).toBe('applied');
    expect(replace([text('t', null, { generation: Number.MAX_SAFE_INTEGER })])).toBe('applied');
    expect(replace([text('t', null, { lang: 'zh-Hant-TW' })])).toBe('applied');
    expect(replace([withRun({ size: SCENE_TEXT_MAX_SIZE })])).toBe('applied');
    expect(replace([withCluster({ text: '👨‍👩‍👧', x: -3.5, y: 0, advance: 0 })])).toBe('applied');
    // DEL (U+007F) is neither C0 nor C1 (E28-S2); U+00A0 follows the C1 range.
    expect(replace([withCluster({ text: '\u007f', x: 0, y: 0, advance: 0 })])).toBe('applied');
    expect(replace([withCluster({ text: '\u00a0', x: 0, y: 0, advance: 0 })])).toBe('applied');
  });

  it('reports text as unsupported-feature without the gate, after the shape check', () => {
    expect(replace([text('t')], NONE)).toBe('unsupported-feature');
    expect(replace([text('t', null, { lang: '' })], NONE)).toBe('invalid-value');
  });

  it('rejects each E28-S1 and S2 violation with invalid-value', () => {
    const invalid: RenderNodeSnapshot[] = [
      text('t', null, { generation: -1 }),
      text('t', null, { generation: 1.5 }),
      text('t', null, { generation: Number.MAX_SAFE_INTEGER + 1 }),
      text('t', null, { lang: '' }),
      text('t', null, { lang: 'x'.repeat(36) }),
      text('t', null, { lang: 'ko_KR' }),
      text('t', null, { lang: 'ko KR' }),
      text('t', null, { lang: 'ㄱ' }),
      text('t', null, { children: [] }),
      text('t', null, { clip: null }),
      withRun({ fontList: '' }),
      withRun({ fontList: 'a'.repeat(513) }),
      withRun({ size: 0 }),
      withRun({ size: -1 }),
      withRun({ size: SCENE_TEXT_MAX_SIZE + 1 }),
      withRun({ size: Number.NaN }),
      withRun({ color: { r: 2, g: 0, b: 0, a: 1 } }),
      withCluster({ text: '', x: 0, y: 0, advance: 0 }),
      withCluster({ text: 'a'.repeat(33), x: 0, y: 0, advance: 0 }),
      withCluster({ text: '\n', x: 0, y: 0, advance: 0 }),
      withCluster({ text: '\u0085', x: 0, y: 0, advance: 0 }),
      withCluster({ text: '\u0080', x: 0, y: 0, advance: 0 }),
      withCluster({ text: '\u009f', x: 0, y: 0, advance: 0 }),
      withCluster({ text: '\ud800', x: 0, y: 0, advance: 0 }),
      withCluster({ text: '\udc00a', x: 0, y: 0, advance: 0 }),
      withCluster({ text: 'a', x: Number.POSITIVE_INFINITY, y: 0, advance: 0 }),
      withCluster({ text: 'a', x: 0, y: 0, advance: Number.NaN }),
      withCluster({ text: 'a', x: 0, y: 0 }),
      withCluster({ text: 'a', x: 0, y: 0, advance: 0, extra: 1 }),
    ];
    for (const node of invalid) expect(replace([node])).toBe('invalid-value');
  });

  it('accepts exactly SCENE_TEXT_MAX_CLUSTERS clusters across runs', () => {
    const cluster = { text: 'a', x: 0, y: 0, advance: 1 };
    const half = SCENE_TEXT_MAX_CLUSTERS / 2;
    const runs = (extra: number) => [
      run({ clusters: Array.from({ length: half }, () => cluster) }),
      run({ clusters: Array.from({ length: half + extra }, () => cluster) }),
    ];
    expect(replace([text('t', null, { runs: runs(0) })])).toBe('applied');
    expect(replace([text('t', null, { runs: runs(1) })])).toBe('invalid-value');
  });

  it('accepts exactly SCENE_TEXT_MAX_RUNS runs', () => {
    const empty = run({ clusters: [] });
    const runs = (count: number) => Array.from({ length: count }, () => empty);
    expect(replace([text('t', null, { runs: runs(SCENE_TEXT_MAX_RUNS) })])).toBe('applied');
    expect(replace([text('t', null, { runs: runs(SCENE_TEXT_MAX_RUNS + 1) })])).toBe(
      'invalid-value',
    );
  });

  it('E28-S4: a text mask source is unsupported-feature; text under a mask is accepted', () => {
    const options: RetainedSceneMirrorOptions = { ...ATLAS, clips: 'supported' };
    expect(
      replace([container('m', ['src', 'r'], 'mask'), text('src', 'm'), rect('r', 'm')], options),
    ).toBe('unsupported-feature');
    expect(
      replace([container('m', ['src', 't'], 'mask'), rect('src', 'm'), text('t', 'm')], options),
    ).toBe('applied');
  });

  it('E28-S4 holds for a change set that only reorders a text node into the source slot', () => {
    const options: RetainedSceneMirrorOptions = { ...ATLAS, clips: 'supported' };
    const mirror = new RetainedSceneMirror(undefined, options);
    expect(
      status(
        mirror.replaceSnapshot(
          snapshot([container('m', ['src', 't'], 'mask'), rect('src', 'm'), text('t', 'm')]),
        ),
      ),
    ).toBe('applied');
    const reorder: RenderChangeSet = {
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [],
      updated: [],
      removed: [],
      orders: [{ parentId: 'm', children: ['t', 'src'] }],
    };
    expect(status(mirror.applyChanges(reorder))).toBe('unsupported-feature');
  });

  it('a text node cannot be a parent', () => {
    expect(replace([text('t'), rect('r', 't')])).toBe('invalid-parent');
  });

  it('equality and change sets cover the text kind', () => {
    const mirror = new RetainedSceneMirror(undefined, ATLAS);
    const nodes = [text('t')];
    expect(status(mirror.replaceSnapshot(snapshot(nodes)))).toBe('applied');
    // An equal snapshot at the same revision replays; any field change is a conflict.
    expect(status(mirror.replaceSnapshot(snapshot(nodes)))).toBe('replayed');
    const changed: RenderNodeSnapshot[] = [
      text('t', null, { generation: 1 }),
      text('t', null, { lang: 'ja' }),
      withRun({ fontList: 'serif' }),
      withRun({ size: 17 }),
      withRun({ color: { r: 0, g: 0, b: 0, a: 0.5 } }),
      withCluster({ text: 'B', x: 0, y: 12, advance: 10 }),
      text('t', null, { runs: [run(), run()] }),
      // Each cluster field of the second cluster, at an unchanged cluster count.
      ...(['text', 'x', 'y', 'advance'] as const).map((field) => {
        const clusters = run().clusters.map((cluster) => ({ ...cluster }));
        const second: Record<string, unknown> = clusters[1]!;
        second[field] = field === 'text' ? '글' : (second[field] as number) + 0.5;
        return withRun({ clusters });
      }),
    ];
    for (const node of changed) {
      expect(status(mirror.replaceSnapshot(snapshot([{ ...node, id: 't' }])))).toBe(
        'revision-conflict',
      );
    }
    // A change in the second run only.
    const twoRuns = new RetainedSceneMirror(undefined, ATLAS);
    expect(
      status(twoRuns.replaceSnapshot(snapshot([text('t', null, { runs: [run(), run()] })]))),
    ).toBe('applied');
    expect(
      status(
        twoRuns.replaceSnapshot(snapshot([text('t', null, { runs: [run(), run({ size: 17 })] })])),
      ),
    ).toBe('revision-conflict');
    const update: RenderChangeSet = {
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [],
      updated: [text('t', null, { generation: 1 })],
      removed: [],
      orders: [],
    };
    expect(status(mirror.applyChanges(update))).toBe('applied');
    const badUpdate: RenderChangeSet = {
      ...update,
      revision: 3,
      baseRevision: 2,
      updated: [text('t', null, { lang: '' })],
    };
    expect(status(mirror.applyChanges(badUpdate))).toBe('invalid-value');
  });

  it('change sets insert and remove text nodes', () => {
    const mirror = new RetainedSceneMirror(undefined, ATLAS);
    expect(status(mirror.replaceSnapshot(snapshot([rect('r', null)])))).toBe('applied');
    const insert: RenderChangeSet = {
      identity,
      revision: 2,
      baseRevision: 1,
      inserted: [text('t')],
      updated: [],
      removed: [],
      orders: [{ parentId: null, children: ['r', 't'] }],
    };
    expect(status(mirror.applyChanges(insert))).toBe('applied');
    const remove: RenderChangeSet = {
      identity,
      revision: 3,
      baseRevision: 2,
      inserted: [],
      updated: [],
      removed: ['t'],
      orders: [{ parentId: null, children: ['r'] }],
    };
    expect(status(mirror.applyChanges(remove))).toBe('applied');
    const badInsert: RenderChangeSet = {
      ...insert,
      revision: 4,
      baseRevision: 3,
      inserted: [text('t', null, { lang: '' })],
    };
    expect(status(mirror.applyChanges(badInsert))).toBe('invalid-value');
  });
});

describe('E28-S3 service options', () => {
  it('rejects bad text and glyphRaster options with TypeError', () => {
    const make = (options: Record<string, unknown>) => () =>
      new PrimitiveRendererService(invalidation, options);
    expect(make({ text: 'dom' })).toThrow(TypeError);
    expect(make({ text: 'atlas', glyphRaster: raster })).toThrow(TypeError);
    expect(make({ text: 'atlas', clips: 'rect' })).toThrow(TypeError);
    const badPorts = [
      null,
      {},
      { portVersion: 1, operationId: 'x', rasterize: () => undefined },
      { portVersion: 0, operationId: '', rasterize: () => undefined },
      { portVersion: 0, operationId: 'x', rasterize: 1 },
      { portVersion: 0, operationId: 'x', buildFillMeshes: () => undefined },
    ];
    for (const glyphRaster of badPorts) {
      expect(make({ text: 'atlas', clips: 'rect', glyphRaster })).toThrow(TypeError);
    }
    expect(make({ text: 'atlas', clips: 'rect', glyphRaster: raster })).not.toThrow();
    // A port without the gate is allowed and changes nothing.
    expect(make({ glyphRaster: raster })).not.toThrow();
  });

  it("text: 'none' rejects text; 'atlas' accepts it, sets requiresTextPipeline and draws nothing yet", () => {
    const none = new PrimitiveRendererService(invalidation);
    expect(none.requiresTextPipeline).toBe(false);
    expect(status(none.replaceSnapshot(snapshot([text('t')])))).toBe('unsupported-feature');

    const atlas = new PrimitiveRendererService(invalidation, {
      text: 'atlas',
      clips: 'rect',
      glyphRaster: raster,
    });
    expect(atlas.requiresTextPipeline).toBe(true);
    expect(status(atlas.replaceSnapshot(snapshot([rect('r', null), text('t')])))).toBe('applied');
    atlas.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    const packet = atlas.prepare(target) as PrimitivePacket;
    expect(packet.draws.reduce((sum, draw) => sum + draw.count, 0)).toBe(1);
  });
});

describe('E28 diagnostic codes', () => {
  it('reserves the three warnings', () => {
    expect(DIAGNOSTIC_CODES.TEXT_UNAVAILABLE).toBe('render.text-unavailable');
    expect(DIAGNOSTIC_CODES.TEXT_RESOURCE_LIMIT).toBe('render.text-resource-limit');
    expect(DIAGNOSTIC_CODES.GLYPH_RASTER_FAILURE).toBe('render.glyph-raster-failure');
  });
});
