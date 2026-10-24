import { describe, expect, it } from 'vitest';
import { A04_ORACLE_PARAMETERS } from '../../packages/geometry-reference/src/a04-region.js';
import { MESH_FILL_SHADER } from '../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import {
  CONTROL_IDS,
  RECT,
  bumpedRect,
  controlPorts,
  fan,
  meshFromTriangles,
  runHarnessControls,
} from './e3-a04/controls.js';
import {
  dNum,
  guardBand,
  mapPoint,
  measureCase,
  noFlip,
  type ShaderLanes,
} from './e3-a04/harness.js';
import { buildRecord, validateRecord, type A04Record } from './e3-a04/record.js';
import { harnessCase } from './e3-a04/smoke.js';
import { fill, polygon, rect } from './e3-a04/oracle-cases.js';
import { createHash } from 'node:crypto';

// D9 E3 unit E3-U3 (docs/plans/d9-e3-b4-precision-contract.md, sections 7, 8 and 15): the
// harness's β model against an f32 emulation, the guard band and the no-flip certificate, the
// harness-level positive controls E3-PC1 to PC9, PC11 and PC14, the seeded defects E3-D7, D9,
// D10 and D14, and the record validator. Every mesh here is synthetic and served by a port
// double through the real PathMeshPipeline; no kernel runs.

const f = Math.fround;

/** WGSL toPhysical, then the NDC step and the viewport transform, each op rounded to f32. */
function emulate(ux: number, uy: number, lanes: ShaderLanes, fused: boolean) {
  const [l0, l1, l2, l3] = lanes.linear;
  const [bx, by] = lanes.anchor;
  const [ox, oy] = lanes.frame.originMinusCamera;
  const { zoom, dpr, width, height } = lanes.frame;
  const lin = (a: number, u: number, c: number, v: number) =>
    fused ? f(a * u + f(c * v)) : f(f(a * u) + f(c * v));
  const px = f(f(f(f(lin(l0, ux, l2, uy) + bx) + ox) * zoom) * dpr);
  const py = f(f(f(f(lin(l1, ux, l3, uy) + by) + oy) * zoom) * dpr);
  const nx = f(f(f(px * 2) / width) - 1);
  const ny = f(1 - f(f(py * 2) / height));
  const fx = f(f(nx * 0.5 + 0.5) * width);
  const fy = f(f(-ny * 0.5 + 0.5) * height);
  return { feature: [px, py] as const, vertex: [fx, fy] as const };
}

/** Deterministic xorshift draws in [0, 1). */
function stream(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
}

function randomLanes(next: () => number): ShaderLanes {
  const dpr = [1, 2, 3][Math.floor(next() * 3)]!;
  const zoom = f([0.01, 1, 64][Math.floor(next() * 3)]!);
  const pick = () => f((next() - 0.5) * 4);
  return {
    linear: [pick(), pick(), pick(), pick()],
    anchor: [f(((next() - 0.5) * 2000) / zoom), f(((next() - 0.5) * 2000) / zoom)],
    frame: {
      originMinusCamera: [f(((next() - 0.5) * 300) / zoom), f(((next() - 0.5) * 300) / zoom)],
      zoom,
      dpr,
      width: 640 * dpr,
      height: 360 * dpr,
    },
  };
}

describe('β: the f32 model of the vertex and feature paths (section 15.2)', () => {
  it('bounds an f32 emulation (unfused and fused) on 20,000 random points', () => {
    const next = stream(0x5eed);
    for (let i = 0; i < 20_000; i += 1) {
      const lanes = randomLanes(next);
      const ux = f(((next() - 0.5) * 600) / lanes.frame.zoom);
      const uy = f(((next() - 0.5) * 600) / lanes.frame.zoom);
      const p = mapPoint(ux, uy, lanes);
      const exact = [dNum(p.x), dNum(p.y)] as const;
      for (const fused of [false, true]) {
        const e = emulate(ux, uy, lanes, fused);
        expect(Math.hypot(e.feature[0] - exact[0], e.feature[1] - exact[1])).toBeLessThanOrEqual(
          p.betaFeature,
        );
        expect(Math.hypot(e.vertex[0] - exact[0], e.vertex[1] - exact[1])).toBeLessThanOrEqual(
          p.betaVertex,
        );
      }
    }
  });

  it('E3-D14: β without the NDC step misses the emulated vertex error at a far-translation point', () => {
    // Under far translation the K4 lanes stay small (B and O_m − camera are near the mesh and
    // the camera), so toPhysical of a point near the surface origin is almost exact, while the
    // NDC round trip rounds `p·2/W − 1` near −1, an error of about W·2^-26 px.
    const lanes: ShaderLanes = {
      linear: [1, 0, 0, 1],
      anchor: [f(0.3), f(0.2)],
      frame: { originMinusCamera: [f(0.25), f(0.5)], zoom: 1, dpr: 2, width: 1280, height: 720 },
    };
    let caught = 0;
    for (let k = 0; k < 64; k += 1) {
      const ux = f(0.1 + 0.0937 * k);
      const uy = f(0.2 + 0.0311 * k);
      const p = mapPoint(ux, uy, lanes, { omitNdc: true });
      const e = emulate(ux, uy, lanes, false);
      const err = Math.hypot(e.vertex[0] - dNum(p.x), e.vertex[1] - dNum(p.y));
      if (err > p.betaVertex) caught += 1;
      expect(err).toBeLessThanOrEqual(mapPoint(ux, uy, lanes).betaVertex);
    }
    expect(caught).toBeGreaterThan(0);
  });

  it('the shader identity hash is recorded from the WGSL source', () => {
    const sha = createHash('sha256').update(MESH_FILL_SHADER).digest('hex');
    expect(sha).toMatch(/^[0-9a-f]{64}$/u);
    // The model of section 15.2 is written for this toPhysical and meshPositionNdc.
    expect(MESH_FILL_SHADER).toContain(
      'let linear = instance.linear.xy * offset.x + instance.linear.zw * offset.y;',
    );
    expect(MESH_FILL_SHADER).toContain(
      'return documentPosition * frame.zoom * frame.devicePixelRatio;',
    );
    expect(MESH_FILL_SHADER).toContain('physicalPosition.x * 2.0 / frame.physicalSize.x - 1.0');
    expect(MESH_FILL_SHADER).toContain('1.0 - physicalPosition.y * 2.0 / frame.physicalSize.y');
    expect(MESH_FILL_SHADER).toContain('@builtin(position) @invariant position: vec4f');
  });
});

