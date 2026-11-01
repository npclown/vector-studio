import type { EditorSnapshot, PathEditOverlay } from '@vector-studio/editor-core';

// M3-U4 (MVP M3 contract, sections 4 and 5.1): the host side of the next-host page's path edit
// mode, kept pure so it is unit tested without a DOM. The editor decides every behaviour; these
// helpers only draw the `pathOverlay` query result. The toggle-closed button's command moved to
// `@vector-studio/ui`'s toolbar (MVP M8 contract, M8-L1; removed here in M8-U6).

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
