// P3 B2 ST-U3d/ST-U3e evidence (manual; not run in CI): compares two `P3STKDUMP1` dumps of the
// same input, case by case, and checks that every change is a shared-point change of the plan
// entry "B2 ST-U3d/ST-U3e stroke sharing (review follow-up)":
//
// - the request, subpaths, piece count and piece metadata are equal;
// - a segment's start triple changes only after an exact reversal, to the incoming end triple
//   with E- and E+ swapped, bit for bit;
// - piece samples differ only by that triple;
// - every added piece point is a triple's E-, E+ or centre;
// - every removed point is a replaced reversal-triple point, a triple centre, or a disk vertex
//   of a round piece within `(3.125k + 7) u (|c|inf + r)` of a triple point (k from the piece's
//   disk count);
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
    for (const point of p2) {
      if (set1.has(key(point))) continue;
      if (centres.has(key(point))) tally.centreFlips++;
      else if (!outer.has(key(point))) bad(`piece ${i} added a point that is not a triple point`);
    }
    for (const point of p1) {
      if (set2.has(key(point)) || replaced.has(key(point))) continue;
      if (centres.has(key(point))) {
        tally.centreFlips++;
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
