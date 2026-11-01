// M6c-U5 (MVP M6c contract, section 9 and M6c-A10): the pure half of the observation run
// (playwright.m6c-observe.config.ts): the text of the 16,384-unit node, the per-keystroke
// figures of the typing observation, the E28 raster-frame figures, and the summary the run's
// teardown prints. Observations are recorded, not judged (section 9: no gate, no claim), so
// nothing here holds a bound. Kept free of Playwright and of the DOM so it is unit tested
// (tests/unit/m6c-u5-observe.test.ts).

/** `MAX_TEXT_LENGTH` (M6b section 1): the node ends the 30 keystrokes at this length. */
export const OBSERVE_TEXT_LENGTH = 16_384;

/** The 30 keystrokes (M6b-Q15 (a), section 9), typed one key at a time at offset 0. */
export const OBSERVE_KEYS = 'the quick brown fox jumps over';

/** Frames with no new layout or raster call and unchanged counters that close a keystroke. */
export const QUIET_FRAMES = 10;

const FILLER = 'Typing cost 한글 observation, wrapped text 문장 sample. ';

/**
 * The node's starting text: `length` UTF-16 units of Latin and Hangul words with spaces, all in
 * the BMP and in the committed test font's subset, so every unit is one cluster.
 */
export function fillerText(length: number): string {
  if (!Number.isInteger(length) || length < 0) throw new Error(`invalid length ${length}`);
  return FILLER.repeat(Math.ceil(length / FILLER.length)).slice(0, length);
}

/** One timed call: `startMs` on the page's `performance.now()` clock. */
export type TimedCall = Readonly<{ startMs: number; durationMs: number }>;

/** What the page recorded around one keystroke (the spec's in-page instrumentation). */
export type KeystrokeLog = Readonly<{
  key: string;
  /** The keydown event's `timeStamp`. */
  keydownMs: number;
  /** The `requestAnimationFrame` time of the first of the `QUIET_FRAMES` quiet frames. */
  quietMs: number;
  /** Every `requestAnimationFrame` time the page saw, in order. */
  frames: readonly number[];
  /** The port's `layout` calls (text-dom), timed by the spec's wrapper. */
  layouts: readonly TimedCall[];
  /** The host service's glyph raster port calls (`glyphRasterLog`); empty without a renderer. */
  rasters: readonly TimedCall[];
  /** `long-animation-frame` entries, where the browser reports them. */
  longFrames: readonly Readonly<{
    startTime: number;
    duration: number;
    blockingDuration: number;
  }>[];
}>;

/** The figures of one keystroke, in ms relative to its keydown where a time is given. */
export type KeystrokeRow = Readonly<{
  key: string;
  /** Intervals between consecutive animation frames from the one before the keydown. */
  frameIntervalsMs: readonly number[];
  maxFrameMs: number;
  layoutCalls: number;
  layoutMs: number;
  maxLayoutMs: number;
  rasterCalls: number;
  rasterMs: number;
  /** Frames with at least one raster call (the E28 budget spreads a miss set over frames). */
  rasterFrames: number;
  /** End of the last layout or raster call after the keydown; 0 with none. */
  workEndMs: number;
  /** The first quiet frame. */
  quietMs: number;
  longFrames: number;
  longFrameMs: number;
}>;

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const round = (value: number) => Math.round(value * 1000) / 1000;

/** The calls of `log` that start at or after the keydown and before the quiet frame. */
function inWindow(calls: readonly TimedCall[], from: number, to: number): TimedCall[] {
  return calls.filter((call) => call.startMs >= from && call.startMs < to);
}

export function keystrokeRow(log: KeystrokeLog): KeystrokeRow {
  const from = log.keydownMs;
  const to = log.quietMs;
  if (!(to >= from)) throw new Error(`${log.key}: quiet frame ${to} before keydown ${from}`);
  const intervals: number[] = [];
  for (let index = 1; index < log.frames.length; index += 1) {
    const frame = log.frames[index]!;
    const previous = log.frames[index - 1]!;
    // The frame that spans the keydown counts: its interval holds the input's handling.
    if (frame > from && frame <= to) intervals.push(frame - previous);
  }
  const layouts = inWindow(log.layouts, from, to);
  const rasters = inWindow(log.rasters, from, to);
  const ends = [...layouts, ...rasters].map((call) => call.startMs + call.durationMs - from);
  // A raster call belongs to the frame whose time is the latest at or before its start.
  const rasterFrames = new Set<number>();
  for (const call of rasters) {
    let frame = -Infinity;
    for (const time of log.frames) if (time <= call.startMs) frame = time;
    rasterFrames.add(frame);
  }
  const longFrames = log.longFrames.filter(
    (entry) => entry.startTime + entry.duration > from && entry.startTime < to,
  );
  return {
    key: log.key,
    frameIntervalsMs: intervals.map(round),
    maxFrameMs: round(Math.max(0, ...intervals)),
    layoutCalls: layouts.length,
    layoutMs: round(sum(layouts.map((call) => call.durationMs))),
    maxLayoutMs: round(Math.max(0, ...layouts.map((call) => call.durationMs))),
    rasterCalls: rasters.length,
    rasterMs: round(sum(rasters.map((call) => call.durationMs))),
    rasterFrames: rasterFrames.size,
    workEndMs: round(Math.max(0, ...ends)),
    quietMs: round(to - from),
    longFrames: longFrames.length,
    longFrameMs: round(sum(longFrames.map((entry) => entry.duration))),
  };
}

export type Stats = Readonly<{
  count: number;
  mean: number;
  median: number;
  p95: number;
  max: number;
}>;

