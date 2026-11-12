import type {
  DocumentV8,
  Editor,
  Guide,
  PagePoint,
  RenderCamera,
  SelectionHandles,
} from '@vector-studio/editor-core';
import { layoutGridLines } from '@vector-studio/editor-core';
import { useEditorCommands, useEditorSelector } from '@vector-studio/react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { nodePageCorners } from './m2-geometry';
import {
  RULER_PX,
  dragStale,
  guideAt,
  guideScreen,
  guideValue,
  mayPickGuide,
  pageGuides,
  releaseRemoves,
  releasedGuides,
  rulerTicks,
  tickLabel,
  type GuideDrag,
} from './v38-rulers-model';

// V-38 contract, section 5: next-host's rulers along the canvas's top and left (V38-H1), page
// guides drawn over the canvas and dragged from the rulers (V38-H2), the layout grids of the
// active page's frames (V38-H3), and the Rulers and Layout grids toggles of the top bar. The
// editor owns the guides (`setGuides`, one step per drag) and both flags; this module only draws
// and turns a drag into one command. While a guide is dragged, pointer and key events stop here.

const GUIDE_COLOUR = '#ff5a36';
/** A uniform grid closer than this (CSS px) is not drawn (V38-H3). */
const MIN_GRID_PX = 2;

type CanvasPoint = Readonly<{ x: number; y: number }>;

function canvasPoint(
  host: HTMLElement | null,
  clientX: number,
  clientY: number,
): CanvasPoint | null {
  const canvas = host?.querySelector('canvas');
  if (canvas == null) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left - canvas.clientLeft, y: clientY - rect.top - canvas.clientTop };
}

const toPage = (camera: RenderCamera, point: CanvasPoint): PagePoint => ({
  x: camera.position.x + point.x / camera.zoom,
  y: camera.position.y + point.y / camera.zoom,
});

/** How long after a guide drag a click or double-click is still the drag's own (ms). */
const CLICK_AFTER_DRAG_MS = 500;

/**
 * Swallows the click a guide drag's release makes and a double-click that follows it, so a press
 * and release on a guide never enters a scope or text edit underneath.
 */