describe('guard band and no-flip certificate (sections 15.3 and 15.4)', () => {
  const lanes: ShaderLanes = {
    linear: [1, 0, 0, 1],
    anchor: [0, 0],
    frame: { originMinusCamera: [0, 0], zoom: 1, dpr: 1, width: 640, height: 360 },
  };
  const mapped = (pts: readonly (readonly [number, number])[], indices: number[]) => ({
    points: pts.map(([x, y]) => mapPoint(x, y, lanes)),
    indices,
    width: 640,
    height: 360,
  });
  it('clips only triangles that cross the viewport', () => {
    const inside = guardBand(
      mapped(
        [
          [10, 10],
          [20, 10],
          [10, 20],
        ],
        [0, 1, 2],
      ),
    );
    expect(inside).toEqual({ outside: 0, crossing: 0, betaClip: 0 });
    const crossing = guardBand(
      mapped(
        [
          [630, 10],
          [700, 10],
          [630, 20],
        ],
        [0, 1, 2],
      ),
    );
    expect(crossing.crossing).toBe(1);
    expect(crossing.betaClip).toBeGreaterThan(0);
    expect(crossing.betaClip).toBeLessThan(2e-3);
    const beyond = guardBand(
      mapped(
        [
          [700, 10],
          [800, 10],
          [700, 20],
        ],
        [0, 1, 2],
      ),
    );
    expect(beyond).toEqual({ outside: 3, crossing: 0, betaClip: 0 });
  });
  it('certifies a regular triangle, exempts a collapsed one, and fails a zero-area and a sliver triangle', () => {
    expect(
      noFlip(
        mapped(
          [
            [10, 10],
            [20, 10],
            [10, 20],
          ],
          [0, 1, 2],
        ),
        1e-3,
      ),
    ).toEqual({ checked: 1, failed: 0, zeroArea: 0, collapsed: 0 });
    expect(
      noFlip(
        mapped(
          [
            [10, 10],
            [20, 10],
            [30, 10],
          ],
          [0, 1, 2],
        ),
        1e-3,
      ),
    ).toEqual({ checked: 1, failed: 1, zeroArea: 1, collapsed: 0 });
    // Two vertices with the same stored offset: the same segment on the CPU and the GPU.
    expect(
      noFlip(
        mapped(
          [
            [10, 10],
            [20, 10],
            [20, 10],
          ],
          [0, 1, 2],
        ),
        1e-3,
      ),
    ).toEqual({ checked: 1, failed: 0, zeroArea: 1, collapsed: 1 });
    expect(
      noFlip(
        mapped(
          [
            [10, 10],
            [20, 10],
            [30, 10.0001],
          ],
          [0, 1, 2],
        ),
        1e-3,
      ).failed,
    ).toBe(1);
    // Off Ω ⊕ 2: not checked.
    expect(
      noFlip(
        mapped(
          [
            [700, 10],
            [720, 10],
            [730, 10],
          ],
          [0, 1, 2],
        ),
        1e-3,
      ).checked,
    ).toBe(0);
  });
});

describe('harness-level positive controls (section 8.1, E3-A5)', () => {
  const outcomes = runHarnessControls();
  it('covers E3-PC1 to PC9, PC11 and PC14', () => {
    expect(outcomes.map((o) => o.id)).toEqual([...CONTROL_IDS]);
  });
  for (const id of CONTROL_IDS)
    it(`${id} meets its expectation`, () => {
      const o = outcomes.find((x) => x.id === id)!;
      expect(o.ok, `${o.id}: expected ${o.expected}; observed ${o.observed}`).toBe(true);
    });
});