/** Mean, median, 95th percentile and maximum, with the E28 spec's quantile (`floor(q · n)`). */
export function stats(values: readonly number[]): Stats {
  if (values.length === 0) return { count: 0, mean: 0, median: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    count: sorted.length,
    mean: round(sum(sorted) / sorted.length),
    median: round(quantile(0.5)),
    p95: round(quantile(0.95)),
    max: round(sorted[sorted.length - 1]!),
  };
}

export type TypingSummary = Readonly<{
  keystrokes: number;
  /** Every frame interval of every keystroke. */
  frameMs: Stats;
  /** Per keystroke. */
  maxFrameMs: Stats;
  layoutMs: Stats;
  layoutCalls: Stats;
  rasterMs: Stats;
  rasterCalls: Stats;
  rasterFrames: Stats;
  workEndMs: Stats;
  quietMs: Stats;
  longFrames: number;
}>;

export function typingSummary(rows: readonly KeystrokeRow[]): TypingSummary {
  const of = (pick: (row: KeystrokeRow) => number) => stats(rows.map(pick));
  return {
    keystrokes: rows.length,
    frameMs: stats(rows.flatMap((row) => row.frameIntervalsMs)),
    maxFrameMs: of((row) => row.maxFrameMs),
    layoutMs: of((row) => row.layoutMs),
    layoutCalls: of((row) => row.layoutCalls),
    rasterMs: of((row) => row.rasterMs),
    rasterCalls: of((row) => row.rasterCalls),
    rasterFrames: of((row) => row.rasterFrames),
    workEndMs: of((row) => row.workEndMs),
    quietMs: of((row) => row.quietMs),
    longFrames: sum(rows.map((row) => row.longFrames)),
  };
}

/** The typing report the spec writes, one per project. */
export type TypingReport = Readonly<{
  project: string;
  browser: string;
  userAgent: string;
  devicePixelRatio: number;
  renderer: boolean;
  startLength: number;
  endLength: number;
  lines: number;
  setup: Readonly<{ createMs: number; settleFrames: number }>;
  summary: TypingSummary;
  rows: readonly KeystrokeRow[];
}>;

/** The E28 raster-cost figures of one `handoff-dpr-N/report.json` (tests/gpu/e28-text-atlas.spec.ts). */
export type RasterFrameRow = Readonly<{
  project: string;
  dpr: number;
  frameCalls: number;
  frameDistinct: number;
  frameMs: number;
  fitsFrame: boolean;
  coldMeanMs: number;
  warmMeanMs: number;
  failures: number;
}>;

type Cost = Readonly<{ meanMs: number }>;

/** Reads one E28 hand-off report; throws on a report without the raster-cost figures. */
export function rasterFrameRow(project: string, report: unknown): RasterFrameRow {
  const value = report as {
    dpr?: number;
    cost?: { frameCalls: number; frameDistinct: number; frameMs: number; cold: Cost; warm: Cost };
    fitsFrame?: boolean;
    failures?: unknown[];
  };
  const cost = value.cost;
  if (typeof value.dpr !== 'number' || cost === undefined) {
    throw new Error(`${project}: not an E28 hand-off report`);
  }
  return {
    project,
    dpr: value.dpr,
    frameCalls: cost.frameCalls,
    frameDistinct: cost.frameDistinct,
    frameMs: round(cost.frameMs),
    fitsFrame: value.fitsFrame === true,
    coldMeanMs: round(cost.cold.meanMs),
    warmMeanMs: round(cost.warm.meanMs),
    failures: value.failures?.length ?? 0,
  };
}

const cell = (s: Stats) => `${s.mean} / ${s.median} / ${s.p95} / ${s.max}`;

/** The Markdown the teardown prints and saves: one table per observation. */
export function summaryMarkdown(
  typing: readonly TypingReport[],
  raster: readonly RasterFrameRow[],
): string {
  const lines: string[] = ['# M6c-U5 observations (section 9; recorded, not judged)', ''];
  lines.push(
    `## Typing: ${OBSERVE_KEYS.length} keystrokes at offset 0 of a node growing to ${OBSERVE_TEXT_LENGTH.toLocaleString('en-US')} units`,
    '',
  );
  if (typing.length === 0) {
    lines.push('No typing report.', '');
  } else {
    lines.push(
      'Figures in ms as mean / median / p95 / max (per keystroke unless named).',
      '',
      '| Project | Browser | DPR | Renderer | Lines | Create | Frame (every interval) | Max frame | Layout | Layout calls | Raster | Raster calls | Raster frames | Last work | Quiet from | Long frames |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const report of typing) {
      const s = report.summary;
      lines.push(
        `| ${report.project} | ${report.browser} | ${report.devicePixelRatio} | ${report.renderer ? 'yes' : 'no'} | ${report.lines} | ${round(report.setup.createMs)} | ${cell(s.frameMs)} | ${cell(s.maxFrameMs)} | ${cell(s.layoutMs)} | ${cell(s.layoutCalls)} | ${cell(s.rasterMs)} | ${cell(s.rasterCalls)} | ${cell(s.rasterFrames)} | ${cell(s.workEndMs)} | ${cell(s.quietMs)} | ${s.longFrames} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Raster frame: one E28 budget-sized frame of distinct calls (E28 spec)', '');
  if (raster.length === 0) {
    lines.push('No E28 hand-off report.', '');
  } else {
    lines.push(
      '| Project | DPR | Calls | Distinct | Frame ms | Within 16.7 ms | Cold mean ms | Warm mean ms | Spec failures |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const row of raster) {
      lines.push(
        `| ${row.project} | ${row.dpr} | ${row.frameCalls} | ${row.frameDistinct} | ${row.frameMs} | ${row.fitsFrame ? 'yes' : 'no'} | ${row.coldMeanMs} | ${row.warmMeanMs} | ${row.failures} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
