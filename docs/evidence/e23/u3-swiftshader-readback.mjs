/* global window, Buffer, URL */
// E23 U3: SwiftShader readback of gradient fixtures against a binary64 oracle (U3 software-GPU check; needs the U4 page e23-gradient-paint.html served on BASE).
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../../package.json', import.meta.url))(
  '@playwright/test',
);

const BASE = process.env.BASE ?? 'http://127.0.0.1:4176';
const samples = Number(process.env.SAMPLES ?? 4);
const red = { r: 1, g: 0, b: 0, a: 1 },
  blue = { r: 0, g: 0, b: 1, a: 1 };
const identity = { documentId: 'e23', pageId: 'page' };
const T = (x, y) => [1, 0, 0, 1, x, y];
const rect = (id, x, y, w, h, fill, stroke = null, extra = {}) => ({
  id,
  parentId: null,
  transform: T(x, y),
  visible: true,
  opacity: 1,
  kind: 'primitive',
  geometry: { kind: 'rectangle', width: w, height: h, cornerRadii: [0, 0, 0, 0] },
  style: { fill, stroke },
  ...extra,
});
const g = (transform, stops, spread = 'pad', kind = 'linear') => ({
  kind,
  transform,
  stops,
  spread,
});
const lin = (t, stops, spread) =>
  g(
    t,
    stops.map(([o, c]) => ({ offset: o, color: c })),
    spread,
  );

// Oracle: K1-K3 in binary64; premultiplied.
function inv([a, b, c, d, e, f]) {
  const D = a * d - b * c;
  return [d / D, -b / D, -c / D, a / D, (c * f - d * e) / D, (b * e - a * f) / D];
}
function ap([a, b, c, d, e, f], x, y) {
  return [a * x + c * y + e, b * x + d * y + f];
}
function Q(grad, lx, ly) {
  const [gx, gy] = ap(inv(grad.transform), lx, ly);
  let t = grad.kind === 'radial' ? Math.hypot(gx, gy) : gx;
  if (grad.spread === 'pad') t = Math.min(1, Math.max(0, t));
  else if (grad.spread === 'repeat') t = t - Math.floor(t);
  else {
    const u = t - 2 * Math.floor(t / 2);
    t = 1 - Math.abs(u - 1);
  }
  const s = grad.stops,
    P = (c) => [c.r * c.a, c.g * c.a, c.b * c.a, c.a];
  if (t < s[0].offset) return P(s[0].color);
  if (t >= s.at(-1).offset) return P(s.at(-1).color);
  let i = 0;
  for (let k = 0; k < s.length; k++) if (s[k].offset <= t) i = k;
  const w = (t - s[i].offset) / (s[i + 1].offset - s[i].offset);
  const A = P(s[i].color),
    B = P(s[i + 1].color);
  return A.map((v, k) => v + w * (B[k] - v));
}

const G1 = lin(
  [200, 0, 0, 200, 50, 0],
  [
    [0, red],
    [1, blue],
  ],
  'pad',
);
const G5a = lin(
  [200, 0, 0, 200, 0, 0],
  [
    [0, red],
    [1, { r: 0, g: 1, b: 0, a: 0 }],
  ],
  'pad',
);
const G5b = lin(
  [200, 0, 0, 200, 0, 0],
  [
    [0, red],
    [0.5, red],
    [0.5, blue],
    [1, blue],
  ],
  'pad',
);
const spreadOf = (sp) =>
  lin(
    [100, 0, 0, 100, 100, 0],
    [
      [0, { r: 0, g: 0, b: 0, a: 1 }],
      [1, { r: 1, g: 1, b: 1, a: 1 }],
    ],
    sp,
  );