function swallowClicks(host: HTMLElement | null): void {
  const swallow = (event: Event) => {
    // Only the canvas host's own clicks: a quick click on a panel or button still lands.
    if (host === null || !(event.target instanceof Node) || !host.contains(event.target)) return;
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener('click', swallow, true);
  window.addEventListener('dblclick', swallow, true);
  window.setTimeout(() => {
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('dblclick', swallow, true);
  }, CLICK_AFTER_DRAG_MS);
}

/** The live guide drag and the canvas host's handlers for it. */
export type GuideDragging = Readonly<{
  drag: GuideDrag | null;
  /** The cursor over a pickable guide, or null. */
  cursor: string | null;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
}>;

/**
 * V38-H2: the guide drag of the canvas host `host`. A press on a ruler starts a new guide, a press
 * near a guide (select tool, nothing in progress, away from the selection box) picks it up; the
 * drag then captures every pointer event and key press until it ends (key releases pass, so held-key state
 * stays right), and its release writes one
 * `setGuides` built from the page's guides at that moment.
 */
export function useGuideDrag(
  editor: Editor,
  host: RefObject<HTMLDivElement | null>,
): GuideDragging {
  const [drag, setDrag] = useState<GuideDrag | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const active = useRef<(() => void) | null>(null);
  const spaceHeld = useRef(false);

  useEffect(() => () => active.current?.(), []);

  // A held Space is the pan gesture's: a press then never picks a guide up.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceHeld.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceHeld.current = false;
    };
    const blur = () => {
      spaceHeld.current = false;
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const start = useCallback(
    (initial: GuideDrag, pointerId: number) => {
      active.current?.();
      let current = initial;
      setDrag(current);
      const end = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', cancel, true);
        window.removeEventListener('keydown', key, true);
        window.removeEventListener('blur', blurred);
        unsubscribe();
        active.current = null;
        setDrag(null);
      };
      const move = (event: PointerEvent) => {
        event.stopPropagation();
        if (event.pointerId !== pointerId) return;
        // A release the window never saw (outside the page, a lost capture) ends the drag unwritten.
        if (event.buttons === 0) {
          end();
          return;
        }
        const point = canvasPoint(host.current, event.clientX, event.clientY);
        if (point === null) return;
        const page = toPage(editor.getSnapshot().viewport, point);
        current = { ...current, value: guideValue(current.axis === 'x' ? page.x : page.y) };
        setDrag(current);
      };
      const up = (event: PointerEvent) => {
        event.stopPropagation();
        event.preventDefault();
        if (event.pointerId !== pointerId) return;
        const snapshot = editor.getSnapshot();
        const canvas = host.current?.querySelector('canvas');
        const point = canvasPoint(host.current, event.clientX, event.clientY);
        end();
        swallowClicks(host.current);
        if (canvas == null || point === null) return;
        if (dragStale(current, snapshot.revision, snapshot.activePage)) return;
        const remove = releaseRemoves(
          current.axis,
          point.x,
          point.y,
          canvas.clientWidth,
          canvas.clientHeight,
        );
        const guides = releasedGuides(pageGuides(snapshot.document, current.page), current, remove);
        if (guides !== null) editor.execute({ type: 'setGuides', page: current.page, guides });
      };
      const cancel = (event: PointerEvent) => {
        event.stopPropagation();
        if (event.pointerId === pointerId) end();
      };
      const blurred = () => end();
      // Key presses during the drag reach nothing; releases pass so held-key state stays right.
      const key = (event: KeyboardEvent) => {
        event.stopPropagation();
        event.preventDefault();
        if (event.key === 'Escape') end();
      };
      // An undo, a load or a page switch during the drag ends it, so a stale list is never written.
      const unsubscribe = editor.subscribe(() => {
        const snapshot = editor.getSnapshot();
        if (dragStale(current, snapshot.revision, snapshot.activePage)) end();
      });
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', cancel, true);
      window.addEventListener('keydown', key, true);
      window.addEventListener('blur', blurred);
      active.current = end;
    },
    [editor, host],
  );

  const onPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const snapshot = editor.getSnapshot();
    if (!snapshot.rulersVisible || event.button !== 0) return;
    const point = canvasPoint(host.current, event.clientX, event.clientY);
    if (point === null) return;
    const camera = snapshot.viewport;
    const page = toPage(camera, point);
    const base = { page: snapshot.activePage, revision: snapshot.revision };
    const onTop = point.y >= 0 && point.y < RULER_PX;
    const onLeft = point.x >= 0 && point.x < RULER_PX;
    if (onTop || onLeft) {
      event.stopPropagation();
      event.preventDefault();
      // The corner square starts nothing.
      if (onTop && onLeft) return;
      const axis = onTop ? 'y' : 'x';
      start(
        { ...base, axis, index: null, value: guideValue(axis === 'x' ? page.x : page.y) },
        event.pointerId,
      );
      return;
    }
    const guides = pageGuides(snapshot.document, snapshot.activePage);
    const index = guideAt(guides, camera, point.x, point.y);
    if (index === null || spaceHeld.current) return;
    const handles = editor.query({ type: 'handles' });
    const pickable = mayPickGuide(
      {
        tool: snapshot.tool,
        busy: snapshot.overlay !== null || snapshot.pathEdit !== null || snapshot.textEdit !== null,
        corners: handles?.corners ?? null,
        camera,
      },
      point.x,
      point.y,
    );
    if (!pickable) return;
    event.stopPropagation();
    event.preventDefault();
    start(
      { ...base, axis: guides[index]!.axis, index, value: guides[index]!.value },
      event.pointerId,
    );
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    let next: string | null = null;
    const snapshot = editor.getSnapshot();
    if (snapshot.rulersVisible && event.buttons === 0) {
      const point = canvasPoint(host.current, event.clientX, event.clientY);
      if (point !== null && point.x >= RULER_PX && point.y >= RULER_PX) {
        const guides = pageGuides(snapshot.document, snapshot.activePage);
        const index = guideAt(guides, snapshot.viewport, point.x, point.y);
        const handles = editor.query({ type: 'handles' });
        if (
          index !== null &&
          mayPickGuide(
            {
              tool: snapshot.tool,
              busy:
                snapshot.overlay !== null ||
                snapshot.pathEdit !== null ||
                snapshot.textEdit !== null,
              corners: handles?.corners ?? null,
              camera: snapshot.viewport,
            },
            point.x,
            point.y,
          )
        ) {
          next = guides[index]!.axis === 'x' ? 'col-resize' : 'row-resize';
        }
      }
    }
    setCursor((previous) => (previous === next ? previous : next));
  };

  return {
    drag,
    cursor: drag === null ? cursor : drag.axis === 'x' ? 'col-resize' : 'row-resize',
    onPointerDownCapture,
    onPointerMove,
    onPointerLeave: () => setCursor(null),
  };
}

