import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '@vector-studio/editor-core';
import { EditorProvider, LayerTree } from '@vector-studio/ui';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  OVERSCAN_ROWS,
  UNMEASURED_ROWS,
  createLayerRowCache,
  layerRows,
  mountedIndexes,
  windowRange,
} from '../../packages/ui/src/layer-model.js';

// V-20 contract, unit V20-U2 (levers L2 and L3, section 4): the row cache returns the previous
// row object while its node, depth, expansion and selection are unchanged; the window range
// covers the rows in view plus the overscan, clamped; and before a measurement (and so in
// `renderToString`) the list mounts its first rows in normal flow. The browser half (scrolling,
// pins, Tab, stable handlers) is `tests/v20/v20-render-count.spec.ts`.

const frame = { x: 10, y: 20, width: 30, height: 40 };
const none: ReadonlySet<string> = new Set();

function editor(): Editor {
  return createEditor({
    document: {
      schemaVersion: 6,
      id: 'doc',
      pages: [{ id: 'p1', name: 'Page 1', children: [] }],
      nodes: {},
    },
    ids: createCounterIdSource('n'),
  });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
  return result.ids;
}

/** `count` rectangles on page `p1`, back to front. */
function rectangles(count: number) {
  const target = editor();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(ok(target, { type: 'createRectangle', frame, name: `R${index}` })[0]!);
  }
  return { target, ids };
}

const rowsOf = (
  target: Editor,
  cache: ReturnType<typeof createLayerRowCache> | null,
  expanded: ReadonlySet<string> = none,
) => {
  const { document, activePage, selection } = target.getSnapshot();
  return layerRows(document, activePage, expanded, selection, cache);
};

describe('V20-U2 row cache (lever L2)', () => {
  it('returns the same rows as without a cache', () => {
    const { target, ids } = rectangles(5);
    const g = ok(target, { type: 'groupNodes', ids: [ids[1]!, ids[2]!], kind: 'group' })[0]!;
    ok(target, { type: 'setSelection', ids: [ids[3]!] });
    const expanded = new Set([g]);
    expect(rowsOf(target, createLayerRowCache(), expanded)).toEqual(rowsOf(target, null, expanded));
  });

  it('reuses a row while its node, depth, expansion and selection are unchanged', () => {
    const { target, ids } = rectangles(4);
    const cache = createLayerRowCache();
    const first = rowsOf(target, cache);
    // A camera change and an unrelated document edit keep every untouched row object.
    ok(target, { type: 'setViewport', camera: { position: { x: 5, y: 5 }, zoom: 2 } });
    expect(rowsOf(target, cache)).toEqual(first);
    rowsOf(target, cache).forEach((row, index) => expect(row).toBe(first[index]));
    ok(target, { type: 'setNodeProps', id: ids[0]!, props: { name: 'Renamed' } });
    const renamed = rowsOf(target, cache);
    const changed = renamed.filter((row, index) => row !== first[index]).map((row) => row.id);
    expect(changed).toEqual([ids[0]]);
    expect(renamed.find((row) => row.id === ids[0])!.name).toBe('Renamed');
    // Selection: only the rows whose `selected` flips are new objects.
    ok(target, { type: 'setSelection', ids: [ids[2]!] });
    const selected = rowsOf(target, cache);
    expect(selected.filter((row, index) => row !== renamed[index]).map((row) => row.id)).toEqual([
      ids[2],
    ]);
  });

  it('builds a new row when its depth or expansion changes', () => {
    const { target, ids } = rectangles(3);
    const g = ok(target, { type: 'groupNodes', ids: [ids[0]!, ids[1]!], kind: 'group' })[0]!;
    const cache = createLayerRowCache();
    const closed = rowsOf(target, cache);
    const open = rowsOf(target, cache, new Set([g]));
    const group = (rows: typeof open) => rows.find((row) => row.id === g)!;
    expect(group(open)).not.toBe(group(closed));
    expect(group(open).expanded).toBe(true);
    // The sibling outside the group is untouched.
    expect(open.find((row) => row.id === ids[2])).toBe(closed.find((row) => row.id === ids[2]));
    // Ungrouping moves the children to depth 0: new rows.
    const children = open.filter((row) => row.depth === 1);
    ok(target, { type: 'ungroupNodes', id: g });
    const flat = rowsOf(target, cache, new Set([g]));
    for (const child of children) {
      const now = flat.find((row) => row.id === child.id)!;
      expect(now.depth).toBe(0);
      expect(now).not.toBe(child);
    }
  });
});

