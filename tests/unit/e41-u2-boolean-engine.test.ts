// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), unit U2: E41-A02 boolean
// correctness on fixtures B1 to B15 and a seeded random corpus, checked by a scanline oracle.
import { describe, expect, it } from 'vitest';

import {
  BOOLEAN_EPSILON,
  BOOLEAN_ETA,
  booleanOp,
  type BFillRule,
  type BPoint,
  type BSegment,
  type BShape,
  type BooleanOp,
} from '../../packages/editor-core/src/boolean/index.js';

const K = 0.5522847498307936;
const OPS: readonly BooleanOp[] = ['union', 'subtract', 'intersect', 'exclude'];

// ---------- shape builders ----------

function line(a: BPoint, b: BPoint): BSegment {
  return { kind: 'line', p0: a, p1: b };
}
function cubic(p0: BPoint, c1: BPoint, c2: BPoint, p1: BPoint): BSegment {
  return { kind: 'cubic', p0, c1, c2, p1 };
}
function polygon(points: readonly BPoint[], fillRule: BFillRule = 'nonzero'): BShape {
  const segs: BSegment[] = [];
  for (let i = 0; i < points.length; i++) {
    segs.push(line(points[i] as BPoint, points[(i + 1) % points.length] as BPoint));
  }
  return { contours: [segs], fillRule };
}
function rect(x: number, y: number, w: number, h: number): BShape {
  return polygon([
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]);
}
function ellipse(cx: number, cy: number, rx: number, ry: number): BShape {
  const kx = K * rx;
  const ky = K * ry;
  return {
    contours: [
      [
        cubic(
          { x: cx + rx, y: cy },
          { x: cx + rx, y: cy + ky },
          { x: cx + kx, y: cy + ry },
          { x: cx, y: cy + ry },
        ),
        cubic(
          { x: cx, y: cy + ry },
          { x: cx - kx, y: cy + ry },
          { x: cx - rx, y: cy + ky },
          { x: cx - rx, y: cy },
        ),
        cubic(
          { x: cx - rx, y: cy },
          { x: cx - rx, y: cy - ky },
          { x: cx - kx, y: cy - ry },
          { x: cx, y: cy - ry },
        ),
        cubic(
          { x: cx, y: cy - ry },
          { x: cx + kx, y: cy - ry },
          { x: cx + rx, y: cy - ky },
          { x: cx + rx, y: cy },
        ),
      ],
    ],
    fillRule: 'nonzero',
  };
}
function roundedRect(x: number, y: number, w: number, h: number, r: number): BShape {
  const k = K * r;
  return {
    contours: [
      [
        line({ x: x + r, y }, { x: x + w - r, y }),
        cubic(
          { x: x + w - r, y },
          { x: x + w - r + k, y },
          { x: x + w, y: y + r - k },
          { x: x + w, y: y + r },
        ),
        line({ x: x + w, y: y + r }, { x: x + w, y: y + h - r }),
        cubic(
          { x: x + w, y: y + h - r },
          { x: x + w, y: y + h - r + k },
          { x: x + w - r + k, y: y + h },
          { x: x + w - r, y: y + h },
        ),
        line({ x: x + w - r, y: y + h }, { x: x + r, y: y + h }),
        cubic(
          { x: x + r, y: y + h },
          { x: x + r - k, y: y + h },
          { x, y: y + h - r + k },
          { x, y: y + h - r },
        ),
        line({ x, y: y + h - r }, { x, y: y + r }),
        cubic({ x, y: y + r }, { x, y: y + r - k }, { x: x + r - k, y }, { x: x + r, y }),
      ],
    ],
    fillRule: 'nonzero',
  };
}
function star(cx: number, cy: number, outer: number, inner: number, n: number): BShape {
  const pts: BPoint[] = [];
  for (let i = 0; i < 2 * n; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return polygon(pts);
}
function mapShape(shape: BShape, f: (p: BPoint) => BPoint): BShape {
  return {
    fillRule: shape.fillRule,
    contours: shape.contours.map((c) =>
      c.map((s) =>
        s.kind === 'line' ? line(f(s.p0), f(s.p1)) : cubic(f(s.p0), f(s.c1), f(s.c2), f(s.p1)),
      ),
    ),
  };
}
function rotate(shape: BShape, angle: number, cx: number, cy: number): BShape {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return mapShape(shape, (p) => ({
    x: cx + (p.x - cx) * c - (p.y - cy) * s,
    y: cy + (p.x - cx) * s + (p.y - cy) * c,
  }));
}

// ---------- scanline oracle ----------

type Crossing = { x: number; sign: number };

function rowCrossings(segs: readonly BSegment[], y: number): Crossing[] {
  const out: Crossing[] = [];
  for (const s of segs) {
    if (s.kind === 'line') {
      const a = s.p0.y - y;
      const b = s.p1.y - y;
      let sign = 0;
      if (a <= 0 && b > 0) sign = 1;
      else if (b <= 0 && a > 0) sign = -1;
      if (sign === 0) continue;
      const t = a / (a - b);
      out.push({ x: s.p0.x + (s.p1.x - s.p0.x) * t, sign });
      continue;
    }
    const ys = [s.p0.y, s.c1.y, s.c2.y, s.p1.y].map((v) => v - y);
    if (Math.min(...ys) > 0 || Math.max(...ys) <= 0) continue;
    const [p0, p1, p2, p3] = ys as [number, number, number, number];
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 3 * p0 - 6 * p1 + 3 * p2;
    const c = -3 * p0 + 3 * p1;
    const yAt = (t: number) => ((a * t + b) * t + c) * t + p0;
    const breaks = [0, ...quadRoots(3 * a, 2 * b, c), 1];
    for (let i = 0; i + 1 < breaks.length; i++) {
      const t0 = breaks[i] as number;
      const t1 = breaks[i + 1] as number;
      const y0 = i === 0 ? p0 : yAt(t0);
      const y1 = i + 2 === breaks.length ? p3 : yAt(t1);
      let sign = 0;
      if (y0 <= 0 && y1 > 0) sign = 1;
      else if (y1 <= 0 && y0 > 0) sign = -1;
      if (sign === 0) continue;
      let lo = t0;
      let hi = t1;
      for (let k = 0; k < 52; k++) {
        const mid = 0.5 * (lo + hi);
        if (yAt(mid) > 0 === sign > 0) hi = mid;
        else lo = mid;
      }
      const t = 0.5 * (lo + hi);
      const u = 1 - t;
      const x =
        u * u * u * s.p0.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.p1.x;
      out.push({ x, sign });
    }
  }
  return out.sort((p, q) => q.x - p.x);
}

function quadRoots(a: number, b: number, c: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return [];
  if (Math.abs(a) <= 1e-12 * scale) {
    const t = -c / b;
    return t > 0 && t < 1 ? [t] : [];
  }
  const d = b * b - 4 * a * c;
  if (d < 0) return [];
  const sq = Math.sqrt(d);
  const q = -0.5 * (b + (b >= 0 ? sq : -sq));
  return [q / a, q !== 0 ? c / q : q / a].filter((t) => t > 0 && t < 1).sort((x, y) => x - y);
}

/** Windings along a row at the given xs (crossings sorted by descending x). */
function rowWindings(crossings: readonly Crossing[], xs: readonly number[]): number[] {
  return xs.map((x) => {
    let w = 0;
    for (const c of crossings) {
      if (c.x <= x) break;
      w += c.sign;
    }
    return w;
  });
}

function inside(w: number, rule: BFillRule): boolean {
  return rule === 'evenodd' ? (w & 1) !== 0 : w !== 0;
}

function expected(op: BooleanOp, m: readonly boolean[]): boolean {
  switch (op) {
    case 'union':
      return m.some(Boolean);
    case 'intersect':
      return m.every(Boolean);
    case 'subtract':
      return (m[0] ?? false) && !m.slice(1).some(Boolean);
    case 'exclude':
      return m.filter(Boolean).length % 2 === 1;
  }
}

function boundsOf(shapes: readonly BShape[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    for (const c of shape.contours) {
      for (const s of c) {
        for (const p of s.kind === 'line' ? [s.p0, s.p1] : [s.p0, s.c1, s.c2, s.p1]) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
      }
    }
  }
  return { minX, minY, maxX, maxY, diag: Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2) };
}

