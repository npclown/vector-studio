// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), section 2.4: segment math for the
// boolean engine. Plain numbers only; a segment is a line or a cubic in one shared space.

export type BPoint = Readonly<{ x: number; y: number }>;
export type BLine = Readonly<{ kind: 'line'; p0: BPoint; p1: BPoint }>;
export type BCubic = Readonly<{ kind: 'cubic'; p0: BPoint; c1: BPoint; c2: BPoint; p1: BPoint }>;
export type BSegment = BLine | BCubic;
export type BBox = Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;

export function pointAt(s: BSegment, t: number): BPoint {
  if (s.kind === 'line') {
    return { x: s.p0.x + (s.p1.x - s.p0.x) * t, y: s.p0.y + (s.p1.y - s.p0.y) * t };
  }
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * s.p0.x + b * s.c1.x + c * s.c2.x + d * s.p1.x,
    y: a * s.p0.y + b * s.c1.y + c * s.c2.y + d * s.p1.y,
  };
}

export function derivativeAt(s: BSegment, t: number): BPoint {
  if (s.kind === 'line') return { x: s.p1.x - s.p0.x, y: s.p1.y - s.p0.y };
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const c = 3 * t * t;
  return {
    x: a * (s.c1.x - s.p0.x) + b * (s.c2.x - s.c1.x) + c * (s.p1.x - s.c2.x),
    y: a * (s.c1.y - s.p0.y) + b * (s.c2.y - s.c1.y) + c * (s.p1.y - s.c2.y),
  };
}

function lerp(a: BPoint, b: BPoint, t: number): BPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** The piece of `s` over `[t0, t1]` (de Casteljau). */
export function subSegment(s: BSegment, t0: number, t1: number): BSegment {
  if (s.kind === 'line') return { kind: 'line', p0: pointAt(s, t0), p1: pointAt(s, t1) };
  let c: BCubic = s;
  if (t1 < 1) c = splitCubic(c, t1)[0];
  if (t0 > 0) c = splitCubic(c, t0 / t1)[1];
  return c;
}

export function splitCubic(s: BCubic, t: number): [BCubic, BCubic] {
  const ab = lerp(s.p0, s.c1, t);
  const bc = lerp(s.c1, s.c2, t);
  const cd = lerp(s.c2, s.p1, t);
  const abc = lerp(ab, bc, t);
  const bcd = lerp(bc, cd, t);
  const m = lerp(abc, bcd, t);
  return [
    { kind: 'cubic', p0: s.p0, c1: ab, c2: abc, p1: m },
    { kind: 'cubic', p0: m, c1: bcd, c2: cd, p1: s.p1 },
  ];
}

