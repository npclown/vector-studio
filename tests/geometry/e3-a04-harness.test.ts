// D9 E3 unit E3-U3: tests of the A04 measurement harness
// (docs/plans/d9-e3-b4-precision-contract.md sections 3.2, 6, 7.1 to 7.3 and 15).
//
// The corpus `a04-corpus/v1` is NOT run here (section 5.5: no kernel before the freeze note).
// Every case is a hand-made one and every port is a synthetic double, except the one smoke test
// at the end, which is skipped without a release WASM and drives the real ports on two
// hand-made, non-corpus cases.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { computePathBuckets } from '../../packages/renderer-core/src/path-buckets.js';
import {
  type CaseObject,
  type HarnessHooks,
  measureCase,
  renderCase,
  scoreRendered,
} from './e3-a04/harness.js';
import { fill, makeCase, polygon, rect, stroke } from './e3-a04/oracle-cases.js';
import {
  F32_DIV,
  F32_OP,
  type ShaderLanes,
  clipBound,
  mapMesh,
  mapStoredPoint,
  noFlipCertificate,
  shaderIdentitySha256,
} from './e3-a04/shader-model.js';
import {
  type Tri,
  fanTriangles,
  meshFromTriangles,
  syntheticPorts,
} from './e3-a04/synthetic.js';

const ORIGIN: readonly [number, number] = [-100, -100];

// =============================================================================================
// The shader model: exact mapping and the f32 error bound beta (section 7.1; E3-D7, E3-D14)

const toNumber = (d: { n: bigint; e: number }): number => Number(d.n) * 2 ** d.e;

/** f32 operations of the WGSL mapping, with the rounding of the given mode. */
function simulate(
  round: (x: number) => number,
  ux: number,
  uy: number,
  lanes: ShaderLanes,
): { vertex: readonly [number, number]; feature: readonly [number, number] } {
  const mul = (a: number, b: number) => round(a * b);
  const add = (a: number, b: number) => round(a + b);
  const div = (a: number, b: number) => round(a / b);
  const [l0, l1, l2, l3] = lanes.linear;
  const lx = add(mul(l0, ux), mul(l2, uy));
  const ly = add(mul(l1, ux), mul(l3, uy));
  const dx = add(add(lx, lanes.anchor[0]), lanes.originMinusCamera[0]);
  const dy = add(add(ly, lanes.anchor[1]), lanes.originMinusCamera[1]);
  const px = mul(mul(dx, lanes.zoom), lanes.devicePixelRatio);
  const py = mul(mul(dy, lanes.zoom), lanes.devicePixelRatio);
  const [W, H] = lanes.physicalSize;
  const ndcX = add(div(mul(px, 2), W), -1);
  const ndcY = add(1, -div(mul(py, 2), H));
  const backX = mul(mul(add(ndcX, 1), 0.5), W);
  const backY = mul(mul(add(1, -ndcY), 0.5), H);
  return { vertex: [backX, backY], feature: [px, py] };
}

const roundNearest = (x: number): number => Math.fround(x);

/** Round toward zero in binary32: one of the two neighbours WGSL allows (section 15.2). */
function roundTowardZero(x: number): number {
  const r = Math.fround(x);
  if (Math.abs(r) <= Math.abs(x)) return r;
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, r);
  view.setUint32(0, view.getUint32(0) - 1);
  return view.getFloat32(0);
}

function randomLanes(seed: number, far: boolean): { lanes: ShaderLanes; points: number[][] } {
  let s = seed >>> 0;
  const next = () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s / 2 ** 32;
  };
  const f = Math.fround;
  const angle = next() * 6.28;
  const scale = 0.5 + next() * 2;
  const lanes: ShaderLanes = {
    linear: [
      f(scale * Math.cos(angle)),
      f(scale * Math.sin(angle)),
      f(-scale * Math.sin(angle)),
      f(scale * Math.cos(angle)),
    ],
    anchor: far
      ? [f((next() - 0.5) * 4000), f((next() - 0.5) * 4000)]
      : [f((next() - 0.5) * 200), f((next() - 0.5) * 200)],
    originMinusCamera: [f((next() - 0.5) * 300), f((next() - 0.5) * 300)],
    zoom: f(far ? 0.01 : 0.5 + next() * 3),
    devicePixelRatio: [1, 2, 3][Math.floor(next() * 3)]!,
    physicalSize: [640 * [1, 2, 3][Math.floor(next() * 3)]!, 360],
  };
  // Keep the physical size consistent with the DPR (an exact integer pair).
  const dpr = lanes.devicePixelRatio;
  const sized = { ...lanes, physicalSize: [640 * dpr, 360 * dpr] as const };
  const points = Array.from({ length: 40 }, () => [
    f((next() - 0.5) * (far ? 40000 : 400)),
    f((next() - 0.5) * (far ? 40000 : 400)),
  ]);
  return { lanes: sized, points };
}

