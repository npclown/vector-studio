// P3 B2 ST-U3d/ST-U3e evidence (manual; not run in CI): compares two `P3STKDUMP1` dumps of the
// same input, case by case, and checks that every change is a shared-point change of the plan
// entry "B2 ST-U3d/ST-U3e stroke sharing (review follow-up)":
//
// - the case sets are equal: a case present in only one dump is a violation;
// - the request, subpaths, piece count and piece metadata are equal;
// - a segment's start triple changes only after an exact reversal, to the incoming end triple
//   with E- and E+ swapped, bit for bit;
// - piece samples differ only by that triple;
// - every added piece point is a triple's E-, E+ or centre;
// - every removed point is a replaced reversal-triple point, a triple centre, or a disk vertex
//   of a round piece within `(3.125k + 7) u (|c|inf + r)` of a triple point (k from the piece's
//   disk count), where a disk vertex needs a segment centre at distance r (a disk vertex with no
//   such centre is a violation, not a zero ratio);
// - a triple centre is an exact source point. It may enter or leave a piece's point set only as
//   a hull-membership flip: it is a centre in both dumps, it lies inside or on the convex hull
//   (exact rational arithmetic) of the point set that does not contain it (an added centre
//   inside the hull of the before points, a removed centre inside the hull of the after points),
//   and another, non-centre point of the same piece changed too (a centre that changes alone is
//   a dropped or added centre, not a flip). Any other centre change is a violation;
// - a status changes only from unsupported-geometry to ok.
//
//   node tooling/p3-stroke-dump-diff.mjs <before.dump> <after.dump>
//
// Exits 1 on any violation. The dumps come from the ignored native test
// `stroke_dump_tests::emit_stroke_dump` (P3_STROKE_INPUT, P3_STROKE_DUMP).
import { Buffer } from 'node:buffer';
import fs from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: node tooling/p3-stroke-dump-diff.mjs <before.dump> <after.dump>');
  process.exit(2);
}
const U = 2 ** -53;
const f64 = (hex) => Buffer.from(hex, 'hex').readDoubleBE(0);
const read = (path) =>
  new Map(
    fs
      .readFileSync(path, 'utf8')
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const value = JSON.parse(line.slice(line.indexOf(' ') + 1));
        return [value.name, value];
      }),
  );
const key = (point) => point.join(',');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Exact coordinates: a binary64 is m * 2^e, so BigInt(m) << (e + 1074) is an exact integer.
const exact = (hex) => {
  const bits = Buffer.from(hex, 'hex').readBigUInt64BE(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  const mantissa = exponent === 0 ? fraction : fraction | (1n << 52n);
  const value = mantissa << BigInt((exponent === 0 ? 1 : exponent) - 1);
  return bits >> 63n === 1n ? -value : value;
};
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const hullOf = (points) => {
  const sorted = [...new Map(points.map((p) => [key(p), p.map(exact)])).values()].sort((p, q) =>
    p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0,
  );
  if (sorted.length < 3) return sorted;
  const chain = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0n) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...chain(sorted), ...chain([...sorted].reverse())];
};
const insideOrOn = (hull, point) => {
  const p = point.map(exact);
  if (hull.length === 0) return false;
  if (hull.length === 1) return hull[0][0] === p[0] && hull[0][1] === p[1];
  if (hull.length === 2) {
    const [a, b] = hull;
    const within = (v, x, y) => v >= (x < y ? x : y) && v <= (x > y ? x : y);
    return cross(a, b, p) === 0n && within(p[0], a[0], b[0]) && within(p[1], a[1], b[1]);
  }
  for (let i = 0; i < hull.length; i++) {
    if (cross(hull[i], hull[(i + 1) % hull.length], p) < 0n) return false;
  }
  return true;
};

