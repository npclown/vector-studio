import { describe, expect, it } from 'vitest';
import {
  checkStrokeExactRegion,
  checkStrokeInventory,
  checkStrokeMembership,
  checkStrokePieceBounds,
  checkStrokeResolution,
  classifyStrokeSource,
  idealStrokeExactArea,
  idealStrokePieces,
  idealStrokeVerticesBinary64,
  STROKE_16GON_AREA,
  STROKE_FIXTURES,
  STROKE_S2_EXPONENTS,
  STROKE_S2_FAMILIES,
  strokeAreaEquals,
  strokeConvexHull,
  strokeDiskVertexCount,
  strokeMiterKept,
  strokePolygonUnionArea,
  type Point,
  type StrokeDumpPiece,
  type StrokeFixture,
  type StrokeOracleMesh,
  type StrokeOracleSource,
  type StrokeSampleTriple,
} from '../../packages/geometry-reference/src/index.js';

// ST-U2 tests: the B2 stroke oracle ST-O1 to ST-O5 with its positive controls
// (contract section 11.1) and the literal expectations of ST-F1 to ST-F26
// (section 11.2), checked against the oracle's own ideal geometry.

const fixture = (id: string): StrokeFixture => {
  const found = STROKE_FIXTURES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing fixture ${id}`);
  return found;
};

// ---------------------------------------------------------------------------
// A synthetic test-only candidate. It builds dumps with Float64 arithmetic
// following the contract's piece definitions (section 4.2), with uniform cubic
// leaves instead of the kernel's adaptive test. It exists only to give the
// oracle well-formed inputs and controlled mutations; it is not the kernel.

type Segment = { verb: number; points: Point[] };
type Subpath = { closed: boolean; start: Point; segments: Segment[] };

function decode(source: StrokeOracleSource): Subpath[] {
  const verbs = Array.from(source.verbs);
  const scalars = Array.from(source.points);
  let cursor = 0;
  const take = (): Point => {
    const point: Point = [scalars[cursor]!, scalars[cursor + 1]!];
    cursor += 2;
    return point;
  };
  const out: Subpath[] = [];
  let current: Subpath | null = null;
  let last: Point = [0, 0];
  verbs.forEach((verb, ordinal) => {
    if (verb === 0) {
      last = take();
      current = { closed: false, start: last, segments: [] };
      out.push(current);
    } else if (verb === 1) {
      const end = take();
      current!.segments.push({ verb: ordinal, points: [last, end] });
      last = end;
    } else if (verb === 2) {
      const controls = [last, take(), take(), take()];
      current!.segments.push({ verb: ordinal, points: controls });
      last = controls[3]!;
    } else {
      const open: Subpath = current!;
      if (last[0] !== open.start[0] || last[1] !== open.start[1])
        open.segments.push({ verb: ordinal, points: [last, open.start] });
      open.closed = true;
    }
  });
  return out;
}

const isZero = (segment: Segment) =>
  segment.points.every((p) => p[0] === segment.points[0]![0] && p[1] === segment.points[0]![1]);

function firstNonzero(base: Point, others: readonly Point[], sign: 1 | -1): Point {
  for (const point of others) {
    const d: Point = [sign * (point[0] - base[0]), sign * (point[1] - base[1])];
    if (d[0] !== 0 || d[1] !== 0) return d;
  }
  throw new Error('zero-length segment');
}

const startTangent = (s: Segment): Point => firstNonzero(s.points[0]!, s.points.slice(1), 1);
const endTangent = (s: Segment): Point => {
  const p = s.points;
  return firstNonzero(p[p.length - 1]!, [...p.slice(0, -1)].reverse(), -1);
};

function leftNormal(d: Point): Point {
  const length = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
  return [-(d[1] / length), d[0] / length];
}

function triple(center: Point, d: Point, r: number): StrokeSampleTriple {
  const n = leftNormal(d);
  return {
    minus: [center[0] - r * n[0], center[1] - r * n[1]],
    center,
    plus: [center[0] + r * n[0], center[1] + r * n[1]],
  };
}

function hull(points: readonly Point[]): Point[] | null {
  return strokeConvexHull(points);
}

function diskPolygon(center: Point, r: number, e: number, extra: readonly Point[]): Point[] | null {
  const n = strokeDiskVertexCount(r, e, Math.max(Math.abs(center[0]), Math.abs(center[1])))!;
  const vertices: Point[] = [];
  for (let j = 0; j < n; j += 1) {
    const angle = (2 * Math.PI * j) / n;
    const quarter = j % (n / 4) === 0;
    // Exact axis directions, as the bisection construction gives them.
    const c = quarter ? [1, 0, -1, 0][j / (n / 4)]! : Math.cos(angle);
    const s = quarter ? [0, 1, 0, -1][j / (n / 4)]! : Math.sin(angle);
    vertices.push([center[0] + r * c, center[1] + r * s]);
  }
  return hull([...vertices, ...extra]);
}

/** The disk vertex count the contract's rule gives for a center. */
function diskN(center: Point, r: number, e: number): number {
  return strokeDiskVertexCount(r, e, Math.max(Math.abs(center[0]), Math.abs(center[1])))!;
}

function bezier(p: readonly Point[], t: number): Point {
  const lerp = (a: Point, b: Point): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a = lerp(p[0]!, p[1]!);
  const b = lerp(p[1]!, p[2]!);
  const c = lerp(p[2]!, p[3]!);
  return lerp(lerp(a, b), lerp(b, c));
}

function derivative(p: readonly Point[], t: number): Point {
  const u = 1 - t;
  const f = (k: 0 | 1) =>
    3 *
    (u * u * (p[1]![k] - p[0]![k]) +
      2 * u * t * (p[2]![k] - p[1]![k]) +
      t * t * (p[3]![k] - p[2]![k]));
  return [f(0), f(1)];
}

/** Direction at t, taken from the side `toward` (+1 right of t, -1 left) at a stationary point. */
function direction(p: readonly Point[], t: number, toward: 1 | -1): Point {
  const d = derivative(p, t);
  if (d[0] !== 0 || d[1] !== 0) return d;
  const near = derivative(p, t + toward * 2 ** -30);
  return near;
}

function sourceOf(
  verbs: number[],
  points: number[],
  width: number,
  cap: StrokeOracleSource['cap'],
  join: StrokeOracleSource['join'],
  miterLimit: number,
  e: number,
): StrokeOracleSource {
  return { verbs, points, width, cap, join, miterLimit, toleranceExponent: e };
}

function syntheticDump(source: StrokeOracleSource, depth = 5): StrokeDumpPiece[] {
  const r = source.width / 2;
  const e = source.toleranceExponent;
  const classification = classifyStrokeSource(source);
  const pieces: StrokeDumpPiece[] = [];
  const startTriple = new Map<number, StrokeSampleTriple>();
  const endTriple = new Map<number, StrokeSampleTriple>();

  const segmentPieces = (segment: Segment): StrokeDumpPiece[] => {
    const out: StrokeDumpPiece[] = [];
    if (segment.points.length === 2) {
      const d: Point = [
        segment.points[1]![0] - segment.points[0]![0],
        segment.points[1]![1] - segment.points[0]![1],
      ];
      const start = triple(segment.points[0]!, d, r);
      const end = triple(segment.points[1]!, d, r);
      out.push({
        kind: 'line-sweep',
        verb: segment.verb,
        part: 0,
        start,
        end,
        polygon: hull([start.minus, start.center, start.plus, end.minus, end.center, end.plus]),
      });
      startTriple.set(segment.verb, start);
      endTriple.set(segment.verb, end);
      return out;
    }
    const info = classification.cubics.find((cubic) => cubic.verb === segment.verb)!;
    const p = segment.points;
    if (info.kind === 'collinear') {
      const knots: Point[] = [p[0]!, ...info.turningPoints.map((turning) => turning.point), p[3]!];
      for (let part = 0; part + 1 < knots.length; part += 1) {
        const a = knots[part]!;
        const b = knots[part + 1]!;
        const d: Point = [b[0] - a[0], b[1] - a[1]];
        const start = triple(a, d, r);
        const end = triple(b, d, r);
        if (part > 0) {
          out.push({
            kind: 'cusp-disk',
            verb: segment.verb,
            parameter: info.turningPoints[part - 1]!.t,
            center: a,
            diskVertices: diskN(a, r, e),
            polygon: diskPolygon(a, r, e, []),
          });
        }
        out.push({
          kind: 'line-sweep',
          verb: segment.verb,
          part,
          start,
          end,
          polygon: hull([start.minus, start.center, start.plus, end.minus, end.center, end.plus]),
        });
        if (part === 0) startTriple.set(segment.verb, start);
        endTriple.set(segment.verb, end);
      }
      return out;
    }
    const split = info.kind === 'cusp' ? info.stationary!.value : null;
    const ranges: [number, number][] =
      split === null
        ? [[0, 1]]
        : [
            [0, split],
            [split, 1],
          ];
    ranges.forEach(([from, to], rangeIndex) => {
      if (rangeIndex === 1) {
        const center = bezier(p, split!);
        out.push({
          kind: 'cusp-disk',
          verb: segment.verb,
          parameter: split!,
          center,
          diskVertices: diskN(center, r, e),
          polygon: diskPolygon(center, r, e, []),
        });
      }
      const count = 2 ** depth;
      let previous: StrokeSampleTriple | null = null;
      for (let index = 0; index < count; index += 1) {
        const t0 = from + ((to - from) * index) / count;
        const t1 = from + ((to - from) * (index + 1)) / count;
        const at = (t: number, toward: 1 | -1): StrokeSampleTriple => {
          if (t === 0) return triple(p[0]!, startTangent(segment), r);
          if (t === 1) return triple(p[3]!, endTangent(segment), r);
          // At the cusp split, the direction is taken toward the leaf's interior (section 4.5).
          if (t === split) return triple(bezier(p, t), derivative(p, t + toward * 2 ** -30), r);
          return triple(bezier(p, t), direction(p, t, toward), r);
        };
        const start: StrokeSampleTriple = previous ?? at(t0, 1);
        const end = at(t1, -1);
        out.push({
          kind: 'cubic-leaf',
          verb: segment.verb,
          rangeStart: from,
          rangeEnd: to,
          depth,
          index,
          start,
          end,
          polygon: hull([start.minus, start.center, start.plus, end.minus, end.center, end.plus]),
        });
        if (rangeIndex === 0 && index === 0) startTriple.set(segment.verb, start);
        previous = end;
      }
      endTriple.set(segment.verb, previous!);
    });
    return out;
  };

  const joinPiece = (incoming: Segment, outgoing: Segment): StrokeDumpPiece | null => {
    const decided = classification.joins.find(
      (join) => join.incomingVerb === incoming.verb && join.outgoingVerb === outgoing.verb,
    )!;
    if (decided.piece === 'none') return null;
    const inTriple = endTriple.get(incoming.verb)!;
    const outTriple = startTriple.get(outgoing.verb)!;
    const b = decided.point;
    if (decided.turn === 'reversal') {
      return {
        kind: 'join',
        incomingVerb: incoming.verb,
        outgoingVerb: outgoing.verb,
        join: 'round',
        outerIn: inTriple.minus,
        outerOut: inTriple.plus,
        tip: null,
        diskVertices: diskN(b, r, e),
        polygon: diskPolygon(b, r, e, [b, inTriple.minus, inTriple.plus]),
      };
    }
    const side = decided.outer!;
    const outerIn = inTriple[side];
    const outerOut = outTriple[side];
    if (decided.piece === 'bevel') {
      return {
        kind: 'join',
        incomingVerb: incoming.verb,
        outgoingVerb: outgoing.verb,
        join: 'bevel',
        outerIn,
        outerOut,
        tip: null,
        polygon: hull([b, outerIn, outerOut]),
      };
    }
    if (decided.piece === 'round') {
      return {
        kind: 'join',
        incomingVerb: incoming.verb,
        outgoingVerb: outgoing.verb,
        join: 'round',
        outerIn,
        outerOut,
        tip: null,
        diskVertices: diskN(b, r, e),
        polygon: diskPolygon(b, r, e, [b, outerIn, outerOut]),
      };
    }
    const k = side === 'plus' ? 1 : -1;
    const nIn = leftNormal(endTangent(incoming));
    const nOut = leftNormal(startTangent(outgoing));
    const a: Point = [k * nIn[0], k * nIn[1]];
    const c: Point = [k * nOut[0], k * nOut[1]];
    const dHat = a[0] * c[0] + a[1] * c[1];
    const tip: Point = [
      b[0] + (r * (a[0] + c[0])) / (1 + dHat),
      b[1] + (r * (a[1] + c[1])) / (1 + dHat),
    ];
    return {
      kind: 'join',
      incomingVerb: incoming.verb,
      outgoingVerb: outgoing.verb,
      join: 'miter',
      outerIn,
      outerOut,
      tip,
      polygon: hull([b, outerIn, tip, outerOut]),
    };
  };

  const capPiece = (end: 'start' | 'end', segment: Segment): StrokeDumpPiece => {
    const t = end === 'start' ? startTriple.get(segment.verb)! : endTriple.get(segment.verb)!;
    const d = end === 'start' ? startTangent(segment) : endTangent(segment);
    if (source.cap === 'round') {
      return {
        kind: 'cap',
        end,
        verb: segment.verb,
        cap: 'round',
        triple: t,
        extension: null,
        diskVertices: diskN(t.center, r, e),
        polygon: diskPolygon(t.center, r, e, [t.minus, t.center, t.plus]),
      };
    }
    const length = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
    const s = end === 'end' ? 1 : -1;
    const tau: Point = [(s * d[0]) / length, (s * d[1]) / length];
    const extension: [Point, Point] = [
      [t.minus[0] + r * tau[0], t.minus[1] + r * tau[1]],
      [t.plus[0] + r * tau[0], t.plus[1] + r * tau[1]],
    ];
    return {
      kind: 'cap',
      end,
      verb: segment.verb,
      cap: 'square',
      triple: t,
      extension,
      polygon: hull([t.minus, t.center, t.plus, ...extension]),
    };
  };

  decode(source).forEach((subpath, ordinal) => {
    const remaining = subpath.segments.filter((segment) => !isZero(segment));
    if (remaining.length === 0) {
      if (!subpath.closed && subpath.segments.length > 0 && source.cap !== 'butt') {
        const c = subpath.start;
        const polygon =
          source.cap === 'round'
            ? diskPolygon(c, r, e, [])
            : hull([
                [c[0] - r, c[1] - r],
                [c[0] + r, c[1] - r],
                [c[0] + r, c[1] + r],
                [c[0] - r, c[1] + r],
              ]);
        pieces.push({
          kind: 'point-cap',
          subpath: ordinal,
          cap: source.cap,
          point: c,
          ...(source.cap === 'round' ? { diskVertices: diskN(c, r, e) } : {}),
          polygon,
        });
      }
      return;
    }
    const sweeps = remaining.map(segmentPieces);
    const startCap =
      !subpath.closed && source.cap !== 'butt' ? capPiece('start', remaining[0]!) : null;
    if (startCap !== null) pieces.push(startCap);
    remaining.forEach((segment, index) => {
      pieces.push(...sweeps[index]!);
      if (index + 1 < remaining.length) {
        const join = joinPiece(segment, remaining[index + 1]!);
        if (join !== null) pieces.push(join);
      }
    });
    if (subpath.closed) {
      const join = joinPiece(remaining[remaining.length - 1]!, remaining[0]!);
      if (join !== null) pieces.push(join);
    } else if (source.cap !== 'butt') {
      pieces.push(capPiece('end', remaining[remaining.length - 1]!));
    }
  });
  return pieces;
}

// ---------------------------------------------------------------------------
// Hand-made conforming meshes for unit-cell regions (not a tessellator)

function cellMesh(cells: readonly (readonly [number, number])[], unit = 1): StrokeOracleMesh {
  const positions: number[] = [];
  const index = new Map<string, number>();
  const vertex = (x: number, y: number) => {
    const key = `${String(x)},${String(y)}`;
    let found = index.get(key);
    if (found === undefined) {
      found = positions.length / 2;
      index.set(key, found);
      positions.push(x * unit, y * unit);
    }
    return found;
  };
  const indices: number[] = [];
  for (const [x, y] of cells) {
    const a = vertex(x, y);
    const b = vertex(x + 1, y);
    const c = vertex(x + 1, y + 1);
    const d = vertex(x, y + 1);
    indices.push(a, b, c, a, c, d);
  }
  return withBoundary(positions, indices);
}

function withBoundary(positions: number[], indices: number[]): StrokeOracleMesh {
  const count = new Map<string, number>();
  const key = (a: number, b: number) => `${String(Math.min(a, b))}-${String(Math.max(a, b))}`;
  for (let slot = 0; slot < indices.length; slot += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const k = key(indices[slot + corner]!, indices[slot + ((corner + 1) % 3)]!);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const boundaryEdges: number[] = [];
  for (let slot = 0; slot < indices.length; slot += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const a = indices[slot + corner]!;
      const b = indices[slot + ((corner + 1) % 3)]!;
      if (count.get(key(a, b)) === 1) boundaryEdges.push(a, b);
    }
  }
  const xs = positions.filter((_, i) => i % 2 === 0);
  const ys = positions.filter((_, i) => i % 2 === 1);
  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    boundaryEdges: Uint32Array.from(boundaryEdges),
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    },
  };
}

function insideConvex(polygon: readonly Point[], point: Point): boolean {
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    if ((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]) < 0) return false;
  }
  return true;
}

/** Unit cells of an axis-aligned exact ideal region, found by cell centers. */
function idealCells(source: StrokeOracleSource): [number, number][] {
  const polygons = idealStrokePieces(source).map((piece) => {
    if (piece.kind !== 'polygon' || !piece.exact) throw new Error('not an exact polygon fixture');
    return piece.polygon;
  });
  const xs = polygons.flat().map((p) => p[0]);
  const ys = polygons.flat().map((p) => p[1]);
  const cells: [number, number][] = [];
  for (let x = Math.floor(Math.min(...xs)); x < Math.max(...xs); x += 1) {
    for (let y = Math.floor(Math.min(...ys)); y < Math.max(...ys); y += 1) {
      if (polygons.some((polygon) => insideConvex(polygon, [x + 0.5, y + 0.5]))) cells.push([x, y]);
    }
  }
  return cells;
}

/** Disks replaced by the n-gon whose vertices start at angle 0 (section 4.4), for literal areas. */
function idealPolygonsWithNgons(source: StrokeOracleSource): Point[][] {
  return idealStrokePieces(source).map((piece) => {
    if (piece.kind === 'polygon') return [...piece.polygon];
    if (piece.kind === 'disk')
      return diskPolygon(piece.center, piece.radius, source.toleranceExponent, [])!;
    throw new Error('curve sweep has no polygonal ideal');
  });
}

// ---------------------------------------------------------------------------
// Fixture literal expectations (section 11.2)

describe('B2 stroke fixtures ST-F1 to ST-F26', () => {
  it('lists every named fixture with unique case ids', () => {
    const ids = STROKE_FIXTURES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = new Set(STROKE_FIXTURES.map((entry) => entry.fixture));
    for (let n = 1; n <= 26; n += 1) expect(names.has(`ST-F${String(n)}`)).toBe(true);
    expect(STROKE_FIXTURES.filter((entry) => entry.fixture === 'ST-F15')).toHaveLength(54);
  });

  it('checks the 16-gon constants', () => {
    expect(8 * Math.sin(Math.PI / 8)).toBeCloseTo(STROKE_16GON_AREA, 15);
    const square = strokePolygonUnionArea([diskPolygon([0, 0], 1, -3, [])!]);
    expect(Math.abs(square.value - STROKE_16GON_AREA)).toBeLessThanOrEqual(1e-12);
  });

  const exactCases = STROKE_FIXTURES.filter((entry) => entry.expected.areaTolerance === 0);
  it.each(exactCases.map((entry) => [entry.id, entry] as const))(
    '%s: exact ideal area',
    (_, entry) => {
      const area = idealStrokeExactArea(entry.source);
      expect(area).not.toBeNull();
      expect(strokeAreaEquals(area!, entry.expected.area!)).toBe(true);
      expect(entry.expected.exactRegion).toBe(true);
    },
  );

  const approxCases = STROKE_FIXTURES.filter((entry) => entry.expected.areaTolerance === 1e-12);
  it.each(approxCases.map((entry) => [entry.id, entry] as const))(
    '%s: ideal area with n-gon disks',
    (_, entry) => {
      const area = strokePolygonUnionArea(idealPolygonsWithNgons(entry.source));
      expect(Math.abs(area.value - entry.expected.area!)).toBeLessThanOrEqual(1e-12);
    },
  );

  it.each(
    STROKE_FIXTURES.filter((entry) => entry.expected.bounds !== undefined).map(
      (entry) => [entry.id, entry] as const,
    ),
  )('%s: bounds', (_, entry) => {
    const points = idealStrokePieces(entry.source).flatMap((piece) =>
      piece.kind === 'polygon' ? piece.polygon : [],
    );
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]).toEqual(
      entry.expected.bounds,
    );
  });

  it.each(
    STROKE_FIXTURES.filter((entry) => entry.expected.join !== undefined).map(
      (entry) => [entry.id, entry] as const,
    ),
  )('%s: join decision', (_, entry) => {
    const joins = classifyStrokeSource(entry.source).joins;
    expect(joins).toHaveLength(1);
    expect(joins[0]!.piece).toBe(entry.expected.join);
    if (entry.expected.tip !== undefined) {
      const tip = entry.expected.tip;
      const miter = idealStrokePieces(entry.source).find((piece) => piece.role === 'miter-join');
      expect(miter?.kind === 'polygon' && miter.exact).toBe(true);
      if (miter?.kind === 'polygon')
        expect(miter.polygon.some((p) => p[0] === tip[0] && p[1] === tip[1])).toBe(true);
    }
  });

  it.each(
    STROKE_FIXTURES.filter((entry) => entry.expected.status === 'empty').map(
      (entry) => [entry.id, entry] as const,
    ),
  )('%s: no ideal piece', (_, entry) => {
    if (entry.fixture === 'ST-F22') return; // collapse is a Float64 effect, checked below
    expect(idealStrokePieces(entry.source)).toHaveLength(0);
  });

  it.each(
    STROKE_FIXTURES.filter((entry) => entry.expected.diskVertices !== undefined).map(
      (entry) => [entry.id, entry] as const,
    ),
  )('%s: disk vertex count', (_, entry) => {
    const r = entry.source.width / 2;
    const disks = idealStrokePieces(entry.source).filter((piece) => piece.kind === 'disk');
    expect(disks.length).toBeGreaterThan(0);
    for (const disk of disks) {
      if (disk.kind !== 'disk') continue;
      const norm = Math.max(Math.abs(disk.center[0]), Math.abs(disk.center[1]));
      expect(strokeDiskVertexCount(r, entry.source.toleranceExponent, norm)).toBe(
        entry.expected.diskVertices,
      );
    }
  });

  it('ST-F3 and ST-F16: halving n breaks the arc share (ST-D9 is visible to ST-O1)', () => {
    const sagitta = (r: number, n: number) => r * (1 - Math.cos(Math.PI / n));
    expect(sagitta(1, 16)).toBeLessThanOrEqual(2 ** -5);
    expect(sagitta(1, 8)).toBeGreaterThan(2 ** -5);
    expect(sagitta(1 / 16, 32)).toBeLessThanOrEqual(2 ** -10);
    expect(sagitta(1 / 16, 16)).toBeGreaterThan(2 ** -10);
  });

  it('ST-F5 and ST-F25: the exact miter predicate', () => {
    expect(strokeMiterKept([25, 0], [7, 24], 1.25)).toBe(true);
    expect(strokeMiterKept([25, 0], [7, 24], 1.2499999999999998)).toBe(false);
    expect(strokeMiterKept([25, 0], [7, 24], 1.2500000000000002)).toBe(true);
    expect(1.2499999999999998).toBe(1.25 - 2 ** -52);
    expect(1.2500000000000002).toBe(1.25 + 2 ** -52);
    // Math.SQRT2 is above sqrt(2), so the 90° ratio sqrt(2) keeps its miter.
    expect(
      Math.SQRT2 * Math.SQRT2 > 2 || BigInt(Math.SQRT2 * 2 ** 52) ** 2n > 2n * 2n ** 104n,
    ).toBe(true);
    expect(strokeMiterKept([1, 0], [0, 1], Math.SQRT2)).toBe(true);
    expect(strokeMiterKept([1, 0], [0, 1], 1)).toBe(false);
  });

  it('ST-F12: the implicit closing edge is not stroked', () => {
    const entry = fixture('ST-F12');
    const polygons = idealPolygonsWithNgons(entry.source);
    for (const point of entry.expected.inside!)
      expect(polygons.some((p) => insideConvex(p, point))).toBe(true);
    for (const point of entry.expected.outside!)
      expect(polygons.some((p) => insideConvex(p, point))).toBe(false);
  });

  it('ST-F13: forward continuation, no join piece', () => {
    const joins = classifyStrokeSource(fixture('ST-F13').source).joins;
    expect(joins.map((join) => join.turn)).toEqual(['continuation']);
  });

  it('ST-F16: one interior reversal at t* = 1/2 with center (0.5, 0.75)', () => {
    const entry = fixture('ST-F16');
    const [cubic] = classifyStrokeSource(entry.source).cubics;
    expect(cubic!.kind).toBe('cusp');
    expect(cubic!.stationary).toMatchObject({ numerator: 1n, denominator: 2n });
    expect(cubic!.cuspCenter).toEqual([0.5, 0.75]);
    const r = entry.source.width / 2;
    expect(Math.hypot(0.5 - 0.5, 0.8 - 0.75)).toBeLessThan(r * Math.cos(Math.PI / 32));
  });

  it('ST-F17, ST-F19, ST-F20: collinear reversal, continuation and stationary start', () => {
    const f17 = classifyStrokeSource(fixture('ST-F17/butt').source).cubics[0]!;
    expect(f17.kind).toBe('collinear');
    expect(f17.turningPoints).toEqual([{ t: 0.5, point: [0, 0] }]);
    const f19 = classifyStrokeSource(fixture('ST-F19').source).cubics[0]!;
    expect(f19.kind).toBe('collinear');
    expect(f19.turningPoints).toEqual([]);
    expect(f19.continuations).toEqual([0.5]);
    const f18 = classifyStrokeSource(fixture('ST-F18').source);
    expect(f18.cubics[0]!.kind).toBe('endpoint-stationary');
    expect(f18.cubics[0]!.stationary).toMatchObject({ numerator: 0n, denominator: 1n });
    expect(f18.caps.find((cap) => cap.end === 'start')!.tangent).toEqual([1, 0]);
    for (const entry of STROKE_FIXTURES.filter((candidate) => candidate.fixture === 'ST-F20')) {
      expect(classifyStrokeSource(entry.source).cubics[0]!.kind).toBe(entry.expected.cubic);
    }
  });

  it('ST-F18: membership against the ideal square cap and the curve neighbourhood', () => {
    const entry = fixture('ST-F18');
    const cap = idealStrokePieces(entry.source).find((piece) => piece.role === 'start-cap');
    expect(cap?.kind === 'polygon' && cap.exact).toBe(true);
    if (cap?.kind !== 'polygon') return;
    expect(insideConvex(cap.polygon, entry.expected.inside![0]!)).toBe(true);
    const controls: Point[] = [
      [0, 0],
      [0, 0],
      [1, 0],
      [3, 1],
    ];
    for (const point of entry.expected.outside!) {
      expect(insideConvex(cap.polygon, point)).toBe(false);
      let nearest = Infinity;
      for (let i = 0; i <= 10000; i += 1) {
        const c = bezier(controls, i / 10000);
        nearest = Math.min(nearest, Math.hypot(c[0] - point[0], c[1] - point[1]));
      }
      // Sampling spacing 1e-4 with |C'| <= 3·|(2,1)| bounds the miss by 3.4e-4.
      expect(nearest - 3.4e-4).toBeGreaterThan(1);
    }
  });

  it('ST-F22 to ST-F24: collapse and guards as section 4.7 states them', () => {
    const u = 2 ** -53;
    // ST-F22: offsets round onto the centerline; g_off <= 2^(e-4).
    const r22 = 2 ** -42;
    const n = leftNormal([1, 1]);
    expect(2 ** 40 + r22 * n[0]).toBe(2 ** 40);
    expect(2 ** 40 + r22 * n[1]).toBe(2 ** 40);
    expect(2 ** 40 + 1 + r22 * n[1]).toBe(2 ** 40 + 1);
    expect(16 * u * (2 ** 40 + 1 + r22)).toBeLessThanOrEqual(2 ** -7);
    // ST-F23: g_off > 2^(e-4).
    expect(16 * u * (2 ** 60 + 2 ** 20 + 1)).toBeGreaterThan(2 ** -7);
    // ST-F24: the miter is kept at L = 2^30 and g_tip > 2^(e-1); bevel at L = 4.
    expect(strokeMiterKept([1, 0], [-1, 2 ** -20], 2 ** 30)).toBe(true);
    expect(32 * u * (1 + 1 * 2 ** 60)).toBeGreaterThan(2 ** -4);
    expect(strokeMiterKept([1, 0], [-1, 2 ** -20], 4)).toBe(false);
    // ST-F25: every tip guard is within 2^(e-1), so every case is ok.
    expect(32 * u * (25 + 1 * 100 * 100)).toBeLessThanOrEqual(2 ** -4);
  });

  it('ST-F15: the s2 families and the nine exponents', () => {
    for (const { zoom, dpr, e } of STROKE_S2_EXPONENTS)
      expect(Math.floor(Math.log2(0.125 / (zoom * dpr)))).toBe(e);
    const kinds = STROKE_S2_FAMILIES.map((family) => {
      const entry = fixture(`ST-F15/${family.name}-zoom1-dpr1`);
      return classifyStrokeSource(entry.source).cubics[0]!.kind;
    });
    expect(kinds).toEqual(['collinear', 'collinear', 'regular', 'regular', 'regular', 'regular']);
  });

  it('ST-F26: current-cap fixture sizes', () => {
    const count = (id: string) => {
      const c = classifyStrokeSource(fixture(id).source);
      const segments = c.subpaths.reduce(
        (total, subpath) => total + subpath.remainingVerbs.length,
        0,
      );
      const joins = c.joins.filter((join) => join.piece !== 'none');
      return {
        segments,
        joins: joins.length,
        bevels: joins.every((join) => join.piece === 'bevel'),
        caps: c.caps.length,
      };
    };
    const p512 = count('ST-F26/pieces-512');
    expect(p512.segments + p512.joins + p512.caps).toBe(512);
    const p513 = count('ST-F26/pieces-513');
    expect(p513.segments + p513.joins + p513.caps).toBe(513);
    const e1024 = count('ST-F26/edges-1024');
    expect(e1024.bevels).toBe(true);
    expect(6 * e1024.segments + 3 * e1024.joins + 5 * e1024.caps).toBe(1024);
    const e1025 = count('ST-F26/edges-1025');
    expect(e1025.bevels).toBe(true);
    expect(6 * e1025.segments + 3 * e1025.joins + 5 * e1025.caps).toBe(1025);
    const disk256 = fixture('ST-F26/disk-256').source;
    const disk512 = fixture('ST-F26/disk-512').source;
    expect(strokeDiskVertexCount(disk256.width / 2, -3, 4)).toBe(256);
    expect(strokeDiskVertexCount(disk512.width / 2, -3, 4)).toBeNull();
    expect(strokeDiskVertexCount(disk256.width / 2, -3, 0)).toBe(256);
  });
});

// ---------------------------------------------------------------------------
// ST-O1 and ST-O2 on synthetic dumps, with positive controls

const SYNTHETIC = [
  'ST-F1',
  'ST-F2',
  'ST-F3',
  'ST-F4/miter-2',
  'ST-F4/bevel',
  'ST-F4/round',
  'ST-F5/limit-1.25',
  'ST-F5/limit-below',
  'ST-F6/miter-4',
  'ST-F6/round',
  'ST-F8/round',
  'ST-F8/square',
  'ST-F10',
  'ST-F11/miter-2-butt',
  'ST-F11/round-square',
  'ST-F12',
  'ST-F13',
  'ST-F14/a',
  'ST-F14/b',
  'ST-F16',
  'ST-F17/square',
  'ST-F17/round',
  'ST-F18',
  'ST-F19',
  'ST-F20/endpoint-round',
  'ST-F21',
  'ST-F25/sqrt50-L100',
  'ST-F25/90-LSQRT2',
];

describe('ST-O1 piece bounds and ST-O2 inventory', () => {
  it.each(SYNTHETIC)('%s: a well-formed synthetic dump passes', (id) => {
    const source = fixture(id).source;
    const pieces = syntheticDump(source);
    const inventory = checkStrokeInventory(source, pieces);
    expect(inventory.findings).toEqual([]);
    const bounds = checkStrokePieceBounds(source, pieces);
    expect(bounds.findings).toEqual([]);
  });

  it('ST-F15 R3, R4 and R5 at e = -3 certify with enough uniform leaves', () => {
    for (const [name, depth] of [
      ['R3', 0],
      ['R4', 6],
      ['R5', 6],
    ] as const) {
      const source = fixture(`ST-F15/${name}-zoom1-dpr1`).source;
      const result = checkStrokePieceBounds(source, syntheticDump(source, depth));
      expect(result.findings, name).toEqual([]);
      expect(result.maxLeafBound).toBeLessThanOrEqual(2 ** -3);
    }
  });

  it('ST-O1 on coarse R4 leaves: the band certificate (D9 E2-U2) bounds what section 4.5 cannot', () => {
    // Up to stroke-v0+r5 ST-O1 had section 4.5's certificate only, whose hull term r sin(theta)
    // (r = 32) rejects the depth-2 set. The offsets' true deviation from their chords is about
    // 0.001, and E2-K2's band certificate accepts the set (2026-10-25, E2 contract section 5).
    const result = checkStrokePieceBounds(r4, syntheticDump(r4, 2));
    expect(result.findings).toEqual([]);
    expect(result.maxLeafBound).toBeLessThanOrEqual(2 ** -3);
    // At e = -7 one leaf of R4 is too coarse: its inner offset deviates from its chord by about
    // 0.0156 > 2^-7, and both certificates reject it.
    const fine = sourceOf([0, 2], [0, 0, 1, 0, 2, 1 / 64, 3, 3 / 64], 64, 'butt', 'miter', 4, -7);
    const rejected = checkStrokePieceBounds(fine, syntheticDump(fine, 0));
    expect(rejected.ok).toBe(false);
    expect(rejected.findings.join('\n')).toMatch(/hull term|side: /);
    expect(rejected.findings.join('\n')).toMatch(/E2-K2 band certificate: /);
  });

  it('a cusp at the non-dyadic t* = 1/3 certifies through the clip at the Float64 split', () => {
    // C'(t) = (3t(3t - 1), -3(3t - 1)): gcd 3t - 1, so t* = 1/3 exactly and t̃ = 1/3 in Float64 differs.
    const source = sourceOf(
      [0, 2],
      [0, 0, 0, 1, -0.5, 0.5, 1.5, -1.5],
      0.125,
      'butt',
      'miter',
      4,
      -8,
    );
    const [cubic] = classifyStrokeSource(source).cubics;
    expect(cubic!.kind).toBe('cusp');
    expect(cubic!.stationary).toMatchObject({ numerator: 1n, denominator: 3n });
    const pieces = syntheticDump(source, 6);
    expect(checkStrokeInventory(source, pieces).findings).toEqual([]);
    expect(checkStrokePieceBounds(source, pieces).findings).toEqual([]);
  });

  it('ST-F15 R6: uniform leaves cannot cover its folded apex, and the oracle refuses them', () => {
    // R6 turns its normal by nearly 180° around t = 1/2 (curvature radius far below r);
    // a uniform depth-7 dump is not a valid output there, so ST-O1 must reject it.
    const source = fixture('ST-F15/R6-zoom1-dpr1').source;
    expect(checkStrokePieceBounds(source, syntheticDump(source, 7)).ok).toBe(false);
  });

  // Positive controls for ST-O1 (section 11.1): the s2 chord-normal R4 leaf
  // and the flipped R3 start normal. The unmutated R3 leaf certifies first.
  const r3 = fixture('ST-F15/R3-zoom1-dpr1').source;
  const r4 = fixture('ST-F15/R4-zoom1-dpr1').source;

  it('ST-O1 control baseline: the single R3 leaf certifies', () => {
    expect(checkStrokePieceBounds(r3, syntheticDump(r3, 0)).findings).toEqual([]);
  });

  it('ST-O1 control: the s2 chord-normal R4 leaf is rejected at its endpoint', () => {
    const chord: Point = [-1 / Math.sqrt(4097), 64 / Math.sqrt(4097)];
    const r = 32;
    const sample = (c: Point): StrokeSampleTriple => ({
      minus: [c[0] - r * chord[0], c[1] - r * chord[1]],
      center: c,
      plus: [c[0] + r * chord[0], c[1] + r * chord[1]],
    });
    const start = sample([0, 0]);
    const end = sample([3, 3 / 64]);
    const leaf: StrokeDumpPiece = {
      kind: 'cubic-leaf',
      verb: 1,
      rangeStart: 0,
      rangeEnd: 1,
      depth: 0,
      index: 0,
      start,
      end,
      polygon: hull([start.minus, start.center, start.plus, end.minus, end.center, end.plus]),
    };
    const result = checkStrokePieceBounds(r4, [leaf]);
    expect(result.ok).toBe(false);
    expect(result.findings.join('\n')).toMatch(/plus side: endpoint error lower bound .* at t=0$/m);
  });

  it('ST-O1 control: the flipped R3 start normal is rejected', () => {
    const [leaf] = syntheticDump(r3, 0) as [Extract<StrokeDumpPiece, { kind: 'cubic-leaf' }>];
    const start: StrokeSampleTriple = { ...leaf.start, plus: [0, -1] };
    const mutated: StrokeDumpPiece = {
      ...leaf,
      start,
      polygon: hull([
        start.minus,
        start.center,
        start.plus,
        leaf.end.minus,
        leaf.end.center,
        leaf.end.plus,
      ]),
    };
    const result = checkStrokePieceBounds(r3, [mutated]);
    expect(result.ok).toBe(false);
    expect(result.findings.join('\n')).toMatch(
      /offset sample|endpoint error lower bound|collapsed/,
    );
  });

  it('ST-O1 control: a halved disk count, a miter tip off its share and a non-hull polygon are rejected', () => {
    const f3 = fixture('ST-F3').source;
    const pieces = syntheticDump(f3);
    const capIndex = pieces.findIndex((piece) => piece.kind === 'cap');
    const cap = pieces[capIndex] as Extract<StrokeDumpPiece, { kind: 'cap' }>;
    const coarse: Point[] = [];
    for (let j = 0; j < 8; j += 1)
      coarse.push([Math.cos((Math.PI * j) / 4), Math.sin((Math.PI * j) / 4)]);
    const halved = [...pieces];
    halved[capIndex] = {
      ...cap,
      polygon: hull([...coarse, cap.triple.minus, cap.triple.center, cap.triple.plus]),
    };
    expect(checkStrokePieceBounds(f3, halved).findings.join('\n')).toMatch(/closer than r - share/);

    const f4 = fixture('ST-F4/miter-2').source;
    const miter = syntheticDump(f4);
    const joinIndex = miter.findIndex((piece) => piece.kind === 'join');
    const join = miter[joinIndex] as Extract<StrokeDumpPiece, { kind: 'join' }>;
    const moved = [...miter];
    const tip: Point = [5 + 2 ** -2, -1];
    moved[joinIndex] = { ...join, tip, polygon: hull([[4, 0], join.outerIn, tip, join.outerOut]) };
    expect(checkStrokePieceBounds(f4, moved).findings.join('\n')).toMatch(
      /miter tip beyond the share/,
    );

    const notHull = [...miter];
    notHull[joinIndex] = { ...join, polygon: [...join.polygon!].reverse() };
    expect(checkStrokePieceBounds(f4, notHull).findings.join('\n')).toMatch(/is not the hull/);
  });

  it('ST-O1 control: a wrong reported disk vertex count and a pure disk that is not its hull are rejected (M2)', () => {
    const f3 = fixture('ST-F3').source;
    const pieces = syntheticDump(f3);
    const capIndex = pieces.findIndex((piece) => piece.kind === 'cap');
    const cap = pieces[capIndex] as Extract<StrokeDumpPiece, { kind: 'cap' }>;
    expect(cap.diskVertices).toBe(16);
    expect(checkStrokePieceBounds(f3, pieces).findings).toEqual([]);
    const wrong = [...pieces];
    wrong[capIndex] = { ...cap, diskVertices: 8 };
    expect(checkStrokePieceBounds(f3, wrong).findings.join('\n')).toMatch(
      /disk vertex count 8 where the rule gives 16/,
    );

    const f16 = fixture('ST-F16').source;
    const cusp = syntheticDump(f16);
    const diskIndex = cusp.findIndex((piece) => piece.kind === 'cusp-disk');
    const disk = cusp[diskIndex] as Extract<StrokeDumpPiece, { kind: 'cusp-disk' }>;
    expect(disk.polygon).toHaveLength(disk.diskVertices!);
    const dented = [...cusp];
    dented[diskIndex] = { ...disk, polygon: disk.polygon!.filter((_, index) => index !== 3) };
    expect(checkStrokePieceBounds(f16, dented).findings.join('\n')).toMatch(
      /hull vertices, not its/,
    );

    // A pure disk with twice the reported count: every vertex lies on the circle and every chord
    // passes checkDisk, so only the vertex-count check can reject it (review of the hardening).
    const poly = disk.polygon!;
    const cx = poly.reduce((sum, [x]) => sum + x, 0) / poly.length;
    const cy = poly.reduce((sum, [, y]) => sum + y, 0) / poly.length;
    const radius = Math.hypot(poly[0]![0] - cx, poly[0]![1] - cy);
    const doubled = poly.flatMap((point, index) => {
      const next = poly[(index + 1) % poly.length]!;
      const mx = (point[0] + next[0]) / 2 - cx;
      const my = (point[1] + next[1]) / 2 - cy;
      const scale = radius / Math.hypot(mx, my);
      return [point, [cx + mx * scale, cy + my * scale] as const];
    });
    const overfull = [...cusp];
    overfull[diskIndex] = { ...disk, polygon: doubled };
    expect(checkStrokePieceBounds(f16, overfull).findings.join('\n')).toMatch(
      /hull vertices, not its/,
    );
  });

  it("ST-O2 control: a round cap's own E- differing from the sweep triple is rejected (M3)", () => {
    const f3 = fixture('ST-F3').source;
    const pieces = syntheticDump(f3);
    const capIndex = pieces.findIndex((piece) => piece.kind === 'cap' && piece.end === 'end');
    const cap = pieces[capIndex] as Extract<StrokeDumpPiece, { kind: 'cap' }>;
    expect(checkStrokeInventory(f3, pieces).findings).toEqual([]);
    const mutated = [...pieces];
    mutated[capIndex] = { ...cap, triple: { ...cap.triple, minus: cap.triple.plus } };
    expect(checkStrokeInventory(f3, mutated).findings.join('\n')).toMatch(
      /does not share the sweep triple/,
    );
  });

  it('ST-O3 exact mode needs binary64 ideal vertices (M1)', () => {
    const f1 = fixture('ST-F1').source;
    expect(idealStrokeVerticesBinary64(f1)).toBe(true);
    // M(0, 2^40) L(1, 2^40), w = 2^-30: the ideal corners 2^40 ± 2^-31 need 71 bits.
    const thin: StrokeOracleSource = { ...f1, points: [0, 2 ** 40, 1, 2 ** 40], width: 2 ** -30 };
    expect(idealStrokeExactArea(thin)).not.toBeNull();
    expect(idealStrokeVerticesBinary64(thin)).toBe(false);
  });

  it('ST-O1 control: a square cap along the normal instead of the tangent is rejected (ST-D10)', () => {
    const f2 = fixture('ST-F2').source;
    const pieces = syntheticDump(f2);
    const capIndex = pieces.findIndex((piece) => piece.kind === 'cap' && piece.end === 'end');
    const cap = pieces[capIndex] as Extract<StrokeDumpPiece, { kind: 'cap' }>;
    const extension: [Point, Point] = [
      [cap.triple.minus[0], cap.triple.minus[1] - 1],
      [cap.triple.plus[0], cap.triple.plus[1] + 1],
    ];
    const mutated = [...pieces];
    mutated[capIndex] = {
      ...cap,
      extension,
      polygon: hull([cap.triple.minus, cap.triple.center, cap.triple.plus, ...extension]),
    };
    expect(checkStrokePieceBounds(f2, mutated).findings.join('\n')).toMatch(
      /square cap corner beyond the share/,
    );
  });

  // Positive controls for ST-O2 (section 11.1), on ST-F16's cusp cubic.
  const f16 = fixture('ST-F16').source;
  const f16Pieces = syntheticDump(f16);
  const leafIndices = f16Pieces.flatMap((piece, index) =>
    piece.kind === 'cubic-leaf' ? [index] : [],
  );

  it('ST-O2 control baseline: the ST-F16 dump passes and has a cusp disk', () => {
    expect(checkStrokeInventory(f16, f16Pieces).findings).toEqual([]);
    expect(f16Pieces.filter((piece) => piece.kind === 'cusp-disk')).toHaveLength(1);
  });

  it('ST-O2 control: a removed leaf interval is rejected', () => {
    const mutated = f16Pieces.filter((_, index) => index !== leafIndices[3]);
    expect(checkStrokeInventory(f16, mutated).findings.join('\n')).toMatch(/gap/);
  });

  it('ST-O2 control: a duplicated leaf interval is rejected', () => {
    const at = leafIndices[3]!;
    const mutated = [...f16Pieces.slice(0, at + 1), f16Pieces[at]!, ...f16Pieces.slice(at + 1)];
    expect(checkStrokeInventory(f16, mutated).findings.join('\n')).toMatch(/overlap/);
  });

  it('ST-O2 control: a join piece at a generated knot is rejected', () => {
    const at = leafIndices[3]!;
    const leaf = f16Pieces[at] as Extract<StrokeDumpPiece, { kind: 'cubic-leaf' }>;
    const knot = leaf.end;
    const join: StrokeDumpPiece = {
      kind: 'join',
      incomingVerb: 1,
      outgoingVerb: 1,
      join: 'bevel',
      outerIn: knot.minus,
      outerOut: knot.minus,
      tip: null,
      polygon: hull([knot.center, knot.minus, knot.plus]),
    };
    const mutated = [...f16Pieces.slice(0, at + 1), join, ...f16Pieces.slice(at + 1)];
    expect(checkStrokeInventory(f16, mutated).ok).toBe(false);
    expect(checkStrokePieceBounds(f16, mutated).findings.join('\n')).toMatch(/no join piece here/);
  });

  it('ST-O2 control: a missing cusp disk is rejected', () => {
    const mutated = f16Pieces.filter((piece) => piece.kind !== 'cusp-disk');
    expect(checkStrokeInventory(f16, mutated).findings.join('\n')).toMatch(/cusp disk/);
  });

  it('ST-O2 control: an unshared forward-continuation triple is rejected (ST-D3)', () => {
    const f13 = fixture('ST-F13').source;
    const pieces = syntheticDump(f13);
    const second = pieces[1] as Extract<StrokeDumpPiece, { kind: 'line-sweep' }>;
    // An independently rounded start sample one ulp-scale step away from the shared one.
    const start: StrokeSampleTriple = {
      ...second.start,
      minus: [second.start.minus[0] + 2 ** -50, second.start.minus[1]],
    };
    expect(start.minus).not.toEqual(
      (pieces[0] as Extract<StrokeDumpPiece, { kind: 'line-sweep' }>).end.minus,
    );
    const mutated = [
      pieces[0]!,
      {
        ...second,
        start,
        polygon: hull([
          start.minus,
          start.center,
          start.plus,
          second.end.minus,
          second.end.center,
          second.end.plus,
        ]),
      },
    ];
    expect(checkStrokeInventory(f13, mutated).findings.join('\n')).toMatch(
      /does not share the triple/,
    );
  });

  it('ST-O2 control: a stroked implicit closing edge is rejected (ST-D4)', () => {
    const f12 = fixture('ST-F12').source;
    const closed: StrokeOracleSource = { ...f12, verbs: [...Array.from(f12.verbs), 3] };
    const extra = syntheticDump(closed);
    expect(checkStrokeInventory(f12, extra).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ST-O3, ST-O4 and ST-O5 on hand-made meshes, with positive controls

const MESH_FIXTURES = [
  'ST-F1',
  'ST-F2',
  'ST-F4/miter-2',
  'ST-F6/miter-4',
  'ST-F8/square',
  'ST-F10',
  'ST-F11/miter-2-round',
  'ST-F14/a',
  'ST-F14/b',
  'ST-F19',
];

describe('ST-O3 resolution, ST-O4 exact region and ST-O5 membership', () => {
  it.each(MESH_FIXTURES)('%s: a conforming cell mesh of the ideal region passes', (id) => {
    const entry = fixture(id);
    const mesh = cellMesh(idealCells(entry.source));
    const resolution = checkStrokeResolution(syntheticDump(entry.source), mesh, 'exact', 2 ** -5);
    expect(resolution.findings).toEqual([]);
    expect(strokeAreaEquals(resolution.meshArea!, entry.expected.area!)).toBe(true);
    const exact = checkStrokeExactRegion(entry.source, mesh);
    expect(exact.findings).toEqual([]);
    expect(strokeAreaEquals(exact.idealArea!, entry.expected.area!)).toBe(true);
  });

  it('ST-F21: the thin rectangle', () => {
    const entry = fixture('ST-F21');
    const h = 2 ** -21;
    const mesh = withBoundary([0, -h, 4, -h, 4, h, 0, h], [0, 1, 2, 0, 2, 3]);
    expect(checkStrokeExactRegion(entry.source, mesh).findings).toEqual([]);
    expect(
      checkStrokeResolution(syntheticDump(entry.source), mesh, 'exact', 2 ** -5).findings,
    ).toEqual([]);
  });

  const cross = fixture('ST-F14/a');
  const crossMesh = cellMesh(idealCells(cross.source));
  const crossPieces = syntheticDump(cross.source);
  const mutate = (change: (indices: number[], boundary: number[]) => void): StrokeOracleMesh => {
    const indices = Array.from(crossMesh.indices);
    const boundary = Array.from(crossMesh.boundaryEdges);
    change(indices, boundary);
    return {
      ...crossMesh,
      indices: Uint32Array.from(indices),
      boundaryEdges: Uint32Array.from(boundary),
    };
  };

  it('ST-O3 control: a dropped triangle is rejected', () => {
    const mesh = mutate((indices) => indices.splice(6, 3));
    expect(checkStrokeResolution(crossPieces, mesh, 'exact', 2 ** -5).ok).toBe(false);
    expect(checkStrokeExactRegion(cross.source, mesh).ok).toBe(false);
  });

  it('ST-O3 control: a flipped triangle is rejected', () => {
    const mesh = mutate((indices) => {
      [indices[1], indices[2]] = [indices[2]!, indices[1]!];
    });
    expect(checkStrokeResolution(crossPieces, mesh, 'exact', 2 ** -5).findings.join('\n')).toMatch(
      /not strictly positive/,
    );
  });

  it('ST-O3 control: a duplicated triangle is rejected', () => {
    const mesh = mutate((indices) => indices.push(indices[0]!, indices[1]!, indices[2]!));
    expect(checkStrokeResolution(crossPieces, mesh, 'exact', 2 ** -5).findings.join('\n')).toMatch(
      /overlap/,
    );
  });

  it('ST-O3 control: a dropped boundary pair is rejected', () => {
    const mesh = mutate((_, boundary) => boundary.splice(0, 2));
    expect(checkStrokeResolution(crossPieces, mesh, 'exact', 2 ** -5).findings.join('\n')).toMatch(
      /boundaryEdges differs/,
    );
  });

  it('ST-O3 control: a clockwise piece changes the union (ST-D13)', () => {
    const f14b = fixture('ST-F14/b');
    const mesh = cellMesh(idealCells(f14b.source));
    const pieces = syntheticDump(f14b.source);
    const flipped = pieces.map((piece, index) =>
      index === 0 ? { ...piece, polygon: [...piece.polygon!].reverse() } : piece,
    );
    expect(checkStrokeResolution(pieces, mesh, 'exact', 2 ** -5).ok).toBe(true);
    expect(checkStrokeResolution(flipped, mesh, 'exact', 2 ** -5).ok).toBe(false);
  });

  it('ST-O3 band mode accepts a boundary moved by less than tau and rejects a larger change', () => {
    const f1 = fixture('ST-F1');
    const pieces = syntheticDump(f1.source);
    const near = withBoundary([0, -1, 4, -1, 4 + 2 ** -8, 1, 0, 1], [0, 1, 2, 0, 2, 3]);
    expect(checkStrokeResolution(pieces, near, 'exact', 2 ** -5).ok).toBe(false);
    expect(checkStrokeResolution(pieces, near, 'band', 2 ** -5).ok).toBe(true);
    const far = withBoundary([0, -1, 6, -1, 6, 1, 0, 1], [0, 1, 2, 0, 2, 3]);
    expect(checkStrokeResolution(pieces, far, 'band', 2 ** -5).ok).toBe(false);
  });

  it('ST-O3 band control: a translated mesh of equal area is rejected (symmetric difference)', () => {
    const pieces = syntheticDump(fixture('ST-F1').source);
    const moved = withBoundary([100, 49, 104, 49, 104, 51, 100, 51], [0, 1, 2, 0, 2, 3]);
    const result = checkStrokeResolution(pieces, moved, 'band', 2 ** -5);
    expect(result.meshArea).toEqual(result.unionArea);
    expect(result.ok).toBe(false);
    expect(result.findings.join('\n')).toMatch(/symmetric difference/);
    const small = withBoundary(
      [2 ** -8, -1, 4 + 2 ** -8, -1, 4 + 2 ** -8, 1, 2 ** -8, 1],
      [0, 1, 2, 0, 2, 3],
    );
    expect(checkStrokeResolution(pieces, small, 'band', 2 ** -5).ok).toBe(true);
  });

  it('ST-O4 control: the bevel mesh is not the miter region (ST-D2 visible on regions)', () => {
    const miter = fixture('ST-F4/miter-2');
    // The miter region without its unit tip square [4,5]×[-1,0].
    const bevelCells = idealCells(miter.source).filter(([x, y]) => !(x === 4 && y === -1));
    expect(bevelCells).toHaveLength(15);
    expect(checkStrokeExactRegion(miter.source, cellMesh(bevelCells)).ok).toBe(false);
    expect(checkStrokeExactRegion(fixture('ST-F3').source, cellMesh([[0, 0]])).findings).toEqual([
      'the ideal region is not an exact polygon union',
    ]);
  });

  it('ST-O5: literal membership on the mesh, and a wrong expectation is reported', () => {
    const f1 = cellMesh(idealCells(fixture('ST-F1').source));
    expect(
      checkStrokeMembership(f1, [
        { point: [2, 0], inside: true },
        { point: [2, 1.5], inside: false },
        { point: [4, 1], inside: true },
      ]).findings,
    ).toEqual([]);
    expect(checkStrokeMembership(f1, [{ point: [2, 1.5], inside: true }]).ok).toBe(false);
    const f14b = cellMesh(idealCells(fixture('ST-F14/b').source));
    expect(
      checkStrokeMembership(f14b, [
        { point: [4.5, 4.5], inside: true },
        { point: [0.5, 0.5], inside: false },
      ]).findings,
    ).toEqual([]);
  });
});