function pointOn(s: BSegment, t: number): BPoint {
  if (s.kind === 'line')
    return { x: s.p0.x + (s.p1.x - s.p0.x) * t, y: s.p0.y + (s.p1.y - s.p0.y) * t };
  const u = 1 - t;
  return {
    x: u * u * u * s.p0.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.p1.x,
    y: u * u * u * s.p0.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.p1.y,
  };
}

/** Distance from p to s by dense sampling and local refinement (oracle side; independent code). */
function distanceTo(s: BSegment, p: BPoint): number {
  if (s.kind === 'line') {
    const dx = s.p1.x - s.p0.x;
    const dy = s.p1.y - s.p0.y;
    const l2 = dx * dx + dy * dy;
    const t =
      l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - s.p0.x) * dx + (p.y - s.p0.y) * dy) / l2));
    const q = pointOn(s, t);
    return Math.sqrt((q.x - p.x) ** 2 + (q.y - p.y) ** 2);
  }
  const n = 2048;
  const d2 = (t: number) => {
    const q = pointOn(s, t);
    return (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
  };
  const samples: number[] = [];
  for (let i = 0; i <= n; i++) samples.push(d2(i / n));
  let best = Math.min(samples[0] as number, samples[n] as number);
  // Refine around every local minimum of the samples (golden-section style ternary search).
  for (let i = 0; i <= n; i++) {
    const here = samples[i] as number;
    if (
      (i > 0 && (samples[i - 1] as number) < here) ||
      (i < n && (samples[i + 1] as number) < here)
    )
      continue;
    let lo = Math.max(0, (i - 1) / n);
    let hi = Math.min(1, (i + 1) / n);
    for (let k = 0; k < 80; k++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      if (d2(m1) < d2(m2)) hi = m2;
      else lo = m1;
    }
    best = Math.min(best, d2((lo + hi) / 2));
  }
  return Math.sqrt(best);
}

