/* global window */
// M6-S0 (d): canvas versus DOM ink boxes per cluster, measured as plan M6-G3 describes. Each
// single-line fixture is laid out in the measurement element made visible with every cluster
// transparent; one cluster at a time is shown and screenshotted (the DOM side). PROBE_MODES picks
// the isolation: `spans` (one span per cluster, colour toggled) and `highlight` (a CSS custom
// highlight, no DOM change, but Chrome clips its painting to the range box). The same cluster is
// drawn with OffscreenCanvas fillText at the DOM origin and baseline, same font list and lang, at
// the same DPR (the canvas side). Both images are thresholded into ink boxes and compared in CSS
// px. See README.md.
import {
  koreanFamily,
  latinFamily,
  launch,
  list,
  metadata,
  numbers,
  openPage,
  round,
  serve,
  writeReport,
} from './lib.mjs';

const dprs = numbers('DPRS', '1,2');
// A clip at whole CSS px maps to whole device px only at an integer DPR.
if (dprs.some((dpr) => !Number.isInteger(dpr) || dpr < 1)) {
  throw new Error(`DPRS must be positive integers for ink boxes, got ${dprs.join(',')}`);
}
const thresholds = numbers('THRESHOLDS', '16,128');
const modes = list('PROBE_MODES', 'spans,highlight');
const latin = latinFamily();
const korean = koreanFamily();
const single = (id, family, size, text) => ({
  id,
  runs: [{ text, family, size }],
  sizing: 'autoWidth',
  width: 0,
  letterSpacing: 0,
  lineHeight: 1.2,
});
const FIXTURES = [
  single('latin-kerning', latin, 32, 'AVATAR Wa To Ty.'),
  single('hangul', korean, 32, '한글 편집기 벡터'),
  single('hangul-in-latin', latin, 32, 'Vector 한글 Studio'),
  // Han and CJK punctuation in the Latin family: the same text as fallback.mjs's default.
  single('han-in-latin', latin, 32, '漢字 한자「한글」。'),
  {
    id: 'mixed-sizes',
    runs: [
      { text: 'Ab', family: latin, size: 24 },
      { text: '한글', family: korean, size: 40 },
      { text: 'xy', family: latin, size: 16 },
    ],
    sizing: 'autoWidth',
    width: 0,
    letterSpacing: 0,
    lineHeight: 1.2,
  },
  single('small-12', latin, 12, 'Hello 한글 AV'),
  single('small-9', korean, 9, '가나 ab'),
];

function toCss(box, clip, dpr) {
  if (!box) return null;
  return {
    left: clip.x + box.x0 / dpr,
    top: clip.y + box.y0 / dpr,
    right: clip.x + box.x1 / dpr,
    bottom: clip.y + box.y1 / dpr,
  };
}

/** Subpixel measures (device px within the clip) to CSS px on the page. */
function subToCss(sub, clip, dpr) {
  if (!sub) return null;
  return {
    left: clip.x + sub.left / dpr,
    top: clip.y + sub.top / dpr,
    right: clip.x + sub.right / dpr,
    bottom: clip.y + sub.bottom / dpr,
    cx: clip.x + sub.cx / dpr,
    cy: clip.y + sub.cy / dpr,
    massCssPx2: sub.mass / (dpr * dpr),
  };
}

function subDiff(dom, canvas) {
  const edges = diff(dom, canvas);
  if (!edges) return null;
  return {
    ...edges,
    centroidOffset: Math.max(Math.abs(canvas.cx - dom.cx), Math.abs(canvas.cy - dom.cy)),
    massRatio: canvas.massCssPx2 / dom.massCssPx2,
  };
}

