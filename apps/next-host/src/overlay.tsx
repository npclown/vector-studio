import type {
  EditorSnapshot,
  PagePoint,
  PathEditOverlay,
  SelectionHandles,
  SnapOverlay,
  ToolOverlay,
} from '@vector-studio/editor-core';
import { degreesLabel, nodePageCorners } from './m2-geometry';
import { pathMarkers } from './m3-path-overlay';
import type { TextEditMarkers } from './m6b-text-edit';

// P5-U6: the host's selection and tool overlay (P5 plan, section 4.5). It is drawn in CSS pixels
// over the canvas and is never document content. M1-U5: the selection box and its active handles
// come from the editor's `handles` query in page space, so a nested or rotated selection is drawn
// where the select tool picks its handles (M1 contract, section 4.4). M2-U8: the snap overlay of
// session `snap` (M2 contract, section 4.2: guides, equal-spacing gaps and the snapped angle) and
// the outline of session `scope` (section 5), which can lag behind the press during an Alt-drag
// begun outside the scope (M2-U5 note 1), since it is drawn from the session value as is.
// M3-U4: the anchor markers of path edit mode from the `pathOverlay` query (M3 contract,
// section 5.1), the value the select tool picks its edit-mode targets from: every anchor, filled
// when selected, and the visible handles with their lines.
// M6b-U9: the text edit caret, selection and composition underline from the `textEditOverlay`
// query (M6b contract, section 4.5), drawn in DOM over the canvas; the text itself is GPU work
// (M6-Q14 (a), M6c), so in M6b the edited box shows no glyphs. The caret does not blink.

type Props = Readonly<{
  snapshot: EditorSnapshot;
  handles: SelectionHandles | null;
  width: number;
  height: number;
  /** The `pathOverlay` query result for `snapshot` (null outside path edit mode). */
  pathOverlay?: PathEditOverlay | null;
  /** The `textEditOverlay` query result in CSS px (null outside text edit mode). */
  textEdit?: TextEditMarkers | null;
}>;

type ToScreen = (x: number, y: number) => [number, number];

function ToolShape({ overlay, toScreen }: { overlay: ToolOverlay; toScreen: ToScreen }) {
  if (overlay.kind === 'marquee') {
    const [x, y] = toScreen(overlay.frame.x, overlay.frame.y);
    const [x2, y2] = toScreen(
      overlay.frame.x + overlay.frame.width,
      overlay.frame.y + overlay.frame.height,
    );
    return (
      <rect
        data-testid="marquee"
        x={x}
        y={y}
        width={x2 - x}
        height={y2 - y}
        fill="rgba(30, 120, 255, 0.1)"
        stroke="#1e78ff"
        strokeDasharray="4 2"
      />
    );
  }
  const points = overlay.anchors.map((anchor) => toScreen(anchor.point.x, anchor.point.y));
  return (
    <g data-testid="path-anchors">
      <polyline
        points={points.map(([x, y]) => `${x},${y}`).join(' ')}
        fill="none"
        stroke="#1e78ff"
      />
      {points.map(([x, y], index) => (
        <circle key={index} cx={x} cy={y} r={3} fill="#fff" stroke="#1e78ff" />
      ))}
    </g>
  );
}

const SNAP_COLOUR = '#e0218a';
const TEXT_COLOUR = '#1e78ff';

function TextEditShapes({ markers }: { markers: TextEditMarkers }) {
  return (
    <g data-testid="text-edit" data-id={markers.id ?? ''}>
      {markers.selection.map((points, index) => (
        <polygon
          key={`s-${index}`}
          data-testid="text-selection"
          data-points={JSON.stringify(points)}
          points={points.map(([x, y]) => `${x},${y}`).join(' ')}
          fill="rgba(30, 120, 255, 0.3)"
          stroke="none"
        />
      ))}
      {markers.composition.map((segment, index) => (
        <line
          key={`c-${index}`}
          data-testid="text-composition"
          {...segment}
          stroke={TEXT_COLOUR}
          strokeWidth={2}
        />
      ))}
      {markers.caret === null ? null : (
        <line
          data-testid="text-caret"
          data-x1={markers.caret.x1}
          data-y1={markers.caret.y1}
          data-x2={markers.caret.x2}
          data-y2={markers.caret.y2}
          {...markers.caret}
          stroke="#000"
          strokeWidth={1}
        />
      )}
    </g>
  );
}
const PATH_COLOUR = '#1e78ff';