/**
 * Oracle-side area: Green's theorem, ½∮(x dy − y dx). The integrand is a polynomial of degree 5
 * on a cubic, so 4-point Gauss-Legendre is exact (own derivative; independent of the engine).
 */
function areaOf(contour: readonly BSegment[]): number {
  const o = contour[0]?.p0 ?? { x: 0, y: 0 };
  const a = Math.sqrt(3 / 7 - (2 / 7) * Math.sqrt(6 / 5));
  const c = Math.sqrt(3 / 7 + (2 / 7) * Math.sqrt(6 / 5));
  const wa = (18 + Math.sqrt(30)) / 36;
  const wc = (18 - Math.sqrt(30)) / 36;
  const gauss: readonly [number, number][] = [
    [-c, wc],
    [-a, wa],
    [a, wa],
    [c, wc],
  ];
  let area = 0;
  for (const s of contour) {
    if (s.kind === 'line') {
      area += ((s.p0.x - o.x) * (s.p1.y - o.y) - (s.p1.x - o.x) * (s.p0.y - o.y)) / 2;
      continue;
    }
    for (const [x, w] of gauss) {
      const t = (x + 1) / 2;
      const u = 1 - t;
      const p = pointOn(s, t);
      const dx =
        3 * (u * u * (s.c1.x - s.p0.x) + 2 * u * t * (s.c2.x - s.c1.x) + t * t * (s.p1.x - s.c2.x));
      const dy =
        3 * (u * u * (s.c1.y - s.p0.y) + 2 * u * t * (s.c2.y - s.c1.y) + t * t * (s.p1.y - s.c2.y));
      area += ((w / 2) * ((p.x - o.x) * dy - (p.y - o.y) * dx)) / 2;
    }
  }
  return area;
}

/** An input's segments with every open contour closed by a line (section 2.4 step 1). */
function closedSegments(shape: BShape): BSegment[] {
  return shape.contours.flatMap((c) => {
    const first = c[0];
    const last = c[c.length - 1];
    if (first === undefined || last === undefined) return [];
    return last.p1.x === first.p0.x && last.p1.y === first.p0.y
      ? [...c]
      : [...c, line(last.p1, first.p0)];
  });
}

type Check = { mismatches: number; failure: string | null; contours: number; area: number };

