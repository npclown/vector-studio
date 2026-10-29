import { createHash } from 'node:crypto';

import type {
  RenderNodeSnapshot,
  RendererDiagnostic,
  SceneAffine,
  SceneGradient,
} from '@vector-studio/contracts';
import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';
import { PrimitiveRendererService, type GradientPaintRecord } from '@vector-studio/renderer-core';
import {
  WebGpuBackend,
  type WebGpuAdapterPort,
  type WebGpuDevicePort,
  type WebGpuPlatform,
  type WebGpuPrimitiveScenePort,
} from '@vector-studio/renderer-webgpu';
import { describe, expect, it, vi } from 'vitest';

import {
  MESH_FILL_CLIP_SHADER,
  MESH_FILL_MASK_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_SHADER,
  PRIMITIVE_ANALYTIC_MASK_SHADER,
} from '../../packages/renderer-webgpu/src/clip-pipeline.js';
import { MESH_FILL_SHADER } from '../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import { meshPipelineKey } from '../../packages/renderer-webgpu/src/mesh-pipeline.js';
import {
  GRADIENT_RECORD_SIZE,
  MESH_FILL_PAINT_CLIP_SHADER,
  MESH_FILL_PAINT_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_SHADER,
  packGradientRecord,
  packPaintIndices,
  paintClipVariantKey,
  paintVariantKey,
} from '../../packages/renderer-webgpu/src/paint-pipeline.js';
import type { PipelineCacheSnapshot } from '../../packages/renderer-webgpu/src/pipeline-cache.js';
import { PRIMITIVE_ANALYTIC_SHADER } from '../../packages/renderer-webgpu/src/primitive-analytic-shader.js';
import { primitivePipelineKey } from '../../packages/renderer-webgpu/src/primitive-pipeline.js';
import { nativeFixture, nativeScene, submitted } from '../support/p4-native-fixture.js';
import {
  ScriptedStrokeMeshPort,
  createStrokeHarness,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';
import { createCountingPort } from '../support/v3a-path-harness.js';

// E23 contract (docs/plans/d9-e23-gradient-paint-contract.md), unit U3: the `+paint-v0`
// pipeline variants (section 4), their modules and keys beside the unchanged base and clip
// modules (E23-A08 hash part), the paint bind group and change-only record writes (E23-A05),
// draw encoding and batching (E23-A06), fail-closed gradient draws and `render.paint-unavailable`
// (E23-A07), and the paint buffers' accounting (E23-A09 unit part). Fake device seams only; the
// rendered evidence (E23-A03) is the SwiftShader readback and U4's headed run.

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };
const linear: SceneGradient = {
  kind: 'linear',
  transform: [10, 0, 0, 10, 0, 0],
  stops: [
    { offset: 0, color: red },
    { offset: 1, color: blue },
  ],
  spread: 'pad',
};

function box(
  id: string,
  x: number,
  fill: unknown = red,
  parentId: string | null = null,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, 20],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill, stroke: null },
  } as RenderNodeSnapshot;
}

function harness(nodes: readonly RenderNodeSnapshot[]) {
  return createStrokeHarness({
    fillPort: createCountingPort(),
    strokePort: new ScriptedStrokeMeshPort(),
    clips: 'rect',
    paints: 'gradient',
    nodes,
  });
}

const encodeCalls = ['setPipeline', 'setBindGroup', 'drawIndexed', 'draw'];
const encoded = (calls: readonly (readonly unknown[])[]) =>
  calls
    .filter(([name]) => encodeCalls.includes(name as string))
    .map((call) => (call[0] === 'setBindGroup' && call[1] === 0 ? ['setBindGroup', 0] : call));
const allOptions = { meshPipeline: true, clipPipeline: true, paintPipeline: true } as const;
const hash = (code: string) => createHash('sha256').update(code).digest('hex');

