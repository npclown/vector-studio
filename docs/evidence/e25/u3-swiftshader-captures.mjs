/* global window, Buffer, URL */
// E25 U3: E25-A05 and the A08 capture part on a software GPU. Renders scenes whose containers all
// have opacity 1 on the E23 page with the U3 page options (`groups`, `isolate`, `tile`; see
// u3-swiftshader.md) and prints the SHA-256 of every captured frame per configuration:
// - flat: `groups: 'flat'` (A08 baseline);
// - isolated: `groups: 'isolated'`, no layer drawn (A08);
// - layer: `isolateUnitOpacityForTesting`, every container drawn as a layer at opacity 1 (A05);
// - tiled: as layer, with `layerTileSizeForTesting` 64 (A05).
// All four must be byte-identical per scene, sample count and DPR. The page background is the
// clear colour and nothing is drawn under a layer, so the composite rounds nothing (E25-A05).
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
const linear = (transform, from, to) => ({
  kind: 'linear',
  transform,
  stops: [
    { offset: 0, color: from },
    { offset: 1, color: to },
  ],
  spread: 'pad',
});
const radial = (transform) => ({
  kind: 'radial',
  transform,
  stops: [
    { offset: 0, color: { r: 1, g: 1, b: 0, a: 1 } },
    { offset: 0.6, color: { r: 0, g: 0.5, b: 1, a: 0.6 } },
    { offset: 1, color: { r: 1, g: 0, b: 0.5, a: 1 } },
  ],
  spread: 'reflect',
});
const stroke = (color, width) => ({ color, width, cap: 'round', join: 'round', miterLimit: 4 });
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
const container = (id, transform, children, clip = null, parentId = null) =>
  node(id, transform, { kind: 'container', children, clip }, parentId);

// Every leaf kind and variant inside a container: analytic solid and gradient (plain module and
// paint variant), a joint path with a gradient fill (mesh joint paint), a path with an opacity
// (mesh fill), a rotated rect clip with gradient and solid content (clip and paint-clip
// variants), a mask (mask level under the layer), and nested containers (nested layers).
const SCENES = {
  leaves: [
    container('g', T(0, 0), ['a', 'b', 'p', 'q']),
    rect('a', T(21, 17), 160, 90, red, { color: blue, width: 4 }, 'g'),
    rect('b', R(15, 90, 40), 150, 100, linear([150, 0, 0, 150, 0, 0], red, blue), null, 'g'),
    path('p', T(250, 60), radial([100, 0, 0, 80, 100, 60]), stroke(green, 10), 1, 'g'),
    path('q', R(-10, 280, 150), green, null, 0.8, 'g'),
  ],
  clips: [
    container('g', T(0, 0), ['clip', 'mask']),
    container(
      'clip',
      R(20, 40, 30),
      ['c-r', 'c-p'],
      {
        kind: 'rect',
        x: 10,
        y: 10,
        width: 180,
        height: 120,
      },
      'g',
    ),
    rect('c-r', T(-20, -20), 160, 100, linear([160, 0, 0, 160, -20, 0], blue, red), null, 'clip'),
    path('c-p', T(60, 40), red, stroke(blue, 6), 1, 'clip'),
    container('mask', T(260, 60), ['m-src', 'm-a', 'm-b'], { kind: 'mask' }, 'g'),
    ellipse('m-src', T(0, 0), 180, 160, red, null, 'mask'),
    path('m-a', T(-10, 10), linear([200, 0, 0, 200, 0, 0], red, blue), stroke(red, 8), 1, 'mask'),
    rect('m-b', T(40, 60), 120, 50, green, null, 'mask'),
  ],
  // Three nested layers whose leaves do not overlap, so no layer has content under or over it in
  // its parent (A05's setup); the bounds overlap, so g3's composite lands in g2's tile.
  nested: [
    container('g1', T(0, 0), ['n-a', 'g2']),
    rect('n-a', T(20, 30), 150, 160, linear([150, 0, 0, 150, 20, 0], red, green), null, 'g1'),
    container('g2', T(0, 0), ['n-b', 'g3'], null, 'g1'),
    ellipse('n-b', T(190, 40), 120, 150, green, { color: blue, width: 5 }, 'g2'),
    container('g3', T(0, 0), ['n-c'], null, 'g2'),
    path('n-c', T(330, 80), blue, stroke(red, 12), 0.6, 'g3'),
  ],
  // Not part of A05: content under (`under`) or over (`over`) nested layers in their parents. A
  // layer over earlier content rounds L once more, and at 4x content drawn over a composite
  // blends per sample with the layer's resolved pixel, so frames may differ from flat by 8-bit
  // rounding. The script reports the largest channel difference.
  under: [
    container('g1', T(0, 0), ['u-a', 'g2']),
    rect('u-a', T(30, 30), 220, 160, linear([220, 0, 0, 220, 30, 0], red, green), null, 'g1'),
    container('g2', T(0, 0), ['u-b', 'g3'], null, 'g1'),
    ellipse('u-b', T(120, 80), 200, 150, green, { color: blue, width: 5 }, 'g2'),
    container('g3', T(0, 0), ['u-c'], null, 'g2'),
    path('u-c', T(230, 120), blue, stroke(red, 12), 0.6, 'g3'),
  ],
  over: [
    container('g1', T(0, 0), ['g2', 'o-a']),
    container('g2', T(0, 0), ['g3', 'o-b'], null, 'g1'),
    container('g3', T(0, 0), ['o-c'], null, 'g2'),
    path('o-c', T(230, 120), blue, stroke(red, 12), 0.6, 'g3'),
    ellipse('o-b', T(120, 80), 200, 150, green, { color: blue, width: 5 }, 'g2'),
    rect('o-a', T(30, 30), 220, 160, linear([220, 0, 0, 220, 30, 0], red, green), null, 'g1'),
  ],
  // A layer spanning the target: at tile size 64 it takes many tiles, and content crosses the
  // seams at odd offsets.
  wide: [
    container('g', T(0, 0), ['w-bg', 'w-a', 'w-b', 'w-c']),
    rect('w-bg', T(3, 3), 505, 313, linear([505, 0, 0, 505, 3, 0], blue, red), null, 'g'),
    ellipse('w-a', T(61, 61), 131, 133, green, { color: red, width: 3 }, 'g'),
    path('w-b', R(25, 200, 70), radial([100, 0, 0, 100, 100, 50]), stroke(green, 7), 0.9, 'g'),
    rect('w-c', R(-33, 330, 190), 127, 63, red, null, 'g', 0.5),
  ],
};

