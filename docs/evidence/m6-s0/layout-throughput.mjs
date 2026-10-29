/* global window */
// M6-S0 (a): DOM layout throughput. Lays out COUNT (default 1,000) generated nodes of mixed Latin
// and Hangul, one at a time, in the page's hidden shadow-root measurement element (`all: initial`,
// lang=ko) and reads every grapheme cluster with Range.getClientRects. Reports ms totals and per
// node for PASSES passes after a warm-up. See README.md.
import { families, launch, metadata, numbers, env, openPage, serve, writeReport } from './lib.mjs';

const options = {
  count: Number(env('COUNT', '1000')),
  seed: Number(env('SEED', '1')),
  families: families(),
  sizes: numbers('SIZES', '9,12,13,16,24,32'),
  passes: Number(env('PASSES', '3')),
  warmup: Number(env('WARMUP', '50')),
  keepLayouts: false,
};

const server = await serve();
const { browser, launch: launchInfo } = await launch();
try {
  const { page, context, errors } = await openPage(browser, server.base, { dpr: 1 });
  const meta = await metadata(browser, launchInfo, page);
  const result = await page.evaluate((opts) => window.__vectorStudioM6S0.throughput(opts), options);
  const sample = await page.evaluate((opts) => {
    const hook = window.__vectorStudioM6S0;
    const [node] = hook.generateNodes(1, opts.seed, opts.families, opts.sizes);
    return { node, layout: hook.layoutNode(node) };
  }, options);
  const summary = result.passes.map((pass) => ({
    pass: pass.pass,
    nodes: pass.nodes,
    clusters: pass.clusters,
    totalMs: pass.totalMs.total,
    wallMs: pass.wallMs,
    perNodeMeanMs: pass.totalMs.mean,
    perNodeP95Ms: pass.totalMs.p95,
    perNodeMaxMs: pass.totalMs.max,
    perClusterMeanUs: (pass.totalMs.total / pass.clusters) * 1000,
  }));
  console.table(summary);
  writeReport('layout-throughput', launchInfo, {
    ...meta,
    measurement: 'a: DOM layout throughput',
    options,
    summary,
    passes: result.passes,
    sample,
    pageErrors: errors,
  });
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