describe('seeded defects of the harness (section 8.2)', () => {
  it('E3-D7: U without β passes a case whose drawn error may exceed 0.25 px', () => {
    // At z = 64, d = 3 a bump of 0.25 − β_c/2 px lies between 0.25 − β_c and 0.25.
    const zoom = 64;
    const dpr = 3;
    const scale = zoom * dpr;
    const kase = harnessCase({
      id: 'E3-D7',
      ...polygon(RECT.map(([x, y]) => [x / 32, y / 32] as [number, number])),
      paint: fill(),
      zoom,
      dpr,
    });
    const shrink = (mesh: ReturnType<typeof bumpedRect>) => ({
      ...mesh,
      positions: mesh.positions.map((v) => v / 32),
      bounds: {
        minX: mesh.bounds.minX / 32,
        minY: mesh.bounds.minY / 32,
        maxX: mesh.bounds.maxX / 32,
        maxY: mesh.bounds.maxY / 32,
      },
    });
    const dry = measureCase(kase, controlPorts({ status: 'ok', mesh: shrink(bumpedRect(0)) }));
    expect(dry.status).toBe('pass');
    const betaC = dry.betaC!;
    expect(betaC).toBeGreaterThan(1e-5);
    // The bump in local units, 32 times its size in the scaled-down rectangle.
    const bump = shrink(bumpedRect(((0.25 - betaC / 2) / scale) * 32));
    const sound = measureCase(kase, controlPorts({ status: 'ok', mesh: bump }));
    expect(sound.status).toBe('undecided');
    const defect = measureCase(kase, controlPorts({ status: 'ok', mesh: bump }), {
      mutations: { omitBeta: true },
    });
    expect(defect.status).toBe('pass');
  });

  it('E3-D9: a window without the 2 px guard misses a defect inside the guard band', () => {
    // A partial placement: the rectangle runs off the window to the left and top, and its right
    // side lies at x = W + 1.75, inside the guard band, with a 0.5 px inward dent at its middle.
    const r = rect(-200, -200, 641.75, 100);
    const kase = harnessCase({ id: 'E3-D9', ...polygon(r), paint: fill(), c: [0, 0] });
    const dent: [number, number] = [641.25, -50];
    const mesh = meshFromTriangles([
      [[-200, -200], [641.75, -200], dent],
      [[-200, -200], dent, [641.75, 100]],
      [
        [-200, -200],
        [641.75, 100],
        [-200, 100],
      ],
    ]);
    const sound = measureCase(kase, controlPorts({ status: 'ok', mesh }));
    expect(sound.status).toBe('fail');
    const defect = measureCase(kase, controlPorts({ status: 'ok', mesh }), {
      mutations: {
        hooks: { window: (o) => ({ x0: o.x0 + 2, y0: o.y0 + 2, x1: o.x1 - 2, y1: o.y1 - 2 }) },
      },
    });
    expect(defect.status).not.toBe('fail');
  });

  it('E3-D10: a record with a rejected case dropped fails the validator', () => {
    const ports = controlPorts({ status: 'ok', mesh: meshFromTriangles(fan(rect(0, 0, 64, 32))) });
    const rows = ['a', 'b', 'c'].map((id, index) => ({
      ...measureCase(harnessCase({ id, ...polygon(rect(0, 0, 64, 32)), paint: fill() }), ports),
      index,
    }));
    const rejected = {
      ...rows[1]!,
      status: 'rejected' as const,
      code: 'work-limit',
      u: null,
      l: null,
      eLo: null,
      eHi: null,
    };
    const all = [rows[0]!, rejected, rows[2]!];
    const input = {
      provenance: { commit: 'test', dirty: false, corpusSha256: 'test' },
      selection: { stride: 1, shards: 1, corpusCases: 3 },
      gpu: null,
      controls: [],
    };
    const ids = ['a', 'b', 'c'];
    const whole: A04Record = buildRecord({ ...input, rows: all });
    expect(validateRecord(whole, ids)).toEqual([]);
    const dropped = buildRecord({ ...input, rows: [rows[0]!, rows[2]!] });
    expect(validateRecord(dropped, ids).some((p) => p.startsWith('rows 2 ≠ 3'))).toBe(true);
    // The verdict is not PASS without the GPU check and controls, and the validator agrees.
    expect(whole.verdict).toBe('UNVERIFIED');
    const forged = { ...whole, verdict: 'PASS' as const };
    expect(validateRecord(forged, ids)).toContain('verdict PASS ≠ UNVERIFIED');
  });
});

it('the measurement cap is the contract annex parameter', () => {
  expect(A04_ORACLE_PARAMETERS.measureWorkCap).toBe(7_200_000_000);
});
