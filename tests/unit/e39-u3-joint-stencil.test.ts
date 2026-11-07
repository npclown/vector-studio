import type {
  FillMesh,
  FillMeshRequest,
  RenderNodeSnapshot,
  StrokeMeshRequest,
} from '@vector-studio/contracts';
import {
  ResourceAccounting,
  type PrimitivePacket,
  type PrimitiveTarget,
} from '@vector-studio/renderer-core';
import { describe, expect, it } from 'vitest';

import {
  MESH_FILL_SHADER,
  MESH_JOINT_COVER_FRAGMENT_ENTRY_POINT,
} from '../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import {
  createMeshPipelineDescriptor,
  encodeMeshJoint,
  MESH_JOINT_COVERS,
  MESH_JOINT_STROKE_BIT,
  MESH_STENCIL_KINDS,
  meshJointCoverReference,
  meshJointCoverStencilState,
  meshJointSteps,
  meshStencilPassReference,
  meshStencilPassState,
  type MeshCoverRule,
  type MeshJointCover,
} from '../../packages/renderer-webgpu/src/mesh-pipeline.js';
import { createNativePrimitiveSceneCreation } from '../../packages/renderer-webgpu/src/native-primitive-scene.js';
import { nativeFixture, nativeScene, submitted } from '../support/p4-native-fixture.js';
import {
  createStrokeHarness,
  ScriptedStrokeMeshPort,
  strokedNode,
  strokeOk,
} from '../support/st-u6-stroke-harness.js';
import { okResult, ScriptedFillMeshPort, squareMesh } from '../support/v3a-path-harness.js';

// E39 contract (docs/plans/d9-e39-gpu-stencil-path-contract.md), unit U3, acceptance E39-A5 for
// joint draws (R6): a winding fill and its union stroke at 0 < o < 1 draw through one stencil
// (stroke mark in bit 7, fill count in the low 7 bits) in five steps, with no overlay. Checked
// here: the states and references, a per-sample simulation of the five steps against ST-U7's
// composite, the packet's draw pair, the pass encoding (main, layer and count passes) and the
// backend's validation of the pair.

// ---------------------------------------------------------------------------------------------
// A per-sample model of the WebGPU stencil test and write, for the simulation below.

function compares(compare: GPUCompareFunction, reference: number, value: number): boolean {
  switch (compare) {
    case 'never':
      return false;
    case 'less':
      return reference < value;
    case 'equal':
      return reference === value;
    case 'less-equal':
      return reference <= value;
    case 'greater':
      return reference > value;
    case 'not-equal':
      return reference !== value;
    case 'greater-equal':
      return reference >= value;
    case 'always':
      return true;
  }
}

function operate(op: GPUStencilOperation, value: number, reference: number): number {
  switch (op) {
    case 'keep':
      return value;
    case 'zero':
      return 0;
    case 'replace':
      return reference;
    case 'invert':
      return ~value & 0xff;
    case 'increment-clamp':
      return Math.min(value + 1, 0xff);
    case 'decrement-clamp':
      return Math.max(value - 1, 0);
    case 'increment-wrap':
      return (value + 1) & 0xff;
    case 'decrement-wrap':
      return (value - 1) & 0xff;
  }
}

/** One sample's stencil test and write; returns whether the fragment passes. */
function stencilStep(
  state: GPUDepthStencilState,
  reference: number,
  value: number,
  backFace: boolean,
): { pass: boolean; value: number } {
  const face = (backFace ? state.stencilBack : state.stencilFront)!;
  const readMask = state.stencilReadMask ?? 0xff;
  const writeMask = state.stencilWriteMask ?? 0xff;
  const pass = compares(face.compare ?? 'always', reference & readMask, value & readMask);
  const op = pass ? (face.passOp ?? 'keep') : (face.failOp ?? 'keep');
  const written = operate(op, value, reference);
  return { pass, value: (value & ~writeMask & 0xff) | (written & writeMask) };
}

type Rgba = readonly [number, number, number, number];

function over(source: Rgba, destination: Rgba): Rgba {
  const k = 1 - source[3];
  return [
    source[0] + destination[0] * k,
    source[1] + destination[1] * k,
    source[2] + destination[2] * k,
    source[3] + destination[3] * k,
  ];
}

