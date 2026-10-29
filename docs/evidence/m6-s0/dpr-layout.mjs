/* global window */
// M6-S0 (b): the DPR hypothesis (plan section 4.1). Lays out the same generated nodes in a fresh
// context at each deviceScaleFactor in DPRS (default 1, 1.25, 1.5, 2) and compares line breaks and
// cluster positions in page units (CSS px) against the first DPR. See README.md.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  env,
  list,
  families,
  hostMetadata,
  launch,
  metadata,
  numbers,
  openPage,
  round,
  serve,
  sourceState,
  writeReport,
} from './lib.mjs';

const dprs = numbers('DPRS', '1,1.25,1.5,2');
const options = {
  count: Number(env('COUNT', '1000')),
  seed: Number(env('SEED', '1')),
  families: families(),
  sizes: numbers('SIZES', '9,12,13,16,24,32'),
  passes: 1,
  warmup: Number(env('WARMUP', '50')),
  keepLayouts: true,
};
const FIELDS = ['x', 'y', 'w', 'h'];

function compare(base, other) {
  const max = { x: 0, y: 0, w: 0, h: 0, nodeWidth: 0, nodeHeight: 0 };
  const exceed = { any: 0, over001: 0, over01: 0, over05: 0 };
  let lineBreakMismatches = 0;
  let rectPresenceMismatches = 0;
  let nodesWithAnyDelta = 0;
  const examples = [];
  base.forEach((a, index) => {
    const b = other[index];
    const breaksEqual =
      a.lineCount === b.lineCount && a.lineStarts.join(',') === b.lineStarts.join(',');
    if (!breaksEqual) lineBreakMismatches += 1;
    let nodeMax = 0;
    max.nodeWidth = Math.max(max.nodeWidth, Math.abs(a.width - b.width));
    max.nodeHeight = Math.max(max.nodeHeight, Math.abs(a.height - b.height));
    a.clusters.forEach((ca, c) => {
      const cb = b.clusters[c];
      for (const field of FIELDS) {
        if ((ca[field] === null) !== (cb[field] === null)) {
          rectPresenceMismatches += 1;
          continue;
        }
        if (ca[field] === null) continue;
        const delta = Math.abs(ca[field] - cb[field]);
        max[field] = Math.max(max[field], delta);
        nodeMax = Math.max(nodeMax, delta);
        if (delta > 0) exceed.any += 1;
        if (delta > 0.01) exceed.over001 += 1;
        if (delta > 0.1) exceed.over01 += 1;
        if (delta > 0.5) exceed.over05 += 1;
      }
    });
    if (nodeMax > 0 || !breaksEqual) {
      nodesWithAnyDelta += 1;
      if (examples.length < 20) {
        examples.push({
          id: a.id,
          breaksEqual,
          lineStarts: [a.lineStarts, b.lineStarts],
          maxDelta: round(nodeMax),
          size: [
            [round(a.width), round(a.height)],
            [round(b.width), round(b.height)],
          ],
        });
      }
    }
  });
  return {
    nodes: base.length,
    lineBreaksIdentical: lineBreakMismatches === 0,
    lineBreakMismatches,
    rectPresenceMismatches,
    nodesWithAnyDelta,
    positionsIdentical: nodesWithAnyDelta === 0,
    maxDeltaCssPx: Object.fromEntries(Object.entries(max).map(([k, v]) => [k, round(v, 6)])),
    clusterFieldsOver: exceed,
    examples,
  };
}

// COMPARE=a.json,b.json compares two downloads of the page's manual button (real DPR, a monitor
// move or browser zoom) instead of launching a browser.
if (process.env.COMPARE) {
  const files = list('COMPARE', '');
  const [a, b] = files.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  const comparison = {
    label: b.label ?? null,
    against: a.label ?? null,
    dpr: b.devicePixelRatio,
    againstDpr: a.devicePixelRatio,
    ...compare(a.layouts, b.layouts),
  };
  console.log(
    JSON.stringify({ ...comparison, examples: comparison.examples.slice(0, 3) }, null, 2),
  );
  writeReport(
    'dpr-manual-compare',
    { label: `${a.label ?? 'a'}-vs-${b.label ?? 'b'}`.replace(/[^A-Za-z0-9._-]+/g, '_') },
    {
      spike: 'M6-S0',
      plan: 'docs/plans/mvp-m6-text-plan.md',
      measurement: 'b (manual): two page downloads compared',
      createdAt: new Date().toISOString(),
      ...sourceState(),
      ...hostMetadata(),
      inputs: files.map((file, index) => {
        const input = index === 0 ? a : b;
        return {
          file: path.basename(file),
          label: input.label ?? null,
          createdAt: input.createdAt ?? null,
          devicePixelRatio: input.devicePixelRatio,
          viewport: input.viewport ?? null,
          page: input.page ?? null,
        };
      }),
      hypothesisHolds: comparison.lineBreaksIdentical && comparison.positionsIdentical,
      comparison,
    },
  );
  process.exit(0);
}

const server = await serve();
const { browser, launch: launchInfo } = await launch();
try {
  const runs = [];
  let meta = null;
  for (const dpr of dprs) {
    const { page, context, errors } = await openPage(browser, server.base, { dpr });
    meta ??= await metadata(browser, launchInfo, page);
    const reportedDpr = await page.evaluate(() => window.devicePixelRatio);
    const result = await page.evaluate(
      (opts) => window.__vectorStudioM6S0.throughput(opts),
      options,
    );
    runs.push({ dpr, reportedDpr, layouts: result.layouts, pass: result.passes[0], errors });
    await context.close();
  }
  const [base, ...others] = runs;
  const comparisons = others.map((run) => ({
    dpr: run.dpr,
    against: base.dpr,
    ...compare(base.layouts, run.layouts),
  }));
  console.table(
    comparisons.map((c) => ({
      dpr: c.dpr,
      lineBreaksIdentical: c.lineBreaksIdentical,
      positionsIdentical: c.positionsIdentical,
      nodesWithAnyDelta: c.nodesWithAnyDelta,
      maxX: c.maxDeltaCssPx.x,
      maxY: c.maxDeltaCssPx.y,
      maxW: c.maxDeltaCssPx.w,
      maxH: c.maxDeltaCssPx.h,
    })),
  );
  writeReport('dpr-layout', launchInfo, {
    ...meta,
    measurement: 'b: DPR hypothesis (deviceScaleFactor emulation)',
    options: { ...options, dprs },
    hypothesisHolds: comparisons.every((c) => c.lineBreaksIdentical && c.positionsIdentical),
    comparisons,
    runs: runs.map((run) => ({
      dpr: run.dpr,
      reportedDpr: run.reportedDpr,
      totalMs: run.pass.totalMs.total,
      perNodeMeanMs: run.pass.totalMs.mean,
      clusters: run.pass.clusters,
      pageErrors: run.errors,
    })),
  });
} finally {
  await browser.close();
  await server.close();
}
