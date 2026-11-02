import { expect, type Page } from '@playwright/test';

// V-20 contract, section 4: the layer list is windowed, so a row out of view is not in the DOM.
// These helpers scroll the list to a row before a test uses it, and read the row count from
// `aria-setsize` instead of counting `li` elements.

/**
 * Scrolls the layer list until the row `layer-<id>` is mounted, then into view. The list is
 * stepped from the top by its own height, so every row is reached in order.
 */
export async function scrollToLayerRow(page: Page, id: string): Promise<void> {
  const found = await page.evaluate(async (rowId) => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="layer-list-viewport"]');
    if (viewport === null) return false;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const find = () => document.querySelector(`[data-testid="layer-${CSS.escape(rowId)}"]`);
    viewport.scrollTop = 0;
    await frame();
    for (;;) {
      const row = find();
      if (row !== null) {
        row.scrollIntoView({ block: 'nearest' });
        await frame();
        return true;
      }
      const before = viewport.scrollTop;
      viewport.scrollTop = before + Math.max(1, viewport.clientHeight);
      await frame();
      await frame();
      if (viewport.scrollTop === before) return find() !== null;
    }
  }, id);
  expect(found, `layer row ${id} reachable by scrolling`).toBe(true);
}

/** The layer list's row count: `aria-setsize` of a mounted row, or 0 for an empty list. */
export async function layerRowCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="layers"] li[aria-setsize]');
    return row === null ? 0 : Number(row.getAttribute('aria-setsize'));
  });
}

/** Scrolls to and clicks `layer-toggle-<id>` for each ID in order, waiting for each expansion. */
export async function expandLayerRows(page: Page, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await scrollToLayerRow(page, id);
    const toggle = page.getByTestId(`layer-toggle-${id}`);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
}
