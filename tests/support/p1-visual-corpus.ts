import type {
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneAffine,
  SceneColor,
} from '@vector-studio/contracts';

export interface VisualFixture {
  readonly id: string;
  readonly snapshot: RenderSceneSnapshot;
  readonly camera: RenderCamera;
  readonly transparent: boolean;
}

export interface CullingVisualFixture extends VisualFixture {
  readonly expectedVisibleIds: readonly string[];
}

const WHITE: SceneColor = { r: 1, g: 1, b: 1, a: 1 };
const BLUE: SceneColor = { r: 0, g: 0, b: 1, a: 1 };
const RED: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const GREEN: SceneColor = { r: 0, g: 1, b: 0, a: 1 };
const CAMERA: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };
const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];

function snapshot(_id: string, nodes: readonly RenderNodeSnapshot[], rootOrder: readonly string[]) {
  return {
    identity: { documentId: 'fixture-doc', pageId: 'fixture-page' },
    revision: 0,
    nodes,
    rootOrder,
  };
}

function primitive(
  id: string,
  transform: SceneAffine,
  geometry: Extract<RenderNodeSnapshot, { kind: 'primitive' }>['geometry'],
  style: Extract<RenderNodeSnapshot, { kind: 'primitive' }>['style'],
  extra: Partial<Pick<RenderNodeSnapshot, 'parentId' | 'visible' | 'opacity'>> = {},
): RenderNodeSnapshot {
  return {
    id,
    kind: 'primitive',
    parentId: extra.parentId ?? null,
    transform,
    visible: extra.visible ?? true,
    opacity: extra.opacity ?? 1,
    geometry,
    style,
  };
}

function rectangle(
  id: string,
  transform: SceneAffine,
  width: number,
  height: number,
  color = WHITE,
) {
  return primitive(
    id,
    transform,
    { kind: 'rectangle', width, height, cornerRadii: [0, 0, 0, 0] },
    { fill: color, stroke: null },
  );
}

