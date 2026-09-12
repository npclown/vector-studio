import type { VisualFixture } from './p1-visual-corpus.js';

type Point = { x: number; y: number };
type Observation = Point & { localX: number; localY: number };

// Independent f64 construction from literal scene/camera values. No packet,
// camera helper, shader helper, or production packing constants enter the oracle.
export function inspectNativePositions(
  fixture: VisualFixture,
  dpr: number,
  observed: readonly Observation[],
) {
  const node = fixture.snapshot.nodes[0]!;
  if (node.kind !== 'primitive' || node.geometry.kind !== 'rectangle')
    throw new Error('N02 requires a rectangle.');
  const [a, b, c, d, e, f] = node.transform;
  const scale = fixture.camera.zoom * dpr;
  const half = (node.style.stroke?.width ?? 0) / 2;
  const determinant = a * d - b * c;
  const gx = (2 * (Math.abs(d) + Math.abs(c))) / (Math.abs(determinant) * scale);
  const gy = (2 * (Math.abs(b) + Math.abs(a))) / (Math.abs(determinant) * scale);
  const width = 640 * dpr,
    height = 360 * dpr;
  const physical = (p: Point): Point => ({
    x: (a * p.x + c * p.y + (e - fixture.camera.position.x)) * scale,
    y: (b * p.x + d * p.y + (f - fixture.camera.position.y)) * scale,
  });
  const contours = [
    [
      { x: -half, y: -half },
      { x: node.geometry.width + half, y: -half },
      { x: node.geometry.width + half, y: node.geometry.height + half },
      { x: -half, y: node.geometry.height + half },
    ],
    [
      { x: -half - gx, y: -half - gy },
      { x: node.geometry.width + half + gx, y: -half - gy },
      { x: node.geometry.width + half + gx, y: node.geometry.height + half + gy },
      { x: -half - gx, y: node.geometry.height + half + gy },
    ],
  ];
  const points: Point[] = [];
  for (const contour of contours) {
    for (let i = 0; i < 4; i++) {
      const start = contour[i]!,
        end = contour[(i + 1) % 4]!;
      const from = physical(start),
        to = physical(end);
      let lower = 0,
        upper = 1;
      for (const [origin, delta, lo, hi] of [
        [from.x, to.x - from.x, -2, width + 2],
        [from.y, to.y - from.y, -2, height + 2],
      ]) {
        if (delta === 0) {
          if (origin! < lo! || origin! > hi!) upper = -1;
        } else {
          const t0 = (lo! - origin!) / delta!,
            t1 = (hi! - origin!) / delta!;
          lower = Math.max(lower, Math.min(t0, t1));
          upper = Math.min(upper, Math.max(t0, t1));
        }
      }
      if (lower <= upper)
        for (const fraction of [0, 0.125, 0.5, 0.875, 1]) {
          const t = lower + (upper - lower) * fraction;
          points.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
        }
    }
  }
  if (observed.length === 0)
    return {
      pass: points.length === 0,
      maximumError: 0,
      samples: [],
      reason:
        points.length === 0
          ? 'No visible contour or guard interval'
          : 'Visible contour has no native vertex observations',
    };
  if (observed.length !== 4) throw new Error('Expected four native vertices.');
  if (observed.some((point) => !Object.values(point).every(Number.isFinite))) {
    return {
      pass: false,
      maximumError: Number.POSITIVE_INFINITY,
      samples: [],
      reason: 'Nonfinite native vertex readback',
    };
  }
  const [p00, p10, p01, p11] = observed as readonly [
    Observation,
    Observation,
    Observation,
    Observation,
  ];
  const lower = { x: -half - gx, y: -half - gy };
  const upper = { x: node.geometry.width + half + gx, y: node.geometry.height + half + gy };
  const idealLocals = [lower, { x: upper.x, y: lower.y }, { x: lower.x, y: upper.y }, upper];
  const endpoints = observed.map((value, index) => {
    const local = idealLocals[index]!;
    const expected = physical(local);
    const localPhysicalError = Math.hypot(
      (a * (value.localX - local.x) + c * (value.localY - local.y)) * scale,
      (b * (value.localX - local.x) + d * (value.localY - local.y)) * scale,
    );
    return {
      local,
      observed: value,
      expected,
      localPhysicalError,
      error: Math.hypot(value.x - expected.x, value.y - expected.y),
    };
  });
  // Piecewise affine interpolation matches the production quad's two triangles.
  // The endpoint values execute on the native vertex stage; raster images are a
  // separate test. This is not a fragment-stage position readback claim.
  const samples = points.map((p) => {
    // Derive weights from the independent guarded rectangle. Using observed
    // locals here could extrapolate through a missing/incorrect guard and pass.
    const u = Math.max(0, Math.min(1, (p.x - lower.x) / (upper.x - lower.x))),
      v = Math.max(0, Math.min(1, (p.y - lower.y) / (upper.y - lower.y)));
    const actual =
      u + v <= 1
        ? {
            x: p00.x + u * (p10.x - p00.x) + v * (p01.x - p00.x),
            y: p00.y + u * (p10.y - p00.y) + v * (p01.y - p00.y),
          }
        : {
            x: p11.x + (1 - u) * (p01.x - p11.x) + (1 - v) * (p10.x - p11.x),
            y: p11.y + (1 - u) * (p01.y - p11.y) + (1 - v) * (p10.y - p11.y),
          };
    const expected = physical(p);
    return {
      local: p,
      expected,
      actual,
      error: Math.hypot(actual.x - expected.x, actual.y - expected.y),
    };
  });
  const maximumError = Math.max(
    0,
    ...samples.map((sample) => sample.error),
    ...endpoints.flatMap((endpoint) => [endpoint.error, endpoint.localPhysicalError]),
  );
  return {
    pass: Number.isFinite(maximumError) && maximumError <= 0.25,
    maximumError,
    samples,
    endpoints,
    reason:
      'Native vertex-stage endpoints with piecewise affine visible contour/guard interpolation',
  };
}
