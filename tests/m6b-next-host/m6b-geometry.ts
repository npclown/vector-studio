import type { TextLayoutResult } from '@vector-studio/contracts';

// M6b-U9 (MVP M6b contract, section 4.3): an independent reading of the caret and selection
// geometry rules over a node's `TextLayoutResult`, for the headed spec to check the editor's
// `textEditOverlay` and its caret movement against the clusters the real port measured. It
// follows the contract's text, not `packages/editor-core/src/text-caret.ts`; the fixture has no
// long grapheme (M6a-L1's pieces), no negative advance and one run per node, so those rules are
// not needed here.

export type Point = Readonly<{ x: number; y: number }>;
export type Affinity = 'downstream' | 'upstream';
export type Frame = Readonly<{ x: number; y: number; width: number; height: number }>;
export type Placement = Readonly<{ frame: Frame; rotation: number }>;

export class Reference {
  constructor(
    readonly text: string,
    readonly layout: TextLayoutResult,
    /** The box width caret x is clamped to in the wrapping modes, else null (M6b-Q11 (a)). */
    readonly clampWidth: number | null,
  ) {}

  get lines() {
    return this.layout.lines;
  }

  /** Whether line `index` ends at a soft wrap: its end is the next line's start. */
  softWrapAfter(index: number): boolean {
    const next = this.lines[index + 1];
    return next !== undefined && next.start === this.lines[index]!.end;
  }

  /** The line of `offset`: start ≤ offset ≤ end; at a soft wrap the affinity picks. */
  lineOf(offset: number, affinity: Affinity): number {
    const index = this.lines.findIndex((line) => line.start <= offset && offset <= line.end);
    if (index === -1) return offset <= 0 ? 0 : this.lines.length - 1;
    if (
      affinity === 'downstream' &&
      offset === this.lines[index]!.end &&
      this.softWrapAfter(index)
    ) {
      return index + 1;
    }
    return index;
  }

  private clamp(x: number): number {
    return this.clampWidth === null ? x : Math.min(x, this.clampWidth);
  }

  /** Caret x: the first cluster of the line starting at `offset`, else the last ending there. */
  caretX(offset: number, index: number): number {
    const clusters = this.layout.clusters.filter((cluster) => cluster.line === index);
    const starting = clusters.find((cluster) => cluster.start === offset);
    if (starting !== undefined) return this.clamp(starting.x);
    const ending = clusters.filter((cluster) => cluster.end === offset).at(-1);
    if (ending !== undefined) return this.clamp(ending.x + ending.advance);
    return this.clamp(this.lines[index]!.left);
  }

  /** The caret segment, node-local. */
  caret(offset: number, affinity: Affinity): readonly [Point, Point] {
    const index = this.lineOf(offset, affinity);
    const line = this.lines[index]!;
    const x = this.caretX(offset, index);
    return [
      { x, y: line.top },
      { x, y: line.top + line.height },
    ];
  }

  /** The nearest stop on a line: cluster starts and the line end, ties to the earlier stop. */
  nearestOnLine(index: number, x: number): Readonly<{ offset: number; affinity: Affinity }> {
    const line = this.lines[index]!;
    const candidates = [
      ...this.layout.clusters.filter((c) => c.line === index).map((c) => c.start),
      line.end,
    ];
    let best = candidates[0]!;
    let distance = Infinity;
    for (const offset of [...new Set(candidates)].sort((a, b) => a - b)) {
      const d = Math.abs(this.caretX(offset, index) - x);
      if (d < distance) {
        best = offset;
        distance = d;
      }
    }
    const upstream = best === line.end && this.softWrapAfter(index);
    return { offset: best, affinity: upstream ? 'upstream' : 'downstream' };
  }

  /** Point to offset, for a node-local point. */
  pointToOffset(point: Point): Readonly<{ offset: number; affinity: Affinity }> {
    let index = this.lines.findIndex((line) => line.top + line.height > point.y);
    if (index === -1) index = this.lines.length - 1;
    return this.nearestOnLine(index, point.x);
  }

  /** Selection rectangles of `[min, max)` over lines whose content meets it (no LF selected). */
  selection(min: number, max: number): { x: number; y: number; width: number; height: number }[] {
    const out: { x: number; y: number; width: number; height: number }[] = [];
    this.lines.forEach((line, index) => {
      const a = Math.max(min, line.start);
      const b = Math.min(max, line.end);
      if (!(a < b)) return;
      if (this.text.charCodeAt(line.end) === 10 && min <= line.end && line.end < max) {
        throw new Error('the reference does not cover a selected LF');
      }
      const xs = [this.caretX(a, index), this.caretX(b, index)];
      for (const cluster of this.layout.clusters) {
        if (cluster.line !== index || cluster.start < a || cluster.end > b) continue;
        xs.push(this.clamp(cluster.x), this.clamp(cluster.x + cluster.advance));
      }
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      out.push({ x: left, y: line.top, width: right - left, height: line.height });
    });
    return out;
  }
}

/** Node-local to page for a page-root node: rotation about the frame centre (M1). */
export function toPage(placement: Placement, point: Point): Point {
  const { frame, rotation } = placement;
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = point.x - hw;
  const dy = point.y - hh;
  return { x: frame.x + hw + dx * cos - dy * sin, y: frame.y + hh + dx * sin + dy * cos };
}

/** Page to node-local, the inverse of `toPage`. */
export function toLocal(placement: Placement, point: Point): Point {
  const { frame, rotation } = placement;
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = point.x - frame.x - hw;
  const dy = point.y - frame.y - hh;
  return { x: hw + dx * cos + dy * sin, y: hh - dx * sin + dy * cos };
}