const premultiplied = (rgb: readonly [number, number, number], a: number): Rgba => [
  rgb[0] * a,
  rgb[1] * a,
  rgb[2] * a,
  a,
];

/**
 * One sample under the five steps: the fill's fan crosses it `fill` times (signed: front faces
 * up, back faces down), the stroke's union mesh `stroke` times (front faces). Each cover quad
 * contains the sample. Returns the colour over `background` and the stencil after the steps.
 */
function simulate(
  rule: MeshCoverRule,
  fill: number,
  stroke: number,
  opacity: number,
  f: Rgba,
  s: Rgba,
  background: Rgba,
): { colour: Rgba; stencil: number } {
  let stencil = 0;
  let colour = background;
  for (const step of meshJointSteps(rule)) {
    if (step.stage === 'stencil') {
      const state = meshStencilPassState(step.kind);
      const reference = meshStencilPassReference(step.kind);
      const crossings = step.draw === 'fill' ? fill : stroke;
      for (let i = 0; i < Math.abs(crossings); i += 1) {
        stencil = stencilStep(state, reference, stencil, crossings < 0).value;
      }
      continue;
    }
    const state = meshJointCoverStencilState(step.cover);
    const result = stencilStep(state, meshJointCoverReference(step.cover), stencil, false);
    stencil = result.value;
    if (!result.pass) continue;
    // The covers' colours: joint-both the ST-U7 joint fill colour at c_F = c_S = 1, the others
    // the plain opacity-scaled paint (meshFragmentMain over a NO_DISCARD triangle).
    const paint: Rgba =
      step.cover === 'joint-stroke'
        ? [s[0] * opacity, s[1] * opacity, s[2] * opacity, s[3] * opacity]
        : step.cover.startsWith('joint-both')
          ? ((): Rgba => {
              const factor = (opacity * (1 - s[3])) / (1 - opacity * s[3]);
              return [f[0] * factor, f[1] * factor, f[2] * factor, f[3] * factor];
            })()
          : [f[0] * opacity, f[1] * opacity, f[2] * opacity, f[3] * opacity];
    colour = over(paint, colour);
  }
  return { colour, stencil };
}

/** ST-U7's composite: the group of stroke over fill, at opacity o, over the background. */
function reference(
  inFill: boolean,
  inStroke: boolean,
  opacity: number,
  f: Rgba,
  s: Rgba,
  background: Rgba,
): Rgba {
  const transparent: Rgba = [0, 0, 0, 0];
  const group = over(inStroke ? s : transparent, inFill ? f : transparent);
  return over(
    [group[0] * opacity, group[1] * opacity, group[2] * opacity, group[3] * opacity],
    background,
  );
}