/** The visible frames and symbols of `page`, through their ancestors, in pre-order. */
function gridFrames(document: DocumentV8, page: string): string[] {
  const ids: string[] = [];
  const walk = (children: readonly string[]) => {
    for (const id of children) {
      const node = document.nodes[id];
      if (node === undefined || !node.visible) continue;
      if (
        (node.type === 'frame' || node.type === 'symbol') &&
        (node.layoutGrids?.length ?? 0) > 0
      ) {
        ids.push(id);
      }
      if ('children' in node) walk(node.children);
    }
  };
  walk(document.pages.find((entry) => entry.id === page)?.children ?? []);
  return ids;
}

function LayoutGrids({
  document,
  page,
  camera,
}: {
  document: DocumentV8;
  page: string;
  camera: RenderCamera;
}) {
  const { position, zoom } = camera;
  const screen = (p: PagePoint) => [(p.x - position.x) * zoom, (p.y - position.y) * zoom] as const;
  const shapes: ReactElement[] = [];
  for (const id of gridFrames(document, page)) {
    const node = document.nodes[id]!;
    if (node.type !== 'frame' && node.type !== 'symbol') continue;
    const corners = nodePageCorners(document, id);
    if (corners === null) continue;
    const { width, height } = node.frame;
    const [o, right, , down] = corners;
    // The frame's local point (x, y) in page space.
    const at = (x: number, y: number): PagePoint => ({
      x:
        o.x +
        (width > 0 ? ((right.x - o.x) * x) / width : 0) +
        (height > 0 ? ((down.x - o.x) * y) / height : 0),
      y:
        o.y +
        (width > 0 ? ((right.y - o.y) * x) / width : 0) +
        (height > 0 ? ((down.y - o.y) * y) / height : 0),
    });
    const scale = width > 0 ? (Math.hypot(right.x - o.x, right.y - o.y) / width) * zoom : zoom;
    (node.layoutGrids ?? []).forEach((grid, index) => {
      if (!grid.visible) return;
      const { r, g, b, a } = grid.color;
      const colour = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
      const geometry = layoutGridLines(width, height, grid);
      const key = `${id}-${index}`;
      if (grid.type === 'grid') {
        if (grid.size * scale < MIN_GRID_PX) return;
        const d = geometry.lines
          .map((line) => {
            const [x1, y1] = screen(line.axis === 'x' ? at(line.value, 0) : at(0, line.value));
            const [x2, y2] = screen(
              line.axis === 'x' ? at(line.value, height) : at(width, line.value),
            );
            return `M${x1} ${y1}L${x2} ${y2}`;
          })
          .join('');
        shapes.push(
          <path
            key={key}
            data-testid="layout-grid"
            data-frame={id}
            d={d}
            stroke={colour}
            fill="none"
          />,
        );
        return;
      }
      const points = geometry.bands.map((band) => {
        const quad =
          band.axis === 'x'
            ? [at(band.low, 0), at(band.high, 0), at(band.high, height), at(band.low, height)]
            : [at(0, band.low), at(width, band.low), at(width, band.high), at(0, band.high)];
        return quad.map((p) => screen(p).join(',')).join(' ');
      });
      shapes.push(
        <g key={key} data-testid="layout-grid" data-frame={id} data-bands={points.length}>
          {points.map((polygon, band) => (
            <polygon key={band} points={polygon} fill={colour} />
          ))}
        </g>,
      );
    });
  }
  return <>{shapes}</>;
}

/**
 * V38-H2, H3: the layout grids and the page guides, under the selection overlay; draws only, the
 * pointer goes through. `drag` shows the dragged guide at its live value.
 */