/** E41-A02 checks for one case; `grid` samples per side. */
function check(op: BooleanOp, shapes: readonly BShape[], grid = 256, onInput = true): Check {
  const result = booleanOp(op, shapes);
  const b = boundsOf(shapes);
  const eta = BOOLEAN_ETA * b.diag;
  const eps = BOOLEAN_EPSILON * b.diag;
  const inputs = shapes.map(closedSegments);
  const allInput = inputs.flat();
  const resultSegs = result.ok ? result.contours.flat() : [];
  // Closed contours that enclose area (no zero-area back-and-forth contours).
  let area = 0;
  if (result.ok) {
    for (const contour of result.contours) {
      for (let i = 0; i < contour.length; i++) {
        const s = contour[i] as BSegment;
        const n = contour[(i + 1) % contour.length] as BSegment;
        if (s.p1.x !== n.p0.x || s.p1.y !== n.p0.y)
          return { mismatches: 0, failure: 'open contour', contours: 0, area: 0 };
      }
      const a = areaOf(contour);
      let perimeter = 0;
      for (const s of contour)
        perimeter += Math.sqrt((s.p1.x - s.p0.x) ** 2 + (s.p1.y - s.p0.y) ** 2);
      if (Math.abs(a) <= eps * perimeter) {
        return {
          mismatches: 0,
          failure: `sliver area ${a} perimeter ${perimeter}`,
          contours: 0,
          area: 0,
        };
      }
      area += a;
    }
    // Every result piece lies on an input segment within η.
    for (const s of onInput ? resultSegs : []) {
      for (const t of [0.25, 0.5, 0.75]) {
        const p = pointOn(s, t);
        const d = Math.min(...allInput.map((q) => distanceTo(q, p)));
        if (d > eta)
          return {
            mismatches: 0,
            failure: `piece off input by ${d} at ${JSON.stringify(p)} piece ${JSON.stringify(s)}`,
            contours: 0,
            area: 0,
          };
      }
    }
  }
  // Grid membership under both fill rules of the result (they must agree).
  let mismatches = 0;
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const xs: number[] = [];
  for (let i = 0; i < grid; i++) xs.push(b.minX + ((i + 0.5 + 0.0137 * Math.sin(i)) / grid) * w);
  for (let j = 0; j < grid; j++) {
    const y = b.minY + ((j + 0.5 + 0.0071 * Math.cos(j)) / grid) * h;
    const memberships = inputs.map((segs, s) =>
      rowWindings(rowCrossings(segs, y), xs).map((wd) =>
        inside(wd, (shapes[s] as BShape).fillRule),
      ),
    );
    const res = rowWindings(rowCrossings(resultSegs, y), xs);
    for (let i = 0; i < grid; i++) {
      const want = expected(
        op,
        memberships.map((m) => m[i] as boolean),
      );
      const wn = res[i] as number;
      const gotNonzero = wn !== 0;
      const gotEvenodd = (wn & 1) !== 0;
      if (gotNonzero === want && gotEvenodd === want) continue;
      const p = { x: xs[i] as number, y };
      const near = Math.min(...allInput.map((q) => distanceTo(q, p)));
      if (near > 4 * eta) mismatches++;
    }
  }
  return { mismatches, failure: null, contours: result.ok ? result.contours.length : 0, area };
}

function expectCase(op: BooleanOp, shapes: readonly BShape[]) {
  const result = booleanOp(op, shapes);
  if (!result.ok && result.code === 'empty') {
    const c = check(op, shapes, 64);
    expect(c.mismatches).toBe(0);
    return result;
  }
  expect(result.ok, result.ok ? '' : `${result.code}: ${result.detail}`).toBe(true);
  const c = check(op, shapes);
  expect(c.failure).toBeNull();
  expect(c.mismatches).toBe(0);
  return result;
}

// ---------- fixtures ----------