describe('E39-R6 joint stencil states', () => {
  it('marks the stroke in bit 7 and counts the fill in the low 7 bits', () => {
    expect(MESH_STENCIL_KINDS).toEqual(['winding', 'union', 'joint-stroke', 'joint-fill']);
    expect(MESH_JOINT_STROKE_BIT).toBe(0x80);
    const stroke = meshStencilPassState('joint-stroke');
    expect(stroke.stencilFront).toEqual({
      compare: 'always',
      failOp: 'keep',
      depthFailOp: 'keep',
      passOp: 'replace',
    });
    expect(stroke.stencilBack).toEqual(stroke.stencilFront);
    expect(stroke.stencilWriteMask).toBe(0x80);
    expect(meshStencilPassReference('joint-stroke')).toBe(0x80);
    const fill = meshStencilPassState('joint-fill');
    expect(fill.stencilFront!.passOp).toBe('increment-wrap');
    expect(fill.stencilBack!.passOp).toBe('decrement-wrap');
    expect(fill.stencilWriteMask).toBe(0x7f);
    expect(meshStencilPassReference('joint-fill')).toBe(0);
    // The plain kinds are unchanged.
    expect(meshStencilPassState('winding').stencilWriteMask).toBe(0xff);
    expect(meshStencilPassState('union').stencilWriteMask).toBe(0xff);
    expect(meshStencilPassReference('union')).toBe(1);
  });

  it('tests and clears per cover as the contract lists', () => {
    const summary = (cover: MeshJointCover) => {
      const state = meshJointCoverStencilState(cover);
      expect(state.stencilBack).toEqual(state.stencilFront);
      return [
        state.stencilFront!.compare,
        state.stencilReadMask,
        meshJointCoverReference(cover),
        state.stencilFront!.passOp,
        state.stencilFront!.failOp,
        state.stencilWriteMask,
      ];
    };
    expect(Object.fromEntries(MESH_JOINT_COVERS.map((cover) => [cover, summary(cover)]))).toEqual({
      'joint-both-nonzero': ['less', 0xff, 0x80, 'zero', 'keep', 0x7f],
      'joint-both-evenodd': ['equal', 0x81, 0x81, 'zero', 'keep', 0x7f],
      'joint-fill-nonzero': ['not-equal', 0x7f, 0, 'zero', 'zero', 0x7f],
      'joint-fill-evenodd': ['equal', 0x01, 1, 'zero', 'zero', 0x7f],
      'joint-stroke': ['equal', 0x80, 0x80, 'zero', 'zero', 0xff],
    });
    expect(meshJointSteps('evenodd')).toEqual([
      { stage: 'stencil', kind: 'joint-stroke', draw: 'stroke' },
      { stage: 'stencil', kind: 'joint-fill', draw: 'fill' },
      { stage: 'cover', cover: 'joint-both-evenodd', draw: 'fill' },
      { stage: 'cover', cover: 'joint-fill-evenodd', draw: 'fill' },
      { stage: 'cover', cover: 'joint-stroke', draw: 'stroke' },
    ]);
  });

  it('builds the joint-both covers on their own entry point, the others on the fill entry', () => {
    const module = {} as GPUShaderModule;
    const layout = {} as GPUPipelineLayout;
    for (const cover of MESH_JOINT_COVERS) {
      const descriptor = createMeshPipelineDescriptor(
        module,
        layout,
        'bgra8unorm',
        4,
        `cover-${cover}`,
      );
      expect(descriptor.label).toBe(`vector-studio/p3-mesh-cover-${cover}-4x`);
      expect(descriptor.depthStencil).toEqual(meshJointCoverStencilState(cover));
      expect(descriptor.fragment!.entryPoint).toBe(
        cover.startsWith('joint-both') ? MESH_JOINT_COVER_FRAGMENT_ENTRY_POINT : 'meshFragmentMain',
      );
    }
    // R4: the joint cover entry never discards.
    const entry = MESH_FILL_SHADER.slice(
      MESH_FILL_SHADER.indexOf(`fn ${MESH_JOINT_COVER_FRAGMENT_ENTRY_POINT}`),
    );
    expect(entry).not.toContain('discard');
    expect(entry).toContain('let stroke = instances[fill.strokeLink - 1u];');
  });
});

