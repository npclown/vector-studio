// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), section 2.4: the boolean engine.
// Deterministic and synchronous; curves stay curves (every result piece is a piece of an input
// segment). Steps: segments, intersections with shared vertices, split, classify, chain.

import {
  type BBox,
  type BPoint,
  type BSegment,
  boxSize,
  boxesOverlap,
  splitCubic,
  closestParam,
  controlBox,
  derivativeAt,
  distance,
  monotonePieces,
  pointAt,
  rayCrossings,
  subSegment,
  tangentAt,
} from './segment.js';

export type BooleanOp = 'union' | 'subtract' | 'intersect' | 'exclude';
export type BFillRule = 'nonzero' | 'evenodd';
/** One input: closed contours (open ones are closed implicitly) under a fill rule. */
export type BShape = Readonly<{ contours: readonly (readonly BSegment[])[]; fillRule: BFillRule }>;
export type BooleanFailure = 'empty' | 'too-large' | 'failed';
export type BooleanResult =
  | Readonly<{ ok: true; contours: BSegment[][] }>
  | Readonly<{ ok: false; code: BooleanFailure; detail: string }>;

/** E41-B5. */
export const BOOLEAN_MAX_SEGMENTS = 4096;
export const BOOLEAN_MAX_INTERSECTIONS = 16_384;
/** Section 2.4 scales, relative to the diagonal `D` of the inputs' bounds. */
export const BOOLEAN_EPSILON = 1e-9;
export const BOOLEAN_ETA = 1e-7;

type Cut = { t: number; v: number };
type Seg = { seg: BSegment; shape: number; box: BBox; cuts: Cut[] };
type Piece = {
  seg: BSegment;
  shape: number;
  v0: number;
  v1: number;
  group: number;
};
type Directed = { seg: BSegment; from: number; to: number; used: boolean };

export function booleanOp(op: BooleanOp, shapes: readonly BShape[]): BooleanResult {
  try {
    return run(op, shapes);
  } catch (error) {
    return { ok: false, code: 'failed', detail: String(error) };
  }
}

