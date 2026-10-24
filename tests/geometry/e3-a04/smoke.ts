// D9 E3 unit E3-U3: the harness's smoke cases (contract section 15.6). They are not corpus
// cases: their paths are written here, so running the kernel on them reads no kernel output on
// the corpus before the freeze (section 5.5). `pnpm e3-a04:run --smoke` and the WASM harness
// test run them.
import type { A04Case } from '../../../packages/geometry-reference/src/a04-region.js';
import { transformMatrix, type TransformId } from './corpus.js';
import { fill, makeCase, polygon, rect, stroke, type CasePaint } from './oracle-cases.js';

/** Section 13.7's centre placement: the world box of L·x + t centred, snapped to 2^-8. */
export function centerCamera(
  points: readonly number[],
  l: readonly [number, number, number, number],
  t: readonly [number, number],
  zoom: number,
): [number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const x = l[0] * points[i]! + l[1] * points[i + 1]! + t[0];
    const y = l[2] * points[i]! + l[3] * points[i + 1]! + t[1];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const snap = (v: number) => Math.floor(v * 256 + 0.5) / 256;
  return [snap((minX + maxX) / 2 - 320 / zoom), snap((minY + maxY) / 2 - 180 / zoom)];
}

/** A harness case with the centre placement. */
export function harnessCase(
  spec: Readonly<{
    id: string;
    verbs: string;
    points: readonly number[];
    paint: CasePaint;
    transform?: TransformId;
    t?: readonly [number, number];
    zoom?: number;
    dpr?: number;
    c?: readonly [number, number];
  }>,
): A04Case {
  const l = transformMatrix(spec.transform ?? 'T0');
  const t = spec.t ?? [0, 0];
  const zoom = spec.zoom ?? 1;
  return {
    ...makeCase({
      id: spec.id,
      verbs: spec.verbs,
      points: spec.points,
      paint: spec.paint,
      l,
      t,
      zoom,
      dpr: spec.dpr ?? 1,
      c: spec.c ?? centerCamera(spec.points, l, t, zoom),
    }),
    transform: spec.transform ?? 'T0',
  };
}

export type SmokeCase = Readonly<{
  id: string;
  kase: A04Case;
  expect: 'pass' | 'runs';
  /**
   * The oracle takes minutes on it (stroke regions, section 15.6): the WASM test only draws it,
   * and `pnpm e3-a04:run --smoke` measures it.
   */
  slow?: boolean;
}>;

const BLOB = {
  verbs: 'MCCCCZ',
  points: [
    0.1, 5.3, 0.7, 1.9, 3.3, 0.2, 5.1, 0.3, 7.7, 0.4, 10.3, 2.9, 10.1, 5.3, 9.9, 8.1, 7.3, 10.3,
    5.1, 10.1, 2.9, 9.9, -0.3, 8.7, 0.1, 5.3,
  ],
};
const POLYLINE = { verbs: 'MLLL', points: [0, 0, 40, 0, 40, 30, 70, 10] };

export const SMOKE_CASES: readonly SmokeCase[] = [
  {
    id: 'smoke/rect/T0/z1-d1',
    kase: harnessCase({ id: 'smoke/rect/T0/z1-d1', ...polygon(rect(0, 0, 96, 48)), paint: fill() }),
    expect: 'pass',
  },
  {
    id: 'smoke/rect/T0/z64-d3',
    kase: harnessCase({
      id: 'smoke/rect/T0/z64-d3',
      ...polygon(rect(0, 0, 4, 2)),
      paint: fill(),
      zoom: 64,
      dpr: 3,
    }),
    expect: 'pass',
  },
  {
    id: 'smoke/blob/T2/z1-d2',
    kase: harnessCase({
      id: 'smoke/blob/T2/z1-d2',
      ...BLOB,
      paint: fill(),
      transform: 'T2',
      dpr: 2,
    }),
    expect: 'pass',
  },
  {
    id: 'smoke/segment-butt/T0/z1-d1',
    kase: harnessCase({
      id: 'smoke/segment-butt/T0/z1-d1',
      verbs: 'ML',
      points: [0, 0, 32, 0],
      paint: stroke(4, 'butt', 'miter', 4),
    }),
    expect: 'pass',
    slow: true,
  },
  {
    id: 'smoke/polyline-miter/T0/z1-d1',
    kase: harnessCase({
      id: 'smoke/polyline-miter/T0/z1-d1',
      ...POLYLINE,
      paint: stroke(3, 'butt', 'miter', 4),
    }),
    expect: 'pass',
    slow: true,
  },
];