const G2 = g(
  [100, 0, 0, 50, 100, 50],
  [
    { offset: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
    { offset: 0.5, color: { r: 0, g: 1, b: 0, a: 1 } },
    { offset: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
  ],
  'pad',
  'radial',
);
const G3F = lin(
  [173.205, 100, -100, 173.205, 0, 0],
  [
    [0, { r: 1, g: 1, b: 0, a: 1 }],
    [1, { r: 1, g: 0, b: 1, a: 1 }],
  ],
  'pad',
);
const G3S = lin(
  [200, 0, 0, 200, 0, 0],
  [
    [0, { r: 0, g: 1, b: 1, a: 1 }],
    [1, { r: 0, g: 0, b: 0, a: 0.6 }],
  ],
  'pad',
);

const cases = [];
// G1 + G5 + G4 in one scene: probes are interior (>= 2 px from edges, >= 1 px from seams).
{
  const nodes = [
    rect('g1', 10, 10, 300, 100, G1),
    rect('g5a', 10, 130, 200, 60, G5a),
    rect('g5b', 10, 210, 200, 60, G5b),
  ];
  const spreads = ['pad', 'repeat', 'reflect'];
  spreads.forEach((sp, i) => nodes.push(rect(`g4${sp}`, 240, 130 + i * 60, 250, 40, spreadOf(sp))));
  const probes = [];
  for (let x = 13; x < 307; x += 7) probes.push({ x, y: 60, node: [10, 10], grad: G1, k: 1 });
  for (let x = 13; x < 207; x += 5) probes.push({ x, y: 160, node: [10, 130], grad: G5a, k: 1 });
  for (let x = 13; x < 207; x += 5)
    if (Math.abs(x + 0.5 - 110) > 1) probes.push({ x, y: 240, node: [10, 210], grad: G5b, k: 1 });
  spreads.forEach((sp, i) => {
    for (let x = 243; x < 487; x += 3) {
      const lx = x + 0.5 - 240;
      if (Math.abs(lx - 100) > 1 && Math.abs(lx - 200) > 1)
        probes.push({ x, y: 150 + i * 60, node: [240, 130 + i * 60], grad: spreadOf(sp), k: 1 });
    }
  });
  cases.push({ name: 'G1 G4 G5', nodes, probes });
}
// G2 radial ellipse.
{
  const nodes = [
    { ...rect('g2', 50, 50, 200, 100, G2), geometry: { kind: 'ellipse', width: 200, height: 100 } },
  ];
  const probes = [];
  for (let y = 55; y < 145; y += 5)
    for (let x = 55; x < 245; x += 5) {
      const lx = x + 0.5 - 50,
        ly = y + 0.5 - 50;
      const r = Math.hypot((lx - 100) / 100, (ly - 50) / 50);
      if (r < 0.9) probes.push({ x, y, node: [50, 50], grad: G2, k: 1 });
    }
  cases.push({ name: 'G2', nodes, probes });
}
// G8 line and rect strokes.
{
  const stroke = (w) => ({ color: G1t, width: w });
  var G1t = lin(
    [200, 0, 0, 200, 0, 0],
    [
      [0, red],
      [1, blue],
    ],
    'pad',
  );
  const nodes = [
    {
      ...rect('line', 20, 50, 0, 0, null, { color: G1t, width: 16 }),
      geometry: { kind: 'line', start: { x: 0, y: 0 }, end: { x: 200, y: 0 } },
    },
    rect('box', 20, 120, 200, 100, { r: 1, g: 1, b: 1, a: 1 }, stroke(10)),
  ];
  const probes = [];
  for (let x = 23; x < 217; x += 4) probes.push({ x, y: 50, node: [20, 50], grad: G1t, k: 1 });
  // Top stroke band of the box (y 115..125): interior row y = 120 - 0.5 -> pixel 119.
  for (let x = 25; x < 215; x += 4) probes.push({ x, y: 119, node: [20, 120], grad: G1t, k: 1 });
  // Inside the box away from the stroke: white.
  for (let x = 30; x < 210; x += 10) probes.push({ x, y: 170, solid: [1, 1, 1] });
  cases.push({ name: 'G8', nodes, probes });
}
// G3 joint path at opacity 0.5.
{
  const ox = 100,
    oy = 80;
  const node = {
    id: 'g3',
    parentId: null,
    transform: T(ox, oy),
    visible: true,
    opacity: 0.5,
    kind: 'path',
    geometry: {
      kind: 'path',
      fillRule: 'evenodd',
      verbs: ['move', 'cubic', 'line', 'line', 'close', 'move', 'line', 'line', 'line', 'close'],
      points: [0, 0, 80, -40, 120, -40, 200, 0, 200, 120, 0, 120, 60, 40, 140, 40, 140, 80, 60, 80],
    },
    style: {
      fill: G3F,
      stroke: { color: G3S, width: 12, cap: 'butt', join: 'round', miterLimit: 4 },
    },
  };
  const probes = [];
  const f = (lx, ly) => Q(G3F, lx, ly),
    s = (lx, ly) => Q(G3S, lx, ly);
  // Fill only (inside, away from stroke and hole): o * Qf.
  for (const [lx, ly] of [
    [20, 20],
    [30, 100],
    [100, 20],
    [180, 60],
    [100, 100],
    [40, 60],
    [160, 100],
  ])
    probes.push({
      x: Math.floor(ox + lx),
      y: Math.floor(oy + ly),
      mix: () => f(lx + 0.5, ly + 0.5).map((v) => 0.5 * v),
    });
  // Stroke outside fill: right edge lx = 203.
  for (const ly of [20, 60, 100]) {
    const lx = 203;
    probes.push({ x: ox + lx, y: oy + ly, mix: () => s(lx + 0.5, ly + 0.5).map((v) => 0.5 * v) });
  }
  // Stroke over fill: lx = 197; and stroke over hole edge lx = 62 (inside hole: stroke only).
  for (const ly of [20, 60, 100]) {
    const lx = 197;
    probes.push({
      x: ox + lx,
      y: oy + ly,
      mix: () => {
        const S = s(lx + 0.5, ly + 0.5),
          F = f(lx + 0.5, ly + 0.5);
        return S.map((v, k) => 0.5 * (v + F[k] * (1 - S[3])));
      },
    });
  }
  cases.push({ name: 'G3', nodes: [node], probes });
}

// G6: G1 and G3 in a container rotated 20 degrees with a rect clip (paint + clip variants).
{
  const c = Math.cos(Math.PI / 9),
    sn = Math.sin(Math.PI / 9);
  const C = [c, sn, -sn, c, 150, 20];
  const compose = (L, R) => [
    L[0] * R[0] + L[2] * R[1],
    L[1] * R[0] + L[3] * R[1],
    L[0] * R[2] + L[2] * R[3],
    L[1] * R[2] + L[3] * R[3],
    L[0] * R[4] + L[2] * R[5] + L[4],
    L[1] * R[4] + L[3] * R[5] + L[5],
  ];
  const container = {
    id: 'c',
    parentId: null,
    transform: C,
    visible: true,
    opacity: 1,
    kind: 'container',
    clip: { kind: 'rect', x: 20, y: 10, width: 240, height: 80 },
    children: ['g1'],
  };
  const child = { ...rect('g1', 0, 0, 300, 100, G1), parentId: 'c' };
  const Wi = inv(compose(C, T(0, 0))),
    Ci = inv(C);
  const probes = [];
  for (let y = 0; y < 320; y += 4)
    for (let x = 0; x < 512; x += 4) {
      const [lx, ly] = ap(Wi, x + 0.5, y + 0.5);
      const [cx, cy] = ap(Ci, x + 0.5, y + 0.5);
      const m = 3;
      const inRect = lx > m && ly > m && lx < 300 - m && ly < 100 - m;
      const outRect = lx < -m || ly < -m || lx > 300 + m || ly > 100 + m;
      const inClip = cx > 20 + m && cy > 10 + m && cx < 260 - m && cy < 90 - m;
      const outClip = cx < 20 - m || cy < 10 - m || cx > 260 + m || cy > 90 + m;
      if (inRect && inClip) probes.push({ x, y, mix: () => Q(G1, lx, ly) });
      else if (outRect || outClip) probes.push({ x, y, solid: [0, 0, 0] });
    }
  cases.push({ name: 'G6 clip', nodes: [container, child], probes });
}
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: [
    '--enable-unsafe-webgpu',
    '--use-vulkan=swiftshader',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-features=Vulkan',
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text());
});
await page.goto(`${BASE}/e23-gradient-paint.html?samples=${samples}&dpr=1`);
const ready = await page.evaluate(() => window.__vectorStudioE23.ready);
console.log('ready', JSON.stringify(ready));
let worst = 0,
  fails = 0;