export function GridsAndGuides({
  width,
  height,
  drag,
}: {
  width: number;
  height: number;
  drag: GuideDrag | null;
}) {
  const document = useEditorSelector((snapshot) => snapshot.document);
  const page = useEditorSelector((snapshot) => snapshot.activePage);
  const camera = useEditorSelector((snapshot) => snapshot.viewport);
  const rulers = useEditorSelector((snapshot) => snapshot.rulersVisible);
  const grids = useEditorSelector((snapshot) => snapshot.layoutGridsVisible);
  const guides = pageGuides(document, page);
  const shown: { guide: Guide; index: number | 'drag' }[] = [];
  if (rulers) {
    guides.forEach((guide, index) => {
      if (drag?.index !== index) shown.push({ guide, index });
    });
    if (drag !== null) shown.push({ guide: { axis: drag.axis, value: drag.value }, index: 'drag' });
  }
  return (
    <svg
      width={width}
      height={height}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      data-testid="grids-and-guides"
    >
      {grids ? <LayoutGrids document={document} page={page} camera={camera} /> : null}
      {shown.map(({ guide, index }) => {
        const at = guideScreen(guide, camera);
        return guide.axis === 'x' ? (
          <line
            key={`g-${index}`}
            data-testid="guide"
            data-axis="x"
            data-value={guide.value}
            x1={at}
            x2={at}
            y1={0}
            y2={height}
            stroke={GUIDE_COLOUR}
          />
        ) : (
          <line
            key={`g-${index}`}
            data-testid="guide"
            data-axis="y"
            data-value={guide.value}
            x1={0}
            x2={width}
            y1={at}
            y2={at}
            stroke={GUIDE_COLOUR}
          />
        );
      })}
      {drag === null ? null : (
        <text
          data-testid="guide-label"
          x={drag.axis === 'x' ? guideScreen(drag, camera) + 4 : RULER_PX + 4}
          y={drag.axis === 'y' ? guideScreen(drag, camera) - 4 : RULER_PX + 14}
          fill={GUIDE_COLOUR}
          fontSize={11}
        >
          {tickLabel(drag.value)}
        </text>
      )}
    </svg>
  );
}

/** Forwards wheel events over a ruler to the canvas, so wheel zoom and pan work there too. */
function useWheelForward(
  ruler: RefObject<HTMLDivElement | null>,
  host: RefObject<HTMLDivElement | null>,
  visible: boolean,
) {
  // `visible` re-runs the effect when the rulers mount again after Shift+R hid them.
  useEffect(() => {
    const element = ruler.current;
    if (element === null) return;
    const forward = (event: WheelEvent) => {
      const canvas = host.current?.querySelector('canvas');
      if (canvas == null) return;
      const copy = new WheelEvent('wheel', {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        cancelable: true,
        bubbles: true,
      });
      if (!canvas.dispatchEvent(copy)) event.preventDefault();
    };
    element.addEventListener('wheel', forward, { passive: false });
    return () => element.removeEventListener('wheel', forward);
  }, [ruler, host, visible]);
}

const RULER_BG = '#f5f5f5';
const RULER_TEXT = '#737373';
const RULER_LINE = '#c4c4c4';
const RULER_SHADE = 'rgba(13, 153, 255, 0.18)';

