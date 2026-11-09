import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Editor,
  type Modifiers,
  type PagePoint,
  type SelectionHandles,
} from '../../packages/editor-core/src/index.js';

// V-28 (Figma): the next-host page's hover cursor over the selection handles. A resize handle
// shows a double arrow along its outward direction and a rotate zone a curled arrow around its
// corner, both turned with a rotated box; the cursor agrees with what a press there starts.

// The app sources are outside the root TypeScript project (as in m2-next-host.test.ts).
const appSource = path.resolve(import.meta.dirname, '../../apps/next-host/src');
type HandleCursor = Readonly<{ kind: 'resize' | 'rotate'; angle: number }>;
const { handleCursorAt } = (await import(path.join(appSource, 'm2-geometry.ts'))) as {
  handleCursorAt: (
    handles: SelectionHandles,
    point: PagePoint,
    zoom: number,
  ) => HandleCursor | null;
};
const { handleCursorCss, standardResizeCursor } = (await import(
  path.join(appSource, 'v28-handle-cursor.ts')
)) as {
  handleCursorCss: (cursor: HandleCursor | null) => string | undefined;
  standardResizeCursor: (angle: number) => string;
};

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };

function ok(target: Editor, command: Parameters<Editor['execute']>[0]): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

/** A selected rectangle and its handles; `rotation` in radians. */
function selected(rotation: number, width = 100, height = 50) {
  const target = createEditor({ ids: createCounterIdSource('n') });
  ok(target, { type: 'setSnapping', enabled: false });
  const [id] = ok(target, {
    type: 'createRectangle',
    frame: { x: 100, y: 100, width, height },
    rotation,
  });
  ok(target, { type: 'setSelection', ids: [id!] });
  return { target, id: id!, handles: target.query({ type: 'handles' })! };
}

/** The angle folded to [0, 360). */
const fold = (angle: number) => ((Math.round(angle) % 360) + 360) % 360;

describe('V-28 handle cursor', () => {
  it('points each handle of a page-aligned box outward', () => {
    const { handles } = selected(0);
    const [tl, tr, br, bl] = handles.corners;
    const expected: [PagePoint, number][] = [
      [tl, 225],
      [tr, 315],
      [br, 45],
      [bl, 135],
      [{ x: (tl.x + tr.x) / 2, y: tl.y }, 270],
      [{ x: tr.x, y: (tr.y + br.y) / 2 }, 0],
      [{ x: (bl.x + br.x) / 2, y: bl.y }, 90],
      [{ x: tl.x, y: (tl.y + bl.y) / 2 }, 180],
    ];
    for (const [point, angle] of expected) {
      const cursor = handleCursorAt(handles, { x: point.x + 1, y: point.y - 1 }, 1);
      expect(cursor?.kind).toBe('resize');
      expect(fold(cursor!.angle)).toBe(angle);
    }
    // Corners stay diagonal on a long thin box (not along the centre-to-corner line).
    const thin = selected(0, 300, 20).handles;
    expect(fold(handleCursorAt(thin, thin.corners[2], 1)!.angle)).toBe(45);
  });

  it('turns with a rotated box', () => {
    const { handles } = selected(Math.PI / 6);
    const right = {
      x: (handles.corners[1].x + handles.corners[2].x) / 2,
      y: (handles.corners[1].y + handles.corners[2].y) / 2,
    };
    expect(fold(handleCursorAt(handles, right, 1)!.angle)).toBe(30);
    expect(fold(handleCursorAt(handles, handles.corners[2], 1)!.angle)).toBe(75);
  });

  it('shows the rotate cursor outside a corner and nothing elsewhere', () => {
    const { handles } = selected(0);
    const [tl, , br] = handles.corners;
    const rotate = handleCursorAt(handles, { x: tl.x - 10, y: tl.y - 10 }, 1);
    expect(rotate).toEqual({ kind: 'rotate', angle: -135 });
    expect(fold(handleCursorAt(handles, { x: br.x + 10, y: br.y + 10 }, 1)!.angle)).toBe(45);
    // Inside the box away from the handles, and far outside.
    expect(handleCursorAt(handles, { x: tl.x + 30, y: tl.y + 20 }, 1)).toBeNull();
    expect(handleCursorAt(handles, { x: tl.x - 40, y: tl.y - 40 }, 1)).toBeNull();
    // Reaches scale with zoom: 6 / 2 and 18 / 2 page units.
    expect(handleCursorAt(handles, { x: tl.x - 4, y: tl.y - 4 }, 2)?.kind).toBe('rotate');
    expect(handleCursorAt(handles, { x: tl.x - 2, y: tl.y - 2 }, 2)?.kind).toBe('resize');
  });

  it('agrees with the select tool: a resize cursor press resizes, a rotate cursor press rotates', () => {
    for (const rotation of [0, 0.5]) {
      const probes = (handles: SelectionHandles): PagePoint[] => {
        const [tl, tr, br] = handles.corners;
        const out = (p: PagePoint, c: PagePoint) => ({
          x: p.x + (p.x - c.x) * 0.15,
          y: p.y + (p.y - c.y) * 0.15,
        });
        const centre = { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
        return [
          tl,
          { x: (tr.x + br.x) / 2, y: (tr.y + br.y) / 2 },
          out(br, centre),
          out(tr, centre),
        ];
      };
      for (const probe of probes(selected(rotation).handles)) {
        const { target, id, handles } = selected(rotation);
        const cursor = handleCursorAt(handles, probe, 1);
        const before = target.query({ type: 'node', id })!;
        const to = { x: probe.x + 7, y: probe.y + 23 };
        const send = (kind: 'pointerdown' | 'pointermove' | 'pointerup', p: PagePoint) =>
          target.execute({ type: 'input', event: { kind, point: p, modifiers: none } });
        send('pointerdown', probe);
        send('pointermove', to);
        send('pointerup', to);
        const after = target.query({ type: 'node', id })!;
        const resized =
          after.frame.width !== before.frame.width || after.frame.height !== before.frame.height;
        const rotated = after.rotation !== before.rotation;
        expect(cursor?.kind ?? 'none').toBe(resized ? 'resize' : rotated ? 'rotate' : 'none');
        expect(cursor).not.toBeNull();
      }
    }
  });

  it('shows no resize cursor inside a box too small for its handles', () => {
    const { handles } = selected(0, 16, 16);
    const [tl] = handles.corners;
    expect(handleCursorAt(handles, { x: tl.x + 2, y: tl.y + 2 }, 1)).toBeNull();
    expect(handleCursorAt(handles, { x: tl.x - 2, y: tl.y - 2 }, 1)?.kind).toBe('resize');
  });

  it('builds a turned SVG cursor with the nearest standard fallback', () => {
    expect(handleCursorCss(null)).toBeUndefined();
    const resize = handleCursorCss({ kind: 'resize', angle: 31 })!;
    expect(resize).toContain(encodeURIComponent('rotate(30 12 12)'));
    expect(resize.endsWith(', nwse-resize')).toBe(true);
    expect(handleCursorCss({ kind: 'resize', angle: 31 })).toBe(resize);
    expect(handleCursorCss({ kind: 'rotate', angle: -135 })!.endsWith(', grab')).toBe(true);
    expect([0, 45, 90, 135, 180, 225, 270, 315].map(standardResizeCursor)).toEqual([
      'ew-resize',
      'nwse-resize',
      'ns-resize',
      'nesw-resize',
      'ew-resize',
      'nwse-resize',
      'ns-resize',
      'nesw-resize',
    ]);
  });
});