describe('E41-A02 fixtures B1 to B15', () => {
  it('B1 two overlapping circles, every operation', () => {
    const shapes = [ellipse(40, 50, 30, 30), ellipse(70, 50, 30, 30)];
    for (const op of OPS) expectCase(op, shapes);
    const u = booleanOp('union', shapes);
    expect(u.ok && u.contours.length).toBe(1);
    expect(u.ok && u.contours.flat().every((s) => s.kind === 'cubic')).toBe(true);
    const x = booleanOp('exclude', shapes);
    expect(x.ok && x.contours.length).toBe(2);
  });
  it('B2 rectangle minus circle', () => {
    expectCase('subtract', [rect(0, 0, 100, 60), ellipse(100, 30, 25, 25)]);
  });
  it('B3 star intersect circle', () => {
    const r = expectCase('intersect', [star(50, 50, 45, 20, 5), ellipse(50, 50, 32, 32)]);
    expect(r.ok && r.contours.length).toBe(1);
  });
  it('B4 rectangles sharing an edge: union is one rectangle, no seam', () => {
    const r = expectCase('union', [rect(0, 0, 50, 40), rect(50, 0, 50, 40)]);
    expect(r.ok && r.contours.length).toBe(1);
    expect(r.ok && Math.abs(areaOf(r.contours[0] as BSegment[]))).toBeCloseTo(4000, 6);
  });
  it('B5 squares touching at a corner: two contours meeting at one vertex', () => {
    const r = expectCase('union', [rect(0, 0, 40, 40), rect(40, 40, 40, 40)]);
    expect(r.ok && r.contours.length).toBe(2);
  });
  it('B6 identical inputs', () => {
    const a = ellipse(50, 50, 30, 20);
    const u = expectCase('union', [a, a]);
    expect(u.ok && u.contours.length).toBe(1);
    expectCase('intersect', [a, a]);
    const x = booleanOp('exclude', [a, a]);
    expect(x.ok).toBe(false);
    expect(!x.ok && x.code).toBe('empty');
  });
  it('B7 circle inside a rectangle: subtract makes a hole', () => {
    const r = expectCase('subtract', [rect(0, 0, 100, 100), ellipse(50, 50, 20, 20)]);
    expect(r.ok && r.contours.length).toBe(2);
  });
  it('B8 rotated rectangles', () => {
    const shapes = [
      rotate(rect(10, 10, 60, 40), 0.4, 40, 30),
      rotate(rect(30, 20, 60, 40), -0.7, 60, 40),
    ];
    for (const op of OPS) expectCase(op, shapes);
  });
  it('B9 rounded rectangles', () => {
    const shapes = [roundedRect(0, 0, 80, 60, 15), roundedRect(40, 30, 80, 60, 20)];
    for (const op of OPS) expectCase(op, shapes);
  });
  it('B10 an evenodd self-crossing pen path', () => {
    const p = polygon(
      [
        { x: 0, y: 0 },
        { x: 100, y: 80 },
        { x: 100, y: 0 },
        { x: 0, y: 80 },
      ],
      'evenodd',
    );
    for (const op of OPS) expectCase(op, [p, rect(30, 20, 40, 40)]);
  });
  it('B10b a self-crossing input whose edges cross at 1 degree', () => {
    const s = Math.tan(Math.PI / 180) * 100;
    const p = polygon(
      [
        { x: 0, y: 0 },
        { x: 100, y: s },
        { x: 100, y: 30 },
        { x: 0, y: s },
        { x: 0, y: 30 },
        { x: 100, y: 0 },
      ],
      'evenodd',
    );
    for (const op of OPS) expectCase(op, [p, rect(20, -5, 40, 20)]);
  });
  it('B11 three inputs in order: subtract uses the bottom input', () => {
    const shapes = [rect(0, 0, 100, 100), ellipse(20, 20, 15, 15), ellipse(80, 80, 15, 15)];
    for (const op of OPS) expectCase(op, shapes);
  });
  it('B12 two unit circles tangent outside', () => {
    const shapes = [ellipse(0, 0, 1, 1), ellipse(2, 0, 1, 1)];
    const u = expectCase('union', shapes);
    expect(u.ok && u.contours.length).toBe(2);
    const i = booleanOp('intersect', shapes);
    expect(!i.ok && i.code).toBe('empty');
    const s = expectCase('subtract', shapes);
    expect(s.ok && Math.abs(areaOf(s.contours.flat()))).toBeCloseTo(
      Math.abs(areaOf(shapes[0]!.contours[0]!)),
      9,
    );
  });
  it('B13 circles tangent inside', () => {
    const shapes = [ellipse(0, 0, 2, 2), ellipse(1, 0, 1, 1)];
    for (const op of OPS) expectCase(op, shapes);
  });
  it('B14 a shared edge 0.5 η apart snaps: union is one rectangle', () => {
    const gap = 0.5 * BOOLEAN_ETA * Math.sqrt(100 * 100 + 40 * 40);
    const r = expectCase('union', [rect(0, 0, 50, 40), rect(50 + gap, 0, 50 - gap, 40)]);
    expect(r.ok && r.contours.length).toBe(1);
  });
  it('B15 rectangles crossing at 1 degree', () => {
    const shapes = [rect(0, 0, 100, 20), rotate(rect(0, 0, 100, 20), Math.PI / 180, 0, 20)];
    for (const op of OPS) expectCase(op, shapes);
  });
});