describe('shader model: the exact mapping and beta (section 7.1)', () => {
  it('the mapping is the exact K4 expression over the rationals', () => {
    const lanes: ShaderLanes = {
      linear: [1.5, 0.25, -0.75, 2],
      anchor: [3.5, -2.25],
      originMinusCamera: [-0.5, 0.125],
      zoom: 2,
      devicePixelRatio: 3,
      physicalSize: [1920, 1080],
    };
    const p = mapStoredPoint(4, -2, lanes);
    // x = ((1.5·4 + -0.75·-2) + 3.5 + -0.5)·2·3 = (7.5 + 3.5 - 0.5)·6 = 63
    expect(toNumber(p.x)).toBe(63);
    // y = ((0.25·4 + 2·-2) - 2.25 + 0.125)·6 = (-3 - 2.25 + 0.125)·6 = -30.75
    expect(toNumber(p.y)).toBe(-30.75);
  });

  it('beta contains the f32 evaluation error: round to nearest and toward zero, near and far', () => {
    let worst = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const { lanes, points } = randomLanes(seed * 7919, seed % 2 === 0);
      for (const [ux, uy] of points) {
        const p = mapStoredPoint(ux!, uy!, lanes);
        const ideal = [toNumber(p.x), toNumber(p.y)] as const;
        for (const round of [roundNearest, roundTowardZero]) {
          const sim = simulate(round, ux!, uy!, lanes);
          const vertexError = Math.hypot(sim.vertex[0] - ideal[0], sim.vertex[1] - ideal[1]);
          const featureError = Math.hypot(sim.feature[0] - ideal[0], sim.feature[1] - ideal[1]);
          expect(vertexError).toBeLessThanOrEqual(p.betaVertex);
          expect(featureError).toBeLessThanOrEqual(p.betaFeature);
          worst = Math.max(worst, vertexError / p.betaVertex);
        }
      }
    }
    // The bound is not vacuous: some sample reaches a few percent of it.
    expect(worst).toBeGreaterThan(0.02);
  });

  it('E3-D14: an NDC step omitted from beta is caught on a far-translation point', () => {
    // The mutant keeps only the toPhysical error. At zoom 0.01 and DPR 3 (two inexact
    // multiplies) the NDC round trip adds four more roundings, and a toward-zero simulation
    // exceeds the mutant on some point, while the full bound still contains every one.
    let beyondMutant = 0;
    let beyondFull = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const { lanes, points } = randomLanes(seed * 104729, true);
      const dpr = 3;
      const l = { ...lanes, devicePixelRatio: dpr, physicalSize: [640 * dpr, 360 * dpr] as const };
      for (const [ux, uy] of points) {
        const full = mapStoredPoint(ux!, uy!, l);
        const mutant = mapStoredPoint(ux!, uy!, l, { omitNdc: true });
        expect(mutant.betaVertex).toBeLessThan(full.betaVertex);
        const sim = simulate(roundTowardZero, ux!, uy!, l).vertex;
        const error = Math.hypot(sim[0] - toNumber(full.x), sim[1] - toNumber(full.y));
        if (error > mutant.betaVertex) beyondMutant += 1;
        if (error > full.betaVertex) beyondFull += 1;
      }
    }
    expect(beyondMutant).toBeGreaterThan(0);
    expect(beyondFull).toBe(0);
  });

  it('the model constants are WGSL-allowed ulps, and the shader identity hash is a SHA-256', () => {
    expect(F32_OP).toBe(2 ** -23);
    expect(F32_DIV).toBe(2.5 * 2 ** -23);
    expect(shaderIdentitySha256()).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('an intermediate that can exceed f32 is flagged', () => {
    const lanes: ShaderLanes = {
      linear: [3e38, 0, 0, 1],
      anchor: [0, 0],
      originMinusCamera: [0, 0],
      zoom: 1,
      devicePixelRatio: 1,
      physicalSize: [640, 360],
    };
    expect(mapStoredPoint(1e3, 0, lanes).overflow).toBe(true);
    expect(mapStoredPoint(1, 0, { ...lanes, linear: [1, 0, 0, 1] }).overflow).toBe(false);
  });
});

