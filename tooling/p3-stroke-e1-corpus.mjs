// P3 rendering-track item E1, unit ST-U10 (manual; not run in CI): writes the failure-heavy
// stroke corpus E1-C1 of the stroke contract's ST-U9 addendum (docs/plans/p3-b2-stroke-contract.md,
// E1.5) as `P3STKIN1` input for the ignored native tests `stroke_dump_tests::emit_stroke_dump`
// (the byte-identical dump of E1.4 item 1) and `stroke_early_abort_tests::e1_c1_differential_sweep`
// (the on-off differential and the max_work sweep of E1.4 item 2).
//
//   node tooling/p3-stroke-e1-corpus.mjs c1 <out.txt>
//
// E1-C1 holds:
// - the ST-U3b chords family: open polylines of 2 to 64 LINE segments on a circle of radius 100
//   at multiples of the golden angle (`stroke_probe_tests.rs`), every join and cap, width 2,
//   miter limit 4, at e = -3 and e = -6;
// - the `edges-N` stacks: N = 8 to 64 square-capped horizontal subpaths `M(0, 4i) L(4, 4i)`,
//   width 2, miter join, e = -3 (ST-F26's `edges-1024` is N = 64);
// - the E1.1 cases: ST-F16 at e = -8, and the playground paths `cusp-f16-large` (ST-F16's
//   playground curve at e = -9), `wide-cubic` and the stroke of `fill-stroke-circle`, in local
//   coordinates. The chords and `edges-1024` cases of E1.1 are already in the families above.
//
// The chord points come from `Math.cos` and `Math.sin`, so their bits may differ from the Rust
// probe's in the last place; the corpus is defined by this generator's output.
import { Buffer } from 'node:buffer';
import fs from 'node:fs';

const [mode, out] = process.argv.slice(2);
if (mode !== 'c1' || !out) {
  console.error('usage: node tooling/p3-stroke-e1-corpus.mjs c1 <out.txt>');
  process.exit(2);
}

const hex = (value) => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return bytes.toString('hex');
};
const lines = ['P3STKIN1'];
const names = new Set();
const add = (name, exponent, width, cap, join, verbs, points) => {
  if (names.has(name)) throw new Error(`duplicate case ${name}`);
  names.add(name);
  for (const value of points) if (!Number.isFinite(value)) throw new Error(`${name}: not finite`);
  lines.push(
    [name, String(exponent), hex(width), cap, join, hex(4), verbs, points.map(hex).join(',')].join(
      '\t',
    ),
  );
};

const CAPS = ['butt', 'round', 'square'];
const JOINS = ['miter', 'round', 'bevel'];
const CHORD_RADIUS = 100;
const GOLDEN_ANGLE = 2.399963229728653;

// The ST-U3b chords family.
for (let segments = 2; segments <= 64; segments += 1) {
  const points = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = GOLDEN_ANGLE * index;
    points.push(CHORD_RADIUS * Math.cos(angle), CHORD_RADIUS * Math.sin(angle));
  }
  const verbs = `0${'1'.repeat(segments)}`;
  for (const exponent of [-3, -6])
    for (const join of JOINS)
      for (const cap of CAPS)
        add(
          `chords-${segments}-${join}-${cap}-e${exponent}`,
          exponent,
          2,
          cap,
          join,
          verbs,
          points,
        );
}

// The edges-N square-capped subpath stacks.
for (let stack = 8; stack <= 64; stack += 1) {
  const points = [];
  for (let row = 0; row < stack; row += 1) points.push(0, row * 4, 4, row * 4);
  add(`edges-${stack}`, -3, 2, 'square', 'miter', '01'.repeat(stack), points);
}

// The remaining E1.1 cases.
const F16 = [0, 0, 1, 1, 0, 1, 1, 0];
add('E1.1/ST-F16-e-8', -8, 0.125, 'butt', 'miter', '02', F16);
add(
  'E1.1/cusp-f16-large-e-9',
  -9,
  0.125,
  'butt',
  'miter',
  '02',
  [-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, -0.5],
);
add('E1.1/wide-cubic-e-3', -3, 24, 'round', 'round', '02', [-55, 25, -10, -60, 10, 60, 55, -25]);
{
  // `circle(0, 0, 30)` of the playground: four cubics from (30, 0), closed.
  const KAPPA = 0.5522847498307936;
  const r = 30;
  const anchors = [
    [r, 0],
    [0, r],
    [-r, 0],
    [0, -r],
    [r, 0],
  ];
  const points = [r, 0];
  for (let index = 0; index < 4; index += 1) {
    const [x0, y0] = anchors[index];
    const [x1, y1] = anchors[index + 1];
    const t0 = [-y0, x0];
    const t1 = [-y1, x1];
    points.push(x0 + KAPPA * t0[0], y0 + KAPPA * t0[1], x1 - KAPPA * t1[0], y1 - KAPPA * t1[1]);
    points.push(x1, y1);
  }
  add('E1.1/fill-stroke-circle-e-3', -3, 8, 'butt', 'round', '022223', points);
}

fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`${lines.length - 1} cases -> ${out}`);