describe('E23 U3 paint shader variants (section 4, Pipelines; E23-A08 hash part)', () => {
  it('keeps every base, clip and mask module byte-identical to main at the U1 merge base', () => {
    // SHA-256 at 1fb3830; MESH_FILL_SHADER's is the E3-recorded hash.
    expect({
      analytic: hash(PRIMITIVE_ANALYTIC_SHADER),
      mesh: hash(MESH_FILL_SHADER),
      analyticClip: hash(PRIMITIVE_ANALYTIC_CLIP_SHADER),
      meshClip: hash(MESH_FILL_CLIP_SHADER),
      analyticMask: hash(PRIMITIVE_ANALYTIC_MASK_SHADER),
      meshMask: hash(MESH_FILL_MASK_SHADER),
    }).toEqual({
      analytic: '06b0839c15b93141d1caa72596484b0aa02f53e74f1e58b74959fb5b92af527d',
      mesh: 'd306137cf0770f6bf7f9237f1c98b9ecd0a165cfdbfda916196d299e36b831a3',
      analyticClip: '434bc1d2768c1b9d09c385a2ac4f524f3d6976e183fb9324e0612a7a176efc0d',
      meshClip: 'abcac5d89e07e09978e7a93ad4f14783ac17fef656332cdcffa821328e994d7a',
      analyticMask: '64eb3d86eec661291c71665f6bbaeb18095cfb7db793edec1b64a18468bd504b',
      meshMask: 'a479f0c5500d1d446c4b3bd6fa1242a4995e8161fcd02390b112e389d47639f4',
    });
    for (const code of [PRIMITIVE_ANALYTIC_SHADER, MESH_FILL_SHADER, MESH_FILL_CLIP_SHADER]) {
      expect(code).not.toContain('paintValue');
    }
  });

  it('suffixes the variant keys and leaves the base and clip keys alone', () => {
    const analytic = primitivePipelineKey('bgra8unorm', 4, true);
    expect(paintVariantKey(analytic)).toEqual({
      ...analytic,
      shaderKey: 'p1-analytic-v1+paint-v0',
      layoutKey: 'p1-packet-v1+e23-paint-v0',
    });
    expect(paintClipVariantKey(analytic)).toEqual({
      ...analytic,
      shaderKey: 'p1-analytic-v1+paint-v0+clip-v0',
      layoutKey: 'p1-packet-v1+e23-paint-v0+p4-clip-v0',
    });
    expect(paintVariantKey(meshPipelineKey('bgra8unorm', 1, 'joint')).shaderKey).toBe(
      'p3-mesh-joint-v0+paint-v0',
    );
  });

  it('replaces only the paint colour; the paint follows every coverage derivative', () => {
    const entries = (code: string) =>
      code.match(/@fragment\s+fn (\w+)/g)?.map((match) => match.split(' ').pop());
    expect(entries(PRIMITIVE_ANALYTIC_PAINT_SHADER)).toEqual(['fragmentMain']);
    expect(entries(PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER)).toEqual(['fragmentMain']);
    expect(entries(MESH_FILL_PAINT_SHADER)).toEqual(['meshFragmentMain', 'meshJointFragmentMain']);
    expect(entries(MESH_FILL_PAINT_CLIP_SHADER)).toEqual([
      'meshFragmentMain',
      'meshJointFragmentMain',
    ]);
    // P1: both analyticCoverage calls precede both paint calls.
    const main = PRIMITIVE_ANALYTIC_PAINT_SHADER.slice(
      PRIMITIVE_ANALYTIC_PAINT_SHADER.indexOf('@fragment'),
      PRIMITIVE_ANALYTIC_PAINT_SHADER.indexOf(
        '\n}\n',
        PRIMITIVE_ANALYTIC_PAINT_SHADER.indexOf('@fragment'),
      ),
    );
    expect(main.lastIndexOf('analyticCoverage(')).toBeLessThan(main.indexOf('paintContribution('));
    expect(main.match(/paintContribution\(/g)).toHaveLength(2);
    expect(main).not.toContain('premultipliedContribution(style');
    // The clipped modules take the clip coverage first.
    const analyticEntry = PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER.slice(
      PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER.lastIndexOf('@fragment'),
    );
    expect(analyticEntry.indexOf('clipCoverage(')).toBeLessThan(
      analyticEntry.indexOf('shadePrimitive('),
    );
    const joint = MESH_FILL_PAINT_CLIP_SHADER.slice(
      MESH_FILL_PAINT_CLIP_SHADER.lastIndexOf('@fragment'),
    );
    expect(joint.indexOf('clipCoverage(')).toBeLessThan(joint.indexOf('paintValue('));
    expect(joint).toContain('let opacity = fill.opacity * clip;');
    expect(joint).toContain('let strokeAlpha = coverage.y * strokePaint.a;');
    // Paint modules carry the base module apart from the replaced lines.
    expect(PRIMITIVE_ANALYTIC_PAINT_SHADER.startsWith(PRIMITIVE_ANALYTIC_SHADER)).toBe(false);
    expect(
      PRIMITIVE_ANALYTIC_PAINT_SHADER.replace(/fill = paintContribution\([^;]+;/, '').replace(
        /stroke = paintContribution\([^;]+;/,
        '',
      ),
    ).toContain(
      PRIMITIVE_ANALYTIC_SHADER.replace(
        /fill = premultipliedContribution\(style\.fill, contourCoverage\);/,
        '',
      ).replace(/stroke = premultipliedContribution\(style\.stroke, coverage\);/, ''),
    );
  });
});

describe('E23 U3 record and index packing', () => {
  const record: GradientPaintRecord = {
    kind: 'radial',
    spread: 'reflect',
    map: [0.5, 0, 0, 0.25, -1, 2],
    offsets: [0, 0.5, 1],
    colors: [1, 0, 0, 1, 0, 0.5, 0, 0.5, 0, 0, 1, 1],
  };

  it('lays out header, map, offsets and colours in 368 bytes', () => {
    const bytes = packGradientRecord(record)!;
    expect(bytes.byteLength).toBe(GRADIENT_RECORD_SIZE);
    expect(GRADIENT_RECORD_SIZE).toBe(368);
    const view = new DataView(bytes.buffer);
    expect([0, 4, 8].map((offset) => view.getUint32(offset, true))).toEqual([1, 1, 3]);
    expect([16, 20, 24, 28, 32, 36].map((offset) => view.getFloat32(offset, true))).toEqual(
      record.map,
    );
    expect([48, 52, 56].map((offset) => view.getFloat32(offset, true))).toEqual(record.offsets);
    expect(Array.from({ length: 12 }, (_, lane) => view.getFloat32(112 + lane * 4, true))).toEqual(
      record.colors,
    );
    expect(view.getFloat32(60, true)).toBe(0);
  });

  it('refuses malformed records', () => {
    const bad: readonly Partial<Record<keyof GradientPaintRecord, unknown>>[] = [
      { kind: 'conic' },
      { spread: 'clamp' },
      { map: [1, 0, 0, 1, 0] },
      { map: [1, 0, 0, 1, 0, Number.NaN] },
      { map: [1, 0, 0, 1, 0, 0.1] },
      { offsets: [], colors: [] },
      { offsets: [0, 0.6, 0.5] },
      { offsets: [0, 0.5, 1.5] },
      { colors: [1, 0, 0, 1] },
      { colors: [2, 0, 0, 1, 0, 0.5, 0, 0.5, 0, 0, 1, 1] },
    ];
    for (const fields of bad) {
      expect(
        packGradientRecord({ ...record, ...fields } as GradientPaintRecord),
        JSON.stringify(fields),
      ).toBeNull();
    }
  });

  it('packs index pairs at 8 bytes per key, at least 16 bytes', () => {
    expect(packPaintIndices(new Map()).byteLength).toBe(16);
    const bytes = packPaintIndices(
      new Map<number, readonly [number, number]>([
        [3, [2, 0]],
        [0, [0, 1]],
      ]),
    );
    expect(Array.from(new Uint32Array(bytes.buffer))).toEqual([0, 1, 0, 0, 0, 0, 2, 0]);
  });
});

/** The scene's pipeline cache counts (the native scene's test seam). */
const readyOf = (scene: unknown) =>
  (
    scene as { pipelineCacheSnapshotForTesting(): PipelineCacheSnapshot }
  ).pipelineCacheSnapshotForTesting();

describe('E23 U3 pipeline creation', () => {
  it('creates the paint variants after the clip variants, with group 2 the paint layout', async () => {
    const fixture = nativeFixture();
    const { scene, creation, accounting } = await nativeScene(fixture, allOptions);
    expect(scene).toMatchObject({
      paintPipelineAvailable: true,
      clipPipelineAvailable: true,
      pipelinesCreated: 15,
      shaderModulesCreated: 11,
    });
    expect(fixture.pipelineLabels.slice(9)).toEqual([
      'vector-studio/p1-analytic-primitive-stencil-4x+paint-v0',
      'vector-studio/p1-analytic-primitive-stencil-4x+paint-v0+clip-v0',
      'vector-studio/p3-mesh-fill-4x+paint-v0',
      'vector-studio/p3-mesh-joint-4x+paint-v0',
      'vector-studio/p3-mesh-fill-4x+paint-v0+clip-v0',
      'vector-studio/p3-mesh-joint-4x+paint-v0+clip-v0',
    ]);
    const groups = (label: string) =>
      (
        fixture.descriptors.find((descriptor) => descriptor.label === label)!.layout as unknown as {
          groups: { label: string }[];
        }
      ).groups.map((layout) => layout.label);
    expect(groups('vector-studio/p1-analytic-primitive-stencil-4x+paint-v0')).toEqual([
      'vector-studio/p1-primitive-packet-layout',
      'primitive/1/paint-empty-bind-group-layout',
      'vector-studio/e23-paint-layout',
    ]);
    expect(groups('vector-studio/p3-mesh-joint-4x+paint-v0+clip-v0')).toEqual([
      'vector-studio/p3-mesh-packet-layout',
      'vector-studio/p4-clip-layout',
      'vector-studio/e23-paint-layout',
    ]);
    expect(fixture.modules.filter((code) => code.includes('paintValue'))).toEqual([
      PRIMITIVE_ANALYTIC_PAINT_SHADER,
      PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER,
      MESH_FILL_PAINT_SHADER,
      MESH_FILL_PAINT_CLIP_SHADER,
    ]);
    expect(accounting.snapshot().byCategory['render-pipeline'].live).toBe(15);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('creates nothing extra without the option, and only what the other options allow', async () => {
    const plain = nativeFixture();
    const without = await nativeScene(plain, { meshPipeline: true, clipPipeline: true });
    expect(without.scene).toMatchObject({ paintPipelineAvailable: false, pipelinesCreated: 9 });
    expect(plain.modules.some((code) => code.includes('paintValue'))).toBe(false);
    without.creation.dispose();
    const analyticOnly = nativeFixture();
    const only = await nativeScene(analyticOnly, { paintPipeline: true });
    expect(only.scene).toMatchObject({
      paintPipelineAvailable: true,
      pipelinesCreated: 2,
      shaderModulesCreated: 2,
    });
    expect(analyticOnly.pipelineLabels).toEqual([
      'vector-studio/p1-analytic-primitive-4x',
      'vector-studio/p1-analytic-primitive-4x+paint-v0',
    ]);
    only.creation.dispose();
  });

  const steps = [
    ['analytic', 'primitive-stencil-4x+paint-v0'],
    ['analytic clip', 'primitive-stencil-4x+paint-v0+clip'],
    ['mesh', 'p3-mesh-fill-4x+paint-v0'],
    ['mesh joint', 'p3-mesh-joint-4x+paint-v0'],
    ['mesh clip', 'p3-mesh-fill-4x+paint-v0+clip'],
    ['mesh joint clip', 'p3-mesh-joint-4x+paint-v0+clip'],
  ] as const;

  it.each(steps)(
    'E23-A07: a %s failure caches no paint variant and leaves the rest intact',
    async (_, failPipeline) => {
      const plain = await nativeScene(nativeFixture(), { meshPipeline: true, clipPipeline: true });
      const baseline = readyOf(plain.scene).readyEntries;
      const baselineLive = plain.accounting.snapshot().live;
      plain.creation.dispose();
      const { scene, creation, accounting } = await nativeScene(
        nativeFixture({ failPipeline }),
        allOptions,
      );
      expect(scene).toMatchObject({
        paintPipelineAvailable: false,
        clipPipelineAvailable: true,
        meshPipelineAvailable: true,
        pipelinesCreated: 9,
      });
      expect(readyOf(scene).readyEntries).toBe(baseline);
      expect(accounting.snapshot().live).toBe(baselineLive);
      creation.dispose();
      expect(accounting.snapshot().live).toBe(0);
    },
  );

  it('E23-A07: too few storage buffers per stage leaves the paint path unavailable', async () => {
    const fixture = nativeFixture();
    (
      fixture.device.limits as { maxStorageBuffersPerShaderStage: number }
    ).maxStorageBuffersPerShaderStage = 6;
    const { scene, creation } = await nativeScene(fixture, allOptions);
    expect(scene).toMatchObject({ paintPipelineAvailable: false, meshPipelineAvailable: true });
    creation.dispose();
  });
});

describe('E23 U3 draw encoding (E23-A06)', () => {
  const p1 = 'vector-studio/p1-analytic-primitive-stencil-4x';
  const empty = 'primitive/1/paint-empty-bind-group';
  const primitiveGroup = 'primitive/1/paint-primitives-2/bind-group';

  it('draws a gradient run with the paint variant and groups 1 and 2, solid runs as before', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, allOptions);
    const h = harness([box('u0', 0), box('g1', 20, linear), box('g2', 40, linear), box('u1', 60)]);
    const packet = h.source.prepare(target)!;
    expect(packet.draws.map((draw) => [draw.count, draw.paint ?? 'solid'])).toEqual([
      [1, 'solid'],
      [2, 'gradient'],
      [1, 'solid'],
    ]);
    submitted(scene.submitPrimitivePacket(packet));
    expect(encoded(fixture.calls)).toEqual([
      ['setPipeline', p1],
      ['setBindGroup', 0],
      ['drawIndexed', 6, 1, 0, 0, 0],
      ['setPipeline', `${p1}+paint-v0`],
      ['setBindGroup', 1, empty],
      ['setBindGroup', 2, primitiveGroup],
      ['drawIndexed', 6, 2, 0, 0, 1],
      ['setPipeline', p1],
      ['drawIndexed', 6, 1, 0, 0, 3],
    ]);
    // Records 1 and 2, written once each; the slot table names them.
    const records = fixture.writes.filter((write) => write.label.includes('paint-records'));
    expect(records.map((write) => [write.offset, write.bytes])).toEqual([
      [368, 368],
      [736, 368],
    ]);
    creation.dispose();
  });

  it('a solid-only scene encodes exactly as without the paint variants', async () => {
    const nodes = [box('u0', 0), box('u1', 20), strokedNode('a', 40, { opacity: 0.5 })];
    const run = async (options: Parameters<typeof nativeScene>[1]) => {
      const fixture = nativeFixture();
      const { scene, creation, target } = await nativeScene(fixture, options);
      submitted(scene.submitPrimitivePacket(harness(nodes).source.prepare(target)!));
      creation.dispose();
      return { calls: encoded(fixture.calls), writes: fixture.writes };
    };
    const withPaint = await run(allOptions);
    const without = await run({ meshPipeline: true, clipPipeline: true });
    expect(withPaint.calls).toEqual(without.calls);
    expect(withPaint.writes.some((write) => write.label.includes('paint'))).toBe(false);
  });

  it('a joint path with a gradient fill uses the joint paint variant over the mesh paint group', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, allOptions);
    const h = harness([strokedNode('a', 40, { opacity: 0.5, fill: linear })]);
    const packet = h.source.prepare(target)!;
    expect(
      packet.mesh!.draws.map((draw) => [draw.composite ?? 'plain', draw.gradient ?? 0]),
    ).toEqual([
      ['joint-fill', 1],
      ['plain', 0],
    ]);
    submitted(scene.submitPrimitivePacket(packet));
    const calls = encoded(fixture.calls);
    const joint = calls.findIndex(
      (call) => call[0] === 'setPipeline' && call[1] === 'vector-studio/p3-mesh-joint-4x+paint-v0',
    );
    expect(joint).toBeGreaterThan(0);
    expect(calls.slice(joint + 1, joint + 4)).toEqual([
      ['setBindGroup', 0],
      ['setBindGroup', 1, empty],
      ['setBindGroup', 2, 'primitive/1/paint-meshes-3/bind-group'],
    ]);
    // The stroke draw is solid: base fill pipeline, no paint group.
    expect(calls.slice(joint + 5)).toEqual([
      ['setPipeline', 'vector-studio/p3-mesh-fill-4x'],
      ['draw', ...(calls.at(-1)!.slice(1) as number[])],
    ]);
    creation.dispose();
  });

  it('a clipped gradient run uses the paint and clip variant with the clip group at group 1', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, allOptions);
    const h = harness([
      {
        id: 'c',
        parentId: null,
        transform: IDENTITY,
        visible: true,
        opacity: 1,
        kind: 'container',
        clip: { kind: 'rect', x: 15, y: 0, width: 100, height: 100 },
        children: ['g'],
      },
      box('g', 20, linear, 'c'),
    ]);
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    expect(encoded(fixture.calls)).toEqual([
      ['setPipeline', p1],
      ['setBindGroup', 0],
      ['setPipeline', `${p1}+paint-v0+clip-v0`],
      ['setBindGroup', 2, primitiveGroup],
      ['setBindGroup', 1, 'primitive/1/clip-states-1/bind-group', 1280],
      ['drawIndexed', 6, 1, 0, 0, 0],
    ]);
    creation.dispose();
  });

  it('E23-A07: without the paint variants gradient draws are not drawn and solid ones are', async () => {
    const fixture = nativeFixture({ failPipeline: 'primitive-stencil-4x+paint-v0' });
    const { scene, creation, target } = await nativeScene(fixture, allOptions);
    const h = harness([
      box('u0', 0),
      box('g', 20, linear),
      strokedNode('a', 40, { opacity: 0.5, fill: linear }),
    ]);
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    const calls = encoded(fixture.calls);
    expect(calls.filter((call) => call[0] === 'drawIndexed')).toEqual([
      ['drawIndexed', 6, 1, 0, 0, 0],
    ]);
    // The joint fill draw reads the gradient and is not drawn; the solid stroke draw is.
    expect(calls.filter((call) => call[0] === 'setPipeline').map((call) => call[1])).toEqual([
      'vector-studio/p1-analytic-primitive-stencil-4x',
      'vector-studio/p3-mesh-fill-4x',
    ]);
    expect(calls.filter((call) => call[0] === 'draw')).toHaveLength(1);
    expect(fixture.writes.some((write) => write.label.includes('paint'))).toBe(false);
    creation.dispose();
  });
});