// =============================================================================================
// The no-flip certificate and the guard band (section 7.1, E3-Q11 (a))

function meshOf(points: readonly (readonly [number, number])[], triangles: readonly number[]) {
  const identity: ShaderLanes = {
    linear: [1, 0, 0, 1],
    anchor: [0, 0],
    originMinusCamera: [0, 0],
    zoom: 1,
    devicePixelRatio: 1,
    physicalSize: [640, 360],
  };
  return mapMesh(Float32Array.from(points.flat()), Uint32Array.from(triangles), identity);
}

describe('no-flip certificate', () => {
  it('holds for a well-shaped triangle and fails for a sliver thinner than beta allows', () => {
    const good = meshOf(
      [
        [100, 100],
        [116, 100],
        [100, 108],
      ],
      [0, 1, 2],
    );
    expect(noFlipCertificate(good, good.beta).uncertain).toBe(0);
    const sliver = meshOf(
      [
        [100, 100],
        [116, 100],
        [108, 100.0001],
      ],
      [0, 1, 2],
    );
    expect(noFlipCertificate(sliver, sliver.beta).uncertain).toBe(1);
    // A larger beta than the mesh's own also fails the good triangle when it is large enough.
    expect(noFlipCertificate(good, 2).uncertain).toBe(1);
  });
});

describe('guard band and clipping bound', () => {
  const size: readonly [number, number] = [640, 360];
  it('a mesh inside the viewport is not clipped', () => {
    const inside = meshOf(
      [
        [100, 100],
        [116, 100],
        [100, 108],
      ],
      [0, 1, 2],
    );
    expect(clipBound(inside, size, inside.beta)).toMatchObject({ clipped: false, bound: 0 });
  });
  it('a triangle that crosses the viewport edge adds a small f32 interpolation bound', () => {
    const crossing = meshOf(
      [
        [600, 100],
        [700, 100],
        [600, 200],
      ],
      [0, 1, 2],
    );
    const clip = clipBound(crossing, size, crossing.beta);
    expect(clip.clipped).toBe(true);
    expect(clip.crossings).toBeGreaterThan(0);
    expect(clip.bound).toBeGreaterThan(0);
    expect(clip.bound).toBeLessThan(0.01);
  });
  it('a triangle wholly outside one plane draws nothing and adds no bound', () => {
    const away = meshOf(
      [
        [700, 100],
        [716, 100],
        [700, 108],
      ],
      [0, 1, 2],
    );
    expect(clipBound(away, size, away.beta)).toMatchObject({ clipped: false, bound: 0 });
  });
  it('a very long edge makes the bound reach 0.25 px or become uncomputable', () => {
    const long = meshOf(
      [
        [300, 100],
        [3e7, 100],
        [300, 200],
      ],
      [0, 1, 2],
    );
    const clip = clipBound(long, size, long.beta);
    expect(clip.bound === Infinity || clip.bound >= 0.25).toBe(true);
  });
  it('such a case is UNDECIDED in the harness, and never sent to the oracle', () => {
    const kase = makeCase({ ...polygon(rect(0, 0, 16, 8)), paint: fill(), c: ORIGIN });
    const huge: Tri[] = [
      [
        [0, 0],
        [3e7, 0],
        [0, 8],
      ],
    ];
    const row = measureCase(kase, syntheticPorts(meshFromTriangles(huge)));
    expect(row.status).toBe('undecided');
    expect(row.reason).toMatch(/clip bound|beta_c/u);
    expect(row.eLo).toBeNull();
  });
});

// =============================================================================================
// The renderer stage: rejections, served bucket and draw variants (section 6)

const RECT = makeCase({ ...polygon(rect(0, 0, 16, 8)), paint: fill(), c: ORIGIN });
const RECT_MESH = fanTriangles(rect(0, 0, 16, 8));

