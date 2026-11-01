// MVP M8 contract, M8-N3 (M8-U6): the next-host layout values, read inside the page. This module
// imports nothing, so both `tooling/m8-n3-measure.mjs` (Node strips the types) and the spec
// helper in `tests/support/m8-n3-budget.ts` pass `readLayout` to `page.evaluate`. It finds the
// rows as the direct children of `main` that hold the `tool-select` button (row 1), the `pages`
// element (row 2) and the canvas (the canvas row), which holds at 17a2b0a and since M8-U6.

/** The M8-N3 values of the page as loaded, in CSS px. */
export type LayoutReading = {
  /** The canvas content box's origin (inside its border). */
  origin: { x: number; y: number };
  /** The canvas row: its height, and its width up to the right edge of its last child. */
  canvasRow: { width: number | null; height: number | null };
  /** The computed width of the Appearance aside or section (`appearance-panel`). */
  aside: number | null;
  /** The right column (`right-column`, since M8-U6), or null. */
  rightColumn: { width: number; height: number | null; overflowY: string } | null;
  /** Each toolbar row's width up to the right edge of its last child. */
  row1Width: number | null;
  row2Width: number | null;
  row2Height: number | null;
  /** True when row 2's first child holds the page list (`pages`) and starts at the row's left. */
  pagesFirst: boolean;
  /** The window's inner height. */
  innerHeight: number;
  /** The document element's scroll and client sizes. */
  scroll: { scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number };
};

/** Runs in the page: the M8-N3 values (M8-U6). */
export function readLayout(): LayoutReading {
  const main = document.querySelector('main');
  const canvas = document.querySelector('canvas');
  if (main === null || canvas === null) throw new Error('readLayout: no main or no canvas');
  const rowOf = (element: Element | null): Element | null => {
    let node = element;
    while (node !== null && node.parentElement !== main) node = node.parentElement;
    return node;
  };
  const extent = (row: Element | null): number | null => {
    if (row === null) return null;
    const left = row.getBoundingClientRect().left;
    let right = left;
    for (const child of row.children) right = Math.max(right, child.getBoundingClientRect().right);
    return right - left;
  };
  const height = (element: Element | null): number | null =>
    element === null ? null : element.getBoundingClientRect().height;
  const canvasRow = rowOf(canvas);
  const row1 = rowOf(document.querySelector('[data-testid="tool-select"]'));
  const pages = document.querySelector('[data-testid="pages"]');
  const row2 = rowOf(pages);
  const first = row2?.firstElementChild ?? null;
  const aside = document.querySelector('[data-testid="appearance-panel"]');
  const column = document.querySelector('[data-testid="right-column"]');
  const rect = canvas.getBoundingClientRect();
  const root = document.documentElement;
  return {
    origin: { x: rect.left + canvas.clientLeft, y: rect.top + canvas.clientTop },
    canvasRow: { width: extent(canvasRow), height: height(canvasRow) },
    aside: aside === null ? null : Number.parseFloat(getComputedStyle(aside).width),
    rightColumn:
      column === null
        ? null
        : {
            width: column.getBoundingClientRect().width,
            height: height(column),
            overflowY: getComputedStyle(column).overflowY,
          },
    row1Width: extent(row1),
    row2Width: extent(row2),
    row2Height: height(row2),
    pagesFirst:
      row2 !== null &&
      first !== null &&
      pages !== null &&
      first.contains(pages) &&
      first.getBoundingClientRect().left === row2.getBoundingClientRect().left,
    innerHeight: window.innerHeight,
    scroll: {
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
    },
  };
}
