import type { EditorSnapshot, SelectionHandles, ToolOverlay } from '@vector-studio/editor-core';

// P5-U6: the host's selection and tool overlay (P5 plan, section 4.5). It is drawn in CSS pixels
// over the canvas and is never document content. M1-U5: the selection box and its eight handles
// come from the editor's `handles` query in page space, so a nested or rotated selection is drawn
// where the select tool picks its handles (M1 contract, section 4.4).

type Props = Readonly<{
  snapshot: EditorSnapshot;
  handles: SelectionHandles | null;
  width: number;
  height: number;
}>;

function ToolShape({
  overlay,
  toScreen,
}: {
  overlay: ToolOverlay;
  toScreen: (x: number, y: number) => [number, number];
}) {
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

export function SelectionOverlay({ snapshot, handles, width, height }: Props) {
  const { position, zoom } = snapshot.viewport;
  const toScreen = (x: number, y: number): [number, number] => [
    (x - position.x) * zoom,
    (y - position.y) * zoom,
  ];
  const corners = handles === null ? [] : handles.corners.map((p) => toScreen(p.x, p.y));
  // Corners and edge midpoints, clockwise from the box's own top-left corner.
  const points = corners.flatMap((corner, index) => {
    const next = corners[(index + 1) % corners.length]!;
    return [corner, [(corner[0] + next[0]) / 2, (corner[1] + next[1]) / 2] as [number, number]];
  });
  return (
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
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
      {snapshot.overlay === null ? null : (
        <ToolShape overlay={snapshot.overlay} toScreen={toScreen} />
      )}
    </svg>
  );
}