describe('E41-A02 regressions', () => {
  it('B12 rotated: tangent circles union to two contours at any angle', () => {
    for (const angle of [0.123, 0.7, 1.3]) {
      const shapes = [ellipse(0, 0, 1, 1), ellipse(2, 0, 1, 1)].map((sh) =>
        rotate(sh, angle, 1, 0),
      );
      const u = expectCase('union', shapes);
      expect(u.ok && u.contours.length, `angle ${angle}`).toBe(2);
    }
  });
  it('an open subpath is closed implicitly', () => {
    const open: BShape = {
      contours: [
        [
          line({ x: 0, y: 0 }, { x: 60, y: 0 }),
          cubic({ x: 60, y: 0 }, { x: 90, y: 20 }, { x: 90, y: 50 }, { x: 60, y: 70 }),
          line({ x: 60, y: 70 }, { x: 0, y: 70 }),
        ],
      ],
      fillRule: 'nonzero',
    };
    for (const op of OPS) expectCase(op, [open, rect(-20, 20, 50, 30)]);
  });
  it('small rotated rectangles across a long, slightly curved cubic', () => {
    const band: BShape = {
      contours: [
        [
          cubic({ x: 0, y: 0 }, { x: 333, y: 3 }, { x: 667, y: 3 }, { x: 1000, y: 0 }),
          line({ x: 1000, y: 0 }, { x: 1000, y: 40 }),
          line({ x: 1000, y: 40 }, { x: 0, y: 40 }),
          line({ x: 0, y: 40 }, { x: 0, y: 0 }),
        ],
      ],
      fillRule: 'nonzero',
    };
    for (const x of [37, 251, 498.5, 733, 960]) {
      for (const angle of [0.3, 1.1, 2.2]) {
        const small = rotate(rect(x - 3, -0.5, 6, 1), angle, x, 1.5);
        for (const op of OPS) expectCase(op, [band, small]);
      }
    }
  });
  it('a 6 x 1 rectangle on a circle of radius 1000', () => {
    const circle = ellipse(0, 0, 1000, 1000);
    for (const angle of [0.2, 0.9, 2.5, 4.0]) {
      const p = { x: 1000 * Math.cos(angle), y: 1000 * Math.sin(angle) };
      const small = rotate(rect(p.x - 3, p.y - 0.5, 6, 1), angle + 0.4, p.x, p.y);
      for (const op of OPS) expectCase(op, [circle, small]);
    }
  });
  it('an ellipse and a copy shifted k η diagonally', () => {
    const a = ellipse(50, 40, 40, 25);
    const d = Math.sqrt(90 * 90 + 65 * 65);
    for (const k of [0.5, 2, 3, 7, 20, 100, 1000]) {
      const off = k * BOOLEAN_ETA * d;
      const b = mapShape(a, (p) => ({ x: p.x + 0.6 * off, y: p.y + 0.8 * off }));
      for (const op of OPS) expectCase(op, [a, b]);
    }
  });
});

/** Seed 11, case 621: an evenodd self-crossing blob minus its copy 2.4 η away (fail closed). */
const CASE_11_621: readonly (readonly number[])[][] = [
  [
    [
      67.48105312860085, 88.70948860897745, 77.79526506247969, 100.80928540249538,
      14.124785652495767, 84.23220065905234, 30.467187542319834, 88.04838207415465,
    ],
    [
      30.467187542319834, 88.04838207415465, 26.60212968444231, 109.03375030242626,
      28.63390172041193, 36.82960707003011, 41.789718927678926, 51.661680683355875,
    ],
    [
      41.789718927678926, 51.661680683355875, 53.5573302139526, 65.7338082629576, 72.96192313149407,
      35.9713907986455, 72.49127536820508, 38.55264494308072,
    ],
    [
      72.49127536820508, 38.55264494308072, 78.80602945714125, 43.47054407462619,
      118.80388061440897, 76.37750091288899, 102.43745482102105, 69.3253764101067,
    ],
    [
      102.43745482102105, 69.3253764101067, 82.72577994473679, 54.71314109471283, 52.114398017718,
      105.71182245383385, 67.48105312860085, 88.70948860897745,
    ],
  ],
  [
    [
      67.48106886901996, 88.70950488216593, 77.7952808028988, 100.80930167568386, 14.12480139291488,
      84.23221693224082, 30.467203282738947, 88.04839834734312,
    ],
    [
      30.467203282738947, 88.04839834734312, 26.602145424861423, 109.03376657561473,
      28.633917460831043, 36.829623343218586, 41.78973466809804, 51.661696956544354,
    ],
    [
      41.78973466809804, 51.661696956544354, 53.55734595437172, 65.73382453614607,
      72.96193887191319, 35.97140707183398, 72.4912911086242, 38.5526612162692,
    ],
    [
      72.4912911086242, 38.5526612162692, 78.80604519756037, 43.47056034781467, 118.80389635482808,
      76.37751718607747, 102.43747056144016, 69.32539268329518,
    ],
    [
      102.43747056144016, 69.32539268329518, 82.7257956851559, 54.71315736790131, 52.11441375813712,
      105.71183872702233, 67.48106886901996, 88.70950488216593,
    ],
  ],
];

