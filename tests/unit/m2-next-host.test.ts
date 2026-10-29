import path from 'node:path';
import type { DocumentV3 } from '@vector-studio/model';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Editor,
  type EditorSnapshot,
  type Modifiers,
  type PagePoint,
  type SelectionHandles,
} from '../../packages/editor-core/src/index.js';

// MVP M2-U8 (M2 contract, sections 3, 4.1, 4.2 and 5): the next-host page's pure M2 chrome, in
// Node: the scope outline's page corners against the editor's own `handles` geometry, the rotate
// cursor's zone against the select tool's press precedence, the zoom and angle labels, and the
// overlay's snap guides, gaps, angle label and scope outline in CSS pixels.

// The app sources are outside the root TypeScript project (as in p5-react.test.ts), so they are
// imported by path and typed here.
const appSource = path.resolve(import.meta.dirname, '../../apps/next-host/src');
type Quad = readonly [PagePoint, PagePoint, PagePoint, PagePoint];
const { degreesLabel, inRotateZone, nodePageCorners, zoomLabel } = (await import(
  path.join(appSource, 'm2-geometry.ts')
)) as {
  degreesLabel: (radians: number) => string;
  inRotateZone: (handles: SelectionHandles, point: PagePoint, zoom: number) => boolean;
  nodePageCorners: (document: DocumentV3, id: string) => Quad | null;
  zoomLabel: (zoom: number) => string;
};
const { SelectionOverlay } = (await import(path.join(appSource, 'overlay.tsx'))) as {
  SelectionOverlay: ComponentType<{
    snapshot: EditorSnapshot;
    handles: SelectionHandles | null;
    width: number;
    height: number;
  }>;
};

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };

function editor(): Editor {
  return createEditor({ ids: createCounterIdSource('n') });
}

function ok(target: Editor, command: Parameters<Editor['execute']>[0]): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function handlesOf(target: Editor, ids: readonly string[]): SelectionHandles {
  ok(target, { type: 'setSelection', ids });
  return target.query({ type: 'handles' })!;
}

function expectNear(actual: readonly PagePoint[], expected: readonly PagePoint[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, index) => {
    expect(point.x).toBeCloseTo(expected[index]!.x, 9);
    expect(point.y).toBeCloseTo(expected[index]!.y, 9);
  });
}

/** A rotated frame holding a rotated rectangle, and a page-root rectangle. */
function scene() {
  const target = editor();
  const [frame] = ok(target, {
    type: 'createFrame',
    frame: { x: 100, y: 50, width: 200, height: 120 },
    rotation: 0.3,
  });
  const [inner] = ok(target, {
    type: 'createRectangle',
    frame: { x: 20, y: 10, width: 40, height: 30 },
    rotation: -0.7,
    parent: frame!,
  });
  const [plain] = ok(target, {
    type: 'createRectangle',
    frame: { x: 400, y: 300, width: 100, height: 50 },
  });
  return { target, frame: frame!, inner: inner!, plain: plain! };
}

describe('M2-U8 scope outline corners', () => {
  it('matches the editor handle box of a page-root, rotated and nested node', () => {
    const { target, frame, inner, plain } = scene();
    const document = target.query({ type: 'document' });
    for (const id of [plain, frame, inner]) {
      expectNear(nodePageCorners(document, id)!, handlesOf(target, [id]).corners);
    }
    // A page-root node with rotation 0 is exact.
    expect(nodePageCorners(document, plain)).toEqual([
      { x: 400, y: 300 },
      { x: 500, y: 300 },
      { x: 500, y: 350 },
      { x: 400, y: 350 },
    ]);
  });

  it('is null for an unknown node or a broken parent chain', () => {
    const { target, inner } = scene();
    const document = target.query({ type: 'document' });
    expect(nodePageCorners(document, 'missing')).toBeNull();
    const broken = {
      ...document,
      nodes: { ...document.nodes, [inner]: { ...document.nodes[inner]!, parent: 'gone' } },
    };
    expect(nodePageCorners(broken, inner)).toBeNull();
  });
});

