// D9 E3 unit E3-U3: the rejecting positive controls and negative controls of contract section 8.1
// that the harness owns, run through the whole harness path (renderer-core buckets and K4
// packing, the exact shader model with beta, the independent oracle, the pass rule). Every mesh
// is built by hand and answered by a synthetic port, so no kernel output is read: the controls
// are allowed before the corpus freeze (section 5.5).
//
// Owned here: E3-PC1 to E3-PC9, E3-PC11, E3-PC14, and E3-PC10 and E3-PC13 re-run through the
// harness (the oracle-level versions are E3-U2's). E3-PC12 belongs to the GPU model check
// (E3-U4) and is reported as not run.
import { type CaseRow, type HarnessHooks, type ScoreOptions, measureCase } from './harness.js';
import { fill, makeCase, polygon, polygons, rect, stroke } from './oracle-cases.js';
import type { ControlOutcome } from './record.js';
import { type Tri, earClip, fanTriangles, meshFromTriangles, syntheticPorts } from './synthetic.js';

type Pt = readonly [number, number];

/** T0, zoom 1, DPR 1: one local unit is one physical pixel. */
const ORIGIN: Pt = [-100, -100];
const SLACK = 1e-5;
/** The oracle refines a straddling case on its own; a stroke at the default 2^-10 costs minutes. */
const STROKE_RESOLUTION = 2 ** -4;
const COARSE: ScoreOptions = { resolution: STROKE_RESOLUTION };
/** The sandwich controls need a finite E_hi, so each term is refined on its own. */
const SANDWICH: ScoreOptions = { resolution: STROKE_RESOLUTION, separateTerms: true };

const reverse = (points: readonly Pt[]): Pt[] => [...points].reverse();

function run(
  kase: ReturnType<typeof makeCase>,
  triangles: readonly Tri[] | 'empty',
  options: ScoreOptions = {},
): CaseRow {
  const answer = triangles === 'empty' ? 'empty' : meshFromTriangles(triangles);
  return measureCase(kase, syntheticPorts(answer), options);
}

const contains = (row: CaseRow, value: number, slack = SLACK): boolean =>
  row.eLo !== null && row.eLo - slack <= value && (row.eHi === null || value <= row.eHi + slack);

function outcome(
  id: string,
  expected: ControlOutcome['expected'],
  rows: readonly CaseRow[],
  verdict: (rows: readonly CaseRow[]) => string | null,
): ControlOutcome {
  const problem = verdict(rows);
  return {
    id,
    expected,
    observed: rows.map((r) => r.status.toUpperCase()).join(', '),
    ok: problem === null,
    detail: problem ?? rows.map(describe).join('; '),
  };
}

const describe = (r: CaseRow): string =>
  `E=[${r.eLo?.toPrecision(5) ?? 'n/a'}, ${r.eHi?.toPrecision(5) ?? 'inf'}] beta=${r.betaC.toExponential(2)}`;

// ---------------------------------------------------------------------------------------------
// Shapes

const SQUARE16 = rect(0, 0, 16, 16);

function tipTriangles(star: readonly Pt[]): Tri[] {
  // Edge i runs P[i] -> P[i + 1]. Its crossings are with the two non-adjacent edges.
  const n = star.length;
  const cross = (i: number, j: number): Pt => {
    const [a, b] = [star[i]!, star[(i + 1) % n]!];
    const [c, d] = [star[j]!, star[(j + 1) % n]!];
    const r = [b[0] - a[0], b[1] - a[1]] as const;
    const s = [d[0] - c[0], d[1] - c[1]] as const;
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / (r[0] * s[1] - r[1] * s[0]);
    return [a[0] + t * r[0], a[1] + t * r[1]];
  };
  const near = (p: Pt, list: readonly Pt[]): Pt =>
    list.reduce((best, q) =>
      Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.hypot(best[0] - p[0], best[1] - p[1]) ? q : best,
    );
  const out: Tri[] = [];
  for (let k = 0; k < n; k += 1) {
    const tip = star[k]!;
    const inEdge = (k + n - 1) % n;
    const qIn = near(tip, [cross(inEdge, (k + 1) % n), cross(inEdge, (k + 2) % n)]);
    const qOut = near(tip, [cross(k, (k + 2) % n), cross(k, (k + 3) % n)]);
    const tri: Tri = [tip, qIn, qOut];
    const c =
      (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) -
      (tri[1][1] - tri[0][1]) * (tri[2][0] - tri[0][0]);
    out.push(c > 0 ? tri : [tri[0], tri[2], tri[1]]);
  }
  return out;
}

