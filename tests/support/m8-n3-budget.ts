import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { readLayout, type LayoutReading } from './m8-n3-read.js';

// MVP M8 contract, M8-N3 and M8-N5 (M8-U6, M8-A12): the layout budget every next-host spec checks
// after load, against the values measured at 17a2b0a for its own config and project by
// `tooling/m8-n3-measure.mjs`:
//
// 1. the canvas content box's origin is the 17a2b0a one;
// 2. the document is no wider and no taller than at 17a2b0a, and has no horizontal scroll
//    (`scrollWidth <= clientWidth`) unless the 17a2b0a canvas row itself overflowed;
// 3. rows 1 and 2 each fit within the 17a2b0a canvas row width, the page list on the left of
//    row 2, and row 2 has its 17a2b0a height (with `rename`, also while a page rename textbox is
//    open);
// 4. the right column has the 17a2b0a Appearance aside's width and the canvas row's height, scrolls
//    itself (`overflow-y: auto`), and the canvas origin's y plus its height is at most the
//    viewport height. With `?bench=1` the column rules do not apply (M8-N5): the 17a2b0a aside
//    keeps its measured width and no right column exists.
//
// The 17a2b0a values come from the JSON file `M8_N3_BASELINE` names, written by the measurement
// script on the machine that runs the specs (`--json`). Headless smoke projects fall back to the
// committed container measurement, `tests/fixtures/m8-n3/17a2b0a-headless.json`; a headed project
// needs `M8_N3_BASELINE`, since its window scrollbars change the widths (contract M8-N3).

type BaselineRow = LayoutReading & Readonly<{ config: string; project: string }>;

const DEFAULT_BASELINE = path.resolve(
  import.meta.dirname,
  '../fixtures/m8-n3/17a2b0a-headless.json',
);
/** A layout float compared with the measured one: equal to a hundredth of a CSS px. */
const EPSILON = 0.01;

function baselineFor(configFile: string, project: string, headless: boolean): BaselineRow {
  const named = process.env.M8_N3_BASELINE;
  if (named === undefined && !headless) {
    throw new Error(
      'M8-N3: a headed project needs M8_N3_BASELINE, the JSON that ' +
        '`node tooling/m8-n3-measure.mjs --root <17a2b0a checkout> --headed --channel <chrome|msedge> ' +
        '--json <file>` wrote on this machine',
    );
  }
  const file = named ?? DEFAULT_BASELINE;
  const record = JSON.parse(readFileSync(file, 'utf8')) as { results: BaselineRow[] };
  const config = path.basename(configFile);
  const row = record.results.find((entry) => entry.config === config && entry.project === project);
  if (row === undefined) throw new Error(`M8-N3: ${file} has no row for ${config} ${project}`);
  return row;
}

/** Asserts the M8-N3 budget (or, with `?bench=1`, the M8-N5 aside) on the loaded page. */
export async function expectLayoutBudget(
  page: Page,
  options: Readonly<{ bench?: boolean; rename?: boolean }> = {},
): Promise<void> {
  const info = test.info();
  const headless = info.project.use.headless !== false;
  const base = baselineFor(info.config.configFile ?? '', info.project.name, headless);
  const live = await page.evaluate(readLayout);
  const where = `${path.basename(info.config.configFile ?? '')} ${info.project.name}`;
  // 1. The canvas origin.
  expect(live.origin, `${where}: canvas origin`).toEqual(base.origin);
  // 2. No wider and no taller document; no horizontal scroll unless 17a2b0a overflowed.
  expect(live.scroll.scrollWidth, `${where}: scrollWidth`).toBeLessThanOrEqual(
    base.scroll.scrollWidth,
  );
  expect(live.scroll.scrollHeight, `${where}: scrollHeight`).toBeLessThanOrEqual(
    base.scroll.scrollHeight,
  );
  const overflowed = (base.canvasRow.width ?? 0) > base.scroll.clientWidth;
  if (overflowed) {
    info.annotations.push({
      type: 'M8-N3',
      description: `${where}: the 17a2b0a canvas row (${base.canvasRow.width} px) overflowed`,
    });
  } else {
    expect(live.scroll.scrollWidth, `${where}: horizontal scroll`).toBeLessThanOrEqual(
      live.scroll.clientWidth,
    );
  }
  // 3. Rows 1 and 2 within the 17a2b0a canvas row width, the page list first, row 2's height.
  const width = base.canvasRow.width!;
  expect(live.row1Width!, `${where}: row 1 width`).toBeLessThanOrEqual(width + EPSILON);
  expect(live.row2Width!, `${where}: row 2 width`).toBeLessThanOrEqual(width + EPSILON);
  expect(live.pagesFirst, `${where}: the page list on the left of row 2`).toBe(true);
  expect(live.row2Height, `${where}: row 2 height`).toBe(base.row2Height);
  expect(live.canvasRow.height, `${where}: canvas row height`).toBe(base.canvasRow.height);
  if (options.bench === true) {
    // M8-N5: the 17a2b0a aside, no right column.
    expect(live.rightColumn, `${where}: no right column with ?bench=1`).toBeNull();
    expect(live.aside!, `${where}: aside width`).toBeCloseTo(base.aside!, 2);
  } else {
    // 4. The right column.
    const column = live.rightColumn;
    expect(column, `${where}: right column`).not.toBeNull();
    expect(column!.width, `${where}: right column width`).toBeCloseTo(base.aside!, 2);
    expect(column!.height, `${where}: right column height`).toBe(base.canvasRow.height);
    expect(column!.overflowY, `${where}: right column scrolls`).toBe('auto');
    expect(live.origin.y + column!.height!, `${where}: column fits`).toBeLessThanOrEqual(
      live.innerHeight,
    );
  }
  if (options.rename === true) {
    const button = page.getByTestId('pages').getByRole('button').first();
    await button.dblclick();
    const textbox = page.getByTestId('pages').getByRole('textbox', { name: 'page name' });
    await expect(textbox).toBeVisible();
    const renaming = await page.evaluate(readLayout);
    expect(renaming.row2Height, `${where}: row 2 height while renaming`).toBe(base.row2Height);
    expect(renaming.row2Width!, `${where}: row 2 width while renaming`).toBeLessThanOrEqual(
      width + EPSILON,
    );
    await textbox.press('Escape');
    await expect(textbox).toHaveCount(0);
  }
}