describe('E39-R6 per-sample simulation against the ST-U7 composite', () => {
  const f = premultiplied([0.2, 0.6, 1], 0.8);
  const s = premultiplied([1, 0.3, 0.1], 0.9);
  const background = premultiplied([0.1, 0.1, 0.1], 1);
  for (const rule of ['nonzero', 'evenodd'] as const) {
    it(`matches o · (s over f) and leaves the stencil zero (${rule})`, () => {
      for (const opacity of [0.25, 0.5, 0.875]) {
        for (const fill of [-3, -2, -1, 0, 1, 2, 3, 127, 129]) {
          for (const stroke of [0, 1, 2, 5]) {
            const inFill = rule === 'nonzero' ? fill % 128 !== 0 : Math.abs(fill) % 2 === 1;
            const result = simulate(rule, fill, stroke, opacity, f, s, background);
            const expected = reference(inFill, stroke > 0, opacity, f, s, background);
            const label = `${rule} fill ${fill} stroke ${stroke} o ${opacity}`;
            result.colour.forEach((channel, index) =>
              expect(channel, label).toBeCloseTo(expected[index]!, 12),
            );
            expect(result.stencil, label).toBe(0);
          }
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Packet, encoding and validation over the scene's fake device.

/** A fan over the square [x, x+10] x [0, 10] from its first corner, as K1 builds it. */
function coverageMesh(x: number, coverage: 'winding' | 'union'): FillMesh {
  return {
    positions: Float64Array.from([x, 0, x + 10, 0, x + 10, 10, x, 10]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    boundaryEdges: new Uint32Array(0),
    bounds: { minX: x, minY: 0, maxX: x + 10, maxY: 10 },
    coverage,
  };
}

/** Winding fills from tag 100, partition fills below; union strokes from tag 100. */
function jointHarness(nodes: readonly RenderNodeSnapshot[]) {
  return createStrokeHarness({
    fillPort: new ScriptedFillMeshPort({
      request: (request: FillMeshRequest, tag: number) =>
        okResult(request, tag < 100 ? squareMesh() : coverageMesh(tag, 'winding')),
    }),
    strokePort: new ScriptedStrokeMeshPort({
      request: (request: StrokeMeshRequest, tag: number) =>
        tag < 100 ? strokeOk(request, tag) : strokeOk(request, tag, coverageMesh(tag, 'union')),
    }),
    nodes,
  });
}

const meshCalls = (calls: readonly (readonly unknown[])[]) =>
  calls.flatMap((call): unknown[] => {
    if (call[0] === 'beginRenderPass') return [`pass ${String(call[1])}`];
    if (call[0] === 'setPipeline') return [String(call[1])];
    if (call[0] === 'setStencilReference') return [`ref ${String(call[1])}`];
    if (call[0] === 'draw') return [call.slice(1)];
    return [];
  });

type Draw = NonNullable<PrimitivePacket['mesh']>['draws'][number];
const tri = (draw: Draw) => [
  3 * (draw.triangleCount - 2),
  1,
  3 * draw.firstTriangle,
  draw.instance,
];
const quad = (draw: Draw) => [
  6,
  1,
  3 * (draw.firstTriangle + draw.triangleCount - 2),
  draw.instance,
];

/** The five steps' calls with `suffix` on the cover labels (a variant's, such as +layer-v0). */
const fiveSteps = (fill: Draw, stroke: Draw, rule: MeshCoverRule, suffix = '') => [
  'vector-studio/e39-mesh-stencil-joint-stroke-bgra8unorm-4x',
  'ref 128',
  tri(stroke),
  'vector-studio/e39-mesh-stencil-joint-fill-bgra8unorm-4x',
  'ref 0',
  tri(fill),
  `vector-studio/p3-mesh-cover-joint-both-${rule}-4x${suffix}`,
  `ref ${rule === 'nonzero' ? 128 : 129}`,
  quad(fill),
  `vector-studio/p3-mesh-cover-joint-fill-${rule}-4x${suffix}`,
  `ref ${rule === 'nonzero' ? 0 : 1}`,
  quad(fill),
  `vector-studio/p3-mesh-cover-joint-stroke-4x${suffix}`,
  'ref 128',
  quad(stroke),
];

describe('E39-R6 joint draws in the packet', () => {
  it('emits a winding joint-fill draw and its union stroke draw, word 15 naming the stroke', async () => {
    const fixture = nativeFixture();
    const { creation, target } = await nativeScene(fixture, { meshPipeline: true });
    const h = jointHarness([
      strokedNode('j', 120, { opacity: 0.5 }),
      strokedNode('o', 140, { opacity: 1 }),
      strokedNode('k', 40, { opacity: 0.5 }),
    ]);
    const packet = h.source.prepare(target)!;
    const draws = packet.mesh!.draws;
    expect(draws.map((draw) => [draw.coverage ?? 'partition', draw.composite])).toEqual([
      ['winding', 'joint-fill'],
      ['union', undefined],
      // At o = 1 the draws are plain.
      ['winding', undefined],
      ['union', undefined],
      // A partition fill (K5 fallback) keeps ST-U7's overlay joint draw.
      ['partition', 'joint-fill'],
      ['partition', undefined],
    ]);
    // Word 15 of the joint draw's record is the stroke record's slot + 1.
    const word15 = (slot: number) => {
      for (const write of packet.mesh!.writes) {
        if (write.resourceId !== 'meshInstances') continue;
        const index = slot - write.byteOffset / 64;
        if (index < 0 || index >= write.records.length) continue;
        return new DataView(write.bytes.buffer, write.bytes.byteOffset).getUint32(
          64 * index + 60,
          true,
        );
      }
      return undefined;
    };
    expect(word15(draws[0]!.instance)).toBe(draws[1]!.instance + 1);
    expect(word15(draws[2]!.instance)).toBe(0);
    // The winding joint draw draws its own fan and cover quad (no overlay triangles).
    expect(draws[0]!.triangleCount).toBe(draws[2]!.triangleCount);
    creation.dispose();
  });
});

describe('E39-R6 joint encoding (main, layer and count passes)', () => {
  for (const rule of ['nonzero', 'evenodd'] as const) {
    it(`draws the five steps in the main pass and back to plain draws after (${rule})`, async () => {
      const fixture = nativeFixture();
      const { scene, creation, target } = await nativeScene(fixture, { meshPipeline: true });
      const h = jointHarness([
        strokedNode('j', 120, { opacity: 0.5, fillRule: rule }),
        strokedNode('w', 140, { opacity: 1, stroke: null }),
      ]);
      const packet = h.source.prepare(target)!;
      const [fill, stroke, plain] = packet.mesh!.draws;
      submitted(scene.submitPrimitivePacket(packet));
      const calls = meshCalls(fixture.calls);
      const start = calls.indexOf('vector-studio/e39-mesh-stencil-joint-stroke-bgra8unorm-4x');
      expect(start).toBeGreaterThan(0);
      expect(calls.slice(start, start + 15)).toEqual(fiveSteps(fill!, stroke!, rule));
      expect(calls.slice(start + 15, start + 21)).toEqual([
        'vector-studio/e39-mesh-stencil-winding-bgra8unorm-4x',
        'ref 0',
        tri(plain!),
        'vector-studio/p3-mesh-cover-nonzero-4x',
        'ref 0',
        quad(plain!),
      ]);
      creation.dispose();
    });
  }

  it('draws the five steps in a layer tile pass with the layer variant covers', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, {
      meshPipeline: true,
      clipPipeline: true,
      paintPipeline: true,
      layerPipeline: true,
    });
    const h = createStrokeHarness({
      fillPort: new ScriptedFillMeshPort({
        request: (request: FillMeshRequest, tag: number) =>
          okResult(request, coverageMesh(tag, 'winding')),
      }),
      strokePort: new ScriptedStrokeMeshPort({
        request: (request: StrokeMeshRequest, tag: number) =>
          strokeOk(request, tag, coverageMesh(tag, 'union')),
      }),
      clips: 'rect',
      groupOpacity: 'supported',
      nodes: [
        {
          id: 'g',
          parentId: null,
          transform: [1, 0, 0, 1, 0, 0],
          visible: true,
          opacity: 0.5,
          kind: 'container',
          clip: null,
          children: ['j', 'x'],
        },
        strokedNode('j', 120, { parentId: 'g', opacity: 0.5 }),
        strokedNode('x', 160, { parentId: 'g' }),
      ],
    });
    const packet = h.source.prepare(target)!;
    const layer = packet.layers!.layers[0]!;
    const [fill, stroke] = layer.meshDraws;
    expect(fill).toMatchObject({ coverage: 'winding', composite: 'joint-fill' });
    expect(stroke).toMatchObject({ coverage: 'union' });
    submitted(scene.submitPrimitivePacket(packet));
    const calls = meshCalls(fixture.calls);
    const pass = calls.indexOf('pass vector-studio/layer-pass/0');
    expect(pass).toBeGreaterThanOrEqual(0);
    const start = calls.indexOf('vector-studio/e39-mesh-stencil-joint-stroke-bgra8unorm-4x', pass);
    expect(start).toBeGreaterThan(pass);
    expect(calls.slice(start, start + 15)).toEqual(
      fiveSteps(fill!, stroke!, 'nonzero', '+layer-v0'),
    );
    creation.dispose();
  });

  it('replays the five steps in the count pass with the count covers', async () => {
    const fixture = nativeFixture();
    const creation = createNativePrimitiveSceneCreation(
      fixture.device,
      fixture.context,
      'bgra8unorm',
      1,
      new ResourceAccounting(),
      { meshPipeline: true, countPass: true },
    );
    const { scene } = await creation.result;
    const target: PrimitiveTarget = {
      generation: 1,
      surfaceRevision: 1,
      width: 640,
      height: 360,
      devicePixelRatio: 1,
      sampleCount: scene.sampleCount,
      targetFormat: 'bgra8unorm',
    };
    scene.setTarget(target);
    const h = jointHarness([strokedNode('j', 120, { opacity: 0.5 })]);
    const packet = h.source.prepare(target)!;
    const [fill, stroke] = packet.mesh!.draws;
    const settled = new Promise<void>((resolve) => {
      scene.captureNextSubmissionForTesting!({
        counts: true,
        encoded: () => resolve(),
        resolve: () => undefined,
        reject: () => undefined,
      });
    });
    submitted(scene.submitPrimitivePacket(packet));
    await settled;
    const calls = meshCalls(fixture.calls);
    const count = calls.indexOf('pass vector-studio/e10-count-pass');
    expect(count).toBeGreaterThan(0);
    const start = calls.indexOf(
      'vector-studio/e39-mesh-stencil-joint-stroke-rgba16float-4x',
      count,
    );
    expect(start).toBeGreaterThan(count);
    expect(calls.slice(start, start + 15)).toEqual(
      fiveSteps(fill!, stroke!, 'nonzero').map((call) =>
        typeof call !== 'string'
          ? call
          : call
              .replace('bgra8unorm', 'rgba16float')
              .replace('vector-studio/p3-mesh-cover-', 'vector-studio/e39-count-cover-'),
      ),
    );
    // The stroke draw is not drawn again after the pair: the count pass ends there.
    expect(calls.slice(start + 15)).toEqual([
      'pass vector-studio/e10-count-readout-pass',
      'vector-studio/e10-count-readout',
      [3],
    ]);
    creation.dispose();
  });

  it('encodeMeshJoint binds after each cover pipeline and draws the cover quads last', () => {
    const recorded: unknown[] = [];
    const pass = {
      setPipeline: (pipeline: { label: string }) => recorded.push(pipeline.label),
      setStencilReference: (reference: number) => recorded.push(`ref ${reference}`),
      draw: (...args: number[]) => recorded.push(args),
    } as unknown as GPURenderPassEncoder;
    const fill = { instance: 4, firstTriangle: 10, triangleCount: 6 };
    const stroke = { instance: 5, firstTriangle: 16, triangleCount: 8 };
    encodeMeshJoint(
      pass,
      fill,
      stroke,
      'evenodd',
      (kind) => ({ label: `stencil ${kind}` }) as unknown as GPURenderPipeline,
      (cover) => ({ label: `cover ${cover}` }) as unknown as GPURenderPipeline,
      () => recorded.push('bind'),
    );
    expect(recorded).toEqual([
      'stencil joint-stroke',
      'ref 128',
      [18, 1, 48, 5],
      'stencil joint-fill',
      'ref 0',
      [12, 1, 30, 4],
      'cover joint-both-evenodd',
      'bind',
      'ref 129',
      [6, 1, 42, 4],
      'cover joint-fill-evenodd',
      'bind',
      'ref 1',
      [6, 1, 42, 4],
      'cover joint-stroke',
      'bind',
      'ref 128',
      [6, 1, 66, 5],
    ]);
  });
});

describe('E39-R6 joint validation', () => {
  it('rejects a winding joint draw not followed by its union stroke draw', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, { meshPipeline: true });
    const h = jointHarness([
      strokedNode('j', 120, { opacity: 0.5 }),
      strokedNode('x', 140, { opacity: 1 }),
    ]);
    const packet = h.source.prepare(target)!;
    const draws = packet.mesh!.draws;
    const withDraws = (next: readonly unknown[]) =>
      ({ ...packet, mesh: { ...packet.mesh!, draws: next } }) as unknown as PrimitivePacket;
    const reject = (bad: PrimitivePacket) =>
      expect(scene.submitPrimitivePacket(bad)).toEqual({
        status: 'failed',
        reason: 'invalid-packet',
      });
    const [fill, stroke, ...rest] = draws;
    // The stroke draw missing, out of order, not a union draw, or at another clip state.
    reject(withDraws([fill, ...rest]));
    reject(withDraws([fill, rest[0], stroke, rest[1]]));
    reject(withDraws([fill, { ...stroke!, coverage: 'winding' }, ...rest]));
    reject(withDraws([fill, { ...stroke!, clipState: 3 }, ...rest]));
    reject(withDraws([fill, { ...stroke!, composite: 'joint-fill' }, ...rest]));
    // A union draw cannot be a joint draw.
    reject(withDraws([{ ...fill!, coverage: 'union' }, stroke, ...rest]));
    // The unmodified packet is accepted.
    expect(submitted(scene.submitPrimitivePacket(packet)).mesh).toMatchObject({
      status: 'submitted',
    });
    creation.dispose();
  });
});
