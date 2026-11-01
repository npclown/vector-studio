import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import teardown from '../m6c-next-host/m6c-observe-teardown.js';
import {
  fillerText,
  keystrokeRow,
  OBSERVE_KEYS,
  OBSERVE_TEXT_LENGTH,
  rasterFrameRow,
  stats,
  summaryMarkdown,
  typingSummary,
  type KeystrokeLog,
  type TypingReport,
} from '../m6c-next-host/m6c-observe.js';

// M6c-U5 (MVP M6c contract, section 9, M6c-A10): the pure half of the observation run.

describe('M6c-U5 observation helpers', () => {
  it('types 30 keys into a node that ends at the M6b maximum', () => {
    expect(OBSERVE_KEYS).toHaveLength(30);
    expect(OBSERVE_TEXT_LENGTH).toBe(16_384);
    const text = fillerText(OBSERVE_TEXT_LENGTH - OBSERVE_KEYS.length);
    expect(text).toHaveLength(16_354);
    expect((OBSERVE_KEYS + text).length).toBe(OBSERVE_TEXT_LENGTH);
    // BMP only, so one unit per cluster and no split surrogate pair at the cut.
    expect([...text]).toHaveLength(text.length);
    expect(text).toMatch(/한글/u);
    expect(text).toMatch(/^Typing cost /u);
    expect(fillerText(0)).toBe('');
    expect(() => fillerText(-1)).toThrow();
    expect(() => fillerText(1.5)).toThrow();
  });

  it('cuts one keystroke out of the page record', () => {
    const log: KeystrokeLog = {
      key: 'a',
      keydownMs: 105,
      quietMs: 150,
      // 100 is the frame before the keydown; its successor's interval holds the input.
      frames: [84, 100, 125, 133, 150, 166],
      layouts: [
        { startMs: 50, durationMs: 4 }, // before the keydown
        { startMs: 106, durationMs: 9 },
        { startMs: 126, durationMs: 1 },
      ],
      rasters: [
        { startMs: 126, durationMs: 2 },
        { startMs: 128, durationMs: 3 },
        { startMs: 134, durationMs: 0.5 },
        { startMs: 160, durationMs: 1 }, // after the quiet frame
      ],
      longFrames: [
        { startTime: 20, duration: 60, blockingDuration: 10 },
        { startTime: 100, duration: 55, blockingDuration: 5 },
      ],
    };
    expect(keystrokeRow(log)).toEqual({
      key: 'a',
      frameIntervalsMs: [25, 8, 17],
      maxFrameMs: 25,
      layoutCalls: 2,
      layoutMs: 10,
      maxLayoutMs: 9,
      rasterCalls: 3,
      rasterMs: 5.5,
      rasterFrames: 2,
      workEndMs: 29.5,
      quietMs: 45,
      longFrames: 1,
      longFrameMs: 55,
    });
    expect(() => keystrokeRow({ ...log, quietMs: 100 })).toThrow(/before keydown/u);
  });

  it('gives zeros for a keystroke without work', () => {
    const row = keystrokeRow({
      key: ' ',
      keydownMs: 10,
      quietMs: 10,
      frames: [],
      layouts: [],
      rasters: [],
      longFrames: [],
    });
    expect(row).toMatchObject({
      frameIntervalsMs: [],
      maxFrameMs: 0,
      layoutCalls: 0,
      rasterFrames: 0,
      workEndMs: 0,
      quietMs: 0,
    });
  });

  it('summarizes with the E28 quantile rule', () => {
    expect(stats([])).toEqual({ count: 0, mean: 0, median: 0, p95: 0, max: 0 });
    const values = Array.from({ length: 20 }, (_, index) => 20 - index);
    expect(stats(values)).toEqual({ count: 20, mean: 10.5, median: 11, p95: 20, max: 20 });
    expect(stats([1, 2])).toEqual({ count: 2, mean: 1.5, median: 2, p95: 2, max: 2 });
  });

  it('summarizes the typing rows and reads the E28 hand-off report', () => {
    const row = (layoutMs: number) =>
      keystrokeRow({
        key: 'x',
        keydownMs: 0,
        quietMs: 40,
        frames: [0, 16, 33],
        layouts: [{ startMs: 1, durationMs: layoutMs }],
        rasters: [],
        longFrames: [],
      });
    const summary = typingSummary([row(2), row(4)]);
    expect(summary.keystrokes).toBe(2);
    expect(summary.frameMs).toEqual({ count: 4, mean: 16.5, median: 17, p95: 17, max: 17 });
    expect(summary.layoutMs.mean).toBe(3);
    expect(summary.rasterCalls.max).toBe(0);
    const raster = rasterFrameRow('raster-chrome', {
      dpr: 2,
      cost: {
        cold: { meanMs: 0.1234567 },
        warm: { meanMs: 0.02 },
        frameDistinct: 64,
        frameCalls: 64,
        frameMs: 7.25,
      },
      fitsFrame: true,
      failures: [],
    });
    expect(raster).toEqual({
      project: 'raster-chrome',
      dpr: 2,
      frameCalls: 64,
      frameDistinct: 64,
      frameMs: 7.25,
      fitsFrame: true,
      coldMeanMs: 0.123,
      warmMeanMs: 0.02,
      failures: 0,
    });
    expect(() => rasterFrameRow('x', { rows: [] })).toThrow(/hand-off/u);
    const report: TypingReport = {
      project: 'typing-chrome',
      browser: '156.0',
      userAgent: 'test',
      devicePixelRatio: 1,
      renderer: true,
      startLength: 16_354,
      endLength: 16_384,
      lines: 120,
      setup: { createMs: 12.5, settleFrames: 14 },
      summary,
      rows: [],
    };
    const markdown = summaryMarkdown([report], [raster]);
    expect(markdown).toContain('16,384 units');
    expect(markdown).toContain(
      '| typing-chrome | 156.0 | 1 | yes | 120 | 12.5 | 16.5 / 17 / 17 / 17 |',
    );
    expect(markdown).toContain('| raster-chrome | 2 | 64 | 64 | 7.25 | yes | 0.123 | 0.02 | 0 |');
    expect(summaryMarkdown([], [])).toContain('No typing report.');
    expect(summaryMarkdown([], [])).toContain('No E28 hand-off report.');
  });

  describe('the teardown', () => {
    let root: string | null = null;
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      if (root !== null) rmSync(root, { recursive: true, force: true });
      root = null;
    });

    it('collects the typing and E28 hand-off reports and saves the summary', () => {
      root = mkdtempSync(path.join(tmpdir(), 'm6c-u5-'));
      vi.stubEnv('M6C_OBSERVE_DIR', root);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      mkdirSync(path.join(root, 'typing'));
      const report: TypingReport = {
        project: 'typing-edge',
        browser: '156.1',
        userAgent: 'test',
        devicePixelRatio: 1,
        renderer: true,
        startLength: 16_354,
        endLength: 16_384,
        lines: 99,
        setup: { createMs: 3, settleFrames: 12 },
        summary: typingSummary([]),
        rows: [],
      };
      writeFileSync(path.join(root, 'typing', 'typing-edge.json'), JSON.stringify(report));
      const handoff = path.join(root, 'e28', 'run-1', 'raster-edge', 'handoff-dpr-1');
      mkdirSync(handoff, { recursive: true });
      writeFileSync(
        path.join(handoff, 'report.json'),
        JSON.stringify({
          dpr: 1,
          cost: {
            cold: { meanMs: 0.2 },
            warm: { meanMs: 0.03 },
            frameDistinct: 64,
            frameCalls: 64,
            frameMs: 9,
          },
          fitsFrame: true,
          failures: [],
        }),
      );
      // Another E28 test's report is not a raster-cost report and is skipped.
      const other = path.join(root, 'e28', 'run-1', 'raster-edge', 'a04');
      mkdirSync(other, { recursive: true });
      writeFileSync(path.join(other, 'report.json'), '{}');
      teardown();
      const saved = readFileSync(path.join(root, 'summary.md'), 'utf8');
      expect(saved).toContain('| typing-edge | 156.1 | 1 | yes | 99 | 3 |');
      expect(saved).toContain('| raster-edge | 1 | 64 | 64 | 9 | yes | 0.2 | 0.03 | 0 |');
      expect(log).toHaveBeenCalledOnce();
    });

    it('does nothing without a run directory', () => {
      vi.stubEnv('M6C_OBSERVE_DIR', path.join(tmpdir(), 'm6c-u5-missing-directory'));
      expect(() => teardown()).not.toThrow();
    });
  });
});
