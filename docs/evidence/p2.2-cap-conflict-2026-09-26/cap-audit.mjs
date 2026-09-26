// Prospective contract feasibility only. This does not alter the Rust kernel,
// oracle, corpus, work caps, or any acceptance test.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { generateP2GeometryCorpus } from '../../../packages/geometry-reference/dist/index.js';

const midpoint = (a, b) => [a[0] / 2 + b[0] / 2, a[1] / 2 + b[1] / 2];
function requiredLeaves(fixture) {
  const origin = fixture.cubic[0];
  const relative = fixture.cubic.map((point) => [point[0] - origin[0], point[1] - origin[1]]);
  const originalMagnitude = Math.max(1, ...fixture.cubic.flat().map(Math.abs));
  const relativeMagnitude = Math.max(...relative.flat().map(Math.abs));
  const pending = [[relative, 0]];
  let leaves = 0,
    visits = 0,
    maxDepth = 0;
  const depths = {};
  while (pending.length) {
    const [p, depth] = pending.pop();
    if (++visits > 1_048_576)
      throw new Error(`Diagnostic path-work bound exceeded: ${fixture.index}`);
    const guard = 128 * Number.EPSILON * (originalMagnitude + (depth + 1) * relativeMagnitude);
    if (guard >= fixture.bucketTolerance)
      throw new Error(`Guard consumes tolerance: ${fixture.index}`);
    const deviation = (control, numerator) =>
      Math.hypot(
        control[0] - (p[0][0] + (numerator * (p[3][0] - p[0][0])) / 3),
        control[1] - (p[0][1] + (numerator * (p[3][1] - p[0][1])) / 3),
      );
    if (Math.max(deviation(p[1], 1), deviation(p[2], 2)) + guard <= fixture.bucketTolerance) {
      leaves++;
      maxDepth = Math.max(maxDepth, depth);
      depths[depth] = (depths[depth] ?? 0) + 1;
      continue;
    }
    if (depth >= 20) throw new Error(`Diagnostic depth bound exceeded: ${fixture.index}`);
    const a = midpoint(p[0], p[1]),
      b = midpoint(p[1], p[2]),
      c = midpoint(p[2], p[3]);
    const d = midpoint(a, b),
      e = midpoint(b, c),
      f = midpoint(d, e);
    pending.push([[f, e, c, p[3]], depth + 1], [[p[0], a, d, f], depth + 1]);
  }
  return { index: fixture.index, seed: fixture.seed, leaves, visits, maxDepth, depths };
}

const corpus = generateP2GeometryCorpus();
const results = corpus.map(requiredLeaves);
const exceeded = results.filter((result) => result.leaves > 4096);
const worst = results.reduce((best, current) => (current.leaves > best.leaves ? current : best));
console.log(
  JSON.stringify(
    {
      purpose: 'Contract feasibility diagnostic; not acceptance or performance evidence',
      scriptSha256: createHash('sha256')
        .update(readFileSync(new URL(import.meta.url)))
        .digest('hex'),
      corpusVersion: 'p2-geometry/v1',
      cases: results.length,
      frozenLineCap: 4096,
      exceededCount: exceeded.length,
      exceededIndices: exceeded.map((result) => result.index),
      firstFailure: exceeded[0],
      worst,
      allFit8192: results.every((result) => result.leaves <= 8192),
    },
    null,
    2,
  ),
);
