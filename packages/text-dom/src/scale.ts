import type { TextLayoutRequest, TextLayoutResult } from '@vector-studio/contracts';

// M6-Q3 (b), the reference scale (docs/plans/mvp-m6a-text-model-contract.md, section 3.2):
// text-dom measures and assembles every request at a scale `s` times its sizes and width and
// divides the result's lengths by `s`. Chromium rounds a font's ascent, descent and line gap to
// whole CSS px at the size it lays out, so at page units a line's baseline and height carried up
// to a pixel of rounding that does not scale with the size (M6a-A12 failed by 0.75 px on the main
// PC). Measured at `s` times the size, that rounding is `1/s` px of the result and Chromium's
// 1/64 px layout unit `1/(64 s)` px. `s` is a power of two, so multiplying the request and
// dividing the result are exact in binary64 and results stay deterministic.

/** The reference scale `R` (section 3.2): `s` for a request of sizes ≤ 32 within the extent. */
export const REFERENCE_SCALE = 64;

/**
 * The largest font size the scale may give a run (section 3.2). A larger request is measured at
 * the largest power of two below `R` that keeps its largest run at or under it, never below 1
 * (Chromium clamps a computed `font-size` to 10,000 px; a long node is also bounded by
 * `MAX_MEASURED_EXTENT`). A request whose largest size is above 1024 is measured unscaled, as
 * before M6-Q3 (b).
 */
export const MAX_MEASURED_SIZE = 2048;

/**
 * The largest extent, in measured px, a scaled request may reach (section 3.2): Chromium's layout
 * unit range ends at 2^25 px, so a block wider or taller than that is clamped. A request's extent
 * is bounded by `largest size × (UTF-16 units + 1) × max(lineHeight, 2 + max(0, letterSpacing))`
 * (each unit at most one line, or at most about 2 em plus letter spacing wide; the + 1 is the
 * sentinel line), and the scale is halved until it is at most 2^24, half the range.
 */
export const MAX_MEASURED_EXTENT = 2 ** 24;

/** The extent bound of `request` in page px (see `MAX_MEASURED_EXTENT`). */
export function extentBound(request: TextLayoutRequest): number {
  const largest = Math.max(...request.runs.map((run) => run.size));
  const units = request.runs.reduce((sum, run) => sum + run.text.length, 0) + 1;
  const emPerUnit = Math.max(request.lineHeight, 2 + Math.max(0, request.letterSpacing));
  return largest * units * emPerUnit;
}

/**
 * The scale `s` a request is measured at: `R`, halved while its largest run × `s` exceeds 2048 or
 * its extent bound × `s` exceeds 2^24, never below 1.
 */
export function measurementScale(request: TextLayoutRequest): number {
  const largest = Math.max(...request.runs.map((run) => run.size));
  const extent = extentBound(request);
  let scale = REFERENCE_SCALE;
  while (
    scale > 1 &&
    (largest * scale > MAX_MEASURED_SIZE || extent * scale > MAX_MEASURED_EXTENT)
  ) {
    scale /= 2;
  }
  return scale;
}

/** The request as the measurement block lays it out: sizes and width times `scale`. */
export function scaleRequest(request: TextLayoutRequest, scale: number): TextLayoutRequest {
  // Letter spacing is in em and line height a multiple of the size: both follow the sizes. A
  // width above `Number.MAX_VALUE / scale` is capped there rather than overflowing to `Infinity`
  // (Chromium clamps any such length to its layout unit range, about 2^25 px, either way).
  return {
    ...request,
    runs: request.runs.map((run) => ({ ...run, size: run.size * scale })),
    width: request.width === null ? null : Math.min(request.width * scale, Number.MAX_VALUE),
  };
}

/**
 * A result assembled from `scaleRequest(request, scale)`, in page units: every length divided by
 * `scale`. Assembly runs at the measured scale, so its tolerances stay below Chromium's 1/64 px
 * layout unit there. A fixed width is the request's own.
 */
export function unscaleResult(
  result: TextLayoutResult,
  request: TextLayoutRequest,
  scale: number,
): TextLayoutResult {
  return {
    ...result,
    width: request.width ?? result.width / scale,
    height: result.height / scale,
    lines: result.lines.map((line) => ({
      ...line,
      top: line.top / scale,
      height: line.height / scale,
      baseline: line.baseline / scale,
      left: line.left / scale,
      width: line.width / scale,
    })),
    clusters: result.clusters.map((cluster) => ({
      ...cluster,
      x: cluster.x / scale,
      y: cluster.y / scale,
      advance: cluster.advance / scale,
    })),
  };
}
