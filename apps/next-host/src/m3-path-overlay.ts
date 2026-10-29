import type { Command, EditorSnapshot, PathEditOverlay } from '@vector-studio/editor-core';

// M3-U4 (MVP M3 contract, sections 4 and 5.1): the host side of the next-host page's path edit
// mode, kept pure so it is unit tested without a DOM. The editor decides every behaviour; these
// helpers only draw the `pathOverlay` query result and turn the toggle-closed button into the
// command the `togglePathClosed` action would run.

type Camera = EditorSnapshot['viewport'];

/** An anchor marker in CSS pixels over the canvas. */
export type AnchorMarker = Readonly<{
  subpath: number;
  anchor: number;
  x: number;
  y: number;
  selected: boolean;
  mirrored: boolean;
}>;

/** A visible handle marker in CSS pixels, with its anchor's place for the handle line. */
export type HandleMarker = Readonly<{
  subpath: number;
  anchor: number;
  side: 'in' | 'out';
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
}>;

export type PathMarkers = Readonly<{
  anchors: readonly AnchorMarker[];
  handles: readonly HandleMarker[];
}>;

/**
 * The markers of a `pathOverlay` result at `camera`: CSS px = (page − position) · zoom, one per
 * overlay anchor and one per visible (non-null) handle, in overlay order, `in` before `out`.
 */
export function pathMarkers(overlay: PathEditOverlay | null, camera: Camera): PathMarkers {
  if (overlay === null) return { anchors: [], handles: [] };
  const { position, zoom } = camera;
  const x = (value: number) => (value - position.x) * zoom;
  const y = (value: number) => (value - position.y) * zoom;
  const anchors: AnchorMarker[] = [];
  const handles: HandleMarker[] = [];
  overlay.subpaths.forEach((subpath, s) => {
    subpath.anchors.forEach((entry, a) => {
      const ax = x(entry.point.x);
      const ay = y(entry.point.y);
      anchors.push({
        subpath: s,
        anchor: a,
        x: ax,
        y: ay,
        selected: entry.selected,
        mirrored: entry.mirrored,
      });
      for (const side of ['in', 'out'] as const) {
        const handle = entry[side];
        if (handle === null) continue;
        handles.push({
          subpath: s,
          anchor: a,
          side,
          x: x(handle.x),
          y: y(handle.y),
          anchorX: ax,
          anchorY: ay,
        });
      }
    });
  });
  return { anchors, handles };
}

/**
 * The command the `togglePathClosed` action runs for the overlay's anchor selection (M3
 * contract, section 4; M3-U3 note 3), or null when the action would be a no-op: no edit mode,
 * no selected anchor, or anchors in more than one subpath. An open subpath gets
 * `closePathSubpath`; a closed one `openPathSubpath` at the lowest segment `k` whose two ends
 * `{k, (k + 1) mod n}` are exactly the selection, else without `segment` (its closing segment).
 * A one-anchor closed subpath always goes without `segment`: its only segment, if any, is the
 * default one, and the overlay cannot tell a loop from `move, close`.
 */
export function toggleClosedCommand(overlay: PathEditOverlay | null): Command | null {
  if (overlay === null) return null;
  const selected: { subpath: number; anchor: number }[] = [];
  overlay.subpaths.forEach((subpath, s) =>
    subpath.anchors.forEach((entry, a) => {
      if (entry.selected) selected.push({ subpath: s, anchor: a });
    }),
  );
  const subpath = selected[0]?.subpath;
  if (subpath === undefined || selected.some((ref) => ref.subpath !== subpath)) return null;
  const { id } = overlay;
  const { closed, anchors } = overlay.subpaths[subpath]!;
  if (!closed) return { type: 'closePathSubpath', id, subpath };
  const n = anchors.length;
  const chosen = new Set(selected.map((ref) => ref.anchor));
  let segment = -1;
  if (n >= 2) {
    for (let k = 0; k < n && segment < 0; k += 1) {
      const ends = new Set([k, (k + 1) % n]);
      if (ends.size === chosen.size && [...ends].every((a) => chosen.has(a))) segment = k;
    }
  }
  return segment < 0
    ? { type: 'openPathSubpath', id, subpath }
    : { type: 'openPathSubpath', id, subpath, segment };
}
