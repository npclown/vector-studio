import type { Dash } from '@vector-studio/model';

// MVP M4 contract, M4-P5: the dashes of a line's open segment P0 → P1, computed in editor-core
// by E24-K1, K2, K3 and K5 (docs/plans/d9-e24-dash-contract.md, section 3) for the fill mode of
// a dashed line with arrowheads. Arc length runs from P0; the arithmetic follows renderer-core's
// `expandDash` on a single line (binary64, the same order), which editor-core cannot import.

/** E24-K8: more dashes than this on one stroke is the renderer's `dash-limit`. */
export const LINE_DASH_LIMIT = 4_096;

/** One dash: the closed arc-length interval `[s0, s1]` of `[0, L]`, `s0 = s1` allowed. */
export type LineDash = Readonly<{ s0: number; s1: number }>;

/**
 * The dashes of a segment of length `length > 0` under `dash`, left to right, or null when
 * there are more than `limit` of them (counted on the whole segment, M4-P5).
 */
export function lineDashes(length: number, dash: Dash, limit = LINE_DASH_LIMIT): LineDash[] | null {
  // E24-K1: an odd pattern is repeated once; the period is summed left to right.
  const pattern =
    dash.pattern.length % 2 === 1 ? [...dash.pattern, ...dash.pattern] : [...dash.pattern];
  let period = 0;
  for (const entry of pattern) period += entry;
  let phase = dash.phase % period;
  if (phase < 0) phase += period;
  if (phase >= period) phase = 0;
  // A pattern whose gaps are all 0 is on everywhere: one dash over the whole segment.
  let solid = true;
  for (let index = 1; index < pattern.length; index += 2) solid &&= pattern[index] === 0;
  if (solid) return limit >= 1 ? [{ s0: 0, s1: length }] : null;

  const dashes: { s0: number; s1: number }[] = [];
  // Period m starts at m·P − φ; m = −1 covers an on-interval that ends exactly at s = 0.
  for (let m = -1; ; m += 1) {
    const base = m * period - phase;
    if (base > length) break;
    // Every period after the first two lies inside [0, L] up to its gap > 0, which ends a
    // dash, so more periods than this means more dashes than the limit (and bounds the work).
    if (m > limit + 3) return null;
    let offset = 0;
    for (let index = 0; index < pattern.length; index += 2) {
      const lo = base + offset;
      const hi = lo + pattern[index]!;
      // A zero gap before this on-entry joins it to the previous one by structure.
      const joined = pattern[index === 0 ? pattern.length - 1 : index - 1] === 0;
      offset += pattern[index]! + pattern[index + 1]!;
      if (hi < 0 || lo > length) continue;
      const s0 = lo < 0 ? 0 : lo;
      const s1 = hi > length ? length : hi;
      const previous = dashes[dashes.length - 1];
      if (previous !== undefined && (joined || s0 <= previous.s1)) {
        if (s1 > previous.s1) previous.s1 = s1;
        continue;
      }
      dashes.push({ s0, s1 });
      if (dashes.length > limit) return null;
    }
  }
  return dashes;
}