/** V38-H1: the top and left rulers and their corner, over the canvas, while rulers are on. */
export function Rulers({
  width,
  height,
  handles,
  host,
}: {
  width: number;
  height: number;
  handles: SelectionHandles | null;
  host: RefObject<HTMLDivElement | null>;
}) {
  const visible = useEditorSelector((snapshot) => snapshot.rulersVisible);
  const camera = useEditorSelector((snapshot) => snapshot.viewport);
  const top = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  useWheelForward(top, host, visible);
  useWheelForward(left, host, visible);
  if (!visible) return null;
  const { position, zoom } = camera;
  const across = rulerTicks(position.x, zoom, width);
  const down = rulerTicks(position.y, zoom, height);
  // The selection's page-aligned bounds, shaded on both rulers with their edges labelled.
  let extent: { x: [number, number]; y: [number, number] } | null = null;
  if (handles !== null) {
    const xs = handles.corners.map((p) => p.x);
    const ys = handles.corners.map((p) => p.y);
    extent = { x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)] };
  }
  const sx = (value: number) => (value - position.x) * zoom;
  const sy = (value: number) => (value - position.y) * zoom;
  const font = { fontSize: 9, fill: RULER_TEXT, fontFamily: 'system-ui, sans-serif' } as const;
  return (
    <>
      <div
        ref={top}
        data-testid="ruler-top"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width,
          height: RULER_PX,
          background: RULER_BG,
          borderBottom: `1px solid ${RULER_LINE}`,
          boxSizing: 'border-box',
          pointerEvents: 'auto',
          cursor: 'row-resize',
          overflow: 'hidden',
        }}
      >
        <svg width={width} height={RULER_PX}>
          {extent === null ? null : (
            <rect
              x={sx(extent.x[0])}
              width={Math.max(1, sx(extent.x[1]) - sx(extent.x[0]))}
              y={0}
              height={RULER_PX}
              fill={RULER_SHADE}
            />
          )}
          {across.minor.map((px) => (
            <line
              key={`m${px}`}
              x1={px}
              x2={px}
              y1={RULER_PX - 4}
              y2={RULER_PX}
              stroke={RULER_LINE}
            />
          ))}
          {across.major.map((tick) => (
            <g key={`M${tick.value}`}>
              <line x1={tick.px} x2={tick.px} y1={RULER_PX - 8} y2={RULER_PX} stroke={RULER_TEXT} />
              <text x={tick.px + 2} y={9} {...font}>
                {tick.label}
              </text>
            </g>
          ))}
          {extent === null
            ? null
            : extent.x.map((value, index) => (
                <text
                  key={`e${index}`}
                  data-testid="ruler-top-extent"
                  x={sx(value) + 2}
                  y={RULER_PX - 2}
                  {...font}
                  fill="#0d99ff"
                >
                  {tickLabel(value)}
                </text>
              ))}
        </svg>
      </div>
      <div
        ref={left}
        data-testid="ruler-left"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: RULER_PX,
          height,
          background: RULER_BG,
          borderRight: `1px solid ${RULER_LINE}`,
          boxSizing: 'border-box',
          pointerEvents: 'auto',
          cursor: 'col-resize',
          overflow: 'hidden',
        }}
      >
        <svg width={RULER_PX} height={height}>
          {extent === null ? null : (
            <rect
              y={sy(extent.y[0])}
              height={Math.max(1, sy(extent.y[1]) - sy(extent.y[0]))}
              x={0}
              width={RULER_PX}
              fill={RULER_SHADE}
            />
          )}
          {down.minor.map((px) => (
            <line
              key={`m${px}`}
              y1={px}
              y2={px}
              x1={RULER_PX - 4}
              x2={RULER_PX}
              stroke={RULER_LINE}
            />
          ))}
          {down.major.map((tick) => (
            <g key={`M${tick.value}`}>
              <line y1={tick.px} y2={tick.px} x1={RULER_PX - 8} x2={RULER_PX} stroke={RULER_TEXT} />
              <text
                transform={`translate(9 ${tick.px + 2}) rotate(-90)`}
                textAnchor="end"
                {...font}
              >
                {tick.label}
              </text>
            </g>
          ))}
          {extent === null
            ? null
            : extent.y.map((value, index) => (
                <text
                  key={`e${index}`}
                  data-testid="ruler-left-extent"
                  transform={`translate(${RULER_PX - 2} ${sy(value) - 2}) rotate(-90)`}
                  {...font}
                  fill="#0d99ff"
                >
                  {tickLabel(value)}
                </text>
              ))}
        </svg>
      </div>
      <div
        data-testid="ruler-corner"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: RULER_PX,
          height: RULER_PX,
          background: RULER_BG,
          borderRight: `1px solid ${RULER_LINE}`,
          borderBottom: `1px solid ${RULER_LINE}`,
          boxSizing: 'border-box',
          pointerEvents: 'auto',
        }}
      />
    </>
  );
}

/** The studio top bar's Rulers and Layout grids toggles (V38-U1), pressed while shown. */
export function ViewToggles() {
  const execute = useEditorCommands();
  const rulers = useEditorSelector((snapshot) => snapshot.rulersVisible);
  const grids = useEditorSelector((snapshot) => snapshot.layoutGridsVisible);
  return (
    <div role="group" aria-label="view" style={{ display: 'flex', gap: 2 }}>
      <button
        type="button"
        data-testid="toggle-rulers"
        aria-pressed={rulers}
        title="Rulers (Shift+R)"
        onClick={() => execute({ type: 'setRulersVisible', visible: !rulers })}
      >
        Rulers
      </button>
      <button
        type="button"
        data-testid="toggle-layout-grids"
        aria-pressed={grids}
        title="Layout grids (Ctrl+Shift+4)"
        onClick={() => execute({ type: 'setLayoutGridsVisible', visible: !grids })}
      >
        Grids
      </button>
    </div>
  );
}