describe('E23 U3 paint buffers (E23-A05, A09 unit part)', () => {
  it('writes only changed records; a pan writes none; a solid frame releases the buffers', async () => {
    const fixture = nativeFixture();
    const { scene, creation, accounting, target } = await nativeScene(fixture, allOptions);
    const nodes = [box('g1', 20, linear), box('g2', 40, linear)];
    const h = harness(nodes);
    const native = scene as unknown as { paintRecordWritesForTesting: number };
    const submit = () => {
      const packet = h.source.prepare(target)!;
      const receipt = submitted(scene.submitPrimitivePacket(packet));
      h.source.acknowledge(receipt);
      return packet;
    };
    submit();
    expect(native.paintRecordWritesForTesting).toBe(2);
    const createBuffer = vi.mocked(
      (fixture.device as unknown as { createBuffer: () => unknown }).createBuffer,
    );
    const paintBuffers = () =>
      createBuffer.mock.results
        .map((result) => result.value as { label: string; destroy: ReturnType<typeof vi.fn> })
        .filter((buffer) => buffer.label.includes('/paint-'));
    expect(paintBuffers().map((buffer) => buffer.label)).toEqual([
      'primitive/1/paint-records-1',
      'primitive/1/paint-primitives-2',
      'primitive/1/paint-meshes-3',
    ]);

    h.setZoom(2, { x: 5, y: 3 });
    submit();
    expect(native.paintRecordWritesForTesting).toBe(2);
    // A stop edit rewrites only that record.
    h.replace([
      box('g1', 20, linear),
      box('g2', 40, {
        ...linear,
        stops: [
          { offset: 0, color: red },
          { offset: 0.5, color: blue },
        ],
      }),
    ]);
    submit();
    expect(native.paintRecordWritesForTesting).toBe(3);
    h.replace([box('g1', 20), box('g2', 40)]);
    const solid = submit();
    expect(solid.paint).toBeUndefined();
    // Released with their accounting entries (E23-A09): no paint id stays live.
    expect(paintBuffers().every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(paintBuffers()).toHaveLength(3);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('rejects a gradient draw without a paint part and an index past the records', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, allOptions);
    const packet = harness([box('g', 20, linear)]).source.prepare(target)!;
    const { paint, ...withoutPaint } = packet;
    expect(scene.submitPrimitivePacket(withoutPaint)).toMatchObject({ reason: 'invalid-packet' });
    expect(
      scene.submitPrimitivePacket({
        ...packet,
        paint: { ...paint!, primitives: [{ slot: 0, fill: 2, stroke: 0 }] },
      }),
    ).toMatchObject({ reason: 'invalid-packet' });
    expect(
      scene.submitPrimitivePacket({
        ...packet,
        draws: [{ ...packet.draws[0]!, paint: 'x' as never }],
      }),
    ).toMatchObject({ reason: 'invalid-packet' });
    creation.dispose();
  });
});

function fakeDevice(paintPipelineAvailable: boolean) {
  const scene: WebGpuPrimitiveScenePort = {
    sampleCount: 4,
    shaderModulesCreated: 1,
    pipelinesCreated: 1,
    meshPipelineAvailable: false,
    paintPipelineAvailable,
    setTarget: vi.fn(),
    submitPrimitivePacket: vi.fn(() => ({ status: 'not-ready' as const })),
    dispose: vi.fn(),
  };
  let lose!: (loss: { reason: 'unknown'; message: string }) => void;
  const createPrimitiveScene = vi.fn(() => ({
    result: Promise.resolve({ scene, fellBackFrom4x: false }),
    dispose: () => scene.dispose(),
  }));
  const device: WebGpuDevicePort = {
    features: [],
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 256 * 1024 * 1024 },
    lost: new Promise((resolve) => {
      lose = resolve;
    }),
    createFoundationScene: () => {
      throw new Error('foundation mode is not used here');
    },
    createPrimitiveScene,
    waitForSubmittedWork: vi.fn(() => Promise.resolve()),
    subscribeErrors: vi.fn(() => ({ disposed: false, dispose: vi.fn() })),
    triggerValidationErrorForTesting: vi.fn(),
    destroy: vi.fn(),
  };
  const adapter: WebGpuAdapterPort = { info: {}, requestDevice: () => Promise.resolve(device) };
  return {
    adapter,
    createPrimitiveScene,
    lose: (message: string) => lose({ reason: 'unknown', message }),
  };
}

