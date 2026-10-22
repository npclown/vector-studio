// P3 B2 ST-U3e evidence (manual; not run in CI): writes the exact-reversal probe corpora of the
// plan entry "B2 ST-U3d/ST-U3e stroke sharing (review follow-up)" as `P3STKIN1` input for the
// ignored native test `stroke_dump_tests::emit_stroke_dump`.
//
//   node tooling/p3-stroke-reversal-corpus.mjs lines <out.txt>    # 4,800 line-line reversals
//   node tooling/p3-stroke-reversal-corpus.mjs mixed <out.txt>    # line-cubic, cubic-line, seam
//
// Every coordinate is a multiple of 1/8 below 2^20, so every source point and every difference
// is exact, and each join below is an exact reversal: cross(d_in, d_out) = 0, dot < 0.
import { Buffer } from 'node:buffer';
import fs from 'node:fs';

const [mode, out] = process.argv.slice(2);
if (!['lines', 'mixed'].includes(mode) || !out) {
  console.error('usage: node tooling/p3-stroke-reversal-corpus.mjs lines|mixed <out.txt>');
  process.exit(2);
}

const hex = (value) => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return bytes.toString('hex');
};
const lines = ['P3STKIN1'];
const add = (name, exponent, width, cap, join, verbs, points) => {
  for (const value of points) {
    if (!Number.isInteger(value * 8) || Math.abs(value) >= 2 ** 20)
      throw new Error(`${name}: not exact`);
  }
  lines.push(
    [name, String(exponent), hex(width), cap, join, hex(4), verbs, points.map(hex).join(',')].join(
      '\t',
    ),
  );
};

const dirs = [
  [3, 1],
  [1, 7],
  [33, 13],
  [5, 2],
  [7, 3],
  [2, 9],
  [11, -4],
  [-6, 5],
  [13, 11],
  [1, 3],
];
const ratios = [3, 5, 7, 1.5, 2.5, 0.75, 1.25, 6, 9, 3.75];
const bases = [
  [0, 0],
  [100.5, 37.25],
  [-3.125, 1000],
];

if (mode === 'lines') {
  // M(P) L(P + d) L(P + d - lambda d).
  for (const [a, b] of dirs)
    for (const lambda of ratios)
      for (const [px, py] of bases) {
        for (const [width, exponent] of [
          [12, -3],
          [4, -5],
          [12, 0],
          [2.5, -3],
        ]) {
          for (const cap of ['butt', 'round'])
            for (const join of ['round', 'bevel']) {
              const B = [px + a, py + b];
              const C = [B[0] - lambda * a, B[1] - lambda * b];
              add(
                `xrev-${a},${b}-${lambda}-${px},${py}-${width}-${exponent}-${cap}-${join}`,
                exponent,
                width,
                cap,
                join,
                '011',
                [px, py, ...B, ...C],
              );
            }
        }
      }
} else {
  // Width 2, round join, butt caps, e = 1 and -3: line -> cubic, cubic -> line, closed seam.
  for (const [a, b] of dirs)
    for (const lambda of ratios.slice(0, 6))
      for (const [px, py] of bases.slice(0, 2)) {
        for (const exponent of [1, -3]) {
          const d = [a, b];
          const n = [-b, a];
          const P = [px, py];
          const B = [px + a, py + b];
          // Line then a cubic leaving B along -d: first control B - lambda d.
          const lc = [
            ...P,
            ...B,
            B[0] - lambda * d[0],
            B[1] - lambda * d[1],
            B[0] - 2 * lambda * d[0] + n[0],
            B[1] - 2 * lambda * d[1] + n[1],
            B[0] - 3 * lambda * d[0] + 2 * n[0],
            B[1] - 3 * lambda * d[1] + 2 * n[1],
          ];
          add(
            `xlc-${a},${b}-${lambda}-${px},${py}-${exponent}`,
            exponent,
            2,
            'butt',
            'round',
            '012',
            lc,
          );
          // A cubic arriving at B along d (last control B - d), then a line back by lambda d.
          const cl = [
            P[0] - n[0],
            P[1] - n[1],
            P[0] + n[0],
            P[1] + n[1],
            B[0] - d[0],
            B[1] - d[1],
            ...B,
            B[0] - lambda * d[0],
            B[1] - lambda * d[1],
          ];
          add(
            `xcl-${a},${b}-${lambda}-${px},${py}-${exponent}`,
            exponent,
            2,
            'butt',
            'round',
            '021',
            cl,
          );
          // Closed: M(P) L(P + d) L(P + d + n) L(P + 4 lambda d) Z; the seam at P is a reversal.
          const seam = [
            ...P,
            ...B,
            B[0] + n[0],
            B[1] + n[1],
            P[0] + 4 * lambda * d[0],
            P[1] + 4 * lambda * d[1],
          ];
          add(
            `xseam-${a},${b}-${lambda}-${px},${py}-${exponent}`,
            exponent,
            2,
            'butt',
            'round',
            '01113',
            seam,
          );
        }
      }
}
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`${lines.length - 1} cases -> ${out}`);