const PENTAGRAM: Pt[] = [
  [0, -10],
  [6, 8],
  [-10, -3],
  [10, -3],
  [-6, 8],
];

function circlePolygon(n: number, radius: number, split = 0.3): Tri[] {
  // The inscribed n-gon as a fan from the center; each chord is split at `split` of its length
  // so that no dyadic cell center falls on a chord midpoint (where the sagitta is attained).
  const ring: Pt[] = [];
  for (let k = 0; k < n; k += 1) {
    const a: Pt = [
      radius * Math.cos((2 * Math.PI * k) / n),
      radius * Math.sin((2 * Math.PI * k) / n),
    ];
    const b: Pt = [
      radius * Math.cos((2 * Math.PI * (k + 1)) / n),
      radius * Math.sin((2 * Math.PI * (k + 1)) / n),
    ];
    ring.push(a, [a[0] + split * (b[0] - a[0]), a[1] + split * (b[1] - a[1])]);
  }
  return ring.map((p, i) => [[0, 0], p, ring[(i + 1) % ring.length]!] as Tri);
}

const sagitta = (n: number, radius: number): number => radius * (1 - Math.cos(Math.PI / n));

/** The exact disk of radius 8: a zero-length subpath with a round cap of width 16 (ST-S10). */
const DISK = makeCase({
  verbs: 'ML',
  points: [0, 0, 0, 0],
  paint: stroke(16, 'round'),
  c: ORIGIN,
});

// E3-PC3's S-curve row: the closed S of the corpus (row c03), its two cubics replaced by m
// inscribed chords each.
const C1 = [
  [0, 0],
  [4, 8],
  [8, -8],
  [12, 0],
] as const;
const C2 = [
  [12, -6],
  [8, -14],
  [4, 2],
  [0, -6],
] as const;
const S_CURVE = makeCase({
  verbs: 'MCLCZ',
  points: [0, 0, 4, 8, 8, -8, 12, 0, 12, -6, 8, -14, 4, 2, 0, -6],
  paint: fill(),
  c: ORIGIN,
});

const cubicAt = (p: readonly (readonly number[])[], t: number): Pt => {
  const s = 1 - t;
  const w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
  return [w.reduce((a, b, i) => a + b * p[i]![0]!, 0), w.reduce((a, b, i) => a + b * p[i]![1]!, 0)];
};

/** The largest perpendicular distance from a chord of the m-chord approximation to its arc. */
export function chordDeviation(p: readonly (readonly number[])[], m: number): number {
  let worst = 0;
  for (let i = 0; i < m; i += 1) {
    const a = cubicAt(p, i / m);
    const b = cubicAt(p, (i + 1) / m);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let k = 0; k <= 4000; k += 1) {
      const q = cubicAt(p, (i + k / 4000) / m);
      const d = Math.abs((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) / length;
      worst = Math.max(worst, d);
    }
  }
  return worst;
}

/** The chord count that the `e + 3` tolerance admits: the smallest m with deviation <= 2^(e+3). */
export function admittedChords(tolerance: number): number {
  let m = 1;
  while (chordDeviation(C1, m) > tolerance || chordDeviation(C2, m) > tolerance) m += 1;
  return m;
}

const sCurvePolygon = (m: number): Pt[] => [
  ...Array.from({ length: m + 1 }, (_, i) => cubicAt(C1, i / m)),
  ...Array.from({ length: m + 1 }, (_, i) => cubicAt(C2, i / m)),
];

// ---------------------------------------------------------------------------------------------
// The controls

const base = polygon(rect(0, 0, 16, 8));

/** A 16 x 8 rectangle with a vertex M = (8, 0) on its top edge, as a conforming triangulation. */
function rectWithMidpoint(moved: number): Tri[] {
  const m: Pt = [8, moved];
  return [
    [[0, 0], m, [0, 8]],
    [m, [16, 8], [0, 8]],
    [m, [16, 0], [16, 8]],
  ];
}

function pc1(): ControlOutcome {
  const kase = makeCase({ ...base, paint: fill(), c: ORIGIN });
  const row = run(kase, rectWithMidpoint(-0.26), { separateTerms: true });
  return outcome('E3-PC1', 'FAIL', [row], ([r]) =>
    r!.status === 'fail' && contains(r!, 0.26)
      ? null
      : 'a vertex moved 0.26 px did not fail at 0.26',
  );
}

