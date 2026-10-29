/* global window, Buffer, URL */
// E28 U3: E28-A07's capture part and a text smoke check on a software GPU, on the E23 page with
// its `text=atlas` option (see u3-swiftshader.md).
// - Identity (A07): scenes without text give byte-identical frames with `text=none` and
//   `text=atlas`, in flat and isolated configurations.
// - Snapped text: white clusters on the opaque black clear colour. Each pixel of a cluster's
//   bitmap rect must equal the canvas port's own bitmap placed by E28-K1 to K3, and no other
//   pixel is lit (exact: coverage is 8-bit and white over black writes it unchanged).
// - Variants: the same text inside a far rect clip, inside a layer (isolate=1), and both, must
//   be byte-identical to the plain frame, so the clip, layer and combined text variants draw.
// - General text: the clusters rotated by 30 degrees draw ink and raise no error.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../../package.json', import.meta.url))(
  '@playwright/test',
);

const BASE = process.env.BASE ?? 'http://127.0.0.1:4176';
const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };
const green = { r: 0, g: 0.6, b: 0.2, a: 0.7 };
const white = { r: 1, g: 1, b: 1, a: 1 };
const T = (x, y) => [1, 0, 0, 1, x, y];
const R = (degrees, x, y) => {
  const a = (degrees * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), x, y];
};
const node = (id, transform, rest, parentId = null, opacity = 1) => ({
  id,
  parentId,
  transform,
  visible: true,
  opacity,
  ...rest,
});
const rect = (id, transform, w, h, fill, parentId = null, opacity = 1) =>
  node(
    id,
    transform,
    {
      kind: 'primitive',
      geometry: { kind: 'rectangle', width: w, height: h, cornerRadii: [6, 6, 6, 6] },
      style: { fill, stroke: { color: blue, width: 3 } },
    },
    parentId,
    opacity,
  );
const path = (id, transform, fill, parentId = null) =>
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
      style: {
        fill,
        stroke: { color: red, width: 6, cap: 'round', join: 'round', miterLimit: 4 },
      },
    },
    parentId,
  );
const container = (id, transform, children, clip = null, parentId = null, opacity = 1) =>
  node(id, transform, { kind: 'container', children, clip }, parentId, opacity);

// Scenes without text (A07).
const PLAIN = {
  leaves: [
    rect('a', T(21, 17), 160, 90, red),
    rect('b', R(15, 90, 40), 150, 100, green),
    path('p', T(250, 60), blue),
  ],
  groups: [
    container('g', T(0, 0), ['g-a', 'c']),
    rect('g-a', T(30, 30), 220, 160, green, 'g'),
    container(
      'c',
      R(20, 200, 40),
      ['c-p'],
      { kind: 'rect', x: 0, y: 0, width: 180, height: 120 },
      'g',
      0.5,
    ),
    path('c-p', T(20, 30), red, 'c'),
  ],
};

// Text: well-separated clusters, so bitmaps never overlap. Each is [text, x, y, size, font].
const ARIAL = '"Arial", "Liberation Sans", sans-serif';
const CLUSTERS = [
  ['A', 20, 40, 16, ARIAL],
  ['g', 60.25, 40, 16, ARIAL],
  ['W', 100.5, 40, 16, ARIAL],
  ['f', 140.75, 40, 16, ARIAL],
  ['Q', 20, 110, 24, ARIAL],
  ['한', 80.25, 110, 24, 'sans-serif'],
  ['j', 140.5, 110, 24, 'serif'],
];
const textNode = (id, transform, clusters, parentId = null) =>
  node(
    id,
    transform,
    {
      kind: 'text',
      generation: 1,
      lang: 'ko',
      runs: clusters.map(([text, x, y, size, fontList]) => ({
        fontList,
        size,
        color: white,
        clusters: [{ text, x, y, advance: size / 2 }],
      })),
    },
    parentId,
  );
