// A03 corpus rejections (E11 section 7.2): the closed-list label of a rejected stroke request,
// from its port outcome alone. Only stroke `work-limit` is decided here: the stroke `work-limit`
// class of E11-Q2 (a), which also holds the stroke source caps at limit + 1 (SC17), since the
// port reports both as `work-limit`. Every other outcome keeps its code as its label, and the
// evidence review decides whether it is on the list (the E4 class is a native topology
// diagnosis, ST-U3f, that the port outcome cannot show).

/** The label counted in `strokeClassCounts` for one rejected stroke outcome. */
export function strokeClassLabel(outcome: string): string {
  return outcome === 'failed:work-limit' ? 'stroke-work-limit' : outcome;
}

/**
 * The counting key of a request id: `scene` in the scene phase, otherwise `<stratum>/named` or
 * `<stratum>/generated` (generated rows are `g` and digits), since E11 section 7.2 rules named
 * and generated rows differently.
 */
export function rowKey(phase: string, id: string): string {
  if (phase === 'scene') return 'scene';
  const [stratum, row] = id.split('/') as [string, string];
  return `${stratum}/${/^g\d+$/u.test(row) ? 'generated' : 'named'}`;
}