describe('M2-U8 rotate cursor zone', () => {
  const box: SelectionHandles = {
    corners: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ],
    rotation: 0,
    handles: [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 25 },
      { x: 100, y: 50 },
      { x: 50, y: 50 },
      { x: 0, y: 50 },
      { x: 0, y: 25 },
    ],
  };

  it('is outside the box near a corner, after the handles, at zoom 1 and 2', () => {
    expect(inRotateZone(box, { x: -10, y: -10 }, 1)).toBe(true);
    expect(inRotateZone(box, { x: 112, y: 62 }, 1)).toBe(true);
    // A handle within 6 / zoom wins.
    expect(inRotateZone(box, { x: -3, y: -3 }, 1)).toBe(false);
    // Inside the box, or beyond 18 / zoom of every corner.
    expect(inRotateZone(box, { x: 5, y: 5 }, 1)).toBe(false);
    expect(inRotateZone(box, { x: -20, y: -20 }, 1)).toBe(false);
    expect(inRotateZone(box, { x: 50, y: -10 }, 1)).toBe(false);
    // At zoom 2 both reaches halve: 3 and 9 page units.
    expect(inRotateZone(box, { x: -10, y: -10 }, 2)).toBe(false);
    expect(inRotateZone(box, { x: -5, y: -5 }, 2)).toBe(true);
    expect(inRotateZone(box, { x: -2, y: -2 }, 2)).toBe(false);
  });

  it('agrees with the select tool: a press it marks starts a rotation, others do not', () => {
    const away = (handles: SelectionHandles, index: number, distance: number) => {
      // Beyond a corner along the box's diagonal, outside the box in its own axes.
      const corner = handles.corners[index as 0 | 1 | 2 | 3];
      const centre = {
        x: (handles.corners[0].x + handles.corners[2].x) / 2,
        y: (handles.corners[0].y + handles.corners[2].y) / 2,
      };
      const dx = corner.x - centre.x;
      const dy = corner.y - centre.y;
      const length = Math.hypot(dx, dy);
      const point = {
        x: corner.x + (dx / length) * distance,
        y: corner.y + (dy / length) * distance,
      };
      // A quarter turn of the press about the pivot.
      const turned = { x: centre.x - (point.y - centre.y), y: centre.y + (point.x - centre.x) };
      return { point, turned };
    };
    const cases = [
      { corner: 0, distance: 12, rotate: true },
      { corner: 1, distance: 14, rotate: true },
      { corner: 2, distance: 30, rotate: false },
    ];
    for (const { corner, distance, rotate } of cases) {
      const { target, inner } = scene();
      ok(target, { type: 'setSnapping', enabled: false });
      const handles = handlesOf(target, [inner]);
      const { point, turned } = away(handles, corner, distance);
      expect(inRotateZone(handles, point, 1)).toBe(rotate);
      const before = target.query({ type: 'node', id: inner })!.rotation;
      const send = (kind: 'pointerdown' | 'pointermove' | 'pointerup', p: PagePoint) =>
        target.execute({ type: 'input', event: { kind, point: p, modifiers: none } });
      send('pointerdown', point);
      send('pointermove', turned);
      send('pointerup', turned);
      const after = target.query({ type: 'node', id: inner })!.rotation;
      expect(after !== before).toBe(rotate);
    }
  });
});

describe('M2-U8 labels', () => {
  it('shows the zoom in percent and the snapped angle in degrees', () => {
    expect(zoomLabel(1)).toBe('100%');
    expect(zoomLabel(2)).toBe('200%');
    expect(zoomLabel(1 / 64)).toBe('1.56%');
    expect(zoomLabel(256)).toBe('25600%');
    expect(degreesLabel(Math.PI / 12)).toBe('15°');
    expect(degreesLabel(-Math.PI / 2)).toBe('-90°');
    expect(degreesLabel(0.3)).toBe('17.2°');
  });
});

describe('M2-U8 overlay drawing', () => {
  it('draws the snap guides, gaps and angle and the scope outline in CSS pixels', () => {
    const { target, frame } = scene();
    ok(target, { type: 'setScope', id: frame });
    ok(target, { type: 'setViewport', camera: { position: { x: 10, y: 20 }, zoom: 2 } });
    const base = target.getSnapshot();
    const snapshot: EditorSnapshot = {
      ...base,
      snap: {
        guides: [{ a: { x: 15, y: 20 }, b: { x: 15, y: 70 } }],
        gaps: [{ a: { x: 30, y: 40 }, b: { x: 40, y: 40 } }],
        angle: Math.PI / 12,
      },
    };
    const handles = handlesOf(target, [frame]);
    const html = renderToString(
      createElement(SelectionOverlay, { snapshot, handles, width: 960, height: 640 }),
    );
    // (page - position) * zoom.
    expect(html).toContain('data-testid="snap-guide" x1="10" y1="0" x2="10" y2="100"');
    expect(html).toContain('data-testid="snap-gap" x1="40" y1="40" x2="60" y2="40"');
    expect(html).toMatch(/data-testid="snap-angle" data-angle="0\.26179\d*"[^>]*>15°</u);
    const scope = /data-testid="scope" data-scope="([^"]+)" points="([^"]+)"/u.exec(html);
    expect(scope?.[1]).toBe(frame);
    const drawn = scope![2]!.split(' ').map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x: x!, y: y! };
    });
    expectNear(
      drawn,
      handles.corners.map((p) => ({ x: (p.x - 10) * 2, y: (p.y - 20) * 2 })),
    );
  });

  it('draws neither without a snap overlay or a scope', () => {
    const { target } = scene();
    const html = renderToString(
      createElement(SelectionOverlay, {
        snapshot: target.getSnapshot(),
        handles: null,
        width: 960,
        height: 640,
      }),
    );
    expect(html).not.toContain('data-testid="snap"');
    expect(html).not.toContain('data-testid="scope"');
  });
});