describe('E41-A02 recorded failures', () => {
  it('seed 11 case 621 fails closed or is correct, never wrong', () => {
    const shapes: BShape[] = CASE_11_621.map((contour) => ({
      fillRule: 'evenodd',
      contours: [
        contour.map((n) =>
          cubic(
            { x: n[0] as number, y: n[1] as number },
            { x: n[2] as number, y: n[3] as number },
            { x: n[4] as number, y: n[5] as number },
            { x: n[6] as number, y: n[7] as number },
          ),
        ),
      ],
    }));
    const result = booleanOp('subtract', shapes);
    if (!result.ok) expect(result.code).toBe('failed');
    else expectCase('subtract', shapes);
  });
});

// ---------- random corpus ----------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomShape(rand: () => number): BShape {
  const kind = Math.floor(rand() * 6);
  const cx = 20 + rand() * 60;
  const cy = 20 + rand() * 60;
  let shape: BShape;
  switch (kind) {
    case 0: {
      const n = 3 + Math.floor(rand() * 6);
      const pts: BPoint[] = [];
      for (let i = 0; i < n; i++) pts.push({ x: rand() * 100, y: rand() * 100 });
      shape = polygon(pts, rand() < 0.5 ? 'evenodd' : 'nonzero');
      break;
    }
    case 1: {
      const n = 3 + Math.floor(rand() * 4);
      const pts: BPoint[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        const r = 15 + rand() * 30;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      const segs: BSegment[] = [];
      for (let i = 0; i < n; i++) {
        const p = pts[i] as BPoint;
        const q = pts[(i + 1) % n] as BPoint;
        segs.push(
          cubic(
            p,
            { x: p.x + (rand() - 0.5) * 40, y: p.y + (rand() - 0.5) * 40 },
            { x: q.x + (rand() - 0.5) * 40, y: q.y + (rand() - 0.5) * 40 },
            q,
          ),
        );
      }
      shape = { contours: [segs], fillRule: rand() < 0.5 ? 'evenodd' : 'nonzero' };
      break;
    }
    case 2:
      shape = roundedRect(cx - 30, cy - 20, 20 + rand() * 50, 20 + rand() * 40, rand() * 10);
      break;
    case 3:
      shape = ellipse(cx, cy, 10 + rand() * 30, 10 + rand() * 30);
      break;
    case 4:
      shape = star(cx, cy, 20 + rand() * 25, 8 + rand() * 10, 4 + Math.floor(rand() * 4));
      break;
    default:
      shape = rect(
        Math.round(rand() * 6) * 10,
        Math.round(rand() * 6) * 10,
        10 + Math.round(rand() * 4) * 10,
        10 + Math.round(rand() * 4) * 10,
      );
  }
  return rand() < 0.3 ? rotate(shape, rand() * Math.PI, cx, cy) : shape;
}

describe('E41-A02 random corpus', () => {
  it('1,000 seeded cases: no grid mismatch, at most 5 boolean-failed', () => {
    const rand = mulberry32(Number(process.env['E41_SEED'] ?? 0xe41));
    const failed: string[] = [];
    const wrong: string[] = [];
    for (let k = 0; k < Number(process.env['E41_CASES'] ?? 1000); k++) {
      const n = 2 + (rand() < 0.25 ? 1 : 0);
      const shapes: BShape[] = [];
      for (let i = 0; i < n; i++) {
        const shape = randomShape(rand);
        // Mixed scales: some inputs shrink to 2 % to 20 % about the middle of the frame.
        if (rand() < 0.15) {
          const f = 0.02 + rand() * 0.18;
          const cx = rand() * 100;
          const cy = rand() * 100;
          shapes.push(mapShape(shape, (p) => ({ x: cx + (p.x - 50) * f, y: cy + (p.y - 50) * f })));
        } else {
          shapes.push(shape);
        }
      }
      // Near-coincident copies within 10 η, in a random direction: below η, 1 to 4 η, 4 to 10 η.
      if (rand() < 0.15) {
        shapes[1] = shapes[0] as BShape;
        const diag = boundsOf(shapes).diag;
        const band = Math.floor(rand() * 3);
        const k = band === 0 ? 0.05 + rand() * 0.9 : band === 1 ? 1 + rand() * 3 : 4 + rand() * 6;
        const angle = rand() * 2 * Math.PI;
        const d = k * BOOLEAN_ETA * diag;
        shapes[1] = mapShape(shapes[0] as BShape, (p) => ({
          x: p.x + d * Math.cos(angle),
          y: p.y + d * Math.sin(angle),
        }));
      }
      const op = OPS[Math.floor(rand() * 4)] as BooleanOp;
      if (process.env['E41_DUMP']?.split(',').includes(String(k))) {
        process.stderr.write(`CASE ${k} ${JSON.stringify({ op, shapes })}\n`);
      }
      const result = booleanOp(op, shapes);
      if (!result.ok && result.code === 'failed') {
        failed.push(`#${k} ${op}: ${result.detail}`);
        continue;
      }
      const c = check(op, shapes, Number(process.env['E41_GRID'] ?? 256));
      if (c.failure !== null || c.mismatches > 0)
        wrong.push(`#${k} ${op}: ${c.failure ?? c.mismatches}`);
    }
    process.stderr.write(
      `E41-A02 random corpus: ${failed.length} boolean-failed\n${failed.join('\n')}\n`,
    );
    expect(wrong).toEqual([]);
    expect(failed.length, failed.join('\n')).toBeLessThanOrEqual(5);
  }, 600_000);
});