function diff(dom, canvas) {
  if (!dom || !canvas) return null;
  const dLeft = canvas.left - dom.left;
  const dTop = canvas.top - dom.top;
  const dRight = canvas.right - dom.right;
  const dBottom = canvas.bottom - dom.bottom;
  const dWidth = canvas.right - canvas.left - (dom.right - dom.left);
  const dHeight = canvas.bottom - canvas.top - (dom.bottom - dom.top);
  return {
    dLeft,
    dTop,
    dRight,
    dBottom,
    /** M6-G2 offset: the larger of the left and top edge shifts. */
    offset: Math.max(Math.abs(dLeft), Math.abs(dTop)),
    centerOffset: Math.max(Math.abs((dLeft + dRight) / 2), Math.abs((dTop + dBottom) / 2)),
    /** M6-G2 size difference: the larger of the width and height differences. */
    sizeDiff: Math.max(Math.abs(dWidth), Math.abs(dHeight)),
  };
}

const server = await serve();
const { browser, launch: launchInfo } = await launch();
try {
  let meta = null;
  const runs = [];
  for (const dpr of dprs) {
    const { page, context, errors } = await openPage(browser, server.base, { dpr });
    meta ??= await metadata(browser, launchInfo, page);
    for (const [mode, fixture] of modes.flatMap((m) => FIXTURES.map((f) => [m, f]))) {
      const shown = await page.evaluate(
        ([node, probeMode]) => window.__vectorStudioM6S0.probeShow(node, probeMode),
        [fixture, mode],
      );
      const valid = shown.clusters.filter((c) => Number.isFinite(c.left));
      const margin = Math.ceil(Math.max(...fixture.runs.map((r) => r.size)) * 0.5) + 2;
      const lineClip = {
        x: Math.floor(Math.min(...valid.map((c) => c.left)) - margin),
        y: Math.floor(Math.min(...valid.map((c) => c.top)) - margin),
        width: 0,
        height: 0,
      };
      lineClip.width =
        Math.ceil(Math.max(...valid.map((c) => c.left + c.width)) + margin) - lineClip.x;
      lineClip.height =
        Math.ceil(Math.max(...valid.map((c) => c.top + c.height)) + margin) - lineClip.y;

      // Isolation check: every cluster shown through the probe mode versus ordinary black text.
      await page.evaluate(() => window.__vectorStudioM6S0.probeHighlight('plain'));
      const plain = (
        await page.screenshot({ clip: lineClip, animations: 'disabled', caret: 'hide' })
      ).toString('base64');
      await page.evaluate(() => window.__vectorStudioM6S0.probeHighlight(-1));
      const all = (
        await page.screenshot({ clip: lineClip, animations: 'disabled', caret: 'hide' })
      ).toString('base64');
      const highlightVsPlain = await page.evaluate(
        ([a, b]) => window.__vectorStudioM6S0.pngDiff(a, b),
        [plain, all],
      );

      const clusters = [];
      for (const cluster of shown.clusters) {
        if (!Number.isFinite(cluster.left) || cluster.text.trim() === '') continue;
        const pad = Math.ceil(cluster.size * 0.5) + 2;
        const clip = {
          x: Math.floor(cluster.left - pad),
          y: Math.floor(cluster.top - pad),
          width: Math.ceil(cluster.width + 2 * pad) + 1,
          height: Math.ceil(cluster.height + 2 * pad) + 1,
        };
        await page.evaluate(
          (index) => window.__vectorStudioM6S0.probeHighlight(index),
          cluster.index,
        );
        const shot = (
          await page.screenshot({ clip, animations: 'disabled', caret: 'hide' })
        ).toString('base64');
        const dom = await page.evaluate(
          ([png, t]) => window.__vectorStudioM6S0.domInk(png, t),
          [shot, thresholds],
        );
        const canvas = await page.evaluate(
          (request) => window.__vectorStudioM6S0.canvasInk(request),
          {
            clip,
            text: cluster.text,
            family: cluster.family,
            size: cluster.size,
            x: cluster.left,
            baseline: shown.baseline,
            dpr,
            thresholds,
          },
        );
        const byThreshold = thresholds.map((threshold, t) => {
          const domBox = toCss(dom.boxes[t], clip, dpr);
          const canvasBox = toCss(canvas.boxes[t], clip, dpr);
          return {
            threshold,
            dom: domBox,
            canvas: canvasBox,
            domInked: dom.boxes[t]?.inked ?? 0,
            canvasInked: canvas.boxes[t]?.inked ?? 0,
            diff: diff(domBox, canvasBox),
          };
        });
        clusters.push({
          index: cluster.index,
          text: cluster.text,
          family: cluster.family,
          size: cluster.size,
          clip,
          imageSize: { dom: [dom.width, dom.height], canvas: [canvas.width, canvas.height] },
          byThreshold,
          subpixel: (() => {
            const domSub = subToCss(dom.subpixel, clip, dpr);
            const canvasSub = subToCss(canvas.subpixel, clip, dpr);
            return { dom: domSub, canvas: canvasSub, diff: subDiff(domSub, canvasSub) };
          })(),
        });
      }
      const maxima = thresholds.map((threshold, t) => {
        const diffs = clusters.map((c) => c.byThreshold[t].diff).filter(Boolean);
        return {
          threshold,
          clusters: clusters.length,
          compared: diffs.length,
          blank: clusters.length - diffs.length,
          maxOffset: round(Math.max(0, ...diffs.map((d) => d.offset))),
          maxCenterOffset: round(Math.max(0, ...diffs.map((d) => d.centerOffset))),
          maxSizeDiff: round(Math.max(0, ...diffs.map((d) => d.sizeDiff))),
        };
      });
      const subDiffs = clusters.map((c) => c.subpixel.diff).filter(Boolean);
      const subpixelMaxima = {
        compared: subDiffs.length,
        maxOffset: round(Math.max(0, ...subDiffs.map((d) => d.offset))),
        maxSizeDiff: round(Math.max(0, ...subDiffs.map((d) => d.sizeDiff))),
        maxCentroidOffset: round(Math.max(0, ...subDiffs.map((d) => d.centroidOffset))),
        massRatioRange: subDiffs.length
          ? [
              round(Math.min(...subDiffs.map((d) => d.massRatio))),
              round(Math.max(...subDiffs.map((d) => d.massRatio))),
            ]
          : null,
      };
      runs.push({
        dpr,
        mode,
        fixture: fixture.id,
        layoutDeltaVsPlain: shown.layoutDelta,
        subpixelMaxima,
        node: fixture,
        baseline: shown.baseline,
        highlightVsPlain,
        maxima,
        clusters,
        pageErrors: errors,
      });
    }
    await page.evaluate(() => window.__vectorStudioM6S0.probeHide());
    await context.close();
  }
  const table = runs.flatMap((run) =>
    run.maxima.map((m) => ({
      dpr: run.dpr,
      mode: run.mode,
      fixture: run.fixture,
      threshold: m.threshold,
      compared: m.compared,
      blank: m.blank,
      maxOffset: m.maxOffset,
      maxSizeDiff: m.maxSizeDiff,
      subOffset: run.subpixelMaxima.maxOffset,
      subSizeDiff: run.subpixelMaxima.maxSizeDiff,
      centroid: run.subpixelMaxima.maxCentroidOffset,
      allShownVsPlainPx: run.highlightVsPlain.differing,
      layoutDelta: round(run.layoutDeltaVsPlain),
    })),
  );
  console.table(table);
  writeReport('ink-boxes', launchInfo, {
    ...meta,
    measurement: 'd: canvas vs DOM ink boxes per cluster (M6-G3 method)',
    options: {
      dprs,
      modes,
      thresholds,
      latin,
      korean,
      coverage: '255 - min(R, G, B) over white',
      subpixel: 'coverage-weighted edges and centroid; coverage <= 2/255 ignored',
    },
    proposedTolerance: { offsetCssPx: 0.5, sizeDiffCssPx: 1, source: 'plan M6-G2' },
    summary: table,
    runs,
  });
} finally {
  await browser.close();
  await server.close();
}