function run(op: BooleanOp, shapes: readonly BShape[]): BooleanResult {
  // Bounds and scales.
  let box: BBox | null = null;
  let count = 0;
  for (const shape of shapes) {
    for (const contour of shape.contours) {
      for (const s of contour) {
        count++;
        const b = controlBox(s);
        if (![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) {
          return { ok: false, code: 'failed', detail: 'non-finite coordinate' };
        }
        box = box === null ? b : union(box, b);
      }
    }
  }
  if (count > BOOLEAN_MAX_SEGMENTS) {
    return { ok: false, code: 'too-large', detail: `${count} segments` };
  }
  if (box === null) return { ok: false, code: 'empty', detail: 'no segments' };
  const diag = Math.sqrt((box.maxX - box.minX) ** 2 + (box.maxY - box.minY) ** 2);
  if (!(diag > 0) || !Number.isFinite(diag)) {
    return { ok: false, code: 'empty', detail: 'degenerate bounds' };
  }
  const eps = BOOLEAN_EPSILON * diag;
  const eta = BOOLEAN_ETA * diag;
  const vertices = new VertexPool(eta, box.minX, box.minY);

  // 1. Segments, closed contours, endpoint vertices.
  const segs: Seg[] = [];
  shapes.forEach((shape, shapeIndex) => {
    for (const contour of shape.contours) {
      const closed = closeContour(contour).flatMap(monotonePieces);
      for (const s of closed) {
        const b = controlBox(s);
        if (boxSize(b) <= eta && distance(s.p0, s.p1) <= eta) continue;
        segs.push({
          seg: s,
          shape: shapeIndex,
          box: b,
          cuts: [
            { t: 0, v: vertices.add(s.p0) },
            { t: 1, v: vertices.add(s.p1) },
          ],
        });
      }
    }
  });
  if (segs.length === 0) return { ok: false, code: 'empty', detail: 'no segments' };

  // 2. Intersections, one shared vertex per crossing (tangent clusters merged into runs).
  let crossings = 0;
  // Sweep over x: pairs in order of the first segment's index in `order`.
  const order = segs
    .map((_, index) => index)
    .sort((x, y) => (segs[x] as Seg).box.minX - (segs[y] as Seg).box.minX || x - y);
  for (let oi = 0; oi < order.length; oi++) {
    const a = segs[order[oi] as number] as Seg;
    for (let oj = oi + 1; oj < order.length; oj++) {
      const b = segs[order[oj] as number] as Seg;
      if (b.box.minX > a.box.maxX + eta) break;
      if (!boxesOverlap(a.box, b.box, eta)) continue;
      const hits = intersect(a.seg, b.seg, eps, eta);
      if (hits === null) {
        return { ok: false, code: 'failed', detail: 'intersection budget exhausted' };
      }
      for (const hit of hits) {
        const p = pointAt(a.seg, hit.t);
        const q = pointAt(b.seg, hit.u);
        const v = vertices.add({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
        a.cuts.push({ t: hit.t, v });
        b.cuts.push({ t: hit.u, v });
        crossings++;
        if (crossings > BOOLEAN_MAX_INTERSECTIONS) {
          return { ok: false, code: 'too-large', detail: `${crossings} intersections` };
        }
      }
    }
  }

  // Overlap and T-junction rule: every vertex within η of a segment cuts it.
  const grid = new SegmentGrid(box, segs, eta);
  for (let v = 0; v < vertices.count; v++) {
    const p = vertices.at(v);
    for (const index of grid.near(p)) {
      const s = segs[index] as Seg;
      if (s.cuts.some((c) => c.v === v)) continue;
      if (p.x < s.box.minX - eta || p.x > s.box.maxX + eta) continue;
      if (p.y < s.box.minY - eta || p.y > s.box.maxY + eta) continue;
      const hit = closestParam(s.seg, p);
      if (hit.d < eta) s.cuts.push({ t: hit.t, v });
    }
  }

  // 3. Split into pieces with snapped end points.
  const pieces: Piece[] = [];
  for (const s of segs) {
    // The end point cuts stay first and last, so that the pieces of consecutive segments meet
    // at the same vertex even where an interior cut lands at t = 0 or 1 with another vertex.
    const [first, last, ...inner] = s.cuts as [Cut, Cut, ...Cut[]];
    const cuts = [first, ...inner.sort((x, y) => x.t - y.t || x.v - y.v), last];
    let prev = cuts[0] as Cut;
    for (let k = 1; k < cuts.length; k++) {
      const next = cuts[k] as Cut;
      if (next.v === prev.v) {
        // A loop back to the same vertex over a real stretch is still a piece.
        if (next.t - prev.t > 0 && arcLength(s.seg, prev.t, next.t) > 4 * eta) {
          // Keep as a closed piece only if it is not degenerate: split it in two.
          const mid = (prev.t + next.t) / 2;
          const vm = vertices.add(pointAt(s.seg, mid));
          if (vm !== prev.v) {
            pieces.push(makePiece(s, prev.t, mid, prev.v, vm, vertices));
            pieces.push(makePiece(s, mid, next.t, vm, next.v, vertices));
          }
        }
        prev = next;
        continue;
      }
      pieces.push(makePiece(s, prev.t, next.t, prev.v, next.v, vertices));
      prev = next;
    }
  }

  // Coincident groups: same end vertices and the same course within 4η.
  const byEnds = new Map<string, number[]>();
  let groups = 0;
  const groupMembers: number[][] = [];
  pieces.forEach((piece, index) => {
    const key = piece.v0 < piece.v1 ? `${piece.v0},${piece.v1}` : `${piece.v1},${piece.v0}`;
    const list = byEnds.get(key);
    if (list !== undefined) {
      const mid = pointAt(piece.seg, 0.5);
      for (const other of list) {
        const rep = pieces[other] as Piece;
        if (closestParam(rep.seg, mid).d < 4 * eta) {
          piece.group = rep.group;
          (groupMembers[rep.group] as number[]).push(index);
          return;
        }
      }
      list.push(index);
    } else {
      byEnds.set(key, [index]);
    }
    piece.group = groups++;
    groupMembers.push([index]);
  });

  const byShape: number[][] = shapes.map(() => []);
  pieces.forEach((piece, index) => (byShape[piece.shape] as number[]).push(index));

  // 4. Classify each group by an axis ray from its midpoint (+x, or +y where the piece runs
  // closer to horizontal). The group's own copies are excluded: the ray from a side point
  // crosses them on exactly one side, which gives the jump between the two sides.
  const bands = shapes.map((_, s) => new BandIndex(box, pieces, byShape[s] as number[]));
  const pieceBoxes = pieces.map((piece) => controlBox(piece.seg));
  const kept: Directed[] = [];
  for (const members of groupMembers) {
    const rep = pieces[members[0] as number] as Piece;
    const mid = pointAt(rep.seg, 0.5);
    const tan = tangentAt(rep.seg, 0.5);
    const alongX = Math.abs(tan.y) >= Math.abs(tan.x);
    // Frame: x' along the ray, y' = cross(e, v).
    const toFrame = alongX
      ? (p: BPoint): BPoint => ({ x: p.x - mid.x, y: p.y - mid.y })
      : (p: BPoint): BPoint => ({ x: p.y - mid.y, y: mid.x - p.x });
    const tanY = alongX ? tan.y : -tan.x;
    const left: boolean[] = [];
    const right: boolean[] = [];
    shapes.forEach((shape, s) => {
      let w = 0;
      let jump = 0;
      const candidates = alongX
        ? (bands[s] as BandIndex).rowX(mid.y)
        : (bands[s] as BandIndex).columnY(mid.x);
      for (const index of candidates) {
        const piece = pieces[index] as Piece;
        if (piece.group === rep.group) continue;
        const pb = pieceBoxes[index] as BBox;
        if (
          alongX
            ? pb.maxX <= mid.x || pb.minY > mid.y || pb.maxY < mid.y
            : pb.maxY <= mid.y || pb.minX > mid.x || pb.maxX < mid.x
        )
          continue;
        w += rayCrossings(piece.seg, toFrame);
      }
      for (const index of groupMembers[rep.group] as number[]) {
        const piece = pieces[index] as Piece;
        if (piece.shape === s) jump += piece.v0 === rep.v0 ? 1 : -1;
      }
      // tanY > 0: the left side's ray misses the copies; otherwise the right side's does.
      const l = tanY > 0 ? w : w - jump;
      left.push(inside(l, shape.fillRule));
      right.push(inside(l + jump, shape.fillRule));
    });
    const l = apply(op, left);
    const r = apply(op, right);
    if (l === r) continue;
    kept.push(
      l
        ? { seg: rep.seg, from: rep.v0, to: rep.v1, used: false }
        : { seg: reverse(rep.seg), from: rep.v1, to: rep.v0, used: false },
    );
  }
  if (kept.length === 0) return { ok: false, code: 'empty', detail: 'empty region' };

  // 5. Chain at shared vertices; next outgoing piece clockwise (y-down) from the reversed
  // incoming direction.
  const outgoing = new Map<number, Directed[]>();
  for (const d of kept) {
    const list = outgoing.get(d.from);
    if (list === undefined) outgoing.set(d.from, [d]);
    else list.push(d);
  }
  const contours: BSegment[][] = [];
  for (const start of kept) {
    if (start.used) continue;
    start.used = true;
    const contour: BSegment[] = [start.seg];
    let current = start;
    for (let guard = 0; ; guard++) {
      if (guard > kept.length) return { ok: false, code: 'failed', detail: 'chain loop' };
      const at = current.to;
      const candidates = (outgoing.get(at) ?? []).filter((d) => !d.used || d === start);
      if (candidates.length === 0) {
        return { ok: false, code: 'failed', detail: `unpaired piece at vertex ${at}` };
      }
      const best = nextClockwise(current.seg, candidates);
      if (best === start) break;
      best.used = true;
      contour.push(best.seg);
      current = best;
    }
    contours.push(contour);
  }
  return { ok: true, contours };
}

/**
 * The outgoing piece next clockwise (y-down) from the reversed incoming direction. Directions
 * within `TIE` of each other, or of the reversed incoming one, are ordered by the chords to the
 * points at a common small distance `r` instead: the pieces do not cross, so those chords keep
 * their order.
 */
function nextClockwise(incoming: BSegment, candidates: readonly Directed[]): Directed {
  const back = tangentAt(incoming, 1);
  const base = Math.atan2(-back.y, -back.x);
  const turn = (angle: number) => {
    let delta = angle - base;
    while (delta <= 0) delta += 2 * Math.PI;
    while (delta > 2 * Math.PI) delta -= 2 * Math.PI;
    return delta;
  };
  const primary = candidates.map((c) => {
    const t = tangentAt(c.seg, 0);
    return turn(Math.atan2(t.y, t.x));
  });
  const ambiguous = primary.map(
    (d, i) =>
      d < TIE || d > 2 * Math.PI - TIE || primary.some((e, j) => j !== i && Math.abs(e - d) < TIE),
  );
  let index = 0;
  if (ambiguous.some(Boolean)) {
    const reversed = reverse(incoming);
    let r = chordLength(reversed);
    for (const c of candidates) r = Math.min(r, chordLength(c.seg));
    r /= 2;
    const anchor = reversed.p0;
    const direction = (s: BSegment) => {
      const p = pointAtDistance(s, r);
      return Math.atan2(p.y - anchor.y, p.x - anchor.x);
    };
    const chordBase = direction(reversed);
    const secondary = candidates.map((c) => {
      let delta = direction(c.seg) - chordBase;
      while (delta <= 0) delta += 2 * Math.PI;
      while (delta > 2 * Math.PI) delta -= 2 * Math.PI;
      return delta;
    });
    const key = (i: number) => (ambiguous[i] ? (secondary[i] as number) : (primary[i] as number));
    for (let i = 1; i < candidates.length; i++) if (key(i) < key(index)) index = i;
  } else {
    for (let i = 1; i < candidates.length; i++)
      if ((primary[i] as number) < (primary[index] as number)) index = i;
  }
  return candidates[index] as Directed;
}

const TIE = 1e-6;

function chordLength(s: BSegment): number {
  return distance(s.p0, s.p1);
}

/** The point of a monotone piece at distance `r` from its start (distance grows along it). */
function pointAtDistance(s: BSegment, r: number): BPoint {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (distance(s.p0, pointAt(s, mid)) < r) lo = mid;
    else hi = mid;
  }
  return pointAt(s, (lo + hi) / 2);
}

function inside(w: number, rule: BFillRule): boolean {
  return rule === 'evenodd' ? (w & 1) !== 0 : w !== 0;
}

function apply(op: BooleanOp, member: readonly boolean[]): boolean {
  switch (op) {
    case 'union':
      return member.some(Boolean);
    case 'intersect':
      return member.every(Boolean);
    case 'subtract':
      return (member[0] ?? false) && !member.slice(1).some(Boolean);
    case 'exclude':
      return member.filter(Boolean).length % 2 === 1;
  }
}

function reverse(s: BSegment): BSegment {
  return s.kind === 'line'
    ? { kind: 'line', p0: s.p1, p1: s.p0 }
    : { kind: 'cubic', p0: s.p1, c1: s.c2, c2: s.c1, p1: s.p0 };
}

function union(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function closeContour(contour: readonly BSegment[]): BSegment[] {
  const out = [...contour];
  const first = contour[0];
  const last = contour[contour.length - 1];
  if (first !== undefined && last !== undefined) {
    if (last.p1.x !== first.p0.x || last.p1.y !== first.p0.y) {
      out.push({ kind: 'line', p0: last.p1, p1: first.p0 });
    }
  }
  return out;
}

function arcLength(s: BSegment, t0: number, t1: number): number {
  let length = 0;
  let prev = pointAt(s, t0);
  for (let i = 1; i <= 8; i++) {
    const p = pointAt(s, t0 + ((t1 - t0) * i) / 8);
    length += distance(prev, p);
    prev = p;
  }
  return length;
}

function makePiece(
  s: Seg,
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  pool: VertexPool,
): Piece {
  const raw = subSegment(s.seg, t0, t1);
  const a = pool.at(v0);
  const b = pool.at(v1);
  let seg: BSegment;
  if (raw.kind === 'line') {
    seg = { kind: 'line', p0: a, p1: b };
  } else {
    seg = {
      kind: 'cubic',
      p0: a,
      c1: { x: raw.c1.x + a.x - raw.p0.x, y: raw.c1.y + a.y - raw.p0.y },
      c2: { x: raw.c2.x + b.x - raw.p1.x, y: raw.c2.y + b.y - raw.p1.y },
      p1: b,
    };
  }
  return { seg, shape: s.shape, v0, v1, group: -1 };
}

type Hit = { t: number; u: number };

/**
 * Intersections of two segments, excluding coincident stretches (the vertex rule cuts those), or
 * null when subdivision ran out of budget (the operation then fails closed).
 */
function intersect(a: BSegment, b: BSegment, eps: number, eta: number): Hit[] | null {
  if (a.kind === 'line' && b.kind === 'line') {
    const hit = chordHit(a, b);
    return hit === null ? [] : [hit];
  }
  const leaves: Hit[] = [];
  const state = { budget: SUBDIVISION_BUDGET };
  subdivide(a, 0, 1, b, 0, 1, 0, eps, eta, leaves, state);
  if (state.budget < 0) return null;
  if (leaves.length === 0) return [];
  // Merge leaves into runs and keep the closest point of each run.
  leaves.sort((x, y) => x.t - y.t);
  const runs: Hit[][] = [];
  for (const leaf of leaves) {
    const run = runs.find((r) =>
      r.some((h) => Math.abs(h.t - leaf.t) < 1e-6 && Math.abs(h.u - leaf.u) < 1e-6),
    );
    if (run !== undefined) run.push(leaf);
    else runs.push([leaf]);
  }
  const out: Hit[] = [];
  for (const run of runs) {
    let best = run[0] as Hit;
    let bestD = Infinity;
    for (const h of run) {
      const d = distance(pointAt(a, h.t), pointAt(b, h.u));
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    const refined = newton(a, b, best);
    const d = distance(pointAt(a, refined.t), pointAt(b, refined.u));
    out.push(d <= bestD ? refined : best);
  }
  return out;
}

function subdivide(
  a: BSegment,
  t0: number,
  t1: number,
  b: BSegment,
  u0: number,
  u1: number,
  depth: number,
  eps: number,
  eta: number,
  out: Hit[],
  state: { budget: number },
  pa: BSegment = subSegment(a, t0, t1),
  pb: BSegment = subSegment(b, u0, u1),
): void {
  if (--state.budget < 0) return;
  const ba = controlBox(pa);
  const bb = controlBox(pb);
  if (!boxesOverlap(ba, bb, eps)) return;
  // Fat lines: each piece lies in a strip along its own chord; near-parallel pieces a few η
  // apart separate there long before their boxes do.
  if (fatLineMisses(pa, pb, eps) || fatLineMisses(pb, pa, eps)) return;
  const sa = boxSize(ba);
  const sb = boxSize(bb);
  if ((sa <= eps && sb <= eps) || depth > 60) {
    out.push({ t: (t0 + t1) / 2, u: (u0 + u1) / 2 });
    return;
  }
  // Coincident stretch (checked only at scales where a real crossing would separate the
  // samples by more than η): the vertex rule handles its ends. A shallow crossing inside it
  // (the samples change sides) is found by bisection on the side, since subdivision cannot
  // separate curves that stay within ε of each other over a long stretch.
  if (Math.max(sa, sb) > COINCIDENT_SCALE * eta) {
    const near = coincident(pa, pb, eta, eps);
    if (near !== null) {
      for (const h of near) out.push({ t: t0 + (t1 - t0) * h.t, u: u0 + (u1 - u0) * h.u });
      return;
    }
  }
  // Pieces that share an end point and lie in disjoint cones from it meet only there (that
  // vertex exists).
  if (separatedAtSharedEnd(pa, pb)) return;
  const fa = flatness(pa);
  const fb = flatness(pb);
  // Pieces whose controls project inside their chords lie in rectangles of half-width `dev`
  // around the chords. Where the chords' lines cross at sine `sin`, a common point lies within
  // (devA + devB) / sin of that crossing along each chord: outside that pad there is none.
  if (fa.len > 0 && fb.len > 0 && fa.dev < Infinity && fb.dev < Infinity) {
    const rx = pa.p1.x - pa.p0.x;
    const ry = pa.p1.y - pa.p0.y;
    const sx = pb.p1.x - pb.p0.x;
    const sy = pb.p1.y - pb.p0.y;
    const den = rx * sy - ry * sx;
    const sin = Math.abs(den) / (fa.len * fb.len);
    if (sin > 1e-6) {
      const qx = pb.p0.x - pa.p0.x;
      const qy = pb.p0.y - pa.p0.y;
      const tc = (qx * sy - qy * sx) / den;
      const uc = (qx * ry - qy * rx) / den;
      const reach = (fa.dev + fb.dev + eps) / sin;
      const padT = reach / fa.len;
      const padU = reach / fb.len;
      if (tc < -padT || tc > 1 + padT || uc < -padU || uc > 1 + padU) return;
      // Disjoint hodograph cones: the pieces cross at most once, so a Newton root inside the
      // parameter box is the only one.
      if (conesDisjoint(pa, pb)) {
        const start = {
          t: t0 + (t1 - t0) * Math.min(1, Math.max(0, tc)),
          u: u0 + (u1 - u0) * Math.min(1, Math.max(0, uc)),
        };
        const hit = newton(a, b, start);
        const slackT = (t1 - t0) * 1e-9;
        const slackU = (u1 - u0) * 1e-9;
        if (
          hit.t >= t0 - slackT &&
          hit.t <= t1 + slackT &&
          hit.u >= u0 - slackU &&
          hit.u <= u1 + slackU &&
          distance(pointAt(a, hit.t), pointAt(b, hit.u)) <= eps
        ) {
          out.push(hit);
          return;
        }
      }
    }
  }
  // η-flat pieces: the chords stand in for the curves within η.
  if (fa.dev <= eta / 4 && fb.dev <= eta / 4) {
    const hit = chordHit(pa, pb);
    if (hit !== null) out.push({ t: t0 + (t1 - t0) * hit.t, u: u0 + (u1 - u0) * hit.u });
    return;
  }
  const tm = (t0 + t1) / 2;
  const um = (u0 + u1) / 2;
  if (sa >= sb) {
    const [l, r] = halves(pa);
    subdivide(a, t0, tm, b, u0, u1, depth + 1, eps, eta, out, state, l, pb);
    subdivide(a, tm, t1, b, u0, u1, depth + 1, eps, eta, out, state, r, pb);
  } else {
    const [l, r] = halves(pb);
    subdivide(a, t0, t1, b, u0, um, depth + 1, eps, eta, out, state, pa, l);
    subdivide(a, t0, t1, b, um, u1, depth + 1, eps, eta, out, state, pa, r);
  }
}

/** Whether `b`'s controls lie outside the strip around `a`'s chord that holds `a`. */
function fatLineMisses(a: BSegment, b: BSegment, eps: number): boolean {
  const dx = a.p1.x - a.p0.x;
  const dy = a.p1.y - a.p0.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return false;
  const off = (p: BPoint) => ((p.x - a.p0.x) * dy - (p.y - a.p0.y) * dx) / len;
  let lo = 0;
  let hi = 0;
  for (const p of controls(a)) {
    const d = off(p);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  let blo = Infinity;
  let bhi = -Infinity;
  for (const p of controls(b)) {
    const d = off(p);
    blo = Math.min(blo, d);
    bhi = Math.max(bhi, d);
  }
  return blo > hi + eps || bhi < lo - eps;
}

function halves(s: BSegment): [BSegment, BSegment] {
  if (s.kind === 'cubic') return splitCubic(s, 0.5);
  const m = { x: (s.p0.x + s.p1.x) / 2, y: (s.p0.y + s.p1.y) / 2 };
  return [
    { kind: 'line', p0: s.p0, p1: m },
    { kind: 'line', p0: m, p1: s.p1 },
  ];
}

function controls(s: BSegment): BPoint[] {
  return s.kind === 'line' ? [s.p0, s.p1] : [s.p0, s.c1, s.c2, s.p1];
}

/**
 * Whether `a` and `b` share an end point `P` and a line through `P` separates their other
 * control points strictly; each piece lies in the convex hull of its controls, so they then
 * meet only at `P`.
 */
function separatedAtSharedEnd(a: BSegment, b: BSegment): boolean {
  const same = (p: BPoint, q: BPoint) => p.x === q.x && p.y === q.y;
  let shared: BPoint | null = null;
  for (const p of [a.p0, a.p1]) {
    if (same(p, b.p0) || same(p, b.p1)) shared = p;
  }
  if (shared === null) return false;
  const P = shared;
  const dirs = (s: BSegment) =>
    controls(s)
      .map((q) => ({ x: q.x - P.x, y: q.y - P.y }))
      .filter((d) => d.x !== 0 || d.y !== 0)
      .map((d) => {
        const l = Math.sqrt(d.x * d.x + d.y * d.y);
        return { x: d.x / l, y: d.y / l };
      });
  const da = dirs(a);
  const db = dirs(b);
  if (da.length === 0 || db.length === 0) return false;
  const sum = (ds: readonly BPoint[]) =>
    ds.reduce((m, d) => ({ x: m.x + d.x, y: m.y + d.y }), { x: 0, y: 0 });
  const sa = sum(da);
  const sb = sum(db);
  const candidates: BPoint[] = [{ x: sa.x - sb.x, y: sa.y - sb.y }];
  for (const d of [...da, ...db]) candidates.push({ x: -d.y, y: d.x }, { x: d.y, y: -d.x });
  const margin = 1e-12;
  return candidates.some(
    (m) =>
      da.every((d) => d.x * m.x + d.y * m.y > margin) &&
      db.every((d) => d.x * m.x + d.y * m.y < -margin),
  );
}

/** Chord length, the controls' largest distance from the chord, and their ratio. */
function flatness(s: BSegment): { len: number; dev: number; ratio: number } {
  const dx = s.p1.x - s.p0.x;
  const dy = s.p1.y - s.p0.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (s.kind === 'line') return { len, dev: 0, ratio: 0 };
  if (len === 0) {
    const dev = boxSize(controlBox(s));
    return { len, dev, ratio: dev === 0 ? 0 : Infinity };
  }
  const off = (p: BPoint) => Math.abs((p.x - s.p0.x) * dy - (p.y - s.p0.y) * dx) / len;
  const along = (p: BPoint) => ((p.x - s.p0.x) * dx + (p.y - s.p0.y) * dy) / (len * len);
  const a1 = along(s.c1);
  const a2 = along(s.c2);
  // Controls outside the chord's span make the piece fold back: not flat.
  if (a1 < 0 || a1 > 1 || a2 < 0 || a2 > 1) return { len, dev: Infinity, ratio: Infinity };
  const dev = Math.max(off(s.c1), off(s.c2));
  return { len, dev, ratio: dev / len };
}

/** Pieces larger than this many η are checked for coincidence (section 2.4 step 2). */
const COINCIDENT_SCALE = 4096;
/** Box pairs one segment pair may visit before the operation fails closed. */
const SUBDIVISION_BUDGET = 20_000;

function chordHit(a: BSegment, b: BSegment): Hit | null {
  const rx = a.p1.x - a.p0.x;
  const ry = a.p1.y - a.p0.y;
  const sx = b.p1.x - b.p0.x;
  const sy = b.p1.y - b.p0.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) <= 1e-14 * Math.sqrt((rx * rx + ry * ry) * (sx * sx + sy * sy))) return null;
  const qx = b.p0.x - a.p0.x;
  const qy = b.p0.y - a.p0.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return t < 0 || t > 1 || u < 0 || u > 1 ? null : { t, u };
}

/**
 * Section 2.4 step 2: null unless five samples each way lie within η of the other piece. Then
 * the pieces are coincident, and the result lists the crossings inside the stretch (local
 * parameters): a change of side between consecutive samples, refined by bisection, or an end
 * sample within ε of the other piece where the others are not.
 */
function coincident(a: BSegment, b: BSegment, eta: number, eps: number): Hit[] | null {
  // Cheap necessary condition: each midpoint lies in the other's box grown by η.
  const ma = pointAt(a, 0.5);
  const mb = pointAt(b, 0.5);
  const ba = controlBox(a);
  const bb = controlBox(b);
  if (ma.x < bb.minX - eta || ma.x > bb.maxX + eta || ma.y < bb.minY - eta || ma.y > bb.maxY + eta)
    return null;
  if (mb.x < ba.minX - eta || mb.x > ba.maxX + eta || mb.y < ba.minY - eta || mb.y > ba.maxY + eta)
    return null;
  // And the end points lie near the other piece's box too.
  for (const p of [a.p0, a.p1]) {
    if (p.x < bb.minX - eta || p.x > bb.maxX + eta || p.y < bb.minY - eta || p.y > bb.maxY + eta)
      return null;
  }
  const sides: number[][] = [];
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const row: number[] = [];
    for (const t of COINCIDENT_SAMPLES) {
      const side = sideOf(from, to, t, eps);
      if (side === null) return null;
      row.push(side);
    }
    sides.push(row);
  }
  const hits: Hit[] = [];
  const row = sides[0] as number[];
  for (let i = 1; i < row.length; i++) {
    const s0 = row[i - 1] as number;
    const s1 = row[i] as number;
    if (s0 * s1 >= 0) continue;
    let lo = COINCIDENT_SAMPLES[i - 1] as number;
    let hi = COINCIDENT_SAMPLES[i] as number;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      const side = sideOf(a, b, mid, eps) ?? 0;
      if (side === 0) {
        lo = hi = mid;
        break;
      }
      if (side * s0 > 0) lo = mid;
      else hi = mid;
    }
    const t = (lo + hi) / 2;
    hits.push({ t, u: closestParam(b, pointAt(a, t)).t });
  }
  if (
    hits.length === 0 &&
    (sides[1] as number[]).some((x, i, all) => i > 0 && x * (all[i - 1] as number) < 0)
  ) {
    // Seen only from `b`'s side: the samples of `a` straddle the crossing too coarsely.
    return [];
  }
  // A crossing or touch at an end of the stretch.
  if (row.some((x) => x !== 0)) {
    for (const i of [0, row.length - 1]) {
      if (row[i] !== 0) continue;
      const t = COINCIDENT_SAMPLES[i] as number;
      hits.push({ t, u: closestParam(b, pointAt(a, t)).t });
    }
  }
  return hits;
}

/** The side of `from(t)` relative to `to` (0 within ε), or null when it is η or more away. */
function sideOf(from: BSegment, to: BSegment, t: number, eps: number): number | null {
  const p = pointAt(from, t);
  const hit = closestParam(to, p);
  if (hit.d >= eps * (BOOLEAN_ETA / BOOLEAN_EPSILON)) return null;
  if (hit.d <= eps) return 0;
  const q = pointAt(to, hit.t);
  const d = derivativeAt(to, hit.t);
  return Math.sign(d.x * (p.y - q.y) - d.y * (p.x - q.x));
}

const COINCIDENT_SAMPLES = [0, 0.25, 0.5, 0.75, 1] as const;

/**
 * Whether every direction of `a`'s control polygon lies strictly on one side of every
 * direction of `b`'s (in the same rotational sense): the hodographs' cones are then disjoint
 * and the pieces cross at most once.
 */
function conesDisjoint(a: BSegment, b: BSegment): boolean {
  const edges = (s: BSegment) => {
    const c = controls(s);
    const out: BPoint[] = [];
    for (let i = 1; i < c.length; i++) {
      const e = {
        x: (c[i] as BPoint).x - (c[i - 1] as BPoint).x,
        y: (c[i] as BPoint).y - (c[i - 1] as BPoint).y,
      };
      if (e.x !== 0 || e.y !== 0) out.push(e);
    }
    return out;
  };
  const ea = edges(a);
  const eb = edges(b);
  if (ea.length === 0 || eb.length === 0) return false;
  let sign = 0;
  for (const p of ea) {
    for (const q of eb) {
      const c = p.x * q.y - p.y * q.x;
      const bound = 1e-9 * Math.sqrt((p.x * p.x + p.y * p.y) * (q.x * q.x + q.y * q.y));
      const sc = c > bound ? 1 : c < -bound ? -1 : 0;
      if (sc === 0 || (sign !== 0 && sc !== sign)) return false;
      sign = sc;
    }
  }
  return true;
}

function newton(a: BSegment, b: BSegment, start: Hit): Hit {
  let { t, u } = start;
  for (let i = 0; i < 16; i++) {
    const p = pointAt(a, t);
    const q = pointAt(b, u);
    const fx = p.x - q.x;
    const fy = p.y - q.y;
    const da = derivativeAt(a, t);
    const db = derivativeAt(b, u);
    // [da, -db] [dt, du]^T = -f
    const det = da.x * -db.y - da.y * -db.x;
    if (Math.abs(det) < 1e-300) break;
    const dt = (-fx * -db.y - -fy * -db.x) / det;
    const du = (da.x * -fy - da.y * -fx) / det;
    const nt = t + dt;
    const nu = u + du;
    if (nt < 0 || nt > 1 || nu < 0 || nu > 1) break;
    t = nt;
    u = nu;
    if (Math.abs(dt) < 1e-16 && Math.abs(du) < 1e-16) break;
  }
  return { t, u };
}

/** Vertices clustered within η (grid hash over η-sized cells, relative to the inputs' corner). */
class VertexPool {
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly cells = new Map<number, number[]>();
  constructor(
    private readonly eta: number,
    private readonly ox: number,
    private readonly oy: number,
  ) {}
  get count(): number {
    return this.xs.length;
  }
  at(v: number): BPoint {
    return { x: this.xs[v] as number, y: this.ys[v] as number };
  }
  private key(cx: number, cy: number): number {
    // Cells span about 1e7 per axis (D / η); 2^26 per axis keeps the key exact.
    return (cx + 2) * 67_108_864 + (cy + 2);
  }
  add(p: BPoint): number {
    const cx = Math.floor((p.x - this.ox) / this.eta);
    const cy = Math.floor((p.y - this.oy) / this.eta);
    let best = -1;
    let bestD = this.eta;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get(this.key(cx + dx, cy + dy));
        if (cell === undefined) continue;
        for (const v of cell) {
          const ex = (this.xs[v] as number) - p.x;
          const ey = (this.ys[v] as number) - p.y;
          const d = Math.sqrt(ex * ex + ey * ey);
          if (d < bestD) {
            bestD = d;
            best = v;
          }
        }
      }
    }
    if (best >= 0) return best;
    const v = this.xs.length;
    this.xs.push(p.x);
    this.ys.push(p.y);
    const key = this.key(cx, cy);
    const cell = this.cells.get(key);
    if (cell === undefined) this.cells.set(key, [v]);
    else cell.push(v);
    return v;
  }
}