const FAR_CLIP = { kind: 'rect', x: -1000, y: -1000, width: 3000, height: 3000 };
const TEXT = {
  plain: [textNode('t', T(0, 0), CLUSTERS)],
  clipped: [container('c', T(0, 0), ['t'], FAR_CLIP), textNode('t', T(0, 0), CLUSTERS, 'c')],
  layered: [container('g', T(0, 0), ['t']), textNode('t', T(0, 0), CLUSTERS, 'g')],
  both: [
    container('g', T(0, 0), ['c']),
    container('c', T(0, 0), ['t'], FAR_CLIP, 'g'),
    textNode('t', T(0, 0), CLUSTERS, 'c'),
  ],
  rotated: [textNode('t', R(30, 200, 20), CLUSTERS)],
};

const roundHalfUp = (value) => Math.floor(value + 0.5);
const bucket = (s) => (s <= 64 ? roundHalfUp(s * 4) / 4 : Math.min(256, roundHalfUp(s)));

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
const hashes = new Map();
let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`FAIL ${message}`);
};

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${BASE}/e23-gradient-paint.html?${query}`);
  const ready = await page.evaluate(() => window.__vectorStudioE23.ready);
  if (!ready.supported) throw new Error(`adapter: ${JSON.stringify(ready)}`);
  return { page, ready };
}

async function render(page, name, nodes) {
  const snapshot = {
    identity: { documentId: 'e28-u3', pageId: name },
    revision: 1,
    nodes,
    rootOrder: nodes.filter((item) => item.parentId === null).map((item) => item.id),
  };
  const camera = { position: { x: 0, y: 0 }, zoom: 1 };
  // Two frames: the first rasterizes and uploads, the second draws from the acknowledged atlas.
  await page.evaluate(
    ([scene, at]) => window.__vectorStudioE23.show(scene, at),
    [snapshot, camera],
  );
  const rendered = await page.evaluate(
    ([scene, at]) => window.__vectorStudioE23.render(scene, at),
    [snapshot, camera],
  );
  if (rendered.status !== 'applied') throw new Error(`${name}: ${rendered.status}`);
  const errors = (await page.evaluate(() => window.__vectorStudioE23.diagnostics()))
    .filter((diagnostic) => diagnostic.severity === 'error' || diagnostic.code.includes('text'))
    .map((diagnostic) => diagnostic.code);
  const rgba = Buffer.from(rendered.frame.rgbaBase64, 'base64');
  return { rgba, frame: rendered.frame, counters: rendered.counters, errors };
}

for (const samples of [4, 1]) {
  for (const dpr of [1, 2]) {
    // A07: no text, text=none against text=atlas, flat and isolated.
    for (const groups of ['flat', 'isolated']) {
      for (const text of ['none', 'atlas']) {
        const { page } = await open(`samples=${samples}&dpr=${dpr}&groups=${groups}&text=${text}`);
        for (const [name, nodes] of Object.entries(PLAIN)) {
          if (groups === 'flat' && name === 'groups') continue;
          const { rgba, errors, frame } = await render(page, name, nodes);
          const sha256 = createHash('sha256').update(rgba).digest('hex');
          const key = `${name}/${groups}/${samples}/${dpr}`;
          if (text === 'none') hashes.set(key, sha256);
          else if (hashes.get(key) !== sha256) fail(`A07 ${key}: text=atlas differs`);
          if (errors.length > 0) fail(`A07 ${key} ${text}: ${errors.join(',')}`);
          rows.push({
            part: 'A07',
            samples,
            dpr,
            groups,
            text,
            scene: name,
            textPart: frame.packet?.text ?? null,
            sha256,
          });
        }
        await page.evaluate(() => window.__vectorStudioE23.dispose());
        await page.close();
      }
    }

    // Text: plain, clipped and rotated; then, with every container drawn as a layer, layered
    // and both, which must equal plain too.
    const { page } = await open(`samples=${samples}&dpr=${dpr}&groups=isolated&text=atlas`);
    const plain = await render(page, 'plain', TEXT.plain);
    const width = plain.frame.width;
    const height = plain.frame.height;
    const lit = new Uint8Array(width * height);
    let worst = 0;
    const placements = [];
    for (const [text, x, y, size, fontList] of CLUSTERS) {
      // E28-K1 to K3 at camera (0, 0), zoom 1: o = (x, y) · DPR, snapped.
      const ox = x * dpr;
      const oy = y * dpr;
      const q = roundHalfUp(4 * ox);
      const phaseX = (((q % 4) + 4) % 4) / 4;
      const px = Math.floor(q / 4);
      const py = roundHalfUp(oy);
      const pixelSize = bucket(size * dpr);
      const bitmap = await page.evaluate((request) => window.__vectorStudioE23.rasterize(request), {
        text,
        fontList,
        lang: 'ko',
        pixelSize,
        phaseX,
      });
      if (bitmap.status !== 'ok') {
        fail(`raster ${text}: ${JSON.stringify(bitmap)}`);
        continue;
      }
      const coverage = Buffer.from(bitmap.coverage, 'base64');
      const left = px - bitmap.left;
      const top = py - bitmap.top;
      placements.push({
        text,
        pixelSize,
        phaseX,
        corner: [px, py],
        left: bitmap.left,
        top: bitmap.top,
        width: bitmap.width,
        height: bitmap.height,
      });
      for (let j = 0; j < bitmap.height; j += 1) {
        for (let i = 0; i < bitmap.width; i += 1) {
          const dx = left + i;
          const dy = top + j;
          if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
          lit[dy * width + dx] = 1;
          const expected = coverage[j * bitmap.width + i];
          const at = (dy * width + dx) * 4;
          for (let channel = 0; channel < 3; channel += 1) {
            worst = Math.max(worst, Math.abs(plain.rgba[at + channel] - expected));
          }
        }
      }
    }
    let stray = 0;
    for (let index = 0; index < width * height; index += 1) {
      if (lit[index] === 0 && plain.rgba[index * 4] !== 0) stray += 1;
    }
    if (worst !== 0 || stray !== 0)
      fail(`snapped ${samples}x dpr ${dpr}: worst ${worst}, stray ${stray}`);
    if (plain.errors.length > 0) fail(`snapped ${samples}x dpr ${dpr}: ${plain.errors.join(',')}`);
    const plainHash = createHash('sha256').update(plain.rgba).digest('hex');
    rows.push({
      part: 'snapped',
      samples,
      dpr,
      worst,
      stray,
      counters: {
        calls: plain.counters.glyphRasterCalls,
        uploads: plain.counters.glyphUploads,
        layerPasses: plain.counters.layerPasses,
      },
      textPart: plain.frame.packet?.text ?? null,
      placements,
      sha256: plainHash,
    });
    const isolated = await open(
      `samples=${samples}&dpr=${dpr}&groups=isolated&isolate=1&text=atlas`,
    );
    for (const name of ['clipped', 'layered', 'both']) {
      const result = await render(name === 'clipped' ? page : isolated.page, name, TEXT[name]);
      const sha256 = createHash('sha256').update(result.rgba).digest('hex');
      if (sha256 !== plainHash) fail(`${name} ${samples}x dpr ${dpr}: differs from plain`);
      if (result.errors.length > 0)
        fail(`${name} ${samples}x dpr ${dpr}: ${result.errors.join(',')}`);
      rows.push({
        part: 'variant',
        samples,
        dpr,
        scene: name,
        layerPasses: result.counters.layerPasses,
        sha256,
      });
    }
    const rotated = await render(page, 'rotated', TEXT.rotated);
    let ink = 0;
    for (let index = 0; index < width * height; index += 1) ink += rotated.rgba[index * 4];
    if (ink === 0) fail(`rotated ${samples}x dpr ${dpr}: no ink`);
    if (rotated.errors.length > 0)
      fail(`rotated ${samples}x dpr ${dpr}: ${rotated.errors.join(',')}`);
    rows.push({
      part: 'general',
      samples,
      dpr,
      ink,
      sha256: createHash('sha256').update(rotated.rgba).digest('hex'),
    });
    for (const open of [page, isolated.page]) {
      await open.evaluate(() => window.__vectorStudioE23.dispose());
      await open.close();
    }
  }
}
await browser.close();
for (const row of rows) console.log(JSON.stringify(row));
console.log(`${rows.length} rows, ${failures} failures`);
process.exitCode = failures === 0 ? 0 : 1;
