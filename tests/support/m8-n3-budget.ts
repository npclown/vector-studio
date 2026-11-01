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
// script on the machine that runs the specs (`--json`; `--headed` for the headed projects, each
// measured in its own channel). Headless projects read `M8_N3_HEADLESS_BASELINE` (a run without
// `--headed`) or, by default, the committed container measurement,
// `tests/fixtures/m8-n3/17a2b0a-headless.json`; a headed project needs
// `M8_N3_BASELINE`, since its window scrollbars change the widths (contract M8-N3). A row is
// taken only when it was measured in the reading project's channel and mode, so an Edge project
// is never compared with a Chrome measurement; a missing file or row fails the spec.
//
// A config that 17a2b0a did not have (M8-U7's `tests/m8-next-host/`) reads the row of an existing
// config at the same viewport, device scale factor, channel and mode, by `BASELINE_SOURCES`.

type BaselineRow = LayoutReading &
  Readonly<{
    config: string;
    project: string;
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    channel: string | null;
    headless: boolean;
  }>;

/** The project that reads a baseline row. */
export type BaselineReader = Readonly<{
  config: string;
  project: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  channel: string | null;
  headless: boolean;
}>;

const DEFAULT_BASELINE = path.resolve(
  import.meta.dirname,
  '../fixtures/m8-n3/17a2b0a-headless.json',
);
/** A layout float compared with the measured one: equal to a hundredth of a CSS px. */
const EPSILON = 0.01;

/**
 * Configs new since 17a2b0a and, per viewport (`<width>x<height>`), the 17a2b0a config whose rows
 * stand in for theirs: the M1 config at 1280 × 720 and the M2 config at 1280 × 900 load the same
 * `?test=1` page at those viewports, in Chrome, Edge and a headless smoke project.
 */
export const BASELINE_SOURCES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'playwright.m8-next-host.config.ts': {
    '1280x720': 'playwright.m1-next-host.config.ts',
    '1280x900': 'playwright.m2-next-host.config.ts',
  },
};

/** The row of `rows` that `reader` compares with; throws when none or several match. */
export function selectBaseline(
  rows: readonly BaselineRow[],
  reader: BaselineReader,
  file: string,
): BaselineRow {
  const where = `${reader.config} ${reader.project}`;
  const sameMode = (row: BaselineRow) =>
    row.channel === reader.channel && row.headless === reader.headless;
  const mode = `${reader.channel ?? 'chromium'}${reader.headless ? ' headless' : ' headed'}`;
  const sources = BASELINE_SOURCES[reader.config];
  if (sources === undefined) {
    const row = rows.find(
      (entry) => entry.config === reader.config && entry.project === reader.project,
    );
    if (row === undefined) throw new Error(`M8-N3: ${file} has no row for ${where}`);
    if (!sameMode(row)) {
      throw new Error(
        `M8-N3: ${file} measured ${where} in ${row.channel ?? 'chromium'}` +
          `${row.headless ? ' headless' : ' headed'}, not in ${mode}`,
      );
    }
    return row;
  }
  const key = `${reader.viewport.width}x${reader.viewport.height}`;
  const source = sources[key];
  if (source === undefined)
    throw new Error(`M8-N3: no 17a2b0a config stands in for ${where} at ${key}`);
  const matches = rows.filter(
    (row) =>
      row.config === source &&
      sameMode(row) &&
      row.viewport.width === reader.viewport.width &&
      row.viewport.height === reader.viewport.height &&
      row.deviceScaleFactor === reader.deviceScaleFactor,
  );
  if (matches.length !== 1) {
    throw new Error(
      `M8-N3: ${file} has ${matches.length} rows of ${source} in ${mode} at ${key} for ${where}`,
    );
  }
  return matches[0]!;
}

function baselineFor(reader: BaselineReader): BaselineRow {
  // Headed projects: the machine's own headed measurement, required. Headless projects: their own
  // file when named, else the committed container measurement.
  const named = reader.headless ? process.env.M8_N3_HEADLESS_BASELINE : process.env.M8_N3_BASELINE;
  if (named === undefined && !reader.headless) {
    throw new Error(
      'M8-N3: a headed project needs M8_N3_BASELINE, the JSON that ' +
        '`node tooling/m8-n3-measure.mjs --root <17a2b0a checkout> --headed --json <file>` ' +
        'wrote on this machine',
    );
  }
  const file = named ?? DEFAULT_BASELINE;
  const record = JSON.parse(readFileSync(file, 'utf8')) as { results: BaselineRow[] };
  return selectBaseline(record.results, reader, file);
}

/**
 * Asserts the M8-N3 budget (or, with `?bench=1`, the M8-N5 aside) on the loaded page.
 * `statusLines`: the height in CSS px of status lines 17a2b0a had no counterpart for (the M8
 * spec's `?test=1&faults=1` `panel-error` lines, M8-N2), which may add to the document height.
 */
export async function expectLayoutBudget(
  page: Page,
  options: Readonly<{ bench?: boolean; rename?: boolean; statusLines?: number }> = {},
): Promise<void> {
  const info = test.info();
  const use = info.project.use;
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('M8-N3: the page has no fixed viewport');
  const base = baselineFor({
    config: path.basename(info.config.configFile ?? ''),
    project: info.project.name,
    viewport,
    deviceScaleFactor: use.deviceScaleFactor ?? 1,
    channel: use.channel ?? null,
    headless: use.headless !== false,
  });
  // The page must be at the measured row's viewport, or the comparison would be vacuous.
  expect(viewport, 'M8-N3: viewport of the measured row').toEqual(base.viewport);
  const live = await page.evaluate(readLayout);
  const where = `${path.basename(info.config.configFile ?? '')} ${info.project.name}`;
  // 1. The canvas origin.
  expect(live.origin, `${where}: canvas origin`).toEqual(base.origin);
  // 2. No wider and no taller document; no horizontal scroll unless 17a2b0a overflowed. The
  // scroll sizes never drop below the client sizes, which a scrollbar shrinks: at 1280 x 900 the
  // 17a2b0a row 1 overflowed, its horizontal scrollbar made both its clientHeight and its
  // scrollHeight 885, and a page without that overflow fills the whole 900 px viewport. A size
  // within the live client size is no overflow at all, so the bound is the larger of the two.
  expect(live.scroll.scrollWidth, `${where}: scrollWidth`).toBeLessThanOrEqual(
    Math.max(base.scroll.scrollWidth, live.scroll.clientWidth),
  );
  expect(live.scroll.scrollHeight, `${where}: scrollHeight`).toBeLessThanOrEqual(
    Math.max(base.scroll.scrollHeight + (options.statusLines ?? 0), live.scroll.clientHeight),
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