describe('V20-U2 window range (lever L3)', () => {
  it('mounts the first rows before a measurement', () => {
    expect(windowRange(100, null, 0, 240)).toEqual({ start: 0, end: UNMEASURED_ROWS });
    expect(windowRange(10, null, 500, 240)).toEqual({ start: 0, end: 10 });
    expect(windowRange(100, 0, 0, 240)).toEqual({ start: 0, end: UNMEASURED_ROWS });
  });

  it('covers the rows in view plus the overscan, clamped to the rows', () => {
    // 20 px rows, a 200 px viewport: 10 rows in view.
    expect(windowRange(1000, 20, 0, 200)).toEqual({ start: 0, end: 10 + OVERSCAN_ROWS });
    expect(windowRange(1000, 20, 400, 200)).toEqual({
      start: 20 - OVERSCAN_ROWS,
      end: 30 + OVERSCAN_ROWS,
    });
    // A partly scrolled row at each edge is in view.
    expect(windowRange(1000, 20, 410, 200)).toEqual({
      start: 20 - OVERSCAN_ROWS,
      end: 31 + OVERSCAN_ROWS,
    });
    // The end, and one row short of it.
    expect(windowRange(1000, 20, 19_800, 200)).toEqual({ start: 990 - OVERSCAN_ROWS, end: 1000 });
    expect(windowRange(1000, 20, 19_780, 200)).toEqual({ start: 989 - OVERSCAN_ROWS, end: 1000 });
    expect(windowRange(0, 20, 0, 200)).toEqual({ start: 0, end: 0 });
    expect(windowRange(5, 20, -30, 200)).toEqual({ start: 0, end: 5 });
    // A scroll offset beyond a list that just got shorter is clamped to its last rows.
    expect(windowRange(100, 20, 19_800, 200)).toEqual({ start: 90 - OVERSCAN_ROWS, end: 100 });
  });

  it('mounts the edge rows, the focused row with its neighbours and the rename row', () => {
    const range = { start: 40, end: 66 };
    const window = Array.from({ length: 26 }, (_, index) => 40 + index);
    // Before the measurement only the range.
    expect(mountedIndexes({ start: 0, end: 32 }, 100, false, 70, 80)).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    );
    expect(mountedIndexes(range, 1000, true, null, null)).toEqual([0, ...window, 999]);
    expect(mountedIndexes(range, 1000, true, 500, 700)).toEqual([
      0,
      ...window,
      499,
      500,
      501,
      700,
      999,
    ]);
    // Neighbours stay inside the rows; a pin inside the window adds nothing.
    expect(mountedIndexes({ start: 0, end: 3 }, 3, true, 0, 2)).toEqual([0, 1, 2]);
    expect(mountedIndexes({ start: 0, end: 0 }, 0, true, null, null)).toEqual([]);
  });
});

describe('V20-U2 first render (section 4, row height)', () => {
  const markup = (target: Editor) =>
    renderToString(createElement(EditorProvider, { editor: target }, createElement(LayerTree)));

  it('mounts the first UNMEASURED_ROWS rows unpositioned in renderToString', () => {
    const { target, ids } = rectangles(UNMEASURED_ROWS + 8);
    const html = markup(target);
    const rows = [...html.matchAll(/<li data-testid="layer-([^"]+)"/gu)].map((match) => match[1]);
    // Front first: the last created rectangle is the first row.
    expect(rows).toEqual([...ids].reverse().slice(0, UNMEASURED_ROWS));
    expect(html).not.toContain('position:absolute');
    expect(html).toContain(`aria-setsize="${UNMEASURED_ROWS + 8}"`);
    expect(html).toContain('aria-posinset="1"');
    expect(html).toContain('<ul aria-label="layer list" style="margin:0;padding:0">');
  });

  it('mounts no rows for an empty page', () => {
    const html = markup(editor());
    expect(html).not.toContain('<li');
  });
});