function platformFor(adapters: WebGpuAdapterPort[]): WebGpuPlatform {
  const context = { configure: vi.fn(), unconfigure: vi.fn() };
  return {
    secureContext: true,
    apiAvailable: true,
    requestAdapter: vi.fn(() => Promise.resolve(adapters.shift() ?? null)),
    getCanvasContext: vi.fn(() => context),
    getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
  };
}

const surface = {
  canvas: { width: 0, height: 0 } as HTMLCanvasElement,
  cssSize: { width: 640, height: 360 },
  devicePixelRatio: 1,
};

const unavailable = (diagnostics: readonly RendererDiagnostic[]) =>
  diagnostics.filter((diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.PAINT_UNAVAILABLE);

async function start(paints: 'solid' | 'gradient', devices: ReturnType<typeof fakeDevice>[]) {
  const backend = new WebGpuBackend({ platform: platformFor(devices.map((d) => d.adapter)) });
  const diagnostics: RendererDiagnostic[] = [];
  backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));
  const service = new PrimitiveRendererService(
    { invalidate: vi.fn(), setMode: vi.fn() },
    { paints },
  );
  backend.attachPrimitiveFrameSource(service);
  await backend.initialize(surface);
  return { backend, diagnostics, service };
}

describe('E23 U3 render.paint-unavailable and the service option (E23-A07)', () => {
  it('the service passes paints to the mirror and asks for the paint variants', () => {
    const invalidate = { invalidate: vi.fn(), setMode: vi.fn() };
    expect(
      new PrimitiveRendererService(invalidate, { paints: 'gradient' }).requiresPaintPipeline,
    ).toBe(true);
    expect(new PrimitiveRendererService(invalidate).requiresPaintPipeline).toBe(false);
    expect(() => new PrimitiveRendererService(invalidate, { paints: 'ramp' as 'solid' })).toThrow(
      "paints must be 'solid' or 'gradient'.",
    );
  });

  it('the backend creates the scene with paintPipeline only when asked', async () => {
    const asked = fakeDevice(true);
    const one = await start('gradient', [asked]);
    expect(asked.createPrimitiveScene.mock.calls[0]).toContainEqual({ paintPipeline: true });
    one.backend.dispose();
    one.service.dispose();
    const solid = fakeDevice(false);
    const two = await start('solid', [solid]);
    expect(solid.createPrimitiveScene.mock.calls[0]).toHaveLength(4);
    two.backend.dispose();
    two.service.dispose();
  });

  it('is emitted once per generation when gradients are asked for and the variants are unavailable', async () => {
    const first = fakeDevice(false);
    const second = fakeDevice(false);
    const { backend, diagnostics, service } = await start('gradient', [first, second]);
    expect(unavailable(diagnostics)).toHaveLength(1);
    expect(unavailable(diagnostics)[0]).toMatchObject({ severity: 'warning', generation: 1 });
    first.lose('injected loss');
    await vi.waitFor(() => {
      expect(backend.generation).toBe(2);
      expect(backend.state).toBe('ready');
    });
    expect(unavailable(diagnostics).map((diagnostic) => diagnostic.generation)).toEqual([1, 2]);
    backend.dispose();
    service.dispose();
  });

  it('is not emitted when the variants are available or gradients are not asked for', async () => {
    for (const [paints, available] of [
      ['gradient', true],
      ['solid', false],
    ] as const) {
      const { backend, diagnostics, service } = await start(paints, [fakeDevice(available)]);
      expect(backend.state).toBe('ready');
      expect(unavailable(diagnostics)).toEqual([]);
      backend.dispose();
      service.dispose();
    }
  });
});
