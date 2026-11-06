import type { PagePoint, PathAnchor } from '@vector-studio/editor-core';

// V-25 slice 8 (pen curves): what the studio overlay draws while the path tool has anchors. The
// M2 overlay drew a polyline through the anchor points, so a press-and-drag anchor (a cubic,
// symmetric handles) looked straight until Enter. Here the pending path is drawn as it will be
// created: a line where neither end has a handle, else the cubic the tool builds (`from.out`,
// `to.in`, a missing handle at its anchor). The last anchor's handles show while they are set,
// and with the pointer over the canvas the next segment runs to it (a rubber band). Host only.

/** A point in CSS px over the canvas. */
type Point = readonly [number, number];
type ToScreen = (x: number, y: number) => [number, number];

/** The path tool closes on a press this many CSS px from the first anchor (`CLOSE_RADIUS`). */
export const PEN_CLOSE_RADIUS = 4;

export type PenPreview = Readonly<{
  /** The pending path's SVG `d`, in CSS px. */
  path: string;
  /** The segment from the last anchor to the pointer, or null without a pointer. */
  next: string | null;
  /** The last anchor's handles: the anchor and each set handle's end. */
  handles: readonly Readonly<{ from: Point; to: Point }>[];
  anchors: readonly Point[];
  /** The pointer is over the first anchor of two or more, so a press closes the path. */
  closing: boolean;
}>;

const fmt = ([x, y]: Point) => `${x} ${y}`;

function segment(from: PathAnchor, to: PathAnchor, toScreen: ToScreen): string {
  const end = toScreen(to.point.x, to.point.y);
  if (from.out === null && to.in === null) return ` L ${fmt(end)}`;
  const c1 = from.out ?? from.point;
  const c2 = to.in ?? to.point;
  return ` C ${fmt(toScreen(c1.x, c1.y))} ${fmt(toScreen(c2.x, c2.y))} ${fmt(end)}`;
}

/** The preview of the pending anchors, with the pointer at page point `cursor` (or none). */
export function penPreview(
  anchors: readonly PathAnchor[],
  cursor: PagePoint | null,
  toScreen: ToScreen,
): PenPreview | null {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (first === undefined || last === undefined) return null;
  const start = toScreen(first.point.x, first.point.y);
  let path = `M ${fmt(start)}`;
  for (let i = 1; i < anchors.length; i += 1)
    path += segment(anchors[i - 1]!, anchors[i]!, toScreen);
  let next: string | null = null;
  let closing = false;
  if (cursor !== null) {
    const at = toScreen(cursor.x, cursor.y);
    closing =
      anchors.length >= 2 && Math.hypot(at[0] - start[0], at[1] - start[1]) <= PEN_CLOSE_RADIUS;
    // A close joins the first anchor with its own in handle, as the tool's closing segment does.
    const target: PathAnchor = closing ? first : { point: cursor, in: null, out: null };
    next = `M ${fmt(toScreen(last.point.x, last.point.y))}${segment(last, target, toScreen)}`;
  }
  const anchor = toScreen(last.point.x, last.point.y);
  const handles = [last.in, last.out]
    .filter((handle): handle is PagePoint => handle !== null)
    .map((handle) => ({ from: anchor, to: toScreen(handle.x, handle.y) }));
  return {
    path,
    next,
    handles,
    anchors: anchors.map(({ point }) => toScreen(point.x, point.y) as Point),
    closing,
  };
}