function pc2(): ControlOutcome {
  const kase = makeCase({ ...base, paint: fill(), c: ORIGIN });
  const row = run(kase, rectWithMidpoint(-0.24), { separateTerms: true });
  return outcome('E3-PC2', 'PASS', [row], ([r]) =>
    r!.status === 'pass' && contains(r!, 0.24)
      ? null
      : 'a vertex moved 0.24 px did not pass at 0.24',
  );
}

function pc3(): ControlOutcome {
  // The circle row: the exact circle against an inscribed n-gon at the chord count that the
  // e + 3 tolerance admits. T0, zoom 1, DPR 1 give e = -3, so the admitted sagitta is 2^0 = 1 px.
  let n = 3;
  while (sagitta(n, 8) > 1) n += 1;
  const circleRow = run(DISK, circlePolygon(n, 8), SANDWICH);
  const known = sagitta(n, 8);
  // The S-curve row.
  const m = admittedChords(1);
  const deviation = Math.max(chordDeviation(C1, m), chordDeviation(C2, m));
  const sRow = run(S_CURVE, earClip(sCurvePolygon(m)), SANDWICH);
  return outcome('E3-PC3', 'FAIL', [circleRow, sRow], ([c, s]) => {
    if (!(known > 0.3 && known <= 1)) return `circle sagitta ${known} is not in (0.3, 1]`;
    if (!(deviation > 0.3 && deviation <= 1))
      return `S-curve deviation ${deviation} not in (0.3, 1]`;
    if (c!.status !== 'fail') return 'the coarse circle did not fail';
    if (!contains(c!, known, 1e-6)) return `the circle sagitta ${known} is outside [E_lo, E_hi]`;
    if (s!.status !== 'fail') return 'the coarse S-curve did not fail';
    // The perpendicular deviation bounds the boundary distance from above; the oracle's lower
    // bound must not exceed it, and must exceed the 0.25 target.
    if (s!.eLo === null || s!.eLo > deviation + 1e-6) return 'E_lo exceeds the closed-form bound';
    return null;
  });
}

function pc4(): ControlOutcome {
  const kase = makeCase({ ...polygon(SQUARE16), paint: fill(), c: ORIGIN });
  const c: Pt = [8, 8];
  const fan: Tri[] = [
    [[0, 0], [16, 0], c],
    [[16, 0], [16, 16], c],
    [[16, 16], [0, 16], c],
    [[0, 16], [0, 0], c],
  ];
  const good = run(kase, fan);
  const dropped = run(kase, [fan[0]!, fan[1]!, fan[3]!]);
  return outcome('E3-PC4', 'FAIL', [dropped, good], ([bad, ok]) =>
    bad!.status === 'fail' && ok!.status === 'pass'
      ? null
      : 'a dropped interior triangle did not fail',
  );
}

function pc5(): ControlOutcome {
  const kase = makeCase({ ...polygon(PENTAGRAM), paint: fill('nonzero'), c: ORIGIN });
  // The even-odd region of the pentagram is its five tips, without the central pentagon.
  const row = run(kase, tipTriangles(PENTAGRAM));
  return outcome('E3-PC5', 'FAIL', [row], ([r]) =>
    r!.status === 'fail' ? null : 'the even-odd mesh against a nonzero case did not fail',
  );
}

function pc6(): ControlOutcome {
  // A ring whose ideal hole is 0.4 px wide, meshed without the hole (the ST-OB3 residual).
  const kase = makeCase({
    ...polygons([rect(-8, -8, 8, 8), reverse(rect(-0.2, -4, 0.2, 4))]),
    paint: fill(),
    c: ORIGIN,
  });
  const row = run(kase, fanTriangles(rect(-8, -8, 8, 8)));
  return outcome('E3-PC6', 'FAIL', [row], ([r]) =>
    r!.status === 'fail' ? null : 'a closed hole did not fail',
  );
}

const FAR = 2 ** 24;

/** x12 of the corpus: s01-I (here 20 wide) with t = (2^24, -2^24), the camera following it. */
export function farCase() {
  return makeCase({
    ...polygon(rect(0, 0, 20, 8)),
    paint: fill(),
    t: [FAR, -FAR],
    c: [FAR + 10 - 320, -FAR + 4 - 180],
  });
}

export const farRectangle = (): Tri[] => fanTriangles(rect(0, 0, 20, 8));