/** Pieces bucketed into horizontal and vertical bands, for axis rays. */
class BandIndex {
  private readonly n = 1024;
  private readonly rows: number[][];
  private readonly cols: number[][];
  private readonly sx: number;
  private readonly sy: number;
  constructor(
    private readonly box: BBox,
    pieces: readonly Piece[],
    indices: readonly number[],
  ) {
    this.rows = Array.from({ length: this.n }, () => []);
    this.cols = Array.from({ length: this.n }, () => []);
    this.sx = (box.maxX - box.minX) / this.n || 1;
    this.sy = (box.maxY - box.minY) / this.n || 1;
    for (const index of indices) {
      const b = controlBox((pieces[index] as Piece).seg);
      for (let r = this.row(b.minY); r <= this.row(b.maxY); r++)
        (this.rows[r] as number[]).push(index);
      for (let c = this.col(b.minX); c <= this.col(b.maxX); c++)
        (this.cols[c] as number[]).push(index);
    }
  }
  private row(y: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.floor((y - this.box.minY) / this.sy)));
  }
  private col(x: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.floor((x - this.box.minX) / this.sx)));
  }
  /** Pieces that may cross the ray from (x, y) along +x. */
  rowX(y: number): readonly number[] {
    return this.rows[this.row(y)] as number[];
  }
  /** Pieces that may cross the ray from (x, y) along +y. */
  columnY(x: number): readonly number[] {
    return this.cols[this.col(x)] as number[];
  }
}