function PathShapes({ overlay, snapshot }: { overlay: PathEditOverlay; snapshot: EditorSnapshot }) {
  const { anchors, handles } = pathMarkers(overlay, snapshot.viewport);
  return (
    <g data-testid="path-edit" data-path={overlay.id}>
      {handles.map((handle) => (
        <g key={`h-${handle.subpath}-${handle.anchor}-${handle.side}`}>
          <line
            x1={handle.anchorX}
            y1={handle.anchorY}
            x2={handle.x}
            y2={handle.y}
            stroke={PATH_COLOUR}
          />
          <circle
            data-testid="path-handle"
            data-subpath={handle.subpath}
            data-anchor={handle.anchor}
            data-side={handle.side}
            data-x={handle.x}
            data-y={handle.y}
            cx={handle.x}
            cy={handle.y}
            r={3}
            fill="#fff"
            stroke={PATH_COLOUR}
          />
        </g>
      ))}
      {anchors.map((anchor) => (
        <rect
          key={`a-${anchor.subpath}-${anchor.anchor}`}
          data-testid="path-anchor"
          data-subpath={anchor.subpath}
          data-anchor={anchor.anchor}
          data-selected={anchor.selected}
          data-mirrored={anchor.mirrored}
          data-x={anchor.x}
          data-y={anchor.y}
          x={anchor.x - 3.5}
          y={anchor.y - 3.5}
          width={7}
          height={7}
          fill={anchor.selected ? PATH_COLOUR : '#fff'}
          stroke={PATH_COLOUR}
        />
      ))}
    </g>
  );
}

function SnapShapes({
  snap,
  handles,
  toScreen,
}: {
  snap: SnapOverlay;
  handles: SelectionHandles | null;
  toScreen: ToScreen;
}) {
  const segment = ({ a, b }: Readonly<{ a: PagePoint; b: PagePoint }>) => {
    const [x1, y1] = toScreen(a.x, a.y);
    const [x2, y2] = toScreen(b.x, b.y);
    return { x1, y1, x2, y2 };
  };
  // The label sits at the handle box's centre, the rotate pivot of a one-node rotation.
  const centre =
    handles === null
      ? null
      : toScreen(
          (handles.corners[0].x + handles.corners[2].x) / 2,
          (handles.corners[0].y + handles.corners[2].y) / 2,
        );
  return (
    <g data-testid="snap">
      {snap.guides.map((guide, index) => (
        <line
          key={`guide-${index}`}
          data-testid="snap-guide"
          {...segment(guide)}
          stroke={SNAP_COLOUR}
          strokeWidth={1}
        />
      ))}
      {snap.gaps.map((gap, index) => (
        <line
          key={`gap-${index}`}
          data-testid="snap-gap"
          {...segment(gap)}
          stroke={SNAP_COLOUR}
          strokeWidth={1}
          strokeDasharray="2 2"
          markerStart="url(#snap-tick)"
          markerEnd="url(#snap-tick)"
        />
      ))}
      {snap.angle === null || centre === null ? null : (
        <text
          data-testid="snap-angle"
          data-angle={snap.angle}
          x={centre[0] + 8}
          y={centre[1] - 8}
          fill={SNAP_COLOUR}
          fontSize={12}
        >
          {degreesLabel(snap.angle)}
        </text>
      )}
    </g>
  );
}

export function SelectionOverlay({
  snapshot,
  handles,
  width,
  height,
  pathOverlay = null,
  textEdit = null,
}: Props) {
  const { position, zoom } = snapshot.viewport;
  const toScreen = (x: number, y: number): [number, number] => [
    (x - position.x) * zoom,
    (y - position.y) * zoom,
  ];
  const corners = handles === null ? [] : handles.corners.map((p) => toScreen(p.x, p.y));
  // Only the handles the select tool can pick (a zero-size axis has no edge handles on it).
  const points = handles === null ? [] : handles.handles.map((p) => toScreen(p.x, p.y));
  const scope = snapshot.scope === null ? null : nodePageCorners(snapshot.document, snapshot.scope);
  return (
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
      <defs>
        <marker id="snap-tick" viewBox="0 0 2 8" refX={1} refY={4} markerWidth={2} markerHeight={8}>
          <rect width={2} height={8} fill={SNAP_COLOUR} />
        </marker>
      </defs>
      {scope === null ? null : (
        <polygon
          data-testid="scope"
          data-scope={snapshot.scope ?? ''}
          points={scope
            .map((p) => toScreen(p.x, p.y))
            .map(([x, y]) => `${x},${y}`)
            .join(' ')}
          fill="none"
          stroke="#8a5cf6"
          strokeDasharray="6 3"
        />
      )}
      {handles === null ? null : (
        <polygon
          data-testid="selection"
          data-rotation={handles.rotation}
          points={corners.map(([x, y]) => `${x},${y}`).join(' ')}
          fill="none"
          stroke="#1e78ff"
        />
      )}
      {points.map(([x, y], index) => (
        <rect
          key={index}
          data-testid="handle"
          x={x - 3}
          y={y - 3}
          width={6}
          height={6}
          fill="#fff"
          stroke="#1e78ff"
        />
      ))}
      {pathOverlay === null ? null : <PathShapes overlay={pathOverlay} snapshot={snapshot} />}
      {textEdit === null ? null : <TextEditShapes markers={textEdit} />}
      {snapshot.overlay === null ? null : (
        <ToolShape overlay={snapshot.overlay} toScreen={toScreen} />
      )}
      {snapshot.snap === null ? null : (
        <SnapShapes snap={snapshot.snap} handles={handles} toScreen={toScreen} />
      )}
    </svg>
  );
}