function pc7(): ControlOutcome {
  const kase = farCase();
  const good = run(kase, farRectangle());
  // One f32 lane of A is perturbed by 2^18 ulps (2^-5): the vertices at u = +-10 move 0.3125 px.
  const hooks: HarnessHooks = {
    mutateLanes: (l) => ({
      ...l,
      linear: [l.linear[0] + 2 ** -5, l.linear[1], l.linear[2], l.linear[3]],
    }),
  };
  const bad = run(kase, farRectangle(), { hooks });
  return outcome('E3-PC7', 'FAIL', [bad, good], ([b, g]) =>
    b!.status === 'fail' && g!.status === 'pass' && contains(b!, 0.3125, 1e-4)
      ? null
      : 'a perturbed lane of A did not fail at the far-translation case',
  );
}

function pc8(): ControlOutcome {
  const kase = farCase();
  const good = run(kase, farRectangle());
  const hooks: HarnessHooks = {
    mutateLanes: (l) => ({
      ...l,
      originMinusCamera: [Math.fround(l.originMinusCamera[0] + 0.3), l.originMinusCamera[1]],
    }),
  };
  const bad = run(kase, farRectangle(), { hooks });
  return outcome('E3-PC8', 'FAIL', [bad, good], ([b, g]) =>
    b!.status === 'fail' && g!.status === 'pass' ? null : 'a 0.3 px pan offset did not fail',
  );
}

function strokeLine() {
  return makeCase({ verbs: 'ML', points: [0, 0, 20, 0], paint: stroke(2, 'butt'), c: ORIGIN });
}

function pc9(): ControlOutcome {
  // (a) The half-width raised by 0.3: each side moves 0.3 px.
  const width = strokeLine();
  const wideOk = run(width, fanTriangles(rect(0, -1, 20, 1)), COARSE);
  const wideBad = run(width, fanTriangles(rect(0, -1.3, 20, 1.3)), COARSE);
  // (b) A kept miter replaced by a bevel: the tip (21, -1) lies 0.707 px beyond the bevel line.
  const corner = makeCase({
    verbs: 'MLL',
    points: [0, 0, 20, 0, 20, 20],
    paint: stroke(2, 'butt', 'miter', 4),
    c: ORIGIN,
  });
  const miter: Pt[] = [
    [0, -1],
    [21, -1],
    [21, 20],
    [19, 20],
    [19, 1],
    [0, 1],
  ];
  const bevel: Pt[] = [
    [0, -1],
    [20, -1],
    [21, 0],
    [21, 20],
    [19, 20],
    [19, 1],
    [0, 1],
  ];
  const miterOk = run(corner, earClip(miter), COARSE);
  const miterBad = run(corner, earClip(bevel), COARSE);
  // (c) A round cap replaced by a square cap: the corner lies r(sqrt 2 - 1) = 0.414 px outside.
  const round = makeCase({
    verbs: 'ML',
    points: [0, 0, 20, 0],
    paint: stroke(2, 'round', 'round'),
    c: ORIGIN,
  });
  const half = 64;
  const roundOutline: Pt[] = [];
  for (let k = 0; k <= half; k += 1) {
    const t = -Math.PI / 2 + (Math.PI * k) / half;
    roundOutline.push([20 + Math.cos(t), Math.sin(t)]);
  }
  for (let k = 0; k <= half; k += 1) {
    const t = Math.PI / 2 + (Math.PI * k) / half;
    roundOutline.push([Math.cos(t), Math.sin(t)]);
  }
  const roundOk = run(round, earClip(roundOutline), COARSE);
  const roundBad = run(round, fanTriangles(rect(-1, -1, 21, 1)), COARSE);
  const rows = [wideBad, miterBad, roundBad, wideOk, miterOk, roundOk];
  return outcome('E3-PC9', 'FAIL', rows, ([a, b, c, ...oks]) => {
    if (a!.status !== 'fail') return 'half-width + 0.3 did not fail';
    if (b!.status !== 'fail') return 'a miter replaced by a bevel did not fail';
    if (c!.status !== 'fail') return 'a round cap replaced by a square cap did not fail';
    if (!oks.every((r) => r.status === 'pass')) return 'a correct stroke mesh did not pass';
    return null;
  });
}

