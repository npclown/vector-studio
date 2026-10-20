// P3 Alt-A1 AL-OB5 workload corpus `p3-al-ob5-workload/v1`, fixed by
// docs/plans/p3-al-ob5-workload-scenario-proposal.md section 2.1 (OB5-U1). It applies B0's
// generator `p3-b0-ring/v1` unchanged to three new cells through the B0 module's own
// `generateCellPaths` and `encodeCorpus`; no B0 module is edited. Erasable TypeScript only.

import { BULGE_BY_LAMBDA, encodeCorpus, type CellSpec } from '../p3-b0/corpus.js';

export const OB5_SCENARIO_ID = 'p3-al-ob5-workload';
export const OB5_SCENARIO_VERSION = 1;
export const OB5_PATHS = 1000;
export const OB5_CUBICS = 32;

function ob5Cell(
  id: string,
  lambda: 2 | 4 | 8,
  snapped: boolean,
  role: 'decision' | 'o1',
): CellSpec {
  return {
    id,
    series: id,
    role,
    family: 'ring',
    entry: 'attempt',
    contours: 1,
    cubicsPerContour: OB5_CUBICS,
    lambda,
    bulge: BULGE_BY_LAMBDA[lambda]!,
    snapped,
    paths: OB5_PATHS,
  };
}

/** The three decision sets OB5-W2, OB5-W4 and OB5-W8, in corpus order. */
export function ob5DecisionCells(): CellSpec[] {
  return [
    ob5Cell('OB5-W2', 2, true, 'decision'),
    ob5Cell('OB5-W4', 4, true, 'decision'),
    ob5Cell('OB5-W8', 8, true, 'decision'),
  ];
}

/**
 * The untimed generic-coordinate observation of OB5-Q7 (a): OB5-W8 with `snapped: false`. It is
 * outside the decision sets and outside the decision corpus bytes and hash.
 */
export function ob5ObservationCells(): CellSpec[] {
  return [ob5Cell('OB5-W8U', 8, false, 'o1')];
}

/** The framed decision corpus (B0's `P3B0COR1` framing) of the three snapped sets. */
export function encodeOb5DecisionCorpus(): Uint8Array {
  return encodeCorpus(ob5DecisionCells());
}

/** The framed corpus of the unsnapped observation set, with its own hash. */
export function encodeOb5ObservationCorpus(): Uint8Array {
  return encodeCorpus(ob5ObservationCells());
}

/** Expected fast-mesh counts of a set: vertices V, triangles T and boundary pairs B (section 2.1). */
export function ob5ExpectedCounts(lambda: number) {
  const leaves = OB5_CUBICS * lambda;
  return { vertices: leaves, triangles: leaves - 2, boundaryPairs: leaves };
}
