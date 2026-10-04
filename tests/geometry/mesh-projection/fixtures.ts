import { fixedCarrierConformingMeshFixtures } from '../conforming-mesh/fixtures.js';
import { refineConformingMesh, verifyConformingRefinement } from '../conforming-mesh/oracle.js';
import { fromBits } from '../rounded-fill/exact.js';
import type { ProjectionInput } from './model.js';

export type ProjectionDisposition = 'REQUIRED_PASS' | 'REQUIRED_TOPOLOGY_REJECT' | 'OBSERVE';

export type ProjectionFixture = Readonly<{
  id: string;
  family: 'carrier' | 'rectangle' | 'origin-sequence' | 'thin';
  disposition: ProjectionDisposition;
  input: ProjectionInput;
  carrierMetadata?: unknown;
}>;

export type LegacyProjectionCounter = Readonly<{
  id: 'legacy/p1-5-over-64';
  point: readonly [2048, 2048];
  affine: readonly [number, number, number, number, 0, 0];
  camera: readonly [number, number];
  origin: readonly [8192, 6144];
  zoom: 64;
  dpr: 2;
  expectedDelta: readonly [-0.0625, -0.046875];
  expectedSquared: Readonly<{ n: '25'; d: '4096' }>;
}>;

type Linear = Readonly<{ id: string; value: readonly [number, number, number, number] }>;
const LINEARS: readonly Linear[] = [
  { id: 'I', value: [1, 0, 0, 1] },
  {
    id: 'R15',
    value: [
      fromBits(0x3feee8dd4748bf15n),
      fromBits(0x3fd0907dc1930690n),
      fromBits(0xbfd0907dc1930690n),
      fromBits(0x3feee8dd4748bf15n),
    ],
  },
  {
    id: 'R45',
    value: [
      fromBits(0x3fe6a09e667f3bcdn),
      fromBits(0x3fe6a09e667f3bcdn),
      fromBits(0xbfe6a09e667f3bcdn),
      fromBits(0x3fe6a09e667f3bcdn),
    ],
  },
  { id: 'R90', value: [0, 1, -1, 0] },
  { id: 'reflectX', value: [-1, 0, 0, 1] },
  { id: 'scale', value: [2, 0, 0, 0.5] },
  { id: 'shear', value: [1, 0, 0.25, 1] },
] as const;

function input(
  id: string,
  mesh: ProjectionInput['mesh'],
  linear: Linear['value'],
  translation: readonly [number, number],
  camera: readonly [number, number],
  origin: readonly [number, number],
  zoom: number,
  dpr: number,
): ProjectionInput {
  return {
    id,
    mesh,
    affine: [...linear, ...translation],
    camera,
    origin,
    zoom,
    dpr,
    width: 640 * dpr,
    height: 360 * dpr,
  };
}

const STATES = [
  ['S0', 0, [0.25, 0.5], [0, 0], [0, 0], 1, 1, 'REQUIRED_PASS'],
  ['S1', 1, [0.25, 0.5], [0.125, 0.375], [0, 0], 0.01, 1.5, 'OBSERVE'],
  ['S2', 2, [32.25, 48.5], [32.125, 48.375], [0, 0], 1, 2, 'OBSERVE'],
  ['S3', 3, [256.25, 256.5], [256.125, 256.375], [256, 256], 64, 1, 'OBSERVE'],
  ['S4', 4, [-255.75, 0.5], [-255.875, 0.375], [-256, 0], 0.01, 2, 'OBSERVE'],
  ['S5', 5, [511.75, 511.5], [511.625, 511.375], [256, 256], 1, 1.5, 'OBSERVE'],
  ['S6', 6, [-511.75, -511.5], [-511.875, -511.625], [-512, -512], 64, 2, 'OBSERVE'],
  ['S7', 0, [1e9 + 0.25, -1e9 + 0.5], [1e9, -1e9], [1e9, -1e9], 0.01, 1, 'OBSERVE'],
  ['S8', 2, [-1e9 + 0.25, 1e9 + 0.5], [-1e9 + 0.125, 1e9 + 0.375], [-1e9, 1e9], 64, 1.5, 'OBSERVE'],
] as const;