function pc10(): ControlOutcome {
  // Closed-form controls through the harness: the rectangle (E = 0), an inscribed 16-gon of the
  // exact circle (E = its sagitta), and a polygon translated by 2^-4 (E = 2^-4).
  const rectRow = run(
    makeCase({ ...base, paint: fill(), c: ORIGIN }),
    fanTriangles(rect(0, 0, 16, 8)),
  );
  const ngonRow = run(DISK, circlePolygon(16, 8), SANDWICH);
  const x08: Pt[] = [
    [0, 0],
    [16, 0],
    [12, 8],
    [4, 8],
  ];
  const moved = x08.map(([x, y]) => [x, y + 2 ** -4] as Pt);
  const shiftRow = run(
    makeCase({ ...polygon(x08), paint: fill(), c: ORIGIN }),
    fanTriangles(moved),
  );
  return outcome('E3-PC10', 'INTERVAL', [rectRow, ngonRow, shiftRow], ([r, g, s]) => {
    if (!contains(r!, 0, 1e-6) || r!.eHi! > 2 ** -10 + 1e-6) return 'the rectangle is not E = 0';
    if (!contains(g!, sagitta(16, 8), 1e-6)) return 'the 16-gon interval misses its sagitta';
    if (!contains(s!, 2 ** -4, 1e-6)) return 'the translated polygon interval misses 2^-4';
    return null;
  });
}

function pc11(): ControlOutcome {
  const kase = makeCase({ ...base, paint: fill(), c: ORIGIN });
  const row = run(kase, 'empty');
  return outcome('E3-PC11', 'FAIL', [row], ([r]) =>
    r!.status === 'fail' ? null : 'an empty result for a non-empty case did not fail',
  );
}

function pc13(): ControlOutcome {
  // A synthetic T-junction mesh under the shear T4 (section 8.1, E3-PC13), through the harness.
  const a = 1 - 2 ** -24;
  const ym = 0.5 - 2 ** -25;
  const kase = makeCase({
    ...polygon(rect(0, 0, 2 * a, a)),
    paint: fill(),
    l: [1, 0.5, 0, 1],
    zoom: 8,
    c: [-1, -1],
  });
  const tris: Tri[] = [
    [
      [0, 0],
      [a, 0],
      [a, a],
    ],
    [
      [0, 0],
      [a, a],
      [0, a],
    ],
    [
      [a, 0],
      [2 * a, 0],
      [a, ym],
    ],
    [
      [2 * a, 0],
      [2 * a, a],
      [a, ym],
    ],
    [
      [2 * a, a],
      [a, a],
      [a, ym],
    ],
  ];
  const row = run(kase, tris);
  return outcome('E3-PC13', 'PASS', [row], ([r]) => {
    if (r!.status !== 'pass') return `the T-junction mesh is ${r!.status}`;
    if (r!.tJunctions !== 1) return `T-junctions: ${r!.tJunctions}, expected 1`;
    if (r!.storageCracks !== 0) return 'the T-vertex left its edge in M*';
    if (r!.crackBound === null || !(r!.crackBound >= 2 * r!.betaC))
      return 'no crack bound reported';
    return null;
  });
}

function pc14(): ControlOutcome {
  const cover = makeCase({ ...polygon(rect(-1000, -1000, 2000, 2000)), paint: fill() });
  const row = run(cover, 'empty');
  const away = makeCase({ ...polygon(rect(5000, 5000, 5016, 5008)), paint: fill() });
  const quiet = run(away, 'empty');
  return outcome('E3-PC14', 'FAIL', [row, quiet], ([r, w]) => {
    if (r!.status !== 'fail' || r!.windowPoint === null)
      return 'a missing mesh over Ω did not fail';
    if (!(r!.windowPoint.r && !r!.windowPoint.m)) return 'the window point did not disagree';
    if (w!.status !== 'window-empty')
      return 'a shape away from Ω with no mesh was not window-empty';
    return null;
  });
}

const pc12 = (): ControlOutcome => ({
  id: 'E3-PC12',
  expected: 'GPU-CHECK-FAILS',
  observed: 'NOT RUN',
  ok: false,
  detail: 'the GPU model check and its control belong to E3-U4',
});

const CONTROLS: Readonly<Record<string, () => ControlOutcome>> = {
  'E3-PC1': pc1,
  'E3-PC2': pc2,
  'E3-PC3': pc3,
  'E3-PC4': pc4,
  'E3-PC5': pc5,
  'E3-PC6': pc6,
  'E3-PC7': pc7,
  'E3-PC8': pc8,
  'E3-PC9': pc9,
  'E3-PC10': pc10,
  'E3-PC11': pc11,
  'E3-PC12': pc12,
  'E3-PC13': pc13,
  'E3-PC14': pc14,
};

export const CONTROL_IDS = Object.keys(CONTROLS);

/** Runs the named controls (all by default). A throw is reported as a control that failed. */
export function runControls(only: readonly string[] = CONTROL_IDS): ControlOutcome[] {
  return only.map((id) => {
    try {
      return CONTROLS[id]!();
    } catch (error) {
      return {
        id,
        expected: 'FAIL',
        observed: 'ERROR',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