const before = read(beforePath);
const after = read(afterPath);
const tally = {
  cases: before.size,
  identical: 0,
  changed: 0,
  failToOk: 0,
  okChanged: 0,
  reversalTriples: 0,
  snappedVertices: 0,
  centreFlips: 0,
  maxSnapUR: 0,
};
const violations = [];
for (const name of after.keys()) {
  if (!before.has(name)) violations.push(`${name}: missing before`);
}
for (const [name, a] of before) {
  const b = after.get(name);
  if (!b) {
    violations.push(`${name}: missing after`);
    continue;
  }
  if (same(a, b)) {
    tally.identical++;
    continue;
  }
  tally.changed++;
  const bad = (message) => violations.push(`${name}: ${message}`);
  if (a.status === b.status) {
    if (a.status === 'ok') tally.okChanged++;
  } else if (a.status === 'unsupported-geometry' && b.status === 'ok') tally.failToOk++;
  else bad(`status ${a.status} -> ${b.status}`);
  if (!same(a.request, b.request) || !same(a.subpaths, b.subpaths)) bad('request or subpaths');
  // Segments: only a start triple after an exact reversal may change.
  const replaced = new Map();
  if (a.segments.length !== b.segments.length) bad('segment count');
  for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
    const { start: s1, ...rest1 } = a.segments[i];
    const { start: s2, ...rest2 } = b.segments[i];
    if (!same(rest1, rest2)) bad(`segment ${i} fields`);
    if (same(s1, s2)) continue;
    const previous = b.segments.find(
      (segment) => segment.join?.next === i && segment.join.class === 'reversal',
    );
    if (!previous || !same(s2, [previous.end[2], previous.end[1], previous.end[0]]))
      bad(`segment ${i} start is not a swapped reversal triple`);
    replaced.set(key(s1[0]), s2[0]);
    replaced.set(key(s1[2]), s2[2]);
    tally.reversalTriples++;
  }
  const outer = new Set();
  const centres = new Set();
  for (const segment of b.segments) {
    for (const t of [segment.start, segment.end]) {
      outer.add(key(t[0]));
      outer.add(key(t[2]));
      centres.add(key(t[1]));
    }
  }
  const centresBefore = new Set();
  for (const segment of a.segments) {
    for (const t of [segment.start, segment.end]) centresBefore.add(key(t[1]));
  }
  const r = f64(b.request.width) / 2;
  const pieces1 = a.pieces ?? [];
  const pieces2 = b.pieces ?? [];
  if (pieces1.length !== pieces2.length) {
    bad('piece count');
    continue;
  }
  for (let i = 0; i < pieces1.length; i++) {
    const { points: p1 = [], samples: m1, ...rest1 } = pieces1[i];
    const { points: p2 = [], samples: m2, ...rest2 } = pieces2[i];
    if (!same(rest1, rest2)) bad(`piece ${i} metadata`);
    const mapped = JSON.stringify(m1).replace(/\["[0-9a-f]{16}","[0-9a-f]{16}"\]/g, (text) => {
      const to = replaced.get(JSON.parse(text).join(','));
      return to ? JSON.stringify(to) : text;
    });
    if (mapped !== JSON.stringify(m2)) bad(`piece ${i} samples`);
    const set1 = new Set(p1.map(key));
    const set2 = new Set(p2.map(key));
    // A hull flip needs a cause: some non-centre point of the piece must have changed too.
    const others1 = p1.filter((point) => !centres.has(key(point))).map(key);
    const others2 = p2.filter((point) => !centres.has(key(point))).map(key);
    const caused = !same(others1.sort(), others2.sort());
    let hull1;
    let hull2;
    for (const point of p2) {
      if (set1.has(key(point))) continue;
      if (centres.has(key(point))) {
        hull1 ??= hullOf(p1);
        if (caused && centresBefore.has(key(point)) && insideOrOn(hull1, point))
          tally.centreFlips++;
        else bad(`piece ${i} added a centre that is not a hull-membership flip`);
      } else if (!outer.has(key(point))) bad(`piece ${i} added a point that is not a triple point`);
    }
    for (const point of p1) {
      if (set2.has(key(point)) || replaced.has(key(point))) continue;
      if (centres.has(key(point))) {
        hull2 ??= hullOf(p2);
        if (caused && centresBefore.has(key(point)) && insideOrOn(hull2, point))
          tally.centreFlips++;
        else bad(`piece ${i} removed a centre that is not a hull-membership flip`);
        continue;
      }
      const round = pieces2[i].kind.startsWith('round') || pieces2[i].kind === 'cusp-disk';
      if (!round || !pieces2[i].disk) {
        bad(`piece ${i} (${pieces2[i].kind}) removed a point`);
        continue;
      }
      const q = point.map(f64);
      let nearest = Infinity;
      for (const t of outer) {
        const p = t.split(',').map(f64);
        nearest = Math.min(nearest, Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])));
      }
      // The disk's centre is the segment centre at distance r from the removed vertex.
      let reach = Infinity;
      for (const segment of b.segments) {
        for (const t of [segment.start, segment.end]) {
          const c = t[1].map(f64);
          if (Math.abs(Math.hypot(q[0] - c[0], q[1] - c[1]) - r) < 1e-6 * r) {
            reach = Math.min(reach, Math.max(Math.abs(c[0]), Math.abs(c[1])) + r);
          }
        }
      }
      if (reach === Infinity) {
        bad(`piece ${i} removed a disk vertex with no segment centre at distance r`);
        continue;
      }
      const level = Math.log2(pieces2[i].disk) - 2;
      const ratio = nearest / (U * reach);
      tally.snappedVertices++;
      tally.maxSnapUR = Math.max(tally.maxSnapUR, ratio);
      if (!(ratio <= 3.125 * level + 7))
        bad(`piece ${i} removed a disk vertex ${ratio} u*R from a triple point (k = ${level})`);
    }
  }
}
console.log(JSON.stringify(tally));
for (const line of violations) console.log(`VIOLATION ${line}`);
process.exit(violations.length ? 1 : 0);
