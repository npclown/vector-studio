/* global window */
// M6-S0 (c): the fallback hypothesis (plan M6-F2). Lays out Hangul and mixed text in a Latin-only
// family (LATIN_FAMILY, default Arial) with the M6-F2 font list and lang=ko, and compares DOM
// cluster advances with OffscreenCanvas measureText on the main thread (with and without
// ctx.lang) and in a dedicated worker (self.fonts, not document.fonts). A FontFace registered in
// document.fonts only shows the worker difference. The fonts the DOM actually used come from the
// Chrome DevTools Protocol (CSS.getPlatformFontsForNode). Canvas ink is in ink-boxes.mjs.
import {
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

const options = {
  latinFamily: latinFamily(),
  texts: list(
    'TEXTS',
    '한글,Hello 한글 World,가나다라마바사,AV 벡터 To,했습니다.,漢字 한자「한글」。,Vector Studio',
  ),
  sizes: numbers('SIZES', '12,16,24'),
};

const server = await serve();
const { browser, launch: launchInfo } = await launch();
try {
  const { page, context, errors } = await openPage(browser, server.base, { dpr: 1 });
  const meta = await metadata(browser, launchInfo, page);
  const result = await page.evaluate((opts) => window.__vectorStudioM6S0.fallback(opts), options);

  // Which platform fonts the DOM used per text (light-DOM copies with the same font list and lang).
  const ids = await page.evaluate(
    (opts) => window.__vectorStudioM6S0.platformFontProbes(opts),
    options,
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const platformFonts = [];
  for (const [index, id] of ids.entries()) {
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: `#${id}`,
    });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    platformFonts.push({ text: options.texts[index], fonts });
  }

  const rows = result.results.map((row) => ({
    family: row.family,
    size: row.size,
    text: row.text,
    domTotal: round(row.domTotal),
    canvasLang: round(row.canvasLang.total),
    worker: round(row.workerLang?.total),
    maxClusterDomVsCanvas: round(row.maxClusterDelta.domVsCanvasLang),
    maxClusterDomVsWorker: round(row.maxClusterDelta.domVsWorkerLang),
    // README decision rule: whole-run widths agree within 1/64 px (Chrome's layout unit).
    totalWithin1_64:
      Math.abs(row.totalDelta.domVsCanvasLang) <= 1 / 64 &&
      row.totalDelta.domVsWorkerLang !== null &&
      Math.abs(row.totalDelta.domVsWorkerLang) <= 1 / 64,
  }));
  console.table(rows);
  console.table(
    platformFonts.map((p) => ({
      text: p.text,
      fonts: p.fonts
        .map((f) => `${f.familyName}${f.isCustomFont ? '*' : ''}:${f.glyphCount}`)
        .join(' '),
    })),
  );
  writeReport('fallback', launchInfo, {
    ...meta,
    measurement: 'c: fallback hypothesis (DOM vs OffscreenCanvas, document.fonts vs self.fonts)',
    options,
    summary: rows,
    platformFonts,
    ...result,
    pageErrors: errors,
  });
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
