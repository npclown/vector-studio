export type ProjectionPoint = readonly [x: number, y: number];

export type ProjectionInput = Readonly<{
  id: string;
  mesh: Readonly<{ vertices: readonly ProjectionPoint[]; indices: readonly number[] }>;
  affine: readonly [number, number, number, number, number, number];
  camera: ProjectionPoint;
  origin: ProjectionPoint;
  zoom: number;
  dpr: number;
  width: number;
  height: number;
}>;

export type ProjectionStage =
  | 'INPUT'
  | 'MIDPOINT'
  | 'LOCAL_OFFSET'
  | 'LINEAR'
  | 'ANCHOR'
  | 'FRAME_OFFSET'
  | 'SCALE'
  | 'SIZE'
  | 'VERTEX_PHYSICAL'
  | 'VERTEX_NDC'
  | 'VIEWPORT_RECOVERY';

type ProjectionSuccess = Readonly<{
  ok: true;
  midpoint: ProjectionPoint;
  localOffsets: readonly ProjectionPoint[];
  linear: readonly [number, number, number, number];
  anchor: ProjectionPoint;
  offset: ProjectionPoint;
  scale: readonly [number, number];
  size: readonly [number, number];
  physical: readonly ProjectionPoint[];
  ndc: readonly ProjectionPoint[];
  recovered: readonly ProjectionPoint[];
}>;

export type ProjectionObservation =
  ProjectionSuccess | Readonly<{ ok: false; stage: ProjectionStage }>;

const f = Math.fround;

function failed(stage: ProjectionStage): ProjectionObservation {
  return { ok: false, stage };
}

function finite(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function validInput(input: ProjectionInput): boolean {
  const { vertices, indices } = input.mesh;
  if (
    typeof input.id !== 'string' ||
    !Array.isArray(vertices) ||
    !Array.isArray(indices) ||
    vertices.length === 0 ||
    vertices.length > 256 ||
    indices.length === 0 ||
    indices.length % 3 !== 0 ||
    indices.length / 3 > 256 ||
    !Array.isArray(input.affine) ||
    input.affine.length !== 6 ||
    !Array.isArray(input.camera) ||
    input.camera.length !== 2 ||
    !Array.isArray(input.origin) ||
    input.origin.length !== 2 ||
    !finite([...input.affine, ...input.camera, ...input.origin, input.zoom, input.dpr]) ||
    input.zoom <= 0 ||
    input.dpr <= 0 ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0 ||
    input.width > 16_384 ||
    input.height > 16_384
  )
    return false;
  for (let index = 0; index < vertices.length; index += 1) {
    const point: unknown = vertices[index];
    if (
      !Object.hasOwn(vertices, index) ||
      !Array.isArray(point) ||
      point.length !== 2 ||
      typeof point[0] !== 'number' ||
      typeof point[1] !== 'number' ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1])
    )
      return false;
  }
  for (let index = 0; index < indices.length; index += 1) {
    const value: unknown = indices[index];
    if (
      !Object.hasOwn(indices, index) ||
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value >= vertices.length
    )
      return false;
  }
  return true;
}

export function simulateMeshProjection(input: ProjectionInput): ProjectionObservation {
  if (!validInput(input)) return failed('INPUT');
  const vertices = input.mesh.vertices;
  const xs = vertices.map((point) => point[0]);
  const ys = vertices.map((point) => point[1]);
  const midpoint: ProjectionPoint = [
    Math.min(...xs) / 2 + Math.max(...xs) / 2,
    Math.min(...ys) / 2 + Math.max(...ys) / 2,
  ];
  if (!finite(midpoint)) return failed('MIDPOINT');

  const localOffsets = vertices.map(([x, y]): ProjectionPoint => [
    f(x - midpoint[0]),
    f(y - midpoint[1]),
  ]);
  if (!localOffsets.every(finite)) return failed('LOCAL_OFFSET');

  const linear = input.affine.slice(0, 4).map(f) as unknown as [number, number, number, number];
  if (!finite(linear)) return failed('LINEAR');
  const [a, b, c, d, e, g] = input.affine;
  const anchor: ProjectionPoint = [
    f(a * midpoint[0] + c * midpoint[1] + e - input.origin[0]),
    f(b * midpoint[0] + d * midpoint[1] + g - input.origin[1]),
  ];
  if (!finite(anchor)) return failed('ANCHOR');
  const offset: ProjectionPoint = [
    f(input.origin[0] - input.camera[0]),
    f(input.origin[1] - input.camera[1]),
  ];
  if (!finite(offset)) return failed('FRAME_OFFSET');
  const scale: readonly [number, number] = [f(input.zoom), f(input.dpr)];
  if (!finite(scale) || scale[0] === 0 || scale[1] === 0) return failed('SCALE');
  const size: readonly [number, number] = [f(input.width), f(input.height)];
  if (!finite(size)) return failed('SIZE');

  const physical: ProjectionPoint[] = [];
  for (const [x, y] of localOffsets) {
    const sx = f(f(f(linear[0] * x) + f(linear[2] * y)) + anchor[0]);
    const sy = f(f(f(linear[1] * x) + f(linear[3] * y)) + anchor[1]);
    const rx = f(sx + offset[0]);
    const ry = f(sy + offset[1]);
    const px = f(f(rx * scale[0]) * scale[1]);
    const py = f(f(ry * scale[0]) * scale[1]);
    if (!finite([px, py])) return failed('VERTEX_PHYSICAL');
    physical.push([px, py]);
  }
  const ndc: ProjectionPoint[] = [];
  for (const [x, y] of physical) {
    const nx = f(f(f(x * 2) / size[0]) - 1);
    const ny = f(1 - f(f(y * 2) / size[1]));
    if (!finite([nx, ny])) return failed('VERTEX_NDC');
    ndc.push([nx, ny]);
  }
  const recovered: ProjectionPoint[] = [];
  for (const [x, y] of ndc) {
    const rx = ((x + 1) * input.width) / 2;
    const ry = ((1 - y) * input.height) / 2;
    if (!finite([rx, ry])) return failed('VIEWPORT_RECOVERY');
    recovered.push([rx, ry]);
  }
  return {
    ok: true,
    midpoint: [...midpoint],
    localOffsets: localOffsets.map(([x, y]) => [x, y]),
    linear: [...linear],
    anchor: [...anchor],
    offset: [...offset],
    scale: [...scale],
    size: [...size],
    physical: physical.map(([x, y]) => [x, y]),
    ndc: ndc.map(([x, y]) => [x, y]),
    recovered: recovered.map(([x, y]) => [x, y]),
  };
}