export function controlBox(s: BSegment): BBox {
  const pts = s.kind === 'line' ? [s.p0, s.p1] : [s.p0, s.c1, s.c2, s.p1];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function boxesOverlap(a: BBox, b: BBox, pad: number): boolean {
  return (
    a.minX <= b.maxX + pad &&
    b.minX <= a.maxX + pad &&
    a.minY <= b.maxY + pad &&
    b.minY <= a.maxY + pad
  );
}

export function boxSize(b: BBox): number {
  return Math.max(b.maxX - b.minX, b.maxY - b.minY);
}

export function distance(a: BPoint, b: BPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** The parameter and distance of the point of `s` closest to `p`. */
export function closestParam(s: BSegment, p: BPoint): { t: number; d: number } {
  if (s.kind === 'line') {
    const dx = s.p1.x - s.p0.x;
    const dy = s.p1.y - s.p0.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : clamp01(((p.x - s.p0.x) * dx + (p.y - s.p0.y) * dy) / len2);
    return { t, d: distance(pointAt(s, t), p) };
  }
  let best = 0;
  let bestD = Infinity;
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const d = distance(pointAt(s, t), p);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  let t = best;
  for (let i = 0; i < 12; i++) {
    const q = pointAt(s, t);
    const d1 = derivativeAt(s, t);
    const d2 = secondDerivativeAt(s, t);
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const f = ex * d1.x + ey * d1.y;
    const fp = d1.x * d1.x + d1.y * d1.y + ex * d2.x + ey * d2.y;
    if (fp === 0) break;
    const next = clamp01(t - f / fp);
    if (Math.abs(next - t) < 1e-15) {
      t = next;
      break;
    }
    t = next;
  }
  const d = distance(pointAt(s, t), p);
  return d <= bestD ? { t, d } : { t: best, d: bestD };
}

function secondDerivativeAt(s: BCubic, t: number): BPoint {
  const u = 1 - t;
  return {
    x: 6 * u * (s.c2.x - 2 * s.c1.x + s.p0.x) + 6 * t * (s.p1.x - 2 * s.c2.x + s.c1.x),
    y: 6 * u * (s.c2.y - 2 * s.c1.y + s.p0.y) + 6 * t * (s.p1.y - 2 * s.c2.y + s.c1.y),
  };
}

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** A unit tangent at `t`, falling back to the chord (or the control polygon) where it vanishes. */
export function tangentAt(s: BSegment, t: number): BPoint {
  const d = derivativeAt(s, t);
  let len = Math.sqrt(d.x * d.x + d.y * d.y);
  if (len > 1e-300) return { x: d.x / len, y: d.y / len };
  const tries: [BPoint, BPoint][] =
    s.kind === 'line'
      ? [[s.p0, s.p1]]
      : t < 0.5
        ? [
            [s.p0, s.c2],
            [s.p0, s.p1],
          ]
        : [
            [s.c1, s.p1],
            [s.p0, s.p1],
          ];
  for (const [a, b] of tries) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1e-300) return { x: dx / len, y: dy / len };
  }
  return { x: 1, y: 0 };
}

/** Coefficients of a cubic Bézier coordinate as a polynomial `a t³ + b t² + c t + d`. */
function poly(p0: number, p1: number, p2: number, p3: number): [number, number, number, number] {
  return [-p0 + 3 * p1 - 3 * p2 + p3, 3 * p0 - 6 * p1 + 3 * p2, -3 * p0 + 3 * p1, p0];
}

