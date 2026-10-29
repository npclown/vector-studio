/* global window, Buffer, URL */
// E23-A08 capture part: renders solid-only scenes on the P4 page (unchanged since 9ef77b5) and
// prints the SHA-256 of every captured frame, so two commits can be compared byte for byte.
// Usage: serve the playground of one commit on BASE, run this script, keep its output; repeat for
// the other commit; the two outputs must be identical. SWIFTSHADER=1 uses the container's
// software adapter; otherwise CHANNEL (default 'chrome') is launched headed on the real GPU.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../../package.json', import.meta.url))(
  '@playwright/test',
);

const BASE = process.env.BASE ?? 'http://127.0.0.1:4176';
const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };
const green = { r: 0, g: 0.6, b: 0.2, a: 0.7 };
const T = (x, y) => [1, 0, 0, 1, x, y];
const R = (degrees, x, y) => {
  const a = (degrees * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), x, y];
};
const pen = (color, width) => ({ color, width });
const stroke = (color, width) => ({
  ...pen(color, width),
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
});
const node = (id, transform, rest, parentId = null, opacity = 1) => ({
  id,
  parentId,
  transform,
  visible: true,
  opacity,
  ...rest,
});
const rect = (id, transform, w, h, fill, line = null, parentId = null, opacity = 1) =>
  node(
    id,
    transform,
    {
      kind: 'primitive',
      geometry: { kind: 'rectangle', width: w, height: h, cornerRadii: [6, 6, 6, 6] },
      style: { fill, stroke: line },
    },
    parentId,
    opacity,
  );
const ellipse = (id, transform, w, h, fill, line = null, parentId = null) =>
  node(
    id,
    transform,
    {
      kind: 'primitive',
      geometry: { kind: 'ellipse', width: w, height: h },
      style: { fill, stroke: line },
    },
    parentId,
  );
const path = (id, transform, fill, line, opacity = 1, parentId = null) =>
  node(
    id,
    transform,
    {
      kind: 'path',
      geometry: {
        kind: 'path',
        verbs: ['move', 'cubic', 'line', 'line', 'close'],
        points: [0, 0, 80, -40, 120, -40, 200, 0, 200, 120, 0, 120],
        fillRule: 'nonzero',
      },
      style: { fill, stroke: line },
    },
    parentId,
    opacity,
  );
const container = (id, transform, children, clip) =>
  node(id, transform, { kind: 'container', children, clip });

// P1 primitives, a P3 path with a joint stroke, a P4 rect clip and a P4 mask, all solid paints.
const SCENES = {
  p1: [
    rect('r1', T(20, 20), 160, 90, red, pen(blue, 4)),
    ellipse('e1', R(20, 260, 40), 140, 80, green, pen(red, 3)),
    rect('r2', R(-12, 60, 180), 120, 60, blue, null, null, 0.5),
  ],
  p3: [path('p1', T(40, 80), red, stroke(blue, 10), 0.5), path('p2', R(15, 280, 60), green, null)],
  p4: [
    container('clip', R(10, 30, 30), ['c-r', 'c-e'], {
      kind: 'rect',
      x: 10,
      y: 10,
      width: 180,
      height: 120,
    }),
    rect('c-r', T(-20, -20), 160, 100, red, pen(blue, 6), 'clip'),
    ellipse('c-e', T(80, 40), 140, 120, green, null, 'clip'),
    container('mask', T(260, 60), ['m-src', 'm-a'], { kind: 'mask' }),
    ellipse('m-src', T(0, 0), 180, 160, red, null, 'mask'),
    path('m-a', T(-10, 10), blue, stroke(red, 8), 1, 'mask'),
  ],
};

const launch = process.env.SWIFTSHADER
  ? {
      executablePath: '/opt/pw-browsers/chromium',
      args: [
        '--enable-unsafe-webgpu',
        '--use-vulkan=swiftshader',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--enable-features=Vulkan',
      ],
    }
  : { channel: process.env.CHANNEL ?? 'chrome', headless: false };
const browser = await chromium.launch(launch);
const out = [];
for (const samples of [4, 1]) {
  for (const dpr of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`${BASE}/p4-clip-mask.html?samples=${samples}&dpr=${dpr}`);
    const ready = await page.evaluate(() => window.__vectorStudioP4.ready);
    if (!ready.supported) throw new Error(`adapter: ${JSON.stringify(ready)}`);
    for (const [name, nodes] of Object.entries(SCENES)) {
      const snapshot = {
        identity: { documentId: 'e23-a08', pageId: name },
        revision: 1,
        nodes,
        rootOrder: nodes.filter((item) => item.parentId === null).map((item) => item.id),
      };
      const shown = await page.evaluate(
        ([scene]) => window.__vectorStudioP4.show(scene, { position: { x: 0, y: 0 }, zoom: 1 }),
        [snapshot],
      );
      if (shown.status !== 'applied') throw new Error(`${name}: ${shown.status}`);
      const rendered = await page.evaluate(
        ([scene]) => window.__vectorStudioP4.render(scene, { position: { x: 0, y: 0 }, zoom: 1 }),
        [snapshot],
      );
      if (rendered.status !== 'applied') throw new Error(`${name}: ${rendered.status}`);
      const rgba = Buffer.from(rendered.frame.rgbaBase64, 'base64');
      out.push({
        scene: name,
        samples,
        dpr,
        size: `${rendered.frame.width}x${rendered.frame.height}`,
        // Colour channels above the opaque black background: a blank frame proves nothing.
        painted: rgba.reduce(
          (count, value, index) => count + (index % 4 < 3 && value > 0 ? 1 : 0),
          0,
        ),
        sha256: createHash('sha256').update(rgba).digest('hex'),
      });
    }
    await page.close();
  }
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