// ---------- E41-A04 cost ----------

/** A closed wavy ring of `n` cubic segments, Hermite-fitted to r(θ) = r0 + amp·sin(k θ + φ). */
function wavyRing(n: number, r0: number, amp: number, k: number, phase: number): BShape {
  const at = (theta: number) => {
    const r = r0 + amp * Math.sin(k * theta + phase);
    const dr = amp * k * Math.cos(k * theta + phase);
    return {
      p: { x: r * Math.cos(theta), y: r * Math.sin(theta) },
      d: {
        x: dr * Math.cos(theta) - r * Math.sin(theta),
        y: dr * Math.sin(theta) + r * Math.cos(theta),
      },
    };
  };
  const h = (2 * Math.PI) / n;
  const segs: BSegment[] = [];
  let prev = at(0);
  const first = prev.p;
  for (let i = 1; i <= n; i++) {
    const next = at(i * h);
    const p1 = i === n ? first : next.p;
    segs.push(
      cubic(
        prev.p,
        { x: prev.p.x + (prev.d.x * h) / 3, y: prev.p.y + (prev.d.y * h) / 3 },
        { x: p1.x - (next.d.x * h) / 3, y: p1.y - (next.d.y * h) / 3 },
        p1,
      ),
    );
    prev = next;
  }
  return { contours: [segs], fillRule: 'nonzero' };
}

describe('E41-A04 boolean cost', () => {
  it('two inputs of 512 cubic segments, 1,024 crossings, median of 5 within 100 ms', () => {
    const a = wavyRing(512, 100, 0.5, 256, 0);
    const b = wavyRing(512, 100, 1, 512, 0.3);
    const times: number[] = [];
    let contours = 0;
    booleanOp('union', [a, b]); // warm-up (JIT), not timed
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      const r = booleanOp('union', [a, b]);
      times.push(performance.now() - start);
      expect(r.ok).toBe(true);
      if (r.ok) contours = r.contours.length;
    }
    // The timed result is correct: grid membership against the oracle (the on-input check is
    // left out here for time; the fixtures and the corpus cover it).
    const c = check('union', [a, b], 128, false);
    // 1,024 crossings: the union's boundary switches between the inputs at each one.
    {
      const res = booleanOp('union', [a, b]);
      if (res.ok) {
        const owner = (seg: BSegment) => {
          const p = pointOn(seg, 0.5);
          const th = Math.atan2(p.y, p.x);
          const r = Math.hypot(p.x, p.y);
          const ra = 100 + 0.5 * Math.sin(256 * th);
          const rb = 100 + Math.sin(512 * th + 0.3);
          return Math.abs(r - ra) < Math.abs(r - rb) ? 0 : 1;
        };
        const segs = res.contours[0] as BSegment[];
        let switches = 0;
        for (let i = 0; i < segs.length; i++)
          if (owner(segs[i] as BSegment) !== owner(segs[(i + 1) % segs.length] as BSegment))
            switches++;
        expect(switches).toBe(1024);
      }
    }
    expect(c.failure).toBeNull();
    expect(c.mismatches).toBe(0);
    times.sort((x, y) => x - y);
    const median = times[2] as number;
    process.stderr.write(
      `E41-A04 median ${median.toFixed(1)} ms, runs ${times.map((t) => t.toFixed(1)).join(' ')}, contours ${contours}\n`,
    );
    // The 100 ms gate is judged on the recorded container measurement (E41_A04_GATE=1, see
    // docs/evidence/e41/u2-boolean-engine.md); shared CI runners only get a 1 s smoke ceiling.
    expect(median).toBeLessThanOrEqual(process.env['E41_A04_GATE'] === '1' ? 100 : 1000);
  });
});