function rectangle(width: number, height: number): ProjectionInput['mesh'] {
  return {
    vertices: [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

export function fixedProjectionFixtures(): readonly ProjectionFixture[] {
  const carriers = fixedCarrierConformingMeshFixtures().flatMap((fixture) => {
    const refined = refineConformingMesh(fixture.mesh);
    if (refined.status !== 'CERTIFIED') throw new Error(`${fixture.id}: J refinement failed`);
    verifyConformingRefinement(fixture.mesh, refined.mesh);
    return STATES.map(([state, linear, translation, camera, origin, zoom, dpr, disposition]) => ({
      id: `${fixture.id}/${state}`,
      family: 'carrier' as const,
      disposition,
      input: input(
        `${fixture.id}/${state}`,
        refined.mesh,
        LINEARS[linear]!.value,
        translation,
        camera,
        origin,
        zoom,
        dpr,
      ),
      carrierMetadata: {
        sourceCarrier: fixture.carrier,
        refinedParentTriangle: [...refined.mesh.parentTriangle],
      },
    }));
  });
  const stressScales = [
    [0.01, 1],
    [1, 1.5],
    [64, 2],
    [0.01, 2],
    [1, 1],
    [64, 1.5],
    [1, 2],
  ] as const;
  const rectangles = (
    [
      [16, 8],
      [16, 16],
      [4096, 4096],
    ] as const
  ).flatMap(([width, height]) =>
    LINEARS.flatMap((linear, index) => {
      const mesh = rectangle(width, height);
      const base = `rectangle/${width}x${height}/${linear.id}`;
      const sign = index % 2 === 0 ? 1 : -1;
      const p = [sign * 1e9, -sign * 1e9] as const;
      const [zoom, dpr] = stressScales[index]!;
      return [
        {
          id: `${base}/ordinary`,
          family: 'rectangle' as const,
          disposition: 'REQUIRED_PASS' as const,
          input: input(`${base}/ordinary`, mesh, linear.value, [0.25, 0.5], [0, 0], [0, 0], 1, 1),
        },
        {
          id: `${base}/stress`,
          family: 'rectangle' as const,
          disposition: 'OBSERVE' as const,
          input: input(
            `${base}/stress`,
            mesh,
            linear.value,
            [p[0] + 0.25, p[1] + 0.5],
            [p[0] + 0.125, p[1] + 0.375],
            p,
            zoom,
            dpr,
          ),
        },
      ];
    }),
  );
  const cameras = [0, 255.75, 256, 511.75, 512, 512.25, 511.75] as const;
  const origins = [0, 0, 0, 0, 0, 512, 512] as const;
  const originRows = cameras.map((cameraX, index) => {
    const id = `origin-sequence/${index}`;
    return {
      id,
      family: 'origin-sequence' as const,
      disposition: 'REQUIRED_PASS' as const,
      input: input(
        id,
        rectangle(16, 8),
        LINEARS[0]!.value,
        [0.25, 0.5],
        [cameraX, 0],
        [origins[index]!, 0],
        1,
        1,
      ),
    };
  });
  const thinId = 'thin/collapse';
  const thin: ProjectionFixture = {
    id: thinId,
    family: 'thin',
    disposition: 'REQUIRED_TOPOLOGY_REJECT',
    input: input(
      thinId,
      {
        vertices: [
          [1, 0],
          [1 + 2 ** -25, 0],
          [1, 1],
        ],
        indices: [0, 1, 2],
      },
      LINEARS[0]!.value,
      [0, 0],
      [0, 0],
      [0, 0],
      1,
      1,
    ),
  };
  return [...carriers, ...rectangles, ...originRows, thin];
}

export function legacyProjectionCounter(): LegacyProjectionCounter {
  return {
    id: 'legacy/p1-5-over-64',
    point: [2048, 2048],
    affine: [2 + 2 ** -23, 2 + 2 ** -23, 2 + 2 ** -23, 1 + 2 ** -24, 0, 0],
    camera: [8192 + 2 ** -11, 6144 + 3 * 2 ** -13],
    origin: [8192, 6144],
    zoom: 64,
    dpr: 2,
    expectedDelta: [-0.0625, -0.046875],
    expectedSquared: { n: '25', d: '4096' },
  };
}