for (const c of cases) {
  const out = await page.evaluate(
    ([snap, cam]) => window.__vectorStudioE23.render(snap, cam),
    [
      {
        identity,
        revision: 1,
        nodes: c.nodes,
        rootOrder: c.nodes.filter((n) => n.parentId === null).map((n) => n.id),
      },
      { position: { x: 0, y: 0 }, zoom: 1 },
    ],
  );
  const rgba = Buffer.from(out.frame.rgbaBase64, 'base64');
  const W = out.frame.width;
  let cw = 0,
    n = 0;
  const bad = [];
  for (const p of c.probes) {
    const exp =
      p.solid ?? (p.mix ? p.mix() : Q(p.grad, p.x + 0.5 - p.node[0], p.y + 0.5 - p.node[1]));
    const at = (p.y * W + p.x) * 4;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(rgba[at + k] - exp[k] * 255);
      cw = Math.max(cw, d);
      if (d > 2)
        bad.push({ x: p.x, y: p.y, k, got: rgba[at + k], exp: +(exp[k] * 255).toFixed(2) });
    }
    n++;
  }
  worst = Math.max(worst, cw);
  fails += bad.length;
  console.log(
    c.name,
    'status',
    out.status,
    'probes',
    n,
    'max diff',
    cw.toFixed(2),
    'fails',
    bad.length,
    JSON.stringify(bad.slice(0, 6)),
    'packet',
    JSON.stringify(out.frame.packet),
  );
}
// A04: G5 t=0.5 probe.
console.log(
  'diagnostics',
  JSON.stringify(await page.evaluate(() => window.__vectorStudioE23.diagnostics())),
);
console.log('errors', JSON.stringify(errors.slice(0, 10)));
console.log('WORST', worst.toFixed(2), 'FAILS', fails);
await browser.close();