const CONFIGS = {
  flat: 'groups=flat',
  isolated: 'groups=isolated',
  layer: 'groups=isolated&isolate=1',
  tiled: 'groups=isolated&isolate=1&tile=64',
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
const rows = [];
const pixels = new Map();
for (const samples of [4, 1]) {
  for (const dpr of [1, 2]) {
    for (const [config, query] of Object.entries(CONFIGS)) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      await page.goto(`${BASE}/e23-gradient-paint.html?samples=${samples}&dpr=${dpr}&${query}`);
      const ready = await page.evaluate(() => window.__vectorStudioE23.ready);
      if (!ready.supported) throw new Error(`adapter: ${JSON.stringify(ready)}`);
      for (const [name, nodes] of Object.entries(SCENES)) {
        const snapshot = {
          identity: { documentId: 'e25-u3', pageId: name },
          revision: 1,
          nodes,
          rootOrder: nodes.filter((item) => item.parentId === null).map((item) => item.id),
        };
        const camera = { position: { x: 0, y: 0 }, zoom: 1 };
        const shown = await page.evaluate(
          ([scene, at]) => window.__vectorStudioE23.show(scene, at),
          [snapshot, camera],
        );
        if (shown.status !== 'applied') throw new Error(`${name}: ${shown.status}`);
        const before = await page.evaluate(() => window.__vectorStudioE23.counters().layerPasses);
        const rendered = await page.evaluate(
          ([scene, at]) => window.__vectorStudioE23.render(scene, at),
          [snapshot, camera],
        );
        if (rendered.status !== 'applied') throw new Error(`${name}: ${rendered.status}`);
        const after = await page.evaluate(() => window.__vectorStudioE23.counters().layerPasses);
        const errors = (await page.evaluate(() => window.__vectorStudioE23.diagnostics())).filter(
          (diagnostic) => diagnostic.severity === 'error',
        );
        const { frame } = rendered;
        const rgba = Buffer.from(frame.rgbaBase64, 'base64');
        pixels.set(`${config}/${name}/${samples}/${dpr}`, rgba);
        const flat = pixels.get(`flat/${name}/${samples}/${dpr}`);
        let maxDiff = 0;
        for (let index = 0; index < rgba.length; index += 1) {
          maxDiff = Math.max(maxDiff, Math.abs(rgba[index] - flat[index]));
        }
        rows.push({
          samples,
          dpr,
          config,
          scene: name,
          size: `${frame.width}x${frame.height}`,
          layerPasses: after - before,
          errors: errors.map((diagnostic) => diagnostic.code),
          maxDiff,
          sha256: createHash('sha256').update(rgba).digest('hex'),
        });
      }
      await page.evaluate(() => window.__vectorStudioE23.dispose());
      await page.close();
    }
  }
}
await browser.close();
for (const row of rows) console.log(JSON.stringify(row));
// Per scene, sample count and DPR: every configuration's frame must be the same.
let mismatches = 0;
for (const row of rows) {
  const flat = rows.find(
    (other) =>
      other.config === 'flat' &&
      other.scene === row.scene &&
      other.samples === row.samples &&
      other.dpr === row.dpr,
  );
  if (row.scene !== 'under' && row.scene !== 'over' && flat.sha256 !== row.sha256) {
    mismatches += 1;
    console.log(`MISMATCH ${row.config} ${row.scene} samples=${row.samples} dpr=${row.dpr}`);
  }
}
console.log(`${rows.length} frames, ${mismatches} mismatches`);
process.exitCode = mismatches === 0 ? 0 : 1;
