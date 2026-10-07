import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { o02Variants } from './coverage-oracle/variants.js';
import {
  bboxMidpoint,
  c2Q,
  certifyLanesCore,
  clearanceAtDeltaQ,
  packLanesCore,
  wedgeTermQ,
  type CoreInput,
  type Q2,
  type Triangle,
} from './extent-t01/core.js';
import { PINNED_SOURCES } from './extent-t01/sources.js';
import type { ProjectionInput } from './mesh-projection/model.js';
import { certifyPosition, q } from './position-certificate/certificate.js';
import { loadFixtureRows, prospectiveRows, termRows } from './position-certificate/corpus.js';
import { clearanceAtDelta } from './position-certificate/r3-window.js';
import { certifyC2, wedgeTerm } from './position-certificate/wedge.js';
import { compare, type Rational } from './rounded-fill/exact.js';

// P3.1p T01: core.ts reproduces the pinned M01/M04/R0a code exactly on binary64 inputs
// (docs/plans/p3-t01-extent-experiment-contract.md, "Cores" and "Implementation details" 1).

const equal = (left: Rational | null | undefined, right: Rational | null | undefined) =>
  left === null || left === undefined
    ? right === null || right === undefined
    : right !== null && right !== undefined && compare(left, right) === 0;

function coreOf(input: ProjectionInput): CoreInput {
  const triangles: Triangle[] = [];
  for (let offset = 0; offset < input.mesh.indices.length; offset += 3)
    triangles.push(input.mesh.indices.slice(offset, offset + 3) as unknown as Triangle);
  return {
    points: input.mesh.vertices.map(([x, y]): Q2 => [q(x), q(y)]),
    triangles,
    affine: input.affine,
    camera: input.camera,
    zoom: input.zoom,
    dpr: input.dpr,
    width: input.width,
    height: input.height,
  };
}

function inputs(): { id: string; input: ProjectionInput }[] {
  return [
    ...loadFixtureRows().map((row) => ({ id: row.id, input: row.input })),
    ...prospectiveRows().map((row) => ({ id: row.id, input: row.input })),
    ...termRows().map((row) => ({ id: row.id, input: row.input })),
    ...o02Variants().map((variant) => ({
      id: `${variant.id}@${variant.dpr}`,
      input: variant.input,
    })),
  ];
}

function identity(input: ProjectionInput) {
  const origin = input.origin;
  const reference = certifyPosition(input, origin);
  const core = coreOf(input);
  const lanes = packLanesCore(
    input.mesh.vertices,
    input.affine,
    input.camera,
    input.zoom,
    input.dpr,
    bboxMidpoint(input.mesh.vertices),
    origin,
  );
  const used = [...new Set(input.mesh.indices)].sort((a, b) => a - b);
  if (reference.reason === 'lane-range' || reference.reason === 'singular') return;
  const errors = certifyLanesCore(core, lanes, used);
  expect(errors).not.toBe('lane-range');
  if (errors === 'lane-range') return;
  for (const vertex of used) {
    expect(equal(errors.get(vertex)!.ex, reference.ex[vertex])).toBe(true);
    expect(equal(errors.get(vertex)!.ey, reference.ey[vertex])).toBe(true);
  }
  const scale = { affine: input.affine, zoom: input.zoom, dpr: input.dpr };
  const base = clearanceAtDelta(input, reference.delta2Max);
  const mine = clearanceAtDeltaQ(core.points, input.mesh.indices, scale, reference.delta2Max);
  expect(mine.term).toBe(base.term);
  expect(mine.slackTerm).toBe(base.slackTerm);
  expect(equal(mine.slack, base.slack)).toBe(true);
  let pinnedWedge: ReturnType<typeof wedgeTerm> | string;
  try {
    pinnedWedge = wedgeTerm(input, reference.delta2Max);
  } catch (error) {
    pinnedWedge = (error as Error).message;
  }
  let coreWedge: ReturnType<typeof wedgeTermQ> | string;
  try {
    coreWedge = wedgeTermQ(core.points, input.mesh.indices, scale, reference.delta2Max);
  } catch (error) {
    coreWedge = (error as Error).message;
  }
  if (typeof pinnedWedge === 'string') {
    expect(coreWedge).toBe(pinnedWedge);
    return;
  }
  if (typeof coreWedge === 'string') throw new Error(`core-wedge:${coreWedge}`);
  expect(coreWedge.term).toBe(pinnedWedge.term);
  expect(coreWedge.worst?.vertex).toBe(pinnedWedge.worst?.vertex);
  expect(coreWedge.worst?.margin).toBe(pinnedWedge.worst?.margin);
  expect(equal(coreWedge.worst?.slack, pinnedWedge.worst?.slack)).toBe(true);
  const c2 = certifyC2(input, origin);
  if (!reference.reason?.startsWith('position:'))
    expect(c2Q(core.points, input.mesh.indices, scale, reference.delta2Max).term).toBe(
      c2.clearance.term,
    );
}

describe('P3.1p T01 cores', () => {
  it('keeps the pinned sources byte-unchanged', () => {
    for (const [path, sha256] of Object.entries(PINNED_SOURCES))
      expect(createHash('sha256').update(readFileSync(path)).digest('hex'), path).toBe(sha256);
  });

  const all = inputs();
  const chunk = Math.ceil(all.length / 6);
  for (let start = 0; start < all.length; start += chunk) {
    const slice = all.slice(start, start + chunk);
    it(
      `reproduces certifyPosition, clearanceAtDelta, wedgeTerm and certifyC2 (rows ${start}..${start + slice.length - 1})`,
      { timeout: 60_000 },
      () => {
        for (const { input } of slice) identity(input);
      },
    );
  }
});