describe('rejected cases are excluded and counted, never measured (section 6)', () => {
  for (const code of [
    'work-limit',
    'unsupported-geometry',
    'numeric-range',
    'invalid-tolerance',
    'invalid-path',
  ] as const) {
    it(`a port failed (${code}) is rejected with its code`, () => {
      const row = measureCase(RECT, syntheticPorts({ failed: code }));
      expect(row.status).toBe('rejected');
      expect(row.rejection).toEqual({ source: 'port-failed', code });
      expect(row.eLo).toBeNull();
    });
  }
  it('a renderer state failure before a draw is rejected (invalid-mesh)', () => {
    const bad = meshFromTriangles(RECT_MESH);
    const broken = { ...bad, bounds: { ...bad.bounds, maxX: bad.bounds.maxX + 1 } };
    const row = measureCase(RECT, syntheticPorts(broken));
    expect(row.status).toBe('rejected');
    expect(row.rejection).toEqual({ source: 'renderer-state', code: 'invalid-mesh' });
  });
  it('det L = 0 and w = 0 are not drawable, and rejected', () => {
    const singular = makeCase({ ...polygon(rect(0, 0, 16, 8)), paint: fill(), l: [1, 2, 2, 4] });
    expect(measureCase(singular, syntheticPorts('empty')).rejection).toEqual({
      source: 'not-drawable',
      code: 'det-l-zero',
    });
    const zero = makeCase({ verbs: 'ML', points: [0, 0, 8, 0], paint: stroke(0) });
    expect(measureCase(zero, syntheticPorts('empty')).rejection).toEqual({
      source: 'not-drawable',
      code: 'w-zero',
    });
  });
});

describe('measured, not rejected: empty, fringe-work-cap and fringe-unsupported', () => {
  it('an empty result is a drawn answer M = ∅ (E3-PC11)', () => {
    const rendered = renderCase(RECT, syntheticPorts('empty'));
    expect(rendered).toEqual({ kind: 'empty', reason: 'port-empty' });
    expect(scoreRendered(RECT, rendered).status).toBe('fail');
  });
  it('more than 128 distinct boundary vertices draw region-only and are measured', () => {
    const n = 200;
    const ring = Array.from(
      { length: n },
      (_, k) => [50 * Math.cos((2 * Math.PI * k) / n), 50 * Math.sin((2 * Math.PI * k) / n)] as const,
    );
    const kase = makeCase({ ...polygon(ring as [number, number][]), paint: fill(), c: ORIGIN });
    const rendered = renderCase(kase, syntheticPorts(meshFromTriangles(fanTriangles(ring))));
    expect(rendered).toMatchObject({ kind: 'drawn', variant: 'fringe-work-cap' });
    const row = scoreRendered(kase, rendered, { resolution: 2 ** -6 });
    expect(row.status).toBe('pass');
    expect(row.variant).toBe('fringe-work-cap');
  });
  it('a vertex with four sectors is fringe-unsupported; its region triangles are measured', () => {
    // Four triangles that meet only at the origin (the shape of corpus row f05).
    const turn = (x: number, y: number): [number, number] => [-y, x];
    const tri = (k: number): Tri => {
      let a: [number, number] = [8, -2];
      let b: [number, number] = [8, 2];
      for (let i = 0; i < k; i += 1) {
        a = turn(...a);
        b = turn(...b);
      }
      return [[0, 0], a, b];
    };
    const tris = [0, 1, 2, 3].map(tri);
    const kase = makeCase({
      verbs: 'MLLZMLLZMLLZMLLZ',
      points: tris.flat().flat(),
      paint: fill(),
      c: ORIGIN,
    });
    // tri() puts the shared vertex first: each contour is (0,0), a, b.
    const rendered = renderCase(kase, syntheticPorts(meshFromTriangles(tris)));
    expect(rendered).toMatchObject({ kind: 'drawn', variant: 'fringe-unsupported' });
    expect(scoreRendered(kase, rendered).status).toBe('pass');
  });
});

describe('the served bucket (section 3.2)', () => {
  it('the port is asked at e - k and the row records the served exponent', () => {
    const e = computePathBuckets([1, 0, 0, 1], 1, 1);
    if (e.singular) throw new Error('unexpected');
    const asked: number[] = [];
    const ports = syntheticPorts((request) => {
      asked.push(request.toleranceExponent);
      return meshFromTriangles(RECT_MESH);
    });
    for (const k of [0, 1, 2]) {
      asked.length = 0;
      const row = measureCase({ ...RECT, servedOffset: k }, ports);
      expect(asked).toEqual([e.e - k]);
      expect(row.bucket).toBe(e.e);
      expect(row.servedExponent).toBe(e.e - k);
      expect(row.status).toBe('pass');
    }
  });
});

// =============================================================================================
// The pass rule (section 7.3) and the seeded defects E3-D7 and E3-D9

