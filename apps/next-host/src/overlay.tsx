import type { EditorSnapshot, ToolOverlay } from '@vector-studio/editor-core';
import type { Frame } from '@vector-studio/model';

// P5-U6: the host's selection and tool overlay (P5 plan, section 4.5). It is drawn in CSS pixels
// over the canvas and is never document content.

type Props = Readonly<{ snapshot: EditorSnapshot; width: number; height: number }>;

function bounds(snapshot: EditorSnapshot): Frame | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of snapshot.selection) {
    const frame = snapshot.document.nodes[id]?.frame;
    if (frame === undefined) continue;
    minX = Math.min(minX, frame.x);
    minY = Math.min(minY, frame.y);
    maxX = Math.max(maxX, frame.x + frame.width);
    maxY = Math.max(maxY, frame.y + frame.height);
  }
  return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

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

export function SelectionOverlay({ snapshot, width, height }: Props) {
  const { position, zoom } = snapshot.viewport;
  const toScreen = (x: number, y: number): [number, number] => [
    (x - position.x) * zoom,
    (y - position.y) * zoom,
  ];
  const box = bounds(snapshot);
  const handles: [number, number][] = [];
  let outline = null;
  if (box !== null) {
    const [x, y] = toScreen(box.x, box.y);
    const [x2, y2] = toScreen(box.x + box.width, box.y + box.height);
    outline = (
      <rect
        data-testid="selection"
        x={x}
        y={y}
        width={x2 - x}
        height={y2 - y}
        fill="none"
        stroke="#1e78ff"
      />
    );
    for (const hx of [x, (x + x2) / 2, x2]) {
      for (const hy of [y, (y + y2) / 2, y2]) {
        if (hx !== (x + x2) / 2 || hy !== (y + y2) / 2) handles.push([hx, hy]);
      }
    }
  }
  return (
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
      {outline}
      {handles.map(([x, y], index) => (
        <rect key={index} x={x - 3} y={y - 3} width={6} height={6} fill="#fff" stroke="#1e78ff" />
      ))}
      {snapshot.overlay === null ? null : (
        <ToolShape overlay={snapshot.overlay} toScreen={toScreen} />
      )}
    </svg>
  );
}