/** A coarse uniform grid of segment boxes for the vertex rule. */
class SegmentGrid {
  private readonly n = 64;
  private readonly cells: number[][];
  private readonly sx: number;
  private readonly sy: number;
  constructor(
    private readonly box: BBox,
    segs: readonly Seg[],
    pad: number,
  ) {
    this.cells = Array.from({ length: this.n * this.n }, () => []);
    this.sx = (box.maxX - box.minX) / this.n || 1;
    this.sy = (box.maxY - box.minY) / this.n || 1;
    segs.forEach((s, index) => {
      const [x0, y0] = this.cell(s.box.minX - pad, s.box.minY - pad);
      const [x1, y1] = this.cell(s.box.maxX + pad, s.box.maxY + pad);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) (this.cells[y * this.n + x] as number[]).push(index);
      }
    });
  }
  private cell(x: number, y: number): [number, number] {
    const cx = Math.min(this.n - 1, Math.max(0, Math.floor((x - this.box.minX) / this.sx)));
    const cy = Math.min(this.n - 1, Math.max(0, Math.floor((y - this.box.minY) / this.sy)));
    return [cx, cy];
  }
  near(p: BPoint): readonly number[] {
    const [cx, cy] = this.cell(p.x, p.y);
    return this.cells[cy * this.n + cx] as number[];
  }
}