describe('E3-D7: beta omitted from U', () => {
  // A small far-translation rectangle (u = +-2). The floor is 2^-12 so that a straddling case
  // ends in bounded time: the distance is constant along a whole edge (section 14.4).
  const FAR = 2 ** 24;
  const kase = makeCase({
    ...polygon(rect(0, 0, 4, 2)),
    paint: fill(),
    t: [FAR, -FAR],
    c: [FAR + 2 - 320, -FAR + 1 - 180],
  });
  const ports = syntheticPorts(meshFromTriangles(fanTriangles(rect(0, 0, 4, 2))));
  const options = { floor: 2 ** -12 };
  /** The x lane of A raised by n ulps: the edges at u = +-2 move 2 n 2^-23 px. */
  const lift = (target: number): HarnessHooks => {
    const n = Math.round(target / (2 * 2 ** -23));
    return {
      mutateLanes: (l) => ({
        ...l,
        linear: [l.linear[0] + n * 2 ** -23, l.linear[1], l.linear[2], l.linear[3]],
      }),
    };
  };
  const beta = measureCase(kase, ports, options).betaC;

  it('a case whose error sits inside beta of the threshold is not PASS, and the mutant passes it', () => {
    const hooks = lift(0.25 - 0.8 * beta);
    const real = measureCase(kase, ports, { ...options, hooks });
    expect(real.eLo!).toBeGreaterThan(0.25 - beta);
    expect(real.eLo!).toBeLessThan(0.25);
    expect(real.u!).toBeGreaterThan(0.25);
    expect(real.status).toBe('undecided');
    const mutant = measureCase(kase, ports, { ...options, hooks: { ...hooks, omitBeta: true } });
    expect(mutant.status).toBe('pass');
  });
  it('FAIL needs L = E_lo - beta > 0.25, not E_lo > 0.25', () => {
    const row = measureCase(kase, ports, { ...options, hooks: lift(0.25 + 0.5 * beta) });
    expect(row.eLo!).toBeGreaterThan(0.25);
    expect(row.l!).toBeLessThanOrEqual(0.25);
    expect(row.status).toBe('undecided');
  });
});

describe('E3-D9: a window without the 2 px guard', () => {
  // The path is much larger than Ω (a partial placement). The drawn mesh stops at x = 641, which
  // is inside the guard band (the viewport ends at 640, Ω at 642). A defect there is a missing
  // 259 px of the shape, visible only inside the guard.
  const big = makeCase({
    ...polygon(rect(-100, -100, 900, 300)),
    paint: fill(),
    c: [0, 0],
  });
  const left = fanTriangles(rect(-100, -100, 641, 300));
  it('the oracle window catches it; a window shrunk by the guard misses it', () => {
    const ports = syntheticPorts(meshFromTriangles(left));
    const real = measureCase(big, ports);
    expect(real.status).toBe('fail');
    expect(real.clip.clipped).toBe(true);
    const guardless: HarnessHooks = {
      // Ω loses its right 4 px (viewport 636 css px, DPR 1): the guard ring is gone.
      oracleCase: (k: CaseObject) => ({ ...k, viewport: [636, 360] }),
    };
    const mutant = measureCase(big, ports, { hooks: guardless });
    // The defect is outside the shrunk window: nothing is measured, and the case reads as quiet.
    expect(mutant.status).toBe('window-empty');
  });
});

// =============================================================================================
// Real ports, two hand-made cases that are not in the corpus (skipped without a release WASM)

describe.skipIf(process.env.P2_WASM_PATH === undefined)('real release WASM ports (smoke)', () => {
  it('measures a hand-made fill and a hand-made stroke through the real ports', async () => {
    const { createFillMeshPort, createStrokeMeshPort } = await import(
      '../../packages/geometry-wasm/src/index.js'
    );
    const module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH!)));
    const ports = {
      fill: await createFillMeshPort(module),
      stroke: await createStrokeMeshPort(module),
    };
    const square = makeCase({ ...polygon(rect(0, 0, 16, 16)), paint: fill(), c: ORIGIN });
    const fillRow = measureCase(square, ports, { resolution: 2 ** -4 });
    expect(fillRow.status).toBe('pass');
    expect(fillRow.variant).toBe('fringe');
    const line = makeCase({ verbs: 'ML', points: [0, 0, 16, 0], paint: stroke(4), c: ORIGIN });
    const strokeRow = measureCase(line, ports, { resolution: 2 ** -3 });
    expect(['pass', 'undecided']).toContain(strokeRow.status);
    expect(strokeRow.rejection).toBeNull();
  });
});