/** Real roots of `a t² + b t + c` in the open interval (0, 1). */
function quadraticRoots01(a: number, b: number, c: number): number[] {
  const out: number[] = [];
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return out;
  if (Math.abs(a) <= 1e-12 * scale) {
    if (Math.abs(b) > 1e-300) {
      const t = -c / b;
      if (t > 0 && t < 1) out.push(t);
    }
    return out;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return out;
  const sq = Math.sqrt(disc);
  const q = -0.5 * (b + (b >= 0 ? sq : -sq));
  const r1 = q / a;
  const r2 = q !== 0 ? c / q : r1;
  for (const r of [r1, r2]) if (r > 0 && r < 1) out.push(r);
  return out.sort((x, y) => x - y);
}

/**
 * Crossings of `s` with the ray from the origin along +x, in a frame given by `toFrame`, with the
 * half-open rule: an increasing run counts when `y0 ≤ 0 < y1` (+1), a decreasing one when
 * `y1 ≤ 0 < y0` (−1). Returns the signed sum.
 */
export function rayCrossings(s: BSegment, toFrame: (p: BPoint) => BPoint): number {
  if (s.kind === 'line') {
    const a = toFrame(s.p0);
    const b = toFrame(s.p1);
    return lineCrossing(a, b);
  }
  const p0 = toFrame(s.p0);
  const c1 = toFrame(s.c1);
  const c2 = toFrame(s.c2);
  const p1 = toFrame(s.p1);
  if (Math.max(p0.x, c1.x, c2.x, p1.x) <= 0) return 0;
  const minX = Math.min(p0.x, c1.x, c2.x, p1.x);
  const minY = Math.min(p0.y, c1.y, c2.y, p1.y);
  const maxY = Math.max(p0.y, c1.y, c2.y, p1.y);
  if (minY > 0 || maxY <= 0) return 0;
  const [ay, by, cy, dy] = poly(p0.y, c1.y, c2.y, p1.y);
  const [ax, bx, cx, dx] = poly(p0.x, c1.x, c2.x, p1.x);
  const yAt = (t: number) => ((ay * t + by) * t + cy) * t + dy;
  const xAt = (t: number) => ((ax * t + bx) * t + cx) * t + dx;
  const breaks = [0, ...quadraticRoots01(3 * ay, 2 * by, cy), 1];
  let sum = 0;
  for (let i = 0; i + 1 < breaks.length; i++) {
    const t0 = breaks[i] as number;
    const t1 = breaks[i + 1] as number;
    const y0 = i === 0 ? p0.y : yAt(t0);
    const y1 = i + 2 === breaks.length ? p1.y : yAt(t1);
    let sign = 0;
    if (y0 <= 0 && y1 > 0) sign = 1;
    else if (y1 <= 0 && y0 > 0) sign = -1;
    if (sign === 0) continue;
    if (minX > 0) {
      sum += sign;
      continue;
    }
    // Bisection on the monotone run for y = 0.
    let lo = t0;
    let hi = t1;
    for (let k = 0; k < 60; k++) {
      const mid = 0.5 * (lo + hi);
      const ym = yAt(mid);
      if (ym > 0 === sign > 0) hi = mid;
      else lo = mid;
    }
    if (xAt(0.5 * (lo + hi)) > 0) sum += sign;
  }
  return sum;
}

function lineCrossing(a: BPoint, b: BPoint): number {
  let sign = 0;
  if (a.y <= 0 && b.y > 0) sign = 1;
  else if (b.y <= 0 && a.y > 0) sign = -1;
  if (sign === 0) return 0;
  const t = a.y / (a.y - b.y);
  const x = a.x + (b.x - a.x) * t;
  return x > 0 ? sign : 0;
}

/** Signed area of a closed chain (Green's theorem; 3-point Gauss is exact for the cubic terms). */
export function signedArea(contour: readonly BSegment[]): number {
  const nodes = [0.5 - Math.sqrt(0.15), 0.5, 0.5 + Math.sqrt(0.15)];
  const weights = [5 / 18, 8 / 18, 5 / 18];
  let area = 0;
  for (const s of contour) {
    if (s.kind === 'line') {
      area += (s.p0.x * s.p1.y - s.p1.x * s.p0.y) / 2;
      continue;
    }
    for (let i = 0; i < 3; i++) {
      const t = nodes[i] as number;
      const p = pointAt(s, t);
      const d = derivativeAt(s, t);
      area += ((weights[i] as number) * (p.x * d.y - p.y * d.x)) / 2;
    }
  }
  return area;
}

/**
 * `s` split at the extrema of x and y, so that every piece is monotone in both coordinates and
 * cannot cross itself; a self-crossing cubic then shows up as a crossing between its pieces.
 */
export function monotonePieces(s: BSegment): BSegment[] {
  if (s.kind === 'line') return [s];
  const ts: number[] = [];
  for (const [a, b, c, d] of [
    [s.p0.x, s.c1.x, s.c2.x, s.p1.x],
    [s.p0.y, s.c1.y, s.c2.y, s.p1.y],
  ] as const) {
    const [pa, pb, pc] = poly(a, b, c, d);
    ts.push(...quadraticRoots01(3 * pa, 2 * pb, pc));
  }
  const cuts = [...new Set(ts)].filter((t) => t > 1e-9 && t < 1 - 1e-9).sort((x, y) => x - y);
  if (cuts.length === 0) return [s];
  const out: BSegment[] = [];
  let prev = 0;
  for (const t of [...cuts, 1]) {
    out.push(subSegment(s, prev, t));
    prev = t;
  }
  return out;
}