function around(
  center: readonly [number, number],
  linear: SceneAffine,
  placement: readonly [number, number],
): SceneAffine {
  const [cx, cy] = center;
  const [a, b, c, d] = linear;
  return [a, b, c, d, placement[0] + cx - a * cx - c * cy, placement[1] + cy - b * cx - d * cy];
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;
export const P1_AFFINE_VARIANTS = Object.freeze([
  ['identity', IDENTITY],
  [
    'rot15',
    [
      Math.cos(radians(15)),
      Math.sin(radians(15)),
      -Math.sin(radians(15)),
      Math.cos(radians(15)),
      0,
      0,
    ],
  ],
  [
    'rot45',
    [
      Math.cos(radians(45)),
      Math.sin(radians(45)),
      -Math.sin(radians(45)),
      Math.cos(radians(45)),
      0,
      0,
    ],
  ],
  ['rot90', [0, 1, -1, 0, 0, 0]],
  ['reflect', [-1, 0, 0, 1, 0, 0]],
  ['scale', [2, 0, 0, 0.5, 0, 0]],
  ['shear', [1, 0, 0.25, 1, 0, 0]],
] as const satisfies readonly (readonly [string, SceneAffine])[]);

export function visualFixtures(): readonly VisualFixture[] {
  const v01 = primitive(
    'v01-rounded',
    [1, 0, 0, 1, 20, 20],
    { kind: 'rectangle', width: 100, height: 60, cornerRadii: [80, 40, 20, 0] },
    { fill: WHITE, stroke: null },
  );
  const v02 = primitive(
    'v02-fill-stroke',
    [1, 0, 0, 1, 20.25, 20.5],
    { kind: 'rectangle', width: 40, height: 30, cornerRadii: [0, 0, 0, 0] },
    { fill: BLUE, stroke: { color: RED, width: 4 } },
    { opacity: 0.5 },
  );
  const fixed: VisualFixture[] = [
    {
      id: 'V01-rounded-asymmetric',
      snapshot: snapshot('V01', [v01], [v01.id]),
      camera: CAMERA,
      transparent: false,
    },
    {
      id: 'V02-fill-stroke-opacity',
      snapshot: snapshot('V02', [v02], [v02.id]),
      camera: CAMERA,
      transparent: true,
    },
  ];
  const overlap = (reversed: boolean): VisualFixture => {
    const red = rectangle('red', [1, 0, 0, 1, 30, 30], 80, 80, { ...RED, a: 0.5 });
    const blue = rectangle('blue', [1, 0, 0, 1, 50, 50], 80, 80, { ...BLUE, a: 0.5 });
    const ordered = reversed ? [blue, red] : [red, blue];
    return {
      id: reversed ? 'V03-overlap-reversed' : 'V03-overlap-forward',
      snapshot: snapshot(
        reversed ? 'V03r' : 'V03',
        ordered,
        ordered.map(({ id }) => id),
      ),
      camera: CAMERA,
      transparent: true,
    };
  };
  fixed.push(overlap(false), overlap(true));
  for (const [name, linear] of P1_AFFINE_VARIANTS) {
    const ellipse = primitive(
      'v04-ellipse',
      around([40, 20], linear, [200.25, 80.5]),
      { kind: 'ellipse', width: 80, height: 40 },
      { fill: GREEN, stroke: { color: WHITE, width: 0.5 } },
    );
    fixed.push({
      id: `V04-ellipse-${name}`,
      snapshot: snapshot(`V04-${name}`, [ellipse], [ellipse.id]),
      camera: CAMERA,
      transparent: false,
    });
    const line = primitive(
      'v05-line',
      around([20, 0], linear, [40.25, 140.5]),
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
      { fill: null, stroke: { color: WHITE, width: 3 } },
    );
    fixed.push({
      id: `V05-butt-line-${name}`,
      snapshot: snapshot(`V05-${name}`, [line], [line.id]),
      camera: CAMERA,
      transparent: false,
    });
  }
  const hidden: RenderNodeSnapshot = {
    id: 'v06-hidden-parent',
    parentId: null,
    kind: 'container',
    transform: IDENTITY,
    visible: false,
    opacity: 1,
    children: ['v06-hidden-child'],
  };
  const v06 = [
    primitive(
      'v06-zero-rect',
      [1, 0, 0, 1, 20, 20],
      { kind: 'rectangle', width: 0, height: 8, cornerRadii: [0, 0, 0, 0] },
      { fill: WHITE, stroke: { color: WHITE, width: 4 } },
    ),
    primitive(
      'v06-zero-ellipse',
      [1, 0, 0, 1, 45, 20],
      { kind: 'ellipse', width: 8, height: 0 },
      { fill: WHITE, stroke: { color: RED, width: 4 } },
    ),
    primitive(
      'v06-zero-line',
      [1, 0, 0, 1, 70, 20],
      { kind: 'line', start: { x: 3, y: 4 }, end: { x: 3, y: 4 } },
      { fill: null, stroke: { color: WHITE, width: 4 } },
    ),
    primitive(
      'v06-singular',
      [1, 0, 2, 0, 0, 0],
      { kind: 'rectangle', width: 20, height: 20, cornerRadii: [0, 0, 0, 0] },
      { fill: WHITE, stroke: { color: WHITE, width: 4 } },
    ),
    hidden,
    primitive(
      'v06-hidden-child',
      [1, 0, 0, 1, 20, 20],
      { kind: 'rectangle', width: 20, height: 20, cornerRadii: [0, 0, 0, 0] },
      { fill: WHITE, stroke: null },
      { parentId: hidden.id },
    ),
  ];
  fixed.push({
    id: 'V06-hidden-degenerate',
    snapshot: snapshot('V06', v06, [
      'v06-zero-rect',
      'v06-zero-ellipse',
      'v06-zero-line',
      'v06-singular',
      hidden.id,
    ]),
    camera: CAMERA,
    transparent: false,
  });
  const v07 = visualCullingFixture();
  fixed.push(v07);
  return Object.freeze(fixed);
}

export function visualCullingFixture(): CullingVisualFixture {
  const nodes = [
    rectangle('left-touch', [1, 0, 0, 1, -8, 20], 8, 8),
    rectangle('right-touch', [1, 0, 0, 1, 640, 20], 8, 8),
    rectangle('top-touch', [1, 0, 0, 1, 20, -8], 8, 8),
    rectangle('bottom-touch', [1, 0, 0, 1, 20, 360], 8, 8),
    rectangle('outside', [1, 0, 0, 1, -10.01, 20], 8, 8),
  ];
  return {
    id: 'V07-inclusive-guarded-culling',
    snapshot: snapshot(
      'V07',
      nodes,
      nodes.map(({ id }) => id),
    ),
    camera: CAMERA,
    transparent: false,
    expectedVisibleIds: ['left-touch', 'right-touch', 'top-touch', 'bottom-touch'],
  };
}

export function invalidContainerSnapshot(): RenderSceneSnapshot {
  const child = rectangle('v06-invalid-child', IDENTITY, 10, 10);
  const parent: RenderNodeSnapshot = {
    id: 'v06-invalid-opacity',
    parentId: null,
    kind: 'container',
    transform: IDENTITY,
    visible: true,
    opacity: 0.5,
    children: [child.id],
  };
  return snapshot('V06-invalid', [parent, { ...child, parentId: parent.id }], [parent.id]);
}

/** Full N02 Cartesian corpus: 2 signs × 3 sizes × 2 styles × 2 cameras × 3 zooms × 7 affines. */
export function precisionFixtures(dpr: number): readonly VisualFixture[] {
  if (![1, 1.5, 2].includes(dpr)) throw new RangeError('N02 DPR must be 1, 1.5, or 2.');
  const fixtures: VisualFixture[] = [];
  for (const [originX, originY, sign] of [
    [1e9, -1e9, 'plus'],
    [-1e9, 1e9, 'minus'],
  ] as const)
    for (const [width, height] of [
      [16, 8],
      [16, 16],
      [4096, 4096],
    ] as const)
      for (const strokeWidth of [0, 4] as const)
        for (const cameraKind of ['origin', 'center'] as const)
          for (const zoom of [0.01, 1, 64] as const)
            for (const [affineName, affine] of P1_AFFINE_VARIANTS) {
              const transform: SceneAffine = [
                affine[0],
                affine[1],
                affine[2],
                affine[3],
                originX + 0.25,
                originY + 0.5,
              ];
              const camera =
                cameraKind === 'origin'
                  ? { position: { x: originX, y: originY }, zoom }
                  : {
                      position: {
                        x: originX + affine[0] * (width / 2) + affine[2] * (height / 2),
                        y: originY + affine[1] * (width / 2) + affine[3] * (height / 2),
                      },
                      zoom,
                    };
              const node = primitive(
                'n02-rectangle',
                transform,
                { kind: 'rectangle', width, height, cornerRadii: [0, 0, 0, 0] },
                {
                  fill: WHITE,
                  stroke: strokeWidth === 0 ? null : { color: WHITE, width: strokeWidth },
                },
              );
              fixtures.push({
                id: `N02-dpr${dpr}-sign${sign}-size${width}x${height}-stroke${strokeWidth}-camera${cameraKind}-zoom${zoom}-affine${affineName}`,
                snapshot: snapshot(`N02-${fixtures.length}`, [node], [node.id]),
                camera,
                transparent: false,
              });
            }
  return Object.freeze(fixtures);
}
